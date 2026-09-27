/**
 * Canvas Horizon - 設定管理モジュール
 * アプリケーション設定の読み込み、保存、永続化を管理します。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// アプリケーションデータ保存先ディレクトリ（AppData/Roaming/Canvas Horizon）
const userDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Canvas Horizon');
if (!fs.existsSync(userDir)) {
  try {
    fs.mkdirSync(userDir, { recursive: true });
  } catch (e) {
    console.error('設定フォルダの作成に失敗しました:', e.message);
  }
}

const CONFIG_PATH = path.join(userDir, 'config.json');
const FALLBACK_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * 現在の設定を読み込みます。
 * @returns {object} アプリケーション設定オブジェクト
 */
function loadConfig() {
  let config = {
    baseUrl: '',
    apiToken: '',
    theme: 'dark',
    currentQuarter: '',
    batterySaver: false,
    pollIntervalMin: 15,
    autoDownloadFolder: '',
    githubRepo: 'shizengakari/CanvasLMS-Horizon'
  };

  // 1. AppData からユーザー設定を読み込み
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config = { ...config, ...data };
    } catch (e) {
      console.error('AppData からの設定読み込みエラー:', e.message);
    }
  } else if (fs.existsSync(FALLBACK_CONFIG_PATH)) {
    // 2. ローカルディレクトリのフォールバック設定を読み込み
    try {
      const data = JSON.parse(fs.readFileSync(FALLBACK_CONFIG_PATH, 'utf-8'));
      config = { ...config, ...data };
    } catch (e) {
      console.error('フォールバック設定の読み込みエラー:', e.message);
    }
  }

  // 3. 環境変数（CI/CD またはローカル開発用）からの補完
  if (!config.baseUrl && process.env.CANVAS_BASE_URL) {
    config.baseUrl = process.env.CANVAS_BASE_URL;
  }
  if (!config.apiToken && process.env.CANVAS_API_TOKEN) {
    config.apiToken = process.env.CANVAS_API_TOKEN;
  }

  return config;
}

/**
 * 更新された設定を保存します。
 * @param {object} newConfig 保存する新しい設定情報
 * @returns {boolean} 成功可否
 */
function saveConfig(newConfig) {
  try {
    const current = loadConfig();
    const merged = { ...current, ...newConfig };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('設定の保存に失敗しました:', err.message);
    return false;
  }
}

module.exports = {
  loadConfig,
  saveConfig
};
