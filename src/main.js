/**
 * Canvas Horizon - Electron メインプロセス
 * デスクトップウィンドウのライフサイクル、ネイティブUI、IPC通信を管理します。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ネイティブメニューバーの無効化
Menu.setApplicationMenu(null);

// 例外ハンドリングおよび EPIPE エラー防止
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || (err.message && err.message.includes('EPIPE')))) return;
  console.error('Uncaught Exception:', err);
  try {
    dialog.showErrorBox('Canvas Horizon エラー', `予期せぬエラーが発生しました:\n${err?.stack || err?.message || err}`);
  } catch (e) {}
});

if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', (err) => { if (err && err.code === 'EPIPE') return; });
}

const { startServer, PORT, compareSemver } = require('./server');
const { loadConfig } = require('./config');

let mainWindow = null;
let serverInstance = null;
let actualPort = PORT;
let downloadsActive = false;

// タスクバーのアプリアイコン設定
app.setName('Canvas Horizon');
app.setAppUserModelId('io.github.shizengakari.canvashorizon');

// 二重起動の防止および既存ウィンドウのフォーカス
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  // レンダリング最適化フラグの設定（バックグラウンドスロットリングを有効化してバッテリーを保護）
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,SmoothScrolling,ResourceLoadScheduler');
  app.commandLine.appendSwitch('disable-background-timer-throttling', 'false');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'false');

  async function createWindow() {
    try {
      let initialBg = '#0b0f19';
      try {
        const cfg = loadConfig();
        if (cfg && cfg.theme === 'light') initialBg = '#f8f9fa';
      } catch (e) {}

      mainWindow = new BrowserWindow({
        width: 1380,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: initialBg,
        title: 'Canvas Horizon',
        icon: path.join(__dirname, '..', 'app.ico'),
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: true, // バックグラウンド時に適切にスロットリングしてCPU・バッテリー消費を大幅削減
          plugins: true,
          preload: path.join(__dirname, 'preload.js')
        },
        frame: true,
        show: false
      });

      mainWindow.setMenuBarVisibility(false);
      mainWindow.removeMenu();

      // 開発・ローカル実行時はHTTPキャッシュをクリアして常に最新コードを確実に反映
      if (!app.isPackaged) {
        try {
          await mainWindow.webContents.session.clearCache();
        } catch (_) {}
      }

      // 開発・テスト時のショートカット（F5 / Ctrl+R でキャッシュ無視リロード、F12 で DevTools）
      mainWindow.webContents.on('before-input-event', (event, input) => {
        if (!app.isPackaged) {
          if (input.key === 'F12' && input.type === 'keyDown') {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
          }
          if (((input.key === 'F5') || (input.control && input.key.toLowerCase() === 'r')) && input.type === 'keyDown') {
            mainWindow.webContents.reloadIgnoringCache();
            event.preventDefault();
          }
        }
      });

      const targetUrl = `http://localhost:${actualPort}`;
      mainWindow.loadURL(targetUrl);

      let isShown = false;
      const showWindow = () => {
        if (!isShown && mainWindow) {
          isShown = true;
          mainWindow.show();
          mainWindow.focus();
        }
      };

      mainWindow.once('ready-to-show', () => {
        showWindow();
        if (app.isPackaged) {
          setTimeout(() => {
            checkAsarUpdate().catch(() => {});
          }, 3000);
        }
      });
      setTimeout(showWindow, 600);

      // 読み込み失敗時の再試行
      mainWindow.webContents.on('did-fail-load', () => {
        setTimeout(() => {
          if (mainWindow) {
            mainWindow.loadURL(targetUrl);
          }
        }, 500);
      });

      // 外部リンクを既定のブラウザで開く
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
      });

      // ブラウザダウンロード発生時の保存先制御
      mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
        const downloadsDir = app.getPath('downloads');
        const filename = item.getFilename() || 'download';
        let savePath = path.join(downloadsDir, filename);
        item.setSavePath(savePath);
      });

      mainWindow.on('closed', () => {
        mainWindow = null;
      });

      let allowingClose = false;
      mainWindow.on('close', (event) => {
        if (allowingClose || !downloadsActive) return;
        event.preventDefault();
        try {
          const parentWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
          const choice = dialog.showMessageBoxSync(parentWin, {
            type: 'warning',
            buttons: ['ダウンロードを続ける', 'アプリを閉じる'],
            defaultId: 0,
            cancelId: 0,
            title: 'ダウンロード中',
            message: 'ダウンロード中です。',
            detail: 'アプリを閉じるとダウンロードが中断されます。終了しますか？'
          });
          if (choice === 1) {
            allowingClose = true;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.destroy();
            }
            app.quit();
          }
        } catch (err) {
          allowingClose = true;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
          }
          app.quit();
        }
      });
    } catch (err) {
      console.error('Failed to create window:', err);
      dialog.showErrorBox('Canvas Horizon 起動エラー', `ウィンドウの作成に失敗しました:\n${err?.stack || err?.message || err}`);
    }
  }

  // フォルダ選択ダイアログ
  ipcMain.handle('select-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // ファイルまたはフォルダを開く
  ipcMain.handle('open-path', async (event, fullPath) => {
    return await shell.openPath(fullPath);
  });

  // 外部リンクをブラウザで開く
  ipcMain.handle('open-external', async (event, url) => {
    return await shell.openExternal(url);
  });

  let powerSaveBlockerId = null;
  ipcMain.on('downloads-active', (event, active) => {
    downloadsActive = Boolean(active);
    if (downloadsActive) {
      if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else {
      if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
        powerSaveBlocker.stop(powerSaveBlockerId);
        powerSaveBlockerId = null;
      }
    }
  });

  // 電源状態の取得ハンドラ
  ipcMain.handle('get-power-state', () => {
    try {
      return { onBattery: powerMonitor.isOnBatteryPower() };
    } catch (e) {
      return { onBattery: false };
    }
  });

  // OS電源状態変化イベントのリッスン
  powerMonitor.on('on-battery', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-state-change', { onBattery: true });
    }
  });
  powerMonitor.on('on-ac', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-state-change', { onBattery: false });
    }
  });

  ipcMain.on('app-relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // アプリケーション情報取得
  ipcMain.handle('get-app-info', () => ({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
  }));

  // ==========================================
  // 自動アップデート用 (SmartScreen/Defender完全回避 Asar ホットパッチ更新)
  // ==========================================
  let pendingAsarUpdate = null; // { version, pendingFile, targetAsar, exePath }

  async function checkAsarUpdate() {
    if (!app.isPackaged) {
      return { status: 'dev-mode', message: '開発環境のためスキップします' };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { type: 'checking' });
    }
    try {
      const pkg = require('../package.json');
      const currentVersion = `v${pkg.version}`;
      const cfg = loadConfig();
      const repo = cfg.githubRepo || 'shizengakari/CanvasLMS-Horizon';
      const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          'User-Agent': 'CanvasHorizon-App',
          'Accept': 'application/vnd.github.v3+json',
          'Cache-Control': 'no-cache'
        }
      });
      if (!resp.ok) {
        throw new Error(`GitHub API HTTP ${resp.status}`);
      }
      const release = await resp.json();
      const latestTag = release.tag_name || '';
      const hasUpdate = compareSemver(latestTag, currentVersion) > 0;
      const asarAsset = release.assets?.find(a => a.name === 'app.asar');

      if (hasUpdate && asarAsset) {
        const updateData = {
          type: 'available',
          version: latestTag,
          releaseNotes: release.body || '',
          releaseDate: release.published_at,
          downloadUrl: asarAsset.browser_download_url,
          size: asarAsset.size
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-status', updateData);
        }
        return { status: 'available', updateInfo: updateData };
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-status', {
            type: 'not-available',
            version: latestTag || currentVersion
          });
        }
        return { status: 'not-available', version: latestTag || currentVersion };
      }
    } catch (err) {
      console.error('アップデート確認エラー:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'error',
          error: err.message
        });
      }
      return { status: 'error', message: err.message };
    }
  }

  ipcMain.handle('check-for-updates', async () => {
    return await checkAsarUpdate();
  });

  ipcMain.handle('start-download-update', async () => {
    if (!app.isPackaged) {
      return { success: false, message: '開発環境のためスキップします' };
    }
    try {
      const cfg = loadConfig();
      const repo = cfg.githubRepo || 'shizengakari/CanvasLMS-Horizon';
      const resp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          'User-Agent': 'CanvasHorizon-App',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const release = await resp.json();
      const asarAsset = release.assets?.find(a => a.name === 'app.asar');
      if (!asarAsset) throw new Error('app.asar が最新リリースに見つかりません');

      const downloadUrl = asarAsset.browser_download_url;
      const totalBytes = asarAsset.size || 0;
      const updateDir = path.join(app.getPath('userData'), 'pending-update');
      if (!fs.existsSync(updateDir)) fs.mkdirSync(updateDir, { recursive: true });
      const pendingFile = path.join(updateDir, 'app.asar');

      const downloadResp = await fetch(downloadUrl);
      if (!downloadResp.ok) throw new Error(`ダウンロード失敗: HTTP ${downloadResp.status}`);

      const fileStream = fs.createWriteStream(pendingFile);
      const reader = downloadResp.body.getReader();
      let receivedBytes = 0;
      let lastProgressTime = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        receivedBytes += value.length;

        const now = Date.now();
        if (now - lastProgressTime > 150) {
          lastProgressTime = now;
          const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-status', {
              type: 'progress',
              percent,
              transferred: receivedBytes,
              total: totalBytes
            });
          }
        }
      }
      fileStream.end();

      pendingAsarUpdate = {
        version: release.tag_name,
        pendingFile,
        targetAsar: path.join(process.resourcesPath, 'app.asar'),
        exePath: process.execPath
      };

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'downloaded',
          version: release.tag_name,
          releaseNotes: release.body || ''
        });
      }

      return { success: true };
    } catch (err) {
      console.error('アップデートダウンロードエラー:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'error',
          error: err.message
        });
      }
      return { success: false, error: err.message };
    }
  });

  ipcMain.on('quit-and-install', () => {
    if (serverInstance) {
      try {
        serverInstance.closeAllConnections?.();
        serverInstance.close();
      } catch (_) {}
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }

    if (pendingAsarUpdate && fs.existsSync(pendingAsarUpdate.pendingFile)) {
      // Windows用ホットパッチ再起動バッチスクリプト
      const updateDir = path.dirname(pendingAsarUpdate.pendingFile);
      const batPath = path.join(updateDir, 'apply-update.bat');
      const batContent = `@echo off
chcp 65001 >nul
timeout /t 1 /nobreak >nul
copy /y "${pendingAsarUpdate.pendingFile}" "${pendingAsarUpdate.targetAsar}" >nul
start "" "${pendingAsarUpdate.exePath}"
del "${pendingAsarUpdate.pendingFile}" >nul 2>&1
(goto) 2>nul & del "%~f0"
`;
      try {
        fs.writeFileSync(batPath, batContent, 'utf8');
        const child = spawn('cmd.exe', ['/c', batPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.unref();
        setTimeout(() => {
          app.exit(0);
        }, 300);
        return;
      } catch (e) {
        console.error('バッチ生成エラー:', e);
      }
    }

    app.exit(0);
  });

  app.whenReady().then(async () => {
    try {
      serverInstance = await startServer(PORT);
      actualPort = serverInstance.address().port;
      console.log(`API Server running at port ${actualPort}`);
      await createWindow();
    } catch (err) {
      console.error('Failed to start server:', err);
      dialog.showErrorBox('Canvas Horizon 起動エラー', `ローカルサーバーの起動に失敗しました:\n${err.message}`);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    if (serverInstance) {
      serverInstance.close();
    }
  });
}
