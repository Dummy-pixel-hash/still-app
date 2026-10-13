//! Still orb — Smart layer (BYO local-AI classifier, optional, default OFF).
//!
//! Design (see plan §16): NO vendored model, NO sidecar, NO new Rust deps.
//! The user runs their own `llama-server` (or any `POST /v1/systemone`
//! endpoint) on loopback; Still classifies stripped pane text through it and
//! uses the verdict only when confident. Everything fails open to the
//! scrape — Julia can be wrong, slow, or offline with zero visible breakage.
//!
//! Layer order in `agent_tick`: fresh hook stamp → Julia (this file) → scrape.
//!
//! Privacy (hard rules, asserted in tests-orb):
//! - endpoints restricted to loopback (`127.0.0.1`, `::1`, `localhost`
//!   resolving to loopback). Anything else → typed refusal, no dial.
//! - pane text travels to a localhost socket only; diag records
//!   `model/confidence/agree` — never pane bytes.
//! - 3s classify timeout; malformed responses → `None` → scrape.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

/// Default cutoff: accept Julia's verdict at ≥55% confidence.
pub const DEFAULT_CUTOFF: f64 = 0.55;
/// Default endpoint: a user-run `llama-server --port 8080`.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8080";
/// Classify timeout: the tick must never stall on a slow model.
pub const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(3);
/// Pane budget sent to the model (chars, rough ~4 chars/token guard).
pub const STATE_BUDGET_CHARS: usize = 4096;

/// User-facing smart-orb settings (managed Tauri state, renderer-editable).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub cutoff: f64,
}

impl Default for SmartConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: DEFAULT_ENDPOINT.to_string(),
            cutoff: DEFAULT_CUTOFF,
        }
    }
}

pub struct SmartState {
    inner: Mutex<SmartConfig>,
}

impl SmartState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SmartConfig::default()),
        }
    }
    pub fn get(&self) -> SmartConfig {
        self.inner.lock().unwrap().clone()
    }
    pub fn set(&self, cfg: SmartConfig) {
        *self.inner.lock().unwrap() = cfg;
    }
}

/// Criterion wording per label — the accuracy lever (HF blog: descriptions
/// matter more than model size). Tune against fixtures, not by guessing.
pub fn criterion(label: &str) -> &'static str {
    match label {
        "working" => "actively generating output or running tools; progress or spinner visible, interrupt hint present",
        "needs_input" => "blocked waiting on the user: approval or permission prompt, question, or explicit action-required banner",
        "idle" => "sitting at an input prompt with no activity and no pending work",
        "done" => "just finished a task and is awaiting the next instruction",
        "error" => "a failure banner is visible: error, failure, rate limit, or auth failure",
        _ => "none of the other options apply",
    }
}

/// Build the `/v1/systemone` request body for one pane capture.
pub fn classify_body(pane_text: &str) -> serde_json::Value {
    let state: String = pane_text.chars().take(STATE_BUDGET_CHARS).collect();
    serde_json::json!({
        "state": state,
        "questions": {
            "status": {
                "type": "choice",
                "instructions": "What is the agent doing?",
                "criteria": {
                    "working": criterion("working"),
                    "needs_input": criterion("needs_input"),
                    "idle": criterion("idle"),
                    "done": criterion("done"),
                    "error": criterion("error"),
                }
            }
        }
    })
}

/// Map a model choice word onto the shared vocabulary (accepts both
/// `needs_input` and `needs-input` spellings).
pub fn map_choice(choice: &str) -> Option<crate::agent_state::AgentState> {
    use crate::agent_state::AgentState as S;
    match choice.trim().to_lowercase().as_str() {
        "working" => Some(S::Working),
        "needs_input" | "needs-input" | "needsinput" | "blocked" => {
            Some(S::NeedsInput)
        }
        "idle" => Some(S::Idle),
        "done" | "finished" => Some(S::Done),
        "error" => Some(S::Error),
        _ => None,
    }
}

/// Defensive parse of a `/v1/systemone` response. Returns
/// `(AgentState, confidence)` or `None` on any shape mismatch.
pub fn parse_response(body: &str) -> Option<(crate::agent_state::AgentState, f64)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let status = v.get("status")?;
    let choice = status.get("choice")?.as_str()?;
    let state = map_choice(choice)?;
    let confidence = status
        .get("confidence")
        .and_then(|c| c.as_f64())
        .or_else(|| {
            status
                .get("probabilities")
                .and_then(|p| p.get(choice))
                .and_then(|p| p.as_f64())
        })
        .unwrap_or(0.0);
    if !(0.0..=1.0).contains(&confidence) {
        return None;
    }
    Some((state, confidence))
}

/// Loopback guard: only `127.0.0.0/8`, `::1`, or `localhost` (which must
/// resolve to loopback). Returns `(host, port)` on success.
pub fn loopback_addr(endpoint: &str) -> Result<(String, u16), String> {
    let rest = endpoint
        .strip_prefix("http://")
        .ok_or_else(|| "endpoint must be http://host:port".to_string())?;
    let rest = rest.trim_end_matches('/');
    let (host, port) = rest.rsplit_once(':').ok_or_else(|| {
        "endpoint must be http://host:port (e.g. http://127.0.0.1:8080)".to_string()
    })?;
    let port: u16 = port
        .parse()
        .map_err(|_| "endpoint port must be 1-65535".to_string())?;
    if port == 0 {
        return Err("endpoint port must be 1-65535".to_string());
    }
    let host_lc = host.trim().to_lowercase();
    // Strip brackets for IPv6 literals.
    let bare = host_lc
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host_lc);
    let is_loop = bare == "::1"
        || bare.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
        || bare.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.is_loopback())
        || bare == "localhost";
    if !is_loop {
        return Err("endpoint must be loopback (127.0.0.1, ::1, or localhost)".to_string());
    }
    // `localhost` must actually resolve to loopback — no DNS tricks.
    if bare == "localhost" {
        let resolves_loop = std::net::ToSocketAddrs::to_socket_addrs(
            &format!("localhost:{port}")[..],
        )
        .map(|mut it| it.any(|a| a.ip().is_loopback()))
        .unwrap_or(false);
        if !resolves_loop {
            return Err("localhost does not resolve to loopback on this machine".to_string());
        }
    }
    Ok((bare.to_string(), port))
}

/// Minimal HTTP/1.1 POST over raw tokio TCP (no new deps): fixed small
/// bodies, Content-Length framing, read-until-close-or-cap, 3s budget.
/// Localhost only — the caller enforces `loopback_addr` first.
async fn http_post(host: &str, port: u16, path: &str, body: &str) -> anyhow::Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let stream = tokio::time::timeout(
        CLASSIFY_TIMEOUT,
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("smart endpoint unreachable (connect timeout)"))?
    .map_err(|e| anyhow::anyhow!("smart endpoint unreachable: {e:#}"))?;
    let mut stream = stream;
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tokio::time::timeout(CLASSIFY_TIMEOUT, stream.write_all(req.as_bytes()))
        .await
        .map_err(|_| anyhow::anyhow!("smart request timed out"))?
        .map_err(|e| anyhow::anyhow!("smart request failed: {e:#}"))?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + CLASSIFY_TIMEOUT;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, stream.read(&mut buf)).await {
            Err(_) => break,
            Ok(Err(_)) => break,
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > 256 * 1024 {
                    break;
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    // Split headers/body on the first blank line; tolerate missing headers.
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or(&text);
    let body = body.split_once("\n\n").map(|(_, b)| b).unwrap_or(body);
    Ok(body.to_string())
}

/// Classify one stripped pane through the user's endpoint.
/// Returns `(state, confidence)` or `None` (disabled / refused / timeout /
/// malformed) — the caller falls back to the scrape on `None`.
pub async fn classify(
    endpoint: &str,
    cutoff: f64,
    pane_text: &str,
) -> Option<(crate::agent_state::AgentState, f64)> {
    let (host, port) = loopback_addr(endpoint).ok()?;
    let body = classify_body(pane_text).to_string();
    let resp = http_post(&host, port, "/v1/systemone", &body).await.ok()?;
    let (state, confidence) = parse_response(&resp)?;
    if confidence < cutoff.clamp(0.0, 1.0) {
        return None;
    }
    Some((state, confidence))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_allows_local_forms() {
        assert!(loopback_addr("http://127.0.0.1:8080").is_ok());
        assert!(loopback_addr("http://127.0.0.2:1").is_ok());
        assert!(loopback_addr("http://[::1]:8080").is_ok());
    }

    #[test]
    fn loopback_refuses_everything_else() {
        assert!(loopback_addr("https://127.0.0.1:8080").is_err());
        assert!(loopback_addr("http://192.168.1.5:8080").is_err());
        assert!(loopback_addr("http://10.0.0.1:8080").is_err());
        assert!(loopback_addr("http://example.com:8080").is_err());
        assert!(loopback_addr("http://127.0.0.1").is_err());
        assert!(loopback_addr("http://127.0.0.1:0").is_err());
        assert!(loopback_addr("http://[::ffff:127.0.0.1]:8080").is_err());
    }

    #[test]
    fn body_carries_criteria_and_budget() {
        let v = classify_body(&"x".repeat(9000));
        assert_eq!(v["questions"]["status"]["type"], "choice");
        let state = v["state"].as_str().unwrap();
        assert!(state.len() <= STATE_BUDGET_CHARS);
        for label in ["working", "needs_input", "idle", "done", "error"] {
            assert!(
                v["questions"]["status"]["criteria"].get(label).is_some(),
                "missing criterion {label}"
            );
        }
    }

    #[test]
    fn parse_accepts_choice_plus_confidence() {
        let (s, c) = parse_response(
            r#"{"status":{"choice":"needs_input","confidence":0.91}}"#,
        )
        .unwrap();
        assert_eq!(s, crate::agent_state::AgentState::NeedsInput);
        assert!((c - 0.91).abs() < 1e-9);
    }

    #[test]
    fn parse_falls_back_to_probabilities_map() {
        let (s, c) = parse_response(
            r#"{"status":{"choice":"working","probabilities":{"working":0.7,"idle":0.3}}}"#,
        )
        .unwrap();
        assert_eq!(s, crate::agent_state::AgentState::Working);
        assert!((c - 0.7).abs() < 1e-9);
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_response("").is_none());
        assert!(parse_response("{}").is_none());
        assert!(parse_response(r#"{"status":{"choice":"napping"}}"#).is_none());
        assert!(parse_response(r#"{"status":{"choice":"working","confidence":9}}"#).is_none());
    }

    #[test]
    fn map_choice_accepts_both_spellings() {
        use crate::agent_state::AgentState as S;
        assert_eq!(map_choice("needs_input"), Some(S::NeedsInput));
        assert_eq!(map_choice("needs-input"), Some(S::NeedsInput));
        assert_eq!(map_choice("finished"), Some(S::Done));
        assert_eq!(map_choice("???"), None);
    }

    #[tokio::test]
    async fn http_roundtrip_against_local_stub() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = sock.read(&mut buf).await;
            let body = r#"{"status":{"choice":"idle","confidence":0.99}}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let out = http_post("127.0.0.1", port, "/v1/systemone", "{}")
            .await
            .unwrap();
        assert!(out.contains("idle"));
        let _ = server.await;
    }

    #[tokio::test]
    async fn classify_gates_on_cutoff() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Serve two identical confident answers (two classify calls).
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 65536];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"status":{"choice":"working","confidence":0.6}}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        let ep = format!("http://127.0.0.1:{port}");
        // 0.6 ≥ 0.55 → accepted.
        let hit = classify(&ep, 0.55, "spinner…").await.unwrap();
        assert_eq!(hit.0, crate::agent_state::AgentState::Working);
        // 0.6 < 0.9 → gated out.
        assert!(classify(&ep, 0.9, "spinner…").await.is_none());
        let _ = server.await;
    }
}
