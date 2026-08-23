use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS session_index (
  engine TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  native_title TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER,
  cwd TEXT,
  workspace_path TEXT,
  physical_path TEXT,
  parent_session_id TEXT,
  size_bytes INTEGER,
  provider_profile_id TEXT,
  provider_profile_name TEXT,
  source_fingerprint TEXT,
  indexed_at INTEGER NOT NULL,
  tombstoned_at INTEGER,
  PRIMARY KEY (engine, session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_index_workspace_mtime
  ON session_index(workspace_path, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_index_cwd_mtime
  ON session_index(cwd, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_index_engine_mtime
  ON session_index(engine, updated_at DESC);

CREATE TABLE IF NOT EXISTS session_index_sources (
  source_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  last_sync_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_index_backfill (
  source_key TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  complete INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexRow {
    pub engine: String,
    pub session_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_title: Option<String>,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub physical_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexListPage {
    pub data: Vec<SessionIndexRow>,
    pub source: String,
    pub synced: bool,
    pub sync_ms: Option<u64>,
    pub engines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_source: Option<String>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<super::shared_visibility::SharedNativeVisibilityProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexSyncReport {
    pub upserted: usize,
    pub engines: Vec<String>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_source: Option<String>,
    pub skipped_fresh: bool,
}

pub(crate) fn database_path() -> Result<PathBuf, String> {
    Ok(crate::app_paths::app_home_dir()?.join("session-index.sqlite3"))
}

pub(crate) fn open_connection() -> Result<Connection, String> {
    let path = database_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(DDL)
        .map_err(|error| error.to_string())?;
    let _ = connection.execute(
        "ALTER TABLE session_index ADD COLUMN tombstoned_at INTEGER",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE session_index ADD COLUMN provider_profile_id TEXT",
        [],
    );
    let _ = connection.execute(
        "ALTER TABLE session_index ADD COLUMN provider_profile_name TEXT",
        [],
    );
    let _ = connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_index_backfill (
           source_key TEXT PRIMARY KEY,
           cursor TEXT NOT NULL DEFAULT '',
           complete INTEGER NOT NULL DEFAULT 0,
           updated_ms INTEGER NOT NULL
         );",
    );
    migrate_legacy_qoder_session_identities(&connection)?;
    Ok(connection)
}

/// Session Index historically keyed Qoder rows by raw ACP id. Global and CN
/// may legitimately produce the same raw id, so upgrade old rows in place to
/// the profile-qualified identity before any list or writer can observe them.
/// The vendor history files remain untouched.
fn migrate_legacy_qoder_session_identities(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT session_id, provider_profile_id, tombstoned_at
             FROM session_index
             WHERE engine = 'qoder'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Ok(());
    }

    let tx = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for (legacy_id, provider_profile_id, tombstoned_at) in rows {
        let identity =
            match crate::engine::qoder_provider_profile::parse_qoder_native_session_identity(
                &legacy_id,
                provider_profile_id.as_deref(),
            ) {
                Ok(identity) => identity,
                Err(error) => {
                    log::warn!(
                    "[session-index] retained malformed Qoder identity `{}` during migration: {}",
                    legacy_id,
                    error
                );
                    continue;
                }
            };
        let canonical_id = identity.canonical_id();
        let canonical_provider_profile_id = identity.provider_profile_id;
        if canonical_id == legacy_id {
            tx.execute(
                "UPDATE session_index SET provider_profile_id = ?1
                 WHERE engine = 'qoder' AND session_id = ?2",
                params![canonical_provider_profile_id, legacy_id],
            )
            .map_err(|error| error.to_string())?;
            continue;
        }
        let canonical_exists = tx
            .query_row(
                "SELECT 1 FROM session_index WHERE engine = 'qoder' AND session_id = ?1",
                [&canonical_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if canonical_exists {
            if let Some(tombstoned_at) = tombstoned_at {
                tx.execute(
                    "UPDATE session_index
                     SET tombstoned_at = COALESCE(tombstoned_at, ?1),
                         provider_profile_id = ?2
                     WHERE engine = 'qoder' AND session_id = ?3",
                    params![tombstoned_at, canonical_provider_profile_id, canonical_id],
                )
                .map_err(|error| error.to_string())?;
            } else {
                tx.execute(
                    "UPDATE session_index SET provider_profile_id = ?1
                     WHERE engine = 'qoder' AND session_id = ?2",
                    params![canonical_provider_profile_id, canonical_id],
                )
                .map_err(|error| error.to_string())?;
            }
            tx.execute(
                "DELETE FROM session_index WHERE engine = 'qoder' AND session_id = ?1",
                [&legacy_id],
            )
            .map_err(|error| error.to_string())?;
        } else {
            tx.execute(
                "UPDATE session_index SET session_id = ?1, provider_profile_id = ?2
                 WHERE engine = 'qoder' AND session_id = ?3",
                params![canonical_id, canonical_provider_profile_id, legacy_id],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn normalize_path_key(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut normalized = trimmed.replace('\\', "/");

    // Windows extended-length prefixes after slash unification:
    // \\?\C:\foo → //?/C:/foo → C:/foo
    // \\?\UNC\server\share → //?/UNC/server/share → //server/share
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{rest}");
    } else if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_string();
    }

    while should_strip_trailing_slash(&normalized) {
        normalized.pop();
    }

    if is_windows_style_path(&normalized) {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn should_strip_trailing_slash(path: &str) -> bool {
    if path.len() <= 1 || !path.ends_with('/') {
        return false;
    }
    // Keep drive roots such as C:/
    if path.len() == 3 && path.as_bytes()[1] == b':' {
        return false;
    }
    path != "//"
}

fn is_windows_style_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return true;
    }
    path.starts_with("//")
}

pub(crate) fn paths_equivalent(left: &str, right: &str) -> bool {
    let left = normalize_path_key(left);
    let right = normalize_path_key(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    if is_windows_style_path(&left) && is_windows_style_path(&right) {
        return left.eq_ignore_ascii_case(&right);
    }
    false
}

pub(crate) fn upsert_rows(
    connection: &Connection,
    rows: &[SessionIndexRow],
) -> Result<usize, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let indexed_at = now_ms();
    let tx = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO session_index (
                    engine, session_id, title, native_title, updated_at, created_at,
                    cwd, workspace_path, physical_path, parent_session_id, size_bytes,
                    provider_profile_id, provider_profile_name,
                    source_fingerprint, indexed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(engine, session_id) DO UPDATE SET
                    title = excluded.title,
                    native_title = excluded.native_title,
                    updated_at = excluded.updated_at,
                    created_at = COALESCE(session_index.created_at, excluded.created_at, session_index.updated_at),
                    cwd = COALESCE(excluded.cwd, session_index.cwd),
                    workspace_path = COALESCE(excluded.workspace_path, session_index.workspace_path),
                    physical_path = COALESCE(excluded.physical_path, session_index.physical_path),
                    parent_session_id = COALESCE(excluded.parent_session_id, session_index.parent_session_id),
                    size_bytes = COALESCE(excluded.size_bytes, session_index.size_bytes),
                    provider_profile_id = COALESCE(excluded.provider_profile_id, session_index.provider_profile_id),
                    provider_profile_name = COALESCE(excluded.provider_profile_name, session_index.provider_profile_name),
                    source_fingerprint = excluded.source_fingerprint,
                    indexed_at = excluded.indexed_at
                 WHERE session_index.tombstoned_at IS NULL",
            )
            .map_err(|error| error.to_string())?;
        for row in rows {
            let engine = row.engine.trim().to_ascii_lowercase();
            let qoder_identity = (engine == "qoder")
                .then(|| {
                    crate::engine::qoder_provider_profile::parse_qoder_native_session_identity(
                        &row.session_id,
                        row.provider_profile_id.as_deref(),
                    )
                })
                .transpose()?;
            let qoder_session_id = qoder_identity.as_ref().map(
                crate::engine::qoder_provider_profile::QoderNativeSessionIdentity::canonical_id,
            );
            let session_id = qoder_session_id
                .as_deref()
                .unwrap_or_else(|| row.session_id.trim());
            let provider_profile_id = qoder_identity
                .as_ref()
                .map(|identity| identity.provider_profile_id)
                .or_else(|| {
                    row.provider_profile_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                });
            if engine.is_empty() || session_id.is_empty() {
                continue;
            }
            let title = {
                let trimmed = row.title.trim();
                if trimmed.is_empty() {
                    format!("{} session", engine)
                } else {
                    trimmed.to_string()
                }
            };
            let cwd = row
                .cwd
                .as_deref()
                .map(normalize_path_key)
                .filter(|value| !value.is_empty());
            let workspace_path = row
                .workspace_path
                .as_deref()
                .map(normalize_path_key)
                .filter(|value| !value.is_empty())
                .or_else(|| cwd.clone());
            statement
                .execute(params![
                    engine,
                    session_id,
                    title,
                    row.native_title
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    row.updated_at.max(0),
                    row.created_at
                        .filter(|value| *value > 0)
                        .or(Some(row.updated_at.max(0))),
                    cwd,
                    workspace_path,
                    row.physical_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    row.parent_session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    row.size_bytes.map(|value| value as i64),
                    provider_profile_id,
                    row.provider_profile_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty()),
                    row.physical_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or(""),
                    indexed_at,
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(rows.len())
}

pub(crate) fn mark_source_synced(
    connection: &Connection,
    source_key: &str,
    fingerprint: &str,
    row_count: usize,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO session_index_sources (source_key, fingerprint, last_sync_ms, row_count)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source_key) DO UPDATE SET
               fingerprint = excluded.fingerprint,
               last_sync_ms = excluded.last_sync_ms,
               row_count = excluded.row_count",
            params![source_key, fingerprint, now_ms(), row_count as i64],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn source_is_fresh(
    connection: &Connection,
    source_key: &str,
    fingerprint: &str,
    max_age_ms: i64,
) -> Result<bool, String> {
    let row = connection
        .query_row(
            "SELECT fingerprint, last_sync_ms FROM session_index_sources WHERE source_key = ?1",
            [source_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((stored_fp, last_sync_ms)) = row else {
        return Ok(false);
    };
    if stored_fp != fingerprint {
        return Ok(false);
    }
    let age = now_ms().saturating_sub(last_sync_ms);
    Ok(age <= max_age_ms)
}

pub(crate) fn max_updated_at_for_engine(
    connection: &Connection,
    engine: &str,
    workspace_path: &str,
) -> Result<Option<i64>, String> {
    let key = normalize_path_key(workspace_path);
    let engine = engine.trim().to_ascii_lowercase();
    if key.is_empty() || engine.is_empty() {
        return Ok(None);
    }
    let max: Option<i64> = connection
        .query_row(
            "SELECT MAX(updated_at) FROM session_index
             WHERE engine = ?1
               AND tombstoned_at IS NULL
               AND (workspace_path = ?2 OR cwd = ?2)",
            params![engine, key],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(max.filter(|value| *value > 0))
}

/// True when a send/create marked this workspace's Index sources stale.
/// Restart first-paint / next non-force list must rescan writers even if
/// some Claude/Codex rows already exist.
pub(crate) fn workspace_index_sources_invalidated(
    connection: &Connection,
    workspace_path: &str,
) -> Result<bool, String> {
    let key = normalize_path_key(workspace_path);
    if key.is_empty() {
        return Ok(false);
    }
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_index_sources
             WHERE last_sync_ms <= 0
               AND (source_key LIKE ?1 OR source_key LIKE ?2)",
            rusqlite::params![format!("%:{}", key), format!("%{}", key)],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(count > 0)
}

pub(crate) fn invalidate_source_freshness(
    connection: &Connection,
    source_key: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE session_index_sources SET last_sync_ms = 0 WHERE source_key = ?1",
            [source_key],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

const INDEX_LIST_ENGINES: &[&str] = &[
    "claude", "codex", "gemini", "grok", "kimi", "opencode", "pi", "dsh", "qoder",
];

fn list_slice_for_workspace_engine(
    connection: &Connection,
    workspace_key: &str,
    engine: &str,
    limit: usize,
) -> Result<Vec<SessionIndexRow>, String> {
    let fetch_limit = if engine == "codex" {
        (limit.saturating_mul(8)).clamp(limit, 500)
    } else {
        limit
    };
    let mut statement = connection
        .prepare(
            "SELECT engine, session_id, title, native_title, updated_at, created_at,
                    cwd, workspace_path, physical_path, parent_session_id, size_bytes,
                    provider_profile_id, provider_profile_name
             FROM session_index
             WHERE (workspace_path = ?1 OR cwd = ?1)
               AND engine = ?2
               AND tombstoned_at IS NULL
             ORDER BY updated_at DESC, session_id ASC
             LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query_map(params![workspace_key, engine, fetch_limit as i64], map_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if engine == "codex" {
        hydrate_missing_codex_parents(connection, workspace_key, &mut rows)?;
        retain_codex_parent_tree_within_limit(&mut rows, limit);
    }
    Ok(rows)
}

fn hydrate_missing_codex_parents(
    connection: &Connection,
    workspace_key: &str,
    rows: &mut Vec<SessionIndexRow>,
) -> Result<(), String> {
    let mut existing = std::collections::HashSet::<String>::new();
    for row in rows.iter() {
        existing.insert(row.session_id.clone());
        let bare = strip_known_engine_prefix(&row.session_id);
        if !bare.is_empty() {
            existing.insert(bare.to_string());
        }
        if let Some(uuid) = extract_codex_canonical_session_id(&row.session_id) {
            existing.insert(uuid);
        }
    }
    let missing: Vec<String> = rows
        .iter()
        .filter_map(|row| row.parent_session_id.clone())
        .filter(|parent| {
            let bare = strip_known_engine_prefix(parent);
            if existing.contains(parent) || existing.contains(bare) {
                return false;
            }
            extract_codex_canonical_session_id(parent)
                .map(|uuid| !existing.contains(&uuid))
                .unwrap_or(true)
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut statement = connection
        .prepare(
            "SELECT engine, session_id, title, native_title, updated_at, created_at,
                    cwd, workspace_path, physical_path, parent_session_id, size_bytes,
                    provider_profile_id, provider_profile_name
             FROM session_index
             WHERE engine = 'codex'
               AND tombstoned_at IS NULL
               AND (workspace_path = ?1 OR cwd = ?1)
               AND (session_id = ?2 OR session_id = ?3)",
        )
        .map_err(|error| error.to_string())?;
    for parent in missing {
        let bare = strip_known_engine_prefix(&parent);
        let fetched = statement
            .query_map(params![workspace_key, parent, bare], map_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        for row in fetched {
            if existing.insert(row.session_id.clone()) {
                rows.push(row);
            }
        }
    }
    Ok(())
}

fn row_matches_workspace(row: &SessionIndexRow, key: &str) -> bool {
    row.workspace_path
        .as_deref()
        .is_some_and(|value| paths_equivalent(value, key))
        || row
            .cwd
            .as_deref()
            .is_some_and(|value| paths_equivalent(value, key))
}

fn row_is_before_cursor(row: &SessionIndexRow, before: Option<&(i64, String)>) -> bool {
    let Some((before_updated, before_id)) = before else {
        return true;
    };
    row.updated_at < *before_updated
        || (row.updated_at == *before_updated && row.session_id.as_str() > before_id.as_str())
}

/// Scan recent Index rows and fold in path-equivalent matches.
/// Read-only: never rewrites workspace_path. Always run — not only when
/// the exact-key page is empty — so a non-empty Claude page still surfaces
/// Grok/PI written under a drifted Windows key.
fn merge_equivalent_workspace_rows(
    connection: &Connection,
    key: &str,
    limit: usize,
    existing: &mut std::collections::HashSet<(String, String)>,
    rows: &mut Vec<SessionIndexRow>,
    before: Option<(i64, String)>,
) -> Result<(), String> {
    let scan_limit = (limit.saturating_mul(20).max(100)) as i64;
    let mut fallback = connection
        .prepare(
            "SELECT engine, session_id, title, native_title, updated_at, created_at,
                    cwd, workspace_path, physical_path, parent_session_id, size_bytes,
                    provider_profile_id, provider_profile_name
             FROM session_index
             WHERE tombstoned_at IS NULL
             ORDER BY updated_at DESC, session_id ASC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let recent = fallback
        .query_map(params![scan_limit], map_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut per_engine: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in rows.iter() {
        *per_engine.entry(row.engine.clone()).or_insert(0) += 1;
    }
    for row in recent {
        if !row_matches_workspace(&row, key) {
            continue;
        }
        if !row_is_before_cursor(&row, before.as_ref()) {
            continue;
        }
        if !INDEX_LIST_ENGINES.contains(&row.engine.as_str()) {
            continue;
        }
        let identity = (row.engine.clone(), row.session_id.clone());
        if !existing.insert(identity) {
            continue;
        }
        let count = per_engine.entry(row.engine.clone()).or_insert(0);
        if *count >= limit {
            continue;
        }
        *count += 1;
        rows.push(row);
    }
    Ok(())
}

pub(crate) fn list_for_workspace_path(
    connection: &Connection,
    workspace_path: &str,
    limit: usize,
) -> Result<Vec<SessionIndexRow>, String> {
    let limit = limit.clamp(1, 500);
    let key = normalize_path_key(workspace_path);
    if key.is_empty() {
        return Ok(Vec::new());
    }
    // Per-engine budget: a global LIMIT would let recent Claude/Shared rows
    // starve PI (and the sidebar would look like PI never landed).
    let mut rows = Vec::new();
    let mut existing = std::collections::HashSet::<(String, String)>::new();
    for engine in INDEX_LIST_ENGINES {
        for row in list_slice_for_workspace_engine(connection, &key, engine, limit)? {
            let identity = (row.engine.clone(), row.session_id.clone());
            if existing.insert(identity) {
                rows.push(row);
            }
        }
    }

    merge_equivalent_workspace_rows(connection, &key, limit, &mut existing, &mut rows, None)?;
    rows.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(rows)
}

pub(crate) fn list_for_workspace_path_before(
    connection: &Connection,
    workspace_path: &str,
    limit: usize,
    before: Option<(i64, String)>,
) -> Result<Vec<SessionIndexRow>, String> {
    let limit = limit.clamp(1, 500);
    let key = normalize_path_key(workspace_path);
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let fetch_limit = (limit.saturating_add(1)) as i64;
    let mut statement = connection
        .prepare(
            "SELECT engine, session_id, title, native_title, updated_at, created_at,
                    cwd, workspace_path, physical_path, parent_session_id, size_bytes,
                    provider_profile_id, provider_profile_name
             FROM session_index
             WHERE (workspace_path = ?1 OR cwd = ?1)
               AND tombstoned_at IS NULL
               AND (
                 ?3 IS NULL
                 OR updated_at < ?3
                 OR (updated_at = ?3 AND session_id > ?4)
               )
             ORDER BY updated_at DESC, session_id ASC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let before_updated = before.as_ref().map(|(updated_at, _)| *updated_at);
    let before_id = before
        .as_ref()
        .map(|(_, session_id)| session_id.as_str())
        .unwrap_or("");
    let mut rows = statement
        .query_map(
            params![key, fetch_limit, before_updated, before_id],
            map_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut existing: std::collections::HashSet<(String, String)> = rows
        .iter()
        .map(|row| (row.engine.clone(), row.session_id.clone()))
        .collect();
    merge_equivalent_workspace_rows(connection, &key, limit, &mut existing, &mut rows, before)?;
    rows.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    rows.truncate(limit);
    Ok(rows)
}

/// Count all non-tombstoned rows matching a workspace (any engine).
/// Includes path-equivalent keys so has_more does not drop Grok on a drifted
/// Windows path while Claude sits on the current key.
pub(crate) fn count_for_workspace_path(
    connection: &Connection,
    workspace_path: &str,
) -> Result<i64, String> {
    let key = normalize_path_key(workspace_path);
    if key.is_empty() {
        return Ok(0);
    }
    let mut statement = connection
        .prepare("SELECT cwd, workspace_path FROM session_index WHERE tombstoned_at IS NULL")
        .map_err(|error| error.to_string())?;
    let mapped = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut count = 0i64;
    for item in mapped {
        let (cwd, workspace) = item.map_err(|error| error.to_string())?;
        let matches = workspace
            .as_deref()
            .is_some_and(|value| paths_equivalent(value, &key))
            || cwd
                .as_deref()
                .is_some_and(|value| paths_equivalent(value, &key));
        if matches {
            count += 1;
        }
    }
    Ok(count)
}

/// Persisted incremental-backfill state for one `{engine}:{workspace_path}`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BackfillState {
    pub cursor: String,
    pub complete: bool,
}

pub(crate) fn load_backfill_state(
    connection: &Connection,
    source_key: &str,
) -> Result<BackfillState, String> {
    let row = connection
        .query_row(
            "SELECT cursor, complete FROM session_index_backfill WHERE source_key = ?1",
            [source_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(match row {
        Some((cursor, complete)) => BackfillState {
            cursor,
            complete: complete > 0,
        },
        None => BackfillState::default(),
    })
}

pub(crate) fn save_backfill_state(
    connection: &Connection,
    source_key: &str,
    state: &BackfillState,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO session_index_backfill (source_key, cursor, complete, updated_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source_key) DO UPDATE SET
               cursor = excluded.cursor,
               complete = excluded.complete,
               updated_ms = excluded.updated_ms",
            params![
                source_key,
                state.cursor,
                if state.complete { 1 } else { 0 },
                now_ms()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn tombstone_session_ids(
    connection: &Connection,
    session_ids: &[String],
) -> Result<usize, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let marked_at = now_ms();
    let mut updated = 0usize;
    let mut statement = connection
        .prepare(
            "UPDATE session_index
             SET tombstoned_at = COALESCE(tombstoned_at, ?1)
             WHERE session_id = ?2
                OR session_id = ?3
                OR (engine || ':' || session_id) = ?2",
        )
        .map_err(|error| error.to_string())?;
    // 持久删除标记：UPDATE 只能盖住已存在的行；对尚未入索引的 id 直接插入
    // tombstoned 占位行，让后续 rescan 的 INSERT 撞上 (engine, session_id)
    // 冲突并被 ON CONFLICT 的 tombstoned_at IS NULL 守卫挡下，防止已删会话
    // 在重启后的 sync/backfill 中复活。
    let mut marker = connection
        .prepare(
            "INSERT INTO session_index (
                engine, session_id, title, updated_at, indexed_at, tombstoned_at
             ) VALUES (?1, ?2, '', ?3, ?3, ?3)
             ON CONFLICT(engine, session_id) DO NOTHING",
        )
        .map_err(|error| error.to_string())?;
    let mut qoder_statement = connection
        .prepare(
            "UPDATE session_index
             SET tombstoned_at = COALESCE(tombstoned_at, ?1)
             WHERE engine = 'qoder' AND (session_id = ?2 OR session_id = ?3)",
        )
        .map_err(|error| error.to_string())?;
    for raw in session_ids {
        let full = raw.trim();
        if full.is_empty() {
            continue;
        }
        if full.starts_with(crate::engine::qoder_provider_profile::QODER_NATIVE_SESSION_PREFIX) {
            let identity =
                crate::engine::qoder_provider_profile::parse_qoder_native_session_identity(
                    full, None,
                )?;
            let canonical_id = identity.canonical_id();
            let legacy_raw_id = if identity.is_legacy {
                identity.raw_session_id
            } else {
                String::new()
            };
            updated += qoder_statement
                .execute(params![marked_at, canonical_id, legacy_raw_id])
                .map_err(|error| error.to_string())? as usize;
            marker
                .execute(params!["qoder", canonical_id, marked_at])
                .map_err(|error| error.to_string())?;
            continue;
        }
        let engine_hint = full
            .split_once(':')
            .map(|(head, _)| head.trim().to_ascii_lowercase())
            .filter(|head| INDEX_LIST_ENGINES.contains(&head.as_str()));
        let bare = full
            .split_once(':')
            .map(|(_, rest)| rest.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(full);
        updated += statement
            .execute(params![marked_at, full, bare])
            .map_err(|error| error.to_string())? as usize;
        match engine_hint {
            Some(engine) => {
                marker
                    .execute(params![engine, bare, marked_at])
                    .map_err(|error| error.to_string())?;
            }
            None if !full.contains(':') => {
                // 裸 id（如 codex threadId）无法判定 engine，为所有已知
                // engine 落标记；UUID 跨 engine 碰撞可忽略。
                for engine in INDEX_LIST_ENGINES {
                    marker
                        .execute(params![engine, full, marked_at])
                        .map_err(|error| error.to_string())?;
                }
            }
            None => {
                // 未知前缀（如 shared:）不入索引，无需标记。
            }
        }
    }
    Ok(updated)
}

/// Prune-only tombstone: match exact `(engine, session_id)`.
/// Never mark the same bare id on other engines (that would revive the Grok vanish class).
pub(crate) fn tombstone_engine_sessions(
    connection: &Connection,
    pairs: &[(String, String)],
) -> Result<usize, String> {
    if pairs.is_empty() {
        return Ok(0);
    }
    let marked_at = now_ms();
    let mut updated = 0usize;
    let mut statement = connection
        .prepare(
            "UPDATE session_index
             SET tombstoned_at = COALESCE(tombstoned_at, ?1)
             WHERE engine = ?2 AND session_id = ?3",
        )
        .map_err(|error| error.to_string())?;
    let mut marker = connection
        .prepare(
            "INSERT INTO session_index (
                engine, session_id, title, updated_at, indexed_at, tombstoned_at
             ) VALUES (?1, ?2, '', ?3, ?3, ?3)
             ON CONFLICT(engine, session_id) DO NOTHING",
        )
        .map_err(|error| error.to_string())?;
    for (engine, session_id) in pairs {
        let engine = engine.trim().to_ascii_lowercase();
        let qoder_session_id = (engine == "qoder")
            .then(|| {
                crate::engine::qoder_provider_profile::canonical_qoder_native_session_id(
                    session_id, None,
                )
            })
            .transpose()?;
        let session_id = qoder_session_id
            .as_deref()
            .unwrap_or_else(|| session_id.trim());
        if engine.is_empty() || session_id.is_empty() {
            continue;
        }
        updated += statement
            .execute(params![marked_at, engine, session_id])
            .map_err(|error| error.to_string())? as usize;
        marker
            .execute(params![engine, session_id, marked_at])
            .map_err(|error| error.to_string())?;
    }
    Ok(updated)
}

/// Hard-delete Index rows that should never have been imported (empty /
/// control-plane Claude jsonl). Unlike tombstone, this does not block a later
/// upsert when the same session grows a real user prompt.
pub(crate) fn delete_engine_session_rows(
    connection: &Connection,
    pairs: &[(String, String)],
) -> Result<usize, String> {
    if pairs.is_empty() {
        return Ok(0);
    }
    let mut deleted = 0usize;
    let mut statement = connection
        .prepare("DELETE FROM session_index WHERE engine = ?1 AND session_id = ?2")
        .map_err(|error| error.to_string())?;
    for (engine, session_id) in pairs {
        let engine = engine.trim().to_ascii_lowercase();
        let qoder_session_id = (engine == "qoder")
            .then(|| {
                crate::engine::qoder_provider_profile::canonical_qoder_native_session_id(
                    session_id, None,
                )
            })
            .transpose()?;
        let session_id = qoder_session_id
            .as_deref()
            .unwrap_or_else(|| session_id.trim());
        if engine.is_empty() || session_id.is_empty() {
            continue;
        }
        deleted += statement
            .execute(params![engine, session_id])
            .map_err(|error| error.to_string())? as usize;
    }
    Ok(deleted)
}

fn strip_known_engine_prefix(id: &str) -> &str {
    const PREFIXES: [&str; 8] = [
        "codex:",
        "claude:",
        "kimi:",
        "grok:",
        "opencode:",
        "pi:",
        "gemini:",
        "dsh:",
    ];
    let lower = id.to_ascii_lowercase();
    for prefix in PREFIXES {
        if lower.starts_with(prefix) {
            return id[prefix.len()..].trim();
        }
    }
    id
}

fn looks_like_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().copied().enumerate() {
        if index == 8 || index == 13 || index == 18 || index == 23 {
            if byte != b'-' {
                return false;
            }
            continue;
        }
        if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn extract_codex_canonical_session_id(id: &str) -> Option<String> {
    let bare = strip_known_engine_prefix(id);
    if looks_like_uuid(bare) {
        return Some(bare.to_ascii_lowercase());
    }
    let Some(suffix) = bare.strip_prefix("rollout-") else {
        return None;
    };
    let Some((_, uuid)) = suffix.rsplit_once('-') else {
        return None;
    };
    if looks_like_uuid(uuid) {
        Some(uuid.to_ascii_lowercase())
    } else {
        None
    }
}

fn remember_codex_identity_keys(
    visible_id_by_identifier: &mut std::collections::HashMap<String, String>,
    visible_id: &str,
) {
    visible_id_by_identifier
        .entry(visible_id.to_string())
        .or_insert_with(|| visible_id.to_string());
    let bare = strip_known_engine_prefix(visible_id);
    if !bare.is_empty() {
        visible_id_by_identifier
            .entry(bare.to_string())
            .or_insert_with(|| visible_id.to_string());
    }
    if let Some(uuid) = extract_codex_canonical_session_id(visible_id) {
        visible_id_by_identifier
            .entry(uuid.clone())
            .or_insert_with(|| visible_id.to_string());
        visible_id_by_identifier
            .entry(format!("codex:{uuid}"))
            .or_insert_with(|| visible_id.to_string());
    }
}

fn resolve_visible_parent_id(
    parent_session_id: &str,
    visible_id_by_identifier: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if let Some(visible) = visible_id_by_identifier.get(parent_session_id) {
        return Some(visible.clone());
    }
    let bare = strip_known_engine_prefix(parent_session_id);
    if let Some(visible) = visible_id_by_identifier.get(bare) {
        return Some(visible.clone());
    }
    let uuid = extract_codex_canonical_session_id(parent_session_id)?;
    visible_id_by_identifier.get(&uuid).cloned().or_else(|| {
        visible_id_by_identifier
            .get(&format!("codex:{uuid}"))
            .cloned()
    })
}

fn retain_codex_parent_tree_within_limit(rows: &mut Vec<SessionIndexRow>, requested_limit: usize) {
    if rows.is_empty() || requested_limit == 0 {
        rows.clear();
        return;
    }

    let mut visible_id_by_identifier = std::collections::HashMap::<String, String>::new();
    for row in rows.iter() {
        remember_codex_identity_keys(&mut visible_id_by_identifier, &row.session_id);
    }

    let mut keep: Vec<String> = Vec::new();
    let mut keep_set = std::collections::HashSet::<String>::new();
    let mut kept_roots = 0usize;
    for row in rows.iter() {
        let parent_id = row
            .parent_session_id
            .as_deref()
            .and_then(|parent| resolve_visible_parent_id(parent, &visible_id_by_identifier))
            .filter(|parent| parent != &row.session_id);
        if parent_id.is_some() {
            continue;
        }
        if kept_roots >= requested_limit {
            continue;
        }
        if keep_set.insert(row.session_id.clone()) {
            keep.push(row.session_id.clone());
            kept_roots += 1;
        }
    }

    let mut grew = true;
    while grew {
        grew = false;
        for row in rows.iter() {
            if keep_set.contains(&row.session_id) {
                continue;
            }
            let Some(parent_id) = row
                .parent_session_id
                .as_deref()
                .and_then(|parent| resolve_visible_parent_id(parent, &visible_id_by_identifier))
            else {
                continue;
            };
            if keep_set.contains(&parent_id) && keep_set.insert(row.session_id.clone()) {
                keep.push(row.session_id.clone());
                grew = true;
            }
        }
    }

    let order: std::collections::HashMap<String, usize> = keep
        .iter()
        .enumerate()
        .map(|(index, id)| (id.clone(), index))
        .collect();
    rows.retain(|row| keep_set.contains(&row.session_id));
    rows.sort_by(|left, right| {
        order
            .get(&left.session_id)
            .cmp(&order.get(&right.session_id))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionIndexRow> {
    Ok(SessionIndexRow {
        engine: row.get(0)?,
        session_id: row.get(1)?,
        title: row.get(2)?,
        native_title: row.get(3)?,
        updated_at: row.get(4)?,
        created_at: row.get(5)?,
        cwd: row.get(6)?,
        workspace_path: row.get(7)?,
        physical_path: row.get(8)?,
        parent_session_id: row.get(9)?,
        size_bytes: row.get::<_, Option<i64>>(10)?.and_then(|value| {
            if value >= 0 {
                Some(value as u64)
            } else {
                None
            }
        }),
        provider_profile_id: row.get(11)?,
        provider_profile_name: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_row(engine: &str, session_id: &str, updated_at: i64) -> SessionIndexRow {
        SessionIndexRow {
            engine: engine.into(),
            session_id: session_id.into(),
            title: session_id.into(),
            native_title: None,
            updated_at,
            created_at: None,
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        }
    }

    #[test]
    fn provider_columns_roundtrip_and_survive_reupsert_without_provider() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let row = SessionIndexRow {
            engine: "codex".into(),
            session_id: "sp1".into(),
            title: "Hello".into(),
            native_title: None,
            updated_at: 200,
            created_at: Some(100),
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: Some("profile-a".into()),
            provider_profile_name: Some("Provider A".into()),
        };
        upsert_rows(&connection, &[row]).expect("upsert with provider");

        // 不知道 provider 的 writer 重 upsert（COALESCE）不得清掉已有值。
        let mut stripped = index_row("codex", "sp1", 300);
        stripped.title = "Hello v2".into();
        upsert_rows(&connection, &[stripped]).expect("re-upsert without provider");

        let rows = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Hello v2");
        assert_eq!(rows[0].provider_profile_id.as_deref(), Some("profile-a"));
        assert_eq!(rows[0].provider_profile_name.as_deref(), Some("Provider A"));
    }

    fn upsert_and_list_by_workspace() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        upsert_rows(
            &connection,
            &[SessionIndexRow {
                engine: "claude".into(),
                session_id: "s1".into(),
                title: "Hello".into(),
                native_title: None,
                updated_at: 200,
                created_at: Some(100),
                cwd: Some("/Users/me/proj".into()),
                workspace_path: Some("/Users/me/proj".into()),
                physical_path: Some("/tmp/s1.jsonl".into()),
                parent_session_id: None,
                size_bytes: Some(12),
                provider_profile_id: None,
                provider_profile_name: None,
            }],
        )
        .expect("upsert");
        let rows = list_for_workspace_path(&connection, "/Users/me/proj/", 10).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s1");
        assert_eq!(
            max_updated_at_for_engine(&connection, "claude", "/Users/me/proj/").expect("max"),
            Some(200)
        );
        assert_eq!(
            max_updated_at_for_engine(&connection, "grok", "/Users/me/proj/").expect("empty"),
            None
        );
    }

    #[test]
    fn backfill_state_roundtrips() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");

        let initial = load_backfill_state(&connection, "codex:/tmp/proj").expect("load");
        assert_eq!(initial, BackfillState::default());

        save_backfill_state(
            &connection,
            "codex:/tmp/proj",
            &BackfillState {
                cursor: "{\"day\":\"2026/07/01\",\"plainDone\":true}".into(),
                complete: false,
            },
        )
        .expect("save");
        let loaded = load_backfill_state(&connection, "codex:/tmp/proj").expect("reload");
        assert!(!loaded.complete);
        assert!(loaded.cursor.contains("2026/07/01"));

        save_backfill_state(
            &connection,
            "codex:/tmp/proj",
            &BackfillState {
                cursor: loaded.cursor.clone(),
                complete: true,
            },
        )
        .expect("save complete");
        assert!(
            load_backfill_state(&connection, "codex:/tmp/proj")
                .expect("reload")
                .complete
        );
    }

    #[test]
    fn upsert_keeps_existing_created_at_when_refresh_sends_newer() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let first = SessionIndexRow {
            engine: "dsh".into(),
            session_id: "dsh-clock".into(),
            title: "dsh session".into(),
            native_title: None,
            updated_at: 1_000,
            created_at: Some(1_000),
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[first]).expect("insert");
        let refresh = SessionIndexRow {
            engine: "dsh".into(),
            session_id: "dsh-clock".into(),
            title: "dsh session".into(),
            native_title: None,
            updated_at: 20 * 60 * 1000,
            created_at: Some(20 * 60 * 1000),
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[refresh]).expect("refresh");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].created_at, Some(1_000));
        assert_eq!(listed[0].updated_at, 20 * 60 * 1000);
    }

    #[test]
    fn upsert_backfills_missing_created_at_from_first_updated_at() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let first = SessionIndexRow {
            engine: "claude".into(),
            session_id: "claude-clock".into(),
            title: "claude session".into(),
            native_title: None,
            updated_at: 1_000,
            created_at: None,
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[first]).expect("insert");
        let refresh = SessionIndexRow {
            engine: "claude".into(),
            session_id: "claude-clock".into(),
            title: "claude session".into(),
            native_title: None,
            updated_at: 9_000,
            created_at: None,
            cwd: Some("/tmp/proj".into()),
            workspace_path: Some("/tmp/proj".into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        };
        upsert_rows(&connection, &[refresh]).expect("refresh");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].created_at, Some(1_000));
        assert_eq!(listed[0].updated_at, 9_000);
    }

    #[test]
    fn tombstone_accepts_pi_prefixed_and_bare_session_ids() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        upsert_rows(
            &connection,
            &[SessionIndexRow {
                engine: "pi".into(),
                session_id: "ses_pi_1".into(),
                title: "PI Session".into(),
                native_title: None,
                updated_at: 200,
                created_at: Some(100),
                cwd: Some("/tmp/codex".into()),
                workspace_path: Some("/tmp/codex".into()),
                physical_path: None,
                parent_session_id: None,
                size_bytes: Some(32),
                provider_profile_id: None,
                provider_profile_name: None,
            }],
        )
        .expect("upsert");

        let updated =
            tombstone_session_ids(&connection, &["pi:ses_pi_1".into()]).expect("tombstone");
        assert_eq!(updated, 1);
        let listed = list_for_workspace_path(&connection, "/tmp/codex", 10).expect("list");
        assert!(
            listed.is_empty(),
            "tombstoned PI rows must leave the sidebar page"
        );
    }

    #[test]
    fn qoder_same_raw_id_keeps_global_and_cn_rows_isolated() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let mut global = index_row("qoder", "same-qoder-session", 200);
        global.provider_profile_id = Some("__qoder_global__".into());
        global.provider_profile_name = Some("Qoder Global".into());
        let mut cn = index_row("qoder", "same-qoder-session", 201);
        cn.provider_profile_id = Some("__qoder_cn__".into());
        cn.provider_profile_name = Some("Qoder CN".into());

        upsert_rows(&connection, &[global, cn]).expect("upsert both distributions");
        let rows = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| {
            row.session_id == "qoder:__qoder_global__:same-qoder-session"
                && row.provider_profile_id.as_deref() == Some("__qoder_global__")
        }));
        assert!(rows.iter().any(|row| {
            row.session_id == "qoder:__qoder_cn__:same-qoder-session"
                && row.provider_profile_id.as_deref() == Some("__qoder_cn__")
        }));

        let updated = tombstone_session_ids(
            &connection,
            &["qoder:__qoder_global__:same-qoder-session".into()],
        )
        .expect("tombstone Global only");
        assert_eq!(updated, 1);
        let remaining = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].session_id,
            "qoder:__qoder_cn__:same-qoder-session"
        );
    }

    #[test]
    fn qoder_legacy_row_migrates_using_its_durable_cn_owner() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        connection
            .execute(
                "INSERT INTO session_index (
                    engine, session_id, title, updated_at, indexed_at, provider_profile_id
                 ) VALUES ('qoder', 'legacy-qoder-session', 'Legacy', 1, 1, '__qoder_cn__')",
                [],
            )
            .expect("seed legacy CN row");

        migrate_legacy_qoder_session_identities(&connection).expect("migrate legacy row");
        let session_id: String = connection
            .query_row(
                "SELECT session_id FROM session_index WHERE engine = 'qoder'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated row");
        assert_eq!(session_id, "qoder:__qoder_cn__:legacy-qoder-session");
        let provider_profile_id: String = connection
            .query_row(
                "SELECT provider_profile_id FROM session_index WHERE engine = 'qoder'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated profile");
        assert_eq!(provider_profile_id, "__qoder_cn__");
    }

    #[test]
    fn qoder_upsert_makes_legacy_global_owner_explicit() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let row = index_row("qoder", "legacy-global-session", 1);

        upsert_rows(&connection, &[row]).expect("upsert legacy Global row");
        let (session_id, provider_profile_id): (String, String) = connection
            .query_row(
                "SELECT session_id, provider_profile_id FROM session_index WHERE engine = 'qoder'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read canonical Qoder row");
        assert_eq!(session_id, "qoder:__qoder_global__:legacy-global-session");
        assert_eq!(provider_profile_id, "__qoder_global__");
    }

    #[test]
    fn tombstone_unknown_id_blocks_later_rescan_resurrection() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        // 行尚不存在（会话只经磁盘列表进过侧栏）：tombstone 也要留下持久标记
        let updated =
            tombstone_session_ids(&connection, &["pi:ses_ghost".into()]).expect("tombstone");
        assert_eq!(updated, 0);
        // 重启后 rescan 重新 upsert 同一个 (engine, session_id)
        upsert_rows(&connection, &[index_row("pi", "ses_ghost", 300)]).expect("upsert");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert!(
            listed.is_empty(),
            "tombstone marker must block rescan resurrection"
        );
    }

    #[test]
    fn tombstone_bare_id_marks_all_known_engines() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        // 裸 id（codex 等不带 engine 前缀的 threadId）
        tombstone_session_ids(&connection, &["ses_bare".into()]).expect("tombstone");
        upsert_rows(&connection, &[index_row("codex", "ses_bare", 300)]).expect("upsert");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 10).expect("list");
        assert!(
            listed.is_empty(),
            "bare-id tombstone markers must cover every known engine"
        );
    }

    #[test]
    fn list_keeps_codex_parent_when_philosopher_pups_are_newer() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let parent_id = "01a01b3c-db39-7362-9505-3e3535f4b878";
        let mut rows = vec![index_row("codex", parent_id, 100)];
        for (index, name) in [
            "Socrates",
            "Beauvoir",
            "Faraday",
            "Heisenberg",
            "Bohr",
            "Anscombe",
            "Volta",
            "Cicero",
        ]
        .into_iter()
        .enumerate()
        {
            let mut child = index_row("codex", &format!("pup-{index}-{name}"), 400 + index as i64);
            child.title = name.into();
            child.parent_session_id = Some(parent_id.into());
            rows.push(child);
        }
        rows.push(index_row("claude", "claude-recent", 500));
        upsert_rows(&connection, &rows).expect("upsert");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 2).expect("list");
        assert!(
            listed.iter().any(|row| row.session_id == parent_id),
            "parent must survive newer Codex philosopher pups"
        );
        assert!(listed.iter().any(|row| row.session_id == "claude-recent"));
        assert!(
            listed
                .iter()
                .any(|row| row.parent_session_id.as_deref() == Some(parent_id)),
            "visible pups stay nested under the retained parent"
        );
    }

    #[test]
    fn list_hydrates_older_codex_parent_outside_mtime_window() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let parent_id = "01a01b3c-db39-7362-9505-3e3535f4b878";
        let mut rows = vec![index_row("codex", parent_id, 1)];
        for index in 0..20 {
            let mut child = index_row("codex", &format!("pup-{index}"), 1000 + index);
            child.parent_session_id = Some(parent_id.into());
            rows.push(child);
        }
        upsert_rows(&connection, &rows).expect("upsert");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 2).expect("list");
        assert!(
            listed.iter().any(|row| row.session_id == parent_id),
            "parent outside the mtime window must still be hydrated"
        );
        assert!(listed
            .iter()
            .any(|row| row.parent_session_id.as_deref() == Some(parent_id)));
    }

    #[test]
    fn list_keeps_per_engine_budget_so_pi_is_not_starved() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        let mut rows = Vec::new();
        for index in 0..8 {
            rows.push(index_row(
                "claude",
                &format!("claude-{index}"),
                1000 + index,
            ));
        }
        rows.push(index_row("pi", "pi-old", 1));
        upsert_rows(&connection, &rows).expect("upsert");
        let listed = list_for_workspace_path(&connection, "/tmp/proj", 2).expect("list");
        let claude = listed.iter().filter(|row| row.engine == "claude").count();
        let pi = listed.iter().filter(|row| row.engine == "pi").count();
        assert_eq!(claude, 2);
        assert_eq!(pi, 1);
        assert!(listed.iter().any(|row| row.session_id == "pi-old"));
    }

    #[test]
    fn workspace_index_sources_invalidated_after_send_marks_stale() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        upsert_rows(&connection, &[index_row("claude", "claude-1", 100)]).expect("upsert");
        mark_source_synced(&connection, "pi:/tmp/proj", "fp-a", 1).expect("mark");
        assert!(!workspace_index_sources_invalidated(&connection, "/tmp/proj").expect("fresh"));
        connection
            .execute(
                "UPDATE session_index_sources SET last_sync_ms = 0 WHERE source_key = ?1",
                ["pi:/tmp/proj"],
            )
            .expect("invalidate");
        assert!(
            workspace_index_sources_invalidated(&connection, "/tmp/proj")
                .expect("stale after PI send")
        );
    }

    #[test]
    fn normalize_path_key_folds_windows_drive_and_extended_prefix() {
        assert_eq!(normalize_path_key(r"C:\Users\me\proj"), "c:/users/me/proj");
        assert_eq!(normalize_path_key(r"c:\Users\me\proj\"), "c:/users/me/proj");
        assert_eq!(
            normalize_path_key(r"\\?\C:\Users\me\proj"),
            "c:/users/me/proj"
        );
        assert_eq!(
            normalize_path_key(r"\\?\UNC\server\share\proj"),
            "//server/share/proj"
        );
        assert_eq!(normalize_path_key("C:/"), "c:/");
        assert!(paths_equivalent(
            r"C:\Users\me\proj",
            r"\\?\c:\Users\me\proj\"
        ));
        assert!(paths_equivalent(
            r"\\server\share\proj",
            r"\\?\UNC\SERVER\share\proj\"
        ));
        assert!(!paths_equivalent("/tmp/proj", "/tmp/other"));
    }

    fn index_row_at(
        engine: &str,
        session_id: &str,
        updated_at: i64,
        workspace_path: &str,
    ) -> SessionIndexRow {
        SessionIndexRow {
            engine: engine.into(),
            session_id: session_id.into(),
            title: session_id.into(),
            native_title: None,
            updated_at,
            created_at: None,
            cwd: Some(workspace_path.into()),
            workspace_path: Some(workspace_path.into()),
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        }
    }

    #[test]
    fn list_always_merges_equivalent_keys_when_claude_page_is_nonempty() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        upsert_rows(
            &connection,
            &[
                index_row_at("claude", "claude-b", 200, "C:/Users/me/proj"),
                index_row_at("grok", "grok-a", 150, r"c:\Users\me\proj"),
                index_row_at("pi", "pi-a", 140, r"\\?\C:\Users\me\proj"),
                index_row_at("dsh", "dsh-a", 130, "C:/Users/me/proj"),
            ],
        )
        .expect("upsert");
        let listed = list_for_workspace_path(&connection, r"C:\Users\me\proj", 10).expect("list");
        let engines: Vec<_> = listed.iter().map(|row| row.engine.as_str()).collect();
        assert!(engines.contains(&"claude"), "{engines:?}");
        assert!(engines.contains(&"grok"), "{engines:?}");
        assert!(engines.contains(&"pi"), "{engines:?}");
        assert!(engines.contains(&"dsh"), "{engines:?}");
        assert_eq!(
            count_for_workspace_path(&connection, r"C:\Users\me\proj").expect("count"),
            4
        );
    }

    #[test]
    fn keyset_list_includes_equivalent_grok_and_dsh() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(DDL).expect("ddl");
        upsert_rows(
            &connection,
            &[
                index_row_at("claude", "claude-new", 300, "C:/Users/me/proj"),
                index_row_at("grok", "grok-old", 100, r"c:\Users\me\proj"),
                index_row_at("dsh", "dsh-old", 90, r"\\?\C:\Users\me\proj"),
            ],
        )
        .expect("upsert");
        let page = list_for_workspace_path_before(
            &connection,
            r"C:\Users\me\proj",
            10,
            Some((300, "claude-new".into())),
        )
        .expect("keyset");
        assert!(page.iter().any(|row| row.session_id == "grok-old"));
        assert!(page.iter().any(|row| row.session_id == "dsh-old"));
    }

    #[test]
    fn engine_table_sentinel_keeps_sync_backfill_list_and_timeout_aligned() {
        let store = include_str!("store.rs");
        let writers = include_str!("writers.rs");
        let commands = include_str!("commands.rs");
        let required = [
            "claude", "codex", "gemini", "grok", "kimi", "opencode", "pi", "dsh", "qoder",
        ];
        let engine_table = store
            .split("const INDEX_LIST_ENGINES")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("INDEX_LIST_ENGINES table missing");
        for engine in required {
            assert!(
                engine_table.contains(&format!("\"{engine}\"")),
                "INDEX_LIST_ENGINES missing {engine}"
            );
        }
        for writer in [
            "sync_claude_for_workspace",
            "sync_codex_for_workspace",
            "sync_kimi_for_workspace",
            "rows_from_gemini_summaries",
            "rows_from_grok_summaries",
            "rows_from_pi_summaries",
            "rows_from_dsh_summaries",
            "rows_from_opencode_entries",
        ] {
            assert!(writers.contains(writer), "writers.rs missing {writer}");
        }
        for command in [
            "sync_claude_for_workspace",
            "sync_codex_for_workspace",
            "sync_kimi_for_workspace",
            "sync_opencode_engine",
            "list_gemini_sessions",
            "list_grok_sessions",
            "list_pi_sessions",
            "list_dsh_sessions",
        ] {
            assert!(commands.contains(command), "commands.rs missing {command}");
        }
        assert!(
            commands.contains("SKIP_BACKFILL: opencode"),
            "OpenCode must declare SKIP_BACKFILL"
        );
        assert!(
            commands.contains("const ASYNC_ENGINE_LIST_TIMEOUT"),
            "async timeout contract missing"
        );
        assert!(
            commands.contains("Duration::from_secs(3)"),
            "async engine list timeout must stay 3s"
        );
    }
}
