/**
 * Canvas Horizon - フロントエンド制御ロジック
 * 洗練されたUI/UXと高速性を備えた Canvas LMS デスクトップクライアント
 */

const STORAGE_KEY_BATTERY_MODE = 'canvas_horizon_battery_mode';
const STORAGE_KEY_MANUAL_COMPLETED = 'canvas_horizon_manual_completed';

// アプリケーション全体の状態管理 (State)
const state = {
  profile: null,
  config: null,
  courses: [],
  selectedCourseId: 'all',
  allAssignments: [],
  groupedMaterials: [],
  materialsCache: new Map(), // コースID -> 講義資料のインメモリキャッシュ
  announcements: [],
  activeView: 'dashboard',
  assignmentFilter: 'unsubmitted', // デフォルトは未提出課題を表示
  onlyCurrentQuarterTasks: false, // 今学期の課題のみに絞り込み
  sidebarQuarterFilter: 'all', // サイドバーの学期フィルター ('all' | '1Q' | '2Q' | '3Q' | '4Q')
  currentQuarter: '',
  dashboardSearchQuery: '',
  dashboardSort: 'due-asc',
  currentModalAssignment: null,
  filesQueue: [],
  isSubmitting: false,
  materialsCourseId: null,
  batteryMode: (() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_BATTERY_MODE);
      if (saved && ['auto', 'on', 'off'].includes(saved)) return saved;
    } catch (_) {}
    return 'auto';
  })(), // 'auto' | 'on' | 'off'
  isBatterySaving: false,
  isOnBattery: false,
  manualCompletedAssignments: (() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_MANUAL_COMPLETED);
      return new Set(saved ? JSON.parse(saved) : []);
    } catch (_) {
      return new Set();
    }
  })()
};

function isAssignmentManuallyCompleted(id) {
  return state.manualCompletedAssignments.has(String(id));
}

function toggleAssignmentManualComplete(id) {
  const sId = String(id);
  if (state.manualCompletedAssignments.has(sId)) {
    state.manualCompletedAssignments.delete(sId);
  } else {
    state.manualCompletedAssignments.add(sId);
  }
  const completedArray = [...state.manualCompletedAssignments];
  try {
    localStorage.setItem(STORAGE_KEY_MANUAL_COMPLETED, JSON.stringify(completedArray));
  } catch (_) {}
  // サーバー（AppDataディスクストレージ）へも永続化保存
  api.post('/api/assignments/manual-completed', { completedIds: completedArray }).catch(() => {});
}

// ユーティリティ関数群
const utils = {
  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  formatDate(isoString, includeYear = false) {
    if (!isoString) return '期限なし';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '期限なし';
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const y = d.getFullYear();
    const currentYear = new Date().getFullYear();
    const m = d.getMonth() + 1;
    const date = d.getDate();
    const day = days[d.getDay()];
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');

    const yearPrefix = (includeYear || y !== currentYear) ? `${y}年` : '';
    return `${yearPrefix}${m}月${date}日(${day}) ${h}:${min}`;
  },

  getDueUrgency(isoString, isSubmitted, assignmentId = null) {
    const isManuallyDone = assignmentId ? isAssignmentManuallyCompleted(assignmentId) : false;
    if (isSubmitted || isManuallyDone) return { text: isSubmitted ? '提出済み' : '完了', level: 'submitted' };
    if (!isoString) return { text: '期限なし', level: 'none' };
    const now = new Date();
    const due = new Date(isoString);
    const diffMs = due - now;

    if (diffMs < 0) {
      const diffHours = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60));
      if (diffHours < 24) return { text: '本日締切超過', level: 'urgent' };
      return { text: `${Math.floor(diffHours / 24)}日前に締切`, level: 'overdue' };
    }

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 24) {
      if (diffHours <= 0) return { text: 'まもなく締切', level: 'urgent' };
      return { text: `残り ${diffHours}時間`, level: 'urgent' };
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays <= 3) {
      return { text: `残り ${diffDays}日`, level: 'pending' };
    }
    return { text: `残り ${diffDays}日`, level: 'normal' };
  },

  getCourseColor(courseIdOrName) {
    let hash = 0;
    const str = String(courseIdOrName || '');
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const idx = Math.abs(hash) % 6;
    return {
      index: idx,
      tagClass: `course-tag-${idx}`,
      dotClass: `course-dot-${idx}`
    };
  },

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  getFileExt(filename) {
    if (!filename) return '';
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toUpperCase() : 'FILE';
  },

  renderQuarterBadge(quarter, isCurrent = false) {
    if (!quarter) return '<span class="badge-q badge-other-q">通年</span>';
    const qLower = quarter.toLowerCase();
    const cls = ['1q', '2q', '3q', '4q'].includes(qLower) ? `badge-${qLower}` : 'badge-other-q';
    const highlightCls = isCurrent ? ' current-highlight' : '';
    const icon = isCurrent ? '<span class="current-q-dot"></span>' : '';
    return `<span class="badge-q ${cls}${highlightCls}">${icon}${quarter}</span>`;
  },

  extractYouTubeVideoId(url) {
    if (!url) return null;
    const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = String(url).match(regExp);
    return match && match[1] ? match[1] : null;
  },

  formatHtmlWithLinks(html) {
    if (!html) return '';
    // プレーンテキストで書かれたURLを検出して美しいリンクに変換
    const urlRegex = /(?![^<]*>)(https?:\/\/[^\s<>"']+)/g;
    let formatted = html.replace(urlRegex, (url) => {
      const ytId = utils.extractYouTubeVideoId(url);
      if (ytId) {
        return `<a href="${url}" class="formatted-url-link yt-inline-link" data-yt-id="${ytId}">▶ YouTube動画を再生</a>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="formatted-url-link">${url}</a>`;
    });
    return formatted;
  },

  openExternalUrl(url) {
    if (!url || url === '#' || url.startsWith('javascript:')) return;
    const ytId = utils.extractYouTubeVideoId(url);
    if (ytId) {
      openYouTubeModal(ytId, 'YouTube動画', url);
      return;
    }
    if (window.desktopAPI && typeof window.desktopAPI.openExternal === 'function') {
      window.desktopAPI.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
};

// 軽量デバウンス関数（入力スパイク・不要なDOM再計算を根絶）
function debounce(fn, delay = 150) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  };
}

// API 通信クライアント (重複GETリクエストの統合・インメモリキャッシュ対応)
const api = {
  _inflight: new Map(),
  _cache: new Map(),

  async get(url, options = {}) {
    const { bypassCache = false, ttl = 0 } = options;
    const now = Date.now();

    // 1. キャッシュの有効性チェック（TTL指定時）
    if (!bypassCache && ttl > 0 && this._cache.has(url)) {
      const hit = this._cache.get(url);
      if (now - hit.timestamp < ttl) {
        return hit.data;
      }
      this._cache.delete(url);
    }

    // 2. 進行中リクエストのデデュープ（同一URLへの並行フェッチを1つに統合）
    if (this._inflight.has(url)) {
      return await this._inflight.get(url);
    }

    const promise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        if (ttl > 0) {
          this._cache.set(url, { data, timestamp: Date.now() });
          // キャッシュサイズ制限（最大30件）
          if (this._cache.size > 30) {
            const firstKey = this._cache.keys().next().value;
            if (firstKey) this._cache.delete(firstKey);
          }
        }
        return data;
      } finally {
        this._inflight.delete(url);
      }
    })();

    this._inflight.set(url, promise);
    return await promise;
  },

  clearCache() {
    this._cache.clear();
  },

  async post(url, data, isFormData = false) {
    this.clearCache(); // 更新系API実行時はキャッシュをクリア
    const options = {
      method: 'POST',
      body: isFormData ? data : JSON.stringify(data)
    };
    if (!isFormData) {
      options.headers = { 'Content-Type': 'application/json' };
    }
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return await res.json();
  }
};

// トースト通知（右下通知の抑制管理）
function showToast(message, type = 'normal') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  // 右下の通知トーストはユーザー要望により非表示
}

// ダウンロード管理システム（ヘッダーアイコンと進捗バーで統合管理）
const downloadManager = {
  jobs: [],
  pollTimer: null,
  isPanelOpen: false,

  init() {
    this.btn = document.getElementById('btn-download-manager');
    this.badge = document.getElementById('download-count-badge');
    this.btnProgressBar = document.getElementById('dl-btn-progressbar');
    this.panel = document.getElementById('download-panel');
    this.closeBtn = document.getElementById('btn-close-download-panel');
    this.clearBtn = document.getElementById('btn-clear-downloads');
    this.listEl = document.getElementById('download-list');
    this.summaryEl = document.getElementById('download-panel-summary');
    this.summaryText = document.getElementById('download-summary-text');
    this.summaryPercent = document.getElementById('download-summary-percent');
    this.summaryBar = document.getElementById('download-summary-bar');

    if (this.btn) {
      this.btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePanel();
      });
    }

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePanel();
      });
    }

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.clearCompleted();
      });
    }

    // パネルの外側クリックで閉じる
    document.addEventListener('click', (e) => {
      if (this.isPanelOpen && this.panel && !this.panel.contains(e.target) && !this.btn?.contains(e.target)) {
        this.closePanel();
      }
    });

    // Escキーで閉じる
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isPanelOpen) {
        this.closePanel();
      }
    });

    // 初回ジョブ取得
    this.fetchJobs();
  },

  togglePanel() {
    if (this.isPanelOpen) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  },

  openPanel() {
    if (!this.panel) return;
    this.panel.hidden = false;
    this.isPanelOpen = true;
    this.btn?.setAttribute('aria-expanded', 'true');
    this.render();
  },

  closePanel() {
    if (!this.panel) return;
    this.panel.hidden = true;
    this.isPanelOpen = false;
    this.btn?.setAttribute('aria-expanded', 'false');
  },

  async fetchJobs() {
    try {
      const res = await api.get('/api/downloads');
      if (res.success && Array.isArray(res.downloads)) {
        this.jobs = res.downloads;
        this.render();
        this.updateState();
      }
    } catch (err) {
      console.warn('Failed to fetch downloads:', err);
    }
  },

  addJob(job) {
    if (!job) return;
    const existingIdx = this.jobs.findIndex(j => j.id === job.id);
    if (existingIdx >= 0) {
      this.jobs[existingIdx] = job;
    } else {
      this.jobs.unshift(job);
    }
    this.render();
    this.updateState();
    this.startPolling();
  },

  updateState() {
    const activeJobs = this.jobs.filter(j => j.status === 'downloading');
    const hasActive = activeJobs.length > 0;

    // Electronにダウンロード中フラグを送信（アプリ終了時の警告確認用）
    if (window.desktopAPI && typeof window.desktopAPI.setDownloadsActive === 'function') {
      window.desktopAPI.setDownloadsActive(hasActive);
    }

    // バッジ更新
    if (this.badge) {
      if (hasActive) {
        this.badge.hidden = false;
        this.badge.textContent = activeJobs.length;
      } else {
        this.badge.hidden = true;
      }
    }

    // ボタンのスタイルとインライン進捗バー更新
    if (this.btn) {
      this.btn.classList.toggle('is-active', hasActive);
    }

    if (this.btnProgressBar) {
      if (hasActive) {
        const totalProgress = activeJobs.reduce((acc, j) => acc + (j.progress || 0), 0);
        const avgProgress = Math.round(totalProgress / activeJobs.length);
        this.btnProgressBar.style.width = `${Math.max(6, avgProgress)}%`;
        this.btnProgressBar.style.display = 'block';
      } else {
        this.btnProgressBar.style.width = '0%';
        this.btnProgressBar.style.display = 'none';
      }
    }

    // ポーリング制御
    if (hasActive) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  },

  startPolling() {
    if (this.pollTimer) return;
    // 省電力モードまたはバッテリー駆動時はポーリング間隔を拡大して通信・電力をセーブ
    const interval = (state.isBatterySaving || state.isOnBattery) ? 2500 : 1200;
    this.pollTimer = setInterval(() => {
      if (document.hidden) return; // バックグラウンド時は通信を休止
      this.fetchJobs();
    }, interval);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async cancelJob(id) {
    try {
      await api.post(`/api/downloads/${id}/cancel`, {});
      await this.fetchJobs();
    } catch (err) {
      console.error('Cancel error:', err);
    }
  },

  async clearCompleted() {
    try {
      await api.post('/api/downloads/clear', {});
      this.jobs = this.jobs.filter(j => j.status === 'downloading');
      this.render();
      this.updateState();
    } catch (err) {
      console.error('Clear downloads error:', err);
    }
  },

  async openJobFolder(job) {
    if (!job) return;
    const targetPath = job.saveDir || job.fileName;
    if (targetPath) {
      if (window.desktopAPI && typeof window.desktopAPI.openPath === 'function') {
        window.desktopAPI.openPath(targetPath);
      } else {
        api.post('/api/open-path', { targetPath });
      }
    } else {
      api.post('/api/open-downloads', {});
    }
  },

  render() {
    if (!this.listEl) return;

    if (this.jobs.length === 0) {
      this.listEl.innerHTML = '<p class="download-empty">進行中のダウンロードはありません</p>';
      if (this.summaryEl) this.summaryEl.style.display = 'none';
      return;
    }

    const activeJobs = this.jobs.filter(j => j.status === 'downloading');
    if (this.summaryEl) {
      if (activeJobs.length > 0) {
        this.summaryEl.style.display = 'block';
        const total = activeJobs.reduce((sum, j) => sum + (j.progress || 0), 0);
        const avg = Math.round(total / activeJobs.length);
        if (this.summaryText) this.summaryText.textContent = `${activeJobs.length}件ダウンロード中`;
        if (this.summaryPercent) this.summaryPercent.textContent = `${avg}%`;
        if (this.summaryBar) this.summaryBar.style.width = `${avg}%`;
      } else {
        this.summaryEl.style.display = 'none';
      }
    }

    try {
      this.listEl.innerHTML = this.jobs.map(job => {
        const isYt = job.type === 'youtube';
        const isCompleted = job.status === 'completed';
        const isFailed = job.status === 'failed';
        const isCancelled = job.status === 'cancelled';
        const isDownloading = job.status === 'downloading';
        const progress = Math.min(100, Math.max(0, job.progress || 0));

        const iconHtml = isYt 
          ? `<div class="download-item-icon youtube" title="YouTube動画"><svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></div>`
          : `<div class="download-item-icon" title="講義資料・ファイル"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></div>`;

        let statusText = job.message || '';
        if (isCompleted) {
          statusText = `✓ 保存完了`;
        } else if (isFailed) {
          statusText = `✕ 失敗: ${job.error || '保存エラー'}`;
        } else if (isCancelled) {
          statusText = `キャンセル`;
        } else if (isDownloading) {
          statusText = `${progress}% • ${statusText}`;
        }

        const safeTitle = utils.escapeHtml(job.title || 'ダウンロード');
        const safeDir = job.saveDir ? utils.escapeHtml(job.saveDir) : '';

        return `
          <div class="download-item ${job.status}" data-id="${job.id}">
            <div class="download-item-top">
              ${iconHtml}
              <div class="download-item-info">
                <div class="download-item-title" title="${safeTitle}">${safeTitle}</div>
                <div class="download-item-status">${utils.escapeHtml(statusText)}</div>
                ${safeDir ? `<div style="font-size: 10px; color: var(--text-muted); opacity: 0.8; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="保存先: ${safeDir}">保存先: ${safeDir}</div>` : ''}
              </div>
            </div>
            <div class="download-progress">
              <span style="width: ${progress}%;"></span>
            </div>
            <div class="download-item-actions">
              ${isDownloading ? `
                <button type="button" class="dl-item-btn btn-cancel" onclick="window.downloadManager.cancelJob('${job.id}')">キャンセル</button>
              ` : ''}
              ${isCompleted ? `
                <button type="button" class="dl-item-btn btn-open" onclick="window.downloadManager.openJobFolder(window.downloadManager.jobs.find(j => j.id === '${job.id}'))">
                  <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
                  フォルダを開く
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    } catch (renderErr) {
      console.error('Download list render error:', renderErr);
    }
  }
};

window.downloadManager = downloadManager;

// ブラウザ終了時の警告ガード（Webブラウザ専用。Electron環境ではメインプロセスで安全に処理）
if (!window.desktopAPI) {
  window.addEventListener('beforeunload', (e) => {
    const hasActive = downloadManager.jobs.some(j => j.status === 'downloading');
    if (hasActive) {
      e.preventDefault();
      e.returnValue = 'ダウンロード中のタスクがあります。';
    }
  });
}

// 通常ファイル一括保存（ダイアログなしでOS既定のダウンロードフォルダへ直接即座に保存）
async function downloadFilesToFolder(fileList, title, folderName) {
  if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
    showToast('ダウンロード可能なファイルがありません');
    return;
  }

  // 場所を聞かずに即座にダウンロード開始（~/Downloads/Canvas Horizon/[科目名] に自動保存）
  const targetDir = null;

  // UIに即座に「開始中」フィードバックを表示
  const tempJobId = `batch-init-${Date.now()}`;
  const tempJob = {
    id: tempJobId,
    type: 'batch-files',
    title: title || '講義資料の一括保存',
    status: 'downloading',
    progress: 2,
    totalCount: fileList.length,
    completedCount: 0,
    saveDir: 'ダウンロード',
    message: `準備中 (${fileList.length}件)`
  };
  downloadManager.addJob(tempJob);
  downloadManager.openPanel();

  try {
    const res = await api.post('/api/files/download-batch', {
      files: fileList,
      title: title || '講義資料',
      folderName: folderName || title,
      targetDir
    });

    // テンポラリジョブを削除
    downloadManager.jobs = downloadManager.jobs.filter(j => j.id !== tempJobId);

    if (res.success && res.job) {
      downloadManager.addJob(res.job);
      downloadManager.openPanel();
    } else {
      downloadManager.render();
      downloadManager.updateState();
    }
  } catch (err) {
    console.error('Batch download start error:', err);
    const j = downloadManager.jobs.find(j => j.id === tempJobId);
    if (j) {
      j.status = 'failed';
      j.error = err.message || '通信エラー';
      j.message = '保存に失敗しました';
      downloadManager.render();
      downloadManager.updateState();
    }
  }
}

// レガシー互換エイリアス（ZIPダウンロード呼び出しもフォルダ通常保存へ橋渡し）
async function downloadFilesAsZip(fileList, zipName) {
  const cleanTitle = (zipName || '講義資料').replace(/\.zip$/i, '');
  await downloadFilesToFolder(fileList, cleanTitle, cleanTitle);
}

// 単体ファイルの直接保存
async function downloadSingleFile({ id, url, name, courseId }) {
  const fileName = name || 'file.pdf';

  const tempJobId = `single-init-${Date.now()}`;
  const tempJob = {
    id: tempJobId,
    type: 'single-file',
    title: fileName,
    status: 'downloading',
    progress: 10,
    saveDir: 'ダウンロード',
    message: '保存中...'
  };
  downloadManager.addJob(tempJob);
  downloadManager.openPanel();

  try {
    const res = await api.post('/api/files/download-single', {
      id,
      url,
      name: fileName,
      courseId: courseId || state.materialsCourseId
    });

    downloadManager.jobs = downloadManager.jobs.filter(j => j.id !== tempJobId);

    if (res.success && res.job) {
      downloadManager.addJob(res.job);
      downloadManager.openPanel();
    } else {
      downloadManager.render();
      downloadManager.updateState();
    }
  } catch (err) {
    console.error('Single download start error:', err);
    const j = downloadManager.jobs.find(j => j.id === tempJobId);
    if (j) {
      j.status = 'failed';
      j.error = err.message || '通信エラー';
      j.message = '保存に失敗しました';
      downloadManager.render();
      downloadManager.updateState();
    }
  }
}

// 課題提出完了時の演出アニメーション (自然で優雅な花びらの舞い上がり＆セレブレーション)
function triggerConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // 高DPIディスプレイ対応
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  // 省電力モード時は粒子数を最適化しつつ美しさを保持
  const isSaving = document.body.classList.contains('battery-saver');
  const petalCount = isSaving ? 65 : 120;
  const sparklesCount = isSaving ? 14 : 28;

  // 上品で自然な桜色・パールホワイト・淡いゴールドのカラーパレット
  const petalPalettes = [
    { fill: 'rgba(255, 183, 197, 0.94)', stroke: 'rgba(255, 160, 180, 0.55)', backFill: 'rgba(244, 114, 182, 0.90)' }, // 桜色
    { fill: 'rgba(251, 207, 232, 0.92)', stroke: 'rgba(244, 114, 182, 0.45)', backFill: 'rgba(236, 72, 153, 0.88)' }, // 淡桜
    { fill: 'rgba(253, 164, 175, 0.94)', stroke: 'rgba(244, 63, 94, 0.4)',   backFill: 'rgba(251, 113, 133, 0.90)' }, // ピーチピンク
    { fill: 'rgba(255, 241, 242, 0.96)', stroke: 'rgba(255, 205, 210, 0.65)', backFill: 'rgba(255, 228, 230, 0.92)' }, // パールホワイト
    { fill: 'rgba(254, 240, 138, 0.90)', stroke: 'rgba(251, 191, 36, 0.55)', backFill: 'rgba(252, 211, 77, 0.88)' }, // シャンパンゴールド
    { fill: 'rgba(255, 255, 255, 0.97)', stroke: 'rgba(255, 210, 225, 0.5)', backFill: 'rgba(253, 242, 248, 0.94)' }  // ピュアホワイト
  ];

  const particles = [];

  // 花びら粒子の生成（画面下部〜中央下から上方へ自然にふわっと舞い上がる）
  for (let i = 0; i < petalCount; i++) {
    const originX = width * 0.5 + (Math.random() - 0.5) * (width * 0.55);
    const originY = height * 0.78 + (Math.random() - 0.5) * (height * 0.22);

    // 上方向への自然な初速（噴出ではなく、ふわっと風に乗って舞い上がる上昇気流）
    const upwardSpeed = -(Math.random() * 8.5 + 5.5);
    const horizontalSpread = (Math.random() - 0.5) * 7.5 + (originX < width * 0.5 ? -1.8 : 1.8);

    particles.push({
      type: Math.random() > 0.4 ? 'sakura' : 'oval',
      x: originX,
      y: originY,
      vx: horizontalSpread,
      vy: upwardSpeed,
      size: Math.random() * 8 + 8.5, // 自然な花びらのサイズ
      lengthFactor: Math.random() * 0.35 + 1.15, // 縦横比
      colors: petalPalettes[Math.floor(Math.random() * petalPalettes.length)],
      gravity: 0.10 + Math.random() * 0.05, // 非常に穏やかな重力（ふわりと舞う）
      airResistance: 0.98, // 滑らかな空気抵抗
      opacity: 0, // 最初はフェードイン
      targetOpacity: Math.random() * 0.25 + 0.75,
      fadeInRate: 0.08,
      fadeOutRate: 0.006 + Math.random() * 0.005,
      // 3Dひらひら回転
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 2.2,
      flipAngle: Math.random() * Math.PI * 2,
      flipSpeed: (Math.random() * 0.038 + 0.018) * (Math.random() < 0.5 ? -1 : 1),
      // 風のゆらぎ（左右の優しい揺れ）
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: Math.random() * 0.045 + 0.02,
      wobbleAmp: Math.random() * 1.6 + 0.7
    });
  }

  // 豪華さと祝祭感を上品に引き立てる微細なシャンパンゴールド＆ホワイトの光の粒子
  for (let i = 0; i < sparklesCount; i++) {
    particles.push({
      type: 'sparkle',
      x: width * 0.5 + (Math.random() - 0.5) * (width * 0.6),
      y: height * 0.72 + (Math.random() - 0.5) * (height * 0.28),
      vx: (Math.random() - 0.5) * 6,
      vy: -(Math.random() * 7.5 + 4),
      size: Math.random() * 2.8 + 1.8,
      color: Math.random() > 0.35 ? '#fbbf24' : '#ffffff',
      gravity: 0.07,
      airResistance: 0.965,
      opacity: 1,
      fadeOutRate: 0.014 + Math.random() * 0.009,
      sparklePhase: Math.random() * Math.PI * 2,
      sparkleSpeed: 0.16
    });
  }

  // 既存のアニメーションフレームがあればキャンセル
  if (window._petalAnimId) {
    cancelAnimationFrame(window._petalAnimId);
  }

  // 桜の花びらの描画（先端に繊細な切れ込み）
  function drawSakuraPetal(c, size, lenFactor) {
    const l = size * lenFactor;
    const w = size;
    c.beginPath();
    c.moveTo(0, l * 0.5);
    c.bezierCurveTo(-w * 0.68, l * 0.15, -w * 0.62, -l * 0.35, -w * 0.22, -l * 0.5);
    c.lineTo(0, -l * 0.36); // 先端のサクラノッチ
    c.lineTo(w * 0.22, -l * 0.5);
    c.bezierCurveTo(w * 0.62, -l * 0.35, w * 0.68, l * 0.15, 0, l * 0.5);
    c.closePath();
    c.fill();
    c.stroke();
  }

  // 柔らかなしずく型花弁の描画
  function drawOvalPetal(c, size, lenFactor) {
    const l = size * lenFactor;
    const w = size * 0.82;
    c.beginPath();
    c.moveTo(0, l * 0.5);
    c.bezierCurveTo(-w * 0.55, l * 0.2, -w * 0.55, -l * 0.45, 0, -l * 0.5);
    c.bezierCurveTo(w * 0.55, -l * 0.45, w * 0.55, l * 0.2, 0, l * 0.5);
    c.closePath();
    c.fill();
    c.stroke();
  }

  // きらめき光粒子の描画（微細なクロスライト）
  function drawSparkle(c, size) {
    c.beginPath();
    c.arc(0, 0, size, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(-size * 2.2, 0);
    c.lineTo(size * 2.2, 0);
    c.moveTo(0, -size * 2.2);
    c.lineTo(0, size * 2.2);
    c.stroke();
  }

  let running = true;
  function animate() {
    if (!running) return;
    ctx.clearRect(0, 0, width, height);
    let activeParticles = 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      // 物理挙動の更新
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= p.airResistance;
      p.vy += p.gravity;

      if (p.type === 'sparkle') {
        p.opacity -= p.fadeOutRate;
        p.sparklePhase += p.sparkleSpeed;
        if (p.opacity > 0) {
          activeParticles++;
          ctx.save();
          ctx.translate(p.x, p.y);
          const shimmer = (Math.sin(p.sparklePhase) + 1) * 0.35 + 0.35;
          ctx.globalAlpha = Math.max(0, p.opacity * shimmer);
          ctx.fillStyle = p.color;
          ctx.strokeStyle = p.color;
          drawSparkle(ctx, p.size);
          ctx.restore();
        }
      } else {
        // 花びら
        if (p.opacity < p.targetOpacity) {
          p.opacity = Math.min(p.targetOpacity, p.opacity + p.fadeInRate);
        } else {
          p.opacity -= p.fadeOutRate;
        }

        // 風による横揺れ（ゆらぎ）
        p.wobble += p.wobbleSpeed;
        p.x += Math.sin(p.wobble) * p.wobbleAmp;

        // 3Dひらひら回転
        p.rotation += p.rotSpeed;
        p.flipAngle += p.flipSpeed;

        if (p.opacity > 0 && p.y < height + 60) {
          activeParticles++;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);

          // 3Dフリップ感（表裏の反転による自然な舞い）
          const cosFlip = Math.cos(p.flipAngle);
          ctx.scale(cosFlip, 1);

          ctx.globalAlpha = Math.max(0, p.opacity);
          // 表面と裏面でほのかにトーンを変えてリアルな陰影
          const isFront = cosFlip >= 0;
          ctx.fillStyle = isFront ? p.colors.fill : p.colors.backFill;
          ctx.strokeStyle = p.colors.stroke;
          ctx.lineWidth = 0.6;

          if (p.type === 'sakura') {
            drawSakuraPetal(ctx, p.size, p.lengthFactor);
          } else {
            drawOvalPetal(ctx, p.size, p.lengthFactor);
          }

          ctx.restore();
        }
      }
    }

    if (activeParticles > 0) {
      window._petalAnimId = requestAnimationFrame(animate);
    } else {
      running = false;
      ctx.clearRect(0, 0, width, height);
      // 高DPIキャンバスのバックバッファを解放してVRAM/メモリをOSへ即時返却
      canvas.width = 0;
      canvas.height = 0;
      window._petalAnimId = null;
    }
  }

  window._petalAnimId = requestAnimationFrame(animate);
}

// 画面遷移・ナビゲーション制御
function setupNavigation() {
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const target = item.dataset.target;
      switchView(target);
    });
  });

  // ヘッダーの設定ボタン
  const headerSettingsBtn = document.getElementById('btn-header-settings');
  if (headerSettingsBtn) {
    headerSettingsBtn.addEventListener('click', () => {
      const baseUrl = document.getElementById('cfg-base-url')?.value?.trim();
      const apiToken = document.getElementById('cfg-api-token')?.value?.trim();
      const welcomeBanner = document.getElementById('setting-welcome-banner');
      if (welcomeBanner) {
        welcomeBanner.style.display = (baseUrl && apiToken) ? 'none' : 'flex';
      }
      switchView('settings');
    });
  }

  // 設定画面の戻るボタン
  const settingsBackBtn = document.getElementById('btn-settings-back');
  if (settingsBackBtn) {
    settingsBackBtn.addEventListener('click', () => {
      switchView('dashboard');
    });
  }
}

function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.target === viewName);
  });
  document.querySelectorAll('.view-page').forEach(page => {
    page.classList.toggle('active', page.id === `view-${viewName}`);
  });

  // ヘッダー設定ボタンの active 状態
  const headerSettingsBtn = document.getElementById('btn-header-settings');
  if (headerSettingsBtn) {
    headerSettingsBtn.classList.toggle('active', viewName === 'settings');
  }

  if (viewName === 'settings' && typeof window.evaluateAppBatterySaving === 'function') {
    window.evaluateAppBatterySaving();
  }

  // materials 以外のビュー（dashboard 等）ではサイドバー科目の選択状態を解除
  document.querySelectorAll('.sidebar-course-item').forEach(el => {
    const isItemActive = (viewName === 'materials') && el.dataset.courseId && (String(el.dataset.courseId) === String(state.materialsCourseId));
    el.classList.toggle('active', Boolean(isItemActive));
  });

  if (viewName === 'materials') {
    if (!state.materialsCourseId && state.courses.length > 0) {
      state.materialsCourseId = state.courses[0].id;
      const matSelect = document.getElementById('material-course-select');
      if (matSelect) matSelect.value = state.materialsCourseId;
    }
    if (state.materialsCourseId && (!state.groupedMaterials || state.groupedMaterials.length === 0)) {
      loadCourseMaterialsGrouped(state.materialsCourseId);
    }
  } else if (viewName === 'announcements' && (!state.announcements || state.announcements.length === 0)) {
    loadAnnouncements();
  }
}

// テーマ切り替え制御（ヘッダーアイコン、設定セグメント）
function setupTheme() {
  const headerToggleBtn = document.getElementById('btn-theme-toggle');
  const moonIcon = document.getElementById('theme-moon-icon');
  const sunIcon = document.getElementById('theme-sun-icon');

  const sidebarToggleBtn = document.getElementById('btn-sidebar-theme-toggle');
  const sidebarMoonIcon = document.getElementById('sidebar-moon-icon');
  const sidebarSunIcon = document.getElementById('sidebar-sun-icon');

  const settingsDarkBtn = document.getElementById('theme-btn-dark');
  const settingsLightBtn = document.getElementById('theme-btn-light');

  function applyTheme(theme, notify = false, persistServer = true) {
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('canvas_horizon_theme', theme);

    if (persistServer) {
      api.post('/api/config', { theme }).catch(() => {});
    }

    // ヘッダーUI（アイコン切り替え ＆ ツールチップ更新）
    if (moonIcon && sunIcon) {
      moonIcon.style.display = isDark ? 'block' : 'none';
      sunIcon.style.display = isDark ? 'none' : 'block';
    }
    if (headerToggleBtn) {
      headerToggleBtn.setAttribute('title', isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
    }

    // サイドバーUI
    if (sidebarMoonIcon && sidebarSunIcon) {
      sidebarMoonIcon.style.display = isDark ? 'block' : 'none';
      sidebarSunIcon.style.display = isDark ? 'none' : 'block';
    }

    // 設定画面のセグメント切り替えボタン
    if (settingsDarkBtn && settingsLightBtn) {
      settingsDarkBtn.classList.toggle('active', isDark);
      settingsLightBtn.classList.toggle('active', !isDark);
    }

    if (notify) {
      showToast(isDark ? '🌙 ダークモードに切り替えました' : '☀️ ライトモードに切り替えました');
    }
  }

  window.applyAppTheme = applyTheme;

  const savedTheme = localStorage.getItem('canvas_horizon_theme') || 'dark';
  applyTheme(savedTheme, false, false);

  if (headerToggleBtn) {
    headerToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark', true);
    });
  }

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark', true);
    });
  }

  if (settingsDarkBtn) {
    settingsDarkBtn.addEventListener('click', () => {
      applyTheme('dark', true);
    });
  }

  if (settingsLightBtn) {
    settingsLightBtn.addEventListener('click', () => {
      applyTheme('light', true);
    });
  }
}

// バッテリー・省電力マネージャー
let batteryManagerInitialized = false;
async function setupBatteryManager() {
  if (batteryManagerInitialized) return;
  batteryManagerInitialized = true;

  const powerBtn = document.getElementById('btn-power-mode');
  const powerIndicator = document.getElementById('power-status-indicator');
  const powerText = document.getElementById('power-status-text');
  const acIcon = document.getElementById('power-status-icon-ac');
  const batIcon = document.getElementById('power-status-icon-battery');

  function updateBatteryUi() {
    const isSaving = state.isBatterySaving;
    document.body.classList.toggle('battery-saver', isSaving);

    // ヘッダーの丸型電源アイコンボタン: 省電力モードの場合のみ表示
    if (powerBtn) {
      if (isSaving) {
        powerBtn.style.display = 'inline-flex';
        powerBtn.setAttribute('title', '省電力モード動作中 (クリックで設定を開く)');
      } else {
        powerBtn.style.display = 'none';
      }
    }

    // 設定画面の電源状態インジケーター (シンプルなアイコン判定)
    if (powerIndicator && powerText) {
      powerIndicator.classList.toggle('on-battery', state.isOnBattery);
      powerIndicator.classList.toggle('ac-power', !state.isOnBattery);

      if (state.isOnBattery) {
        if (acIcon) acIcon.style.display = 'none';
        if (batIcon) batIcon.style.display = 'block';
        powerText.textContent = isSaving ? 'バッテリー駆動 (省電力中)' : 'バッテリー駆動';
      } else {
        if (acIcon) acIcon.style.display = 'block';
        if (batIcon) batIcon.style.display = 'none';
        powerText.textContent = '電源に接続中';
      }
    }

    // 設定画面のセグメントボタン
    document.querySelectorAll('.battery-segment-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.batteryMode === state.batteryMode);
    });
  }

  function evaluateBatterySaving() {
    if (state.batteryMode === 'on') {
      state.isBatterySaving = true;
    } else if (state.batteryMode === 'off') {
      state.isBatterySaving = false;
    } else {
      // 'auto' (デフォルト・推奨): バッテリー駆動時に省電力化
      state.isBatterySaving = Boolean(state.isOnBattery);
    }
    updateBatteryUi();
  }

  // 1. Electron Native powerMonitor の確認 (プラグの有無)
  if (window.desktopAPI && typeof window.desktopAPI.getPowerState === 'function') {
    try {
      const pState = await window.desktopAPI.getPowerState();
      state.isOnBattery = Boolean(pState?.onBattery);
    } catch (e) {}

    if (typeof window.desktopAPI.onPowerStateChange === 'function') {
      window.desktopAPI.onPowerStateChange((data) => {
        state.isOnBattery = Boolean(data?.onBattery);
        evaluateBatterySaving();
      });
    }
  } else if (navigator.getBattery) {
    // 2. ブラウザ標準 Battery Status API フォールバック
    try {
      const b = await navigator.getBattery();
      state.isOnBattery = !b.charging;
      b.addEventListener('chargingchange', () => {
        state.isOnBattery = !b.charging;
        evaluateBatterySaving();
      });
    } catch (e) {}
  }

  // ヘッダー丸型ボタンのクリックで設定画面（バッテリー設定項目）へ遷移
  if (powerBtn) {
    powerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchView('settings');
      const targetSec = document.getElementById('setting-item-battery');
      if (targetSec) {
        targetSec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // 設定画面のセグメントボタンイベント登録
  document.querySelectorAll('.battery-segment-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.batteryMode;
      state.batteryMode = mode;
      try {
        localStorage.setItem(STORAGE_KEY_BATTERY_MODE, mode);
      } catch (_) {}
      evaluateBatterySaving();
      try {
        await api.post('/api/config', { batteryMode: mode });
      } catch (e) {
        console.warn('Failed to persist battery mode:', e);
      }
    });
  });

  // 設定ファイル(API)からの同期
  api.get('/api/config').then(res => {
    if (res?.success && res.config?.batteryMode && ['auto', 'on', 'off'].includes(res.config.batteryMode)) {
      state.batteryMode = res.config.batteryMode;
      try {
        localStorage.setItem(STORAGE_KEY_BATTERY_MODE, res.config.batteryMode);
      } catch (_) {}
      evaluateBatterySaving();
    }
  }).catch(() => {});

  // バックグラウンド・最小化時のリソース最適化（非表示時は進行中のアニメーション・ポーリング・VRAMを完全休止）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (window._petalAnimId) {
        cancelAnimationFrame(window._petalAnimId);
        window._petalAnimId = null;
        const c = document.getElementById('confetti-canvas');
        if (c) {
          c.width = 0;
          c.height = 0;
        }
      }
      // バックグラウンド時はダウンロードポーリングを停止してCPU/通信を完全休止
      if (typeof downloadManager !== 'undefined' && downloadManager.pollTimer) {
        downloadManager.stopPolling();
      }
    } else {
      // 画面復帰時、進行中のダウンロードがあれば速やかにポーリングを再開
      if (typeof downloadManager !== 'undefined' && downloadManager.jobs && downloadManager.jobs.some(j => j.status === 'downloading')) {
        downloadManager.startPolling();
      }
    }
  });

  window.evaluateAppBatterySaving = evaluateBatterySaving;
  evaluateBatterySaving();
}

// 学期・クォーターの表示インジケーター更新
function updateQuarterIndicators() {
  const currentQ = state.currentQuarter || '';
  const cfgSelect = document.getElementById('cfg-quarter');
  if (cfgSelect && cfgSelect.value !== currentQ) {
    cfgSelect.value = currentQ;
  }
}

let isSyncing = false;
let lastSyncTimestamp = 0;

// アプリ全体の統合データ同期オーケストレーター
async function syncAllData(forceRefresh = false) {
  if (isSyncing) return;
  isSyncing = true;

  try {
    await Promise.allSettled([
      loadCourses(forceRefresh),
      loadAllAssignments(forceRefresh),
      (state.activeView === 'materials' && state.materialsCourseId) ? loadCourseMaterialsGrouped(state.materialsCourseId, forceRefresh) : Promise.resolve(),
      (state.activeView === 'announcements') ? loadAnnouncements() : Promise.resolve()
    ]);
    lastSyncTimestamp = Date.now();
  } finally {
    isSyncing = false;
  }
}

// 右上の更新ボタンによる同期実行（同期中くるくる回転、完了後は速やかに自然復帰）
async function triggerRefresh(force = true) {
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn && refreshBtn.classList.contains('spinning')) return;

  if (refreshBtn) {
    refreshBtn.classList.remove('success');
    refreshBtn.classList.add('spinning');
  }

  try {
    await syncAllData(force);

    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.classList.add('success');

      setTimeout(() => {
        refreshBtn.classList.remove('success');
      }, 600);
    }
  } catch (err) {
    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.classList.remove('success');
    }
    console.error('Refresh sync error:', err);
  }
}

// アプリケーション初期化・初期データ読み込み
async function initApp() {
  setupNavigation();
  setupTheme();
  setupBatteryManager();
  setupModalEvents();
  setupCommandPalette();
  setupSettingsEvents();
  setupDashboardFilterEvents();
  setupMaterialsViewEvents();
  downloadManager.init();

  // 0. 手動完了済みリストのディスク同期（再起動後も確実に復元）
  api.get('/api/assignments/manual-completed').then(res => {
    if (res.success && Array.isArray(res.completedIds)) {
      let changed = false;
      res.completedIds.forEach(id => {
        if (!state.manualCompletedAssignments.has(String(id))) {
          state.manualCompletedAssignments.add(String(id));
          changed = true;
        }
      });
      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY_MANUAL_COMPLETED, JSON.stringify([...state.manualCompletedAssignments]));
        } catch (_) {}
        renderAssignmentsList();
      }
    }
  }).catch(() => {});

  // 1. プロファイル・設定の取得 & 起動画面の決定
  api.get('/api/me').then(meRes => {
    const isConfigured = Boolean(
      meRes.config?.isConfigured ||
      (meRes.config?.baseUrl && (meRes.config?.hasToken || meRes.config?.apiToken))
    );

    if (meRes.success && meRes.profile) {
      state.profile = meRes.profile;
      state.config = meRes.config;
      if (meRes.config && meRes.config.currentQuarter !== undefined) {
        state.currentQuarter = meRes.config.currentQuarter;
      }
      if (meRes.config && meRes.config.batteryMode !== undefined) {
        state.batteryMode = meRes.config.batteryMode;
        try { localStorage.setItem(STORAGE_KEY_BATTERY_MODE, meRes.config.batteryMode); } catch (_) {}
        if (window.evaluateAppBatterySaving) window.evaluateAppBatterySaving();
      }
      if (meRes.config && meRes.config.theme) {
        applyTheme(meRes.config.theme, false, false);
      }
      renderProfile(meRes.profile);
      updateQuarterIndicators();

      // 設定が入力されている場合は起動時に必ずホーム（課題画面）を表示
      if (isConfigured) {
        switchView('dashboard');
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'none';
      } else {
        // 設定未完了の場合のみ設定画面に誘導
        switchView('settings');
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'flex';
      }
    } else {
      // プロファイル取得に失敗・オフライン等の場合
      if (meRes?.config?.batteryMode && ['auto', 'on', 'off'].includes(meRes.config.batteryMode)) {
        state.batteryMode = meRes.config.batteryMode;
        try { localStorage.setItem(STORAGE_KEY_BATTERY_MODE, meRes.config.batteryMode); } catch (_) {}
        if (window.evaluateAppBatterySaving) window.evaluateAppBatterySaving();
      }
      if (isConfigured) {
        switchView('dashboard');
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'none';
      } else {
        switchView('settings');
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'flex';
      }
    }
  }).catch(async (err) => {
    console.warn('Profile load deferred/cached:', err.message);
    try {
      const cfgRes = await api.get('/api/config');
      if (cfgRes?.config?.batteryMode && ['auto', 'on', 'off'].includes(cfgRes.config.batteryMode)) {
        state.batteryMode = cfgRes.config.batteryMode;
        try { localStorage.setItem(STORAGE_KEY_BATTERY_MODE, cfgRes.config.batteryMode); } catch (_) {}
        if (window.evaluateAppBatterySaving) window.evaluateAppBatterySaving();
      }
      if (cfgRes?.config?.baseUrl && cfgRes?.config?.apiToken) {
        switchView('dashboard');
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'none';
        return;
      }
    } catch (_) {}
    switchView('settings');
    const welcomeBanner = document.getElementById('setting-welcome-banner');
    if (welcomeBanner) welcomeBanner.style.display = 'flex';
  });

  // 自動アップデートリスナーの登録（Electron ネイティブ・electron-updater）
  if (window.desktopAPI && typeof window.desktopAPI.onUpdateStatus === 'function') {
    const banner = document.getElementById('header-update-banner');
    const bannerText = document.getElementById('header-update-text');
    const restartBtn = document.getElementById('btn-header-update-restart');

    window.desktopAPI.onUpdateStatus((status) => {
      if (status.type === 'available') {
        if (banner && bannerText && restartBtn) {
          bannerText.textContent = `新バージョン (${status.version || '最新'}) 利用可能`;
          restartBtn.textContent = '詳細 / 更新';
          restartBtn.disabled = false;
          banner.style.display = 'flex';
          banner.style.cursor = 'pointer';
          banner.onclick = () => {
            if (currentUpdateData) showUpdateModal(currentUpdateData);
            else checkAppUpdates(true);
          };
          restartBtn.onclick = (e) => {
            e.stopPropagation();
            if (currentUpdateData) showUpdateModal(currentUpdateData);
            else checkAppUpdates(true);
          };
        }
      } else if (status.type === 'progress') {
        isUpdateDownloading = true;
        if (banner && bannerText && restartBtn) {
          bannerText.textContent = `更新ダウンロード中... ${status.percent}%`;
          restartBtn.textContent = `${status.percent}%`;
          restartBtn.disabled = true;
          banner.style.display = 'flex';
        }

        // モーダル内の進捗を滑らかに更新
        const progressWrap = document.getElementById('update-modal-progress-wrap');
        const progressFill = document.getElementById('update-progress-bar-fill');
        const progressPercent = document.getElementById('update-progress-percent');
        const progressDetail = document.getElementById('update-progress-detail');
        const progressStatus = document.getElementById('update-progress-status');
        const actionBtn = document.getElementById('btn-update-action');

        if (progressWrap) progressWrap.style.display = 'flex';
        if (progressFill) progressFill.style.width = `${status.percent}%`;
        if (progressPercent) progressPercent.textContent = `${status.percent}%`;
        if (progressStatus) progressStatus.textContent = '新バージョンをダウンロード中...';
        if (actionBtn) {
          actionBtn.disabled = true;
          actionBtn.textContent = 'ダウンロード中...';
        }
        if (progressDetail && status.transferred && status.total) {
          const curMb = (status.transferred / 1048576).toFixed(1);
          const totalMb = (status.total / 1048576).toFixed(1);
          const speedMb = status.bytesPerSecond ? `(${(status.bytesPerSecond / 1048576).toFixed(1)} MB/s)` : '';
          progressDetail.textContent = `${curMb} MB / ${totalMb} MB ${speedMb}`.trim();
        }
      } else if (status.type === 'downloaded') {
        isUpdateDownloading = false;
        isUpdateDownloaded = true;
        if (banner && bannerText && restartBtn) {
          bannerText.textContent = `新バージョン (${status.version || '最新'}) の準備完了`;
          restartBtn.textContent = '今すぐ再起動';
          restartBtn.disabled = false;
          banner.style.display = 'flex';
          restartBtn.onclick = (e) => {
            e.stopPropagation();
            restartBtn.disabled = true;
            restartBtn.textContent = '再起動中...';
            window.desktopAPI.quitAndInstall();
          };
        }

        const progressWrap = document.getElementById('update-modal-progress-wrap');
        const progressStatus = document.getElementById('update-progress-status');
        const progressFill = document.getElementById('update-progress-bar-fill');
        const progressPercent = document.getElementById('update-progress-percent');
        const actionBtn = document.getElementById('btn-update-action');

        if (progressWrap) progressWrap.style.display = 'flex';
        if (progressStatus) progressStatus.textContent = 'ダウンロード完了。今すぐ更新できます。';
        if (progressFill) progressFill.style.width = '100%';
        if (progressPercent) progressPercent.textContent = '100%';
        if (actionBtn) {
          actionBtn.disabled = false;
          actionBtn.textContent = '今すぐ再起動して更新';
          actionBtn.onclick = () => {
            actionBtn.disabled = true;
            actionBtn.textContent = '再起動中...';
            window.desktopAPI.quitAndInstall();
          };
        }
        showToast('アップデートの準備が完了しました。再起動して適用できます。', 'success');
      } else if (status.type === 'error') {
        isUpdateDownloading = false;
        if (banner && bannerText && restartBtn) {
          bannerText.textContent = '更新ダウンロードで問題が発生しました';
          restartBtn.textContent = '詳細確認';
          restartBtn.disabled = false;
          restartBtn.onclick = () => {
            if (currentUpdateData) showUpdateModal(currentUpdateData);
            else checkAppUpdates(true);
          };
        }
        const progressStatus = document.getElementById('update-progress-status');
        if (progressStatus) {
          progressStatus.textContent = '自動更新で問題が発生しました。「手動ダウンロード」をお試しください。';
        }
        const actionBtn = document.getElementById('btn-update-action');
        if (actionBtn && currentUpdateData) {
          actionBtn.disabled = false;
          actionBtn.textContent = 'ブラウザでダウンロード';
          actionBtn.onclick = () => {
            utils.openExternalUrl(currentUpdateData.downloadUrl || 'https://github.com/shizengakari/CanvasLMS-Horizon/releases');
          };
        }
      }
    });
  }

  // アプリ起動時の自動更新確認（開いた瞬間にバックグラウンドで実行）
  checkAppUpdates(false);

  // 2. 右上のRefreshボタンのクリックイベント登録
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => triggerRefresh(true));
  }

  // 3. アプリ起動時の初期描画（キャッシュ優先で即座に表示、バックグラウンドでの定期通信は行わない）
  setTimeout(async () => {
    await syncAllData(false);

    // 初回起動で課題データが全く存在しない場合のみ、初期ロードとして取得
    const isInitialEmpty = (!state.allAssignments || state.allAssignments.length === 0);
    if (isInitialEmpty && (state.config?.baseUrl || state.profile)) {
      triggerRefresh(false);
    }
  }, 50);
}

function renderProfile(profile) {
  const defaultName = 'Canvas ユーザー';
  let rawName = profile?.short_name || profile?.name || defaultName;

  // 学籍番号やクラス識別コードなどの接頭辞（例: 'B08... 氏名'）を自動除去
  let cleanName = rawName.replace(/^[A-Z0-9\-_]+[\s　]+/, '').trim();
  if (!cleanName || cleanName.length < 2) cleanName = defaultName;

  // 設定画面の連携状態表示カードを表示
  const accountCard = document.getElementById('settings-account-card');
  if (accountCard) {
    accountCard.style.display = 'flex';
  }

  // 設定画面のアカウント名（連携済み 〇〇 としてログイン中）
  const settingsNameEl = document.getElementById('settings-user-name');
  if (settingsNameEl) {
    settingsNameEl.innerHTML = `連携済み <strong>${utils.escapeHtml(cleanName)}</strong> としてログイン中`;
  }
}

// コース一覧の読み込み
async function loadCourses(forceRefresh = false) {
  try {
    const res = await api.get(`/api/courses?refresh=${forceRefresh}`);
    if (res.success && res.courses) {
      state.courses = res.courses;
      renderSidebarCourses(res.courses);
      populateMaterialCourseSelect(res.courses);
    }
  } catch (err) {
    console.error('Failed to load courses:', err);
  }
}

// サイドバーのコース一覧描画
function renderSidebarCourses(courses) {
  const list = document.getElementById('sidebar-courses-list');
  const countPill = document.getElementById('sidebar-courses-count');
  if (countPill && courses) {
    countPill.textContent = courses.length;
  }
  const statCoursesVal = document.getElementById('stat-courses-val');
  if (statCoursesVal && courses) {
    statCoursesVal.textContent = courses.length;
  }

  list.innerHTML = '';

  if (!courses || courses.length === 0) {
    list.innerHTML = '<div style="color: var(--text-muted); padding: 12px; font-size: 12px;">科目がありません</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  const pendingCountMap = new Map();
  if (Array.isArray(state.allAssignments)) {
    for (const a of state.allAssignments) {
      if (!a.isSubmitted && a.courseId != null) {
        const cid = String(a.courseId);
        pendingCountMap.set(cid, (pendingCountMap.get(cid) || 0) + 1);
      }
    }
  }

  courses.forEach(c => {
    const item = document.createElement('div');
    // materials ビューを表示中かつ科目IDが一致する場合のみ active（起動時のダッシュボードでは未選択）
    const isActive = (state.activeView === 'materials') && (String(state.materialsCourseId) === String(c.id));
    item.className = `sidebar-course-item${isActive ? ' active' : ''}`;
    item.dataset.courseId = c.id;
    item.setAttribute('title', c.name);

    const color = utils.getCourseColor(c.name || c.id);
    const pendingCount = pendingCountMap.get(String(c.id)) || 0;

    item.innerHTML = `
      <div class="sidebar-course-left">
        <span class="course-color-dot ${color.dotClass}"></span>
        <span class="sidebar-course-name">${c.cleanName || c.name}</span>
      </div>
      ${pendingCount > 0 ? `<span class="course-task-badge" title="未提出課題: ${pendingCount}件">${pendingCount}</span>` : ''}
    `;

    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-course-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');

      state.materialsCourseId = c.id;
      const select = document.getElementById('material-course-select');
      if (select) select.value = c.id;
      switchView('materials');
      loadCourseMaterialsGrouped(c.id, false);
    });

    fragment.appendChild(item);
  });
  list.appendChild(fragment);
}

function setupSidebarQuarterFilters() {
  // サイドバーピルは廃止（設定画面で管理）
}

function populateMaterialCourseSelect(courses) {
  const matSelect = document.getElementById('material-course-select');
  matSelect.innerHTML = '';

  courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.cleanName || c.name;
    matSelect.appendChild(opt);
  });

  if (state.materialsCourseId) {
    matSelect.value = state.materialsCourseId;
  }
}

// 全課題タイムラインの読み込み
async function loadAllAssignments(forceRefresh = false) {
  try {
    const res = await api.get(`/api/dashboard/timeline?refresh=${forceRefresh}`);
    if (res.success && res.assignments) {
      // dueTime（ミリ秒数値）を1度だけ事前キャッシュ（O(N log N)のnew Date生成を完全撲滅）
      const newItems = res.assignments;
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i];
        if (item.dueAt && item.dueTime === undefined) {
          const t = new Date(item.dueAt).getTime();
          item.dueTime = isNaN(t) ? 0 : t;
        } else if (!item.dueAt) {
          item.dueTime = 0;
        }
      }

      // 軽量な変更検知（配列の長さ・ID・提出状態・採点状態を高速ループ比較して文字列アロケーションゼロに）
      const oldItems = state.allAssignments || [];
      let isChanged = oldItems.length !== newItems.length;
      if (!isChanged) {
        for (let i = 0; i < newItems.length; i++) {
          const o = oldItems[i];
          const n = newItems[i];
          if (o.id !== n.id || o.isSubmitted !== n.isSubmitted || o.isGraded !== n.isGraded) {
            isChanged = true;
            break;
          }
        }
      }

      state.allAssignments = newItems;
      updateAssignmentMetrics(newItems);
      renderSidebarCourses(state.courses); // サイドバーの未提出課題バッジを同期

      // データに変更があった場合、または初回のみDOMを再描画（無駄なCPU/GPU再計算・リフローを根絶）
      if (isChanged || !document.querySelector('.assignment-card')) {
        renderAssignmentsList();
      }
    }
  } catch (err) {
    console.error('Failed to load assignments:', err);
    // 初回ロードで課題がまだ1件も表示されていない場合はスピナーを解除して再試行UIを表示
    if (!state.allAssignments || state.allAssignments.length === 0) {
      const list = document.getElementById('main-assignment-list');
      if (list) {
        list.innerHTML = `
          <div class="empty-state-card">
            <div class="empty-state-icon" style="color: var(--status-urgent, #f43f5e);">
              <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            </div>
            <div class="empty-state-title">課題データの同期に失敗しました</div>
            <div class="empty-state-sub">${utils.escapeHtml(err.message || 'ネットワーク通信を確認してください')}</div>
            <button class="btn-primary" style="margin-top: 14px; padding: 7px 20px; font-weight: 600;" id="btn-retry-assignments">再試行</button>
          </div>
        `;
        document.getElementById('btn-retry-assignments')?.addEventListener('click', () => loadAllAssignments(true));
      }
    }
  }
}

function updateAssignmentMetrics(assignments = null) {
  let list = assignments || state.allAssignments || [];
  // 学期フィルターが有効な場合は連動
  if (state.onlyCurrentQuarterTasks && state.currentQuarter !== 'all') {
    list = list.filter(a => a.isCurrentQuarter);
  }

  const pending = list.filter(a => !a.isSubmitted && !isAssignmentManuallyCompleted(a.id));
  const submitted = list.filter(a => a.isSubmitted || isAssignmentManuallyCompleted(a.id));

  const now = new Date();
  const urgent = pending.filter(a => {
    if (!a.dueAt) return false;
    const due = new Date(a.dueAt);
    const diffHours = (due - now) / (1000 * 60 * 60);
    // 締切直前24時間以内および締切直後24時間以内（24時間以上超過したものは除外）
    return diffHours >= -24 && diffHours <= 24;
  });

  const urgentEl = document.getElementById('stat-urgent-val');
  const pendingEl = document.getElementById('stat-pending-val');
  const completedEl = document.getElementById('stat-completed-val');
  if (urgentEl) urgentEl.textContent = urgent.length;
  if (pendingEl) pendingEl.textContent = pending.length;
  if (completedEl) completedEl.textContent = submitted.length;

  const urgentBadge = document.getElementById('sidebar-urgent-count');
  if (urgentBadge) {
    if (urgent.length > 0) {
      urgentBadge.textContent = urgent.length;
      urgentBadge.style.display = 'inline-block';
    } else {
      urgentBadge.style.display = 'none';
    }
  }
}

// KPIカードのアクティブ状態の同期
function updateKpiActiveState() {
  document.querySelectorAll('.kpi-card').forEach(el => el.classList.remove('active'));
  if (state.assignmentFilter === 'urgent') {
    document.getElementById('kpi-card-urgent')?.classList.add('active');
  } else if (state.assignmentFilter === 'unsubmitted') {
    document.getElementById('kpi-card-pending')?.classList.add('active');
  } else if (state.assignmentFilter === 'submitted' || state.assignmentFilter === 'graded') {
    document.getElementById('kpi-card-completed')?.classList.add('active');
  }
}

function renderAssignmentsList() {
  // KPIカードの件数を最新のフィルター状態と同期
  updateAssignmentMetrics();

  const list = document.getElementById('main-assignment-list');
  list.innerHTML = '';

  let filtered = [...state.allAssignments];

  // 1. ステータスフィルター
  if (state.assignmentFilter === 'unsubmitted') {
    filtered = filtered.filter(a => !a.isSubmitted && !isAssignmentManuallyCompleted(a.id));
  } else if (state.assignmentFilter === 'submitted') {
    filtered = filtered.filter(a => (a.isSubmitted || isAssignmentManuallyCompleted(a.id)) && !a.isGraded);
  } else if (state.assignmentFilter === 'graded') {
    filtered = filtered.filter(a => a.isGraded);
  } else if (state.assignmentFilter === 'urgent') {
    // 24時間以内（締切前24時間〜締切直後24時間）
    const now = new Date();
    filtered = filtered.filter(a => {
      if (a.isSubmitted || isAssignmentManuallyCompleted(a.id) || !a.dueAt) return false;
      const due = new Date(a.dueAt);
      const diffHours = (due - now) / (1000 * 60 * 60);
      return diffHours >= -24 && diffHours <= 24;
    });
  }

  // 2. 学期フィルター
  if (state.onlyCurrentQuarterTasks && state.currentQuarter !== 'all') {
    filtered = filtered.filter(a => a.isCurrentQuarter);
  }

  // 3. 検索キーワードフィルター
  if (state.dashboardSearchQuery) {
    const q = state.dashboardSearchQuery.toLowerCase();
    filtered = filtered.filter(a => 
      (a.name && a.name.toLowerCase().includes(q)) ||
      (a.courseName && a.courseName.toLowerCase().includes(q)) ||
      (a.cleanCourseName && a.cleanCourseName.toLowerCase().includes(q))
    );
  }

  // 結果件数バッジの更新
  const countBadge = document.getElementById('dashboard-results-count');
  if (countBadge) {
    countBadge.textContent = `${filtered.length}件`;
  }

  // KPIカードのアクティブ状態を反映
  updateKpiActiveState();

  if (filtered.length === 0) {
    const qNote = state.onlyCurrentQuarterTasks ? ` (${state.currentQuarter}限定)` : '';
    const searchNote = state.dashboardSearchQuery ? `「${state.dashboardSearchQuery}」に一致する` : '';
    list.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-state-icon">
          <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>
        <div class="empty-state-title">${searchNote}表示対象の課題はありません${qNote}</div>
        <div class="empty-state-sub">すべてのタスクが完了しているか、指定した条件に該当する課題がありません。</div>
      </div>
    `;
    return;
  }

  // 4. ソート順（事前計算された dueTime 数値比較で new Date アロケーションを完全排除）
  const sortMode = state.dashboardSort || 'due-asc';
  if (sortMode === 'due-asc') {
    filtered.sort((a, b) => {
      const ta = a.dueTime !== undefined ? a.dueTime : (a.dueAt ? (a.dueTime = new Date(a.dueAt).getTime()) : Infinity);
      const tb = b.dueTime !== undefined ? b.dueTime : (b.dueAt ? (b.dueTime = new Date(b.dueAt).getTime()) : Infinity);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta - tb;
    });
  } else if (sortMode === 'due-desc') {
    filtered.sort((a, b) => {
      const ta = a.dueTime !== undefined ? a.dueTime : (a.dueAt ? (a.dueTime = new Date(a.dueAt).getTime()) : 0);
      const tb = b.dueTime !== undefined ? b.dueTime : (b.dueAt ? (b.dueTime = new Date(b.dueAt).getTime()) : 0);
      if (!ta && !tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return tb - ta;
    });
  } else if (sortMode === 'course') {
    filtered.sort((a, b) => (a.courseName || '').localeCompare(b.courseName || '', 'ja'));
  } else if (sortMode === 'points') {
    filtered.sort((a, b) => (b.pointsPossible || 0) - (a.pointsPossible || 0));
  }

  // 5. スマートタイムライングルーピング描画
  if (sortMode === 'due-asc' && !state.dashboardSearchQuery && state.assignmentFilter !== 'urgent') {
    renderGroupedTimelineList(list, filtered);
  } else {
    // フラット描画 (DocumentFragment で一括描画してリフローを1回に抑制)
    const fragment = document.createDocumentFragment();
    filtered.forEach(a => {
      fragment.appendChild(createAssignmentCardElement(a));
    });
    list.appendChild(fragment);
  }
}

// タイムラインセクション別グルーピング描画 (重複表記を廃止した極めてシンプルで洗練された見出し)
function renderGroupedTimelineList(container, assignments) {
  const now = new Date();

  const groups = {
    urgent: {
      title: '24時間以内',
      badge: '', // 「まもなく」などの重複を廃止し単一表記に統一
      cls: 'urgent',
      items: []
    },
    thisWeek: {
      title: '1週間以内', // 「今週中の課題」と「7日以内」の重複を「1週間以内」に一本化
      badge: '',
      cls: 'this-week',
      items: []
    },
    later: {
      title: '1週間以降',
      badge: '',
      cls: 'later',
      items: []
    },
    submitted: {
      title: '完了・提出済み',
      badge: '',
      cls: 'submitted',
      items: []
    },
    noDue: {
      title: '期限指定なし',
      badge: '',
      cls: 'other',
      items: []
    }
  };

  assignments.forEach(a => {
    const isDone = a.isSubmitted || a.isGraded || isAssignmentManuallyCompleted(a.id);
    if (isDone) {
      groups.submitted.items.push(a);
      return;
    }
    if (!a.dueAt) {
      groups.noDue.items.push(a);
      return;
    }
    const due = new Date(a.dueAt);
    const diffHours = (due - now) / (1000 * 60 * 60);

    // 締め切りが24時間以上過ぎた未提出かつ未完了のものは自動非表示にする
    if (diffHours < -24) {
      return;
    }

    if (diffHours <= 24) {
      groups.urgent.items.push(a);
    } else if (diffHours <= 7 * 24) {
      groups.thisWeek.items.push(a);
    } else {
      groups.later.items.push(a);
    }
  });

  const fragment = document.createDocumentFragment();
  Object.values(groups).forEach(grp => {
    if (grp.items.length === 0) return;

    const header = document.createElement('div');
    header.className = 'timeline-section-header';
    header.innerHTML = `
      <div class="timeline-section-title ${grp.cls}">
        <span class="timeline-section-text">${grp.title}</span>
        ${grp.badge ? `<span class="timeline-section-badge ${grp.cls}">${grp.badge}</span>` : ''}
      </div>
      <span class="timeline-count-pill">${grp.items.length}件</span>
    `;
    fragment.appendChild(header);

    grp.items.forEach(a => {
      fragment.appendChild(createAssignmentCardElement(a));
    });
  });
  container.appendChild(fragment);
}

function createAssignmentCardElement(a) {
  const card = document.createElement('div');
  const isManualDone = isAssignmentManuallyCompleted(a.id);
  const isDone = a.isSubmitted || a.isGraded || isManualDone;
  const urgency = utils.getDueUrgency(a.dueAt, a.isSubmitted, a.id);
  const color = utils.getCourseColor(a.courseName || a.courseId);

  let statusCls = urgency.level;
  if (a.isGraded) statusCls = 'graded';
  else if (a.isSubmitted || isManualDone) statusCls = 'submitted';

  card.className = `assignment-card ${statusCls}`;
  
  const dueFormatted = utils.formatDate(a.dueAt);
  const pointsBadge = a.pointsPossible ? `<span class="assignment-points">${a.pointsPossible} 点</span>` : '';

  // 状態バッジ
  let badgeHtml = '';
  if (a.isGraded) {
    badgeHtml = `<span class="badge badge-submitted">採点済み (${a.submission?.score ?? ''}点)</span>`;
  } else if (a.isSubmitted) {
    badgeHtml = '<span class="badge badge-submitted"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg> 提出済み</span>';
  } else if (isManualDone) {
    badgeHtml = '<span class="badge badge-submitted"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg> 完了マーク</span>';
  } else if (urgency.level === 'urgent') {
    badgeHtml = `<span class="badge badge-urgent"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> ${urgency.text}</span>`;
  } else if (urgency.level === 'pending') {
    badgeHtml = `<span class="badge badge-pending">${urgency.text}</span>`;
  }

  // 手動完了マーク切替ボタン
  const completeToggleBtnHtml = isDone
    ? `<button type="button" class="btn-manual-complete-toggle action-chip-btn action-completed" title="${isManualDone ? '未完了に戻す' : '提出完了済み'}">
        <svg class="btn-icon" width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        <span>${isManualDone ? '手動完了' : '完了'}</span>
       </button>`
    : `<button type="button" class="btn-manual-complete-toggle action-chip-btn action-check" title="完了マークをつける (手動完了)">
        <svg class="btn-icon" width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        <span>完了</span>
       </button>`;

  // アクションボタン (保存ボタン action-chip-btn と統一規格のピルデザイン・適正サイズ)
  const actionBtnHtml = a.isSubmitted
    ? `<button class="btn-view-submission action-chip-btn action-submitted" title="提出内容を確認">
        <svg class="btn-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
        <span>提出済</span>
       </button>`
    : `<button class="btn-submit-action action-chip-btn action-submit" title="課題の提出画面を開く">
        <svg class="btn-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
        <span>提出</span>
       </button>`;

  const cleanCourse = a.cleanCourseName || a.courseName || '科目';

  card.innerHTML = `
    <div class="assignment-left">
      <div class="assignment-title-row">
        <span class="assignment-name">${a.name}</span>
        ${badgeHtml}
      </div>
      <div class="assignment-meta-row">
        <span class="assignment-course ${color.tagClass}" title="${a.courseName || ''}">
          ${cleanCourse}
        </span>
        <span class="assignment-due-time">
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          ${dueFormatted}
        </span>
        ${pointsBadge}
      </div>
    </div>
    <div class="assignment-right">
      ${completeToggleBtnHtml}
      ${actionBtnHtml}
    </div>
  `;

  // 手動完了ボタンのクリック処理（カードクリックへの伝播を防止）
  const completeBtn = card.querySelector('.btn-manual-complete-toggle');
  if (completeBtn) {
    completeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAssignmentManualComplete(a.id);
      renderAssignmentsList();
    });
  }

  card.addEventListener('click', () => {
    openAssignmentModal(a);
  });

  return card;
}

// 課題フィルター・検索・KPIカードのイベント登録
function setupDashboardFilterEvents() {
  // ピルボタン（未提出、すべて、提出済み、採点済み）
  document.querySelectorAll('#assignment-status-pills .pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#assignment-status-pills .pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.assignmentFilter = btn.dataset.filter;
      renderAssignmentsList();
    });
  });

  // 今期のみトグルボタン
  const qBtn = document.getElementById('btn-toggle-current-q');
  if (qBtn) {
    qBtn.addEventListener('click', () => {
      state.onlyCurrentQuarterTasks = !state.onlyCurrentQuarterTasks;
      qBtn.classList.toggle('active', state.onlyCurrentQuarterTasks);
      renderAssignmentsList();
    });
  }

  // インライン検索（デバウンスで入力時のCPU負荷・DOM再計算を劇的に軽減）
  const searchInput = document.getElementById('dashboard-search-input');
  const clearBtn = document.getElementById('btn-clear-dashboard-search');
  if (searchInput) {
    const debouncedRenderAssignments = debounce(() => renderAssignmentsList(), 140);
    searchInput.addEventListener('input', (e) => {
      state.dashboardSearchQuery = e.target.value.trim();
      if (clearBtn) clearBtn.style.display = state.dashboardSearchQuery ? 'block' : 'none';
      debouncedRenderAssignments();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.dashboardSearchQuery = '';
      clearBtn.style.display = 'none';
      renderAssignmentsList();
    });
  }

  // ソートセレクト
  const sortSelect = document.getElementById('dashboard-sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      state.dashboardSort = e.target.value;
      renderAssignmentsList();
    });
  }

  // KPIカードクリック時のフィルター連動
  const kpiUrgent = document.getElementById('kpi-card-urgent');
  if (kpiUrgent) {
    kpiUrgent.addEventListener('click', () => {
      document.querySelectorAll('#assignment-status-pills .pill-btn').forEach(b => b.classList.remove('active'));
      state.assignmentFilter = 'urgent';
      renderAssignmentsList();
    });
  }

  const kpiPending = document.getElementById('kpi-card-pending');
  if (kpiPending) {
    kpiPending.addEventListener('click', () => {
      document.querySelectorAll('#assignment-status-pills .pill-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('#assignment-status-pills .pill-btn[data-filter="unsubmitted"]')?.classList.add('active');
      state.assignmentFilter = 'unsubmitted';
      renderAssignmentsList();
    });
  }

  const kpiCompleted = document.getElementById('kpi-card-completed');
  if (kpiCompleted) {
    kpiCompleted.addEventListener('click', () => {
      document.querySelectorAll('#assignment-status-pills .pill-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('#assignment-status-pills .pill-btn[data-filter="submitted"]')?.classList.add('active');
      state.assignmentFilter = 'submitted';
      renderAssignmentsList();
    });
  }

  const kpiCourses = document.getElementById('kpi-card-courses');
  if (kpiCourses) {
    kpiCourses.addEventListener('click', () => {
      switchView('materials');
    });
  }
}

// 課題詳細・提出モーダル
function switchSubmissionTab(tabKey) {
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabKey);
  });
  const up = document.getElementById('tab-content-upload');
  const txt = document.getElementById('tab-content-text');
  const url = document.getElementById('tab-content-url');
  if (up) up.style.display = tabKey === 'upload' ? 'block' : 'none';
  if (txt) txt.style.display = tabKey === 'text' ? 'block' : 'none';
  if (url) url.style.display = tabKey === 'url' ? 'block' : 'none';
}

function openAssignmentModal(assignment) {
  state.currentModalAssignment = assignment;
  state.filesQueue = [];

  document.getElementById('modal-course-name').textContent = assignment.courseName || '';
  document.getElementById('modal-assignment-title').textContent = assignment.name || '課題';
  document.getElementById('modal-due-date').textContent = utils.formatDate(assignment.dueAt);
  document.getElementById('modal-points').textContent = assignment.pointsPossible ? `${assignment.pointsPossible} 点` : 'なし';

  const statusEl = document.getElementById('modal-status-badge');
  if (assignment.isGraded) {
    statusEl.innerHTML = `<span class="badge badge-submitted">採点済み (${assignment.submission.grade || assignment.submission.score}点)</span>`;
  } else if (assignment.isSubmitted) {
    statusEl.innerHTML = `<span class="badge badge-submitted">提出済み (${utils.formatDate(assignment.submission.submittedAt)})</span>`;
  } else if (assignment.isLocked) {
    statusEl.innerHTML = `<span class="badge badge-locked">ロック中</span>`;
  } else {
    statusEl.innerHTML = `<span class="badge badge-pending">未提出</span>`;
  }

  const types = assignment.submissionTypes || [];
  const readableTypes = [];
  if (types.includes('online_upload')) readableTypes.push('ファイル提出');
  if (types.includes('online_text_entry')) readableTypes.push('テキスト記述');
  if (types.includes('online_url')) readableTypes.push('Web URL');
  if (types.includes('online_quiz')) readableTypes.push('アンケート/小テスト');
  if (types.includes('on_paper')) readableTypes.push('対面提出');
  if (types.includes('none')) readableTypes.push('提出不要');

  document.getElementById('modal-allowed-types').textContent = readableTypes.length > 0 ? readableTypes.join(' / ') : (types.join(', ') || 'なし');

  const descBox = document.getElementById('modal-description-box');
  if (assignment.description && assignment.description.trim()) {
    descBox.innerHTML = utils.formatHtmlWithLinks(assignment.description);
    setupContentLinks(descBox, assignment.courseId);
  } else {
    descBox.innerHTML = '<span style="color: var(--text-muted);">説明なし</span>';
  }

  // 提出可能なフォーマットの判定
  const canUpload = types.includes('online_upload');
  const canText = types.includes('online_text_entry');
  const canUrl = types.includes('online_url');
  const isQuiz = types.includes('online_quiz');

  const tabsContainer = document.getElementById('modal-submission-tabs');
  const quizNotice = document.getElementById('modal-quiz-notice');
  const extNotice = document.getElementById('modal-external-notice');
  const tabUploadBtn = document.getElementById('sub-tab-upload');
  const tabTextBtn = document.getElementById('sub-tab-text');
  const tabUrlBtn = document.getElementById('sub-tab-url');

  const onlineTypesCount = (canUpload ? 1 : 0) + (canText ? 1 : 0) + (canUrl ? 1 : 0);

  if (onlineTypesCount > 0) {
    quizNotice.style.display = 'none';
    extNotice.style.display = 'none';
    tabsContainer.style.display = 'flex';

    tabUploadBtn.style.display = canUpload ? 'inline-flex' : 'none';
    tabTextBtn.style.display = canText ? 'inline-flex' : 'none';
    tabUrlBtn.style.display = canUrl ? 'inline-flex' : 'none';

    // 利用可能な最初の提出タブをデフォルト選択
    const defaultTab = canUpload ? 'upload' : (canText ? 'text' : 'url');
    switchSubmissionTab(defaultTab);
  } else if (isQuiz) {
    tabsContainer.style.display = 'none';
    extNotice.style.display = 'none';
    quizNotice.style.display = 'block';
    const quizLink = document.getElementById('btn-open-canvas-quiz');
    const quizUrl = assignment.htmlUrl || '#';
    quizLink.href = quizUrl;
    quizLink.setAttribute('data-url', assignment.htmlUrl || '');
    document.getElementById('tab-content-upload').style.display = 'none';
    document.getElementById('tab-content-text').style.display = 'none';
    document.getElementById('tab-content-url').style.display = 'none';
  } else {
    tabsContainer.style.display = 'none';
    quizNotice.style.display = 'none';
    extNotice.style.display = 'block';
    const extLink = document.getElementById('btn-open-canvas-external');
    const extUrl = assignment.htmlUrl || '#';
    extLink.href = extUrl;
    extLink.setAttribute('data-url', assignment.htmlUrl || '');
    document.getElementById('tab-content-upload').style.display = 'none';
    document.getElementById('tab-content-text').style.display = 'none';
    document.getElementById('tab-content-url').style.display = 'none';
  }

  // 過去の提出済みファイル一覧（保持・マージ提出対応）
  const historySec = document.getElementById('modal-history-section');
  const historyGrid = document.getElementById('modal-history-files-list');
  historyGrid.innerHTML = '';

  if (assignment.submission && assignment.submission.attachments && assignment.submission.attachments.length > 0) {
    historySec.style.display = 'flex';
    document.getElementById('modal-history-count').textContent = `${assignment.submission.attachments.length}件`;

    assignment.submission.attachments.forEach(att => {
      const item = document.createElement('div');
      item.className = 'history-file-row';
      item.innerHTML = `
        <div class="history-file-left">
          <label class="history-file-checkbox-label" title="チェックしたファイルは再提出時も保持されます">
            <input type="checkbox" class="retain-file-checkbox" data-file-id="${att.id}" checked>
            <span class="file-icon-badge">${utils.getFileExt(att.displayName)}</span>
            <span class="history-file-name" title="${att.displayName}">${att.displayName}</span>
          </label>
        </div>
        <div class="history-file-actions">
          <button class="action-chip-btn preview-file-btn" title="ファイル内容をプレビュー">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            <span>プレビュー</span>
          </button>
          <a class="action-chip-btn" href="/api/files/download?url=${encodeURIComponent(att.url)}&name=${encodeURIComponent(att.displayName)}" download="${att.displayName}" title="ファイルをローカル保存">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            <span>保存</span>
          </a>
        </div>
      `;

      item.querySelector('.preview-file-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openPdfPreviewModal(att.url, att.displayName);
      });

      item.querySelector('.retain-file-checkbox').addEventListener('change', () => {
        renderFileQueue();
      });

      historyGrid.appendChild(item);
    });

    document.getElementById('btn-download-submission-zip').onclick = () => {
      downloadFilesToFolder(assignment.submission.attachments.map(att => ({
        url: att.url,
        name: att.displayName
      })), `${assignment.name} 提出ファイル`, `${assignment.name}_提出ファイル`);
    };
  } else {
    historySec.style.display = 'none';
  }

  // 入力欄のリセットおよび過去のテキスト提出内容の復元
  document.getElementById('modal-submission-comment').value = '';
  document.getElementById('modal-text-comment').value = '';
  document.getElementById('modal-url-entry-url').value = '';
  document.getElementById('modal-url-comment').value = '';
  document.getElementById('modal-upload-progress').classList.remove('active');

  const charCountBadge = document.getElementById('modal-text-char-count');
  if (assignment.submission && assignment.submission.body) {
    const rawText = utils.stripHtml(assignment.submission.body);
    document.getElementById('modal-text-entry-body').value = rawText;
    if (charCountBadge) charCountBadge.textContent = `${rawText.length.toLocaleString()} 文字`;
  } else {
    document.getElementById('modal-text-entry-body').value = '';
    if (charCountBadge) charCountBadge.textContent = '0 文字';
  }

  renderFileQueue();
  // モーダルを全画面表示で展開
  toggleAssignmentFullscreen(true);
  document.getElementById('assignment-modal').classList.add('open');
}

let isAssignmentFullscreen = false;
let isEditorWide = false;

// モーダルの全画面化ヘルパー
function toggleModalFullscreen(containerId, expandIconId, compressIconId, forceState) {
  const container = document.getElementById(containerId);
  const expandIcon = document.getElementById(expandIconId);
  const compressIcon = document.getElementById(compressIconId);
  if (!container) return false;

  const isFs = container.classList.contains('fullscreen');
  const nextFs = (typeof forceState === 'boolean') ? forceState : !isFs;

  if (nextFs) {
    container.classList.add('fullscreen');
    if (expandIcon) expandIcon.style.display = 'none';
    if (compressIcon) compressIcon.style.display = 'block';
  } else {
    container.classList.remove('fullscreen');
    if (expandIcon) expandIcon.style.display = 'block';
    if (compressIcon) compressIcon.style.display = 'none';
  }
  return nextFs;
}

function toggleAssignmentFullscreen(forceState) {
  isAssignmentFullscreen = toggleModalFullscreen('assignment-modal-container', 'assignment-expand-icon', 'assignment-compress-icon', forceState);
}

// 執筆ワイドモードの切り替え
function toggleEditorWide(forceState) {
  const grid = document.querySelector('.assignment-modal-grid');
  const iconExpand = document.getElementById('editor-wide-icon-expand');
  const iconCollapse = document.getElementById('editor-wide-icon-collapse');
  const quickWideText = document.getElementById('btn-quick-wide-text');
  if (!grid) return;

  isEditorWide = (typeof forceState === 'boolean') ? forceState : !isEditorWide;

  if (isEditorWide) {
    grid.classList.add('editor-wide');
    if (iconExpand) iconExpand.style.display = 'none';
    if (iconCollapse) iconCollapse.style.display = 'block';
    if (quickWideText) quickWideText.textContent = '標準幅に戻す';
  } else {
    grid.classList.remove('editor-wide');
    if (iconExpand) iconExpand.style.display = 'block';
    if (iconCollapse) iconCollapse.style.display = 'none';
    if (quickWideText) quickWideText.textContent = '執筆ワイド表示';
  }
}

function closeAssignmentModal() {
  document.getElementById('assignment-modal').classList.remove('open');
  if (isAssignmentFullscreen) {
    toggleAssignmentFullscreen(false);
  }
  if (isEditorWide) {
    toggleEditorWide(false);
  }
  state.currentModalAssignment = null;
  state.filesQueue = [];
}

function setupModalEvents() {
  document.getElementById('modal-close-btn').addEventListener('click', closeAssignmentModal);
  
  const assignFsBtn = document.getElementById('assignment-modal-fullscreen-btn');
  if (assignFsBtn) {
    assignFsBtn.addEventListener('click', () => toggleAssignmentFullscreen());
  }

  const editorWideBtn = document.getElementById('btn-toggle-editor-wide');
  if (editorWideBtn) {
    editorWideBtn.addEventListener('click', () => toggleEditorWide());
  }

  const quickWideBtn = document.getElementById('btn-quick-wide-toggle');
  if (quickWideBtn) {
    quickWideBtn.addEventListener('click', () => toggleEditorWide());
  }

  // リアルタイム文字数カウント & Ctrl+Enter 提出ショートカット
  const textEditor = document.getElementById('modal-text-entry-body');
  const charCountBadge = document.getElementById('modal-text-char-count');
  if (textEditor && charCountBadge) {
    textEditor.addEventListener('input', () => {
      const len = textEditor.value.length;
      charCountBadge.textContent = `${len.toLocaleString()} 文字`;
    });

    textEditor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        executeTextSubmission();
      }
    });
  }

  // クイズおよび外部URL課題の安全なブラウザ起動
  const quizLink = document.getElementById('btn-open-canvas-quiz');
  if (quizLink) {
    quizLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = quizLink.getAttribute('data-url') || quizLink.href;
      if (url && url !== '#') {
        utils.openExternalUrl(url);
      }
    });
  }

  const extLink = document.getElementById('btn-open-canvas-external');
  if (extLink) {
    extLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = extLink.getAttribute('data-url') || extLink.href;
      if (url && url !== '#') {
        utils.openExternalUrl(url);
      }
    });
  }

  document.getElementById('assignment-modal').addEventListener('click', (e) => {
    if (e.target.id === 'assignment-modal') closeAssignmentModal();
  });

  // アップデートモーダルのイベント登録
  const updateCloseBtn = document.getElementById('update-modal-close-btn');
  if (updateCloseBtn) updateCloseBtn.addEventListener('click', closeUpdateModal);

  const updateDismissBtn = document.getElementById('btn-update-dismiss');
  if (updateDismissBtn) updateDismissBtn.addEventListener('click', closeUpdateModal);

  const updateOverlay = document.getElementById('update-modal');
  if (updateOverlay) {
    updateOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'update-modal') closeUpdateModal();
    });
  }

  // 提出形式タブの切り替え
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSubmissionTab(btn.dataset.tab);
    });
  });

  // ファイルアップロードのイベント登録
  const dropzone = document.getElementById('bulk-dropzone');
  const fileInput = document.getElementById('bulk-file-input');

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(Array.from(e.dataTransfer.files));
    }
  });

  // 提出実行ボタンのイベント登録
  document.getElementById('btn-execute-submit').addEventListener('click', executeBulkSubmission);
  document.getElementById('btn-execute-text-submit').addEventListener('click', executeTextSubmission);
  document.getElementById('btn-execute-url-submit').addEventListener('click', executeUrlSubmission);
}

function addFilesToQueue(newFiles) {
  newFiles.forEach(nf => {
    if (!state.filesQueue.some(f => f.name === nf.name && f.size === nf.size)) {
      state.filesQueue.push(nf);
    }
  });
  renderFileQueue();
}

function removeFileFromQueue(index) {
  state.filesQueue.splice(index, 1);
  renderFileQueue();
}

function renderFileQueue() {
  const container = document.getElementById('modal-files-queue');
  const submitBtn = document.getElementById('btn-execute-submit');

  const retainedCheckboxes = Array.from(document.querySelectorAll('.retain-file-checkbox:checked'));
  const retainCount = retainedCheckboxes.length;
  const newFilesCount = state.filesQueue.length;

  if (newFilesCount === 0) {
    container.style.display = 'none';
    container.innerHTML = '';

    if (retainCount > 0) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
        保持ファイル (${retainCount}件) で提出
      `;
    } else {
      submitBtn.disabled = true;
      submitBtn.innerHTML = `
        <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
        ファイルを選択してください
      `;
    }
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = '';
  submitBtn.disabled = false;

  const submitLabel = retainCount > 0
    ? `${newFilesCount}個のファイルを追加 (${retainCount}件保持)`
    : `${newFilesCount}個のファイルを提出`;

  submitBtn.innerHTML = `
    <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
    ${submitLabel}
  `;

  state.filesQueue.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'file-queue-item';
    item.innerHTML = `
      <div class="file-queue-left">
        <span class="file-icon-badge">${utils.getFileExt(file.name)}</span>
        <span class="file-queue-name" title="${file.name}">${file.name}</span>
        <span class="file-queue-size">(${utils.formatBytes(file.size)})</span>
      </div>
      <button class="remove-file-btn" title="削除">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    `;
    item.querySelector('.remove-file-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFileFromQueue(idx);
    });
    container.appendChild(item);
  });
}

// 1. ファイルアップロード提出（過去ファイルの保持・マージ提出対応）
async function executeBulkSubmission() {
  const retainedCheckboxes = Array.from(document.querySelectorAll('.retain-file-checkbox:checked'));
  const retainFileIds = retainedCheckboxes.map(cb => cb.dataset.fileId);

  if (!state.currentModalAssignment || (state.filesQueue.length === 0 && retainFileIds.length === 0) || state.isSubmitting) {
    return;
  }

  const assignment = state.currentModalAssignment;
  const courseId = assignment.courseId;
  const assignmentId = assignment.id;
  const comment = document.getElementById('modal-submission-comment').value;

  state.isSubmitting = true;
  const submitBtn = document.getElementById('btn-execute-submit');
  const progressContainer = document.getElementById('modal-upload-progress');
  const progressBar = document.getElementById('modal-progress-bar');
  const progressText = document.getElementById('modal-progress-status');
  const progressPercent = document.getElementById('modal-progress-percentage');

  submitBtn.disabled = true;
  progressContainer.classList.add('active');
  progressBar.style.width = '15%';
  progressText.textContent = `Canvasへ送信中...`;
  progressPercent.textContent = '15%';

  let progressTimer = null;
  try {
    const formData = new FormData();
    state.filesQueue.forEach(file => {
      formData.append('files', file);
    });
    formData.append('comment', comment);
    formData.append('retainFileIds', JSON.stringify(retainFileIds));

    let cur = 20;
    progressTimer = setInterval(() => {
      if (cur < 85) {
        cur += 15;
        progressBar.style.width = `${cur}%`;
        progressPercent.textContent = `${cur}%`;
      }
    }, 350);

    const res = await api.post(`/api/courses/${courseId}/assignments/${assignmentId}/submit-files`, formData, true);
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }

    if (res.success) {
      progressBar.style.width = '100%';
      progressPercent.textContent = '100%';
      progressText.textContent = '提出完了';

      const totalCount = res.result ? res.result.totalCount : (state.filesQueue.length + retainFileIds.length);
      showToast(`課題を提出しました（合計 ${totalCount} 件）`, 'success');
      triggerConfetti();

      await loadAllAssignments(true);
      if (state.materialsCourseId) loadCourseMaterialsGrouped(state.materialsCourseId, true);
      setTimeout(() => {
        closeAssignmentModal();
      }, 1200);
    } else {
      throw new Error(res.error || '提出に失敗しました');
    }
  } catch (err) {
    console.error('Submission failed:', err);
    showToast(`提出エラー: ${err.message}`, 'error');
    progressContainer.classList.remove('active');
    submitBtn.disabled = false;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    state.isSubmitting = false;
  }
}

// 2. テキスト記述入力提出
async function executeTextSubmission() {
  if (!state.currentModalAssignment || state.isSubmitting) return;

  const textBody = document.getElementById('modal-text-entry-body').value.trim();
  const commentText = document.getElementById('modal-text-comment').value.trim();

  if (!textBody) {
    showToast('提出する本文テキストを入力してください', 'error');
    return;
  }

  const assignment = state.currentModalAssignment;
  const courseId = assignment.courseId;
  const assignmentId = assignment.id;
  const submitBtn = document.getElementById('btn-execute-text-submit');

  state.isSubmitting = true;
  submitBtn.disabled = true;
  const origHtml = submitBtn.innerHTML;
  submitBtn.innerHTML = '<span>送信中...</span>';

  try {
    const res = await api.post(`/api/courses/${courseId}/assignments/${assignmentId}/submit-text`, {
      submissionType: 'online_text_entry',
      body: textBody,
      commentText
    });

    if (res.success) {
      showToast('テキスト課題の提出が完了しました', 'success');
      triggerConfetti();
      await loadAllAssignments(true);
      if (state.materialsCourseId) loadCourseMaterialsGrouped(state.materialsCourseId, true);
      setTimeout(() => {
        closeAssignmentModal();
      }, 1200);
    } else {
      throw new Error(res.error || '提出に失敗しました');
    }
  } catch (err) {
    console.error('Text submission failed:', err);
    showToast(`提出エラー: ${err.message}`, 'error');
  } finally {
    state.isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerHTML = origHtml;
  }
}

// 3. Web URL提出
async function executeUrlSubmission() {
  if (!state.currentModalAssignment || state.isSubmitting) return;

  const inputUrl = document.getElementById('modal-url-entry-url').value.trim();
  const commentText = document.getElementById('modal-url-comment').value.trim();

  if (!inputUrl) {
    showToast('提出先URLを入力してください', 'error');
    return;
  }

  if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
    showToast('URLは http:// または https:// で入力してください', 'error');
    return;
  }

  const assignment = state.currentModalAssignment;
  const courseId = assignment.courseId;
  const assignmentId = assignment.id;
  const submitBtn = document.getElementById('btn-execute-url-submit');

  state.isSubmitting = true;
  submitBtn.disabled = true;
  const origHtml = submitBtn.innerHTML;
  submitBtn.innerHTML = '<span>送信中...</span>';

  try {
    const res = await api.post(`/api/courses/${courseId}/assignments/${assignmentId}/submit-text`, {
      submissionType: 'online_url',
      url: inputUrl,
      commentText
    });

    if (res.success) {
      showToast('URL課題の提出が完了しました', 'success');
      triggerConfetti();
      await loadAllAssignments(true);
      if (state.materialsCourseId) loadCourseMaterialsGrouped(state.materialsCourseId, true);
      setTimeout(() => {
        closeAssignmentModal();
      }, 1200);
    } else {
      throw new Error(res.error || '提出に失敗しました');
    }
  } catch (err) {
    console.error('URL submission failed:', err);
    showToast(`提出エラー: ${err.message}`, 'error');
  } finally {
    state.isSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerHTML = origHtml;
  }
}

// 授業回（モジュール）ごとの資料表示
document.getElementById('material-course-select').addEventListener('change', (e) => {
  state.materialsCourseId = e.target.value;
  loadCourseMaterialsGrouped(e.target.value);
});

// 講義資料画面の初期化イベント（リアルタイム検索 & すべて折りたたむ）
let areAllModulesCollapsed = false;
function setupMaterialsViewEvents() {
  const toggleAllBtn = document.getElementById('btn-toggle-all-modules');
  const toggleAllLabel = document.getElementById('btn-toggle-all-label');

  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      areAllModulesCollapsed = !areAllModulesCollapsed;
      document.querySelectorAll('.module-group').forEach(grp => {
        grp.classList.toggle('collapsed', areAllModulesCollapsed);
      });
      if (toggleAllLabel) {
        toggleAllLabel.textContent = areAllModulesCollapsed ? 'すべて展開する' : 'すべて折りたたむ';
      }
    });
  }

  const searchInput = document.getElementById('materials-search-input');
  const clearBtn = document.getElementById('btn-clear-materials-search');

  if (searchInput) {
    const debouncedFilter = debounce((q) => {
      filterMaterialsInDom(q);
    }, 120);

    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
      debouncedFilter(q);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      filterMaterialsInDom('');
    });
  }
}

function filterMaterialsInDom(query) {
  const groups = document.querySelectorAll('.module-group');
  groups.forEach(group => {
    const titleText = group.querySelector('.module-group-title span')?.textContent.toLowerCase() || '';
    const cards = group.querySelectorAll('.module-file-card');
    let hasMatch = false;

    cards.forEach(card => {
      const cardTitle = card.querySelector('.module-file-title')?.textContent.toLowerCase() || '';
      const cardMeta = card.querySelector('.module-file-meta')?.textContent.toLowerCase() || '';
      const matches = !query || cardTitle.includes(query) || cardMeta.includes(query) || titleText.includes(query);
      card.style.display = matches ? 'flex' : 'none';
      if (matches) hasMatch = true;
    });

    group.style.display = (!query || hasMatch || titleText.includes(query)) ? 'block' : 'none';
    if (query && hasMatch) {
      group.classList.remove('collapsed');
    }
  });
}

// クライアント側講義資料キャッシュ管理 (バッテリー節約 & 即時ゼロディレイ表示)
const CLIENT_MATERIALS_CACHE_TTL = 30 * 60 * 1000; // 30分間有効
const MAX_MATERIALS_IN_MEMORY = 12; // メモリ肥大化を防ぐ上限件数

function getCachedMaterials(courseId) {
  const cacheKey = String(courseId);
  // 1. インメモリキャッシュ
  if (state.materialsCache.has(cacheKey)) {
    const entry = state.materialsCache.get(cacheKey);
    const data = (entry && entry.data) ? entry.data : entry;
    const time = (entry && entry.timestamp) ? entry.timestamp : 0;
    if (data && (Date.now() - time < CLIENT_MATERIALS_CACHE_TTL)) {
      return data;
    }
  }
  // 2. セッションストレージ (タブ/ウィンドウを開いている間の高速復旧)
  try {
    const raw = sessionStorage.getItem(`canvas_horizon_materials_${cacheKey}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && (Date.now() - (parsed.timestamp || 0) < CLIENT_MATERIALS_CACHE_TTL)) {
        state.materialsCache.set(cacheKey, parsed);
        return parsed.data;
      }
    }
  } catch (_) {}
  return null;
}

function setCachedMaterials(courseId, modules) {
  const cacheKey = String(courseId);
  const entry = { data: modules, timestamp: Date.now() };

  // Map の LRU 制御: すでに存在していれば削除して末尾に再挿入
  if (state.materialsCache.has(cacheKey)) {
    state.materialsCache.delete(cacheKey);
  } else if (state.materialsCache.size >= MAX_MATERIALS_IN_MEMORY) {
    // 最も古いエントリを破棄してメモリリーク・肥大化を完全防止
    const oldestKey = state.materialsCache.keys().next().value;
    if (oldestKey) state.materialsCache.delete(oldestKey);
  }
  state.materialsCache.set(cacheKey, entry);

  try {
    sessionStorage.setItem(`canvas_horizon_materials_${cacheKey}`, JSON.stringify(entry));
  } catch (err) {
    // QuotaExceededError が発生した場合は古い講義資料セッションストレージキーをパージ
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('canvas_horizon_materials_')) {
          sessionStorage.removeItem(k);
        }
      }
      sessionStorage.setItem(`canvas_horizon_materials_${cacheKey}`, JSON.stringify(entry));
    } catch (_) {}
  }
}

async function loadCourseMaterialsGrouped(courseId, forceRefresh = false) {
  if (!courseId) return;
  const container = document.getElementById('grouped-modules-container');
  const targetId = String(courseId);
  state.materialsCourseId = targetId;

  // 1. キャッシュが存在する場合: 0msで即座にパッと描画！(バッテリー消費・通信ゼロ)
  if (!forceRefresh) {
    const cached = getCachedMaterials(targetId);
    if (cached) {
      state.groupedMaterials = cached;
      renderGroupedMaterials(cached);
      return;
    }
  }

  // 2. キャッシュがない場合: 画面中央にシンプルな同期スピナーを表示
  container.innerHTML = `
    <div class="materials-center-loading">
      <div class="spinner-ring"></div>
      <span class="materials-center-text">講義資料を同期中...</span>
    </div>
  `;

  try {
    const res = await api.get(`/api/courses/${courseId}/materials-grouped?refresh=${forceRefresh}`);
    // 通信中にユーザーが別科目に切り替えていた場合は古い結果を適用しない
    if (String(state.materialsCourseId) !== targetId) return;

    if (res.success && res.modules) {
      state.groupedMaterials = res.modules;
      setCachedMaterials(targetId, res.modules);
      renderGroupedMaterials(res.modules);
    }
  } catch (err) {
    if (String(state.materialsCourseId) !== targetId) return;
    const fallback = getCachedMaterials(targetId);
    if (fallback) {
      state.groupedMaterials = fallback;
      renderGroupedMaterials(fallback);
      showToast('最新資料の取得に失敗したため、キャッシュを表示しています', 'info');
    } else {
      container.innerHTML = `<div style="color: var(--status-urgent); padding: 24px; font-weight: 600;">資料取得エラー: ${utils.escapeHtml(err.message)}</div>`;
    }
  }
}

function renderGroupedMaterials(modules) {
  const container = document.getElementById('grouped-modules-container');
  container.innerHTML = '';

  if (modules.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-state-icon">
          <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        </div>
        <div class="empty-state-title">公開された講義資料はありません</div>
        <div class="empty-state-sub">この科目のモジュールにはまだPDFや資料が追加されていないか、非公開に設定されています。</div>
      </div>
    `;
    return;
  }

  // 検索入力欄があれば値を引き継いでフィルタ
  const searchInput = document.getElementById('materials-search-input');
  const currentQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const fragment = document.createDocumentFragment();
  modules.forEach(m => {
    const group = document.createElement('div');
    group.className = 'module-group';

    const fileItems = [];
    const videoItems = [];

    m.items.forEach(it => {
      const extUrl = it.externalUrl || it.url || it.htmlUrl;
      const ytId = utils.extractYouTubeVideoId(extUrl);
      if (it.type === 'File') {
        fileItems.push({
          id: it.id,
          name: it.displayName || it.title,
          url: it.url,
          courseId: it.courseId || state.materialsCourseId
        });
      } else if (ytId) {
        videoItems.push({
          url: extUrl,
          title: it.displayName || it.title
        });
      } else if (it.type === 'ExternalUrl' && /\.(pdf|zip|docx?|pptx?|xlsx?|mp4|mov|mkv|webm)$/i.test(extUrl || '')) {
        fileItems.push({
          id: it.id || null,
          name: it.displayName || it.title,
          url: extUrl,
          courseId: it.courseId || state.materialsCourseId
        });
      }
    });

    const totalSavable = fileItems.length + videoItems.length;

    group.innerHTML = `
      <div class="module-group-header">
        <div class="module-group-title">
          <svg class="module-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/></svg>
          <span>${m.name}</span>
          <span class="module-items-badge">${m.items.length}件</span>
        </div>
        ${totalSavable > 0 ? `
          <button class="action-chip-btn btn-zip-module" style="font-weight: 700; color: #38bdf8; border-color: rgba(56, 189, 248, 0.35);" title="この回のファイル・動画をすべて保存します">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            この回の資料を保存 (${totalSavable}件)
          </button>
        ` : ''}
      </div>
      <div class="module-files-grid"></div>
    `;

    // モジュールヘッダーのクリックによるアコーディオン開閉
    const header = group.querySelector('.module-group-header');
    header.addEventListener('click', (e) => {
      // 資料保存ボタンをクリックした場合は開閉させない
      if (e.target.closest('.btn-zip-module')) return;
      group.classList.toggle('collapsed');
    });

    if (totalSavable > 0) {
      const zipBtn = group.querySelector('.btn-zip-module');
      zipBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const origContent = zipBtn.innerHTML;
        zipBtn.disabled = true;
        zipBtn.innerHTML = `
          <svg class="spin" width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          準備中...
        `;
        try {
          const promises = [];
          // 通常ファイルは一括ダウンロード
          if (fileItems.length > 0) {
            promises.push(downloadFilesToFolder(fileItems, `${m.name} 資料`, m.name));
          }
          // YouTube動画・映像は個別にジョブとしてキュー
          videoItems.forEach(v => {
            promises.push(downloadYouTubeVideo(v.url, v.title));
          });
          await Promise.all(promises);
        } finally {
          zipBtn.disabled = false;
          zipBtn.innerHTML = origContent;
        }
      });
    }

    const grid = group.querySelector('.module-files-grid');

    m.items.forEach(it => {
      const isFile = it.type === 'File';
      const isPage = it.type === 'Page';
      const isAssignment = it.type === 'Assignment';
      const isExternal = it.type === 'ExternalUrl';
      const isQuiz = it.type === 'Quiz';

      const isPdf = isFile && ((it.displayName && it.displayName.toLowerCase().endsWith('.pdf')) || (it.title && it.title.toLowerCase().endsWith('.pdf')));
      const title = it.displayName || it.title;
      const directDownloadUrl = it.id ? `/api/files/download?id=${it.id}&name=${encodeURIComponent(title)}` : null;

      const card = document.createElement('div');
      card.className = 'module-file-card';

      const extUrl = it.externalUrl || it.url || it.htmlUrl;
      const ytId = isExternal ? utils.extractYouTubeVideoId(extUrl) : null;

      // アイコンの選定
      let iconHtml = '';
      let iconClass = 'other';

      // 提出状況の判定
      let isAssignmentSubmitted = false;
      let matchingAssign = null;
      if (isAssignment) {
        matchingAssign = (state.allAssignments || []).find(a => 
          (it.contentId && String(a.id) === String(it.contentId)) ||
          (it.assignmentId && String(a.id) === String(it.assignmentId)) ||
          (it.id && String(a.id) === String(it.id)) ||
          (a.name && (a.name.trim() === title.trim() || a.name.includes(title) || title.includes(a.name)))
        );

        isAssignmentSubmitted = Boolean(
          it.isSubmitted ||
          matchingAssign?.isSubmitted ||
          (matchingAssign?.submission && (matchingAssign.submission.workflowState === 'submitted' || matchingAssign.submission.workflowState === 'graded')) ||
          (it.submission && (it.submission.workflowState === 'submitted' || it.submission.workflowState === 'graded'))
        );
      }

      if (isPdf) {
        iconClass = 'pdf';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';
      } else if (isQuiz) {
        iconClass = 'quiz';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
      } else if (isPage) {
        iconClass = 'page';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>';
      } else if (isAssignment) {
        iconClass = 'assignment';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
      } else if (ytId) {
        iconClass = 'video';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
      } else if (isExternal) {
        iconClass = 'other';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>';
      } else {
        iconClass = 'other';
        iconHtml = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>';
      }

      // サブテキストの表示（締切・配点）
      let metaHtml = '';
      if (isAssignment) {
        const assignData = matchingAssign || it;
        const dueAt = assignData.dueAt;
        const pointsPossible = assignData.pointsPossible;
        const pointsText = (typeof pointsPossible === 'number') ? `${pointsPossible}点` : '';
        const dueText = dueAt ? utils.formatDate(dueAt) : null;

        if (isAssignmentSubmitted) {
          // ステータスタグの表示判定
          const parts = [];
          if (dueText) parts.push(`締切: ${dueText}`);
          if (pointsText) parts.push(pointsText);
          metaHtml = parts.length > 0 ? `<span>${parts.join(' ・ ')}</span>` : `<span>課題</span>`;
        } else if (dueText) {
          const urgency = utils.getDueUrgency(dueAt, false);
          const chipClass = urgency.level === 'urgent' ? 'due-urgent' : 'due-normal';
          metaHtml = `<span class="meta-chip ${chipClass}">締切: ${dueText}</span>${pointsText ? `<span>${pointsText}</span>` : ''}`;
        } else if (pointsText) {
          metaHtml = `<span>配点: ${pointsText}</span>`;
        } else {
          metaHtml = `<span>課題</span>`;
        }
      } else if (isQuiz) {
        metaHtml = `<span>小テスト</span>`;
      } else if (isPage) {
        metaHtml = `<span>ノート</span>`;
      } else if (ytId) {
        metaHtml = `<span>YouTube</span>`;
      } else if (isFile) {
        metaHtml = `<span>${utils.getFileExt(title)} ${it.size ? `・ ${utils.formatBytes(it.size)}` : ''}</span>`;
      } else {
        metaHtml = `<span>リンク</span>`;
      }

      // アクションボタンの生成
      let actionHtml = '';
      if (isFile) {
        actionHtml = `
          <button type="button" class="action-chip-btn action-download btn-file-direct-save" title="ダウンロードフォルダに保存">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            <span>保存</span>
          </button>
        `;
      } else if (isQuiz) {
        actionHtml = `
          <span class="action-chip-btn action-quiz btn-open-quiz-direct" title="小テスト・アンケートを受験">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            <span>回答</span>
          </span>
        `;
      } else if (isPage) {
        actionHtml = `
          <span class="action-chip-btn action-view" title="講義ノート・指示事項を表示">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span>閲覧</span>
          </span>
        `;
      } else if (isAssignment) {
        if (isAssignmentSubmitted) {
          actionHtml = `
            <span class="action-chip-btn action-submitted" title="提出状況の確認・再提出">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7"/></svg>
              <span>提出済み</span>
            </span>
          `;
        } else {
          actionHtml = `
            <span class="action-chip-btn action-submit" title="課題の確認と提出">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
              <span>提出</span>
            </span>
          `;
        }
      } else if (ytId) {
        // 保存ボタンの生成
        actionHtml = `
          <button type="button" class="action-chip-btn action-download btn-yt-dl-trigger" title="動画をダウンロードフォルダに保存">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            <span>保存</span>
          </button>
        `;
      } else if (isExternal) {
        actionHtml = `
          <span class="action-chip-btn action-external" title="外部ページを開く">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
            <span>開く</span>
          </span>
        `;
      }

      card.innerHTML = `
        <div class="module-file-left">
          <div class="module-file-icon ${iconClass}">
            ${iconHtml}
          </div>
          <div class="module-file-info">
            <span class="module-file-title" title="${title}">${title}</span>
            <div class="module-file-meta">
              ${metaHtml}
            </div>
          </div>
        </div>
        <div class="module-file-actions">
          ${actionHtml}
        </div>
      `;

      // カード全体のクリックイベント
      card.addEventListener('click', (e) => {
        // 単体ファイルの「保存」ボタンをクリックした時は直接ダウンロードフォルダ保存
        const fileDirectSaveBtn = e.target.closest('.btn-file-direct-save');
        if (fileDirectSaveBtn) {
          e.stopPropagation();
          e.preventDefault();
          downloadSingleFile({
            id: it.id,
            url: it.url,
            name: title,
            courseId: it.courseId || state.materialsCourseId
          });
          return;
        }

        // YouTubeの保存ボタンクリック時はダウンロード処理のみ実行
        const ytDlTrigger = e.target.closest('.btn-yt-dl-trigger');
        if (ytDlTrigger) {
          e.stopPropagation();
          e.preventDefault();
          downloadYouTubeVideo(it.externalUrl || it.url || it.htmlUrl, title);
          return;
        }

        // 直接回答ボタンクリック時も伝播停止してブラウザを開く
        const quizDirectBtn = e.target.closest('.btn-open-quiz-direct');
        if (quizDirectBtn) {
          e.stopPropagation();
          e.preventDefault();
          const quizUrl = it.htmlUrl || it.url;
          if (quizUrl) utils.openExternalUrl(quizUrl);
          return;
        }

        if (ytId) {
          openYouTubeModal(ytId, title, it.externalUrl || it.url || it.htmlUrl);
          return;
        }

        if (isPdf && it.id) {
          openPdfPreviewModal(`/api/files/download?id=${it.id}&inline=true`, title, it.id, it.courseId || state.materialsCourseId);
        } else if (isFile) {
          downloadSingleFile({
            id: it.id,
            url: it.url,
            name: title,
            courseId: it.courseId || state.materialsCourseId
          });
        } else if (isQuiz) {
          const quizUrl = it.htmlUrl || it.url;
          // アクションボタン（受験・回答 ↗）クリック時は直接既定ブラウザで開く
          if (e.target.classList.contains('btn-open-quiz-direct')) {
            if (quizUrl) {
              utils.openExternalUrl(quizUrl);
              return;
            }
          }
          // カード本体クリック時は詳細モーダルを開く
          const existing = state.allAssignments.find(a => 
            (it.contentId && String(a.id) === String(it.contentId)) ||
            (it.id && String(a.id) === String(it.id)) ||
            (a.name === title)
          );
          if (existing) {
            openAssignmentModal(existing);
          } else {
            openAssignmentModal({
              id: it.contentId || it.id,
              courseId: state.materialsCourseId,
              name: title,
              courseName: document.getElementById('material-course-select')?.selectedOptions[0]?.text || '',
              submissionTypes: ['online_quiz'],
              htmlUrl: quizUrl
            });
          }
        } else if (isPage && it.pageUrl) {
          openPageModal(state.materialsCourseId, it.pageUrl, title);
        } else if (isAssignment) {
          const assignData = matchingAssign || {
            id: it.assignmentId || it.contentId || it.id,
            courseId: it.courseId || state.materialsCourseId,
            name: title,
            courseName: document.getElementById('material-course-select')?.selectedOptions[0]?.text || '',
            submissionTypes: it.submissionTypes || ['online_upload'],
            isSubmitted: isAssignmentSubmitted,
            dueAt: it.dueAt,
            pointsPossible: it.pointsPossible,
            submission: it.submission
          };
          openAssignmentModal(assignData);
        } else if (isExternal && it.url) {
          utils.openExternalUrl(it.url);
        }
      });

      grid.appendChild(card);
    });

    fragment.appendChild(group);
  });

  container.appendChild(fragment);

  if (currentQuery) {
    filterMaterialsInDom(currentQuery);
  }
}

// ページコンテンツ表示モーダル
async function openPageModal(courseId, pageUrl, fallbackTitle) {
  const modal = document.getElementById('page-modal');
  const titleEl = document.getElementById('page-modal-title');
  const bodyEl = document.getElementById('page-modal-body');

  titleEl.textContent = fallbackTitle || '講義ノート';
  bodyEl.innerHTML = '<div style="color: var(--text-muted); padding: 20px;">本文を読み込み中...</div>';
  modal.classList.add('open');

  try {
    const res = await api.get(`/api/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
    if (res.success && res.page) {
      titleEl.textContent = res.page.title || fallbackTitle;
      bodyEl.innerHTML = utils.formatHtmlWithLinks(res.page.body || '<p style="color: var(--text-muted);">本文がありません。</p>');
      setupContentLinks(bodyEl, courseId);
    } else {
      throw new Error(res.error || 'ページ内容の取得に失敗しました');
    }
  } catch (err) {
    bodyEl.innerHTML = `<div style="color: var(--status-urgent); padding: 16px;">ページ取得エラー: ${err.message}</div>`;
  }
}

let isPageFullscreen = false;

function togglePageFullscreen(forceState) {
  isPageFullscreen = toggleModalFullscreen('page-modal-container', 'page-expand-icon', 'page-compress-icon', forceState);
}

function closePageModal() {
  const modal = document.getElementById('page-modal');
  if (modal) modal.classList.remove('open');
  if (isPageFullscreen) {
    togglePageFullscreen(false);
  }
}

document.getElementById('page-modal-close-btn').addEventListener('click', closePageModal);

const pageFsBtn = document.getElementById('page-modal-fullscreen-btn');
if (pageFsBtn) {
  pageFsBtn.addEventListener('click', () => togglePageFullscreen());
}

document.getElementById('page-modal').addEventListener('click', (e) => {
  if (e.target.id === 'page-modal') closePageModal();
});

// ファイル・動画の一括保存（科目全体）
document.getElementById('btn-download-all-zip').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const allFiles = [];
  const allVideos = [];
  state.groupedMaterials.forEach(m => {
    m.items.forEach(it => {
      const extUrl = it.externalUrl || it.url || it.htmlUrl;
      const ytId = utils.extractYouTubeVideoId(extUrl);
      if (it.type === 'File' && it.id) {
        allFiles.push({
          id: it.id,
          name: it.displayName || it.title,
          url: it.url,
          courseId: it.courseId || state.materialsCourseId
        });
      } else if (ytId) {
        allVideos.push({
          url: extUrl,
          title: it.displayName || it.title
        });
      } else if (it.type === 'ExternalUrl' && /\.(pdf|zip|docx?|pptx?|xlsx?|mp4|mov|mkv|webm)$/i.test(extUrl || '')) {
        allFiles.push({
          id: it.id || null,
          name: it.displayName || it.title,
          url: extUrl,
          courseId: it.courseId || state.materialsCourseId
        });
      }
    });
  });

  if (allFiles.length === 0 && allVideos.length === 0) return;

  const courseSelect = document.getElementById('material-course-select');
  const courseName = courseSelect.options[courseSelect.selectedIndex]?.text || '講義資料';

  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `
    <svg class="spin" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
    準備中...
  `;
  try {
    const promises = [];
    if (allFiles.length > 0) {
      promises.push(downloadFilesToFolder(allFiles, `${courseName} 全講義資料`, courseName));
    }
    allVideos.forEach(v => {
      promises.push(downloadYouTubeVideo(v.url, v.title));
    });
    await Promise.all(promises);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
});

// アプリ内 PDF ビューアモーダル（全画面表示対応）
let isPdfFullscreen = false;
let currentPdfFile = null;

function togglePdfFullscreen(forceState) {
  isPdfFullscreen = toggleModalFullscreen('pdf-modal-container', 'pdf-expand-icon', 'pdf-compress-icon', forceState);
}

function openPdfPreviewModal(fileUrl, fileName, fileId = null, courseId = null) {
  const modal = document.getElementById('pdf-modal');
  const iframe = document.getElementById('pdf-iframe');
  const title = document.getElementById('pdf-modal-title');
  const spinner = document.getElementById('pdf-loading-spinner');

  currentPdfFile = {
    id: fileId,
    url: fileUrl,
    name: fileName || 'document.pdf',
    courseId: courseId || state.materialsCourseId
  };

  if (title) title.textContent = currentPdfFile.name;

  if (spinner) {
    spinner.style.display = 'flex';
    spinner.style.opacity = '1';
  }

  // タイムアウトによる安全なスピナー解除
  let spinnerTimer = setTimeout(() => {
    if (spinner) {
      spinner.style.opacity = '0';
      setTimeout(() => { spinner.style.display = 'none'; }, 200);
    }
  }, 6000);

  // 高速な読み込み完了検知
  iframe.onload = () => {
    clearTimeout(spinnerTimer);
    if (spinner) {
      spinner.style.opacity = '0';
      setTimeout(() => { spinner.style.display = 'none'; }, 200);
    }
  };

  // PDF表示幅の設定
  const viewerUrl = fileUrl.includes('#') ? fileUrl : `${fileUrl}#view=FitH&toolbar=1`;
  iframe.src = viewerUrl;
  modal.classList.add('open');
}

function closePdfModal() {
  const modal = document.getElementById('pdf-modal');
  const iframe = document.getElementById('pdf-iframe');
  const spinner = document.getElementById('pdf-loading-spinner');
  if (isPdfFullscreen) {
    togglePdfFullscreen(false);
  }
  if (spinner) {
    spinner.style.display = 'none';
  }
  iframe.src = 'about:blank';
  modal.classList.remove('open');
  currentPdfFile = null;
}

const pdfCloseBtn = document.getElementById('pdf-modal-close-btn');
if (pdfCloseBtn) {
  pdfCloseBtn.addEventListener('click', closePdfModal);
}

const pdfFsBtn = document.getElementById('pdf-modal-fullscreen-btn');
if (pdfFsBtn) {
  pdfFsBtn.addEventListener('click', () => togglePdfFullscreen());
}

// PDFモーダル内の保存ボタン
const pdfDlBtn = document.getElementById('pdf-modal-download-btn');
if (pdfDlBtn) {
  pdfDlBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentPdfFile) return;

    const origHtml = pdfDlBtn.innerHTML;
    pdfDlBtn.disabled = true;
    pdfDlBtn.innerHTML = `
      <svg class="spin" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      <span>保存中...</span>
    `;

    try {
      await downloadSingleFile({
        id: currentPdfFile.id,
        url: currentPdfFile.url,
        name: currentPdfFile.name,
        courseId: currentPdfFile.courseId
      });
    } finally {
      pdfDlBtn.disabled = false;
      pdfDlBtn.innerHTML = origHtml;
    }
  });
}

// アプリ内 YouTube プレイヤー ＆ ダウンローダー
let currentYtVideoInfo = null;
let isYouTubeFullscreen = false;

function toggleYouTubeFullscreen(forceState) {
  isYouTubeFullscreen = toggleModalFullscreen('youtube-modal-container', 'youtube-expand-icon', 'youtube-compress-icon', forceState);
}

function openYouTubeModal(videoId, title, originalUrl) {
  const modal = document.getElementById('youtube-modal');
  const container = document.getElementById('youtube-iframe-container');
  const titleEl = document.getElementById('youtube-modal-title');
  const extBtn = document.getElementById('youtube-modal-external-btn');

  if (!modal || !container) return;

  currentYtVideoInfo = {
    videoId,
    title: title || 'YouTube講義動画',
    url: originalUrl || `https://www.youtube.com/watch?v=${videoId}`
  };

  if (titleEl) titleEl.textContent = title || '動画再生';
  if (extBtn) extBtn.href = currentYtVideoInfo.url;
  
  // 物理的に iframe を動的生成してメディアセッションを起動
  container.innerHTML = `<iframe id="youtube-iframe" src="https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1" style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
  modal.classList.add('open');
}

function closeYouTubeModal() {
  const modal = document.getElementById('youtube-modal');
  const container = document.getElementById('youtube-iframe-container');
  if (modal) modal.classList.remove('open');
  if (isYouTubeFullscreen) {
    toggleYouTubeFullscreen(false);
  }
  // iframeの破棄および再生停止
  if (container) {
    container.innerHTML = '';
  }
  currentYtVideoInfo = null;
}

const ytCloseBtn = document.getElementById('youtube-modal-close-btn');
if (ytCloseBtn) {
  ytCloseBtn.addEventListener('click', closeYouTubeModal);
}

const ytFsBtn = document.getElementById('youtube-modal-fullscreen-btn');
if (ytFsBtn) {
  ytFsBtn.addEventListener('click', () => toggleYouTubeFullscreen());
}

// YouTubeモーダル背景クリックで閉じる
const ytModalEl = document.getElementById('youtube-modal');
if (ytModalEl) {
  ytModalEl.addEventListener('click', (e) => {
    if (e.target.id === 'youtube-modal') closeYouTubeModal();
  });
}

// yt-dlp による YouTube 動画のダウンロード
async function downloadYouTubeVideo(url, title) {
  try {
    const res = await api.post('/api/youtube/download', { url, title });
    if (res.success && res.job) {
      downloadManager.addJob(res.job);
      downloadManager.openPanel();
    } else if (!res.success) {
      console.error('YouTube download start failed:', res.error);
    }
  } catch (err) {
    console.error('YouTube download request error:', err);
  }
}

const ytDlBtn = document.getElementById('youtube-modal-dl-btn');
if (ytDlBtn) {
  ytDlBtn.addEventListener('click', () => {
    if (currentYtVideoInfo && currentYtVideoInfo.url) {
      downloadYouTubeVideo(currentYtVideoInfo.url, currentYtVideoInfo.title);
    }
  });
}

// 課題説明文や講義ノート内の YouTube リンククリックのインターセプト
document.addEventListener('click', (e) => {
  const ytLink = e.target.closest('.yt-inline-link');
  if (ytLink) {
    e.preventDefault();
    const ytId = ytLink.dataset.ytId;
    if (ytId) {
      openYouTubeModal(ytId, ytLink.textContent || 'YouTube動画', ytLink.href);
    }
  }
});

window.addEventListener('keydown', (e) => {
  // Alt+W: 執筆ワイドモード切替
  if (e.altKey && (e.key === 'w' || e.key === 'W')) {
    const assignModal = document.getElementById('assignment-modal');
    if (assignModal && assignModal.classList.contains('open')) {
      e.preventDefault();
      toggleEditorWide();
      return;
    }
  }

  if (e.key === 'Escape') {
    const ytModal = document.getElementById('youtube-modal');
    if (ytModal && ytModal.classList.contains('open')) {
      if (isYouTubeFullscreen) {
        toggleYouTubeFullscreen(false);
      } else {
        closeYouTubeModal();
      }
      return;
    }

    const assignModal = document.getElementById('assignment-modal');
    if (assignModal && assignModal.classList.contains('open')) {
      if (isAssignmentFullscreen) {
        toggleAssignmentFullscreen(false);
      } else {
        closeAssignmentModal();
      }
      return;
    }

    const modal = document.getElementById('pdf-modal');
    if (modal && modal.classList.contains('open')) {
      if (isPdfFullscreen) {
        togglePdfFullscreen(false);
      } else {
        closePdfModal();
      }
      return;
    }

    const pageModal = document.getElementById('page-modal');
    if (pageModal && pageModal.classList.contains('open')) {
      if (isPageFullscreen) {
        togglePageFullscreen(false);
      } else {
        closePageModal();
      }
      return;
    }

    const updateModal = document.getElementById('update-modal');
    if (updateModal && updateModal.style.display !== 'none') {
      closeUpdateModal();
      return;
    }
  }
});

// アナウンス（お知らせ）一覧
async function loadAnnouncements() {
  const list = document.getElementById('announcements-timeline-list');
  list.innerHTML = '<div style="color: var(--text-muted); padding: 24px;">お知らせを取得中...</div>';

  try {
    const res = await api.get('/api/announcements');
    if (res.success && res.announcements) {
      state.announcements = res.announcements;
      renderAnnouncements(res.announcements);
    }
  } catch (err) {
    list.innerHTML = `<div style="color: var(--status-urgent); padding: 24px;">お知らせ取得エラー: ${err.message}</div>`;
  }
}

// リッチテキストコンテンツ内の動画埋め込み・ファイルリンク・外部リンクの包括的解決
function setupContentLinks(container, defaultCourseId = null) {
  if (!container) return;

  // 1. Canvas のメディア埋め込み iframe (media_attachments_iframe, media_objects_iframe) の検出と高機能プレイヤー化
  const iframes = Array.from(container.querySelectorAll('iframe'));
  iframes.forEach(iframe => {
    const src = iframe.getAttribute('src') || '';
    const titleAttr = iframe.getAttribute('title') || '';
    let cleanTitle = titleAttr.replace(/のビデオプレーヤー.*$/i, '').trim();

    // 1-1. media_attachments_iframe (Canvas 添付ファイル動画)
    const attMatch = src.match(/media_attachments_iframe\/(\d+)/);
    if (attMatch) {
      const attachmentId = attMatch[1];
      const vMatch = src.match(/[?&]verifier=([a-zA-Z0-9\-_]+)/);
      const verifier = vMatch ? vMatch[1] : '';
      if (!cleanTitle) cleanTitle = `講義動画 (${attachmentId})`;
      if (!/\.(mp4|webm|mov|mkv)$/i.test(cleanTitle)) cleanTitle += '.mp4';

      const streamUrl = `/api/files/download?id=${attachmentId}&verifier=${encodeURIComponent(verifier)}&courseId=${defaultCourseId || ''}&inline=true&name=${encodeURIComponent(cleanTitle)}`;

      const videoCard = document.createElement('div');
      videoCard.className = 'embedded-video-card';
      videoCard.innerHTML = `
        <div class="embedded-video-header">
          <div class="embedded-video-title" title="${utils.escapeHtml(cleanTitle)}">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span>${utils.escapeHtml(cleanTitle)}</span>
          </div>
          <div class="embedded-video-actions">
            <button type="button" class="action-chip-btn action-download btn-save-embedded-video" title="ダウンロードフォルダに保存">
              <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              <span>保存</span>
            </button>
          </div>
        </div>
        <div class="embedded-video-player-wrapper">
          <video class="embedded-video-player" controls preload="metadata" playsinline src="${streamUrl}">
            お使いの環境では動画タグの直接再生がサポートされていません。
          </video>
        </div>
      `;

      const saveBtn = videoCard.querySelector('.btn-save-embedded-video');
      if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          downloadSingleFile({
            id: attachmentId,
            url: streamUrl,
            name: cleanTitle,
            courseId: defaultCourseId
          });
        });
      }

      iframe.parentNode.replaceChild(videoCard, iframe);
      return;
    }

    // 1-2. media_objects_iframe (Kaltura / Canvas Media Object)
    const objMatch = src.match(/media_objects_iframe\/(m-[a-zA-Z0-9\-_]+)/);
    if (objMatch) {
      const mediaId = objMatch[1];
      if (!cleanTitle) cleanTitle = `講義メディア (${mediaId})`;
      
      const videoCard = document.createElement('div');
      videoCard.className = 'embedded-video-card';
      videoCard.innerHTML = `
        <div class="embedded-video-header">
          <div class="embedded-video-title" title="${utils.escapeHtml(cleanTitle)}">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            <span>${utils.escapeHtml(cleanTitle)}</span>
          </div>
        </div>
        <div class="embedded-video-player-wrapper">
          <video class="embedded-video-player" controls preload="metadata" playsinline>
            動画ストリームを解決中...
          </video>
        </div>
      `;

      iframe.parentNode.replaceChild(videoCard, iframe);

      api.get(`/api/media/resolve?entryId=${encodeURIComponent(mediaId)}&courseId=${defaultCourseId || ''}`)
        .then(res => {
          if (res.success && res.streamUrl) {
            const v = videoCard.querySelector('video');
            if (v) v.src = res.streamUrl;
          }
        }).catch(() => {});
      return;
    }
  });

  // 2. 既存の <video> / <source> タグの相対パス補正
  container.querySelectorAll('video, audio').forEach(mediaEl => {
    mediaEl.classList.add('embedded-video-player');
    const src = mediaEl.getAttribute('src');
    if (src && (src.startsWith('/') || src.includes('instructure.com'))) {
      const fMatch = src.match(/\/files\/(\d+)/);
      if (fMatch) {
        mediaEl.src = `/api/files/download?id=${fMatch[1]}&courseId=${defaultCourseId || ''}&inline=true`;
      }
    }
    mediaEl.querySelectorAll('source').forEach(s => {
      const sSrc = s.getAttribute('src');
      if (sSrc && (sSrc.startsWith('/') || sSrc.includes('instructure.com'))) {
        const sfMatch = sSrc.match(/\/files\/(\d+)/);
        if (sfMatch) {
          s.src = `/api/files/download?id=${sfMatch[1]}&courseId=${defaultCourseId || ''}&inline=true`;
        }
      }
    });
  });

  // 3. リンクのインターセプト（PDFビューア、動画ファイル、外部リンク）
  container.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href') || '';
    const text = link.textContent.trim();
    const title = link.getAttribute('title') || '';
    const endpoint = link.dataset.apiEndpoint || '';

    // Canvas のファイルリンクまたは PDF リンクの精密判定
    const isPdf = href.toLowerCase().includes('.pdf') ||
                  text.toLowerCase().includes('.pdf') ||
                  title.toLowerCase().includes('.pdf') ||
                  link.dataset.apiReturntype === 'File';

    const isVideo = href.match(/\.(mp4|webm|mov|mkv)$/i) ||
                    text.match(/\.(mp4|webm|mov|mkv)$/i) ||
                    title.match(/\.(mp4|webm|mov|mkv)$/i);

    const isCanvasFile = href.includes('/files/') ||
                         endpoint.includes('/files/') ||
                         link.classList.contains('instructure_file_link');

    if (isPdf || isCanvasFile) {
      link.classList.add(isPdf ? 'inline-pdf-link' : 'inline-file-link');
      link.style.cursor = 'pointer';
      link.title = isPdf ? '内蔵PDFビューアでプレビュー' : (isVideo ? '動画を再生またはダウンロード' : 'ファイルをダウンロード');

      link.addEventListener('click', (e) => {
        e.preventDefault();

        // fileId と courseId の精密抽出
        const endpointOrHref = endpoint || href;
        const fMatch = endpointOrHref.match(/\/files\/(\d+)/);
        const fileId = fMatch ? fMatch[1] : null;

        const cMatch = endpointOrHref.match(/\/courses\/(\d+)/);
        const courseId = cMatch ? cMatch[1] : (defaultCourseId || state.materialsCourseId || null);

        let safeName = text || title || (isPdf ? 'document.pdf' : (isVideo ? 'video.mp4' : 'download'));
        safeName = safeName.replace(/[\r\n\t]+/g, ' ').trim() || (isPdf ? 'document.pdf' : 'download');
        if (!safeName.toLowerCase().endsWith('.pdf') && isPdf) {
          safeName += '.pdf';
        }

        if (isPdf) {
          let previewUrl;
          if (fileId) {
            previewUrl = `/api/files/download?id=${fileId}&courseId=${courseId || ''}&inline=true&name=${encodeURIComponent(safeName)}`;
          } else {
            previewUrl = `/api/files/download?url=${encodeURIComponent(href)}&courseId=${courseId || ''}&inline=true&name=${encodeURIComponent(safeName)}`;
          }
          openPdfPreviewModal(previewUrl, safeName, fileId, courseId);
        } else {
          downloadSingleFile({
            id: fileId,
            url: href,
            name: safeName,
            courseId: courseId
          });
        }
      });
    } else if (href && href !== '#' && !href.startsWith('javascript:')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        utils.openExternalUrl(href);
      });
    }
  });
}

function renderAnnouncements(announcements) {
  const list = document.getElementById('announcements-timeline-list');
  list.innerHTML = '';

  if (announcements.length === 0) {
    list.innerHTML = '<div style="color: var(--text-muted); padding: 32px; text-align: center;">新しいお知らせはありません。</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  announcements.forEach(a => {
    const card = document.createElement('div');
    card.className = 'announcement-card';

    const formattedDate = utils.formatDate(a.postedAt);
    const authorName = a.author || '担当教員';

    const courseId = a.contextCode ? a.contextCode.replace('course_', '') : '';
    const course = state.courses ? state.courses.find(c => String(c.id) === String(courseId)) : null;
    const courseName = course ? (course.cleanName || course.name) : '';
    const courseColor = utils.getCourseColor(courseName || courseId);

    const courseTagHtml = courseName
      ? `<span class="assignment-course ${courseColor.tagClass}" title="${courseName}">${courseName}</span>`
      : '';

    card.innerHTML = `
      <div class="announcement-header">
        <div class="announcement-title-row">
          <h3 class="announcement-title">${a.title}</h3>
        </div>
        <div class="announcement-meta-row">
          ${courseTagHtml}
          <span class="announcement-time-badge">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            ${formattedDate}
          </span>
          <span class="announcement-author-badge">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
            ${authorName}
          </span>
        </div>
      </div>
      <div class="announcement-body">${a.message}</div>
    `;

    // 本文内のファイル・PDFリンクを内蔵PDFプレビューへバインド
    const bodyEl = card.querySelector('.announcement-body');
    if (bodyEl) {
      setupContentLinks(bodyEl, courseId);
    }

    // 添付ファイル（attachments）が存在する場合は専用のアクションチップを表示
    if (a.attachments && a.attachments.length > 0) {
      const attachWrap = document.createElement('div');
      attachWrap.className = 'announcement-attachments';
      attachWrap.style.cssText = 'margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border-subtle); display: flex; flex-wrap: wrap; gap: 8px; align-items: center;';

      const label = document.createElement('span');
      label.style.cssText = 'font-size: 11.5px; font-weight: 600; color: var(--text-muted); margin-right: 4px;';
      label.textContent = '添付ファイル:';
      attachWrap.appendChild(label);

      a.attachments.forEach(att => {
        const attName = att.display_name || att.filename || '添付ファイル';
        const isPdf = attName.toLowerCase().endsWith('.pdf') || att['content-type'] === 'application/pdf';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `action-chip-btn ${isPdf ? 'action-submit' : 'action-download'}`;
        btn.title = isPdf ? '内蔵PDFビューアでプレビュー' : 'ファイルをダウンロード';
        btn.innerHTML = `
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${isPdf ? 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z' : 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12'}"/></svg>
          <span>${utils.escapeHtml(attName)}</span>
        `;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          if (isPdf) {
            const previewUrl = `/api/files/download?id=${att.id || ''}&url=${encodeURIComponent(att.url || '')}&courseId=${courseId}&inline=true&name=${encodeURIComponent(attName)}`;
            openPdfPreviewModal(previewUrl, attName, att.id, courseId);
          } else {
            downloadSingleFile({ id: att.id, url: att.url, name: attName, courseId });
          }
        });
        attachWrap.appendChild(btn);
      });

      card.appendChild(attachWrap);
    }

    fragment.appendChild(card);
  });
  list.appendChild(fragment);
}

// 設定画面のイベント登録
function setupSettingsEvents() {
  const saveBtn = document.getElementById('btn-save-settings');
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  const batterySwitch = document.getElementById('cfg-battery-saver');

  api.get('/api/config').then(res => {
    if (res.success && res.config) {
      document.getElementById('cfg-base-url').value = res.config.baseUrl || '';
      document.getElementById('cfg-api-token').value = res.config.apiToken || '';
      if (res.config.currentQuarter) {
        document.getElementById('cfg-quarter').value = res.config.currentQuarter;
        state.currentQuarter = res.config.currentQuarter;
        updateQuarterIndicators();
      }
      if (res.config.batteryMode && ['auto', 'on', 'off'].includes(res.config.batteryMode)) {
        state.batteryMode = res.config.batteryMode;
        try { localStorage.setItem(STORAGE_KEY_BATTERY_MODE, res.config.batteryMode); } catch (_) {}
        if (window.evaluateAppBatterySaving) window.evaluateAppBatterySaving();
      }
      if (batterySwitch) {
        batterySwitch.checked = Boolean(res.config.batterySaver);
      }
      const welcomeBanner = document.getElementById('setting-welcome-banner');
      if (welcomeBanner) {
        welcomeBanner.style.display = (res.config.baseUrl && res.config.apiToken) ? 'none' : 'flex';
      }
    }
  });

  saveBtn.addEventListener('click', async () => {
    const baseUrl = document.getElementById('cfg-base-url').value.trim();
    const apiToken = document.getElementById('cfg-api-token').value.trim();
    const currentQuarter = document.getElementById('cfg-quarter').value.trim();

    if (!baseUrl || !apiToken) {
      showToast('Canvas URLとAPIトークンを入力してください', 'error');
      return;
    }

    const originalText = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '保存中...';

    try {
      try {
        localStorage.setItem(STORAGE_KEY_BATTERY_MODE, state.batteryMode);
      } catch (_) {}
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      const res = await api.post('/api/config', {
        baseUrl,
        apiToken,
        currentQuarter,
        theme,
        batteryMode: state.batteryMode
      });
      if (res.success) {
        state.currentQuarter = currentQuarter;
        updateQuarterIndicators();
        showToast('設定を保存しました。Canvasからデータを取得しています...', 'success');

        // 初回ウェルカムバナーを非表示にしてダッシュボードへ遷移
        const welcomeBanner = document.getElementById('setting-welcome-banner');
        if (welcomeBanner) welcomeBanner.style.display = 'none';
        switchView('dashboard');

        await loadCourses(true);
        await loadAllAssignments(true);
        api.get('/api/me').then(meRes => {
          if (meRes.success && meRes.profile) {
            renderProfile(meRes.profile);
          }
        }).catch(() => {});
      }
    } catch (err) {
      showToast(`保存エラー: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalText;
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    try {
      state.materialsCache.clear();
      try {
        Object.keys(sessionStorage).forEach(k => {
          if (k.startsWith('canvas_horizon_materials_')) sessionStorage.removeItem(k);
        });
      } catch (_) {}
      await api.post('/api/cache/clear', {});
      showToast('キャッシュをクリアしました', 'success');
      await loadCourses(true);
      await loadAllAssignments(true);
    } catch (err) {
      showToast(`キャッシュクリア失敗: ${err.message}`, 'error');
    }
  });

  // アプリ内アップデート確認ボタン
  const checkUpdateBtn = document.getElementById('btn-check-update');
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', () => {
      checkAppUpdates(true);
    });
  }
}

// ==========================================================================
// アプリアップデート制御ロジック (electron-updater + Update Modal)
// ==========================================================================
let currentUpdateData = null;
let isUpdateDownloading = false;
let isUpdateDownloaded = false;

function closeUpdateModal() {
  const modal = document.getElementById('update-modal');
  if (modal) modal.style.display = 'none';
}

function showUpdateModal(updateData) {
  if (!updateData) return;
  currentUpdateData = updateData;
  const modal = document.getElementById('update-modal');
  if (!modal) return;

  const curVerEl = document.getElementById('update-modal-current-ver');
  if (curVerEl) curVerEl.textContent = updateData.currentVersion || 'v1.1.2';

  const latestVerEl = document.getElementById('update-modal-latest-ver');
  if (latestVerEl) latestVerEl.textContent = updateData.latestVersion || 'v1.1.2';

  const dateEl = document.getElementById('update-modal-date');
  if (dateEl) {
    if (updateData.publishedAt) {
      try {
        const d = new Date(updateData.publishedAt);
        dateEl.textContent = `(${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 公開)`;
      } catch (_) {
        dateEl.textContent = '';
      }
    } else {
      dateEl.textContent = '';
    }
  }

  const notesEl = document.getElementById('update-modal-notes');
  if (notesEl) {
    if (updateData.releaseNotes && updateData.releaseNotes.trim()) {
      notesEl.textContent = updateData.releaseNotes.trim();
    } else {
      notesEl.textContent = `バージョン ${updateData.latestVersion} が利用可能です。\nセキュリティの強化、更新プロセスの信頼性向上、および動作の安定性改善が含まれています。`;
    }
  }

  const manualLink = document.getElementById('update-manual-link');
  if (manualLink) {
    manualLink.onclick = (e) => {
      e.preventDefault();
      const url = updateData.downloadUrl || updateData.zipUrl || 'https://github.com/shizengakari/CanvasLMS-Horizon/releases';
      utils.openExternalUrl(url);
    };
  }

  const actionBtn = document.getElementById('btn-update-action');
  const progressWrap = document.getElementById('update-modal-progress-wrap');

  if (isUpdateDownloaded) {
    if (progressWrap) progressWrap.style.display = 'none';
    if (actionBtn) {
      actionBtn.textContent = '今すぐ再起動して更新';
      actionBtn.disabled = false;
      actionBtn.onclick = () => {
        actionBtn.disabled = true;
        actionBtn.textContent = '再起動中...';
        if (window.desktopAPI && typeof window.desktopAPI.quitAndInstall === 'function') {
          window.desktopAPI.quitAndInstall();
        }
      };
    }
  } else if (isUpdateDownloading) {
    if (progressWrap) progressWrap.style.display = 'flex';
    if (actionBtn) {
      actionBtn.textContent = 'ダウンロード中...';
      actionBtn.disabled = true;
    }
  } else {
    if (progressWrap) progressWrap.style.display = 'none';
    if (actionBtn) {
      actionBtn.textContent = '今すぐアップデート';
      actionBtn.disabled = false;
      actionBtn.onclick = async () => {
        if (window.desktopAPI && typeof window.desktopAPI.startDownloadUpdate === 'function') {
          isUpdateDownloading = true;
          actionBtn.disabled = true;
          actionBtn.textContent = 'ダウンロード中...';
          if (progressWrap) progressWrap.style.display = 'flex';
          const res = await window.desktopAPI.startDownloadUpdate();
          if (!res || !res.success) {
            isUpdateDownloading = false;
            actionBtn.disabled = false;
            actionBtn.textContent = 'ブラウザでダウンロード';
            actionBtn.onclick = () => {
              utils.openExternalUrl(updateData.downloadUrl || 'https://github.com/shizengakari/CanvasLMS-Horizon/releases');
            };
          }
        } else {
          utils.openExternalUrl(updateData.downloadUrl || 'https://github.com/shizengakari/CanvasLMS-Horizon/releases');
        }
      };
    }
  }

  modal.style.display = 'flex';
}

// アプリ全体の自動アップデート確認関数
async function checkAppUpdates(isManual = false) {
  const banner = document.getElementById('header-update-banner');
  const bannerText = document.getElementById('header-update-text');
  const restartBtn = document.getElementById('btn-header-update-restart');
  const checkUpdateBtn = document.getElementById('btn-check-update');
  const updateDesc = document.getElementById('update-status-desc');

  if (isManual && checkUpdateBtn) {
    checkUpdateBtn.disabled = true;
    checkUpdateBtn.textContent = '確認中...';
  }

  try {
    let appInfo = null;
    if (window.desktopAPI && typeof window.desktopAPI.getAppInfo === 'function') {
      try {
        appInfo = await window.desktopAPI.getAppInfo();
      } catch (_) {}
    }

    const res = await api.get('/api/app/check-update');
    const verTag = document.getElementById('app-current-version');
    if (verTag && res && res.currentVersion) {
      verTag.textContent = res.currentVersion;
    }

    if (res && res.hasUpdate) {
      currentUpdateData = res;

      // ヘッダーバナー表示
      if (banner && bannerText && restartBtn) {
        if (!isUpdateDownloading && !isUpdateDownloaded) {
          bannerText.textContent = `新バージョン (${res.latestVersion}) 利用可能`;
          restartBtn.textContent = '詳細 / 更新';
          restartBtn.disabled = false;
          banner.style.display = 'flex';
          banner.style.cursor = 'pointer';
          banner.onclick = () => showUpdateModal(res);
          restartBtn.onclick = (e) => {
            e.stopPropagation();
            showUpdateModal(res);
          };
        }
      }

      // 設定画面の更新説明
      if (updateDesc) {
        updateDesc.innerHTML = `<span style="color: var(--accent-primary); font-weight: 600;">新バージョン (${res.latestVersion}) が利用可能です</span>`;
      }
      if (checkUpdateBtn) {
        checkUpdateBtn.textContent = 'アップデートを確認';
        checkUpdateBtn.classList.remove('btn-secondary');
        checkUpdateBtn.classList.add('btn-primary');
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.onclick = () => showUpdateModal(res);
      }

      // 手動で更新確認を押した場合モーダルを即座に開く
      if (isManual) {
        showUpdateModal(res);
      } else {
        // 自動確認時は控えめにトースト
        showToast(`新バージョン ${res.latestVersion} が利用可能です。上部バーまたは設定から更新できます。`, 'info');
      }

      // Electronネイティブの autoUpdater バックグラウンド確認
      if (window.desktopAPI && appInfo && appInfo.isPackaged && typeof window.desktopAPI.checkForUpdates === 'function') {
        window.desktopAPI.checkForUpdates().catch(() => {});
      }
    } else if (res && res.success) {
      if (updateDesc) {
        updateDesc.textContent = '最新バージョンです';
      }
      if (checkUpdateBtn) {
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.textContent = isManual ? '最新です' : '更新を確認';
        if (isManual) {
          setTimeout(() => {
            checkUpdateBtn.textContent = '更新を確認';
          }, 2500);
        }
      }
      if (isManual) {
        showToast(`お使いのバージョンは最新です (${res.currentVersion})`, 'success');
      }
    } else {
      if (updateDesc) {
        updateDesc.innerHTML = `<span style="color: #ef4444; font-weight: 500;">更新の確認に失敗しました</span>`;
      }
      if (checkUpdateBtn) {
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.textContent = '再試行';
      }
      if (isManual) {
        showToast('更新の確認に失敗しました。ネットワークをご確認ください。', 'warning');
      }
    }
  } catch (err) {
    if (updateDesc) {
      updateDesc.innerHTML = `<span style="color: #ef4444; font-weight: 500;">更新の確認に失敗しました</span>`;
    }
    if (checkUpdateBtn) {
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.textContent = '更新を確認';
    }
    if (isManual) {
      showToast('アップデート確認中にエラーが発生しました', 'error');
    }
  }
}

// コマンドパレット (Ctrl+K)
function setupCommandPalette() {
  const overlay = document.getElementById('command-palette');
  const searchInput = document.getElementById('palette-search-input');
  const resultsList = document.getElementById('palette-results-list');
  let selectedIndex = 0;
  let currentItems = [];

  function openPalette() {
    overlay.classList.add('open');
    searchInput.value = '';
    searchInput.focus();
    selectedIndex = 0;
    renderPaletteResults('');
  }

  function closePalette() {
    overlay.classList.remove('open');
  }

  document.getElementById('global-search-trigger').addEventListener('click', openPalette);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('open')) closePalette();
      else openPalette();
      return;
    }

    if (!overlay.classList.contains('open')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentItems.length > 0) {
        selectedIndex = (selectedIndex + 1) % currentItems.length;
        updateActiveItem();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentItems.length > 0) {
        selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
        updateActiveItem();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentItems.length > 0 && currentItems[selectedIndex]) {
        currentItems[selectedIndex].action();
      }
    }
  });

  function updateActiveItem() {
    const items = resultsList.querySelectorAll('.palette-item');
    items.forEach((item, idx) => {
      const isActive = idx === selectedIndex;
      item.classList.toggle('active', isActive);
      if (isActive) {
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
  });

  const debouncedRenderPalette = debounce((q) => {
    renderPaletteResults(q);
  }, 100);

  searchInput.addEventListener('input', (e) => {
    selectedIndex = 0;
    debouncedRenderPalette(e.target.value.toLowerCase().trim());
  });

  function renderPaletteResults(rawQuery) {
    resultsList.innerHTML = '';
    currentItems = [];

    const query = (rawQuery || '').toLowerCase().trim();
    // ひらがな・カタカナ正規化用の簡易ヘルパー
    const normalizeKana = (str) => {
      if (!str) return '';
      return str.normalize('NFKC').toLowerCase()
        .replace(/[\u30a1-\u30f6]/g, m => String.fromCharCode(m.charCodeAt(0) - 0x60));
    };
    const normQuery = normalizeKana(query);

    const isMatch = (text) => {
      if (!query) return true;
      if (!text) return false;
      const tLower = text.toLowerCase();
      if (tLower.includes(query)) return true;
      const tNorm = normalizeKana(text);
      return tNorm.includes(normQuery);
    };

    // 1. 講義資料（PDF・スライド・配布ファイル・講義ノート・YouTube動画）
    if (Array.isArray(state.groupedMaterials)) {
      const activeCourseName = document.getElementById('material-course-select')?.selectedOptions[0]?.text || '';
      state.groupedMaterials.forEach(m => {
        (m.items || []).forEach(it => {
          const title = it.displayName || it.title || '';
          if (isMatch(title) || isMatch(m.name) || isMatch(activeCourseName)) {
            const isFile = it.type === 'File';
            const isPdf = isFile && title.toLowerCase().endsWith('.pdf');
            const isPage = it.type === 'Page';
            const isVideo = it.type === 'ExternalUrl' && utils.extractYouTubeVideoId(it.url || it.htmlUrl);

            let type = '資料';
            let typeColor = 'background: rgba(16, 185, 129, 0.16); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3);';

            if (isPdf) {
              type = 'PDF';
              typeColor = 'background: rgba(244, 63, 94, 0.16); color: #fda4af; border: 1px solid rgba(244, 63, 94, 0.3);';
            } else if (isVideo) {
              type = '動画';
              typeColor = 'background: rgba(239, 68, 68, 0.16); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3);';
            } else if (isPage) {
              type = 'ノート';
              typeColor = 'background: rgba(245, 158, 11, 0.16); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.3);';
            }

            currentItems.push({
              type,
              badgeStyle: typeColor,
              title: title,
              subtitle: `${activeCourseName ? `${activeCourseName} • ` : ''}${m.name || 'モジュール'}`,
              action: () => {
                closePalette();
                if (isPdf && it.id) {
                  openPdfPreviewModal(`/api/files/download?id=${it.id}&inline=true`, title, it.id, it.courseId || state.materialsCourseId);
                } else if (isVideo) {
                  const ytId = utils.extractYouTubeVideoId(it.url || it.htmlUrl);
                  openYouTubeModal(ytId, title, it.url || it.htmlUrl);
                } else if (isPage && it.pageUrl) {
                  openPageModal(it.courseId || state.materialsCourseId, it.pageUrl, title);
                } else if (isFile) {
                  downloadSingleFile({
                    id: it.id,
                    url: it.url,
                    name: title,
                    courseId: it.courseId || state.materialsCourseId
                  });
                }
              }
            });
          }
        });
      });
    }

    // 2. お知らせ
    if (Array.isArray(state.announcements)) {
      state.announcements.forEach(a => {
        if (isMatch(a.title) || isMatch(a.message) || isMatch(a.author)) {
          currentItems.push({
            type: 'お知らせ',
            badgeStyle: 'background: rgba(168, 85, 247, 0.16); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.3);',
            title: a.title,
            subtitle: `${a.author || '教員'} • ${utils.formatDate(a.postedAt)}`,
            action: () => {
              closePalette();
              switchView('announcements');
            }
          });
        }
      });
    }

    // 3. 課題アイテム
    state.allAssignments.forEach(a => {
      if (isMatch(a.name) || isMatch(a.courseName) || isMatch(a.description)) {
        currentItems.push({
          type: '課題',
          badgeStyle: 'background: rgba(99, 102, 241, 0.16); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3);',
          title: a.name,
          subtitle: `${a.courseName || ''} • 締切: ${utils.formatDate(a.dueAt)}`,
          action: () => {
            closePalette();
            openAssignmentModal(a);
          }
        });
      }
    });

    // 4. 科目アイテム
    state.courses.forEach(c => {
      if (isMatch(c.name) || isMatch(c.cleanName) || isMatch(c.courseCode)) {
        currentItems.push({
          type: '科目',
          badgeStyle: 'background: rgba(6, 182, 212, 0.16); color: #67e8f9; border: 1px solid rgba(6, 182, 212, 0.3);',
          title: `${c.cleanName || c.name}`,
          subtitle: `${c.quarter ? `[${c.quarter}] ` : ''}${c.courseCode || '履修科目'} • 講義資料を開く`,
          action: () => {
            closePalette();
            state.materialsCourseId = c.id;
            const matSelect = document.getElementById('material-course-select');
            if (matSelect) matSelect.value = c.id;
            switchView('materials');
            loadCourseMaterialsGrouped(c.id, false);
          }
        });
      }
    });

    if (currentItems.length === 0) {
      resultsList.innerHTML = '<div style="color: var(--text-muted); padding: 24px; text-align: center; font-size: 13px;">該当するPDF資料、課題、お知らせ、科目が見つかりません</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    currentItems.slice(0, 16).forEach((it, idx) => {
      const el = document.createElement('div');
      el.className = `palette-item${idx === selectedIndex ? ' active' : ''}`;

      el.innerHTML = `
        <span class="file-icon-badge" style="${it.badgeStyle || ''}">${it.type}</span>
        <div style="display: flex; flex-direction: column; overflow: hidden; flex: 1;">
          <span style="font-weight: 600; color: var(--text-main); font-size: 13.5px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${utils.escapeHtml(it.title)}</span>
          <span style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${utils.escapeHtml(it.subtitle)}</span>
        </div>
        <kbd style="font-size: 10px; opacity: 0.6;">↵</kbd>
      `;

      el.addEventListener('mouseenter', () => {
        selectedIndex = idx;
        updateActiveItem();
      });

      el.addEventListener('click', it.action);
      fragment.appendChild(el);
    });
    resultsList.appendChild(fragment);
  }
}

window.addEventListener('DOMContentLoaded', initApp);
