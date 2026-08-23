use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::State;
use tokio::time::timeout;

use super::store::{
    count_for_workspace_path, list_for_workspace_path, list_for_workspace_path_before,
    load_backfill_state, normalize_path_key, open_connection, save_backfill_state,
    tombstone_session_ids, upsert_rows, workspace_index_sources_invalidated, BackfillState,
    SessionIndexListPage, SessionIndexRow, SessionIndexSyncReport,
};
use super::writers::{
    backfill_claude_for_workspace, backfill_codex_for_workspace, backfill_kimi_for_workspace,
    commit_engine_rows, dsh_source_fingerprint, engine_source_should_skip, gemini_home_fingerprint,
    grok_home_fingerprint, invalidate_workspace_sources, opencode_source_fingerprint,
    pi_home_fingerprint, qoder_source_fingerprint, rows_from_dsh_summaries,
    rows_from_gemini_summaries, rows_from_grok_summaries, rows_from_opencode_entries,
    rows_from_pi_summaries, rows_from_qoder_summaries, sync_claude_for_workspace,
    sync_codex_for_workspace, sync_kimi_for_workspace, BackfillBatchResult, WriterResult,
    CLAUDE_BACKFILL_BATCH_SIZE, CODEX_BACKFILL_PARTITIONS_PER_BATCH, KIMI_BACKFILL_BATCH_SIZE,
};
use crate::engine::gemini_history::list_gemini_sessions;
use crate::engine::grok_history::list_grok_sessions;
use crate::engine::opencode_session_list_core;
use crate::engine::pi_history::list_pi_sessions;
use crate::engine::qoder_history::{
    list_qoder_sessions_for_launch_profile, QoderSessionSummary,
};
use crate::engine::qoder_provider_profile::{
    resolve_qoder_provider_launch_profile, QoderDistributionSettings, QoderProviderLaunchProfile,
    QODER_CN_PROVIDER_PROFILE_ID, QODER_GLOBAL_PROVIDER_PROFILE_ID,
};
use crate::local_usage::resolve_sessions_roots;
use crate::state::AppState;

const DEFAULT_SIDEBAR_INDEX_LIMIT: usize = 12;
const ASYNC_ENGINE_LIST_TIMEOUT: Duration = Duration::from_secs(3);
const OPENCODE_INDEX_TIMEOUT: Duration = Duration::from_secs(2);

fn resolve_qoder_index_profiles(
    workspace_path: &PathBuf,
    settings: &QoderDistributionSettings,
) -> Result<[QoderProviderLaunchProfile; 2], String> {
    let workspace_key = workspace_path.to_string_lossy();
    Ok([
        resolve_qoder_provider_launch_profile(
            &workspace_key,
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID),
            settings,
        )?,
        resolve_qoder_provider_launch_profile(
            &workspace_key,
            Some(QODER_CN_PROVIDER_PROFILE_ID),
            settings,
        )?,
    ])
}

async fn list_qoder_index_sessions(
    workspace_path: &PathBuf,
    limit: usize,
    profiles: [QoderProviderLaunchProfile; 2],
) -> (Vec<QoderSessionSummary>, Option<String>) {
    let [global_profile, cn_profile] = profiles;
    let (global_result, cn_result) = tokio::join!(
        timeout(
            ASYNC_ENGINE_LIST_TIMEOUT,
            list_qoder_sessions_for_launch_profile(workspace_path, Some(limit), &global_profile),
        ),
        timeout(
            ASYNC_ENGINE_LIST_TIMEOUT,
            list_qoder_sessions_for_launch_profile(workspace_path, Some(limit), &cn_profile),
        ),
    );

    let mut sessions = Vec::new();
    let mut failure = None;
    for result in [global_result, cn_result] {
        match result {
            Ok(Ok(mut distribution_sessions)) => sessions.append(&mut distribution_sessions),
            Ok(Err(error)) => {
                let message = error.to_ascii_lowercase();
                failure = Some(if message.contains("not found")
                    || message.contains("not installed")
                    || message.contains("no such file")
                    || message.contains("timed out")
                    || message.contains("timeout")
                {
                    "qoder-unavailable".to_string()
                } else {
                    format!("qoder-sync-error:{}", truncate_error(&error))
                });
            }
            Err(_) => failure = Some("qoder-sync-timeout".to_string()),
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    (sessions, failure)
}

fn merge_writer(into: &mut WriterResult, from: WriterResult) {
    into.upserted += from.upserted;
    for engine in from.engines {
        if !into.engines.iter().any(|existing| existing == &engine) {
            into.engines.push(engine);
        }
    }
    if into.partial_source.is_none() {
        into.partial_source = from.partial_source;
    }
    into.skipped_fresh = into.skipped_fresh && from.skipped_fresh;
}

async fn resolve_workspace_path_async(
    state: &AppState,
    workspace_id: &str,
) -> Result<(String, PathBuf), String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("workspace_id is required".to_string());
    }
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .ok_or_else(|| "workspace not found".to_string())?;
    Ok((entry.path.clone(), PathBuf::from(&entry.path)))
}

async fn sync_disk_engines(
    workspace_path: PathBuf,
    sessions_roots: Vec<PathBuf>,
    limit: usize,
    force: bool,
) -> Result<WriterResult, String> {
    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        let mut aggregated = WriterResult {
            skipped_fresh: true,
            ..WriterResult::default()
        };

        match sync_claude_for_workspace(&connection, &workspace_path, limit, force) {
            Ok(result) => merge_writer(&mut aggregated, result),
            Err(error) => {
                aggregated.partial_source =
                    Some(format!("claude-sync-error:{}", truncate_error(&error)));
                aggregated.engines.push("claude".into());
                aggregated.skipped_fresh = false;
            }
        }

        match sync_codex_for_workspace(&connection, &workspace_path, &sessions_roots, limit, force)
        {
            Ok(result) => merge_writer(&mut aggregated, result),
            Err(error) => {
                if aggregated.partial_source.is_none() {
                    aggregated.partial_source =
                        Some(format!("codex-sync-error:{}", truncate_error(&error)));
                }
                if !aggregated.engines.iter().any(|engine| engine == "codex") {
                    aggregated.engines.push("codex".into());
                }
                aggregated.skipped_fresh = false;
            }
        }

        match sync_kimi_for_workspace(&connection, &workspace_path, limit, force) {
            Ok(result) => merge_writer(&mut aggregated, result),
            Err(error) => {
                if aggregated.partial_source.is_none() {
                    aggregated.partial_source =
                        Some(format!("kimi-sync-error:{}", truncate_error(&error)));
                }
                if !aggregated.engines.iter().any(|engine| engine == "kimi") {
                    aggregated.engines.push("kimi".into());
                }
                aggregated.skipped_fresh = false;
            }
        }

        Ok::<WriterResult, String>(aggregated)
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn sync_gemini_engine(workspace_path: PathBuf, limit: usize, force: bool) -> WriterResult {
    let fingerprint = gemini_home_fingerprint();
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "gemini", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["gemini".into()],
            ..WriterResult::default()
        };
    }

    let list_result = timeout(
        ASYNC_ENGINE_LIST_TIMEOUT,
        list_gemini_sessions(&workspace_path, Some(limit), None),
    )
    .await;

    let (rows, partial) = match list_result {
        Ok(Ok(sessions)) => (rows_from_gemini_summaries(&workspace_path, &sessions), None),
        Ok(Err(error)) => (
            Vec::new(),
            Some(format!("gemini-sync-error:{}", truncate_error(&error))),
        ),
        Err(_) => (Vec::new(), Some("gemini-sync-timeout".into())),
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "gemini",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["gemini".into()],
        partial_source: Some("gemini-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

async fn sync_grok_engine(workspace_path: PathBuf, limit: usize, force: bool) -> WriterResult {
    let fingerprint = grok_home_fingerprint();
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "grok", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["grok".into()],
            ..WriterResult::default()
        };
    }

    let list_result = timeout(
        ASYNC_ENGINE_LIST_TIMEOUT,
        list_grok_sessions(&workspace_path, Some(limit), None),
    )
    .await;

    let (rows, partial) = match list_result {
        Ok(Ok(sessions)) => (rows_from_grok_summaries(&workspace_path, &sessions), None),
        Ok(Err(error)) => (
            Vec::new(),
            Some(format!("grok-sync-error:{}", truncate_error(&error))),
        ),
        Err(_) => (Vec::new(), Some("grok-sync-timeout".into())),
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "grok",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["grok".into()],
        partial_source: Some("grok-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

async fn sync_pi_engine(workspace_path: PathBuf, limit: usize, force: bool) -> WriterResult {
    let fingerprint = pi_home_fingerprint();
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "pi", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["pi".into()],
            ..WriterResult::default()
        };
    }

    let list_result = timeout(
        ASYNC_ENGINE_LIST_TIMEOUT,
        list_pi_sessions(&workspace_path, Some(limit), None),
    )
    .await;

    let (rows, partial) = match list_result {
        Ok(Ok(sessions)) => (rows_from_pi_summaries(&workspace_path, &sessions), None),
        Ok(Err(error)) => (
            Vec::new(),
            Some(format!("pi-sync-error:{}", truncate_error(&error))),
        ),
        Err(_) => (Vec::new(), Some("pi-sync-timeout".into())),
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "pi",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["pi".into()],
        partial_source: Some("pi-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

async fn sync_dsh_engine(
    state: &AppState,
    workspace_path: PathBuf,
    limit: usize,
    force: bool,
) -> WriterResult {
    let fingerprint = dsh_source_fingerprint(&workspace_path);
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "dsh", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["dsh".into()],
            ..WriterResult::default()
        };
    }

    let settings = state.app_settings.lock().await.clone();
    let runtime = crate::engine::dsh::runtime_settings_from_app(&settings);
    let list_result = timeout(ASYNC_ENGINE_LIST_TIMEOUT, async {
        let (_snapshot, client) = crate::engine::dsh::connect_existing(&runtime).await?;
        crate::engine::dsh::history::list_dsh_sessions(&client, &workspace_path, Some(limit)).await
    })
    .await;

    let (rows, partial) = match list_result {
        Ok(Ok(sessions)) => (rows_from_dsh_summaries(&workspace_path, &sessions), None),
        Ok(Err(error)) => {
            // Host down / not installed is soft-empty for index sync.
            let message = error.to_ascii_lowercase();
            let soft = message.contains("not running")
                || message.contains("connection refused")
                || message.contains("connect")
                || message.contains("not found")
                || message.contains("not installed")
                || message.contains("timed out")
                || message.contains("timeout");
            (
                Vec::new(),
                if soft {
                    Some("dsh-unavailable".into())
                } else {
                    Some(format!("dsh-sync-error:{}", truncate_error(&error)))
                },
            )
        }
        Err(_) => (Vec::new(), Some("dsh-sync-timeout".into())),
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "dsh",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["dsh".into()],
        partial_source: Some("dsh-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

async fn sync_qoder_engine(
    state: &AppState,
    workspace_path: PathBuf,
    limit: usize,
    force: bool,
) -> WriterResult {
    let fingerprint = qoder_source_fingerprint(&workspace_path);
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "qoder", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["qoder".into()],
            ..WriterResult::default()
        };
    }

    let qoder_config = state
        .engine_manager
        .get_engine_config(crate::engine::EngineType::Qoder)
        .await;
    let (rows, partial) = if qoder_config.is_some() {
        let settings = state.engine_manager.qoder_distribution_settings().await;
        match resolve_qoder_index_profiles(&workspace_path, &settings) {
            Ok(profiles) => {
                let (sessions, partial) = list_qoder_index_sessions(&workspace_path, limit, profiles).await;
                (rows_from_qoder_summaries(&workspace_path, &sessions), partial)
            }
            Err(error) => (
                Vec::new(),
                Some(format!("qoder-sync-error:{}", truncate_error(&error))),
            ),
        }
    } else {
        (Vec::new(), None)
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "qoder",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["qoder".into()],
        partial_source: Some("qoder-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

async fn sync_opencode_engine(
    state: &AppState,
    workspace_id: &str,
    workspace_path: PathBuf,
    limit: usize,
    force: bool,
) -> WriterResult {
    let fingerprint = opencode_source_fingerprint(&workspace_path);
    let skip = !force
        && tokio::task::spawn_blocking({
            let workspace_path = workspace_path.clone();
            let fingerprint = fingerprint.clone();
            move || {
                let connection = open_connection()?;
                engine_source_should_skip(&connection, "opencode", &workspace_path, &fingerprint)
            }
        })
        .await
        .ok()
        .and_then(|result| result.ok())
        .unwrap_or(false);
    if skip {
        return WriterResult {
            skipped_fresh: true,
            engines: vec!["opencode".into()],
            ..WriterResult::default()
        };
    }

    // Soft path: never block sidebar on OpenCode CLI; empty + partial on failure.
    let list_result: Result<
        Result<Vec<crate::engine::OpenCodeSessionEntry>, String>,
        tokio::time::error::Elapsed,
    > = timeout(
        OPENCODE_INDEX_TIMEOUT,
        opencode_session_list_core(&state.workspaces, &state.engine_manager, workspace_id),
    )
    .await;

    let (rows, partial) = match list_result {
        Ok(Ok(mut entries)) => {
            entries.truncate(limit);
            (rows_from_opencode_entries(&workspace_path, &entries), None)
        }
        Ok(Err(error)) => {
            // Missing CLI / disabled engine is soft-empty, not hard failure.
            let message = error.to_ascii_lowercase();
            let soft = message.contains("not found")
                || message.contains("disabled")
                || message.contains("not installed")
                || message.contains("no such file");
            (
                Vec::new(),
                if soft {
                    Some("opencode-unavailable".into())
                } else {
                    Some(format!("opencode-sync-error:{}", truncate_error(&error)))
                },
            )
        }
        Err(_) => (Vec::new(), Some("opencode-sync-timeout".into())),
    };

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        commit_engine_rows(
            &connection,
            "opencode",
            &workspace_path,
            rows,
            &fingerprint,
            partial,
        )
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_else(|| WriterResult {
        engines: vec!["opencode".into()],
        partial_source: Some("opencode-commit-error".into()),
        skipped_fresh: false,
        ..WriterResult::default()
    })
}

pub(crate) async fn sync_session_index_core(
    state: &AppState,
    workspace_id: &str,
    limit: usize,
    force: bool,
) -> Result<SessionIndexSyncReport, String> {
    let started = Instant::now();
    let (_path_str, workspace_path) = resolve_workspace_path_async(state, workspace_id).await?;
    let sessions_roots = {
        let workspaces = state.workspaces.lock().await;
        resolve_sessions_roots(&workspaces, Some(workspace_path.as_path()))
    };

    // Disk-bound engines first (blocking pool), then bounded async engine lists.
    let mut aggregated =
        sync_disk_engines(workspace_path.clone(), sessions_roots, limit, force).await?;

    // Gemini / Grok / PI / DSH / Qoder each have their own 3s timeout. Join them so a
    // slow Gemini probe cannot serialize PI/DSH/Qoder off the first-paint window.
    let (gemini, grok, pi, dsh, qoder) = tokio::join!(
        sync_gemini_engine(workspace_path.clone(), limit, force),
        sync_grok_engine(workspace_path.clone(), limit, force),
        sync_pi_engine(workspace_path.clone(), limit, force),
        sync_dsh_engine(state, workspace_path.clone(), limit, force),
        sync_qoder_engine(state, workspace_path.clone(), limit, force),
    );
    merge_writer(&mut aggregated, gemini);
    merge_writer(&mut aggregated, grok);
    merge_writer(&mut aggregated, pi);
    merge_writer(&mut aggregated, dsh);
    merge_writer(&mut aggregated, qoder);

    let opencode =
        sync_opencode_engine(state, workspace_id, workspace_path.clone(), limit, force).await;
    merge_writer(&mut aggregated, opencode);

    Ok(SessionIndexSyncReport {
        upserted: aggregated.upserted,
        engines: aggregated.engines,
        duration_ms: started.elapsed().as_millis() as u64,
        partial_source: aggregated.partial_source,
        skipped_fresh: aggregated.skipped_fresh,
    })
}

const ASYNC_BACKFILL_PAGE: usize = 200;
const ASYNC_BACKFILL_MAX_LIMIT: usize = 5_000;

async fn backfill_async_engine<S, F, Fut, C>(
    engine: &str,
    workspace_path: PathBuf,
    fetch: F,
    convert: C,
) -> WriterResult
where
    F: FnOnce(PathBuf, usize) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<S>, String>>,
    C: FnOnce(&std::path::Path, &[S]) -> Vec<SessionIndexRow>,
{
    let engine_key = engine.trim().to_ascii_lowercase();
    let source_key = format!(
        "{}:{}",
        engine_key,
        normalize_path_key(&workspace_path.to_string_lossy())
    );
    let state = tokio::task::spawn_blocking({
        let source_key = source_key.clone();
        move || {
            let connection = open_connection()?;
            load_backfill_state(&connection, &source_key)
        }
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_default();
    if state.complete {
        return WriterResult {
            skipped_fresh: true,
            engines: vec![engine_key],
            ..WriterResult::default()
        };
    }
    let covered: usize = state.cursor.trim().parse().unwrap_or(0);
    let request = covered
        .saturating_add(ASYNC_BACKFILL_PAGE)
        .min(ASYNC_BACKFILL_MAX_LIMIT);

    let list_result = timeout(
        ASYNC_ENGINE_LIST_TIMEOUT,
        fetch(workspace_path.clone(), request),
    )
    .await;
    let sessions = match list_result {
        Ok(Ok(sessions)) => sessions,
        Ok(Err(error)) => {
            return WriterResult {
                engines: vec![engine_key.clone()],
                partial_source: Some(format!(
                    "{engine_key}-backfill-error:{}",
                    truncate_error(&error)
                )),
                ..WriterResult::default()
            };
        }
        Err(_) => {
            return WriterResult {
                engines: vec![engine_key.clone()],
                partial_source: Some(format!("{engine_key}-backfill-timeout")),
                ..WriterResult::default()
            };
        }
    };
    let total = sessions.len();
    let rows = convert(&workspace_path, &sessions);
    let complete = total < request || request >= ASYNC_BACKFILL_MAX_LIMIT;

    tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        let upserted = upsert_rows(&connection, &rows)?;
        save_backfill_state(
            &connection,
            &source_key,
            &BackfillState {
                cursor: total.to_string(),
                complete,
            },
        )?;
        Ok::<usize, String>(upserted)
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .map(|upserted| WriterResult {
        upserted,
        engines: vec![engine_key.clone()],
        ..WriterResult::default()
    })
    .unwrap_or_else(|| WriterResult {
        engines: vec![engine_key.clone()],
        partial_source: Some(format!("{engine_key}-backfill-commit-error")),
        ..WriterResult::default()
    })
}

fn merge_backfill(
    into: &mut WriterResult,
    engine: &str,
    from: Result<BackfillBatchResult, String>,
) {
    match from {
        Ok(result) => {
            into.upserted += result.upserted;
            if !into.engines.iter().any(|existing| existing == engine) {
                into.engines.push(engine.to_string());
            }
        }
        Err(error) => {
            if into.partial_source.is_none() {
                into.partial_source = Some(format!(
                    "{engine}-backfill-error:{}",
                    truncate_error(&error)
                ));
            }
            if !into.engines.iter().any(|existing| existing == engine) {
                into.engines.push(engine.to_string());
            }
        }
    }
}

/// One bounded historical-backfill batch per engine for a workspace.
/// SKIP_BACKFILL: opencode — no durable disk index (soft-empty); only light sync.
pub(crate) async fn backfill_session_index_core(
    state: &AppState,
    workspace_id: &str,
) -> Result<WriterResult, String> {
    let (_path_str, workspace_path) = resolve_workspace_path_async(state, workspace_id).await?;
    let sessions_roots = {
        let workspaces = state.workspaces.lock().await;
        resolve_sessions_roots(&workspaces, Some(workspace_path.as_path()))
    };

    let mut aggregated = WriterResult::default();

    let disk = tokio::task::spawn_blocking({
        let workspace_path = workspace_path.clone();
        move || {
            let connection = open_connection()?;
            let mut result = WriterResult::default();
            merge_backfill(
                &mut result,
                "claude",
                backfill_claude_for_workspace(
                    &connection,
                    &workspace_path,
                    CLAUDE_BACKFILL_BATCH_SIZE,
                ),
            );
            merge_backfill(
                &mut result,
                "codex",
                backfill_codex_for_workspace(
                    &connection,
                    &workspace_path,
                    &sessions_roots,
                    CODEX_BACKFILL_PARTITIONS_PER_BATCH,
                ),
            );
            merge_backfill(
                &mut result,
                "kimi",
                backfill_kimi_for_workspace(&connection, &workspace_path, KIMI_BACKFILL_BATCH_SIZE),
            );
            Ok::<WriterResult, String>(result)
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    merge_writer(&mut aggregated, disk);

    let settings = state.app_settings.lock().await.clone();
    let dsh_runtime = crate::engine::dsh::runtime_settings_from_app(&settings);
    let qoder_config = state
        .engine_manager
        .get_engine_config(crate::engine::EngineType::Qoder)
        .await;
    let qoder_profiles = qoder_config
        .is_some()
        .then(|| {
            resolve_qoder_index_profiles(
                &workspace_path,
                &QoderDistributionSettings::from_app_settings(&settings),
            )
        })
        .transpose()?;
    let (gemini, grok, pi, dsh, qoder) = tokio::join!(
        backfill_async_engine(
            "gemini",
            workspace_path.clone(),
            |path, limit| async move { list_gemini_sessions(&path, Some(limit), None).await },
            rows_from_gemini_summaries,
        ),
        backfill_async_engine(
            "grok",
            workspace_path.clone(),
            |path, limit| async move { list_grok_sessions(&path, Some(limit), None).await },
            rows_from_grok_summaries,
        ),
        backfill_async_engine(
            "pi",
            workspace_path.clone(),
            |path, limit| async move { list_pi_sessions(&path, Some(limit), None).await },
            rows_from_pi_summaries,
        ),
        backfill_async_engine(
            "dsh",
            workspace_path.clone(),
            move |path, limit| {
                let runtime = dsh_runtime.clone();
                async move {
                    let (_snapshot, client) =
                        crate::engine::dsh::connect_existing(&runtime).await?;
                    crate::engine::dsh::history::list_dsh_sessions(&client, &path, Some(limit))
                        .await
                }
            },
            rows_from_dsh_summaries,
        ),
        backfill_async_engine(
            "qoder",
            workspace_path.clone(),
            move |path, limit| {
                let profiles = qoder_profiles.clone();
                async move {
                    let Some([global_profile, cn_profile]) = profiles else {
                        return Ok(Vec::new());
                    };
                    let (global_result, cn_result) = tokio::join!(
                        list_qoder_sessions_for_launch_profile(
                            &path,
                            Some(limit),
                            &global_profile,
                        ),
                        list_qoder_sessions_for_launch_profile(&path, Some(limit), &cn_profile),
                    );
                    let mut sessions = Vec::new();
                    let mut errors = Vec::new();
                    for result in [global_result, cn_result] {
                        match result {
                            Ok(mut distribution_sessions) => sessions.append(&mut distribution_sessions),
                            Err(error) => errors.push(error),
                        }
                    }
                    if sessions.is_empty() && !errors.is_empty() {
                        return Err(errors.join("; "));
                    }
                    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                    Ok(sessions)
                }
            },
            rows_from_qoder_summaries,
        ),
    );
    merge_writer(&mut aggregated, gemini);
    merge_writer(&mut aggregated, grok);
    merge_writer(&mut aggregated, pi);
    merge_writer(&mut aggregated, dsh);
    merge_writer(&mut aggregated, qoder);

    Ok(aggregated)
}

/// Sync light indexes for all supported engines into SQLite.
#[tauri::command]
pub async fn sync_session_index_for_workspace(
    workspace_id: String,
    limit: Option<u32>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<SessionIndexSyncReport, String> {
    let force = force.unwrap_or(false);
    let limit = limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_SIDEBAR_INDEX_LIMIT)
        .clamp(1, 500);
    sync_session_index_core(&state, &workspace_id, limit, force).await
}

/// Soft-invalidate workspace sources so next list/sync rescans (CLI create path).
#[tauri::command]
pub async fn invalidate_session_index_for_workspace(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let (_path_str, workspace_path) = resolve_workspace_path_async(&state, &workspace_id).await?;
    let changed = tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        invalidate_workspace_sources(&connection, &workspace_path)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(changed as u32)
}

/// Mark Session Index rows deleted so sidebar hydrate cannot resurrect them.
#[tauri::command]
pub async fn tombstone_session_index_rows(session_ids: Vec<String>) -> Result<u32, String> {
    let changed = tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        tombstone_session_ids(&connection, &session_ids)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(changed as u32)
}

/// Client-created sessions write the sidebar Index directly. No disk scan.
#[tauri::command]
pub async fn upsert_session_index_rows(rows: Vec<SessionIndexRow>) -> Result<u32, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let changed = tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        upsert_rows(&connection, &rows)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(changed as u32)
}

/// List sidebar sessions from SQLite. Optionally sync first when stale/empty.
#[tauri::command]
pub async fn list_session_index_for_workspace(
    workspace_id: String,
    limit: Option<u32>,
    sync_if_needed: Option<bool>,
    force_sync: Option<bool>,
    before_updated_at: Option<i64>,
    before_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<SessionIndexListPage, String> {
    let started = Instant::now();
    let limit = limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_SIDEBAR_INDEX_LIMIT)
        .clamp(1, 500);
    let keyset_before = before_updated_at.map(|updated_at| {
        (
            updated_at,
            before_session_id.unwrap_or_default().trim().to_string(),
        )
    });
    // Keyset "更多" is a pure page query — never block paging on a writer rescan.
    let sync_if_needed = sync_if_needed.unwrap_or(true) && keyset_before.is_none();
    let force_sync = force_sync.unwrap_or(false) && keyset_before.is_none();
    let (path_str, _workspace_path) = resolve_workspace_path_async(&state, &workspace_id).await?;

    let mut synced = false;
    let mut sync_ms = None;
    let mut partial_source = None;
    let mut engines = Vec::new();

    if sync_if_needed || force_sync {
        let path_for_check = path_str.clone();
        let index_empty = force_sync
            || tokio::task::spawn_blocking(move || {
                let connection = open_connection()?;
                let existing = list_for_workspace_path(&connection, &path_for_check, 1)?;
                if existing.is_empty() {
                    return Ok(true);
                }
                workspace_index_sources_invalidated(&connection, &path_for_check)
            })
            .await
            .map_err(|error| error.to_string())??;
        if force_sync || index_empty {
            let report = sync_session_index_core(&state, &workspace_id, limit, force_sync).await?;
            synced = !report.skipped_fresh || index_empty;
            sync_ms = Some(report.duration_ms);
            partial_source = report.partial_source;
            engines = report.engines;
        }
    }

    // First page only: GC stale empty native drafts after sync, before SQL list.
    if keyset_before.is_none() {
        super::empty_prune::prune_stale_empty_native_sessions(&path_str, Some(&*state)).await;
    }

    let path_for_list = path_str.clone();
    let (data, has_more) = tokio::task::spawn_blocking(move || {
        let connection = open_connection()?;
        match keyset_before {
            Some((before_updated_at, before_session_id)) => {
                let mut rows = list_for_workspace_path_before(
                    &connection,
                    &path_for_list,
                    limit.saturating_add(1),
                    Some((before_updated_at, before_session_id)),
                )?;
                let more = rows.len() > limit;
                if more {
                    rows.truncate(limit);
                }
                Ok::<(Vec<SessionIndexRow>, bool), String>((rows, more))
            }
            None => {
                let rows = list_for_workspace_path(&connection, &path_for_list, limit)?;
                let total = count_for_workspace_path(&connection, &path_for_list)?;
                let more = total > rows.len() as i64;
                Ok((rows, more))
            }
        }
    })
    .await
    .map_err(|error| error.to_string())??;

    // provider 标签 overlay：老行 / 缺列行按绑定账本补齐（codex 另走
    // physical_path provider-home 兜底），重载后 first paint 即可画标签。
    let mut data = data;
    crate::session_management::overlay_session_index_provider_bindings(
        &state.storage_path,
        &workspace_id,
        &mut data,
    );

    if engines.is_empty() {
        let mut seen = std::collections::HashSet::new();
        for row in &data {
            if seen.insert(row.engine.clone()) {
                engines.push(row.engine.clone());
            }
        }
    }

    let event_log_path = state
        .storage_path
        .parent()
        .map(|parent| parent.join("shared-event-log-v2.sqlite3"));
    let visibility = super::shared_visibility::load_shared_native_visibility_projection(
        &workspace_id,
        event_log_path.as_deref(),
        &data,
    );

    Ok(SessionIndexListPage {
        data,
        source: if synced {
            "session-index+sync".into()
        } else {
            "session-index".into()
        },
        synced,
        sync_ms: sync_ms.or_else(|| Some(started.elapsed().as_millis() as u64)),
        engines,
        partial_source,
        has_more,
        visibility: Some(visibility),
    })
}

fn truncate_error(error: &str) -> String {
    let trimmed = error.trim();
    if trimmed.chars().count() <= 120 {
        return trimmed.to_string();
    }
    trimmed.chars().take(119).collect::<String>() + "…"
}
