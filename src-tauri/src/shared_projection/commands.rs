use std::collections::HashMap;

use tauri::State;

use crate::engine::EngineType;
use crate::shared_sessions::{
    ensure_supported_shared_session_engine, shared_session_projection_source,
};
use crate::state::AppState;

use super::{
    LegacySharedReader, MismatchReport, ProjectionItem, ShadowComparator, SharedProjector,
    CANVAS_PROJECTION_NAME, CANVAS_PROJECTION_VERSION,
};

async fn projection_context(
    workspace_id: &str,
    thread_id: &str,
    state: &State<'_, AppState>,
) -> Result<
    (
        crate::shared_event_log::SharedEventWriter,
        String,
        std::path::PathBuf,
    ),
    String,
> {
    if !state.workspaces.lock().await.contains_key(workspace_id) {
        return Err(format!("Unknown workspace: {workspace_id}"));
    }
    let (session_id, legacy_log_path) = shared_session_projection_source(workspace_id, thread_id)?;
    let writer = state
        .shared_event_writer
        .as_ref()
        .cloned()
        .ok_or_else(|| "Shared projection store is unavailable".to_string())?;
    Ok((writer, session_id, legacy_log_path))
}

fn projection_engine(snapshot: &serde_json::Map<String, serde_json::Value>) -> Option<EngineType> {
    let engine = serde_json::from_value::<EngineType>(
        snapshot.get("engine")?.as_str()?.trim().to_string().into(),
    )
    .ok()?;
    ensure_supported_shared_session_engine(engine).ok()
}

fn is_legacy_local_provider(engine: EngineType, provider_profile_id: &str) -> bool {
    match engine {
        EngineType::Claude => {
            provider_profile_id
                == crate::engine::claude::provider_profile::CLAUDE_LOCAL_PROVIDER_PROFILE_ID
        }
        EngineType::Codex => {
            provider_profile_id == crate::codex::provider_profile::CODEX_DISK_PROVIDER_PROFILE_ID
        }
        EngineType::Kimi => {
            provider_profile_id
                == crate::engine::kimi_provider_profile::KIMI_LOCAL_PROVIDER_PROFILE_ID
        }
        EngineType::Grok => {
            provider_profile_id
                == crate::engine::grok_provider_profile::GROK_LOCAL_PROVIDER_PROFILE_ID
        }
        EngineType::OpenCode => {
            provider_profile_id
                == crate::engine::opencode_provider_profile::OPENCODE_LOCAL_PROVIDER_PROFILE_ID
        }
        EngineType::Pi => {
            provider_profile_id == crate::engine::pi_provider_profile::PI_LOCAL_PROVIDER_PROFILE_ID
        }
        EngineType::Qoder => {
            provider_profile_id
                == crate::engine::qoder_provider_profile::QODER_LOCAL_PROVIDER_PROFILE_ID
        }
        // Native-only engines are never Shared local providers.
        EngineType::Gemini | EngineType::Dsh => false,
    }
}

fn provider_catalog_is_available(engine: EngineType, provider_profile_id: &str) -> bool {
    // Qoder catalog is ACP runtime-only. Its Global/CN identities are still
    // valid provider targets even when no static model list is cached.
    if engine == EngineType::Qoder {
        return crate::engine::qoder_provider_profile::qoder_distribution_from_provider_profile_id(
            Some(provider_profile_id),
        )
        .is_ok();
    }
    is_legacy_local_provider(engine, provider_profile_id)
        || matches!(
            crate::engine::status::get_provider_scoped_engine_models(
                engine,
                Some(provider_profile_id),
            ),
            Ok(Some(_))
        )
}

fn enrich_provider_availability(items: &mut [ProjectionItem]) {
    let mut availability_by_target = HashMap::<(EngineType, String), bool>::new();
    for item in items {
        let Some(snapshot) = item
            .content
            .get_mut("executionTargetSnapshot")
            .and_then(serde_json::Value::as_object_mut)
        else {
            continue;
        };
        let Some(provider_profile_id) = snapshot
            .get("providerProfileId")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            snapshot.insert("providerAvailable".to_string(), true.into());
            continue;
        };
        let Some(engine) = projection_engine(snapshot) else {
            continue;
        };
        let target_key = (engine, provider_profile_id.to_string());
        let available = *availability_by_target
            .entry(target_key)
            .or_insert_with(|| provider_catalog_is_available(engine, provider_profile_id));
        snapshot.insert("providerAvailable".to_string(), available.into());
    }
}

#[tauri::command]
pub(crate) async fn load_shared_projection(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProjectionItem>, String> {
    let (writer, session_id, _) = projection_context(&workspace_id, &thread_id, &state).await?;
    tokio::task::spawn_blocking(move || {
        let mut items = SharedProjector::new().project(
            &writer,
            &session_id,
            CANVAS_PROJECTION_NAME,
            CANVAS_PROJECTION_VERSION,
        )?;
        enrich_provider_availability(&mut items);
        Ok::<_, crate::shared_event_log::StoreError>(items)
    })
    .await
    .map_err(|error| format!("Shared projection task failed: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn rebuild_shared_projection(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ProjectionItem>, String> {
    let (writer, session_id, _) = projection_context(&workspace_id, &thread_id, &state).await?;
    tokio::task::spawn_blocking(move || {
        let mut items = SharedProjector::new().rebuild(
            &writer,
            &session_id,
            CANVAS_PROJECTION_NAME,
            CANVAS_PROJECTION_VERSION,
        )?;
        enrich_provider_availability(&mut items);
        Ok::<_, crate::shared_event_log::StoreError>(items)
    })
    .await
    .map_err(|error| format!("Shared projection rebuild task failed: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn compare_shared_projection(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<MismatchReport, String> {
    let (writer, session_id, legacy_log_path) =
        projection_context(&workspace_id, &thread_id, &state).await?;
    tokio::task::spawn_blocking(move || {
        let shadow = SharedProjector::new().project(
            &writer,
            &session_id,
            CANVAS_PROJECTION_NAME,
            CANVAS_PROJECTION_VERSION,
        )?;
        let legacy = LegacySharedReader::new().read_snapshot(&legacy_log_path)?;
        Ok::<_, crate::shared_event_log::StoreError>(
            ShadowComparator::new().compare(&shadow, &legacy),
        )
    })
    .await
    .map_err(|error| format!("Shared projection compare task failed: {error}"))?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_engine_covers_shared_cli_matrix_and_rejects_gemini() {
        for engine in ["claude", "codex", "kimi", "grok", "opencode", "qoder"] {
            let snapshot = serde_json::json!({ "engine": engine })
                .as_object()
                .expect("snapshot object")
                .clone();
            assert!(projection_engine(&snapshot).is_some(), "{engine}");
        }

        let snapshot = serde_json::json!({ "engine": "gemini" })
            .as_object()
            .expect("snapshot object")
            .clone();
        assert!(projection_engine(&snapshot).is_none());
    }

    #[test]
    fn missing_managed_provider_catalog_is_unavailable_for_shared_cli_matrix() {
        for engine in [
            EngineType::Claude,
            EngineType::Codex,
            EngineType::Kimi,
            EngineType::Grok,
            EngineType::OpenCode,
        ] {
            assert!(
                !provider_catalog_is_available(engine, "__missing-shared-provider__"),
                "{engine:?}"
            );
        }
    }

    #[test]
    fn qoder_distribution_bindings_are_available_without_static_catalog() {
        for profile_id in [
            crate::engine::qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID,
            crate::engine::qoder_provider_profile::QODER_CN_PROVIDER_PROFILE_ID,
        ] {
            assert!(provider_catalog_is_available(EngineType::Qoder, profile_id));
        }
        assert!(!provider_catalog_is_available(
            EngineType::Qoder,
            "__missing-qoder-distribution__",
        ));
    }
}
