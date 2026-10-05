//! Still native service core.
//!
//! Port of the Flutter backend semantics:
//! - `TmuxPlan`  <- lib/src/tmux/tmux.dart (attach/create/quoting/sanitization)
//! - validation   <- lib/src/session/session_validation.dart
//! - error mapping<- lib/src/session/connection_errors.dart
//! - SshConfig    <- lib/src/config/ssh_config.dart
//! - session state<- RemoteSessionController status model (idle/connecting/live/closed/error)
//!
//! Invariants preserved:
//! - tmux is invisible infrastructure (attach-or-create, same session name reconnects)
//! - remote session survives local disconnect (we close the channel, never kill tmux)
//! - renderer never sees raw secrets (password/key passed per-call, never persisted in JS)
//! - no cloud sync / no backend server / no fake connected state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
#[allow(unused_imports)]
use tauri as _tauri_reexport_guard;


// ---------------------------------------------------------------------------
// SshConfig (mirrors lib/src/config/ssh_config.dart)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectArgs {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "privateKey" | "agent" (agent unsupported in POC -> friendly error)
    pub auth_kind: String,
    /// Raw secret for THIS call only. Never stored, never returned.
    pub secret: Option<String>,
    /// Remember secret in OS secure storage (keyring) for this connection id.
    pub remember: Option<bool>,
    pub tmux_session: Option<String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub tmux_session: String,
    pub cols: u32,
    pub rows: u32,
}

impl SshConnectArgs {
    /// Mirrors session_validation.dart: host/user non-empty, port range, tmux name safe.
    pub fn validate(&self) -> Result<SshConfig, StillError> {
        let host = self.host.trim();
        if host.is_empty() {
            return Err(StillError::invalid("host", "Host is required."));
        }
        if self.port == 0 {
            return Err(StillError::invalid("port", "Port must be 1-65535."));
        }
        let username = self.username.trim();
        if username.is_empty() {
            return Err(StillError::invalid(
                "username",
                "Username is required.",
            ));
        }
        match self.auth_kind.as_str() {
            "password" => {
                let empty = self
                    .secret
                    .as_deref()
                    .map(|s| s.is_empty())
                    .unwrap_or(true);
                let remembered = self.remember.unwrap_or(false);
                if empty && !remembered {
                    // Caller may rely on stored secret; the service layer
                    // resolves it. Only reject obviously-empty explicit attempts.
                }
            }
            "privateKey" => {}
            "agent" => {
                return Err(StillError::friendly(
                    "auth_unsupported",
                    "SSH-agent auth is not supported in this POC. Use password or a pasted private key.",
                ));
            }
            other => {
                return Err(StillError::invalid(
                    "authKind",
                    format!("Unknown auth kind: {other}"),
                ));
            }
        }
        Ok(SshConfig {
            host: host.to_string(),
            port: self.port,
            username: username.to_string(),
            tmux_session: TmuxPlan::sanitize_name(self.tmux_session.as_deref()),
            cols: self.cols.unwrap_or(80).clamp(20, 500),
            rows: self.rows.unwrap_or(24).clamp(5, 200),
        })
    }

    /// Key under which a remembered secret is stored in the OS keyring.
    /// Mirrors connectionKey() in lib/src/storage/credential_store.dart.
    pub fn connection_key(&self, cfg: &SshConfig) -> String {
        format!("still/ssh/{}@{}:{}", cfg.username, cfg.host, cfg.port)
    }
}

// ---------------------------------------------------------------------------
// TmuxPlan (mirrors lib/src/tmux/tmux.dart exactly)
// ---------------------------------------------------------------------------

pub struct TmuxPlan {
    pub session_name: String,
}

impl TmuxPlan {
    pub fn new(name: &str) -> Self {
        Self {
            session_name: Self::sanitize_name(Some(name)),
        }
    }

    pub fn sanitize_name(raw: Option<&str>) -> String {
        Self::sanitize_name_str(raw.unwrap_or("still"))
    }

    fn sanitize_name_str(raw: &str) -> String {
        let mut out = String::new();
        for c in raw.chars() {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                out.push(c);
            } else {
                out.push('_');
            }
        }
        if out.is_empty() {
            "still".to_string()
        } else {
            out
        }
    }

    /// `tmux -u new-session -A -s <name> -x <cols> -y <rows>\n`
    /// (-A = attach if exists else create: the persistence primitive.)
    pub fn attach_command(&self, cols: u32, rows: u32) -> String {
        format!(
            "tmux -u new-session -A -s {} -x {} -y {}\n",
            self.session_name, cols, rows
        )
    }

    pub fn refresh_command() -> &'static str {
        "tmux refresh-client -S 2>/dev/null || tmux refresh-client 2>/dev/null || true\n"
    }
}

// ---------------------------------------------------------------------------
// Error taxonomy (mirrors lib/src/session/connection_errors.dart)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StillError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl StillError {
    pub fn invalid(field: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            code: "invalid".into(),
            message: msg.into(),
            field: Some(field.into()),
        }
    }
    pub fn friendly(code: impl Into<String>, msg: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: msg.into(),
            field: None,
        }
    }
    /// Map anyhow/russh/IO failures to the friendly taxonomy.
    ///
    /// A `prefix` already carrying a typed host-key message (`host_key_*:`)
    /// is mapped to its stable code without leaking key material.
    pub fn from_transport(e: &anyhow::Error) -> Self {
        let s = format!("{e:#}");
        let lower = s.to_lowercase();
        if lower.contains("auth fail") || lower.contains("authentication") {
            return Self::friendly(
                "auth_failed",
                "Authentication failed. Check the username and password/key.",
            );
        }
        if lower.contains("timed out")
            || lower.contains("timeout")
            || lower.contains("connection refused")
            || lower.contains("no route")
            || lower.contains("network is unreachable")
        {
            return Self::friendly(
                "unreachable",
                format!("Cannot reach the host ({s}). Check the hostname, port, and network."),
            );
        }
        if lower.starts_with("host_key_unknown:") {
            return Self::friendly(
                "host_key_unknown",
                "Unknown SSH host key. Review the server fingerprint, then Trust or Reject it. No credentials were sent.",
            );
        }
        if lower.starts_with("host_key_changed:") {
            return Self::friendly(
                "host_key_changed",
                "WARNING: the server host key changed. The connection was refused — do not trust it without verifying out-of-band.",
            );
        }
        if lower.contains("host key") || lower.contains("unknown key") {
            return Self::friendly(
                "host_key_changed",
                "The server host key failed verification. The connection was refused.",
            );
        }
        Self::friendly("transport", format!("Connection failed: {s}"))
    }
}

impl std::fmt::Display for StillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for StillError {}

// ---------------------------------------------------------------------------
// Session state (mirrors RemoteSessionStatus)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Connecting,
    Live,
    Closed,
    Error,
}

pub struct LiveSession {
    pub config: SshConfig,
    pub status: SessionStatus,
    pub last_error: Option<StillError>,
    /// Handle to pump input bytes into the SSH channel.
    pub input_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Handle to request resize.
    pub resize_tx: mpsc::UnboundedSender<(u32, u32)>,
    /// Worker task handle: aborting it drops TCP+channel (tmux survives).
    pub abort_handle: tauri::async_runtime::JoinHandle<()>,
    /// Owned shutdown signal: kept alive for the session lifetime so the
    /// worker's shutdown receiver stays PENDING until explicit disconnect.
    /// (Previously the sender was dropped at spawn, pre-resolving shutdown
    /// and letting the biased pump select kill healthy sessions instantly.)
    pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Data { data: Vec<u8> },
    Status { status: SessionStatus },
    Error { error: StillError },
    /// M5: server presented an untrusted host key. The worker stops BEFORE
    /// auth — no credentials cross the wire. The renderer shows the
    /// fingerprint + Trust/Reject; Rust stays authoritative (it re-verifies
    /// against the live key on the trust retry path).
    HostKeyPrompt { prompt: HostKeyPrompt },
}

/// M5: information the renderer needs for an explicit trust decision.
/// Never contains secrets — only the server's public host-key identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    /// "ssh-ed25519" / "ssh-rsa" / ...
    pub key_type: String,
    /// OpenSSH `SHA256:...` fingerprint of the raw key blob.
    pub fingerprint: String,
    /// Full OpenSSH public-key line (`"<type> <base64>"`), shown verbatim
    /// so the user can compare against out-of-band material. Never logged.
    pub openssh_key: String,
    /// True when the store holds a DIFFERENT key (possible MITM) vs false
    /// for a never-seen host.
    pub changed: bool,
}

pub type SessionMap = Arc<Mutex<HashMap<String, Arc<Mutex<LiveSession>>>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {   use super::*;

    #[test]
    fn attach_command_matches_flutter() {
        let p = TmuxPlan::new("still");
        assert_eq!(
            p.attach_command(80, 24),
            "tmux -u new-session -A -s still -x 80 -y 24\n"
        );
    }

    #[test]
    fn sanitize_matches_flutter() {
        assert_eq!(TmuxPlan::sanitize_name(Some("still; rm -rf /")), "still__rm_-rf__");
        assert_eq!(TmuxPlan::sanitize_name(Some("")), "still");
        assert_eq!(TmuxPlan::sanitize_name(Some("dev-1.2_ok")), "dev-1.2_ok");
    }

    #[test]
    fn reconnect_reuses_same_attach_command() {
        let p = TmuxPlan::new("still");
        assert_eq!(p.attach_command(100, 30), p.attach_command(100, 30));
        assert!(
            TmuxPlan::new("claude-xxy-4").attach_command(100, 30).contains("-A"),
            "attach-or-create (-A) is the persistence primitive"
        );
    }

    #[test]
    fn connection_key_matches_flutter() {
        // mirrors connectionKey() in credential_store.dart: still/ssh/user@host:port
        let a = SshConnectArgs {
            host: "example.com".into(),
            port: 2222,
            username: "deploy".into(),
            auth_kind: "password".into(),
            secret: None,
            remember: None,
            tmux_session: None,
            cols: None,
            rows: None,
            client_id: None,
        };
        let cfg = a.validate().unwrap();
        assert_eq!(a.connection_key(&cfg), "still/ssh/deploy@example.com:2222");
        // secrets are per-call only: validate() never echoes them back
        assert!(!format!("{cfg:?}").contains("secret"));
    }

    #[test]
    fn validation_rejects_empty_host() {
        let a = SshConnectArgs {
            host: "".into(),
            port: 22,
            username: "u".into(),
            auth_kind: "password".into(),
            secret: None,
            remember: None,
            tmux_session: None,
            cols: None,
            rows: None,
            client_id: None,
        };
        assert!(a.validate().is_err());
    }
}
