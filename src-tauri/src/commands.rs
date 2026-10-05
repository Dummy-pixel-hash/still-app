//! Still production IPC surface.
//!
//! Renderer contract (frontend/src/lib/session.ts):
//! - `still_connect(args)` -> { sessionId, status }  (spawns worker; streams events)
//! - `still_write({sessionId, data: number[]})`      (xterm.js onData -> SSH)
//! - `still_resize({sessionId, cols, rows})`
//! - `still_disconnect({sessionId})`                 (aborts worker; tmux lives on)
//! - `still_status({sessionId})`
//! - `still_forget_secret({host,port,username})`
//! - events: `still://session-event/<sessionId>` { type, ... }
//!
//! Secrets: password/key arrive per-call; if `remember:true` they are written
//! to the OS keyring under connectionKey(). They are NEVER returned to the
//! renderer and never written anywhere else.
//!
//! Disconnect semantics: abort the worker task (drops TCP+channel). tmux
//! keeps running server-side; reconnect uses the same tmux session name.

use crate::core::{
    LiveSession, SessionEvent, SessionStatus, SshConnectArgs, StillError,
};
use crate::diag;
use crate::hostkeys;
use crate::ssh_worker;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

pub struct AppState {
    pub sessions: crate::core::SessionMap,
    ping_count: std::sync::atomic::AtomicU64,
}

impl AppState {
    pub fn record_ping(&self) -> u64 {
        self.ping_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    }

    pub fn new() -> Self {
        Self {
            sessions: crate::core::new_session_map(),
            ping_count: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub status: SessionStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeArgs {
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
}

fn entry_name(key: &str, kind: &str) -> String {
    format!("{key}/{kind}")
}

fn read_remembered(key: &str, kind: &str) -> Option<String> {
    keyring::Entry::new("dev.still.app", &entry_name(key, kind))
        .ok()
        .and_then(|e| e.get_password().ok())
}

fn key_of(host: &str, port: u16, username: &str) -> String {
    format!("still/ssh/{username}@{host}:{port}")
}

#[tauri::command]
pub async fn still_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SshConnectArgs,
) -> Result<ConnectResult, StillError> {
    // DIAG-ONLY: native command entry. `client_id` doubles as the local
    // session id for correlation (no secrets logged — ids + stages only).
    let diag_local = args
        .client_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_default();
    let t0 = std::time::Instant::now();
    diag::record("rust", "STILL_CONNECT_ENTERED", &diag_local, "", true, "", "", None);
    let res = still_connect_inner(app, state, args, diag_local.clone()).await;
    match &res {
        Ok(ok) => diag::ok_elapsed(
            "rust",
            "STILL_CONNECT_EXITED_OK",
            &diag_local,
            &ok.session_id,
            t0.elapsed().as_millis(),
        ),
        Err(e) => diag::record(
            "rust",
            "STILL_CONNECT_EXITED_ERR",
            &diag_local,
            "",
            false,
            &e.code,
            &e.message,
            Some(t0.elapsed().as_millis()),
        ),
    }
    res
}

async fn still_connect_inner(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SshConnectArgs,
    diag_local: String,
) -> Result<ConnectResult, StillError> {
    let cfg = args.validate()?;
    // M5: host-key verification happens inside the worker handshake, BEFORE
    // any credential is used. No secret is sent until the endpoint is trusted.
    let key = args.connection_key(&cfg);

    // Resolve secret: explicit per-call secret wins; else OS keyring.
    let (password, private_key): (Option<String>, Option<String>) =
        match args.auth_kind.as_str() {
            "password" => (
                args.secret
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| read_remembered(&key, "password")),
                None,
            ),
            "privateKey" => (
                None,
                args.secret
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| read_remembered(&key, "key")),
            ),
            _ => (None, None),
        };

    if args.auth_kind == "password"
        && password.as_deref().map(|s| s.is_empty()).unwrap_or(true)
    {
        return Err(StillError::friendly(
            "auth_missing",
            "No password available. Enter a password or tick Remember to reuse a saved one.",
        ));
    }
    if args.auth_kind == "privateKey"
        && private_key
            .as_deref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
    {
        return Err(StillError::friendly(
            "auth_missing",
            "No private key available. Paste an OpenSSH PEM key.",
        ));
    }

    if args.remember.unwrap_or(false) {
        match args.auth_kind.as_str() {
            "password" => {
                if let Some(pw) = password.clone() {
                    if let Ok(e) =
                        keyring::Entry::new("dev.still.app", &entry_name(&key, "password"))
                    {
                        let _ = e.set_password(&pw);
                    }
                }
            }
            "privateKey" => {
                if let Some(k) = private_key.clone() {
                    if let Ok(e) =
                        keyring::Entry::new("dev.still.app", &entry_name(&key, "key"))
                    {
                        let _ = e.set_password(&k);
                    }
                }
            }
            _ => {}
        }
    }

    let session_id = args
        .client_id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "{}-{}",
                cfg.tmux_session,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            )
        });

    // Reconnect path: drop any previous worker under the same id.
    // Signal its owned shutdown first (same legitimate origin as
    // still_disconnect), then abort as the backstop.
    {
        let mut map = state.sessions.lock().await;
        if let Some(old) = map.remove(&session_id) {
            let mut old = old.lock().await;
            if let Some(tx) = old.shutdown_tx.take() {
                let _ = tx.send(());
            }
            old.abort_handle.abort();
        }
    }

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<SessionEvent>();
    let (input_tx, input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    // Placeholder abort handle until the worker spawns.
    let worker_holder: Arc<tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
        Arc::new(tokio::sync::Mutex::new(None));

    let live = Arc::new(tokio::sync::Mutex::new(LiveSession {
        config: cfg.clone(),
        status: SessionStatus::Connecting,
        last_error: None,
        input_tx: input_tx.clone(),
        resize_tx: resize_tx.clone(),
        abort_handle: tauri::async_runtime::spawn(async {}),
        // Own the sender for the session lifetime: keeps shutdown pending.
        shutdown_tx: Some(shutdown_tx),
    }));
    // Replace placeholder with the real worker task.
    // DIAG-ONLY: log spawn + trace forwarded session events (type only).
    diag::ok("rust", "WORKER_SPAWNED", &diag_local, &session_id);
    {
        let mut live_guard = live.lock().await;
        live_guard.abort_handle.abort(); // kill no-op placeholder
        let ev = event_tx.clone();
        let live_clone = live.clone();
        let app_e = app.clone();
        let sid_e = session_id.clone();
        let diag_local_e = diag_local.clone();
        let handle = tauri::async_runtime::spawn(async move {
            // Forward worker events -> window events + mirror status.
            let forward = async move {
                while let Some(event) = event_rx.recv().await {
                    match &event {
                        SessionEvent::Status { status } => {
                            live_clone.lock().await.status = *status;
                            diag::record(
                                "rust",
                                "EVENT_EMITTED_STATUS",
                                &diag_local_e,
                                &sid_e,
                                true,
                                "",
                                &format!("{status:?}"),
                                None,
                            );
                        }
                        SessionEvent::Error { error } => {
                            live_clone.lock().await.last_error =
                                Some(error.clone());
                            diag::record(
                                "rust",
                                "EVENT_EMITTED_ERROR",
                                &diag_local_e,
                                &sid_e,
                                false,
                                &error.code,
                                &error.message,
                                None,
                            );
                        }
                        SessionEvent::Data { data } => {
                            diag::record(
                                "rust",
                                "EVENT_EMITTED_DATA",
                                &diag_local_e,
                                &sid_e,
                                true,
                                "",
                                &format!("{} bytes", data.len()),
                                None,
                            );
                        }
                        SessionEvent::HostKeyPrompt { .. } => {
                            diag::ok(
                                "rust",
                                "EVENT_EMITTED_HOSTKEY_PROMPT",
                                &diag_local_e,
                                &sid_e,
                            );
                        }
                    }
                    let topic = format!("still://session-event/{sid_e}");
                    let _ = app_e.emit(&topic, &event);
                }
                diag::ok("rust", "FORWARD_LOOP_ENDED", &diag_local_e, &sid_e);
            };
            let run = ssh_worker::run_session(
                cfg,
                password,
                private_key,
                ev,
                input_rx,
                resize_rx,
                shutdown_rx,
            );
            tokio::join!(forward, run);
        });
        live_guard.abort_handle = handle;
    }
    state.sessions.lock().await.insert(session_id.clone(), live);
    drop(worker_holder);

    Ok(ConnectResult {
        session_id,
        status: SessionStatus::Connecting,
    })
}

#[tauri::command]
pub async fn still_write(
    state: State<'_, AppState>,
    args: WriteArgs,
) -> Result<(), StillError> {
    let map = state.sessions.lock().await;
    let live = map.get(&args.session_id).ok_or_else(|| {
        StillError::friendly("no_session", "Unknown session. Connect first.")
    })?;
    let live = live.lock().await;
    live.input_tx.send(args.data).map_err(|_| {
        StillError::friendly("not_connected", "Session is not connected.")
    })?;
    Ok(())
}

#[tauri::command]
pub async fn still_resize(
    state: State<'_, AppState>,
    args: ResizeArgs,
) -> Result<(), StillError> {
    let map = state.sessions.lock().await;
    let live = map.get(&args.session_id).ok_or_else(|| {
        StillError::friendly("no_session", "Unknown session. Connect first.")
    })?;
    let live = live.lock().await;
    let cols = args.cols.clamp(20, 500);
    let rows = args.rows.clamp(5, 200);
    live.resize_tx.send((cols, rows)).map_err(|_| {
        StillError::friendly("not_connected", "Session is not connected.")
    })?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub status: SessionStatus,
    pub last_error: Option<StillError>,
}

#[tauri::command]
pub async fn still_status(
    state: State<'_, AppState>,
    args: IdArgs,
) -> Result<StatusResult, StillError> {
    // DIAG-ONLY: native command entry/exit + elapsed. No behavior change.
    let t0 = std::time::Instant::now();
    let sid = args.session_id.clone();
    diag::record("rust", "STILL_STATUS_ENTERED", "", &sid, true, "", "", None);
    let map = state.sessions.lock().await;
    let live = map.get(&args.session_id).ok_or_else(|| {
        diag::fail("rust", "STILL_STATUS_EXITED_ERR", "", &sid, "no_session", "Unknown session.");
        StillError::friendly("no_session", "Unknown session.")
    })?;
    let live = live.lock().await;
    let out = StatusResult {
        status: live.status,
        last_error: live.last_error.clone(),
    };
    diag::record(
        "rust",
        "STILL_STATUS_EXITED_OK",
        "",
        &sid,
        true,
        "",
        &format!("{:?}", out.status),
        Some(t0.elapsed().as_millis()),
    );
    Ok(out)
}

#[tauri::command]
pub async fn still_disconnect(
    state: State<'_, AppState>,
    args: IdArgs,
) -> Result<(), StillError> {
    // DIAG-ONLY: native command entry/exit. No behavior change.
    let t0 = std::time::Instant::now();
    let sid = args.session_id.clone();
    diag::record("rust", "STILL_DISCONNECT_ENTERED", "", &sid, true, "", "", None);
    let mut map = state.sessions.lock().await;
    if let Some(live) = map.remove(&args.session_id) {
        // Legitimate shutdown origin: signal the worker first so the pump
        // takes the clean shutdown branch (channel EOF + disconnect),
        // then abort as the backstop. Sender ownership is what keeps the
        // receiver pending for the whole session lifetime until here.
        let mut guard = live.lock().await;
        if let Some(tx) = guard.shutdown_tx.take() {
            let _ = tx.send(());
        }
        guard.abort_handle.abort();
        // tmux keeps running server-side: we only dropped OUR channel.
        diag::ok_elapsed("rust", "STILL_DISCONNECT_EXITED_OK", "", &sid, t0.elapsed().as_millis());
        Ok(())
    } else {
        diag::fail("rust", "STILL_DISCONNECT_EXITED_ERR", "", &sid, "no_session", "Unknown session.");
        Err(StillError::friendly("no_session", "Unknown session."))
    }
}

/// DIAG-ONLY: fire-and-forget frontend checkpoint sink.
/// Writes one JSONL record to the same append-only diagnostic log so the
/// packaged Windows WebView can report reached stages without a console.
/// Never fails (returns unit); args are ids/stages only — never secrets.
#[tauri::command]
pub async fn still_diag_record(args: DiagRecordArgs) -> () {
    diag::record(
        "webview",
        &args.stage,
        &args.local_id,
        &args.native_id,
        args.ok,
        &args.code,
        &args.message,
        args.elapsed_ms,
    );
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagRecordArgs {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub local_id: String,
    #[serde(default)]
    pub native_id: String,
    #[serde(default = "default_true")]
    pub ok: bool,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub elapsed_ms: Option<u128>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyArgs {
    pub key_id: String,
}

fn library_key_name(key_id: &str) -> String {
    format!("still/key-library/{key_id}/key")
}

/// Persist SSH key text for a library entry id (OS keyring only).
/// The renderer holds metadata (id, name) — never the secret text.
#[tauri::command]
pub async fn still_save_key(args: KeyArgs, secret: String) -> Result<(), StillError> {
    if args.key_id.trim().is_empty() {
        return Err(StillError::friendly("invalid", "key id required."));
    }
    if secret.trim().is_empty() {
        return Err(StillError::friendly("auth_missing", "Key text is empty."));
    }
    let entry = keyring::Entry::new("dev.still.app", &library_key_name(&args.key_id))
        .map_err(|e| StillError::friendly("keyring", format!("Secure storage unavailable: {e}")))?;
    entry
        .set_password(&secret)
        .map_err(|e| StillError::friendly("keyring", format!("Could not save key: {e}")))?;
    Ok(())
}

/// Whether key text exists in the OS keyring for a library entry id.
#[tauri::command]
pub async fn still_has_key(args: KeyArgs) -> Result<bool, StillError> {
    let entry = keyring::Entry::new("dev.still.app", &library_key_name(&args.key_id))
        .map_err(|e| StillError::friendly("keyring", format!("Secure storage unavailable: {e}")))?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(StillError::friendly("keyring", format!("Secure storage error: {e}"))),
    }
}

/// Remove key text for a library entry id from the OS keyring.
#[tauri::command]
pub async fn still_forget_key(args: KeyArgs) -> Result<(), StillError> {
    if let Ok(entry) =
        keyring::Entry::new("dev.still.app", &library_key_name(&args.key_id))
    {
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub async fn still_forget_secret(args: ForgetArgs) -> Result<(), StillError> {
    let key = key_of(&args.host, args.port, &args.username);
    for kind in ["password", "key"] {
        if let Ok(e) = keyring::Entry::new("dev.still.app", &entry_name(&key, kind)) {
            let _ = e.delete_credential();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn still_has_secret(args: ForgetArgs) -> Result<bool, StillError> {
    let key = key_of(&args.host, args.port, &args.username);
    Ok(read_remembered(&key, "password").is_some()
        || read_remembered(&key, "key").is_some())
}

// ---------------------------------------------------------------------------
// M5 host-key verification IPC (Rust is the authority).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostArgs {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub openssh_key: String,
    /// None => never trusted; Some(true) => matches; Some(false) => CHANGED.
    pub trusted: Option<bool>,
}

fn host_args_valid(args: &HostArgs) -> Result<(String, u16), StillError> {
    let host = args.host.trim().to_string();
    if host.is_empty() {
        return Err(StillError::invalid("host", "Host is required."));
    }
    if args.port == 0 {
        return Err(StillError::invalid("port", "Port must be 1-65535."));
    }
    Ok((host, args.port))
}

/// Fetch the live server host key WITHOUT authenticating + report trust state.
/// Never sends credentials, never stores trust, never logs key material.
#[tauri::command]
pub async fn still_probe_host(args: HostArgs) -> Result<HostKeyInfo, StillError> {
    let (host, port) = host_args_valid(&args)?;
    let (key_type, openssh, fingerprint) = crate::ssh_worker::probe_host_key(&host, port)
        .await
        .map_err(|e| StillError::friendly("unreachable", format!("Cannot reach the host ({e:#}).")))?;
    let trusted = match hostkeys::lookup_trusted(&host, port) {
        Ok(Some(stored)) => Some(stored.trim() == openssh.trim()),
        Ok(None) => None,
        Err(_) => None, // malformed store => treat as unknown, refuse later
    };
    Ok(HostKeyInfo { host, port, key_type, fingerprint, openssh_key: openssh, trusted })
}

/// Explicit trust: re-probe the LIVE key and store it ONLY if it still equals
/// `expected_openssh` (the exact string the user approved). Refuses on
/// changed-key endpoints unless `force_changed` — which the UI never sets;
/// changed keys must be forgotten explicitly, never silently overwritten.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustArgs {
    pub host: String,
    pub port: u16,
    pub expected_openssh: String,
}

#[tauri::command]
pub async fn still_trust_host(args: TrustArgs) -> Result<HostKeyInfo, StillError> {
    let host = args.host.trim().to_string();
    if host.is_empty() {
        return Err(StillError::invalid("host", "Host is required."));
    }
    if args.port == 0 {
        return Err(StillError::invalid("port", "Port must be 1-65535."));
    }
    if args.expected_openssh.trim().is_empty() {
        return Err(StillError::invalid("hostKey", "No host key to trust."));
    }
    let (key_type, live_openssh, fingerprint) =
        crate::ssh_worker::probe_host_key(&host, args.port)
            .await
            .map_err(|e| StillError::friendly("unreachable", format!("Cannot reach the host ({e:#}).")))?;
    if live_openssh.trim() != args.expected_openssh.trim() {
        return Err(StillError::friendly(
            "host_key_changed",
            "The server key changed since you reviewed it. Trust refused — verify out-of-band.",
        ));
    }
    // Changed-key endpoints: refuse to overwrite silently.
    match hostkeys::lookup_trusted(&host, args.port) {
        Ok(Some(stored)) if stored.trim() != live_openssh.trim() => {
            return Err(StillError::friendly(
                "host_key_changed",
                "A different key is already trusted for this host. Remove it explicitly before trusting a new one.",
            ))
        }
        Err(_) => {
            return Err(StillError::friendly(
                "host_key_changed",
                "Trust data is unreadable, refusing to overwrite. Clear Still's known_hosts file and retry.",
            ))
        }
        _ => {}
    }
    hostkeys::store_trusted(&host, args.port, live_openssh.trim()).map_err(|e| {
        StillError::friendly("keyring", format!("Could not persist host trust: {e:#}"))
    })?;
    Ok(HostKeyInfo {
        host, port: args.port, key_type, fingerprint,
        openssh_key: live_openssh, trusted: Some(true),
    })
}

/// Remove stored trust (surfaces as unknown-host on next connect).
#[tauri::command]
pub async fn still_forget_host(args: HostArgs) -> Result<(), StillError> {
    let (host, port) = host_args_valid(&args)?;
    let _ = hostkeys::forget_trusted(&host, port);
    Ok(())
}
