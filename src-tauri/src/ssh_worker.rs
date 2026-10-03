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
use crate::hostkeys;
use anyhow::{anyhow, Context};
use russh::client::{self};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelMsg, Disconnect};
use russh::keys::PublicKeyOrCertificate;
use std::sync::Arc;
use tokio::sync::mpsc;

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

async fn handshake_permit() -> tokio::sync::MutexGuard<'static, ()> {
    let g = HANDSHAKE_SERIAL.lock().await;
    // Pace handshakes: the system sshd throttles rapid unauthenticated KEX.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    g
}

/// Fetch the server's presented host-key identity WITHOUT authenticating.
/// Used by `still_probe_host` (unknown-host dialog content) and by
/// `still_trust_host` (TOCTOU re-check before persisting).
pub async fn probe_host_key(host: &str, port: u16) -> anyhow::Result<(String, String, String)> {
    probe_host_key_retry(host, port, 4).await
}

async fn probe_host_key_once(host: &str, port: u16) -> anyhow::Result<(String, String, String)> {
    let _permit = handshake_permit().await;
    let addr = format!("{host}:{port}");
    let tcp = tokio::net::TcpStream::connect(&addr)
        .await
        .with_context(|| format!("dial {addr}"))?;
    tcp.set_nodelay(true).ok();
    let config = Arc::new(client::Config::default());
    let captured: Arc<std::sync::Mutex<Option<(String, String, String)>>> =
        Arc::new(std::sync::Mutex::new(None));
    let client = CaptureClient { captured: captured.clone() };
    // Handshake is EXPECTED to fail (we return false); the capture is the product.
    let _ = client::connect(config, &addr, client).await;
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
            let _ = event_tx.send(SessionEvent::Status {
                status: SessionStatus::Closed,
            });
        }
        Err(e) => {
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
    let _permit = handshake_permit().await;
    let connect_result = client::connect(config, &addr, verifier).await;
    drop(_permit);
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
    let mut authed = false;
    if let Some(pem) = private_key_pem {
        let pem = pem.trim().to_string();
        if !pem.is_empty() {
            let key = russh::keys::decode_secret_key(&pem, password.as_deref())
                .map_err(|e| anyhow!("decode private key: {e}"))?;
            let alg = PrivateKeyWithHashAlg::new(
                Arc::new(key),
                handle.best_supported_rsa_hash().await?.flatten(),
            );
            let res = handle
                .authenticate_publickey(&cfg.username, alg)
                .await
                .with_context(|| "publickey auth")?;
            authed = res.success();
        }
    }
    if !authed
        && let Some(pw) = password
    {
        let res = handle
            .authenticate_password(&cfg.username, &pw)
            .await
            .with_context(|| "password auth")?;
        authed = res.success();
    }
    if !authed {
        return Err(anyhow!("authentication failed (auth fail)"));
    }

    let mut channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cfg.cols, cfg.rows, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;

    // Invisible tmux infrastructure: attach-or-create, same name => persistence.
    let plan = TmuxPlan::new(&cfg.tmux_session);
    channel.data_bytes(plan.attach_command(cfg.cols, cfg.rows)).await?;

    let _ = event_tx.send(SessionEvent::Status {
        status: SessionStatus::Live,
    });

    // ---- pump loop ----
    loop {
        tokio::select! {
            biased;
            _ = &mut *shutdown_rx => {
                // Clean disconnect: close channel, leave tmux alive server-side.
                let _ = channel.eof().await;
                let _ = channel.close().await;
                let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                return Ok(());
            }
            Some((c, r)) = resize_rx.recv() => {
                let _ = channel.window_change(c, r, 0, 0).await;
                let _ = channel.data_bytes(crate::core::TmuxPlan::refresh_command().as_bytes()).await;
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
                        let _ = event_tx.send(SessionEvent::Data { data: data.to_vec() });
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | None => {
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
