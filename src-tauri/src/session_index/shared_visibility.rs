//! Read-only Shared native-ownership projection for Session Index first-paint.
//!
//! This path MUST NOT send commands through `SharedEventWriter`. It reads V0
//! Shared metadata from the filesystem and delegates V2 identity recovery to
//! the shared short-timeout read-only helper.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::store::SessionIndexRow;
use crate::shared_binding_visibility::{collect_v2_shared_binding_ids, insert_shared_binding_identity};
use crate::shared_sessions::load_workspace_shared_ownership_seed;

const MOSSX_CONTROL_PLANE_PREFIXES: &[&str] = &[
    "MOSSX_CONTEXT_PACKAGE",
    "MOSSX_CONTEXT_ACCEPTED",
    "MOSSX_NATIVE_CONTEXT_V1",
    "MOSSX_SHARED_CONTEXT_V1",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedNativeVisibilityProjection {
    pub available: bool,
    pub freshness: String,
    pub hidden_native_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub protocol_hidden_native_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SharedNativeVisibilityProjection {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            freshness: "unavailable".into(),
            hidden_native_ids: Vec::new(),
            protocol_hidden_native_ids: Vec::new(),
            reason: Some(reason.into()),
        }
    }
}

pub(crate) fn is_exact_mossx_control_plane_title(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    MOSSX_CONTROL_PLANE_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

pub(crate) fn extract_claude_parent_session_id(session_id: &str) -> Option<String> {
    let rest = session_id.trim().strip_prefix("subagent:")?;
    let parent = rest.split(':').next().unwrap_or("").trim();
    if parent.is_empty() {
        None
    } else {
        Some(parent.to_string())
    }
}

fn protocol_hidden_ids_from_index_rows(rows: &[SessionIndexRow]) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for row in rows {
        let title_hit = is_exact_mossx_control_plane_title(&row.title)
            || row
                .native_title
                .as_deref()
                .is_some_and(is_exact_mossx_control_plane_title);
        if title_hit {
            insert_shared_binding_identity(&mut ids, &row.session_id);
        }
    }
    ids.into_iter().collect()
}

#[derive(Debug)]
enum VisibilityV2Read {
    NotRequired,
    StoreMissing,
    Ready(BTreeSet<String>),
    Failed(String),
}

fn finalize_visibility_projection(
    skipped_meta: usize,
    _session_ids: &[String],
    v0_native_ids: &[String],
    v2_read: VisibilityV2Read,
    protocol_hidden_native_ids: Vec<String>,
) -> SharedNativeVisibilityProjection {
    let mut hidden = BTreeSet::new();
    for native_id in v0_native_ids {
        insert_shared_binding_identity(&mut hidden, native_id);
    }

    if skipped_meta > 0 {
        return SharedNativeVisibilityProjection {
            available: false,
            freshness: "unavailable".into(),
            hidden_native_ids: hidden.into_iter().collect(),
            protocol_hidden_native_ids,
            reason: Some(format!("legacy-meta-skipped:{skipped_meta}")),
        };
    }

    match v2_read {
        VisibilityV2Read::NotRequired | VisibilityV2Read::StoreMissing => {}
        VisibilityV2Read::Ready(v2_ids) => hidden.extend(v2_ids),
        VisibilityV2Read::Failed(error) => {
            return SharedNativeVisibilityProjection {
                available: false,
                freshness: "unavailable".into(),
                hidden_native_ids: hidden.into_iter().collect(),
                protocol_hidden_native_ids,
                reason: Some(format!("v2-readonly:{error}")),
            };
        }
    }

    SharedNativeVisibilityProjection {
        available: true,
        freshness: "verified".into(),
        hidden_native_ids: hidden.into_iter().collect(),
        protocol_hidden_native_ids,
        reason: None,
    }
}

pub(crate) fn load_shared_native_visibility_projection(
    workspace_id: &str,
    event_log_path: Option<&Path>,
    index_rows: &[SessionIndexRow],
) -> SharedNativeVisibilityProjection {
    let protocol_hidden_native_ids = protocol_hidden_ids_from_index_rows(index_rows);
    let seed = match load_workspace_shared_ownership_seed(workspace_id) {
        Ok(seed) => seed,
        Err(error) => {
            return SharedNativeVisibilityProjection {
                protocol_hidden_native_ids,
                ..SharedNativeVisibilityProjection::unavailable(format!("legacy-meta:{error}"))
            };
        }
    };

    let v2_read = if seed.session_ids.is_empty() {
        VisibilityV2Read::NotRequired
    } else {
        match event_log_path {
            None => VisibilityV2Read::Failed("v2-path-missing".into()),
            Some(path) if !path.exists() => VisibilityV2Read::StoreMissing,
            Some(path) => match collect_v2_shared_binding_ids(path, &seed.session_ids) {
                Ok(ids) => VisibilityV2Read::Ready(ids),
                Err(error) => VisibilityV2Read::Failed(error),
            },
        }
    };

    finalize_visibility_projection(
        seed.skipped_meta,
        &seed.session_ids,
        &seed.native_ids,
        v2_read,
        protocol_hidden_native_ids,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(session_id: &str, title: &str, native_title: Option<&str>) -> SessionIndexRow {
        SessionIndexRow {
            engine: "claude".into(),
            session_id: session_id.into(),
            title: title.into(),
            native_title: native_title.map(str::to_string),
            updated_at: 1,
            created_at: None,
            cwd: None,
            workspace_path: None,
            physical_path: None,
            parent_session_id: None,
            size_bytes: None,
            provider_profile_id: None,
            provider_profile_name: None,
        }
    }

    #[test]
    fn protocol_classifier_is_exact() {
        assert!(is_exact_mossx_control_plane_title(
            "MOSSX_CONTEXT_PACKAGE:sha256:abc"
        ));
        assert!(is_exact_mossx_control_plane_title(
            "MOSSX_NATIVE_CONTEXT_V1\nsource:x"
        ));
        assert!(!is_exact_mossx_control_plane_title("Claude Session"));
        assert!(!is_exact_mossx_control_plane_title("Agent 3"));
        assert!(!is_exact_mossx_control_plane_title(
            "please explain MOSSX_CONTEXT_PACKAGE"
        ));
    }

    #[test]
    fn extracts_claude_subagent_parent() {
        assert_eq!(
            extract_claude_parent_session_id("subagent:parent-1:worker-9").as_deref(),
            Some("parent-1")
        );
        assert_eq!(extract_claude_parent_session_id("plain-session"), None);
    }

    #[test]
    fn protocol_hidden_ids_use_raw_index_fields() {
        let rows = vec![
            sample_row(
                "owned-1",
                "MOSSX_CONTEXT_PACKAGE:dead:beef",
                Some("Claude Session"),
            ),
            sample_row("user-1", "Claude Session", None),
        ];
        let hidden = protocol_hidden_ids_from_index_rows(&rows);
        assert!(hidden.iter().any(|id| id == "owned-1"));
        assert!(!hidden.iter().any(|id| id == "user-1"));
    }

    #[test]
    fn protocol_hidden_ids_keep_claude_file_uuid_when_title_is_mossx() {
        let rows = vec![
            sample_row(
                "1807f883-011c-46bd-94d5-ff483ffb1a4a",
                "MOSSX_CONTEXT_PACKAGE:sha256:dead…",
                None,
            ),
            sample_row("visible-native", "继续", None),
        ];
        let hidden = protocol_hidden_ids_from_index_rows(&rows);
        assert!(hidden
            .iter()
            .any(|id| id == "1807f883-011c-46bd-94d5-ff483ffb1a4a"));
        assert!(!hidden.iter().any(|id| id == "visible-native"));
    }

    #[test]
    fn missing_shared_workspace_is_available_with_empty_hide() {
        let projection =
            load_shared_native_visibility_projection("ws-does-not-exist-for-visibility", None, &[]);
        assert!(projection.available);
        assert_eq!(projection.freshness, "verified");
        assert!(projection.hidden_native_ids.is_empty());
    }

    #[test]
    fn skipped_meta_is_unavailable() {
        let projection = finalize_visibility_projection(
            1,
            &["shared-1".into()],
            &["native-v0".into()],
            VisibilityV2Read::Ready(BTreeSet::new()),
            Vec::new(),
        );
        assert!(!projection.available);
        assert_eq!(projection.freshness, "unavailable");
        assert!(projection
            .hidden_native_ids
            .iter()
            .any(|id| id == "native-v0"));
    }

    #[test]
    fn v2_read_failure_with_shared_sessions_is_unavailable() {
        let projection = finalize_visibility_projection(
            0,
            &["shared-1".into()],
            &["native-v0".into()],
            VisibilityV2Read::Failed("busy".into()),
            Vec::new(),
        );
        assert!(!projection.available);
        assert_eq!(projection.freshness, "unavailable");
        assert!(projection
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("v2-readonly"));
        assert!(projection
            .hidden_native_ids
            .iter()
            .any(|id| id == "native-v0"));
    }

    #[test]
    fn missing_v2_store_with_v0_sessions_is_verified() {
        let projection = finalize_visibility_projection(
            0,
            &["shared-1".into()],
            &["native-v0".into()],
            VisibilityV2Read::StoreMissing,
            Vec::new(),
        );
        assert!(projection.available);
        assert_eq!(projection.freshness, "verified");
        assert!(projection
            .hidden_native_ids
            .iter()
            .any(|id| id == "native-v0"));
    }
}
