const { loadConfig, saveConfig } = require('./config');
const archiverModule = require('archiver');
const ZipArchive = archiverModule.ZipArchive || (typeof archiverModule === 'function' ? archiverModule : null);
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 並行リクエストキュー（レート制限および同時接続過多の防止）
class RequestQueue {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this.next();
        });
    }
  }
}

// クォーター表記の抽出および正規化
function extractQuarter(courseName) {
  if (!courseName) return null;
  const normalized = courseName
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[Ｑｑ]/g, 'Q');

  const qMatch = normalized.match(/[\(\[（【〈](\d)\s*Q[\)\]）】〉]/i) ||
                 normalized.match(/\b([1-4])\s*Q\b/i) ||
                 normalized.match(/[\s_]([1-4])\s*Q/i);
  if (qMatch && qMatch[1]) {
    const qNum = parseInt(qMatch[1], 10);
    if (qNum >= 1 && qNum <= 4) return `${qNum}Q`;
  }

  const wordMatch = normalized.match(/(?:第)?\s*([1-4])\s*(?:クォーター|クオーター|期)/i);
  if (wordMatch && wordMatch[1]) {
    return `${wordMatch[1]}Q`;
  }

  return null;
}

function cleanCourseName(courseName) {
  if (!courseName) return '';
  const cleaned = courseName
    .replace(/[\(\[（【〈]\s*[1-4１-４]\s*[QＱ]\s*[\)\]）】〉]/gi, '')
    .replace(/\b[1-4１-４]\s*[QＱ]\b/gi, '')
    .replace(/[\(\[（【〈]\s*(?:第)?\s*[1-4１-４]\s*(?:クォーター|クオーター|期)\s*[\)\]）】〉]/gi, '')
    .replace(/(?:第)?\s*[1-4１-４]\s*(?:クォーター|クオーター|期)/gi, '')
    .replace(/[\(\[（【〈]\s*[\)\]）】〉]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || courseName;
}

class CanvasService {
  constructor() {
    this.cache = {
      profile: null,
      courses: null,
      coursesTime: 0,
      allAssignments: null,
      allAssignmentsTime: 0,
      assignments: new Map(),
      modules: new Map(),
      files: new Map(),
      resolvedUrls: new Map()
    };
    this.CACHE_TTL = 3 * 60 * 1000; // 3分メモリキャッシュ（高速応答）
    this.queue = new RequestQueue(4); // Canvas APIへの同時リクエスト数を4に制御して安定性を最大化
    this.inflightRequests = new Map(); // 重複GETリクエストのデデュープ
    this._saveCacheTimer = null;

    const userDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Canvas Horizon');
    if (!fs.existsSync(userDir)) {
      try { fs.mkdirSync(userDir, { recursive: true }); } catch (e) {}
    }
    this.cacheFilePath = path.join(userDir, 'cache.json');
    this.loadDiskCache();
  }

  // ディスクキャッシュの読み込み
  loadDiskCache() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed) {
          if (parsed.profile) this.cache.profile = parsed.profile;
          if (Array.isArray(parsed.courses)) {
            this.cache.courses = parsed.courses;
            this.cache.coursesTime = parsed.coursesTime || 0;
          }
          if (Array.isArray(parsed.allAssignments)) {
            this.cache.allAssignments = parsed.allAssignments;
            this.cache.allAssignmentsTime = parsed.allAssignmentsTime || 0;
          }
          if (parsed.assignments && typeof parsed.assignments === 'object') {
            for (const [k, v] of Object.entries(parsed.assignments)) {
              this.cache.assignments.set(k, v);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load disk cache:', e.message);
    }
  }

  // ディスクキャッシュへの保存（デバウンス処理）
  saveDiskCacheDebounced() {
    if (this._saveCacheTimer) clearTimeout(this._saveCacheTimer);
    this._saveCacheTimer = setTimeout(() => {
      try {
        const assignmentsObj = {};
        for (const [k, v] of this.cache.assignments.entries()) {
          assignmentsObj[k] = v;
        }
        const data = {
          profile: this.cache.profile,
          courses: this.cache.courses,
          coursesTime: this.cache.coursesTime,
          allAssignments: this.cache.allAssignments,
          allAssignmentsTime: this.cache.allAssignmentsTime,
          assignments: assignmentsObj
        };
        fs.writeFileSync(this.cacheFilePath, JSON.stringify(data), 'utf-8');
      } catch (e) {
        console.warn('Failed to save disk cache:', e.message);
      }
    }, 800);
  }

  getConfig() {
    return loadConfig();
  }

  getHeaders() {
    const cfg = this.getConfig();
    return {
      'Authorization': `Bearer ${cfg.apiToken}`,
      'Accept': 'application/json'
    };
  }

  getBaseUrl() {
    const cfg = this.getConfig();
    return (cfg.baseUrl || '').replace(/\/+$/, '');
  }

  /**
   * タイムアウト・自動リトライ・レート制限対策を備えたHTTPリクエスト
   */
  async request(endpoint, options = {}, retries = 3) {
    return this.queue.add(async () => {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const baseUrl = this.getBaseUrl();
        const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
        const headers = { ...this.getHeaders(), ...(options.headers || {}) };

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 20000); // 20秒タイムアウト

          const res = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (res.status === 401) {
            throw new Error('Canvas APIトークンが無効または期限切れです。設定を確認してください。');
          }

          // レート制限（429 または 403 Rate Limit）の自動リトライ
          if (res.status === 429 || res.status === 403) {
            const errBody = await res.text().catch(() => '');
            if (res.status === 429 || errBody.toLowerCase().includes('rate limit')) {
              if (attempt < retries) {
                const retryAfterHeader = res.headers.get('Retry-After');
                const waitMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (1500 * Math.pow(2, attempt) + Math.random() * 500);
                console.warn(`Canvas Rate limit reached. Backing off for ${waitMs}ms (attempt ${attempt + 1}/${retries})...`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
              }
              throw new Error('Canvas APIのレート制限に達しました。しばらく待ってから再試行してください。');
            }
            throw new Error(`API Error [${res.status}]: ${errBody || res.statusText}`);
          }

          // 5xx サーバーエラーの自動リトライ
          if (res.status >= 500 && res.status <= 504) {
            if (attempt < retries) {
              const waitMs = 1000 * Math.pow(2, attempt) + Math.random() * 400;
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`API Error [${res.status}]: ${errText || res.statusText}`);
          }

          return res;
        } catch (err) {
          lastErr = err;
          if (err.message && err.message.includes('トークンが無効')) {
            throw err;
          }
          if (attempt < retries && (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.message.includes('fetch failed'))) {
            const waitMs = 1000 * Math.pow(2, attempt) + Math.random() * 400;
            console.warn(`Canvas connection retry ${attempt + 1}/${retries} for ${endpoint}: ${err.message}`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          if (attempt >= retries) throw err;
        }
      }
      throw lastErr;
    });
  }

  async fetchJson(endpoint, options = {}) {
    const isGet = !options.method || options.method === 'GET';
    const baseUrl = this.getBaseUrl();
    const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    // 同一GETリクエストの重複排除
    if (isGet) {
      if (this.inflightRequests.has(url)) {
        return this.inflightRequests.get(url);
      }
      const promise = (async () => {
        const res = await this.request(url, options);
        return await res.json();
      })().finally(() => {
        this.inflightRequests.delete(url);
      });
      this.inflightRequests.set(url, promise);
      return promise;
    }

    const res = await this.request(endpoint, options);
    return await res.json();
  }

  // ユーザープロファイル
  async getProfile(forceRefresh = false) {
    if (!forceRefresh && this.cache.profile) {
      return this.cache.profile;
    }
    try {
      const profile = await this.fetchJson('/api/v1/users/self');
      this.cache.profile = profile;
      this.saveDiskCacheDebounced();
      return profile;
    } catch (err) {
      if (this.cache.profile) {
        console.warn('Canvas profile fetch failed, using cached profile:', err.message);
        return this.cache.profile;
      }
      throw err;
    }
  }

  // アクティブなコース一覧の取得
  async getCourses(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cache.courses && (now - this.cache.coursesTime < this.CACHE_TTL)) {
      return this.cache.courses;
    }

    try {
      // 履修中のコース（termやimageを含む）
      const courses = await this.fetchJson('/api/v1/courses?enrollment_state=active&include[]=term&include[]=course_image&per_page=100');
      const cfg = this.getConfig();
      const activeQ = (cfg.currentQuarter || '').trim().toUpperCase();
      
      // 各コースのクォーター抽出と整形
      const formatted = (Array.isArray(courses) ? courses : [])
        .filter(c => c && c.name && !c.access_restricted_by_date)
        .map(c => {
          const quarter = extractQuarter(c.name);
          const cleaned = cleanCourseName(c.name);
          const matchesFilter = !activeQ || activeQ === 'ALL' || (quarter && quarter === activeQ) || c.name.toUpperCase().includes(activeQ);

          return {
            id: c.id,
            name: c.name,
            cleanName: cleaned,
            quarter: quarter, // '1Q', '2Q', '3Q', '4Q' または null
            isCurrentQuarter: Boolean(matchesFilter),
            courseCode: c.course_code || '',
            term: c.term ? c.term.name : '',
            imageUrl: c.image_download_url || null,
            defaultView: c.default_view || 'modules',
            isFavorite: Boolean(c.is_favorite)
          };
        });

      // 設定された学期・フィルター条件を優先してソート
      formatted.sort((a, b) => {
        if (activeQ && activeQ !== 'ALL') {
          const aMatches = Boolean(a.isCurrentQuarter);
          const bMatches = Boolean(b.isCurrentQuarter);
          if (aMatches && !bMatches) return -1;
          if (!aMatches && bMatches) return 1;
        }
        
        // 2. クォーター指定がある科目を優先（降順または指定順）
        if (a.quarter && b.quarter) {
          if (a.quarter !== b.quarter) return b.quarter.localeCompare(a.quarter); // 3Q -> 2Q -> 1Q
        } else if (a.quarter) {
          return -1;
        } else if (b.quarter) {
          return 1;
        }

        return a.cleanName.localeCompare(b.cleanName, 'ja');
      });

      this.cache.courses = formatted;
      this.cache.coursesTime = now;
      this.saveDiskCacheDebounced();
      return formatted;
    } catch (err) {
      if (this.cache.courses && this.cache.courses.length > 0) {
        console.warn('Canvas courses fetch failed, using cached courses fallback:', err.message);
        return this.cache.courses;
      }
      throw err;
    }
  }

  // 課題一覧（提出状況・添付ファイル含む）
  async getAssignments(courseId, forceRefresh = false, includeOld = false) {
    const cacheKey = String(courseId) + (includeOld ? '_all' : '_recent');
    const cached = this.cache.assignments.get(cacheKey);
    const now = Date.now();
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    if (!forceRefresh && cached && (now - cached.time < this.CACHE_TTL)) {
      return cached.data;
    }

    try {
      const assignments = await this.fetchJson(
        `/api/v1/courses/${courseId}/assignments?include[]=submission&include[]=rubric_assessment&include[]=can_submit&per_page=100`
      );

      const formatted = (Array.isArray(assignments) ? assignments : [])
        .filter(a => {
          // 締切から1週間以上経過した課題を除外
          if (!includeOld && a.due_at) {
            const dueTime = new Date(a.due_at).getTime();
            if (now - dueTime > ONE_WEEK_MS) {
              return false;
            }
          }
          return true;
        })
        .map(a => {
          const sub = a.submission || null;
          const isSubmitted = sub && (sub.workflow_state === 'submitted' || sub.workflow_state === 'graded');
          const isGraded = sub && sub.workflow_state === 'graded';

          return {
            id: a.id,
            courseId: a.course_id || courseId,
            name: a.name || '無題の課題',
            description: a.description || '',
            dueAt: a.due_at,
            lockAt: a.lock_at,
            unlockAt: a.unlock_at,
            isLocked: Boolean(a.locked_for_user),
            lockExplanation: a.lock_explanation || null,
            pointsPossible: a.points_possible,
            gradingType: a.grading_type,
            submissionTypes: a.submission_types || [],
            allowedExtensions: a.allowed_extensions || [],
            htmlUrl: a.html_url,
            isSubmitted,
            isGraded,
            submission: sub ? {
              id: sub.id,
              submittedAt: sub.submitted_at,
              score: sub.score,
              grade: sub.grade,
              workflowState: sub.workflow_state,
              attempt: sub.attempt,
              attachments: (sub.attachments || []).map(att => ({
                id: att.id,
                displayName: att.display_name,
                filename: att.filename,
                size: att.size,
                contentType: att.content_type,
                url: att.url,
                createdAt: att.created_at
              })),
              submissionComments: (sub.submission_comments || []).map(sc => ({
                id: sc.id,
                authorName: sc.author_name,
                comment: sc.comment,
                createdAt: sc.created_at
              }))
            } : null
          };
        });

      // 締切順にソート（期限あり未提出が先、期限なし・完了が後）
      formatted.sort((a, b) => {
        if (!a.dueAt && !b.dueAt) return 0;
        if (!a.dueAt) return 1;
        if (!b.dueAt) return -1;
        return new Date(a.dueAt) - new Date(b.dueAt);
      });

      this.cache.assignments.set(cacheKey, { time: now, data: formatted });
      this.saveDiskCacheDebounced();
      return formatted;
    } catch (err) {
      if (cached && cached.data) {
        console.warn(`Assignments fetch failed for course ${courseId}, falling back to cache:`, err.message);
        return cached.data;
      }
      throw err;
    }
  }

  // 全コースの横断課題一覧（ダッシュボード・カレンダー用）
  async getAllAssignments(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cache.allAssignments && (now - this.cache.allAssignmentsTime < this.CACHE_TTL)) {
      return this.cache.allAssignments;
    }

    const courses = await this.getCourses(forceRefresh);

    // 今学期のコースを優先して順次取得
    const sortedCourses = [...courses].sort((a, b) => (b.isCurrentQuarter ? 1 : 0) - (a.isCurrentQuarter ? 1 : 0));

    const promises = sortedCourses.map(c => 
      this.getAssignments(c.id, forceRefresh, false)
        .then(assignments => assignments.map(a => ({
          ...a,
          courseName: c.name,
          cleanCourseName: c.cleanName,
          quarter: c.quarter,
          isCurrentQuarter: c.isCurrentQuarter,
          courseCode: c.courseCode
        })))
        .catch(err => {
          console.error(`Failed to fetch assignments for course ${c.id}:`, err.message);
          // 個別コースの前回キャッシュをフォールバックとして検索
          const cached = this.cache.assignments.get(String(c.id) + '_recent');
          if (cached && cached.data) {
            return cached.data.map(a => ({
              ...a,
              courseName: c.name,
              cleanCourseName: c.cleanName,
              quarter: c.quarter,
              isCurrentQuarter: c.isCurrentQuarter,
              courseCode: c.courseCode
            }));
          }
          return [];
        })
    );

    const results = await Promise.all(promises);
    const all = results.flat();

    all.sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });

    this.cache.allAssignments = all;
    this.cache.allAssignmentsTime = now;
    this.saveDiskCacheDebounced();

    return all;
  }

  // コースのモジュール（講義回ごとの資料・スライドPDF・演習）
  async getModules(courseId, forceRefresh = false) {
    const cacheKey = String(courseId);
    const cached = this.cache.modules.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cached && (now - cached.time < this.CACHE_TTL)) {
      return cached.data;
    }

    let modules = [];
    try {
      modules = await this.fetchJson(`/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`);
    } catch (e) {
      console.warn(`Could not fetch modules for course ${courseId}:`, e.message);
      modules = [];
    }

    const formatted = (Array.isArray(modules) ? modules : []).map(m => ({
      id: m.id,
      name: m.name,
      position: m.position,
      itemsCount: m.items_count,
      items: (m.items || []).map(it => ({
        id: it.id,
        title: it.title,
        type: it.type, // 'File', 'Assignment', 'Page', 'ExternalUrl', 'Quiz' など
        contentId: it.content_id,
        htmlUrl: it.html_url,
        url: it.url, // ファイル解決用API URL
        externalUrl: it.external_url || null
      }))
    }));

    this.cache.modules.set(cacheKey, { time: now, data: formatted });
    return formatted;
  }

  // コース内の全ファイル（PDF・スライド等）を統合して取得
  async getCourseFiles(courseId, forceRefresh = false) {
    const cacheKey = String(courseId);
    const cached = this.cache.files.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cached && (now - cached.time < this.CACHE_TTL)) {
      return cached.data;
    }

    const fileMap = new Map();

    // 1. 直の files API を試す（権限がある場合）
    try {
      const files = await this.fetchJson(`/api/v1/courses/${courseId}/files?sort=updated_at&order=desc&per_page=100`);
      if (Array.isArray(files)) {
        files.forEach(f => {
          fileMap.set(String(f.id), {
            id: f.id,
            displayName: f.display_name || f.filename,
            size: f.size,
            contentType: f['content-type'] || f.content_type,
            url: f.url,
            createdAt: f.created_at,
            updatedAt: f.updated_at,
            source: 'files'
          });
        });
      }
    } catch (e) {
      // 403 の場合はモジュールからファイルを集約
    }

    // 2. モジュールから 'File' タイプのアイテムを取得・解決
    const modules = await this.getModules(courseId, forceRefresh);
    const fileItems = [];
    modules.forEach(m => {
      (m.items || []).forEach(it => {
        if (it.type === 'File' && it.contentId && !fileMap.has(String(it.contentId))) {
          fileItems.push({
            contentId: it.contentId,
            title: it.title,
            url: it.url,
            moduleName: m.name
          });
        }
      });
    });

    // モジュール内ファイルを並列解決（最大15件ずつバッチ処理）
    const batchSize = 10;
    for (let i = 0; i < fileItems.length; i += batchSize) {
      const batch = fileItems.slice(i, i + batchSize);
      await Promise.all(batch.map(async item => {
        try {
          if (item.url) {
            const fData = await this.fetchJson(item.url);
            fileMap.set(String(item.contentId), {
              id: item.contentId,
              displayName: fData.display_name || item.title,
              size: fData.size || 0,
              contentType: fData['content-type'] || (item.title.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
              url: fData.url,
              createdAt: fData.created_at || null,
              updatedAt: fData.updated_at || null,
              moduleName: item.moduleName,
              source: 'module'
            });
          }
        } catch (err) {
          // 取得失敗してもタイトルだけでエントリ作成
          fileMap.set(String(item.contentId), {
            id: item.contentId,
            displayName: item.title,
            size: 0,
            contentType: item.title.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
            url: null,
            moduleName: item.moduleName,
            source: 'module'
          });
        }
      }));
    }

    const result = Array.from(fileMap.values());
    this.cache.files.set(cacheKey, { time: now, data: result });
    return result;
  }

  // 授業回（モジュール）ごとにグループ化された講義資料を取得
  async getCourseMaterialsGrouped(courseId, forceRefresh = false) {
    const [modules, files, assignments] = await Promise.all([
      this.getModules(courseId, forceRefresh),
      this.getCourseFiles(courseId, forceRefresh),
      this.getAssignments(courseId, forceRefresh, true).catch(() => [])
    ]);

    const fileMapById = new Map();
    files.forEach(f => fileMapById.set(String(f.id), f));

    const assignMapById = new Map();
    const assignMapByName = new Map();
    (assignments || []).forEach(a => {
      assignMapById.set(String(a.id), a);
      if (a.name) assignMapByName.set(a.name.trim(), a);
    });

    const grouped = [];

    modules.forEach(m => {
      const moduleFiles = [];
      (m.items || []).forEach(it => {
        if (it.type === 'File') {
          const resolved = fileMapById.get(String(it.contentId)) || {};
          moduleFiles.push({
            id: it.contentId,
            itemId: it.id,
            title: it.title,
            displayName: resolved.displayName || it.title,
            size: resolved.size || 0,
            contentType: resolved.contentType || (it.title.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
            url: resolved.url || null,
            type: 'File',
            htmlUrl: it.htmlUrl
          });
        } else if (it.type === 'Page') {
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: 'Page',
            pageUrl: it.page_url || (it.url ? it.url.split('/').pop() : null),
            apiUrl: it.url,
            htmlUrl: it.htmlUrl
          });
        } else if (it.type === 'Assignment') {
          const assign = assignMapById.get(String(it.contentId)) || 
                         assignMapById.get(String(it.id)) ||
                         assignMapByName.get((it.title || '').trim()) || null;
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: 'Assignment',
            assignmentId: it.contentId || it.id,
            htmlUrl: it.htmlUrl,
            isSubmitted: assign ? Boolean(assign.isSubmitted) : false,
            isGraded: assign ? Boolean(assign.isGraded) : false,
            dueAt: assign?.dueAt || null,
            pointsPossible: assign?.pointsPossible ?? null,
            submission: assign?.submission || null,
            submissionTypes: assign?.submissionTypes || ['online_upload']
          });
        } else if (it.type === 'ExternalUrl') {
          moduleFiles.push({
            id: it.id,
            itemId: it.id,
            title: it.title,
            type: 'ExternalUrl',
            url: it.externalUrl, // 外部直接URL（YouTube動画など）
            htmlUrl: it.htmlUrl
          });
        } else {
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: it.type,
            url: it.externalUrl || it.url,
            htmlUrl: it.htmlUrl
          });
        }
      });

      if (moduleFiles.length > 0) {
        grouped.push({
          id: m.id,
          name: m.name,
          position: m.position,
          items: moduleFiles
        });
      }
    });

    // モジュールに属さないファイルがある場合の「その他・配布資料」カテゴリ
    const assignedFileIds = new Set();
    grouped.forEach(g => g.items.forEach(it => {
      if (it.type === 'File') assignedFileIds.add(String(it.id));
    }));

    const unassignedFiles = files.filter(f => !assignedFileIds.has(String(f.id)));
    if (unassignedFiles.length > 0) {
      grouped.push({
        id: 'unassigned',
        name: 'その他の資料・ファイル',
        position: 9999,
        items: unassignedFiles.map(f => ({
          id: f.id,
          title: f.displayName,
          displayName: f.displayName,
          size: f.size,
          contentType: f.contentType,
          url: f.url,
          type: 'File'
        }))
      });
    }

    return grouped;
  }

  // 講義ページ（Wikiページ）の本文を取得（Canvas LMSを開かずにアプリ内で全文表示）
  async getPage(courseId, pageUrl) {
    const data = await this.fetchJson(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
    return {
      title: data.title,
      body: data.body,
      updatedAt: data.updated_at,
      url: data.html_url
    };
  }

  // ファイル直接ダウンロード用のURLまたはストリームを解決
  async resolveFileDownload(fileId, courseId = null) {
    const cacheKey = `${courseId || 'global'}_${fileId}`;
    const cached = this.cache.resolvedUrls?.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.time < 10 * 60 * 1000)) {
      return cached.data;
    }

    // ファイル詳細APIから最新の署名付きURLを取得
    const endpoint = courseId 
      ? `/api/v1/courses/${courseId}/files/${fileId}`
      : `/api/v1/files/${fileId}`;
    
    const fileData = await this.fetchJson(endpoint);
    if (fileData?.url && this.cache.resolvedUrls) {
      this.cache.resolvedUrls.set(cacheKey, { data: fileData, time: now });
    }
    return fileData; // 署名付きダウンロードURLやファイル名、サイズを含むオブジェクト
  }

  // アナウンス一覧の取得
  async getAnnouncements(courseIds = []) {
    if (!courseIds || courseIds.length === 0) {
      const courses = await this.getCourses();
      courseIds = courses.map(c => c.id);
    }
    const contextCodes = courseIds.map(id => `context_codes[]=course_${id}`).join('&');
    const announcements = await this.fetchJson(`/api/v1/announcements?${contextCodes}&per_page=30`);
    
    return (Array.isArray(announcements) ? announcements : []).map(a => ({
      id: a.id,
      title: a.title,
      message: a.message,
      postedAt: a.posted_at,
      author: a.user_name || (a.author ? a.author.display_name : '教員'),
      contextCode: a.context_code,
      htmlUrl: a.html_url,
      attachments: a.attachments || []
    }));
  }

  // ==========================================
  // 複数ファイル一括アップロードおよび提出処理
  // ==========================================

  /**
   * 単一ファイルのCanvasアップロード
   */
  async uploadSingleFileForSubmission(courseId, assignmentId, fileObj) {
    const { originalname, buffer, mimetype, size } = fileObj;

    // ステップ1: Canvasへアップロードを申請して署名付きURLを取得
    const step1Url = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`;
    const step1Res = await this.request(step1Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: originalname,
        size: size,
        content_type: mimetype || 'application/octet-stream'
      })
    });

    const step1Data = await step1Res.json();
    const { upload_url, upload_params, file_param = 'file' } = step1Data;

    if (!upload_url) {
      throw new Error(`ファイルアップロードURLの取得に失敗しました (${originalname})`);
    }

    // ステップ2: ストレージへマルチパートフォームで送信
    const formData = new FormData();
    if (upload_params) {
      for (const [key, value] of Object.entries(upload_params)) {
        formData.append(key, value);
      }
    }
    const fileBlob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
    formData.append(file_param, fileBlob, originalname);

    const step2Res = await fetch(upload_url, {
      method: 'POST',
      body: formData,
      redirect: 'follow'
    });

    if (!step2Res.ok && step2Res.status !== 302 && step2Res.status !== 201 && step2Res.status !== 200) {
      throw new Error(`ストレージへのファイル送信失敗: ${step2Res.statusText}`);
    }

    // ステップ3: レスポンスの解析（JSONまたはリダイレクト後のファイル情報）
    let fileResult = null;
    const contentType = step2Res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      fileResult = await step2Res.json();
    } else {
      const loc = step2Res.headers.get('location');
      if (loc) {
        fileResult = await this.fetchJson(loc);
      }
    }

    if (!fileResult || !fileResult.id) {
      throw new Error(`アップロード確認に失敗しました (${originalname})`);
    }

    return fileResult; // アップロード完了後のファイル情報オブジェクト
  }

  /**
   * 複数ファイルの一括アップロードおよび課題提出
   */
  async uploadAndSubmit(courseId, assignmentId, files = [], commentText = '', retainFileIds = []) {
    const validRetainIds = (Array.isArray(retainFileIds) ? retainFileIds : [])
      .map(id => Number(id))
      .filter(id => !isNaN(id) && id > 0);

    if ((!files || files.length === 0) && validRetainIds.length === 0) {
      throw new Error('提出するファイルが選択されていません。');
    }

    console.log(`一括アップロード開始: 新規ファイル ${files.length} 件, 保持ファイル ${validRetainIds.length} 件 (コース ${courseId}, 課題 ${assignmentId})`);

    // 新規ファイルの順次アップロード
    const uploadedFiles = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`ファイルアップロード中 (${i + 1}/${files.length}): ${file.originalname}`);
      const uploaded = await this.uploadSingleFileForSubmission(courseId, assignmentId, file);
      uploadedFiles.push(uploaded);
    }

    const newFileIds = uploadedFiles.map(f => f.id);
    // 前回提出のファイルIDと新規アップロードのファイルIDを結合
    const allFileIds = [...validRetainIds, ...newFileIds];
    console.log(`提出対象ファイルID一覧:`, allFileIds);

    // Canvasの課題提出APIを実行
    const submitPayload = {
      submission: {
        submission_type: 'online_upload',
        file_ids: allFileIds
      }
    };

    if (commentText && commentText.trim()) {
      submitPayload.comment = {
        text_comment: commentText.trim()
      };
    }

    const submitRes = await this.request(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitPayload)
      }
    );

    const submissionData = await submitRes.json();

    // キャッシュの無効化
    this.cache.assignments.delete(String(courseId) + '_recent');
    this.cache.assignments.delete(String(courseId) + '_all');
    this.cache.assignments.delete(String(courseId));

    return {
      success: true,
      submission: submissionData,
      retainedCount: validRetainIds.length,
      uploadedCount: uploadedFiles.length,
      totalCount: allFileIds.length
    };
  }

  // テキストまたはURLによる課題提出
  async submitTextOrUrl(courseId, assignmentId, { submissionType, body, url, commentText }) {
    const payload = {
      submission: {
        submission_type: submissionType
      }
    };

    if (submissionType === 'online_text_entry') {
      payload.submission.body = body;
    } else if (submissionType === 'online_url') {
      payload.submission.url = url;
    }

    if (commentText && commentText.trim()) {
      payload.comment = { text_comment: commentText.trim() };
    }

    const res = await this.request(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    this.cache.assignments.delete(String(courseId));
    return await res.json();
  }

  // 複数ファイルをZIPアーカイブにまとめてストリーミング
  async createZipArchive(filesToDownload, outputStream) {
    const archive = ZipArchive.prototype 
      ? new ZipArchive({ zlib: { level: 6 } })
      : ZipArchive('zip', { zlib: { level: 6 } });

    archive.pipe(outputStream);

    for (const item of filesToDownload) {
      try {
        let downloadUrl = item.url;
        if (!downloadUrl && item.id) {
          const resolved = await this.resolveFileDownload(item.id, item.courseId);
          downloadUrl = resolved.url;
        }

        if (downloadUrl) {
          const res = await fetch(downloadUrl);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            archive.append(buf, { name: item.name || item.displayName || 'download' });
          }
        }
      } catch (err) {
        console.error(`Failed to add ${item.name} to zip:`, err.message);
      }
    }

    await archive.finalize();
  }
}

module.exports = new CanvasService();
