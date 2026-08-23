//! Qoder session history.
//!
//! Primary: read `~/.qoder/projects/<cwd-slug>/<sessionId>.jsonl` (Grok/PI/Kimi
//! NativeHistoryReader shape). ACP `session/list` / `session/load` is fallback
//! when the jsonl is missing. Delete still goes through ACP `session/delete`
//! (红线 21: do not mutate vendor files).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::qoder::{
    extract_content_text, extract_qoder_tool_call_id, extract_qoder_tool_content_text,
    extract_qoder_tool_name, parse_acp_line, run_qoder_acp_initialized_for_distribution, AcpLine,
    QODER_DELETE_TIMEOUT, QODER_LIST_TIMEOUT, QODER_LOAD_TIMEOUT, QODER_RPC_HANDSHAKE_TIMEOUT,
};
use super::qoder_provider_profile::{
    resolve_qoder_home_dir, resolve_qoder_provider_launch_profile, QoderDistributionSettings,
    QoderProviderLaunchProfile,
};

const MAX_TITLE_CHARS: usize = 80;
const MAX_QODER_PROJECT_DIR_SCAN: usize = 128;

fn normalize_session_id(session_id: &str) -> Result<String, String> {
    let normalized = session_id.trim();
    if normalized.is_empty()
        || normalized == "."
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains("..")
    {
        return Err("[SESSION_NOT_FOUND] Invalid Qoder session id".to_string());
    }
    Ok(normalized.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderSessionSummary {
    pub session_id: String,
    pub first_message: String,
    pub updated_at: i64,
    pub created_at: i64,
    pub message_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribution_status: Option<String>,
    /// Explicit for newly discovered Global/CN history. Historic callers may
    /// still omit it; their compatibility resolver remains Global.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderSessionMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// "message", "reasoning", or "tool"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QoderSessionUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderSessionLoadResult {
    pub messages: Vec<QoderSessionMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<QoderSessionUsage>,
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    format!("{truncated}…")
}

fn normalize_path_for_comparison(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut value = trimmed.replace('\\', "/");
    while value.ends_with('/') && value.len() > 1 {
        value.pop();
    }
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

pub(crate) fn paths_match(left: &str, right: &str) -> bool {
    normalize_path_for_comparison(left) == normalize_path_for_comparison(right)
}

fn workspace_path_variants(workspace_path: &Path) -> Vec<String> {
    let raw = workspace_path.to_string_lossy().replace('\\', "/");
    let mut variants = vec![raw.clone()];
    if let Ok(canonical) = fs::canonicalize(workspace_path) {
        variants.push(canonical.to_string_lossy().replace('\\', "/"));
    }
    if let Some(rest) = raw.strip_prefix("/private/tmp") {
        variants.push(format!("/tmp{rest}"));
    } else if let Some(rest) = raw.strip_prefix("/tmp") {
        variants.push(format!("/private/tmp{rest}"));
    }
    variants.sort();
    variants.dedup();
    variants
}

fn record_matches_workspace_path(record_path: &str, workspace_path: &Path) -> bool {
    workspace_path_variants(workspace_path)
        .iter()
        .any(|workspace| paths_match(record_path, workspace))
}

/// `/Users/foo/bar` → `-Users-foo-bar` (qodercli 1.1.28 project dir names).
pub(crate) fn encode_qoder_project_slug(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    while value.ends_with('/') && value.len() > 1 {
        value.pop();
    }
    if value.is_empty() {
        return String::new();
    }
    value.replace('/', "-")
}

fn push_unique_slug(slugs: &mut Vec<String>, path: &str) {
    let slug = encode_qoder_project_slug(path);
    if !slug.is_empty() && !slugs.iter().any(|existing| existing == &slug) {
        slugs.push(slug);
    }
}

pub(crate) fn candidate_qoder_project_slugs(workspace_path: &Path) -> Vec<String> {
    let mut slugs = Vec::new();
    for path in workspace_path_variants(workspace_path) {
        push_unique_slug(&mut slugs, &path);
    }
    slugs
}

fn qoder_projects_root(home_dir: Option<&str>) -> PathBuf {
    resolve_qoder_home_dir(home_dir.map(Path::new))
        .unwrap_or_else(|| PathBuf::from(".qoder"))
        .join("projects")
}

fn qoder_projects_root_for_launch_profile(
    launch_profile: &QoderProviderLaunchProfile,
) -> Option<PathBuf> {
    launch_profile
        .home_dir
        .as_ref()
        .map(|home| home.join("projects"))
}

fn is_sidechain_record(record: &Value) -> bool {
    match record.get("isSidechain") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(value)) => value.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn extract_command_name(text: &str) -> Option<String> {
    let start = text.find("<command-name>")?;
    let rest = &text[start + "<command-name>".len()..];
    let end = rest.find("</command-name>")?;
    let name = rest[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn extract_user_visible_text(record: &Value) -> Option<String> {
    if record.get("toolUseResult").is_some() {
        return None;
    }
    if is_sidechain_record(record) {
        return None;
    }
    if let Some(text) = record
        .get("humanInput")
        .and_then(|input| input.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    match record
        .get("message")
        .and_then(|message| message.get("content"))
    {
        Some(Value::String(text)) => {
            if let Some(command) = extract_command_name(text) {
                return Some(command);
            }
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn file_mtime_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|duration| duration.as_millis() as i64)
        })
        .unwrap_or(0)
}

fn find_qoder_session_jsonl(
    workspace_path: &Path,
    session_id: &str,
    home_dir: Option<&str>,
) -> Option<PathBuf> {
    let root = qoder_projects_root(home_dir);
    for slug in candidate_qoder_project_slugs(workspace_path) {
        let candidate = root.join(&slug).join(format!("{session_id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    find_qoder_session_jsonl_by_workspace_metadata(&root, workspace_path, session_id)
}

fn find_qoder_session_jsonl_by_workspace_metadata(
    projects_root: &Path,
    workspace_path: &Path,
    session_id: &str,
) -> Option<PathBuf> {
    let entries = fs::read_dir(projects_root).ok()?;
    let mut scanned_dirs = 0usize;
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        scanned_dirs += 1;
        if scanned_dirs > MAX_QODER_PROJECT_DIR_SCAN {
            break;
        }
        let candidate = project_dir.join(format!("{session_id}.jsonl"));
        if candidate.is_file() && jsonl_cwd_matches(&candidate, workspace_path) {
            return Some(candidate);
        }
    }
    None
}

fn tool_result_text(record: &Value) -> (Option<String>, Option<Value>, Option<String>) {
    let output = record.get("toolUseResult").cloned();
    let mut tool_id = None;
    let mut text = String::new();
    if let Some(blocks) = record
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            if tool_id.is_none() {
                tool_id = block
                    .get("tool_use_id")
                    .or_else(|| block.get("toolUseId"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            let chunk = match block.get("content") {
                Some(Value::String(value)) => value.clone(),
                other => extract_content_text(other),
            };
            if !chunk.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&chunk);
            }
        }
    }
    (
        tool_id,
        output,
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        },
    )
}

fn parse_qoder_jsonl_messages_checked(path: &Path) -> Result<Vec<QoderSessionMessage>, String> {
    let file = fs::File::open(path).map_err(|error| {
        format!(
            "Failed to read Qoder native history {}: {error}",
            path.display()
        )
    })?;
    let mut messages: Vec<QoderSessionMessage> = Vec::new();
    let mut tool_positions: HashMap<String, usize> = HashMap::new();
    let mut saw_nonempty_line = false;
    let mut parsed_record_count = 0usize;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| {
            format!(
                "Failed to read Qoder native history {}: {error}",
                path.display()
            )
        })?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        saw_nonempty_line = true;
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        parsed_record_count += 1;
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        if is_sidechain_record(&record) {
            continue;
        }
        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match kind {
            "user" => {
                if record.get("toolUseResult").is_some() {
                    let (tool_id, output, text) = tool_result_text(&record);
                    let Some(tool_id) = tool_id else {
                        continue;
                    };
                    if let Some(&index) = tool_positions.get(&tool_id) {
                        let existing = &mut messages[index];
                        if let Some(text) = text {
                            if existing.text.is_empty() {
                                existing.text = text;
                            }
                        }
                        if existing.tool_output.is_none() {
                            existing.tool_output = output;
                        }
                    }
                    continue;
                }
                let Some(text) = extract_user_visible_text(&record) else {
                    continue;
                };
                let id = record
                    .get("uuid")
                    .and_then(Value::as_str)
                    .map(|uuid| format!("message:{uuid}"))
                    .unwrap_or_else(|| format!("qoder-user-{}", messages.len() + 1));
                messages.push(QoderSessionMessage {
                    id,
                    role: "user".to_string(),
                    text,
                    images: None,
                    timestamp,
                    kind: "message".to_string(),
                    tool_type: None,
                    title: None,
                    tool_input: None,
                    tool_output: None,
                });
            }
            "assistant" => {
                let uuid = record.get("uuid").and_then(Value::as_str);
                let content = record
                    .get("message")
                    .and_then(|message| message.get("content"));
                match content {
                    Some(Value::Array(blocks)) => {
                        for block in blocks {
                            let block_type =
                                block.get("type").and_then(Value::as_str).unwrap_or("");
                            match block_type {
                                "thinking" => {
                                    let text = extract_content_text(Some(block));
                                    if text.trim().is_empty() {
                                        continue;
                                    }
                                    let id = uuid
                                        .map(|value| format!("reasoning:{value}"))
                                        .unwrap_or_else(|| {
                                            format!("qoder-reasoning-{}", messages.len() + 1)
                                        });
                                    messages.push(QoderSessionMessage {
                                        id,
                                        role: "assistant".to_string(),
                                        text,
                                        images: None,
                                        timestamp: timestamp.clone(),
                                        kind: "reasoning".to_string(),
                                        tool_type: None,
                                        title: None,
                                        tool_input: None,
                                        tool_output: None,
                                    });
                                }
                                "text" => {
                                    let text = extract_content_text(Some(block));
                                    if text.trim().is_empty() {
                                        continue;
                                    }
                                    let id = uuid
                                        .map(|value| format!("message:{value}"))
                                        .unwrap_or_else(|| {
                                            format!("qoder-assistant-{}", messages.len() + 1)
                                        });
                                    messages.push(QoderSessionMessage {
                                        id,
                                        role: "assistant".to_string(),
                                        text,
                                        images: None,
                                        timestamp: timestamp.clone(),
                                        kind: "message".to_string(),
                                        tool_type: None,
                                        title: None,
                                        tool_input: None,
                                        tool_output: None,
                                    });
                                }
                                "tool_use" => {
                                    let tool_id = block
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    if tool_id.is_empty() {
                                        continue;
                                    }
                                    let name = block
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("tool")
                                        .to_string();
                                    let message_id = format!("tool:{tool_id}");
                                    tool_positions.insert(tool_id, messages.len());
                                    messages.push(QoderSessionMessage {
                                        id: message_id,
                                        role: "assistant".to_string(),
                                        text: String::new(),
                                        images: None,
                                        timestamp: timestamp.clone(),
                                        kind: "tool".to_string(),
                                        tool_type: Some(name.clone()),
                                        title: Some(name),
                                        tool_input: block.get("input").cloned(),
                                        tool_output: None,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Value::String(text)) if !text.trim().is_empty() => {
                        let id = uuid
                            .map(|value| format!("message:{value}"))
                            .unwrap_or_else(|| format!("qoder-assistant-{}", messages.len() + 1));
                        messages.push(QoderSessionMessage {
                            id,
                            role: "assistant".to_string(),
                            text: text.clone(),
                            images: None,
                            timestamp,
                            kind: "message".to_string(),
                            tool_type: None,
                            title: None,
                            tool_input: None,
                            tool_output: None,
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if saw_nonempty_line && parsed_record_count == 0 {
        return Err(format!(
            "Qoder native history is not valid NDJSON: {}",
            path.display()
        ));
    }
    Ok(messages)
}

pub(crate) fn parse_qoder_jsonl_messages(path: &Path) -> Vec<QoderSessionMessage> {
    parse_qoder_jsonl_messages_checked(path).unwrap_or_default()
}

fn summarize_qoder_jsonl(path: &Path, session_id: &str) -> Option<QoderSessionSummary> {
    let file = fs::File::open(path).ok()?;
    let file_size_bytes = fs::metadata(path).ok().map(|meta| meta.len());
    let mut first_message = String::new();
    let mut ai_title = String::new();
    let mut last_prompt = String::new();
    let mut created_at = 0i64;
    let mut updated_at = 0i64;
    let mut message_count = 0usize;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = parse_millis(record.get("timestamp"));
        if created_at == 0 && ts > 0 {
            created_at = ts;
        }
        if ts > updated_at {
            updated_at = ts;
        }
        match kind {
            "ai-title" => {
                if let Some(title) = record.get("aiTitle").and_then(Value::as_str) {
                    if !title.trim().is_empty() {
                        ai_title = title.to_string();
                    }
                }
            }
            "last-prompt" => {
                if let Some(prompt) = record.get("lastPrompt").and_then(Value::as_str) {
                    if !prompt.trim().is_empty() {
                        last_prompt = prompt.to_string();
                    }
                }
            }
            "user" => {
                if extract_user_visible_text(&record).is_some() {
                    message_count += 1;
                    if first_message.is_empty() {
                        if let Some(text) = extract_user_visible_text(&record) {
                            first_message = text;
                        }
                    }
                }
            }
            "assistant" => message_count += 1,
            _ => {}
        }
    }
    let title = if !ai_title.is_empty() {
        ai_title
    } else if !first_message.is_empty() {
        first_message
    } else {
        last_prompt
    };
    if updated_at == 0 {
        updated_at = file_mtime_millis(path);
    }
    Some(QoderSessionSummary {
        session_id: session_id.to_string(),
        first_message: truncate_chars(&title, MAX_TITLE_CHARS),
        updated_at,
        created_at,
        message_count,
        file_size_bytes,
        engine: Some("qoder".to_string()),
        canonical_session_id: Some(session_id.to_string()),
        attribution_status: Some("strict-match".to_string()),
        provider_profile_id: None,
        provider_profile_name: None,
    })
}

fn list_qoder_jsonl_in_dir(dir: &Path) -> Vec<QoderSessionSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if let Some(summary) = summarize_qoder_jsonl(&path, session_id) {
            sessions.push(summary);
        }
    }
    sessions
}

fn jsonl_cwd_matches(path: &Path, workspace_path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    for line in BufReader::new(file).lines().take(8) {
        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) == Some("workspace-directories") {
            if let Some(dirs) = record.get("directories").and_then(Value::as_array) {
                if dirs.iter().any(|dir| {
                    dir.as_str()
                        .is_some_and(|value| record_matches_workspace_path(value, workspace_path))
                }) {
                    return true;
                }
            }
        }
        if let Some(cwd) = record.get("cwd").and_then(Value::as_str) {
            if record_matches_workspace_path(cwd, workspace_path) {
                return true;
            }
        }
    }
    false
}

fn list_qoder_sessions_from_disk(
    workspace_path: &Path,
    home_dir: Option<&str>,
) -> (Vec<QoderSessionSummary>, bool) {
    let root = qoder_projects_root(home_dir);
    if !root.is_dir() {
        return (Vec::new(), false);
    }
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let mut found_workspace_source = false;
    for slug in candidate_qoder_project_slugs(workspace_path) {
        let dir = root.join(&slug);
        if !dir.is_dir() {
            continue;
        }
        found_workspace_source = true;
        for summary in list_qoder_jsonl_in_dir(&dir) {
            if seen.insert(summary.session_id.clone()) {
                sessions.push(summary);
            }
        }
    }
    if sessions.is_empty() && !found_workspace_source {
        if let Ok(entries) = fs::read_dir(&root) {
            let mut scanned_dirs = 0usize;
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                scanned_dirs += 1;
                if scanned_dirs > MAX_QODER_PROJECT_DIR_SCAN {
                    break;
                }
                let Ok(files) = fs::read_dir(&dir) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                        || !path.is_file()
                        || !jsonl_cwd_matches(&path, workspace_path)
                    {
                        continue;
                    }
                    let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                        continue;
                    };
                    if seen.insert(session_id.to_string()) {
                        if let Some(summary) = summarize_qoder_jsonl(&path, session_id) {
                            found_workspace_source = true;
                            sessions.push(summary);
                        }
                    }
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    (sessions, found_workspace_source)
}

fn list_qoder_sessions_from_disk_for_launch_profile(
    workspace_path: &Path,
    launch_profile: &QoderProviderLaunchProfile,
) -> (Vec<QoderSessionSummary>, bool) {
    let Some(root) = qoder_projects_root_for_launch_profile(launch_profile) else {
        return (Vec::new(), false);
    };
    if !root.is_dir() {
        return (Vec::new(), false);
    }
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let mut found_workspace_source = false;
    for slug in candidate_qoder_project_slugs(workspace_path) {
        let dir = root.join(&slug);
        if !dir.is_dir() {
            continue;
        }
        found_workspace_source = true;
        for summary in list_qoder_jsonl_in_dir(&dir) {
            if seen.insert(summary.session_id.clone()) {
                sessions.push(summary);
            }
        }
    }
    if sessions.is_empty() && !found_workspace_source {
        if let Ok(entries) = fs::read_dir(&root) {
            let mut scanned_dirs = 0usize;
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                scanned_dirs += 1;
                if scanned_dirs > MAX_QODER_PROJECT_DIR_SCAN {
                    break;
                }
                let Ok(files) = fs::read_dir(&dir) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                        || !path.is_file()
                        || !jsonl_cwd_matches(&path, workspace_path)
                    {
                        continue;
                    }
                    let Some(session_id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                        continue;
                    };
                    if seen.insert(session_id.to_string()) {
                        if let Some(summary) = summarize_qoder_jsonl(&path, session_id) {
                            found_workspace_source = true;
                            sessions.push(summary);
                        }
                    }
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    (sessions, found_workspace_source)
}

fn parse_millis(value: Option<&Value>) -> i64 {
    value
        .and_then(|entry| {
            entry
                .as_i64()
                .or_else(|| entry.as_u64().map(|n| n as i64))
                .or_else(|| {
                    entry.as_str().and_then(|text| {
                        chrono::DateTime::parse_from_rfc3339(text)
                            .ok()
                            .map(|dt| dt.timestamp_millis())
                            .or_else(|| text.parse::<i64>().ok())
                    })
                })
        })
        .unwrap_or(0)
}

fn extract_session_id_from_value(value: &Value) -> Option<String> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_cwd(value: &Value) -> Option<String> {
    value
        .get("cwd")
        .or_else(|| value.get("workingDirectory"))
        .or_else(|| value.get("workspacePath"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn map_session_list_entries(
    result: &Value,
    workspace_path: &Path,
) -> Vec<QoderSessionSummary> {
    let workspace = workspace_path.to_string_lossy();
    let entries = result
        .get("sessions")
        .or_else(|| result.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| result.as_array().cloned())
        .unwrap_or_default();
    let mut sessions = Vec::new();
    for entry in entries {
        let Some(session_id) = extract_session_id_from_value(&entry) else {
            continue;
        };
        if let Some(cwd) = extract_cwd(&entry) {
            if !paths_match(&cwd, &workspace) {
                continue;
            }
        }
        let first_message = entry
            .get("title")
            .or_else(|| entry.get("firstMessage"))
            .or_else(|| entry.get("preview"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated_at = parse_millis(
            entry
                .get("updatedAt")
                .or_else(|| entry.get("updated_at"))
                .or_else(|| entry.get("mtime")),
        );
        let created_at = parse_millis(
            entry
                .get("createdAt")
                .or_else(|| entry.get("created_at"))
                .or_else(|| entry.get("ctime")),
        );
        let message_count = entry
            .get("messageCount")
            .or_else(|| entry.get("message_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        sessions.push(QoderSessionSummary {
            session_id: session_id.clone(),
            first_message: truncate_chars(&first_message, MAX_TITLE_CHARS),
            updated_at,
            created_at,
            message_count,
            file_size_bytes: None,
            engine: Some("qoder".to_string()),
            canonical_session_id: Some(session_id),
            attribution_status: Some("strict-match".to_string()),
            provider_profile_id: None,
            provider_profile_name: None,
        });
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

fn update_message_id(update: &Value) -> Option<String> {
    update
        .get("messageId")
        .or_else(|| update.get("message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn update_timestamp(update: &Value) -> Option<String> {
    update
        .get("timestamp")
        .or_else(|| update.get("createdAt"))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|n| n.to_string()))
        })
}

fn build_tool_message(id: String, update: &Value, include_input: bool) -> QoderSessionMessage {
    let tool_name = extract_qoder_tool_name(update).unwrap_or_else(|| "tool".to_string());
    QoderSessionMessage {
        id,
        role: "assistant".to_string(),
        text: extract_qoder_tool_content_text(update),
        images: None,
        timestamp: update_timestamp(update),
        kind: "tool".to_string(),
        tool_type: Some(tool_name.clone()),
        title: Some(tool_name),
        tool_input: if include_input {
            update
                .get("rawInput")
                .cloned()
                .or_else(|| update.get("input").cloned())
        } else {
            None
        },
        tool_output: update
            .get("rawOutput")
            .cloned()
            .or_else(|| update.get("output").cloned())
            .or_else(|| update.get("content").cloned()),
    }
}

pub(crate) fn project_replayed_updates(updates: &[Value]) -> Vec<QoderSessionMessage> {
    let mut messages: Vec<QoderSessionMessage> = Vec::new();
    let mut seen = HashSet::new();
    let mut tool_positions: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut synthetic = 0usize;
    for params in updates {
        let update = params.get("update").unwrap_or(params);
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "available_commands_update" || kind == "config_option_update" || kind == "plan" {
            continue;
        }
        if kind == "tool_call" || kind == "tool_call_update" {
            let tool_call_id = extract_qoder_tool_call_id(update).unwrap_or_else(|| {
                synthetic += 1;
                log::warn!("qoder history replay: {kind} without toolCallId, synthesizing id");
                format!("qoder-synthetic-tool-{synthetic}")
            });
            // Namespaced so tool ids can never collide with message ids.
            let message_id = format!("tool:{tool_call_id}");
            let status = update.get("status").and_then(Value::as_str).unwrap_or("");
            if let Some(&index) = tool_positions.get(&tool_call_id) {
                // Later snapshots (incl. tool_call_update completions) carry the
                // output; merge into the existing entry, preferring richer data.
                let existing = &mut messages[index];
                let content_text = extract_qoder_tool_content_text(update);
                if !content_text.trim().is_empty() {
                    if existing.text.is_empty() {
                        existing.text = content_text;
                    } else if status == "failed" && !existing.text.contains(&content_text) {
                        existing.text.push('\n');
                        existing.text.push_str(&content_text);
                    }
                }
                if existing.tool_output.is_none() {
                    existing.tool_output = update
                        .get("rawOutput")
                        .cloned()
                        .or_else(|| update.get("output").cloned())
                        .or_else(|| update.get("content").cloned());
                }
                if existing.tool_input.is_none() {
                    existing.tool_input = update
                        .get("rawInput")
                        .cloned()
                        .or_else(|| update.get("input").cloned());
                }
                if existing.tool_type.as_deref() == Some("tool") {
                    if let Some(name) = extract_qoder_tool_name(update) {
                        existing.tool_type = Some(name.clone());
                        existing.title = Some(name);
                    }
                }
                continue;
            }
            tool_positions.insert(tool_call_id, messages.len());
            seen.insert(message_id.clone());
            messages.push(build_tool_message(message_id, update, true));
            continue;
        }
        let (role, text, message_kind) = match kind {
            "user_message_chunk" => (
                "user",
                extract_content_text(update.get("content")),
                "message",
            ),
            "agent_message_chunk" => (
                "assistant",
                extract_content_text(update.get("content")),
                "message",
            ),
            "agent_thought_chunk" => (
                "assistant",
                extract_content_text(update.get("content")),
                "reasoning",
            ),
            _ => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        // Key dedup by (kind, id): a thought and a message sharing a messageId
        // must not merge into each other.
        let dedup_key = update_message_id(update)
            .map(|id| format!("{message_kind}:{id}"))
            .unwrap_or_else(|| {
                synthetic += 1;
                format!("qoder-synthetic-{synthetic}")
            });
        if !seen.insert(dedup_key.clone()) {
            if let Some(existing) = messages.iter_mut().find(|msg| msg.id == dedup_key) {
                existing.text.push_str(&text);
            }
            continue;
        }
        messages.push(QoderSessionMessage {
            id: dedup_key,
            role: role.to_string(),
            text,
            images: None,
            timestamp: update_timestamp(update),
            kind: message_kind.to_string(),
            tool_type: None,
            title: None,
            tool_input: None,
            tool_output: None,
        });
    }
    messages
}

fn collect_session_updates_from_ndjson(lines: &str) -> Vec<Value> {
    let mut updates = Vec::new();
    for line in lines.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let AcpLine::Notification { method, params } = parse_acp_line(&value) {
            if method == "session/update" {
                updates.push(params);
            }
        }
    }
    updates
}

async fn with_initialized_acp<T, F>(
    workspace_path: &Path,
    home_dir: Option<&str>,
    timeout_dur: Duration,
    body: F,
) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut super::qoder::QoderAcpProcess,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    let settings = QoderDistributionSettings::default();
    let mut launch_profile =
        resolve_qoder_provider_launch_profile(&workspace_path.to_string_lossy(), None, &settings)?;
    launch_profile.home_dir = home_dir.map(PathBuf::from);
    with_initialized_acp_for_launch_profile(workspace_path, &launch_profile, timeout_dur, body)
        .await
}

async fn with_initialized_acp_for_launch_profile<T, F>(
    workspace_path: &Path,
    launch_profile: &QoderProviderLaunchProfile,
    timeout_dur: Duration,
    body: F,
) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut super::qoder::QoderAcpProcess,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    run_qoder_acp_initialized_for_distribution(
        launch_profile.distribution,
        launch_profile.bin_path.as_deref(),
        workspace_path,
        launch_profile
            .home_dir
            .as_deref()
            .and_then(|home| home.to_str()),
        timeout_dur,
        body,
    )
    .await
}

async fn list_qoder_sessions_from_acp(
    workspace_path: &Path,
    limit: Option<usize>,
    home_dir: Option<&str>,
) -> Result<Vec<QoderSessionSummary>, String> {
    match with_initialized_acp(
        workspace_path,
        home_dir,
        QODER_LIST_TIMEOUT,
        |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, String>> + Send + '_>,
        > {
            Box::pin(async move {
                acp.request("session/list", json!({}), QODER_RPC_HANDSHAKE_TIMEOUT)
                    .await
            })
        },
    )
    .await
    {
        Ok(result) => {
            let mut sessions = map_session_list_entries(&result, workspace_path);
            if let Some(limit) = limit {
                sessions.truncate(limit);
            }
            Ok(sessions)
        }
        Err(error) => {
            log::warn!("list_qoder_sessions ACP fallback failed: {error}");
            Ok(Vec::new())
        }
    }
}

async fn list_qoder_sessions_from_acp_for_launch_profile(
    workspace_path: &Path,
    limit: Option<usize>,
    launch_profile: &QoderProviderLaunchProfile,
) -> Result<Vec<QoderSessionSummary>, String> {
    match with_initialized_acp_for_launch_profile(
        workspace_path,
        launch_profile,
        QODER_LIST_TIMEOUT,
        |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Value, String>> + Send + '_>,
        > {
            Box::pin(async move {
                acp.request("session/list", json!({}), QODER_RPC_HANDSHAKE_TIMEOUT)
                    .await
            })
        },
    )
    .await
    {
        Ok(result) => {
            let mut sessions = map_session_list_entries(&result, workspace_path);
            if let Some(limit) = limit {
                sessions.truncate(limit);
            }
            Ok(sessions)
        }
        Err(error) => {
            log::warn!(
                "list_qoder_sessions {} ACP fallback failed: {error}",
                launch_profile.distribution.runtime_segment()
            );
            Ok(Vec::new())
        }
    }
}

pub async fn list_qoder_sessions(
    workspace_path: &Path,
    limit: Option<usize>,
    home_dir: Option<&str>,
) -> Result<Vec<QoderSessionSummary>, String> {
    let (mut sessions, found_workspace_source) =
        list_qoder_sessions_from_disk(workspace_path, home_dir);
    if sessions.is_empty() && !found_workspace_source {
        sessions = list_qoder_sessions_from_acp(workspace_path, limit, home_dir).await?;
    }
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }
    Ok(sessions)
}

pub async fn list_qoder_sessions_for_launch_profile(
    workspace_path: &Path,
    limit: Option<usize>,
    launch_profile: &QoderProviderLaunchProfile,
) -> Result<Vec<QoderSessionSummary>, String> {
    let (mut sessions, found_workspace_source) =
        list_qoder_sessions_from_disk_for_launch_profile(workspace_path, launch_profile);
    if sessions.is_empty() && !found_workspace_source {
        sessions =
            list_qoder_sessions_from_acp_for_launch_profile(workspace_path, limit, launch_profile)
                .await?;
    }
    let binding = launch_profile.binding.as_ref();
    for session in &mut sessions {
        session.provider_profile_id = binding.map(|binding| binding.provider_profile_id.clone());
        session.provider_profile_name =
            binding.map(|binding| binding.provider_profile_name.clone());
    }
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }
    Ok(sessions)
}

async fn load_qoder_session_from_acp(
    workspace_path: &Path,
    session_id: &str,
    home_dir: Option<&str>,
) -> Result<QoderSessionLoadResult, String> {
    let workspace_owned = workspace_path.to_path_buf();
    let session_owned = session_id.to_string();
    let result = with_initialized_acp(
        workspace_path,
        home_dir,
        QODER_LOAD_TIMEOUT,
        move |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Vec<Value>, String>> + Send + '_>,
        > {
            let workspace_owned = workspace_owned.clone();
            let session_owned = session_owned.clone();
            Box::pin(async move {
                acp.request(
                    "session/load",
                    json!({
                        "sessionId": session_owned,
                        "cwd": workspace_owned.to_string_lossy(),
                        "mcpServers": [],
                    }),
                    QODER_LOAD_TIMEOUT,
                )
                .await?;
                Ok(acp.collected_updates.clone())
            })
        },
    )
    .await?;
    Ok(QoderSessionLoadResult {
        messages: project_replayed_updates(&result),
        usage: None,
    })
}

async fn load_qoder_session_from_acp_for_launch_profile(
    workspace_path: &Path,
    session_id: &str,
    launch_profile: &QoderProviderLaunchProfile,
) -> Result<QoderSessionLoadResult, String> {
    let workspace_owned = workspace_path.to_path_buf();
    let session_owned = session_id.to_string();
    let result = with_initialized_acp_for_launch_profile(
        workspace_path,
        launch_profile,
        QODER_LOAD_TIMEOUT,
        move |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Vec<Value>, String>> + Send + '_>,
        > {
            let workspace_owned = workspace_owned.clone();
            let session_owned = session_owned.clone();
            Box::pin(async move {
                acp.request(
                    "session/load",
                    json!({
                        "sessionId": session_owned,
                        "cwd": workspace_owned.to_string_lossy(),
                        "mcpServers": [],
                    }),
                    QODER_LOAD_TIMEOUT,
                )
                .await?;
                Ok(acp.collected_updates.clone())
            })
        },
    )
    .await?;
    Ok(QoderSessionLoadResult {
        messages: project_replayed_updates(&result),
        usage: None,
    })
}

pub async fn load_qoder_session(
    workspace_path: &Path,
    session_id: &str,
    home_dir: Option<&str>,
) -> Result<QoderSessionLoadResult, String> {
    let session_id = normalize_session_id(session_id)?;
    if let Some(path) = find_qoder_session_jsonl(workspace_path, &session_id, home_dir) {
        match parse_qoder_jsonl_messages_checked(&path) {
            Ok(messages) => {
                return Ok(QoderSessionLoadResult {
                    messages,
                    usage: None,
                });
            }
            Err(error) => log::warn!(
                "Qoder native history is unavailable; falling back to ACP: {} ({error})",
                path.display()
            ),
        }
    }
    load_qoder_session_from_acp(workspace_path, &session_id, home_dir).await
}

pub async fn load_qoder_session_for_launch_profile(
    workspace_path: &Path,
    session_id: &str,
    launch_profile: &QoderProviderLaunchProfile,
) -> Result<QoderSessionLoadResult, String> {
    let session_id = normalize_session_id(session_id)?;
    let local_path = qoder_projects_root_for_launch_profile(launch_profile).and_then(|root| {
        for slug in candidate_qoder_project_slugs(workspace_path) {
            let candidate = root.join(slug).join(format!("{session_id}.jsonl"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        find_qoder_session_jsonl_by_workspace_metadata(&root, workspace_path, &session_id)
    });
    if let Some(path) = local_path {
        match parse_qoder_jsonl_messages_checked(&path) {
            Ok(messages) => {
                return Ok(QoderSessionLoadResult {
                    messages,
                    usage: None,
                });
            }
            Err(error) => log::warn!(
                "Qoder {} native history is unavailable; falling back to its ACP: {} ({error})",
                launch_profile.distribution.runtime_segment(),
                path.display()
            ),
        }
    }
    load_qoder_session_from_acp_for_launch_profile(workspace_path, &session_id, launch_profile)
        .await
}

pub async fn delete_qoder_session(
    workspace_path: &Path,
    session_id: &str,
    home_dir: Option<&str>,
) -> Result<(), String> {
    let session_id = normalize_session_id(session_id)?;
    with_initialized_acp(
        workspace_path,
        home_dir,
        QODER_DELETE_TIMEOUT,
        |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>,
        > {
            Box::pin(async move {
                acp.request(
                    "session/delete",
                    json!({ "sessionId": session_id }),
                    QODER_RPC_HANDSHAKE_TIMEOUT,
                )
                .await?;
                Ok(())
            })
        },
    )
    .await
}

pub async fn delete_qoder_session_for_launch_profile(
    workspace_path: &Path,
    session_id: &str,
    launch_profile: &QoderProviderLaunchProfile,
) -> Result<(), String> {
    let session_id = normalize_session_id(session_id)?;
    with_initialized_acp_for_launch_profile(
        workspace_path,
        launch_profile,
        QODER_DELETE_TIMEOUT,
        |acp| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>,
        > {
            Box::pin(async move {
                acp.request(
                    "session/delete",
                    json!({ "sessionId": session_id }),
                    QODER_RPC_HANDSHAKE_TIMEOUT,
                )
                .await?;
                Ok(())
            })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::qoder_provider_profile::{
        QODER_CN_PROVIDER_PROFILE_ID, QODER_GLOBAL_PROVIDER_PROFILE_ID,
    };
    use serde_json::json;

    fn temporary_qoder_home(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mossx-qoder-history-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn write_qoder_jsonl(path: &Path, records: &[Value], malformed_line: bool) {
        let parent = path.parent().expect("session parent");
        fs::create_dir_all(parent).expect("create session parent");
        let mut content = records
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .expect("serialize fixture")
            .join("\n");
        if malformed_line {
            content.push_str("\n{ not json }");
        }
        content.push('\n');
        fs::write(path, content).expect("write Qoder fixture");
    }

    fn qoder_turn_records(workspace: &Path) -> Vec<Value> {
        let cwd = workspace.to_string_lossy();
        vec![
            json!({"type":"workspace-directories","directories":[cwd.as_ref()]}),
            json!({"type":"user","uuid":"user-1","timestamp":"2026-08-22T00:00:00Z","humanInput":{"text":"first prompt"},"message":{"content":"first prompt"}}),
            json!({"type":"user","uuid":"hidden","isSidechain":true,"humanInput":{"text":"hidden prompt"},"message":{"content":"hidden prompt"}}),
            json!({"type":"assistant","uuid":"assistant-1","timestamp":"2026-08-22T00:00:01Z","message":{"content":[
                {"type":"thinking","thinking":"reasoning"},
                {"type":"text","text":"before tool"},
                {"type":"tool_use","id":"tool-1","name":"Read","input":{"path":"README.md"}}
            ]}}),
            json!({"type":"user","timestamp":"2026-08-22T00:00:02Z","toolUseResult":{"ok":true},"message":{"content":[
                {"type":"tool_result","tool_use_id":"tool-1","content":"file body"}
            ]}}),
            json!({"type":"ai-title","aiTitle":"Generated title"}),
            json!({"type":"assistant","uuid":"assistant-2","timestamp":"2026-08-22T00:00:03Z","message":{"content":[
                {"type":"text","text":"after tool"}
            ]}}),
        ]
    }

    fn write_workspace_session(
        home: &Path,
        storage_slug: &str,
        workspace: &Path,
        session_id: &str,
        malformed_line: bool,
    ) -> PathBuf {
        let path = home
            .join("projects")
            .join(storage_slug)
            .join(format!("{session_id}.jsonl"));
        write_qoder_jsonl(&path, &qoder_turn_records(workspace), malformed_line);
        path
    }

    #[test]
    fn maps_session_list_and_filters_cwd() {
        let workspace = PathBuf::from("/tmp/ws");
        let result = json!({
            "sessions": [
                {"sessionId":"keep","cwd":"/tmp/ws","title":"hello","updatedAt":10},
                {"sessionId":"drop","cwd":"/tmp/other","title":"nope","updatedAt":20}
            ]
        });
        let sessions = map_session_list_entries(&result, &workspace);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "keep");
        assert_eq!(sessions[0].first_message, "hello");
    }

    #[test]
    fn native_jsonl_summary_and_projection_preserve_tool_timeline() {
        let home = temporary_qoder_home("projection");
        let workspace = PathBuf::from("/tmp/mossx-qoder-history-projection");
        let session_id = "session-1";
        let storage_slug = encode_qoder_project_slug(&workspace.to_string_lossy());
        let path = write_workspace_session(&home, &storage_slug, &workspace, session_id, true);

        let summary = summarize_qoder_jsonl(&path, session_id).expect("session summary");
        assert_eq!(summary.first_message, "Generated title");
        assert_eq!(summary.message_count, 3);
        assert_eq!(summary.engine.as_deref(), Some("qoder"));
        assert_eq!(summary.attribution_status.as_deref(), Some("strict-match"));

        let messages = parse_qoder_jsonl_messages(&path);
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0].text, "first prompt");
        assert_eq!(messages[1].kind, "reasoning");
        assert_eq!(messages[1].text, "reasoning");
        assert_eq!(messages[2].text, "before tool");
        assert_eq!(messages[3].kind, "tool");
        assert_eq!(messages[3].tool_type.as_deref(), Some("Read"));
        assert_eq!(messages[3].tool_input, Some(json!({"path":"README.md"})));
        assert_eq!(messages[3].tool_output, Some(json!({"ok":true})));
        assert_eq!(messages[3].text, "file body");
        assert_eq!(messages[4].text, "after tool");
        assert!(!messages
            .iter()
            .any(|message| message.text == "hidden prompt"));

        fs::remove_dir_all(&home).expect("remove temp Qoder home");
    }

    #[test]
    fn native_lookup_uses_workspace_metadata_when_slug_is_unknown() {
        let home = temporary_qoder_home("metadata-fallback");
        let workspace = PathBuf::from("/tmp/mossx-qoder-history-target");
        let session_id = "session-shared-id";
        let matching = write_workspace_session(
            &home,
            "legacy-qoder-project-slug",
            &workspace,
            session_id,
            false,
        );
        let foreign_workspace = PathBuf::from("/tmp/mossx-qoder-history-foreign");
        write_workspace_session(
            &home,
            "foreign-qoder-project-slug",
            &foreign_workspace,
            session_id,
            false,
        );

        let home_text = home.to_string_lossy();
        assert_eq!(
            find_qoder_session_jsonl(&workspace, session_id, Some(&home_text)),
            Some(matching)
        );
        let (listed, found_workspace_source) =
            list_qoder_sessions_from_disk(&workspace, Some(&home_text));
        assert!(found_workspace_source);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, session_id);

        fs::remove_dir_all(&home).expect("remove temp Qoder home");
    }

    #[tokio::test]
    async fn load_prefers_native_jsonl_without_acp() {
        let home = temporary_qoder_home("native-load");
        let workspace = PathBuf::from("/tmp/mossx-qoder-history-native-load");
        let session_id = "session-native-load";
        let storage_slug = encode_qoder_project_slug(&workspace.to_string_lossy());
        write_workspace_session(&home, &storage_slug, &workspace, session_id, false);

        let home_text = home.to_string_lossy();
        let loaded = load_qoder_session(&workspace, session_id, Some(&home_text))
            .await
            .expect("native Qoder history loads");
        assert_eq!(loaded.messages.len(), 5);
        assert_eq!(loaded.messages[3].kind, "tool");

        fs::remove_dir_all(&home).expect("remove temp Qoder home");
    }

    #[tokio::test]
    async fn distribution_launch_profiles_never_cross_read_disk_history() {
        let global_home = temporary_qoder_home("global-history");
        let cn_home = temporary_qoder_home("cn-history");
        let workspace = PathBuf::from("/tmp/mossx-qoder-history-distribution-isolation");
        let storage_slug = encode_qoder_project_slug(&workspace.to_string_lossy());
        write_workspace_session(
            &global_home,
            &storage_slug,
            &workspace,
            "same-raw-session",
            false,
        );
        write_workspace_session(
            &cn_home,
            &storage_slug,
            &workspace,
            "same-raw-session",
            false,
        );

        let settings = QoderDistributionSettings {
            global_config_dir: Some(global_home.to_string_lossy().to_string()),
            cn_config_dir: Some(cn_home.to_string_lossy().to_string()),
            ..Default::default()
        };
        let global_profile = resolve_qoder_provider_launch_profile(
            "workspace",
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID),
            &settings,
        )
        .expect("Global launch profile");
        let cn_profile = resolve_qoder_provider_launch_profile(
            "workspace",
            Some(QODER_CN_PROVIDER_PROFILE_ID),
            &settings,
        )
        .expect("CN launch profile");

        let global_sessions =
            list_qoder_sessions_for_launch_profile(&workspace, None, &global_profile)
                .await
                .expect("Global disk history");
        let cn_sessions = list_qoder_sessions_for_launch_profile(&workspace, None, &cn_profile)
            .await
            .expect("CN disk history");

        assert_eq!(
            global_sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["same-raw-session"],
        );
        assert_eq!(
            cn_sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["same-raw-session"],
        );
        assert_eq!(
            global_sessions[0].provider_profile_id.as_deref(),
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID),
        );
        assert_eq!(
            cn_sessions[0].provider_profile_id.as_deref(),
            Some(QODER_CN_PROVIDER_PROFILE_ID),
        );

        fs::remove_dir_all(&global_home).expect("remove Global Qoder home");
        fs::remove_dir_all(&cn_home).expect("remove CN Qoder home");
    }

    #[test]
    fn readable_metadata_only_history_is_authoritative_empty() {
        let home = temporary_qoder_home("metadata-only");
        let workspace = PathBuf::from("/tmp/mossx-qoder-history-metadata-only");
        let session_id = "session-metadata-only";
        let storage_slug = encode_qoder_project_slug(&workspace.to_string_lossy());
        let path = home
            .join("projects")
            .join(storage_slug)
            .join(format!("{session_id}.jsonl"));
        write_qoder_jsonl(
            &path,
            &[json!({
                "type": "workspace-directories",
                "directories": [workspace.to_string_lossy()],
            })],
            false,
        );

        assert!(parse_qoder_jsonl_messages_checked(&path)
            .expect("readable metadata-only history")
            .is_empty());
        fs::remove_dir_all(&home).expect("remove temp Qoder home");
    }

    #[test]
    fn malformed_native_history_requires_acp_fallback() {
        let home = temporary_qoder_home("malformed");
        let path = home.join("projects").join("project").join("bad.jsonl");
        write_qoder_jsonl(&path, &[], true);

        let error = parse_qoder_jsonl_messages_checked(&path).expect_err("invalid NDJSON");
        assert!(error.contains("not valid NDJSON"), "{error}");
        fs::remove_dir_all(&home).expect("remove temp Qoder home");
    }

    #[test]
    fn replay_dedupes_message_id_and_skips_available_commands() {
        let ndjson = r#"
{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update","availableCommands":[]}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"text":"hi"},"timestamp":"t1"}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"text":" there"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"a1","content":{"text":"yo"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan"}}}
"#;
        let updates = collect_session_updates_from_ndjson(ndjson);
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "hi there");
        assert_eq!(messages[0].timestamp.as_deref(), Some("t1"));
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "yo");
    }

    #[test]
    fn replay_maps_thought_chunks_to_reasoning() {
        let updates = vec![
            json!({"update":{"sessionUpdate":"agent_thought_chunk","messageId":"t1","content":{"text":"thinking"}}}),
            json!({"update":{"sessionUpdate":"agent_message_chunk","messageId":"a1","content":{"text":"answer"}}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].kind, "reasoning");
        assert_eq!(messages[0].text, "thinking");
        assert_eq!(messages[1].kind, "message");
        assert_eq!(messages[1].text, "answer");
    }

    #[test]
    fn replay_maps_tool_call_and_dedupes_by_tool_call_id() {
        let updates = vec![
            json!({"update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Skill","rawInput":{"skill":"quest"},"rawOutput":{"success":true},"content":[{"type":"content","content":{"type":"text","text":"done"}}],"_meta":{"qoder":{"toolName":"Skill"}}}}),
            json!({"update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Skill"}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].kind, "tool");
        assert_eq!(messages[0].tool_type.as_deref(), Some("Skill"));
        assert_eq!(messages[0].text, "done");
        assert_eq!(messages[0].tool_input, Some(json!({"skill":"quest"})));
        assert_eq!(messages[0].tool_output, Some(json!({"success":true})));
    }

    #[test]
    fn replay_tool_call_update_merges_completion_output() {
        // Live stream shape: tool_call (pending, carries input) first,
        // tool_call_update (completed, carries output) later.
        let updates = vec![
            json!({"update":{"sessionUpdate":"tool_call","toolCallId":"call_1","status":"pending","title":"Shell","rawInput":{"cmd":"ls"}}}),
            json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed","rawOutput":{"exit":0},"content":[{"type":"content","content":{"type":"text","text":"file.txt"}}]}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "tool:call_1");
        assert_eq!(messages[0].tool_input, Some(json!({"cmd":"ls"})));
        assert_eq!(messages[0].tool_output, Some(json!({"exit":0})));
        assert_eq!(messages[0].text, "file.txt");
    }

    #[test]
    fn replay_tool_call_update_without_prior_call_inserts_in_place() {
        let updates = vec![
            json!({"update":{"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"text":"hi"}}}),
            json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"call_9","status":"failed","content":[{"type":"content","content":{"type":"text","text":"boom"}}]}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].kind, "tool");
        assert_eq!(messages[1].text, "boom");
        assert_eq!(
            messages[1].tool_output,
            Some(json!([{"type":"content","content":{"type":"text","text":"boom"}}]))
        );
    }

    #[test]
    fn replay_projects_captured_qoder_1_1_28_load_stream() {
        // Captured from qodercli 1.1.28 session/load of a real /quest turn.
        // The JSON-RPC result arrived after the first user chunk; these eight
        // updates are the full replay once trailing drain is applied.
        let updates = vec![
            json!({"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"你好"},"messageId":"e706f26d-5f2f-463b-94d5-5b5259a807ff"}}),
            json!({"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking greeting"},"messageId":"d8da4116-b2ea-41e0-8d5a-19d62e6e871a"}}),
            json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好！有什么可以帮你的吗？"},"messageId":"4d1ed6d4-8801-487d-bd54-4bb47adf6222"}}),
            json!({"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<command-name>/quest</command-name>"},"messageId":"76399fc7-8113-42fd-bb95-e9cf11b91b2c"}}),
            json!({"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking quest"},"messageId":"f0defbd4-ad83-4117-acb9-5dc7de2aad37"}}),
            json!({"update":{"sessionUpdate":"tool_call","toolCallId":"call_01a024d1af117dd1b4ea5705","status":"completed","title":"Skill","content":[{"type":"content","content":{"type":"text","text":"{\"success\":true}"}}],"kind":"other","rawInput":{"skill":"quest"},"rawOutput":{"success":true,"commandName":"quest","status":"inline"},"_meta":{"qoder":{"toolName":"Skill"}}}}),
            json!({"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking after skill"},"messageId":"6285ae60-d3a6-4763-b881-118935c13c44"}}),
            json!({"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好！我是 Quest Task Handler"},"messageId":"f62dba7a-7bc9-416f-b49b-290f9720c3e9"}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 8);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "你好");
        assert_eq!(messages[1].kind, "reasoning");
        assert_eq!(messages[2].text, "你好！有什么可以帮你的吗？");
        assert_eq!(messages[3].role, "user");
        assert_eq!(messages[4].kind, "reasoning");
        assert_eq!(messages[5].kind, "tool");
        assert_eq!(messages[5].id, "tool:call_01a024d1af117dd1b4ea5705");
        assert_eq!(messages[5].tool_type.as_deref(), Some("Skill"));
        assert_eq!(messages[5].tool_input, Some(json!({"skill":"quest"})));
        assert_eq!(messages[6].kind, "reasoning");
        assert_eq!(messages[7].text, "你好！我是 Quest Task Handler");
    }

    #[test]
    fn replay_namespaces_ids_and_separates_kinds() {
        // A thought and a message sharing a messageId must not merge.
        let updates = vec![
            json!({"update":{"sessionUpdate":"agent_thought_chunk","messageId":"same","content":{"text":"thinking"}}}),
            json!({"update":{"sessionUpdate":"agent_message_chunk","messageId":"same","content":{"text":"answer"}}}),
            json!({"update":{"sessionUpdate":"tool_call","toolCallId":"message:same","title":"t"}}),
        ];
        let messages = project_replayed_updates(&updates);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].id, "reasoning:same");
        assert_eq!(messages[1].id, "message:same");
        // toolCallId "message:same" must not collide with chunk ids.
        assert_eq!(messages[2].id, "tool:message:same");
    }

    #[test]
    fn empty_list_is_soft_empty() {
        let sessions = map_session_list_entries(&json!({}), Path::new("/tmp/ws"));
        assert!(sessions.is_empty());
    }
}
