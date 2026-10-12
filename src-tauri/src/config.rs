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
    pub auto_download_folder: String,
    #[serde(default = "default_github_repo")]
    pub github_repo: String,
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

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_token: String::new(),
            theme: default_theme(),
            current_quarter: String::new(),
            battery_mode: default_battery_mode(),
            battery_saver: false,
            poll_interval_min: default_poll_interval(),
            auto_download_folder: String::new(),
            github_repo: default_github_repo(),
        }
    }
}

impl AppConfig {
    /// Synchronize batteryMode, batterySaver, and repository normalization
    pub fn normalize(&mut self) {
        // batteryMode <-> batterySaver mutual sync
        if self.battery_mode == "on" {
            self.battery_saver = true;
        } else if self.battery_mode == "off" {
            self.battery_saver = false;
        } else {
            // 'auto' or other: battery_saver stays false initially unless on battery
            self.battery_saver = false;
        }

        // githubRepo normalization
        if self.github_repo.trim().is_empty() || self.github_repo == LEGACY_REPO {
            self.github_repo = OFFICIAL_REPO.to_string();
        }

        // Environment variables override
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

/// Returns the configuration file path
pub fn get_config_path() -> PathBuf {
    get_user_data_dir().join("config.json")
}

/// Returns the manual_completed.json file path
pub fn get_manual_completed_path() -> PathBuf {
    get_user_data_dir().join("manual_completed.json")
}

/// Load configuration from disk, falling back to defaults
pub fn load_config_from_path(path: &Path) -> AppConfig {
    let mut config = if path.exists() {
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str::<AppConfig>(&content).unwrap_or_default(),
            Err(_) => AppConfig::default(),
        }
    } else {
        AppConfig::default()
    };
    config.normalize();
    config
}

/// Load configuration from standard AppData path
pub fn load_config() -> AppConfig {
    let config_path = get_config_path();
    load_config_from_path(&config_path)
}

/// Save configuration to specified path
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

/// Save configuration to standard AppData path
pub fn save_config(config: &AppConfig) -> Result<(), std::io::Error> {
    save_config_to_path(config, &get_config_path())
}

/// Load manually completed assignment IDs
pub fn load_manual_completed_from_path(path: &Path) -> Vec<String> {
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                return ids;
            }
        }
    }
    Vec::new()
}

/// Load manually completed assignment IDs from standard AppData path
pub fn load_manual_completed() -> Vec<String> {
    load_manual_completed_from_path(&get_manual_completed_path())
}

/// Save manually completed assignment IDs to specified path
pub fn save_manual_completed_to_path(ids: &[String], path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(ids)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(path, json)?;
    Ok(())
}

/// Save manually completed assignment IDs to standard AppData path
pub fn save_manual_completed(ids: &[String]) -> Result<(), std::io::Error> {
    save_manual_completed_to_path(ids, &get_manual_completed_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("canvas_horizon_test_{}_{}", prefix, timestamp));
        let _ = fs::create_dir_all(&path);
        path
    }

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.theme, "dark");
        assert_eq!(config.battery_mode, "auto");
        assert_eq!(config.battery_saver, false);
        assert_eq!(config.poll_interval_min, 15);
        assert_eq!(config.github_repo, OFFICIAL_REPO);
    }

    #[test]
    fn test_battery_mode_sync() {
        let mut config = AppConfig {
            battery_mode: "on".to_string(),
            battery_saver: false,
            ..Default::default()
        };
        config.normalize();
        assert_eq!(config.battery_saver, true);

        config.battery_mode = "off".to_string();
        config.normalize();
        assert_eq!(config.battery_saver, false);

        config.battery_mode = "auto".to_string();
        config.normalize();
        assert_eq!(config.battery_saver, false);
    }

    #[test]
    fn test_github_repo_normalization() {
        let mut config = AppConfig {
            github_repo: LEGACY_REPO.to_string(),
            ..Default::default()
        };
        config.normalize();
        assert_eq!(config.github_repo, OFFICIAL_REPO);

        config.github_repo = "   ".to_string();
        config.normalize();
        assert_eq!(config.github_repo, OFFICIAL_REPO);
    }

    #[test]
    fn test_config_save_load_roundtrip() {
        let dir = temp_test_dir("config_roundtrip");
        let cfg_path = dir.join("config.json");

        let initial = AppConfig {
            base_url: "https://canvas.example.edu".to_string(),
            api_token: "test_token_xyz".to_string(),
            theme: "light".to_string(),
            current_quarter: "2Q".to_string(),
            battery_mode: "on".to_string(),
            battery_saver: false,
            poll_interval_min: 30,
            auto_download_folder: "C:\\Downloads".to_string(),
            github_repo: OFFICIAL_REPO.to_string(),
        };

        save_config_to_path(&initial, &cfg_path).expect("Failed to save config");

        let loaded = load_config_from_path(&cfg_path);
        assert_eq!(loaded.base_url, "https://canvas.example.edu");
        assert_eq!(loaded.api_token, "test_token_xyz");
        assert_eq!(loaded.theme, "light");
        assert_eq!(loaded.current_quarter, "2Q");
        assert_eq!(loaded.battery_mode, "on");
        assert_eq!(loaded.battery_saver, true); // normalized
        assert_eq!(loaded.poll_interval_min, 30);
        assert_eq!(loaded.auto_download_folder, "C:\\Downloads");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_manual_completed_roundtrip() {
        let dir = temp_test_dir("manual_completed");
        let file_path = dir.join("manual_completed.json");

        let initial_ids = vec!["assign_101".to_string(), "assign_202".to_string()];
        save_manual_completed_to_path(&initial_ids, &file_path).expect("Failed to save manual completed");

        let loaded_ids = load_manual_completed_from_path(&file_path);
        assert_eq!(loaded_ids, initial_ids);

        let _ = fs::remove_dir_all(&dir);
    }
}
