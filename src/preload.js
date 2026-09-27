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

  // 自動アップデート確認
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // 更新適用と再起動（インストーラーのサイレント実行）
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),

  // 自動アップデート状態の受信リスナー
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (event, data) => callback(data));
  }
});
