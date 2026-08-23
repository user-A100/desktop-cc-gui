use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::Value;

use super::store::{
    delete_engine_session_rows, invalidate_source_freshness, load_backfill_state,
    mark_source_synced, max_updated_at_for_engine, normalize_path_key, save_backfill_state,
    source_is_fresh, upsert_rows, BackfillState, SessionIndexRow,
};
use crate::engine::claude_history::encode_project_path;
use crate::engine::qoder_provider_profile::canonical_qoder_native_session_id;

/// Freshness window for source fingerprints. Within this, list can skip rescan.
/// Kept short so CLI-created sessions appear in the sidebar without force refresh.
pub(crate) const SOURCE_FRESH_MAX_AGE_MS: i64 = 8_000;

#[derive(Debug, Default)]
pub(crate) struct WriterResult {
    pub upserted: usize,
    pub engines: Vec<String>,
    pub partial_source: Option<String>,
    pub skipped_fresh: bool,
}

fn mtime_fingerprint(path: &Path) -> String {
    let meta = fs::metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let len = meta.map(|metadata| metadata.len()).unwrap_or(0);
    format!("{modified}:{len}")
}

fn file_mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn file_created_at_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.created())
        .ok()
        .and_then(|created| created.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn optional_file_created_at_ms(path: &Path) -> Option<i64> {
    let created_at = file_created_at_ms(path);
    (created_at > 0).then_some(created_at)
}

fn created_at_from_json_value(value: &Value) -> Option<i64> {
    value
        .get("createdAt")
        .or_else(|| value.get("created_at"))
        .and_then(|raw| {
            raw.as_i64()
                .or_else(|| raw.as_u64().map(|n| n as i64))
                .or_else(|| {
                    raw.as_f64()
                        .filter(|n| n.is_finite() && *n > 0.0)
                        .map(|n| n as i64)
                })
        })
        .filter(|value| *value > 0)
}

/// Result of one bounded historical-backfill batch (import daemon tail).
#[derive(Debug, Default)]
pub(crate) struct BackfillBatchResult {
    pub upserted: usize,
    pub complete: bool,
}

/// Claude backfill: page through project-dir files (mtime desc) by offset.
pub(crate) const CLAUDE_BACKFILL_BATCH_SIZE: usize = 100;
/// Codex backfill: distinct partition days processed per tick.
pub(crate) const CODEX_BACKFILL_PARTITIONS_PER_BATCH: usize = 3;
/// Codex non-partitioned fallback root cap (one-shot, first batch only).
pub(crate) const CODEX_BACKFILL_PLAIN_FILE_CAP: usize = 1_000;
/// Kimi backfill: matched index lines per tick.
pub(crate) const KIMI_BACKFILL_BATCH_SIZE: usize = 100;

fn list_claude_project_session_files(project_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(project_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|left, right| {
        file_mtime_ms(right)
            .cmp(&file_mtime_ms(left))
            .then_with(|| left.to_string_lossy().cmp(&right.to_string_lossy()))
    });
    files
}

fn claude_session_id_from_path(path: &Path) -> Option<String> {
    let session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if session_id.is_empty() {
        None
    } else {
        Some(session_id)
    }
}

fn is_claude_agent_session_id(session_id: &str) -> bool {
    session_id.starts_with("agent-")
}

fn is_mossx_program_control_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("MOSSX_")
}

/// Shared 协议包（完整 token）。截断占位 `MOSSX_CONTE` 不算，避免 empty-prune 把续跑 jsonl 当空会话删盘。
pub(crate) fn is_mossx_shared_protocol_owner_text(text: &str) -> bool {
    let trimmed = text.trim();
    const TOKENS: &[&str] = &[
        "MOSSX_CONTEXT_PACKAGE",
        "MOSSX_SHARED_CONTEXT",
        "MOSSX_NATIVE_CONTEXT",
        "MOSSX_CONTEXT_ACCEPTED",
    ];
    TOKENS.iter().any(|token| {
        trimmed.len() >= token.len() && trimmed[..token.len()].eq_ignore_ascii_case(token)
    })
}

fn is_generic_claude_session_title(title: &str) -> bool {
    title.trim().eq_ignore_ascii_case("claude session")
}

fn is_claude_control_plane_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() || is_generic_claude_session_title(trimmed) {
        return false;
    }
    is_mossx_program_control_text(trimmed) || is_claude_control_or_synthetic_user_text(trimmed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeTranscriptPeek {
    RealUser,
    MediaOnly,
    Empty,
}

fn peek_claude_transcript_kind(path: &Path) -> ClaudeTranscriptPeek {
    let Some(file) = File::open(path).ok() else {
        return ClaudeTranscriptPeek::Empty;
    };
    let mut reader = BufReader::new(file);
    let mut saw_media_only = false;
    for _ in 0..80 {
        let line = match read_jsonl_line_capped(&mut reader, 256 * 1024) {
            Ok(Some(JsonlLine::Text(line))) => line,
            Ok(Some(JsonlLine::SkippedHuge)) => continue,
            Ok(None) => break,
            Err(_) => break,
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !is_claude_user_or_human_entry(&value) {
            continue;
        }
        if let Some(text) = extract_text_preview(&value) {
            let trimmed = text.trim();
            if !trimmed.is_empty() && !is_claude_control_or_synthetic_user_text(trimmed) {
                return ClaudeTranscriptPeek::RealUser;
            }
        }
        if claude_value_has_media_part(&value) {
            saw_media_only = true;
        }
    }
    if saw_media_only {
        ClaudeTranscriptPeek::MediaOnly
    } else {
        ClaudeTranscriptPeek::Empty
    }
}

fn should_omit_claude_index_row(session_id: &str, title: &str, path: &Path) -> bool {
    if is_claude_agent_session_id(session_id) {
        return true;
    }
    // Shared 协议 owner 必须留在 Index，供 protocol hide 收录文件 UUID。
    // 侧栏投影再用 MOSSX_ 标题闸藏行；禁止用 history.jsonl「继续」顶替后 omit 失败。
    if is_mossx_program_control_text(title) {
        return false;
    }
    if is_claude_control_plane_title(title) {
        return true;
    }
    if is_generic_claude_session_title(title) {
        return peek_claude_transcript_kind(path) == ClaudeTranscriptPeek::Empty;
    }
    false
}

fn peek_claude_first_user_raw(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    for _ in 0..80 {
        let line = match read_jsonl_line_capped(&mut reader, 256 * 1024) {
            Ok(Some(JsonlLine::Text(line))) => line,
            Ok(Some(JsonlLine::SkippedHuge)) => continue,
            Ok(None) => break,
            Err(_) => break,
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !is_claude_user_or_human_entry(&value) {
            continue;
        }
        if let Some(text) = extract_text_preview(&value) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn claude_index_row_from_file(
    path: &Path,
    workspace_path: &Path,
    titles: &HashMap<String, String>,
) -> Option<SessionIndexRow> {
    let session_id = claude_session_id_from_path(path)?;
    if is_claude_agent_session_id(&session_id) {
        return None;
    }
    let updated_at = file_mtime_ms(path);
    let protocol_raw =
        peek_claude_first_user_raw(path).filter(|text| is_mossx_program_control_text(text));
    let (title, title_from_history) = if let Some(raw) = protocol_raw {
        (truncate_title(&raw, 80), None)
    } else {
        let title_from_history = titles
            .get(&session_id)
            .cloned()
            .filter(|title| !is_claude_control_plane_title(title));
        let title = title_from_history
            .clone()
            .or_else(|| peek_claude_first_user_preview(path))
            .unwrap_or_else(|| "Claude Session".to_string());
        (title, title_from_history)
    };
    if should_omit_claude_index_row(&session_id, &title, path) {
        return None;
    }
    let size_bytes = fs::metadata(path).ok().map(|metadata| metadata.len());
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    Some(SessionIndexRow {
        engine: "claude".into(),
        session_id: session_id.clone(),
        title: title.clone(),
        native_title: title_from_history,
        updated_at,
        created_at: optional_file_created_at_ms(path),
        cwd: Some(workspace_key.clone()),
        workspace_path: Some(workspace_key),
        physical_path: Some(path.to_string_lossy().to_string()),
        parent_session_id: super::shared_visibility::extract_claude_parent_session_id(&session_id),
        size_bytes,
        provider_profile_id: None,
        provider_profile_name: None,
    })
}

fn collect_claude_index_rows(
    files: &[PathBuf],
    workspace_path: &Path,
    titles: &HashMap<String, String>,
    limit: Option<usize>,
) -> (Vec<SessionIndexRow>, Vec<(String, String)>) {
    let mut rows = Vec::new();
    let mut omitted = Vec::new();
    for path in files {
        let Some(session_id) = claude_session_id_from_path(path) else {
            continue;
        };
        match claude_index_row_from_file(path, workspace_path, titles) {
            Some(row) => {
                rows.push(row);
                if limit.is_some_and(|max| rows.len() >= max) {
                    break;
                }
            }
            None => omitted.push(("claude".to_string(), session_id)),
        }
    }
    (rows, omitted)
}

fn is_generic_codex_session_title(title: &str) -> bool {
    title.trim().eq_ignore_ascii_case("codex session")
}

pub(crate) fn should_omit_codex_index_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() || is_generic_codex_session_title(trimmed) {
        return true;
    }
    // Shared 协议 owner 必须留在 Index，供 protocol hide 收录文件 uuid。
    // Windows Codex 首条常是 <environment_context>，标题扫描会落到后续 MOSSX 包。
    if is_mossx_program_control_text(trimmed) {
        return false;
    }
    crate::local_usage::is_codex_background_helper_text(trimmed)
}

fn collect_codex_index_rows(
    summaries: impl IntoIterator<Item = crate::types::LocalUsageSessionSummary>,
    workspace_key: &str,
) -> (Vec<SessionIndexRow>, Vec<(String, String)>) {
    let mut rows = Vec::new();
    let mut omitted = Vec::new();
    // provider id → 显示名 per-collect cache，避免每行重复读 config。
    let mut provider_name_cache: HashMap<String, String> = HashMap::new();
    for summary in summaries {
        let session_id = summary.session_id.clone();
        match codex_summary_to_index_row(summary, workspace_key, &mut provider_name_cache) {
            Some(row) => rows.push(row),
            None => omitted.push(("codex".to_string(), session_id)),
        }
    }
    (rows, omitted)
}

fn codex_summary_to_index_row(
    summary: crate::types::LocalUsageSessionSummary,
    workspace_key: &str,
    provider_name_cache: &mut HashMap<String, String>,
) -> Option<SessionIndexRow> {
    let title = summary
        .native_title
        .clone()
        .or(summary.summary.clone())
        .unwrap_or_else(|| "Codex Session".to_string());
    if should_omit_codex_index_title(&title) {
        return None;
    }
    // scan 已从 physical path 推断 managed provider id（provider-home 会话）；
    // 这里解析显示名，让 first paint 就能画供应商标签。
    let provider_profile_id = summary
        .provider_profile_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let provider_profile_name = provider_profile_id.as_ref().map(|profile_id| {
        provider_name_cache
            .entry(profile_id.clone())
            .or_insert_with(|| {
                crate::codex::provider_profile::codex_provider_binding_for_profile_id(profile_id)
                    .provider_profile_name
            })
            .clone()
    });
    Some(SessionIndexRow {
        engine: "codex".into(),
        session_id: summary.session_id,
        title: title.clone(),
        native_title: summary.native_title.or(summary.summary),
        updated_at: summary.timestamp,
        created_at: summary
            .physical_path
            .as_deref()
            .map(Path::new)
            .and_then(optional_file_created_at_ms),
        cwd: summary
            .cwd
            .as_deref()
            .map(normalize_path_key)
            .or_else(|| Some(workspace_key.to_string())),
        workspace_path: Some(workspace_key.to_string()),
        physical_path: summary.physical_path,
        parent_session_id: summary.parent_session_id,
        size_bytes: summary.file_size_bytes,
        provider_profile_id,
        provider_profile_name,
    })
}

fn kimi_session_index_path() -> Option<PathBuf> {
    let home = dirs::home_dir().map(|home| home.join(".kimi"))?;
    let home = std::env::var("KIMI_HOME")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
        .unwrap_or(home);
    Some(home.join("session_index.jsonl"))
}

fn parse_kimi_index_line(line: &str, target: &str) -> Option<SessionIndexRow> {
    if line.len() > 256_000 {
        return None;
    }
    let value = serde_json::from_str::<Value>(line).ok()?;
    let work_dir = value
        .get("workDir")
        .or_else(|| value.get("work_dir"))
        .or_else(|| value.get("cwd"))
        .and_then(Value::as_str)
        .map(normalize_path_key)
        .unwrap_or_default();
    if work_dir.is_empty() || work_dir != target {
        return None;
    }
    let session_id = value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let session_dir = value
        .get("sessionDir")
        .or_else(|| value.get("session_dir"))
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let updated_at = session_dir
        .as_ref()
        .map(|path| file_mtime_ms(path))
        .filter(|value| *value > 0)
        .unwrap_or_else(|| now_ms_fallback());
    let title = value
        .get("title")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Kimi Session".to_string());
    Some(SessionIndexRow {
        engine: "kimi".into(),
        session_id: session_id.to_string(),
        title,
        native_title: None,
        updated_at,
        created_at: created_at_from_json_value(&value)
            .or_else(|| session_dir.as_deref().and_then(optional_file_created_at_ms)),
        cwd: Some(target.to_string()),
        workspace_path: Some(target.to_string()),
        physical_path: session_dir.map(|path| path.to_string_lossy().to_string()),
        parent_session_id: None,
        size_bytes: None,
        provider_profile_id: None,
        provider_profile_name: None,
    })
}

pub(crate) fn backfill_claude_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    batch_size: usize,
) -> Result<BackfillBatchResult, String> {
    let source_key = format!(
        "claude:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let state = load_backfill_state(connection, &source_key)?;
    if state.complete {
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let Some(claude_home) = crate::claude_home::resolve_effective_claude_home(None) else {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: state.cursor.clone(),
                complete: true,
            },
        )?;
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    };
    let encoded = encode_project_path(&workspace_path.to_string_lossy());
    let project_dir = claude_home.join("projects").join(&encoded);
    if !project_dir.is_dir() {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: state.cursor.clone(),
                complete: true,
            },
        )?;
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let history_path = claude_home.join("history.jsonl");
    let titles = read_claude_history_titles(&history_path, workspace_path);
    let files = list_claude_project_session_files(&project_dir);
    let offset: usize = state.cursor.trim().parse().unwrap_or(0);
    if offset >= files.len() {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: state.cursor.clone(),
                complete: true,
            },
        )?;
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let end = offset.saturating_add(batch_size).min(files.len());
    let (rows, omitted) =
        collect_claude_index_rows(&files[offset..end], workspace_path, &titles, None);
    if !omitted.is_empty() {
        delete_engine_session_rows(connection, &omitted)?;
    }
    let upserted = upsert_rows(connection, &rows)?;
    let complete = end >= files.len();
    save_backfill_state(
        connection,
        &source_key,
        &BackfillState {
            cursor: end.to_string(),
            complete,
        },
    )?;
    Ok(BackfillBatchResult { upserted, complete })
}

pub(crate) fn backfill_codex_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    sessions_roots: &[PathBuf],
    max_partitions: usize,
) -> Result<BackfillBatchResult, String> {
    let source_key = format!(
        "codex:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let state = load_backfill_state(connection, &source_key)?;
    if state.complete {
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let parsed = serde_json::from_str::<Value>(&state.cursor).ok();
    let cursor_day = parsed
        .as_ref()
        .and_then(|value| value.get("day"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut plain_done = parsed
        .as_ref()
        .and_then(|value| value.get("plainDone"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    let mut upserted = 0usize;

    if !plain_done {
        let files = crate::local_usage::collect_codex_jsonl_candidates_capped(
            sessions_roots,
            CODEX_BACKFILL_PLAIN_FILE_CAP,
        );
        if !files.is_empty() {
            let summaries = crate::local_usage::scan_codex_session_summaries_for_files(
                Some(workspace_path),
                files,
            )?;
            let (rows, omitted) = collect_codex_index_rows(summaries, &workspace_key);
            delete_engine_session_rows(connection, &omitted)?;
            upserted += upsert_rows(connection, &rows)?;
        }
        plain_done = true;
    }

    let partitions = crate::local_usage::list_codex_day_partitions(sessions_roots);
    let mut dates: Vec<String> = Vec::new();
    for partition in &partitions {
        if !dates.iter().any(|key| key == &partition.key) {
            dates.push(partition.key.clone());
        }
    }
    let remaining: Vec<String> = dates
        .iter()
        .filter(|key| cursor_day.is_empty() || *key < &cursor_day)
        .cloned()
        .collect();
    let batch_dates: Vec<String> = remaining.iter().take(max_partitions).cloned().collect();

    let save_state = |day: &str, plain: bool, complete: bool| {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: format!("{{\"day\":{:?},\"plainDone\":{}}}", day, plain),
                complete,
            },
        )
    };

    if batch_dates.is_empty() {
        save_state(&cursor_day, plain_done, true)?;
        return Ok(BackfillBatchResult {
            upserted,
            complete: true,
        });
    }

    let selected: Vec<_> = partitions
        .into_iter()
        .filter(|partition| batch_dates.contains(&partition.key))
        .collect();
    let summaries = crate::local_usage::scan_codex_session_summaries_for_day_dirs(
        Some(workspace_path),
        &selected,
    )?;
    let (rows, omitted) = collect_codex_index_rows(summaries, &workspace_key);
    delete_engine_session_rows(connection, &omitted)?;
    upserted += upsert_rows(connection, &rows)?;

    let oldest = batch_dates.last().cloned().unwrap_or_default();
    let complete = !dates.iter().any(|key| *key < oldest);
    save_state(&oldest, plain_done, complete)?;
    Ok(BackfillBatchResult { upserted, complete })
}

pub(crate) fn backfill_kimi_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    batch_size: usize,
) -> Result<BackfillBatchResult, String> {
    let source_key = format!(
        "kimi:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let state = load_backfill_state(connection, &source_key)?;
    if state.complete {
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let Some(index_path) = kimi_session_index_path() else {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: state.cursor.clone(),
                complete: true,
            },
        )?;
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    };
    if !index_path.is_file() {
        save_backfill_state(
            connection,
            &source_key,
            &BackfillState {
                cursor: state.cursor.clone(),
                complete: true,
            },
        )?;
        return Ok(BackfillBatchResult {
            upserted: 0,
            complete: true,
        });
    }
    let offset: usize = state.cursor.trim().parse().unwrap_or(0);
    let target = normalize_path_key(&workspace_path.to_string_lossy());
    let file = File::open(&index_path).map_err(|error| error.to_string())?;
    let mut matched = 0usize;
    let mut rows = Vec::new();
    let mut hit_batch_limit = false;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Some(row) = parse_kimi_index_line(&line, &target) else {
            continue;
        };
        matched += 1;
        if matched <= offset {
            continue;
        }
        if rows.len() >= batch_size {
            hit_batch_limit = true;
            break;
        }
        rows.push(row);
    }
    let upserted = upsert_rows(connection, &rows)?;
    let covered = offset + rows.len();
    let complete = !hit_batch_limit;
    save_backfill_state(
        connection,
        &source_key,
        &BackfillState {
            cursor: covered.to_string(),
            complete,
        },
    )?;
    Ok(BackfillBatchResult { upserted, complete })
}

/// Sync Claude sessions for one workspace via project-dir mtime + history.jsonl titles.
pub(crate) fn sync_claude_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    limit: usize,
    force: bool,
) -> Result<WriterResult, String> {
    let limit = limit.clamp(1, 500);
    let claude_home = crate::claude_home::resolve_effective_claude_home(None)
        .ok_or_else(|| "claude home not found".to_string())?;
    let projects_dir = claude_home.join("projects");
    let encoded = encode_project_path(&workspace_path.to_string_lossy());
    let project_dir = projects_dir.join(&encoded);
    let history_path = claude_home.join("history.jsonl");

    let source_key = format!(
        "claude:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let fingerprint = format!(
        "{}|{}",
        mtime_fingerprint(&project_dir),
        mtime_fingerprint(&history_path)
    );
    if !force
        && source_should_skip_as_fresh(
            connection,
            &source_key,
            &fingerprint,
            "claude",
            workspace_path,
            newest_child_mtime_ms(&project_dir, 1),
        )?
    {
        return Ok(WriterResult {
            skipped_fresh: true,
            engines: vec!["claude".into()],
            ..WriterResult::default()
        });
    }

    let titles = read_claude_history_titles(&history_path, workspace_path);
    let mut rows = Vec::new();
    let mut omitted = Vec::new();
    if project_dir.is_dir() {
        let mut files = list_claude_project_session_files(&project_dir);
        files.truncate(limit.saturating_mul(2).max(limit));
        let collected = collect_claude_index_rows(&files, workspace_path, &titles, Some(limit));
        rows = collected.0;
        omitted = collected.1;
    }
    if !omitted.is_empty() {
        delete_engine_session_rows(connection, &omitted)?;
    }

    let upserted = upsert_rows(connection, &rows)?;
    mark_source_synced(connection, &source_key, &fingerprint, rows.len())?;
    Ok(WriterResult {
        upserted,
        engines: vec!["claude".into()],
        partial_source: if project_dir.is_dir() {
            None
        } else {
            Some("claude-project-dir-missing".into())
        },
        skipped_fresh: false,
    })
}

fn read_claude_history_titles(
    history_path: &Path,
    workspace_path: &Path,
) -> HashMap<String, String> {
    let Ok(file) = File::open(history_path) else {
        return HashMap::new();
    };
    let target = normalize_path_key(&workspace_path.to_string_lossy());
    let mut titles: HashMap<String, (i64, String)> = HashMap::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        if line.len() > 256_000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let project = value
            .get("project")
            .and_then(Value::as_str)
            .map(normalize_path_key)
            .unwrap_or_default();
        if project.is_empty() || project != target {
            // Tolerate trailing-slash / slash style differences only via normalize.
            continue;
        }
        let session_id = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            continue;
        };
        let display = value
            .get("display")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(display) = display else {
            continue;
        };
        let timestamp = value.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        let entry = titles
            .entry(session_id.to_string())
            .or_insert((timestamp, display.to_string()));
        // Keep earliest user prompt as title (first message), but allow refresh if empty.
        if entry.1.is_empty() || (timestamp > 0 && timestamp < entry.0) {
            *entry = (timestamp, display.to_string());
        }
    }
    titles
        .into_iter()
        .map(|(session_id, (_ts, title))| (session_id, truncate_title(&title, 80)))
        .collect()
}

const CLAUDE_INJECTION_ENVELOPE_TAGS: &[&str] = &[
    "system-reminder",
    "user_info",
    "git_status",
    "open_and_recently_viewed_files",
    "agent_skills",
    "mcp_servers",
    "image_compression_notice",
    "available_skills",
    "goal_round",
    "rules",
];

pub(crate) fn is_claude_control_or_synthetic_user_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    if is_mossx_program_control_text(trimmed) {
        return true;
    }
    if trimmed.contains("Warmup")
        || trimmed.contains(
            "Caveat: The messages below were generated by the user while running local commands",
        )
    {
        return true;
    }
    if trimmed.starts_with("<command-") || trimmed.starts_with("<local-command-") {
        return !has_non_empty_command_args(trimmed);
    }
    strip_claude_injection_envelopes(trimmed).is_empty()
}

fn has_non_empty_command_args(text: &str) -> bool {
    let Some(start) = text.find("<command-args>") else {
        return false;
    };
    let after = &text[start + "<command-args>".len()..];
    let Some(end) = after.find("</command-args>") else {
        return false;
    };
    !after[..end].trim().is_empty()
}

pub(crate) fn strip_claude_injection_envelopes(text: &str) -> String {
    let mut remaining = text.to_string();
    for tag in CLAUDE_INJECTION_ENVELOPE_TAGS {
        remaining = strip_xml_tag_blocks(&remaining, tag);
    }
    remaining.trim().to_string()
}

fn strip_xml_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        output.push_str(&rest[..start]);
        let after_open = &rest[start + open.len()..];
        if let Some(end) = after_open.find(&close) {
            rest = &after_open[end + close.len()..];
        } else {
            rest = "";
            break;
        }
    }
    output.push_str(rest);
    output
}

pub(crate) fn claude_value_has_media_part(value: &Value) -> bool {
    let content = value
        .pointer("/message/content")
        .or_else(|| value.get("content"));
    let Some(items) = content.and_then(Value::as_array) else {
        return false;
    };
    items.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("image" | "image_url" | "input_image" | "file" | "document")
        )
    })
}

fn peek_claude_first_user_preview(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    for _ in 0..80 {
        let line = match read_jsonl_line_capped(&mut reader, 256 * 1024) {
            Ok(Some(JsonlLine::Text(line))) => line,
            Ok(Some(JsonlLine::SkippedHuge)) => continue,
            Ok(None) => break,
            Err(_) => break,
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !is_claude_user_or_human_entry(&value) {
            continue;
        }
        if let Some(text) = extract_text_preview(&value) {
            let trimmed = text.trim();
            if !trimmed.is_empty() && !is_claude_control_or_synthetic_user_text(trimmed) {
                let cleaned = strip_claude_injection_envelopes(trimmed);
                let preview = if cleaned.is_empty() {
                    trimmed
                } else {
                    cleaned.as_str()
                };
                return Some(truncate_title(preview, 80));
            }
        }
        if claude_value_has_media_part(&value) {
            // Image/file-only user turn is real content, but not a usable title.
            return None;
        }
    }
    None
}

pub(crate) fn is_claude_user_or_human_entry(value: &Value) -> bool {
    let role = value
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| value.get("role").and_then(Value::as_str))
        .unwrap_or("");
    if role == "user" || role == "human" {
        return true;
    }
    matches!(
        value.pointer("/message/role").and_then(Value::as_str),
        Some("user" | "human")
    )
}

#[derive(Debug)]
pub(crate) enum JsonlLine {
    Text(String),
    SkippedHuge,
}

/// Read one JSONL line without loading a multi-MB snapshot into a title/scan buffer.
pub(crate) fn read_jsonl_line_capped(
    reader: &mut impl BufRead,
    cap: usize,
) -> std::io::Result<Option<JsonlLine>> {
    let mut buf = Vec::new();
    let mut skipped = false;
    loop {
        let available = {
            let data = reader.fill_buf()?;
            if data.is_empty() {
                if buf.is_empty() && !skipped {
                    return Ok(None);
                }
                break;
            }
            data.to_vec()
        };
        if let Some(nl) = available.iter().position(|&byte| byte == b'\n') {
            if !skipped {
                if buf.len().saturating_add(nl) > cap {
                    skipped = true;
                } else {
                    buf.extend_from_slice(&available[..nl]);
                }
            }
            reader.consume(nl + 1);
            break;
        }
        if !skipped {
            if buf.len().saturating_add(available.len()) > cap {
                skipped = true;
            } else {
                buf.extend_from_slice(&available);
            }
        }
        reader.consume(available.len());
    }
    if skipped {
        Ok(Some(JsonlLine::SkippedHuge))
    } else {
        Ok(Some(JsonlLine::Text(
            String::from_utf8_lossy(&buf).into_owned(),
        )))
    }
}

pub(crate) fn extract_text_preview(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.pointer("/message/content").and_then(|content| {
        if let Some(text) = content.as_str() {
            return Some(text.to_string());
        }
        if let Some(arr) = content.as_array() {
            let mut parts = Vec::new();
            for item in arr {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text);
                    }
                }
            }
            if !parts.is_empty() {
                return Some(parts.join(" "));
            }
        }
        None
    }) {
        return Some(text);
    }
    value
        .get("display")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn truncate_title(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out = trimmed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

/// Sync Codex sessions for one workspace using bounded ThreadPreview scanner.
pub(crate) fn sync_codex_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    sessions_roots: &[PathBuf],
    limit: usize,
    force: bool,
) -> Result<WriterResult, String> {
    let limit = limit.clamp(1, 500);
    let source_key = format!(
        "codex:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let fingerprint = sessions_roots
        .iter()
        .map(|root| mtime_fingerprint(root))
        .collect::<Vec<_>>()
        .join("|");
    // Also include session_index.jsonl when present under parent home.
    let mut fingerprint = fingerprint;
    for root in sessions_roots {
        if let Some(home) = root.parent() {
            let index = home.join("session_index.jsonl");
            fingerprint.push('|');
            fingerprint.push_str(&mtime_fingerprint(&index));
        }
    }
    let disk_newest = sessions_roots
        .iter()
        .filter_map(|root| newest_child_mtime_ms(root, 2))
        .max();
    if !force
        && source_should_skip_as_fresh(
            connection,
            &source_key,
            &fingerprint,
            "codex",
            workspace_path,
            disk_newest,
        )?
    {
        return Ok(WriterResult {
            skipped_fresh: true,
            engines: vec!["codex".into()],
            ..WriterResult::default()
        });
    }

    let (summaries, _scanned) = crate::local_usage::scan_codex_session_summaries_for_index(
        Some(workspace_path),
        sessions_roots,
        limit,
    )?;
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    let (rows, omitted) = collect_codex_index_rows(summaries, &workspace_key);
    delete_engine_session_rows(connection, &omitted)?;
    let upserted = upsert_rows(connection, &rows)?;
    mark_source_synced(connection, &source_key, &fingerprint, rows.len())?;
    Ok(WriterResult {
        upserted,
        engines: vec!["codex".into()],
        partial_source: None,
        skipped_fresh: false,
    })
}

/// Sync Kimi via session_index.jsonl (light index).
pub(crate) fn sync_kimi_for_workspace(
    connection: &Connection,
    workspace_path: &Path,
    limit: usize,
    force: bool,
) -> Result<WriterResult, String> {
    let limit = limit.clamp(1, 500);
    let home = dirs::home_dir()
        .map(|home| home.join(".kimi"))
        .ok_or_else(|| "home not found".to_string())?;
    // Kimi may use custom home; best-effort default + env.
    let home = std::env::var("KIMI_HOME")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
        .unwrap_or(home);
    let index_path = home.join("session_index.jsonl");
    let source_key = format!(
        "kimi:{}",
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let fingerprint = mtime_fingerprint(&index_path);
    if !force
        && source_should_skip_as_fresh(
            connection,
            &source_key,
            &fingerprint,
            "kimi",
            workspace_path,
            newest_child_mtime_ms(index_path.parent().unwrap_or(&home), 2),
        )?
    {
        return Ok(WriterResult {
            skipped_fresh: true,
            engines: vec!["kimi".into()],
            ..WriterResult::default()
        });
    }
    if !index_path.is_file() {
        mark_source_synced(connection, &source_key, &fingerprint, 0)?;
        return Ok(WriterResult {
            engines: vec!["kimi".into()],
            partial_source: Some("kimi-index-missing".into()),
            ..WriterResult::default()
        });
    }
    let target = normalize_path_key(&workspace_path.to_string_lossy());
    let file = File::open(&index_path).map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    for line in BufReader::new(file).lines() {
        if rows.len() >= limit {
            break;
        }
        let Ok(line) = line else {
            continue;
        };
        if line.len() > 256_000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let work_dir = value
            .get("workDir")
            .or_else(|| value.get("work_dir"))
            .or_else(|| value.get("cwd"))
            .and_then(Value::as_str)
            .map(normalize_path_key)
            .unwrap_or_default();
        if work_dir.is_empty() || work_dir != target {
            continue;
        }
        let session_id = value
            .get("sessionId")
            .or_else(|| value.get("session_id"))
            .or_else(|| value.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            continue;
        };
        let session_dir = value
            .get("sessionDir")
            .or_else(|| value.get("session_dir"))
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let updated_at = session_dir
            .as_ref()
            .map(|path| file_mtime_ms(path))
            .filter(|value| *value > 0)
            .unwrap_or_else(|| now_ms_fallback());
        let title = value
            .get("title")
            .or_else(|| value.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "Kimi Session".to_string());
        let created_at = created_at_from_json_value(&value)
            .or_else(|| session_dir.as_deref().and_then(optional_file_created_at_ms));
        rows.push(SessionIndexRow {
            engine: "kimi".into(),
            session_id: session_id.to_string(),
            title,
            native_title: None,
            updated_at,
            created_at,
            cwd: Some(target.clone()),
            workspace_path: Some(target.clone()),
            physical_path: session_dir.map(|path| path.to_string_lossy().to_string()),
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        });
    }
    let upserted = upsert_rows(connection, &rows)?;
    mark_source_synced(connection, &source_key, &fingerprint, rows.len())?;
    Ok(WriterResult {
        upserted,
        engines: vec!["kimi".into()],
        partial_source: None,
        skipped_fresh: false,
    })
}

fn now_ms_fallback() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Commit prebuilt rows for one engine (used by async Gemini/Grok/OpenCode writers).
pub(crate) fn commit_engine_rows(
    connection: &Connection,
    engine: &str,
    workspace_path: &Path,
    rows: Vec<SessionIndexRow>,
    fingerprint: &str,
    partial_source: Option<String>,
) -> Result<WriterResult, String> {
    let engine = engine.trim().to_ascii_lowercase();
    if engine.is_empty() {
        return Err("engine is required".to_string());
    }
    let source_key = format!(
        "{}:{}",
        engine,
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let is_partial = partial_source.is_some();
    if is_partial && rows.is_empty() {
        invalidate_source_freshness(connection, &source_key)?;
        return Ok(WriterResult {
            upserted: 0,
            engines: vec![engine],
            partial_source,
            skipped_fresh: false,
        });
    }
    let upserted = upsert_rows(connection, &rows)?;
    if is_partial {
        invalidate_source_freshness(connection, &source_key)?;
    } else {
        mark_source_synced(connection, &source_key, fingerprint, rows.len())?;
    }
    Ok(WriterResult {
        upserted,
        engines: vec![engine],
        partial_source,
        skipped_fresh: false,
    })
}

pub(crate) fn source_should_skip_as_fresh(
    connection: &Connection,
    source_key: &str,
    fingerprint: &str,
    engine: &str,
    workspace_path: &Path,
    disk_newest_mtime: Option<i64>,
) -> Result<bool, String> {
    if !source_is_fresh(connection, source_key, fingerprint, SOURCE_FRESH_MAX_AGE_MS)? {
        return Ok(false);
    }
    let Some(disk_newest) = disk_newest_mtime.filter(|value| *value > 0) else {
        return Ok(true);
    };
    let ledger_max =
        max_updated_at_for_engine(connection, engine, &workspace_path.to_string_lossy())?;
    match ledger_max {
        Some(max) if disk_newest <= max => Ok(true),
        _ => Ok(false),
    }
}

fn newest_child_mtime_ms(dir: &Path, extra_depth: usize) -> Option<i64> {
    if !dir.exists() {
        return None;
    }
    let mut newest = file_mtime_ms(dir);
    let Ok(entries) = fs::read_dir(dir) else {
        return (newest > 0).then_some(newest);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        let mtime = file_mtime_ms(&path);
        if mtime > newest {
            newest = mtime;
        }
        if extra_depth > 0 && path.is_dir() {
            if let Some(child) = newest_child_mtime_ms(&path, extra_depth.saturating_sub(1)) {
                if child > newest {
                    newest = child;
                }
            }
        }
    }
    (newest > 0).then_some(newest)
}

fn peek_engine_disk_newest_mtime(engine: &str, workspace_path: &Path) -> Option<i64> {
    match engine.trim().to_ascii_lowercase().as_str() {
        "gemini" => {
            let home = std::env::var("GEMINI_HOME")
                .ok()
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".gemini")))
                .unwrap_or_else(|| PathBuf::from(".gemini"));
            newest_child_mtime_ms(&home, 2)
        }
        "grok" => {
            let home = std::env::var("GROK_HOME")
                .ok()
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
                .unwrap_or_else(|| PathBuf::from(".grok"));
            newest_child_mtime_ms(&home.join("sessions"), 2)
                .or_else(|| newest_child_mtime_ms(&home, 2))
        }
        "pi" => {
            let sessions = crate::engine::pi_history::resolve_pi_sessions_root(None);
            newest_child_mtime_ms(&sessions, 2)
        }
        "dsh" => {
            let home = std::env::var_os("DSH_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
                .unwrap_or_else(|| PathBuf::from(".dsh"));
            newest_child_mtime_ms(&home, 2)
        }
        "claude" => {
            let claude_home = crate::claude_home::resolve_effective_claude_home(None)?;
            let encoded = encode_project_path(&workspace_path.to_string_lossy());
            newest_child_mtime_ms(&claude_home.join("projects").join(encoded), 1)
        }
        // qoder history is ACP-based with no vendor disk sessions root
        // (add-qoder-engine design: skip prune/fingerprint wiring).
        "kimi" => {
            let home = std::env::var("KIMI_HOME")
                .ok()
                .and_then(|value| {
                    let trimmed = value.trim();
                    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
                })
                .or_else(|| dirs::home_dir().map(|home| home.join(".kimi")))
                .unwrap_or_else(|| PathBuf::from(".kimi"));
            newest_child_mtime_ms(&home, 2)
        }
        // OpenCode has no durable disk index (15s fingerprint bucket).
        // Codex writers pass session-root child mtimes directly.
        _ => None,
    }
}

pub(crate) fn engine_source_is_fresh(
    connection: &Connection,
    engine: &str,
    workspace_path: &Path,
    fingerprint: &str,
) -> Result<bool, String> {
    let source_key = format!(
        "{}:{}",
        engine.trim().to_ascii_lowercase(),
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    source_is_fresh(
        connection,
        &source_key,
        fingerprint,
        SOURCE_FRESH_MAX_AGE_MS,
    )
}

pub(crate) fn engine_source_should_skip(
    connection: &Connection,
    engine: &str,
    workspace_path: &Path,
    fingerprint: &str,
) -> Result<bool, String> {
    let source_key = format!(
        "{}:{}",
        engine.trim().to_ascii_lowercase(),
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    source_should_skip_as_fresh(
        connection,
        &source_key,
        fingerprint,
        engine,
        workspace_path,
        peek_engine_disk_newest_mtime(engine, workspace_path),
    )
}

pub(crate) fn gemini_home_fingerprint() -> String {
    let home = std::env::var("GEMINI_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".gemini")))
        .unwrap_or_else(|| PathBuf::from(".gemini"));
    mtime_fingerprint(&home)
}

pub(crate) fn pi_home_fingerprint() -> String {
    let sessions = crate::engine::pi_history::resolve_pi_sessions_root(None);
    let home = sessions
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| sessions.clone());
    let mut parts = vec![mtime_fingerprint(&home), mtime_fingerprint(&sessions)];
    // New jsonl lives in sessions/<encoded-cwd>/; parent mtime often stays
    // unchanged, so include each cwd-dir fingerprint.
    if let Ok(entries) = fs::read_dir(&sessions) {
        let mut child_prints = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            if name.starts_with('.') {
                continue;
            }
            child_prints.push(format!("{name}:{}", mtime_fingerprint(&path)));
        }
        child_prints.sort();
        parts.extend(child_prints);
    }
    parts.join("|")
}

pub(crate) fn grok_home_fingerprint() -> String {
    let home = std::env::var("GROK_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
        .unwrap_or_else(|| PathBuf::from(".grok"));
    let sessions = home.join("sessions");
    format!(
        "{}|{}",
        mtime_fingerprint(&home),
        mtime_fingerprint(&sessions)
    )
}

pub(crate) fn opencode_source_fingerprint(workspace_path: &Path) -> String {
    // OpenCode has no durable local index file we control; use wall-clock bucket
    // so soft re-sync can refresh without force while still de-duping storms.
    let bucket = now_ms_fallback() / 15_000;
    format!(
        "opencode:{}:{}",
        normalize_path_key(&workspace_path.to_string_lossy()),
        bucket
    )
}

pub(crate) fn qoder_source_fingerprint(workspace_path: &Path) -> String {
    // Qoder history is ACP session/list, not a vendor disk sessions root.
    // Use a wall-clock bucket so sidebar light-sync can refresh without force
    // while still de-duping storms (same idea as OpenCode).
    let bucket = now_ms_fallback() / 15_000;
    format!(
        "qoder:{}:{}",
        normalize_path_key(&workspace_path.to_string_lossy()),
        bucket
    )
}

pub(crate) fn dsh_source_fingerprint(workspace_path: &Path) -> String {
    // DSH sessions live in the host process / $DSH_HOME. Home mtime catches
    // durable writes; a short wall-clock bucket still re-probes live host
    // sessions created without immediate disk churn (same idea as OpenCode).
    let home = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
        .unwrap_or_else(|| PathBuf::from(".dsh"));
    let bucket = now_ms_fallback() / 15_000;
    format!(
        "dsh:{}:{}:{}",
        normalize_path_key(&workspace_path.to_string_lossy()),
        mtime_fingerprint(&home),
        bucket
    )
}

pub(crate) fn rows_from_gemini_summaries(
    workspace_path: &Path,
    sessions: &[crate::engine::gemini_history::GeminiSessionSummary],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    sessions
        .iter()
        .map(|session| {
            let title = {
                let trimmed = session.first_message.trim();
                if trimmed.is_empty() {
                    "Gemini Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            SessionIndexRow {
                engine: "gemini".into(),
                session_id: session.session_id.clone(),
                title,
                native_title: None,
                updated_at: session.updated_at,
                created_at: Some(session.created_at).filter(|value| *value > 0),
                cwd: Some(workspace_key.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: session.file_size_bytes,
                provider_profile_id: None,
                provider_profile_name: None,
            }
        })
        .collect()
}

pub(crate) fn rows_from_pi_summaries(
    workspace_path: &Path,
    sessions: &[crate::engine::pi_history::PiSessionSummary],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    sessions
        .iter()
        .map(|session| {
            let title = {
                let trimmed = session.first_message.trim();
                if trimmed.is_empty() {
                    "PI Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            SessionIndexRow {
                engine: "pi".into(),
                session_id: session.session_id.clone(),
                title,
                native_title: None,
                updated_at: session.updated_at,
                created_at: Some(session.created_at).filter(|value| *value > 0),
                cwd: Some(workspace_key.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: session.file_size_bytes,
                provider_profile_id: None,
                provider_profile_name: None,
            }
        })
        .collect()
}

pub(crate) fn rows_from_qoder_summaries(
    workspace_path: &Path,
    sessions: &[crate::engine::qoder_history::QoderSessionSummary],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    sessions
        .iter()
        .filter_map(|session| {
            let session_id = match canonical_qoder_native_session_id(
                &session.session_id,
                session.provider_profile_id.as_deref(),
            ) {
                Ok(session_id) => session_id,
                Err(error) => {
                    log::warn!(
                        "[session-index] ignored invalid Qoder session identity `{}`: {}",
                        session.session_id,
                        error
                    );
                    return None;
                }
            };
            let title = {
                let trimmed = session.first_message.trim();
                if trimmed.is_empty() {
                    "Qoder Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            Some(SessionIndexRow {
                engine: "qoder".into(),
                session_id,
                title,
                native_title: None,
                updated_at: session.updated_at,
                created_at: Some(session.created_at).filter(|value| *value > 0),
                cwd: Some(workspace_key.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: session.file_size_bytes,
                provider_profile_id: session.provider_profile_id.clone(),
                provider_profile_name: session.provider_profile_name.clone(),
            })
        })
        .collect()
}

pub(crate) fn rows_from_dsh_summaries(
    workspace_path: &Path,
    sessions: &[crate::engine::dsh::history::DshSessionSummary],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    sessions
        .iter()
        .map(|session| {
            let title = {
                let trimmed = session.first_message.trim();
                if trimmed.is_empty() {
                    "DeepSeek Harness Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            SessionIndexRow {
                engine: "dsh".into(),
                session_id: session.session_id.clone(),
                title,
                native_title: None,
                updated_at: session.updated_at,
                created_at: Some(session.created_at).filter(|value| *value > 0),
                cwd: Some(workspace_key.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: None,
                provider_profile_id: None,
                provider_profile_name: None,
            }
        })
        .collect()
}

pub(crate) fn rows_from_grok_summaries(
    workspace_path: &Path,
    sessions: &[crate::engine::grok_history::GrokSessionSummary],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    sessions
        .iter()
        .map(|session| {
            let title = {
                let trimmed = session.first_message.trim();
                if trimmed.is_empty() {
                    "Grok Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            SessionIndexRow {
                engine: "grok".into(),
                session_id: session.session_id.clone(),
                title,
                native_title: None,
                updated_at: session.updated_at,
                created_at: Some(session.created_at).filter(|value| *value > 0),
                cwd: Some(workspace_key.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: session.parent_session_id.clone(),
                size_bytes: session.file_size_bytes,
                provider_profile_id: None,
                provider_profile_name: None,
            }
        })
        .collect()
}

pub(crate) fn rows_from_opencode_entries(
    workspace_path: &Path,
    entries: &[crate::engine::OpenCodeSessionEntry],
) -> Vec<SessionIndexRow> {
    let workspace_key = normalize_path_key(&workspace_path.to_string_lossy());
    entries
        .iter()
        .map(|entry| {
            let title = {
                let trimmed = entry.title.trim();
                if trimmed.is_empty() {
                    "OpenCode Session".to_string()
                } else {
                    truncate_title(trimmed, 80)
                }
            };
            let cwd = entry
                .directory
                .as_deref()
                .map(normalize_path_key)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| workspace_key.clone());
            SessionIndexRow {
                engine: "opencode".into(),
                session_id: entry.session_id.clone(),
                title,
                native_title: None,
                updated_at: entry.updated_at.unwrap_or_else(now_ms_fallback),
                created_at: None,
                cwd: Some(cwd.clone()),
                workspace_path: Some(workspace_key.clone()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: None,
                provider_profile_id: None,
                provider_profile_name: None,
            }
        })
        .collect()
}

/// Soft-invalidate all sources for a workspace so the next sync rescans.
pub(crate) fn invalidate_workspace_sources(
    connection: &Connection,
    workspace_path: &Path,
) -> Result<usize, String> {
    let key = normalize_path_key(&workspace_path.to_string_lossy());
    if key.is_empty() {
        return Ok(0);
    }
    let pattern = format!("%:{}", key);
    let changed = connection
        .execute(
            "UPDATE session_index_sources
             SET last_sync_ms = 0
             WHERE source_key LIKE ?1 OR source_key LIKE ?2",
            rusqlite::params![pattern, format!("%{}", key)],
        )
        .map_err(|error| error.to_string())?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::super::store::mark_source_synced;
    use super::*;

    #[test]
    fn claude_index_row_writes_file_birthtime_as_created_at() {
        let dir = std::env::temp_dir().join(format!(
            "claude-created-at-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("sess-created-at.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello created at"}]}}
"#,
        )
        .expect("write");
        let row =
            claude_index_row_from_file(&path, Path::new("/tmp/ws"), &HashMap::new()).expect("row");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(row.created_at.unwrap_or(0) > 0);
        assert!(row.updated_at > 0);
    }

    #[test]
    fn rows_from_pi_summaries_prefix_engine_and_title() {
        let rows = rows_from_pi_summaries(
            Path::new("/Users/chenxiangning/code/AI/reach/ai-reach"),
            &[crate::engine::pi_history::PiSessionSummary {
                session_id: "019ffb7b-dedc-7b36-8d2f-f85f35501036".into(),
                first_message: "你在干什么".into(),
                updated_at: 10,
                created_at: 9,
                message_count: 2,
                file_size_bytes: Some(128),
                engine: Some("pi".into()),
                canonical_session_id: None,
                attribution_status: None,
            }],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].engine, "pi");
        assert_eq!(rows[0].session_id, "019ffb7b-dedc-7b36-8d2f-f85f35501036");
        assert_eq!(rows[0].title, "你在干什么");
        assert_eq!(rows[0].size_bytes, Some(128));
    }

    #[test]
    fn rows_from_dsh_summaries_prefix_engine_and_title() {
        let rows = rows_from_dsh_summaries(
            Path::new("/Users/zhukunpeng/Desktop/CC GUI 项目/desktop-cc-gui"),
            &[crate::engine::dsh::history::DshSessionSummary {
                session_id: "session-aba863d5-ef07-4a41-94a6-4dc7c2226d3d".into(),
                first_message: "无法查看DSH历史记录".into(),
                updated_at: 1_786_896_696_172,
                created_at: 1_786_896_696_172,
                message_count: 0,
                engine: Some("dsh".into()),
                canonical_session_id: Some("session-aba863d5-ef07-4a41-94a6-4dc7c2226d3d".into()),
                agent_preset: None,
            }],
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].engine, "dsh");
        assert_eq!(
            rows[0].session_id,
            "session-aba863d5-ef07-4a41-94a6-4dc7c2226d3d"
        );
        assert_eq!(rows[0].title, "无法查看DSH历史记录");
        assert!(rows[0]
            .workspace_path
            .as_deref()
            .is_some_and(|path| path.contains("desktop-cc-gui")));
    }

    #[test]
    fn rows_from_qoder_summaries_prefix_engine_and_title() {
        let rows = rows_from_qoder_summaries(
            Path::new("/Users/zhukunpeng/Desktop/CC GUI 项目/desktop-cc-gui"),
            &[
                crate::engine::qoder_history::QoderSessionSummary {
                    session_id: "019ffb7b-dedc-7b36-8d2f-f85f35501036".into(),
                    first_message: "我是 Qoder Global".into(),
                    updated_at: 1_786_896_696_172,
                    created_at: 1_786_896_696_172,
                    message_count: 2,
                    file_size_bytes: None,
                    engine: Some("qoder".into()),
                    canonical_session_id: Some("019ffb7b-dedc-7b36-8d2f-f85f35501036".into()),
                    attribution_status: None,
                    provider_profile_id: Some("__qoder_global__".into()),
                    provider_profile_name: Some("Qoder Global".into()),
                },
                crate::engine::qoder_history::QoderSessionSummary {
                    session_id: "019ffb7b-dedc-7b36-8d2f-f85f35501036".into(),
                    first_message: "我是 Qoder CN".into(),
                    updated_at: 1_786_896_696_173,
                    created_at: 1_786_896_696_173,
                    message_count: 2,
                    file_size_bytes: None,
                    engine: Some("qoder".into()),
                    canonical_session_id: Some("019ffb7b-dedc-7b36-8d2f-f85f35501036".into()),
                    attribution_status: None,
                    provider_profile_id: Some("__qoder_cn__".into()),
                    provider_profile_name: Some("Qoder CN".into()),
                },
            ],
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].engine, "qoder");
        assert_eq!(
            rows[0].session_id,
            "qoder:__qoder_global__:019ffb7b-dedc-7b36-8d2f-f85f35501036"
        );
        assert_eq!(rows[0].title, "我是 Qoder Global");
        assert_eq!(
            rows[0].provider_profile_id.as_deref(),
            Some("__qoder_global__")
        );
        assert_eq!(
            rows[1].session_id,
            "qoder:__qoder_cn__:019ffb7b-dedc-7b36-8d2f-f85f35501036"
        );
        assert_eq!(rows[1].provider_profile_id.as_deref(), Some("__qoder_cn__"));
        assert!(rows[0]
            .workspace_path
            .as_deref()
            .is_some_and(|path| path.contains("desktop-cc-gui")));
    }

    #[test]
    fn pi_fingerprint_changes_when_cwd_subdir_gets_new_jsonl() {
        let dir = std::env::temp_dir().join(format!(
            "pi-fp-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let sessions = dir.join("sessions");
        let cwd = sessions.join("--tmp-ws--");
        std::fs::create_dir_all(&cwd).expect("mkdir");
        std::fs::write(cwd.join("a.jsonl"), "x").expect("write a");
        let previous = std::env::var("PI_CODING_AGENT_DIR").ok();
        std::env::set_var("PI_CODING_AGENT_DIR", &dir);
        let first = pi_home_fingerprint();
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(cwd.join("b.jsonl"), "y").expect("write b");
        let second = pi_home_fingerprint();
        match previous {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(first, second, "cwd jsonl must change PI fingerprint");
    }

    #[test]
    fn incremental_sync_helper_treats_missing_mismatch_and_invalidate() {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(
                "CREATE TABLE session_index_sources (
                   source_key TEXT PRIMARY KEY,
                   fingerprint TEXT NOT NULL,
                   last_sync_ms INTEGER NOT NULL,
                   row_count INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .expect("ddl");
        let workspace = Path::new("/tmp/ccgui-pi-stale-ws");
        assert!(!engine_source_is_fresh(&connection, "pi", workspace, "fp-a").expect("missing"));
        mark_source_synced(&connection, "pi:/tmp/ccgui-pi-stale-ws", "fp-a", 1).expect("mark");
        assert!(engine_source_is_fresh(&connection, "pi", workspace, "fp-a").expect("match"));
        assert!(!engine_source_is_fresh(&connection, "pi", workspace, "fp-b").expect("mismatch"));
        connection
            .execute(
                "UPDATE session_index_sources SET last_sync_ms = 0 WHERE source_key = ?1",
                ["pi:/tmp/ccgui-pi-stale-ws"],
            )
            .expect("invalidate");
        assert!(
            !engine_source_is_fresh(&connection, "pi", workspace, "fp-a").expect("invalidated")
        );
    }

    #[test]
    fn commit_engine_rows_timeout_does_not_wipe_or_mark_fresh() {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(super::super::store::DDL)
            .expect("ddl");
        let workspace = Path::new(r"C:\Users\me\proj");
        let existing = SessionIndexRow {
            engine: "grok".into(),
            session_id: "grok-keep".into(),
            title: "keep".into(),
            native_title: None,
            updated_at: 200,
            created_at: None,
            cwd: Some(r"C:\Users\me\proj".into()),
            workspace_path: Some(r"C:\Users\me\proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[existing]).expect("seed");
        mark_source_synced(&connection, "grok:c:/users/me/proj", "fp-ok", 1).expect("mark");
        assert!(engine_source_is_fresh(&connection, "grok", workspace, "fp-ok").expect("fresh"));

        let result = commit_engine_rows(
            &connection,
            "grok",
            workspace,
            Vec::new(),
            "fp-ok",
            Some("grok-sync-timeout".into()),
        )
        .expect("timeout commit");
        assert_eq!(result.upserted, 0);
        assert_eq!(result.partial_source.as_deref(), Some("grok-sync-timeout"));
        assert!(
            !engine_source_is_fresh(&connection, "grok", workspace, "fp-ok")
                .expect("must not stay fresh")
        );
        let listed =
            super::super::store::list_for_workspace_path(&connection, r"C:\Users\me\proj", 10)
                .expect("list");
        assert!(
            listed.iter().any(|row| row.session_id == "grok-keep"),
            "timeout empty commit must not wipe indexed grok rows: {listed:?}"
        );
    }

    #[test]
    fn root_fresh_but_child_newer_does_not_skip() {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(super::super::store::DDL)
            .expect("ddl");
        let workspace = Path::new("/tmp/ccgui-fresh-child");
        let existing = SessionIndexRow {
            engine: "grok".into(),
            session_id: "old".into(),
            title: "old".into(),
            native_title: None,
            updated_at: 100,
            created_at: None,
            cwd: Some("/tmp/ccgui-fresh-child".into()),
            workspace_path: Some("/tmp/ccgui-fresh-child".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[existing]).expect("seed");
        mark_source_synced(&connection, "grok:/tmp/ccgui-fresh-child", "fp-root", 1).expect("mark");
        assert!(engine_source_is_fresh(&connection, "grok", workspace, "fp-root").expect("fp"));
        assert!(
            !source_should_skip_as_fresh(
                &connection,
                "grok:/tmp/ccgui-fresh-child",
                "fp-root",
                "grok",
                workspace,
                Some(200),
            )
            .expect("child newer"),
            "root fingerprint fresh + child newer than ledger must not skip"
        );
        assert!(
            source_should_skip_as_fresh(
                &connection,
                "grok:/tmp/ccgui-fresh-child",
                "fp-root",
                "grok",
                workspace,
                Some(50),
            )
            .expect("child older"),
            "child older than ledger may stay skipped"
        );
    }

    #[test]
    fn claude_injection_envelopes_are_synthetic_but_real_prompt_is_not() {
        assert!(is_claude_control_or_synthetic_user_text(
            "<system-reminder>\nInstructions from: AGENTS.md\n</system-reminder>"
        ));
        assert!(is_claude_control_or_synthetic_user_text(
            "<user_info>\nOS Version: macos\n</user_info>"
        ));
        assert!(is_claude_control_or_synthetic_user_text("Warmup"));
        assert!(is_claude_control_or_synthetic_user_text(
            "<command-name>/resume</command-name>"
        ));
        assert!(!is_claude_control_or_synthetic_user_text(
            "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>看一下这个 PR</command-args>"
        ));
        assert!(!is_claude_control_or_synthetic_user_text(
            "<system-reminder>ctx</system-reminder>\n请帮我看一下列表"
        ));
        assert!(!is_claude_control_or_synthetic_user_text("你好"));
        assert!(is_claude_control_or_synthetic_user_text(
            "MOSSX_CONTEXT_PACKAGE:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));
        assert!(is_claude_control_or_synthetic_user_text("MOSSX_CONTE"));
        assert!(super::is_mossx_shared_protocol_owner_text(
            "MOSSX_CONTEXT_PACKAGE:sha256:dead"
        ));
        assert!(super::is_mossx_shared_protocol_owner_text(
            "MOSSX_SHARED_CONTEXT_V1\nsession:x"
        ));
        assert!(!super::is_mossx_shared_protocol_owner_text("MOSSX_CONTE"));
        assert!(!super::is_mossx_shared_protocol_owner_text("继续"));
    }

    #[test]
    fn claude_index_skips_empty_control_plane_and_agent_jsonl() {
        let dir = std::env::temp_dir().join(format!(
            "claude-omit-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let empty = dir.join("empty-uuid.jsonl");
        std::fs::write(&empty, "").expect("empty");
        let control = dir.join("control-uuid.jsonl");
        std::fs::write(
            &control,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"MOSSX_CONTEXT_PACKAGE:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}}
"#,
        )
        .expect("control");
        let agent = dir.join("agent-deadbeef.jsonl");
        std::fs::write(
            &agent,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"子代理分析"}]}}
"#,
        )
        .expect("agent");
        let real = dir.join("real-uuid.jsonl");
        std::fs::write(
            &real,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"分析左侧栏消失问题"}]}}
"#,
        )
        .expect("real");

        let ws = Path::new("/tmp/ws");
        let titles = HashMap::new();
        assert!(claude_index_row_from_file(&empty, ws, &titles).is_none());
        let control_row = claude_index_row_from_file(&control, ws, &titles)
            .expect("keep mossx owner for protocol hide");
        assert!(control_row.title.starts_with("MOSSX_CONTEXT_PACKAGE"));
        assert!(control_row.native_title.is_none());
        assert!(claude_index_row_from_file(&agent, ws, &titles).is_none());
        let imported = claude_index_row_from_file(&real, ws, &titles).expect("real row");
        assert_eq!(imported.title, "分析左侧栏消失问题");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_index_keeps_mossx_title_when_history_says_continue() {
        let dir = std::env::temp_dir().join(format!(
            "claude-mossx-continue-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("1807f883-011c-46bd-94d5-ff483ffb1a4a.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"MOSSX_CONTEXT_PACKAGE:sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef:sha256:cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe\nMOSSX_SHARED_CONTEXT_V1\nsession:267c001d-932a-4a05-bfa9-a238937f7707\nbinding:claude:c65677af-c64e-4fce-9e34-76f1cd1a7c7f\n\nCurrent user request:\n继续"}]}}
"#,
        )
        .expect("write");
        let mut titles = HashMap::new();
        titles.insert("1807f883-011c-46bd-94d5-ff483ffb1a4a".into(), "继续".into());
        let row = claude_index_row_from_file(&path, Path::new("/tmp/ws"), &titles)
            .expect("protocol owner stays in index");
        assert!(
            row.title.starts_with("MOSSX_CONTEXT_PACKAGE"),
            "history 继续 must not replace protocol title: {}",
            row.title
        );
        assert_ne!(row.title, "继续");
        assert!(row.native_title.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_index_omits_history_title_that_is_mossx_control_plane() {
        let dir = std::env::temp_dir().join(format!(
            "claude-omit-history-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("history-control.jsonl");
        std::fs::write(&path, "{\"type\":\"assistant\"}\n").expect("write");
        let mut titles = HashMap::new();
        titles.insert(
            "history-control".into(),
            "MOSSX_CONTEXT_PACKAGE:sha25…".into(),
        );
        assert!(claude_index_row_from_file(&path, Path::new("/tmp/ws"), &titles).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample_codex_summary(
        session_id: &str,
        title: Option<&str>,
    ) -> crate::types::LocalUsageSessionSummary {
        crate::types::LocalUsageSessionSummary {
            session_id: session_id.into(),
            session_id_aliases: vec![],
            parent_session_id: None,
            timestamp: 1,
            cwd: Some("/tmp/ws".into()),
            model: "gpt-5.1".into(),
            usage: Default::default(),
            cost: 0.0,
            summary: title.map(str::to_string),
            native_title: None,
            source: None,
            provider: None,
            provider_profile_id: None,
            provider_profile_source: None,
            provider_profile_name: None,
            provider_availability: None,
            physical_path: None,
            file_size_bytes: None,
            modified_lines: 0,
        }
    }

    #[test]
    fn should_omit_codex_index_title_filters_empty_helpers_and_mossx() {
        assert!(should_omit_codex_index_title(""));
        assert!(should_omit_codex_index_title("Codex Session"));
        assert!(should_omit_codex_index_title("codex session"));
        assert!(!should_omit_codex_index_title(
            "MOSSX_CONTEXT_PACKAGE:sha25"
        ));
        assert!(should_omit_codex_index_title(
            "Generate a concise title for a coding chat thread from the first user message."
        ));
        assert!(should_omit_codex_index_title(
            "You are generating OpenSpec project context."
        ));
        assert!(!should_omit_codex_index_title("分析左侧栏消失问题"));
        assert!(!should_omit_codex_index_title("Aristotle"));
    }

    #[test]
    fn collect_codex_index_rows_omits_empty_helpers_and_keeps_real() {
        let (rows, omitted) = collect_codex_index_rows(
            vec![
                sample_codex_summary("empty", None),
                sample_codex_summary("generic", Some("Codex Session")),
                sample_codex_summary("mossx", Some("MOSSX_CONTEXT_PACKAGE:sha25")),
                sample_codex_summary(
                    "helper",
                    Some("You are generating OpenSpec project context."),
                ),
                sample_codex_summary("real", Some("分析左侧栏消失问题")),
                sample_codex_summary("nick", Some("Aristotle")),
            ],
            "/tmp/ws",
        );
        let kept: Vec<&str> = rows.iter().map(|row| row.session_id.as_str()).collect();
        assert_eq!(kept, vec!["mossx", "real", "nick"]);
        let omitted_ids: Vec<&str> = omitted.iter().map(|(_, id)| id.as_str()).collect();
        assert_eq!(omitted_ids, vec!["empty", "generic", "helper"]);
        let mossx_row = rows
            .iter()
            .find(|row| row.session_id == "mossx")
            .expect("keep");
        assert!(mossx_row.title.starts_with("MOSSX_CONTEXT_PACKAGE"));
    }
}
