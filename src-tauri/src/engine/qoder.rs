//! Qoder CLI engine implementation
//!
//! Headless protocol (spike-verified on qodercli 1.1.27):
//! `qodercli --acp` — NDJSON JSON-RPC 2.0 over stdin/stdout (ACP v1).
//!
//! Spawn-per-turn: initialize → session/resume|session/new → optional
//! set_model / set_config_option → session/set_mode bypassPermissions →
//! session/prompt. The prompt JSON-RPC response is the typed terminal;
//! killing the child is cleanup, not settlement.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio::time::timeout;

use super::events::EngineEvent;
use super::qoder_provider_profile::QoderDistribution;
use super::{EngineConfig, EngineType, ModelInfo, SendMessageParams};

const QODER_CLI_NAME: &str = "qodercli";
const QODERCN_CLI_NAME: &str = "qoderclicn";
const QODER_IDE_LAUNCHER_NAME: &str = "qoder";
const ACP_PROTOCOL_VERSION: u32 = 1;
const QODER_POST_TERMINAL_DRAIN: Duration = Duration::from_millis(250);
const QODER_STDERR_JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// `session/cancel` 通常会立即产生 typed prompt response；在 fallback kill
/// 卡死的 qodercli 前，先保留 ACP reader 等待该 response。
const QODER_CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const QODER_RPC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// session/new scans the workspace on first contact (measured 30.1s in a large
/// repo, 0.1s in /tmp; see mossx-qoder-capability-spike latency table), so the
/// setup call needs far more headroom than the generic RPC handshake.
const QODER_SESSION_NEW_TIMEOUT: Duration = Duration::from_secs(90);
/// session/resume re-attaches without the workspace scan (measured 0.1s).
const QODER_SESSION_RESUME_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const QODER_LIST_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const QODER_DELETE_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const QODER_LOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const QODER_DOCTOR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// qodercli 1.1.28 会把 `session/load` / `session/prompt` 的 JSON-RPC response
/// 插在 `session/update` 流中间（实测：第一条 user chunk 之后立刻回 result，
/// thought / tool_call / 最终正文在 response 之后才到）。request 必须在
/// response 之后继续读到 idle，否则历史截断、实时少最后一段。
const QODER_PROMPT_TRAILING_IDLE: Duration = Duration::from_millis(400);
const QODER_LOAD_TRAILING_IDLE: Duration = Duration::from_millis(1000);
const QODER_PROMPT_TRAILING_CAP: Duration = Duration::from_secs(2);
const QODER_LOAD_TRAILING_CAP: Duration = Duration::from_secs(15);
const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
const JSONRPC_INVALID_PARAMS: i64 = -32602;
const JSONRPC_INTERNAL_ERROR: i64 = -32603;

pub fn resolve_qoder_session_id_for_engine_send(
    continue_session: bool,
    explicit_session_id: Option<String>,
    tracked_session_id: Option<String>,
    provider_profile_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(session_id) = continue_session
        .then(|| explicit_session_id.or(tracked_session_id))
        .flatten()
    else {
        return Ok(None);
    };
    Ok(Some(
        super::qoder_provider_profile::parse_qoder_native_session_identity(
            &session_id,
            provider_profile_id,
        )?
        .raw_session_id,
    ))
}

pub(crate) fn normalize_qoder_fork_session_id(
    value: Option<&str>,
    provider_profile_id: Option<&str>,
) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Err("forkSessionId is required for Qoder fork session".to_string())
            } else {
                Ok(Some(
                    super::qoder_provider_profile::parse_qoder_native_session_identity(
                        trimmed,
                        provider_profile_id,
                    )?
                    .raw_session_id,
                ))
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct QoderTurnEvent {
    pub turn_id: String,
    pub event: EngineEvent,
}

/// Qoder session for a workspace (one ACP process per turn).
pub struct QoderSession {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    session_id: RwLock<Option<String>>,
    event_sender: broadcast::Sender<QoderTurnEvent>,
    bin_path: Option<String>,
    home_dir: Option<String>,
    custom_args: Option<String>,
    distribution: QoderDistribution,
    active_processes: Mutex<HashMap<String, ActiveQoderChildProcess>>,
    cancel_requested_turns: Mutex<HashSet<String>>,
    forced_cancelled_turns: Mutex<HashSet<String>>,
}

#[allow(dead_code)]
pub struct QoderActiveProcessSnapshot {
    pub pid: u32,
    pub registered_age_ms: u64,
}

struct ActiveQoderChildProcess {
    child: Child,
    stdin: std::sync::Arc<Mutex<Option<ChildStdin>>>,
    acp_session_id: Option<String>,
    #[allow(dead_code)]
    started_at_ms: u64,
}

impl ActiveQoderChildProcess {
    fn new(child: Child, stdin: std::sync::Arc<Mutex<Option<ChildStdin>>>) -> Self {
        Self {
            child,
            stdin,
            acp_session_id: None,
            started_at_ms: unix_timestamp_ms_for_process_diagnostics(),
        }
    }

    fn into_child(self) -> Child {
        self.child
    }

    #[allow(dead_code)]
    fn snapshot(&self, sampled_at_ms: u64) -> Option<QoderActiveProcessSnapshot> {
        Some(QoderActiveProcessSnapshot {
            pid: self.child.id()?,
            registered_age_ms: sampled_at_ms.saturating_sub(self.started_at_ms),
        })
    }
}

fn unix_timestamp_ms_for_process_diagnostics() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Parsed representation of one ACP NDJSON line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AcpLine {
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<AcpRpcError>,
    },
    Notification {
        method: String,
        params: Value,
    },
    AgentRequest {
        id: Value,
        method: String,
        params: Value,
    },
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AcpRpcError {
    pub code: i64,
    pub message: String,
}

fn jsonrpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

pub(crate) fn parse_acp_line(value: &Value) -> AcpLine {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        && value.get("method").is_none()
        && value.get("id").is_none()
    {
        return AcpLine::Other;
    }
    let method = value.get("method").and_then(Value::as_str);
    let id = value.get("id").cloned().filter(|id| !id.is_null());
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = method {
        if let Some(id) = id {
            return AcpLine::AgentRequest {
                id,
                method: method.to_string(),
                params,
            };
        }
        return AcpLine::Notification {
            method: method.to_string(),
            params,
        };
    }
    if let Some(id) = id {
        let error = value.get("error").and_then(|err| {
            let code = err
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or(JSONRPC_INTERNAL_ERROR);
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("JSON-RPC error")
                .to_string();
            Some(AcpRpcError { code, message })
        });
        return AcpLine::Response {
            id,
            result: value.get("result").cloned(),
            error,
        };
    }
    AcpLine::Other
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum QoderSessionUpdate {
    AgentMessageChunk {
        text: String,
    },
    AgentThoughtChunk {
        text: String,
    },
    ToolStarted {
        tool_id: String,
        tool_name: String,
        input: Option<Value>,
    },
    ToolCompleted {
        tool_id: String,
        tool_name: Option<String>,
        output: Option<Value>,
        error: Option<String>,
    },
    Ignore,
}

pub(crate) fn extract_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(thinking) = content.get("thinking").and_then(Value::as_str) {
        return thinking.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
                    .or_else(|| {
                        part.get("thinking")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        let nested = extract_content_text(part.get("content"));
                        if nested.is_empty() {
                            None
                        } else {
                            Some(nested)
                        }
                    })
            })
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

pub(crate) fn extract_qoder_tool_call_id(update: &Value) -> Option<String> {
    update
        .get("toolCallId")
        .or_else(|| update.get("toolCallID"))
        .or_else(|| update.get("tool_call_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn extract_qoder_tool_name(update: &Value) -> Option<String> {
    update
        .get("_meta")
        .and_then(|meta| meta.get("qoder"))
        .and_then(|qoder| qoder.get("toolName"))
        .and_then(Value::as_str)
        .or_else(|| update.get("title").and_then(Value::as_str))
        .or_else(|| update.get("kind").and_then(Value::as_str))
        .or_else(|| update.get("name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn extract_qoder_tool_content_text(update: &Value) -> String {
    let from_blocks = extract_content_text(update.get("content"));
    if !from_blocks.trim().is_empty() {
        return from_blocks;
    }
    let from_raw = extract_content_text(update.get("rawOutput"));
    if !from_raw.trim().is_empty() {
        return from_raw;
    }
    extract_content_text(update.get("output"))
}

pub(crate) fn acp_method_drains_trailing_updates(method: &str) -> bool {
    matches!(method, "session/load" | "session/prompt")
}

fn trailing_update_idle_timeout(method: &str) -> Duration {
    match method {
        "session/load" => QODER_LOAD_TRAILING_IDLE,
        "session/prompt" => QODER_PROMPT_TRAILING_IDLE,
        _ => Duration::ZERO,
    }
}

fn trailing_update_drain_cap(method: &str) -> Duration {
    match method {
        "session/load" => QODER_LOAD_TRAILING_CAP,
        "session/prompt" => QODER_PROMPT_TRAILING_CAP,
        _ => Duration::ZERO,
    }
}

pub(crate) fn is_error_prefixed_text(text: &str) -> bool {
    text.trim_start().starts_with("[Error]")
}

pub(crate) fn map_session_update(update: &Value) -> QoderSessionUpdate {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                QoderSessionUpdate::Ignore
            } else {
                QoderSessionUpdate::AgentMessageChunk { text }
            }
        }
        "agent_thought_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                QoderSessionUpdate::Ignore
            } else {
                QoderSessionUpdate::AgentThoughtChunk { text }
            }
        }
        "tool_call" => {
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            let Some(tool_id) = extract_qoder_tool_call_id(update) else {
                return QoderSessionUpdate::Ignore;
            };
            let tool_name = extract_qoder_tool_name(update).unwrap_or_else(|| "tool".to_string());
            let input = update
                .get("rawInput")
                .cloned()
                .or_else(|| update.get("input").cloned());
            // session/load 回放把 tool 压成一条 status=completed 的 tool_call
            // snapshot（qodercli 1.1.28 实测）。不能只认 pending，否则历史
            // 和部分 live 路径会把工具块整段丢掉。
            if status == "completed" || status == "failed" {
                let output = update
                    .get("rawOutput")
                    .cloned()
                    .or_else(|| update.get("output").cloned())
                    .or_else(|| update.get("content").cloned());
                let error = if status == "failed" {
                    Some(extract_qoder_tool_content_text(update))
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                } else {
                    None
                };
                return QoderSessionUpdate::ToolCompleted {
                    tool_id,
                    tool_name: Some(tool_name),
                    output,
                    error,
                };
            }
            if status != "pending" && status != "in_progress" {
                return QoderSessionUpdate::Ignore;
            }
            QoderSessionUpdate::ToolStarted {
                tool_id,
                tool_name,
                input,
            }
        }
        "tool_call_update" => {
            let status = update.get("status").and_then(Value::as_str).unwrap_or("");
            if status != "completed" && status != "failed" {
                return QoderSessionUpdate::Ignore;
            }
            let Some(tool_id) = extract_qoder_tool_call_id(update) else {
                return QoderSessionUpdate::Ignore;
            };
            let tool_name = extract_qoder_tool_name(update);
            let output = update
                .get("rawOutput")
                .cloned()
                .or_else(|| update.get("output").cloned())
                .or_else(|| update.get("content").cloned());
            let error = if status == "failed" {
                Some(extract_qoder_tool_content_text(update))
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            } else {
                None
            };
            QoderSessionUpdate::ToolCompleted {
                tool_id,
                tool_name,
                output,
                error,
            }
        }
        "plan" | "available_commands_update" | "config_option_update" | "user_message_chunk" => {
            QoderSessionUpdate::Ignore
        }
        _ => QoderSessionUpdate::Ignore,
    }
}

pub(crate) fn session_update_from_notification(params: &Value) -> QoderSessionUpdate {
    let update = params.get("update").unwrap_or(params);
    map_session_update(update)
}

pub(crate) fn permission_auto_answer(params: &Value) -> Result<Value, String> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "session/request_permission missing options".to_string())?;
    let option = options.iter().find(|option| {
        option
            .get("kind")
            .and_then(Value::as_str)
            .map(|kind| kind.to_ascii_lowercase().starts_with("allow"))
            .unwrap_or(false)
    });
    let option_id = option
        .and_then(|option| {
            option
                .get("optionId")
                .or_else(|| option.get("option_id"))
                .or_else(|| option.get("id"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| "session/request_permission has no allow* option".to_string())?;
    Ok(json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    }))
}

fn jsonrpc_error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn jsonrpc_result_response(id: &Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

pub(crate) fn confine_path_to_workspace(
    workspace_root: &Path,
    requested: &str,
    for_write: bool,
) -> Result<PathBuf, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = PathBuf::from(requested);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };
    let root = std::fs::canonicalize(workspace_root).unwrap_or_else(|_| {
        if workspace_root.is_absolute() {
            workspace_root.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(workspace_root)
        }
    });
    let resolved = if for_write && !absolute.exists() {
        let parent = absolute.parent().unwrap_or(workspace_root);
        let file_name = absolute
            .file_name()
            .ok_or_else(|| "invalid path".to_string())?;
        let parent_real = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        parent_real.join(file_name)
    } else {
        std::fs::canonicalize(&absolute).unwrap_or(absolute.clone())
    };
    if resolved == root || resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(format!(
            "path '{}' escapes workspace root '{}'",
            requested,
            root.display()
        ))
    }
}

fn handle_fs_read(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/read_text_file missing path".to_string())?;
    let confined = confine_path_to_workspace(workspace_root, path, false)?;
    let content = std::fs::read_to_string(&confined).map_err(|error| error.to_string())?;
    Ok(json!({ "content": content }))
}

fn handle_fs_write(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/write_text_file missing path".to_string())?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "fs/write_text_file missing content".to_string())?;
    let confined = confine_path_to_workspace(workspace_root, path, true)?;
    if let Some(parent) = confined.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&confined, content).map_err(|error| error.to_string())?;
    Ok(json!({}))
}

pub(crate) fn answer_agent_request(
    workspace_root: &Path,
    id: &Value,
    method: &str,
    params: &Value,
) -> Value {
    match method {
        "session/request_permission" => match permission_auto_answer(params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        "fs/read_text_file" => match handle_fs_read(workspace_root, params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        "fs/write_text_file" => match handle_fs_write(workspace_root, params) {
            Ok(result) => jsonrpc_result_response(id, result),
            Err(message) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &message),
        },
        _ => jsonrpc_error_response(id, JSONRPC_METHOD_NOT_FOUND, "Method not found"),
    }
}

fn mime_type_for_image_path(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub(crate) fn assemble_prompt_blocks(
    text: &str,
    images: Option<&[String]>,
    workspace_path: &Path,
) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    blocks.push(json!({
        "type": "text",
        "text": text,
    }));
    let image_files =
        crate::engine::cli_image_input::resolve_existing_image_files(images, workspace_path)?;
    for path in image_files {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("failed to read image {}: {error}", path.display()))?;
        let mime = mime_type_for_image_path(&path).unwrap_or("image/png");
        blocks.push(json!({
            "type": "image",
            "data": BASE64_STANDARD.encode(bytes),
            "mimeType": mime,
        }));
    }
    Ok(blocks)
}

pub(crate) fn binary_file_stem(bin: &str) -> String {
    Path::new(bin.trim())
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(bin.trim())
        .to_ascii_lowercase()
}

pub(crate) fn is_qoder_ide_launcher_bin(bin: &str) -> bool {
    binary_file_stem(bin) == QODER_IDE_LAUNCHER_NAME
}

pub(crate) fn resolve_qodercli_bin(custom_bin: Option<&str>) -> Result<String, String> {
    resolve_qoder_distribution_bin(QoderDistribution::Global, custom_bin)
}

pub(crate) fn resolve_qoder_distribution_bin(
    distribution: QoderDistribution,
    custom_bin: Option<&str>,
) -> Result<String, String> {
    if let Some(custom) = custom_bin.map(str::trim).filter(|value| !value.is_empty()) {
        if is_qoder_ide_launcher_bin(custom) {
            return Err(format!(
                "{} must point to {}, not the Qoder IDE launcher (`qoder`)",
                match distribution {
                    QoderDistribution::Global => "qoderBin",
                    QoderDistribution::Cn => "qoderCnBin",
                },
                distribution.cli_name()
            ));
        }
        return Ok(custom.to_string());
    }
    let cli_name = match distribution {
        QoderDistribution::Global => QODER_CLI_NAME,
        QoderDistribution::Cn => QODERCN_CLI_NAME,
    };
    Ok(crate::backend::app_server::find_cli_binary(cli_name, None)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| cli_name.to_string()))
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": ACP_PROTOCOL_VERSION,
        "clientInfo": {
            "name": "mossx",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {
            "fs": {
                "readTextFile": true,
                "writeTextFile": true,
            }
        }
    })
}

fn extract_session_id(value: &Value) -> Option<String> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn parse_qoder_models_from_session_new(result: &Value) -> Vec<ModelInfo> {
    let models_node = result.get("models").unwrap_or(result);
    let current = models_node
        .get("currentModelId")
        .or_else(|| models_node.get("current_model_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut reasoning_efforts = Vec::new();
    let mut default_effort = None;
    if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
        for option in options {
            let id = option
                .get("configId")
                .or_else(|| option.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if id != "reasoning_effort" {
                continue;
            }
            default_effort = option
                .get("value")
                .or_else(|| option.get("currentValue"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(choices) = option.get("options").and_then(Value::as_array) {
                for choice in choices {
                    let value = choice
                        .get("value")
                        .or_else(|| choice.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !value.is_empty() && !reasoning_efforts.contains(&value) {
                        reasoning_efforts.push(value);
                    }
                }
            }
        }
    }
    let available = models_node
        .get("availableModels")
        .or_else(|| models_node.get("available_models"))
        .and_then(Value::as_array);
    let mut models = Vec::new();
    if let Some(available) = available {
        for entry in available {
            let id = entry
                .get("modelId")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if id.is_empty() {
                continue;
            }
            let name = entry
                .get("name")
                .or_else(|| entry.get("displayName"))
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let mut info = ModelInfo::new(id.clone(), name)
                .with_provider("qoder")
                .with_protocol("acp")
                .with_provenance("cli:qoder-acp")
                .with_source("detected");
            if !reasoning_efforts.is_empty() || default_effort.is_some() {
                info = info.with_reasoning(reasoning_efforts.clone(), default_effort.clone());
            }
            if current.as_deref() == Some(id.as_str()) {
                info = info.as_default();
            }
            models.push(info);
        }
    }
    if let Some(first) = models.first_mut() {
        if current.is_none() {
            first.default = true;
        }
    }
    models
}

pub(crate) fn jsonrpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

pub(crate) fn jsonrpc_notification(method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
}

pub(crate) fn encode_ndjson(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(crate) fn spawn_qoder_command(
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    custom_args: Option<&str>,
) -> Result<Command, String> {
    spawn_qoder_command_for_distribution(
        QoderDistribution::Global,
        custom_bin,
        workspace_path,
        home_dir,
        custom_args,
    )
}

pub(crate) fn spawn_qoder_command_for_distribution(
    distribution: QoderDistribution,
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    custom_args: Option<&str>,
) -> Result<Command, String> {
    let bin = resolve_qoder_distribution_bin(distribution, custom_bin)?;
    if is_qoder_ide_launcher_bin(&bin) {
        return Err(format!(
            "{} must point to {}, not the Qoder IDE launcher (`qoder`)",
            match distribution {
                QoderDistribution::Global => "qoderBin",
                QoderDistribution::Cn => "qoderCnBin",
            },
            distribution.cli_name()
        ));
    }
    let mut cmd = crate::backend::app_server::build_command_for_binary(&bin);
    cmd.current_dir(workspace_path);
    if let Some(args) = custom_args {
        for arg in args.split_whitespace() {
            if arg == "--acp" {
                continue;
            }
            cmd.arg(arg);
        }
    }
    cmd.arg("--acp");
    if let Some(home) = home_dir.map(str::trim).filter(|value| !value.is_empty()) {
        cmd.env(distribution.config_dir_env_var(), home);
        cmd.arg("--config-dir");
        cmd.arg(home);
    }
    crate::engine::qoder_auth::apply_qoder_pat_env_for_distribution(&mut cmd, distribution);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    Ok(cmd)
}

pub(crate) struct QoderAcpProcess {
    stdin: std::sync::Arc<Mutex<Option<ChildStdin>>>,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: u64,
    workspace_root: PathBuf,
    pub collected_updates: Vec<Value>,
}

impl QoderAcpProcess {
    fn new(
        stdin: std::sync::Arc<Mutex<Option<ChildStdin>>>,
        stdout: tokio::process::ChildStdout,
        workspace_root: PathBuf,
    ) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
            workspace_root,
            collected_updates: Vec::new(),
        }
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let bytes = encode_ndjson(value)?;
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "Qoder ACP stdin is closed".to_string())?;
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("failed to write ACP request: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush ACP request: {error}"))?;
        Ok(())
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&jsonrpc_notification(method, params)).await
    }

    pub async fn initialize(&mut self) -> Result<Value, String> {
        self.request(
            "initialize",
            initialize_params(),
            QODER_RPC_HANDSHAKE_TIMEOUT,
        )
        .await
    }

    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
    ) -> Result<Value, String> {
        self.request_with_updates(method, params, timeout_dur, |_| {})
            .await
    }

    pub async fn request_with_updates<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
        mut on_update: F,
    ) -> Result<Value, String>
    where
        F: FnMut(Value),
    {
        let id = self.next_id;
        self.next_id += 1;
        let expected_key = id.to_string();
        self.write_line(&jsonrpc_request(id, method, params))
            .await?;
        let deadline = tokio::time::Instant::now() + timeout_dur;
        let drain_trailing = acp_method_drains_trailing_updates(method);
        let idle = trailing_update_idle_timeout(method);
        let drain_cap = trailing_update_drain_cap(method);
        let mut settled: Option<Value> = None;
        let mut drain_deadline: Option<tokio::time::Instant> = None;
        loop {
            let wait = if settled.is_some() {
                let cap_remaining = drain_deadline
                    .map(|until| until.saturating_duration_since(tokio::time::Instant::now()))
                    .unwrap_or(idle);
                if cap_remaining.is_zero() {
                    return Ok(settled.take().unwrap_or(Value::Null));
                }
                idle.min(cap_remaining)
            } else {
                deadline.saturating_duration_since(tokio::time::Instant::now())
            };
            if wait.is_zero() {
                return match settled.take() {
                    Some(result) => Ok(result),
                    None => Err(format!("{method} timed out")),
                };
            }
            let line = match timeout(wait, self.stdout.next_line()).await {
                Ok(Ok(Some(line))) => line,
                Ok(Ok(None)) => {
                    return match settled.take() {
                        Some(result) => Ok(result),
                        None => Err(format!("{method} ended: ACP stdout closed")),
                    };
                }
                Ok(Err(error)) => {
                    return match settled.take() {
                        Some(result) => Ok(result),
                        None => Err(format!("{method} stdout error: {error}")),
                    };
                }
                Err(_) => {
                    return match settled.take() {
                        Some(result) => Ok(result),
                        None => Err(format!("{method} timed out")),
                    };
                }
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let value = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            match parse_acp_line(&value) {
                AcpLine::Response {
                    id: response_id,
                    result,
                    error,
                } => {
                    if jsonrpc_id_key(&response_id).as_deref() != Some(expected_key.as_str()) {
                        continue;
                    }
                    if let Some(error) = error {
                        return Err(format!(
                            "rpc:{code}:{message}",
                            code = error.code,
                            message = error.message
                        ));
                    }
                    let result = result.unwrap_or(Value::Null);
                    if !drain_trailing {
                        return Ok(result);
                    }
                    settled = Some(result);
                    drain_deadline = Some(tokio::time::Instant::now() + drain_cap);
                }
                AcpLine::Notification {
                    method: notif_method,
                    params,
                } => {
                    if notif_method == "session/update" {
                        self.collected_updates.push(params.clone());
                        on_update(params);
                    }
                }
                AcpLine::AgentRequest {
                    id: request_id,
                    method: request_method,
                    params,
                } => {
                    let response = answer_agent_request(
                        &self.workspace_root,
                        &request_id,
                        &request_method,
                        &params,
                    );
                    self.write_line(&response).await?;
                }
                AcpLine::Other => {}
            }
        }
    }
}

fn spawn_stderr_collector(stderr: tokio::process::ChildStderr) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut text = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            text.push_str(&line);
            text.push('\n');
        }
        text
    })
}

pub(crate) async fn spawn_qoder_acp_process(
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    custom_args: Option<&str>,
) -> Result<
    (
        Child,
        QoderAcpProcess,
        tokio::task::JoinHandle<String>,
        std::sync::Arc<Mutex<Option<ChildStdin>>>,
    ),
    String,
> {
    spawn_qoder_acp_process_for_distribution(
        QoderDistribution::Global,
        custom_bin,
        workspace_path,
        home_dir,
        custom_args,
    )
    .await
}

pub(crate) async fn spawn_qoder_acp_process_for_distribution(
    distribution: QoderDistribution,
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    custom_args: Option<&str>,
) -> Result<
    (
        Child,
        QoderAcpProcess,
        tokio::task::JoinHandle<String>,
        std::sync::Arc<Mutex<Option<ChildStdin>>>,
    ),
    String,
> {
    let mut command = spawn_qoder_command_for_distribution(
        distribution,
        custom_bin,
        workspace_path,
        home_dir,
        custom_args,
    )?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn qodercli: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;
    let stdin = std::sync::Arc::new(Mutex::new(Some(stdin)));
    let process = QoderAcpProcess::new(stdin.clone(), stdout, workspace_path.to_path_buf());
    Ok((child, process, spawn_stderr_collector(stderr), stdin))
}

pub(crate) async fn run_qoder_acp_initialized<T, F>(
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    timeout_dur: Duration,
    body: F,
) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut QoderAcpProcess,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    run_qoder_acp_initialized_for_distribution(
        QoderDistribution::Global,
        custom_bin,
        workspace_path,
        home_dir,
        timeout_dur,
        body,
    )
    .await
}

pub(crate) async fn run_qoder_acp_initialized_for_distribution<T, F>(
    distribution: QoderDistribution,
    custom_bin: Option<&str>,
    workspace_path: &Path,
    home_dir: Option<&str>,
    timeout_dur: Duration,
    body: F,
) -> Result<T, String>
where
    F: for<'a> FnOnce(
        &'a mut QoderAcpProcess,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>,
    >,
{
    let (mut child, mut acp, stderr_task, _stdin) = spawn_qoder_acp_process_for_distribution(
        distribution,
        custom_bin,
        workspace_path,
        home_dir,
        None,
    )
    .await?;
    let outcome = async {
        acp.initialize().await?;
        body(&mut acp).await
    };
    let result = timeout(timeout_dur, outcome).await;
    let _ = child.kill().await;
    let _ = timeout(QODER_POST_TERMINAL_DRAIN, child.wait()).await;
    let _ = timeout(QODER_STDERR_JOIN_TIMEOUT, stderr_task).await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("Qoder ACP call timed out".to_string()),
    }
}

fn parse_rpc_error_code(message: &str) -> Option<String> {
    let rest = message.strip_prefix("rpc:")?;
    let code = rest.split(':').next()?;
    (!code.is_empty()).then(|| code.to_string())
}

fn parse_rpc_error_message(message: &str) -> String {
    if let Some(rest) = message.strip_prefix("rpc:") {
        if let Some((_, text)) = rest.split_once(':') {
            return text.to_string();
        }
    }
    message.to_string()
}

fn qoder_session_setting_error(setting: &str, value: &str, error: String) -> String {
    format!("Qoder {setting} `{value}` setup failed: {error}")
}

fn qoder_usage_update(workspace_id: &str, result: &Value) -> Option<EngineEvent> {
    let usage = result.get("usage")?;
    let input_tokens = usage.get("inputTokens").and_then(Value::as_i64);
    let output_tokens = usage.get("outputTokens").and_then(Value::as_i64);
    if input_tokens.is_none() && output_tokens.is_none() {
        return None;
    }
    Some(EngineEvent::UsageUpdate {
        workspace_id: workspace_id.to_string(),
        input_tokens,
        output_tokens,
        cached_tokens: None,
        model_context_window: None,
        context_used_tokens: None,
        context_usage_source: None,
        context_usage_freshness: None,
        context_used_percent: None,
        context_remaining_percent: None,
        context_tool_usages: None,
        context_tool_usages_truncated: None,
        context_category_usages: None,
    })
}

fn qoder_cancelled_result(response_text: String) -> Value {
    json!({
        "text": response_text,
        "stopReason": "cancelled",
    })
}

impl QoderSession {
    pub fn new(
        workspace_id: String,
        workspace_path: PathBuf,
        config: Option<EngineConfig>,
    ) -> Self {
        Self::new_with_distribution(
            workspace_id,
            workspace_path,
            config,
            QoderDistribution::Global,
        )
    }

    pub fn new_with_distribution(
        workspace_id: String,
        workspace_path: PathBuf,
        config: Option<EngineConfig>,
        distribution: QoderDistribution,
    ) -> Self {
        let (event_sender, _) = broadcast::channel(1024);
        let config = config.unwrap_or_default();
        Self {
            workspace_id,
            workspace_path,
            session_id: RwLock::new(None),
            event_sender,
            bin_path: config.bin_path,
            home_dir: config.home_dir,
            custom_args: config.custom_args,
            distribution,
            active_processes: Mutex::new(HashMap::new()),
            cancel_requested_turns: Mutex::new(HashSet::new()),
            forced_cancelled_turns: Mutex::new(HashSet::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<QoderTurnEvent> {
        self.event_sender.subscribe()
    }

    pub async fn get_session_id(&self) -> Option<String> {
        self.session_id.read().await.clone()
    }

    async fn set_session_id(&self, id: Option<String>) {
        *self.session_id.write().await = id;
    }

    fn emit_turn_event(&self, turn_id: &str, event: EngineEvent) {
        let _ = self.event_sender.send(QoderTurnEvent {
            turn_id: turn_id.to_string(),
            event,
        });
    }

    pub fn emit_error(&self, turn_id: &str, error: String) {
        self.emit_turn_event(
            turn_id,
            EngineEvent::TurnError {
                workspace_id: self.workspace_id.clone(),
                error,
                code: None,
            },
        );
    }

    fn emit_error_with_code(&self, turn_id: &str, error: String, code: Option<String>) {
        self.emit_turn_event(
            turn_id,
            EngineEvent::TurnError {
                workspace_id: self.workspace_id.clone(),
                error,
                code,
            },
        );
    }

    pub(crate) fn build_command(&self) -> Result<Command, String> {
        spawn_qoder_command_for_distribution(
            self.distribution,
            self.bin_path.as_deref(),
            &self.workspace_path,
            self.home_dir.as_deref(),
            self.custom_args.as_deref(),
        )
    }

    pub async fn send_message(
        &self,
        params: SendMessageParams,
        turn_id: &str,
    ) -> Result<String, String> {
        let prompt_blocks = match assemble_prompt_blocks(
            &params.text,
            params.images.as_deref(),
            &self.workspace_path,
        ) {
            Ok(blocks) => blocks,
            Err(error) => {
                let error_msg = format!("Failed to assemble Qoder prompt: {error}");
                self.emit_error(turn_id, error_msg.clone());
                return Err(error_msg);
            }
        };

        let (child, mut acp, mut stderr_task, stdin) =
            match spawn_qoder_acp_process_for_distribution(
                self.distribution,
                self.bin_path.as_deref(),
                &self.workspace_path,
                self.home_dir.as_deref(),
                self.custom_args.as_deref(),
            )
            .await
            {
                Ok(spawned) => spawned,
                Err(error) => {
                    self.emit_error(turn_id, error.clone());
                    return Err(error);
                }
            };

        {
            let mut active = self.active_processes.lock().await;
            active.insert(
                turn_id.to_string(),
                ActiveQoderChildProcess::new(child, stdin),
            );
        }

        self.emit_turn_event(
            turn_id,
            EngineEvent::TurnStarted {
                workspace_id: self.workspace_id.clone(),
                turn_id: turn_id.to_string(),
            },
        );

        let mut response_text = String::new();
        let mut pending_error_chunks: Vec<String> = Vec::new();
        let mut terminal_error: Option<(String, Option<String>)> = None;
        let mut prompt_result: Option<Value> = None;
        let mut handshake_failed = false;

        let result = async {
            acp.initialize().await?;
            let cwd = self.workspace_path.to_string_lossy().to_string();
            let fork_session_id = normalize_qoder_fork_session_id(
                params.fork_session_id.as_deref(),
                Some(self.distribution.provider_profile_id()),
            )?;
            let resume_id = params
                .session_id
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .filter(|_| params.continue_session)
                .map(str::to_string);
            let session_result = if let Some(session_id) = fork_session_id.as_ref() {
                acp.request(
                    "session/fork",
                    json!({
                        "cwd": cwd,
                        "mcpServers": [],
                        "sessionId": session_id,
                    }),
                    QODER_SESSION_RESUME_TIMEOUT,
                )
                .await?
            } else if let Some(session_id) = resume_id.as_ref() {
                acp.request(
                    "session/resume",
                    json!({
                        "cwd": cwd,
                        "mcpServers": [],
                        "sessionId": session_id,
                    }),
                    QODER_SESSION_RESUME_TIMEOUT,
                )
                .await?
            } else {
                acp.request(
                    "session/new",
                    json!({
                        "cwd": cwd,
                        "mcpServers": [],
                    }),
                    QODER_SESSION_NEW_TIMEOUT,
                )
                .await?
            };
            let session_id = extract_session_id(&session_result)
                .or_else(|| resume_id.clone())
                .ok_or_else(|| "Qoder session handshake returned no sessionId".to_string())?;
            self.set_session_id(Some(session_id.clone())).await;
            {
                let mut active = self.active_processes.lock().await;
                if let Some(process) = active.get_mut(turn_id) {
                    process.acp_session_id = Some(session_id.clone());
                }
            }
            self.emit_turn_event(
                turn_id,
                EngineEvent::SessionStarted {
                    workspace_id: self.workspace_id.clone(),
                    session_id: session_id.clone(),
                    engine: EngineType::Qoder,
                    turn_id: Some(turn_id.to_string()),
                },
            );
            if let Some(model) = params
                .model
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                acp.request(
                    "session/set_model",
                    json!({
                        "sessionId": session_id,
                        "modelId": model,
                    }),
                    QODER_RPC_HANDSHAKE_TIMEOUT,
                )
                .await
                .map_err(|error| qoder_session_setting_error("model", model, error))?;
            }
            if let Some(effort) = params
                .effort
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
            {
                acp.request(
                    "session/set_config_option",
                    json!({
                        "sessionId": session_id,
                        "configId": "reasoning_effort",
                        "value": effort,
                    }),
                    QODER_RPC_HANDSHAKE_TIMEOUT,
                )
                .await
                .map_err(|error| qoder_session_setting_error("reasoning effort", effort, error))?;
            }
            acp.request(
                "session/set_mode",
                json!({
                    "sessionId": session_id,
                    "modeId": "bypassPermissions",
                }),
                QODER_RPC_HANDSHAKE_TIMEOUT,
            )
            .await?;

            let workspace_id = self.workspace_id.clone();
            let event_sender = self.event_sender.clone();
            let turn_id_owned = turn_id.to_string();
            let result = acp
                .request_with_updates(
                    "session/prompt",
                    json!({
                        "sessionId": session_id,
                        "prompt": prompt_blocks,
                    }),
                    Duration::from_secs(60 * 30),
                    |params| {
                        if prompt_result.is_some() || terminal_error.is_some() {
                            return;
                        }
                        match session_update_from_notification(&params) {
                            QoderSessionUpdate::AgentMessageChunk { text } => {
                                if is_error_prefixed_text(&text) {
                                    pending_error_chunks.push(text);
                                    return;
                                }
                                response_text.push_str(&text);
                                let _ = event_sender.send(QoderTurnEvent {
                                    turn_id: turn_id_owned.clone(),
                                    event: EngineEvent::TextDelta {
                                        workspace_id: workspace_id.clone(),
                                        text,
                                    },
                                });
                            }
                            QoderSessionUpdate::AgentThoughtChunk { text } => {
                                let _ = event_sender.send(QoderTurnEvent {
                                    turn_id: turn_id_owned.clone(),
                                    event: EngineEvent::ReasoningDelta {
                                        workspace_id: workspace_id.clone(),
                                        text,
                                    },
                                });
                            }
                            QoderSessionUpdate::ToolStarted {
                                tool_id,
                                tool_name,
                                input,
                            } => {
                                let _ = event_sender.send(QoderTurnEvent {
                                    turn_id: turn_id_owned.clone(),
                                    event: EngineEvent::ToolStarted {
                                        workspace_id: workspace_id.clone(),
                                        tool_id,
                                        tool_name,
                                        input,
                                    },
                                });
                            }
                            QoderSessionUpdate::ToolCompleted {
                                tool_id,
                                tool_name,
                                output,
                                error,
                            } => {
                                let _ = event_sender.send(QoderTurnEvent {
                                    turn_id: turn_id_owned.clone(),
                                    event: EngineEvent::ToolCompleted {
                                        workspace_id: workspace_id.clone(),
                                        tool_id,
                                        tool_name,
                                        output,
                                        error,
                                    },
                                });
                            }
                            QoderSessionUpdate::Ignore => {}
                        }
                    },
                )
                .await;
            result
        }
        .await;

        match result {
            Ok(value) => prompt_result = Some(value),
            Err(error) => {
                handshake_failed = error.contains("initialize")
                    || error.contains("session/new")
                    || error.contains("session/resume")
                    || error.contains("session/set_mode")
                    || error.contains("session handshake");
                terminal_error = Some((error.clone(), parse_rpc_error_code(&error)));
            }
        }

        tokio::time::sleep(QODER_POST_TERMINAL_DRAIN).await;
        let stderr_text = self.cleanup_child(turn_id, &mut stderr_task).await;
        let cancel_requested = self.cancel_requested_turns.lock().await.remove(turn_id);
        let forced_cancelled = self.forced_cancelled_turns.lock().await.remove(turn_id);

        if let Some(mut result) = prompt_result {
            if result.get("text").is_none() {
                result["text"] = json!(response_text.clone());
            }
            if result.get("stopReason").is_none() {
                result["stopReason"] = json!(if cancel_requested || forced_cancelled {
                    "cancelled"
                } else {
                    "end_turn"
                });
            }
            if forced_cancelled {
                result["stopReason"] = json!("cancelled");
            }
            if let Some(usage_event) = qoder_usage_update(&self.workspace_id, &result) {
                self.emit_turn_event(turn_id, usage_event);
            }
            self.emit_turn_event(
                turn_id,
                EngineEvent::TurnCompleted {
                    workspace_id: self.workspace_id.clone(),
                    result: Some(result),
                },
            );
            return Ok(response_text);
        }

        if cancel_requested || forced_cancelled {
            self.emit_turn_event(
                turn_id,
                EngineEvent::TurnCompleted {
                    workspace_id: self.workspace_id.clone(),
                    result: Some(qoder_cancelled_result(response_text.clone())),
                },
            );
            return Ok(response_text);
        }

        let (raw_error, code) = terminal_error.unwrap_or_else(|| {
            (
                if !stderr_text.trim().is_empty() {
                    stderr_text.trim().to_string()
                } else {
                    "Qoder exited without a prompt response".to_string()
                },
                None,
            )
        });
        let message = if !pending_error_chunks.is_empty() {
            pending_error_chunks.join("\n")
        } else {
            let parsed = parse_rpc_error_message(&raw_error);
            if parsed.trim().is_empty() && !stderr_text.trim().is_empty() {
                stderr_text.trim().to_string()
            } else {
                parsed
            }
        };
        let _ = handshake_failed;
        self.emit_error_with_code(turn_id, message.clone(), code);
        Err(message)
    }

    async fn cleanup_child(
        &self,
        turn_id: &str,
        stderr_task: &mut tokio::task::JoinHandle<String>,
    ) -> String {
        let mut child = {
            let mut active = self.active_processes.lock().await;
            active
                .remove(turn_id)
                .map(ActiveQoderChildProcess::into_child)
        };
        if let Some(mut process) = child.take() {
            let _ = process.kill().await;
            let _ = timeout(QODER_POST_TERMINAL_DRAIN, process.wait()).await;
        }
        match timeout(QODER_STDERR_JOIN_TIMEOUT, stderr_task).await {
            Ok(Ok(text)) => text,
            _ => String::new(),
        }
    }

    async fn request_turn_cancellations(
        &self,
        turn_ids: &[String],
    ) -> (Vec<String>, Vec<String>, Vec<String>) {
        let mut active = self.active_processes.lock().await;
        let mut graceful_turn_ids = Vec::new();
        let mut forced_turn_ids = Vec::new();
        let mut errors = Vec::new();

        for turn_id in turn_ids {
            let Some(process) = active.get_mut(turn_id) else {
                continue;
            };
            let Some(session_id) = process.acp_session_id.clone() else {
                forced_turn_ids.push(turn_id.clone());
                continue;
            };
            let payload =
                jsonrpc_notification("session/cancel", json!({ "sessionId": session_id }));
            let bytes = match encode_ndjson(&payload) {
                Ok(bytes) => bytes,
                Err(error) => {
                    forced_turn_ids.push(turn_id.clone());
                    errors.push(format!(
                        "{turn_id}: failed to encode session/cancel: {error}"
                    ));
                    continue;
                }
            };
            let mut stdin = process.stdin.lock().await;
            let Some(stdin) = stdin.as_mut() else {
                forced_turn_ids.push(turn_id.clone());
                continue;
            };
            if let Err(error) = stdin.write_all(&bytes).await {
                forced_turn_ids.push(turn_id.clone());
                errors.push(format!("{turn_id}: failed to send session/cancel: {error}"));
                continue;
            }
            if let Err(error) = stdin.flush().await {
                forced_turn_ids.push(turn_id.clone());
                errors.push(format!(
                    "{turn_id}: failed to flush session/cancel: {error}"
                ));
                continue;
            }
            graceful_turn_ids.push(turn_id.clone());
        }
        drop(active);

        if !graceful_turn_ids.is_empty() {
            let mut requested = self.cancel_requested_turns.lock().await;
            requested.extend(graceful_turn_ids.iter().cloned());
        }

        (graceful_turn_ids, forced_turn_ids, errors)
    }

    async fn force_cancel_turns(&self, turn_ids: &[String]) -> Vec<String> {
        let mut active = self.active_processes.lock().await;
        let mut forced_turn_ids = Vec::new();
        let mut errors = Vec::new();

        for turn_id in turn_ids {
            let Some(process) = active.get_mut(turn_id) else {
                continue;
            };
            match process.child.try_wait() {
                Ok(Some(_)) => forced_turn_ids.push(turn_id.clone()),
                Ok(None) => match process.child.kill().await {
                    Ok(()) => forced_turn_ids.push(turn_id.clone()),
                    Err(error) => {
                        errors.push(format!("{turn_id}: failed to kill qodercli: {error}"))
                    }
                },
                Err(error) => {
                    errors.push(format!("{turn_id}: failed to inspect qodercli: {error}"))
                }
            }
        }
        drop(active);

        if !forced_turn_ids.is_empty() {
            let mut forced = self.forced_cancelled_turns.lock().await;
            forced.extend(forced_turn_ids);
        }

        errors
    }

    async fn interrupt_turn_ids(
        self: &std::sync::Arc<Self>,
        turn_ids: &[String],
    ) -> Result<(), String> {
        let (graceful_turn_ids, forced_turn_ids, mut errors) =
            self.request_turn_cancellations(turn_ids).await;
        errors.extend(self.force_cancel_turns(&forced_turn_ids).await);

        if !graceful_turn_ids.is_empty() {
            let session = std::sync::Arc::clone(self);
            tokio::spawn(async move {
                tokio::time::sleep(QODER_CANCEL_SETTLE_TIMEOUT).await;
                let watchdog_errors = session.force_cancel_turns(&graceful_turn_ids).await;
                if !watchdog_errors.is_empty() {
                    log::warn!(
                        "Qoder cancel watchdog could not stop {} turn(s): {}",
                        watchdog_errors.len(),
                        watchdog_errors.join("; ")
                    );
                }
            });
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "failed to interrupt {} qoder turn(s): {}",
                errors.len(),
                errors.join("; ")
            ))
        }
    }

    pub async fn interrupt(self: &std::sync::Arc<Self>) -> Result<(), String> {
        let turn_ids = self
            .active_processes
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        self.interrupt_turn_ids(&turn_ids).await
    }

    pub async fn interrupt_turn(self: &std::sync::Arc<Self>, turn_id: &str) -> Result<(), String> {
        self.interrupt_turn_ids(&[turn_id.to_string()]).await
    }

    #[allow(dead_code)]
    pub async fn active_process_snapshots(
        &self,
        sampled_at_ms: u64,
    ) -> Vec<QoderActiveProcessSnapshot> {
        let active = self.active_processes.lock().await;
        active
            .values()
            .filter_map(|process| process.snapshot(sampled_at_ms))
            .collect()
    }
}

impl Drop for QoderSession {
    fn drop(&mut self) {
        let Ok(mut active) = self.active_processes.try_lock() else {
            log::warn!(
                "[qoder] dropping session workspace={} while active_processes is locked",
                self.workspace_id
            );
            return;
        };
        if active.is_empty() {
            return;
        }
        for (turn_id, process) in active.drain() {
            let mut child = process.into_child();
            let pid = child.id();
            match child.start_kill() {
                Ok(()) => {
                    log::info!(
                        "[qoder] drop fallback kill workspace={} turn={} pid={:?}",
                        self.workspace_id,
                        turn_id,
                        pid
                    );
                }
                Err(error) => {
                    log::warn!(
                        "[qoder] drop fallback failed workspace={} turn={} pid={:?}: {}",
                        self.workspace_id,
                        turn_id,
                        pid,
                        error
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::qoder_provider_profile;
    use serde_json::json;
    use std::fs;

    #[test]
    fn parses_response_notification_and_agent_request() {
        let response = json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}});
        match parse_acp_line(&response) {
            AcpLine::Response { id, result, error } => {
                assert_eq!(id, json!(1));
                assert_eq!(result, Some(json!({"ok":true})));
                assert!(error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }
        let notification = json!({
            "jsonrpc":"2.0",
            "method":"session/update",
            "params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}
        });
        match parse_acp_line(&notification) {
            AcpLine::Notification { method, .. } => assert_eq!(method, "session/update"),
            other => panic!("expected notification, got {other:?}"),
        }
        let request = json!({
            "jsonrpc":"2.0",
            "id":7,
            "method":"session/request_permission",
            "params":{"options":[]}
        });
        match parse_acp_line(&request) {
            AcpLine::AgentRequest { id, method, .. } => {
                assert_eq!(id, json!(7));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("expected agent request, got {other:?}"),
        }
    }

    #[test]
    fn maps_session_update_kinds() {
        let text =
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}});
        assert_eq!(
            map_session_update(&text),
            QoderSessionUpdate::AgentMessageChunk {
                text: "hello".into()
            }
        );
        let think = json!({"sessionUpdate":"agent_thought_chunk","content":{"text":"plan"}});
        assert_eq!(
            map_session_update(&think),
            QoderSessionUpdate::AgentThoughtChunk {
                text: "plan".into()
            }
        );
        let tool = json!({
            "sessionUpdate":"tool_call",
            "status":"pending",
            "toolCallId":"t1",
            "title":"bash",
            "rawInput":{"command":"ls"}
        });
        match map_session_update(&tool) {
            QoderSessionUpdate::ToolStarted {
                tool_id,
                tool_name,
                input,
            } => {
                assert_eq!(tool_id, "t1");
                assert_eq!(tool_name, "bash");
                assert_eq!(input, Some(json!({"command":"ls"})));
            }
            other => panic!("expected ToolStarted, got {other:?}"),
        }
        let tool_done = json!({
            "sessionUpdate":"tool_call_update",
            "status":"completed",
            "toolCallId":"t1",
            "content":{"text":"ok"}
        });
        match map_session_update(&tool_done) {
            QoderSessionUpdate::ToolCompleted { tool_id, error, .. } => {
                assert_eq!(tool_id, "t1");
                assert!(error.is_none());
            }
            other => panic!("expected ToolCompleted, got {other:?}"),
        }
        let ignore = json!({"sessionUpdate":"available_commands_update","availableCommands":[]});
        assert_eq!(map_session_update(&ignore), QoderSessionUpdate::Ignore);
        let unknown = json!({"sessionUpdate":"totally_new"});
        assert_eq!(map_session_update(&unknown), QoderSessionUpdate::Ignore);
        let in_progress_update = json!({
            "sessionUpdate":"tool_call_update",
            "status":"in_progress",
            "toolCallId":"t1"
        });
        assert_eq!(
            map_session_update(&in_progress_update),
            QoderSessionUpdate::Ignore
        );
        let plan = json!({"sessionUpdate":"plan"});
        assert_eq!(map_session_update(&plan), QoderSessionUpdate::Ignore);
        let user = json!({"sessionUpdate":"user_message_chunk","content":{"text":"hi"}});
        assert_eq!(map_session_update(&user), QoderSessionUpdate::Ignore);
        let config = json!({"sessionUpdate":"config_option_update"});
        assert_eq!(map_session_update(&config), QoderSessionUpdate::Ignore);

        // session/load replay snapshot: tool_call arrives already completed.
        let completed_snapshot = json!({
            "sessionUpdate":"tool_call",
            "toolCallId":"call_01a024d1af117dd1b4ea5705",
            "status":"completed",
            "title":"Skill",
            "content":[{"type":"content","content":{"type":"text","text":"{\"success\":true}"}}],
            "kind":"other",
            "rawInput":{"skill":"quest"},
            "rawOutput":{"success":true},
            "_meta":{"qoder":{"toolName":"Skill"}}
        });
        match map_session_update(&completed_snapshot) {
            QoderSessionUpdate::ToolCompleted {
                tool_id,
                tool_name,
                output,
                error,
            } => {
                assert_eq!(tool_id, "call_01a024d1af117dd1b4ea5705");
                assert_eq!(tool_name.as_deref(), Some("Skill"));
                assert_eq!(output, Some(json!({"success":true})));
                assert!(error.is_none());
            }
            other => panic!("expected ToolCompleted snapshot, got {other:?}"),
        }
    }

    #[test]
    fn load_and_prompt_drain_trailing_session_updates() {
        assert!(acp_method_drains_trailing_updates("session/load"));
        assert!(acp_method_drains_trailing_updates("session/prompt"));
        assert!(!acp_method_drains_trailing_updates("session/list"));
        assert!(!acp_method_drains_trailing_updates("initialize"));
        assert!(!acp_method_drains_trailing_updates("session/new"));
        assert_eq!(
            extract_qoder_tool_content_text(&json!({
                "content":[{"type":"content","content":{"type":"text","text":"done"}}]
            })),
            "done"
        );
    }

    #[test]
    fn error_prefixed_chunks_are_detected_for_dedupe() {
        assert!(is_error_prefixed_text("[Error] Network attempt failed"));
        assert!(is_error_prefixed_text("  [Error] boom"));
        assert!(!is_error_prefixed_text("hello [Error] later"));
    }

    #[test]
    fn session_setting_error_names_the_rejected_value() {
        assert_eq!(
            qoder_session_setting_error(
                "model",
                "qoder-max",
                "rpc:-32602: invalid model".to_string(),
            ),
            "Qoder model `qoder-max` setup failed: rpc:-32602: invalid model"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejected_model_stops_before_session_prompt() {
        use std::os::unix::fs::PermissionsExt;

        let fixture_dir =
            std::env::temp_dir().join(format!("mossx-qoder-model-reject-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&fixture_dir).expect("create fixture directory");
        let trace_path = fixture_dir.join("acp-trace.ndjson");
        let script_path = fixture_dir.join("qodercli-fixture");
        let script = format!(
            r#"#!/bin/sh
TRACE="{}"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$TRACE"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{}}}}'
      ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"fixture-session"}}}}'
      ;;
    *'"method":"session/set_model"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":3,"error":{{"code":-32602,"message":"invalid model"}}}}'
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":5,"result":{{"stopReason":"end_turn"}}}}'
      ;;
  esac
done
"#,
            trace_path.display()
        );
        fs::write(&script_path, script).expect("write fixture CLI");
        let mut permissions = fs::metadata(&script_path)
            .expect("fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("make fixture executable");

        let session = QoderSession::new(
            "ws".into(),
            fixture_dir.clone(),
            Some(EngineConfig {
                bin_path: Some(script_path.to_string_lossy().to_string()),
                ..Default::default()
            }),
        );
        let error = session
            .send_message(
                SendMessageParams {
                    text: "hello".to_string(),
                    model: Some("missing-model".to_string()),
                    ..Default::default()
                },
                "turn-model-reject",
            )
            .await
            .expect_err("invalid model stops the turn");
        assert!(
            error.contains("model `missing-model` setup failed"),
            "{error}"
        );

        let trace = fs::read_to_string(&trace_path).expect("read ACP trace");
        assert!(trace.contains("session/set_model"), "{trace}");
        assert!(!trace.contains("session/prompt"), "{trace}");
        fs::remove_dir_all(&fixture_dir).expect("remove fixture directory");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fork_uses_the_child_session_for_prompt() {
        use std::os::unix::fs::PermissionsExt;

        let fixture_dir =
            std::env::temp_dir().join(format!("mossx-qoder-fork-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&fixture_dir).expect("create fixture directory");
        let trace_path = fixture_dir.join("acp-trace.ndjson");
        let script_path = fixture_dir.join("qodercli-fixture");
        let script = format!(
            r#"#!/bin/sh
TRACE="{}"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$TRACE"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{}}}}'
      ;;
    *'"method":"session/fork"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"child-session"}}}}'
      ;;
    *'"method":"session/set_mode"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{"stopReason":"end_turn"}}}}'
      ;;
  esac
done
"#,
            trace_path.display()
        );
        fs::write(&script_path, script).expect("write fixture CLI");
        let mut permissions = fs::metadata(&script_path)
            .expect("fixture metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("make fixture executable");

        let session = QoderSession::new(
            "ws".into(),
            fixture_dir.clone(),
            Some(EngineConfig {
                bin_path: Some(script_path.to_string_lossy().to_string()),
                ..Default::default()
            }),
        );
        let mut receiver = session.subscribe();
        session
            .send_message(
                SendMessageParams {
                    text: "hello".to_string(),
                    fork_session_id: Some("parent-session".to_string()),
                    ..Default::default()
                },
                "turn-fork",
            )
            .await
            .expect("forked prompt succeeds");

        let trace = fs::read_to_string(&trace_path).expect("read ACP trace");
        assert!(trace.contains("session/fork"), "{trace}");
        assert!(!trace.contains("session/new"), "{trace}");
        assert!(!trace.contains("session/resume"), "{trace}");
        assert!(trace.contains("\"sessionId\":\"child-session\""), "{trace}");

        let events = std::iter::from_fn(|| receiver.try_recv().ok()).collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            &event.event,
            EngineEvent::SessionStarted { session_id, .. } if session_id == "child-session"
        )));
        fs::remove_dir_all(&fixture_dir).expect("remove fixture directory");
    }

    #[test]
    fn usage_update_reads_only_token_usage() {
        let event = qoder_usage_update(
            "ws",
            &json!({
                "usage": {
                    "inputTokens": 123,
                    "outputTokens": 45,
                    "totalTokens": 168,
                },
                "_meta": { "quota": { "token_count": 168 } },
            }),
        )
        .expect("usage event");
        match event {
            EngineEvent::UsageUpdate {
                workspace_id,
                input_tokens,
                output_tokens,
                cached_tokens,
                ..
            } => {
                assert_eq!(workspace_id, "ws");
                assert_eq!(input_tokens, Some(123));
                assert_eq!(output_tokens, Some(45));
                assert_eq!(cached_tokens, None);
            }
            other => panic!("expected UsageUpdate, got {other:?}"),
        }
        assert!(qoder_usage_update("ws", &json!({"_meta": {"quota": {}}})).is_none());
    }

    #[test]
    fn forced_cancellation_has_typed_terminal_result() {
        assert_eq!(
            qoder_cancelled_result("partial answer".to_string()),
            json!({"text":"partial answer","stopReason":"cancelled"})
        );
    }

    #[test]
    fn permission_auto_answer_selects_first_allow_kind() {
        let params = json!({
            "options": [
                {"kind":"reject_once","optionId":"no"},
                {"kind":"allowAlways","optionId":"yes-always"},
                {"kind":"allowOnce","optionId":"yes"}
            ]
        });
        let result = permission_auto_answer(&params).expect("answer");
        assert_eq!(result["outcome"]["optionId"], "yes-always");
        assert_eq!(result["outcome"]["outcome"], "selected");
    }

    #[test]
    fn fs_sandbox_rejects_escape() {
        let root = std::env::temp_dir().join(format!("qoder-fs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let err = confine_path_to_workspace(&root, "/etc/passwd", false).expect_err("escape");
        assert!(err.contains("escapes workspace root"), "{err}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn assemble_prompt_blocks_preserves_text_and_encodes_image() {
        let dir = std::env::temp_dir().join(format!("qoder-img-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("shot.png");
        std::fs::write(&image, b"fake-png").unwrap();
        let blocks =
            assemble_prompt_blocks("look", Some(&[image.to_string_lossy().to_string()]), &dir)
                .expect("blocks");
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "look");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["mimeType"], "image/png");
        assert!(!blocks[1]["data"].as_str().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn assemble_prompt_blocks_fails_on_missing_image() {
        let dir = std::env::temp_dir().join(format!("qoder-img-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = assemble_prompt_blocks(
            "look",
            Some(&[dir.join("missing.png").to_string_lossy().to_string()]),
            &dir,
        )
        .expect_err("missing image");
        assert!(err.contains("none of the attached images"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_session_id_requires_continue() {
        assert_eq!(
            resolve_qoder_session_id_for_engine_send(
                false,
                Some("abc".into()),
                Some("tracked".into()),
                Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
            ),
            Ok(None)
        );
        assert_eq!(
            resolve_qoder_session_id_for_engine_send(
                true,
                Some("abc".into()),
                Some("tracked".into()),
                Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
            ),
            Ok(Some("abc".into()))
        );
        assert_eq!(
            resolve_qoder_session_id_for_engine_send(
                true,
                None,
                Some("tracked".into()),
                Some(qoder_provider_profile::QODER_CN_PROVIDER_PROFILE_ID),
            ),
            Ok(Some("tracked".into()))
        );
    }

    #[test]
    fn normalizes_qoder_fork_session_id() {
        assert_eq!(
            normalize_qoder_fork_session_id(
                Some(" parent-session "),
                Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
            )
            .expect("fork id"),
            Some("parent-session".to_string())
        );
        assert_eq!(
            normalize_qoder_fork_session_id(
                None,
                Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
            )
            .expect("no fork"),
            None
        );
        assert_eq!(
            normalize_qoder_fork_session_id(
                Some(" "),
                Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
            )
            .expect_err("blank fork rejected"),
            "forkSessionId is required for Qoder fork session"
        );
    }

    #[test]
    fn qoder_send_rejects_cross_distribution_canonical_session() {
        let error = resolve_qoder_session_id_for_engine_send(
            true,
            Some("qoder:__qoder_cn__:same-session".into()),
            None,
            Some(qoder_provider_profile::QODER_GLOBAL_PROVIDER_PROFILE_ID),
        )
        .expect_err("Global runtime must not accept CN canonical identity");
        assert!(error.contains("does not match runtime owner"), "{error}");
    }

    #[test]
    fn build_command_rejects_ide_launcher_named_qoder() {
        let session = QoderSession::new(
            "ws".into(),
            std::env::temp_dir(),
            Some(EngineConfig {
                bin_path: Some("qoder".into()),
                ..Default::default()
            }),
        );
        let err = session.build_command().expect_err("launcher rejected");
        assert!(err.contains("qodercli"), "{err}");
        assert!(err.contains("IDE launcher"), "{err}");
    }

    #[test]
    fn unknown_agent_request_returns_method_not_found() {
        let root = std::env::temp_dir();
        let response = answer_agent_request(&root, &json!(3), "totally/unknown", &json!({}));
        assert_eq!(response["error"]["code"], JSONRPC_METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn interrupt_unknown_turn_is_idempotent() {
        let session =
            std::sync::Arc::new(QoderSession::new("ws".into(), std::env::temp_dir(), None));
        session.interrupt_turn("missing").await.expect("idempotent");
        assert!(session.cancel_requested_turns.lock().await.is_empty());
        assert!(session.forced_cancelled_turns.lock().await.is_empty());
    }
}
