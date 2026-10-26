//! Foreground remote ACP v1 runner. The remote SSH handle, not the client,
//! launches and owns the CLI. A remote supervisor is a future reliability gate.
use crate::{
    commands::AppState,
    core::{SessionStatus, StillError},
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
            plan: None,
            commands: None,
            content: None,
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
    pub commands: Vec<Value>,
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
            "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:$PATH\"; {script}"
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
        "cd -- {path} || exit 73; printf 'STILL_CWD:%s\\n' \"$PWD\"; "
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
}
#[tauri::command]
pub async fn still_agent_check(args: CheckArgs) -> Result<Vec<Availability>, StillError> {
    let ids: Vec<&str> = args
        .agent_id
        .as_deref()
        .map(|id| vec![id])
        .unwrap_or_else(|| vec!["opencode", "pi", "codex", "claude", "gemini"]);
    let mut script = String::new();
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
                available: path.is_some(),
                executable: path,
            }
        })
        .collect())
}
fn append_history(history: &mut Vec<Event>, event: Event) {
    if matches!(event.kind.as_str(), "assistantChunk" | "reasoningChunk") {
        if let Some(last) = history.last_mut().filter(|last| last.kind == event.kind) {
            last.sequence = event.sequence;
            last.text
                .get_or_insert_with(String::new)
                .push_str(event.text.as_deref().unwrap_or(""));
            return;
        }
    }
    if history.len() >= HISTORY_LIMIT {
        history.remove(0);
    }
    history.push(event);
}
fn emit(thread: &mut Thread, mut e: Event) {
    thread.snapshot.last_sequence = thread.snapshot.last_sequence.saturating_add(1);
    e.sequence = thread.snapshot.last_sequence;
    append_history(&mut thread.snapshot.transcript, e.clone());
    let _ = thread.app.emit(
        &format!("still://agent-event/{}", thread.snapshot.execution_id),
        e,
    );
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
        args.cwd
            .as_deref()
            .or(config.working_directory.as_deref())
            .unwrap_or("~"),
    )
    .await?;
    let path = executable(&def, args.executable.as_deref())?;
    let launch = std::iter::once(path.as_str())
        .chain(def.args.iter().copied())
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let remote = login_command(&format!(
        "cd -- {} || exit 73; command -v {} >/dev/null 2>&1 || {{ printf '%s\\n' {} >&2; exit 127; }}; exec {launch}",
        quote(&cwd),
        quote(&path),
        quote(&format!(
            "Install {} on this remote server, or set its executable path in Agent setup.",
            def.install
        ))
    ));
    let channel=ssh_worker::open_agent_exec(&args.native_session_id,&remote).await.map_err(|_|StillError::friendly("agent_launch",format!("Could not launch {} on the remote host. Verify that {} is already installed there.",def.name,def.install)))?;
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
        commands: Vec::new(),
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
    if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"still","title":"Still","version":env!("CARGO_PKG_VERSION")}}})).await{fail(&row,&format!("ACP initialize failed: {error}")).await;return}
    let mut buffer = Vec::new();
    let mut stage = 0_u8;
    let mut session_id = None;
    let mut permission: Option<(Value, Vec<Value>)> = None;
    let mut stderr = String::new();

    let mut cancel_received = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);

    loop {
        tokio::select! {
          _ = tokio::time::sleep_until(deadline), if stage < 3 => { fail(&row, &format!("Remote ACP initialization timed out. Check installation and authentication in the server terminal. {}", stderr.trim())).await; return; },
         _ = cancel.recv(), if !cancel_received => {
            cancel_received=true;
            if let Some((request_id,_))=permission.take(){
               if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","id":request_id,"result":{"outcome":{"outcome":"cancelled"}}})).await{fail(&row,&error).await;return;}
               let mut thread=row.lock().await;thread.snapshot.pending_permission=None;thread.permission=None;
            }
            if let Some(session)=session_id.as_ref(){
               if let Err(error)=send(&channel,&json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}})).await{fail(&row,&error).await;return;}
              let mut thread=row.lock().await;
              if thread.snapshot.turn_active {
                thread.snapshot.state="working".into();
                let mut event=Event::new("threadStopped");event.text=Some("Cancellation requested; waiting for the agent to confirm it has stopped.".into());emit(&mut thread,event);
              }
            }
         },
          Some(value)=outbound.recv()=>{if permission.as_ref().is_some_and(|(id,_)|value.get("id")==Some(id)&&value.get("result").is_some()){permission=None;}if value.get("method").and_then(Value::as_str)==Some("session/prompt"){cancel_received=false;}if let Err(error)=send(&channel,&value).await{fail(&row,&format!("SSH stream closed before request send: {error}")).await;return}},
          incoming=channel.wait()=>match incoming{Some(ChannelMsg::Data{data})=>{buffer.extend_from_slice(&data);if buffer.len()>FRAME_LIMIT{fail(&row,"ACP frame exceeded 2 MiB.").await;return}while let Some(end)=buffer.iter().position(|byte|*byte==b'\n'){let frame:Vec<u8>=buffer.drain(..=end).collect();if frame.iter().all(u8::is_ascii_whitespace){continue;}let value=match serde_json::from_slice::<Value>(&frame){Ok(value)=>value,Err(_)=>{fail(&row,"Remote stdout was not valid ACP JSON. Check whether the login shell prints a startup banner.").await;return}};if let Err(error)=handle(&mut channel,&row,&cwd,&mut stage,&mut session_id,&mut permission,value).await{fail(&row,&error).await;return}}},Some(ChannelMsg::ExtendedData{data,..})=>{stderr.push_str(&String::from_utf8_lossy(&data));if stderr.len()>16384{let mut cut=stderr.len()-16384;while !stderr.is_char_boundary(cut){cut+=1;}stderr.drain(..cut);}},Some(ChannelMsg::Eof|ChannelMsg::Close)|None=>{fail(&row,&format!("Remote agent process exited. Check installation and authentication in the server terminal. Background survival is not guaranteed. {}",stderr.trim())).await;return},_=>{}}
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
            let detail = json!({"requestId":id,"sessionId":params.get("sessionId").and_then(Value::as_str).unwrap_or(""),"toolCallId":tool.get("toolCallId").and_then(Value::as_str).unwrap_or(""),"title":tool.get("title").and_then(Value::as_str).or_else(||tool.get("name").and_then(Value::as_str)).unwrap_or("Permission required"),"description":tool.get("description"),"command":tool.get("rawInput").and_then(|v|v.get("command")).or_else(||tool.get("content").and_then(Value::as_array).and_then(|a|a.first()).and_then(|x|x.pointer("/content/text"))),"options":options});
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
        // authMethods lists possible sign-in routes, not whether sign-in is needed.
        // Use credentials already configured on the remote account.
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
        let mut configs = result
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        add_legacy_config(&mut configs, result);
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
            emit(&mut thread, event);
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
                emit(&mut t, event);
            }
        }
    }
    Ok(())
}
async fn send_new(channel: &Channel<client::Msg>, cwd: &str) -> Result<(), String> {
    send(channel,&json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await
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
            emit(&mut t, event);
        }
        return;
    }
    let mut e = Event::new("toolUpdate");
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
            e.detail = u.get("rawInput").map(Value::to_string);
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
    t.permission = None;
    t.snapshot.pending_permission = None;
    for (_, pending) in t.config_requests.drain() {
        let _ = pending.reply.send(Err(message.into()));
    }
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
    if !matches!(
        thread.snapshot.state.as_str(),
        "working" | "complete" | "cancelled"
    ) || thread.snapshot.turn_active
        || !thread.config_requests.is_empty()
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
    if thread.snapshot.turn_active
        || !matches!(
            thread.snapshot.state.as_str(),
            "working" | "complete" | "cancelled"
        )
        || !thread.config_requests.is_empty()
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
    thread.cancel.send(()).map_err(|_| {
        StillError::friendly(
            "agent_process_lost",
            "The remote agent disconnected; cancellation was not sent.",
        )
    })
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
    emit(&mut thread, event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(history[1].sequence, 2000);
        assert_eq!(history[1].text.as_ref().unwrap().len(), 2000);
        append_history(&mut history, Event::new("toolStart"));
        append_history(&mut history, Event::new("assistantChunk"));
        assert_eq!(history.len(), 4);
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
        assert_eq!(executable(&def, None).unwrap(), "pi-acp");
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
