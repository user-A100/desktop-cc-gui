use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::session_management_types::{
    parse_status_filter, SessionCatalogCountSummary, SessionCatalogScanMode,
    SessionCatalogStatusFilter, WorkspaceSessionCatalogDiagnostic, WorkspaceSessionCatalogEntry,
    WorkspaceSessionCatalogQuery, WorkspaceSessionCatalogSourceStatus,
    WorkspaceSessionSourceCacheMetrics, WorkspaceSessionSourceCompleteness,
    SESSION_CATALOG_PARTIAL_CLAUDE_UNCERTAIN_EMPTY,
};
use crate::engine;

pub(super) fn build_source_label(source: Option<&str>, provider: Option<&str>) -> Option<String> {
    match (
        source.map(str::trim).filter(|value| !value.is_empty()),
        provider.map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (Some(source), Some(provider)) => Some(format!("{source}/{provider}")),
        (Some(source), None) => Some(source.to_string()),
        (None, Some(provider)) => Some(provider.to_string()),
        (None, None) => None,
    }
}

pub(super) fn entry_matches_keyword(entry: &WorkspaceSessionCatalogEntry, keyword: &str) -> bool {
    let title = entry.title.to_lowercase();
    let session_id = entry.session_id.to_lowercase();
    let source = entry
        .source
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_default();
    let source_label = entry
        .source_label
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_default();
    let workspace_label = entry
        .workspace_label
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_default();
    title.contains(keyword)
        || session_id.contains(keyword)
        || source.contains(keyword)
        || source_label.contains(keyword)
        || workspace_label.contains(keyword)
}

pub(super) fn entry_matches_engine_and_keyword(
    entry: &WorkspaceSessionCatalogEntry,
    engine_filter: Option<&str>,
    keyword: Option<&str>,
) -> bool {
    if let Some(filter) = engine_filter {
        if entry.engine != filter {
            return false;
        }
    }
    if let Some(keyword) = keyword {
        return entry_matches_keyword(entry, keyword);
    }
    true
}

pub(super) fn entry_matches_status(
    entry: &WorkspaceSessionCatalogEntry,
    status_filter: SessionCatalogStatusFilter,
) -> bool {
    match status_filter {
        SessionCatalogStatusFilter::Active => entry.exists_on_disk && entry.archived_at.is_none(),
        SessionCatalogStatusFilter::Archived => entry.archived_at.is_some(),
        SessionCatalogStatusFilter::All => true,
    }
}

pub(super) fn build_catalog_count_summary(
    entries: &[WorkspaceSessionCatalogEntry],
    query: &WorkspaceSessionCatalogQuery,
) -> SessionCatalogCountSummary {
    let status_filter = parse_status_filter(query.status.as_deref());
    let keyword = query
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());
    let engine_filter = query
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());

    let mut counts = SessionCatalogCountSummary {
        active_total: 0,
        archived_total: 0,
        all_total: 0,
        filtered_total: 0,
    };

    for entry in entries {
        if entry_is_hidden_automatic_session(entry) {
            continue;
        }
        if !entry_matches_engine_and_keyword(entry, engine_filter.as_deref(), keyword.as_deref()) {
            continue;
        }
        counts.all_total += 1;
        if entry.archived_at.is_some() {
            counts.archived_total += 1;
        } else {
            counts.active_total += 1;
        }
        if entry_matches_status(entry, status_filter) {
            counts.filtered_total += 1;
        }
    }

    counts
}

pub(super) fn entry_is_hidden_automatic_session(entry: &WorkspaceSessionCatalogEntry) -> bool {
    entry
        .auto_session
        .as_ref()
        .is_some_and(|metadata| metadata.visibility == super::AutoSessionVisibility::Hidden)
}

pub(super) fn entry_matches_query(
    entry: &WorkspaceSessionCatalogEntry,
    query: &WorkspaceSessionCatalogQuery,
) -> bool {
    let status_filter = parse_status_filter(query.status.as_deref());
    let keyword = query
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());
    let engine_filter = query
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());

    entry_matches_engine_and_keyword(entry, engine_filter.as_deref(), keyword.as_deref())
        && entry_matches_status(entry, status_filter)
}

pub(super) fn build_catalog_entry_stable_key(entry: &WorkspaceSessionCatalogEntry) -> String {
    let engine = entry.engine.trim().to_ascii_lowercase();
    let session_identity = entry
        .canonical_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| entry.session_id.trim());
    if engine == "qoder" {
        let qoder_identity = engine::qoder_provider_profile::parse_qoder_native_session_identity(
            session_identity,
            entry.provider_profile_id.as_deref(),
        );
        if let Ok(identity) = qoder_identity {
            return format!(
                "qoder:{}:{}:{}",
                entry.workspace_id, identity.provider_profile_id, identity.raw_session_id
            );
        }
    }
    format!("{}:{}:{}", engine, entry.workspace_id, session_identity)
}

pub(super) fn source_status_for_engine<'a>(
    source_statuses: &'a [WorkspaceSessionCatalogSourceStatus],
    engine: &str,
) -> Option<&'a WorkspaceSessionCatalogSourceStatus> {
    let normalized_engine = engine.trim().to_ascii_lowercase();
    if normalized_engine.is_empty() {
        return None;
    }
    source_statuses
        .iter()
        .filter(|status| status.engine.eq_ignore_ascii_case(&normalized_engine))
        .max_by_key(|status| source_status_priority(status.completeness))
}

pub(super) fn decorate_catalog_entry_for_response(
    mut entry: WorkspaceSessionCatalogEntry,
    source_statuses: &[WorkspaceSessionCatalogSourceStatus],
) -> WorkspaceSessionCatalogEntry {
    if entry.stable_session_key.is_none() {
        entry.stable_session_key = Some(build_catalog_entry_stable_key(&entry));
    }
    if let Some(source_status) = source_status_for_engine(source_statuses, &entry.engine) {
        if entry.source_completeness.is_none() {
            entry.source_completeness = Some(source_status.completeness);
        }
        if entry.source_status_reason.is_none() {
            entry.source_status_reason = source_status.reason.clone();
        }
    }
    entry
}

fn source_status_priority(completeness: WorkspaceSessionSourceCompleteness) -> u8 {
    match completeness {
        WorkspaceSessionSourceCompleteness::AuthoritativeEmpty => 0,
        WorkspaceSessionSourceCompleteness::Complete => 1,
        WorkspaceSessionSourceCompleteness::UncertainEmpty => 2,
        WorkspaceSessionSourceCompleteness::Partial => 3,
        WorkspaceSessionSourceCompleteness::Degraded => 4,
    }
}

fn merge_optional_count(left: Option<usize>, right: Option<usize>) -> Option<usize> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.saturating_add(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

pub(super) fn normalize_source_statuses(
    source_statuses: Vec<WorkspaceSessionCatalogSourceStatus>,
) -> Vec<WorkspaceSessionCatalogSourceStatus> {
    let mut by_source =
        HashMap::<(String, Option<String>), WorkspaceSessionCatalogSourceStatus>::new();
    for mut status in source_statuses {
        let engine = status.engine.trim().to_ascii_lowercase();
        if engine.is_empty() {
            continue;
        }
        status.engine = engine.clone();
        status.source_kind = status
            .source_kind
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_ascii_lowercase());
        if status.scan_cap_reached.unwrap_or(false)
            && status.completeness == WorkspaceSessionSourceCompleteness::Complete
        {
            status.completeness = WorkspaceSessionSourceCompleteness::Partial;
            if status.reason.is_none() {
                status.reason = Some(format!("{engine}-scan-cap-reached"));
            }
        }
        let key = (engine.clone(), status.source_kind.clone());
        match by_source.get_mut(&key) {
            Some(existing) => {
                existing.scanned_candidates =
                    merge_optional_count(existing.scanned_candidates, status.scanned_candidates);
                existing.skipped_candidates =
                    merge_optional_count(existing.skipped_candidates, status.skipped_candidates);
                existing.scan_cap_reached = match (
                    existing.scan_cap_reached.unwrap_or(false),
                    status.scan_cap_reached.unwrap_or(false),
                ) {
                    (false, false) => existing.scan_cap_reached.or(status.scan_cap_reached),
                    _ => Some(true),
                };
                existing.diagnostics.extend(status.diagnostics);
                existing.cache = merge_source_cache_metrics(existing.cache.take(), status.cache);
                let incoming_priority = source_status_priority(status.completeness);
                let existing_priority = source_status_priority(existing.completeness);
                if incoming_priority > existing_priority {
                    existing.completeness = status.completeness;
                    existing.reason = status.reason;
                } else if existing.reason.is_none() {
                    existing.reason = status.reason;
                }
            }
            None => {
                by_source.insert(key, status);
            }
        }
    }
    let mut normalized = by_source.into_values().collect::<Vec<_>>();
    normalized.sort_by(|left, right| {
        left.engine
            .cmp(&right.engine)
            .then_with(|| left.source_kind.cmp(&right.source_kind))
    });
    normalized
}

fn merge_source_cache_metrics(
    left: Option<WorkspaceSessionSourceCacheMetrics>,
    right: Option<WorkspaceSessionSourceCacheMetrics>,
) -> Option<WorkspaceSessionSourceCacheMetrics> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.hits = left.hits.saturating_add(right.hits);
            left.misses = left.misses.saturating_add(right.misses);
            left.stale = left.stale.saturating_add(right.stale);
            left.rebuilds = left.rebuilds.saturating_add(right.rebuilds);
            left.failures = left.failures.saturating_add(right.failures);
            Some(left)
        }
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn scan_cap_reached(row_count: usize, scan_mode: SessionCatalogScanMode) -> Option<bool> {
    match scan_mode {
        SessionCatalogScanMode::Bounded(limit) => Some(row_count >= limit),
        SessionCatalogScanMode::Exhaustive => None,
    }
}

pub(super) fn build_success_source_status(
    engine: &str,
    row_count: usize,
    scan_mode: SessionCatalogScanMode,
    empty_completeness: WorkspaceSessionSourceCompleteness,
    empty_reason: Option<&str>,
) -> WorkspaceSessionCatalogSourceStatus {
    let cap_reached = scan_cap_reached(row_count, scan_mode);
    let did_reach_cap = cap_reached.unwrap_or(false);
    let completeness = if row_count == 0 {
        empty_completeness
    } else if did_reach_cap {
        WorkspaceSessionSourceCompleteness::Partial
    } else {
        WorkspaceSessionSourceCompleteness::Complete
    };
    let reason = if row_count == 0 {
        empty_reason.map(ToString::to_string)
    } else if did_reach_cap {
        Some(format!(
            "{}-scan-cap-reached",
            engine.trim().to_ascii_lowercase()
        ))
    } else {
        None
    };
    WorkspaceSessionCatalogSourceStatus {
        engine: engine.to_string(),
        source_kind: None,
        completeness,
        reason,
        scanned_candidates: Some(row_count),
        skipped_candidates: None,
        scan_cap_reached: cap_reached,
        diagnostics: Vec::new(),
        cache: None,
    }
}

pub(super) fn build_degraded_source_status(
    engine: &str,
    reason: &str,
) -> WorkspaceSessionCatalogSourceStatus {
    WorkspaceSessionCatalogSourceStatus {
        engine: engine.to_string(),
        source_kind: None,
        completeness: WorkspaceSessionSourceCompleteness::Degraded,
        reason: Some(reason.to_string()),
        scanned_candidates: None,
        skipped_candidates: None,
        scan_cap_reached: None,
        diagnostics: Vec::new(),
        cache: None,
    }
}

pub(super) fn source_fact_cache_dir(storage_path: &Path, engine: &str) -> Result<PathBuf, String> {
    let data_dir = storage_path
        .parent()
        .ok_or_else(|| format!("storage path has no parent: {}", storage_path.display()))?;
    Ok(data_dir
        .join("session-management")
        .join("source-fact-cache")
        .join(engine))
}

fn redacted_physical_locator(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let file_name = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown");
    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    Some(format!("{file_name}:{}", &digest[..16.min(digest.len())]))
}

fn claude_scan_diagnostic_to_catalog(
    diagnostic: &engine::claude_history::ClaudeSessionScanDiagnostic,
) -> WorkspaceSessionCatalogDiagnostic {
    WorkspaceSessionCatalogDiagnostic {
        engine: "claude".to_string(),
        code: diagnostic.reason.clone(),
        reason: diagnostic.reason.clone(),
        session_id: diagnostic
            .session_id
            .as_ref()
            .map(|session_id| format!("claude:{session_id}")),
        physical_locator: redacted_physical_locator(&diagnostic.physical_path),
        cwd: diagnostic.cwd.clone(),
        candidate_count: None,
    }
}

pub(super) fn unresolved_catalog_entry_to_diagnostic(
    entry: &WorkspaceSessionCatalogEntry,
) -> WorkspaceSessionCatalogDiagnostic {
    WorkspaceSessionCatalogDiagnostic {
        engine: entry.engine.clone(),
        code: entry
            .attribution_reason
            .clone()
            .unwrap_or_else(|| "owner-unresolved".to_string()),
        reason: entry
            .attribution_reason
            .clone()
            .unwrap_or_else(|| "owner-unresolved".to_string()),
        session_id: Some(entry.session_id.clone()),
        physical_locator: entry
            .physical_path
            .as_deref()
            .and_then(redacted_physical_locator),
        cwd: entry.cwd.clone(),
        candidate_count: None,
    }
}

fn claude_cache_metrics_to_catalog(
    metrics: engine::claude_history::ClaudeSessionSourceFactCacheMetrics,
) -> Option<WorkspaceSessionSourceCacheMetrics> {
    let has_metrics = metrics.hits > 0
        || metrics.misses > 0
        || metrics.stale > 0
        || metrics.rebuilds > 0
        || metrics.failures > 0;
    if !has_metrics {
        return None;
    }
    Some(WorkspaceSessionSourceCacheMetrics {
        hits: metrics.hits,
        misses: metrics.misses,
        stale: metrics.stale,
        rebuilds: metrics.rebuilds,
        failures: metrics.failures,
    })
}

pub(super) fn build_claude_source_fact_status(
    result: &engine::claude_history::ClaudeSessionSourceFactList,
    scan_mode: SessionCatalogScanMode,
    extra_diagnostics: Vec<WorkspaceSessionCatalogDiagnostic>,
) -> WorkspaceSessionCatalogSourceStatus {
    let has_partial_fact = result
        .facts
        .iter()
        .any(|fact| fact.source_health.eq_ignore_ascii_case("partial"));
    let cache_failed = result.cache_metrics.failures > 0;
    let has_unreadable_diagnostic = result.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == engine::claude_history::ClaudeSessionScanDiagnosticCode::UnreadableFile
    });
    let has_skipped_source_diagnostic = result.skipped_candidates > 0;
    let completeness = if result.scan_cap_reached {
        WorkspaceSessionSourceCompleteness::Partial
    } else if has_unreadable_diagnostic || (cache_failed && result.facts.is_empty()) {
        WorkspaceSessionSourceCompleteness::Degraded
    } else if has_partial_fact || has_skipped_source_diagnostic {
        WorkspaceSessionSourceCompleteness::Partial
    } else if result.facts.is_empty() {
        WorkspaceSessionSourceCompleteness::UncertainEmpty
    } else {
        WorkspaceSessionSourceCompleteness::Complete
    };
    let reason = if result.scan_cap_reached {
        Some("claude-scan-cap-reached".to_string())
    } else if completeness == WorkspaceSessionSourceCompleteness::Degraded {
        Some("claude-source-degraded".to_string())
    } else if has_partial_fact || has_skipped_source_diagnostic {
        Some("claude-source-diagnostics".to_string())
    } else if result.facts.is_empty() {
        Some(SESSION_CATALOG_PARTIAL_CLAUDE_UNCERTAIN_EMPTY.to_string())
    } else if cache_failed {
        Some("claude-source-fact-cache-degraded".to_string())
    } else {
        None
    };
    let mut diagnostics = result
        .diagnostics
        .iter()
        .map(claude_scan_diagnostic_to_catalog)
        .collect::<Vec<_>>();
    diagnostics.extend(extra_diagnostics);
    WorkspaceSessionCatalogSourceStatus {
        engine: "claude".to_string(),
        source_kind: None,
        completeness,
        reason,
        scanned_candidates: Some(result.scanned_candidates),
        skipped_candidates: Some(result.skipped_candidates),
        scan_cap_reached: scan_cap_reached(result.scanned_candidates, scan_mode)
            .map(|cap| cap || result.scan_cap_reached),
        diagnostics,
        cache: claude_cache_metrics_to_catalog(result.cache_metrics.clone()),
    }
}
