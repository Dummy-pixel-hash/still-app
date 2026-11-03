//! Remote ACP transport attached to a private, detached server-side worker.
//! Losing SSH detaches the UI; the worker and its replay journal stay on the server.
use crate::{
    agent_store,
    commands::AppState,
    core::{SessionStatus, StillError},
    ssh_worker,
};
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use base64::Engine;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, mpsc, oneshot};

const FRAME_LIMIT: usize = 16 * 1024 * 1024;
const HISTORY_LIMIT: usize = 1200;
/// Prints the remote Node version and one bounded `--version` result per provider.
/// Runs only where Node exists; a missing/failing probe simply omits version data.
const VERSION_PROBE: &str = r#"import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
const entries = JSON.parse(Buffer.from(process.argv[1] || "", "base64").toString("utf8"));
console.log("STILL_NODE:" + process.versions.node);
const clean = value => [...value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()].slice(0, 200).join("");
const executablePath = command => {
  const paths = isAbsolute(command) ? [command] : (process.env.PATH || "").split(delimiter).map(directory => resolvePath(join(directory, command)));
  for (const path of paths) { try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path } catch {} }
};
const probe = entry => new Promise(resolve => {
  let settled = false, retained = 0, child, timer;
  const stdout = [], stderr = [];
  const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value === "native" ? "" : value) } };
  const stop = () => {
    try { if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, "SIGKILL"); else child?.kill("SIGKILL") } catch {}
  };
  try {
    const executable = executablePath(entry.executable);
    if (!executable) { finish(""); return }
    console.log("STILL_EXECUTABLE:" + entry.id + ":" + executable);
    child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    timer = setTimeout(() => { stop(); finish("") }, 2000);
    const retain = (destination, chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      if (retained + bytes.length > 16 * 1024) { stop(); finish(""); return }
      retained += bytes.length; destination.push(bytes);
    };
    child.stdout.on("data", chunk => retain(stdout, chunk)); child.stderr.on("data", chunk => retain(stderr, chunk));
    child.once("error", () => finish(""));
    child.once("close", code => finish(code === 0 ? clean(Buffer.concat(stdout).toString("utf8").trim() || Buffer.concat(stderr).toString("utf8")) : ""));
  } catch { finish("") }
});
const versions = await Promise.all(entries.map(probe));
entries.forEach((entry, index) => { if (versions[index]) console.log("STILL_VERSION:" + entry.id + ":" + versions[index]) });
"#;
static IDS: AtomicU64 = AtomicU64::new(1);
static THREADS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Thread>>>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Arc<Mutex<Thread>>>> {
    THREADS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn next_request_id() -> u64 {
    let now = (agent_store::timestamp() as u64).saturating_mul(1000);
    loop {
        let old = IDS.load(Ordering::SeqCst);
        let next = old.saturating_add(1).max(now);
        if IDS.compare_exchange_weak(old,next,Ordering::SeqCst,Ordering::SeqCst).is_ok() { return next; }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_sequence: Option<u64>,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locations: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_delta: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_capabilities: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_outcome: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cursor: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todos: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_todo_sync")]
    pub todo_sync: Option<TodoSync>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Value>,
}
impl Event {
    fn new(kind: &str) -> Self {
        Self {
            sequence: 0,
            attempt_id: None,
            end_sequence: None,
            kind: kind.into(),
            state: None,
            text: None,
            tool_call_id: None,
            title: None,
            detail: None,
            status: None,
            permission: None,
            config_options: None,
            plan: None,
            commands: None,
            content: None,
            message_id: None,
            tool_kind: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            input: None,
            output_delta: None,
            checkpoint: None,
            history_capabilities: None,
            request: None,
            request_outcome: None,
            remote_cursor: None,
            turn_active: None,
            todos: None,
            todo_sync: None,
            capabilities: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub conversation_id: String,
    #[serde(default)]
    pub host_key: String,
    pub execution_id: String,
    pub local_session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub agent_session_id: Option<String>,
    pub cwd: String,
    pub state: String,
    pub transcript: Vec<Event>,
    pub pending_permission: Option<Value>,
    pub last_error: Option<String>,
    pub last_sequence: u64,
    pub turn_active: bool,
    pub config_options: Vec<Value>,
    pub commands: Vec<Value>,
    pub pending_input: Option<Value>,
    pub resumable: bool,
    #[serde(default)]
    pub history_capabilities: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_message_ids: Option<Vec<String>>,
    #[serde(default)]
    pub persistent: bool,
    #[serde(default)]
    pub remote_cursor: u64,
    #[serde(default)]
    pub prompt_id: Option<Value>,
    #[serde(default)]
    pub recovery_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todos: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_todo_sync")]
    pub todo_sync: Option<TodoSync>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_optional_capabilities")]
    pub capabilities: Option<CapabilityReport>,
}
impl Snapshot {
    fn history_header(&self) -> Self {
        Self {
            conversation_id: self.conversation_id.clone(), host_key: self.host_key.clone(),
            execution_id: self.execution_id.clone(), local_session_id: self.local_session_id.clone(),
            agent_id: self.agent_id.clone(), agent_name: self.agent_name.clone(), agent_session_id: self.agent_session_id.clone(),
            cwd: self.cwd.clone(), state: self.state.clone(), last_error: self.last_error.clone(),
            last_sequence: self.last_sequence, turn_active: self.turn_active, resumable: self.resumable,
            transcript: Vec::new(), config_options: Vec::new(), commands: Vec::new(), pending_input: None, pending_permission: None,
            history_capabilities: self.history_capabilities.clone(),
            active_message_ids: None,
            persistent: self.persistent, remote_cursor: self.remote_cursor, prompt_id: self.prompt_id.clone(), recovery_required: self.recovery_required,
            todos: self.todos.clone(),
            todo_sync: self.todo_sync.clone(),
            capabilities: self.capabilities.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoSync {
    pub(crate) state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

fn deserialize_optional_todo_sync<'de, D>(deserializer: D) -> Result<Option<TodoSync>, D::Error>
where D: serde::Deserializer<'de> {
    let raw = Option::<Value>::deserialize(deserializer)?;
    Ok(raw.as_ref().and_then(valid_todo_sync))
}

struct PendingPermission {
    id: Value,
    options: Vec<Value>,
}
struct Thread {
    snapshot: Snapshot,
    app: AppHandle,
    outbound: mpsc::UnboundedSender<Value>,
    cancel: mpsc::UnboundedSender<()>,
    permission: Option<PendingPermission>,
    prompt: Option<Value>,
    config_requests: HashMap<u64, PendingConfig>,
    response_delivery: Option<PendingResponse>,
    transport_active: bool,
    transport_epoch: u64,
    recovering_uncertain: bool,
    close: mpsc::UnboundedSender<oneshot::Sender<Result<(), String>>>,
    resume_session_id: Option<String>,
    pending_input_id: Option<Value>,
    early_updates: Vec<Value>,
    cleanup_error: Option<String>,
    unsaved: VecDeque<(Snapshot, Event)>,
    history_lease: Option<std::fs::File>,
    messages: Vec<Event>,
    history_request: Option<PendingHistory>,
    reconcile_request: Option<PendingReconcile>,
    load_session: bool,
    capability_notice: Option<String>,
    awaiting_catch_up: bool,
    capability_remote_cursor: u64,
}
struct PendingHistory {
    request_id: u64,
    message: Event,
    previous_state: String,
    reply: oneshot::Sender<Result<(), String>>,
}
struct PendingReconcile {
    request_id: u64,
    reply: oneshot::Sender<Result<(), String>>,
}
struct PendingConfig {
    id: String,
    value: Value,
    previous_capabilities: Option<CapabilityReport>,
    previous_config: String,
    previous_capability_cursor: u64,
    reply: oneshot::Sender<Result<(), String>>,
}
struct PendingResponse {
    id: Value,
    outcome: Value,
    reply: oneshot::Sender<Result<(), String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    native_session_id: String,
    local_session_id: String,
    agent_id: String,
    cwd: Option<String>,
    executable: Option<String>,
    resume_session_id: Option<String>,
    conversation_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    execution_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachArgs {
    native_session_id: String,
    execution_id: String,
    conversation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendArgs {
    execution_id: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertArgs {
    execution_id: String,
    message_id: String,
    expected_sequence: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionArgs {
    execution_id: String,
    request_id: Value,
    option_id: String,
}
struct Definition {
    name: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    install: &'static str,
}
fn definition(id: &str) -> Option<Definition> {
    Some(match id {
        "opencode" => Definition {
            name: "OpenCode",
            command: "opencode",
            args: &["acp"],
            install: "OpenCode with ACP",
        },
        "pi" => Definition {
            name: "Pi",
            command: "pi",
            args: &[],
            install: "Pi CLI",
        },
        "codex" => Definition {
            name: "Codex",
            command: "codex",
            args: &[],
            install: "Codex CLI",
        },
        "claude" => Definition {
            name: "Claude Code",
            command: "claude",
            args: &[],
            install: "Claude Code CLI",
        },
        "gemini" => Definition {
            name: "Gemini CLI",
            command: "gemini",
            args: &["--acp"],
            install: "Gemini CLI ACP mode",
        },
        _ => return None,
    })
}
pub(crate) fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}
fn executable(def: &Definition, override_path: Option<&str>) -> Result<String, StillError> {
    let path = override_path
        .filter(|p| !p.is_empty())
        .unwrap_or(def.command);
    if path != def.command
        && (!path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control))
    {
        return Err(StillError::friendly(
            "agent_executable_invalid",
            "Use an absolute executable path, without shell arguments.",
        ));
    }
    Ok(path.to_owned())
}
pub(crate) fn login_command(script: &str) -> String {
    format!(
        "exec \"${{SHELL:-/bin/sh}}\" -lc {}",
        quote(&format!(
            "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:$HOME/.claude/local:$PATH\"; if ! command -v node >/dev/null 2>&1 && [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; fi; {script}"
        ))
    )
}
fn directory_script(cwd: &str) -> Result<String, StillError> {
    if cwd.len() > 4096 || cwd.chars().any(char::is_control) {
        return Err(StillError::friendly(
            "agent_cwd_invalid",
            "Choose a remote directory without control characters.",
        ));
    }
    let path = if cwd == "~" || cwd.is_empty() {
        "\"$HOME\"".to_owned()
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(rest))
    } else {
        quote(cwd)
    };
    Ok(format!(
        "cd -- {path} || exit 73; printf 'STILL_CWD:%s\\n' \"$(pwd -P)\"; "
    ))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntime {
    transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version_observed_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFeature {
    status: String,
    reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFeatures {
    shared_todos: CapabilityFeature,
    provider_plans: CapabilityFeature,
    provider_task_projection: CapabilityFeature,
    client_todo_write: CapabilityFeature,
}

/// Validated worker facts plus the native freshness decision. Never provider JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    schema_version: u64,
    execution_id: String,
    agent_session_id: String,
    cwd: String,
    config_generation: u64,
    observed_at: u64,
    provider_runtime: ProviderRuntime,
    features: CapabilityFeatures,
    pub(crate) freshness: String,
}

fn deserialize_optional_capabilities<'de, D>(deserializer: D) -> Result<Option<CapabilityReport>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|value| serde_json::from_value(value).ok()))
}

/// Protocol the worker actually runs. A display name never establishes this.
fn agent_transport(agent_id: &str) -> &'static str {
    match agent_id {
        "opencode" => "http-v2+sse",
        "codex" => "codex-app-server",
        "claude" => "claude-stream-json",
        "pi" => "pi-rpc",
        _ => "acp-v1",
    }
}

fn parse_versions(text: &str) -> std::collections::HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.strip_prefix("STILL_VERSION:"))
        .filter_map(|rest| rest.split_once(':'))
        .filter(|(id, version)| definition(id).is_some() && !version.is_empty() && *version != "native"
            && version.chars().count() <= 200 && version.len() <= 800 && !version.chars().any(char::is_control))
        .map(|(id, version)| (id.to_owned(), version.to_owned()))
        .collect()
}

#[derive(Default)]
struct VersionProbeResult {
    versions: HashMap<String, String>,
    executables: HashMap<String, String>,
}

fn parse_version_probe(text: &str) -> VersionProbeResult {
    let executables = text.lines().filter_map(|line| line.strip_prefix("STILL_EXECUTABLE:"))
        .filter_map(|rest| rest.split_once(':'))
        .filter(|(id, path)| definition(id).is_some() && path.starts_with('/') && path.len() <= 4096 && !path.chars().any(char::is_control))
        .map(|(id, path)| (id.to_owned(), path.to_owned())).collect();
    VersionProbeResult { versions: parse_versions(text), executables }
}

async fn collect_exec(channel: &mut Channel<client::Msg>, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                output.extend_from_slice(&data);
                if output.len() > limit {
                    return Err("Remote shell output exceeded the detection limit.".into());
                }
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(output)
}

/// Bounded version lookup on the already-verified SSH connection. Never starts inference.
async fn probe_versions(
    session_id: &str,
    entries: &[(String, String)],
    deadline: tokio::time::Instant,
) -> Result<VersionProbeResult, StillError> {
    if entries.is_empty() {
        return Ok(VersionProbeResult::default());
    }
    let list = Value::Array(
        entries
            .iter()
            .map(|(id, path)| json!({ "id": id, "executable": path }))
            .collect(),
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        serde_json::to_vec(&list)
            .map_err(|error| StillError::friendly("agent_check_failed", error.to_string()))?,
    );
    let script = format!(
        "if command -v node >/dev/null 2>&1; then node --input-type=module -e {} {} 2>/dev/null; fi; ",
        quote(VERSION_PROBE),
        quote(&encoded),
    );
    let command = login_command(&script);
    let mut channel = tokio::time::timeout_at(deadline, ssh_worker::open_agent_exec(session_id, &command))
        .await.map_err(|_| StillError::friendly("agent_check_timeout", "Reading the installed provider version timed out."))?
        .map_err(|error| StillError::friendly("agent_check_failed", error.to_string()))?;
    let output = tokio::time::timeout_at(deadline, collect_exec(&mut channel, 32 * 1024)).await;
    let _ = channel.close().await;
    let output = output.map_err(|_| {
        StillError::friendly("agent_check_timeout", "Reading the installed provider version timed out.")
    })?;
    let output = output.map_err(|error| StillError::friendly("agent_check_failed", error))?;
    Ok(parse_version_probe(&String::from_utf8_lossy(&output)))
}

/// Launch-time runtime identity. A failed probe leaves version unknown; it never blocks launch.
async fn probe_runtime(session_id: &str, agent_id: &str, executable: &str) -> Option<ProviderRuntime> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let observed = probe_versions(session_id, &[(agent_id.to_owned(), executable.to_owned())], deadline)
        .await
        .unwrap_or_default();
    let version = observed.versions.get(agent_id).cloned();
    let version_observed_at = version.as_ref().map(|_| agent_store::timestamp() as u64);
    Some(ProviderRuntime {
        transport: agent_transport(agent_id).into(),
        executable: Some(observed.executables.get(agent_id).cloned().unwrap_or_else(|| executable.to_owned())),
        version_source: version.as_ref().map(|_| "executable".to_owned()),
        version,
        version_observed_at,
    })
}

/// Validated worker facts plus the native freshness decision. Never provider JSON.
const CAPABILITY_LIMIT: usize = 16 * 1024;

/// Reject a value that cannot be shown and persisted verbatim.
fn bounded_text(value: Option<&Value>, label: &str, max_chars: usize, max_bytes: usize) -> Result<String, String> {
    let text = value.and_then(Value::as_str).ok_or_else(|| format!("{label} is not text."))?;
    if text.is_empty()
        || text.chars().count() > max_chars
        || text.len() > max_bytes
        || text.chars().any(char::is_control)
    {
        return Err(format!("{label} is not a bounded printable value."));
    }
    Ok(text.to_owned())
}

fn capability_count(value: Option<&Value>, label: &str) -> Result<u64, String> {
    let count = value
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{label} is not a nonnegative integer."))?;
    if count > 9_007_199_254_740_991 {
        return Err(format!("{label} exceeds the safe integer limit."));
    }
    Ok(count)
}

fn capability_feature(value: Option<&Value>, key: &str, fixed_unsupported: bool) -> Result<CapabilityFeature, String> {
    let value = value.ok_or_else(|| format!("{key} is missing."))?;
    let status = value.get("status").and_then(Value::as_str).unwrap_or_default();
    if !matches!(status, "supported" | "unsupported" | "unverified") {
        return Err(format!("{key} has an unknown status."));
    }
    if fixed_unsupported && status != "unsupported" {
        return Err(format!("{key} cannot be claimed in this version."));
    }
    let evidence = match value.get("evidence") {
        None => None,
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err(format!("{key} has unknown evidence.")),
    };
    match evidence {
        Some("adapter" | "advertised" | "observed") => {}
        Some(_) => return Err(format!("{key} has unknown evidence.")),
        None if status != "unverified" => return Err(format!("{key} needs evidence for a {status} claim.")),
        None => {}
    }
    if fixed_unsupported && evidence != Some("adapter") {
        return Err(format!("{key} must remain an adapter-level unavailable feature."));
    }
    Ok(CapabilityFeature {
        status: status.to_owned(),
        reason: bounded_text(value.get("reason"), &format!("{key} reason"), 240, 960)?,
        evidence: evidence.map(str::to_owned),
    })
}

/// Validate once at the wire boundary; older generation ordering is checked by the caller.
pub(crate) fn validate_capabilities(
    raw: &Value,
    execution_id: &str,
    agent_id: &str,
    agent_session_id: &str,
    cwd: &str,
) -> Result<CapabilityReport, String> {
    let encoded = serde_json::to_vec(raw).map_err(|_| "Capability report is not JSON.".to_string())?;
    if encoded.len() > CAPABILITY_LIMIT {
        return Err("Capability report is too large.".into());
    }
    if definition(agent_id).is_none() {
        return Err("Capability report has no recognized provider identity.".into());
    }
    let object = raw.as_object().ok_or("Capability report is not an object.")?;
    if capability_count(object.get("schemaVersion"), "schemaVersion")? != 1 {
        return Err("Capability report uses an unsupported schema version.".into());
    }
    if bounded_text(object.get("executionId"), "executionId", 160, 4096)? != execution_id {
        return Err("Capability report belongs to another execution.".into());
    }
    if bounded_text(object.get("agentSessionId"), "agentSessionId", 4096, 4096)? != agent_session_id {
        return Err("Capability report belongs to another provider session.".into());
    }
    if bounded_text(object.get("cwd"), "cwd", 4096, 4096)? != cwd {
        return Err("Capability report belongs to another folder.".into());
    }
    let runtime = object
        .get("providerRuntime")
        .and_then(Value::as_object)
        .ok_or("Capability report is missing its runtime identity.")?;
    let transport = bounded_text(runtime.get("transport"), "transport", 32, 32)?;
    if !matches!(
        transport.as_str(),
        "http-v2+sse" | "codex-app-server" | "claude-stream-json" | "pi-rpc" | "acp-v1"
    ) {
        return Err("Capability report has an unknown transport.".into());
    }
    if transport != agent_transport(agent_id) {
        return Err("Capability report transport does not match the selected agent.".into());
    }
    let executable = runtime
        .get("executable")
        .map(|value| bounded_text(Some(value), "executable", 4096, 4096))
        .transpose()?;
    let version = runtime
        .get("version")
        .map(|value| bounded_text(Some(value), "version", 200, 800))
        .transpose()?;
    if version.as_deref() == Some("native") { return Err("The adapter label is not an installed provider version.".into()); }
    let version_source = match runtime.get("versionSource") {
        None => None,
        Some(Value::String(value)) if matches!(value.as_str(), "runtime" | "executable") => Some(value.clone()),
        Some(_) => return Err("Capability report has an unknown version source.".into()),
    };
    let version_observed_at = runtime
        .get("versionObservedAt")
        .map(|value| capability_count(Some(value), "versionObservedAt"))
        .transpose()?;
    if (version.is_some() && (version_source.is_none() || version_observed_at.is_none()))
        || (version.is_none() && (version_source.is_some() || version_observed_at.is_some()))
    {
        return Err("Capability report version evidence is incomplete.".into());
    }
    let features = object
        .get("features")
        .and_then(Value::as_object)
        .ok_or("Capability report is missing its features.")?;
    let features = CapabilityFeatures {
        shared_todos: capability_feature(features.get("sharedTodos"), "sharedTodos", false)?,
        provider_plans: capability_feature(features.get("providerPlans"), "providerPlans", false)?,
        provider_task_projection: capability_feature(features.get("providerTaskProjection"), "providerTaskProjection", true)?,
        client_todo_write: capability_feature(features.get("clientTodoWrite"), "clientTodoWrite", true)?,
    };
    Ok(CapabilityReport {
        schema_version: 1,
        execution_id: execution_id.to_owned(),
        agent_session_id: agent_session_id.to_owned(),
        cwd: cwd.to_owned(),
        config_generation: capability_count(object.get("configGeneration"), "configGeneration")?,
        observed_at: capability_count(object.get("observedAt"), "observedAt")?,
        provider_runtime: ProviderRuntime {
            transport,
            executable,
            version,
            version_source,
            version_observed_at,
        },
        features,
        // Only the native observer can decide this; an incoming value is ignored.
        freshness: "current".into(),
    })
}

fn mark_capabilities_stale(snapshot: &mut Snapshot) -> bool {
    match snapshot.capabilities.as_mut() {
        Some(report) if report.freshness != "stale" => {
            report.freshness = "stale".into();
            true
        }
        _ => false,
    }
}

fn effective_config_key(options: &[Value]) -> String {
    let mut entries = options.iter().filter_map(|option| option["id"].as_str().map(|id|
        (id.to_owned(), json!([id, option.get("type"), option.get("currentValue")])))).collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    serde_json::to_string(&entries.into_iter().map(|(_, value)| value).collect::<Vec<_>>()).unwrap_or_default()
}

fn restore_rejected_capability_report(snapshot: &mut Snapshot, pending: &PendingConfig, cursor: u64) -> bool {
    let Some(previous) = pending.previous_capabilities.as_ref() else { return false };
    if previous.freshness != "current" || previous.execution_id != snapshot.execution_id
        || Some(previous.agent_session_id.as_str()) != snapshot.agent_session_id.as_deref() || previous.cwd != snapshot.cwd
        || pending.previous_config != effective_config_key(&snapshot.config_options) || cursor != pending.previous_capability_cursor
    { return false; }
    let changed = snapshot.capabilities.as_ref() != Some(previous);
    snapshot.capabilities = Some(previous.clone());
    changed
}

fn confirm_config_capability_report(snapshot: &mut Snapshot, pending: &PendingConfig, cursor: u64) -> bool {
    let same_config = pending.previous_config == effective_config_key(&snapshot.config_options);
    if same_config && restore_rejected_capability_report(snapshot, pending, cursor) { return true; }
    let Some(report) = snapshot.capabilities.as_mut() else { return false };
    if report.execution_id != snapshot.execution_id || Some(report.agent_session_id.as_str()) != snapshot.agent_session_id.as_deref()
        || report.cwd != snapshot.cwd || cursor <= pending.previous_capability_cursor
        || !same_config && pending.previous_capabilities.as_ref().is_some_and(|previous| report.config_generation <= previous.config_generation)
    { return false; }
    let changed = report.freshness != "current";
    report.freshness = "current".into();
    changed
}

fn invalidate_for_provider_session(snapshot: &mut Snapshot, next_session: Option<&str>) -> bool {
    if snapshot.agent_session_id.as_deref() == next_session { return false; }
    mark_capabilities_stale(snapshot)
}

pub(crate) fn restore_capabilities(snapshot: &mut Snapshot) {
    let Some(old) = snapshot.capabilities.as_ref() else { return };
    let Ok(raw) = serde_json::to_value(old) else {
        snapshot.capabilities = None;
        return;
    };
    let Some(session) = snapshot.agent_session_id.as_deref() else {
        snapshot.capabilities = None;
        return;
    };
    match validate_capabilities(&raw, &snapshot.execution_id, &snapshot.agent_id, session, &snapshot.cwd) {
        Ok(mut report) => {
            report.freshness = "stale".into();
            snapshot.capabilities = Some(report);
        }
        Err(_) => snapshot.capabilities = None,
    }
}

fn capability_is_older(
    current: Option<&CapabilityReport>,
    next: &CapabilityReport,
    current_cursor: u64,
    next_cursor: u64,
) -> bool {
    current.is_some_and(|current| {
        current.execution_id == next.execution_id && next.config_generation < current.config_generation
    }) || next_cursor < current_cursor
}

fn provider_resumable(agent_id: &str, reported: Option<bool>, load_session: bool, session_id: &str) -> bool {
    reported.unwrap_or(agent_id == "gemini" && load_session && !session_id.is_empty())
}

fn capability_observation_freshness(fresh: bool, transport_active: bool, awaiting_catch_up: bool, config_pending: bool, history_pending: bool) -> &'static str {
    if fresh && transport_active && !awaiting_catch_up && !config_pending && !history_pending { "current" } else { "stale" }
}

/// Accept a worker report for this execution, session, and folder. Returns whether
/// the stored report changed; older generations are ignored without downgrading.
fn accept_capabilities(
    thread: &mut Thread,
    raw: &Value,
    cursor: Option<u64>,
    fresh: bool,
) -> Result<bool, String> {
    let session = thread
        .snapshot
        .agent_session_id
        .clone()
        .ok_or("Capability report arrived before the provider session identity.")?;
    let mut report = validate_capabilities(
        raw,
        &thread.snapshot.execution_id,
        &thread.snapshot.agent_id,
        &session,
        &thread.snapshot.cwd,
    )?;
    report.freshness = capability_observation_freshness(fresh, thread.transport_active, thread.awaiting_catch_up,
        !thread.config_requests.is_empty(), thread.history_request.is_some()).into();
    let cursor = cursor.unwrap_or(thread.snapshot.remote_cursor);
    if capability_is_older(
        thread.snapshot.capabilities.as_ref(),
        &report,
        thread.capability_remote_cursor,
        cursor,
    ) {
        return Ok(false);
    }
    let changed = thread.snapshot.capabilities.as_ref() != Some(&report);
    thread.snapshot.capabilities = Some(report);
    thread.capability_remote_cursor = cursor;
    Ok(changed)
}

async fn emit_capabilities(thread: &mut Thread) {
    let Some(report) = thread.snapshot.capabilities.clone() else { return };
    let Ok(value) = serde_json::to_value(report) else { return };
    let mut event = Event::new("capabilities");
    event.capabilities = Some(value);
    emit(thread, event).await;
}

/// One bounded notice per distinct failure condition; a later valid report clears it.
async fn note_capability_error(thread: &mut Thread, message: &str) {
    let message = message.chars().take(240).collect::<String>();
    if thread.capability_notice.as_deref() == Some(message.as_str()) {
        return;
    }
    thread.capability_notice = Some(message.clone());
    let mut event = Event::new("notice");
    event.title = Some("Capability details unavailable".into());
    event.text = Some(message);
    emit(thread, event).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckArgs {
    native_session_id: String,
    agent_id: Option<String>,
    executable: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    agent_id: String,
    executable: Option<String>,
    available: bool,
    installed: bool,
    runtime: String,
    runtime_available: bool,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_runtime: Option<ProviderRuntime>,
    checked_at: u64,
}
#[tauri::command]
pub async fn still_agent_check(args: CheckArgs) -> Result<Vec<Availability>, StillError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let ids: Vec<&str> = args
        .agent_id
        .as_deref()
        .map(|id| vec![id])
        .unwrap_or_else(|| vec!["opencode", "pi", "codex", "claude", "gemini"]);
    let mut script = String::from(
        "if command -v node >/dev/null 2>&1; then node -p '\"STILL_NODE:\"+process.versions.node' 2>/dev/null; fi; ",
    );
    for id in &ids {
        let def = definition(id).ok_or_else(|| {
            StillError::friendly("agent_unknown", "Choose a supported ACP agent.")
        })?;
        let path = executable(&def, args.executable.as_deref())?;
        script.push_str(&format!("p=$(command -v {} 2>/dev/null) && [ -x \"$p\" ] && printf 'STILL_AGENT:%s:%s\\n' {} \"$p\"; ", quote(&path), quote(id)));
    }
    let command = login_command(&script);
    let mut channel = tokio::time::timeout_at(deadline, ssh_worker::open_agent_exec(&args.native_session_id, &command))
        .await.map_err(|_| StillError::friendly("agent_check_timeout", "Remote detection timed out. Check the server terminal and login shell."))?
        .map_err(|e| {
            StillError::friendly(
                "agent_check_failed",
                &format!("Connect to the remote server first: {e}"),
            )
        })?;
    let output = tokio::time::timeout_at(deadline, collect_exec(&mut channel, FRAME_LIMIT)).await;
    let _ = channel.close().await;
    let output = output
        .map_err(|_| {
            StillError::friendly(
                "agent_check_timeout",
                "Remote detection timed out. Check the server terminal and login shell.",
            )
        })?
        .map_err(|e| StillError::friendly("agent_check_failed", e))?;
    let text = String::from_utf8_lossy(&output);
    let node_ready = text
        .lines()
        .find_map(|line| line.strip_prefix("STILL_NODE:"))
        .and_then(|version| version.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major >= 20);
    let installed: Vec<(String, String)> = ids
        .iter()
        .filter_map(|id| {
            let prefix = format!("STILL_AGENT:{id}:");
            text.lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .map(|path| ((*id).to_owned(), path.to_owned()))
        })
        .collect();
    // Version lookup uses the remaining discovery budget; absence never changes install state.
    let versions = if node_ready {
        probe_versions(&args.native_session_id, &installed, deadline).await.unwrap_or_default().versions
    } else {
        std::collections::HashMap::new()
    };
    let observed_at = agent_store::timestamp() as u64;
    Ok(ids
        .into_iter()
        .map(|id| {
            let prefix = format!("STILL_AGENT:{id}:");
            let path = text
                .lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .map(str::to_owned);
            let version = versions.get(id).cloned();
            let version_observed_at = version.as_ref().map(|_| observed_at);
            let provider_runtime = path.as_ref().map(|executable| ProviderRuntime {
                transport: agent_transport(id).into(),
                executable: Some(executable.clone()),
                version_source: version.as_ref().map(|_| "executable".to_owned()),
                version,
                version_observed_at,
            });
            Availability {
                agent_id: id.to_owned(),
                available: path.is_some() && node_ready,
                installed: path.is_some(),
                runtime: if id == "gemini" { "acp" } else { "native" }.into(),
                runtime_available: node_ready,
                message: if path.is_some() && !node_ready {
                    Some("Installed. Persistent agent sessions need Node.js 20 or newer on this server.".into())
                } else if provider_runtime.as_ref().is_some_and(|runtime| runtime.version.is_none()) {
                    Some("Installed. The selected executable did not report a version.".into())
                } else {
                    None
                },
                provider_runtime,
                checked_at: observed_at,
                executable: path,
            }
        })
        .collect())
}
fn append_history(history: &mut Vec<Event>, event: Event) {
    apply_history_event(history, &event);
    if matches!(event.kind.as_str(), "assistantChunk" | "reasoningChunk") {
        if let Some(last) = history
            .last_mut()
            .filter(|last| last.kind == event.kind && last.message_id == event.message_id)
        {
            last.text
                .get_or_insert_with(String::new)
                .push_str(event.text.as_deref().unwrap_or(""));
            last.end_sequence = Some(event.sequence);
            return;
        }
    }
    if history.len() >= HISTORY_LIMIT {
        history.remove(0);
    }
    history.push(event);
}
/// Apply provider-acknowledged boundaries; the journal records the boundary durably.
pub(super) fn apply_history_event(history: &mut Vec<Event>, event: &Event) {
    if event.kind == "messageCheckpoint" {
        if let Some(message) = history.iter_mut().find(|message| message.kind == "userMessage" && message.message_id.is_some() && message.message_id == event.message_id) {
            message.checkpoint = event.checkpoint.clone();
        }
    } else if event.kind == "historyReverted" {
        if let Some(index) = history.iter().position(|message| message.kind == "userMessage" && message.message_id.is_some() && message.message_id == event.message_id) {
            history.truncate(index);
        } else if let Some(sequence) = event.checkpoint.as_ref().and_then(|value| value["sequence"].as_u64()) {
            let attempt = event.checkpoint.as_ref().and_then(|value| value["attemptId"].as_str());
            if attempt == event.attempt_id.as_deref() { history.retain(|message| message.sequence < sequence); }
            else { history.clear(); }
        }
    }
}
async fn emit(thread: &mut Thread, mut e: Event) {
    thread.snapshot.last_sequence = thread.snapshot.last_sequence.saturating_add(1);
    e.sequence = thread.snapshot.last_sequence;
    e.attempt_id = Some(thread.snapshot.execution_id.clone());
    e.remote_cursor = thread.snapshot.persistent.then_some(thread.snapshot.remote_cursor);
    e.turn_active = Some(thread.snapshot.turn_active);
    if e.kind == "userMessage" { thread.messages.push(e.clone()); }
    else { apply_history_event(&mut thread.messages, &e); }
    append_history(&mut thread.snapshot.transcript, e.clone());
    let mut result = Ok(());
    while let Some((snapshot, event)) = thread.unsaved.front() {
        result = agent_store::event(&thread.app, snapshot, event).await;
        if result.is_err() { break; }
        thread.unsaved.pop_front();
    }
    if result.is_ok() { result = agent_store::event(&thread.app, &thread.snapshot, &e).await; }
    if result.is_err() {
        let snapshot = thread.snapshot.history_header();
        thread.unsaved.push_back((snapshot, e.clone()));
    }
    agent_store::report(&thread.app, &thread.snapshot.conversation_id, e.sequence, &result);
    let _ = thread.app.emit(
        &format!("still://agent-event/{}", thread.snapshot.execution_id),
        e,
    );
}

pub async fn live_executions() -> Vec<String> {
    registry().lock().await.keys().cloned().collect()
}

async fn flush_history(thread: &mut Thread) -> Result<(), StillError> {
    while let Some((snapshot, event)) = thread.unsaved.front() {
        let result = agent_store::event(&thread.app, snapshot, event).await;
        agent_store::report(&thread.app, &snapshot.conversation_id, event.sequence, &result);
        result?;
        thread.unsaved.pop_front();
    }
    Ok(())
}

#[tauri::command]
pub async fn still_agent_flush() -> Result<(), StillError> {
    let threads: Vec<_> = registry().lock().await.values().cloned().collect();
    for row in threads { flush_history(&mut *row.lock().await).await?; }
    Ok(())
}

/// Resolve and verify the directory through the already verified SSH connection.
pub(crate) async fn remote_cwd(session_id: &str, directory: &str) -> Result<String, StillError> {
    let script = directory_script(directory)?;
    let mut channel = ssh_worker::open_agent_exec(session_id, &login_command(&script))
        .await
        .map_err(|_| {
            StillError::friendly(
                "agent_ssh",
                "Could not inspect the remote working directory.",
            )
        })?;
    let until = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    loop {
        let msg = tokio::time::timeout_at(until, channel.wait())
            .await
            .map_err(|_| {
                StillError::friendly("agent_cwd_timeout", "Remote directory lookup timed out.")
            })?;
        match msg {
            Some(ChannelMsg::Data { data }) if bytes.len() + data.len() < 65536 => {
                bytes.extend_from_slice(&data)
            }
            Some(ChannelMsg::Data { .. }) => {
                return Err(StillError::friendly(
                    "agent_cwd_invalid",
                    "Remote pwd output is too large.",
                ));
            }
            Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let cwd = String::from_utf8_lossy(&bytes)
        .lines()
        .find_map(|line| line.strip_prefix("STILL_CWD:"))
        .unwrap_or("")
        .trim()
        .to_owned();
    if cwd.starts_with('/') {
        Ok(cwd)
    } else {
        Err(StillError::friendly(
            "agent_cwd_invalid",
            "Could not determine an absolute remote working directory.",
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderArgs { native_session_id: String, cwd: String }

#[tauri::command]
pub async fn still_agent_resolve_folder(args: FolderArgs) -> Result<String, StillError> {
    if args.cwd.trim().is_empty() { return Err(StillError::friendly("agent_project_required", "Enter the remote project folder.")); }
    remote_cwd(&args.native_session_id, &args.cwd).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogArgs { native_session_id: String, agent_id: String, cwd: String, executable: Option<String> }

#[tauri::command]
pub async fn still_agent_catalog(args: CatalogArgs) -> Result<Value, StillError> {
    let def = definition(&args.agent_id).ok_or_else(|| StillError::friendly("agent_unknown", "Choose a supported agent."))?;
    if args.agent_id != "opencode" { return Ok(json!({"commands":[],"configOptions":[]})); }
    if args.cwd.trim().is_empty() { return Err(StillError::friendly("agent_project_required", "Choose the project first.")); }
    let cwd = remote_cwd(&args.native_session_id, &args.cwd).await?;
    let path = executable(&def, args.executable.as_deref())?;
    let script = login_command(&format!("cd -- {} || exit 73; exec env STILL_AGENT_CATALOG=opencode STILL_AGENT_EXECUTABLE={} node --input-type=module -e {}", quote(&cwd), quote(&path), quote(include_str!("../agent-host/bridge.mjs"))));
    let mut channel = ssh_worker::open_agent_exec(&args.native_session_id, &script).await.map_err(|e| StillError::friendly("agent_catalog", e.to_string()))?;
    let result = tokio::time::timeout(Duration::from_secs(65), async {
        let mut bytes = Vec::new(); let mut stderr = Vec::new(); let mut failed = false;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => { if bytes.len() + data.len() > FRAME_LIMIT { return Err("Project catalog exceeded 2 MiB".to_owned()); } bytes.extend_from_slice(&data); },
                ChannelMsg::ExtendedData { data, .. } => { if stderr.len() < 16000 { stderr.extend_from_slice(&data[..data.len().min(16000 - stderr.len())]); } },
                ChannelMsg::ExitStatus { exit_status } => failed = exit_status != 0,
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {},
            }
        }
        if failed || bytes.is_empty() { return Err(format!("Could not load project commands: {}", String::from_utf8_lossy(&stderr).trim())); }
        let catalog: Value = serde_json::from_slice(&bytes).map_err(|_| "The provider returned an invalid command catalog".to_owned())?;
        if !catalog["commands"].is_array() || !catalog["configOptions"].is_array() { return Err("The provider omitted its command catalog".into()); }
        Ok(catalog)
    }).await;
    let _ = channel.eof().await; let _ = channel.close().await;
    result.map_err(|_| StillError::friendly("agent_catalog", "Project command discovery timed out. Retry from the command picker."))?.map_err(|e| StillError::friendly("agent_catalog", e))
}

fn persistent_command(execution: &str, conversation_id: &str, cwd: &str, agent_id: &str, executable: &str, create: bool, cursor: u64, runtime: Option<&ProviderRuntime>, todo_seed: Option<&Value>) -> Result<(String, String), StillError> {
    if execution.is_empty() || execution.len() > 160 || !execution.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err(StillError::friendly("agent_identity", "Invalid persistent execution identity."));
    }
    let definition = definition(agent_id).ok_or_else(|| StillError::friendly("agent_unsupported", "Unknown agent."))?;
    let (command, env) = if !create {
        (Vec::new(), json!({}))
    } else if agent_id == "gemini" {
        (std::iter::once(executable.to_owned()).chain(definition.args.iter().map(|arg| (*arg).to_owned())).collect::<Vec<_>>(), json!({}))
    } else {
        (vec!["node".to_owned(), "--input-type=module".to_owned(), "-e".to_owned(), include_str!("../agent-host/bridge.mjs").to_owned()], json!({"STILL_AGENT_DRIVER":agent_id,"STILL_AGENT_EXECUTABLE":executable}))
    };
    let mut payload = json!({"executionId":execution,"conversationId":conversation_id,"agentId":agent_id,"cwd":cwd,"create":create,"after":cursor,"command":command,"env":env});
    if create {
        payload["source"] = json!(include_str!("../agent-host/supervisor.mjs"));
        payload["todosSource"] = json!(include_str!("../agent-host/todos.mjs"));
        payload["todoPiSource"] = json!(include_str!("../agent-host/todo-pi.mjs"));
        if let Some(seed) = todo_seed { payload["todoSeed"] = seed.clone(); }
        if let Some(runtime) = runtime {
            // The worker may replace the version with stronger runtime evidence;
            // transport and executable stay those of the launch we actually made.
            payload["providerRuntime"] = json!(runtime);
            payload["env"]["STILL_PROVIDER_RUNTIME"] = json!(serde_json::to_string(runtime).unwrap_or_default());
        }
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&payload).map_err(|error| StillError::friendly("agent_launch", error.to_string()))?);
    let bootstrap = include_str!("../agent-host/bootstrap.mjs");
    let command = login_command(&format!("exec node --input-type=module -e {}", quote(bootstrap)));
    Ok((command, encoded))
}

async fn bootstrap_remote(channel: &mut Channel<client::Msg>, payload: &str) -> Result<Vec<u8>, String> {
    let mut input = payload.as_bytes().to_vec();
    input.push(b'\n');
    for chunk in input.chunks(16 * 1024) {
        channel.data_bytes(chunk.to_vec()).await.map_err(|error| format!("Could not send remote agent configuration: {error}"))?;
    }

    const READY: &str = "STILL_BOOTSTRAP_READY";
    const ERROR: &str = "STILL_BOOTSTRAP_ERROR:";
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut output = Vec::new();
    let mut stderr = String::new();
    loop {
        let message = tokio::time::timeout_at(deadline, channel.wait()).await
            .map_err(|_| "Remote bootstrap timed out before the agent transport was ready".to_owned())?;
        match message {
            Some(ChannelMsg::Data { data }) => {
                output.extend_from_slice(&data);
                if output.len() > 64 * 1024 { return Err("Remote startup output exceeded 64 KiB before bootstrap".into()); }
                while let Some(end) = output.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<_> = output.drain(..=end).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end_matches(['\r', '\n']);
                    if line == READY { return Ok(std::mem::take(&mut output)); }
                    if let Some(error) = line.strip_prefix(ERROR) { return Err(error.to_owned()); }
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                stderr.push_str(&String::from_utf8_lossy(&data));
                if stderr.len() > 8 * 1024 {
                    let mut cut = stderr.len() - 8 * 1024;
                    while !stderr.is_char_boundary(cut) { cut += 1; }
                    stderr.drain(..cut);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => return Err(format!("Remote bootstrap exited with status {exit_status}. {}", stderr.trim())),
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return Err(format!("Remote bootstrap closed before the agent transport was ready. {}", stderr.trim())),
            _ => {}
        }
    }
}

fn validate_resume_scope(saved: &Snapshot, host: &str, agent: &str, cwd: &str, session_id: Option<&str>) -> Result<(), String> {
    if saved.host_key != host || saved.agent_id != agent || saved.cwd != cwd {
        return Err("The saved conversation belongs to another server, folder, or agent.".into());
    }
    if session_id.is_none_or(str::is_empty) || saved.agent_session_id.as_deref() != session_id || !saved.resumable {
        return Err("Resume the saved provider session explicitly; its identity or resume support was not confirmed.".into());
    }
    if saved.turn_active || saved.recovery_required || matches!(saved.state.as_str(), "submissionUnknown" | "rewinding")
        || saved.pending_input.is_some() || saved.pending_permission.is_some()
    {
        return Err("The saved execution is active or unconfirmed. Reattach and inspect it before starting a replacement.".into());
    }
    Ok(())
}

fn validate_replacement_execution(existing: &Snapshot, conversation_id: &str) -> Result<(), String> {
    if existing.conversation_id == conversation_id {
        return Err("This conversation already has a managed execution. Reattach to it, or explicitly stop and close it before resuming.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn still_agent_start(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartArgs,
) -> Result<Snapshot, StillError> {
    let def = definition(&args.agent_id)
        .ok_or_else(|| StillError::friendly("agent_unsupported", "Unknown agent."))?;
    let owner = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&args.native_session_id)
            .cloned()
            .ok_or_else(|| {
                StillError::friendly(
                    "agent_session",
                    "Connect the selected server in Still first.",
                )
            })?
    };
    let config = {
        let session = owner.lock().await;
        if session.status != SessionStatus::Live {
            return Err(StillError::friendly(
                "agent_session",
                "Wait until the selected SSH connection is live, then start the agent.",
            ));
        }
        session.config.clone()
    };
    let cwd = remote_cwd(
        &args.native_session_id,
        args.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()).ok_or_else(|| StillError::friendly("agent_project_required", "Choose the project folder before starting a conversation."))?,
    )
    .await?;
    let path = executable(&def, args.executable.as_deref())?;
    let execution_id = format!("agent-{}-{}-{}", agent_store::timestamp(), std::process::id(), IDS.fetch_add(1, Ordering::Relaxed));
    let conversation_id = args.conversation_id.clone().unwrap_or_else(|| execution_id.clone());
    let host_key = json!([config.host.to_lowercase(), config.port, config.username]).to_string();
    let managed = registry().lock().await.values().cloned().collect::<Vec<_>>();
    for row in managed {
        let thread = row.lock().await;
        validate_replacement_execution(&thread.snapshot, &conversation_id)
            .map_err(|error| StillError::friendly("agent_execution_exists", error))?;
    }
    let history_lease = agent_store::lease(&app, conversation_id.clone()).await?;
    let default_todos = || json!({"protocolVersion":3,"revision":0,"items":[],"toolAvailable":false,"available":true});
    let saved_todos = if args.conversation_id.is_some() {
        let saved = agent_store::load_snapshot(&app, conversation_id.clone()).await?;
        if saved.conversation_id != conversation_id {
            return Err(StillError::friendly("agent_resume_identity", "The saved conversation identity does not match this resume request."));
        }
        validate_resume_scope(&saved, &host_key, &args.agent_id, &cwd, args.resume_session_id.as_deref())
            .map_err(|error| StillError::friendly("agent_resume_identity", error))?;
        saved.todos
    } else { None };
    let validated_saved_todos = saved_todos.and_then(|todos| validate_todos(&todos).ok());
    let mut initial_todos = validated_saved_todos.clone().unwrap_or_else(default_todos);
    initial_todos["toolAvailable"] = json!(false);
    initial_todos["available"] = json!(true);
    let todo_seed = validated_saved_todos.as_ref().map(|todos| {
        let mut seed = json!({"revision":todos["revision"],"items":todos["items"]});
        if let Some(active_id) = todos["activeId"].as_str() { seed["activeId"] = json!(active_id); }
        seed
    });
    let runtime = probe_runtime(&args.native_session_id, &args.agent_id, &path).await;
    let (remote, bootstrap_payload) = persistent_command(&execution_id, &conversation_id, &cwd, &args.agent_id, &path, true, 0, runtime.as_ref(), todo_seed.as_ref())?;
    let mut channel=ssh_worker::open_agent_exec(&args.native_session_id,&remote).await.map_err(|_|StillError::friendly("agent_launch",format!("Could not launch {} on the remote host. Verify that {} is already installed there.",def.name,def.install)))?;
    let bootstrap_data = match bootstrap_remote(&mut channel, &bootstrap_payload).await {
        Ok(data) => data,
        Err(error) => {
            let _ = channel.eof().await; let _ = channel.close().await;
            return Err(StillError::friendly("agent_launch", format!("Could not prepare the remote agent: {error}")));
        }
    };
    let (cancel, cancel_rx) = mpsc::unbounded_channel();
    let (outbound, outbound_rx) = mpsc::unbounded_channel();
    let (close, close_rx) = mpsc::unbounded_channel();
    let snapshot = Snapshot {
        conversation_id,
        host_key,
        execution_id: execution_id.clone(),
        local_session_id: args.local_session_id,
        agent_id: args.agent_id,
        agent_name: def.name.into(),
        agent_session_id: args.resume_session_id.clone(),
        cwd: cwd.clone(),
        state: "connecting".into(),
        transcript: Vec::new(),
        pending_permission: None,
        last_error: None,
        last_sequence: 0,
        turn_active: false,
        config_options: Vec::new(),
        commands: Vec::new(),
        pending_input: None,
        resumable: args.resume_session_id.is_some(),
            history_capabilities: json!({"revert":false,"retry":false}),
            todos: Some(initial_todos),
            todo_sync: Some(TodoSync { state: "stale".into(), reason: Some("Waiting for this execution to confirm the conversation Todo list.".into()) }),
        active_message_ids: None,
        persistent: true, remote_cursor: 0, prompt_id: None, recovery_required: false,
        capabilities: None,
    };
    if let Err(error) = agent_store::register(&app, &snapshot, args.conversation_id.is_some()).await {
        let _ = send(&channel,&json!({"jsonrpc":"2.0","id":"startup-cleanup","method":"_still/shutdown"})).await;
        let _ = channel.eof().await;
        let _ = channel.close().await;
        return Err(error);
    }
    let messages = if args.conversation_id.is_some() {
        match agent_store::history_messages(&app, snapshot.conversation_id.clone()).await {
            Ok(messages) => messages,
            Err(error) => { let _ = send(&channel,&json!({"jsonrpc":"2.0","id":"startup-cleanup","method":"_still/shutdown"})).await; let _ = channel.eof().await; let _ = channel.close().await; return Err(error); }
        }
    } else { Vec::new() };
    let row = Arc::new(Mutex::new(Thread {
        snapshot: snapshot.clone(),
        app,
        outbound,
        cancel,
        permission: None,
        prompt: None,
        config_requests: HashMap::new(),
        response_delivery: None,
        transport_active: true,
        transport_epoch: 1,
        recovering_uncertain: false,
        close,
        resume_session_id: args.resume_session_id,
        pending_input_id: None,
        early_updates: Vec::new(),
        cleanup_error: None,
        unsaved: VecDeque::new(),
        history_lease: Some(history_lease),
        messages,
        history_request: None,
        reconcile_request: None,
        load_session: false,
        capability_notice: None,
        awaiting_catch_up: false,
        capability_remote_cursor: 0,
    }));
    registry().lock().await.insert(execution_id, row.clone());
    tokio::spawn(run(channel, row, outbound_rx, cancel_rx, close_rx, cwd, bootstrap_data));
    Ok(snapshot)
}

async fn run(
    mut channel: Channel<client::Msg>,
    row: Arc<Mutex<Thread>>,
    outbound: mpsc::UnboundedReceiver<Value>,
    cancel: mpsc::UnboundedReceiver<()>,
    close: mpsc::UnboundedReceiver<oneshot::Sender<Result<(), String>>>,
    cwd: String,
    initial_data: Vec<u8>,
) {
    let epoch = row.lock().await.transport_epoch;
    run_stream(&mut channel, row.clone(), outbound, cancel, close, cwd, initial_data).await;
    // Every exit, including malformed frames and initialization timeout, closes
    // stdin explicitly so the remote host can reap its native child processes.
    let mut thread = row.lock().await;
    if thread.transport_epoch == epoch {
        thread.transport_active = false;
        thread.awaiting_catch_up = true;
        if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
        if mark_todos_stale(&mut thread.snapshot) { emit_todos(&mut thread).await; }
        if let Some(pending) = thread.response_delivery.take() {
            let _ = pending.reply.send(Err("The agent connection closed before the response was sent.".into()));
        }
    }
    drop(thread);
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

async fn run_stream(
    channel: &mut Channel<client::Msg>,
    row: Arc<Mutex<Thread>>,
    mut outbound: mpsc::UnboundedReceiver<Value>,
    mut cancel: mpsc::UnboundedReceiver<()>,
    mut close: mpsc::UnboundedReceiver<oneshot::Sender<Result<(), String>>>,
    cwd: String,
    initial_data: Vec<u8>,
) {
    if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"still","title":"Still","version":env!("CARGO_PKG_VERSION")}}})).await{transport_lost(&row,&format!("ACP initialize failed: {error}")).await;return}
    let mut buffer = initial_data;
    let mut discarding_frame = false;
    let mut stage = 0_u8;
    let mut session_id = None;
    let mut permission: Option<(Value, Vec<Value>)> = None;
    let mut stderr = String::new();

    let mut cancel_received = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

    loop {
        tokio::select! {
          Some(reply) = close.recv() => {
            if row.lock().await.snapshot.persistent {
                if let Err(error) = send(&channel, &json!({"jsonrpc":"2.0","id":"still-close","method":"_still/shutdown"})).await {
                    let _ = reply.send(Err(format!("Could not stop the persistent worker: {error}"))); return;
                }
            }
            if let Err(error) = channel.eof().await {
                let _ = reply.send(Err(format!("Could not request agent shutdown: {error}")));
                return;
            }
            let ended = tokio::time::timeout(Duration::from_secs(7), async {
                while let Some(message) = channel.wait().await {
                    match message {
                        ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => return Err(format!("Agent cleanup failed (exit {exit_status}). Inspect the remote process before deleting this conversation.")),
                        ChannelMsg::Close | ChannelMsg::Eof => return Ok(()),
                        _ => {}
                    }
                }
                Ok(())
            }).await;
            let _ = channel.close().await;
            let result = ended.unwrap_or_else(|_| Err("Agent shutdown timed out. Inspect the remote process before deleting this conversation.".to_owned()));
            if let Err(message) = &result {
                let mut thread = row.lock().await;
                thread.cleanup_error = Some(message.clone());
                thread.snapshot.state = "submissionUnknown".into();
                thread.snapshot.last_error = Some(message.clone());
                let mut event = Event::new("threadError"); event.text = Some(message.clone()); emit(&mut thread, event).await;
            }
            let _ = reply.send(result);
            return;
          },
          _ = tokio::time::sleep_until(deadline), if stage < 3 => { fail(&row, &format!("Remote ACP initialization timed out. Check installation and authentication in the server terminal. {}", stderr.trim())).await; return; },
         _ = cancel.recv(), if !cancel_received => {
            cancel_received=true;
             if let Some((request_id,_))=permission.take(){
                if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":{"outcome":"cancelled"}}})).await{fail(&row,&error).await;return;}
                let mut thread=row.lock().await;
                let request = thread.snapshot.pending_permission.take();
                thread.permission=None;
                if let Some(request) = request {
                    let mut event = Event::new("requestOutcome");
                    event.request_outcome = Some(json!({"requestId":request_id,"kind":"permission","title":request["title"].as_str().unwrap_or("Permission required"),"outcome":"cancelled"}));
                    emit(&mut thread,event).await;
                }
             }
             {
                let mut thread = row.lock().await;
                 if let Some(request_id) = thread.pending_input_id.take() {
                   let _ = send(&channel, &json!({"jsonrpc":"2.0","id":request_id,"result":{"action":"cancel"}})).await;
                   let request = thread.snapshot.pending_input.take();
                   if let Some(request) = request {
                     let mut event = Event::new("requestOutcome");
                     event.request_outcome = Some(json!({"requestId":request_id,"kind":"question","title":request["title"].as_str().unwrap_or("Agent needs your input"),"outcome":"cancelled"}));
                     emit(&mut thread,event).await;
                   }
                }
             }
            if let Some(session)=session_id.as_ref(){
               if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await{fail(&row,&error).await;return;}
              let mut thread=row.lock().await;
              if thread.snapshot.turn_active {
                thread.snapshot.state="working".into();
                let mut event=Event::new("threadStopped");event.text=Some("Cancellation requested; waiting for the agent to confirm it has stopped.".into());emit(&mut thread,event).await;
              }
            }
         },
          Some(value)=outbound.recv()=>{
            let mut thread = row.lock().await;
            let pending_response = value.get("result").is_some() && thread.response_delivery.as_ref().is_some_and(|pending| value.get("id") == Some(&pending.id));
            if pending_response {
                let pending = thread.response_delivery.take().unwrap();
                let kind = pending.outcome["kind"].as_str().unwrap_or("");
                let active = if kind == "permission" { thread.permission.as_ref().map(|request| &request.id) == Some(&pending.id) } else { thread.pending_input_id.as_ref() == Some(&pending.id) };
                if !active {
                    let _ = pending.reply.send(Err("This request was cancelled before its response was sent.".into()));
                    continue;
                }
                match send(&channel,&value).await {
                    Ok(()) => {
                        if thread.snapshot.persistent { thread.response_delivery = Some(pending); continue; }
                        if kind == "permission" { thread.permission = None; thread.snapshot.pending_permission = None; permission = None; }
                        else { thread.pending_input_id = None; thread.snapshot.pending_input = None; }
                        thread.snapshot.state = "working".into();
                        let mut event = Event::new("requestOutcome"); event.request_outcome = Some(pending.outcome); emit(&mut thread,event).await;
                        let mut event = Event::new("threadState"); event.state = Some("working".into()); emit(&mut thread,event).await;
                        let _ = pending.reply.send(Ok(()));
                    }
                    Err(error) => {
                        let mut outcome = pending.outcome; outcome["outcome"] = json!("uncertain");
                        let mut event = Event::new("requestOutcome"); event.request_outcome = Some(outcome); emit(&mut thread,event).await;
                        let _ = pending.reply.send(Err(format!("Response delivery was not confirmed: {error}")));
                        drop(thread); transport_lost(&row,&format!("SSH stream closed while sending the response: {error}")).await; return;
                    }
                }
            } else {
                drop(thread);
                if value.get("method").and_then(Value::as_str)==Some("session/prompt"){cancel_received=false;}
                if let Err(error)=send(&channel,&value).await{transport_lost(&row,&format!("SSH stream closed before request send: {error}")).await;return}
            }
          },
           incoming=channel.wait()=>match incoming{
             Some(ChannelMsg::Data{data})=>{
               buffer.extend_from_slice(&data);
               let mut protocol_issue = None;
               loop {
                 if discarding_frame {
                   if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                     buffer.drain(..=end); discarding_frame = false; continue;
                   }
                   buffer.clear(); break;
                 }
                 let Some(end) = buffer.iter().position(|byte| *byte == b'\n') else {
                   if buffer.len() > FRAME_LIMIT {
                     buffer.clear(); discarding_frame = true;
                     protocol_issue = Some("A remote ACP frame exceeded 16 MiB and was discarded.");
                   }
                   break;
                 };
                 if end + 1 > FRAME_LIMIT {
                   buffer.drain(..=end);
                   protocol_issue = Some("A remote ACP frame exceeded 16 MiB and was discarded.");
                   continue;
                 }
                 let frame: Vec<u8> = buffer.drain(..=end).collect();
                 if frame.iter().all(u8::is_ascii_whitespace) { continue; }
                 let value = match serde_json::from_slice::<Value>(&frame) {
                   Ok(value) => value,
                   Err(_) => { protocol_issue = Some("Remote stdout contained an invalid ACP record; it was skipped."); continue; }
                 };
                 if let Err(error) = handle(channel, &row, &cwd, &mut stage, &mut session_id, &mut permission, value).await {
                   fail(&row, &error).await; return;
                 }
               }
               if let Some(message) = protocol_issue {
                 if stage < 3 { fail(&row, message).await; return; }
                 protocol_warning(&row, message).await;
               }
             },
             Some(ChannelMsg::ExtendedData{data,..})=>{stderr.push_str(&String::from_utf8_lossy(&data));if stderr.len()>16384{let mut cut=stderr.len()-16384;while !stderr.is_char_boundary(cut){cut+=1;}stderr.drain(..cut);}},
             Some(ChannelMsg::Eof|ChannelMsg::Close)|None=>{transport_lost(&row,stderr.trim()).await;return},_=>{}
           }
        }
    }
}
async fn send(channel: &Channel<client::Msg>, value: &Value) -> Result<(), String> {
    let mut frame = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    frame.push(b'\n');
    channel.data_bytes(frame).await.map_err(|e| e.to_string())
}
async fn handle(
    channel: &mut Channel<client::Msg>,
    row: &Arc<Mutex<Thread>>,
    cwd: &str,
    stage: &mut u8,
    session_id: &mut Option<String>,
    permission: &mut Option<(Value, Vec<Value>)>,
    value: Value,
) -> Result<(), String> {
    if let Some(cursor) = value.pointer("/_still/index").and_then(Value::as_u64) {
        let mut thread = row.lock().await;
        if cursor <= thread.snapshot.remote_cursor && value.pointer("/_still/pending").and_then(Value::as_bool) != Some(true) { return Ok(()); }
        thread.snapshot.remote_cursor = thread.snapshot.remote_cursor.max(cursor);
    }
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        if method == "_still/request_outcome" {
            let outcome = value.get("params").cloned().ok_or("Missing request outcome")?;
            let mut thread = row.lock().await;
            let request_id = outcome.get("requestId").cloned().ok_or("Missing response identity")?;
            if outcome["kind"] == "permission" { thread.permission = None; thread.snapshot.pending_permission = None; *permission = None; }
            else { thread.pending_input_id = None; thread.snapshot.pending_input = None; }
            thread.snapshot.state = "working".into();
            let mut event = Event::new("requestOutcome"); event.request_outcome = Some(outcome); emit(&mut thread,event).await;
            if thread.response_delivery.as_ref().is_some_and(|pending| pending.id == request_id) {
                let pending = thread.response_delivery.take().unwrap(); let _ = pending.reply.send(Ok(()));
            }
            let mut event = Event::new("threadState"); event.state = Some("working".into()); emit(&mut thread,event).await;
            return Ok(());
        }
        if method == "_still/history_reverted" {
            let params = &value["params"];
            let message_id = params["messageId"].as_str().ok_or("Missing history boundary")?;
            let mut thread = row.lock().await;
            if thread.messages.iter().any(|message| message.message_id.as_deref() == Some(message_id)) {
                let next_session_id = params["sessionId"].as_str().map(str::to_owned);
                let session_changed = thread.snapshot.agent_session_id != next_session_id;
                thread.snapshot.agent_session_id = next_session_id;
                *session_id = thread.snapshot.agent_session_id.clone();
                if session_changed && mark_capabilities_stale(&mut thread.snapshot) {
                    emit_capabilities(&mut thread).await;
                }
                thread.snapshot.state = "working".into(); thread.snapshot.last_error = None;
                thread.recovering_uncertain = false;
                thread.snapshot.recovery_required = false;
                let mut event = Event::new("historyReverted"); event.message_id = Some(message_id.to_owned()); emit(&mut thread,event).await;
            }
            return Ok(());
        }
        if method == "_still/capabilities_changed" {
            let mut thread = row.lock().await;
            let Some(raw) = value.pointer("/params/capabilities") else {
                if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
                note_capability_error(&mut thread, "Capability notification omitted its report.").await;
                return Ok(());
            };
            let cursor = value.pointer("/_still/index").and_then(Value::as_u64);
            let fresh = !thread.awaiting_catch_up;
            match accept_capabilities(&mut thread, raw, cursor, fresh) {
                Ok(true) => {
                    thread.capability_notice = None;
                    emit_capabilities(&mut thread).await;
                }
                Ok(false) => {}
                Err(error) => {
                    if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
                    note_capability_error(&mut thread, &error).await;
                }
            }
            return Ok(());
        }
        if method == "_still/todos_changed" {
            let mut thread = row.lock().await;
            let observation = if thread.awaiting_catch_up { TodoObservation::Replay } else { TodoObservation::Live };
            if update_todos(&mut thread.snapshot, value.pointer("/params/todos"), observation) { emit_todos(&mut thread).await; }
            return Ok(());
        }
        if method == "_still/chat_title_changed" {
            let Some(title) = value.pointer("/params/title").and_then(Value::as_str) else { return Ok(()); };
            let title = title.trim();
            if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) { return Ok(()); }
            let mut thread = row.lock().await;
            let mut event = Event::new("chatTitle");
            event.title = Some(title.to_owned());
            emit(&mut thread, event).await;
            return Ok(());
        }
        if method == "_still/caught_up" {
            let mut thread = row.lock().await;
            let params = &value["params"];
            let caught_up_index = params["index"].as_u64().unwrap_or(0);
            thread.snapshot.remote_cursor = thread.snapshot.remote_cursor.max(caught_up_index);
            if update_todos(&mut thread.snapshot, params.get("todos"), TodoObservation::CatchUp) { emit_todos(&mut thread).await; }
            thread.awaiting_catch_up = false;
            if let Some(raw) = params.get("capabilities") {
                match accept_capabilities(&mut thread, raw, Some(caught_up_index), true) {
                    Ok(true) => {
                        thread.capability_notice = None;
                        emit_capabilities(&mut thread).await;
                    }
                    Ok(false) => {}
                    Err(error) => {
                        if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
                        note_capability_error(&mut thread, &error).await;
                    }
                }
            } else if mark_capabilities_stale(&mut thread.snapshot) {
                emit_capabilities(&mut thread).await;
            }
            let unconfirmed_prompt = thread.prompt.is_some() && params["busy"] == false;
            thread.snapshot.turn_active = params["busy"].as_bool().unwrap_or(false);
            if unconfirmed_prompt || thread.recovering_uncertain {
                thread.snapshot.state = "submissionUnknown".into();
                thread.snapshot.recovery_required = true;
                thread.snapshot.last_error = Some("The last prompt was not confirmed by the remote worker. It has not been resent. Inspect the provider session before continuing.".into());
                let mut event = Event::new("threadError"); event.state = Some("submissionUnknown".into()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread,event).await;
                return Ok(());
            }
            if matches!(thread.snapshot.state.as_str(), "error" | "submissionUnknown") {
                let mut event = Event::new("threadState"); event.state = Some(thread.snapshot.state.clone()); emit(&mut thread,event).await;
                return Ok(());
            }
            if thread.snapshot.pending_input.is_some() || thread.snapshot.pending_permission.is_some() { thread.snapshot.state = "inputRequired".into(); }
            else { thread.snapshot.state = "working".into(); }
            thread.prompt = params.get("activePrompt").filter(|value| !value.is_null()).cloned();
            thread.snapshot.prompt_id = thread.prompt.clone();
            thread.snapshot.last_error = None;
            let mut event = Event::new("threadState"); event.state = Some(thread.snapshot.state.clone()); emit(&mut thread,event).await;
            return Ok(());
        }
        if method == "session/update" {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if *stage < 3 {
                let mut thread = row.lock().await;
                if thread.early_updates.len() >= 256 {
                    return Err("Too many updates before session initialization.".into());
                }
                thread.early_updates.push(params);
            } else {
                update(row, params).await;
            }
            return Ok(());
        }
        if method == "elicitation/create" {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let id = value
                .get("id")
                .cloned()
                .ok_or("Question omitted its request id")?;
            let mut thread = row.lock().await;
            if params.get("sessionId").and_then(Value::as_str)
                != thread.snapshot.agent_session_id.as_deref()
                || params.get("mode").and_then(Value::as_str) != Some("form")
            {
                drop(thread);
                send(
                    channel,
                    &json!({"jsonrpc":"2.0","id":id,"result":{"action":"decline"}}),
                )
                .await?;
                return Ok(());
            }
            if thread.pending_input_id.is_some() {
                return Err("A second question arrived before the first was answered.".into());
            }
            let input = json!({"requestId":id,"title":params.get("message").and_then(Value::as_str).unwrap_or("Agent needs your input"),"schema":params.get("requestedSchema")});
            thread.pending_input_id = Some(id);
            thread.snapshot.pending_input = Some(input.clone());
            thread.snapshot.state = "inputRequired".into();
            let mut event = Event::new("input");
            event.input = Some(input);
            emit(&mut thread, event).await;
            return Ok(());
        }
        if method == "session/request_permission" {
            if permission.is_some() {
                return Err("Concurrent permission requests are not supported.".into());
            }
            let id = value
                .get("id")
                .cloned()
                .ok_or("Permission request has no JSON-RPC id")?;
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if row.lock().await.snapshot.agent_session_id.as_deref()
                != params.get("sessionId").and_then(Value::as_str)
            {
                return Err("Permission request has an unexpected ACP session id.".into());
            }
            let options = params
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if options.is_empty() {
                return Err("Permission request has no options.".into());
            }
            let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
            let detail = json!({"requestId":id,"sessionId":params.get("sessionId").and_then(Value::as_str).unwrap_or(""),"toolCallId":tool.get("toolCallId").and_then(Value::as_str).unwrap_or(""),"title":tool.get("title").and_then(Value::as_str).or_else(||tool.get("name").and_then(Value::as_str)).unwrap_or("Permission required"),"description":tool.get("description"),"command":tool.get("rawInput").and_then(|v|v.get("command")).or_else(||tool.get("content").and_then(Value::as_array).and_then(|a|a.first()).and_then(|x|x.pointer("/content/text"))),"rawInput":tool.get("rawInput"),"content":tool.get("content"),"options":options});
            *permission = Some((id.clone(), options.clone()));
            {
                let mut thread = row.lock().await;
                thread.permission = Some(PendingPermission {
                    id: id.clone(),
                    options: options.clone(),
                });
            }
            let mut t = row.lock().await;
            t.snapshot.state = "inputRequired".into();
            t.snapshot.pending_permission = Some(detail.clone());
            let mut e = Event::new("permission");
            e.permission = Some(detail);
            e.state = Some("inputRequired".into());
            emit(&mut t, e).await;
            return Ok(());
        }
        if let Some(id) = value.get("id") {
            send(channel, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Still does not implement this ACP client method."}})).await?;
        }
        return Ok(());
    }
    let id = value.get("id").cloned();
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Remote ACP request failed.");
        if let Some(id) = id {
            if let Some(number) = id.as_u64() {
                let mut thread = row.lock().await;
                if thread.reconcile_request.as_ref().is_some_and(|pending| pending.request_id == number) {
                    let pending = thread.reconcile_request.take().unwrap();
                    let _ = pending.reply.send(Err(message.to_owned()));
                    return Ok(());
                }
                if thread.history_request.as_ref().is_some_and(|pending| pending.request_id == number) {
                    let pending = thread.history_request.take().unwrap();
                    thread.snapshot.state = if error.pointer("/data/historyUncertain").and_then(Value::as_bool) == Some(true) { "submissionUnknown".into() } else { pending.previous_state };
                    thread.snapshot.last_error = Some(message.to_owned());
                    let mut event = Event::new("threadError"); event.state = Some(thread.snapshot.state.clone()); event.text = Some(message.to_owned()); emit(&mut thread, event).await;
                    let _ = pending.reply.send(Err(message.to_owned()));
                    return Ok(());
                }
                if let Some(pending) = thread.config_requests.remove(&number) {
                    let cursor = thread.capability_remote_cursor;
                    if thread.transport_active && !thread.awaiting_catch_up && thread.capability_notice.is_none()
                        && restore_rejected_capability_report(&mut thread.snapshot, &pending, cursor) {
                        emit_capabilities(&mut thread).await;
                    }
                    let _ = pending.reply.send(Err(message.to_owned()));
                    return Ok(());
                }
                drop(thread);
            }
            if (*stage == 0 && id.as_u64() == Some(1)) || (*stage == 2 && id.as_u64() == Some(3)) {
                return Err(message.into());
            }
            let mut thread = row.lock().await;
            if thread.prompt.as_ref().is_some_and(|request| request == &id) {
                thread.prompt = None;
                thread.snapshot.prompt_id = None;
                thread.recovering_uncertain = false;
                thread.snapshot.recovery_required = false;
                thread.snapshot.turn_active = false;
                thread.snapshot.state = "error".into();
                thread.snapshot.last_error = Some(message.to_owned());
                thread.snapshot.pending_permission = None;
                thread.permission = None;
                *permission = None;
                let mut event = Event::new("threadError");
                event.state = Some("error".into());
                event.text = Some(message.to_owned());
                emit(&mut thread, event).await;
                return Ok(());
            }
        }
        return Err(message.into());
    }
    let Some(result) = value.get("result") else {
        return Ok(());
    };
    if *stage == 0 && id.as_ref().and_then(Value::as_u64) == Some(1) {
        if result.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
            return Err("Remote agent must negotiate ACP v1.".into());
        }
        let name = result
            .get("agentInfo")
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Remote agent")
            .to_owned();
        {
            let mut t = row.lock().await;
            t.snapshot.agent_name = name;
            // Direct ACP providers advertise their own resume support; the wrapper's
            // hard-coded loadSession is not evidence for every native provider.
            t.load_session = result
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut e = Event::new("threadState");
            e.state = Some("connecting".into());
            emit(&mut t, e).await
        }
        // authMethods lists possible sign-in routes, not whether sign-in is needed.
        // Use credentials already configured on the remote account.
        *stage = 2;
        let resume = row.lock().await.resume_session_id.clone();
        let params = if let Some(resume) = resume {
            *session_id = Some(resume.clone());
            json!({"cwd":cwd,"mcpServers":[],"sessionId":resume})
        } else {
            json!({"cwd":cwd,"mcpServers":[]})
        };
        send(channel,&json!({"jsonrpc":"2.0","id":3,"method":if session_id.is_some(){"session/load"}else{"session/new"},"params":params})).await?;
        return Ok(());
    }
    if *stage == 2 && id.as_ref().and_then(Value::as_u64) == Some(3) {
        let sid = result
            .get("sessionId")
            .and_then(Value::as_str)
            .or(session_id.as_deref())
            .ok_or("Session response omitted sessionId")?
            .to_owned();
        *session_id = Some(sid.clone());
        *stage = 3;
        let mut configs = result
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        add_legacy_config(&mut configs, result);
        let mut t = row.lock().await;
        if let Some(maximum) = result.pointer("/_meta/maxRequestId").and_then(Value::as_u64) { IDS.fetch_max(maximum,Ordering::SeqCst); }
        t.snapshot.agent_session_id = Some(sid.clone());
        let reported_resumable = result.pointer("/_meta/resumable").and_then(Value::as_bool);
        t.snapshot.resumable = provider_resumable(&t.snapshot.agent_id, reported_resumable, t.load_session, &sid);
        let capabilities = result.pointer("/_meta/historyCapabilities");
        t.snapshot.history_capabilities = json!({"revert":capabilities.and_then(|value| value["revert"].as_bool()).unwrap_or(false),"retry":capabilities.and_then(|value| value["retry"].as_bool()).unwrap_or(false)});
        let mut capability_event = Event::new("historyCapabilities");
        capability_event.history_capabilities = Some(t.snapshot.history_capabilities.clone());
        emit(&mut t, capability_event).await;
        if !t.awaiting_catch_up && update_todos(&mut t.snapshot, result.pointer("/_meta/todos"), TodoObservation::Live) { emit_todos(&mut t).await; }
        if !t.awaiting_catch_up {
            if let Some(raw) = result.pointer("/_meta/capabilities") {
                let cursor = t.snapshot.remote_cursor;
                match accept_capabilities(&mut t, raw, Some(cursor), true) {
                    Ok(true) => { t.capability_notice = None; emit_capabilities(&mut t).await; }
                    Ok(false) => {}
                    Err(error) => {
                        if mark_capabilities_stale(&mut t.snapshot) { emit_capabilities(&mut t).await; }
                        note_capability_error(&mut t, &error).await;
                    }
                }
            }
        }
        t.snapshot.config_options = configs.clone();
        t.snapshot.turn_active = result.pointer("/_meta/busy").and_then(Value::as_bool).unwrap_or(t.snapshot.turn_active);
        let restored_prompt = result.pointer("/_meta/activePrompt").filter(|value| !value.is_null()).cloned();
        if let Some(prompt) = restored_prompt { t.prompt = Some(prompt); }
        t.snapshot.prompt_id = t.prompt.clone();
        t.snapshot.state = "working".into();
        if !configs.is_empty() {
            let mut config_event = Event::new("configOptions");
            config_event.config_options = Some(configs);
            emit(&mut t, config_event).await;
        }
        let mut e = Event::new("threadState");
        e.state = Some("working".into());
        emit(&mut t, e).await;
        let early = std::mem::take(&mut t.early_updates);
        drop(t);
        for params in early {
            update(row, params).await;
        }
        return Ok(());
    }
    if let Some(request_id) = id.as_ref().and_then(Value::as_u64) {
        let mut thread = row.lock().await;
        if thread.reconcile_request.as_ref().is_some_and(|pending| pending.request_id == request_id) {
            let pending = thread.reconcile_request.take().unwrap();
            let Some(busy) = result.get("busy").and_then(Value::as_bool) else {
                let _ = pending.reply.send(Err("The remote worker did not report its execution state.".into()));
                return Ok(());
            };
            if busy {
                thread.snapshot.turn_active = true;
                thread.snapshot.state = if thread.snapshot.pending_input.is_some() || thread.snapshot.pending_permission.is_some() { "inputRequired" } else { "working" }.into();
                thread.snapshot.last_error = None;
                let mut event = Event::new("threadState"); event.state = Some(thread.snapshot.state.clone()); emit(&mut thread, event).await;
            } else {
                if result.get("activePrompt").is_some_and(|value| !value.is_null()) {
                    let _ = pending.reply.send(Err("The remote worker reports no active turn but still identifies a prompt. Check status again before continuing.".into()));
                    return Ok(());
                }
                thread.snapshot.turn_active = false;
                if thread.prompt.take().is_some() {
                    thread.snapshot.prompt_id = None;
                    thread.snapshot.state = "complete".into();
                    thread.snapshot.last_error = None;
                    thread.snapshot.recovery_required = false;
                    thread.recovering_uncertain = false;
                    let mut event = Event::new("threadComplete"); event.state = Some("complete".into()); event.text = Some("Remote status confirms no active turn. The prompt was not resent.".into()); emit(&mut thread, event).await;
                } else {
                    let mut event = Event::new("threadState"); event.state = Some(thread.snapshot.state.clone()); emit(&mut thread, event).await;
                }
            }
            let _ = pending.reply.send(Ok(()));
            return Ok(());
        }
        if thread.history_request.as_ref().is_some_and(|pending| pending.request_id == request_id) {
            let pending = thread.history_request.take().unwrap();
            let sid = result["sessionId"].as_str().filter(|id| !id.is_empty());
            if result["reverted"] != true || sid.is_none() {
                thread.snapshot.state = "submissionUnknown".into();
                thread.snapshot.last_error = Some("The provider did not confirm the history change. Inspect its session before continuing.".into());
                let mut event = Event::new("threadError"); event.state = Some(thread.snapshot.state.clone()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread, event).await;
                let _ = pending.reply.send(Err(thread.snapshot.last_error.clone().unwrap()));
                return Ok(());
            }
            if invalidate_for_provider_session(&mut thread.snapshot, sid) { emit_capabilities(&mut thread).await; }
            thread.snapshot.agent_session_id = sid.map(str::to_owned);
            *session_id = thread.snapshot.agent_session_id.clone();
            thread.snapshot.state = "working".into(); thread.snapshot.last_error = None;
            let mut event = Event::new("historyReverted");
            event.message_id = pending.message.message_id;
            event.text = pending.message.text;
            event.checkpoint = Some(json!({"sequence":pending.message.sequence,"attemptId":pending.message.attempt_id}));
            emit(&mut thread, event).await;
            if let Some(options) = result["configOptions"].as_array() {
                thread.snapshot.config_options = options.clone();
                let mut event = Event::new("configOptions"); event.config_options = Some(options.clone()); emit(&mut thread, event).await;
            }
            let saved = flush_history(&mut thread).await.map_err(|error| error.message);
            if let Err(message) = &saved {
                thread.snapshot.state = "submissionUnknown".into();
                thread.snapshot.last_error = Some(format!("The provider reverted this conversation, but its local checkpoint could not be saved: {message}"));
                let mut event = Event::new("threadError"); event.state = Some(thread.snapshot.state.clone()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread, event).await;
            }
            let _ = pending.reply.send(saved);
            return Ok(());
        }
        if let Some(pending) = thread.config_requests.remove(&request_id) {
            if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
                thread.snapshot.config_options = options.clone();
            } else if pending.id.starts_with("still:") {
                if let Some(option) = thread
                    .snapshot
                    .config_options
                    .iter_mut()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some(pending.id.as_str()))
                {
                    option["currentValue"] = pending.value.clone();
                }
            } else {
                let _ = pending.reply.send(Err("Agent acknowledged the setting without configOptions. Refresh the thread before retrying.".into()));
                return Ok(());
            }
            let mut event = Event::new("configOptions");
            event.config_options = Some(thread.snapshot.config_options.clone());
            emit(&mut thread, event).await;
            let cursor = thread.capability_remote_cursor;
            if thread.transport_active && !thread.awaiting_catch_up && thread.capability_notice.is_none()
                && confirm_config_capability_report(&mut thread.snapshot, &pending, cursor) {
                emit_capabilities(&mut thread).await;
            }
            let _ = pending.reply.send(Ok(()));
            return Ok(());
        }
    }
    if *stage == 3 {
        if let Some(id) = id {
            let mut t = row.lock().await;
            if t.prompt.as_ref().is_some_and(|request| request == &id) {
                let stop_reason = value
                    .get("result")
                    .and_then(|result| result.get("stopReason"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                if !matches!(
                    stop_reason,
                    "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
                ) {
                    return Err(format!(
                        "ACP prompt response had unsupported stopReason '{stop_reason}'."
                    ));
                }
                t.prompt = None;
                t.snapshot.prompt_id = None;
                t.recovering_uncertain = false;
                t.snapshot.recovery_required = false;
                t.snapshot.turn_active = false;
                if let Some(request) = t.snapshot.pending_permission.take() {
                    if let Some((request_id, _)) = permission.take() {
                        let mut event = Event::new("requestOutcome");
                        event.request_outcome = Some(json!({"requestId":request_id,"kind":"permission","title":request["title"].as_str().unwrap_or("Permission required"),"outcome":"uncertain"}));
                        emit(&mut t,event).await;
                    }
                }
                if let Some(request) = t.snapshot.pending_input.take() {
                    if let Some(request_id) = t.pending_input_id.take() {
                        let mut event = Event::new("requestOutcome");
                        event.request_outcome = Some(json!({"requestId":request_id,"kind":"question","title":request["title"].as_str().unwrap_or("Agent needs your input"),"outcome":"uncertain"}));
                        emit(&mut t,event).await;
                    }
                }
                t.permission = None;
                t.snapshot.last_error = None;
                *permission = None;
                t.snapshot.state = if stop_reason == "cancelled" {
                    "cancelled"
                } else {
                    "complete"
                }
                .into();
                let mut event = Event::new("threadComplete");
                event.state = Some(t.snapshot.state.clone());
                event.text = Some(format!("stopReason: {stop_reason}"));
                emit(&mut t, event).await;
            }
        }
    }
    Ok(())
}
fn add_legacy_config(options: &mut Vec<Value>, result: &Value) {
    for (category, key, list, current) in [
        ("mode", "modes", "availableModes", "currentModeId"),
        ("model", "models", "availableModels", "currentModelId"),
    ] {
        if options
            .iter()
            .any(|o| o.get("category").and_then(Value::as_str) == Some(category))
        {
            continue;
        }
        let Some(data) = result.get(key) else {
            continue;
        };
        let Some(values) = data.get(list).and_then(Value::as_array) else {
            continue;
        };
        let id_key = if category == "mode" { "id" } else { "modelId" };
        options.push(json!({"id":format!("still:{category}"),"name":if category=="mode" {"Mode"} else {"Model"},"category":category,"type":"select","currentValue":data.get(current),"options":values.iter().filter_map(|v| Some(json!({"value":v.get(id_key)?.as_str()?,"name":v.get("name")?.as_str()?,"description":v.get("description")}))).collect::<Vec<_>>()}));
    }
}
async fn update(row: &Arc<Mutex<Thread>>, params: Value) {
    let u = params.get("update").cloned().unwrap_or(Value::Null);
    let kind = u
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if !matches!(
        kind,
        "agent_message_chunk"
            | "agent_thought_chunk"
            | "agent_message"
            | "tool_call"
            | "tool_call_update"
            | "plan"
            | "current_mode_update"
            | "config_option_update"
            | "available_commands_update"
            | "session_info_update"
            | "usage_update"
            | "notice"
            | "session_error"
            | "still_connection_state"
            | "still_message_checkpoint"
    ) {
        return;
    }
    let mut t = row.lock().await;
    if params.get("sessionId").and_then(Value::as_str) != t.snapshot.agent_session_id.as_deref() {
        return;
    }
    if kind == "config_option_update" {
        if let Some(options) = u.get("configOptions").and_then(Value::as_array) {
            let options = options.clone();
            let changed = effective_config_key(&options) != effective_config_key(&t.snapshot.config_options);
            t.snapshot.config_options = options.clone();
            if changed && mark_capabilities_stale(&mut t.snapshot) { emit_capabilities(&mut t).await; }
            let mut event = Event::new("configOptions");
            event.config_options = Some(options);
            emit(&mut t, event).await;
        }
        return;
    }
    if kind == "still_message_checkpoint" {
        let message_id = u["messageId"].as_str();
        if let Some(message) = t.messages.iter().find(|event| event.message_id.as_deref() == message_id && message_id.is_some()) {
            if message.attempt_id.as_deref() == Some(t.snapshot.execution_id.as_str()) && u["checkpoint"].is_object() {
                let mut event = Event::new("messageCheckpoint"); event.message_id = message_id.map(str::to_owned); event.checkpoint = Some(u["checkpoint"].clone()); emit(&mut t, event).await;
            }
        }
        return;
    }
    if kind == "still_connection_state" {
        if t.snapshot.turn_active {
            t.snapshot.state = if t.snapshot.pending_input.is_some() || t.snapshot.pending_permission.is_some() { "inputRequired" } else { "working" }.into();
            t.snapshot.last_error = None;
        }
        let mut event = Event::new("threadState"); event.state = Some(t.snapshot.state.clone()); emit(&mut t, event).await;
        return;
    }
    let mut e = Event::new("toolUpdate");
    e.message_id = u
        .pointer("/_meta/messageId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match kind {
        "agent_thought_chunk" => {
            e.kind = "reasoningChunk".into();
            e.text = u
                .pointer("/content/text")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        "plan" => {
            e.kind = "plan".into();
            e.plan = u.get("entries").filter(|v| v.is_array()).cloned();
        }
        "available_commands_update" => {
            e.kind = "commands".into();
            t.snapshot.commands = u
                .get("availableCommands")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            e.commands = Some(json!(t.snapshot.commands));
        }
        "current_mode_update" => {
            if let Some(value) = u.get("currentModeId") {
                let previous_config = effective_config_key(&t.snapshot.config_options);
                if let Some(option) = t
                    .snapshot
                    .config_options
                    .iter_mut()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some("still:mode"))
                {
                    option["currentValue"] = value.clone();
                }
                if previous_config != effective_config_key(&t.snapshot.config_options) && mark_capabilities_stale(&mut t.snapshot) { emit_capabilities(&mut t).await; }
                e.kind = "configOptions".into();
                e.config_options = Some(t.snapshot.config_options.clone());
            }
        }
        "agent_message_chunk" => {
            e.kind = "assistantChunk".into();
            e.text = u
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        "agent_message" => {
            e.kind = "assistantMessage".into();
            e.text = u
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        "tool_call" | "tool_call_update" => {
            e.kind = if kind == "tool_call" {
                "toolStart"
            } else {
                "toolUpdate"
            }
            .into();
            e.tool_call_id = u
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            e.title = u
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| u.get("name").and_then(Value::as_str))
                .map(str::to_owned);
            e.status = u.get("status").and_then(Value::as_str).map(str::to_owned);
            e.content = u.get("content").filter(|v| v.is_array()).cloned();
            e.tool_kind = u.get("kind").and_then(Value::as_str).map(str::to_owned);
            e.raw_input = u.get("rawInput").filter(|v| v.is_object()).cloned();
            e.raw_output = u.get("rawOutput").cloned();
            e.locations = u.get("locations").filter(|v| v.is_array()).cloned();
            e.output_delta = u
                .pointer("/_meta/outputDelta")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        "session_error" => {
            e.kind = "threadError".into();
            e.text = u.get("message").and_then(Value::as_str).map(str::to_owned);
            t.snapshot.last_error = e.text.clone();
            t.snapshot.state = failure_state(&t).into();
            e.state = Some(t.snapshot.state.clone());
            let active_reported = u.pointer("/_meta/executionActive").and_then(Value::as_bool) == Some(true);
            if active_reported { t.snapshot.turn_active = true; }
        }
        "notice" => {
            e.kind = "notice".into();
            e.title = Some("Agent notice".into());
            e.text = u.get("message").and_then(Value::as_str).map(str::to_owned);
        }
        _ => return,
    }
    emit(&mut t, e).await
}
async fn fail(row: &Arc<Mutex<Thread>>, message: &str) {
    let mut t = row.lock().await;
    t.awaiting_catch_up = true;
    if mark_capabilities_stale(&mut t.snapshot) { emit_capabilities(&mut t).await; }
    if mark_todos_stale(&mut t.snapshot) { emit_todos(&mut t).await; }
    t.snapshot.state = failure_state(&t).into();
    t.snapshot.last_error = Some(message.into());
    t.permission = None;
    t.snapshot.pending_permission = None;
    t.snapshot.pending_input = None;
    t.pending_input_id = None;
    for (_, pending) in t.config_requests.drain() {
        let _ = pending.reply.send(Err(message.into()));
    }
    if let Some(pending) = t.response_delivery.take() {
        let mut outcome = pending.outcome;
        outcome["outcome"] = json!("uncertain");
        let mut event = Event::new("requestOutcome"); event.request_outcome = Some(outcome); emit(&mut t,event).await;
        let _ = pending.reply.send(Err(message.into()));
    }
    if let Some(pending) = t.history_request.take() { let _ = pending.reply.send(Err(message.into())); }
    if let Some(pending) = t.reconcile_request.take() { let _ = pending.reply.send(Err(message.into())); }
    t.snapshot.turn_active = false;
    let mut e = Event::new("threadError");
    e.state = Some(t.snapshot.state.clone());
    e.text = Some(message.into());
    emit(&mut t, e).await
}
async fn protocol_warning(row: &Arc<Mutex<Thread>>, message: &str) {
    let mut thread = row.lock().await;
    thread.snapshot.last_error = Some(message.to_owned());
    thread.snapshot.state = failure_state(&thread).into();
    let mut event = Event::new("threadError");
    event.state = Some(thread.snapshot.state.clone());
    event.text = Some(message.to_owned());
    emit(&mut thread, event).await;
}
async fn transport_lost(row: &Arc<Mutex<Thread>>, detail: &str) {
    let mut thread = row.lock().await;
    if !thread.snapshot.persistent { drop(thread); fail(row,detail).await; return; }
    if detail.contains("Persistent worker is not available") || detail.contains("remote agent process has ended") || detail.contains("Cannot find module") {
        drop(thread); fail(row, "The server-side worker is no longer available. Resume the provider’s saved session explicitly; no prompt has been resent.").await; return;
    }
    thread.recovering_uncertain = thread.recovering_uncertain || thread.history_request.is_some() || matches!(thread.snapshot.state.as_str(), "submissionUnknown" | "rewinding");
    thread.snapshot.recovery_required = thread.recovering_uncertain;
    thread.snapshot.state = "detached".into();
    thread.transport_active = false;
    thread.awaiting_catch_up = true;
    if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
    if mark_todos_stale(&mut thread.snapshot) { emit_todos(&mut thread).await; }
    thread.snapshot.last_error = Some(if detail.is_empty() {
        "Connection interrupted. The agent continues on the server; reconnect to catch up.".to_owned()
    } else { format!("Could not attach to the remote agent: {detail}") });
    for (_, pending) in thread.config_requests.drain() { let _ = pending.reply.send(Err("Connection interrupted during configuration update.".into())); }
    if let Some(pending) = thread.response_delivery.take() { let _ = pending.reply.send(Err("Response delivery was not confirmed. Reattach to check its status.".into())); }
    if let Some(pending) = thread.history_request.take() { let _ = pending.reply.send(Err("History change was not confirmed. Reattach before retrying.".into())); }
    if let Some(pending) = thread.reconcile_request.take() { let _ = pending.reply.send(Err("The remote status check was interrupted. Reattach and check again.".into())); }
    let mut event = Event::new("threadState"); event.state = Some("detached".into()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread,event).await;
}
fn failure_state(thread: &Thread) -> &'static str {
    if thread.history_request.is_some() || thread.snapshot.state == "submissionUnknown" { "submissionUnknown" } else { "error" }
}

const TODO_CONFLICT_REASON: &str = "Showing saved Todos; the remote list does not match.";
const TODO_STALE_REASON: &str = "Showing saved Todos; updates may have continued on the server.";

fn valid_todo_sync(value: &Value) -> Option<TodoSync> {
    let state = value.get("state")?.as_str()?;
    if !matches!(state, "current" | "stale" | "conflict" | "unavailable") { return None; }
    let reason = value.get("reason").map(|reason| bounded_text(Some(reason), "Todo observation reason", 240, 960)).transpose().ok()?;
    Some(TodoSync { state: state.into(), reason })
}

fn set_todo_sync(snapshot: &mut Snapshot, state: &str, reason: Option<&str>) {
    snapshot.todo_sync = Some(TodoSync { state: state.into(), reason: reason.map(str::to_owned) });
}

fn mark_todos_stale(snapshot: &mut Snapshot) -> bool {
    if snapshot.todos.is_none() || snapshot.todo_sync.as_ref().is_some_and(|sync| matches!(sync.state.as_str(), "stale" | "conflict" | "unavailable")) { return false; }
    set_todo_sync(snapshot, "stale", Some(TODO_STALE_REASON));
    true
}

pub(crate) fn restore_todos(snapshot: &mut Snapshot) {
    let (todos, sync) = restore_todo_metadata(snapshot.todos.take(), snapshot.todo_sync.take());
    snapshot.todos = todos;
    snapshot.todo_sync = sync;
}

pub(crate) fn restore_todo_fields(row: &mut Value) {
    let todos = row.get("todos").filter(|value| !value.is_null()).cloned();
    let sync = row.get("todoSync").and_then(valid_todo_sync);
    let (todos, sync) = restore_todo_metadata(todos, sync);
    if let Some(object) = row.as_object_mut() {
        object.remove("todos"); object.remove("todoSync");
        if let Some(todos) = todos { object.insert("todos".into(), todos); }
        if let Some(sync) = sync { object.insert("todoSync".into(), json!(sync)); }
    }
}

fn restore_todo_metadata(todos: Option<Value>, sync: Option<TodoSync>) -> (Option<Value>, Option<TodoSync>) {
    let todos = match todos.as_ref().map(validate_todos).transpose() {
        Ok(todos) => todos,
        Err(_) => return (None, Some(TodoSync { state: "unavailable".into(), reason: Some("The saved Todo list could not be validated.".into()) })),
    };
    if sync.as_ref().is_some_and(|sync| matches!(sync.state.as_str(), "conflict" | "unavailable")) { return (todos, sync); }
    let sync = todos.as_ref().map(|todos| if todos["available"] == false {
        TodoSync { state: "unavailable".into(), reason: Some("This execution cannot provide Todo updates. Saved tasks remain readable.".into()) }
    } else {
        TodoSync { state: "stale".into(), reason: Some(TODO_STALE_REASON.into()) }
    });
    (todos, sync)
}

#[derive(Clone, Copy, PartialEq)]
enum TodoObservation { Live, Replay, CatchUp }

fn todo_task_state(todos: &Value) -> Value {
    json!({"revision":todos["revision"],"items":todos["items"],"activeId":todos.get("activeId")})
}

fn validate_todos(value: &Value) -> Result<Value, String> {
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(3) { return Err("Unsupported shared todo protocol version".into()); }
    let revision = value.get("revision").and_then(Value::as_u64).filter(|revision| *revision <= 9_007_199_254_740_991).ok_or("Todo snapshot has no valid revision")?;
    let available = value.get("toolAvailable").and_then(Value::as_bool).ok_or("Todo snapshot has no tool status")?;
    let service_available = value.get("available").and_then(Value::as_bool).ok_or("Todo snapshot has no service status")?;
    let items = value.get("items").and_then(Value::as_array).ok_or("Todo snapshot has no item list")?;
    if items.len() > 100 { return Err("Todo list exceeds 100 items".into()); }
    let mut ids = std::collections::HashSet::new();
    let mut sanitized = Vec::with_capacity(items.len());
    for item in items {
        let id = item.get("id").and_then(Value::as_str).ok_or("Todo item has no ID")?;
        let title = item.get("title").and_then(Value::as_str).ok_or("Todo item has no title")?;
        if id.is_empty() || id.len() > 100 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') || !ids.insert(id) {
            return Err("Todo item has an invalid or duplicate ID".into());
        }
        if title.trim().is_empty() || title.chars().count() > 500 || title.len() > 2000 || title.chars().any(char::is_control) { return Err("Todo item has an invalid title".into()); }
        if !["pending", "completed"].contains(&item.get("status").and_then(Value::as_str).unwrap_or("")) { return Err("Todo item has an invalid status".into()); }
        if !["user", "agent"].contains(&item.get("createdBy").and_then(Value::as_str).unwrap_or("")) || !["user", "agent"].contains(&item.get("updatedBy").and_then(Value::as_str).unwrap_or("")) { return Err("Todo item has an invalid author".into()); }
        if item.get("detail").is_some_and(|detail| detail.as_str().is_none_or(|detail| detail.chars().count()>500 || detail.len()>2000 || detail.chars().any(char::is_control))) { return Err("Todo item has invalid progress detail".into()); }
        for field in ["createdAt","startedAt","completedAt","durationMs"] { if item.get(field).is_some_and(|value| value.as_u64().is_none_or(|time| time>9_007_199_254_740_991)) { return Err("Todo item has an invalid timestamp".into()); } }
        let mut safe = json!({"id":id,"title":title.trim(),"status":item["status"],"createdBy":item["createdBy"],"updatedBy":item["updatedBy"]});
        for field in ["createdAt","startedAt","completedAt","durationMs","detail"] {
            if let Some(value) = item.get(field) { safe[field] = value.clone(); }
        }
        sanitized.push(safe);
    }
    let active_id=value.get("activeId").and_then(Value::as_str);
    if value.get("activeId").is_some_and(|id| !id.is_null() && (active_id.is_none() || !items.iter().any(|item| item["id"]==active_id.unwrap() && item["status"]=="pending"))) { return Err("Todo snapshot has an invalid active item".into()); }
    let mut result=json!({"protocolVersion":3,"revision":revision,"items":sanitized,"toolAvailable":available,"available":service_available});
    if let Some(active_id)=active_id { result["activeId"]=json!(active_id); }
    Ok(result)
}

fn update_todos(snapshot: &mut Snapshot, value: Option<&Value>, observation: TodoObservation) -> bool {
    let before = (snapshot.todos.clone(), snapshot.todo_sync.clone());
    let next = value.map(validate_todos).transpose();
    match next {
        Ok(Some(next)) => {
            let prior = snapshot.todos.as_ref();
            let lower = prior.is_some_and(|prior| next["revision"].as_u64() < prior["revision"].as_u64());
            let divergent = prior.is_some_and(|prior| next["revision"] == prior["revision"] && todo_task_state(prior) != todo_task_state(&next));
            if lower && observation != TodoObservation::CatchUp { return false; }
            if lower || divergent {
                set_todo_sync(snapshot, "conflict", Some(TODO_CONFLICT_REASON));
            } else {
                let available = next["available"] == true;
                snapshot.todos = Some(next);
                if !available {
                    if !snapshot.todo_sync.as_ref().is_some_and(|sync| sync.state == "conflict") {
                        set_todo_sync(snapshot, "unavailable", Some("This execution cannot provide Todo updates. Saved tasks remain readable."));
                    }
                } else if observation == TodoObservation::Replay {
                    if !snapshot.todo_sync.as_ref().is_some_and(|sync| sync.state == "conflict") {
                        set_todo_sync(snapshot, "stale", Some(TODO_STALE_REASON));
                    }
                } else {
                    set_todo_sync(snapshot, "current", None);
                }
            }
        }
        Ok(None) => {
            if !snapshot.todo_sync.as_ref().is_some_and(|sync| sync.state == "conflict") {
                if let Some(todos) = snapshot.todos.as_mut() { todos["available"] = json!(false); todos["toolAvailable"] = json!(false); }
                set_todo_sync(snapshot, "unavailable", Some("This execution does not report the Still Todo service."));
            }
        }
        Err(_) => {
            if !snapshot.todo_sync.as_ref().is_some_and(|sync| sync.state == "conflict") {
                if value.and_then(|value| value["protocolVersion"].as_u64()).is_some_and(|protocol| protocol != 3) {
                    if let Some(todos) = snapshot.todos.as_mut() { todos["available"] = json!(false); todos["toolAvailable"] = json!(false); }
                }
                set_todo_sync(snapshot, "unavailable", Some("Todo updates could not be verified. The last valid list is still shown."));
            }
        }
    }
    before != (snapshot.todos.clone(), snapshot.todo_sync.clone())
}

async fn emit_todos(thread: &mut Thread) {
    let mut event = Event::new("todos");
    event.todos = thread.snapshot.todos.clone();
    event.todo_sync = thread.snapshot.todo_sync.clone();
    emit(thread, event).await;
}

async fn queue_request_response(thread: &mut Thread, id: Value, response: Value, outcome: Value) -> Result<oneshot::Receiver<Result<(), String>>, StillError> {
    if thread.response_delivery.is_some() {
        return Err(StillError::friendly("agent_response_busy", "A response is already being sent."));
    }
    let (reply, receiver) = oneshot::channel();
    thread.response_delivery = Some(PendingResponse { id: id.clone(), outcome, reply });
    if thread.outbound.send(json!({"jsonrpc":"2.0","id":id,"result":response})).is_err() {
        thread.response_delivery = None;
        return Err(StillError::friendly("agent_disconnected", "The agent disconnected before the response could be queued."));
    }
    Ok(receiver)
}

async fn await_request_delivery(response: oneshot::Receiver<Result<(), String>>) -> Result<(), StillError> {
    tokio::time::timeout(Duration::from_secs(20), response).await
        .map_err(|_| StillError::friendly("agent_response_unknown", "Response delivery was not confirmed. Check request status before retrying."))?
        .map_err(|_| StillError::friendly("agent_response_unknown", "The response acknowledgement was lost. Check request status before retrying."))?
        .map_err(|message| StillError::friendly("agent_response_failed", message))
}

#[tauri::command]
pub async fn still_agent_send(args: SendArgs) -> Result<(), StillError> {
    if args.message.trim().is_empty() || args.message.len() > 120_000 {
        return Err(StillError::friendly(
            "agent_prompt",
            "Message must be non-empty and under 120,000 bytes.",
        ));
    }
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    if !matches!(
        thread.snapshot.state.as_str(),
        "working" | "complete" | "cancelled" | "error"
    ) || thread.snapshot.turn_active
        || thread.prompt.is_some()
        || !thread.config_requests.is_empty()
        || thread.history_request.is_some()
    {
        return Err(StillError::friendly(
            "agent_not_ready",
            "Remote agent is busy or awaiting approval.",
        ));
    }
    let sid = thread.snapshot.agent_session_id.clone().ok_or_else(|| {
        StillError::friendly("agent_not_ready", "ACP session is still initializing.")
    })?;
    let id = next_request_id();
    thread.prompt = Some(json!(id));
    thread.snapshot.prompt_id = Some(json!(id));
    thread.snapshot.turn_active = true;
    thread.snapshot.state = "working".into();
    thread.snapshot.last_error = None;
    let mut event = Event::new("userMessage");
    event.text = Some(args.message.clone());
    let message_id = format!("{}-{id}", thread.snapshot.execution_id);
    event.message_id = Some(message_id.clone());
    emit(&mut thread, event).await;
    if thread.outbound.send(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":args.message}],"_meta":{"messageId":message_id}}})).is_err() {
        thread.prompt=None;thread.snapshot.turn_active=false;thread.snapshot.state="submissionUnknown".into();
        thread.snapshot.last_error = Some("The SSH stream closed while queuing the prompt. Inspect the remote process before retrying.".into());
        let mut event = Event::new("threadError"); event.state = Some("submissionUnknown".into()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread, event).await;
        return Err(StillError::friendly("agent_submission_unknown","The SSH stream closed while queuing the prompt. Inspect the remote process before retrying."));
    }
    Ok(())
}
#[tauri::command]
pub async fn still_agent_revert(args: RevertArgs) -> Result<Snapshot, StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    if thread.snapshot.history_capabilities["revert"] != true { return Err(StillError::friendly("agent_history_unsupported", "This agent does not support reverting conversation messages.")); }
    if thread.snapshot.last_sequence != args.expected_sequence || thread.snapshot.turn_active || thread.prompt.is_some() || thread.permission.is_some() || thread.pending_input_id.is_some() || !thread.config_requests.is_empty() || thread.history_request.is_some() || !matches!(thread.snapshot.state.as_str(), "working" | "complete" | "cancelled" | "error") {
        return Err(StillError::friendly("agent_history_busy", "The conversation changed or is busy. Wait until it is idle before reverting."));
    }
    if thread.outbound.is_closed() { return Err(StillError::friendly("agent_process_lost", "Resume this conversation before changing its history.")); }
    let message = thread.messages.iter().find(|message| message.message_id.as_deref() == Some(args.message_id.as_str()) && message.checkpoint.is_some()).cloned().ok_or_else(|| StillError::friendly("agent_history_stale", "This message has no current provider checkpoint."))?;
    flush_history(&mut thread).await?;
    let request_id = next_request_id();
    let request = json!({"jsonrpc":"2.0","id":request_id,"method":"_still/session/revert","params":{"sessionId":thread.snapshot.agent_session_id,"checkpoint":message.checkpoint},"_meta":{"messageId":args.message_id}});
    let (reply, response) = oneshot::channel();
    let previous_state = thread.snapshot.state.clone();
    thread.snapshot.state = "rewinding".into();
    thread.history_request = Some(PendingHistory { request_id, message, previous_state:previous_state.clone(), reply });
    let mut event = Event::new("threadState"); event.state = Some("rewinding".into()); emit(&mut thread, event).await;
    if let Err(error) = flush_history(&mut thread).await {
        thread.history_request = None; thread.snapshot.state = previous_state.clone();
        let mut event = Event::new("threadState"); event.state = Some(previous_state); emit(&mut thread, event).await;
        return Err(error);
    }
    if thread.outbound.send(request).is_err() {
        thread.history_request = None; thread.snapshot.state = previous_state;
        let mut event = Event::new("threadState"); event.state = Some(thread.snapshot.state.clone()); emit(&mut thread, event).await;
        return Err(StillError::friendly("agent_process_lost", "The connection closed before the history request was sent."));
    }
    drop(thread);
    match tokio::time::timeout(Duration::from_secs(65), response).await {
        Ok(Ok(Ok(()))) => Ok(row.lock().await.snapshot.clone()),
        Ok(Ok(Err(message))) => Err(StillError::friendly("agent_history_failed", message)),
        _ => {
            let mut thread = row.lock().await;
            if thread.history_request.is_some() {
                thread.snapshot.state = "submissionUnknown".into();
                thread.snapshot.last_error = Some("The history change was not acknowledged. Inspect the provider session before continuing.".into());
                let mut event = Event::new("threadError"); event.state = Some("submissionUnknown".into()); event.text = thread.snapshot.last_error.clone(); emit(&mut thread, event).await;
            }
            Err(StillError::friendly("agent_history_unknown", "The history change was not acknowledged. Inspect the provider session before continuing."))
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigArgs {
    execution_id: String,
    config_id: String,
    value: Value,
}
#[tauri::command]
pub async fn still_agent_set_config(args: SetConfigArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    let session = thread.snapshot.agent_session_id.clone().ok_or_else(|| {
        StillError::friendly("agent_not_ready", "ACP session is still initializing.")
    })?;
    if thread.snapshot.turn_active
        || !matches!(
            thread.snapshot.state.as_str(),
            "working" | "complete" | "cancelled" | "error"
        )
        || thread.prompt.is_some()
        || !thread.config_requests.is_empty()
        || thread.history_request.is_some()
    {
        return Err(StillError::friendly(
            "agent_config_busy",
            "Wait until the agent and any setting update are idle.",
        ));
    }
    let valid = config_value_is_advertised(
        &Value::Array(thread.snapshot.config_options.clone()),
        &args.config_id,
        &args.value,
    );
    if !valid {
        return Err(StillError::friendly(
            "agent_config_invalid",
            "Choose a value offered by this agent.",
        ));
    }
    let request_id = next_request_id();
    let (reply, receive) = oneshot::channel();
    let request = match args.config_id.as_str() {
        "still:mode" => {
            json!({"jsonrpc":"2.0","id":request_id,"method":"session/set_mode","params":{"sessionId":session,"modeId":args.value}})
        }
        "still:model" => {
            json!({"jsonrpc":"2.0","id":request_id,"method":"session/set_model","params":{"sessionId":session,"modelId":args.value}})
        }
        _ => {
            json!({"jsonrpc":"2.0","id":request_id,"method":"session/set_config_option","params":{"sessionId":session,"configId":args.config_id,"value":args.value}})
        }
    };
    let previous_capabilities = thread.snapshot.capabilities.clone();
    let previous_config = effective_config_key(&thread.snapshot.config_options);
    let previous_capability_cursor = thread.capability_remote_cursor;
    thread.config_requests.insert(
        request_id,
        PendingConfig {
            id: args.config_id,
            value: args.value,
            previous_capabilities,
            previous_config,
            previous_capability_cursor,
            reply,
        },
    );
    if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
    if thread.outbound.send(request).is_err() {
        thread.config_requests.remove(&request_id);
        return Err(StillError::friendly(
            "agent_config_unknown",
            "Remote ACP stream disconnected before config update.",
        ));
    }
    drop(thread);
    tokio::time::timeout(Duration::from_secs(20), receive)
        .await
        .map_err(|_| {
            StillError::friendly(
                "agent_config_unknown",
                "Setting acknowledgement timed out. Refresh the thread before retrying.",
            )
        })?
        .map_err(|_| {
            StillError::friendly(
                "agent_config_unknown",
                "Remote agent disconnected during the setting update.",
            )
        })?
        .map_err(|e| StillError::friendly("agent_config_failed", e))
}

async fn find_thread(id: &str) -> Result<Arc<Mutex<Thread>>, StillError> {
    registry().lock().await.get(id).cloned().ok_or_else(||StillError::friendly("agent_process_lost","This agent transport is no longer attached. Reattach to the server before starting a replacement."))
}

#[tauri::command]
pub async fn still_agent_attach(app: AppHandle, state: State<'_, AppState>, args: AttachArgs) -> Result<Snapshot, StillError> {
    let owner = state.sessions.lock().await.get(&args.native_session_id).cloned().ok_or_else(|| StillError::friendly("agent_session", "Reconnect and verify this server first."))?;
    let server = owner.lock().await;
    if server.status != SessionStatus::Live { return Err(StillError::friendly("agent_session", "Wait until the SSH connection is live.")); }
    let host_key = json!([server.config.host.to_lowercase(), server.config.port, server.config.username]).to_string();
    drop(server);
    let existing = registry().lock().await.get(&args.execution_id).cloned();
    let saved = if let Some(row) = &existing { row.lock().await.snapshot.clone() }
        else { agent_store::load_snapshot(&app, args.conversation_id.clone()).await? };
    if saved.execution_id != args.execution_id || saved.conversation_id != args.conversation_id || saved.host_key != host_key || !saved.persistent {
        return Err(StillError::friendly("agent_attach_identity", "This persistent execution belongs to a different conversation or server."));
    }
    if let Some(row) = &existing {
        let thread = row.lock().await;
        if thread.transport_active {
            if thread.snapshot.state == "detached" { return Err(StillError::friendly("agent_attach_pending", "The old transport is still closing. Try again shortly.")); }
            return Ok(thread.snapshot.clone());
        }
    }
    let (remote, bootstrap_payload) = persistent_command(&saved.execution_id, &saved.conversation_id, &saved.cwd, &saved.agent_id, "", false, saved.remote_cursor, None, None)?;
    let mut channel = ssh_worker::open_agent_exec(&args.native_session_id,&remote).await.map_err(|error| StillError::friendly("agent_attach", format!("Could not reattach to the server-side agent: {error}")))?;
    let bootstrap_data = match bootstrap_remote(&mut channel, &bootstrap_payload).await {
        Ok(data) => data,
        Err(error) => {
            let _ = channel.eof().await; let _ = channel.close().await;
            return Err(StillError::friendly("agent_attach", format!("Could not start the server-side transport: {error}")));
        }
    };
    let (outbound, outbound_rx) = mpsc::unbounded_channel();
    let (cancel, cancel_rx) = mpsc::unbounded_channel();
    let (close, close_rx) = mpsc::unbounded_channel();
    let row = if let Some(row) = existing {
        let mut thread = row.lock().await;
        if thread.transport_active { return Ok(thread.snapshot.clone()); }
        thread.outbound = outbound; thread.cancel = cancel; thread.close = close;
        thread.permission = None; thread.pending_input_id = None;
        thread.snapshot.pending_permission = None; thread.snapshot.pending_input = None;
        thread.snapshot.state = "connecting".into(); thread.snapshot.last_error = None;
        thread.awaiting_catch_up = true;
        thread.capability_remote_cursor = thread.snapshot.remote_cursor;
        if mark_capabilities_stale(&mut thread.snapshot) { emit_capabilities(&mut thread).await; }
        if mark_todos_stale(&mut thread.snapshot) { emit_todos(&mut thread).await; }
        thread.transport_active = true;
        thread.transport_epoch = thread.transport_epoch.saturating_add(1);
        drop(thread); row
    } else {
        let lease = agent_store::lease(&app, args.conversation_id).await?;
        let messages = agent_store::history_messages(&app, saved.conversation_id.clone()).await?;
        let recovering_uncertain = saved.recovery_required || matches!(saved.state.as_str(), "submissionUnknown" | "rewinding");
        let mut snapshot = saved;
        snapshot.state = "connecting".into(); snapshot.last_error = None;
        let stale_changed = mark_capabilities_stale(&mut snapshot);
        let todo_stale_changed = mark_todos_stale(&mut snapshot);
        let capability_remote_cursor = snapshot.remote_cursor;
        let row = Arc::new(Mutex::new(Thread {
            prompt: snapshot.prompt_id.clone(), snapshot, app, outbound, cancel, close,
            permission: None, pending_input_id: None, config_requests: HashMap::new(), response_delivery: None,
            transport_active: true, transport_epoch: 1, recovering_uncertain, resume_session_id: None, early_updates: Vec::new(), cleanup_error: None,
            unsaved: VecDeque::new(), history_lease: Some(lease), messages, history_request: None, reconcile_request: None,
            load_session: false, capability_notice: None,
            awaiting_catch_up: true, capability_remote_cursor,
        }));
        if stale_changed {
            let mut thread = row.lock().await;
            emit_capabilities(&mut thread).await;
        }
        if todo_stale_changed { let mut thread = row.lock().await; emit_todos(&mut thread).await; }
        row
    };
    let snapshot = row.lock().await.snapshot.clone();
    registry().lock().await.insert(args.execution_id, row.clone());
    let cwd = snapshot.cwd.clone();
    tokio::spawn(run(channel,row,outbound_rx,cancel_rx,close_rx,cwd,bootstrap_data));
    Ok(snapshot)
}
#[tauri::command]
pub async fn still_agent_snapshot(args: IdArgs) -> Result<Snapshot, StillError> {
    let row = find_thread(&args.execution_id).await?;
    let thread = row.lock().await;
    let mut snapshot = thread.snapshot.clone();
    snapshot.active_message_ids = Some(thread.messages.iter().filter_map(|message| message.message_id.clone()).collect());
    Ok(snapshot)
}
#[tauri::command]
pub async fn still_agent_reconcile(args: IdArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    if !thread.snapshot.persistent || !thread.transport_active {
        return Err(StillError::friendly("agent_reconcile_offline", "Reconnect this conversation to its server before checking the remote agent."));
    }
    if thread.reconcile_request.is_some() {
        return Err(StillError::friendly("agent_reconcile_busy", "A status check is already in progress."));
    }
    let request_id = next_request_id();
    let (reply, receive) = oneshot::channel();
    thread.reconcile_request = Some(PendingReconcile { request_id, reply });
    if thread.outbound.send(json!({"jsonrpc":"2.0","id":request_id,"method":"_still/status","params":{}})).is_err() {
        thread.reconcile_request = None;
        return Err(StillError::friendly("agent_reconcile_offline", "The status request could not reach the remote worker."));
    }
    drop(thread);
    match tokio::time::timeout(Duration::from_secs(15), receive).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(message))) => Err(StillError::friendly("agent_reconcile_failed", message)),
        _ => {
            let mut thread = row.lock().await;
            if thread.reconcile_request.as_ref().is_some_and(|pending| pending.request_id == request_id) { thread.reconcile_request = None; }
            Err(StillError::friendly("agent_reconcile_unknown", "The server did not confirm the agent's status. No prompt was resent; try the status check again."))
        }
    }
}
#[tauri::command]
pub async fn still_agent_cancel(args: IdArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let thread = row.lock().await;
    if !thread.snapshot.turn_active {
        return Err(StillError::friendly(
            "agent_turn_idle",
            "There is no active prompt to cancel.",
        ));
    }
    thread.cancel.send(()).map_err(|_| {
        StillError::friendly(
            "agent_process_lost",
            "The remote agent disconnected; cancellation was not sent.",
        )
    })
}
#[tauri::command]
pub async fn still_agent_close(args: IdArgs) -> Result<(), StillError> {
    let Some(row) = registry().lock().await.get(&args.execution_id).cloned() else {
        return Ok(());
    };
    let mut thread = row.lock().await;
    flush_history(&mut thread).await?;
    if let Some(error) = &thread.cleanup_error {
        return Err(StillError::friendly("agent_close_unknown", error));
    }
    if thread.snapshot.turn_active || thread.history_request.is_some() {
        return Err(StillError::friendly(
            "agent_busy",
            "Stop the agent before deleting this conversation.",
        ));
    }
    let (reply, response) = oneshot::channel();
    let sent = thread.close.send(reply).is_ok();
    drop(thread);
    if sent {
        tokio::time::timeout(Duration::from_secs(8), response).await
            .map_err(|_| StillError::friendly("agent_close_unknown", "Agent shutdown was not confirmed. Refresh before deleting this conversation."))?
            .map_err(|_| StillError::friendly("agent_close_unknown", "Agent shutdown acknowledgement was lost. Refresh before deleting this conversation."))?
            .map_err(|message| StillError::friendly("agent_close_unknown", message))?;
        // The worker distinguishes confirmed EOF from its bounded shutdown timeout.
    }
    registry().lock().await.remove(&args.execution_id);
    row.lock().await.history_lease.take();
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputArgs {
    execution_id: String,
    request_id: Value,
    answers: Option<Value>,
}
#[tauri::command]
pub async fn still_agent_input(args: InputArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    if thread.pending_input_id.as_ref() != Some(&args.request_id) {
        return Err(StillError::friendly(
            "agent_input_stale",
            "This question is no longer pending.",
        ));
    }
    let title = thread.snapshot.pending_input.as_ref().and_then(|request| request["title"].as_str()).unwrap_or("Agent needs your input").to_owned();
    let answered = args.answers.is_some();
    let result = if let Some(answers) = args.answers {
        json!({"action":"accept","content":answers})
    } else {
        json!({"action":"decline"})
    };
    let outcome = json!({"requestId":args.request_id,"kind":"question","title":title,"outcome":if answered {"answered"} else {"dismissed"}});
    let response = queue_request_response(&mut thread,args.request_id,result,outcome).await?;
    drop(thread);
    await_request_delivery(response).await
}
#[tauri::command]
pub async fn still_agent_respond(args: PermissionArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    let permission = thread.permission.as_ref().ok_or_else(|| {
        StillError::friendly("agent_permission_expired", "Approval is no longer pending.")
    })?;
    let id = permission.id.clone();
    if id != args.request_id {
        return Err(StillError::friendly(
            "agent_permission_stale",
            "This approval belongs to a different request.",
        ));
    }
    let selected = permission.options.iter().find(|option| {
        option.get("optionId").and_then(Value::as_str) == Some(args.option_id.as_str())
    });
    let Some(selected) = selected else {
        return Err(StillError::friendly(
            "agent_permission_invalid",
            "Choose an option the remote agent actually offered.",
        ));
    };
    let title = thread.snapshot.pending_permission.as_ref().and_then(|request| request["title"].as_str()).unwrap_or("Permission required").to_owned();
    let option_name = selected.get("name").and_then(Value::as_str).unwrap_or(&args.option_id).to_owned();
    let option_kind = selected.get("kind").and_then(Value::as_str).unwrap_or("");
    let outcome_kind = if option_kind.starts_with("reject") { "rejected" } else if option_kind.starts_with("allow") { "approved" } else { "uncertain" };
    let outcome = json!({"requestId":args.request_id,"kind":"permission","title":title,"outcome":outcome_kind,"responseLabel":option_name});
    let result = json!({"outcome":{"outcome":"selected","optionId":args.option_id}});
    let response = queue_request_response(&mut thread,args.request_id,result,outcome).await?;
    drop(thread);
    await_request_delivery(response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_agent_bootstrap_streams_large_sources_over_stdin() {
        let runtime = ProviderRuntime {
            transport: "codex-app-server".into(),
            executable: Some("/usr/local/bin/codex".into()),
            version: Some("codex-cli 0.52.0".into()),
            version_source: Some("executable".into()),
            version_observed_at: Some(1_793_372_400_000),
        };
        let (command, payload) = persistent_command("agent-test-1", "conversation-1", "/srv/project", "opencode", "opencode", true, 0, Some(&runtime), None).unwrap();
        assert!(command.len() < 8 * 1024, "SSH exec command must stay far below Linux's 128 KiB argument limit");
        assert!(!command.contains(&payload), "base64 configuration belongs on stdin, never in the SSH exec argument");
        assert!(payload.len() > 128 * 1024, "test fixture should exercise the Linux per-argument overflow boundary");
        let decoded = base64::engine::general_purpose::STANDARD.decode(payload).unwrap();
        let config: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(config["source"], include_str!("../agent-host/supervisor.mjs"));
        assert_eq!(config["todosSource"], include_str!("../agent-host/todos.mjs"));
        assert_eq!(config["command"][3], include_str!("../agent-host/bridge.mjs"));
        assert_eq!(config["providerRuntime"]["transport"], "codex-app-server");
        let worker_env: Value = serde_json::from_str(config["env"]["STILL_PROVIDER_RUNTIME"].as_str().unwrap()).unwrap();
        assert_eq!(worker_env, config["providerRuntime"], "the worker must receive the same launch-time runtime facts");

        let (attach_command, attach_payload) = persistent_command("agent-test-1", "conversation-1", "/srv/project", "opencode", "", false, 17, None, None).unwrap();
        assert!(attach_command.len() < 8 * 1024);
        assert!(attach_payload.len() < 1024, "reattach does not need to retransmit bundled source code");
        let attach_config: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(attach_payload).unwrap()).unwrap();
        assert!(attach_config.get("source").is_none());
        assert!(attach_config.get("providerRuntime").is_none(), "reattach keeps the worker's existing facts");
        assert_eq!(attach_config["command"], json!([]));
    }
    #[test]
    fn provider_runtime_transports_and_version_output_stay_bounded() {
        for (id, transport) in [("opencode", "http-v2+sse"), ("codex", "codex-app-server"), ("claude", "claude-stream-json"), ("pi", "pi-rpc"), ("gemini", "acp-v1")] {
            assert_eq!(agent_transport(id), transport);
        }
        let parsed = parse_versions("STILL_NODE:22.1.0\nSTILL_VERSION:codex:codex-cli 0.52.0\nSTILL_VERSION:pi:\nSTILL_VERSION::1.2.3\nSTILL_VERSION:claude:2.0.1 (Claude Code)");
        assert_eq!(parsed.get("codex").map(String::as_str), Some("codex-cli 0.52.0"));
        assert_eq!(parsed.get("claude").map(String::as_str), Some("2.0.1 (Claude Code)"));
        assert_eq!(parsed.len(), 2, "empty ids/versions and the Node line are not provider versions");
        let unknown = ProviderRuntime { transport: "pi-rpc".into(), executable: Some("pi".into()), version: None, version_source: None, version_observed_at: None };
        let (_, payload) = persistent_command("agent-test-2", "conversation-2", "/srv/project", "pi", "pi", true, 0, Some(&unknown), None).unwrap();
        let config: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(payload).unwrap()).unwrap();
        assert!(config["providerRuntime"].get("version").is_none(), "an unknown version stays absent rather than guessed");
        assert_eq!(config["providerRuntime"]["transport"], "pi-rpc");
    }
    #[test]
    fn resumed_todo_seed_stays_in_stdin_config_and_never_in_the_ssh_command() {
        let repeated_title = "😀".repeat(500);
        let repeated_detail = "🧭".repeat(500);
        let items = (0..100)
            .map(|index| json!({
                "id":format!("task-{index}"),"title":repeated_title,"status":"pending",
                "createdBy":"agent","updatedBy":"agent","createdAt":1,"startedAt":1,
                "detail":repeated_detail
            }))
            .collect::<Vec<_>>();
        let seed = json!({"revision":12,"items":items,"activeId":"task-0"});
        let seed_bytes = serde_json::to_vec(&seed).unwrap();
        assert!(seed_bytes.len() > 128 * 1024, "fixture should exceed Linux's per-argument limit if copied into argv");
        assert!(seed_bytes.len() < 1024 * 1024, "valid seed remains under the private file limit");
        let (command, payload) = persistent_command("agent-seed-1", "conversation-seed", "/srv/project", "pi", "pi", true, 0, None, Some(&seed)).unwrap();
        assert!(command.len() < 8 * 1024);
        assert!(!command.contains("Resume the prior checklist") && !command.contains("task-0"));
        let config: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(payload).unwrap()).unwrap();
        assert_eq!(config["todoSeed"], seed, "native passes only its validated snapshot through bootstrap stdin");
        assert!(config["todoSeed"].get("toolAvailable").is_none());
    }
    #[test]
    fn replacement_seed_requires_the_saved_host_folder_provider_and_explicit_session() {
        let mut saved = capability_snapshot(validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap());
        assert!(validate_resume_scope(&saved, "host", "pi", "/srv/project", Some("session-1")).is_ok());
        for (host, agent, cwd, session) in [
            ("other-account", "pi", "/srv/project", Some("session-1")),
            ("host", "codex", "/srv/project", Some("session-1")),
            ("host", "pi", "/other-folder", Some("session-1")),
            ("host", "pi", "/srv/project", Some("wrong-session")),
            ("host", "pi", "/srv/project", None),
        ] { assert!(validate_resume_scope(&saved, host, agent, cwd, session).is_err()); }
        saved.resumable = false;
        assert!(validate_resume_scope(&saved, "host", "pi", "/srv/project", Some("session-1")).is_err());
        saved.resumable = true; saved.turn_active = true;
        assert!(validate_resume_scope(&saved, "host", "pi", "/srv/project", Some("session-1")).is_err());
    }
    #[test]
    fn legacy_managed_execution_must_be_explicitly_closed_before_replacement() {
        let mut legacy = capability_snapshot(validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap());
        legacy.capabilities = None;
        legacy.todos = None;
        assert!(validate_replacement_execution(&legacy, "conversation-1").is_err(), "native ownership guard does not depend on the upgraded worker report");
        assert!(validate_replacement_execution(&legacy, "another-conversation").is_ok());
        assert!(validate_resume_scope(&legacy, "host", "pi", "/srv/project", Some("session-1")).is_ok(), "an explicitly resumed closed legacy snapshot remains compatible");
    }
    #[test]
    fn discovery_availability_reports_identity_without_claiming_support() {
        let runtime = ProviderRuntime { transport: "acp-v1".into(), executable: Some("/home/user/.local/bin/gemini".into()), version: None, version_source: None, version_observed_at: None };
        assert_eq!(serde_json::to_value(&runtime).unwrap(), json!({"transport":"acp-v1","executable":"/home/user/.local/bin/gemini"}));
    }
    fn capability_fixture() -> Value {
        json!({
            "schemaVersion":1,"executionId":"execution-1","agentSessionId":"session-1","cwd":"/srv/project",
            "configGeneration":2,"observedAt":1234,"freshness":"stale","ignoredMetadata":"drop me",
            "providerRuntime":{"transport":"pi-rpc","executable":"/usr/bin/pi","version":"Pi 0.9.1","versionSource":"executable","versionObservedAt":1230,"ignoredRuntime":"drop me"},
            "features":{
                "sharedTodos":{"status":"supported","evidence":"observed","reason":"An authenticated tool call succeeded."},
                "providerPlans":{"status":"unsupported","evidence":"adapter","reason":"This integration does not consume provider plans."},
                "providerTaskProjection":{"status":"unsupported","evidence":"adapter","reason":"Native tasks are not synchronized."},
                "clientTodoWrite":{"status":"unsupported","evidence":"adapter","reason":"The agent owns Todo changes."},
                "unknownFeature":{"status":"supported","evidence":"observed","reason":"Ignored."}
            }
        })
    }
    fn capability_snapshot(report: CapabilityReport) -> Snapshot {
        Snapshot {
            conversation_id: "conversation-1".into(), host_key: "host".into(),
            execution_id: "execution-1".into(), local_session_id: "local".into(),
            agent_id: "pi".into(), agent_name: "Pi".into(), agent_session_id: Some("session-1".into()),
            cwd: "/srv/project".into(), state: "detached".into(), transcript: Vec::new(),
            pending_permission: None, last_error: None, last_sequence: 0, turn_active: false,
            config_options: Vec::new(), commands: Vec::new(), pending_input: None, resumable: true,
            history_capabilities: json!({"revert":false,"retry":false}), active_message_ids: None,
            persistent: true, remote_cursor: 12, prompt_id: None, recovery_required: false,
            todos: None, todo_sync: None, capabilities: Some(report),
        }
    }
    #[test]
    fn capability_wire_validation_binds_scope_drops_unknowns_and_owns_freshness() {
        let report = validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap();
        assert_eq!(report.freshness, "current", "worker-supplied freshness is never trusted");
        assert_eq!(report.config_generation, 2);
        assert_eq!(report.provider_runtime.transport, "pi-rpc");
        let saved = serde_json::to_value(report).unwrap();
        assert!(saved.get("ignoredMetadata").is_none());
        assert!(saved["providerRuntime"].get("ignoredRuntime").is_none());
        assert!(saved["features"].get("unknownFeature").is_none());
        assert_eq!(saved["features"]["sharedTodos"]["evidence"], "observed");
    }
    #[test]
    fn capability_wire_validation_rejects_scope_claim_and_size_violations() {
        let raw = capability_fixture();
        assert!(validate_capabilities(&raw, "another-execution", "pi", "session-1", "/srv/project").is_err());
        assert!(validate_capabilities(&raw, "execution-1", "pi", "another-session", "/srv/project").is_err());
        assert!(validate_capabilities(&raw, "execution-1", "pi", "session-1", "/another/project").is_err());
        let mut wrong_transport = raw.clone();
        wrong_transport["providerRuntime"]["transport"] = json!("acp-v1");
        assert!(validate_capabilities(&wrong_transport, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut promoted = raw.clone();
        promoted["features"]["clientTodoWrite"] = json!({"status":"supported","evidence":"observed","reason":"User editing is enabled."});
        assert!(validate_capabilities(&promoted, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut missing_evidence = raw.clone();
        missing_evidence["features"]["sharedTodos"].as_object_mut().unwrap().remove("evidence");
        assert!(validate_capabilities(&missing_evidence, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut malformed_evidence = raw.clone();
        malformed_evidence["features"]["sharedTodos"]["status"] = json!("unverified");
        malformed_evidence["features"]["sharedTodos"]["evidence"] = json!(true);
        assert!(validate_capabilities(&malformed_evidence, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut malformed_source = raw.clone();
        malformed_source["providerRuntime"]["versionSource"] = json!(false);
        assert!(validate_capabilities(&malformed_source, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut unsafe_generation = raw.clone();
        unsafe_generation["configGeneration"] = json!(9_007_199_254_740_992u64);
        assert!(validate_capabilities(&unsafe_generation, "execution-1", "pi", "session-1", "/srv/project").is_err());
        let mut too_large = raw;
        too_large["features"]["sharedTodos"]["reason"] = json!("r".repeat(241));
        assert!(validate_capabilities(&too_large, "execution-1", "pi", "session-1", "/srv/project").is_err());
    }
    #[test]
    fn restored_capabilities_are_stale_and_invalid_optional_data_is_discarded() {
        let report = validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap();
        let mut snapshot = capability_snapshot(report);
        assert!(mark_capabilities_stale(&mut snapshot));
        assert_eq!(snapshot.capabilities.as_ref().unwrap().freshness, "stale");
        assert!(!mark_capabilities_stale(&mut snapshot), "stale transitions are idempotent");
        let header = serde_json::to_value(snapshot.history_header()).unwrap();
        assert_eq!(header["capabilities"]["freshness"], "stale");
        assert_eq!(header["transcript"], json!([]));

        let mut corrupted = capability_fixture();
        corrupted["freshness"] = json!("current");
        corrupted["features"]["sharedTodos"]["status"] = json!("invented");
        let capability: CapabilityReport = serde_json::from_value(corrupted).unwrap();
        let mut snapshot = capability_snapshot(capability);
        restore_capabilities(&mut snapshot);
        assert!(snapshot.capabilities.is_none(), "invalid optional capability data must not break conversation restoration");

        let mut missing = serde_json::to_value(capability_snapshot(
            validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap(),
        )).unwrap();
        missing["capabilities"] = json!({"schemaVersion":1,"broken":true});
        let restored: Snapshot = serde_json::from_value(missing).unwrap();
        assert!(restored.capabilities.is_none(), "malformed optional metadata does not reject the whole snapshot");
    }
    #[test]
    fn capability_order_uses_generation_and_worker_event_cursor_not_remote_clocks() {
        let base = validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap();
        let mut old_generation = base.clone(); old_generation.config_generation = 1;
        assert!(capability_is_older(Some(&base), &old_generation, 8, 12));
        let mut later_generation = base.clone(); later_generation.config_generation = 3;
        later_generation.observed_at = 1;
        assert!(!capability_is_older(Some(&base), &later_generation, 8, 12));
        assert!(capability_is_older(Some(&base), &later_generation, 13, 12));
    }
    #[test]
    fn capability_freshness_requires_catch_up_and_no_pending_settings_or_history() {
        assert_eq!(capability_observation_freshness(true, true, false, false, false), "current");
        for (fresh, live, catching_up, config, history) in [
            (false, true, false, false, false), (true, false, false, false, false),
            (true, true, true, false, false), (true, true, false, true, false),
            (true, true, false, false, true),
        ] { assert_eq!(capability_observation_freshness(fresh, live, catching_up, config, history), "stale"); }
    }
    #[test]
    fn config_acknowledgements_cannot_refresh_old_generation_capability_evidence() {
        let report = validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap();
        let mut snapshot = capability_snapshot(report);
        snapshot.config_options = vec![json!({"id":"model","type":"select","currentValue":"a"})];
        let (reply, _receive) = oneshot::channel();
        let pending = PendingConfig {
            id: "model".into(), value: json!("b"), previous_capabilities: snapshot.capabilities.clone(),
            previous_config: effective_config_key(&snapshot.config_options), previous_capability_cursor: 12, reply,
        };
        mark_capabilities_stale(&mut snapshot);
        assert!(restore_rejected_capability_report(&mut snapshot, &pending, 12), "a rejected unchanged setting may restore its previously current report");
        mark_capabilities_stale(&mut snapshot);
        snapshot.config_options[0]["currentValue"] = json!("b");
        assert!(!restore_rejected_capability_report(&mut snapshot, &pending, 12));
        assert!(!confirm_config_capability_report(&mut snapshot, &pending, 12));
        assert!(!confirm_config_capability_report(&mut snapshot, &pending, 13), "a newer event cursor alone is not new-model evidence");
        snapshot.capabilities.as_mut().unwrap().config_generation += 1;
        assert!(confirm_config_capability_report(&mut snapshot, &pending, 13));
        assert_eq!(snapshot.capabilities.as_ref().unwrap().freshness, "current");
        assert_eq!(effective_config_key(&[json!({"id":"b","type":"select","currentValue":1}),json!({"id":"a","type":"select","currentValue":2})]),
            effective_config_key(&[json!({"id":"a","type":"select","currentValue":2}),json!({"id":"b","type":"select","currentValue":1})]));
        assert!(invalidate_for_provider_session(&mut snapshot, Some("forked-session")));
    }
    #[test]
    fn only_direct_gemini_load_session_advertisement_fills_missing_resume_metadata() {
        assert!(provider_resumable("gemini", None, true, "gemini-session"));
        assert!(!provider_resumable("gemini", None, false, "gemini-session"));
        assert!(!provider_resumable("pi", None, true, "pi-session"));
        assert!(!provider_resumable("gemini", Some(false), true, "gemini-session"));
        assert!(provider_resumable("pi", Some(true), false, "pi-session"));
    }
    #[test]
    fn todo_snapshots_reject_stale_revisions_invalid_status_and_duplicate_ids() {
        let valid=json!({"protocolVersion":3,"revision":7,"activeId":"task-2","toolAvailable":true,"available":true,"items":[{"id":"task-1","title":"Read project files","status":"completed","createdBy":"agent","updatedBy":"agent","startedAt":100,"completedAt":12000,"durationMs":11900},{"id":"task-2","title":"Run checks","status":"pending","createdBy":"agent","updatedBy":"agent","startedAt":13000,"detail":"Running focused checks"}]});
        assert_eq!(validate_todos(&valid).unwrap(),valid);
        assert!(validate_todos(&json!({"protocolVersion":3,"revision":9_007_199_254_740_992u64,"toolAvailable":false,"available":true,"items":[]})).is_err());
        assert!(validate_todos(&json!({"protocolVersion":3,"revision":1,"toolAvailable":false,"available":true,"items":[{"id":"same","title":"A","status":"in_progress","createdBy":"user","updatedBy":"user"}]})).is_err());
        let duplicate=json!({"protocolVersion":3,"revision":1,"toolAvailable":false,"available":true,"items":[{"id":"same","title":"A","status":"pending","createdBy":"user","updatedBy":"user"},{"id":"same","title":"B","status":"pending","createdBy":"agent","updatedBy":"agent"}]});
        assert!(validate_todos(&duplicate).is_err());
        assert!(validate_todos(&json!({"protocolVersion":3,"revision":1,"activeId":"task-1","toolAvailable":false,"available":true,"items":[{"id":"task-1","title":"Finished","status":"completed","createdBy":"agent","updatedBy":"agent"}]})).is_err());
    }
    fn todo_fixture(revision: u64) -> Value {
        json!({"protocolVersion":3,"revision":revision,"activeId":"task-1","toolAvailable":true,"available":true,
            "items":[{"id":"task-1","title":"Keep the shared list","status":"pending","createdBy":"agent","updatedBy":"agent","startedAt":10,"detail":"Checking restore."}]})
    }
    #[test]
    fn todo_revision_equality_separates_tasks_from_availability_and_deduplicates_updates() {
        let mut snapshot = capability_snapshot(validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap());
        let original = todo_fixture(7);
        assert!(update_todos(&mut snapshot, Some(&original), TodoObservation::Live));
        assert!(!update_todos(&mut snapshot, Some(&original), TodoObservation::Live));
        let mut readiness = original.clone(); readiness["toolAvailable"] = json!(false);
        assert!(update_todos(&mut snapshot, Some(&readiness), TodoObservation::Live));
        assert_eq!(todo_task_state(snapshot.todos.as_ref().unwrap()), todo_task_state(&original));
        let mut conflict = original.clone(); conflict["items"][0]["title"] = json!("Divergent task at the same revision");
        assert!(update_todos(&mut snapshot, Some(&conflict), TodoObservation::Live));
        assert_eq!(snapshot.todos, Some(readiness));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "conflict");
        assert!(!update_todos(&mut snapshot, Some(&conflict), TodoObservation::Live));
        assert!(!update_todos(&mut snapshot, Some(&todo_fixture(6)), TodoObservation::Replay));
        assert!(update_todos(&mut snapshot, Some(&original), TodoObservation::CatchUp));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "current");
    }
    #[test]
    fn authoritative_lower_todo_revision_conflicts_without_rolling_back_the_saved_list() {
        let mut snapshot = capability_snapshot(validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap());
        let original = todo_fixture(7);
        update_todos(&mut snapshot, Some(&original), TodoObservation::Live);
        assert!(!update_todos(&mut snapshot, Some(&todo_fixture(0)), TodoObservation::Replay));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "current");
        assert!(update_todos(&mut snapshot, Some(&todo_fixture(0)), TodoObservation::CatchUp));
        assert_eq!(snapshot.todos, Some(original.clone()));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().reason.as_deref(), Some(TODO_CONFLICT_REASON));
        assert!(!update_todos(&mut snapshot, None, TodoObservation::CatchUp), "an absent report cannot clear a known conflict");
        assert!(!update_todos(&mut snapshot, Some(&original), TodoObservation::Replay), "replay alone cannot claim catch-up completed");
        assert!(update_todos(&mut snapshot, Some(&todo_fixture(8)), TodoObservation::Live));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "current");
    }
    #[test]
    fn invalid_todo_metadata_is_nonfatal_and_offline_state_preserves_service_facts_and_turns() {
        let mut snapshot = capability_snapshot(validate_capabilities(&capability_fixture(), "execution-1", "pi", "session-1", "/srv/project").unwrap());
        snapshot.state = "inputRequired".into(); snapshot.turn_active = true;
        snapshot.pending_permission = Some(json!({"requestId":"approval","title":"Run checks"}));
        let original = todo_fixture(7);
        update_todos(&mut snapshot, Some(&original), TodoObservation::Live);
        assert!(mark_todos_stale(&mut snapshot));
        assert_eq!(snapshot.todos, Some(original.clone()), "disconnect observation cannot rewrite service/readiness flags");
        let mut invalid = original.clone(); invalid["items"][0]["status"] = json!("in_progress");
        assert!(update_todos(&mut snapshot, Some(&invalid), TodoObservation::Live));
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "unavailable");
        assert!(!update_todos(&mut snapshot, Some(&invalid), TodoObservation::Live));
        assert_eq!(snapshot.todos, Some(original));
        assert_eq!(snapshot.state, "inputRequired");
        assert!(snapshot.turn_active);
        assert_eq!(snapshot.pending_permission.as_ref().unwrap()["requestId"], "approval");
        let mut complete = todo_fixture(8); complete.as_object_mut().unwrap().remove("activeId"); complete["items"][0]["status"] = json!("completed");
        update_todos(&mut snapshot, Some(&complete), TodoObservation::Live);
        assert!(snapshot.turn_active, "a finished checklist is not a finished turn");
        assert_eq!(snapshot.state, "inputRequired");
        restore_todos(&mut snapshot);
        assert_eq!(snapshot.todo_sync.as_ref().unwrap().state, "stale");
        assert_eq!(snapshot.todos, Some(complete));
    }
    #[test]
    fn request_ids_do_not_reuse_prompt_receipts_after_reattachment() {
        let first = next_request_id();
        let remote_maximum = first.saturating_add(1000);
        IDS.fetch_max(remote_maximum,Ordering::SeqCst);
        assert!(next_request_id() > remote_maximum);
        let a = next_request_id(); let b = next_request_id(); assert!(b > a);
    }
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires localhost SSH fixture and installed Pi/Claude/Codex/OpenCode; performs no model prompts"]
    async fn native_catalogs_initialise_over_verified_ssh_without_tmux() {
        use crate::{core, hostkeys};
        let root = std::path::PathBuf::from("/tmp/opencode")
            .join(format!("still-agent-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        unsafe {
            std::env::set_var("STILL_KNOWN_HOSTS", root.join("known-hosts.json"));
        }
        let (_, public, _) = ssh_worker::probe_host_key("127.0.0.1", 22).await.unwrap();
        hostkeys::store_trusted("127.0.0.1", 22, public.trim()).unwrap();
        let home = std::env::var("HOME").unwrap();
        let secret = std::fs::read_to_string(format!("{home}/.ssh/still_poc_test")).unwrap();
        let config = core::SshConfig {
            host: "127.0.0.1".into(),
            port: 22,
            username: std::env::var("USER").unwrap(),
            tmux_session: "still-unused-agent-test".into(),
            ssh_only: true,
            working_directory: None,
            cols: 80,
            rows: 24,
        };
        let (events, mut receiver) = mpsc::unbounded_channel();
        let (_input, input_rx) = mpsc::unbounded_channel();
        let (_resize, resize_rx) = mpsc::unbounded_channel();
        let (shutdown, shutdown_rx) = oneshot::channel();
        let worker = tokio::spawn(ssh_worker::run_session(
            "native-catalog-fixture".into(),
            config,
            None,
            Some(secret),
            events,
            input_rx,
            resize_rx,
            shutdown_rx,
        ));
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                match receiver.recv().await.unwrap() {
                    core::SessionEvent::Status {
                        status: core::SessionStatus::Live,
                    } => break,
                    core::SessionEvent::Error { error } => {
                        panic!("SSH fixture failed: {}", error.message)
                    }
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        let cwd = remote_cwd("native-catalog-fixture", root.to_str().unwrap())
            .await
            .unwrap();
        let commands = root.join(".opencode/commands/team");
        let skills = root.join(".opencode/skills/still-check");
        std::fs::create_dir_all(&commands).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(commands.join("review.md"), "---\ndescription: Still catalog fixture\n---\nReview $ARGUMENTS.").unwrap();
        std::fs::write(skills.join("SKILL.md"), "---\nname: Still Check\ndescription: Verify the preflight inventory\n---\nInspect the fixture.").unwrap();
        let catalog = still_agent_catalog(CatalogArgs { native_session_id:"native-catalog-fixture".into(),agent_id:"opencode".into(),cwd:cwd.clone(),executable:None }).await.unwrap();
        let entries = catalog["commands"].as_array().unwrap();
        assert!(entries.iter().any(|command| command["name"] == "team/review"));
        assert!(entries.iter().any(|command| command["name"] == "skill:still-check"));
        for id in ["pi", "claude", "codex", "opencode"] {
            let command = login_command(&format!(
                "cd -- {} || exit 73; exec env STILL_AGENT_DRIVER={} STILL_AGENT_EXECUTABLE={} node --input-type=module -e {}",
                quote(&cwd),
                quote(id),
                quote(id),
                quote(include_str!("../agent-host/bridge.mjs"))
            ));
            let mut channel = ssh_worker::open_agent_exec("native-catalog-fixture", &command)
                .await
                .unwrap();
            send(&channel, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}})).await.unwrap();
            send(&channel, &json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await.unwrap();
            let mut bytes = Vec::new();
            let result = tokio::time::timeout(Duration::from_secs(45), async {
                while let Some(message) = channel.wait().await {
                    match message {
                        ChannelMsg::Data { data } => {
                            bytes.extend_from_slice(&data);
                            assert!(bytes.len() <= FRAME_LIMIT);
                            while let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
                                let line = bytes.drain(..=end).collect::<Vec<_>>();
                                let frame: Value = serde_json::from_slice(&line)
                                    .expect("real native SSH stdout must be JSONL");
                                if frame.get("id").and_then(Value::as_u64) == Some(3) {
                                    return frame;
                                }
                            }
                        }
                        ChannelMsg::Eof | ChannelMsg::Close => {
                            panic!("{id} exited before returning its catalog")
                        }
                        _ => {}
                    }
                }
                panic!("{id} stream closed during initialization")
            })
            .await
            .unwrap();
            let _ = channel.eof().await;
            let _ = channel.close().await;
            assert!(result.get("error").is_none(), "{id}: {}", result);
            assert!(
                result
                    .pointer("/result/sessionId")
                    .and_then(Value::as_str)
                    .is_some()
            );
            assert!(
                !result
                    .pointer("/result/configOptions")
                    .and_then(Value::as_array)
                    .unwrap()
                    .is_empty()
            );
        }
        let _ = shutdown.send(());
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn streaming_history_keeps_messages_not_thousands_of_token_frames() {
        let mut history = vec![Event::new("userMessage")];
        for sequence in 1..=2000 {
            let mut event = Event::new("assistantChunk");
            event.sequence = sequence;
            event.text = Some("x".into());
            append_history(&mut history, event);
        }
        assert_eq!(history.len(), 2);
        assert_eq!(history[1].sequence, 1);
        assert_eq!(history[1].text.as_ref().unwrap().len(), 2000);
        append_history(&mut history, Event::new("toolStart"));
        append_history(&mut history, Event::new("assistantChunk"));
        assert_eq!(history.len(), 4);
    }
    #[test]
    fn acknowledged_revert_clears_trimmed_and_resumed_snapshots_at_the_requested_boundary() {
        let event = |value| serde_json::from_value::<Event>(value).unwrap();
        let mut full = vec![
            event(json!({"sequence":1,"attemptId":"old","type":"userMessage","messageId":"first","text":"Keep"})),
            event(json!({"sequence":2,"attemptId":"old","type":"assistantChunk","text":"Kept reply"})),
            event(json!({"sequence":3,"attemptId":"old","type":"userMessage","messageId":"second","text":"Revert"})),
            event(json!({"sequence":4,"attemptId":"old","type":"assistantChunk","text":"Removed reply"})),
        ];
        apply_history_event(&mut full, &event(json!({"sequence":5,"attemptId":"old","type":"messageCheckpoint","messageId":"second","checkpoint":{"provider":"codex","turnId":"turn-two"}})));
        assert_eq!(full[2].checkpoint.as_ref().unwrap()["turnId"], "turn-two");
        let boundary = event(json!({"sequence":6,"attemptId":"old","type":"historyReverted","messageId":"second","checkpoint":{"sequence":3,"attemptId":"old"}}));
        let mut trimmed = full[3..].to_vec();
        apply_history_event(&mut trimmed, &boundary);
        assert!(trimmed.is_empty());
        apply_history_event(&mut full, &boundary);
        assert_eq!(full.len(), 2);
        assert_eq!(full[0].message_id.as_deref(), Some("first"));
        let mut resumed = vec![event(json!({"sequence":1,"attemptId":"new","type":"assistantChunk","text":"Later process output"}))];
        let resumed_boundary = event(json!({"sequence":3,"attemptId":"new","type":"historyReverted","messageId":"second","checkpoint":{"sequence":3,"attemptId":"old"}}));
        apply_history_event(&mut resumed, &resumed_boundary);
        assert!(resumed.is_empty());
    }
    #[test]
    fn legacy_controls_only_fill_missing_categories() {
        let result = json!({"modes":{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"code","name":"Code"}]},"models":{"currentModelId":"a","availableModels":[{"modelId":"a","name":"Model A"}]}});
        let mut options = vec![
            json!({"id":"modern-model","category":"model","type":"select","currentValue":"x","options":[{"value":"x","name":"X"}]}),
        ];
        add_legacy_config(&mut options, &result);
        assert_eq!(options.len(), 2);
        assert_eq!(options[1]["id"], "still:mode");
        assert!(config_value_is_advertised(
            &json!(options),
            "still:mode",
            &json!("code")
        ));
        assert!(!config_value_is_advertised(
            &json!(options),
            "still:mode",
            &json!("unsafe")
        ));
    }
    #[test]
    fn executable_overrides_are_literal_absolute_paths() {
        let def = definition("pi").unwrap();
        assert_eq!(executable(&def, None).unwrap(), "pi");
        assert!(executable(&def, Some("npx pi-acp")).is_err());
        assert!(executable(&def, Some("/path\nwith/control")).is_err());
        assert_eq!(
            executable(&def, Some("/home/user/custom bin/pi-acp")).unwrap(),
            "/home/user/custom bin/pi-acp"
        );
    }
    #[test]
    fn directory_script_preserves_home_expansion_and_quotes_input() {
        assert!(
            directory_script("~/project a")
                .unwrap()
                .contains("\"$HOME\"/'project a'")
        );
        assert!(directory_script("~").unwrap().contains("cd -- \"$HOME\""));
        assert!(
            directory_script("/srv/a'$(touch pwned)")
                .unwrap()
                .contains("'\\''")
        );
        assert!(directory_script("/srv/a\nb").is_err());
        assert!(login_command("printf ok").contains("-lc"));
    }
    #[test]
    fn model_config_is_detected_only_from_agent_advertisement() {
        let options = json!([{"id":"reasoning","category":"thought_level","type":"select"},{"id":"model","category":"model","type":"select"}]);
        let advertised = options.as_array().unwrap();
        assert_eq!(
            advertised
                .iter()
                .find(
                    |option| option.get("category").and_then(Value::as_str) == Some("model")
                        && option.get("type").and_then(Value::as_str) == Some("select")
                )
                .and_then(|option| option.get("id"))
                .and_then(Value::as_str),
            Some("model")
        );
        let none = json!([]);
        assert_eq!(
            none.as_array()
                .unwrap()
                .iter()
                .find(|option| option.get("category").and_then(Value::as_str) == Some("model")),
            None
        );
    }
    #[test]
    fn config_values_must_be_offered_by_agent() {
        let options = json!([{"id":"model","type":"select","options":[{"value":"a"},{"name":"group","options":[{"value":"b"}]}]}]);
        assert!(config_value_is_advertised(&options, "model", &json!("a")));
        assert!(config_value_is_advertised(&options, "model", &json!("b")));
        assert!(!config_value_is_advertised(
            &options,
            "model",
            &json!("evil")
        ));
    }
}
fn config_value_is_advertised(options: &Value, id: &str, value: &Value) -> bool {
    options
        .as_array()
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
        })
        .is_some_and(|option| {
            option.get("type").and_then(Value::as_str) == Some("boolean") && value.is_boolean()
                || option.get("type").and_then(Value::as_str) == Some("select")
                    && option
                        .get("options")
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values.iter().any(|entry| {
                                entry.get("value") == Some(value)
                                    || entry.get("options").and_then(Value::as_array).is_some_and(
                                        |nested| {
                                            nested
                                                .iter()
                                                .any(|item| item.get("value") == Some(value))
                                        },
                                    )
                            })
                        })
        })
}
