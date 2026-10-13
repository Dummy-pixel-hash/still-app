//! Still orb — Smart layer (BYO AI classifier, optional, default OFF).
//!
//! The user points Still at their own text model — llama.cpp server or any
//! OpenAI-compatible `/v1/chat/completions` endpoint — plus the legacy
//! llama-server `/v1/systemone` choice endpoint. Still classifies stripped
//! pane text through it and uses the verdict only when confident. Everything
//! fails open to the scrape — the model can be wrong, slow, or offline with
//! zero visible breakage.
//!
//! Layer order in `agent_tick`: fresh hook stamp → smart (this file) → scrape.
//!
//! Privacy:
//! - Loopback endpoints are always fine. Remote endpoints must be https (no
//!   cleartext pane text on the wire) AND explicitly acknowledged
//!   (`allow_remote`), set from the Settings checkbox that says pane
//!   snippets leave the machine.
//! - Secrets are scrubbed before sending (same shapes as the snippet
//!   redactor). Diag records verdict + confidence only — never pane bytes.
//! - API keys live in the OS keyring, never in config JSON or logs.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

/// Default cutoff: accept the model's verdict at ≥55% confidence.
pub const DEFAULT_CUTOFF: f64 = 0.55;
/// Needs-input trips easier (missing a question hurts more than mislabeling
/// busy spin): accepted at ≥35% unless the user raises it.
pub const DEFAULT_QUESTION_CUTOFF: f64 = 0.35;
/// Default endpoint: a user-run `llama-server --port 8080`.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8080";
/// Default model: empty = let the server decide (single-model llama.cpp
/// ignores it). Remote endpoints REQUIRE a model name.
pub const DEFAULT_MODEL: &str = "";
/// Classify timeout default (local servers answer fast; remote gets room).
pub const DEFAULT_TIMEOUT_SECS: u64 = 8;
/// Legacy constant kept for suites: the old fixed 3s systemone budget.
pub const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(3);
/// Pane budget sent to the model (chars, rough ~4 chars/token guard).
/// Kept small on purpose: the default `llama-server` physical batch is 512
/// tokens, and the criteria block eats ~200 of those. Tail-only — the newest
/// pane lines carry the current state; stale scrollback only adds tokens.
pub const STATE_BUDGET_CHARS: usize = 1200;
/// Default tail budget for the OpenAI path (chat prompts are cheaper).
pub const DEFAULT_BUDGET_CHARS: usize = 2000;

fn default_question_cutoff() -> f64 {
    DEFAULT_QUESTION_CUTOFF
}
fn default_timeout_secs() -> u64 {
    DEFAULT_TIMEOUT_SECS
}
fn default_budget_chars() -> usize {
    DEFAULT_BUDGET_CHARS
}
fn default_kind() -> String {
    "auto".to_string()
}

/// Which dialect to speak. `auto` tries OpenAI chat first (universal) and
/// falls back to systemone on 404/405 within the same timeout budget.
pub fn normalize_kind(k: &str) -> &str {
    match k.trim().to_lowercase().as_str() {
        "systemone" | "system-one" => "systemone",
        "openai" | "chat" | "chat-completions" => "openai",
        _ => "auto",
    }
}

/// User-facing smart-orb settings (managed Tauri state, renderer-editable).
/// New fields are `#[serde(default)]` so old `{enabled,endpoint,cutoff}`
/// JSON still loads. The API key is NEVER here — keyring only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartConfig {
    pub enabled: bool,
    pub endpoint: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub cutoff: f64,
    #[serde(default = "default_question_cutoff")]
    pub question_cutoff: f64,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    #[serde(default = "default_budget_chars")]
    pub budget_chars: usize,
    #[serde(default)]
    pub allow_remote: bool,
}

impl Default for SmartConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: DEFAULT_MODEL.to_string(),
            kind: "auto".to_string(),
            cutoff: DEFAULT_CUTOFF,
            question_cutoff: DEFAULT_QUESTION_CUTOFF,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            budget_chars: DEFAULT_BUDGET_CHARS,
            allow_remote: false,
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

/// Keyring slot for the Smart API key (BYO remote endpoints).
const SMART_KEY_SERVICE: &str = "dev.still.app";
const SMART_KEY_NAME: &str = "still/smart-llm/api-key";

pub fn save_api_key(key: &str) -> Result<(), String> {
    keyring::Entry::new(SMART_KEY_SERVICE, SMART_KEY_NAME)
        .map_err(|e| format!("secure storage unavailable: {e}"))?
        .set_password(key)
        .map_err(|e| format!("could not save key: {e}"))?;
    Ok(())
}

pub fn load_api_key() -> Option<String> {
    keyring::Entry::new(SMART_KEY_SERVICE, SMART_KEY_NAME)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.trim().is_empty())
}

pub fn forget_api_key() {
    if let Ok(e) = keyring::Entry::new(SMART_KEY_SERVICE, SMART_KEY_NAME) {
        let _ = e.delete_credential();
    }
}

pub fn has_api_key() -> bool {
    load_api_key().is_some()
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
/// Takes the TAIL (newest lines carry the current state; stale scrollback
/// only burns batch budget the server may not have).
pub fn classify_body(pane_text: &str) -> serde_json::Value {
    classify_body_budget(pane_text, STATE_BUDGET_CHARS)
}

fn classify_body_budget(pane_text: &str, budget: usize) -> serde_json::Value {
    let tail: String = pane_text
        .chars()
        .rev()
        .take(budget)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    serde_json::json!({
        "state": tail,
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

/// Parse an OpenAI chat completion body: extract the first `{…}` JSON object
/// from the assistant text and read `status`/`choice` + `confidence`.
/// Missing confidence becomes 0.6 (moderate) so the cutoff still gates it;
/// out-of-range confidence rejects.
pub fn parse_chat_response(body: &str) -> Option<(crate::agent_state::AgentState, f64)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let text = v
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?
        .as_str()?;
    // The assistant may wrap JSON in prose/fences: take the outer object.
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(&text[start..=end]).ok()?;
    let choice = obj
        .get("status")
        .or_else(|| obj.get("choice"))
        .or_else(|| obj.get("state"))
        .and_then(|c| c.as_str())?;
    let state = map_choice(choice)?;
    let confidence = obj
        .get("confidence")
        .and_then(|c| c.as_f64())
        .unwrap_or(0.6);
    if !(0.0..=1.0).contains(&confidence) {
        return None;
    }
    Some((state, confidence))
}

/// Split a base URL into (scheme, host, port). Accepts
/// `http(s)://host[:port][/v1][/...]`; default ports 80/443. Paths beyond
/// the host are ignored (we append our own).
fn split_base(endpoint: &str) -> Result<(String, String, u16), String> {
    let e = endpoint.trim().trim_end_matches('/');
    let (scheme, rest) = e
        .strip_prefix("http://")
        .map(|r| ("http".to_string(), r))
        .or_else(|| e.strip_prefix("https://").map(|r| ("https".to_string(), r)))
        .ok_or_else(|| "endpoint must start with http:// or https://".to_string())?;
    // Drop any path/query: host[:port] is the first segment.
    let authority = rest.split('/').next().unwrap_or(rest);
    let authority = authority.split('?').next().unwrap_or(authority);
    // Strip userinfo if present (we never want creds in the URL).
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    // IPv6 literals in brackets.
    if let Some(bracketed) = authority.strip_prefix('[') {
        let (host_part, port_part) = bracketed.split_once(']').unwrap_or((bracketed, ""));
        let host = format!("[{host_part}]");
        let port: u16 = port_part
            .trim_start_matches(':')
            .parse()
            .unwrap_or(if scheme == "https" { 443 } else { 80 });
        if port == 0 {
            return Err("endpoint port must be 1-65535".to_string());
        }
        return Ok((scheme, host, port));
    }
    if let Some((host, port_str)) = authority.rsplit_once(':') {
        // A bare colon with no port (or an IPv6 without brackets that has
        // multiple colons) — treat carefully.
        if port_str.contains(':') {
            return Ok((
                scheme.clone(),
                authority.to_string(),
                if scheme == "https" { 443 } else { 80 },
            ));
        }
        let port: u16 = port_str
            .parse()
            .map_err(|_| "endpoint port must be 1-65535".to_string())?;
        if port == 0 {
            return Err("endpoint port must be 1-65535".to_string());
        }
        return Ok((scheme, host.to_string(), port));
    }
    Ok((
        scheme.clone(),
        authority.to_string(),
        if scheme == "https" { 443 } else { 80 },
    ))
}

fn host_is_loopback(host: &str) -> bool {
    let bare = host
        .trim()
        .to_lowercase()
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host.trim().to_lowercase())
        .to_string();
    if bare == "::1" || bare == "localhost" {
        return true;
    }
    if let Ok(ip4) = bare.parse::<std::net::Ipv4Addr>() {
        return ip4.is_loopback();
    }
    if let Ok(ip6) = bare.parse::<std::net::Ipv6Addr>() {
        return ip6.is_loopback();
    }
    false
}

fn localhost_actually_resolves(port: u16) -> bool {
    std::net::ToSocketAddrs::to_socket_addrs(&format!("localhost:{port}")[..])
        .map(|mut it| it.any(|a| a.ip().is_loopback()))
        .unwrap_or(false)
}

/// Endpoint policy for ANY model server (local or remote):
/// - loopback (127/8, ::1, localhost-that-resolves-loopback): always fine,
///   http or https.
/// - remote over plain http: refused (no cleartext pane text on the wire).
/// - remote over https: requires explicit `allow_remote` ack, and a model
///   name (so a typo can't silently classify against the wrong weights).
/// Returns the normalized base URL (scheme + host + port, no path).
pub fn endpoint_policy(endpoint: &str, model: &str, allow_remote: bool) -> Result<String, String> {
    let (scheme, host, port) = split_base(endpoint)?;
    let loopback = host_is_loopback(&host);
    if host.trim().to_lowercase() == "localhost" && !localhost_actually_resolves(port) {
        return Err("localhost does not resolve to loopback on this machine".to_string());
    }
    if !loopback {
        if scheme != "https" {
            return Err(
                "remote endpoints must use https:// (pane snippets would travel cleartext otherwise)"
                    .to_string(),
            );
        }
        if !allow_remote {
            return Err(
                "that host is not on this machine — tick the remote-acknowledgement box to send pane snippets there"
                    .to_string(),
            );
        }
        if model.trim().is_empty() {
            return Err("a model name is required for remote endpoints".to_string());
        }
    }
    let default_port = if scheme == "https" { 443 } else { 80 };
    let base = if port == default_port {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    };
    Ok(base)
}

/// Loopback guard (legacy shape, kept for suites + old callers): only
/// `127.0.0.0/8`, `::1`, or `localhost` (which must resolve to loopback).
/// Returns `(host, port)` on success.
pub fn loopback_addr(endpoint: &str) -> Result<(String, u16), String> {
    let (scheme, host, port) = split_base(endpoint)?;
    if scheme != "http" {
        return Err("endpoint must be http://host:port (e.g. http://127.0.0.1:8080)".to_string());
    }
    if !host_is_loopback(&host) {
        return Err("endpoint must be loopback (127.0.0.1, ::1, or localhost)".to_string());
    }
    if host.trim().to_lowercase() == "localhost" && !localhost_actually_resolves(port) {
        return Err("localhost does not resolve to loopback on this machine".to_string());
    }
    // The legacy contract demands an explicit port.
    if !endpoint.trim_end_matches('/').rsplit('/').next().unwrap_or("").contains(':') {
        return Err("endpoint must be http://host:port (e.g. http://127.0.0.1:8080)".to_string());
    }
    Ok((host, port))
}

/// Scrub secret-shaped lines before anything leaves the machine. Same
/// shapes as the snippet redactor: line-wise so one key never poisons a
/// whole pane.
pub fn redact_pane(text: &str) -> String {
    text.lines()
        .map(|line| {
            let t = line.trim();
            if t.contains("-----BEGIN") && t.contains("PRIVATE KEY") {
                return "…(redacted)".to_string();
            }
            for needle in ["sk-", "ghp_", "gsk_", "xoxb-", "xoxp-", "xoxa-", "AKIA"] {
                if let Some(idx) = line.find(needle) {
                    if line[idx..].chars().take(24).filter(|c| c.is_alphanumeric()).count() >= 12 {
                        return "…(redacted)".to_string();
                    }
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tail_budget(text: &str, budget: usize) -> String {
    let redacted = redact_pane(text);
    redacted
        .chars()
        .rev()
        .take(budget.clamp(400, 8000))
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn chat_system_prompt() -> String {
    format!(
        "You classify a coding agent's terminal pane into exactly one status. Reply with STRICT JSON only: {{\"status\": \"<word>\", \"confidence\": <0-1>}}.\nValid words:\n- working: {}. \n- needs_input: {}. \n- idle: {}. \n- done: {}. \n- error: {}. \nRules: a question/approval prompt with options means needs_input even if a spinner shows. An explicit done banner means done. Bare prompt with no activity means idle. When unsure, pick the closest word and lower the confidence.",
        criterion("working"),
        criterion("needs_input"),
        criterion("idle"),
        criterion("done"),
        criterion("error"),
    )
}

fn chat_body(cfg: &SmartConfig, pane_text: &str) -> serde_json::Value {
    let tail = tail_budget(pane_text, cfg.budget_chars);
    let mut m: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    // Local single-model servers ignore the name; remote requires it
    // (enforced by endpoint_policy). Omit when empty for max compat.
    if !cfg.model.trim().is_empty() {
        m.insert("model".to_string(), serde_json::Value::String(cfg.model.trim().to_string()));
    }
    m.insert(
        "messages".to_string(),
        serde_json::json!([
            { "role": "system", "content": chat_system_prompt() },
            { "role": "user", "content": tail },
        ]),
    );
    m.insert("temperature".to_string(), serde_json::json!(0));
    m.insert("max_tokens".to_string(), serde_json::json!(64));
    m.insert(
        "response_format".to_string(),
        serde_json::json!({ "type": "json_object" }),
    );
    serde_json::Value::Object(m)
}

fn reqwest_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("smart http client failed: {e:#}"))
}

async fn post_systemone(
    base: &str,
    api_key: Option<&str>,
    timeout: Duration,
    pane_text: &str,
    budget: usize,
) -> Option<(crate::agent_state::AgentState, f64)> {
    let client = reqwest_client(timeout).ok()?;
    let url = format!("{base}/v1/systemone");
    let mut req = client.post(&url).json(&classify_body_budget(pane_text, budget));
    if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
        req = req.bearer_auth(k.trim());
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // Distinguish "no such endpoint" (caller may fall back) via status?
    let text = resp.text().await.ok()?;
    parse_response(&text)
}

async fn post_openai(
    base: &str,
    api_key: Option<&str>,
    timeout: Duration,
    cfg: &SmartConfig,
    pane_text: &str,
) -> Option<(crate::agent_state::AgentState, f64)> {
    let client = reqwest_client(timeout).ok()?;
    let url = format!("{base}/v1/chat/completions");
    let mut req = client.post(&url).json(&chat_body(cfg, pane_text));
    if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
        req = req.bearer_auth(k.trim());
    }
    let resp = req.send().await.ok()?;
    let status = resp.status();
    if !status.is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    parse_chat_response(&text)
}

/// Classify through the user's configured endpoint (any local or
/// acknowledged-remote model server). Returns `(state, confidence)` or
/// `None` (disabled / refused / timeout / malformed / below bar) — the
/// caller falls back to the scrape on `None`. Needs-input/error verdicts
/// use the lower question bar; everything else uses the global cutoff.
pub async fn classify_cfg(
    cfg: &SmartConfig,
    pane_text: &str,
) -> Option<(crate::agent_state::AgentState, f64)> {
    if !cfg.enabled {
        return None;
    }
    let base = endpoint_policy(&cfg.endpoint, &cfg.model, cfg.allow_remote).ok()?;
    let timeout = Duration::from_secs(cfg.timeout_secs.clamp(2, 30));
    let budget = cfg.budget_chars.clamp(400, 8000);
    let api_key = load_api_key();
    let kind = normalize_kind(&cfg.kind);
    let verdict = match kind {
        "systemone" => post_systemone(&base, api_key.as_deref(), timeout, pane_text, budget).await,
        "openai" => post_openai(&base, api_key.as_deref(), timeout, cfg, pane_text).await,
        _ => {
            // auto: OpenAI first (universal), systemone on miss.
            match post_openai(&base, api_key.as_deref(), timeout, cfg, pane_text).await {
                Some(v) => Some(v),
                None => post_systemone(&base, api_key.as_deref(), timeout, pane_text, budget).await,
            }
        }
    };
    let (state, confidence) = verdict?;
    if !(0.0..=1.0).contains(&confidence) {
        return None;
    }
    let bar = match state {
        crate::agent_state::AgentState::NeedsInput | crate::agent_state::AgentState::Error => {
            cfg.question_cutoff.clamp(0.0, 1.0).min(cfg.cutoff.clamp(0.0, 1.0))
        }
        _ => cfg.cutoff.clamp(0.0, 1.0),
    };
    if confidence < bar {
        return None;
    }
    Some((state, confidence))
}

/// Minimal HTTP/1.1 POST over raw tokio TCP (no TLS): kept for the legacy
/// loopback systemone path + unit tests. Remote traffic always goes through
/// reqwest (above) so cleartext can be refused by policy.
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

/// Legacy classify (loopback systemone only, single cutoff) — kept for old
/// callers + suites. New code prefers `classify_cfg`.
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
    fn policy_allows_loopback_always() {
        assert!(endpoint_policy("http://127.0.0.1:8080", "", false).is_ok());
        assert!(endpoint_policy("http://localhost:8080", "", false).is_ok());
    }

    #[test]
    fn policy_gates_remote() {
        // Plain-http remote: refused even with ack (cleartext pane text).
        assert!(endpoint_policy("http://10.0.0.1:8080", "qwen", true).is_err());
        // https remote without ack: refused.
        assert!(endpoint_policy("https://llm.example.com", "qwen", false).is_err());
        // https remote without model: refused.
        assert!(endpoint_policy("https://llm.example.com", "", true).is_err());
        // https + ack + model: allowed.
        assert!(endpoint_policy("https://llm.example.com", "qwen3", true).is_ok());
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
    fn parse_chat_accepts_strict_json() {
        let body = r#"{"choices":[{"message":{"content":"{\"status\": \"needs_input\", \"confidence\": 0.82}"}}]}"#;
        let (s, c) = parse_chat_response(body).unwrap();
        assert_eq!(s, crate::agent_state::AgentState::NeedsInput);
        assert!((c - 0.82).abs() < 1e-9);
    }

    #[test]
    fn parse_chat_tolerates_fences_and_aliases() {
        let body = r#"{"choices":[{"message":{"content":"Here you go:\n```json\n{\"status\":\"blocked\",\"confidence\":0.5}\n```"}}]}"#;
        let (s, c) = parse_chat_response(body).unwrap();
        assert_eq!(s, crate::agent_state::AgentState::NeedsInput);
        assert!((c - 0.5).abs() < 1e-9);
    }

    #[test]
    fn parse_chat_rejects_garbage() {
        assert!(parse_chat_response("{}").is_none());
        assert!(parse_chat_response(r#"{"choices":[]}"#).is_none());
        assert!(parse_chat_response(r#"{"choices":[{"message":{"content":"napping"}}]}"#).is_none());
    }

    #[test]
    fn redact_pane_scrubs_keys() {
        let out = redact_pane("export K=sk-abcdefghijklmnopqrstuv\necho hi");
        assert!(!out.contains("sk-"));
        assert!(out.contains("echo hi"));
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
