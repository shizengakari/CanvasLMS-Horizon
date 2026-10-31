use crate::config::{get_config_dir, load_config};
use crate::quarter::{clean_course_name, extract_quarter};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

const CACHE_TTL_MS: u64 = 15 * 60 * 1000;
const COURSES_CACHE_TTL_MS: u64 = 60 * 60 * 1000;
const MATERIALS_CACHE_TTL_MS: u64 = 30 * 60 * 1000;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimedEntry {
    pub time: u64,
    pub data: Value,
}

#[derive(Default)]
pub struct MemoryCache {
    pub profile: Option<Value>,
    pub courses: Option<Value>,
    pub courses_time: u64,
    pub all_assignments: Option<Value>,
    pub all_assignments_time: u64,
    pub assignments: HashMap<String, TimedEntry>,
    pub modules: HashMap<String, TimedEntry>,
    pub files: HashMap<String, TimedEntry>,
    pub grouped_materials: HashMap<String, TimedEntry>,
    pub resolved_urls: HashMap<String, TimedEntry>,
    pub submitted_overrides: HashMap<String, TimedEntry>,
}

pub fn is_submission_completed(sub: Option<&Value>, override_entry: Option<&TimedEntry>) -> bool {
    if let Some(ov) = override_entry {
        if now_ms().saturating_sub(ov.time) < 30 * 60 * 1000 {
            return true;
        }
    }
    let Some(s) = sub.filter(|v| !v.is_null()) else {
        return false;
    };
    let wf = s
        .get("workflow_state")
        .or_else(|| s.get("workflowState"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if matches!(
        wf.as_str(),
        "submitted" | "graded" | "pending_review" | "complete"
    ) {
        return true;
    }
    let has_submitted_at = s
        .get("submitted_at")
        .or_else(|| s.get("submittedAt"))
        .and_then(|v| v.as_str())
        .map(|st| !st.trim().is_empty())
        .unwrap_or(false);
    if has_submitted_at {
        return true;
    }
    let attempt = s.get("attempt").and_then(|v| v.as_i64()).unwrap_or(0);
    if attempt > 0 {
        return true;
    }
    if s.get("excused").and_then(|v| v.as_bool()).unwrap_or(false) {
        return true;
    }
    false
}

pub struct UploadFilePayload {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct CanvasService {
    pub client: reqwest::Client,
    pub semaphore: Arc<Semaphore>,
    pub cache: Arc<Mutex<MemoryCache>>,
    pub cache_file_path: PathBuf,
}

impl CanvasService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .pool_max_idle_per_host(8)
            .user_agent("CanvasHorizon-Rust/1.3.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let dir = get_config_dir();
        let _ = fs::create_dir_all(&dir);
        let cache_file_path = dir.join("cache.json");

        let svc = Self {
            client,
            semaphore: Arc::new(Semaphore::new(4)),
            cache: Arc::new(Mutex::new(MemoryCache::default())),
            cache_file_path,
        };
        svc.load_disk_cache();
        svc
    }

    pub fn load_disk_cache(&self) {
        if !self.cache_file_path.exists() {
            return;
        }
        let Ok(raw) = fs::read_to_string(&self.cache_file_path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        let Ok(mut guard) = self.cache.lock() else {
            return;
        };

        if let Some(p) = parsed.get("profile") {
            if !p.is_null() {
                guard.profile = Some(p.clone());
            }
        }
        let is_same_app_version =
            parsed.get("appVersion").and_then(|v| v.as_str()) == Some(crate::server::APP_VERSION);
        if is_same_app_version && parsed.get("schemaVersion").and_then(|v| v.as_u64()) == Some(2) {
            if let Some(c) = parsed.get("courses") {
                if c.is_array() {
                    guard.courses = Some(c.clone());
                    guard.courses_time = parsed
                        .get("coursesTime")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                }
            }
            if let Some(all_a) = parsed.get("allAssignments") {
                if all_a.is_array() {
                    guard.all_assignments = Some(all_a.clone());
                    guard.all_assignments_time = parsed
                        .get("allAssignmentsTime")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                }
            }
            if let Some(assign_map) = parsed.get("assignments").and_then(|v| v.as_object()) {
                for (k, v) in assign_map {
                    if let (Some(t), Some(d)) =
                        (v.get("time").and_then(|x| x.as_u64()), v.get("data"))
                    {
                        guard.assignments.insert(
                            k.clone(),
                            TimedEntry {
                                time: t,
                                data: d.clone(),
                            },
                        );
                    }
                }
            }
            if let Some(gm_map) = parsed.get("groupedMaterials").and_then(|v| v.as_object()) {
                for (k, v) in gm_map {
                    if let (Some(t), Some(d)) =
                        (v.get("time").and_then(|x| x.as_u64()), v.get("data"))
                    {
                        guard.grouped_materials.insert(
                            k.clone(),
                            TimedEntry {
                                time: t,
                                data: d.clone(),
                            },
                        );
                    }
                }
            }
        }
    }

    pub fn save_disk_cache(&self) {
        let payload = {
            let Ok(guard) = self.cache.lock() else {
                return;
            };
            json!({
              "schemaVersion": 2,
              "appVersion": crate::server::APP_VERSION,
              "profile": guard.profile,
              "courses": guard.courses,
              "coursesTime": guard.courses_time,
              "allAssignments": guard.all_assignments,
              "allAssignmentsTime": guard.all_assignments_time,
              "assignments": guard.assignments,
              "groupedMaterials": guard.grouped_materials,
            })
        };
        let path = self.cache_file_path.clone();
        tokio::spawn(async move {
            if let Ok(serialized) = serde_json::to_string(&payload) {
                let _ = tokio::fs::write(path, serialized).await;
            }
        });
    }

    pub fn clear_all_cache(&self, keep_profile: bool) {
        let profile_backup = if let Ok(mut guard) = self.cache.lock() {
            let p = if keep_profile {
                guard.profile.clone()
            } else {
                None
            };
            *guard = MemoryCache {
                profile: p.clone(),
                ..Default::default()
            };
            p
        } else {
            None
        };

        if self.cache_file_path.exists() {
            if let Some(p) = profile_backup {
                if let Ok(s) = serde_json::to_string_pretty(&json!({ "profile": p })) {
                    let _ = fs::write(&self.cache_file_path, s);
                }
            } else {
                let _ = fs::remove_file(&self.cache_file_path);
            }
        }
    }

    pub fn get_base_url(&self) -> String {
        let cfg = load_config();
        cfg.base_url.trim().trim_end_matches('/').to_string()
    }

    pub fn get_api_token(&self) -> String {
        let cfg = load_config();
        cfg.api_token.trim().to_string()
    }

    fn extract_next_link(link_header: &str) -> Option<String> {
        for part in link_header.split(',') {
            let lower = part.to_lowercase();
            if lower.contains("rel=\"next\"") || lower.contains("rel='next'") {
                if let (Some(start), Some(end)) = (part.find('<'), part.find('>')) {
                    if end > start + 1 {
                        return Some(part[start + 1..end].trim().to_string());
                    }
                }
            }
        }
        None
    }

    async fn fetch_single_page(
        &self,
        url_or_endpoint: &str,
    ) -> Result<(Value, Option<String>), String> {
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|e| format!("Semaphore error: {e}"))?;

        let base_url = self.get_base_url();
        let token = self.get_api_token();
        if base_url.is_empty() || token.is_empty() {
            return Err("Canvas APIの設定（URLまたはトークン）が未入力です。".to_string());
        }

        let url =
            if url_or_endpoint.starts_with("http://") || url_or_endpoint.starts_with("https://") {
                url_or_endpoint.to_string()
            } else {
                format!("{}{}", base_url, url_or_endpoint)
            };

        let mut last_err = String::new();
        for attempt in 0..=3 {
            let resp = self
                .client
                .get(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Accept", "application/json")
                .send()
                .await;

            match resp {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 401 {
                        return Err(
                            "Canvas APIトークンが無効または期限切れです。設定を確認してください。"
                                .to_string(),
                        );
                    }
                    if status == 429 || status == 403 {
                        let retry_after = res
                            .headers()
                            .get("Retry-After")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse::<u64>().ok());
                        let body = res.text().await.unwrap_or_default();
                        if status == 429 || body.to_lowercase().contains("rate limit") {
                            if attempt < 3 {
                                let wait_ms = retry_after
                                    .map(|s| s * 1000)
                                    .unwrap_or(1500 * (1 << attempt));
                                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                                continue;
                            }
                            return Err("Canvas APIのレート制限に達しました。しばらく待ってから再試行してください。".to_string());
                        }
                        return Err(format!("API Error [{}]: {}", status, body));
                    }
                    if (500..=504).contains(&status) && attempt < 3 {
                        tokio::time::sleep(Duration::from_millis(1000 * (1 << attempt))).await;
                        continue;
                    }
                    if !res.status().is_success() {
                        let body = res.text().await.unwrap_or_default();
                        return Err(format!("API Error [{}]: {}", status, body));
                    }
                    let next_link = res
                        .headers()
                        .get("link")
                        .and_then(|v| v.to_str().ok())
                        .and_then(Self::extract_next_link);
                    let json_val = res
                        .json::<Value>()
                        .await
                        .map_err(|e| format!("JSON parse error: {e}"))?;
                    return Ok((json_val, next_link));
                }
                Err(err) => {
                    last_err = err.to_string();
                    if attempt < 3 {
                        tokio::time::sleep(Duration::from_millis(1000 * (1 << attempt))).await;
                        continue;
                    }
                }
            }
        }
        Err(last_err)
    }

    pub async fn fetch_json(&self, endpoint: &str) -> Result<Value, String> {
        let (first_val, mut next_url) = self.fetch_single_page(endpoint).await?;
        let Some(first_arr) = first_val.as_array() else {
            return Ok(first_val);
        };
        if next_url.is_none() {
            return Ok(first_val);
        }

        let mut combined = first_arr.clone();
        let mut page_count = 1usize;
        while let Some(url) = next_url.take() {
            if page_count >= 6 {
                break;
            }
            page_count += 1;
            match self.fetch_single_page(&url).await {
                Ok((Value::Array(mut arr), next)) => {
                    combined.append(&mut arr);
                    next_url = next;
                }
                _ => break,
            }
        }
        Ok(Value::Array(combined))
    }

    pub async fn get_profile(&self, force_refresh: bool) -> Result<Value, String> {
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(p) = &guard.profile {
                    return Ok(p.clone());
                }
            }
        }

        match self.fetch_json("/api/v1/users/self").await {
            Ok(profile) => {
                if let Ok(mut guard) = self.cache.lock() {
                    guard.profile = Some(profile.clone());
                }
                self.save_disk_cache();
                Ok(profile)
            }
            Err(err) => {
                if let Ok(guard) = self.cache.lock() {
                    if let Some(p) = &guard.profile {
                        return Ok(p.clone());
                    }
                }
                Err(err)
            }
        }
    }

    pub async fn get_courses(&self, force_refresh: bool) -> Result<Vec<Value>, String> {
        let now = now_ms();
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(Value::Array(arr)) = &guard.courses {
                    if now.saturating_sub(guard.courses_time) < COURSES_CACHE_TTL_MS {
                        return Ok(arr.clone());
                    }
                }
            }
        }

        let raw = match self
      .fetch_json("/api/v1/courses?enrollment_state=active&include[]=term&include[]=course_image&per_page=100")
      .await
    {
      Ok(v) => v,
      Err(err) => {
        if let Ok(guard) = self.cache.lock() {
          if let Some(Value::Array(arr)) = &guard.courses {
            if !arr.is_empty() {
              return Ok(arr.clone());
            }
          }
        }
        return Err(err);
      }
    };

        let cfg = load_config();
        let active_q = cfg.current_quarter.trim().to_uppercase();

        let mut formatted: Vec<Value> = raw
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .filter(|c| {
        let has_name = c.get("name").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
        let restricted = c
          .get("access_restricted_by_date")
          .and_then(|v| v.as_bool())
          .unwrap_or(false);
        has_name && !restricted
      })
      .map(|c| {
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let quarter = extract_quarter(name);
        let cleaned = clean_course_name(name);
        let matches_filter = active_q.is_empty()
          || active_q == "ALL"
          || quarter.as_deref() == Some(active_q.as_str())
          || name.to_uppercase().contains(&active_q);

        json!({
          "id": c.get("id").cloned().unwrap_or(Value::Null),
          "name": name,
          "cleanName": cleaned,
          "quarter": quarter,
          "isCurrentQuarter": matches_filter,
          "courseCode": c.get("course_code").and_then(|v| v.as_str()).unwrap_or(""),
          "term": c.get("term").and_then(|t| t.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
          "imageUrl": c.get("image_download_url").cloned().unwrap_or(Value::Null),
          "defaultView": c.get("default_view").and_then(|v| v.as_str()).unwrap_or("modules"),
          "isFavorite": c.get("is_favorite").and_then(|v| v.as_bool()).unwrap_or(false),
        })
      })
      .collect();

        formatted.sort_by(|a, b| {
            if !active_q.is_empty() && active_q != "ALL" {
                let a_match = a
                    .get("isCurrentQuarter")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let b_match = b
                    .get("isCurrentQuarter")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if a_match != b_match {
                    return b_match.cmp(&a_match);
                }
            }
            let aq = a.get("quarter").and_then(|v| v.as_str());
            let bq = b.get("quarter").and_then(|v| v.as_str());
            match (aq, bq) {
                (Some(x), Some(y)) if x != y => y.cmp(x),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => {
                    let an = a.get("cleanName").and_then(|v| v.as_str()).unwrap_or("");
                    let bn = b.get("cleanName").and_then(|v| v.as_str()).unwrap_or("");
                    an.cmp(bn)
                }
            }
        });

        if let Ok(mut guard) = self.cache.lock() {
            guard.courses = Some(Value::Array(formatted.clone()));
            guard.courses_time = now;
        }
        self.save_disk_cache();
        Ok(formatted)
    }

    pub async fn get_assignments(
        &self,
        course_id: &str,
        force_refresh: bool,
        include_old: bool,
    ) -> Result<Vec<Value>, String> {
        let cache_key = format!(
            "{}{}",
            course_id,
            if include_old { "_all" } else { "_recent" }
        );
        let now = now_ms();

        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(entry) = guard.assignments.get(&cache_key) {
                    if now.saturating_sub(entry.time) < CACHE_TTL_MS {
                        if let Some(arr) = entry.data.as_array() {
                            return Ok(arr.clone());
                        }
                    }
                }
            }
        }

        let endpoint = format!(
            "/api/v1/courses/{}/assignments?include[]=submission&include[]=rubric_assessment&include[]=can_submit&per_page=100",
            course_id
        );

        let raw = match self.fetch_json(&endpoint).await {
            Ok(v) => v,
            Err(err) => {
                if let Ok(guard) = self.cache.lock() {
                    if let Some(entry) = guard.assignments.get(&cache_key) {
                        if let Some(arr) = entry.data.as_array() {
                            return Ok(arr.clone());
                        }
                    }
                }
                return Err(err);
            }
        };

        let overrides_snapshot: HashMap<String, TimedEntry> = self
            .cache
            .lock()
            .map(|g| g.submitted_overrides.clone())
            .unwrap_or_default();

        let mut formatted: Vec<Value> = raw
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .map(|a| {
        let aid_str = a
          .get("id")
          .map(|v| match v {
            Value::String(s) => s.clone(),
            _ => v.to_string(),
          })
          .unwrap_or_default();
        let override_key = format!("{}_{}", course_id, aid_str);
        let ov_entry = overrides_snapshot.get(&override_key);
        let sub = a.get("submission").filter(|v| !v.is_null());
        let wf = sub
          .and_then(|s| s.get("workflow_state"))
          .and_then(|v| v.as_str())
          .unwrap_or("");
        let is_submitted = is_submission_completed(sub, ov_entry);
        let is_graded = wf == "graded"
          || sub
            .and_then(|s| s.get("score"))
            .filter(|v| !v.is_null())
            .is_some();

        let sub_val = if let Some(s) = sub {
          let attachments: Vec<Value> = s
            .get("attachments")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|att| {
              json!({
                "id": att.get("id").cloned().unwrap_or(Value::Null),
                "displayName": att.get("display_name").or_else(|| att.get("filename")).cloned().unwrap_or(Value::Null),
                "filename": att.get("filename").cloned().unwrap_or(Value::Null),
                "size": att.get("size").cloned().unwrap_or(Value::Null),
                "contentType": att.get("content_type").or_else(|| att.get("content-type")).cloned().unwrap_or(Value::Null),
                "url": att.get("url").cloned().unwrap_or(Value::Null),
                "createdAt": att.get("created_at").cloned().unwrap_or(Value::Null),
              })
            })
            .collect();

          let comments: Vec<Value> = s
            .get("submission_comments")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|sc| {
              json!({
                "id": sc.get("id").cloned().unwrap_or(Value::Null),
                "authorName": sc.get("author_name").cloned().unwrap_or(Value::Null),
                "comment": sc.get("comment").cloned().unwrap_or(Value::Null),
                "createdAt": sc.get("created_at").cloned().unwrap_or(Value::Null),
              })
            })
            .collect();

          json!({
            "id": s.get("id").cloned().unwrap_or(Value::Null),
            "submittedAt": s.get("submitted_at").cloned().unwrap_or(Value::Null),
            "score": s.get("score").cloned().unwrap_or(Value::Null),
            "grade": s.get("grade").cloned().unwrap_or(Value::Null),
            "workflowState": s.get("workflow_state").cloned().unwrap_or(Value::Null),
            "attempt": s.get("attempt").cloned().unwrap_or(Value::Null),
            "body": s.get("body").cloned().unwrap_or(Value::Null),
            "url": s.get("url").cloned().unwrap_or(Value::Null),
            "attachments": attachments,
            "submissionComments": comments,
          })
        } else {
          Value::Null
        };

        let course_id_val = a
          .get("course_id")
          .cloned()
          .unwrap_or_else(|| json!(course_id));

        json!({
          "id": a.get("id").cloned().unwrap_or(Value::Null),
          "courseId": course_id_val,
          "name": a.get("name").and_then(|v| v.as_str()).unwrap_or("無題の課題"),
          "description": a.get("description").and_then(|v| v.as_str()).unwrap_or(""),
          "dueAt": a.get("due_at").cloned().unwrap_or(Value::Null),
          "lockAt": a.get("lock_at").cloned().unwrap_or(Value::Null),
          "unlockAt": a.get("unlock_at").cloned().unwrap_or(Value::Null),
          "isLocked": a.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false),
          "lockExplanation": a.get("lock_explanation").cloned().unwrap_or(Value::Null),
          "pointsPossible": a.get("points_possible").cloned().unwrap_or(Value::Null),
          "gradingType": a.get("grading_type").cloned().unwrap_or(Value::Null),
          "submissionTypes": a.get("submission_types").cloned().unwrap_or_else(|| json!([])),
          "allowedExtensions": a.get("allowed_extensions").cloned().unwrap_or_else(|| json!([])),
          "htmlUrl": a.get("html_url").cloned().unwrap_or(Value::Null),
          "isSubmitted": is_submitted,
          "isGraded": is_graded,
          "submission": sub_val,
        })
      })
      .collect();

        formatted.sort_by(|a, b| {
            let ad = a.get("dueAt").and_then(|v| v.as_str());
            let bd = b.get("dueAt").and_then(|v| v.as_str());
            match (ad, bd) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        if let Ok(mut guard) = self.cache.lock() {
            guard.assignments.insert(
                cache_key,
                TimedEntry {
                    time: now,
                    data: Value::Array(formatted.clone()),
                },
            );
        }
        self.save_disk_cache();
        Ok(formatted)
    }

    pub async fn get_all_assignments(&self, force_refresh: bool) -> Result<Vec<Value>, String> {
        let now = now_ms();
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(Value::Array(arr)) = &guard.all_assignments {
                    if now.saturating_sub(guard.all_assignments_time) < CACHE_TTL_MS {
                        return Ok(arr.clone());
                    }
                }
            }
        }

        let courses = self.get_courses(force_refresh).await?;
        let mut handles = Vec::new();

        for c in courses {
            let svc = self.clone();
            handles.push(tokio::spawn(async move {
                let cid = c
                    .get("id")
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        _ => v.to_string(),
                    })
                    .unwrap_or_default();
                if cid.is_empty() {
                    return Vec::new();
                }
                let cname = c
                    .get("name")
                    .cloned()
                    .unwrap_or(Value::String(String::new()));
                let clean_name = c.get("cleanName").cloned().unwrap_or(cname.clone());
                let quarter = c.get("quarter").cloned().unwrap_or(Value::Null);
                let is_current_q = c
                    .get("isCurrentQuarter")
                    .cloned()
                    .unwrap_or(Value::Bool(true));
                let course_code = c
                    .get("courseCode")
                    .cloned()
                    .unwrap_or(Value::String(String::new()));

                let list = svc
                    .get_assignments(&cid, force_refresh, false)
                    .await
                    .unwrap_or_default();
                list.into_iter()
                    .map(|mut a| {
                        if let Some(obj) = a.as_object_mut() {
                            obj.insert("courseName".to_string(), cname.clone());
                            obj.insert("cleanCourseName".to_string(), clean_name.clone());
                            obj.insert("quarter".to_string(), quarter.clone());
                            obj.insert("isCurrentQuarter".to_string(), is_current_q.clone());
                            obj.insert("courseCode".to_string(), course_code.clone());
                        }
                        a
                    })
                    .collect::<Vec<Value>>()
            }));
        }

        let mut all = Vec::new();
        for h in handles {
            if let Ok(mut items) = h.await {
                all.append(&mut items);
            }
        }

        all.sort_by(|a, b| {
            let ad = a.get("dueAt").and_then(|v| v.as_str());
            let bd = b.get("dueAt").and_then(|v| v.as_str());
            match (ad, bd) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });

        if let Ok(mut guard) = self.cache.lock() {
            guard.all_assignments = Some(Value::Array(all.clone()));
            guard.all_assignments_time = now;
        }
        self.save_disk_cache();
        Ok(all)
    }

    pub async fn get_calendar_events(&self) -> Vec<Value> {
        let Ok(courses) = self.get_courses(false).await else {
            return Vec::new();
        };
        if courses.is_empty() {
            return Vec::new();
        }

        let context_codes: Vec<String> = courses
            .iter()
            .take(20)
            .filter_map(|c| {
                c.get("id")
                    .map(|id| format!("context_codes[]=course_{}", id))
            })
            .collect();
        if context_codes.is_empty() {
            return Vec::new();
        }

        let endpoint = format!(
            "/api/v1/calendar_events?type=event&per_page=50&{}",
            context_codes.join("&")
        );
        let Ok(raw) = self.fetch_json(&endpoint).await else {
            return Vec::new();
        };
        raw.as_array().cloned().unwrap_or_default()
    }

    pub async fn get_timeline(&self, force_refresh: bool) -> Result<Vec<Value>, String> {
        let assignments = self.get_all_assignments(force_refresh).await?;
        let mut items: Vec<Value> = assignments
            .into_iter()
            .map(|mut a| {
                if let Some(obj) = a.as_object_mut() {
                    obj.insert("itemType".to_string(), json!("assignment"));
                    let dt = obj.get("dueAt").cloned().unwrap_or(Value::Null);
                    obj.insert("datetime".to_string(), dt);
                }
                a
            })
            .collect();

        items.sort_by(|a, b| {
            let ad = a.get("datetime").and_then(|v| v.as_str());
            let bd = b.get("datetime").and_then(|v| v.as_str());
            match (ad, bd) {
                (Some(x), Some(y)) => x.cmp(y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });
        Ok(items)
    }

    pub async fn get_modules(
        &self,
        course_id: &str,
        force_refresh: bool,
    ) -> Result<Vec<Value>, String> {
        let now = now_ms();
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(entry) = guard.modules.get(course_id) {
                    if now.saturating_sub(entry.time) < CACHE_TTL_MS {
                        if let Some(arr) = entry.data.as_array() {
                            return Ok(arr.clone());
                        }
                    }
                }
            }
        }

        let endpoint = format!(
            "/api/v1/courses/{}/modules?include[]=items&include[]=content_details&per_page=100",
            course_id
        );
        let raw = self.fetch_json(&endpoint).await?;
        let modules: Vec<Value> = raw
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .map(|m| {
        let mod_locked = m.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false);
        let mod_unlock_at = m.get("unlock_at").cloned().unwrap_or(Value::Null);
        let items: Vec<Value> = m
          .get("items")
          .and_then(|v| v.as_array())
          .cloned()
          .unwrap_or_default()
          .into_iter()
          .map(|it| {
            let cd = it.get("content_details");
            let item_locked = it.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false)
              || cd
                .and_then(|c| c.get("locked_for_user"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
              || mod_locked;
            let lock_exp = it
              .get("lock_explanation")
              .or_else(|| cd.and_then(|c| c.get("lock_explanation")))
              .or_else(|| {
                cd.and_then(|c| c.get("lock_info"))
                  .and_then(|li| li.get("lock_explanation"))
              })
              .cloned()
              .unwrap_or(Value::Null);
            let unlock_at = cd
              .and_then(|c| c.get("unlock_at"))
              .or_else(|| {
                cd.and_then(|c| c.get("lock_info"))
                  .and_then(|li| li.get("unlock_at"))
              })
              .cloned()
              .unwrap_or_else(|| mod_unlock_at.clone());
            let lock_at = cd
              .and_then(|c| c.get("lock_at"))
              .or_else(|| {
                cd.and_then(|c| c.get("lock_info"))
                  .and_then(|li| li.get("lock_at"))
              })
              .cloned()
              .unwrap_or(Value::Null);

            let disp_name = cd
              .and_then(|c| c.get("display_name").or_else(|| c.get("filename")))
              .or_else(|| it.get("title"))
              .cloned()
              .unwrap_or(Value::Null);
            let fname = cd
              .and_then(|c| c.get("filename").or_else(|| c.get("display_name")))
              .or_else(|| it.get("title"))
              .cloned()
              .unwrap_or(Value::Null);
            let ctype = cd
              .and_then(|c| c.get("content_type").or_else(|| c.get("content-type")))
              .cloned()
              .unwrap_or(Value::Null);
            let sz = cd
              .and_then(|c| c.get("size"))
              .cloned()
              .unwrap_or(Value::Null);

            json!({
              "id": it.get("id").cloned().unwrap_or(Value::Null),
              "title": it.get("title").and_then(|v| v.as_str()).unwrap_or(""),
              "displayName": disp_name,
              "filename": fname,
              "contentType": ctype,
              "size": sz,
              "type": it.get("type").and_then(|v| v.as_str()).unwrap_or(""),
              "contentId": it.get("content_id").cloned().unwrap_or(Value::Null),
              "pageUrl": it.get("page_url").cloned().unwrap_or(Value::Null),
              "htmlUrl": it.get("html_url").cloned().unwrap_or(Value::Null),
              "url": it.get("url").cloned().unwrap_or(Value::Null),
              "externalUrl": it.get("external_url").cloned().unwrap_or(Value::Null),
              "indent": it.get("indent").and_then(|v| v.as_u64()).unwrap_or(0),
              "isLocked": item_locked,
              "lockedForUser": item_locked,
              "unlockAt": unlock_at,
              "lockAt": lock_at,
              "lockExplanation": lock_exp,
              "dueAt": cd.and_then(|c| c.get("due_at")).cloned().unwrap_or(Value::Null),
              "pointsPossible": cd.and_then(|c| c.get("points_possible")).cloned().unwrap_or(Value::Null),
            })
          })
          .collect();

        json!({
          "id": m.get("id").cloned().unwrap_or(Value::Null),
          "name": m.get("name").and_then(|v| v.as_str()).unwrap_or("モジュール"),
          "position": m.get("position").and_then(|v| v.as_u64()).unwrap_or(0),
          "state": m.get("state").cloned().unwrap_or(Value::Null),
          "unlockAt": mod_unlock_at,
          "itemsCount": m.get("items_count").and_then(|v| v.as_u64()).unwrap_or(items.len() as u64),
          "items": items,
        })
      })
      .collect();

        if let Ok(mut guard) = self.cache.lock() {
            guard.modules.insert(
                course_id.to_string(),
                TimedEntry {
                    time: now,
                    data: Value::Array(modules.clone()),
                },
            );
        }
        Ok(modules)
    }

    pub async fn get_course_files(
        &self,
        course_id: &str,
        force_refresh: bool,
    ) -> Result<Vec<Value>, String> {
        let now = now_ms();
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(entry) = guard.files.get(course_id) {
                    if now.saturating_sub(entry.time) < CACHE_TTL_MS {
                        if let Some(arr) = entry.data.as_array() {
                            return Ok(arr.clone());
                        }
                    }
                }
            }
        }

        let mut file_map: HashMap<String, Value> = HashMap::new();

        if let Ok(Value::Array(direct_files)) = self
            .fetch_json(&format!("/api/v1/courses/{}/files?per_page=100", course_id))
            .await
        {
            for f in direct_files {
                if let Some(id) = f.get("id") {
                    let id_str = match id {
                        Value::String(s) => s.clone(),
                        _ => id.to_string(),
                    };
                    let display_name = f
                        .get("display_name")
                        .or_else(|| f.get("filename"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("file");
                    let content_type = f
                        .get("content-type")
                        .or_else(|| f.get("content_type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("application/octet-stream");
                    let locked = f
                        .get("locked_for_user")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                        || f.get("hidden_for_user")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                    file_map.insert(
            id_str,
            json!({
              "id": id,
              "displayName": display_name,
              "filename": f.get("filename").and_then(|v| v.as_str()).unwrap_or(display_name),
              "size": f.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
              "contentType": content_type,
              "url": f.get("url").cloned().unwrap_or(Value::Null),
              "createdAt": f.get("created_at").cloned().unwrap_or(Value::Null),
              "updatedAt": f.get("updated_at").cloned().unwrap_or(Value::Null),
              "isLocked": locked,
              "lockedForUser": locked,
              "unlockAt": f.get("unlock_at").cloned().unwrap_or(Value::Null),
              "lockExplanation": f.get("lock_explanation").cloned().unwrap_or(Value::Null),
              "source": "files_tab",
            }),
          );
                }
            }
        }

        if let Ok(modules) = self.get_modules(course_id, force_refresh).await {
            for m in &modules {
                let m_name = m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let m_locked = m.get("isLocked").and_then(|v| v.as_bool()).unwrap_or(false);
                if let Some(items) = m.get("items").and_then(|v| v.as_array()) {
                    for it in items {
                        if it.get("type").and_then(|v| v.as_str()) == Some("File") {
                            if let Some(cid) = it.get("contentId").filter(|v| !v.is_null()) {
                                let cid_str = match cid {
                                    Value::String(s) => s.clone(),
                                    _ => cid.to_string(),
                                };
                                if !file_map.contains_key(&cid_str) {
                                    let title_str = it.get("title").and_then(|v| v.as_str()).unwrap_or("file");
                                    let disp_str = it.get("displayName").and_then(|v| v.as_str()).unwrap_or(title_str);
                                    let fname_str = it.get("filename").and_then(|v| v.as_str()).unwrap_or(title_str);
                                    let is_pdf = disp_str.to_lowercase().ends_with(".pdf")
                                        || fname_str.to_lowercase().ends_with(".pdf")
                                        || !disp_str.contains('.');
                                    let ct = it.get("contentType").and_then(|v| v.as_str()).unwrap_or(
                                        if is_pdf { "application/pdf" } else { "application/octet-stream" }
                                    );
                                    let sz = it.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                    let item_locked = it
                                        .get("isLocked")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false) || m_locked;

                                    file_map.insert(
                                        cid_str,
                                        json!({
                                            "id": cid.clone(),
                                            "displayName": disp_str,
                                            "filename": fname_str,
                                            "size": sz,
                                            "contentType": ct,
                                            "url": it.get("url").cloned().unwrap_or(Value::Null),
                                            "createdAt": Value::Null,
                                            "updatedAt": Value::Null,
                                            "isLocked": item_locked,
                                            "lockedForUser": item_locked,
                                            "unlockAt": it.get("unlockAt").cloned().unwrap_or(Value::Null),
                                            "lockExplanation": it.get("lockExplanation").cloned().unwrap_or(Value::Null),
                                            "moduleName": m_name.clone(),
                                            "source": "module",
                                        }),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        let result: Vec<Value> = file_map.into_values().collect();
        if let Ok(mut guard) = self.cache.lock() {
            guard.files.insert(
                course_id.to_string(),
                TimedEntry {
                    time: now,
                    data: Value::Array(result.clone()),
                },
            );
        }
        Ok(result)
    }

    pub async fn get_course_materials_grouped(
        &self,
        course_id: &str,
        force_refresh: bool,
    ) -> Result<Vec<Value>, String> {
        let now = now_ms();
        if !force_refresh {
            if let Ok(guard) = self.cache.lock() {
                if let Some(entry) = guard.grouped_materials.get(course_id) {
                    if now.saturating_sub(entry.time) < MATERIALS_CACHE_TTL_MS {
                        if let Some(arr) = entry.data.as_array() {
                            return Ok(arr.clone());
                        }
                    }
                }
            }
        }

        let (modules_res, files_res, assigns_res) = tokio::join!(
            self.get_modules(course_id, force_refresh),
            self.get_course_files(course_id, force_refresh),
            self.get_assignments(course_id, force_refresh, true)
        );

        let modules = modules_res.unwrap_or_default();
        let files = files_res.unwrap_or_default();
        let assignments = assigns_res.unwrap_or_default();

        let mut file_map_by_id: HashMap<String, Value> = HashMap::new();
        for f in &files {
            if let Some(id) = f.get("id") {
                let key = match id {
                    Value::String(s) => s.clone(),
                    _ => id.to_string(),
                };
                file_map_by_id.insert(key, f.clone());
            }
        }

        let mut assign_map_by_id: HashMap<String, Value> = HashMap::new();
        let mut assign_map_by_name: HashMap<String, Value> = HashMap::new();
        for a in &assignments {
            if let Some(id) = a.get("id") {
                let key = match id {
                    Value::String(s) => s.clone(),
                    _ => id.to_string(),
                };
                assign_map_by_id.insert(key, a.clone());
            }
            if let Some(name) = a.get("name").and_then(|v| v.as_str()) {
                assign_map_by_name.insert(name.trim().to_string(), a.clone());
            }
        }

        let mut grouped: Vec<Value> = Vec::new();
        let mut used_file_ids: HashSet<String> = HashSet::new();

        for m in &modules {
            let mut module_items: Vec<Value> = Vec::new();
            if let Some(items) = m.get("items").and_then(|v| v.as_array()) {
                for it in items {
                    let item_type = it.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let cid_opt = it
                        .get("contentId")
                        .filter(|v| !v.is_null())
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            _ => v.to_string(),
                        });

                    if item_type == "File" {
                        if let Some(ref cid_str) = cid_opt {
                            used_file_ids.insert(cid_str.clone());
                            if let Some(f_info) = file_map_by_id.get(cid_str) {
                                let mut merged = f_info.clone();
                                if let Some(obj) = merged.as_object_mut() {
                                    obj.insert(
                                        "itemId".to_string(),
                                        it.get("id").cloned().unwrap_or(Value::Null),
                                    );
                                    obj.insert("courseId".to_string(), json!(course_id));
                                    obj.insert(
                                        "title".to_string(),
                                        it.get("title").cloned().unwrap_or(Value::Null),
                                    );
                                    obj.insert(
                                        "indent".to_string(),
                                        it.get("indent").cloned().unwrap_or(json!(0)),
                                    );
                                    obj.insert("type".to_string(), json!("File"));
                                    if !obj.contains_key("contentType") || obj.get("contentType").map_or(true, |v| v.is_null()) {
                                        if let Some(ct) = it.get("contentType").filter(|v| !v.is_null()) {
                                            obj.insert("contentType".to_string(), ct.clone());
                                        }
                                    }
                                    if obj.get("size").and_then(|v| v.as_u64()).unwrap_or(0) == 0 {
                                        if let Some(sz) = it.get("size").filter(|v| !v.is_null()) {
                                            obj.insert("size".to_string(), sz.clone());
                                        }
                                    }
                                }
                                module_items.push(merged);
                                continue;
                            }
                        }
                    } else if item_type == "Page" {
                        module_items.push(json!({
              "id": it.get("id").cloned().unwrap_or(Value::Null),
              "itemId": it.get("id").cloned().unwrap_or(Value::Null),
              "courseId": course_id,
              "title": it.get("title").cloned().unwrap_or(Value::Null),
              "type": "Page",
              "pageUrl": it.get("pageUrl").cloned().unwrap_or(Value::Null),
              "htmlUrl": it.get("htmlUrl").cloned().unwrap_or(Value::Null),
              "isLocked": it.get("isLocked").and_then(|v| v.as_bool()).unwrap_or(false),
              "lockedForUser": it.get("lockedForUser").and_then(|v| v.as_bool()).unwrap_or(false),
              "unlockAt": it.get("unlockAt").cloned().unwrap_or(Value::Null),
              "lockExplanation": it.get("lockExplanation").cloned().unwrap_or(Value::Null),
              "indent": it.get("indent").cloned().unwrap_or(json!(0)),
            }));
                    } else if item_type == "Assignment" {
                        let title_str = it
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let assign_info = cid_opt
                            .as_ref()
                            .and_then(|k| assign_map_by_id.get(k))
                            .or_else(|| assign_map_by_name.get(title_str));
                        let resolved_aid = assign_info
                            .and_then(|a| a.get("id"))
                            .or_else(|| it.get("contentId"))
                            .or_else(|| it.get("id"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let is_locked = assign_info
                            .and_then(|a| a.get("isLocked"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                            || it
                                .get("isLocked")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);

                        module_items.push(json!({
              "id": resolved_aid,
              "itemId": it.get("id").cloned().unwrap_or(Value::Null),
              "contentId": resolved_aid,
              "assignmentId": resolved_aid,
              "courseId": course_id,
              "title": it.get("title").cloned().unwrap_or(Value::Null),
              "type": "Assignment",
              "htmlUrl": assign_info.and_then(|a| a.get("htmlUrl")).or_else(|| it.get("htmlUrl")).cloned().unwrap_or(Value::Null),
              "dueAt": assign_info.and_then(|a| a.get("dueAt")).or_else(|| it.get("dueAt")).cloned().unwrap_or(Value::Null),
              "pointsPossible": assign_info.and_then(|a| a.get("pointsPossible")).or_else(|| it.get("pointsPossible")).cloned().unwrap_or(Value::Null),
              "submissionTypes": assign_info.and_then(|a| a.get("submissionTypes")).cloned().unwrap_or_else(|| json!(["online_upload"])),
              "isSubmitted": assign_info.and_then(|a| a.get("isSubmitted")).and_then(|v| v.as_bool()).unwrap_or(false),
              "isGraded": assign_info.and_then(|a| a.get("isGraded")).and_then(|v| v.as_bool()).unwrap_or(false),
              "isLocked": is_locked,
              "lockedForUser": is_locked,
              "unlockAt": assign_info.and_then(|a| a.get("unlockAt")).or_else(|| it.get("unlockAt")).cloned().unwrap_or(Value::Null),
              "lockAt": assign_info.and_then(|a| a.get("lockAt")).or_else(|| it.get("lockAt")).cloned().unwrap_or(Value::Null),
              "lockExplanation": assign_info.and_then(|a| a.get("lockExplanation")).or_else(|| it.get("lockExplanation")).cloned().unwrap_or(Value::Null),
              "description": assign_info.and_then(|a| a.get("description")).and_then(|v| v.as_str()).unwrap_or(""),
              "submission": assign_info.and_then(|a| a.get("submission")).cloned().unwrap_or(Value::Null),
              "indent": it.get("indent").cloned().unwrap_or(json!(0)),
            }));
                    } else if item_type == "Discussion" {
                        let tid = it
                            .get("contentId")
                            .or_else(|| it.get("id"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        module_items.push(json!({
              "id": tid,
              "itemId": it.get("id").cloned().unwrap_or(Value::Null),
              "topicId": tid,
              "courseId": course_id,
              "title": it.get("title").cloned().unwrap_or(Value::Null),
              "type": "Discussion",
              "htmlUrl": it.get("htmlUrl").cloned().unwrap_or(Value::Null),
              "isLocked": it.get("isLocked").and_then(|v| v.as_bool()).unwrap_or(false),
              "lockedForUser": it.get("lockedForUser").and_then(|v| v.as_bool()).unwrap_or(false),
              "unlockAt": it.get("unlockAt").cloned().unwrap_or(Value::Null),
              "lockExplanation": it.get("lockExplanation").cloned().unwrap_or(Value::Null),
              "indent": it.get("indent").cloned().unwrap_or(json!(0)),
            }));
                    } else if item_type == "ExternalUrl"
                        || item_type == "ExternalTool"
                        || item_type == "Quiz"
                    {
                        module_items.push(json!({
              "id": it.get("id").cloned().unwrap_or(Value::Null),
              "itemId": it.get("id").cloned().unwrap_or(Value::Null),
              "contentId": it.get("contentId").cloned().unwrap_or(Value::Null),
              "courseId": course_id,
              "title": it.get("title").cloned().unwrap_or(Value::Null),
              "type": item_type,
              "url": it.get("externalUrl").or_else(|| it.get("htmlUrl")).or_else(|| it.get("url")).cloned().unwrap_or(Value::Null),
              "externalUrl": it.get("externalUrl").cloned().unwrap_or(Value::Null),
              "htmlUrl": it.get("htmlUrl").cloned().unwrap_or(Value::Null),
              "isLocked": it.get("isLocked").and_then(|v| v.as_bool()).unwrap_or(false),
              "lockedForUser": it.get("lockedForUser").and_then(|v| v.as_bool()).unwrap_or(false),
              "unlockAt": it.get("unlockAt").cloned().unwrap_or(Value::Null),
              "lockExplanation": it.get("lockExplanation").cloned().unwrap_or(Value::Null),
              "indent": it.get("indent").cloned().unwrap_or(json!(0)),
            }));
                    }
                }
            }

            if !module_items.is_empty() {
                grouped.push(json!({
                  "id": m.get("id").cloned().unwrap_or(Value::Null),
                  "name": m.get("name").cloned().unwrap_or_else(|| json!("モジュール")),
                  "position": m.get("position").cloned().unwrap_or(json!(0)),
                  "items": module_items,
                }));
            }
        }

        let remaining_files: Vec<Value> = files
            .into_iter()
            .filter(|f| {
                let id_str = f
                    .get("id")
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        _ => v.to_string(),
                    })
                    .unwrap_or_default();
                !used_file_ids.contains(&id_str)
            })
            .map(|mut f| {
                if let Some(obj) = f.as_object_mut() {
                    let title = obj
                        .get("displayName")
                        .or_else(|| obj.get("filename"))
                        .cloned()
                        .unwrap_or(json!("ファイル"));
                    obj.insert(
                        "itemId".to_string(),
                        obj.get("id").cloned().unwrap_or(Value::Null),
                    );
                    obj.insert("courseId".to_string(), json!(course_id));
                    obj.insert("title".to_string(), title);
                    obj.insert("type".to_string(), json!("File"));
                }
                f
            })
            .collect();

        if !remaining_files.is_empty() {
            grouped.push(json!({
              "id": "other_files",
              "name": "その他のコースファイル",
              "position": 999,
              "items": remaining_files,
            }));
        }

        if let Ok(mut guard) = self.cache.lock() {
            guard.grouped_materials.insert(
                course_id.to_string(),
                TimedEntry {
                    time: now,
                    data: Value::Array(grouped.clone()),
                },
            );
        }
        self.save_disk_cache();
        Ok(grouped)
    }

    pub async fn get_page(&self, course_id: &str, page_url: &str) -> Result<Value, String> {
        let mut clean_slug = page_url.trim().to_string();
        for _ in 0..3 {
            if let Ok(dec) = urlencoding::decode(&clean_slug) {
                let dec_str = dec.into_owned();
                if dec_str == clean_slug {
                    break;
                }
                clean_slug = dec_str;
            } else {
                break;
            }
        }

        let encoded_slug = urlencoding::encode(&clean_slug);
        let endpoint = format!("/api/v1/courses/{}/pages/{}", course_id, encoded_slug);
        let data = self.fetch_json(&endpoint).await?;

        Ok(json!({
          "title": data.get("title").cloned().unwrap_or_else(|| json!(clean_slug)),
          "body": data.get("body").and_then(|v| v.as_str()).unwrap_or(""),
          "createdAt": data.get("created_at").cloned().unwrap_or(Value::Null),
          "updatedAt": data.get("updated_at").cloned().unwrap_or(Value::Null),
          "htmlUrl": data.get("html_url").cloned().unwrap_or(Value::Null),
          "lockedForUser": data.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false),
          "lockExplanation": data.get("lock_explanation").or_else(|| data.get("lock_info").and_then(|li| li.get("lock_explanation"))).cloned().unwrap_or(Value::Null),
          "unlockAt": data.get("unlock_at").or_else(|| data.get("lock_info").and_then(|li| li.get("unlock_at"))).cloned().unwrap_or(Value::Null),
        }))
    }

    pub async fn get_course_discussions(&self, course_id: &str) -> Result<Vec<Value>, String> {
        let endpoint = format!(
            "/api/v1/courses/{}/discussion_topics?per_page=50",
            course_id
        );
        let raw = self.fetch_json(&endpoint).await?;
        let list = raw
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .map(|d| {
        json!({
          "id": d.get("id").cloned().unwrap_or(Value::Null),
          "title": d.get("title").and_then(|v| v.as_str()).unwrap_or("無題のトピック"),
          "message": d.get("message").and_then(|v| v.as_str()).unwrap_or(""),
          "postedAt": d.get("posted_at").or_else(|| d.get("created_at")).cloned().unwrap_or(Value::Null),
          "author": d.get("author").and_then(|a| a.get("display_name")).and_then(|v| v.as_str()).unwrap_or(""),
          "discussionSubentryCount": d.get("discussion_subentry_count").and_then(|v| v.as_u64()).unwrap_or(0),
          "htmlUrl": d.get("html_url").cloned().unwrap_or(Value::Null),
          "lockedForUser": d.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false),
          "lockExplanation": d.get("lock_explanation").cloned().unwrap_or(Value::Null),
        })
      })
      .collect();
        Ok(list)
    }

    pub async fn get_discussion_topic(
        &self,
        course_id: &str,
        topic_id: &str,
    ) -> Result<Value, String> {
        let endpoint = format!(
            "/api/v1/courses/{}/discussion_topics/{}",
            course_id, topic_id
        );
        let data = self.fetch_json(&endpoint).await?;
        Ok(json!({
          "id": data.get("id").cloned().unwrap_or(Value::Null),
          "title": data.get("title").and_then(|v| v.as_str()).unwrap_or("ディスカッション"),
          "body": data.get("message").and_then(|v| v.as_str()).unwrap_or(""),
          "postedAt": data.get("posted_at").or_else(|| data.get("created_at")).cloned().unwrap_or(Value::Null),
          "author": data.get("author").and_then(|a| a.get("display_name")).and_then(|v| v.as_str()).unwrap_or(""),
          "htmlUrl": data.get("html_url").cloned().unwrap_or(Value::Null),
          "lockedForUser": data.get("locked_for_user").and_then(|v| v.as_bool()).unwrap_or(false),
          "lockExplanation": data.get("lock_explanation").cloned().unwrap_or(Value::Null),
        }))
    }

    pub async fn get_announcements(&self, force_refresh: bool) -> Result<Vec<Value>, String> {
        let courses = self.get_courses(force_refresh).await?;
        if courses.is_empty() {
            return Ok(Vec::new());
        }
        let context_codes: Vec<String> = courses
            .iter()
            .take(25)
            .filter_map(|c| {
                c.get("id")
                    .map(|id| format!("context_codes[]=course_{}", id))
            })
            .collect();
        if context_codes.is_empty() {
            return Ok(Vec::new());
        }

        let endpoint = format!(
            "/api/v1/announcements?per_page=40&{}",
            context_codes.join("&")
        );
        let raw = self
            .fetch_json(&endpoint)
            .await
            .unwrap_or_else(|_| json!([]));
        let mut course_name_map: HashMap<String, String> = HashMap::new();
        for c in &courses {
            if let Some(id) = c.get("id") {
                let key = format!("course_{}", id);
                let cname = c
                    .get("cleanName")
                    .or_else(|| c.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                course_name_map.insert(key, cname);
            }
        }

        let list: Vec<Value> = raw
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .map(|a| {
        let ctx = a.get("context_code").and_then(|v| v.as_str()).unwrap_or("");
        let cname = course_name_map.get(ctx).cloned().unwrap_or_default();
        let cid = ctx.strip_prefix("course_").unwrap_or("");
        json!({
          "id": a.get("id").cloned().unwrap_or(Value::Null),
          "title": a.get("title").and_then(|v| v.as_str()).unwrap_or("お知らせ"),
          "message": a.get("message").and_then(|v| v.as_str()).unwrap_or(""),
          "postedAt": a.get("posted_at").or_else(|| a.get("created_at")).cloned().unwrap_or(Value::Null),
          "author": a.get("author").and_then(|au| au.get("display_name")).and_then(|v| v.as_str()).unwrap_or(""),
          "courseName": cname,
          "courseId": cid,
          "htmlUrl": a.get("html_url").cloned().unwrap_or(Value::Null),
        })
      })
      .collect();
        Ok(list)
    }

    pub async fn resolve_file_download(
        &self,
        file_id: &str,
        course_id: Option<&str>,
    ) -> Result<Value, String> {
        let now = now_ms();
        if let Ok(guard) = self.cache.lock() {
            if let Some(entry) = guard.resolved_urls.get(file_id) {
                if now.saturating_sub(entry.time) < 10 * 60 * 1000 {
                    return Ok(entry.data.clone());
                }
            }
        }

        if let Some(cid) = course_id.filter(|s| !s.is_empty()) {
            if let Ok(f_data) = self
                .fetch_json(&format!("/api/v1/courses/{}/files/{}", cid, file_id))
                .await
            {
                if let Ok(mut guard) = self.cache.lock() {
                    guard.resolved_urls.insert(
                        file_id.to_string(),
                        TimedEntry {
                            time: now,
                            data: f_data.clone(),
                        },
                    );
                }
                return Ok(f_data);
            }
        }

        let f_data = self
            .fetch_json(&format!("/api/v1/files/{}", file_id))
            .await?;
        if let Ok(mut guard) = self.cache.lock() {
            guard.resolved_urls.insert(
                file_id.to_string(),
                TimedEntry {
                    time: now,
                    data: f_data.clone(),
                },
            );
        }
        Ok(f_data)
    }

    pub async fn get_assignment_submission(
        &self,
        course_id: &str,
        assignment_id: &str,
    ) -> Result<Value, String> {
        let endpoint = format!(
            "/api/v1/courses/{}/assignments/{}/submissions/self?include[]=submission_history&include[]=submission_comments&include[]=rubric_assessment&include[]=assignment",
            course_id, assignment_id
        );
        let sub = self.fetch_json(&endpoint).await?;

        let mut attachments = sub
            .get("attachments")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if let Some(hist) = sub.get("submission_history").and_then(|v| v.as_array()) {
            let mut sorted_hist = hist.clone();
            sorted_hist.sort_by(|a, b| {
                let aa = a.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0);
                let ba = b.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0);
                ba.cmp(&aa)
            });
            if let Some(latest_atts) = sorted_hist
                .first()
                .and_then(|h| h.get("attachments"))
                .and_then(|v| v.as_array())
            {
                if !latest_atts.is_empty() {
                    let mut seen = HashSet::new();
                    let mut merged = Vec::new();
                    for att in latest_atts {
                        let id_s = att.get("id").map(|v| v.to_string()).unwrap_or_default();
                        seen.insert(id_s);
                        merged.push(att.clone());
                    }
                    for att in attachments {
                        let id_s = att.get("id").map(|v| v.to_string()).unwrap_or_default();
                        if !seen.contains(&id_s) {
                            merged.push(att);
                        }
                    }
                    attachments = merged;
                }
            }
        }

        let assign_obj = sub.get("assignment").filter(|v| !v.is_null());
        let wf = sub
            .get("workflow_state")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let is_locked = assign_obj
            .and_then(|a| a.get("locked_for_user"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mapped_atts: Vec<Value> = attachments
      .into_iter()
      .map(|att| {
        json!({
          "id": att.get("id").cloned().unwrap_or(Value::Null),
          "displayName": att.get("display_name").or_else(|| att.get("filename")).cloned().unwrap_or(Value::Null),
          "filename": att.get("filename").cloned().unwrap_or(Value::Null),
          "size": att.get("size").cloned().unwrap_or(Value::Null),
          "contentType": att.get("content_type").or_else(|| att.get("content-type")).cloned().unwrap_or(Value::Null),
          "url": att.get("url").cloned().unwrap_or(Value::Null),
          "createdAt": att.get("created_at").cloned().unwrap_or(Value::Null),
        })
      })
      .collect();

        let override_key = format!("{}_{}", course_id, assignment_id);
        let ov_entry = self
            .cache
            .lock()
            .ok()
            .and_then(|g| g.submitted_overrides.get(&override_key).cloned());
        let is_submitted = is_submission_completed(Some(&sub), ov_entry.as_ref());
        let is_graded = wf == "graded" || sub.get("score").filter(|v| !v.is_null()).is_some();

        Ok(json!({
          "id": sub.get("id").cloned().unwrap_or(Value::Null),
          "assignmentId": sub.get("assignment_id").cloned().unwrap_or_else(|| json!(assignment_id)),
          "userId": sub.get("user_id").cloned().unwrap_or(Value::Null),
          "submittedAt": sub.get("submitted_at").cloned().unwrap_or(Value::Null),
          "score": sub.get("score").cloned().unwrap_or(Value::Null),
          "grade": sub.get("grade").cloned().unwrap_or(Value::Null),
          "workflowState": sub.get("workflow_state").cloned().unwrap_or(Value::Null),
          "attempt": sub.get("attempt").cloned().unwrap_or(Value::Null),
          "body": sub.get("body").cloned().unwrap_or(Value::Null),
          "url": sub.get("url").cloned().unwrap_or(Value::Null),
          "submissionType": sub.get("submission_type").cloned().unwrap_or(Value::Null),
          "late": sub.get("late").and_then(|v| v.as_bool()).unwrap_or(false),
          "missing": sub.get("missing").and_then(|v| v.as_bool()).unwrap_or(false),
          "isSubmitted": is_submitted,
          "isGraded": is_graded,
          "assignmentDescription": assign_obj.and_then(|a| a.get("description")).cloned().unwrap_or(Value::Null),
          "assignmentDueAt": assign_obj.and_then(|a| a.get("due_at")).cloned().unwrap_or(Value::Null),
          "assignmentPointsPossible": assign_obj.and_then(|a| a.get("points_possible")).cloned().unwrap_or(Value::Null),
          "assignmentSubmissionTypes": assign_obj.and_then(|a| a.get("submission_types")).cloned().unwrap_or(Value::Null),
          "assignmentHtmlUrl": assign_obj.and_then(|a| a.get("html_url")).cloned().unwrap_or(Value::Null),
          "assignmentIsLocked": is_locked,
          "assignmentLockedForUser": is_locked,
          "assignmentLockExplanation": assign_obj.and_then(|a| a.get("lock_explanation").or_else(|| a.get("lock_info").and_then(|li| li.get("lock_explanation")))).cloned().unwrap_or(Value::Null),
          "assignmentUnlockAt": assign_obj.and_then(|a| a.get("unlock_at").or_else(|| a.get("lock_info").and_then(|li| li.get("unlock_at")))).cloned().unwrap_or(Value::Null),
          "assignmentLockAt": assign_obj.and_then(|a| a.get("lock_at").or_else(|| a.get("lock_info").and_then(|li| li.get("lock_at")))).cloned().unwrap_or(Value::Null),
          "attachments": mapped_atts,
        }))
    }

    pub fn mark_submission_override(&self, course_id: &str, assignment_id: &str, data: Value) {
        if let Ok(mut guard) = self.cache.lock() {
            guard.submitted_overrides.insert(
                format!("{}_{}", course_id, assignment_id),
                TimedEntry {
                    time: now_ms(),
                    data,
                },
            );
        }
    }

    pub fn invalidate_course_assignment_cache(&self, course_id: &str) {
        if let Ok(mut guard) = self.cache.lock() {
            guard.assignments.remove(&format!("{}_recent", course_id));
            guard.assignments.remove(&format!("{}_all", course_id));
            guard.assignments.remove(course_id);
            guard.grouped_materials.remove(course_id);
            guard.all_assignments = None;
        }
        self.save_disk_cache();
    }

    pub async fn upload_and_submit_assignment(
        &self,
        course_id: &str,
        assignment_id: &str,
        files: Vec<UploadFilePayload>,
        retain_file_ids: Vec<String>,
        comment: Option<String>,
    ) -> Result<Value, String> {
        let base_url = self.get_base_url();
        let token = self.get_api_token();
        let mut uploaded_ids: Vec<String> = retain_file_ids;

        for f in files {
            // Step 1: Request upload slot
            let step1_url = format!(
                "{}/api/v1/courses/{}/assignments/{}/submissions/self/files",
                base_url, course_id, assignment_id
            );
            let step1_res = self
                .client
                .post(&step1_url)
                .header("Authorization", format!("Bearer {}", token))
                .form(&[
                    ("name", f.filename.as_str()),
                    ("size", &f.bytes.len().to_string()),
                    ("content_type", f.content_type.as_str()),
                ])
                .send()
                .await
                .map_err(|e| format!("Upload step 1 failed: {e}"))?;

            if !step1_res.status().is_success() {
                let txt = step1_res.text().await.unwrap_or_default();
                return Err(format!("Upload slot error: {txt}"));
            }
            let slot_json: Value = step1_res
                .json()
                .await
                .map_err(|e| format!("Upload slot JSON error: {e}"))?;

            let upload_url = slot_json
                .get("upload_url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing upload_url from Canvas".to_string())?;

            let mut form = reqwest::multipart::Form::new();
            if let Some(params) = slot_json.get("upload_params").and_then(|v| v.as_object()) {
                for (k, v) in params {
                    let val_str = match v {
                        Value::String(s) => s.clone(),
                        _ => v.to_string(),
                    };
                    form = form.text(k.clone(), val_str);
                }
            }
            let part = reqwest::multipart::Part::bytes(f.bytes)
                .file_name(f.filename.clone())
                .mime_str(&f.content_type)
                .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));
            form = form.part("file", part);

            let step2_res = self
                .client
                .post(upload_url)
                .multipart(form)
                .send()
                .await
                .map_err(|e| format!("Upload step 2 failed: {e}"))?;

            let step2_json: Value = step2_res
                .json()
                .await
                .map_err(|e| format!("Upload finalize JSON error: {e}"))?;
            if let Some(fid) = step2_json.get("id") {
                let id_str = match fid {
                    Value::String(s) => s.clone(),
                    _ => fid.to_string(),
                };
                uploaded_ids.push(id_str);
            }
        }

        let submit_url = format!(
            "{}/api/v1/courses/{}/assignments/{}/submissions",
            base_url, course_id, assignment_id
        );
        let mut params: Vec<(String, String)> = vec![(
            "submission[submission_type]".to_string(),
            "online_upload".to_string(),
        )];
        for fid in &uploaded_ids {
            params.push(("submission[file_ids][]".to_string(), fid.clone()));
        }
        if let Some(c) = comment.filter(|s| !s.trim().is_empty()) {
            params.push(("comment[text_comment]".to_string(), c));
        }

        let sub_res = self
            .client
            .post(&submit_url)
            .header("Authorization", format!("Bearer {}", token))
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Submission POST failed: {e}"))?;

        if !sub_res.status().is_success() {
            let err_txt = sub_res.text().await.unwrap_or_default();
            return Err(format!("Submission failed: {err_txt}"));
        }

        let parsed = sub_res
            .json::<Value>()
            .await
            .map_err(|e| format!("Submission response parse error: {e}"))?;
        self.mark_submission_override(course_id, assignment_id, parsed.clone());
        self.invalidate_course_assignment_cache(course_id);
        Ok(parsed)
    }

    pub async fn submit_text_assignment(
        &self,
        course_id: &str,
        assignment_id: &str,
        text_body: &str,
        comment: Option<String>,
    ) -> Result<Value, String> {
        let base_url = self.get_base_url();
        let token = self.get_api_token();
        let html_body = if text_body.contains('<') && text_body.contains('>') {
            text_body.to_string()
        } else {
            text_body
                .split('\n')
                .map(|line| {
                    if line.trim().is_empty() {
                        "<p><br></p>".to_string()
                    } else {
                        format!("<p>{}</p>", line)
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        };

        let submit_url = format!(
            "{}/api/v1/courses/{}/assignments/{}/submissions",
            base_url, course_id, assignment_id
        );
        let mut params = vec![
            (
                "submission[submission_type]".to_string(),
                "online_text_entry".to_string(),
            ),
            ("submission[body]".to_string(), html_body),
        ];
        if let Some(c) = comment.filter(|s| !s.trim().is_empty()) {
            params.push(("comment[text_comment]".to_string(), c));
        }

        let res = self
            .client
            .post(&submit_url)
            .header("Authorization", format!("Bearer {}", token))
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Text submission failed: {e}"))?;

        if !res.status().is_success() {
            let txt = res.text().await.unwrap_or_default();
            return Err(format!("Text submission error: {txt}"));
        }
        let parsed = res.json::<Value>().await.map_err(|e| e.to_string())?;
        self.mark_submission_override(course_id, assignment_id, parsed.clone());
        self.invalidate_course_assignment_cache(course_id);
        Ok(parsed)
    }

    pub async fn submit_url_assignment(
        &self,
        course_id: &str,
        assignment_id: &str,
        url_entry: &str,
        comment: Option<String>,
    ) -> Result<Value, String> {
        let base_url = self.get_base_url();
        let token = self.get_api_token();
        let submit_url = format!(
            "{}/api/v1/courses/{}/assignments/{}/submissions",
            base_url, course_id, assignment_id
        );
        let mut params = vec![
            (
                "submission[submission_type]".to_string(),
                "online_url".to_string(),
            ),
            ("submission[url]".to_string(), url_entry.to_string()),
        ];
        if let Some(c) = comment.filter(|s| !s.trim().is_empty()) {
            params.push(("comment[text_comment]".to_string(), c));
        }

        let res = self
            .client
            .post(&submit_url)
            .header("Authorization", format!("Bearer {}", token))
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("URL submission failed: {e}"))?;

        if !res.status().is_success() {
            let txt = res.text().await.unwrap_or_default();
            return Err(format!("URL submission error: {txt}"));
        }
        let parsed = res.json::<Value>().await.map_err(|e| e.to_string())?;
        self.mark_submission_override(course_id, assignment_id, parsed.clone());
        self.invalidate_course_assignment_cache(course_id);
        Ok(parsed)
    }
}
