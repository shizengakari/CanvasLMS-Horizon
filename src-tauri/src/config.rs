//! Configuration management module for Canvas Horizon
//! Handles reading, saving, and synchronizing user configuration from %APPDATA%/Canvas Horizon/config.json
//! Provides 100% parity with `src/config.js` and `manual_completed.json`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const OFFICIAL_REPO: &str = "shizengakari/CanvasLMS-Horizon";
const LEGACY_REPO: &str = "shize-tech/CanvasLMS";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_token: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub current_quarter: String,
    #[serde(default = "default_battery_mode")]
    pub battery_mode: String,
    #[serde(default)]
    pub battery_saver: bool,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_min: u32,
    #[serde(default)]
    pub download_dir: String,
    #[serde(default)]
    pub auto_download_folder: String,
    #[serde(default = "default_github_repo")]
    pub github_repo: String,
}

#[derive(Debug, Clone, Default)]
pub struct ConfigPatch {
    pub base_url: Option<String>,
    pub api_token: Option<String>,
    pub download_dir: Option<String>,
    pub current_quarter: Option<String>,
    pub theme: Option<String>,
    pub battery_mode: Option<String>,
    pub battery_saver: Option<bool>,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_battery_mode() -> String {
    "auto".to_string()
}

fn default_poll_interval() -> u32 {
    15
}

fn default_github_repo() -> String {
    OFFICIAL_REPO.to_string()
}

pub fn default_download_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join("Downloads")
        .to_string_lossy()
        .into_owned()
}

impl Default for AppConfig {
    fn default() -> Self {
        let dl = default_download_dir();
        Self {
            base_url: String::new(),
            api_token: String::new(),
            theme: default_theme(),
            current_quarter: String::new(),
            battery_mode: default_battery_mode(),
            battery_saver: false,
            poll_interval_min: default_poll_interval(),
            download_dir: dl.clone(),
            auto_download_folder: dl,
            github_repo: default_github_repo(),
        }
    }
}

impl AppConfig {
    /// Synchronize batteryMode, batterySaver, download_dir, and repository normalization
    pub fn normalize(&mut self) {
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.api_token = self.api_token.trim().to_string();

        if self.battery_mode == "on" {
            self.battery_saver = true;
        } else if self.battery_mode == "off" {
            self.battery_saver = false;
        } else {
            self.battery_mode = "auto".to_string();
            self.battery_saver = false;
        }

        if self.download_dir.trim().is_empty() && !self.auto_download_folder.trim().is_empty() {
            self.download_dir = self.auto_download_folder.trim().to_string();
        } else if self.download_dir.trim().is_empty() {
            self.download_dir = default_download_dir();
        }
        let norm_dl = self
            .download_dir
            .trim()
            .trim_end_matches(['\\', '/'])
            .to_lowercase();
        if norm_dl.ends_with("\\downloads\\canvas")
            || norm_dl.ends_with("/downloads/canvas")
            || norm_dl.ends_with("\\downloads\\canvaslms")
            || norm_dl.ends_with("/downloads/canvaslms")
        {
            self.download_dir = default_download_dir();
        }
        self.auto_download_folder = self.download_dir.clone();

        if self.github_repo.trim().is_empty() || self.github_repo == LEGACY_REPO {
            self.github_repo = OFFICIAL_REPO.to_string();
        }

        if self.base_url.is_empty() {
            if let Ok(env_url) = std::env::var("CANVAS_BASE_URL") {
                if !env_url.trim().is_empty() {
                    self.base_url = env_url.trim().to_string();
                }
            }
        }
        if self.api_token.is_empty() {
            if let Ok(env_token) = std::env::var("CANVAS_API_TOKEN") {
                if !env_token.trim().is_empty() {
                    self.api_token = env_token.trim().to_string();
                }
            }
        }
    }
}

pub fn mask_token(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".to_string();
    }
    let prefix: String = chars[..4].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{}••••••••{}", prefix, suffix)
}

/// Returns the path to the user AppData configuration directory:
/// `%APPDATA%/Canvas Horizon`
pub fn get_user_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("Canvas Horizon")
    } else if let Ok(home) = std::env::var("USERPROFILE") {
        PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join("Canvas Horizon")
    } else {
        PathBuf::from(".").join("data")
    }
}

pub fn get_config_dir() -> PathBuf {
    get_user_data_dir()
}

pub fn get_config_path() -> PathBuf {
    get_user_data_dir().join("config.json")
}

pub fn get_manual_completed_path() -> PathBuf {
    get_user_data_dir().join("manual_completed.json")
}

fn parse_config_resilient(raw: &str) -> AppConfig {
    let cleaned = raw.trim_start_matches('\u{feff}').trim();
    if let Ok(cfg) = serde_json::from_str::<AppConfig>(cleaned) {
        return cfg;
    }
    let mut cfg = AppConfig::default();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(s) = val.get("baseUrl").and_then(|v| v.as_str()) {
            cfg.base_url = s.to_string();
        }
        if let Some(s) = val.get("apiToken").and_then(|v| v.as_str()) {
            cfg.api_token = s.to_string();
        }
        if let Some(s) = val.get("theme").and_then(|v| v.as_str()) {
            cfg.theme = s.to_string();
        }
        if let Some(s) = val.get("currentQuarter").and_then(|v| v.as_str()) {
            cfg.current_quarter = s.to_string();
        }
        if let Some(s) = val.get("batteryMode").and_then(|v| v.as_str()) {
            cfg.battery_mode = s.to_string();
        }
        if let Some(b) = val.get("batterySaver").and_then(|v| v.as_bool()) {
            cfg.battery_saver = b;
        }
        if let Some(n) = val.get("pollIntervalMin").and_then(|v| v.as_u64()) {
            cfg.poll_interval_min = n as u32;
        }
        if let Some(s) = val.get("downloadDir").and_then(|v| v.as_str()) {
            cfg.download_dir = s.to_string();
        }
        if let Some(s) = val.get("autoDownloadFolder").and_then(|v| v.as_str()) {
            cfg.auto_download_folder = s.to_string();
        }
        if let Some(s) = val.get("githubRepo").and_then(|v| v.as_str()) {
            cfg.github_repo = s.to_string();
        }
    }
    cfg
}

pub fn load_config_from_path(path: &Path) -> AppConfig {
    let mut config = if path.exists() {
        match fs::read_to_string(path) {
            Ok(content) => parse_config_resilient(&content),
            Err(_) => AppConfig::default(),
        }
    } else {
        AppConfig::default()
    };
    config.normalize();
    config
}

pub fn load_config() -> AppConfig {
    let config_path = get_config_path();
    let mut cfg = load_config_from_path(&config_path);
    if cfg.base_url.is_empty() || cfg.api_token.is_empty() {
        let mut fallbacks = vec![PathBuf::from("config.json")];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                fallbacks.push(dir.join("config.json"));
            }
        }
        for fb in fallbacks {
            if fb.exists() && fb != config_path {
                let fb_cfg = load_config_from_path(&fb);
                if !fb_cfg.base_url.is_empty() && !fb_cfg.api_token.is_empty() {
                    if cfg.base_url.is_empty() {
                        cfg.base_url = fb_cfg.base_url;
                    }
                    if cfg.api_token.is_empty() {
                        cfg.api_token = fb_cfg.api_token;
                    }
                    cfg.normalize();
                    let _ = save_config_to_path(&cfg, &config_path);
                    break;
                }
            }
        }
    }
    cfg
}

pub fn save_config_to_path(config: &AppConfig, path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut to_save = config.clone();
    to_save.normalize();
    let json = serde_json::to_string_pretty(&to_save)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(path, json)?;
    Ok(())
}

pub fn save_config(patch: ConfigPatch) -> AppConfig {
    let mut current = load_config();
    if let Some(u) = patch.base_url {
        current.base_url = u;
    }
    if let Some(t) = patch.api_token {
        current.api_token = t;
    }
    if let Some(d) = patch.download_dir {
        current.download_dir = d.clone();
        current.auto_download_folder = d;
    }
    if let Some(q) = patch.current_quarter {
        current.current_quarter = q;
    }
    if let Some(th) = patch.theme {
        current.theme = th;
    }
    if let Some(bm) = patch.battery_mode {
        current.battery_mode = bm;
    } else if let Some(bs) = patch.battery_saver {
        current.battery_mode = if bs {
            "on".to_string()
        } else {
            "off".to_string()
        };
    }
    if let Some(bs) = patch.battery_saver {
        current.battery_saver = bs;
    }
    current.normalize();
    let _ = save_config_to_path(&current, &get_config_path());
    current
}
