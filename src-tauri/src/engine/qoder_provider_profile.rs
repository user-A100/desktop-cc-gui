//! Qoder distribution binding and launch configuration.
//!
//! Qoder Global (`qodercli`) and Qoder CN (`qoderclicn`) are separate CLI
//! distributions.  They intentionally share one engine type, but never share
//! a runtime key, config directory, binary, or PAT credential.

use std::path::{Path, PathBuf};

use crate::session_management::EngineProviderBinding;
use crate::types::AppSettings;

/// Historic local sentinel. Existing sessions without an explicit binding and
/// this sentinel both remain Qoder Global for backward compatibility.
pub(crate) const QODER_LOCAL_PROVIDER_PROFILE_ID: &str = "__local_qoder__";
pub(crate) const QODER_GLOBAL_PROVIDER_PROFILE_ID: &str = "__qoder_global__";
pub(crate) const QODER_CN_PROVIDER_PROFILE_ID: &str = "__qoder_cn__";
pub(crate) const QODER_NATIVE_SESSION_PREFIX: &str = "qoder:";

/// Durable UI / Index / Shared binding identity for one Qoder native session.
///
/// Qoder Global and Qoder CN have independent homes and runtimes, so their raw
/// ACP session ids are only unique within a distribution. New persisted values
/// must use `qoder:<profile>:<raw>`; `qoder:<raw>` remains a legacy input only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QoderNativeSessionIdentity {
    pub(crate) provider_profile_id: &'static str,
    pub(crate) raw_session_id: String,
    pub(crate) is_legacy: bool,
}

impl QoderNativeSessionIdentity {
    pub(crate) fn canonical_id(&self) -> String {
        format!(
            "{QODER_NATIVE_SESSION_PREFIX}{}:{}",
            self.provider_profile_id, self.raw_session_id
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QoderDistribution {
    Global,
    Cn,
}

impl QoderDistribution {
    pub(crate) fn provider_profile_id(self) -> &'static str {
        match self {
            Self::Global => QODER_GLOBAL_PROVIDER_PROFILE_ID,
            Self::Cn => QODER_CN_PROVIDER_PROFILE_ID,
        }
    }

    pub(crate) fn provider_profile_name(self) -> &'static str {
        match self {
            Self::Global => "Qoder Global",
            Self::Cn => "Qoder CN",
        }
    }

    pub(crate) fn runtime_segment(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Cn => "cn",
        }
    }

    pub(crate) fn cli_name(self) -> &'static str {
        match self {
            Self::Global => "qodercli",
            Self::Cn => "qoderclicn",
        }
    }

    pub(crate) fn config_dir_env_var(self) -> &'static str {
        match self {
            Self::Global => "QODER_CONFIG_DIR",
            Self::Cn => "QODERCN_CONFIG_DIR",
        }
    }

    pub(crate) fn default_config_dir_name(self) -> &'static str {
        match self {
            Self::Global => ".qoder",
            Self::Cn => ".qoder-cn",
        }
    }
}

/// Settings owned by the Qoder distribution boundary.  This is deliberately
/// not an `EngineConfig`: the latter describes one native engine, while Qoder
/// needs two independent launch identities under the same engine type.
#[derive(Debug, Clone, Default)]
pub(crate) struct QoderDistributionSettings {
    pub(crate) global_bin: Option<String>,
    pub(crate) cn_bin: Option<String>,
    pub(crate) global_config_dir: Option<String>,
    pub(crate) cn_config_dir: Option<String>,
}

impl QoderDistributionSettings {
    pub(crate) fn from_app_settings(settings: &AppSettings) -> Self {
        Self {
            global_bin: settings.qoder_bin.clone(),
            cn_bin: settings.qoder_cn_bin.clone(),
            global_config_dir: settings.qoder_config_dir.clone(),
            cn_config_dir: settings.qoder_cn_config_dir.clone(),
        }
    }

    fn bin_for(&self, distribution: QoderDistribution) -> Option<&str> {
        match distribution {
            QoderDistribution::Global => self.global_bin.as_deref(),
            QoderDistribution::Cn => self.cn_bin.as_deref(),
        }
    }

    fn config_dir_for(&self, distribution: QoderDistribution) -> Option<&Path> {
        let value = match distribution {
            QoderDistribution::Global => self.global_config_dir.as_deref(),
            QoderDistribution::Cn => self.cn_config_dir.as_deref(),
        }?
        .trim();
        (!value.is_empty()).then(|| Path::new(value))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct QoderProviderLaunchProfile {
    pub(crate) binding: Option<EngineProviderBinding>,
    pub(crate) distribution: QoderDistribution,
    pub(crate) bin_path: Option<String>,
    pub(crate) home_dir: Option<PathBuf>,
    pub(crate) runtime_key: String,
}

pub(crate) fn qoder_distribution_from_provider_profile_id(
    provider_profile_id: Option<&str>,
) -> Result<QoderDistribution, String> {
    match provider_profile_id.map(str::trim).filter(|value| !value.is_empty()) {
        None
        | Some(QODER_LOCAL_PROVIDER_PROFILE_ID)
        | Some(QODER_GLOBAL_PROVIDER_PROFILE_ID) => Ok(QoderDistribution::Global),
        Some(QODER_CN_PROVIDER_PROFILE_ID) => Ok(QoderDistribution::Cn),
        Some(profile_id) => Err(format!(
            "[QODER_DISTRIBUTION] 未知的 Qoder distribution profile `{profile_id}`；仅支持 Qoder Global 或 Qoder CN"
        )),
    }
}

/// Normalize the three accepted Qoder profile representations into the
/// durable distribution profile id. `None` / historic local sentinel remain
/// Global-compatible; unknown values must never silently route to Global.
pub(crate) fn qoder_canonical_provider_profile_id(
    provider_profile_id: Option<&str>,
) -> Result<&'static str, String> {
    Ok(qoder_distribution_from_provider_profile_id(provider_profile_id)?.provider_profile_id())
}

/// `__local_qoder__` is a compatibility sentinel, not a durable choice of
/// Global. Only these two ids may override a legacy raw session's binding.
pub(crate) fn has_explicit_qoder_distribution_owner(provider_profile_id: Option<&str>) -> bool {
    matches!(
        provider_profile_id.map(str::trim).filter(|value| !value.is_empty()),
        Some(QODER_GLOBAL_PROVIDER_PROFILE_ID | QODER_CN_PROVIDER_PROFILE_ID)
    )
}

/// Parse a Qoder identity at an external boundary.
///
/// Canonical identity carries its own distribution and must agree with an
/// optional owner/profile supplied by the caller. Legacy `qoder:<raw>` and raw
/// values use that owner when present, otherwise retain historic Global
/// semantics. This lets old persisted bindings with an explicit CN owner be
/// migrated correctly without guessing from raw ids alone.
pub(crate) fn parse_qoder_native_session_identity(
    value: &str,
    provider_profile_id: Option<&str>,
) -> Result<QoderNativeSessionIdentity, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("[QODER_SESSION_IDENTITY] Qoder session id is required".to_string());
    }
    let supplied_profile_id = provider_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let expected_profile = qoder_canonical_provider_profile_id(supplied_profile_id)?;
    let raw_or_prefixed = trimmed
        .strip_prefix(QODER_NATIVE_SESSION_PREFIX)
        .unwrap_or(trimmed)
        .trim();
    if raw_or_prefixed.is_empty() {
        return Err("[QODER_SESSION_IDENTITY] Qoder session id is required".to_string());
    }

    for profile_id in [
        QODER_GLOBAL_PROVIDER_PROFILE_ID,
        QODER_CN_PROVIDER_PROFILE_ID,
    ] {
        let canonical_prefix = format!("{profile_id}:");
        if let Some(raw_session_id) = raw_or_prefixed.strip_prefix(&canonical_prefix) {
            let raw_session_id = raw_session_id.trim();
            if raw_session_id.is_empty() {
                return Err("[QODER_SESSION_IDENTITY] Qoder raw session id is required".to_string());
            }
            // `__local_qoder__` is a historical non-distribution sentinel.
            // A profile-qualified identity is more precise and remains
            // authoritative when old state still carries that sentinel.
            if has_explicit_qoder_distribution_owner(supplied_profile_id)
                && expected_profile != profile_id
            {
                return Err(format!(
                    "[QODER_SESSION_IDENTITY] Qoder session profile `{profile_id}` does not match runtime owner `{expected_profile}`"
                ));
            }
            return Ok(QoderNativeSessionIdentity {
                provider_profile_id: profile_id,
                raw_session_id: raw_session_id.to_string(),
                is_legacy: false,
            });
        }
    }

    // A profile-looking segment is never a raw id. Reject it so a malformed
    // canonical identity cannot accidentally route through Global.
    if raw_or_prefixed.starts_with("__qoder_") && raw_or_prefixed.contains(':') {
        return Err(format!(
            "[QODER_SESSION_IDENTITY] unknown Qoder session profile in `{trimmed}`"
        ));
    }

    Ok(QoderNativeSessionIdentity {
        provider_profile_id: expected_profile,
        raw_session_id: raw_or_prefixed.to_string(),
        is_legacy: true,
    })
}

/// Canonicalize one Qoder external id for persistence and UI projection.
pub(crate) fn canonical_qoder_native_session_id(
    value: &str,
    provider_profile_id: Option<&str>,
) -> Result<String, String> {
    Ok(parse_qoder_native_session_identity(value, provider_profile_id)?.canonical_id())
}

/// Runtime key is a distribution boundary. Never use a shared workspace-only
/// key here: Global and CN may be open in the same workspace concurrently.
pub(crate) fn qoder_runtime_key(
    workspace_id: &str,
    provider_profile_id: Option<&str>,
) -> Result<String, String> {
    let distribution = qoder_distribution_from_provider_profile_id(provider_profile_id)?;
    Ok(format!(
        "{workspace_id}::qoder::{}",
        distribution.runtime_segment()
    ))
}

/// Recover a fixed Qoder distribution from the runtime-owner key. This is
/// intentionally suffix-based because workspace ids are opaque user data.
pub(crate) fn qoder_provider_profile_id_from_runtime_key(
    runtime_key: &str,
) -> Option<&'static str> {
    let runtime_key = runtime_key.trim();
    if runtime_key.ends_with("::qoder::global") {
        Some(QODER_GLOBAL_PROVIDER_PROFILE_ID)
    } else if runtime_key.ends_with("::qoder::cn") {
        Some(QODER_CN_PROVIDER_PROFILE_ID)
    } else {
        None
    }
}

fn configured_or_env_path(value: Option<&Path>, env_var: &str) -> Option<PathBuf> {
    if let Some(value) = value {
        let value = value.to_string_lossy();
        return crate::claude_home::normalize_home_path(&value);
    }
    std::env::var(env_var)
        .ok()
        .and_then(|value| crate::claude_home::normalize_home_path(&value))
}

/// Resolve one Qoder distribution config directory.
///
/// Global retains the old `QODER_HOME` environment variable only as a
/// compatibility fallback. New launches use the documented `QODER_CONFIG_DIR`.
pub(crate) fn resolve_qoder_distribution_home_dir(
    distribution: QoderDistribution,
    configured_home_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) =
        configured_or_env_path(configured_home_dir, distribution.config_dir_env_var())
    {
        return Some(path);
    }
    if distribution == QoderDistribution::Global {
        if let Some(path) = configured_or_env_path(None, "QODER_HOME") {
            return Some(path);
        }
    }
    dirs::home_dir().map(|home| home.join(distribution.default_config_dir_name()))
}

/// Compatibility shim for older call sites. New code must resolve a concrete
/// distribution before launching a process.
pub(crate) fn resolve_qoder_home_dir(home_dir: Option<&Path>) -> Option<PathBuf> {
    resolve_qoder_distribution_home_dir(QoderDistribution::Global, home_dir)
}

pub(crate) fn resolve_qoder_provider_launch_profile(
    workspace_id: &str,
    provider_profile_id: Option<&str>,
    settings: &QoderDistributionSettings,
) -> Result<QoderProviderLaunchProfile, String> {
    let distribution = qoder_distribution_from_provider_profile_id(provider_profile_id)?;
    let runtime_key = qoder_runtime_key(workspace_id, provider_profile_id)?;
    Ok(QoderProviderLaunchProfile {
        binding: Some(EngineProviderBinding {
            provider_profile_id: distribution.provider_profile_id().to_string(),
            // The source reuses the existing persisted profile transport. It is
            // not a provider CRUD record; it is a fixed distribution binding.
            provider_profile_source: "managed".to_string(),
            provider_profile_name: distribution.provider_profile_name().to_string(),
            provider_availability: "available".to_string(),
        }),
        distribution,
        bin_path: settings.bin_for(distribution).map(str::to_string),
        home_dir: resolve_qoder_distribution_home_dir(
            distribution,
            settings.config_dir_for(distribution),
        ),
        runtime_key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_profile_defaults_to_global_runtime() {
        let settings = QoderDistributionSettings::default();
        let profile =
            resolve_qoder_provider_launch_profile("ws-1", None, &settings).expect("profile");
        assert_eq!(profile.distribution, QoderDistribution::Global);
        assert_eq!(profile.runtime_key, "ws-1::qoder::global");
        assert_eq!(
            profile.binding.expect("binding").provider_profile_id,
            QODER_GLOBAL_PROVIDER_PROFILE_ID
        );
    }

    #[test]
    fn cn_profile_uses_its_own_runtime_and_settings() {
        let settings = QoderDistributionSettings {
            cn_bin: Some("/opt/qoderclicn".to_string()),
            cn_config_dir: Some("/tmp/qoder-cn".to_string()),
            ..Default::default()
        };
        let profile = resolve_qoder_provider_launch_profile(
            "ws-1",
            Some(QODER_CN_PROVIDER_PROFILE_ID),
            &settings,
        )
        .expect("profile");
        assert_eq!(profile.distribution, QoderDistribution::Cn);
        assert_eq!(profile.runtime_key, "ws-1::qoder::cn");
        assert_eq!(profile.bin_path.as_deref(), Some("/opt/qoderclicn"));
        assert_eq!(profile.home_dir, Some(PathBuf::from("/tmp/qoder-cn")));
    }

    #[test]
    fn unknown_profile_fails_closed() {
        let error = qoder_distribution_from_provider_profile_id(Some("unknown"))
            .expect_err("unknown profile must not launch Global silently");
        assert!(error.contains("QODER_DISTRIBUTION"));
    }

    #[test]
    fn canonical_qoder_native_session_identity_keeps_global_and_cn_separate() {
        let global = canonical_qoder_native_session_id(
            "same-raw-session",
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID),
        )
        .expect("Global identity");
        let cn = canonical_qoder_native_session_id(
            "same-raw-session",
            Some(QODER_CN_PROVIDER_PROFILE_ID),
        )
        .expect("CN identity");

        assert_eq!(global, "qoder:__qoder_global__:same-raw-session");
        assert_eq!(cn, "qoder:__qoder_cn__:same-raw-session");
        assert_ne!(global, cn);
    }

    #[test]
    fn legacy_qoder_identity_uses_its_durable_owner_when_available() {
        let cn = parse_qoder_native_session_identity(
            "qoder:legacy-session",
            Some(QODER_CN_PROVIDER_PROFILE_ID),
        )
        .expect("legacy CN binding");
        assert!(cn.is_legacy);
        assert_eq!(cn.provider_profile_id, QODER_CN_PROVIDER_PROFILE_ID);
        assert_eq!(cn.canonical_id(), "qoder:__qoder_cn__:legacy-session");

        let global = parse_qoder_native_session_identity("qoder:legacy-session", None)
            .expect("legacy Global binding");
        assert_eq!(global.provider_profile_id, QODER_GLOBAL_PROVIDER_PROFILE_ID);
    }

    #[test]
    fn canonical_qoder_identity_rejects_cross_distribution_runtime_owner() {
        let error = parse_qoder_native_session_identity(
            "qoder:__qoder_cn__:same-raw-session",
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID),
        )
        .expect_err("CN identity must not route through Global runtime");
        assert!(error.contains("does not match runtime owner"));
    }

    #[test]
    fn canonical_qoder_identity_overrides_the_legacy_local_sentinel() {
        let identity = parse_qoder_native_session_identity(
            "qoder:__qoder_cn__:same-raw-session",
            Some(QODER_LOCAL_PROVIDER_PROFILE_ID),
        )
        .expect("canonical CN identity must override the legacy local sentinel");
        assert_eq!(identity.provider_profile_id, QODER_CN_PROVIDER_PROFILE_ID);

        let blank_identity = parse_qoder_native_session_identity(
            "qoder:__qoder_cn__:same-raw-session",
            Some(""),
        )
        .expect("blank owner must behave as missing legacy owner");
        assert_eq!(blank_identity.provider_profile_id, QODER_CN_PROVIDER_PROFILE_ID);
    }

    #[test]
    fn runtime_key_recovers_distribution_without_parsing_workspace_id() {
        assert_eq!(
            qoder_provider_profile_id_from_runtime_key("workspace:with:colon::qoder::global"),
            Some(QODER_GLOBAL_PROVIDER_PROFILE_ID)
        );
        assert_eq!(
            qoder_provider_profile_id_from_runtime_key("workspace-1::qoder::cn"),
            Some(QODER_CN_PROVIDER_PROFILE_ID)
        );
        assert_eq!(
            qoder_provider_profile_id_from_runtime_key("workspace-1::qoder::unknown"),
            None
        );
    }

    #[test]
    fn configured_tilde_config_directory_expands_to_user_home() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let resolved = resolve_qoder_distribution_home_dir(
            QoderDistribution::Cn,
            Some(Path::new("~/.qoder-cn-isolated")),
        );
        assert_eq!(resolved, Some(home.join(".qoder-cn-isolated")));
    }
}
