use crate::canvas::{CanvasService, UploadFilePayload, now_ms};
use crate::config::{ConfigPatch, get_config_dir, load_config, mask_token, save_config};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

pub const APP_VERSION: &str = "1.4.8";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub status: String,
    pub progress: f64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "completedFiles")]
    pub completed_files: usize,
    #[serde(rename = "totalFiles")]
    pub total_files: usize,
    #[serde(rename = "completedCount")]
    pub completed_count: usize,
    #[serde(rename = "totalCount")]
    pub total_count: usize,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    #[serde(rename = "saveDir")]
    pub save_dir: Option<String>,
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    #[serde(rename = "fullPath")]
    pub full_path: Option<String>,
    #[serde(rename = "savedFiles")]
    pub saved_files: Vec<String>,
    pub message: String,
    pub error: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub canvas: CanvasService,
    pub pdf_cache_dir: PathBuf,
    pub jobs: Arc<Mutex<Vec<DownloadJob>>>,
    pub cancelled_jobs: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl AppState {
    pub fn new() -> Self {
        let pdf_cache_dir = get_config_dir().join("pdf_cache");
        let _ = fs::create_dir_all(&pdf_cache_dir);
        let dir_for_cleanup = pdf_cache_dir.clone();
        std::thread::spawn(move || {
            purge_invalid_pdf_cache(&dir_for_cleanup);
        });

        Self {
            canvas: CanvasService::new(),
            pdf_cache_dir,
            jobs: Arc::new(Mutex::new(Vec::new())),
            cancelled_jobs: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    pub fn clear_pdf_cache(&self) {
        if let Ok(entries) = fs::read_dir(&self.pdf_cache_dir) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub fn update_job<F: FnOnce(&mut DownloadJob)>(&self, job_id: &str, f: F) {
        if let Ok(mut guard) = self.jobs.lock() {
            if let Some(job) = guard.iter_mut().find(|j| j.id == job_id) {
                f(job);
            }
        }
    }

    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.cancelled_jobs
            .lock()
            .map(|s| s.contains(job_id))
            .unwrap_or(false)
    }
}

pub fn is_valid_pdf_file(path: &StdPath) -> bool {
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = f.metadata() else {
        return false;
    };
    if meta.len() < 8 {
        return false;
    }
    let mut buf = [0u8; 5];
    if f.read_exact(&mut buf).is_err() {
        return false;
    }
    &buf == b"%PDF-"
}

pub fn purge_invalid_pdf_cache(dir: &StdPath) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() && !is_valid_pdf_file(&p) {
            let _ = fs::remove_file(p);
        }
    }
}

pub fn ext_to_mime(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        ".pdf" => Some("application/pdf"),
        ".docx" | ".docs" => {
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        }
        ".doc" => Some("application/msword"),
        ".docm" => Some("application/vnd.ms-word.document.macroEnabled.12"),
        ".dotx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.template"),
        ".dotm" => Some("application/vnd.ms-word.template.macroEnabled.12"),
        ".xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ".xls" => Some("application/vnd.ms-excel"),
        ".xlsm" => Some("application/vnd.ms-excel.sheet.macroEnabled.12"),
        ".xlsb" => Some("application/vnd.ms-excel.sheet.binary.macroEnabled.12"),
        ".pptx" => {
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
        }
        ".ppt" => Some("application/vnd.ms-powerpoint"),
        ".pptm" => Some("application/vnd.ms-powerpoint.presentation.macroEnabled.12"),
        ".ppsx" => Some("application/vnd.openxmlformats-officedocument.presentationml.slideshow"),
        ".odt" => Some("application/vnd.oasis.opendocument.text"),
        ".ods" => Some("application/vnd.oasis.opendocument.spreadsheet"),
        ".odp" => Some("application/vnd.oasis.opendocument.presentation"),
        ".pages" => Some("application/vnd.apple.pages"),
        ".numbers" => Some("application/vnd.apple.numbers"),
        ".key" => Some("application/vnd.apple.keynote"),
        ".rtf" => Some("application/rtf"),
        ".zip" => Some("application/zip"),
        ".7z" => Some("application/x-7z-compressed"),
        ".rar" => Some("application/vnd.rar"),
        ".tar" => Some("application/x-tar"),
        ".gz" | ".tgz" => Some("application/gzip"),
        ".csv" => Some("text/csv; charset=utf-8"),
        ".tsv" => Some("text/tab-separated-values; charset=utf-8"),
        ".txt" | ".log" | ".py" | ".java" | ".c" | ".cpp" | ".h" | ".hpp" | ".cs" | ".go"
        | ".rs" | ".rb" | ".php" | ".sh" | ".bat" | ".ps1" | ".sql" | ".yaml" | ".yml"
        | ".toml" | ".ini" | ".r" | ".tex" | ".js" | ".ts" => Some("text/plain; charset=utf-8"),
        ".md" => Some("text/markdown; charset=utf-8"),
        ".json" | ".ipynb" => Some("application/json; charset=utf-8"),
        ".xml" => Some("application/xml; charset=utf-8"),
        ".html" | ".htm" => Some("text/html; charset=utf-8"),
        ".css" => Some("text/css; charset=utf-8"),
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        ".svg" => Some("image/svg+xml"),
        ".bmp" => Some("image/bmp"),
        ".ico" => Some("image/x-icon"),
        ".mp4" | ".m4v" => Some("video/mp4"),
        ".webm" => Some("video/webm"),
        ".mov" => Some("video/quicktime"),
        ".mkv" => Some("video/x-matroska"),
        ".avi" => Some("video/x-msvideo"),
        ".mp3" => Some("audio/mpeg"),
        ".wav" => Some("audio/wav"),
        ".m4a" => Some("audio/mp4"),
        ".ogg" => Some("audio/ogg"),
        ".flac" => Some("audio/flac"),
        _ => None,
    }
}

pub fn mime_to_ext(mime: &str) -> Option<&'static str> {
    let clean = mime.split(';').next().unwrap_or("").trim().to_lowercase();
    match clean.as_str() {
        "application/pdf" => Some(".pdf"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some(".docx"),
        "application/msword" => Some(".doc"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some(".xlsx"),
        "application/vnd.ms-excel" => Some(".xls"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => {
            Some(".pptx")
        }
        "application/vnd.ms-powerpoint" => Some(".ppt"),
        "application/vnd.oasis.opendocument.text" => Some(".odt"),
        "application/vnd.oasis.opendocument.spreadsheet" => Some(".ods"),
        "application/vnd.oasis.opendocument.presentation" => Some(".odp"),
        "application/rtf" => Some(".rtf"),
        "application/zip" | "application/x-zip-compressed" => Some(".zip"),
        "application/x-7z-compressed" => Some(".7z"),
        "application/vnd.rar" | "application/x-rar-compressed" => Some(".rar"),
        "application/x-tar" => Some(".tar"),
        "application/gzip" | "application/x-gzip" => Some(".gz"),
        "text/csv" => Some(".csv"),
        "text/tab-separated-values" => Some(".tsv"),
        "text/plain" => Some(".txt"),
        "text/markdown" => Some(".md"),
        "application/json" => Some(".json"),
        "application/xml" | "text/xml" => Some(".xml"),
        "text/html" => Some(".html"),
        "image/png" => Some(".png"),
        "image/jpeg" => Some(".jpg"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        "image/svg+xml" => Some(".svg"),
        "image/bmp" => Some(".bmp"),
        "video/mp4" | "application/mp4" => Some(".mp4"),
        "video/webm" => Some(".webm"),
        "video/quicktime" => Some(".mov"),
        "video/x-matroska" => Some(".mkv"),
        "audio/mpeg" => Some(".mp3"),
        "audio/wav" | "audio/x-wav" => Some(".wav"),
        "audio/mp4" => Some(".m4a"),
        "audio/ogg" => Some(".ogg"),
        "audio/flac" => Some(".flac"),
        _ => None,
    }
}

static RE_FILENAME_STAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;\r\n]+)").unwrap());
static RE_FILENAME_QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)filename\s*=\s*"([^"]+)""#).unwrap());
static RE_DOUBLE_PDF_EXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\.(docx?|docs|docm|dotx|dotm|xlsx?|xlsm|xlsb|pptx?|pptm|ppsx|odt|ods|odp|pages|numbers|key|rtf|zip|7z|rar|tar|gz|tgz|bz2|xz|csv|tsv|txt|log|md|json|ipynb|xml|html?|css|js|ts|jsx|tsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|sh|bat|ps1|sql|yaml|yml|toml|ini|r|tex|bib|png|jpe?g|gif|webp|svg|bmp|ico|mp4|m4v|webm|mov|mkv|avi|mp3|wav|m4a|ogg|flac|dwg|dxf|stl|obj|fbx|blend|psd|ai|eps|indd|fig|sketch|sqlite3?|db|mdb|accdb|mat|sav|dta|rds|rdata|parquet|feather|arrow|h5|hdf5|nc)\.pdf$",
    )
    .unwrap()
});

pub fn extract_filename_from_content_disposition(disposition: &str) -> Option<String> {
    if let Some(caps) = RE_FILENAME_STAR.captures(disposition) {
        if let Some(m) = caps.get(1) {
            let raw = m.as_str().trim().trim_matches(|c| c == '"' || c == '\'');
            if let Ok(dec) = urlencoding::decode(raw) {
                return Some(dec.into_owned());
            }
        }
    }
    if let Some(caps) = RE_FILENAME_QUOTED.captures(disposition) {
        if let Some(m) = caps.get(1) {
            let raw = m.as_str().trim();
            return Some(
                urlencoding::decode(raw)
                    .map(|d| d.into_owned())
                    .unwrap_or_else(|_| raw.to_string()),
            );
        }
    }
    None
}

pub fn strip_double_pdf_ext(name: &str) -> String {
    let mut result = name.to_string();
    for _ in 0..3 {
        let next = RE_DOUBLE_PDF_EXT.replace(&result, ".$1").into_owned();
        if next == result {
            break;
        }
        result = next;
    }
    result
}

pub fn normalize_download_file_name(
    raw_name: Option<&str>,
    file_data: Option<&Value>,
    content_disposition: Option<&str>,
    response_content_type: Option<&str>,
) -> String {
    let mut name = raw_name
        .unwrap_or("")
        .replace(['\r', '\n', '\t'], " ")
        .trim()
        .to_string();
    if !name.is_empty() {
        name = strip_double_pdf_ext(&name);
    }

    let cd_name = content_disposition.and_then(extract_filename_from_content_disposition);
    let api_name = file_data.and_then(|fd| {
        fd.get("display_name")
            .or_else(|| fd.get("displayName"))
            .or_else(|| fd.get("filename"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });
    let canonical_name = api_name.or(cd_name).unwrap_or_default().trim().to_string();

    let is_generic = name.is_empty()
        || matches!(
            name.to_lowercase().as_str(),
            "file.pdf" | "document.pdf" | "download" | "file" | "添付ファイル"
        );
    if is_generic && !canonical_name.is_empty() {
        name = strip_double_pdf_ext(&canonical_name);
    }

    if name.is_empty() {
        name = "download".to_string();
    }

    let current_ext = StdPath::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    let canonical_ext = StdPath::new(&canonical_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();

    let raw_mime = response_content_type
        .or_else(|| {
            file_data.and_then(|fd| {
                fd.get("content-type")
                    .or_else(|| fd.get("content_type"))
                    .and_then(|v| v.as_str())
            })
        })
        .unwrap_or("");
    let mime_ext = mime_to_ext(raw_mime).unwrap_or("");

    if current_ext == ".pdf" {
        if !canonical_ext.is_empty() && canonical_ext != ".pdf" {
            name = format!("{}{}", &name[..name.len() - 4], canonical_ext);
        } else if !mime_ext.is_empty() && mime_ext != ".pdf" {
            name = format!("{}{}", &name[..name.len() - 4], mime_ext);
        }
    } else if current_ext.is_empty() {
        if !canonical_ext.is_empty() {
            name.push_str(&canonical_ext);
        } else if !mime_ext.is_empty() {
            name.push_str(mime_ext);
        }
    }

    sanitize_file_name(&name)
}

pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_content_type(
    file_name: &str,
    upstream_content_type: &str,
    is_pdf: bool,
    is_video: bool,
) -> String {
    let ext = StdPath::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    if let Some(mapped) = ext_to_mime(&ext) {
        return mapped.to_string();
    }
    let clean_up = upstream_content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !clean_up.is_empty()
        && clean_up != "application/octet-stream"
        && clean_up != "binary/octet-stream"
    {
        return upstream_content_type.to_string();
    }
    if is_pdf {
        return "application/pdf".to_string();
    }
    if is_video {
        return "video/mp4".to_string();
    }
    "application/octet-stream".to_string()
}

pub fn normalize_canvas_file_url(raw_url: &str, base_url: &str, verifier: Option<&str>) -> String {
    let mut target = raw_url.trim().to_string();
    if target.is_empty() {
        return target;
    }
    let clean_base = base_url.trim_end_matches('/');
    if target.starts_with('/') && !clean_base.is_empty() {
        target = format!("{}{}", clean_base, target);
    }
    if let Ok(mut parsed) = url::Url::parse(&target) {
        let mut pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(k, _)| k != "wrap")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();

        if let Some(v) = verifier.filter(|s| !s.is_empty()) {
            if !pairs.iter().any(|(k, _)| k == "verifier") {
                pairs.push(("verifier".to_string(), v.to_string()));
            }
        }

        let path_str = parsed.path().to_string();
        let files_re = Regex::new(r"/files/(\d+)$").unwrap();
        if files_re.is_match(&path_str) && !path_str.contains("/api/v1/") {
            parsed.set_path(&format!("{}/download", path_str));
            if !pairs.iter().any(|(k, _)| k == "download_frd") {
                pairs.push(("download_frd".to_string(), "1".to_string()));
            }
        } else if path_str.contains("/files/") && path_str.ends_with("/download") {
            if !pairs.iter().any(|(k, _)| k == "download_frd") {
                pairs.push(("download_frd".to_string(), "1".to_string()));
            }
        }

        parsed.query_pairs_mut().clear().extend_pairs(pairs);
        return parsed.to_string();
    }
    target
}

pub fn compare_semver(a: &str, b: &str) -> i32 {
    let clean_a = a.trim().trim_start_matches(['v', 'V']);
    let clean_b = b.trim().trim_start_matches(['v', 'V']);
    let parts_a: Vec<u64> = clean_a
        .split(['.', '-'])
        .take(3)
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    let parts_b: Vec<u64> = clean_b
        .split(['.', '-'])
        .take(3)
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    for i in 0..3 {
        let va = parts_a.get(i).copied().unwrap_or(0);
        let vb = parts_b.get(i).copied().unwrap_or(0);
        if va > vb {
            return 1;
        }
        if va < vb {
            return -1;
        }
    }
    0
}

// ============================================================================
// Route Handlers
// ============================================================================

async fn api_get_config() -> Json<Value> {
    let cfg = load_config();
    let is_configured = !cfg.base_url.is_empty() && !cfg.api_token.is_empty();
    let config_obj = json!({
      "baseUrl": cfg.base_url,
      "apiToken": cfg.api_token,
      "hasToken": !cfg.api_token.is_empty(),
      "isConfigured": is_configured,
      "maskedToken": mask_token(&cfg.api_token),
      "downloadDir": cfg.download_dir,
      "autoDownloadFolder": cfg.auto_download_folder,
      "currentQuarter": cfg.current_quarter,
      "theme": cfg.theme,
      "batteryMode": cfg.battery_mode,
      "batterySaver": cfg.battery_saver,
      "pollIntervalMin": cfg.poll_interval_min,
      "githubRepo": cfg.github_repo,
    });
    Json(json!({
      "success": true,
      "config": config_obj,
      "baseUrl": cfg.base_url,
      "apiToken": cfg.api_token,
      "hasToken": !cfg.api_token.is_empty(),
      "isConfigured": is_configured,
      "maskedToken": mask_token(&cfg.api_token),
      "downloadDir": cfg.download_dir,
      "autoDownloadFolder": cfg.auto_download_folder,
      "currentQuarter": cfg.current_quarter,
      "theme": cfg.theme,
      "batteryMode": cfg.battery_mode,
      "batterySaver": cfg.battery_saver,
    }))
}

async fn api_post_config(State(state): State<AppState>, Json(payload): Json<Value>) -> Json<Value> {
    let prev = load_config();
    let mut patch = ConfigPatch::default();

    if let Some(u) = payload.get("baseUrl").and_then(|v| v.as_str()) {
        let trimmed = u.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            patch.base_url = Some(trimmed);
        }
    }
    if let Some(t) = payload.get("apiToken").and_then(|v| v.as_str()) {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() && !trimmed.contains('•') {
            patch.api_token = Some(trimmed);
        }
    }
    if let Some(d) = payload.get("downloadDir").and_then(|v| v.as_str()) {
        let trimmed = d.trim().to_string();
        if !trimmed.is_empty() {
            let _ = fs::create_dir_all(&trimmed);
            patch.download_dir = Some(trimmed);
        }
    }
    if let Some(q) = payload.get("currentQuarter").and_then(|v| v.as_str()) {
        patch.current_quarter = Some(q.trim().to_string());
    }
    if let Some(th) = payload.get("theme").and_then(|v| v.as_str()) {
        if th == "dark" || th == "light" {
            patch.theme = Some(th.to_string());
        }
    }
    if let Some(bm) = payload.get("batteryMode").and_then(|v| v.as_str()) {
        if matches!(bm, "auto" | "on" | "off") {
            patch.battery_mode = Some(bm.to_string());
        }
    }
    if let Some(bs) = payload.get("batterySaver").and_then(|v| v.as_bool()) {
        patch.battery_saver = Some(bs);
    }

    let saved = save_config(patch);
    let connection_changed = prev.base_url != saved.base_url || prev.api_token != saved.api_token;
    let quarter_changed = prev.current_quarter != saved.current_quarter;

    if connection_changed {
        state.canvas.clear_all_cache(false);
    } else if quarter_changed {
        state.canvas.clear_all_cache(true);
    }

    let is_configured = !saved.base_url.is_empty() && !saved.api_token.is_empty();
    Json(json!({
      "success": true,
      "config": {
        "baseUrl": saved.base_url,
        "apiToken": saved.api_token,
        "hasToken": !saved.api_token.is_empty(),
        "isConfigured": is_configured,
        "maskedToken": mask_token(&saved.api_token),
        "downloadDir": saved.download_dir,
        "autoDownloadFolder": saved.auto_download_folder,
        "currentQuarter": saved.current_quarter,
        "theme": saved.theme,
        "batteryMode": saved.battery_mode,
        "batterySaver": saved.battery_saver,
        "pollIntervalMin": saved.poll_interval_min,
        "githubRepo": saved.github_repo,
      }
    }))
}

async fn api_clear_cache(State(state): State<AppState>) -> Json<Value> {
    state.canvas.clear_all_cache(true);
    state.clear_pdf_cache();
    Json(json!({ "success": true, "message": "キャッシュをクリアしました" }))
}

async fn api_check_update(State(state): State<AppState>) -> Json<Value> {
    let checked_at = now_ms();
    let current_ver = format!("v{}", APP_VERSION);
    let url = "https://api.github.com/repos/shizengakari/CanvasLMS-Horizon/releases/latest";
    let res = state
        .canvas
        .client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "CanvasHorizon-Updater")
        .timeout(Duration::from_secs(6))
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(data) = resp.json::<Value>().await {
                let latest_raw = data.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
                let latest_version = latest_raw.trim().trim_start_matches(['v', 'V']);
                let is_newer =
                    !latest_version.is_empty() && compare_semver(latest_version, APP_VERSION) > 0;
                let html_url = data
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("https://github.com/shizengakari/CanvasLMS-Horizon/releases/latest");
                return Json(json!({
                  "success": true,
                  "hasUpdate": is_newer,
                  "updateAvailable": is_newer,
                  "currentVersion": current_ver,
                  "latestVersion": if latest_raw.is_empty() { current_ver } else { latest_raw.to_string() },
                  "releaseName": data.get("name").and_then(|v| v.as_str()).unwrap_or(latest_raw),
                  "downloadUrl": html_url,
                  "releaseUrl": html_url,
                  "releaseNotes": data.get("body").and_then(|v| v.as_str()).unwrap_or(""),
                  "publishedAt": data.get("published_at").cloned().unwrap_or(Value::Null),
                  "checkedAt": checked_at,
                }));
            }
        }
        _ => {}
    }

    Json(json!({
      "success": true,
      "hasUpdate": false,
      "updateAvailable": false,
      "currentVersion": current_ver,
      "latestVersion": current_ver,
      "downloadUrl": "https://github.com/shizengakari/CanvasLMS-Horizon/releases/latest",
      "releaseUrl": "https://github.com/shizengakari/CanvasLMS-Horizon/releases/latest",
      "checkedAt": checked_at,
    }))
}

async fn api_get_profile(State(state): State<AppState>) -> Json<Value> {
    let cfg = load_config();
    let is_configured = !cfg.base_url.is_empty() && !cfg.api_token.is_empty();
    let config_payload = json!({
      "baseUrl": cfg.base_url,
      "apiToken": cfg.api_token,
      "hasToken": !cfg.api_token.is_empty(),
      "isConfigured": is_configured,
      "theme": cfg.theme,
      "currentQuarter": cfg.current_quarter,
      "batteryMode": cfg.battery_mode,
      "batterySaver": cfg.battery_saver,
      "pollIntervalMin": cfg.poll_interval_min,
      "downloadDir": cfg.download_dir,
    });

    if !is_configured {
        return Json(json!({
          "success": true,
          "profile": Value::Null,
          "config": config_payload,
        }));
    }

    match state.canvas.get_profile(false).await {
        Ok(profile) => Json(json!({
          "success": true,
          "profile": profile,
          "config": config_payload,
        })),
        Err(err) => Json(json!({
          "success": false,
          "error": err,
          "config": config_payload,
        })),
    }
}

async fn api_get_courses(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_courses(force).await {
        Ok(courses) => Json(json!({ "success": true, "courses": courses })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_course_assignments(
    State(state): State<AppState>,
    Path(course_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    let include_old = params
        .get("includeOld")
        .map(|v| v == "true")
        .unwrap_or(false);
    match state
        .canvas
        .get_assignments(&course_id, force, include_old)
        .await
    {
        Ok(assignments) => Json(json!({ "success": true, "assignments": assignments })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_all_assignments(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_all_assignments(force).await {
        Ok(assignments) => Json(json!({ "success": true, "assignments": assignments })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_timeline(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_timeline(force).await {
        Ok(timeline) => Json(json!({
          "success": true,
          "assignments": timeline,
          "timeline": timeline,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_course_modules(
    State(state): State<AppState>,
    Path(course_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_modules(&course_id, force).await {
        Ok(modules) => Json(json!({ "success": true, "modules": modules })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_course_files(
    State(state): State<AppState>,
    Path(course_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_course_files(&course_id, force).await {
        Ok(files) => Json(json!({ "success": true, "files": files })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_materials_grouped(
    State(state): State<AppState>,
    Path(course_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state
        .canvas
        .get_course_materials_grouped(&course_id, force)
        .await
    {
        Ok(grouped) => Json(json!({
          "success": true,
          "modules": grouped,
          "groupedMaterials": grouped,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_course_discussions(
    State(state): State<AppState>,
    Path(course_id): Path<String>,
) -> Json<Value> {
    match state.canvas.get_course_discussions(&course_id).await {
        Ok(discussions) => Json(json!({ "success": true, "discussions": discussions })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_discussion_topic(
    State(state): State<AppState>,
    Path((course_id, topic_id)): Path<(String, String)>,
) -> Json<Value> {
    match state
        .canvas
        .get_discussion_topic(&course_id, &topic_id)
        .await
    {
        Ok(discussion) => Json(json!({
          "success": true,
          "page": discussion,
          "discussion": discussion,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_page(
    State(state): State<AppState>,
    Path((course_id, page_url)): Path<(String, String)>,
) -> Json<Value> {
    match state.canvas.get_page(&course_id, &page_url).await {
        Ok(page) => Json(json!({ "success": true, "page": page })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_announcements(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let force = params.get("refresh").map(|v| v == "true").unwrap_or(false);
    match state.canvas.get_announcements(force).await {
        Ok(announcements) => Json(json!({ "success": true, "announcements": announcements })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_get_file_meta(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let mut file_id = params
        .get("id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut course_id = params
        .get("courseId")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let target_url = params
        .get("url")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let raw_name = params.get("name").map(|s| s.trim().to_string());

    if file_id.is_empty() && !target_url.is_empty() {
        if let Ok(re) = Regex::new(r"/files/(\d+)") {
            if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                file_id = c.as_str().to_string();
            }
        }
    }
    if course_id.is_empty() && !target_url.is_empty() {
        if let Ok(re) = Regex::new(r"/courses/(\d+)") {
            if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                course_id = c.as_str().to_string();
            }
        }
    }

    let file_data = if !file_id.is_empty() {
        state
            .canvas
            .resolve_file_download(
                &file_id,
                if course_id.is_empty() {
                    None
                } else {
                    Some(&course_id)
                },
            )
            .await
            .ok()
    } else {
        None
    };

    let display_name =
        normalize_download_file_name(raw_name.as_deref(), file_data.as_ref(), None, None);
    let upstream_ct = file_data
        .as_ref()
        .and_then(|fd| {
            fd.get("content-type")
                .or_else(|| fd.get("content_type"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");
    let content_type = resolve_content_type(
        &display_name,
        upstream_ct,
        display_name.to_lowercase().ends_with(".pdf"),
        false,
    );

    let is_locked = file_data
        .as_ref()
        .map(|fd| {
            fd.get("locked_for_user")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || fd
                    .get("hidden_for_user")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
        })
        .unwrap_or(false);

    let file_payload = json!({
      "id": if file_id.is_empty() { Value::Null } else { json!(file_id) },
      "displayName": display_name,
      "filename": file_data.as_ref().and_then(|fd| fd.get("filename").or_else(|| fd.get("display_name"))).cloned().unwrap_or_else(|| json!(display_name)),
      "contentType": content_type,
      "size": file_data.as_ref().and_then(|fd| fd.get("size")).and_then(|v| v.as_u64()).unwrap_or(0),
      "url": file_data.as_ref().and_then(|fd| fd.get("url")).cloned().unwrap_or_else(|| if target_url.is_empty() { Value::Null } else { json!(target_url) }),
      "isLocked": is_locked,
      "lockExplanation": file_data.as_ref().and_then(|fd| fd.get("lock_explanation").or_else(|| fd.get("lock_info").and_then(|li| li.get("lock_explanation")))).cloned().unwrap_or(Value::Null),
      "unlockAt": file_data.as_ref().and_then(|fd| fd.get("unlock_at").or_else(|| fd.get("lock_info").and_then(|li| li.get("unlock_at")))).cloned().unwrap_or(Value::Null),
    });

    Json(json!({
      "success": true,
      "id": file_payload.get("id").cloned().unwrap_or(Value::Null),
      "displayName": file_payload.get("displayName").cloned().unwrap_or(Value::Null),
      "filename": file_payload.get("filename").cloned().unwrap_or(Value::Null),
      "contentType": file_payload.get("contentType").cloned().unwrap_or(Value::Null),
      "size": file_payload.get("size").cloned().unwrap_or(json!(0)),
      "url": file_payload.get("url").cloned().unwrap_or(Value::Null),
      "isLocked": is_locked,
      "lockExplanation": file_payload.get("lockExplanation").cloned().unwrap_or(Value::Null),
      "unlockAt": file_payload.get("unlockAt").cloned().unwrap_or(Value::Null),
      "file": file_payload,
    }))
}

fn serve_local_file_with_range(
    file_path: &StdPath,
    content_type: &str,
    disposition: &str,
    range_header: Option<&str>,
) -> Result<Response, String> {
    let mut file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let total_size = file.metadata().map_err(|e| e.to_string())?.len();

    if let Some(range_str) = range_header.and_then(|r| r.strip_prefix("bytes=")) {
        let parts: Vec<&str> = range_str.split('-').collect();
        let start = parts
            .first()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let end = parts
            .get(1)
            .and_then(|s| {
                if s.is_empty() {
                    None
                } else {
                    s.parse::<u64>().ok()
                }
            })
            .unwrap_or_else(|| total_size.saturating_sub(1))
            .min(total_size.saturating_sub(1));

        if start < total_size && start <= end {
            let chunk_len = end - start + 1;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; chunk_len as usize];
            file.read_exact(&mut buf).map_err(|e| e.to_string())?;

            return Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CONTENT_DISPOSITION, disposition)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, chunk_len.to_string())
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", start, end, total_size),
                )
                .header(header::CACHE_CONTROL, "public, max-age=86400")
                .body(Body::from(buf))
                .map_err(|e| e.to_string());
        }
    }

    let mut buf = Vec::with_capacity(total_size as usize);
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, total_size.to_string())
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(buf))
        .map_err(|e| e.to_string())
}

async fn ensure_pdf_cached(
    state: &AppState,
    file_id: &str,
    target_url: Option<&str>,
    course_id: Option<&str>,
) -> Result<PathBuf, String> {
    let cached_path = state.pdf_cache_dir.join(format!("{}.pdf", file_id));
    if cached_path.exists() {
        if is_valid_pdf_file(&cached_path) {
            return Ok(cached_path);
        }
        let _ = fs::remove_file(&cached_path);
    }

    let cfg = load_config();
    let mut download_url = target_url.unwrap_or("").to_string();
    if file_id != "" {
        if let Ok(fd) = state.canvas.resolve_file_download(file_id, course_id).await {
            if let Some(u) = fd.get("url").and_then(|v| v.as_str()) {
                download_url = u.to_string();
            }
        }
    }
    download_url = normalize_canvas_file_url(&download_url, &cfg.base_url, None);
    if download_url.is_empty() {
        return Err("Could not resolve PDF download URL".to_string());
    }

    let canvas_host = url::Url::parse(&cfg.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let target_host = url::Url::parse(&download_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let mut req = state.canvas.client.get(&download_url);
    if !canvas_host.is_empty() && canvas_host == target_host && !cfg.api_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_token));
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 8 || &bytes[..5] != b"%PDF-" {
        return Err("Downloaded payload is not a valid PDF".to_string());
    }

    let temp_path = state
        .pdf_cache_dir
        .join(format!("{}.{}.tmp", file_id, now_ms()));
    fs::write(&temp_path, &bytes).map_err(|e| e.to_string())?;
    let _ = fs::rename(&temp_path, &cached_path);
    Ok(cached_path)
}

async fn api_download_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let mut target_url = params
        .get("url")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut file_id = params
        .get("id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut course_id = params
        .get("courseId")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let mut file_name = params
        .get("name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let inline = params.get("inline").map(|s| s == "true").unwrap_or(false);
    let disposition_type = if inline { "inline" } else { "attachment" };
    let mut verifier = params
        .get("verifier")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if !target_url.is_empty() {
        if file_id.is_empty() {
            if let Ok(re) = Regex::new(r"/files/(\d+)") {
                if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                    file_id = c.as_str().to_string();
                }
            }
        }
        if course_id.is_empty() {
            if let Ok(re) = Regex::new(r"/courses/(\d+)") {
                if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                    course_id = c.as_str().to_string();
                }
            }
        }
        if verifier.is_empty() {
            if let Ok(re) = Regex::new(r"[?&]verifier=([a-zA-Z0-9\-_]+)") {
                if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                    verifier = c.as_str().to_string();
                }
            }
        }
    }

    if let Some(ref name_str) = file_name {
        file_name = Some(normalize_download_file_name(
            Some(name_str),
            None,
            None,
            None,
        ));
    }

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    // Fast path: Valid cached PDF
    if !file_id.is_empty() {
        let cached_path = state.pdf_cache_dir.join(format!("{}.pdf", file_id));
        if cached_path.exists() {
            if is_valid_pdf_file(&cached_path) {
                let pdf_name = file_name
                    .as_deref()
                    .filter(|n| n.to_lowercase().ends_with(".pdf"))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}.pdf", file_id));
                let disp = format!(
                    "{}; filename*=UTF-8''{}",
                    disposition_type,
                    urlencoding::encode(&pdf_name)
                );
                if let Ok(resp) = serve_local_file_with_range(
                    &cached_path,
                    "application/pdf",
                    &disp,
                    range_header,
                ) {
                    return resp;
                }
            } else {
                let _ = fs::remove_file(&cached_path);
            }
        }
    }

    let cfg = load_config();
    let mut file_data: Option<Value> = None;
    if !file_id.is_empty() {
        if let Ok(fd) = state
            .canvas
            .resolve_file_download(
                &file_id,
                if course_id.is_empty() {
                    None
                } else {
                    Some(&course_id)
                },
            )
            .await
        {
            if let Some(u) = fd.get("url").and_then(|v| v.as_str()) {
                target_url = u.to_string();
            }
            file_name = Some(normalize_download_file_name(
                file_name.as_deref(),
                Some(&fd),
                None,
                None,
            ));
            file_data = Some(fd);
        }
    }

    if !target_url.is_empty() {
        target_url = normalize_canvas_file_url(
            &target_url,
            &cfg.base_url,
            if verifier.is_empty() {
                None
            } else {
                Some(&verifier)
            },
        );
    } else if !file_id.is_empty() && !verifier.is_empty() && !cfg.base_url.is_empty() {
        target_url = format!(
            "{}/files/{}/download?download_frd=1&verifier={}",
            cfg.base_url.trim_end_matches('/'),
            file_id,
            urlencoding::encode(&verifier)
        );
    }

    if target_url.is_empty() {
        if let Some(ref fd) = file_data {
            let locked = fd
                .get("locked_for_user")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || fd
                    .get("hidden_for_user")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            if locked {
                let lock_msg = fd
                    .get("lock_explanation")
                    .or_else(|| {
                        fd.get("lock_info")
                            .and_then(|li| li.get("lock_explanation"))
                    })
                    .and_then(|v| v.as_str())
                    .unwrap_or("このファイルは現在Canvas上でロックされています。");
                if inline {
                    let html = format!(
                        "<!DOCTYPE html><html lang=\"ja\"><head><meta charset=\"utf-8\"><style>body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111420;color:#e2e8f0;font-family:sans-serif;padding:24px;box-sizing:border-box}}.card{{max-width:460px;background:#1a1f32;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:28px;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,0.4)}}.lock-icon{{width:44px;height:44px;margin:0 auto;border-radius:12px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.35);color:#fbbf24;display:flex;align-items:center;justify-content:center}}h3{{margin:14px 0 8px;font-size:16px}}p{{margin:0;font-size:13.5px;color:#94a3b8;line-height:1.6}}</style></head><body><div class=\"card\"><div class=\"lock-icon\"><svg width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z\"/></svg></div><h3>ファイルはロックされています</h3><p>{}</p></div></body></html>",
                        lock_msg.replace('<', "&lt;")
                    );
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(Body::from(html))
                        .unwrap();
                }
                return (StatusCode::FORBIDDEN, lock_msg.to_string()).into_response();
            }
        }
        return (StatusCode::BAD_REQUEST, "Download URL or File ID required").into_response();
    }

    let effective_name = file_name.clone().unwrap_or_else(|| "download".to_string());
    let ext_lower = StdPath::new(&effective_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    let fd_mime = file_data
        .as_ref()
        .and_then(|fd| {
            fd.get("content-type")
                .or_else(|| fd.get("content_type"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_lowercase();

    let is_video = matches!(
        ext_lower.as_str(),
        ".mp4" | ".webm" | ".mkv" | ".mov" | ".m4v" | ".avi"
    ) || fd_mime.starts_with("video/");
    let is_known_non_pdf_ext = !ext_lower.is_empty() && ext_lower != ".pdf";
    let is_known_non_pdf_mime =
        !fd_mime.is_empty() && !fd_mime.contains("pdf") && !fd_mime.contains("octet-stream");
    let is_pdf_request = !is_known_non_pdf_ext
        && !is_known_non_pdf_mime
        && (ext_lower == ".pdf" || fd_mime == "application/pdf");

    if !file_id.is_empty() && is_pdf_request {
        if let Ok(cached_path) = ensure_pdf_cached(
            &state,
            &file_id,
            Some(&target_url),
            if course_id.is_empty() {
                None
            } else {
                Some(&course_id)
            },
        )
        .await
        {
            let pdf_file_name =
                if effective_name.to_lowercase().ends_with(".pdf") || !ext_lower.is_empty() {
                    effective_name.clone()
                } else {
                    format!("{}.pdf", effective_name)
                };
            let disp = format!(
                "{}; filename*=UTF-8''{}",
                disposition_type,
                urlencoding::encode(&pdf_file_name)
            );
            if let Ok(resp) =
                serve_local_file_with_range(&cached_path, "application/pdf", &disp, range_header)
            {
                return resp;
            }
        }
    }

    let canvas_host = url::Url::parse(&cfg.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let url_host = url::Url::parse(&target_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let mut req = state.canvas.client.get(&target_url);
    if !canvas_host.is_empty() && canvas_host == url_host && !cfg.api_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_token));
    }
    if let Some(r) = range_header {
        req = req.header("Range", r);
    }

    let Ok(upstream) = req.send().await else {
        return (StatusCode::BAD_GATEWAY, "Failed to fetch upstream file").into_response();
    };
    if !upstream.status().is_success() && upstream.status() != StatusCode::PARTIAL_CONTENT {
        return (
            StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            "Upstream file request failed",
        )
            .into_response();
    }

    let resp_disp = upstream
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let resp_ct = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let final_name = normalize_download_file_name(
        file_name.as_deref(),
        file_data.as_ref(),
        resp_disp.as_deref(),
        Some(&resp_ct),
    );
    let actual_is_pdf = final_name.to_lowercase().ends_with(".pdf")
        || resp_ct.to_lowercase().contains("application/pdf");
    let content_type = resolve_content_type(&final_name, &resp_ct, actual_is_pdf, is_video);
    let disp = format!(
        "{}; filename*=UTF-8''{}",
        disposition_type,
        urlencoding::encode(&final_name)
    );

    let status_code = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let content_len = upstream
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let content_range = upstream
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let stream = upstream.bytes_stream();
    let mut builder = Response::builder()
        .status(status_code)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disp)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=86400");

    if let Some(cl) = content_len {
        builder = builder.header(header::CONTENT_LENGTH, cl);
    }
    if let Some(cr) = content_range {
        builder = builder.header(header::CONTENT_RANGE, cr);
    }

    builder.body(Body::from_stream(stream)).unwrap()
}

async fn api_ensure_cache(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let mut file_id = params
        .get("id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let target_url = params
        .get("url")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let course_id = params
        .get("courseId")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let file_name = params
        .get("name")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "document.pdf".to_string());

    if file_id.is_empty() && !target_url.is_empty() {
        if let Ok(re) = Regex::new(r"/files/(\d+)") {
            if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                file_id = c.as_str().to_string();
            }
        }
    }
    if file_id.is_empty() {
        return Json(json!({ "success": false, "error": "File ID required" }));
    }

    match ensure_pdf_cached(
        &state,
        &file_id,
        if target_url.is_empty() {
            None
        } else {
            Some(&target_url)
        },
        if course_id.is_empty() {
            None
        } else {
            Some(&course_id)
        },
    )
    .await
    {
        Ok(path) => Json(json!({
          "success": true,
          "path": path.to_string_lossy(),
          "name": file_name,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn download_one_file_to_disk(
    state: &AppState,
    file_id: Option<&str>,
    raw_url: Option<&str>,
    raw_name: Option<&str>,
    course_id: Option<&str>,
    dest_dir: &StdPath,
    job_id: &str,
) -> Result<PathBuf, String> {
    let cfg = load_config();
    let mut resolved_id = file_id.unwrap_or("").trim().to_string();
    let mut target_url = raw_url.unwrap_or("").trim().to_string();

    if resolved_id.is_empty() && !target_url.is_empty() {
        if let Ok(re) = Regex::new(r"(?:[?&]id=|/files/)(\d+)") {
            if let Some(c) = re.captures(&target_url).and_then(|c| c.get(1)) {
                resolved_id = c.as_str().to_string();
            }
        }
    }

    let mut file_data: Option<Value> = None;
    if !resolved_id.is_empty() {
        if let Ok(fd) = state
            .canvas
            .resolve_file_download(&resolved_id, course_id)
            .await
        {
            if let Some(u) = fd.get("url").and_then(|v| v.as_str()) {
                target_url = u.to_string();
            }
            file_data = Some(fd);
        }
    }

    target_url = normalize_canvas_file_url(&target_url, &cfg.base_url, None);
    if target_url.is_empty() {
        return Err("ダウンロードURLを解決できませんでした。".to_string());
    }

    let canvas_host = url::Url::parse(&cfg.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let url_host = url::Url::parse(&target_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let mut req = state.canvas.client.get(&target_url);
    if !canvas_host.is_empty() && canvas_host == url_host && !cfg.api_token.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_token));
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total_len = resp.content_length().unwrap_or(0);
    let resp_disp = resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let resp_ct = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let final_name = normalize_download_file_name(
        raw_name,
        file_data.as_ref(),
        resp_disp.as_deref(),
        Some(&resp_ct),
    );

    let _ = fs::create_dir_all(dest_dir);
    let save_path = dest_dir.join(&final_name);

    let mut out_file = tokio::fs::File::create(&save_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        if state.is_cancelled(job_id) {
            let _ = tokio::fs::remove_file(&save_path).await;
            return Err("キャンセルされました".to_string());
        }
        let chunk = chunk_res.map_err(|e| e.to_string())?;
        out_file
            .write_all(&chunk)
            .await
            .map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        state.update_job(job_id, |j| {
            j.downloaded_bytes = downloaded;
            if total_len > 0 {
                j.total_bytes = total_len;
                j.progress = ((downloaded as f64 / total_len as f64) * 100.0).min(99.0);
            }
        });
    }
    out_file.flush().await.map_err(|e| e.to_string())?;
    Ok(save_path)
}

async fn api_download_single(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let file_id = payload.get("id").map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    });
    let url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| strip_double_pdf_ext(s))
        .unwrap_or_else(|| "download".to_string());
    let course_id = payload.get("courseId").map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    });

    let cfg = load_config();
    let dest_dir = PathBuf::from(&cfg.download_dir);
    let job_id = format!("dl_{}", now_ms());
    let full_str = dest_dir.join(&name).to_string_lossy().into_owned();

    let job = DownloadJob {
        id: job_id.clone(),
        title: name.clone(),
        job_type: "single-file".to_string(),
        status: "downloading".to_string(),
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        completed_files: 0,
        total_files: 1,
        completed_count: 0,
        total_count: 1,
        save_path: Some(full_str.clone()),
        save_dir: Some(dest_dir.to_string_lossy().into_owned()),
        file_name: Some(name.clone()),
        full_path: Some(full_str),
        saved_files: Vec::new(),
        message: "ダウンロードを開始中...".to_string(),
        error: None,
        created_at: now_ms(),
    };

    if let Ok(mut guard) = state.jobs.lock() {
        guard.insert(0, job.clone());
    }

    let st = state.clone();
    let jid = job_id.clone();
    tokio::spawn(async move {
        match download_one_file_to_disk(
            &st,
            file_id.as_deref(),
            url.as_deref(),
            Some(&name),
            course_id.as_deref(),
            &dest_dir,
            &jid,
        )
        .await
        {
            Ok(saved_path) => {
                let final_file_name = saved_path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(&name)
                    .to_string();
                let saved_full = saved_path.to_string_lossy().into_owned();
                st.update_job(&jid, |j| {
                    j.status = "completed".to_string();
                    j.progress = 100.0;
                    j.completed_files = 1;
                    j.completed_count = 1;
                    j.title = final_file_name.clone();
                    j.file_name = Some(final_file_name.clone());
                    j.save_path = Some(saved_full.clone());
                    j.full_path = Some(saved_full);
                    j.message = format!("保存完了: {}", final_file_name);
                });
            }
            Err(err) => {
                st.update_job(&jid, |j| {
                    j.status = "failed".to_string();
                    j.message = format!("保存失敗: {}", err);
                    j.error = Some(err);
                });
            }
        }
    });

    Json(json!({ "success": true, "job": job }))
}

async fn api_download_batch(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let files = payload
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if files.is_empty() {
        return Json(json!({ "success": false, "error": "No files specified" }));
    }

    let title = payload
        .get("title")
        .or_else(|| payload.get("folderName"))
        .and_then(|v| v.as_str())
        .unwrap_or("講義資料の一括保存")
        .to_string();
    let sub_folder = payload
        .get("subFolder")
        .and_then(|v| v.as_str())
        .map(sanitize_file_name)
        .unwrap_or_default();

    let cfg = load_config();
    let mut dest_dir = payload
        .get("targetDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&cfg.download_dir));
    if !sub_folder.is_empty() {
        dest_dir = dest_dir.join(&sub_folder);
    }
    let _ = fs::create_dir_all(&dest_dir);

    let job_id = format!("batch_{}", now_ms());
    let total_files = files.len();
    let dir_str = dest_dir.to_string_lossy().into_owned();
    let job = DownloadJob {
        id: job_id.clone(),
        title: title.clone(),
        job_type: "batch-files".to_string(),
        status: "downloading".to_string(),
        progress: 0.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        completed_files: 0,
        total_files,
        completed_count: 0,
        total_count: total_files,
        save_path: Some(dir_str.clone()),
        save_dir: Some(dir_str),
        file_name: None,
        full_path: None,
        saved_files: Vec::new(),
        message: format!("準備中 (全 {} 件)", total_files),
        error: None,
        created_at: now_ms(),
    };

    if let Ok(mut guard) = state.jobs.lock() {
        guard.insert(0, job.clone());
    }

    let st = state.clone();
    let jid = job_id.clone();
    tokio::spawn(async move {
        let mut completed = 0usize;
        let mut saved_names: Vec<String> = Vec::new();
        for f in files {
            if st.is_cancelled(&jid) {
                st.update_job(&jid, |j| {
                    j.status = "cancelled".to_string();
                    j.message = "キャンセルしました".to_string();
                    j.error = Some("キャンセルされました".to_string());
                });
                return;
            }
            let fid = f.get("id").map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                _ => v.to_string(),
            });
            let furl = f.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
            let fname = f
                .get("name")
                .or_else(|| f.get("displayName"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let fcourse = f.get("courseId").map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                _ => v.to_string(),
            });

            if let Ok(saved_p) = download_one_file_to_disk(
                &st,
                fid.as_deref(),
                furl.as_deref(),
                fname.as_deref(),
                fcourse.as_deref(),
                &dest_dir,
                &jid,
            )
            .await
            {
                if let Some(bn) = saved_p.file_name().and_then(|n| n.to_str()) {
                    saved_names.push(bn.to_string());
                }
            }
            completed += 1;
            let saved_clone = saved_names.clone();
            st.update_job(&jid, |j| {
                j.completed_files = completed;
                j.completed_count = completed;
                j.saved_files = saved_clone;
                j.progress = ((completed as f64 / total_files as f64) * 100.0).min(100.0);
                j.message = format!("{}/{} 件保存完了", completed, total_files);
            });
        }
        st.update_job(&jid, |j| {
            j.status = "completed".to_string();
            j.progress = 100.0;
            j.message = format!("保存完了: {}/{}件", j.saved_files.len(), total_files);
        });
    });

    Json(json!({ "success": true, "job": job }))
}

async fn api_get_downloads(State(state): State<AppState>) -> Json<Value> {
    let jobs = state.jobs.lock().map(|g| g.clone()).unwrap_or_default();
    Json(json!({ "success": true, "downloads": jobs, "jobs": jobs }))
}

async fn api_get_youtube_downloads(State(state): State<AppState>) -> Json<Value> {
    let jobs: Vec<DownloadJob> = state
        .jobs
        .lock()
        .map(|g| {
            g.iter()
                .filter(|j| j.job_type == "youtube")
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Json(json!({ "success": true, "downloads": jobs, "jobs": jobs }))
}

async fn api_cancel_download(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Json<Value> {
    if let Ok(mut c) = state.cancelled_jobs.lock() {
        c.insert(job_id.clone());
    }
    state.update_job(&job_id, |j| {
        j.status = "cancelled".to_string();
        j.message = "キャンセルしました".to_string();
        j.error = Some("キャンセルされました".to_string());
    });
    let job = state
        .jobs
        .lock()
        .ok()
        .and_then(|g| g.iter().find(|j| j.id == job_id).cloned());
    Json(json!({ "success": true, "job": job }))
}

async fn api_clear_downloads(State(state): State<AppState>) -> Json<Value> {
    if let Ok(mut guard) = state.jobs.lock() {
        guard.retain(|j| j.status == "downloading");
    }
    Json(json!({ "success": true }))
}

fn find_ytdlp_command() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let candidates = [
        PathBuf::from(&home)
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Python")
            .join("Python312")
            .join("Scripts")
            .join("yt-dlp.exe"),
        PathBuf::from(&home)
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Python")
            .join("Python311")
            .join("Scripts")
            .join("yt-dlp.exe"),
        PathBuf::from(&home)
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Python")
            .join("Python310")
            .join("Scripts")
            .join("yt-dlp.exe"),
    ];
    for c in candidates {
        if c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    "yt-dlp".to_string()
}

async fn api_youtube_download(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let url = payload
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("YouTube講義動画")
        .trim()
        .to_string();
    if url.is_empty() {
        return Json(json!({ "success": false, "error": "URL required" }));
    }

    let cfg = load_config();
    let dest_dir = PathBuf::from(&cfg.download_dir);
    let _ = fs::create_dir_all(&dest_dir);

    let safe_title = sanitize_file_name(&title);
    let file_name = format!("{}.mp4", safe_title);
    let output_path = dest_dir.join(&file_name);
    let job_id = format!("yt_{}", now_ms());
    let out_str = output_path.to_string_lossy().into_owned();

    let job = DownloadJob {
        id: job_id.clone(),
        title: title.clone(),
        job_type: "youtube".to_string(),
        status: "downloading".to_string(),
        progress: 5.0,
        downloaded_bytes: 0,
        total_bytes: 0,
        completed_files: 0,
        total_files: 1,
        completed_count: 0,
        total_count: 1,
        save_path: Some(out_str.clone()),
        save_dir: Some(dest_dir.to_string_lossy().into_owned()),
        file_name: Some(file_name.clone()),
        full_path: Some(out_str),
        saved_files: Vec::new(),
        message: "ダウンロード中".to_string(),
        error: None,
        created_at: now_ms(),
    };

    if let Ok(mut guard) = state.jobs.lock() {
        guard.insert(0, job.clone());
    }

    let st = state.clone();
    let jid = job_id.clone();
    let ytdlp_bin = find_ytdlp_command();
    tokio::spawn(async move {
        let status = tokio::process::Command::new(&ytdlp_bin)
            .args([
                "--extractor-args",
                "youtube:player_client=android,web",
                "-f",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b/bv*+ba",
                "--merge-output-format",
                "mp4",
                "--no-playlist",
                "--windows-filenames",
                "-o",
                &output_path.to_string_lossy(),
                &url,
            ])
            .status()
            .await;

        match status {
            Ok(s) if s.success() => {
                st.update_job(&jid, |j| {
                    j.status = "completed".to_string();
                    j.progress = 100.0;
                    j.completed_files = 1;
                    j.completed_count = 1;
                    j.message = "保存しました".to_string();
                });
            }
            Ok(s) => {
                st.update_job(&jid, |j| {
                    j.status = "failed".to_string();
                    j.message = "保存失敗".to_string();
                    j.error = Some(format!("yt-dlp が終了しました ({})", s));
                });
            }
            Err(err) => {
                st.update_job(&jid, |j| {
                    j.status = "failed".to_string();
                    j.message = "yt-dlp を起動できませんでした".to_string();
                    j.error = Some(format!("yt-dlp 実行エラー: {}", err));
                });
            }
        }
    });

    Json(json!({ "success": true, "job": job }))
}

async fn api_get_submission(
    State(state): State<AppState>,
    Path((course_id, assignment_id)): Path<(String, String)>,
) -> Json<Value> {
    match state
        .canvas
        .get_assignment_submission(&course_id, &assignment_id)
        .await
    {
        Ok(submission) => Json(json!({ "success": true, "submission": submission })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_submit_files(
    State(state): State<AppState>,
    Path((course_id, assignment_id)): Path<(String, String)>,
    mut multipart: Multipart,
) -> Json<Value> {
    let mut files: Vec<UploadFilePayload> = Vec::new();
    let mut retain_ids: Vec<String> = Vec::new();
    let mut comment: Option<String> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let field_name = field.name().unwrap_or("").to_string();
        if field_name == "files" {
            let filename = field.file_name().unwrap_or("upload.bin").to_string();
            let content_type = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_string();
            if let Ok(bytes) = field.bytes().await {
                files.push(UploadFilePayload {
                    filename,
                    content_type,
                    bytes: bytes.to_vec(),
                });
            }
        } else if field_name == "retainFileIds" {
            if let Ok(txt) = field.text().await {
                if let Ok(parsed) = serde_json::from_str::<Vec<Value>>(&txt) {
                    for v in parsed {
                        let s = match v {
                            Value::String(st) => st,
                            _ => v.to_string(),
                        };
                        if !s.is_empty() {
                            retain_ids.push(s);
                        }
                    }
                }
            }
        } else if field_name == "comment" {
            if let Ok(txt) = field.text().await {
                if !txt.trim().is_empty() {
                    comment = Some(txt);
                }
            }
        }
    }

    match state
        .canvas
        .upload_and_submit_assignment(&course_id, &assignment_id, files, retain_ids, comment)
        .await
    {
        Ok(submission) => Json(json!({
          "success": true,
          "result": submission,
          "submission": submission,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_submit_text(
    State(state): State<AppState>,
    Path((course_id, assignment_id)): Path<(String, String)>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let sub_type = payload
        .get("submissionType")
        .and_then(|v| v.as_str())
        .unwrap_or("online_text_entry");
    let comment = payload
        .get("commentText")
        .or_else(|| payload.get("comment"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if sub_type == "online_url" {
        let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
        return match state
            .canvas
            .submit_url_assignment(&course_id, &assignment_id, url, comment)
            .await
        {
            Ok(submission) => Json(json!({
              "success": true,
              "result": submission,
              "submission": submission,
            })),
            Err(err) => Json(json!({ "success": false, "error": err })),
        };
    }

    let text = payload
        .get("body")
        .or_else(|| payload.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match state
        .canvas
        .submit_text_assignment(&course_id, &assignment_id, text, comment)
        .await
    {
        Ok(submission) => Json(json!({
          "success": true,
          "result": submission,
          "submission": submission,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

async fn api_submit_url(
    State(state): State<AppState>,
    Path((course_id, assignment_id)): Path<(String, String)>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let comment = payload
        .get("commentText")
        .or_else(|| payload.get("comment"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    match state
        .canvas
        .submit_url_assignment(&course_id, &assignment_id, url, comment)
        .await
    {
        Ok(submission) => Json(json!({
          "success": true,
          "result": submission,
          "submission": submission,
        })),
        Err(err) => Json(json!({ "success": false, "error": err })),
    }
}

fn get_manual_completed_path() -> PathBuf {
    get_config_dir().join("manual_completed.json")
}

async fn api_get_manual_completed() -> Json<Value> {
    let path = get_manual_completed_path();
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(list) = serde_json::from_str::<Vec<Value>>(&raw) {
                return Json(json!({ "success": true, "completedIds": list }));
            }
        }
    }
    Json(json!({ "success": true, "completedIds": [] }))
}

async fn api_post_manual_completed(Json(payload): Json<Value>) -> Json<Value> {
    if let Some(arr) = payload.get("completedIds").and_then(|v| v.as_array()) {
        let path = get_manual_completed_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string(arr) {
            let _ = fs::write(&path, serialized);
            return Json(json!({ "success": true }));
        }
    }
    Json(json!({ "success": false, "error": "Invalid data" }))
}

async fn api_media_resolve(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let entry_id = params.get("entryId").map(|s| s.trim()).unwrap_or("");
    let attachment_id = params.get("attachmentId").map(|s| s.trim()).unwrap_or("");
    let course_id = params.get("courseId").map(|s| s.trim()).unwrap_or("");

    if !attachment_id.is_empty() {
        if let Ok(file_data) = state
            .canvas
            .resolve_file_download(
                attachment_id,
                if course_id.is_empty() {
                    None
                } else {
                    Some(course_id)
                },
            )
            .await
        {
            let display_name = file_data
                .get("display_name")
                .or_else(|| file_data.get("filename"))
                .and_then(|v| v.as_str())
                .unwrap_or("video.mp4");
            let stream_url = format!(
                "/api/files/download?id={}&courseId={}&inline=true&name={}",
                attachment_id,
                course_id,
                urlencoding::encode(display_name)
            );
            return Json(json!({
              "success": true,
              "title": display_name,
              "url": file_data.get("url").cloned().unwrap_or(Value::Null),
              "streamUrl": stream_url,
              "size": file_data.get("size").cloned().unwrap_or(Value::Null),
              "contentType": file_data.get("content-type").and_then(|v| v.as_str()).unwrap_or("video/mp4"),
            }));
        }
    }

    if !entry_id.is_empty() && !course_id.is_empty() {
        let cfg = load_config();
        if !cfg.base_url.is_empty() && !cfg.api_token.is_empty() {
            let media_url = format!(
                "{}/courses/{}/media_download?entryId={}&type=mp4",
                cfg.base_url.trim_end_matches('/'),
                course_id,
                urlencoding::encode(entry_id)
            );
            if let Ok(resp) = state
                .canvas
                .client
                .get(&media_url)
                .header("Authorization", format!("Bearer {}", cfg.api_token))
                .timeout(Duration::from_secs(10))
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(data) = resp.json::<Value>().await {
                        if let Some(u) = data.get("url").and_then(|v| v.as_str()) {
                            return Json(json!({
                              "success": true,
                              "url": u,
                              "streamUrl": u,
                            }));
                        }
                    }
                }
            }
        }
    }

    Json(json!({ "success": false, "error": "Media not found" }))
}

async fn api_open_path(Json(payload): Json<Value>) -> Json<Value> {
    let target = payload
        .get("path")
        .or_else(|| payload.get("targetPath"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if target.is_empty() {
        return Json(json!({ "success": false, "error": "Path is required" }));
    }
    let p = PathBuf::from(target);
    let to_open = if p.exists() {
        p
    } else if let Some(parent) = p.parent().filter(|pr| pr.exists()) {
        parent.to_path_buf()
    } else {
        p
    };
    let _ = open::that(to_open);
    Json(json!({ "success": true }))
}

async fn api_open_downloads() -> Json<Value> {
    let cfg = load_config();
    let _ = open::that(&cfg.download_dir);
    Json(json!({ "success": true }))
}

#[cfg(target_os = "windows")]
pub fn check_windows_battery_power() -> bool {
    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    unsafe extern "system" {
        fn GetSystemPowerStatus(lp_system_power_status: *mut SystemPowerStatus) -> i32;
    }
    let mut status = SystemPowerStatus {
        ac_line_status: 1,
        battery_flag: 0,
        battery_life_percent: 100,
        system_status_flag: 0,
        battery_life_time: 0,
        battery_full_life_time: 0,
    };
    let ok = unsafe { GetSystemPowerStatus(&mut status as *mut SystemPowerStatus) };
    ok != 0 && status.ac_line_status == 0
}

#[cfg(not(target_os = "windows"))]
pub fn check_windows_battery_power() -> bool {
    false
}

async fn api_desktop_app_info() -> Json<Value> {
    Json(json!({
      "version": APP_VERSION,
      "isPackaged": !cfg!(debug_assertions),
      "platform": std::env::consts::OS,
      "backend": "rust"
    }))
}

async fn api_desktop_power_state() -> Json<Value> {
    Json(json!({
      "onBattery": check_windows_battery_power()
    }))
}

async fn api_desktop_select_folder() -> Json<Value> {
    let folder = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("講義資料の保存先ルートフォルダを選択してください")
            .pick_folder()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten();
    Json(json!({ "success": true, "path": folder }))
}

async fn api_desktop_open_external(Json(payload): Json<Value>) -> Json<Value> {
    let url = payload
        .get("url")
        .or_else(|| payload.get("targetUrl"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = open::that(url);
        return Json(json!({ "success": true }));
    }
    Json(json!({ "success": false, "error": "Invalid external URL" }))
}

async fn api_desktop_check_update() -> Json<Value> {
    Json(crate::check_for_updates_impl(None).await)
}

async fn api_desktop_download_update() -> Json<Value> {
    Json(crate::start_download_update_impl(None).await)
}

async fn api_desktop_quit_and_install() -> Json<Value> {
    let applied = crate::quit_and_install_impl();
    Json(json!({ "success": applied }))
}

const EMBED_INDEX_HTML: &str = include_str!("../../public/index.html");
const EMBED_STYLE_CSS: &str = include_str!("../../public/css/style.css");
const EMBED_APP_JS: &str = include_str!("../../public/js/app.js");
const EMBED_MANIFEST_JSON: &str = include_str!("../../public/manifest.json");
const EMBED_SW_JS: &str = include_str!("../../public/sw.js");
const EMBED_ICON_PNG: &[u8] = include_bytes!("../../public/icons/icon.png");
const EMBED_ICON_ICO: &[u8] = include_bytes!("../../public/icons/icon.ico");

pub fn resolve_public_dir() -> PathBuf {
    let candidates = [
        PathBuf::from("public"),
        PathBuf::from("../public"),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("public")))
            .unwrap_or_else(|| PathBuf::from("public")),
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .and_then(|d| d.parent())
                    .map(|d| d.join("public"))
            })
            .unwrap_or_else(|| PathBuf::from("public")),
    ];
    for c in candidates {
        if c.join("index.html").exists() {
            return c;
        }
    }
    PathBuf::from("public")
}

pub fn inject_version_into_html(html: &str) -> String {
    static RE_CSS_VER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"css/style\.css(?:\?v=[^&'\x22>\s]+)?").unwrap());
    static RE_JS_VER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"js/app\.js(?:\?v=[^&'\x22>\s]+)?").unwrap());
    let css_target = format!("css/style.css?v={}", APP_VERSION);
    let js_target = format!("js/app.js?v={}", APP_VERSION);
    let s1 = RE_CSS_VER.replace_all(html, css_target.as_str());
    RE_JS_VER.replace_all(&s1, js_target.as_str()).into_owned()
}

async fn serve_embedded_or_disk(uri: axum::http::Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    let rel_path = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };
    if !rel_path.contains("..") {
        let disk_path = resolve_public_dir().join(rel_path);
        if disk_path.is_file() {
            if let Ok(bytes) = tokio::fs::read(&disk_path).await {
                let ext = disk_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| format!(".{}", s.to_lowercase()))
                    .unwrap_or_default();
                let mime = ext_to_mime(&ext).unwrap_or("application/octet-stream");
                let out_bytes = if rel_path == "index.html" {
                    if let Ok(html_str) = String::from_utf8(bytes) {
                        inject_version_into_html(&html_str).into_bytes()
                    } else {
                        Vec::new()
                    }
                } else {
                    bytes
                };
                if !out_bytes.is_empty() {
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, mime),
                            (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
                        ],
                        out_bytes,
                    )
                        .into_response();
                }
            }
        }
    }

    match rel_path {
        "" | "index.html" => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            inject_version_into_html(EMBED_INDEX_HTML).into_bytes(),
        )
            .into_response(),
        "css/style.css" => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/css; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            EMBED_STYLE_CSS.as_bytes().to_vec(),
        )
            .into_response(),
        "js/app.js" => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    "application/javascript; charset=utf-8",
                ),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            EMBED_APP_JS.as_bytes().to_vec(),
        )
            .into_response(),
        "manifest.json" => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            EMBED_MANIFEST_JSON.as_bytes().to_vec(),
        )
            .into_response(),
        "sw.js" => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    "application/javascript; charset=utf-8",
                ),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            EMBED_SW_JS.as_bytes().to_vec(),
        )
            .into_response(),
        "icons/icon.png" => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "image/png")],
            EMBED_ICON_PNG.to_vec(),
        )
            .into_response(),
        "icons/icon.ico" | "favicon.ico" => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "image/x-icon")],
            EMBED_ICON_ICO.to_vec(),
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "Not Found").into_response(),
    }
}

pub fn build_router(state: AppState) -> Router {
    let _ = ServeDir::new(resolve_public_dir());

    Router::new()
        .route("/api/config", get(api_get_config).post(api_post_config))
        .route("/api/cache/clear", post(api_clear_cache))
        .route("/api/app/check-update", get(api_check_update))
        .route("/api/me", get(api_get_profile))
        .route("/api/profile", get(api_get_profile))
        .route("/api/courses", get(api_get_courses))
        .route(
            "/api/courses/:courseId/assignments",
            get(api_get_course_assignments),
        )
        .route("/api/assignments/all", get(api_get_all_assignments))
        .route(
            "/api/assignments/manual-completed",
            get(api_get_manual_completed).post(api_post_manual_completed),
        )
        .route("/api/timeline", get(api_get_timeline))
        .route("/api/dashboard/timeline", get(api_get_timeline))
        .route(
            "/api/courses/:courseId/modules",
            get(api_get_course_modules),
        )
        .route("/api/courses/:courseId/files", get(api_get_course_files))
        .route(
            "/api/courses/:courseId/materials-grouped",
            get(api_get_materials_grouped),
        )
        .route(
            "/api/courses/:courseId/discussions",
            get(api_get_course_discussions),
        )
        .route(
            "/api/courses/:courseId/discussions/:topicId",
            get(api_get_discussion_topic),
        )
        .route("/api/courses/:courseId/pages/:pageUrl", get(api_get_page))
        .route("/api/announcements", get(api_get_announcements))
        .route("/api/files/meta", get(api_get_file_meta))
        .route("/api/files/download", get(api_download_file))
        .route("/api/files/ensure-cache", get(api_ensure_cache))
        .route("/api/media/resolve", get(api_media_resolve))
        .route("/api/files/download-single", post(api_download_single))
        .route("/api/files/download-batch", post(api_download_batch))
        .route("/api/downloads", get(api_get_downloads))
        .route("/api/downloads/:jobId/cancel", post(api_cancel_download))
        .route("/api/downloads/clear", post(api_clear_downloads))
        .route("/api/open-path", post(api_open_path))
        .route("/api/open-downloads", post(api_open_downloads))
        .route("/api/youtube/downloads", get(api_get_youtube_downloads))
        .route("/api/youtube/download", post(api_youtube_download))
        .route("/api/youtube/download-legacy", post(api_youtube_download))
        .route(
            "/api/youtube/download/:jobId/cancel",
            post(api_cancel_download),
        )
        .route(
            "/api/courses/:courseId/assignments/:assignmentId/submission",
            get(api_get_submission),
        )
        .route(
            "/api/courses/:courseId/assignments/:assignmentId/submit",
            post(api_submit_files),
        )
        .route(
            "/api/courses/:courseId/assignments/:assignmentId/submit-files",
            post(api_submit_files),
        )
        .route(
            "/api/courses/:courseId/assignments/:assignmentId/submit-text",
            post(api_submit_text),
        )
        .route(
            "/api/courses/:courseId/assignments/:assignmentId/submit-url",
            post(api_submit_url),
        )
        .route("/api/desktop/app-info", get(api_desktop_app_info))
        .route("/api/desktop/power-state", get(api_desktop_power_state))
        .route(
            "/api/desktop/select-folder",
            post(api_desktop_select_folder),
        )
        .route("/api/desktop/open-path", post(api_open_path))
        .route(
            "/api/desktop/open-external",
            post(api_desktop_open_external),
        )
        .route("/api/desktop/check-update", get(api_desktop_check_update))
        .route(
            "/api/desktop/download-update",
            post(api_desktop_download_update),
        )
        .route(
            "/api/desktop/quit-and-install",
            post(api_desktop_quit_and_install),
        )
        .fallback(serve_embedded_or_disk)
        .layer(DefaultBodyLimit::max(250 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strip_double_pdf_ext_and_normalize() {
        assert_eq!(
            strip_double_pdf_ext("第1回課題レポート.docx.pdf"),
            "第1回課題レポート.docx"
        );
        assert_eq!(
            strip_double_pdf_ext("課題シート.docs.pdf"),
            "課題シート.docs"
        );
        assert_eq!(
            normalize_download_file_name(
                Some("課題シート.docs.pdf"),
                None,
                None,
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            ),
            "課題シート.docs"
        );
        assert_eq!(
            normalize_download_file_name(
                Some("document.pdf"),
                Some(&json!({ "display_name": "report_template.docx" })),
                None,
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            ),
            "report_template.docx"
        );
    }

    #[test]
    fn test_compare_semver() {
        assert_eq!(compare_semver("1.3.0", "1.2.2"), 1);
        assert_eq!(compare_semver("1.2.2", "1.2.2"), 0);
        assert_eq!(compare_semver("1.1.10", "1.2.0"), -1);
    }

    #[test]
    fn test_inject_version_into_html() {
        let raw = r#"<link rel="stylesheet" href="css/style.css?v=1.1.3"><script src="js/app.js?v=1.1.10"></script>"#;
        let injected = inject_version_into_html(raw);
        assert!(injected.contains(&format!("css/style.css?v={}", APP_VERSION)));
        assert!(injected.contains(&format!("js/app.js?v={}", APP_VERSION)));
    }
}
