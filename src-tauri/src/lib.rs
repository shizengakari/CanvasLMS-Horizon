pub mod canvas;
pub mod config;
pub mod quarter;
pub mod server;

use futures_util::StreamExt;
use serde_json::{Value, json};
use std::fs;
use std::io::Read;
use std::net::TcpListener as StdTcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::AsyncWriteExt;

static DOWNLOADS_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Default)]
struct PendingUpdateInfo {
    version: String,
    download_url: String,
    expected_size: u64,
    html_url: String,
    ready_exe_path: Option<PathBuf>,
}

static PENDING_UPDATE: LazyLock<Mutex<Option<PendingUpdateInfo>>> =
    LazyLock::new(|| Mutex::new(None));

fn dispatch_update_status(app: Option<&tauri::AppHandle>, payload: Value) {
    if let Some(app_handle) = app {
        if let Some(win) = app_handle.get_webview_window("main") {
            if let Ok(serialized) = serde_json::to_string(&payload) {
                let js = format!(
                    "if (window.__dispatchUpdateStatus) {{ window.__dispatchUpdateStatus({}); }}",
                    serialized
                );
                let _ = win.eval(&js);
            }
        }
    }
}

fn get_pending_update_dir() -> PathBuf {
    config::get_config_dir().join("pending-update")
}

fn is_valid_pe_executable(path: &std::path::Path) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = f.metadata() else {
        return false;
    };
    if meta.len() < 1024 * 100 {
        return false;
    }
    let mut magic = [0u8; 2];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    &magic == b"MZ"
}

#[cfg(target_os = "windows")]
fn unblock_windows_executable(path: &std::path::Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let path_str = path.to_string_lossy().replace('\'', "''");
    let _ = std::process::Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &format!(
                "Unblock-File -LiteralPath '{}' -ErrorAction SilentlyContinue",
                path_str
            ),
        ])
        .status();
}

#[cfg(not(target_os = "windows"))]
fn unblock_windows_executable(_path: &std::path::Path) {}

#[tauri::command]
async fn select_folder() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("講義資料の保存先ルートフォルダを選択してください")
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
fn open_path(target_path: String) -> Result<Value, String> {
    let trimmed = target_path.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "success": false, "error": "パスが空です" }));
    }
    let p = PathBuf::from(trimmed);
    let to_open = if p.exists() {
        p
    } else if let Some(parent) = p.parent().filter(|pr| pr.exists()) {
        parent.to_path_buf()
    } else {
        p
    };
    match open::that(to_open) {
        Ok(_) => Ok(json!({ "success": true })),
        Err(err) => Ok(json!({ "success": false, "error": err.to_string() })),
    }
}

#[tauri::command]
fn open_external(target_url: String) -> Result<Value, String> {
    let trimmed = target_url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let _ = open::that(trimmed);
        Ok(json!({ "success": true }))
    } else {
        Ok(json!({ "success": false, "error": "無効なURLです" }))
    }
}

#[tauri::command]
fn set_downloads_active(active: bool) -> bool {
    DOWNLOADS_ACTIVE.store(active, Ordering::Relaxed);
    active
}

#[tauri::command]
fn relaunch(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn get_app_info() -> Value {
    json!({
      "version": server::APP_VERSION,
      "isPackaged": !cfg!(debug_assertions),
      "platform": std::env::consts::OS,
      "backend": "rust"
    })
}

#[tauri::command]
fn get_power_state() -> Value {
    json!({
      "onBattery": server::check_windows_battery_power()
    })
}

pub async fn check_for_updates_impl(app: Option<&tauri::AppHandle>) -> Value {
    dispatch_update_status(app, json!({ "status": "checking" }));

    let cfg = config::load_config();
    let repo = if cfg.github_repo.trim().is_empty() {
        "shizengakari/CanvasLMS-Horizon".to_string()
    } else {
        cfg.github_repo.trim().to_string()
    };
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("CanvasHorizon-Rust-Updater")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let resp = match client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let err_msg = format!("GitHub API HTTP {}", r.status());
            dispatch_update_status(app, json!({ "status": "error", "error": err_msg }));
            return json!({ "success": false, "status": "error", "error": err_msg });
        }
        Err(err) => {
            let err_msg = err.to_string();
            dispatch_update_status(app, json!({ "status": "error", "error": err_msg }));
            return json!({ "success": false, "status": "error", "error": err_msg });
        }
    };

    let Ok(release) = resp.json::<Value>().await else {
        let err_msg = "Failed to parse GitHub release JSON";
        dispatch_update_status(app, json!({ "status": "error", "error": err_msg }));
        return json!({ "success": false, "status": "error", "error": err_msg });
    };

    let latest_tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let latest_version = latest_tag.trim().trim_start_matches(['v', 'V']);
    let html_url = release
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/shizengakari/CanvasLMS-Horizon/releases/latest")
        .to_string();

    if latest_version.is_empty() || server::compare_semver(latest_version, server::APP_VERSION) <= 0
    {
        dispatch_update_status(
            app,
            json!({
              "status": "not-available",
              "version": server::APP_VERSION
            }),
        );
        return json!({
          "success": true,
          "status": "not-available",
          "version": server::APP_VERSION
        });
    }

    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let exe_asset = assets
        .iter()
        .find(|a| {
            a.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n.eq_ignore_ascii_case("canvas-horizon.exe"))
                .unwrap_or(false)
        })
        .or_else(|| {
            assets.iter().find(|a| {
                a.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| {
                        let lower = n.to_lowercase();
                        lower.ends_with(".exe")
                            && !lower.contains("setup")
                            && !lower.contains("unins")
                    })
                    .unwrap_or(false)
            })
        });

    let download_url = exe_asset
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let expected_size = exe_asset
        .and_then(|a| a.get("size"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if let Ok(mut guard) = PENDING_UPDATE.lock() {
        *guard = Some(PendingUpdateInfo {
            version: latest_version.to_string(),
            download_url: download_url.clone(),
            expected_size,
            html_url: html_url.clone(),
            ready_exe_path: None,
        });
    }

    let status_payload = json!({
      "status": "available",
      "version": latest_version,
      "releaseNotes": release.get("body").and_then(|v| v.as_str()).unwrap_or(""),
      "downloadUrl": html_url,
      "hasAsar": !download_url.is_empty(),
      "hasExeAsset": !download_url.is_empty(),
    });
    dispatch_update_status(app, status_payload);

    json!({
      "success": true,
      "status": "available",
      "version": latest_version,
      "hasAsar": !download_url.is_empty(),
      "hasExeAsset": !download_url.is_empty(),
      "downloadUrl": html_url,
    })
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Value {
    check_for_updates_impl(Some(&app)).await
}

pub async fn start_download_update_impl(app: Option<&tauri::AppHandle>) -> Value {
    let pending_opt = PENDING_UPDATE.lock().ok().and_then(|g| g.clone());
    let pending = match pending_opt {
        Some(p) if !p.download_url.is_empty() => p,
        _ => {
            let _ = check_for_updates_impl(app).await;
            match PENDING_UPDATE.lock().ok().and_then(|g| g.clone()) {
                Some(p) if !p.download_url.is_empty() => p,
                Some(p) => {
                    let _ = open::that(&p.html_url);
                    return json!({
                      "success": false,
                      "error": "自動更新用バイナリが見つからないため、リリースページを開きました。"
                    });
                }
                None => {
                    return json!({
                      "success": false,
                      "error": "利用可能なアップデートが見つかりません。"
                    });
                }
            }
        }
    };

    let update_dir = get_pending_update_dir();
    if let Err(err) = fs::create_dir_all(&update_dir) {
        let msg = format!("更新フォルダの作成に失敗しました: {err}");
        dispatch_update_status(app, json!({ "status": "error", "error": msg }));
        return json!({ "success": false, "error": msg });
    }

    let temp_path = update_dir.join("canvas-horizon.update.exe.tmp");
    let final_path = update_dir.join("canvas-horizon.update.exe");
    let _ = fs::remove_file(&temp_path);

    dispatch_update_status(
        app,
        json!({
          "status": "downloading",
          "version": pending.version,
          "percent": 0,
          "transferred": 0,
          "total": pending.expected_size
        }),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("CanvasHorizon-Rust-Updater")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let resp = match client.get(&pending.download_url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let msg = format!("ダウンロード失敗 (HTTP {})", r.status());
            dispatch_update_status(app, json!({ "status": "error", "error": msg }));
            return json!({ "success": false, "error": msg });
        }
        Err(err) => {
            let msg = format!("ダウンロード通信エラー: {err}");
            dispatch_update_status(app, json!({ "status": "error", "error": msg }));
            return json!({ "success": false, "error": msg });
        }
    };

    let total_bytes = resp
        .content_length()
        .filter(|&len| len > 0)
        .unwrap_or(pending.expected_size);

    let mut file = match tokio::fs::File::create(&temp_path).await {
        Ok(f) => f,
        Err(err) => {
            let msg = format!("一時ファイル作成エラー: {err}");
            dispatch_update_status(app, json!({ "status": "error", "error": msg }));
            return json!({ "success": false, "error": msg });
        }
    };

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit_pct: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(err) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let msg = format!("ストリーム受信エラー: {err}");
                dispatch_update_status(app, json!({ "status": "error", "error": msg }));
                return json!({ "success": false, "error": msg });
            }
        };
        if let Err(err) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            let msg = format!("ディスク書き込みエラー: {err}");
            dispatch_update_status(app, json!({ "status": "error", "error": msg }));
            return json!({ "success": false, "error": msg });
        }
        downloaded += chunk.len() as u64;
        if total_bytes > 0 {
            let pct = ((downloaded * 100) / total_bytes).min(100);
            if pct >= last_emit_pct + 2 || pct == 100 {
                last_emit_pct = pct;
                dispatch_update_status(
                    app,
                    json!({
                      "status": "downloading",
                      "version": pending.version,
                      "percent": pct,
                      "transferred": downloaded,
                      "total": total_bytes
                    }),
                );
            }
        }
    }

    let _ = file.flush().await;
    drop(file);

    if pending.expected_size > 0 && downloaded != pending.expected_size {
        let _ = fs::remove_file(&temp_path);
        let msg = format!(
            "ダウンロードサイズ不一致 (期待: {} bytes / 実際: {} bytes)",
            pending.expected_size, downloaded
        );
        dispatch_update_status(app, json!({ "status": "error", "error": msg }));
        return json!({ "success": false, "error": msg });
    }

    if !is_valid_pe_executable(&temp_path) {
        let _ = fs::remove_file(&temp_path);
        let msg = "ダウンロードされた実行ファイルが破損しています (PEヘッダ検証失敗)";
        dispatch_update_status(app, json!({ "status": "error", "error": msg }));
        return json!({ "success": false, "error": msg });
    }

    let _ = fs::remove_file(&final_path);
    if let Err(err) = fs::rename(&temp_path, &final_path) {
        let msg = format!("更新ファイルの配置に失敗しました: {err}");
        dispatch_update_status(app, json!({ "status": "error", "error": msg }));
        return json!({ "success": false, "error": msg });
    }

    unblock_windows_executable(&final_path);

    if let Ok(mut guard) = PENDING_UPDATE.lock() {
        if let Some(info) = guard.as_mut() {
            info.ready_exe_path = Some(final_path.clone());
        }
    }

    dispatch_update_status(
        app,
        json!({
          "status": "downloaded",
          "version": pending.version
        }),
    );

    json!({
      "success": true,
      "status": "downloaded",
      "version": pending.version
    })
}

#[tauri::command]
async fn start_download_update(app: tauri::AppHandle) -> Value {
    start_download_update_impl(Some(&app)).await
}

pub fn quit_and_install_impl() -> bool {
    let ready_exe = PENDING_UPDATE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|p| p.ready_exe_path.clone()))
        .unwrap_or_else(|| get_pending_update_dir().join("canvas-horizon.update.exe"));

    if ready_exe.exists() && is_valid_pe_executable(&ready_exe) {
        unblock_windows_executable(&ready_exe);

        if let Ok(current_exe) = std::env::current_exe() {
            let update_dir = get_pending_update_dir();
            let bat_path = update_dir.join("apply-update.bat");
            let src_str = ready_exe.to_string_lossy();
            let dst_str = current_exe.to_string_lossy();

            let bat_content = format!(
                "@echo off\r\n\
         chcp 65001 >nul\r\n\
         ping 127.0.0.1 -n 3 >nul\r\n\
         powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command \"Unblock-File -LiteralPath '{}' -ErrorAction SilentlyContinue\"\r\n\
         :retry\r\n\
         move /Y \"{}\" \"{}\" >nul 2>&1\r\n\
         if errorlevel 1 (\r\n\
           ping 127.0.0.1 -n 2 >nul\r\n\
           goto retry\r\n\
         )\r\n\
         powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command \"Unblock-File -LiteralPath '{}' -ErrorAction SilentlyContinue\"\r\n\
         start \"\" \"{}\"\r\n\
         del \"%~f0\" >nul 2>&1\r\n",
                src_str.replace('\'', "''"),
                src_str,
                dst_str,
                dst_str.replace('\'', "''"),
                dst_str
            );

            if fs::write(&bat_path, bat_content).is_ok() {
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    let _ = std::process::Command::new("cmd.exe")
                        .creation_flags(CREATE_NO_WINDOW)
                        .args(["/C", &bat_path.to_string_lossy()])
                        .spawn();
                }
                std::process::exit(0);
            }
        }
    }
    false
}

#[tauri::command]
fn quit_and_install(app: tauri::AppHandle) {
    if !quit_and_install_impl() {
        app.restart();
    }
}

fn bind_available_listener() -> StdTcpListener {
    for port in [3000u16, 39281u16, 0u16] {
        if let Ok(listener) = StdTcpListener::bind(("127.0.0.1", port)) {
            let _ = listener.set_nonblocking(true);
            return listener;
        }
    }
    panic!("Failed to bind local HTTP server socket");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let std_listener = bind_available_listener();
    let port = std_listener.local_addr().map(|a| a.port()).unwrap_or(3000);

    tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      select_folder,
      open_path,
      open_external,
      set_downloads_active,
      relaunch,
      get_app_info,
      get_power_state,
      check_for_updates,
      start_download_update,
      quit_and_install,
    ])
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Start embedded Rust Axum server on Tauri's Tokio runtime
      tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(std_listener)
          .expect("Failed to convert std TcpListener to tokio TcpListener");
        let state = server::AppState::new();
        let router = server::build_router(state);
        let _ = axum::serve(listener, router).await;
      });

      let app_url: tauri::Url = format!("http://127.0.0.1:{}", port)
        .parse()
        .expect("Valid localhost URL");

      let _main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url))
        .title("Canvas Horizon")
        .inner_size(1380.0, 900.0)
        .min_inner_size(1024.0, 700.0)
        .center()
        .build()?;

      // Lightweight battery status monitor (polls OS kernel power struct every 15s, zero CPU impact)
      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let mut last_battery = server::check_windows_battery_power();
        loop {
          tokio::time::sleep(Duration::from_secs(15)).await;
          let current = server::check_windows_battery_power();
          if current != last_battery {
            last_battery = current;
            if let Some(win) = app_handle.get_webview_window("main") {
              let js = format!(
                "if (window.__dispatchPowerStateChange) {{ window.__dispatchPowerStateChange({{ onBattery: {} }}); }}",
                if current { "true" } else { "false" }
              );
              let _ = win.eval(&js);
            }
          }
        }
      });

      // Automatic update check 5 seconds after launch in release builds
      if !cfg!(debug_assertions) {
        let update_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          tokio::time::sleep(Duration::from_secs(5)).await;
          let _ = check_for_updates(update_handle).await;
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running Canvas Horizon Tauri application");
}
