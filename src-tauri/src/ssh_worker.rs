//! russh SSH worker: one task per session id.
//!
//! M5: every connection verifies the server host key against the Rust-owned
//! trust store (`hostkeys.rs`). The handshake captures the presented key and
//! checks it BEFORE any credential is used:
//! - trusted (stored key matches): proceed to auth + tmux.
//! - never trusted: stop, emit `HostKeyPrompt { changed: false }` plus a typed
//!   `host_key_unknown` error. No auth attempted.
//! - stored key differs: stop, emit `HostKeyPrompt { changed: true }` plus a
//!   typed `host_key_changed` error. Never overwrite.
//!
//! Trust is granted only via `still_trust_host`, which re-probes the LIVE
//! server key and stores it only if it still matches what the user approved
//! (TOCTOU-safe). The renderer never verifies and never persists trust.
//!
//! Flow otherwise: TCP connect -> russh handshake -> password/publickey auth ->
//! open session channel -> request PTY (xterm-256color) -> request shell ->
//! write tmux attach command -> pump bytes both ways.
//!
//! Disconnect = drop channel/session (tmux keeps running server-side).
//! Reconnect = fresh TCP+channel, same tmux -A session name (re-verified).

use crate::core::{HostKeyPrompt, SessionEvent, SessionStatus, SshConfig, StillError, TmuxPlan};
use crate::diag;
use crate::hostkeys;
use anyhow::{anyhow, Context};
use russh::client::{self};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use russh::keys::PublicKeyOrCertificate;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Bounded connection phases.
//
// Every stage of connection establishment that can otherwise wait
// indefinitely on a stalled peer is wrapped in an explicit timeout, so a
// silent endpoint surfaces a typed transport failure instead of hanging the
// worker (and the UI's "connecting" state) forever. Timeout messages keep
// the words "timed out" and avoid auth vocabulary, so the existing
// `StillError::from_transport` taxonomy files them as `unreachable` without
// any taxonomy change.
// ---------------------------------------------------------------------------

/// TCP SYN/connect gets this long (well under OS defaults, so the app —
/// not the platform — reports the failure first).
const TCP_CONNECT_SECS: u64 = 10;
/// SSH KEX + host-key verification must complete within this long.
const HANDSHAKE_SECS: u64 = 20;
/// Per-attempt bounds for the credential-free host-key probe path.
const PROBE_TCP_SECS: u64 = 10;
const PROBE_HANDSHAKE_SECS: u64 = 15;
/// Authentication may involve slow PAM stacks; still strictly bounded.
const AUTH_SECS: u64 = 30;
/// Post-auth channel/PTY/shell establishment (normally milliseconds).
const CHANNEL_SECS: u64 = 15;
/// Spacing between handshake STARTS (sshd throttles rapid unauthenticated
/// KEX). Held only for this delay — never across network I/O.
const HANDSHAKE_PACING: Duration = Duration::from_millis(300);

/// Run `fut` with an explicit deadline. Inner errors keep their existing
/// context; only a true stall produces the timeout error.
async fn bounded<F, T, E>(secs: u64, what: &str, fut: F) -> anyhow::Result<T>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: Into<anyhow::Error>,
{
    match tokio::time::timeout(Duration::from_secs(secs), fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => {
            let err: anyhow::Error = e.into();
            Err(err.context(format!("{what} failed")))
        }
        Err(_) => Err(anyhow!("{what} timed out after {secs}s")),
    }
}

/// Decode the presented server key into (key_type, openssh_line, fingerprint).
/// `openssh_line` is the trust identity; the fingerprint is its SHA-256.
pub fn describe_key(key: &PublicKeyOrCertificate) -> anyhow::Result<(String, String, String)> {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => {
            let key_type = key.algorithm().to_string();
            let openssh = key.to_openssh()?.trim().to_string();
            let blob = openssh
                .split_whitespace()
                .nth(1)
                .ok_or_else(|| anyhow!("malformed OpenSSH host key"))?;
            let raw = base64_decode(blob)?;
            Ok((key_type, openssh, hostkeys::sha256_fingerprint(&raw)))
        }
        PublicKeyOrCertificate::Certificate(cert) => {
            let inner = cert.public_key();
            let key_type = format!("{}-cert", inner.algorithm());
            let openssh = cert.to_openssh()?.trim().to_string();
            Ok((key_type, openssh.clone(), hostkeys::sha256_fingerprint(openssh.as_bytes())))
        }
    }
}

fn base64_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.chars() {
        if c == '=' {
            break;
        }
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return Err(anyhow!("invalid base64 in host key")),
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    if out.is_empty() {
        return Err(anyhow!("empty host key blob"));
    }
    Ok(out)
}

/// ONE authoritative verification gate. Returns the presented key identity on
/// success; on unknown/changed returns the prompt (caller refuses + reports).
fn verify_against_store(
    host: &str,
    port: u16,
    presented: &PublicKeyOrCertificate,
) -> Result<(String, String, String), HostKeyPrompt> {
    let (key_type, openssh, fingerprint) = describe_key(presented)
        .map_err(|_| HostKeyPrompt {
            host: host.to_string(),
            port,
            key_type: "unknown".into(),
            fingerprint: "undecodable".into(),
            openssh_key: String::new(),
            changed: hostkeys::was_ever_trusted(host, port),
        })?;
    match hostkeys::lookup_trusted(host, port) {
        Ok(Some(stored)) if stored.trim() == openssh.trim() => {
            Ok((key_type, openssh, fingerprint))
        }
        Ok(Some(_)) => Err(HostKeyPrompt {
            host: host.to_string(),
            port,
            key_type,
            fingerprint,
            openssh_key: openssh,
            changed: true,
        }),
        Ok(None) => Err(HostKeyPrompt {
            host: host.to_string(),
            port,
            key_type,
            fingerprint,
            openssh_key: openssh,
            changed: false,
        }),
        Err(_) => Err(HostKeyPrompt {
            host: host.to_string(),
            port,
            key_type,
            fingerprint,
            openssh_key: openssh,
            // Malformed store: fail closed but don't claim MITM.
            changed: false,
        }),
    }
}

struct VerifyClient {
    host: String,
    port: u16,
    verified: Arc<std::sync::Mutex<Option<(String, String, String)>>>,
    prompt: Arc<std::sync::Mutex<Option<HostKeyPrompt>>>,
}

impl client::Handler for VerifyClient {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        match verify_against_store(&self.host, self.port, server_public_key) {
            Ok(id) => {
                *self.verified.lock().unwrap() = Some(id);
                Ok(true)
            }
            Err(prompt) => {
                *self.prompt.lock().unwrap() = Some(prompt);
                Ok(false)
            }
        }
    }
}

struct CaptureClient {
    captured: Arc<std::sync::Mutex<Option<(String, String, String)>>>,
}

impl client::Handler for CaptureClient {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Probe-only: capture the identity, then fail the handshake
        // deliberately so no auth bytes are ever sent.
        if let Ok(id) = describe_key(server_public_key) {
            *self.captured.lock().unwrap() = Some(id);
        }
        Ok(false)
    }
}

static HANDSHAKE_SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Pace the START of SSH handshakes: the system sshd throttles rapid
/// unauthenticated KEX, so beginnings stay serialized at least
/// `HANDSHAKE_PACING` apart. The mutex is held ONLY for this short delay —
/// never across network I/O — so a stalled peer can neither wedge later
/// attempts behind the mutex nor serialize bounded handshakes longer than
/// necessary. (Handshake starts remain ordered; each handshake itself is
/// bounded by the phase timeouts above.)
async fn pace_handshake() {
    let _guard = HANDSHAKE_SERIAL.lock().await;
    tokio::time::sleep(HANDSHAKE_PACING).await;
}

/// Fetch the server's presented host-key identity WITHOUT authenticating.
/// Used by `still_probe_host` (unknown-host dialog content) and by
/// `still_trust_host` (TOCTOU re-check before persisting).
pub async fn probe_host_key(host: &str, port: u16) -> anyhow::Result<(String, String, String)> {
    probe_host_key_retry(host, port, 4).await
}

async fn probe_host_key_once(host: &str, port: u16) -> anyhow::Result<(String, String, String)> {
    pace_handshake().await;
    let addr = format!("{host}:{port}");
    // Each phase bounded: a silent peer stalls neither this attempt nor
    // (via the pacing mutex, which is already released) any other attempt.
    let tcp = bounded(PROBE_TCP_SECS, &format!("TCP probe of {addr}"), tokio::net::TcpStream::connect(&addr)).await?;
    tcp.set_nodelay(true).ok();
    let config = Arc::new(client::Config::default());
    let captured: Arc<std::sync::Mutex<Option<(String, String, String)>>> =
        Arc::new(std::sync::Mutex::new(None));
    let client = CaptureClient { captured: captured.clone() };
    // Handshake is EXPECTED to fail (we return false); the capture is the product.
    // Bounded so a banner-stalled peer cannot hang the probe (or the trust flow).
    let _ = bounded(
        PROBE_HANDSHAKE_SECS,
        &format!("SSH probe of {addr}"),
        client::connect_stream(config, tcp, client),
    )
    .await;
    captured
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| anyhow!("could not capture host key from {addr}"))
}

async fn probe_host_key_retry(
    host: &str,
    port: u16,
    attempts: u32,
) -> anyhow::Result<(String, String, String)> {
    let mut last: anyhow::Error = anyhow!("no attempts");
    for i in 0..attempts {
        match probe_host_key_once(host, port).await {
            Ok(id) => return Ok(id),
            Err(e) => {
                last = e;
                // sshd throttles rapid unauthenticated handshakes; back off.
                tokio::time::sleep(std::time::Duration::from_millis(250 * (i as u64 + 1))).await;
            }
        }
    }
    Err(last)
}

pub async fn run_session(
    cfg: SshConfig,
    password: Option<String>,
    private_key_pem: Option<String>,
    event_tx: mpsc::UnboundedSender<SessionEvent>,
    mut input_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut resize_rx: mpsc::UnboundedReceiver<(u32, u32)>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    // DIAG-ONLY: worker lifecycle boundaries. No behavior change.
    // No secrets: host/port are connection identity, never credentials.
    let native_hint = format!("{}:{} tmux={}", cfg.host, cfg.port, cfg.tmux_session);
    diag::record("rust", "WORKER_ENTERED", "", &native_hint, true, "", "", None);
    let result = run_session_inner(
        &cfg,
        password,
        private_key_pem,
        &event_tx,
        &mut input_rx,
        &mut resize_rx,
        &mut shutdown_rx,
    )
    .await;
    match result {
        Ok(()) => {
            diag::record("rust", "WORKER_EXITED_OK", "", &native_hint, true, "", "", None);
            let _ = event_tx.send(SessionEvent::Status {
                status: SessionStatus::Closed,
            });
        }
        Err(e) => {
            let (code, msg) = diag::classify(&e);
            diag::record("rust", "WORKER_EXITED_ERR", "", &native_hint, false, &code, &msg, None);
            let _ = event_tx.send(SessionEvent::Error {
                error: StillError::from_transport(&e),
            });
            let _ = event_tx.send(SessionEvent::Status {
                status: SessionStatus::Error,
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session_inner(
    cfg: &SshConfig,
    password: Option<String>,
    private_key_pem: Option<String>,
    event_tx: &mpsc::UnboundedSender<SessionEvent>,
    input_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    resize_rx: &mut mpsc::UnboundedReceiver<(u32, u32)>,
    shutdown_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    let addr = format!("{}:{}", cfg.host, cfg.port);

    // ---- M5 host-key verification: BEFORE any auth bytes ----
    // russh dials the socket itself; the VerifyClient's check_server_key runs
    // during KEX, so no credential byte is ever written to an unverified host.
    let config = Arc::new(client::Config::default());
    let verified: Arc<std::sync::Mutex<Option<(String, String, String)>>> =
        Arc::new(std::sync::Mutex::new(None));
    let prompt_cell: Arc<std::sync::Mutex<Option<HostKeyPrompt>>> =
        Arc::new(std::sync::Mutex::new(None));
    let verifier = VerifyClient {
        host: cfg.host.clone(),
        port: cfg.port,
        verified: verified.clone(),
        prompt: prompt_cell.clone(),
    };
    // Pace handshake starts, then run every phase under an explicit
    // deadline: a silent peer surfaces a typed transport failure instead of
    // hanging the worker (and holds no mutex while doing so). Fast failures
    // keep their exact existing shape via the match arms below.
    pace_handshake().await;
    diag::record("rust", "TCP_CONNECT_START", "", &addr, true, "", "", None);
    let t_tcp = std::time::Instant::now();
    let connect_result = async {
        let tcp = bounded(
            TCP_CONNECT_SECS,
            &format!("TCP connect to {addr}"),
            tokio::net::TcpStream::connect(&addr),
        )
        .await?;
        diag::ok_elapsed("rust", "TCP_CONNECTED", "", &addr, t_tcp.elapsed().as_millis());
        diag::record("rust", "HANDSHAKE_START", "", &addr, true, "", "", None);
        let t_hs = std::time::Instant::now();
        let hs = bounded(
            HANDSHAKE_SECS,
            &format!("SSH handshake with {addr}"),
            client::connect_stream(config, tcp, verifier),
        )
        .await;
        match &hs {
            Ok(_) => diag::ok_elapsed("rust", "HANDSHAKE_COMPLETED", "", &addr, t_hs.elapsed().as_millis()),
            Err(e) => {
                let (code, msg) = diag::classify(e);
                diag::record("rust", "HANDSHAKE_FAILED", "", &addr, false, &code, &msg, Some(t_hs.elapsed().as_millis()));
            }
        }
        hs
    }
    .await;
    let prompt = prompt_cell.lock().unwrap().clone();
    let verified_id = verified.lock().unwrap().clone();
    match (connect_result, verified_id, prompt) {
        (Ok(handle), Some(_), None) => {
            run_authenticated(handle, cfg, password, private_key_pem, event_tx, input_rx, resize_rx, shutdown_rx).await
        }
        (_, _, Some(prompt)) => {
            // Refuse: surface the prompt (fingerprint UI) + typed error.
            // No credentials were sent — auth never ran.
            let _ = event_tx.send(SessionEvent::HostKeyPrompt {
                prompt: prompt.clone(),
            });
            if prompt.changed {
                Err(anyhow!(
                    "host_key_changed: {}:{} presents a different key ({} {})",
                    prompt.host,
                    prompt.port,
                    prompt.key_type,
                    prompt.fingerprint
                ))
            } else {
                Err(anyhow!(
                    "host_key_unknown: {}:{} presents an untrusted key ({} {})",
                    prompt.host,
                    prompt.port,
                    prompt.key_type,
                    prompt.fingerprint
                ))
            }
        }
        (Err(e), _, _) => {
            let s = format!("{e:#}").to_lowercase();
            if s.contains("unknown key") || s.contains("host key") {
                // russh-level rejection fallback (should already be a prompt).
                let live = probe_host_key(&cfg.host, cfg.port).await.unwrap_or((
                    "unknown".into(),
                    String::new(),
                    "undecodable".into(),
                ));
                let changed = hostkeys::was_ever_trusted(&cfg.host, cfg.port);
                let prompt = HostKeyPrompt {
                    host: cfg.host.clone(),
                    port: cfg.port,
                    key_type: live.0,
                    fingerprint: live.2,
                    openssh_key: live.1,
                    changed,
                };
                let _ = event_tx.send(SessionEvent::HostKeyPrompt { prompt: prompt.clone() });
                if changed {
                    Err(anyhow!("host_key_changed: {}:{}", cfg.host, cfg.port))
                } else {
                    Err(anyhow!("host_key_unknown: {}:{}", cfg.host, cfg.port))
                }
            } else {
                Err(e).with_context(|| format!("ssh handshake {}", cfg.host))
            }
        }
        _ => Err(anyhow!("host_key_unknown: {}:{} verification failed", cfg.host, cfg.port)),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_authenticated<H: client::Handler>(
    mut handle: russh::client::Handle<H>,
    cfg: &SshConfig,
    password: Option<String>,
    private_key_pem: Option<String>,
    event_tx: &mpsc::UnboundedSender<SessionEvent>,
    input_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    resize_rx: &mut mpsc::UnboundedReceiver<(u32, u32)>,
    shutdown_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    // ---- auth: private key first if provided, else password ----
    // Every network round-trip below is bounded: a peer that stalls
    // mid-auth surfaces a typed failure instead of hanging the worker.
    // Existing error contexts are preserved so failure classification is
    // unchanged; only true stalls produce the new timeout errors.
    // DIAG-ONLY: auth/channel/Live checkpoints (no secrets, no behavior change).
    let addr = format!("{}:{}", cfg.host, cfg.port);
    diag::record("rust", "AUTH_START", "", &addr, true, "", "", None);
    let t_auth = std::time::Instant::now();
    let mut authed = false;
    if let Some(pem) = private_key_pem {
        let pem = pem.trim().to_string();
        if !pem.is_empty() {
            let key = russh::keys::decode_secret_key(&pem, password.as_deref())
                .map_err(|e| anyhow!("decode private key: {e}"))?;
            let alg = PrivateKeyWithHashAlg::new(
                Arc::new(key),
                bounded(AUTH_SECS, "RSA hash negotiation", handle.best_supported_rsa_hash())
                    .await?
                    .flatten(),
            );
            let res = bounded(
                AUTH_SECS,
                "publickey auth",
                handle.authenticate_publickey(&cfg.username, alg),
            )
            .await
            .with_context(|| "publickey auth")?;
            authed = res.success();
        }
    }
    if !authed
        && let Some(pw) = password
    {
        let res = bounded(
            AUTH_SECS,
            "password auth",
            handle.authenticate_password(&cfg.username, &pw),
        )
        .await
        .with_context(|| "password auth")?;
        authed = res.success();
    }
    if !authed {
        diag::fail("rust", "AUTH_FAILED", "", &addr, "auth", "authentication failed");
        return Err(anyhow!("authentication failed (auth fail)"));
    }
    diag::ok_elapsed("rust", "AUTH_COMPLETED", "", &addr, t_auth.elapsed().as_millis());

    diag::record("rust", "CHANNEL_OPEN_START", "", &addr, true, "", "", None);
    let t_ch = std::time::Instant::now();
    let mut channel = bounded(CHANNEL_SECS, "SSH channel open", handle.channel_open_session()).await?;
    diag::ok_elapsed("rust", "CHANNEL_OPENED", "", &addr, t_ch.elapsed().as_millis());
    let t_pty = std::time::Instant::now();
    bounded(
        CHANNEL_SECS,
        "PTY request",
        channel.request_pty(false, "xterm-256color", cfg.cols, cfg.rows, 0, 0, &[]),
    )
    .await?;
    diag::ok_elapsed("rust", "PTY_ACCEPTED", "", &addr, t_pty.elapsed().as_millis());
    let t_sh = std::time::Instant::now();
    bounded(CHANNEL_SECS, "shell request", channel.request_shell(false)).await?;
    diag::ok_elapsed("rust", "SHELL_ACCEPTED", "", &addr, t_sh.elapsed().as_millis());

    // Invisible tmux infrastructure: attach-or-create, same name => persistence.
    // DIAG-ONLY: safe command identity (no secrets — name/geometry only).
    let mut plan = TmuxPlan::new(&cfg.tmux_session);
    plan.working_directory = cfg.working_directory.clone();
    let attach_cmd = plan.attach_command(cfg.cols, cfg.rows);
    diag::record(
        "rust",
        "TMUX_STARTED",
        "",
        &addr,
        true,
        "",
        &format!(
            "name={} cols={} rows={} len={} attach_or_create=true",
            plan.session_name,
            cfg.cols,
            cfg.rows,
            attach_cmd.len(),
        ),
        None,
    );
    channel.data_bytes(attach_cmd).await?;

    let _ = event_tx.send(SessionEvent::Status {
        status: SessionStatus::Live,
    });
    // DIAG-ONLY: first Live emission marker (no behavior change).
    diag::ok("rust", "LIVE_EMITTED", "", &addr);

    // ---- pump loop ----
    // `biased` is kept: shutdown must win once REALLY signaled (disconnect),
    // but the receiver now stays pending for the whole session lifetime
    // because LiveSession owns the sender until still_disconnect.
    let mut stderr_bytes: u64 = 0;
    let mut stderr_chunks: u64 = 0;
    loop {
        tokio::select! {
            biased;
            _ = &mut *shutdown_rx => {
                // Clean disconnect: close channel, leave tmux alive server-side.
                diag::record("rust", "CHANNEL_CLOSED", "", &addr, true, "", "reason=shutdown", None);
                let _ = channel.eof().await;
                let _ = channel.close().await;
                let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                return Ok(());
            }
            Some((c, r)) = resize_rx.recv() => {
                // window_change alone informs tmux of the new size; the old
                // code also typed a `tmux refresh-client` shell command on
                // EVERY resize, which echoed into the shell, wrapped lines
                // and trashed full-screen TUIs. Only re-assert `status off`
                // (cheap, idempotent tmux command, not shell input) and skip
                // it when nothing actually changed.
                let _ = channel.window_change(c, r, 0, 0).await;
            }
            Some(bytes) = input_rx.recv() => {
                let _ = channel.data_bytes(bytes).await;
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = event_tx.send(SessionEvent::Data { data: data.to_vec() });
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // DIAG-ONLY counts (no contents — may carry shell errors
                        // adjacent to closure; content capture is a separate
                        // narrowly-scoped decision).
                        stderr_chunks += 1;
                        stderr_bytes += data.len() as u64;
                        diag::record(
                            "rust",
                            "STDERR_CHUNK",
                            "",
                            &addr,
                            true,
                            "",
                            &format!("chunks={stderr_chunks} bytes={stderr_bytes}"),
                            None,
                        );
                        let _ = event_tx.send(SessionEvent::Data { data: data.to_vec() });
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        diag::record(
                            "rust",
                            "CHANNEL_CLOSED",
                            "",
                            &addr,
                            true,
                            "",
                            &format!("reason=exit_status code={exit_status} stderr_chunks={stderr_chunks} stderr_bytes={stderr_bytes}"),
                            None,
                        );
                        return Ok(());
                    }
                    None => {
                        diag::record(
                            "rust",
                            "CHANNEL_CLOSED",
                            "",
                            &addr,
                            true,
                            "",
                            &format!("reason=eof stderr_chunks={stderr_chunks} stderr_bytes={stderr_bytes}"),
                            None,
                        );
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::PublicKey;

    const ED25519_PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRkLQV806ziDD+iqLZTkOICWW7GmUFe7AsspYQaYgNJ";

    fn key_from(s: &str) -> PublicKeyOrCertificate {
        PublicKeyOrCertificate::PublicKey {
            key: PublicKey::from_openssh(s).expect("parse test key"),
            hash_alg: None,
        }
    }

    #[test]
    fn describe_key_fingerprint_matches_ssh_keygen() {
        // Cross-checked against: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
        let (kt, openssh, fp) = describe_key(&key_from(ED25519_PUB)).unwrap();
        assert_eq!(kt, "ssh-ed25519");
        assert_eq!(openssh, ED25519_PUB);
        assert_eq!(
            fp,
            "SHA256:WhtE49oN6vdnXy0pvOKD+s+ep9UTO3280LQmWk5NcJk"
        );
    }

    #[tokio::test]
    async fn bounded_passes_fast_values_through() {
        let v = bounded(5, "noop", async { Ok::<_, std::io::Error>(42u32) }).await.unwrap();
        assert_eq!(v, 42);
    }

    #[tokio::test]
    async fn bounded_keeps_inner_error_context() {
        // Inner failures keep their message (plus phase context) — no
        // reclassification into timeouts.
        let e = bounded(5, "dial x", async {
            Err::<u32, _>(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused"))
        })
        .await
        .expect_err("refused must propagate");
        let s = format!("{e:#}");
        assert!(s.contains("refused"), "unexpected: {s}");
        assert!(s.contains("dial x failed"), "unexpected: {s}");
        assert!(!s.contains("timed out"), "must not look like a timeout: {s}");
    }

    #[tokio::test]
    async fn bounded_stall_returns_typed_timeout() {
        // A never-resolving phase surfaces a timeout error quickly (1s test
        // bound, not the production constant) instead of hanging forever.
        let e = bounded(1, "SSH handshake with stall", async {
            std::future::pending::<Result<u32, std::io::Error>>().await
        })
        .await
        .expect_err("stall must time out");
        let s = format!("{e:#}");
        assert!(s.contains("timed out after 1s"), "unexpected: {s}");
        // And the existing taxonomy files it as `unreachable` with no new
        // error kinds introduced.
        let typed = StillError::from_transport(&e);
        assert_eq!(typed.code, "unreachable", "unexpected: {typed:?}");
    }

    fn iso(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "still-wk-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("STILL_KNOWN_HOSTS", dir.join("known_hosts.json")) };
        dir
    }

    /// Serializes the process-global STILL_KNOWN_HOSTS across these tests.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        crate::hostkeys::test_serial()
    }

    #[test]
    fn verify_unknown_host_is_refused_not_verified() {
        let _g = serial();
        let dir = iso("unknown");
        let err = verify_against_store("unknown.test", 22, &key_from(ED25519_PUB))
            .expect_err("unknown host must not verify");
        assert!(!err.changed);
        assert!(err.fingerprint.starts_with("SHA256:"));
        assert!(!hostkeys::was_ever_trusted("unknown.test", 22));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_trusted_host_passes() {
        let _g = serial();
        let dir = iso("trusted");
        hostkeys::store_trusted("t.test", 2222, ED25519_PUB).unwrap();
        let ok = verify_against_store("T.TEST", 2222, &key_from(ED25519_PUB))
            .expect("trusted host must verify");
        assert_eq!(ok.1, ED25519_PUB);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_changed_key_refused_and_store_untouched() {
        let _g = serial();
        let dir = iso("changed");
        hostkeys::store_trusted("c.test", 22, "ssh-ed25519 AAAAfakefakefakefake").unwrap();
        let err = verify_against_store("c.test", 22, &key_from(ED25519_PUB))
            .expect_err("changed key must refuse");
        assert!(err.changed);
        assert_eq!(
            hostkeys::lookup_trusted("c.test", 22).unwrap().unwrap(),
            "ssh-ed25519 AAAAfakefakefakefake"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_malformed_store_fails_closed() {
        let _g = serial();
        let dir = iso("malformed");
        std::fs::write(hostkeys::store_path(), b"}{ broken").unwrap();
        let err = verify_against_store("m.test", 22, &key_from(ED25519_PUB))
            .expect_err("malformed store must refuse");
        assert!(!err.changed, "do not claim MITM on a corrupt store");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trust_is_scoped_per_port() {
        let _g = serial();
        let dir = iso("port");
        hostkeys::store_trusted("p.test", 2222, ED25519_PUB).unwrap();
        assert!(hostkeys::is_trusted("p.test", 2222, ED25519_PUB));
        assert!(!hostkeys::is_trusted("p.test", 22, ED25519_PUB));
        assert!(verify_against_store("p.test", 22, &key_from(ED25519_PUB)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
