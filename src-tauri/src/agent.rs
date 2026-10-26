//! Foreground remote ACP v1 runner. The remote SSH handle, not the client,
//! launches and owns the CLI. A remote supervisor is a future reliability gate.
use crate::{
    commands::AppState,
    core::{SessionStatus, SshConfig, StillError},
    ssh_worker,
};
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, mpsc};

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
}
impl Event {
    fn new(kind: &str) -> Self {
        Self {
            sequence: 0,
            kind: kind.into(),
            state: None,
            text: None,
            tool_call_id: None,
            title: None,
            detail: None,
            status: None,
            permission: None,
            config_options: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
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
    config_requests: HashMap<u64, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    native_session_id: String,
    local_session_id: String,
    agent_id: String,
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
            command: "pi-acp",
            args: &[],
            install: "pi-acp adapter",
        },
        "codex" => Definition {
            name: "Codex",
            command: "codex-acp",
            args: &[],
            install: "@agentclientprotocol/codex-acp adapter",
        },
        "claude" => Definition {
            name: "Claude Code",
            command: "claude-agent-acp",
            args: &[],
            install: "@agentclientprotocol/claude-agent-acp adapter",
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
fn command(def: &Definition) -> String {
    std::iter::once(def.command)
        .chain(def.args.iter().copied())
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}
fn emit(thread: &mut Thread, mut e: Event) {
    thread.snapshot.last_sequence = thread.snapshot.last_sequence.saturating_add(1);
    e.sequence = thread.snapshot.last_sequence;
    if thread.snapshot.transcript.len() >= HISTORY_LIMIT {
        thread.snapshot.transcript.remove(0);
    }
    thread.snapshot.transcript.push(e.clone());
    let _ = thread.app.emit(
        &format!("still://agent-event/{}", thread.snapshot.execution_id),
        e,
    );
}

/// Uses an absolute saved cwd when specified. Otherwise runs fixed `pwd` on a
/// temporary non-PTY channel belonging to the same authenticated SSH session.
async fn remote_cwd(session_id: &str, config: &SshConfig) -> Result<String, StillError> {
    if let Some(path) = config
        .working_directory
        .as_deref()
        .filter(|p| p.starts_with('/'))
    {
        return Ok(path.to_owned());
    }
    let mut channel = ssh_worker::open_agent_exec(session_id, "pwd")
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
            Some(ChannelMsg::Data { data }) if bytes.len() + data.len() < 4096 => {
                bytes.extend_from_slice(&data)
            }
            Some(ChannelMsg::Data { .. }) => {
                return Err(StillError::friendly(
                    "agent_cwd_invalid",
                    "Remote pwd output is too large.",
                ));
            }
            Some(ChannelMsg::ExtendedData { .. }) => {
                return Err(StillError::friendly(
                    "agent_cwd_invalid",
                    "Remote shell produced unexpected stderr during directory lookup.",
                ));
            }
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let cwd = String::from_utf8_lossy(&bytes)
        .lines()
        .next()
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
    let cwd = remote_cwd(&args.native_session_id, &config).await?;
    let channel=ssh_worker::open_agent_exec(&args.native_session_id,&command(&def)).await.map_err(|_|StillError::friendly("agent_launch",format!("Could not launch {} on the remote host. Verify that {} is already installed there.",def.name,def.install)))?;
    let execution_id = format!(
        "agent-{}-{}",
        std::process::id(),
        IDS.fetch_add(1, Ordering::Relaxed)
    );
    let (cancel, cancel_rx) = mpsc::unbounded_channel();
    let (outbound, outbound_rx) = mpsc::unbounded_channel();
    let snapshot = Snapshot {
        execution_id: execution_id.clone(),
        local_session_id: args.local_session_id,
        agent_id: args.agent_id,
        agent_name: def.name.into(),
        agent_session_id: None,
        cwd: cwd.clone(),
        state: "connecting".into(),
        transcript: Vec::new(),
        pending_permission: None,
        last_error: None,
        last_sequence: 0,
        turn_active: false,
        config_options: Vec::new(),
    };
    let row = Arc::new(Mutex::new(Thread {
        snapshot: snapshot.clone(),
        app,
        outbound,
        cancel,
        permission: None,
        prompt: None,
        config_requests: HashMap::new(),
    }));
    registry().lock().await.insert(execution_id, row.clone());
    tokio::spawn(run(channel, row, outbound_rx, cancel_rx, cwd));
    Ok(snapshot)
}

async fn run(
    mut channel: Channel<client::Msg>,
    row: Arc<Mutex<Thread>>,
    mut outbound: mpsc::UnboundedReceiver<Value>,
    mut cancel: mpsc::UnboundedReceiver<()>,
    cwd: String,
) {
    if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"auth":{"terminal":false},"session":{"configOptions":{"boolean":{}}}},"clientInfo":{"name":"still","title":"Still","version":env!("CARGO_PKG_VERSION")}}})).await{fail(&row,&format!("ACP initialize failed: {error}")).await;return}
    let mut buffer = Vec::new();
    let mut stage = 0_u8;
    let mut session_id = None;
    let mut permission: Option<(Value, Vec<Value>)> = None;

    let mut cancel_received = false;

    loop {
        tokio::select! {
         _ = cancel.recv(), if !cancel_received => {
            cancel_received=true;
            if let Some((request_id,_))=permission.take(){
              let _=send(&channel,&json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":{"outcome":"cancelled"}}})).await;
              let mut thread=row.lock().await;thread.snapshot.pending_permission=None;
            }
            if let Some(session)=session_id.as_ref(){
              let _=send(&channel,&json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await;
              let mut thread=row.lock().await;
              if thread.snapshot.turn_active {
                thread.snapshot.state="working".into();
                let mut event=Event::new("threadStopped");event.text=Some("Cancellation requested; waiting for the agent to confirm it has stopped.".into());emit(&mut thread,event);
              }
            }
         },
         Some(value)=outbound.recv()=>if let Err(error)=send(&channel,&value).await{fail(&row,&format!("SSH stream closed before request send: {error}")).await;return},
         incoming=channel.wait()=>match incoming{Some(ChannelMsg::Data{data})=>{buffer.extend_from_slice(&data);if buffer.len()>FRAME_LIMIT{fail(&row,"ACP frame exceeded 2 MiB.").await;return}while let Some(end)=buffer.iter().position(|byte|*byte==b'\n'){let frame:Vec<u8>=buffer.drain(..=end).collect();let value=match serde_json::from_slice::<Value>(&frame){Ok(value)=>value,Err(_)=>{fail(&row,"Remote agent stdout was not valid ACP JSON.").await;return}};if let Err(error)=handle(&mut channel,&row,&cwd,&mut stage,&mut session_id,&mut permission,value).await{fail(&row,&error).await;return}}},Some(ChannelMsg::ExtendedData{..})=>{fail(&row,"Remote agent wrote unexpected stderr to its ACP stream.").await;return},Some(ChannelMsg::Eof|ChannelMsg::Close)|None=>{fail(&row,"Remote agent process exited. Background survival is not available in this foreground release.").await;return},_=>{}}
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
        if method == "session/set_config_option" {
            let request = value
                .get("id")
                .cloned()
                .ok_or("config request is missing JSON-RPC ID")?;
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let session = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let config_id = params.get("configId").and_then(Value::as_str).unwrap_or("");
            let selected = params.get("value").cloned().unwrap_or(Value::Null);
            let mut thread = row.lock().await;
            if thread.snapshot.agent_session_id.as_deref() != Some(session) {
                return Err("config request used wrong ACP session".into());
            }
            if !config_value_is_advertised(
                &Value::Array(thread.snapshot.config_options.clone()),
                config_id,
                &selected,
            ) {
                return Err("config request did not select an advertised value".into());
            }
            let option = thread
                .snapshot
                .config_options
                .iter_mut()
                .find(|option| option.get("id").and_then(Value::as_str) == Some(config_id))
                .ok_or("unknown config ID")?;
            if let Some(object) = option.as_object_mut() {
                object.insert("currentValue".into(), selected);
            }
            let result = json!({"configOptions":thread.snapshot.config_options});
            drop(thread);
            send(
                channel,
                &json!({"jsonrpc":"2.0","id":request,"result":result}),
            )
            .await?;
            return Ok(());
        }
        if method == "session/update" {
            update(row, value.get("params").cloned().unwrap_or(Value::Null)).await;
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
            let options = params
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if options.is_empty() {
                return Err("Permission request has no options.".into());
            }
            let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
            let detail = json!({"requestId":id,"sessionId":params.get("sessionId").and_then(Value::as_str).unwrap_or(""),"toolCallId":tool.get("toolCallId").and_then(Value::as_str).unwrap_or(""),"title":tool.get("title").and_then(Value::as_str).or_else(||tool.get("name").and_then(Value::as_str)).unwrap_or("Permission required"),"description":tool.get("description"),"command":tool.get("content").and_then(Value::as_array).and_then(|a|a.first()).and_then(|x|x.get("text")),"options":options});
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
            emit(&mut t, e);
            return Ok(());
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
            if (*stage == 0 && id.as_u64() == Some(1))
                || (*stage == 1 && id.as_u64() == Some(2))
                || (*stage == 2 && id.as_u64() == Some(3))
            {
                return Err(message.into());
            }
            let mut thread = row.lock().await;
            if thread.prompt.as_ref().is_some_and(|request| request == &id) {
                thread.prompt = None;
                thread.snapshot.turn_active = false;
                thread.snapshot.state = "error".into();
                thread.snapshot.last_error = Some(message.to_owned());
                let mut event = Event::new("threadError");
                event.state = Some("error".into());
                event.text = Some(message.to_owned());
                emit(&mut thread, event);
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
        let methods = result
            .get("authMethods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if methods
            .iter()
            .any(|m| m.get("type").and_then(Value::as_str) == Some("terminal"))
        {
            return Err("This agent requires interactive terminal sign-in. Sign in on the remote server, then start a fresh agent thread.".into());
        }
        let usable: Vec<_> = methods
            .iter()
            .filter(|m| m.get("type").and_then(Value::as_str) != Some("terminal"))
            .collect();
        if usable.len() > 1 {
            return Err("This agent advertises multiple login methods; choose one on the remote server and retry.".into());
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
            emit(&mut t, e)
        }
        if let Some(method) = usable.first() {
            *stage = 1;
            send(channel,&json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":method.get("id").and_then(Value::as_str).unwrap_or("")}})).await?
        } else {
            *stage = 2;
            send_new(channel, cwd).await?
        }
        return Ok(());
    }
    if *stage == 1 && id.as_ref().and_then(Value::as_u64) == Some(2) {
        *stage = 2;
        send_new(channel, cwd).await?;
        return Ok(());
    }
    if *stage == 2 && id.as_ref().and_then(Value::as_u64) == Some(3) {
        let sid = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("session/new response omitted sessionId")?
            .to_owned();
        *session_id = Some(sid.clone());
        *stage = 3;
        let configs = result
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut t = row.lock().await;
        t.snapshot.agent_session_id = Some(sid);
        t.snapshot.config_options = configs.clone();
        t.snapshot.state = "working".into();
        if !configs.is_empty() {
            let mut config_event = Event::new("configOptions");
            config_event.config_options = Some(configs);
            emit(&mut t, config_event);
        }
        let mut e = Event::new("threadState");
        e.state = Some("working".into());
        emit(&mut t, e);
        return Ok(());
    }
    if let Some(request_id) = id.as_ref().and_then(Value::as_u64) {
        let mut thread = row.lock().await;
        if thread.config_requests.remove(&request_id).is_some() {
            let options = result
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
                .ok_or("set_config_option response omitted complete configOptions")?;
            thread.snapshot.config_options = options.clone();
            let mut event = Event::new("configOptions");
            event.config_options = Some(options);
            emit(&mut thread, event);
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
                t.snapshot.state = if stop_reason == "cancelled" {
                    "cancelled"
                } else {
                    "complete"
                }
                .into();
                let mut event = Event::new("threadComplete");
                event.state = Some(t.snapshot.state.clone());
                event.text = Some(format!("stopReason: {stop_reason}"));
                emit(&mut t, event);
            }
        }
    }
    Ok(())
}
async fn send_new(channel: &Channel<client::Msg>, cwd: &str) -> Result<(), String> {
    send(channel,&json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await
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
    ) {
        return;
    }
    let mut t = row.lock().await;
    if kind == "config_option_update" {
        if let Some(options) = u.get("configOptions").and_then(Value::as_array) {
            let options = options.clone();
            t.snapshot.config_options = options.clone();
            let mut event = Event::new("configOptions");
            event.config_options = Some(options);
            emit(&mut t, event);
        }
        return;
    }
    let mut e = Event::new("toolUpdate");
    match kind {
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
            e.detail = u
                .get("content")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        }
        "plan" => {
            e.title = Some("Plan".into());
            e.detail = u.get("entries").map(Value::to_string)
        }
        "session_error" => {
            e.kind = "threadError".into();
            e.text = u.get("message").and_then(Value::as_str).map(str::to_owned)
        }
        _ => e.title = Some(kind.into()),
    }
    emit(&mut t, e)
}
async fn fail(row: &Arc<Mutex<Thread>>, message: &str) {
    let mut t = row.lock().await;
    t.snapshot.state = "error".into();
    t.snapshot.last_error = Some(message.into());
    t.snapshot.pending_permission = None;
    t.snapshot.turn_active = false;
    let mut e = Event::new("threadError");
    e.state = Some("error".into());
    e.text = Some(message.into());
    emit(&mut t, e)
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
    if thread.snapshot.state != "working" || thread.snapshot.turn_active {
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
    let mut event = Event::new("userMessage");
    event.text = Some(args.message.clone());
    emit(&mut thread, event);
    if thread.outbound.send(json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":args.message}]}})).is_err() {
        thread.prompt=None;thread.snapshot.turn_active=false;thread.snapshot.state="submissionUnknown".into();
        return Err(StillError::friendly("agent_submission_unknown","The SSH stream closed while queuing the prompt. Inspect the remote process before retrying."));
    }
    Ok(())
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
    thread
        .config_requests
        .insert(request_id, args.config_id.clone());
    thread.outbound.send(json!({"jsonrpc":"2.0","id":request_id,"method":"session/set_config_option","params":{"sessionId":session,"configId":args.config_id,"value":args.value}})).map_err(|_|StillError::friendly("agent_config_unknown","Remote ACP stream disconnected before config update."))?;
    Ok(())
}

async fn find_thread(id: &str) -> Result<Arc<Mutex<Thread>>, StillError> {
    registry().lock().await.get(id).cloned().ok_or_else(||StillError::friendly("agent_process_lost","This foreground process is no longer attached. Inspect the remote host before starting a replacement."))
}
#[tauri::command]
pub async fn still_agent_snapshot(args: IdArgs) -> Result<Snapshot, StillError> {
    Ok(find_thread(&args.execution_id)
        .await?
        .lock()
        .await
        .snapshot
        .clone())
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
    let _ = thread.cancel.send(());
    Ok(())
}
#[tauri::command]
pub async fn still_agent_respond(args: PermissionArgs) -> Result<(), StillError> {
    let row = find_thread(&args.execution_id).await?;
    let mut thread = row.lock().await;
    let permission = thread.permission.take().ok_or_else(|| {
        StillError::friendly("agent_permission_expired", "Approval is no longer pending.")
    })?;
    let id = permission.id.clone();
    if id != args.request_id {
        thread.permission = Some(permission);
        return Err(StillError::friendly(
            "agent_permission_stale",
            "This approval belongs to a different request.",
        ));
    }
    if !permission.options.iter().any(|option| {
        option.get("optionId").and_then(Value::as_str) == Some(args.option_id.as_str())
    }) {
        thread.permission = Some(permission);
        return Err(StillError::friendly(
            "agent_permission_invalid",
            "Choose an option the remote agent actually offered.",
        ));
    }
    thread.outbound.send(json!({"jsonrpc":"2.0","id":args.request_id,"result":{"outcome":{"outcome":"selected","optionId":args.option_id}}})).map_err(|_|StillError::friendly("agent_disconnected","Remote process ended before approval was delivered."))?;
    thread.snapshot.pending_permission = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
