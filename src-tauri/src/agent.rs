//! Foreground remote agent runner. Native provider drivers use the bundled Node
//! host; Gemini uses ACP directly. All share the ACP v1 SSH-facing envelope.
//! Execution depends on the verified SSH connection; detached supervision is not implemented.
use crate::{
    agent_store,
    commands::AppState,
    core::{SessionStatus, StillError},
    ssh_worker,
};
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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

const FRAME_LIMIT: usize = 2 * 1024 * 1024;
const HISTORY_LIMIT: usize = 1200;
static IDS: AtomicU64 = AtomicU64::new(1);
static THREADS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Thread>>>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Arc<Mutex<Thread>>>> {
    THREADS.get_or_init(|| Mutex::new(HashMap::new()))
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
        }
    }
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
    close: mpsc::UnboundedSender<oneshot::Sender<Result<(), String>>>,
    resume_session_id: Option<String>,
    pending_input_id: Option<Value>,
    early_updates: Vec<Value>,
    cleanup_error: Option<String>,
    unsaved: VecDeque<(Snapshot, Event)>,
    history_lease: Option<std::fs::File>,
    messages: Vec<Event>,
    history_request: Option<PendingHistory>,
}
struct PendingHistory {
    request_id: u64,
    message: Event,
    previous_state: String,
    reply: oneshot::Sender<Result<(), String>>,
}
struct PendingConfig {
    id: String,
    value: Value,
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
fn quote(arg: &str) -> String {
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
fn login_command(script: &str) -> String {
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
}
#[tauri::command]
pub async fn still_agent_check(args: CheckArgs) -> Result<Vec<Availability>, StillError> {
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
    let mut channel = ssh_worker::open_agent_exec(&args.native_session_id, &login_command(&script))
        .await
        .map_err(|e| {
            StillError::friendly(
                "agent_check_failed",
                &format!("Connect to the remote server first: {e}"),
            )
        })?;
    let output = tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    output.extend_from_slice(&data);
                    if output.len() > FRAME_LIMIT {
                        return Err("Remote shell output exceeded the detection limit.");
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(output)
    })
    .await;
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
    Ok(ids
        .into_iter()
        .map(|id| {
            let prefix = format!("STILL_AGENT:{id}:");
            let path = text
                .lines()
                .find_map(|line| line.strip_prefix(&prefix))
                .map(str::to_owned);
            Availability {
                agent_id: id.to_owned(),
                available: path.is_some() && (id == "gemini" || node_ready),
                installed: path.is_some(),
                runtime: if id == "gemini" { "acp" } else { "native" }.into(),
                runtime_available: id == "gemini" || node_ready,
                message: if path.is_some() && id != "gemini" && !node_ready { Some("Installed. Still's native bridge needs Node.js 20 or newer on this server.".into()) } else { None },
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
async fn remote_cwd(session_id: &str, directory: &str) -> Result<String, StillError> {
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
    let launch = if args.agent_id == "gemini" {
        std::iter::once(path.as_str())
            .chain(def.args.iter().copied())
            .map(quote)
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        format!(
            "env STILL_AGENT_DRIVER={} STILL_AGENT_EXECUTABLE={} node --input-type=module -e {}",
            quote(&args.agent_id),
            quote(&path),
            quote(include_str!("../agent-host/bridge.mjs"))
        )
    };
    let remote = login_command(&format!(
        "cd -- {} || exit 73; command -v {} >/dev/null 2>&1 || {{ printf '%s\\n' {} >&2; exit 127; }}; exec {launch}",
        quote(&cwd),
        quote(&path),
        quote(&format!(
            "Install {} on this remote server, or set its executable path in Agent setup.",
            def.install
        ))
    ));
    let execution_id = format!("agent-{}-{}-{}", agent_store::timestamp(), std::process::id(), IDS.fetch_add(1, Ordering::Relaxed));
    let conversation_id = args.conversation_id.clone().unwrap_or_else(|| execution_id.clone());
    let history_lease = agent_store::lease(&app, conversation_id.clone()).await?;
    let channel=ssh_worker::open_agent_exec(&args.native_session_id,&remote).await.map_err(|_|StillError::friendly("agent_launch",format!("Could not launch {} on the remote host. Verify that {} is already installed there.",def.name,def.install)))?;
    let (cancel, cancel_rx) = mpsc::unbounded_channel();
    let (outbound, outbound_rx) = mpsc::unbounded_channel();
    let (close, close_rx) = mpsc::unbounded_channel();
    let snapshot = Snapshot {
        conversation_id,
        host_key: json!([config.host.to_lowercase(), config.port, config.username]).to_string(),
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
        active_message_ids: None,
    };
    if let Err(error) = agent_store::register(&app, &snapshot, args.conversation_id.is_some()).await {
        let _ = channel.eof().await;
        let _ = channel.close().await;
        return Err(error);
    }
    let messages = if args.conversation_id.is_some() {
        match agent_store::history_messages(&app, snapshot.conversation_id.clone()).await {
            Ok(messages) => messages,
            Err(error) => { let _ = channel.eof().await; let _ = channel.close().await; return Err(error); }
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
        close,
        resume_session_id: args.resume_session_id,
        pending_input_id: None,
        early_updates: Vec::new(),
        cleanup_error: None,
        unsaved: VecDeque::new(),
        history_lease: Some(history_lease),
        messages,
        history_request: None,
    }));
    registry().lock().await.insert(execution_id, row.clone());
    tokio::spawn(run(channel, row, outbound_rx, cancel_rx, close_rx, cwd));
    Ok(snapshot)
}

async fn run(
    mut channel: Channel<client::Msg>,
    row: Arc<Mutex<Thread>>,
    outbound: mpsc::UnboundedReceiver<Value>,
    cancel: mpsc::UnboundedReceiver<()>,
    close: mpsc::UnboundedReceiver<oneshot::Sender<Result<(), String>>>,
    cwd: String,
) {
    run_stream(&mut channel, row, outbound, cancel, close, cwd).await;
    // Every exit, including malformed frames and initialization timeout, closes
    // stdin explicitly so the remote host can reap its native child processes.
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
) {
    if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"still","title":"Still","version":env!("CARGO_PKG_VERSION")}}})).await{fail(&row,&format!("ACP initialize failed: {error}")).await;return}
    let mut buffer = Vec::new();
    let mut stage = 0_u8;
    let mut session_id = None;
    let mut permission: Option<(Value, Vec<Value>)> = None;
    let mut stderr = String::new();

    let mut cancel_received = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

    loop {
        tokio::select! {
          Some(reply) = close.recv() => {
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
               let mut thread=row.lock().await;thread.snapshot.pending_permission=None;thread.permission=None;
             }
             {
                let mut thread = row.lock().await;
                if let Some(request_id) = thread.pending_input_id.take() {
                  let _ = send(&channel, &json!({"jsonrpc":"2.0","id":request_id,"result":{"action":"cancel"}})).await;
                  thread.snapshot.pending_input = None;
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
          Some(value)=outbound.recv()=>{if permission.as_ref().is_some_and(|(id,_)|value.get("id")==Some(id)&&value.get("result").is_some()){permission=None;}if value.get("method").and_then(Value::as_str)==Some("session/prompt"){cancel_received=false;}if let Err(error)=send(&channel,&value).await{fail(&row,&format!("SSH stream closed before request send: {error}")).await;return}},
           incoming=channel.wait()=>match incoming{Some(ChannelMsg::Data{data})=>{buffer.extend_from_slice(&data);if buffer.len()>FRAME_LIMIT{fail(&row,"ACP frame exceeded 2 MiB.").await;return}while let Some(end)=buffer.iter().position(|byte|*byte==b'\n'){let frame:Vec<u8>=buffer.drain(..=end).collect();if frame.iter().all(u8::is_ascii_whitespace){continue;}let value=match serde_json::from_slice::<Value>(&frame){Ok(value)=>value,Err(_)=>{fail(&row,"Remote stdout was not valid ACP JSON. Check whether the login shell prints a startup banner.").await;return}};if let Err(error)=handle(channel,&row,&cwd,&mut stage,&mut session_id,&mut permission,value).await{fail(&row,&error).await;return}}},Some(ChannelMsg::ExtendedData{data,..})=>{stderr.push_str(&String::from_utf8_lossy(&data));if stderr.len()>16384{let mut cut=stderr.len()-16384;while !stderr.is_char_boundary(cut){cut+=1;}stderr.drain(..cut);}},Some(ChannelMsg::Eof|ChannelMsg::Close)|None=>{fail(&row,&format!("Remote agent process exited. Check installation and authentication in the server terminal. Background survival is not guaranteed. {}",stderr.trim())).await;return},_=>{}}
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
    if let Some(method) = value.get("method").and_then(Value::as_str) {
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
                if thread.history_request.as_ref().is_some_and(|pending| pending.request_id == number) {
                    let pending = thread.history_request.take().unwrap();
                    thread.snapshot.state = if error.pointer("/data/historyUncertain").and_then(Value::as_bool) == Some(true) { "submissionUnknown".into() } else { pending.previous_state };
                    thread.snapshot.last_error = Some(message.to_owned());
                    let mut event = Event::new("threadError"); event.state = Some(thread.snapshot.state.clone()); event.text = Some(message.to_owned()); emit(&mut thread, event).await;
                    let _ = pending.reply.send(Err(message.to_owned()));
                    return Ok(());
                }
                drop(thread);
                if let Some(pending) = row.lock().await.config_requests.remove(&number) {
                    let _ = pending.reply.send(Err(message.to_owned()));
                    return Ok(());
                }
            }
            if (*stage == 0 && id.as_u64() == Some(1)) || (*stage == 2 && id.as_u64() == Some(3)) {
                return Err(message.into());
            }
            let mut thread = row.lock().await;
            if thread.prompt.as_ref().is_some_and(|request| request == &id) {
                thread.prompt = None;
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
        t.snapshot.agent_session_id = Some(sid);
        t.snapshot.resumable = result
            .pointer("/_meta/resumable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let capabilities = result.pointer("/_meta/historyCapabilities");
        t.snapshot.history_capabilities = json!({"revert":capabilities.and_then(|value| value["revert"].as_bool()).unwrap_or(false),"retry":capabilities.and_then(|value| value["retry"].as_bool()).unwrap_or(false)});
        let mut capability_event = Event::new("historyCapabilities");
        capability_event.history_capabilities = Some(t.snapshot.history_capabilities.clone());
        emit(&mut t, capability_event).await;
        t.snapshot.config_options = configs.clone();
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
                    option["currentValue"] = pending.value;
                }
            } else {
                let _ = pending.reply.send(Err("Agent acknowledged the setting without configOptions. Refresh the thread before retrying.".into()));
                return Ok(());
            }
            let mut event = Event::new("configOptions");
            event.config_options = Some(thread.snapshot.config_options.clone());
            emit(&mut thread, event).await;
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
                t.snapshot.turn_active = false;
                t.snapshot.pending_permission = None;
                t.snapshot.pending_input = None;
                t.pending_input_id = None;
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
            t.snapshot.config_options = options.clone();
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
                if let Some(option) = t
                    .snapshot
                    .config_options
                    .iter_mut()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some("still:mode"))
                {
                    option["currentValue"] = value.clone();
                }
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
            t.snapshot.turn_active = false;
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
    t.snapshot.state = failure_state(&t).into();
    t.snapshot.last_error = Some(message.into());
    t.permission = None;
    t.snapshot.pending_permission = None;
    t.snapshot.pending_input = None;
    t.pending_input_id = None;
    for (_, pending) in t.config_requests.drain() {
        let _ = pending.reply.send(Err(message.into()));
    }
    if let Some(pending) = t.history_request.take() { let _ = pending.reply.send(Err(message.into())); }
    t.snapshot.turn_active = false;
    let mut e = Event::new("threadError");
    e.state = Some(t.snapshot.state.clone());
    e.text = Some(message.into());
    emit(&mut t, e).await
}
fn failure_state(thread: &Thread) -> &'static str {
    if thread.history_request.is_some() || thread.snapshot.state == "submissionUnknown" { "submissionUnknown" } else { "error" }
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
        "working" | "complete" | "cancelled"
    ) || thread.snapshot.turn_active
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
    let id = IDS.fetch_add(1, Ordering::Relaxed) + 100;
    thread.prompt = Some(json!(id));
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
    let request_id = IDS.fetch_add(1, Ordering::Relaxed) + 1200;
    let request = json!({"jsonrpc":"2.0","id":request_id,"method":"_still/session/revert","params":{"sessionId":thread.snapshot.agent_session_id,"checkpoint":message.checkpoint}});
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
            "working" | "complete" | "cancelled"
        )
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
    let request_id = IDS.fetch_add(1, Ordering::Relaxed) + 900;
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
    thread.config_requests.insert(
        request_id,
        PendingConfig {
            id: args.config_id,
            value: args.value,
            reply,
        },
    );
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
    registry().lock().await.get(id).cloned().ok_or_else(||StillError::friendly("agent_process_lost","This foreground process is no longer attached. Inspect the remote host before starting a replacement."))
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
    let result = if let Some(answers) = args.answers {
        json!({"action":"accept","content":answers})
    } else {
        json!({"action":"decline"})
    };
    thread
        .outbound
        .send(json!({"jsonrpc":"2.0","id":args.request_id,"result":result}))
        .map_err(|_| {
            StillError::friendly(
                "agent_disconnected",
                "Agent disconnected before receiving your answer.",
            )
        })?;
    thread.pending_input_id = None;
    thread.snapshot.pending_input = None;
    thread.snapshot.state = "working".into();
    let mut event = Event::new("threadState");
    event.state = Some("working".into());
    emit(&mut thread, event).await;
    Ok(())
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
    if !permission.options.iter().any(|option| {
        option.get("optionId").and_then(Value::as_str) == Some(args.option_id.as_str())
    }) {
        return Err(StillError::friendly(
            "agent_permission_invalid",
            "Choose an option the remote agent actually offered.",
        ));
    }
    thread.outbound.send(json!({"jsonrpc":"2.0","id":args.request_id,"result":{"outcome":{"outcome":"selected","optionId":args.option_id}}})).map_err(|_|StillError::friendly("agent_disconnected","Remote process ended before approval was delivered."))?;
    thread.snapshot.pending_permission = None;
    thread.permission = None;
    thread.snapshot.state = "working".into();
    let mut event = Event::new("threadState");
    event.state = Some("working".into());
    emit(&mut thread, event).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
