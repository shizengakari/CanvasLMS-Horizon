/**
 * Canvas Horizon - Electron メインプロセス
 * デスクトップウィンドウのライフサイクル、ネイティブUI、IPC通信を管理します。
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');

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

  // レンダリング最適化フラグの設定
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization,SmoothScrolling');
  app.commandLine.appendSwitch('disable-background-timer-throttling');

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
        icon: path.join(__dirname, 'app.ico'),
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false, // バックグラウンドでも同期やタイマーが滞りなく動作
          plugins: true,
          preload: path.join(__dirname, 'preload.js')
        },
        frame: true,
        show: false
      });

      mainWindow.setMenuBarVisibility(false);
      mainWindow.removeMenu();

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

  ipcMain.on('downloads-active', (event, active) => { downloadsActive = Boolean(active); });
  ipcMain.on('app-relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // 自動アップデート用 IPC ハンドラ
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
    autoUpdater.quitAndInstall(false, true);
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
