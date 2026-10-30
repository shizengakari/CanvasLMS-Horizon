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

// Canvas LMS の提出オブジェクトから提出済みかどうかを包括的に判定
function isSubmissionCompleted(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const state = String(sub.workflow_state || sub.workflowState || '').toLowerCase();
  if (state === 'submitted' || state === 'graded' || state === 'pending_review' || state === 'complete') {
    return true;
  }
  if (Boolean(sub.excused)) return true;
  if (Boolean(sub.submitted_at || sub.submittedAt)) return true;
  if (typeof sub.attempt === 'number' && sub.attempt > 0) return true;
  if (Array.isArray(sub.attachments) && sub.attachments.length > 0) return true;
  if (typeof sub.body === 'string' && sub.body.trim().length > 0) return true;
  if (typeof sub.url === 'string' && sub.url.trim().length > 0) return true;
  if (sub.score !== null && sub.score !== undefined && state !== 'unsubmitted') return true;
  if (sub.grade !== null && sub.grade !== undefined && String(sub.grade).trim() !== '' && state !== 'unsubmitted') return true;
  if (Array.isArray(sub.submission_history)) {
    for (const hist of sub.submission_history) {
      if (!hist || typeof hist !== 'object') continue;
      const hState = String(hist.workflow_state || '').toLowerCase();
      if (
        hState === 'submitted' ||
        hState === 'graded' ||
        hState === 'pending_review' ||
        hState === 'complete' ||
        Boolean(hist.submitted_at) ||
        (typeof hist.attempt === 'number' && hist.attempt > 0) ||
        (Array.isArray(hist.attachments) && hist.attachments.length > 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isSubmissionGraded(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const state = String(sub.workflow_state || sub.workflowState || '').toLowerCase();
  if (state === 'graded' || state === 'complete') return true;
  if (sub.score !== null && sub.score !== undefined && Boolean(sub.graded_at || sub.gradedAt)) return true;
  return false;
}

function parseNextLink(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
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
      groupedMaterials: new Map(), // 授業回別講義資料のキャッシュ
      resolvedUrls: new Map(),
      submittedOverrides: new Map() // 提出完了確認済み課題の永続オーバーライド（Canvasレプリカラグ対策）
    };
    // バッテリー消費削減のため、キャッシュ有効期間を現実的な講義サイクルに合わせて最適化
    this.CACHE_TTL = 15 * 60 * 1000; // 15分（課題一覧など）
    this.COURSES_CACHE_TTL = 60 * 60 * 1000; // 60分（コース一覧）
    this.MATERIALS_CACHE_TTL = 30 * 60 * 1000; // 30分（講義資料モジュール）
    this.queue = new RequestQueue(4); // Canvas APIへの同時リクエスト数を4に制御して安定性を最大化
    this.inflightRequests = new Map(); // 重複GETリクエストのデデュープ
    this._saveCacheTimer = null;

    const userDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Canvas Horizon');
    if (!fs.existsSync(userDir)) {
      try { fs.mkdirSync(userDir, { recursive: true }); } catch (e) {}
    }
    this.cacheFilePath = path.join(userDir, 'cache.json');
    this.loadDiskCache();

    // 15分ごとに期限切れインメモリキャッシュを自動パージしてメモリを最小化
    const cleanupInterval = setInterval(() => this.cleanExpiredEntries(), 15 * 60 * 1000);
    if (cleanupInterval.unref) cleanupInterval.unref();
  }

  // LRUキャッシュ設定ヘルパー（上限を超えた古いエントリを破棄してメモリリーク防止）
  setLru(map, key, value, max = 60) {
    if (!map) return;
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size > max) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
  }

  // 期限切れキャッシュのパージ（メモリの無駄をゼロに）
  cleanExpiredEntries() {
    const now = Date.now();
    for (const [k, v] of this.cache.assignments.entries()) {
      if (v && v.time && (now - v.time > this.CACHE_TTL * 2)) {
        this.cache.assignments.delete(k);
      }
    }
    for (const [k, v] of this.cache.groupedMaterials.entries()) {
      if (v && v.time && (now - v.time > this.MATERIALS_CACHE_TTL * 2)) {
        this.cache.groupedMaterials.delete(k);
      }
    }
    for (const [k, v] of this.cache.resolvedUrls.entries()) {
      if (v && v.time && (now - v.time > 30 * 60 * 1000)) {
        this.cache.resolvedUrls.delete(k);
      }
    }
    for (const [k, v] of this.cache.modules.entries()) {
      if (v && v.time && (now - v.time > this.CACHE_TTL * 2)) {
        this.cache.modules.delete(k);
      }
    }
    for (const [k, v] of this.cache.files.entries()) {
      if (v && v.time && (now - v.time > this.CACHE_TTL * 2)) {
        this.cache.files.delete(k);
      }
    }
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
          if (parsed.submittedOverrides && typeof parsed.submittedOverrides === 'object') {
            const maxAgeMs = 180 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            for (const [k, v] of Object.entries(parsed.submittedOverrides)) {
              if (v && (!v.updatedAt || now - v.updatedAt < maxAgeMs)) {
                this.cache.submittedOverrides.set(k, v);
              }
            }
          }
          // スキーマバージョンが一致する場合のみ詳細キャッシュを復元（ロック情報・URL正規化の整合性保証）
          if (parsed.schemaVersion === 2) {
            if (Array.isArray(parsed.allAssignments)) {
              this.cache.allAssignments = parsed.allAssignments;
              this.cache.allAssignmentsTime = parsed.allAssignmentsTime || 0;
            }
            if (parsed.assignments && typeof parsed.assignments === 'object') {
              for (const [k, v] of Object.entries(parsed.assignments)) {
                this.cache.assignments.set(k, v);
              }
            }
            if (parsed.groupedMaterials && typeof parsed.groupedMaterials === 'object') {
              for (const [k, v] of Object.entries(parsed.groupedMaterials)) {
                this.cache.groupedMaterials.set(k, v);
              }
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
        const groupedMaterialsObj = {};
        for (const [k, v] of this.cache.groupedMaterials.entries()) {
          groupedMaterialsObj[k] = v;
        }
        const submittedOverridesObj = {};
        if (this.cache.submittedOverrides) {
          for (const [k, v] of this.cache.submittedOverrides.entries()) {
            submittedOverridesObj[k] = v;
          }
        }
        const data = {
          schemaVersion: 2,
          profile: this.cache.profile,
          courses: this.cache.courses,
          coursesTime: this.cache.coursesTime,
          allAssignments: this.cache.allAssignments,
          allAssignmentsTime: this.cache.allAssignmentsTime,
          assignments: assignmentsObj,
          groupedMaterials: groupedMaterialsObj,
          submittedOverrides: submittedOverridesObj
        };
        fs.promises.writeFile(this.cacheFilePath, JSON.stringify(data), 'utf-8').catch(() => {});
      } catch (e) {
        console.warn('Failed to save disk cache:', e.message);
      }
    }, 800);
    if (this._saveCacheTimer && this._saveCacheTimer.unref) {
      this._saveCacheTimer.unref();
    }
  }

  // 全キャッシュのクリア（メモリ・ディスク両方）
  clearAllCache(keepProfile = true) {
    if (this.pendingMaterialsPromises) {
      this.pendingMaterialsPromises.clear();
    }
    const profile = keepProfile ? this.cache.profile : null;
    const submittedOverrides = keepProfile && this.cache.submittedOverrides
      ? new Map(this.cache.submittedOverrides)
      : new Map();
    this.cache = {
      profile,
      courses: null,
      coursesTime: 0,
      allAssignments: null,
      allAssignmentsTime: 0,
      assignments: new Map(),
      modules: new Map(),
      files: new Map(),
      groupedMaterials: new Map(),
      resolvedUrls: new Map(),
      submittedOverrides
    };
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        if (profile || submittedOverrides.size > 0) {
          const submittedOverridesObj = {};
          for (const [k, v] of submittedOverrides.entries()) {
            submittedOverridesObj[k] = v;
          }
          fs.writeFileSync(
            this.cacheFilePath,
            JSON.stringify({ schemaVersion: 2, profile, submittedOverrides: submittedOverridesObj }, null, 2),
            'utf-8'
          );
        } else {
          fs.unlinkSync(this.cacheFilePath);
        }
      }
    } catch (e) {
      console.warn('Failed to clear cache file:', e.message);
    }
  }

  // 提出完了が確認された課題のステータスを即時記録（Canvasレプリカラグによる未提出への先祖返りを防止）
  recordSubmittedOverride(courseId, assignmentId, subData = {}) {
    if (!courseId || !assignmentId) return;
    if (!this.cache.submittedOverrides) {
      this.cache.submittedOverrides = new Map();
    }
    const key = `${courseId}_${assignmentId}`;
    const existing = this.cache.submittedOverrides.get(key) || {};
    const override = {
      courseId: String(courseId),
      assignmentId: String(assignmentId),
      isSubmitted: true,
      isGraded: Boolean(isSubmissionGraded(subData) || existing.isGraded),
      submittedAt: subData.submitted_at || subData.submittedAt || existing.submittedAt || new Date().toISOString(),
      workflowState: subData.workflow_state || subData.workflowState || existing.workflowState || 'submitted',
      attempt: subData.attempt || existing.attempt || 1,
      score: subData.score !== undefined ? subData.score : (existing.score ?? null),
      grade: subData.grade !== undefined ? subData.grade : (existing.grade ?? null),
      body: subData.body || existing.body || null,
      url: subData.url || existing.url || null,
      attachments: Array.isArray(subData.attachments) && subData.attachments.length > 0
        ? subData.attachments.map(att => ({
            id: att.id,
            displayName: att.displayName || att.display_name || att.filename,
            filename: att.filename || att.displayName || att.display_name,
            size: att.size || 0,
            contentType: att.contentType || att['content-type'] || att.content_type,
            url: att.url,
            createdAt: att.createdAt || att.created_at
          }))
        : (existing.attachments || []),
      updatedAt: Date.now()
    };
    this.cache.submittedOverrides.set(key, override);

    // インメモリキャッシュ内の課題一覧・全体課題・講義資料も即時同期
    for (const [, entry] of this.cache.assignments.entries()) {
      if (entry && Array.isArray(entry.data)) {
        entry.data.forEach(a => {
          if (String(a.id) === String(assignmentId) && String(a.courseId) === String(courseId)) {
            a.isSubmitted = true;
            if (override.isGraded) a.isGraded = true;
            a.submission = {
              ...(a.submission || {}),
              submittedAt: override.submittedAt,
              workflowState: override.workflowState,
              attempt: override.attempt,
              score: override.score,
              grade: override.grade,
              body: override.body,
              url: override.url,
              attachments: override.attachments.length > 0 ? override.attachments : (a.submission?.attachments || [])
            };
          }
        });
      }
    }
    if (Array.isArray(this.cache.allAssignments)) {
      this.cache.allAssignments.forEach(a => {
        if (String(a.id) === String(assignmentId) && String(a.courseId) === String(courseId)) {
          a.isSubmitted = true;
          if (override.isGraded) a.isGraded = true;
          a.submission = {
            ...(a.submission || {}),
            submittedAt: override.submittedAt,
            workflowState: override.workflowState,
            attempt: override.attempt,
            score: override.score,
            grade: override.grade,
            body: override.body,
            url: override.url,
            attachments: override.attachments.length > 0 ? override.attachments : (a.submission?.attachments || [])
          };
        }
      });
    }
    const matEntry = this.cache.groupedMaterials.get(String(courseId));
    if (matEntry && Array.isArray(matEntry.data)) {
      matEntry.data.forEach(mod => {
        (mod.items || []).forEach(it => {
          if (it.type === 'Assignment' && (String(it.assignmentId) === String(assignmentId) || String(it.id) === String(assignmentId))) {
            it.isSubmitted = true;
            if (override.isGraded) it.isGraded = true;
          }
        });
      });
    }
    this.saveDiskCacheDebounced();
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

    // 同一GETリクエストの重複排除およびページネーション自動追従
    if (isGet) {
      if (this.inflightRequests.has(url)) {
        return this.inflightRequests.get(url);
      }
      const promise = (async () => {
        const res = await this.request(url, options);
        const firstPage = await res.json();
        const linkHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Link') : null;
        let nextUrl = Array.isArray(firstPage) ? parseNextLink(linkHeader) : null;
        if (!nextUrl) return firstPage;

        const combined = [...firstPage];
        let pageCount = 1;
        while (nextUrl && pageCount < 5) {
          pageCount++;
          const nextRes = await this.request(nextUrl, options);
          const nextData = await nextRes.json();
          if (Array.isArray(nextData)) {
            combined.push(...nextData);
          } else {
            break;
          }
          const nextLink = nextRes.headers && typeof nextRes.headers.get === 'function' ? nextRes.headers.get('Link') : null;
          nextUrl = parseNextLink(nextLink);
        }
        return combined;
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
    if (!forceRefresh && this.cache.courses && (now - this.cache.coursesTime < this.COURSES_CACHE_TTL)) {
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
          const effectiveCourseId = a.course_id || courseId;
          const override = this.cache.submittedOverrides?.get(`${effectiveCourseId}_${a.id}`) ||
                           this.cache.submittedOverrides?.get(`${courseId}_${a.id}`) ||
                           null;
          const rawSubmitted = isSubmissionCompleted(sub) ||
            Boolean(a.has_submitted_submissions && sub && String(sub.workflow_state || '').toLowerCase() !== 'unsubmitted');
          const isSubmitted = Boolean(rawSubmitted || (override && override.isSubmitted));
          const isGraded = Boolean(isSubmissionGraded(sub) || (override && override.isGraded));

          const mappedAttachments = sub && Array.isArray(sub.attachments) && sub.attachments.length > 0
            ? sub.attachments.map(att => ({
                id: att.id,
                displayName: att.display_name || att.displayName || att.filename,
                filename: att.filename || att.display_name || att.displayName,
                size: att.size,
                contentType: att.content_type || att['content-type'] || att.contentType,
                url: att.url,
                createdAt: att.created_at || att.createdAt
              }))
            : (override?.attachments || []);

          return {
            id: a.id,
            courseId: effectiveCourseId,
            quizId: a.quiz_id || null,
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
            submission: (sub || override) ? {
              id: sub?.id || null,
              submittedAt: sub?.submitted_at || override?.submittedAt || null,
              score: sub?.score ?? override?.score ?? null,
              grade: sub?.grade ?? override?.grade ?? null,
              workflowState: (rawSubmitted ? sub?.workflow_state : (override?.workflowState || sub?.workflow_state)) || (isSubmitted ? 'submitted' : 'unsubmitted'),
              attempt: sub?.attempt || override?.attempt || (isSubmitted ? 1 : null),
              body: sub?.body || override?.body || null,
              url: sub?.url || override?.url || null,
              attachments: mappedAttachments,
              submissionComments: (sub?.submission_comments || []).map(sc => ({
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

      this.setLru(this.cache.assignments, cacheKey, { time: now, data: formatted });
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
      modules = await this.fetchJson(`/api/v1/courses/${courseId}/modules?include[]=items&include[]=content_details&per_page=100`);
    } catch (e) {
      console.warn(`Could not fetch modules for course ${courseId}:`, e.message);
      modules = [];
    }

    const formatted = (Array.isArray(modules) ? modules : []).map(m => {
      const isModuleLocked = Boolean(m.locked_for_user || m.state === 'locked' || (m.unlock_at && new Date(m.unlock_at) > new Date()));
      const isModulePublished = m.published !== false && m.workflow_state !== 'unpublished';

      return {
        id: m.id,
        name: m.name,
        position: m.position,
        itemsCount: m.items_count,
        published: isModulePublished,
        workflowState: m.workflow_state || null,
        state: m.state || (isModuleLocked ? 'locked' : 'unlocked'),
        unlockAt: m.unlock_at || null,
        isLocked: isModuleLocked,
        items: (m.items || []).map(it => {
          const itemUnlockAt = it.unlock_at || it.lock_info?.unlock_at || it.content_details?.unlock_at || null;
          const itemLockAt = it.lock_at || it.lock_info?.lock_at || it.content_details?.lock_at || null;
          const isItemLocked = Boolean(
            it.locked ||
            it.locked_for_user ||
            it.content_details?.locked ||
            it.content_details?.locked_for_user ||
            it.lock_info ||
            it.content_details?.lock_info ||
            it.workflow_state === 'unpublished' ||
            it.published === false ||
            isModuleLocked ||
            (itemUnlockAt && new Date(itemUnlockAt) > new Date()) ||
            (itemLockAt && new Date(itemLockAt) <= new Date())
          );
          const isItemPublished = it.published !== false && it.workflow_state !== 'unpublished' && isModulePublished;
          const isItemCompleted = Boolean(it.completion_requirement && it.completion_requirement.completed);

          const cd = it.content_details || {};
          const resolvedDisplayName = cd.display_name || cd.filename || it.title || '資料';
          const resolvedFilename = cd.filename || cd.display_name || it.title || '資料';
          const resolvedContentType = cd['content-type'] || cd.content_type || null;
          const resolvedSize = typeof cd.size === 'number' ? cd.size : (cd.size ? parseInt(cd.size, 10) : null);

          return {
            id: it.id,
            title: it.title,
            displayName: resolvedDisplayName,
            filename: resolvedFilename,
            contentType: resolvedContentType,
            size: resolvedSize,
            type: it.type, // 'File', 'Assignment', 'Page', 'ExternalUrl', 'Quiz' など
            contentId: it.content_id,
            quizId: cd.quiz_id || (it.type === 'Quiz' ? it.content_id : null) || null,
            pageUrl: it.page_url || null,
            htmlUrl: it.html_url,
            url: it.url, // ファイル解決用API URL
            externalUrl: it.external_url || null,
            published: isItemPublished,
            workflowState: it.workflow_state || null,
            isCompleted: isItemCompleted,
            lockedForUser: Boolean(it.locked_for_user || cd.locked_for_user),
            isLocked: isItemLocked,
            lockInfo: it.lock_info || cd.lock_info || null,
            unlockAt: itemUnlockAt,
            lockExplanation: it.lock_explanation || it.lock_info?.lock_explanation || cd.lock_explanation || null
          };
        })
      };
    });

    this.setLru(this.cache.modules, cacheKey, { time: now, data: formatted });
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
            filename: f.filename || f.display_name,
            size: f.size,
            contentType: f['content-type'] || f.content_type,
            url: f.url || null,
            createdAt: f.created_at,
            updatedAt: f.updated_at,
            isLocked: Boolean(
              f.locked ||
              f.locked_for_user ||
              f.hidden ||
              f.hidden_for_user ||
              f.lock_info ||
              (f.unlock_at && new Date(f.unlock_at) > new Date()) ||
              (f.lock_info?.unlock_at && new Date(f.lock_info.unlock_at) > new Date()) ||
              (f.lock_at && new Date(f.lock_at) <= new Date()) ||
              (f.lock_info?.lock_at && new Date(f.lock_info.lock_at) <= new Date())
            ),
            lockedForUser: Boolean(f.locked_for_user || f.locked),
            unlockAt: f.unlock_at || f.lock_info?.unlock_at || null,
            lockExplanation: f.lock_explanation || f.lock_info?.lock_explanation || null,
            source: 'files'
          });
        });
      }
    } catch (e) {
      // 403 の場合はモジュールからファイルを集約
    }

    // 2. モジュールから 'File' タイプのアイテムを取得・高速マッピング
    // （大量の直列/バッチHTTPリクエストを完全排除し、瞬時の科目表示とバッテリー節約を実現）
    const modules = await this.getModules(courseId, forceRefresh);
    modules.forEach(m => {
      (m.items || []).forEach(it => {
        if (it.type === 'File' && it.contentId && !fileMap.has(String(it.contentId))) {
          const title = it.title || 'ファイル';
          const resolvedName = it.displayName || it.filename || title;
          const isPdf = resolvedName.toLowerCase().endsWith('.pdf') ||
                        it.contentType === 'application/pdf' ||
                        !resolvedName.includes('.'); // 拡張子がない講義資料はPDFデフォルト
          fileMap.set(String(it.contentId), {
            id: it.contentId,
            displayName: resolvedName,
            filename: it.filename || resolvedName,
            size: it.size || 0,
            contentType: it.contentType || (isPdf ? 'application/pdf' : 'application/octet-stream'),
            url: it.url || null,
            createdAt: null,
            updatedAt: null,
            isLocked: Boolean(it.isLocked || m.isLocked),
            lockedForUser: Boolean(it.lockedForUser || it.isLocked || m.isLocked),
            unlockAt: it.unlockAt || null,
            lockExplanation: it.lockExplanation || null,
            moduleName: m.name,
            source: 'module'
          });
        }
      });
    });

    const result = Array.from(fileMap.values());
    this.setLru(this.cache.files, cacheKey, { time: now, data: result });
    return result;
  }

  // 授業回（モジュール）ごとにグループ化された講義資料を取得
  async getCourseMaterialsGrouped(courseId, forceRefresh = false) {
    const cacheKey = String(courseId);
    const cached = this.cache.groupedMaterials.get(cacheKey);
    const now = Date.now();

    // キャッシュが有効なら即時返却（通信・CPU・バッテリー消費を完全抑制）
    if (!forceRefresh && cached && (now - cached.time < this.MATERIALS_CACHE_TTL)) {
      return cached.data;
    }

    if (!this.pendingMaterialsPromises) {
      this.pendingMaterialsPromises = new Map();
    }
    if (this.pendingMaterialsPromises.has(cacheKey)) {
      return this.pendingMaterialsPromises.get(cacheKey);
    }

    const fetchPromise = (async () => {
      try {
        const [modules, files, assignments] = await Promise.all([
          this.getModules(courseId, forceRefresh),
          this.getCourseFiles(courseId, forceRefresh),
          this.getAssignments(courseId, forceRefresh, true).catch(() => [])
        ]);

    const fileMapById = new Map();
    files.forEach(f => fileMapById.set(String(f.id), f));

    const assignMapById = new Map();
    const assignMapByQuizId = new Map();
    const assignMapByName = new Map();
    (assignments || []).forEach(a => {
      assignMapById.set(String(a.id), a);
      if (a.quizId) assignMapByQuizId.set(String(a.quizId), a);
      if (a.name) assignMapByName.set(a.name.trim(), a);
    });

    const grouped = [];

    modules.forEach(m => {
      const moduleFiles = [];
      (m.items || []).forEach(it => {
        const commonProps = {
          published: it.published,
          isLocked: it.isLocked,
          lockedForUser: it.lockedForUser,
          unlockAt: it.unlockAt,
          lockExplanation: it.lockExplanation,
          workflowState: it.workflowState
        };

        if (it.type === 'File') {
          const resolved = fileMapById.get(String(it.contentId)) || {};
          const resolvedDisplayName = resolved.displayName || it.displayName || it.title;
          const resolvedFilename = resolved.filename || it.filename || resolvedDisplayName;
          const resolvedSize = resolved.size || it.size || 0;
          const resolvedContentType = resolved.contentType || it.contentType || 
            (resolvedDisplayName.toLowerCase().endsWith('.pdf') || resolvedFilename.toLowerCase().endsWith('.pdf') || !resolvedDisplayName.includes('.')
              ? 'application/pdf' : 'application/octet-stream');

          moduleFiles.push({
            id: it.contentId,
            itemId: it.id,
            title: it.title,
            displayName: resolvedDisplayName,
            filename: resolvedFilename,
            size: resolvedSize,
            contentType: resolvedContentType,
            url: resolved.url || it.url || null,
            type: 'File',
            htmlUrl: it.htmlUrl,
            ...commonProps,
            isLocked: Boolean(it.isLocked || resolved.isLocked || it.lockedForUser || resolved.lockedForUser || m.isLocked),
            lockedForUser: Boolean(it.lockedForUser || resolved.lockedForUser || it.isLocked || resolved.isLocked || m.isLocked),
            unlockAt: resolved.unlockAt || it.unlockAt || null,
            lockExplanation: resolved.lockExplanation || it.lockExplanation || null
          });
        } else if (it.type === 'Page') {
          let rawPageUrl = it.pageUrl || it.page_url || (it.url ? it.url.split('/').pop() : null);
          if (rawPageUrl) {
            try {
              for (let i = 0; i < 2; i++) {
                const dec = decodeURIComponent(rawPageUrl);
                if (dec === rawPageUrl) break;
                rawPageUrl = dec;
              }
            } catch (_) {}
          }
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: 'Page',
            pageUrl: rawPageUrl,
            apiUrl: it.url,
            htmlUrl: it.htmlUrl,
            ...commonProps
          });
        } else if (it.type === 'Assignment') {
          const assign = assignMapById.get(String(it.contentId)) ||
                         (it.quizId ? assignMapByQuizId.get(String(it.quizId)) : null) ||
                         assignMapById.get(String(it.id)) ||
                         assignMapByName.get((it.title || '').trim()) || null;
          const effectiveAssignId = assign?.id || it.contentId || it.id;
          const override = this.cache.submittedOverrides?.get(`${courseId}_${effectiveAssignId}`) || null;
          const isItemSubmitted = Boolean(
            (assign && assign.isSubmitted) ||
            (override && override.isSubmitted) ||
            it.isCompleted
          );
          const isItemGraded = Boolean(
            (assign && assign.isGraded) ||
            (override && override.isGraded)
          );
          moduleFiles.push({
            id: effectiveAssignId,
            itemId: it.id,
            title: it.title,
            type: 'Assignment',
            assignmentId: effectiveAssignId,
            description: assign?.description || '',
            htmlUrl: assign?.htmlUrl || it.htmlUrl,
            isSubmitted: isItemSubmitted,
            isGraded: isItemGraded,
            dueAt: assign?.dueAt || null,
            pointsPossible: assign?.pointsPossible ?? null,
            submission: assign?.submission || null,
            submissionTypes: assign?.submissionTypes || ['online_upload'],
            ...commonProps,
            isLocked: Boolean(it.isLocked || assign?.isLocked),
            unlockAt: assign?.unlockAt || it.unlockAt || null,
            lockExplanation: assign?.lockExplanation || it.lockExplanation || null
          });
        } else if (it.type === 'Discussion' || it.type === 'DiscussionTopic') {
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: 'Discussion',
            topicId: it.contentId || it.id,
            url: it.url,
            htmlUrl: it.htmlUrl,
            ...commonProps
          });
        } else if (it.type === 'ExternalUrl') {
          moduleFiles.push({
            id: it.id,
            itemId: it.id,
            title: it.title,
            type: 'ExternalUrl',
            url: it.externalUrl, // 外部直接URL（YouTube動画など）
            htmlUrl: it.htmlUrl,
            ...commonProps
          });
        } else if (it.type !== 'SubHeader') {
          moduleFiles.push({
            id: it.contentId || it.id,
            itemId: it.id,
            title: it.title,
            type: it.type,
            url: it.externalUrl || it.url,
            htmlUrl: it.htmlUrl,
            ...commonProps
          });
        }
      });

      if (moduleFiles.length > 0) {
        grouped.push({
          id: m.id,
          name: m.name,
          position: m.position,
          published: m.published,
          isLocked: m.isLocked,
          unlockAt: m.unlockAt,
          workflowState: m.workflowState,
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
          filename: f.filename || f.displayName,
          size: f.size,
          contentType: f.contentType,
          url: f.url,
          isLocked: Boolean(f.isLocked),
          lockedForUser: Boolean(f.lockedForUser),
          unlockAt: f.unlockAt || null,
          lockExplanation: f.lockExplanation || null,
          type: 'File'
        }))
      });
    }

    // モジュールもファイルも0件のコースの場合、Wikiページ一覧またはフロントページをフォールバック探索
    if (grouped.length === 0) {
      try {
        const pages = await this.fetchJson(`/api/v1/courses/${courseId}/pages?per_page=50`);
        if (Array.isArray(pages) && pages.length > 0) {
          grouped.push({
            id: 'course_pages',
            name: '講義ページ・ノート',
            position: 1,
            items: pages.map(p => ({
              id: p.page_id || p.url,
              itemId: p.page_id || p.url,
              title: p.title || p.url,
              type: 'Page',
              pageUrl: p.url,
              htmlUrl: p.html_url,
              isLocked: Boolean(p.locked_for_user),
              lockedForUser: Boolean(p.locked_for_user),
              lockExplanation: p.lock_explanation || null
            }))
          });
        }
      } catch (_) {}
    }

        this.setLru(this.cache.groupedMaterials, cacheKey, { time: now, data: grouped });
        this.saveDiskCacheDebounced();
        return grouped;
      } finally {
        if (this.pendingMaterialsPromises) {
          this.pendingMaterialsPromises.delete(cacheKey);
        }
      }
    })();

    this.pendingMaterialsPromises.set(cacheKey, fetchPromise);
    return fetchPromise;
  }

  // 講義ページ（Wikiページ）の本文を取得（Canvas LMSを開かずにアプリ内で全文表示）
  async getPage(courseId, pageUrl) {
    let cleanSlug = String(pageUrl || '').trim();
    try {
      for (let i = 0; i < 3; i++) {
        const dec = decodeURIComponent(cleanSlug);
        if (dec === cleanSlug) break;
        cleanSlug = dec;
      }
    } catch (_) {}

    const data = await this.fetchJson(`/api/v1/courses/${courseId}/pages/${encodeURIComponent(cleanSlug)}`);
    return {
      title: data.title,
      body: data.body || '',
      updatedAt: data.updated_at,
      url: data.html_url,
      lockedForUser: Boolean(data.locked_for_user),
      lockExplanation: data.lock_explanation || data.lock_info?.lock_explanation || null,
      unlockAt: data.unlock_at || data.lock_info?.unlock_at || null,
      lockAt: data.lock_info?.lock_at || null
    };
  }

  // ディスカッショントピックの本文を取得
  async getDiscussion(courseId, topicId) {
    const data = await this.fetchJson(`/api/v1/courses/${courseId}/discussion_topics/${encodeURIComponent(topicId)}`);
    return {
      title: data.title || 'ディスカッション',
      body: data.message || '',
      updatedAt: data.posted_at || data.last_reply_at || null,
      url: data.html_url || null,
      author: data.user_name || (data.author ? data.author.display_name : null),
      lockedForUser: Boolean(data.locked_for_user),
      lockExplanation: data.lock_explanation || data.lock_info?.lock_explanation || null
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

    // ファイル詳細APIから最新の署名付きURLを取得（コース指定で失敗した場合はグローバル /api/v1/files/:id へフォールバック）
    let fileData = null;
    if (courseId) {
      try {
        fileData = await this.fetchJson(`/api/v1/courses/${courseId}/files/${fileId}`);
      } catch (_) {
        fileData = await this.fetchJson(`/api/v1/files/${fileId}`);
      }
    } else {
      fileData = await this.fetchJson(`/api/v1/files/${fileId}`);
    }

    if (fileData && this.cache.resolvedUrls) {
      this.setLru(this.cache.resolvedUrls, cacheKey, { data: fileData, time: now }, 100);
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

    // 提出完了オーバーライドを記録（Canvasレプリカラグ対策）およびキャッシュ無効化
    this.recordSubmittedOverride(courseId, assignmentId, {
      ...(submissionData || {}),
      attachments: (Array.isArray(submissionData?.attachments) && submissionData.attachments.length > 0)
        ? submissionData.attachments
        : uploadedFiles
    });
    this.cache.assignments.delete(String(courseId) + '_recent');
    this.cache.assignments.delete(String(courseId) + '_all');
    this.cache.assignments.delete(String(courseId));
    this.cache.groupedMaterials.delete(String(courseId));
    this.cache.allAssignments = null;
    this.saveDiskCacheDebounced();

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

    const submissionData = await res.json();
    this.recordSubmittedOverride(courseId, assignmentId, {
      ...(submissionData || {}),
      body: body || submissionData?.body || null,
      url: url || submissionData?.url || null
    });
    this.cache.assignments.delete(String(courseId) + '_recent');
    this.cache.assignments.delete(String(courseId) + '_all');
    this.cache.assignments.delete(String(courseId));
    this.cache.groupedMaterials.delete(String(courseId));
    this.cache.allAssignments = null;
    this.saveDiskCacheDebounced();
    return submissionData;
  }

  // 課題の最新の提出情報（添付ファイル・履歴・課題詳細含む）をCanvasからダイレクト取得
  async getAssignmentSubmission(courseId, assignmentId) {
    try {
      const sub = await this.fetchJson(
        `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self?include[]=submission_history&include[]=submission_comments&include[]=rubric_assessment&include[]=assignment`
      );
      if (!sub || sub.errors) return null;

      // 最新の attempt の attachments を最優先で取得
      let attachments = Array.isArray(sub.attachments) ? sub.attachments : [];
      if (Array.isArray(sub.submission_history) && sub.submission_history.length > 0) {
        // attempt番号が最大の履歴を探す
        const sortedHist = [...sub.submission_history].sort((a, b) => (b.attempt || 0) - (a.attempt || 0));
        const latestHist = sortedHist[0];
        if (Array.isArray(latestHist?.attachments) && latestHist.attachments.length > 0) {
          // 重複IDを排除しつつマージまたは最新を優先
          const seenIds = new Set();
          const merged = [];
          latestHist.attachments.forEach(att => {
            seenIds.add(String(att.id));
            merged.push(att);
          });
          attachments.forEach(att => {
            if (!seenIds.has(String(att.id))) {
              merged.push(att);
            }
          });
          attachments = merged;
        }
      }

      const assignObj = sub.assignment || null;
      const override = this.cache.submittedOverrides?.get(`${courseId}_${assignmentId}`) || null;
      const rawSubmitted = isSubmissionCompleted({ ...sub, attachments });
      const isSubmitted = Boolean(rawSubmitted || (override && override.isSubmitted));
      const isGraded = Boolean(isSubmissionGraded(sub) || (override && override.isGraded));

      if (rawSubmitted) {
        this.recordSubmittedOverride(courseId, assignmentId, { ...sub, attachments });
      }

      return {
        id: sub.id,
        assignmentId: sub.assignment_id || assignmentId,
        userId: sub.user_id,
        submittedAt: sub.submitted_at || override?.submittedAt || null,
        score: sub.score ?? override?.score ?? null,
        grade: sub.grade ?? override?.grade ?? null,
        workflowState: (rawSubmitted ? sub.workflow_state : (override?.workflowState || sub.workflow_state)) || (isSubmitted ? 'submitted' : 'unsubmitted'),
        attempt: sub.attempt || override?.attempt || (isSubmitted ? 1 : null),
        body: sub.body || override?.body || null,
        url: sub.url || override?.url || null,
        submissionType: sub.submission_type,
        late: Boolean(sub.late),
        missing: Boolean(sub.missing),
        isSubmitted,
        isGraded,
        assignmentDescription: assignObj?.description || null,
        assignmentDueAt: assignObj?.due_at || null,
        assignmentPointsPossible: assignObj?.points_possible ?? null,
        assignmentSubmissionTypes: assignObj?.submission_types || null,
        assignmentHtmlUrl: assignObj?.html_url || null,
        assignmentIsLocked: Boolean(assignObj?.locked_for_user),
        assignmentLockedForUser: Boolean(assignObj?.locked_for_user),
        assignmentLockExplanation: assignObj?.lock_explanation || assignObj?.lock_info?.lock_explanation || null,
        assignmentUnlockAt: assignObj?.unlock_at || assignObj?.lock_info?.unlock_at || null,
        assignmentLockAt: assignObj?.lock_at || assignObj?.lock_info?.lock_at || null,
        attachments: (attachments || []).map(att => ({
          id: att.id,
          displayName: att.display_name || att.filename,
          filename: att.filename,
          size: att.size || 0,
          contentType: att['content-type'] || att.content_type,
          url: att.url,
          createdAt: att.created_at
        })),
        submissionComments: (sub.submission_comments || []).map(sc => ({
          id: sc.id,
          authorName: sc.author_name,
          comment: sc.comment,
          createdAt: sc.created_at
        }))
      };
    } catch (err) {
      console.warn(`Could not get latest submission for assignment ${assignmentId} in course ${courseId}:`, err.message);
      return null;
    }
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
