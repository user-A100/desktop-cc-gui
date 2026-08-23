//! Qoder CLI auth: browser login stays with the selected distribution CLI;
//! each distribution keeps a separate 0600 PAT file in `~/.ccgui` and injects
//! only its matching environment variable on spawn.
//!
//! Qoder has no multi-provider API-key catalog. This file is one credential
//! (PAT) plus a masked status snapshot — not a copy of PI's auth.json CRUD.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tokio::process::Command;

use crate::app_paths;
use crate::engine::qoder_provider_profile::{
    qoder_distribution_from_provider_profile_id, QoderDistribution,
};
use crate::remote_backend;
use crate::state::AppState;

pub(crate) const QODER_PAT_ENV: &str = "QODER_PERSONAL_ACCESS_TOKEN";
pub(crate) const QODERCN_PAT_ENV: &str = "QODERCN_PERSONAL_ACCESS_TOKEN";
const GLOBAL_AUTH_FILE_NAME: &str = "qoder-auth.json";
const CN_AUTH_FILE_NAME: &str = "qoder-cn-auth.json";
const TOKEN_FIELD: &str = "personalAccessToken";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderAuthFileInfo {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderAuthStatus {
    pub distribution: &'static str,
    pub auth_file: QoderAuthFileInfo,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_key: Option<String>,
    pub env_var: &'static str,
}

fn mask_key(key: &str) -> String {
    if key.chars().count() > 10 {
        let head: String = key.chars().take(6).collect();
        let tail: String = key
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{head}········{tail}")
    } else {
        "········".to_string()
    }
}

fn auth_file_name(distribution: QoderDistribution) -> &'static str {
    match distribution {
        QoderDistribution::Global => GLOBAL_AUTH_FILE_NAME,
        QoderDistribution::Cn => CN_AUTH_FILE_NAME,
    }
}

fn pat_env_var(distribution: QoderDistribution) -> &'static str {
    match distribution {
        QoderDistribution::Global => QODER_PAT_ENV,
        QoderDistribution::Cn => QODERCN_PAT_ENV,
    }
}

fn other_distribution_pat_env_var(distribution: QoderDistribution) -> &'static str {
    match distribution {
        QoderDistribution::Global => QODERCN_PAT_ENV,
        QoderDistribution::Cn => QODER_PAT_ENV,
    }
}

fn distribution_label(distribution: QoderDistribution) -> &'static str {
    match distribution {
        QoderDistribution::Global => "global",
        QoderDistribution::Cn => "cn",
    }
}

pub(crate) fn resolve_qoder_auth_file_for_distribution(
    distribution: QoderDistribution,
) -> Result<PathBuf, String> {
    Ok(app_paths::app_home_dir()?.join(auth_file_name(distribution)))
}

/// Legacy callers are Qoder Global.
pub(crate) fn resolve_qoder_auth_file() -> Result<PathBuf, String> {
    resolve_qoder_auth_file_for_distribution(QoderDistribution::Global)
}

pub(crate) fn process_env_pat_for_distribution(distribution: QoderDistribution) -> Option<String> {
    std::env::var(pat_env_var(distribution))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Legacy callers are Qoder Global.
pub(crate) fn process_env_pat() -> Option<String> {
    process_env_pat_for_distribution(QoderDistribution::Global)
}

fn stored_pat_from_map(map: &Map<String, Value>) -> Option<String> {
    map.get(TOKEN_FIELD)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_auth_map_sync(path: &PathBuf) -> Result<Option<Map<String, Value>>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let value: Value = serde_json::from_str(&content).map_err(|error| {
                format!("[QODER_AUTH_CORRUPTED] qoder-auth.json 不是合法 JSON：{error}")
            })?;
            match value {
                Value::Object(map) => Ok(Some(map)),
                _ => Err("[QODER_AUTH_CORRUPTED] qoder-auth.json 根节点必须是对象".to_string()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "[QODER_AUTH_READ] 读取 {} 失败：{error}",
            path.display()
        )),
    }
}

async fn read_auth_map(path: &PathBuf) -> Result<Option<Map<String, Value>>, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            let value: Value = serde_json::from_str(&content).map_err(|error| {
                format!("[QODER_AUTH_CORRUPTED] qoder-auth.json 不是合法 JSON：{error}")
            })?;
            match value {
                Value::Object(map) => Ok(Some(map)),
                _ => Err("[QODER_AUTH_CORRUPTED] qoder-auth.json 根节点必须是对象".to_string()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "[QODER_AUTH_READ] 读取 {} 失败：{error}",
            path.display()
        )),
    }
}

async fn write_auth_map(path: &PathBuf, map: &Map<String, Value>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "[QODER_AUTH_WRITE] qoder-auth.json 路径无父目录".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("[QODER_AUTH_WRITE] 创建 {} 失败：{error}", parent.display()))?;

    // Global/CN share the app credential directory, so the temporary name must
    // remain scoped to the destination file as well. A shared temp name could
    // cross-wire two simultaneous saves before either atomic rename runs.
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "qoder-auth.json".into());
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
    let content = serde_json::to_string_pretty(&Value::Object(map.clone()))
        .map_err(|error| format!("[QODER_AUTH_WRITE] 序列化失败：{error}"))?;

    let write_result = async {
        tokio::fs::write(&tmp, format!("{content}\n"))
            .await
            .map_err(|error| format!("[QODER_AUTH_WRITE] 写入临时文件失败：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(|error| format!("[QODER_AUTH_WRITE] 设置 0600 权限失败：{error}"))?;
        }
        tokio::fs::rename(&tmp, path).await.map_err(|error| {
            format!("[QODER_AUTH_WRITE] 原子替换 qoder-auth.json 失败：{error}")
        })?;
        Ok::<(), String>(())
    }
    .await;

    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    write_result
}

/// Stored mossx PAT, if any. Does not inspect process env.
pub(crate) fn stored_qoder_pat_for_distribution_sync(
    distribution: QoderDistribution,
) -> Option<String> {
    let path = resolve_qoder_auth_file_for_distribution(distribution).ok()?;
    let map = read_auth_map_sync(&path).ok().flatten()?;
    stored_pat_from_map(&map)
}

/// Legacy callers are Qoder Global.
pub(crate) fn stored_qoder_pat_sync() -> Option<String> {
    stored_qoder_pat_for_distribution_sync(QoderDistribution::Global)
}

pub(crate) fn qoder_process_env_has_pat_for_distribution(distribution: QoderDistribution) -> bool {
    process_env_pat_for_distribution(distribution).is_some()
}

/// Legacy callers are Qoder Global.
pub(crate) fn qoder_process_env_has_pat() -> bool {
    qoder_process_env_has_pat_for_distribution(QoderDistribution::Global)
}

pub(crate) fn qoder_has_pat_credential_for_distribution(distribution: QoderDistribution) -> bool {
    qoder_process_env_has_pat_for_distribution(distribution)
        || stored_qoder_pat_for_distribution_sync(distribution).is_some()
}

/// Legacy callers are Qoder Global.
pub(crate) fn qoder_has_pat_credential() -> bool {
    qoder_has_pat_credential_for_distribution(QoderDistribution::Global)
}

/// PAT that should be injected into the selected distribution CLI. Skip when
/// the selected process env already has the variable so the child inherits it.
pub(crate) fn resolve_qoder_pat_for_spawn_for_distribution(
    distribution: QoderDistribution,
) -> Option<String> {
    if qoder_process_env_has_pat_for_distribution(distribution) {
        return None;
    }
    stored_qoder_pat_for_distribution_sync(distribution)
}

/// Legacy callers are Qoder Global.
pub(crate) fn resolve_qoder_pat_for_spawn() -> Option<String> {
    resolve_qoder_pat_for_spawn_for_distribution(QoderDistribution::Global)
}

pub(crate) fn apply_qoder_pat_env_for_distribution(
    cmd: &mut Command,
    distribution: QoderDistribution,
) {
    // Do not let a child for one distribution inherit the other distribution's
    // credential from the parent process environment.
    cmd.env_remove(other_distribution_pat_env_var(distribution));
    if let Some(pat) = resolve_qoder_pat_for_spawn_for_distribution(distribution) {
        cmd.env(pat_env_var(distribution), pat);
    }
}

/// Legacy callers are Qoder Global.
pub(crate) fn apply_qoder_pat_env(cmd: &mut Command) {
    apply_qoder_pat_env_for_distribution(cmd, QoderDistribution::Global)
}

pub async fn qoder_auth_status_from_path_for_distribution(
    path: PathBuf,
    distribution: QoderDistribution,
) -> Result<QoderAuthStatus, String> {
    let map = read_auth_map(&path).await?;
    let exists = map.is_some();
    let stored = map.as_ref().and_then(stored_pat_from_map);
    let env_active = process_env_pat_for_distribution(distribution).is_some();
    let (state, masked_key) = if let Some(key) = stored.as_deref() {
        ("configured", Some(mask_key(key)))
    } else if env_active {
        ("env", None)
    } else {
        ("none", None)
    };
    Ok(QoderAuthStatus {
        distribution: distribution_label(distribution),
        auth_file: QoderAuthFileInfo {
            path: path.to_string_lossy().to_string(),
            exists,
        },
        state,
        masked_key,
        env_var: pat_env_var(distribution),
    })
}

/// Legacy callers are Qoder Global.
pub async fn qoder_auth_status_from_path(path: PathBuf) -> Result<QoderAuthStatus, String> {
    qoder_auth_status_from_path_for_distribution(path, QoderDistribution::Global).await
}

pub async fn set_qoder_pat(path: &PathBuf, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("[QODER_AUTH_SET] PAT 不能为空".to_string());
    }
    let mut map = read_auth_map(path).await?.unwrap_or_default();
    map.insert(TOKEN_FIELD.to_string(), Value::String(trimmed.to_string()));
    write_auth_map(path, &map).await
}

pub async fn delete_qoder_pat(path: &PathBuf) -> Result<(), String> {
    let mut map = match read_auth_map(path).await? {
        Some(map) => map,
        None => return Ok(()),
    };
    map.remove(TOKEN_FIELD);
    if map.is_empty() {
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "[QODER_AUTH_DELETE] 删除 {} 失败：{error}",
                path.display()
            )),
        }
    } else {
        write_auth_map(path, &map).await
    }
}

#[tauri::command]
pub async fn qoder_auth_status(
    provider_profile_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "qoder_auth_status",
            serde_json::json!({ "providerProfileId": provider_profile_id }),
        )
        .await;
    }
    let distribution = qoder_distribution_from_provider_profile_id(provider_profile_id.as_deref())?;
    let path = resolve_qoder_auth_file_for_distribution(distribution)?;
    let result = qoder_auth_status_from_path_for_distribution(path, distribution).await?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn qoder_auth_set_pat(
    key: String,
    provider_profile_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "qoder_auth_set_pat",
            serde_json::json!({ "key": key, "providerProfileId": provider_profile_id }),
        )
        .await
        .map(|_| ());
    }
    let distribution = qoder_distribution_from_provider_profile_id(provider_profile_id.as_deref())?;
    let path = resolve_qoder_auth_file_for_distribution(distribution)?;
    set_qoder_pat(&path, &key).await
}

#[tauri::command]
pub async fn qoder_auth_delete_pat(
    provider_profile_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return remote_backend::call_remote(
            &*state,
            app,
            "qoder_auth_delete_pat",
            serde_json::json!({ "providerProfileId": provider_profile_id }),
        )
        .await
        .map(|_| ());
    }
    let distribution = qoder_distribution_from_provider_profile_id(provider_profile_id.as_deref())?;
    let path = resolve_qoder_auth_file_for_distribution(distribution)?;
    delete_qoder_pat(&path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_auth_file(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mossx-qoder-auth-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("qoder-auth.json")
    }

    #[test]
    fn mask_long_key_exposes_only_head_and_tail() {
        assert_eq!(
            mask_key("qoder_pat_abcdef1234567890xyz"),
            "qoder_········0xyz"
        );
    }

    #[test]
    fn mask_short_key_exposes_nothing() {
        assert_eq!(mask_key("short"), "········");
    }

    #[tokio::test]
    async fn missing_file_is_none_or_env() {
        let path = temp_auth_file("missing");
        let status = qoder_auth_status_from_path(path).await.unwrap();
        assert!(!status.auth_file.exists);
        assert!(status.state == "none" || status.state == "env");
        assert_eq!(status.env_var, QODER_PAT_ENV);
    }

    #[tokio::test]
    async fn set_then_list_masks_and_delete_clears() {
        let path = temp_auth_file("roundtrip");
        set_qoder_pat(&path, "  qoder_pat_abcdef1234567890xyz  ")
            .await
            .unwrap();
        let status = qoder_auth_status_from_path(path.clone()).await.unwrap();
        assert!(status.auth_file.exists);
        assert_eq!(status.state, "configured");
        assert_eq!(status.masked_key.as_deref(), Some("qoder_········0xyz"));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("qoder_pat_abcdef1234567890xyz"));
        assert!(!raw.contains("masked"));

        delete_qoder_pat(&path).await.unwrap();
        assert!(!path.exists());
        let status = qoder_auth_status_from_path(path).await.unwrap();
        assert_ne!(status.state, "configured");
        assert!(status.masked_key.is_none());
    }

    #[tokio::test]
    async fn global_and_cn_auth_files_are_independent() {
        let global_path = temp_auth_file("global-cn-global");
        let cn_path = global_path
            .parent()
            .expect("temp auth parent")
            .join("qoder-cn-auth.json");
        let (global_write, cn_write) = tokio::join!(
            set_qoder_pat(&global_path, "global-qoder-pat-123456"),
            set_qoder_pat(&cn_path, "cn-qoder-pat-123456"),
        );
        global_write.unwrap();
        cn_write.unwrap();

        let global = qoder_auth_status_from_path_for_distribution(
            global_path.clone(),
            QoderDistribution::Global,
        )
        .await
        .unwrap();
        let cn =
            qoder_auth_status_from_path_for_distribution(cn_path.clone(), QoderDistribution::Cn)
                .await
                .unwrap();
        assert_eq!(global.distribution, "global");
        assert_eq!(global.env_var, QODER_PAT_ENV);
        assert_eq!(cn.distribution, "cn");
        assert_eq!(cn.env_var, QODERCN_PAT_ENV);

        delete_qoder_pat(&cn_path).await.unwrap();
        assert!(global_path.exists());
        assert!(!cn_path.exists());
    }

    #[test]
    fn selected_distribution_removes_the_other_pat_environment() {
        use std::ffi::OsStr;

        let mut global = Command::new("qodercli");
        apply_qoder_pat_env_for_distribution(&mut global, QoderDistribution::Global);
        assert!(global
            .as_std()
            .get_envs()
            .any(|(name, value)| { name == OsStr::new(QODERCN_PAT_ENV) && value.is_none() }));

        let mut cn = Command::new("qoderclicn");
        apply_qoder_pat_env_for_distribution(&mut cn, QoderDistribution::Cn);
        assert!(cn
            .as_std()
            .get_envs()
            .any(|(name, value)| { name == OsStr::new(QODER_PAT_ENV) && value.is_none() }));
    }

    #[tokio::test]
    async fn corrupted_json_fails_closed() {
        let path = temp_auth_file("corrupt");
        std::fs::write(&path, "not-json").unwrap();
        let err = qoder_auth_status_from_path(path.clone()).await.unwrap_err();
        assert!(err.contains("QODER_AUTH_CORRUPTED"), "{err}");
        let err = set_qoder_pat(&path, "new-token-value-1234")
            .await
            .unwrap_err();
        assert!(err.contains("QODER_AUTH_CORRUPTED"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not-json");
    }

    #[tokio::test]
    async fn empty_pat_rejected() {
        let path = temp_auth_file("empty");
        let err = set_qoder_pat(&path, "   ").await.unwrap_err();
        assert!(err.contains("QODER_AUTH_SET"), "{err}");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn delete_preserves_unknown_fields() {
        let path = temp_auth_file("keep-unknown");
        std::fs::write(
            &path,
            r#"{"personalAccessToken":"qoder_pat_abcdef1234567890xyz","extra":1}"#,
        )
        .unwrap();
        delete_qoder_pat(&path).await.unwrap();
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(written.get("personalAccessToken").is_none());
        assert_eq!(written["extra"], 1);
    }
}
