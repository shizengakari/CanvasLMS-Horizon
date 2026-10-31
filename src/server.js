if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, exec } = require('child_process');
const canvasService = require('./canvasService');
const { loadConfig, saveConfig } = require('./config');

const app = express();
const downloadJobs = new Map();
const youtubeDownloads = downloadJobs; // 後方互換性のエイリアス

let cachedYtdlCmd = null;
function getYtdlCommand() {
  if (cachedYtdlCmd) return cachedYtdlCmd;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    'yt-dlp'
  ];
  cachedYtdlCmd = candidates.find(candidate => candidate === 'yt-dlp' || fs.existsSync(candidate)) || 'yt-dlp';
  return cachedYtdlCmd;
}

function publicDownloadJob(job) {
  const { process, ...details } = job;
  return details;
}

function registerDownloadJob(job) {
  // 完了・失敗済みの古いジョブが上限を超えた場合は古い順に自動破棄（メモリリーク防止）
  const MAX_FINISHED_JOBS = 30;
  const finishedKeys = [];
  for (const [id, j] of downloadJobs.entries()) {
    if (j.status !== 'downloading') {
      finishedKeys.push(id);
    }
  }
  if (finishedKeys.length > MAX_FINISHED_JOBS) {
    const toRemove = finishedKeys.slice(0, finishedKeys.length - MAX_FINISHED_JOBS);
    for (const id of toRemove) {
      downloadJobs.delete(id);
    }
  }
  downloadJobs.set(job.id, job);
}

function getCanvasHost(cfg) {
  if (!cfg?.baseUrl) return '';
  try {
    return new URL(cfg.baseUrl).host;
  } catch (e) {
    return '';
  }
}
const PORT = process.env.PORT || 39281; // 衝突しにくいポート
let currentPort = PORT;

// メモリ上でファイルを一時保持してCanvasへストリーム転送
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 1ファイルあたり100MBまで
    files: 50 // 一括アップロードの許容ファイル数
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 大容量JSONレスポンスの高速Gzip圧縮ミドルウェア（IPC/ループバック転送量とパース負荷を削減）
app.use((req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('gzip')) return next();
  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      const jsonStr = JSON.stringify(body);
      if (jsonStr && jsonStr.length > 2048 && !res.headersSent) {
        const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'), { level: zlib.constants.Z_BEST_SPEED });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(compressed.length));
        return res.send(compressed);
      }
    } catch (_) {}
    return origJson(body);
  };
  next();
});

// 静的ファイルの提供（HTMLは即時反映、CSS/JS/画像/フォント等はキャッシュしてディスクI/OとCPU負荷を低減）
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.set('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// 1. プロファイル
app.get('/api/me', async (req, res) => {
  const config = loadConfig();
  const isConfigured = Boolean(config.baseUrl && config.apiToken);
  try {
    const profile = isConfigured ? await canvasService.getProfile() : null;
    res.json({
      success: true,
      profile,
      config: {
        baseUrl: config.baseUrl,
        hasToken: Boolean(config.apiToken),
        isConfigured,
        theme: config.theme,
        currentQuarter: config.currentQuarter || '',
        batteryMode: config.batteryMode || 'auto',
        batterySaver: config.batterySaver,
        pollIntervalMin: config.pollIntervalMin || 15
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      config: {
        baseUrl: config.baseUrl,
        hasToken: Boolean(config.apiToken),
        isConfigured,
        theme: config.theme,
        currentQuarter: config.currentQuarter || '',
        batteryMode: config.batteryMode || 'auto',
        batterySaver: config.batterySaver
      }
    });
  }
});

// 2. コース一覧
app.get('/api/courses', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const courses = await canvasService.getCourses(forceRefresh);
    res.json({ success: true, courses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 課題一覧
app.get('/api/courses/:courseId/assignments', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const includeOld = req.query.includeOld === 'true';
    const assignments = await canvasService.getAssignments(req.params.courseId, forceRefresh, includeOld);
    res.json({ success: true, assignments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3.1 特定課題の最新提出データ取得（添付ファイル・採点・履歴含む）
app.get('/api/courses/:courseId/assignments/:assignmentId/submission', async (req, res) => {
  try {
    const { courseId, assignmentId } = req.params;
    const submission = await canvasService.getAssignmentSubmission(courseId, assignmentId);
    res.json({ success: true, submission });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 全課題タイムライン（ダッシュボード用）
app.get('/api/dashboard/timeline', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const allAssignments = await canvasService.getAllAssignments(forceRefresh);
    res.json({ success: true, assignments: allAssignments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4.1 手動完了済み課題リストの永続化（メモリキャッシュ併用で毎回の同期ディスクI/Oを排除）
const MANUAL_COMPLETED_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Canvas Horizon', 'manual_completed.json');
let cachedManualCompleted = null;

app.get('/api/assignments/manual-completed', (req, res) => {
  try {
    if (Array.isArray(cachedManualCompleted)) {
      return res.json({ success: true, completedIds: cachedManualCompleted });
    }
    if (fs.existsSync(MANUAL_COMPLETED_FILE)) {
      const data = JSON.parse(fs.readFileSync(MANUAL_COMPLETED_FILE, 'utf-8'));
      cachedManualCompleted = Array.isArray(data) ? data : [];
      return res.json({ success: true, completedIds: cachedManualCompleted });
    }
    cachedManualCompleted = [];
    res.json({ success: true, completedIds: [] });
  } catch (e) {
    res.json({ success: true, completedIds: cachedManualCompleted || [] });
  }
});

app.post('/api/assignments/manual-completed', (req, res) => {
  try {
    const { completedIds } = req.body;
    if (Array.isArray(completedIds)) {
      cachedManualCompleted = completedIds;
      const dir = path.dirname(MANUAL_COMPLETED_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.promises.writeFile(MANUAL_COMPLETED_FILE, JSON.stringify(completedIds), 'utf-8').catch(() => {});
      return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'Invalid data' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5. モジュール一覧
app.get('/api/courses/:courseId/modules', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const modules = await canvasService.getModules(req.params.courseId, forceRefresh);
    res.json({ success: true, modules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. コース内の全ファイル一覧（フラット）
app.get('/api/courses/:courseId/files', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const files = await canvasService.getCourseFiles(req.params.courseId, forceRefresh);
    res.json({ success: true, files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6-2. コース内の授業回別（モジュール別）講義資料
app.get('/api/courses/:courseId/materials-grouped', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const grouped = await canvasService.getCourseMaterialsGrouped(req.params.courseId, forceRefresh);
    res.json({ success: true, modules: grouped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6-3. 講義ページ本文取得（Canvas LMSを開かずにアプリ内で全文表示）
app.get('/api/courses/:courseId/pages/:pageUrl', async (req, res) => {
  try {
    const page = await canvasService.getPage(req.params.courseId, req.params.pageUrl);
    res.json({ success: true, page });
  } catch (err) {
    // 403/404 ロック・非公開ページの場合も 500 Internal Server Error ではなく案内オブジェクトを返却
    const cfg = loadConfig();
    let cleanSlug = String(req.params.pageUrl || '').trim();
    try { cleanSlug = decodeURIComponent(cleanSlug); } catch (_) {}
    const fallbackUrl = cfg.baseUrl
      ? `${cfg.baseUrl.replace(/\/+$/, '')}/courses/${req.params.courseId}/pages/${encodeURIComponent(cleanSlug)}`
      : null;
    res.json({
      success: true,
      page: {
        title: cleanSlug,
        body: '',
        updatedAt: null,
        url: fallbackUrl,
        lockedForUser: true,
        lockExplanation: 'このページは現在Canvas上でロック（閲覧期間外）または非公開に設定されています。'
      }
    });
  }
});

// 6-4. ディスカッショントピック本文取得
app.get('/api/courses/:courseId/discussions/:topicId', async (req, res) => {
  try {
    const discussion = await canvasService.getDiscussion(req.params.courseId, req.params.topicId);
    res.json({ success: true, page: discussion, discussion });
  } catch (err) {
    const cfg = loadConfig();
    const fallbackUrl = cfg.baseUrl
      ? `${cfg.baseUrl.replace(/\/+$/, '')}/courses/${req.params.courseId}/discussion_topics/${encodeURIComponent(req.params.topicId)}`
      : null;
    res.json({
      success: true,
      page: {
        title: 'ディスカッション',
        body: '',
        updatedAt: null,
        url: fallbackUrl,
        lockedForUser: true,
        lockExplanation: 'このディスカッションは現在Canvas上でロックまたは非公開に設定されています。'
      }
    });
  }
});

// 7. アナウンス一覧
app.get('/api/announcements', async (req, res) => {
  try {
    const courseIds = req.query.courseIds ? req.query.courseIds.split(',') : [];
    const announcements = await canvasService.getAnnouncements(courseIds);
    res.json({ success: true, announcements });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. 複数ファイルの一括アップロードおよび提出（過去ファイルの保持・マージ提出対応）
app.post('/api/courses/:courseId/assignments/:assignmentId/submit-files', upload.array('files', 50), async (req, res) => {
  try {
    const { courseId, assignmentId } = req.params;
    const comment = req.body.comment || '';
    const files = req.files || [];
    let retainFileIds = [];
    if (req.body.retainFileIds) {
      try {
        retainFileIds = typeof req.body.retainFileIds === 'string' ? JSON.parse(req.body.retainFileIds) : req.body.retainFileIds;
      } catch (e) {
        retainFileIds = [];
      }
    }

    if ((!files || files.length === 0) && (!retainFileIds || retainFileIds.length === 0)) {
      return res.status(400).json({ success: false, error: '提出するファイルが選択されていません。' });
    }

    const result = await canvasService.uploadAndSubmit(courseId, assignmentId, files, comment, retainFileIds);
    res.json({ success: true, result });
  } catch (err) {
    console.error('Submit files error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. テキストまたはURLによる提出
app.post('/api/courses/:courseId/assignments/:assignmentId/submit-text', async (req, res) => {
  try {
    const { courseId, assignmentId } = req.params;
    const { submissionType, body, url, commentText } = req.body;
    const result = await canvasService.submitTextOrUrl(courseId, assignmentId, {
      submissionType,
      body,
      url,
      commentText
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PDFキャッシュディレクトリ（ディスクキャッシュで2回目以降の表示遅延をゼロに）
const PDF_CACHE_DIR = path.join(os.tmpdir(), 'canvas_horizon_pdf_cache');
try { fs.mkdirSync(PDF_CACHE_DIR, { recursive: true }); } catch (e) {}

// ファイルが有効なPDF（%PDFマジックバイトを含む）か検証し、破損キャッシュは自動排除
function isValidPdfFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stats = fs.statSync(filePath);
    if (stats.size < 4) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return false;
    }
    const fd = fs.openSync(filePath, 'r');
    let isValid = false;
    try {
      const buf = Buffer.alloc(32);
      const bytesRead = fs.readSync(fd, buf, 0, 32, 0);
      if (bytesRead >= 4) {
        const head = buf.subarray(0, bytesRead).toString('latin1');
        isValid = head.includes('%PDF');
      }
    } finally {
      fs.closeSync(fd);
    }
    if (!isValid) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    return isValid;
  } catch (_) {
    return false;
  }
}

// MIMEタイプと拡張子の相互変換マップ
const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.docs': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docm': 'application/vnd.ms-word.document.macroEnabled.12',
  '.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  '.dotm': 'application/vnd.ms-word.template.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  '.xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  '.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  '.potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
  '.vsdx': 'application/vnd.ms-visio.drawing',
  '.vsd': 'application/vnd.visio',
  '.one': 'application/onenote',
  '.pub': 'application/x-mspublisher',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.odg': 'application/vnd.oasis.opendocument.graphics',
  '.odf': 'application/vnd.oasis.opendocument.formula',
  '.pages': 'application/vnd.apple.pages',
  '.numbers': 'application/vnd.apple.numbers',
  '.key': 'application/vnd.apple.keynote',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.zst': 'application/zstd',
  '.iso': 'application/x-iso9660-image',
  '.jar': 'application/java-archive',
  '.whl': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.rst': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/json; charset=utf-8',
  '.ipynb': 'application/x-ipynb+json',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.kt': 'text/plain; charset=utf-8',
  '.kts': 'text/plain; charset=utf-8',
  '.scala': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
  '.dart': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.cc': 'text/plain; charset=utf-8',
  '.cxx': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8',
  '.pl': 'text/plain; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.jl': 'text/plain; charset=utf-8',
  '.hs': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bash': 'text/plain; charset=utf-8',
  '.zsh': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.r': 'text/plain; charset=utf-8',
  '.rmd': 'text/plain; charset=utf-8',
  '.m': 'text/plain; charset=utf-8',
  '.mlx': 'application/octet-stream',
  '.mat': 'application/x-matlab-data',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.sty': 'text/plain; charset=utf-8',
  '.cls': 'text/plain; charset=utf-8',
  '.v': 'text/plain; charset=utf-8',
  '.sv': 'text/plain; charset=utf-8',
  '.vhd': 'text/plain; charset=utf-8',
  '.vhdl': 'text/plain; charset=utf-8',
  '.ino': 'text/plain; charset=utf-8',
  '.asm': 'text/plain; charset=utf-8',
  '.dwg': 'image/vnd.dwg',
  '.dxf': 'image/vnd.dxf',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.fbx': 'application/octet-stream',
  '.step': 'model/step',
  '.stp': 'model/step',
  '.iges': 'model/iges',
  '.igs': 'model/iges',
  '.blend': 'application/x-blender',
  '.psd': 'image/vnd.adobe.photoshop',
  '.ai': 'application/postscript',
  '.eps': 'application/postscript',
  '.sqlite': 'application/vnd.sqlite3',
  '.sqlite3': 'application/vnd.sqlite3',
  '.db': 'application/octet-stream',
  '.parquet': 'application/vnd.apache.parquet',
  '.h5': 'application/x-hdf5',
  '.hdf5': 'application/x-hdf5',
  '.sav': 'application/x-spss-sav',
  '.rdata': 'application/octet-stream',
  '.rds': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8'
};

const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.ms-word.document.macroenabled.12': '.docm',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template': '.dotx',
  'application/vnd.ms-word.template.macroenabled.12': '.dotm',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': '.xlsb',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template': '.xltx',
  'application/vnd.ms-excel.template.macroenabled.12': '.xltm',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': '.pptm',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': '.ppsx',
  'application/vnd.openxmlformats-officedocument.presentationml.template': '.potx',
  'application/vnd.ms-visio.drawing': '.vsdx',
  'application/vnd.visio': '.vsd',
  'application/onenote': '.one',
  'application/x-mspublisher': '.pub',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'application/vnd.oasis.opendocument.graphics': '.odg',
  'application/vnd.oasis.opendocument.formula': '.odf',
  'application/vnd.apple.pages': '.pages',
  'application/vnd.apple.numbers': '.numbers',
  'application/vnd.apple.keynote': '.key',
  'application/rtf': '.rtf',
  'text/rtf': '.rtf',
  'application/epub+zip': '.epub',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/x-7z-compressed': '.7z',
  'application/vnd.rar': '.rar',
  'application/x-rar-compressed': '.rar',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
  'application/x-gzip': '.gz',
  'application/x-bzip2': '.bz2',
  'application/x-xz': '.xz',
  'application/zstd': '.zst',
  'application/java-archive': '.jar',
  'application/x-ipynb+json': '.ipynb',
  'application/x-matlab-data': '.mat',
  'application/vnd.sqlite3': '.sqlite',
  'application/x-sqlite3': '.sqlite',
  'application/x-hdf5': '.h5',
  'image/vnd.dwg': '.dwg',
  'application/acad': '.dwg',
  'image/vnd.dxf': '.dxf',
  'model/stl': '.stl',
  'application/sla': '.stl',
  'model/obj': '.obj',
  'model/step': '.step',
  'model/iges': '.iges',
  'image/vnd.adobe.photoshop': '.psd',
  'application/postscript': '.eps',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/x-python': '.py',
  'text/x-java-source': '.java',
  'text/x-c': '.c',
  'text/x-c++': '.cpp',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'application/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/x-ms-wmv': '.wmv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac'
};

// 誤って末尾に付与された .pdf 二重拡張子（例: .docx.pdf, .pptx.pdf, .xlsx.pdf, .zip.pdf, .dwg.pdf, .docs.pdf 等）を除去
function stripAccidentalPdfSuffix(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  let cleaned = fileName.trim();
  for (let i = 0; i < 3; i++) {
    if (!/\.pdf$/i.test(cleaned)) break;
    const withoutPdf = cleaned.slice(0, -4);
    const prevExt = path.extname(withoutPdf).toLowerCase();
    if (!prevExt) break;
    // 既知の拡張子、または英字を含む1〜8文字の拡張子（v1.2.pdf のようなバージョン番号は除外）の場合に末尾の .pdf を除去
    const isKnownExt = Boolean(EXT_TO_MIME[prevExt]);
    const isLikelyRealExt = /^\.[a-z0-9]{1,8}$/i.test(prevExt) && /[a-z]/i.test(prevExt) && !/^\.v\d+$/i.test(prevExt);
    if (isKnownExt || isLikelyRealExt) {
      cleaned = withoutPdf;
    } else {
      break;
    }
  }
  return cleaned;
}

// Content-Disposition ヘッダーから元ファイル名を抽出
function extractFilenameFromContentDisposition(disposition) {
  if (!disposition || typeof disposition !== 'string') return null;
  const starMatch = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;\r\n]+)/i);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1].trim().replace(/^["']|["']$/g, ''));
    } catch (_) {}
  }
  const stdMatch = disposition.match(/filename\s*=\s*"([^"]+)"/i) || disposition.match(/filename\s*=\s*([^;\s\r\n]+)/i);
  if (stdMatch && stdMatch[1]) {
    const raw = stdMatch[1].trim().replace(/^["']|["']$/g, '');
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  }
  return null;
}

// ファイル名と拡張子を精密に正規化（.docx.pdf / .pptx.pdf / .xlsx.pdf 等の二重拡張子を防止し、本来の拡張子を補完）
function normalizeDownloadFileName(rawName, fileData = null, contentDisposition = null, responseContentType = null) {
  let name = rawName ? String(rawName).replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (name) {
    name = stripAccidentalPdfSuffix(name);
  }

  const cdInput = (contentDisposition && String(contentDisposition).includes('filename'))
    ? contentDisposition
    : ((responseContentType && String(responseContentType).includes('filename')) ? responseContentType : contentDisposition);
  const mimeInput = (responseContentType && !String(responseContentType).includes('filename'))
    ? responseContentType
    : ((contentDisposition && !String(contentDisposition).includes('filename')) ? contentDisposition : '');

  const cdName = extractFilenameFromContentDisposition(cdInput);
  const apiName = fileData ? (fileData.display_name || fileData.displayName || fileData.filename || null) : null;
  const canonicalName = stripAccidentalPdfSuffix((apiName || cdName || '').trim());

  const isGenericName = !name || /^(file\.pdf|document\.pdf|download|file|添付ファイル)$/i.test(name);
  if (isGenericName && canonicalName) {
    name = canonicalName;
  }

  if (!name) {
    name = 'download';
  }

  // 現在のファイル名に既知の拡張子が含まれているか確認
  const currentExt = path.extname(name).toLowerCase();
  const hasKnownExt = Boolean(currentExt && (EXT_TO_MIME[currentExt] || (/^\.[a-z0-9]{1,8}$/i.test(currentExt) && /[a-z]/i.test(currentExt))));

  const rawMime = (fileData && (fileData['content-type'] || fileData.content_type || fileData.contentType)) || mimeInput || '';
  const cleanMime = String(rawMime).split(';')[0].trim().toLowerCase();
  const mimeExt = (cleanMime && MIME_TO_EXT[cleanMime]) ? MIME_TO_EXT[cleanMime] : '';
  const canonicalExt = canonicalName ? path.extname(canonicalName).toLowerCase() : '';
  const preferredNonPdfExt = (canonicalExt && canonicalExt !== '.pdf') ? canonicalExt : ((mimeExt && mimeExt !== '.pdf') ? mimeExt : '');

  // もし rawName に誤って .pdf が付与されており、元ファイル名またはMIMEタイプが非PDF拡張子を示す場合は修正
  if (currentExt === '.pdf' && preferredNonPdfExt) {
    const stem = name.slice(0, -4);
    name = stem.toLowerCase().endsWith(preferredNonPdfExt) ? stem : (stem + preferredNonPdfExt);
  } else if (!hasKnownExt) {
    if (canonicalExt) {
      name += canonicalExt;
    } else if (mimeExt) {
      name += mimeExt;
    }
  }

  // 再帰的に二重拡張子が残っていないか最終確認
  name = stripAccidentalPdfSuffix(name);

  // OSファイルシステムで禁止されている文字を置換しつつ拡張子を保持して長さ制限
  const finalExt = path.extname(name);
  const finalBase = path.basename(name, finalExt).replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
  const safeExt = finalExt.replace(/[\\/:*?"<>|]/g, '');
  return `${finalBase.slice(0, 140)}${safeExt}`;
}

function resolveContentType(fileName, responseContentType = '', isPdfRequest = false, isVideoRequest = false) {
  const ext = fileName ? path.extname(fileName).toLowerCase() : '';
  if (ext && EXT_TO_MIME[ext]) {
    return EXT_TO_MIME[ext];
  }
  const cleanRespMime = String(responseContentType || '').split(';')[0].trim().toLowerCase();
  if (isVideoRequest || cleanRespMime.startsWith('video/') || cleanRespMime === 'application/mp4') {
    if (ext === '.webm') return 'video/webm';
    return 'video/mp4';
  }
  if (isPdfRequest) {
    return 'application/pdf';
  }
  if (cleanRespMime && cleanRespMime !== 'application/octet-stream' && cleanRespMime !== 'binary/octet-stream') {
    return responseContentType;
  }
  return 'application/octet-stream';
}

// Canvas のファイルURLから wrap=1 を除去し download_frd=1 と verifier を正規化
function normalizeCanvasFileUrl(rawUrl, cfg, verifierParam = null) {
  if (!rawUrl) return null;
  let targetUrl = String(rawUrl).trim();
  if (targetUrl.startsWith('/') && cfg?.baseUrl) {
    try {
      targetUrl = new URL(targetUrl, cfg.baseUrl).toString();
    } catch (_) {}
  }
  try {
    const parsed = new URL(targetUrl);
    if (verifierParam && !parsed.searchParams.has('verifier')) {
      parsed.searchParams.set('verifier', verifierParam);
    }
    if (parsed.searchParams.has('wrap')) {
      parsed.searchParams.delete('wrap');
    }
    if (parsed.pathname.includes('/files/') && !parsed.pathname.includes('/api/v1/')) {
      if (!parsed.searchParams.has('download') && !parsed.searchParams.has('download_frd')) {
        parsed.searchParams.set('download_frd', '1');
      }
    }
    targetUrl = parsed.toString();
  } catch (_) {}
  return targetUrl;
}

// 古いPDFキャッシュおよび破損キャッシュの自動クリーンアップ（ディスク容量とメモリの肥大化防止）
function cleanOldPdfCaches() {
  try {
    if (!fs.existsSync(PDF_CACHE_DIR)) return;
    const files = fs.readdirSync(PDF_CACHE_DIR);
    const now = Date.now();
    const maxAge = 48 * 60 * 60 * 1000; // 48時間
    let totalSize = 0;
    const fileStats = [];

    for (const f of files) {
      const fullPath = path.join(PDF_CACHE_DIR, f);
      try {
        if (f.endsWith('.pdf') && !isValidPdfFile(fullPath)) {
          fs.unlinkSync(fullPath);
          continue;
        }
        const stat = fs.statSync(fullPath);
        totalSize += stat.size;
        fileStats.push({ path: fullPath, size: stat.size, mtime: stat.mtimeMs });
      } catch (_) {}
    }

    // 48時間経過したファイル、または合計300MBを超過した場合は古い順に削除
    fileStats.sort((a, b) => a.mtime - b.mtime);
    for (const item of fileStats) {
      if ((now - item.mtime > maxAge) || totalSize > 300 * 1024 * 1024) {
        try {
          fs.unlinkSync(item.path);
          totalSize -= item.size;
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('PDF cache cleanup warning:', err.message);
  }
}
// 起動時ブロッキングを避けるため非同期スケジュールで初回クリーンアップを実行
setTimeout(cleanOldPdfCaches, 1500).unref?.();
const pdfCleanTimer = setInterval(cleanOldPdfCaches, 6 * 60 * 60 * 1000);
if (pdfCleanTimer.unref) pdfCleanTimer.unref();

const pendingPdfDownloads = new Map();

/**
 * PDFファイルをローカルディスクキャッシュ (%TEMP%/canvas_horizon_pdf_cache/{fileId}.pdf) に保存・確保
 * 複数リクエスト・Range要求が同時に来ても一度だけ完全ダウンロードを行い競合を防止
 */
async function ensurePdfCached(fileId, targetUrl, courseId, fallbackName) {
  const cachedFilePath = path.join(PDF_CACHE_DIR, `${fileId}.pdf`);
  if (fs.existsSync(cachedFilePath)) {
    if (isValidPdfFile(cachedFilePath)) {
      return cachedFilePath;
    }
    try { fs.unlinkSync(cachedFilePath); } catch (_) {}
  }

  if (pendingPdfDownloads.has(fileId)) {
    return pendingPdfDownloads.get(fileId);
  }

  const downloadPromise = (async () => {
    const tempPath = path.join(PDF_CACHE_DIR, `${fileId}.tmp.${Date.now()}`);
    try {
      const cfg = loadConfig();
      let dlUrl = targetUrl;
      if (!dlUrl) {
        const fileInfo = await canvasService.resolveFileDownload(fileId, courseId);
        if (fileInfo?.url) dlUrl = fileInfo.url;
      }
      if (!dlUrl) throw new Error(`Cannot resolve download URL for fileId ${fileId}`);

      dlUrl = normalizeCanvasFileUrl(dlUrl, cfg);

      const canvasHost = getCanvasHost(cfg);
      let urlHost = '';
      try { urlHost = new URL(dlUrl).host; } catch (_) {}
      const fetchHeaders = {};
      if (urlHost && urlHost === canvasHost) {
        fetchHeaders['Authorization'] = `Bearer ${cfg.apiToken}`;
      }

      let resp = await fetch(dlUrl, {
        headers: fetchHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(60000)
      });

      if (!resp.ok && urlHost === canvasHost) {
        try {
          const retry = new URL(dlUrl);
          retry.searchParams.set('access_token', cfg.apiToken);
          resp = await fetch(retry.toString(), {
            headers: fetchHeaders,
            redirect: 'follow',
            signal: AbortSignal.timeout(60000)
          });
        } catch (_) {}
      }

      if (!resp.ok) {
        throw new Error(`Failed to download PDF: ${resp.status} ${resp.statusText}`);
      }

      const fileStream = fs.createWriteStream(tempPath);
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const canWrite = fileStream.write(Buffer.from(value));
        if (!canWrite) {
          await new Promise((resolve) => fileStream.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });

      if (!isValidPdfFile(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        throw new Error('Downloaded file is not a valid PDF document');
      }

      if (fs.existsSync(cachedFilePath)) {
        try { fs.unlinkSync(cachedFilePath); } catch (_) {}
      }
      fs.renameSync(tempPath, cachedFilePath);
      return cachedFilePath;
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
      throw err;
    } finally {
      pendingPdfDownloads.delete(fileId);
    }
  })();

  pendingPdfDownloads.set(fileId, downloadPromise);
  return downloadPromise;
}

// 9.9 ファイルメタデータ解決エンドポイント（拡張子不明のCanvasファイルリンクの事前判定用）
app.get('/api/files/meta', async (req, res) => {
  try {
    const { id, url, courseId, name } = req.query;
    let fileId = id ? String(id).trim() : null;
    let targetUrl = url ? String(url).trim() : null;
    let targetCourseId = courseId ? String(courseId).trim() : null;

    if (!fileId && targetUrl) {
      const fMatch = targetUrl.match(/\/files\/(\d+)/);
      if (fMatch) fileId = fMatch[1];
      const cMatch = targetUrl.match(/\/courses\/(\d+)/);
      if (cMatch && !targetCourseId) targetCourseId = cMatch[1];
    }

    let fileData = null;
    if (fileId) {
      try {
        fileData = await canvasService.resolveFileDownload(fileId, targetCourseId);
      } catch (_) {}
    }

    const displayName = normalizeDownloadFileName(name, fileData);
    const contentType = resolveContentType(
      displayName,
      (fileData && (fileData['content-type'] || fileData.content_type)) || '',
      displayName.toLowerCase().endsWith('.pdf'),
      false
    );

    const filePayload = {
      id: fileId,
      displayName,
      filename: (fileData && (fileData.filename || fileData.display_name)) || displayName,
      contentType,
      size: fileData?.size || 0,
      url: fileData?.url || targetUrl || null,
      isLocked: Boolean(fileData?.locked_for_user || fileData?.hidden_for_user),
      lockExplanation: fileData?.lock_explanation || fileData?.lock_info?.lock_explanation || null,
      unlockAt: fileData?.unlock_at || fileData?.lock_info?.unlock_at || null
    };

    return res.json({
      success: true,
      ...filePayload,
      file: filePayload
    });
  } catch (err) {
    return res.json({
      success: false,
      error: err.message
    });
  }
});

// 10. ファイルダウンロードプロキシ（PDF/画像/テキスト/メディアのインライン表示 & 直接ストリーミング）
app.get('/api/files/download', async (req, res) => {
  try {
    const { url, id, name, inline, courseId } = req.query;
    let targetUrl = url ? String(url).trim() : null;
    let fileId = id ? String(id).trim() : null;
    let targetCourseId = courseId ? String(courseId).trim() : null;
    let fileName = name ? String(name).trim() : null;
    const dispositionType = inline === 'true' ? 'inline' : 'attachment';

    // 0. fileId および courseId の抽出（未指定の場合、URL文字列から自動抽出）
    let verifierParam = req.query.verifier ? String(req.query.verifier).trim() : null;

    if (targetUrl) {
      if (!fileId) {
        const fMatch = targetUrl.match(/\/files\/(\d+)/);
        if (fMatch) fileId = fMatch[1];
      }
      if (!targetCourseId) {
        const cMatch = targetUrl.match(/\/courses\/(\d+)/);
        if (cMatch) targetCourseId = cMatch[1];
      }
      if (!verifierParam) {
        const vMatch = targetUrl.match(/[?&]verifier=([a-zA-Z0-9\-_]+)/);
        if (vMatch) verifierParam = vMatch[1];
      }
    }

    if (fileName) {
      fileName = normalizeDownloadFileName(fileName);
    }

    // 1. 有効なPDFキャッシュが存在する場合はローカルファイルを即座に返却（高速化・Range 206 要求にも完全対応）
    if (fileId) {
      const cachedFilePath = path.join(PDF_CACHE_DIR, `${fileId}.pdf`);
      if (fs.existsSync(cachedFilePath)) {
        if (isValidPdfFile(cachedFilePath)) {
          try {
            const pdfName = (fileName && fileName.toLowerCase().endsWith('.pdf')) ? fileName : `${fileId}.pdf`;
            const encName = encodeURIComponent(pdfName);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encName}`);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.sendFile(cachedFilePath, { acceptRanges: true });
          } catch (cacheErr) {}
        } else {
          try { fs.unlinkSync(cachedFilePath); } catch (_) {}
        }
      }
    }

    const cfg = loadConfig();

    // 2. fileId がある場合は Canvas Files API から署名付きダウンロードURLと正確なファイル名を最優先で解決
    let fileData = null;
    if (fileId) {
      try {
        fileData = await canvasService.resolveFileDownload(fileId, targetCourseId);
        if (fileData?.url) {
          targetUrl = fileData.url;
        }
        fileName = normalizeDownloadFileName(fileName, fileData);
      } catch (resolveErr) {
        console.warn(`Could not resolve fileId ${fileId} via Canvas API, falling back to direct URL:`, resolveErr.message);
      }
    }

    // 3〜5. 相対パス補完・verifier付与・wrap=1除去・download_frd=1付与
    if (targetUrl) {
      targetUrl = normalizeCanvasFileUrl(targetUrl, cfg, verifierParam);
    } else if (fileId && verifierParam && cfg.baseUrl) {
      const base = cfg.baseUrl.replace(/\/+$/, '');
      targetUrl = `${base}/files/${fileId}/download?download_frd=1&verifier=${encodeURIComponent(verifierParam)}`;
    }

    // ロックされているファイルでURLが存在しない場合は分かりやすい案内HTMLを返却（500エラー回避）
    if (!targetUrl && fileData && (fileData.locked_for_user || fileData.hidden_for_user)) {
      const lockMsg = fileData.lock_explanation || fileData.lock_info?.lock_explanation || 'このファイルは現在Canvas上でロックされています。';
      if (inline === 'true') {
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111420;color:#e2e8f0;font-family:sans-serif;padding:24px;box-sizing:border-box}.card{max-width:460px;background:#1a1f32;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,0.4)}.lock-icon{width:44px;height:44px;margin:0 auto;border-radius:12px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);color:#fbbf24;display:flex;align-items:center;justify-content:center}h3{margin:14px 0 8px;font-size:16px}p{margin:0;font-size:13.5px;color:#94a3b8;line-height:1.6}</style></head><body><div class="card"><div class="lock-icon"><svg width="22" height="22" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg></div><h3>ファイルはロックされています</h3><p>${lockMsg.replace(/</g, '&lt;')}</p></div></body></html>`);
      }
      return res.status(403).send(lockMsg);
    }

    if (!targetUrl && !fileId) {
      return res.status(400).send('Download URL or File ID required');
    }

    const effectiveName = fileName || 'download';
    const extLower = path.extname(effectiveName).toLowerCase();
    const fileDataMime = String((fileData && (fileData['content-type'] || fileData.content_type)) || '').toLowerCase();

    const isVideoRequest = /\.(mp4|webm|mkv|mov|m4v|avi|ogv)$/i.test(effectiveName) ||
                           Boolean(targetUrl && /\.(mp4|webm|mkv|mov|m4v|avi|ogv)(\?|$)/i.test(targetUrl)) ||
                           fileDataMime.startsWith('video/');

    const isKnownNonPdfExt = Boolean(extLower && extLower !== '.pdf');
    const isKnownNonPdfMime = Boolean(fileDataMime && !fileDataMime.includes('pdf') && !fileDataMime.includes('octet-stream'));

    const isPdfRequest = !isKnownNonPdfExt && !isKnownNonPdfMime && (
      extLower === '.pdf' ||
      Boolean(targetUrl && /\.pdf(\?|$)/i.test(targetUrl)) ||
      fileDataMime === 'application/pdf'
    );

    // 6. PDF かつ fileId がある場合、フルキャッシュを先行取得して Range 206 を完全サポート
    if (fileId && isPdfRequest) {
      try {
        const cachedPath = await ensurePdfCached(fileId, targetUrl, targetCourseId, effectiveName);
        if (fs.existsSync(cachedPath)) {
          const pdfFileName = effectiveName.toLowerCase().endsWith('.pdf')
            ? effectiveName
            : (extLower ? effectiveName : `${effectiveName}.pdf`);
          const encodedPdfName = encodeURIComponent(pdfFileName);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodedPdfName}`);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.sendFile(cachedPath, { acceptRanges: true });
        }
      } catch (cacheErr) {
        console.warn(`PDF caching failed, falling back to direct stream for ${fileId}:`, cacheErr.message);
      }
    }

    if (!targetUrl) {
      if (inline === 'true') {
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111420;color:#e2e8f0;font-family:sans-serif;padding:24px;box-sizing:border-box}.card{max-width:460px;background:#1a1f32;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px;text-align:center}h3{margin:12px 0 8px;font-size:16px}p{margin:0;font-size:13.5px;color:#94a3b8;line-height:1.6}</style></head><body><div class="card"><h3>ファイルを読み込めませんでした</h3><p>Canvas上でアクセス制限されているか、URLが解決できませんでした。</p></div></body></html>`);
      }
      return res.status(400).send('Download URL or File ID required');
    }

    const canvasHost = getCanvasHost(cfg);
    let urlHost = '';
    try { urlHost = new URL(targetUrl).host; } catch (e) {}

    const fetchHeaders = {};
    if (urlHost && urlHost === canvasHost) {
      fetchHeaders['Authorization'] = `Bearer ${cfg.apiToken}`;
    }

    // Rangeリクエストの透過転送（動画ストリーミング・シーク操作等に必須）
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    let fileRes = await fetch(targetUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(60000)
    });

    if (!fileRes.ok && urlHost === canvasHost) {
      try {
        const retryUrl = new URL(targetUrl);
        retryUrl.searchParams.set('access_token', cfg.apiToken);
        fileRes = await fetch(retryUrl.toString(), {
          headers: fetchHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(60000)
        });
      } catch (retryErr) {}
    }

    if (!fileRes.ok) {
      return res.status(fileRes.status).send(`Failed to fetch file: ${fileRes.statusText}`);
    }

    const respDisposition = fileRes.headers.get('content-disposition');
    const respContentType = fileRes.headers.get('content-type') || 'application/octet-stream';
    const finalFileName = normalizeDownloadFileName(fileName, fileData, respDisposition, respContentType);
    const encodedName = encodeURIComponent(finalFileName);
    const actualIsPdf = finalFileName.toLowerCase().endsWith('.pdf') || respContentType.includes('application/pdf');
    const contentType = resolveContentType(finalFileName, respContentType, actualIsPdf, isVideoRequest);

    const contentLength = fileRes.headers.get('content-length');
    const contentRange = fileRes.headers.get('content-range');
    const acceptRanges = fileRes.headers.get('accept-ranges') || 'bytes';

    res.status(fileRes.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodedName}`);
    res.setHeader('Accept-Ranges', acceptRanges);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    // キャッシュ保存用ストリーム（真にPDFかつ全体リクエスト時のみ安全に書き込み）
    const cachedFilePath = (fileId && actualIsPdf) ? path.join(PDF_CACHE_DIR, `${fileId}.pdf`) : null;
    const cacheWriteStream = (cachedFilePath && !req.headers.range && fileRes.status === 200) ? fs.createWriteStream(cachedFilePath) : null;

    // ストリーミング転送（バックプレッシャー対応）
    const reader = fileRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (cacheWriteStream) cacheWriteStream.end();
        res.end();
        break;
      }
      const buf = Buffer.from(value);
      if (cacheWriteStream) cacheWriteStream.write(buf);
      const ok = res.write(buf);
      if (!ok) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    console.error('File download proxy error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error downloading file: ' + err.message);
    }
  }
});

// 10.05 PDF キャッシュ確保・ネイティブパス解決エンドポイント
app.get('/api/files/ensure-cache', async (req, res) => {
  try {
    const { id, url, name, courseId } = req.query;
    let fileId = id ? String(id).trim() : null;
    let targetUrl = url ? String(url).trim() : null;
    let targetCourseId = courseId ? String(courseId).trim() : null;
    let fileName = name ? String(name).trim() : 'document.pdf';

    if (!fileId && targetUrl) {
      const fMatch = targetUrl.match(/\/files\/(\d+)/);
      if (fMatch) fileId = fMatch[1];
    }

    if (!fileId) {
      return res.status(400).json({ success: false, error: 'File ID required' });
    }

    const cachedFilePath = await ensurePdfCached(fileId, targetUrl, targetCourseId, fileName);
    if (fs.existsSync(cachedFilePath)) {
      return res.json({ success: true, cached: true, path: cachedFilePath });
    }
    return res.status(500).json({ success: false, error: 'Failed to cache PDF' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// 10.1 メディアオブジェクト（動画/音声）URL解決エンドポイント
app.get('/api/media/resolve', async (req, res) => {
  try {
    const { entryId, attachmentId, courseId } = req.query;
    const cfg = loadConfig();

    if (attachmentId) {
      try {
        const fileData = await canvasService.resolveFileDownload(attachmentId, courseId);
        if (fileData) {
          return res.json({
            success: true,
            title: fileData.display_name || fileData.filename || '講義動画',
            url: fileData.url,
            streamUrl: `/api/files/download?id=${attachmentId}&courseId=${courseId || ''}&inline=true&name=${encodeURIComponent(fileData.display_name || 'video.mp4')}`,
            size: fileData.size,
            contentType: fileData['content-type'] || 'video/mp4'
          });
        }
      } catch (fErr) {
        console.warn('resolveFileDownload for media failed:', fErr.message);
      }
    }

    if (entryId && courseId) {
      try {
        const mediaDownloadUrl = `${cfg.baseUrl.replace(/\/$/, '')}/courses/${courseId}/media_download?entryId=${encodeURIComponent(entryId)}&type=mp4`;
        const r = await fetch(mediaDownloadUrl, {
          headers: { 'Authorization': `Bearer ${cfg.apiToken}` },
          signal: AbortSignal.timeout(10000)
        });
        if (r.ok) {
          const data = await r.json();
          if (data && data.url) {
            return res.json({
              success: true,
              url: data.url,
              streamUrl: data.url
            });
          }
        }
      } catch (mErr) {
        console.warn('media_download endpoint failed:', mErr.message);
      }
    }

    res.status(404).json({ success: false, error: 'Media not found' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10.5 単体ファイルの直接保存（Downloads ディレクトリへ適切な拡張子で保存）
app.post('/api/files/download-single', async (req, res) => {
  try {
    const { id, url, name, courseId, verifier } = req.body;
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const rawName = name || 'download';
    let safeFileName = normalizeDownloadFileName(rawName);

    let fileId = id ? String(id).trim() : null;
    let targetCourseId = courseId ? String(courseId).trim() : null;
    let targetVerifier = verifier ? String(verifier).trim() : null;

    if (url) {
      const urlStr = String(url);
      if (!fileId) {
        const fMatch = urlStr.match(/\/files\/(\d+)/) || urlStr.match(/[?&]id=(\d+)/);
        if (fMatch) fileId = fMatch[1];
      }
      if (!targetCourseId) {
        const cMatch = urlStr.match(/\/courses\/(\d+)/) || urlStr.match(/[?&]courseId=(\d+)/);
        if (cMatch) targetCourseId = cMatch[1];
      }
      if (!targetVerifier) {
        const vMatch = urlStr.match(/[?&]verifier=([a-zA-Z0-9\-_]+)/);
        if (vMatch) targetVerifier = vMatch[1];
      }
    }

    const job = {
      id: `single-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'single-file',
      title: safeFileName,
      status: 'downloading',
      progress: 0,
      saveDir: downloadsDir,
      fileName: safeFileName,
      fullPath: path.join(downloadsDir, safeFileName),
      message: 'ダウンロードを開始中...',
      createdAt: Date.now(),
      error: null
    };

    registerDownloadJob(job);

    (async () => {
      const cfg = loadConfig();
      const canvasHost = getCanvasHost(cfg);
      const hostHeader = req.get('host') || (`127.0.0.1:${currentPort || PORT}`);
      const localOrigin = `${req.protocol || 'http'}://${hostHeader}`;
      let downloadUrl = url || null;
      let resolvedFileData = null;

      // 1. fileId がある場合は Canvas Files API から署名付きダウンロードURLと本来のファイル名・拡張子を最優先で解決
      if (fileId) {
        try {
          resolvedFileData = await canvasService.resolveFileDownload(fileId, targetCourseId);
          if (resolvedFileData?.url) {
            downloadUrl = resolvedFileData.url;
          }
          safeFileName = normalizeDownloadFileName(rawName, resolvedFileData);
          job.title = safeFileName;
          job.fileName = safeFileName;
        } catch (e) {}

        // プレビュー等で既にローカルPDFキャッシュに完全なファイルが存在する場合はネットワーク通信ゼロで即時コピー保存
        const cachedPdfPath = path.join(PDF_CACHE_DIR, `${fileId}.pdf`);
        if (
          (safeFileName.toLowerCase().endsWith('.pdf') || !path.extname(safeFileName)) &&
          isValidPdfFile(cachedPdfPath)
        ) {
          if (!safeFileName.toLowerCase().endsWith('.pdf')) safeFileName += '.pdf';
          let finalPath = path.join(downloadsDir, safeFileName);
          let counter = 1;
          const ext = path.extname(safeFileName);
          const base = path.basename(safeFileName, ext);
          while (fs.existsSync(finalPath)) {
            finalPath = path.join(downloadsDir, `${base} (${counter})${ext}`);
            counter++;
          }
          await fs.promises.copyFile(cachedPdfPath, finalPath);
          job.status = 'completed';
          job.progress = 100;
          job.fileName = path.basename(finalPath);
          job.fullPath = finalPath;
          job.saveDir = downloadsDir;
          job.message = `保存完了: ${path.basename(finalPath)}`;
          return;
        }
      }

      // 2. 相対URL（自前プロキシ /api/files/download など）を完全なURLに変換
      if (downloadUrl && downloadUrl.startsWith('/')) {
        try {
          const parsedLocal = new URL(downloadUrl, localOrigin);
          if (parsedLocal.searchParams.get('inline') === 'true') {
            parsedLocal.searchParams.delete('inline');
          }
          downloadUrl = parsedLocal.toString();
        } catch (e) {
          downloadUrl = `${localOrigin}${downloadUrl}`;
        }
      }

      // 3. Canvas API エンドポイントURLの場合、JSONから実体URLを取得
      if (downloadUrl && downloadUrl.includes('/api/v1/')) {
        try {
          const fData = await canvasService.fetchJson(downloadUrl);
          if (fData) {
            resolvedFileData = resolvedFileData || fData;
            if (fData.url) downloadUrl = fData.url;
            safeFileName = normalizeDownloadFileName(rawName, resolvedFileData);
            job.title = safeFileName;
            job.fileName = safeFileName;
          }
        } catch (e) {}
      }

      // 4. Canvas Web画面 URL (/courses/.../files/...?wrap=1) の正規化（wrap=1除去・download_frd=1・verifier付与）
      if (downloadUrl && !downloadUrl.startsWith(localOrigin)) {
        downloadUrl = normalizeCanvasFileUrl(downloadUrl, cfg, targetVerifier);
      }

      if (!downloadUrl && fileId && cfg.baseUrl) {
        const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
        const vQuery = targetVerifier ? `&verifier=${encodeURIComponent(targetVerifier)}` : '';
        downloadUrl = `${baseUrl}/files/${fileId}/download?download_frd=1${vQuery}`;
      }

      if (!downloadUrl) throw new Error('ダウンロードURLを取得できませんでした');

      let urlHost = '';
      try { urlHost = new URL(downloadUrl).host; } catch (e) {}

      const headers = {};
      if (urlHost && urlHost === canvasHost) {
        headers['Authorization'] = `Bearer ${cfg.apiToken}`;
      }

      job.message = 'ダウンロード中...';
      job.progress = 15;

      let fileRes = await fetch(downloadUrl, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(60000)
      });

      if (!fileRes.ok && urlHost === canvasHost) {
        const retryUrl = new URL(downloadUrl);
        retryUrl.searchParams.set('access_token', cfg.apiToken);
        fileRes = await fetch(retryUrl.toString(), {
          redirect: 'follow',
          signal: AbortSignal.timeout(60000)
        });
      }

      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

      // レスポンスヘッダー (Content-Disposition / Content-Type) から最終ファイル名と拡張子を確定
      const respDisposition = fileRes.headers.get('content-disposition');
      const respContentType = fileRes.headers.get('content-type') || '';
      safeFileName = normalizeDownloadFileName(rawName, resolvedFileData, respDisposition, respContentType);
      job.title = safeFileName;

      // HTMLログイン画面の誤保存を防止
      if (respContentType.includes('text/html') && !/\.html?$/i.test(safeFileName)) {
        throw new Error('Canvasの認証またはファイルアクセス権限がありません');
      }

      let finalPath = path.join(downloadsDir, safeFileName);
      let counter = 1;
      const ext = path.extname(safeFileName);
      const base = path.basename(safeFileName, ext);
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(downloadsDir, `${base} (${counter})${ext}`);
        counter++;
      }

      const totalSize = parseInt(fileRes.headers.get('content-length') || '0', 10);
      let downloadedSize = 0;

      const fileStream = fs.createWriteStream(finalPath);
      const reader = fileRes.body.getReader();

      while (true) {
        if (job.status === 'cancelled') {
          fileStream.close();
          fs.unlink(finalPath, () => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const canWrite = fileStream.write(Buffer.from(value));
        if (!canWrite) {
          await new Promise((resolve) => fileStream.once('drain', resolve));
        }
        downloadedSize += value.length;
        if (totalSize > 0) {
          job.progress = Math.min(99, Math.round((downloadedSize / totalSize) * 100));
          const mbCur = (downloadedSize / (1024 * 1024)).toFixed(1);
          const mbTot = (totalSize / (1024 * 1024)).toFixed(1);
          job.message = `${mbCur}MB / ${mbTot}MB`;
        } else {
          job.progress = 50;
        }
      }
      await new Promise((resolve) => fileStream.end(resolve));

      job.status = 'completed';
      job.progress = 100;
      job.fileName = path.basename(finalPath);
      job.fullPath = finalPath;
      job.saveDir = downloadsDir;
      job.message = `保存完了: ${path.basename(finalPath)}`;
    })().catch(err => {
      console.error('Single download failed:', err);
      job.status = 'failed';
      job.error = err.message;
      job.message = `保存失敗: ${err.message}`;
    });

    return res.status(202).json({ success: true, job: publicDownloadJob(job) });
  } catch (err) {
    console.error('download-single error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 11. 複数ファイルの一括保存（Downloads ディレクトリへ適切な拡張子で保存）
app.post('/api/files/download-batch', async (req, res) => {
  try {
    const { files, title, folderName, targetDir } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'Files array is required' });
    }

    // 常にユーザーのダウンロードフォルダー直下に直接保存
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const saveDir = targetDir && typeof targetDir === 'string' && targetDir.trim()
      ? targetDir.trim()
      : downloadsDir;

    try {
      fs.mkdirSync(saveDir, { recursive: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: '保存先フォルダの確認に失敗しました: ' + err.message });
    }

    const job = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'batch-files',
      title: title || folderName || '講義資料の一括保存',
      status: 'downloading',
      progress: 0,
      totalCount: files.length,
      completedCount: 0,
      currentFileName: '',
      saveDir: saveDir,
      savedFiles: [],
      message: `準備中 (全 ${files.length} 件)`,
      createdAt: Date.now(),
      error: null
    };

    registerDownloadJob(job);

    // バックグラウンドで並列・ストリームダウンロード（最大3並列＋メモリ膨張防止）
    (async () => {
      const cfg = loadConfig();
      const canvasHost = getCanvasHost(cfg);
      const downloadErrors = [];
      const hostHeader = req.get('host') || (`127.0.0.1:${currentPort || PORT}`);
      const localOrigin = `${req.protocol || 'http'}://${hostHeader}`;

      let cursor = 0;
      const workerCount = Math.min(3, files.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < files.length) {
          if (job.status === 'cancelled') break;
          const i = cursor++;
          const item = files[i];
          const rawName = item.name || item.displayName || `file_${i + 1}`;
          let safeFileName = normalizeDownloadFileName(rawName);
          job.currentFileName = safeFileName;
          job.message = `${job.completedCount + 1}/${files.length} 件目を保存中: ${safeFileName}`;

          try {
            let downloadUrl = item.url || null;
            let resolvedFileData = null;

            // item.id がある場合は Canvas Files API から署名付きダウンロードURLと本来のファイル名・拡張子を解決
            if (item.id) {
              try {
                resolvedFileData = await canvasService.resolveFileDownload(item.id, item.courseId);
                if (resolvedFileData?.url) {
                  downloadUrl = resolvedFileData.url;
                }
                safeFileName = normalizeDownloadFileName(rawName, resolvedFileData);
                job.currentFileName = safeFileName;
              } catch (resolveErr) {}

              // 既にプレビューキャッシュ済みのPDFならネットワーク通信なしで即時ローカルコピー
              const cachedPdfPath = path.join(PDF_CACHE_DIR, `${item.id}.pdf`);
              if (
                (safeFileName.toLowerCase().endsWith('.pdf') || !path.extname(safeFileName)) &&
                isValidPdfFile(cachedPdfPath)
              ) {
                if (!safeFileName.toLowerCase().endsWith('.pdf')) safeFileName += '.pdf';
                let finalPath = path.join(saveDir, safeFileName);
                let counter = 1;
                const ext = path.extname(safeFileName);
                const base = path.basename(safeFileName, ext);
                while (fs.existsSync(finalPath)) {
                  finalPath = path.join(saveDir, `${base} (${counter})${ext}`);
                  counter++;
                }
                await fs.promises.copyFile(cachedPdfPath, finalPath);
                job.savedFiles.push(path.basename(finalPath));
                job.completedCount++;
                job.progress = Math.round((job.completedCount / job.totalCount) * 100);
                job.message = `${job.completedCount}/${job.totalCount} 件保存完了`;
                continue;
              }
            }

            if (downloadUrl && downloadUrl.startsWith('/')) {
              try {
                const parsedLocal = new URL(downloadUrl, localOrigin);
                if (parsedLocal.searchParams.get('inline') === 'true') {
                  parsedLocal.searchParams.delete('inline');
                }
                downloadUrl = parsedLocal.toString();
              } catch (e) {
                downloadUrl = `${localOrigin}${downloadUrl}`;
              }
            }

            // item.url が Canvas の内部APIエンドポイントの場合、詳細JSONから直接URLを取り出す
            if (downloadUrl && downloadUrl.includes('/api/v1/')) {
              try {
                const fileData = await canvasService.fetchJson(downloadUrl);
                if (fileData) {
                  resolvedFileData = resolvedFileData || fileData;
                  if (fileData.url) {
                    downloadUrl = fileData.url;
                  }
                  safeFileName = normalizeDownloadFileName(rawName, resolvedFileData);
                }
              } catch (apiErr) {
                console.warn(`Could not resolve API URL for ${safeFileName}:`, apiErr.message);
              }
            }

            if (downloadUrl && !downloadUrl.startsWith(localOrigin)) {
              downloadUrl = normalizeCanvasFileUrl(downloadUrl, cfg);
            }

            // 最後のフォールバック（Canvasの直接ダウンロードURL構造）
            if (!downloadUrl && item.id && cfg.baseUrl) {
              const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
              downloadUrl = `${baseUrl}/files/${item.id}/download?download_frd=1`;
            }

            if (!downloadUrl) throw new Error('ダウンロードURLの取得に失敗しました');

            let urlHost = '';
            try {
              urlHost = new URL(downloadUrl).host;
            } catch (e) {}

            const fetchHeaders = {};
            // Canvas ドメイン宛てのリクエストのみ Bearer トークンを付与（S3等の外部ストレージへの誤送信を防ぐ）
            if (urlHost && urlHost === canvasHost) {
              fetchHeaders['Authorization'] = `Bearer ${cfg.apiToken}`;
            }

            let fileRes = await fetch(downloadUrl, {
              headers: fetchHeaders,
              redirect: 'follow',
              signal: AbortSignal.timeout(30000)
            });

            // Canvasホストで認証切れや失敗した場合、URLパラメータにaccess_tokenを付けて1回再試行
            if (!fileRes.ok && urlHost === canvasHost) {
              try {
                const retryUrl = new URL(downloadUrl);
                retryUrl.searchParams.set('access_token', cfg.apiToken);
                fileRes = await fetch(retryUrl.toString(), {
                  redirect: 'follow',
                  signal: AbortSignal.timeout(30000)
                });
              } catch (retryErr) {}
            }

            if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);

            // HTML（Canvasログイン画面など）が返っていないか検知 & Content-Disposition から正確な拡張子を補完
            const contentType = fileRes.headers.get('content-type') || '';
            const respDisposition = fileRes.headers.get('content-disposition');
            safeFileName = normalizeDownloadFileName(rawName, resolvedFileData, respDisposition, contentType);
            if (contentType.includes('text/html') && !/\.html?$/i.test(safeFileName)) {
              throw new Error('Canvasの認証またはファイルアクセス権限がありません (ログイン画面が返却されました)');
            }

            let finalPath = path.join(saveDir, safeFileName);
            let counter = 1;
            const ext = path.extname(safeFileName);
            const base = path.basename(safeFileName, ext);
            while (fs.existsSync(finalPath)) {
              finalPath = path.join(saveDir, `${base} (${counter})${ext}`);
              counter++;
            }

            if (fileRes.body && typeof Readable.fromWeb === 'function') {
              await pipeline(Readable.fromWeb(fileRes.body), fs.createWriteStream(finalPath));
            } else {
              const buffer = Buffer.from(await fileRes.arrayBuffer());
              await fs.promises.writeFile(finalPath, buffer);
            }
            job.savedFiles.push(path.basename(finalPath));
          } catch (err) {
            console.error(`Error saving ${safeFileName}:`, err.message);
            downloadErrors.push(`${safeFileName}: ${err.message}`);
          }

          job.completedCount++;
          job.progress = Math.round((job.completedCount / job.totalCount) * 100);
          job.message = `${job.completedCount}/${job.totalCount} 件保存完了`;
        }
      });

      await Promise.all(workers);

      if (job.status !== 'cancelled') {
        if (job.savedFiles.length === 0 && files.length > 0) {
          job.status = 'failed';
          job.error = downloadErrors[0] || 'ファイルの取得に失敗しました';
          job.message = `保存に失敗しました: ${job.error}`;
        } else {
          job.status = 'completed';
          job.progress = 100;
          job.currentFileName = '';
          const partialNote = downloadErrors.length > 0 ? ` (一部失敗: ${downloadErrors.length}件)` : '';
          job.message = `保存完了: ${job.savedFiles.length}/${job.totalCount}件${partialNote}`;
        }
      }
    })().catch(err => {
      console.error('Batch download error:', err);
      job.status = 'failed';
      job.error = err.message;
    });

    return res.status(202).json({ success: true, job: publicDownloadJob(job) });
  } catch (err) {
    console.error('download-batch error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// レガシーZIPダウンロード（後方互換性）
app.post('/api/files/download-zip', async (req, res) => {
  try {
    const { files, zipName } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).send('Files array is required');
    }
    const outputName = encodeURIComponent(zipName || 'canvas_materials.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${outputName}`);
    await canvasService.createZipArchive(files, res);
  } catch (err) {
    console.error('Zip creation error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error generating zip: ' + err.message);
    }
  }
});

// 12. 設定の取得と保存
app.get('/api/config', (req, res) => {
  res.json({ success: true, config: loadConfig() });
});

app.post('/api/config', (req, res) => {
  try {
    const current = loadConfig();
    const isCredentialsChanged = Boolean(
      (req.body.baseUrl !== undefined && req.body.baseUrl !== current.baseUrl) ||
      (req.body.apiToken !== undefined && req.body.apiToken !== current.apiToken) ||
      (req.body.currentQuarter !== undefined && req.body.currentQuarter !== current.currentQuarter)
    );

    const success = saveConfig(req.body);

    // 認証情報または学期フィルターが変更された場合のみキャッシュを初期化
    if (isCredentialsChanged) {
      canvasService.clearAllCache(true);
    }
    res.json({ success, config: loadConfig() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// キャッシュ強制クリアAPI
app.post('/api/cache/clear', (req, res) => {
  try {
    canvasService.clearAllCache(true);
    res.json({ success: true, message: 'キャッシュをクリアしました' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. 統合ダウンロード管理API（YouTube + フォルダ通常保存）
app.get('/api/downloads', (req, res) => {
  res.json({ success: true, downloads: [...downloadJobs.values()].map(publicDownloadJob) });
});

app.post('/api/downloads/:id/cancel', (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job || job.status !== 'downloading') {
    return res.status(404).json({ success: false, error: 'ダウンロードが見つかりません' });
  }
  job.status = 'cancelled';
  job.message = 'キャンセルしました';
  if (job.process) {
    try { job.process.kill(); } catch (e) {}
    job.process = null;
  }
  res.json({ success: true, job: publicDownloadJob(job) });
});

app.post('/api/downloads/clear', (req, res) => {
  for (const [id, job] of downloadJobs.entries()) {
    if (job.status !== 'downloading') {
      downloadJobs.delete(id);
    }
  }
  res.json({ success: true });
});

// パス（フォルダまたはファイル）をエクスプローラーで開く
app.post('/api/open-path', (req, res) => {
  const targetPath = req.body.path || req.body.targetPath;
  if (!targetPath) return res.status(400).json({ success: false, error: 'Path is required' });
  exec(`explorer.exe "${targetPath}"`, (err) => {
    if (err) console.error('Failed to open path:', err);
  });
  res.json({ success: true });
});

// ダウンロードフォルダを開く
app.post('/api/open-downloads', (req, res) => {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  exec(`explorer.exe "${downloadsDir}"`, (err) => {
    if (err) console.error('Failed to open downloads:', err);
  });
  res.json({ success: true });
});

// 14. YouTube動画のダウンロード（yt-dlp連携）
app.get('/api/youtube/downloads', (req, res) => {
  res.json({ success: true, downloads: [...downloadJobs.values()].filter(j => j.type === 'youtube').map(publicDownloadJob) });
});

app.post('/api/youtube/download', (req, res, next) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

  const ytdlCmd = getYtdlCommand();
  if (!ytdlCmd) return res.status(500).json({ success: false, error: 'yt-dlp が見つかりません' });

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const safeName = (title || 'lecture_video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
  const job = {
    id: `yt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'youtube',
    title: title || 'YouTube動画',
    status: 'downloading',
    progress: 0,
    saveDir: downloadsDir,
    message: '準備中',
    createdAt: Date.now(),
    fileName: null,
    error: null,
    process: null
  };
  const args = [
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b/bv*+ba',
    '--merge-output-format', 'mp4', '--no-playlist', '--windows-filenames', '--newline',
    '-o', path.join(downloadsDir, `${safeName}.%(ext)s`), '--print', 'after_move:filepath', url
  ];

  try {
    const child = spawn(ytdlCmd, args);
    job.process = child;
    registerDownloadJob(job);
    const updateProgress = (data) => {
      const output = data.toString();
      const match = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (match) { job.progress = Math.min(100, Number(match[1])); job.message = 'ダウンロード中'; }
      const pathMatch = output.match(/([^\r\n]+\.(?:mp4|mkv|webm))\s*$/im);
      if (pathMatch) job.fileName = path.basename(pathMatch[1].trim());
    };
    child.stdout.on('data', updateProgress);
    child.stderr.on('data', (data) => { updateProgress(data); job.lastError = data.toString().trim(); });
    child.on('error', (err) => { job.status = 'failed'; job.error = err.code === 'ENOENT' ? 'yt-dlp を起動できませんでした' : err.message; job.process = null; });
    child.on('close', (code) => {
      if (job.status === 'cancelled') return;
      job.process = null;
      if (code === 0) { job.status = 'completed'; job.progress = 100; job.message = '保存しました'; job.fileName ||= `${safeName}.mp4`; }
      else { job.status = 'failed'; job.error = job.lastError || `yt-dlp が終了しました (code ${code})`; }
    });
    return res.status(202).json({ success: true, job: publicDownloadJob(job) });
  } catch (err) { return next(err); }
});

app.post('/api/youtube/download/:id/cancel', (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job || !job.process || job.status !== 'downloading') return res.status(404).json({ success: false, error: 'ダウンロードが見つかりません' });
  job.status = 'cancelled'; job.message = 'キャンセルしました'; job.process.kill(); job.process = null;
  res.json({ success: true, job: publicDownloadJob(job) });
});

// レガシー同期ダウンロードエンドポイント（後方互換性維持用）
app.post('/api/youtube/download-legacy', async (req, res) => {
  const { url, title, courseName } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, error: 'URLが指定されていません' });
  }

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const safeName = (title || 'lecture_video').replace(/[\\/:*?"<>|]/g, '_');
  const outputPattern = path.join(downloadsDir, `${safeName}.%(ext)s`);

  // yt-dlp の実行ファイルパスを解決（キャッシュ済みパスを使用）
  const ytdlCmd = getYtdlCommand();

  // フォーマット指定および保存先パスの解決
  const args = [
    '--extractor-args', 'youtube:player_client=android,web',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b/bv*+ba',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--windows-filenames',
    '-o', outputPattern,
    '--print', 'after_move:filepath',
    url
  ];

  try {
    let savedPath = '';
    let errorMessage = '';

    const ytdl = spawn(ytdlCmd, args);

    ytdl.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && (trimmed.endsWith('.mp4') || trimmed.endsWith('.mkv') || trimmed.endsWith('.webm') || trimmed.includes(downloadsDir))) {
          savedPath = trimmed;
        }
      }
    });

    ytdl.stderr.on('data', (data) => {
      errorMessage += data.toString();
    });

    ytdl.on('error', (err) => {
      if (err.code === 'ENOENT') {
        res.status(500).json({
          success: false,
          error: 'システムに yt-dlp が見つかりませんでした。yt-dlp をインストールするか、アプリ内の「再生」をご利用ください。'
        });
      } else {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    ytdl.on('close', (code) => {
      if (code === 0) {
        res.json({
          success: true,
          message: 'ダウンロード完了',
          savedPath: savedPath || path.join(downloadsDir, `${safeName}.mp4`),
          fileName: path.basename(savedPath || `${safeName}.mp4`),
          downloadsDir
        });
      } else {
        res.status(500).json({
          success: false,
          error: `yt-dlpエラー (コード ${code}): ${errorMessage.slice(0, 300)}`
        });
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. ダウンロードフォルダをエクスプローラーで開く
app.post('/api/open-downloads', (req, res) => {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  exec(`explorer.exe "${downloadsDir}"`, () => {});
  res.json({ success: true });
});

// セマンティックバージョニング比較関数 (vA > vB なら 1, vA < vB なら -1, 等しいなら 0)
function compareSemver(v1, v2) {
  const clean = v => (v || '').replace(/^v/, '').trim();
  const p1 = clean(v1).split('.').map(n => parseInt(n, 10) || 0);
  const p2 = clean(v2).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

// 16. アップデート確認 (GitHub Releases連携)
app.get('/api/app/check-update', async (req, res) => {
  const checkedAt = new Date().toISOString();
  try {
    // 最新の package.json を都度ロード
    delete require.cache[require.resolve('../package.json')];
    const pkg = require('../package.json');
    const currentVersion = `v${pkg.version}`;
    const cfg = loadConfig();
    const repo = cfg.githubRepo || 'shizengakari/CanvasLMS-Horizon';

    // GitHub Releases API への問い合わせ
    const ghUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const resp = await fetch(ghUrl, {
        headers: {
          'User-Agent': 'CanvasHorizon-App',
          'Accept': 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (resp.ok) {
        const release = await resp.json();
        const latestTag = release.tag_name || '';
        const hasUpdate = compareSemver(latestTag, currentVersion) > 0;
        const setupAsset = release.assets?.find(a => a.name && a.name.endsWith('.exe'));
        const zipAsset = release.assets?.find(a => a.name && a.name.endsWith('.zip'));
        const asarAsset = release.assets?.find(a => a.name === 'app.asar');

        return res.json({
          success: true,
          currentVersion,
          latestVersion: latestTag || currentVersion,
          releaseName: release.name || latestTag,
          hasUpdate,
          releaseNotes: release.body || '',
          downloadUrl: setupAsset?.browser_download_url || release.html_url,
          setupSize: setupAsset?.size || null,
          zipUrl: zipAsset?.browser_download_url || null,
          zipSize: zipAsset?.size || null,
          asarUrl: asarAsset?.browser_download_url || null,
          asarSize: asarAsset?.size || null,
          publishedAt: release.published_at,
          checkedAt
        });
      } else {
        const errText = resp.status === 403 ? 'GitHub API のリクエスト制限に達しました' : `GitHub API エラー (HTTP ${resp.status})`;
        return res.json({
          success: false,
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
          downloadUrl: null,
          zipUrl: null,
          error: errText,
          checkedAt
        });
      }
    } catch (e) {
      clearTimeout(timeout);
      const isTimeout = e.name === 'AbortError';
      return res.json({
        success: false,
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        downloadUrl: null,
        zipUrl: null,
        error: isTimeout ? '接続がタイムアウトしました' : 'ネットワークに接続できませんでした',
        checkedAt
      });
    }
  } catch (err) {
    let fallbackVer = 'v1.1.3';
    try { fallbackVer = `v${require('../package.json').version}`; } catch (e) {}
    return res.json({
      success: false,
      currentVersion: fallbackVer,
      latestVersion: fallbackVer,
      hasUpdate: false,
      downloadUrl: null,
      zipUrl: null,
      error: err.message,
      checkedAt
    });
  }
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      currentPort = server.address().port;
      console.log(`Canvas Horizon API Server running at http://localhost:${currentPort}`);
      resolve(server);
    }).on('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        resolve(startServer(port + 1));
      } else {
        reject(err);
      }
    });
  });
}

module.exports = {
  app,
  startServer,
  PORT,
  compareSemver,
  PDF_CACHE_DIR,
  ensurePdfCached,
  normalizeDownloadFileName,
  extractFilenameFromContentDisposition,
  isValidPdfFile,
  resolveContentType,
  normalizeCanvasFileUrl
};

if (require.main === module) {
  startServer();
}
