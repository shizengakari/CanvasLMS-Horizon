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
const { spawn, exec } = require('child_process');
const canvasService = require('./canvasService');
const { loadConfig, saveConfig } = require('./config');

const app = express();
const downloadJobs = new Map();
const youtubeDownloads = downloadJobs; // 後方互換性のエイリアス

function getYtdlCommand() {
  const candidates = [
    'yt-dlp',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe')
  ];
  return candidates.find(candidate => candidate === 'yt-dlp' || fs.existsSync(candidate));
}

function publicDownloadJob(job) {
  const { process, ...details } = job;
  return details;
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

// 静的ファイルの提供（HTMLは即時反映、CSS/JS/画像/フォント等はキャッシュしてディスクI/OとCPU負荷を低減）
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
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
        batteryMode: config.batteryMode || (config.batterySaver ? 'on' : 'auto'),
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
        batteryMode: config.batteryMode || (config.batterySaver ? 'on' : 'auto'),
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
    res.status(500).json({ success: false, error: err.message });
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

// 10. ファイルダウンロードプロキシ（PDFインライン表示 / 直接ストリーミング）
app.get('/api/files/download', async (req, res) => {
  try {
    const { url, id, name, inline } = req.query;
    let targetUrl = url;

    const encodedName = encodeURIComponent(name || 'document.pdf');
    const dispositionType = inline === 'true' ? 'inline' : 'attachment';
    const cachedFilePath = id ? path.join(PDF_CACHE_DIR, `${id}.pdf`) : null;

    // 1. キャッシュが存在する場合はローカルファイルを返却
    if (cachedFilePath && fs.existsSync(cachedFilePath)) {
      try {
        const stats = fs.statSync(cachedFilePath);
        if (stats.size > 0) {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `${dispositionType}; filename*=UTF-8''${encodedName}`);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.sendFile(cachedFilePath);
        }
      } catch (cacheErr) {}
    }

    if (!targetUrl && id) {
      const fileData = await canvasService.resolveFileDownload(id);
      targetUrl = fileData?.url;
    }

    if (!targetUrl) {
      return res.status(400).send('Download URL or File ID required');
    }

    const cfg = loadConfig();
    const canvasHost = getCanvasHost(cfg);
    let urlHost = '';
    try { urlHost = new URL(targetUrl).host; } catch (e) {}

    const fetchHeaders = {};
    if (urlHost && urlHost === canvasHost) {
      fetchHeaders['Authorization'] = `Bearer ${cfg.apiToken}`;
    }

    // Rangeリクエストの透過転送（部分読込対応）
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    let fileRes = await fetch(targetUrl, {
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });

    if (!fileRes.ok && urlHost === canvasHost) {
      try {
        const retryUrl = new URL(targetUrl);
        retryUrl.searchParams.set('access_token', cfg.apiToken);
        fileRes = await fetch(retryUrl.toString(), {
          headers: fetchHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(30000)
        });
      } catch (retryErr) {}
    }

    if (!fileRes.ok) {
      return res.status(fileRes.status).send(`Failed to fetch file: ${fileRes.statusText}`);
    }

    const contentType = fileRes.headers.get('content-type') || 'application/pdf';
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

    // キャッシュ保存用ストリーム
    const cacheWriteStream = cachedFilePath ? fs.createWriteStream(cachedFilePath) : null;

    // ストリーミング転送
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
      res.write(buf);
    }
  } catch (err) {
    console.error('File download proxy error:', err);
    if (!res.headersSent) {
      res.status(500).send('Error downloading file: ' + err.message);
    }
  }
});

// 10.5 単体ファイルの直接保存（Downloads ディレクトリへ保存）
app.post('/api/files/download-single', async (req, res) => {
  try {
    const { id, url, name, courseId } = req.body;
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    const rawName = name || 'file.pdf';
    const safeFileName = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);

    const job = {
      id: `single-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'single-file',
      title: safeFileName,
      status: 'downloading',
      progress: 0,
      saveDir: downloadsDir,
      fileName: safeFileName,
      message: 'ダウンロードを開始中...',
      createdAt: Date.now(),
      error: null
    };

    downloadJobs.set(job.id, job);

    (async () => {
      const cfg = loadConfig();
      const canvasHost = getCanvasHost(cfg);
      let downloadUrl = url || null;

      if (downloadUrl && downloadUrl.includes('/api/v1/')) {
        try {
          const fData = await canvasService.fetchJson(downloadUrl);
          if (fData?.url) downloadUrl = fData.url;
        } catch (e) {}
      }

      if (!downloadUrl && id) {
        try {
          const resolved = await canvasService.resolveFileDownload(id, courseId);
          downloadUrl = resolved?.url;
        } catch (e) {}
      }

      if (!downloadUrl && id && cfg.baseUrl) {
        const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
        downloadUrl = `${baseUrl}/files/${id}/download?download_frd=1`;
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
        fileStream.write(Buffer.from(value));
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
      fileStream.end();

      job.status = 'completed';
      job.progress = 100;
      job.fileName = path.basename(finalPath);
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

// 11. 複数ファイルの一括保存（Downloads ディレクトリへ保存）
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

    downloadJobs.set(job.id, job);

    // バックグラウンドで順次ダウンロード
    (async () => {
      const cfg = loadConfig();
      const canvasHost = getCanvasHost(cfg);
      const downloadErrors = [];

      for (let i = 0; i < files.length; i++) {
        if (job.status === 'cancelled') break;
        const item = files[i];
        const rawName = item.name || item.displayName || `file_${i + 1}`;
        const safeFileName = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
        job.currentFileName = safeFileName;
        job.message = `${i + 1}/${files.length} 件目を保存中: ${safeFileName}`;

        try {
          let downloadUrl = item.url || null;

          // item.url が Canvas の内部APIエンドポイントの場合、詳細JSONから直接URLを取り出す
          if (downloadUrl && downloadUrl.includes('/api/v1/')) {
            try {
              const fileData = await canvasService.fetchJson(downloadUrl);
              if (fileData?.url) {
                downloadUrl = fileData.url;
              }
            } catch (apiErr) {
              console.warn(`Could not resolve API URL for ${safeFileName}:`, apiErr.message);
            }
          }

          // item.id からの最新ダウンロードURL解決
          if (!downloadUrl && item.id) {
            try {
              const resolved = await canvasService.resolveFileDownload(item.id, item.courseId);
              downloadUrl = resolved?.url;
            } catch (resolveErr) {
              console.warn(`Failed to resolve download URL for item ${item.id}:`, resolveErr.message);
            }
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

          // HTML（Canvasログイン画面など）が返っていないか検知
          const contentType = fileRes.headers.get('content-type') || '';
          if (contentType.includes('text/html') && !safeFileName.toLowerCase().endsWith('.html')) {
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

          const buffer = Buffer.from(await fileRes.arrayBuffer());
          await fs.promises.writeFile(finalPath, buffer);
          job.savedFiles.push(path.basename(finalPath));
        } catch (err) {
          console.error(`Error saving ${safeFileName}:`, err.message);
          downloadErrors.push(`${safeFileName}: ${err.message}`);
        }

        job.completedCount++;
        job.progress = Math.round((job.completedCount / job.totalCount) * 100);
        job.message = `${job.completedCount}/${job.totalCount} 件保存完了`;
      }

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
    downloadJobs.set(job.id, job);
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

  // yt-dlp の実行ファイルパスを解決
  let ytdlCmd = 'yt-dlp';
  const knownYtdlPaths = [
    'yt-dlp',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe')
  ];

  for (const p of knownYtdlPaths) {
    if (p === 'yt-dlp' || fs.existsSync(p)) {
      ytdlCmd = p;
      break;
    }
  }

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
          error: 'システムに yt-dlp が見つかりませんでした。yt-dlp をインストールするか、アプリ内の「再生 ▶」をご利用ください。'
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
        const latestTag = release.tag_name || release.name;
        const hasUpdate = Boolean(latestTag && compareSemver(latestTag, currentVersion) > 0);
        return res.json({
          success: true,
          currentVersion,
          latestVersion: latestTag || currentVersion,
          hasUpdate,
          releaseNotes: release.body || '',
          downloadUrl: release.assets?.[0]?.browser_download_url || release.html_url,
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
        error: isTimeout ? '接続がタイムアウトしました' : 'ネットワークに接続できませんでした',
        checkedAt
      });
    }
  } catch (err) {
    let fallbackVer = 'v1.0.7';
    try { fallbackVer = `v${require('../package.json').version}`; } catch (e) {}
    return res.json({
      success: false,
      currentVersion: fallbackVer,
      latestVersion: fallbackVer,
      hasUpdate: false,
      error: err.message,
      checkedAt
    });
  }
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Canvas Horizon API Server running at http://localhost:${port}`);
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

module.exports = { app, startServer, PORT };

if (require.main === module) {
  startServer();
}
