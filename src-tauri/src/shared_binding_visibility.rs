//! Shared binding identity 的只读恢复。
//!
//! Session Index 与 daemon/catalog projection 共用同一份 durable V2 binding
//! facts。本模块刻意不依赖 `SharedEventWriter`，且绝不写入 event log。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;

const VISIBILITY_BUSY_TIMEOUT: Duration = Duration::from_millis(200);
const BINDING_EVENT_SCAN_LIMIT: i64 = 80;

pub(crate) fn insert_shared_binding_identity(target: &mut BTreeSet<String>, value: &str) {
    insert_shared_binding_identity_with_context(target, None, None, value);
}

pub(crate) fn insert_shared_binding_identity_with_context(
    target: &mut BTreeSet<String>,
    engine: Option<&str>,
    provider_profile_id: Option<&str>,
    value: &str,
) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    let is_qoder = engine.is_some_and(|engine| engine.trim().eq_ignore_ascii_case("qoder"))
        || trimmed.starts_with(crate::engine::qoder_provider_profile::QODER_NATIVE_SESSION_PREFIX);
    if is_qoder {
        match crate::engine::qoder_provider_profile::parse_qoder_native_session_identity(
            trimmed,
            provider_profile_id,
        ) {
            Ok(identity) => {
                target.insert(identity.canonical_id());
                // 只有缺失 explicit owner 的历史 Global raw Binding 才保留 alias。
                // 已携带 Global/CN owner 的 raw 值会在读取时升级为 canonical，绝不能
                // 再投影到 bare raw，否则 Global/CN 会互相隐藏。
                let preserves_legacy_global_aliases = identity.is_legacy
                    && matches!(
                        provider_profile_id.map(str::trim),
                        None
                            | Some(
                                crate::engine::qoder_provider_profile::QODER_LOCAL_PROVIDER_PROFILE_ID
                            )
                    );
                if preserves_legacy_global_aliases {
                    target.insert(format!(
                        "{}{}",
                        crate::engine::qoder_provider_profile::QODER_NATIVE_SESSION_PREFIX,
                        identity.raw_session_id
                    ));
                    target.insert(identity.raw_session_id);
                }
            }
            Err(error) => {
                log::warn!(
                    "[shared_binding_visibility] ignored malformed Qoder identity `{trimmed}`: {error}"
                );
                // 保留 exact malformed value，避免把未知数据扩散成跨 distribution alias。
                target.insert(trimmed.to_string());
            }
        }
        return;
    }
    target.insert(trimmed.to_string());
    if let Some((_, bare)) = trimmed.split_once(':') {
        let bare = bare.trim();
        if !bare.is_empty() {
            target.insert(bare.to_string());
        }
    }
}

fn collect_ids_from_json_value(
    value: &Value,
    target: &mut BTreeSet<String>,
    inherited_engine: Option<&str>,
    inherited_provider_profile_id: Option<&str>,
) {
    const KEYS: &[&str] = &[
        "archivedNativeSessionId",
        "archived_native_session_id",
        "nativeSessionId",
        "native_session_id",
    ];
    if let Some(object) = value.as_object() {
        let engine = object
            .get("engine")
            .and_then(Value::as_str)
            .or(inherited_engine);
        let provider_profile_id = object
            .get("providerProfileId")
            .or_else(|| object.get("provider_profile_id"))
            .and_then(Value::as_str)
            .or(inherited_provider_profile_id);
        for key in KEYS {
            if let Some(raw) = object.get(*key).and_then(Value::as_str) {
                insert_shared_binding_identity_with_context(
                    target,
                    engine,
                    provider_profile_id,
                    raw,
                );
            }
        }
        if let Some(nested) = object.get("provisioning") {
            collect_ids_from_json_value(nested, target, engine, provider_profile_id);
        }
    }
}

fn collect_ids_from_json_text(
    raw: &str,
    target: &mut BTreeSet<String>,
    engine: Option<&str>,
    provider_profile_id: Option<&str>,
) {
    if raw.trim().is_empty() {
        return;
    }
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        collect_ids_from_json_value(&value, target, engine, provider_profile_id);
    }
}

/// 不打开 writer，从 V2 读取每个 Shared session 当前与历史的 native binding identity。
/// 返回值保留 Shared session owner，catalog remapping 不得跨会话归属。
pub(crate) fn collect_v2_shared_binding_ids_by_session(
    event_log_path: &Path,
    session_ids: &[String],
) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    if session_ids.is_empty() || !event_log_path.exists() {
        return Ok(BTreeMap::new());
    }
    let connection = Connection::open_with_flags(event_log_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open-readonly:{error}"))?;
    connection
        .busy_timeout(VISIBILITY_BUSY_TIMEOUT)
        .map_err(|error| format!("busy-timeout:{error}"))?;

    let mut ids_by_session = BTreeMap::new();
    let mut state_statement = connection
        .prepare(
            "SELECT engine, provider_profile_id, native_session_id, provisioning_json
             FROM shared_binding_state
             WHERE session_id = ?1",
        )
        .map_err(|error| format!("prepare-binding-state:{error}"))?;
    let mut event_statement = connection
        .prepare(
            "SELECT payload_json
             FROM shared_event_log
             WHERE session_id = ?1 AND fact_type LIKE 'binding.%'
             ORDER BY sequence DESC
             LIMIT ?2",
        )
        .map_err(|error| format!("prepare-binding-events:{error}"))?;

    for session_id in session_ids {
        let mut binding_ids = BTreeSet::new();
        let state_rows = state_statement
            .query_map(params![session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|error| format!("query-binding-state:{error}"))?;
        for row in state_rows {
            let (engine, provider_profile_id, native_session_id, provisioning_json) =
                row.map_err(|error| format!("map-binding-state:{error}"))?;
            if let Some(native_session_id) = native_session_id {
                insert_shared_binding_identity_with_context(
                    &mut binding_ids,
                    Some(engine.as_str()),
                    provider_profile_id.as_deref(),
                    &native_session_id,
                );
            }
            if let Some(provisioning_json) = provisioning_json {
                collect_ids_from_json_text(
                    &provisioning_json,
                    &mut binding_ids,
                    Some(engine.as_str()),
                    provider_profile_id.as_deref(),
                );
            }
        }

        let event_rows = event_statement
            .query_map(params![session_id, BINDING_EVENT_SCAN_LIMIT], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("query-binding-events:{error}"))?;
        for row in event_rows {
            let payload = row.map_err(|error| format!("map-binding-event:{error}"))?;
            collect_ids_from_json_text(&payload, &mut binding_ids, None, None);
        }

        if !binding_ids.is_empty() {
            ids_by_session
                .entry(session_id.clone())
                .or_insert_with(BTreeSet::new)
                .extend(binding_ids);
        }
    }

    Ok(ids_by_session)
}

/// 仅需 workspace 级 hide set 的 visibility surface 使用的 union 形式。
/// daemon 使用上方保留 owner 的形式。
#[allow(dead_code)]
pub(crate) fn collect_v2_shared_binding_ids(
    event_log_path: &Path,
    session_ids: &[String],
) -> Result<BTreeSet<String>, String> {
    Ok(
        collect_v2_shared_binding_ids_by_session(event_log_path, session_ids)?
            .into_values()
            .flatten()
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_json_collects_archived_id() {
        let mut hidden = BTreeSet::new();
        collect_ids_from_json_text(
            r#"{"state":"prepared","archivedNativeSessionId":"qoder:old-1"}"#,
            &mut hidden,
            None,
            None,
        );
        assert!(hidden.contains("qoder:__qoder_global__:old-1"));
        assert!(hidden.contains("qoder:old-1"));
        assert!(hidden.contains("old-1"));
    }

    #[test]
    fn readonly_v2_query_keeps_qoder_global_and_cn_ids_with_their_owner() {
        let dir = std::env::temp_dir().join(format!(
            "mossx-shared-binding-visibility-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let db_path = dir.join("shared-event-log-v2.sqlite3");
        {
            let connection = Connection::open(&db_path).expect("open");
            connection
                .execute_batch(
                    "CREATE TABLE shared_binding_state (
                        session_id TEXT NOT NULL,
                        binding_key TEXT NOT NULL,
                        engine TEXT NOT NULL,
                        provider_profile_id TEXT,
                        native_session_id TEXT,
                        accepted_through_sequence INTEGER,
                        committed_through_sequence INTEGER,
                        provisioning_json TEXT,
                        pending_delivery_json TEXT,
                        availability TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        PRIMARY KEY (session_id, binding_key)
                     );
                     CREATE TABLE shared_event_log (
                        session_id TEXT NOT NULL,
                        sequence INTEGER NOT NULL,
                        event_id TEXT NOT NULL,
                        fact_type TEXT NOT NULL,
                        logical_turn_id TEXT,
                        attempt_id TEXT,
                        dedupe_key TEXT,
                        payload_json TEXT NOT NULL,
                        payload_checksum TEXT NOT NULL,
                        fidelity TEXT NOT NULL,
                        committed_at INTEGER NOT NULL,
                        PRIMARY KEY (session_id, event_id)
                     );",
                )
                .expect("ddl");
            connection
                .execute(
                    "INSERT INTO shared_binding_state (
                        session_id, binding_key, engine, provider_profile_id, native_session_id,
                        provisioning_json, availability, updated_at
                    ) VALUES (?1, 'qoder:__qoder_global__', 'qoder', '__qoder_global__', ?2, ?3, 'ready', 1)",
                    params![
                        "shared-qoder",
                        "same-qoder-session",
                        r#"{"archivedNativeSessionId":"same-qoder-session"}"#
                    ],
                )
                .expect("insert Qoder Global binding");
            connection
                .execute(
                    "INSERT INTO shared_binding_state (
                        session_id, binding_key, engine, provider_profile_id, native_session_id,
                        provisioning_json, availability, updated_at
                    ) VALUES (?1, 'qoder:__qoder_cn__', 'qoder', '__qoder_cn__', ?2, ?3, 'ready', 1)",
                    params![
                        "shared-qoder",
                        "same-qoder-session",
                        r#"{"archivedNativeSessionId":"same-qoder-session"}"#
                    ],
                )
                .expect("insert Qoder CN binding");
            connection
                .execute(
                    "INSERT INTO shared_binding_state (
                        session_id, binding_key, engine, native_session_id,
                        provisioning_json, availability, updated_at
                     ) VALUES (?1, 'pi:default', 'pi', ?2, NULL, 'ready', 1)",
                    params!["shared-pi", "pi:native-pi"],
                )
                .expect("insert pi binding");
            connection
                .execute(
                    "INSERT INTO shared_event_log (
                        session_id, sequence, event_id, fact_type, payload_json,
                        payload_checksum, fidelity, committed_at
                     ) VALUES ('shared-qoder', 1, 'e1', 'binding.rebuilt',
                        '{\"engine\":\"qoder\",\"providerProfileId\":\"__qoder_global__\",\"nativeSessionId\":\"same-qoder-session\"}', 'x', 'full', 1)",
                    [],
                )
                .expect("insert qoder event");
        }

        let ids_by_session = collect_v2_shared_binding_ids_by_session(
            &db_path,
            &["shared-qoder".into(), "shared-pi".into()],
        )
        .expect("query");
        let qoder_ids = ids_by_session.get("shared-qoder").expect("qoder owner ids");
        assert!(qoder_ids.contains("qoder:__qoder_global__:same-qoder-session"));
        assert!(qoder_ids.contains("qoder:__qoder_cn__:same-qoder-session"));
        assert!(!qoder_ids.contains("qoder:same-qoder-session"));
        assert!(!qoder_ids.contains("same-qoder-session"));
        assert!(!qoder_ids.contains("pi:native-pi"));
        assert!(ids_by_session
            .get("shared-pi")
            .expect("pi owner ids")
            .contains("pi:native-pi"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now_nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    }
}
