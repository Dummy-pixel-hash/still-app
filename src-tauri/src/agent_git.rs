use crate::{agent, commands::AppState, core::{SessionStatus, StillError}, ssh_worker};
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, OnceLock, atomic::{AtomicU64, Ordering}},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{State};
use tokio::sync::Mutex;

const GIT_HELPER_SOURCE: &str = include_str!("../agent-host/git-review.mjs");
const GIT_LOADER: &str = r#"
const PREFIX = "__PREFIX__";
const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
let size = 0;
const chunks = [];
const clean = value => [...String(value || "").replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()].slice(0, 500).join("");
const frame = value => {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > OUTPUT_LIMIT + 1024) throw new Error("Git response exceeds its 2 MiB limit.");
  process.stdout.write(PREFIX + output + "\n");
};
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > INPUT_LIMIT) throw Object.assign(new Error("Git request exceeds its 256 KiB limit."), { code: "invalidRequest" });
    chunks.push(chunk);
  }
  const envelope = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (typeof envelope?.source !== "string" || !envelope.request || typeof envelope.request !== "object") {
    throw Object.assign(new Error("Git helper envelope is invalid."), { code: "invalidRequest" });
  }
  try {
    const url = "data:text/javascript;base64," + Buffer.from(envelope.source, "utf8").toString("base64");
    const { inspectGit } = await import(url);
    frame({ ok: true, result: await inspectGit(envelope.request) });
  } catch (error) {
    frame({ ok: false, error: { code: typeof error?.code === "string" ? error.code : "gitHelper", message: clean(error?.message) } });
    process.exitCode = 1;
  }
} catch (error) {
  try { frame({ ok: false, error: { code: typeof error?.code === "string" ? error.code : "gitHelper", message: clean(error?.message) } }); }
  catch {}
  process.exitCode = 1;
}
"#;

const REQUEST_LIMIT: usize = 256 * 1024;
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const BANNER_LIMIT: usize = 16 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const SNAPSHOT_LIMIT: usize = 16;
const CACHE_LIMIT: usize = 16 * 1024 * 1024;
const ENTRY_LIMIT: usize = 2000;
const SNAPSHOT_TTL: Duration = Duration::from_secs(5 * 60);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(10);

static IDS: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<GitRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<GitRegistry> {
    REGISTRY.get_or_init(|| Mutex::new(GitRegistry::default()))
}

fn new_id(prefix: &str) -> String {
    let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let sequence = IDS.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{time:032x}_{sequence:016x}")
}

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentGitView { Combined, Staged, Unstaged }

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGitEntryKind { Modified, Added, Deleted, Renamed, Copied, Untracked, Conflicted, Submodule, TypeChanged }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGitEntry {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: AgentGitEntryKind,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentGitSnapshotState {
    NotRepository { reason: String },
    GitUnavailable { reason: String },
    Ready {
        root: String,
        head_oid: Option<String>,
        branch: Option<String>,
        detached: bool,
        unborn: bool,
        entries: Vec<AgentGitEntry>,
        truncated: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGitSnapshot {
    pub schema_version: u8,
    pub snapshot_id: String,
    pub host_key: String,
    pub cwd: String,
    pub observed_at: u64,
    #[serde(flatten)]
    pub state: AgentGitSnapshotState,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentGitDiffState { Ready, Binary, TooLarge, Conflict, Submodule, Symlink, UnsupportedPath, Stale }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGitDiff {
    pub snapshot_id: String,
    pub entry_id: String,
    pub view: AgentGitView,
    pub observed_at: u64,
    pub state: AgentGitDiffState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs { native_session_id: String, cwd: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffArgs { native_session_id: String, cwd: String, request: GitDiffRequest }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest { snapshot_id: String, entry_id: String, view: AgentGitView }

#[derive(Clone)]
struct StoredEntry { public: AgentGitEntry, helper: Value }

struct StoredSnapshot {
    snapshot_id: String,
    native_session_id: String,
    connection_key: usize,
    host_key: String,
    cwd: String,
    root: String,
    git_dir: String,
    head_oid: Option<String>,
    index_signature: Value,
    fingerprint: String,
    filter_fingerprint: String,
    created_at: Instant,
    cache_bytes: usize,
    entries: HashMap<String, StoredEntry>,
}

#[derive(Default)]
struct GitRegistry { snapshots: HashMap<String, StoredSnapshot>, order: VecDeque<String>, bytes: usize }

impl GitRegistry {
    fn remove(&mut self, id: &str) {
        if let Some(snapshot) = self.snapshots.remove(id) { self.bytes = self.bytes.saturating_sub(snapshot.cache_bytes); }
        self.order.retain(|value| value != id);
    }
    fn prune(&mut self, now: Instant) {
        let expired: Vec<String> = self.snapshots.iter().filter_map(|(id, snapshot)| (now.duration_since(snapshot.created_at) >= SNAPSHOT_TTL).then(|| id.clone())).collect();
        for id in expired { self.remove(&id); }
    }
    fn evict_session(&mut self, session_id: &str) {
        let ids: Vec<String> = self.snapshots.iter().filter_map(|(id, snapshot)| (snapshot.native_session_id == session_id).then(|| id.clone())).collect();
        for id in ids { self.remove(&id); }
    }
    fn evict_replaced(&mut self, session_id: &str, connection_key: usize) {
        let ids: Vec<String> = self.snapshots.iter().filter_map(|(id, snapshot)| {
            (snapshot.native_session_id == session_id && snapshot.connection_key != connection_key).then(|| id.clone())
        }).collect();
        for id in ids { self.remove(&id); }
    }
    fn insert(&mut self, snapshot: StoredSnapshot) {
        self.prune(Instant::now());
        let id = snapshot.snapshot_id.clone();
        while (self.snapshots.len() >= SNAPSHOT_LIMIT || self.bytes.saturating_add(snapshot.cache_bytes) > CACHE_LIMIT) && !self.order.is_empty() {
            if let Some(oldest) = self.order.front().cloned() { self.remove(&oldest); } else { break; }
        }
        if snapshot.cache_bytes > CACHE_LIMIT { return; }
        self.bytes = self.bytes.saturating_add(snapshot.cache_bytes);
        self.order.push_back(id.clone());
        self.snapshots.insert(id, snapshot);
    }
}

#[derive(Clone)]
struct CurrentContext { host_key: String, connection_key: usize }

struct DiffContext { cwd: String, root: String, fingerprint: String, entry: StoredEntry }

fn scope_matches(snapshot: &StoredSnapshot, native_session_id: &str, context: &CurrentContext, cwd: &str) -> bool {
    snapshot.native_session_id == native_session_id && snapshot.host_key == context.host_key
        && snapshot.connection_key == context.connection_key && snapshot.cwd == cwd
}

fn friendly(code: &str, message: &str) -> StillError { StillError::friendly(code, message) }

fn clean_text(value: &str, limit: usize) -> String {
    value.chars().filter(|ch| !ch.is_control()).take(limit).collect::<String>().trim().to_owned()
}

async fn current_context(state: &AppState, native_session_id: &str) -> Result<CurrentContext, StillError> {
    let owner = state.sessions.lock().await.get(native_session_id).cloned()
        .ok_or_else(|| friendly("agent_git_session", "Reconnect and verify the selected server first."))?;
    let connection_key = Arc::as_ptr(&owner) as usize;
    let session = owner.lock().await;
    if session.status != SessionStatus::Live {
        drop(session);
        registry().lock().await.evict_session(native_session_id);
        return Err(friendly("agent_git_session", "The selected server is not connected."));
    }
    let host_key = json!([session.config.host.to_lowercase(), session.config.port, session.config.username]).to_string();
    Ok(CurrentContext { host_key, connection_key })
}

fn valid_hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_rel_path_bytes(path: &[u8]) -> bool {
    if path.is_empty() || path[0] == b'/' || path.contains(&0) { return false; }
    path.split(|byte| *byte == b'/').all(|part| !part.is_empty() && part != b"." && part != b"..")
}

fn display_path(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(path) => path.chars().map(|character| {
            if !character.is_control() { return character.to_string(); }
            let value = character as u32;
            if value <= 0xff { format!("\\x{value:02X}") } else { format!("\\u{{{value:X}}}") }
        }).collect(),
        Err(_) => bytes.iter().map(|byte| format!("\\x{byte:02X}")).collect(),
    }
}

fn decode_path(value: &str) -> Result<Vec<u8>, StillError> {
    let bytes = STANDARD.decode(value).map_err(|_| friendly("agent_git_malformed", "Git returned an invalid path mapping."))?;
    if !valid_rel_path_bytes(&bytes) || STANDARD.encode(&bytes) != value {
        return Err(friendly("agent_git_malformed", "Git returned an invalid path mapping."));
    }
    Ok(bytes)
}

fn helper_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, StillError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid status response."))
}

fn helper_bool(value: &Value, key: &str) -> Result<bool, StillError> {
    value.get(key).and_then(Value::as_bool).ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid status response."))
}

fn helper_optional_string(value: &Value, key: &str) -> Result<Option<String>, StillError> {
    match value.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::String(value)) if value.len() <= 8192 => Ok(Some(value.clone())),
        _ => Err(friendly("agent_git_malformed", "Git returned an invalid status response.")),
    }
}

fn safe_reason(value: &Value) -> Result<String, StillError> {
    let reason = helper_string(value, "reason")?;
    let reason = clean_text(reason, 500);
    if reason.is_empty() { return Err(friendly("agent_git_malformed", "Git returned an invalid status reason.")); }
    Ok(reason)
}

fn parse_kind(value: &str) -> Result<AgentGitEntryKind, StillError> {
    match value {
        "modified" => Ok(AgentGitEntryKind::Modified), "added" => Ok(AgentGitEntryKind::Added),
        "deleted" => Ok(AgentGitEntryKind::Deleted), "renamed" => Ok(AgentGitEntryKind::Renamed),
        "copied" => Ok(AgentGitEntryKind::Copied), "untracked" => Ok(AgentGitEntryKind::Untracked),
        "conflicted" => Ok(AgentGitEntryKind::Conflicted), "submodule" => Ok(AgentGitEntryKind::Submodule),
        "typeChanged" => Ok(AgentGitEntryKind::TypeChanged),
        _ => Err(friendly("agent_git_malformed", "Git returned an unknown file state.")),
    }
}

fn helper_count(value: &Value, key: &str) -> Result<Option<u64>, StillError> {
    let Some(value) = value.get(key) else { return Ok(None) };
    if value.is_null() { return Ok(None); }
    let count = value.as_u64().filter(|count| *count <= 9_007_199_254_740_991)
        .ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid file count."))?;
    Ok(Some(count))
}

fn helper_binary(value: &Value) -> Result<Option<bool>, StillError> {
    match value.get("binary") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(friendly("agent_git_malformed", "Git returned an invalid binary marker.")),
    }
}

fn parse_entry(raw: &Value, id: String) -> Result<StoredEntry, StillError> {
    let path = helper_string(raw, "path")?;
    if path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control) {
        return Err(friendly("agent_git_malformed", "Git returned an invalid path label."));
    }
    let path_bytes = helper_string(raw, "pathBytesBase64")?;
    let decoded_path = decode_path(path_bytes)?;
    if display_path(&decoded_path) != path { return Err(friendly("agent_git_malformed", "Git path labels did not match their native byte mappings.")); }
    let original_path = helper_optional_string(raw, "originalPath")?;
    if original_path.as_ref().is_some_and(|path| path.is_empty() || path.len() > 8192 || path.chars().any(char::is_control)) {
        return Err(friendly("agent_git_malformed", "Git returned an invalid original path label."));
    }
    match raw.get("originalPathBytesBase64") {
        Some(Value::String(bytes)) => {
            let decoded = decode_path(bytes)?;
            if original_path.as_deref() != Some(display_path(&decoded).as_str()) {
                return Err(friendly("agent_git_malformed", "Git returned an incomplete rename mapping."));
            }
        }
        Some(Value::Null) | None if original_path.is_none() => {},
        _ => return Err(friendly("agent_git_malformed", "Git returned an incomplete rename mapping.")),
    }
    let index_status = helper_string(raw, "indexStatus")?;
    let worktree_status = helper_string(raw, "worktreeStatus")?;
    if index_status.chars().count() != 1 || worktree_status.chars().count() != 1
        || !index_status.chars().all(|value| ".MADRCUT?".contains(value))
        || !worktree_status.chars().all(|value| ".MADRCUT?".contains(value)) {
        return Err(friendly("agent_git_malformed", "Git returned invalid index/worktree status."));
    }
    let kind = parse_kind(helper_string(raw, "kind")?)?;
    let signature = raw.get("signature").filter(|value| value.is_object())
        .ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid file signature."))?;
    if serde_json::to_vec(signature).map_or(true, |bytes| bytes.len() > 4096) {
        return Err(friendly("agent_git_malformed", "Git returned an oversized file signature."));
    }
    let path_type = helper_string(raw, "pathType")?;
    if !["file", "symlink", "directory", "other", "missing", "unsupportedPath"].contains(&path_type) {
        return Err(friendly("agent_git_malformed", "Git returned an invalid file type."));
    }
    if let Some(value) = raw.get("originalPathType") {
        if !original_path.is_some() || !value.as_str().is_some_and(|value| ["file", "symlink", "directory", "other", "missing", "unsupportedPath"].contains(&value)) {
            return Err(friendly("agent_git_malformed", "Git returned an invalid original file type."));
        }
    }
    if let Some(value) = raw.get("contentState") {
        if value.as_str() != Some("unsupportedPath") { return Err(friendly("agent_git_malformed", "Git returned an invalid preview state.")); }
    }
    for key in ["pathLinkTarget", "originalPathLinkTarget", "previewReason"] {
        if let Some(value) = raw.get(key) {
            if !value.is_null() && !value.as_str().is_some_and(|value| value.len() <= 1024 && !value.chars().any(char::is_control)) {
                return Err(friendly("agent_git_malformed", "Git returned invalid path metadata."));
            }
        }
    }
    let public = AgentGitEntry {
        id, path: path.to_owned(), original_path, index_status: index_status.to_owned(),
        worktree_status: worktree_status.to_owned(), kind,
        additions: helper_count(raw, "additions")?, deletions: helper_count(raw, "deletions")?, binary: helper_binary(raw)?,
    };
    Ok(StoredEntry { public, helper: raw.clone() })
}

fn parse_status(
    result: &Value, native_session_id: &str, context: &CurrentContext, cwd: &str,
) -> Result<(AgentGitSnapshot, Option<StoredSnapshot>), StillError> {
    if result.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(friendly("agent_git_malformed", "Git returned an unsupported response version."));
    }
    let snapshot_id = new_id("gs");
    let state = helper_string(result, "state")?;
    let (public_state, stored) = match state {
        "notRepository" => (AgentGitSnapshotState::NotRepository { reason: safe_reason(result)? }, None),
        "gitUnavailable" => (AgentGitSnapshotState::GitUnavailable { reason: safe_reason(result)? }, None),
        "ready" => {
            let root = helper_string(result, "root")?;
            if !root.starts_with('/') || root.len() > 4096 || root.chars().any(char::is_control) {
                return Err(friendly("agent_git_malformed", "Git returned an invalid worktree root."));
            }
            let git_dir = helper_string(result, "gitDir")?;
            if !git_dir.starts_with('/') || git_dir.len() > 4096 || git_dir.chars().any(char::is_control) {
                return Err(friendly("agent_git_malformed", "Git returned an invalid Git directory identity."));
            }
            let head_oid = helper_optional_string(result, "headOid")?;
            if head_oid.as_ref().is_some_and(|oid| !valid_hex(oid, &[40, 64])) {
                return Err(friendly("agent_git_malformed", "Git returned an invalid HEAD object ID."));
            }
            let fingerprint = helper_string(result, "fingerprint")?;
            let filter_fingerprint = helper_string(result, "filterFingerprint")?;
            if !valid_hex(fingerprint, &[64]) || !valid_hex(filter_fingerprint, &[64]) {
                return Err(friendly("agent_git_malformed", "Git returned an invalid snapshot fingerprint."));
            }
            let index_signature = result.get("indexSignature").filter(|value| value.is_object())
                .ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid index identity."))?.clone();
            let raw_entries = result.get("entries").and_then(Value::as_array)
                .filter(|entries| entries.len() <= ENTRY_LIMIT)
                .ok_or_else(|| friendly("agent_git_malformed", "Git returned an invalid file list."))?;
            let mut entries = Vec::with_capacity(raw_entries.len());
            let mut stored_entries = HashMap::with_capacity(raw_entries.len());
            for raw in raw_entries {
                let entry_id = new_id("ge");
                let parsed = parse_entry(raw, entry_id.clone())?;
                entries.push(parsed.public.clone());
                stored_entries.insert(entry_id, parsed);
            }
            let branch = helper_optional_string(result, "branch")?;
            if branch.as_ref().is_some_and(|value| value.chars().any(char::is_control)) {
                return Err(friendly("agent_git_malformed", "Git returned an invalid branch label."));
            }
            let detached = helper_bool(result, "detached")?;
            let unborn = helper_bool(result, "unborn")?;
            let truncated = helper_bool(result, "truncated")?;
            if unborn != head_oid.is_none() { return Err(friendly("agent_git_malformed", "Git returned inconsistent unborn repository metadata.")); }
            let public_state = AgentGitSnapshotState::Ready {
                root: root.to_owned(), head_oid: head_oid.clone(), branch, detached, unborn,
                entries, truncated,
            };
            let mut stored = StoredSnapshot {
                snapshot_id: snapshot_id.clone(), native_session_id: native_session_id.to_owned(),
                connection_key: context.connection_key, host_key: context.host_key.clone(), cwd: cwd.to_owned(),
                root: root.to_owned(), git_dir: git_dir.to_owned(), head_oid, index_signature,
                fingerprint: fingerprint.to_owned(), filter_fingerprint: filter_fingerprint.to_owned(),
                created_at: Instant::now(), cache_bytes: 0, entries: stored_entries,
            };
            stored.cache_bytes = snapshot_size(&stored)?;
            if stored.cache_bytes > CACHE_LIMIT {
                return Err(friendly("agent_git_response_too_large", "The Git file list exceeds the native review cache limit."));
            }
            (public_state, Some(stored))
        }
        _ => return Err(friendly("agent_git_malformed", "Git returned an unknown repository state.")),
    };
    Ok((AgentGitSnapshot {
        schema_version: 1, snapshot_id, host_key: context.host_key.clone(), cwd: cwd.to_owned(),
        observed_at: timestamp(), state: public_state,
    }, stored))
}

fn snapshot_size(snapshot: &StoredSnapshot) -> Result<usize, StillError> {
    let mut size = 512usize;
    for entry in snapshot.entries.values() {
        size = size.saturating_add(serde_json::to_vec(&entry.public).map_err(|_| friendly("agent_git_malformed", "Could not size the Git cache entry."))?.len());
        size = size.saturating_add(serde_json::to_vec(&entry.helper).map_err(|_| friendly("agent_git_malformed", "Could not size the Git cache entry."))?.len());
    }
    Ok(size)
}

fn request_envelope(request: &Value) -> Result<Vec<u8>, StillError> {
    let envelope = json!({"source": GIT_HELPER_SOURCE, "request": request});
    let bytes = serde_json::to_vec(&envelope).map_err(|_| friendly("agent_git_request", "Could not encode the Git inspection request."))?;
    if bytes.len() > REQUEST_LIMIT {
        return Err(friendly("agent_git_request_too_large", "This path is too large to open safely in a Git diff."));
    }
    Ok(bytes)
}

fn parse_frame(stdout: &[u8], prefix: &[u8]) -> Result<Value, StillError> {
    let prefix_at = stdout.windows(prefix.len()).position(|window| window == prefix)
        .ok_or_else(|| friendly("agent_git_frame", "Remote Git returned no result frame."))?;
    if prefix_at > BANNER_LIMIT { return Err(friendly("agent_git_frame", "Remote Git login output exceeded its 16 KiB limit.")); }
    let start = prefix_at + prefix.len();
    let end = stdout[start..].iter().position(|byte| *byte == b'\n').map(|offset| start + offset)
        .ok_or_else(|| friendly("agent_git_frame", "Remote Git returned an incomplete result frame."))?;
    if stdout[end + 1..].windows(prefix.len()).any(|window| window == prefix)
        || !stdout[end + 1..].iter().all(u8::is_ascii_whitespace) || end - start > RESPONSE_LIMIT + 1024 {
        return Err(friendly("agent_git_frame", "Remote Git response exceeded its safe frame boundary."));
    }
    serde_json::from_slice(&stdout[start..end]).map_err(|_| friendly("agent_git_frame", "Remote Git returned malformed JSON."))
}

fn helper_error(value: &Value) -> StillError {
    let code = value.pointer("/error/code").and_then(Value::as_str).unwrap_or("gitHelper");
    let message = value.pointer("/error/message").and_then(Value::as_str).unwrap_or("Remote Git inspection failed.");
    let message = clean_text(message, 500);
    match code {
        "gitUnavailable" => friendly("agent_git_unavailable", "Git is not installed or is unavailable on the remote host."),
        "wrongOwnership" => friendly("agent_git_ownership", if message.is_empty() { "Git refused this repository because of its ownership configuration." } else { &message }),
        "timeout" => friendly("agent_git_timeout", "Remote Git inspection exceeded its 10-second deadline."),
        "stale" => friendly("agent_git_stale", "The repository changed while Git status was being collected. Refresh and retry."),
        "invalidRequest" | "invalidPath" | "malformedOutput" => friendly("agent_git_malformed", if message.is_empty() { "Remote Git returned an invalid response." } else { &message }),
        _ => friendly("agent_git_failed", if message.is_empty() { "Remote Git inspection failed." } else { &message }),
    }
}

async fn run_remote_helper(
    native_session_id: &str, request: &Value, deadline: tokio::time::Instant,
) -> Result<Value, StillError> {
    let payload = request_envelope(request)?;
    let prefix = format!("STILL_GIT_RESULT_{}:", new_id("frame"));
    let loader = GIT_LOADER.replace("__PREFIX__", &prefix);
    let command = agent::login_command(&format!("exec node --input-type=module -e {}", agent::quote(&loader)));
    let mut channel = tokio::time::timeout_at(deadline, ssh_worker::open_agent_exec(native_session_id, &command)).await
        .map_err(|_| friendly("agent_git_timeout", "Remote Git inspection exceeded its 10-second deadline."))?
        .map_err(|_| friendly("agent_git_ssh", "The selected SSH connection is unavailable."))?;
    for chunk in payload.chunks(16 * 1024) {
        match tokio::time::timeout_at(deadline, channel.data_bytes(chunk.to_vec())).await {
            Ok(Ok(())) => {},
            Ok(Err(_)) => { let _ = channel.close().await; return Err(friendly("agent_git_ssh", "Could not send the bounded Git request over SSH.")); }
            Err(_) => { let _ = channel.close().await; return Err(friendly("agent_git_timeout", "Remote Git inspection exceeded its 10-second deadline.")); }
        }
    }
    match tokio::time::timeout_at(deadline, channel.eof()).await {
        Ok(Ok(())) => {},
        Ok(Err(_)) => { let _ = channel.close().await; return Err(friendly("agent_git_ssh", "Could not close the Git request stream.")); }
        Err(_) => { let _ = channel.close().await; return Err(friendly("agent_git_timeout", "Remote Git inspection exceeded its 10-second deadline.")); }
    }
    read_helper_channel(&mut channel, prefix.as_bytes(), deadline).await
}

async fn read_helper_channel(
    channel: &mut Channel<client::Msg>, prefix: &[u8], deadline: tokio::time::Instant,
) -> Result<Value, StillError> {
    let mut stdout = Vec::new();
    let mut _stderr = Vec::new();
    let mut exit_status = None;
    let mut exit_signal = None;
    loop {
        let message = match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(message) => message,
            Err(_) => { let _ = channel.close().await; return Err(friendly("agent_git_timeout", "Remote Git inspection exceeded its 10-second deadline.")); }
        };
        match message {
            Some(ChannelMsg::Data { data }) => {
                if stdout.len().saturating_add(data.len()) > RESPONSE_LIMIT + BANNER_LIMIT + prefix.len() + 1024 {
                    let _ = channel.close().await;
                    return Err(friendly("agent_git_frame", "Remote Git response exceeded its 2 MiB limit."));
                }
                stdout.extend_from_slice(&data);
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                let retained = STDERR_LIMIT.saturating_sub(_stderr.len()).min(data.len());
                _stderr.extend_from_slice(&data[..retained]);
            }
            Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => exit_signal = Some(signal_name),
            // SSH EOF closes the output stream, not the process/channel. OpenSSH
            // can send the exit status afterwards; keep draining to Close.
            Some(ChannelMsg::Eof) => {},
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let _ = channel.close().await;
    let frame = parse_frame(&stdout, prefix)?;
    if frame.get("ok").and_then(Value::as_bool) != Some(true) { return Err(helper_error(&frame)); }
    if exit_signal.is_some() { return Err(friendly("agent_git_failed", "Remote Git helper was terminated by a signal.")); }
    match exit_status {
        Some(0) => {},
        Some(code) => return Err(friendly("agent_git_failed", &format!("Remote Git helper exited with status {code}."))),
        None => return Err(friendly("agent_git_failed", "Remote Git helper closed without confirming its exit status.")),
    }
    let result = frame.get("result").cloned().ok_or_else(|| friendly("agent_git_frame", "Remote Git result is missing."))?;
    if serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > RESPONSE_LIMIT) {
        return Err(friendly("agent_git_frame", "Remote Git response exceeded its 2 MiB limit."));
    }
    Ok(result)
}

fn stale_diff(snapshot_id: String, entry_id: String, view: AgentGitView, path: Option<String>, reason: &str) -> AgentGitDiff {
    AgentGitDiff {
        snapshot_id, entry_id, view, observed_at: timestamp(), state: AgentGitDiffState::Stale,
        path, patch: None, reason: Some(clean_text(reason, 500)),
    }
}

pub(crate) async fn evict_session(native_session_id: &str) {
    registry().lock().await.evict_session(native_session_id);
}

#[tauri::command]
pub async fn still_agent_git_status(state: State<'_, AppState>, args: GitStatusArgs) -> Result<AgentGitSnapshot, StillError> {
    let deadline = tokio::time::Instant::now() + OPERATION_TIMEOUT;
    let context = current_context(&state, &args.native_session_id).await?;
    let cwd = agent::remote_cwd(&args.native_session_id, &args.cwd).await?;
    if !cwd.starts_with('/') || cwd.len() > 4096 || cwd.chars().any(char::is_control) {
        return Err(friendly("agent_git_cwd", "The selected directory is not a canonical remote path."));
    }
    let request = json!({"operation":"status","cwd":cwd});
    let result = run_remote_helper(&args.native_session_id, &request, deadline).await?;
    let current = current_context(&state, &args.native_session_id).await?;
    if context.connection_key != current.connection_key || context.host_key != current.host_key {
        return Err(friendly("agent_git_session", "The selected SSH connection changed during Git inspection."));
    }
    let (snapshot, stored) = parse_status(&result, &args.native_session_id, &context, &cwd)?;
    if let Some(stored) = stored {
        let mut cache = registry().lock().await;
        cache.evict_replaced(&args.native_session_id, context.connection_key);
        cache.insert(stored);
        drop(cache);
        let after = current_context(&state, &args.native_session_id).await?;
        if after.connection_key != context.connection_key || after.host_key != context.host_key {
            registry().lock().await.evict_session(&args.native_session_id);
            return Err(friendly("agent_git_session", "The selected SSH connection changed during Git inspection."));
        }
    }
    Ok(snapshot)
}

fn parse_diff_result(
    result: &Value, snapshot_id: String, entry: &StoredEntry, view: AgentGitView,
) -> Result<AgentGitDiff, StillError> {
    let state = match helper_string(result, "state")? {
        "ready" => AgentGitDiffState::Ready, "binary" => AgentGitDiffState::Binary,
        "tooLarge" => AgentGitDiffState::TooLarge, "conflict" => AgentGitDiffState::Conflict,
        "submodule" => AgentGitDiffState::Submodule, "symlink" => AgentGitDiffState::Symlink,
        "unsupportedPath" => AgentGitDiffState::UnsupportedPath, "stale" => AgentGitDiffState::Stale,
        _ => return Err(friendly("agent_git_malformed", "Git returned an unknown diff state.")),
    };
    let reason = match result.get("reason") {
        Some(Value::String(value)) => Some(clean_text(value, 500)),
        None | Some(Value::Null) => None,
        _ => return Err(friendly("agent_git_malformed", "Git returned an invalid diff reason.")),
    };
    let patch = if state == AgentGitDiffState::Ready {
        let value = result.get("patch").and_then(Value::as_str)
            .ok_or_else(|| friendly("agent_git_malformed", "Git returned an incomplete text diff."))?;
        let lines = value.bytes().filter(|byte| *byte == b'\n').count() + usize::from(!value.is_empty() && !value.ends_with('\n'));
        if value.len() > 512 * 1024 || lines > 10_000 {
            return Ok(AgentGitDiff { snapshot_id, entry_id: entry.public.id.clone(), view, observed_at: timestamp(), state: AgentGitDiffState::TooLarge, path: Some(entry.public.path.clone()), patch: None, reason: Some("This diff exceeds its safe preview limit.".into()) });
        }
        Some(value.to_owned())
    } else { None };
    Ok(AgentGitDiff {
        snapshot_id, entry_id: entry.public.id.clone(), view, observed_at: timestamp(), state,
        path: Some(entry.public.path.clone()), patch, reason,
    })
}

#[tauri::command]
pub async fn still_agent_git_diff(state: State<'_, AppState>, args: GitDiffArgs) -> Result<AgentGitDiff, StillError> {
    let deadline = tokio::time::Instant::now() + OPERATION_TIMEOUT;
    if !valid_id(&args.request.snapshot_id) || !valid_id(&args.request.entry_id) {
        return Err(friendly("agent_git_request", "Git snapshot and entry IDs must be opaque native identifiers."));
    }
    if args.cwd.len() > 4096 {
        return Ok(stale_diff(args.request.snapshot_id, args.request.entry_id, args.request.view, None, "This Git snapshot or project scope is invalid."));
    }
    let context = current_context(&state, &args.native_session_id).await?;
    let stale = |path: Option<String>, reason: &str| stale_diff(args.request.snapshot_id.clone(), args.request.entry_id.clone(), args.request.view.clone(), path, reason);
    let snapshot = {
        let mut cache = registry().lock().await;
        cache.prune(Instant::now());
        let Some(snapshot) = cache.snapshots.get(&args.request.snapshot_id) else {
            return Ok(stale(None, "This Git snapshot expired. Refresh repository status."));
        };
        if snapshot.native_session_id != args.native_session_id {
            return Ok(stale(None, "This Git snapshot belongs to a different connection or project."));
        }
        if snapshot.host_key != context.host_key || snapshot.connection_key != context.connection_key {
            cache.evict_session(&args.native_session_id);
            return Ok(stale(None, "The selected connection was replaced. Refresh repository status."));
        }
        if !scope_matches(snapshot, &args.native_session_id, &context, &args.cwd) {
            return Ok(stale(None, "This Git snapshot belongs to a different project."));
        }
        if !snapshot.git_dir.starts_with('/') || snapshot.index_signature.is_null()
            || !valid_hex(&snapshot.fingerprint, &[64]) || !valid_hex(&snapshot.filter_fingerprint, &[64])
            || snapshot.head_oid.as_ref().is_some_and(|oid| !valid_hex(oid, &[40, 64])) {
            return Ok(stale(None, "This Git snapshot no longer has a valid native identity."));
        }
        let Some(entry) = snapshot.entries.get(&args.request.entry_id).cloned() else {
            return Ok(stale(None, "This Git file entry expired. Refresh repository status."));
        };
        DiffContext {
            cwd: snapshot.cwd.clone(), root: snapshot.root.clone(), fingerprint: snapshot.fingerprint.clone(), entry,
        }
    };
    let canonical_cwd = match agent::remote_cwd(&args.native_session_id, &args.cwd).await {
        Ok(cwd) => cwd,
        Err(_) => return Ok(stale(Some(snapshot.entry.public.path.clone()), "The selected project is no longer available.")),
    };
    if canonical_cwd != snapshot.cwd { return Ok(stale(Some(snapshot.entry.public.path.clone()), "The selected project path changed.")); }
    let request = json!({
        "operation":"diff", "cwd":snapshot.cwd, "root":snapshot.root,
        "fingerprint":snapshot.fingerprint, "entry":snapshot.entry.helper,
        "view":match args.request.view { AgentGitView::Combined => "combined", AgentGitView::Staged => "staged", AgentGitView::Unstaged => "unstaged" },
    });
    let result = match run_remote_helper(&args.native_session_id, &request, deadline).await {
        Ok(result) => result,
        Err(error) if error.code == "agent_git_request_too_large" => {
            return Ok(AgentGitDiff { snapshot_id: args.request.snapshot_id, entry_id: args.request.entry_id, view: args.request.view,
                observed_at: timestamp(), state: AgentGitDiffState::UnsupportedPath, path: Some(snapshot.entry.public.path), patch: None,
                reason: Some("This path exceeds the safe remote request limit.".into()) });
        }
        Err(error) => return Err(error),
    };
    let current = current_context(&state, &args.native_session_id).await?;
    if current.connection_key != context.connection_key || current.host_key != context.host_key {
        return Ok(stale(Some(snapshot.entry.public.path.clone()), "The selected SSH connection changed during diff inspection."));
    }
    parse_diff_result(&result, args.request.snapshot_id, &snapshot.entry, args.request.view)
}

#[cfg(test)]
mod tests {
    use super::*;

    // In-memory SSH fixture: no external server, account, keys, or filesystem writes.
    struct ExitOrderServer { exit_code: Option<u32>, signal: bool, delay: Duration }
    impl russh::server::Handler for ExitOrderServer {
        type Error = russh::Error;
        async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }
        async fn channel_open_session(&mut self, _: Channel<russh::server::Msg>, reply: russh::server::ChannelOpenHandle, _: &mut russh::server::Session) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }
        async fn exec_request(&mut self, channel: russh::ChannelId, _: &[u8], session: &mut russh::server::Session) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            session.data(channel, b"STILL_GIT_RESULT_test:{\"ok\":true,\"result\":{\"state\":\"ready\"}}\n".to_vec())?;
            // OpenSSH can close stdout before reporting process exit.
            session.eof(channel)?;
            let handle = session.handle();
            let exit_code = self.exit_code;
            let signal = self.signal;
            let delay = self.delay;
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if let Some(exit_code) = exit_code { let _ = handle.exit_status_request(channel, exit_code).await; }
                if signal { let _ = handle.exit_signal_request(channel, russh::Sig::TERM, false, String::new(), String::new()).await; }
                let _ = handle.close(channel).await;
            });
            Ok(())
        }
    }
    struct ExitOrderClient { expected: russh::keys::PublicKey }
    impl client::Handler for ExitOrderClient {
        type Error = russh::Error;
        async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
            Ok(matches!(key, russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } if key.key_data() == self.expected.key_data()))
        }
    }

    #[tokio::test]
    async fn ssh_output_eof_before_exit_status_does_not_reject_a_successful_helper() {
        use russh::keys::{PrivateKey, ssh_key::private::{Ed25519Keypair, KeypairData}};
        for (exit_code, signal, delay) in [
            (Some(0), false, Duration::from_millis(30)),
            (Some(7), false, Duration::from_millis(30)),
            (None, false, Duration::from_millis(30)),
            (Some(0), true, Duration::from_millis(30)),
            (Some(0), false, Duration::from_secs(5)),
        ] {
            let key = PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&[7;32])), "test-only").unwrap();
            let expected = key.public_key().clone();
            let config = Arc::new(russh::server::Config { keys: vec![key], auth_rejection_time: Duration::ZERO, ..Default::default() });
            let (server_stream, client_stream) = tokio::io::duplex(64 * 1024);
            let server = tokio::spawn(async move { russh::server::run_stream(config, server_stream, ExitOrderServer { exit_code, signal, delay }).await.unwrap().await });
            let mut connection = client::connect_stream(Arc::new(client::Config::default()), client_stream, ExitOrderClient { expected }).await.unwrap();
            assert!(connection.authenticate_none("fixture").await.unwrap().success());
            let mut channel = connection.channel_open_session().await.unwrap();
            channel.exec(true, "fixture").await.unwrap();
            let result = read_helper_channel(&mut channel, b"STILL_GIT_RESULT_test:", tokio::time::Instant::now() + Duration::from_secs(1)).await;
            let _ = connection.disconnect(russh::Disconnect::ByApplication, "", "").await;
            server.abort();
            if delay > Duration::from_secs(1) { assert_eq!(result.unwrap_err().code, "agent_git_timeout"); }
            else if exit_code == Some(0) && !signal { assert_eq!(result.unwrap()["state"], "ready"); }
            else { assert_eq!(result.unwrap_err().code, "agent_git_failed"); }
        }
    }

    fn raw_entry(bytes: &[u8], label: &str) -> Value {
        json!({
            "path": label, "pathBytesBase64": STANDARD.encode(bytes),
            "indexStatus": "M", "worktreeStatus": ".", "kind": "modified",
            "additions": 1, "deletions": 0, "binary": false,
            "pathType": "file", "signature": {"path":{"type":"file","size":"12"}},
        })
    }

    fn raw_status(entry: Value) -> Value {
        json!({
            "schemaVersion":1,"state":"ready","root":"/srv/project","gitDir":"/srv/project/.git",
            "headOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"main","detached":false,"unborn":false,
            "entries":[entry],"truncated":false,"fingerprint":"b".repeat(64),"filterFingerprint":"c".repeat(64),
            "indexSignature":{"type":"file","size":"12"},
        })
    }

    fn context() -> CurrentContext { CurrentContext { host_key: "[\"host\",22,\"user\"]".into(), connection_key: 42 } }

    fn stored(id: &str, session: &str, connection: usize, created_at: Instant, bytes: usize) -> StoredSnapshot {
        StoredSnapshot {
            snapshot_id: id.into(), native_session_id: session.into(), connection_key: connection,
            host_key: "host".into(), cwd: "/project".into(), root: "/project".into(), git_dir: "/project/.git".into(),
            head_oid: None, index_signature: json!({"type":"missing"}), fingerprint: "a".repeat(64),
            filter_fingerprint: "b".repeat(64), created_at, cache_bytes: bytes, entries: HashMap::new(),
        }
    }

    #[test]
    fn public_status_hides_private_path_bytes_signatures_and_git_identity() {
        let bytes = b"src/name with space.txt";
        let (snapshot, private) = parse_status(&raw_status(raw_entry(bytes, "src/name with space.txt")), "native-1", &context(), "/srv/project").unwrap();
        let public = serde_json::to_value(snapshot).unwrap();
        assert_eq!(public["hostKey"], context().host_key);
        assert_eq!(public["cwd"], "/srv/project");
        assert_eq!(public["state"], "ready");
        assert_eq!(public["headOid"], "a".repeat(40));
        assert!(public.get("head_oid").is_none());
        let row = &public["entries"][0];
        assert_eq!(row["path"], "src/name with space.txt");
        assert_ne!(row["id"], "src/name with space.txt");
        assert!(row.get("pathBytesBase64").is_none());
        assert!(row.get("signature").is_none());
        assert!(public.get("gitDir").is_none());
        assert!(public.get("fingerprint").is_none());
        let cached = private.unwrap();
        let helper_entry = cached.entries.get(row["id"].as_str().unwrap()).unwrap();
        assert_eq!(helper_entry.helper["pathBytesBase64"], STANDARD.encode(bytes));
        assert!(cached.cache_bytes < CACHE_LIMIT);
    }

    #[test]
    fn native_path_mapping_rejects_traversal_and_checks_escaped_labels() {
        assert!(decode_path(&STANDARD.encode(b"../outside")).is_err());
        assert!(decode_path(&STANDARD.encode(b"/etc/passwd")).is_err());
        let invalid = [b'a', 0xff, b'b'];
        assert_eq!(display_path(&invalid), "\\x61\\xFF\\x62");
        let mut raw = raw_entry(&invalid, "\\x61\\xFF\\x62");
        raw["pathType"] = json!("unsupportedPath");
        assert!(parse_entry(&raw, "id".into()).is_ok());
        assert!(parse_entry(&raw_entry(&invalid, "a�b"), "id".into()).is_err());
    }

    #[test]
    fn cached_snapshot_scope_binds_session_connection_host_and_cwd() {
        let snapshot = stored("snapshot", "native", 42, Instant::now(), 1);
        let context = CurrentContext { host_key: "host".into(), connection_key: 42 };
        assert!(scope_matches(&snapshot, "native", &context, "/project"));
        assert!(!scope_matches(&snapshot, "other", &context, "/project"));
        assert!(!scope_matches(&snapshot, "native", &CurrentContext { host_key:"other".into(), connection_key:42 }, "/project"));
        assert!(!scope_matches(&snapshot, "native", &CurrentContext { host_key:"host".into(), connection_key:43 }, "/project"));
        assert!(!scope_matches(&snapshot, "native", &context, "/other"));
    }

    #[test]
    fn cache_enforces_snapshot_count_byte_budget_ttl_and_session_eviction() {
        let mut cache = GitRegistry::default();
        for index in 0..SNAPSHOT_LIMIT {
            cache.insert(stored(&format!("s{index}"), "native", 1, Instant::now(), 10));
        }
        cache.insert(stored("new", "native", 1, Instant::now(), 10));
        assert_eq!(cache.snapshots.len(), SNAPSHOT_LIMIT);
        assert!(!cache.snapshots.contains_key("s0"));
        assert!(cache.snapshots.contains_key("new"));
        cache.evict_replaced("native", 2);
        assert!(cache.snapshots.is_empty());
        cache.insert(stored("expired", "native", 2, Instant::now() - SNAPSHOT_TTL, 10));
        cache.prune(Instant::now());
        assert!(cache.snapshots.is_empty());
        cache.insert(stored("large", "native", 2, Instant::now(), CACHE_LIMIT + 1));
        assert!(cache.snapshots.is_empty());
    }

    #[test]
    fn framed_loader_output_tolerates_small_banners_but_rejects_duplicates_and_unbounded_banners() {
        let prefix = b"STILL_GIT_RESULT_nonce:";
        let body = format!("{{\"ok\":true,\"result\":{{\"path\":\"{}\"}}}}", String::from_utf8_lossy(prefix));
        let stdout = format!("login banner without newline{}{}\n", String::from_utf8_lossy(prefix), body);
        let frame = parse_frame(stdout.as_bytes(), prefix).unwrap();
        assert_eq!(frame["ok"], true);
        assert!(parse_frame(b"STILL_GIT_RESULT_nonce:{}\nSTILL_GIT_RESULT_nonce:{}\n", prefix).is_err());
        let mut oversized = vec![b'x'; BANNER_LIMIT + 1];
        oversized.extend_from_slice(prefix);
        oversized.extend_from_slice(b"{}\n");
        assert!(parse_frame(&oversized, prefix).is_err());
    }

    #[test]
    fn helper_envelope_always_uses_embedded_trusted_source_and_stays_bounded() {
        let request = json!({"operation":"status","cwd":"/srv/project"});
        let envelope: Value = serde_json::from_slice(&request_envelope(&request).unwrap()).unwrap();
        assert_eq!(envelope["source"], GIT_HELPER_SOURCE);
        assert_eq!(envelope["request"], request);
        assert!(GIT_HELPER_SOURCE.len() < REQUEST_LIMIT);
    }
}
