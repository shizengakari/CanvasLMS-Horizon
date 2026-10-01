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

const { startServer, PORT } = require('./server');
const { loadConfig } = require('./config');
const { autoUpdater } = require('electron-updater');

// 自動アップデートの設定
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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
            autoUpdater.checkForUpdates().catch(() => {});
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
    version: app.getVersion()
  }));

  // asar 差分アップデート ダウンロード処理
  ipcMain.handle('start-asar-update', async (event, { asarUrl, version }) => {
    if (!app.isPackaged) {
      return { success: false, message: '開発環境のためスキップします' };
    }
    if (!asarUrl) {
      return { success: false, message: '更新ファイルURLが指定されていません' };
    }

    try {
      const updateDir = path.join(app.getPath('userData'), 'update');
      if (!fs.existsSync(updateDir)) {
        fs.mkdirSync(updateDir, { recursive: true });
      }
      const tempAsarPath = path.join(updateDir, 'app.asar.download');
      const targetAsarPath = path.join(updateDir, 'app.asar');

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'available',
          version: version || 'latest',
          method: 'asar'
        });
      }

      const response = await fetch(asarUrl, {
        headers: { 'User-Agent': 'CanvasHorizon-App' }
      });
      if (!response.ok) {
        throw new Error(`ダウンロードに失敗しました (HTTP ${response.status})`);
      }

      const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
      let receivedBytes = 0;
      const fileStream = fs.createWriteStream(tempAsarPath);

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        receivedBytes += value.length;
        if (totalBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
          const percent = Math.round((receivedBytes / totalBytes) * 100);
          mainWindow.webContents.send('update-status', {
            type: 'progress',
            percent,
            method: 'asar'
          });
        }
      }

      await new Promise((resolve, reject) => {
        fileStream.end((err) => (err ? reject(err) : resolve()));
      });

      if (fs.existsSync(targetAsarPath)) {
        try { fs.unlinkSync(targetAsarPath); } catch (_) {}
      }
      fs.renameSync(tempAsarPath, targetAsarPath);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'downloaded',
          version: version || 'latest',
          method: 'asar'
        });
      }

      return { success: true };
    } catch (err) {
      console.error('asar差分アップデート失敗:', err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', {
          type: 'error',
          error: err.message,
          method: 'asar'
        });
      }
      return { success: false, error: err.message };
    }
  });

  // asar 差分アップデート 適用＆再起動
  ipcMain.on('apply-asar-update', () => {
    const updateDir = path.join(app.getPath('userData'), 'update');
    const downloadedAsar = path.join(updateDir, 'app.asar');
    const currentAsar = path.join(process.resourcesPath, 'app.asar');
    const appExe = app.getPath('exe');

    if (!fs.existsSync(downloadedAsar)) {
      console.error('更新ファイルが存在しません:', downloadedAsar);
      return;
    }

    // Windows用再起動・適用バッチスクリプト
    const updaterBat = path.join(updateDir, 'apply-update.bat');
    const batScript = `@echo off
timeout /t 1 /nobreak >nul
:retry
move /y "${downloadedAsar}" "${currentAsar}" >nul 2>&1
if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto retry
)
start "" "${appExe}"
del "%~f0" >nul 2>&1
exit
`;
    try {
      fs.writeFileSync(updaterBat, batScript, 'utf8');
    } catch (e) {
      console.error('バッチファイル作成失敗:', e);
      return;
    }

    // サーバー接続の強制切断
    if (serverInstance) {
      try {
        serverInstance.closeAllConnections?.();
        serverInstance.close();
      } catch (_) {}
    }

    // ウィンドウを破棄
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }

    // スクリプト起動（バックグラウンド非同期）
    const child = spawn('cmd.exe', ['/c', updaterBat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    // プロセス即時終了
    app.exit(0);
  });

  // 自動アップデート用 IPC ハンドラ（従来のインストーラーフォールバック用）
  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      return { status: 'dev-mode', message: '開発環境のためスキップします' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: 'checked', updateInfo: result?.updateInfo };
    } catch (err) {
      console.error('アップデート確認エラー:', err);
      return { status: 'error', message: err.message };
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
    autoUpdater.quitAndInstall(false, true);
    setTimeout(() => {
      app.exit(0);
    }, 500);
  });

  // 自動アップデート イベントリスナー
  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        type: 'available',
        version: info.version
      });
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        type: 'progress',
        percent: Math.round(progressObj.percent)
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        type: 'downloaded',
        version: info.version
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('autoUpdater エラー:', err);
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
