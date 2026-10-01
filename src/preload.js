/**
 * Canvas Horizon - プリロードスクリプト (Preload Script)
 * セキュアなコンテキスト分離環境において、レンダラープロセスに必要な安全なデスクトップネイティブAPIを提供します。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // Electron環境フラグ
  isElectron: true,

  // フォルダ選択ダイアログの表示
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // ファイルまたはフォルダを既定のシステムアプリで開く
  openPath: (path) => ipcRenderer.invoke('open-path', path),

  // 外部リンクを既定のブラウザで開く
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ダウンロード中状態の通知（アプリ終了時の警告確認用）
  setDownloadsActive: (active) => ipcRenderer.send('downloads-active', Boolean(active)),

  // アプリの再起動
  relaunch: () => ipcRenderer.send('app-relaunch'),

  // アプリケーション情報取得
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // 自動アップデート (安全・確実な公式 electron-updater)
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  startDownloadUpdate: () => ipcRenderer.invoke('start-download-update'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),

  // 自動アップデート状態の受信リスナー
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  },

  // 電源・バッテリー状態の取得
  getPowerState: () => ipcRenderer.invoke('get-power-state'),

  // 電源状態変化リスナー
  onPowerStateChange: (callback) => {
    ipcRenderer.on('power-state-change', (event, data) => callback(data));
  }
});
