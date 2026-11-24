//! Device-owned agent history. Each conversation has an append-only journal;
//! acknowledged records are flushed before returning, independently of WebView life.
use crate::{agent::{Event, Snapshot}, agent_history, core::StillError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use tauri::{AppHandle, Emitter, Manager};

static WRITER: Mutex<()> = Mutex::new(());
static VALIDATED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static CHECKPOINT_SIZES: OnceLock<Mutex<std::collections::HashMap<PathBuf, u64>>> = OnceLock::new();
struct Summary { length: u64, modified: Option<std::time::SystemTime>, row: Value }
static SUMMARIES: OnceLock<Mutex<std::collections::HashMap<PathBuf, Summary>>> = OnceLock::new();

fn summary(path: &Path, warnings: &mut Vec<String>) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if let Ok(cache) = SUMMARIES.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock() {
        if let Some(saved) = cache.get(path).filter(|saved| saved.length == metadata.len() && saved.modified == metadata.modified().ok()) { return Ok(saved.row.clone()); }
    }
    let row = agent_history::index(path, warnings)?.row;
    if agent_history::json_size(&row) <= agent_history::PAGE_BYTES {
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        if let Ok(mut cache) = SUMMARIES.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock() {
            if cache.len() >= 64 { if let Some(old) = cache.keys().next().cloned() { cache.remove(&old); } }
            cache.insert(path.to_path_buf(), Summary { length: metadata.len(), modified: metadata.modified().ok(), row: row.clone() });
        }
    }
    Ok(row)
}

fn update_summary(path: &Path, before: u64, record: &Record) {
    let Ok(mut cache) = SUMMARIES.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock() else { return };
    // Cache metadata only. Draft saves and account polling must not re-scan an
    // 84 MB transcript on every keystroke; output bodies never enter this cache.
    if let Some(saved) = cache.get_mut(path).filter(|saved| saved.length == before) {
        match record {
            Record::Update { fields } => merge(&mut saved.row, fields.clone()),
            Record::Metadata { meta } => {
                let activity = saved.row["meta"]["activityAt"].as_u64().unwrap_or(0).max(saved.row["touchedAt"].as_u64().unwrap_or(0)).max(meta["activityAt"].as_u64().unwrap_or(0));
                saved.row["meta"] = meta.clone(); saved.row["meta"]["activityAt"] = json!(activity);
            }
            Record::Event { fields, event } => {
                if fields["executionId"] != saved.row["executionId"] || event.sequence > saved.row["lastSequence"].as_u64().unwrap_or(0) {
                    merge(&mut saved.row, fields.clone());
                    if let Some(activity) = fields["touchedAt"].as_u64() { saved.row["meta"]["activityAt"] = json!(activity); }
                }
            }
            _ => { cache.remove(path); return; },
        }
        saved.row["pendingPermission"] = Value::Null; saved.row["pendingInput"] = Value::Null;
        if agent_history::json_size(&saved.row) > agent_history::PAGE_BYTES { cache.remove(path); return; }
        if let Ok(metadata) = fs::metadata(path) { saved.length = metadata.len(); saved.modified = metadata.modified().ok(); }
        else { cache.remove(path); }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Record {
    Create { row: Value },
    Update { fields: Value },
    Event { fields: Value, event: Event },
    Metadata { meta: Value },
    Workspace { key: String, value: Value },
}

fn file(root: &Path, id: &str, extension: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 100 || id.chars().any(char::is_control) {
        return Err("Invalid local conversation identity.".into());
    }
    let name: String = id.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(root.join(format!("{name}.{extension}")))
}

fn sync_directory(root: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(root).and_then(|file| file.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

fn append(path: &Path, record: &Record) -> Result<(), String> {
    let mut validated = VALIDATED.get_or_init(|| Mutex::new(HashSet::new())).lock().map_err(|_| "History validation is unavailable")?;
    if path.exists() && !validated.contains(path) {
        if path.file_stem().and_then(|v| v.to_str()) == Some("workspace") { records(path, &mut Vec::new())?; }
        else { summary(path, &mut Vec::new())?; }
    }
    validated.insert(path.to_path_buf());
    drop(validated);
    let mut bytes = serde_json::to_vec(&json!({"version": 1, "record": record})).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut output = OpenOptions::new().create(true).read(true).write(true).truncate(false).open(path).map_err(|e| e.to_string())?;
    let mut before = output.metadata().map_err(|e| e.to_string())?.len();
    if before > 0 {
        output.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
        let mut tail = [0_u8]; output.read_exact(&mut tail).map_err(|e| e.to_string())?;
        if tail[0] != b'\n' {
            if path.file_stem().and_then(|v| v.to_str()) == Some("workspace") { records(path, &mut Vec::new())?; }
            else { agent_history::index(path, &mut Vec::new())?; }
            before = output.metadata().map_err(|e| e.to_string())?.len();
        }
    }
    output.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        // A failed write must not leave a partial record in the middle of the next append.
        output.set_len(before).and_then(|_| output.sync_all()).map_err(|rollback| format!("{error}; journal recovery required: {rollback}"))?;
        return Err(error.to_string());
    }
    sync_directory(path.parent().ok_or("Missing storage directory")?)?;
    drop(output);
    update_summary(path, before, record);
    // Maintenance is never an acknowledgement failure: the appended record is
    // already durable, and a failed checkpoint leaves that journal authoritative.
    let boundary = matches!(record, Record::Metadata { .. } | Record::Workspace { .. })
        || matches!(record, Record::Event { event, .. } if matches!(event.kind.as_str(), "threadComplete" | "threadError" | "historyReverted"));
    // Keep conversation journals append-only: a giant Create checkpoint copies
    // the whole transcript into memory and invalidates history paging cursors.
    if boundary && path.file_stem().and_then(|v| v.to_str()) == Some("workspace") {
        let length = before + bytes.len() as u64;
        if let Ok(mut sizes) = CHECKPOINT_SIZES.get_or_init(|| Mutex::new(std::collections::HashMap::new())).lock() {
            let threshold = sizes.get(path).copied().unwrap_or(0).saturating_add(8 * 1024 * 1024);
            if length > threshold {
                let _ = checkpoint(path);
                sizes.insert(path.to_path_buf(), fs::metadata(path).map(|m| m.len()).unwrap_or(length));
            }
        }
    }
    Ok(())
}

fn checkpoint(path: &Path) -> Result<(), String> {
    let records = records(path, &mut Vec::new())?;
    let compacted = if path.file_stem().and_then(|v| v.to_str()) == Some("workspace") {
        let mut values = std::collections::BTreeMap::new();
        for record in records { if let Record::Workspace { key, value } = record { values.insert(key, value); } else { return Err("Invalid workspace record".into()); } }
        values.into_iter().map(|(key, value)| Record::Workspace { key, value }).collect::<Vec<_>>()
    } else { vec![Record::Create { row: replay(records)? }] };
    let temporary = path.with_extension("checkpoint-pending");
    let mut output = OpenOptions::new().create(true).truncate(true).write(true).open(&temporary).map_err(|e| e.to_string())?;
    for record in compacted {
        serde_json::to_writer(&mut output, &json!({"version":1,"record":record})).map_err(|e| e.to_string())?;
        output.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    // std::fs::rename replaces the destination atomically on both Windows and
    // Unix. Never delete the old journal to make replacement succeed.
    fs::rename(&temporary, path).map_err(|e| e.to_string())?;
    sync_directory(path.parent().ok_or("Missing storage directory")?)
}

fn records(path: &Path, warnings: &mut Vec<String>) -> Result<Vec<Record>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut result = Vec::new();
    for line in bytes[..complete].split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
        let value: Value = serde_json::from_slice(line).map_err(|_| format!("History needs recovery: {}. The original file was kept.", path.display()))?;
        if value["version"] != 1 { return Err(format!("Unsupported history version in {}", path.display())); }
        result.push(serde_json::from_value(value["record"].clone()).map_err(|e| format!("Invalid history record: {e}"))?);
    }
    if complete < bytes.len() {
        // Preserve the interrupted append before removing its incomplete suffix.
        let backup = path.with_extension(format!("interrupted-{}", timestamp()));
        fs::copy(path, &backup).map_err(|e| e.to_string())?;
        OpenOptions::new().write(true).open(&backup).and_then(|file| file.sync_all()).map_err(|e| e.to_string())?;
        OpenOptions::new().write(true).open(path).and_then(|file| { file.set_len(complete as u64)?; file.sync_all() }).map_err(|e| e.to_string())?;
        sync_directory(path.parent().ok_or("Missing storage directory")?)?;
        warnings.push("Recovered an interrupted history write. All complete records were retained.".into());
    }
    Ok(result)
}

fn merge(target: &mut Value, fields: Value) {
    if let (Some(target), Some(fields)) = (target.as_object_mut(), fields.as_object()) {
        target.extend(fields.clone());
    }
}

fn replay(records: Vec<Record>) -> Result<Value, String> {
    let mut row = Value::Null;
    for record in records {
        match record {
            Record::Create { row: initial } => {
                if !initial.is_object() || !initial["transcript"].is_array() { return Err("Invalid initial conversation record".into()); }
                if row.is_null() { row = initial; }
            }
            Record::Update { fields } => {
                if !row.is_object() || !fields.is_object() { return Err("Invalid execution record".into()); }
                merge(&mut row, fields);
            }
            Record::Metadata { mut meta } => {
                if !meta.is_object() || !row.is_object() { return Err("Invalid conversation metadata record".into()); }
                let activity = row["meta"]["activityAt"].as_u64().unwrap_or(0).max(row["touchedAt"].as_u64().unwrap_or(0)).max(meta["activityAt"].as_u64().unwrap_or(0));
                meta["activityAt"] = json!(activity);
                row["meta"] = meta;
            }
            Record::Event { fields, event } => {
                if !row.is_object() || !fields.is_object() { return Err("Missing initial conversation record".into()); }
                if fields["executionId"] == row["executionId"] && event.sequence <= row["lastSequence"].as_u64().unwrap_or(0) { continue; }
                let activity = fields["touchedAt"].as_u64();
                merge(&mut row, fields);
                if let Some(activity) = activity { row["meta"]["activityAt"] = json!(activity); }
                if event.kind == "userMessage" && row["meta"]["title"].as_str().unwrap_or("").is_empty() {
                    row["meta"]["title"] = json!(event.text.as_deref().unwrap_or("").lines().next().unwrap_or("").chars().take(160).collect::<String>());
                }
                let events = row["transcript"].as_array_mut().ok_or("History has no transcript")?;
                if event.kind == "messageCheckpoint" {
                    if let Some(message) = events.iter_mut().find(|value| value["type"] == "userMessage" && event.message_id.as_deref().is_some_and(|id| value["messageId"] == id)) { message["checkpoint"] = json!(event.checkpoint); }
                } else if event.kind == "historyReverted" {
                    if let Some(index) = events.iter().position(|value| value["type"] == "userMessage" && event.message_id.as_deref().is_some_and(|id| value["messageId"] == id)) { events.truncate(index); }
                }
                let mut value = serde_json::to_value(&event).map_err(|e| e.to_string())?;
                if matches!(event.kind.as_str(), "permission" | "input") {
                    let permission = event.kind == "permission";
                    let request_id = event.permission.as_ref().and_then(|value| value.get("requestId")).or_else(|| event.input.as_ref().and_then(|value| value.get("requestId"))).cloned().unwrap_or(Value::Null);
                    let title = event.permission.as_ref().and_then(|value| value["title"].as_str()).or_else(|| event.input.as_ref().and_then(|value| value["title"].as_str())).unwrap_or("Agent requested input");
                    value["type"] = json!("agentRequest");
                    value["request"] = json!({"requestId":request_id,"kind":if permission {"permission"} else {"question"},"title":title});
                    value["text"] = json!(title);
                    value.as_object_mut().unwrap().remove("permission");
                    value.as_object_mut().unwrap().remove("input");
                }
                if matches!(event.kind.as_str(), "assistantChunk" | "reasoningChunk") {
                    if let Some(last) = events.last_mut().filter(|last| last["type"] == value["type"] && last["messageId"] == value["messageId"] && last["attemptId"] == value["attemptId"]) {
                        last["text"] = json!(format!("{}{}", last["text"].as_str().unwrap_or(""), event.text.as_deref().unwrap_or("")));
                        last["endSequence"] = json!(event.sequence);
                        continue;
                    }
                }
                events.push(value);
            }
            Record::Workspace { .. } => return Err("Unexpected workspace record in conversation".into()),
        }
    }
    if !row.is_object() || !row["transcript"].is_array() { return Err("Conversation is missing its initial record".into()); }
    row["pendingPermission"] = Value::Null;
    row["pendingInput"] = Value::Null;
    Ok(row)
}

pub fn timestamp() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn fields(snapshot: &Snapshot) -> Value {
    json!({"conversationId": snapshot.conversation_id, "hostKey": snapshot.host_key,
        "executionId": snapshot.execution_id, "localSessionId": snapshot.local_session_id,
        "agentId": snapshot.agent_id, "agentName": snapshot.agent_name, "customAgent": snapshot.custom_agent,
        "agentSessionId": snapshot.agent_session_id, "resumable": snapshot.resumable,
        "cwd": snapshot.cwd, "state": snapshot.state, "turnActive": snapshot.turn_active,
        "lastError": snapshot.last_error, "lastSequence": snapshot.last_sequence, "historyCapabilities": snapshot.history_capabilities,
        "persistent":snapshot.persistent,"continuity":snapshot.continuity,"remoteImported":snapshot.remote_imported,"configGeneration":snapshot.config_generation,"pendingMessageId":snapshot.pending_message_id,"remoteCursor":snapshot.remote_cursor,"promptId":snapshot.prompt_id,"recoveryRequired":snapshot.recovery_required,"todos":snapshot.todos,"todoSync":snapshot.todo_sync,"capabilities":snapshot.capabilities})
}

pub async fn load_snapshot(app: &AppHandle, id: String) -> Result<Snapshot, StillError> {
    let mut snapshot = disk(app, move |root| {
        if file(root, &id, "deleted")?.exists() { return Err("This conversation was deleted from this device".into()); }
        let row = agent_history::page(&file(root, &id, "jsonl")?, None, &mut Vec::new())?;
        serde_json::from_value(row).map_err(|error| error.to_string())
    }).await?;
    crate::agent::restore_capabilities(&mut snapshot);
    crate::agent::restore_todos(&mut snapshot);
    Ok(snapshot)
}

/// Why a discovered execution migration was not applied. Only the first three
/// may be bypassed by an explicit user adoption; the rest protect identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockReason { PendingMessage, RecoveryRequired, UnconfirmedState, GenerationNotNewer, LineageUnproven, ProviderSessionChanged, DifferentAccount }
impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingMessage => "PendingMessage", Self::RecoveryRequired => "RecoveryRequired", Self::UnconfirmedState => "UnconfirmedState",
            Self::GenerationNotNewer => "GenerationNotNewer", Self::LineageUnproven => "LineageUnproven",
            Self::ProviderSessionChanged => "ProviderSessionChanged", Self::DifferentAccount => "DifferentAccount",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::PendingMessage => "a message here was not confirmed by the server",
            Self::RecoveryRequired => "this device's copy needs recovery",
            Self::UnconfirmedState => "this device's copy has an unconfirmed state",
            Self::GenerationNotNewer => "the server's version is not newer than this device's copy",
            Self::LineageUnproven => "the server could not prove how it moved from this device's copy",
            Self::ProviderSessionChanged => "the provider session differs from this device's copy",
            Self::DifferentAccount => "the server's copy belongs to a different account",
        }
    }
}
#[derive(Clone, Debug)]
pub struct MigrationBlock { pub reason: BlockReason, pub remote_execution_id: String, pub remote_generation: u64 }
pub enum ImportOutcome { Imported(Snapshot), Skipped, Blocked(MigrationBlock) }

/// Server-provided ancestry (nearest ancestor first, at most 64 entries). It
/// proves a multi-hop migration only when `saved` appears in it and every hop
/// between it and the current execution kept the saved provider session.
fn lineage_proves(remote: &Value, saved_execution: &str, saved_session: &Option<String>) -> bool {
    if remote["replacesExecutionId"].as_str() == Some(saved_execution) { return true; }
    let Some(chain) = remote["lineage"].as_array().filter(|chain| chain.len() <= 64) else { return false };
    let mut seen = HashSet::new();
    let current = remote["executionId"].as_str().unwrap_or("");
    for entry in chain {
        let Some(id) = entry["executionId"].as_str() else { return false };
        if id == current || !seen.insert(id.to_owned()) { return false; }
        if entry["agentSessionId"].as_str().map(str::to_owned) != *saved_session || saved_session.is_none() && !entry["agentSessionId"].is_null() { return false; }
        if id == saved_execution { return true; }
    }
    false
}

fn clear_block(path: &Path, cached_meta: &Value) -> Result<(), String> {
    if cached_meta.get("migrationBlocked").is_some_and(|v| !v.is_null()) {
        let mut meta = cached_meta.clone();
        if let Some(object) = meta.as_object_mut() { object.remove("migrationBlocked"); }
        append(path, &Record::Metadata { meta })?;
    }
    Ok(())
}

/// Missing, deleted and damaged caches are different outcomes. Discovery must
/// never replace a damaged journal or resurrect a device-local tombstone.
/// `explicit` (user adoption) may bypass only pending/recovery/unconfirmed state.
pub async fn import_remote_snapshot(app: &AppHandle, snapshot: Snapshot, remote: Value, explicit: bool) -> Result<ImportOutcome, StillError> {
    disk(app, move |root| import_at(root, snapshot, remote, explicit)).await
}

fn import_at(root: &Path, snapshot: Snapshot, remote: Value, explicit: bool) -> Result<ImportOutcome, String> {
        let id = &snapshot.conversation_id;
        if file(root, id, "deleted")?.exists() { return Ok(ImportOutcome::Skipped); }
        let path = file(root, id, "jsonl")?;
        if path.exists() {
            let row = summary(&path, &mut Vec::new())?;
            let cached_meta = row["meta"].clone();
            let mut saved: Snapshot = serde_json::from_value(row).map_err(|e| e.to_string())?;
            if saved.host_key != snapshot.host_key || saved.cwd != snapshot.cwd || saved.agent_id != snapshot.agent_id {
                return Err("Discovered conversation conflicts with the saved account, project or provider".into());
            }
            if saved.execution_id != snapshot.execution_id {
                let remote_generation = remote["shared"]["generation"].as_u64().unwrap_or(0);
                let unconfirmed = matches!(saved.state.as_str(), "submissionUnknown" | "rewinding");
                let reason = if cached_meta["shared"]["serverAccountId"].is_string() && cached_meta["shared"]["serverAccountId"] != remote["shared"]["serverAccountId"] { Some(BlockReason::DifferentAccount) }
                    else if !lineage_proves(&remote, &saved.execution_id, &saved.agent_session_id) { Some(BlockReason::LineageUnproven) }
                    else if snapshot.agent_session_id != saved.agent_session_id { Some(BlockReason::ProviderSessionChanged) }
                    else if remote_generation <= cached_meta["shared"]["generation"].as_u64().unwrap_or(0) { Some(BlockReason::GenerationNotNewer) }
                    else if saved.pending_message_id.is_some() && !explicit { Some(BlockReason::PendingMessage) }
                    else if saved.recovery_required && !explicit { Some(BlockReason::RecoveryRequired) }
                    else if unconfirmed && !explicit { Some(BlockReason::UnconfirmedState) }
                    else { None };
                if let Some(reason) = reason {
                    let block = MigrationBlock { reason, remote_execution_id: snapshot.execution_id.clone(), remote_generation };
                    let previous = &cached_meta["migrationBlocked"];
                    let same = previous["reason"] == reason.as_str() && previous["remoteExecutionId"] == block.remote_execution_id && previous["remoteGeneration"] == remote_generation;
                    if !same && cached_meta.is_object() {
                        let mut meta = cached_meta.clone();
                        meta["migrationBlocked"] = json!({"reason":reason.as_str(),"remoteExecutionId":block.remote_execution_id,"remoteGeneration":remote_generation,"detectedAt":timestamp() as u64});
                        append(&path, &Record::Metadata { meta })?;
                    }
                    return Ok(ImportOutcome::Blocked(block));
                }
                // The header advances, while the complete original journal,
                // prior-attempt transcript, local drafts and metadata remain.
                append(&path, &Record::Update { fields: fields(&snapshot) })?;
                clear_block(&path, &cached_meta)?;
                Ok(ImportOutcome::Imported(snapshot))
            } else {
                if refresh_remote_resume_identity(&mut saved, &snapshot)? {
                    append(&path, &Record::Update { fields: json!({"agentSessionId":saved.agent_session_id,"resumable":saved.resumable}) })?;
                }
                clear_block(&path, &cached_meta)?;
                Ok(ImportOutcome::Imported(saved))
            }
        } else {
            let now = timestamp();
            let mut row = serde_json::to_value(&snapshot).map_err(|e| e.to_string())?;
            row["meta"] = json!({"id":id,"hostKey":snapshot.host_key,"folder":snapshot.cwd,"title":"", "pinned":false,"createdAt":now,"activityAt":now,"order":now,"draft":""});
            row["touchedAt"] = json!(now);
            append(&path, &Record::Create { row })?;
            Ok(ImportOutcome::Imported(snapshot))
        }
}

fn refresh_remote_resume_identity(saved: &mut Snapshot, incoming: &Snapshot) -> Result<bool, String> {
    if saved.execution_id != incoming.execution_id || saved.conversation_id != incoming.conversation_id
        || saved.host_key != incoming.host_key || saved.cwd != incoming.cwd || saved.agent_id != incoming.agent_id {
        return Err("Resume metadata belongs to a different conversation, execution or account".into());
    }
    let Some(session) = incoming.agent_session_id.as_ref().filter(|id| !id.is_empty()) else { return Ok(false); };
    if saved.agent_session_id.as_ref().is_some_and(|previous| previous != session) {
        return Err("The provider session identity changed. The saved history and draft were kept".into());
    }
    let changed = saved.agent_session_id.as_ref() != Some(session) || !saved.resumable && incoming.resumable;
    saved.agent_session_id = Some(session.clone());
    // Missing legacy evidence must not revoke an earlier provider confirmation.
    saved.resumable |= incoming.resumable;
    Ok(changed)
}

/// Server-owned fields are projected independently from drafts, attachments and
/// other device-owned metadata. A stale WebView must not roll this binding back.
pub async fn apply_shared_metadata(app: &AppHandle, id: String, host_key: String, shared: Value) -> Result<(), StillError> {
    disk(app, move |root| {
        let path = file(root, &id, "jsonl")?;
        if !path.exists() || file(root, &id, "deleted")?.exists() { return Ok(()); }
        let row = summary(&path, &mut Vec::new())?;
        if let Some(meta) = project_shared_metadata(&row, &id, &host_key, shared)? {
            append(&path, &Record::Metadata { meta })?;
        }
        Ok(())
    }).await
}

fn project_shared_metadata(row: &Value, id: &str, host_key: &str, shared: Value) -> Result<Option<Value>, String> {
        if row["hostKey"] != host_key || shared["conversationId"] != id || shared["executionId"] != row["executionId"]
            || shared["serverAccountId"].as_str().and_then(|id| uuid::Uuid::parse_str(id).ok()).is_none()
            || !shared["revision"].is_u64() || !shared["generation"].is_u64() || !shared["fields"].is_object() || !shared["values"].is_object()
            || !["title", "pinned", "archivedAt", "order"].iter().all(|key| shared["fields"][*key].is_u64())
            || shared["values"]["title"].as_str().is_none_or(|title| title.len() > 640 || title.chars().any(char::is_control))
            || !shared["values"]["pinned"].is_boolean() || !shared["values"]["order"].is_u64() {
            return Err("Shared metadata did not match this account/conversation/execution".into());
        }
        let mut meta = row["meta"].clone();
        if let Some(previous) = meta.get("shared").filter(|value| value.is_object()) {
            if previous["serverAccountId"] != shared["serverAccountId"] { return Err("The server's account identity changed; the saved binding was kept".into()); }
            if previous["revision"].as_u64().unwrap_or(0) > shared["revision"].as_u64().unwrap_or(0) { return Ok(None); }
        }
        if !meta["shared"].is_object() && !row["remoteImported"].as_bool().unwrap_or(false) {
            let mut local = json!({});
            if meta["titleSource"] == "user" && meta["title"] != shared["values"]["title"] { local["title"] = meta["title"].clone(); }
            if meta["pinned"] == true && shared["values"]["pinned"] != true { local["pinned"] = json!(true); }
            if meta["archivedAt"].as_u64().is_some_and(|value| value > 0) && meta["archivedAt"] != shared["values"]["archivedAt"] { local["archivedAt"] = meta["archivedAt"].clone(); }
            if local.as_object().is_some_and(|value| !value.is_empty()) {
                meta["sharedLocalChanges"] = local;
                meta["sharedConflict"] = json!(true);
                meta["sharedSyncError"] = json!("Existing organization remains saved on this device. Choose Apply my saved changes to share it with this account.");
            }
        }
        for key in ["title", "titleSource", "pinned", "archivedAt", "order"] {
            if matches!(key, "title" | "titleSource") && shared["values"]["titleSource"] != "user"
                && shared["values"]["title"].as_str().is_some_and(|title| title.trim().is_empty()) { continue; }
            let field = if key == "titleSource" { "title" } else { key };
            let pending = meta["sharedPending"].as_array().is_some_and(|items| items.iter().any(|item| item["patch"].get(field).is_some()));
            if !pending && meta["sharedLocalChanges"].get(field).is_none() {
                if let Some(value) = shared["values"].get(key) { meta[key] = value.clone(); }
            }
        }
        meta["shared"] = shared;
        if row["parentConversationId"].is_string() && meta["shared"]["prepared"].is_boolean() { meta["subagentPrepared"] = meta["shared"]["prepared"].clone(); }
        if meta["shared"]["deleted"] == true { meta["sharedDeleted"] = json!(true); }
        Ok(Some(meta))
}

pub async fn apply_shared_tombstones(app: &AppHandle, host: String, account: String, ids: Vec<String>) -> Result<(), StillError> {
    disk(app, move |root| {
        for id in ids {
            let path = file(root, &id, "jsonl")?;
            if !path.exists() || file(root, &id, "deleted")?.exists() { continue; }
            let row = summary(&path, &mut Vec::new())?;
            if row["hostKey"] != host || row["meta"]["shared"]["serverAccountId"] != account || row["meta"]["sharedDeleted"] == true { continue; }
            let mut meta = row["meta"].clone();
            meta["sharedDeleted"] = json!(true);
            append(&path, &Record::Metadata { meta })?;
        }
        Ok(())
    }).await
}

/// Even an empty device library has an account binding. A rebuilt SSH endpoint
/// must not silently merge a different account's projects with the old cache.
pub async fn bind_shared_account(app: &AppHandle, host: String, account: String, revision: Value, projects: Value) -> Result<(), StillError> {
    disk(app, move |root| {
        let key = format!("shared-account:{host}");
        let path = root.join("workspace.jsonl");
        let mut existing = None;
        if path.exists() {
            for record in records(&path, &mut Vec::new())? {
                if let Record::Workspace { key: saved_key, value } = record {
                    if saved_key == key { existing = Some(value); }
                }
            }
        }
        if let Some(existing) = existing {
            if existing["serverAccountId"] != account { return Err("This SSH endpoint now reports a different account identity. Existing projects and drafts were preserved; explicit account adoption is required".into()); }
            return Ok(());
        }
        append(&path, &Record::Workspace { key, value: json!({"serverAccountId":account,"revision":revision,"projects":projects}) })
    }).await
}

async fn disk<T: Send + 'static>(app: &AppHandle, operation: impl FnOnce(&Path) -> Result<T, String> + Send + 'static) -> Result<T, StillError> {
    let root = app.path().app_data_dir().map_err(|e| StillError::friendly("agent_storage", e.to_string()))?.join("agents");
    tokio::task::spawn_blocking(move || {
        let _guard = WRITER.lock().map_err(|_| "History writer is unavailable".to_string())?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new().create(true).write(true).truncate(false).open(root.join(".writer.lock")).map_err(|e| e.to_string())?;
        lock.lock().map_err(|e| e.to_string())?;
        operation(&root)
    }).await.map_err(|e| StillError::friendly("agent_storage", e.to_string()))?
        .map_err(|e| StillError::friendly("agent_storage", format!("Conversation changes could not be saved on this device: {e}")))
}

fn stale_library_capabilities(row: &mut Value) {
    let Some(raw) = row.get("capabilities").filter(|value| value.is_object()).cloned() else { return };
    let expected = (
        row["executionId"].as_str(),
        row["agentId"].as_str(),
        row["agentSessionId"].as_str(),
        row["cwd"].as_str(),
    );
    let validated = match expected {
        (Some(execution), Some(agent), Some(session), Some(cwd)) =>
            crate::agent::validate_capabilities(&raw, execution, agent, session, cwd).ok(),
        _ => None,
    };
    if let Some(mut report) = validated {
        report.freshness = "stale".into();
        row["capabilities"] = serde_json::to_value(report).unwrap_or(Value::Null);
    } else if let Some(object) = row.as_object_mut() {
        object.remove("capabilities");
    }
}

pub async fn register(app: &AppHandle, snapshot: &Snapshot, resume: bool) -> Result<(), StillError> {
    let mut snapshot = snapshot.clone();
    snapshot.transcript.clear();
    disk(app, move |root| {
        let path = file(root, &snapshot.conversation_id, "jsonl")?;
        if file(root, &snapshot.conversation_id, "deleted")?.exists() { return Err("This conversation was deleted".into()); }
        if resume {
            let row = summary(&path, &mut Vec::new())?;
            if row["meta"]["hostKey"] != snapshot.host_key || row["cwd"] != snapshot.cwd || row["agentId"] != snapshot.agent_id {
                return Err("The saved conversation belongs to another server, folder, or agent".into());
            }
            if row["agentSessionId"] != json!(snapshot.agent_session_id) { return Err("The saved provider session does not match this resume request".into()); }
            append(&path, &Record::Update { fields: fields(&snapshot) })
        } else {
            if path.exists() { return Err("A conversation already uses this identity".into()); }
            let now = timestamp();
            let mut row = serde_json::to_value(&snapshot).map_err(|e| e.to_string())?;
            row["meta"] = json!({"id": snapshot.conversation_id, "hostKey": snapshot.host_key, "folder": snapshot.cwd, "title":"", "pinned":false, "createdAt":now, "activityAt":now, "order":now, "draft":""});
            row["touchedAt"] = json!(now);
            append(&path, &Record::Create { row })
        }
    }).await
}

pub async fn lease(app: &AppHandle, id: String) -> Result<fs::File, StillError> {
    disk(app, move |root| {
        let file = OpenOptions::new().create(true).truncate(false).write(true).open(file(root, &id, "lease")?).map_err(|e| e.to_string())?;
        file.try_lock().map_err(|_| "This conversation is already attached in another Still window. Close that connection before continuing here.".to_string())?;
        Ok(file)
    }).await
}

pub async fn history_messages(app: &AppHandle, id: String) -> Result<Vec<Event>, StillError> {
    disk(app, move |root| {
        agent_history::messages(&file(root, &id, "jsonl")?)?.into_iter()
            .map(|event| serde_json::from_value(event).map_err(|error| error.to_string())).collect()
    }).await
}

pub async fn event(app: &AppHandle, snapshot: &Snapshot, event: &Event) -> Result<(), StillError> {
    let id = snapshot.conversation_id.clone();
    let mut header = fields(snapshot);
    if let Some(configs) = &event.config_options { header["configOptions"] = json!(configs); }
    if let Some(commands) = &event.commands { header["commands"] = commands.clone(); }
    if is_activity_event(&event.kind) { header["touchedAt"] = json!(timestamp()); }
    let event = history_event(event);
    disk(app, move |root| {
        if file(root, &id, "deleted")?.exists() { return Ok(()); }
        append(&file(root, &id, "jsonl")?, &Record::Event { fields: header, event })
    }).await
}

/// Keep request identity and outcomes in history; unfinished form values remain in memory.
fn history_event(event: &Event) -> Event {
    let mut event = event.clone();
    if matches!(event.kind.as_str(), "permission" | "input") {
        let permission = event.kind == "permission";
        let request = event.permission.as_ref().or(event.input.as_ref());
        event.request = request.map(|request| json!({
            "requestId":request["requestId"],
            "kind":if permission {"permission"} else {"question"},
            "title":request["title"].as_str().unwrap_or("Agent needs input")
        }));
        event.kind = "agentRequest".into();
        event.permission = None;
        event.input = None;
    }
    event
}

fn is_activity_event(kind: &str) -> bool {
    matches!(kind, "userMessage" | "threadComplete" | "threadError" | "permission" | "input" | "requestOutcome")
}

#[tauri::command]
pub async fn still_agent_library(app: AppHandle) -> Result<Value, StillError> {
    let mut library = disk(&app, |root| {
        let mut rows = Vec::new();
        let mut warnings = Vec::new();
        let mut workspace = json!({});
        for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("jsonl") { continue; }
            if path.with_extension("deleted").exists() { continue; }
            if path.file_stem().and_then(|v| v.to_str()) == Some("workspace") {
                match records(&path, &mut warnings) {
                    Ok(records) => for record in records { if let Record::Workspace { key, value } = record { workspace[key] = value; } },
                    Err(error) => warnings.push(error),
                }
            } else {
                match summary(&path, &mut warnings) { Ok(row) => rows.push(row), Err(error) => warnings.push(error) }
            }
        }
        for row in &mut rows { stale_library_capabilities(row); crate::agent::restore_todo_fields(row); }
        Ok(json!({"rows":rows,"workspaces":workspace,"storagePath":root.to_string_lossy(),"warnings":warnings}))
    }).await?;
    library["liveExecutions"] = json!(crate::agent::live_executions().await);
    Ok(library)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryArgs { conversation_id: String, before: Option<usize>, after: Option<usize> }

#[tauri::command]
pub async fn still_agent_history(app: AppHandle, args: HistoryArgs) -> Result<Value, StillError> {
    disk(&app, move |root| {
        if args.before.is_some() && args.after.is_some() { return Err("Choose a history cursor in one direction".into()); }
        if file(root, &args.conversation_id, "deleted")?.exists() { return Err("This conversation was deleted from this device".into()); }
        let row = agent_history::window(&file(root, &args.conversation_id, "jsonl")?, args.before, args.after, &mut Vec::new())?;
        Ok(json!({"executionId":row["executionId"],"lastSequence":row["lastSequence"],"transcript":row["transcript"],"before":row["historyBefore"],"after":row["historyAfter"],"total":row["historyTotal"],"latest":row["historyLatest"]}))
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHistoryArgs { conversation_id: String }

#[tauri::command]
pub async fn still_agent_change_history(app: AppHandle, args: ChangeHistoryArgs) -> Result<Value, StillError> {
    disk(&app, move |root| {
        if file(root, &args.conversation_id, "deleted")?.exists() { return Err("This conversation was deleted from this device".into()); }
        let path = file(root, &args.conversation_id, "jsonl")?;
        let index = agent_history::index(&path, &mut Vec::new())?;
        let changes = agent_history::change_summaries(&path)?;
        Ok(json!({"executionId":index.row["executionId"],"changes":changes}))
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDetailsArgs { conversation_id: String, path: String }

#[tauri::command]
pub async fn still_agent_change_details(app: AppHandle, args: ChangeDetailsArgs) -> Result<Value, StillError> {
    disk(&app, move |root| {
        if args.path.is_empty() || args.path.len() > 4096 || args.path.chars().any(char::is_control) { return Err("Invalid changed-file identity".into()); }
        if file(root, &args.conversation_id, "deleted")?.exists() { return Err("This conversation was deleted from this device".into()); }
        let path = file(root, &args.conversation_id, "jsonl")?;
        let index = agent_history::index(&path, &mut Vec::new())?;
        let events = agent_history::change_details(&path, &args.path)?;
        Ok(json!({"executionId":index.row["executionId"],"path":args.path,"events":events}))
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataArgs { conversation_id: String, meta: Value }

fn validate_meta(id: &str, meta: &Value) -> Result<(), String> {
    if meta["id"].as_str() != Some(id) || !["hostKey", "folder", "title", "draft"].iter().all(|key| meta[*key].is_string())
        || meta["draft"].as_str().unwrap_or("").len() > 1_000_000 || meta["title"].as_str().unwrap_or("").len() > 4096 {
        return Err("Invalid conversation metadata".into());
    }
    Ok(())
}

fn validate_transcript(row: &Value) -> Result<(), String> {
    let events = row["transcript"].as_array().ok_or("Invalid transcript")?;
    for event in events { serde_json::from_value::<Event>(event.clone()).map_err(|e| format!("Invalid saved event: {e}"))?; }
    Ok(())
}

#[tauri::command]
pub async fn still_agent_save_metadata(app: AppHandle, args: MetadataArgs) -> Result<(), StillError> {
    disk(&app, move |root| {
        validate_meta(&args.conversation_id, &args.meta)?;
        let path = file(root, &args.conversation_id, "jsonl")?;
        if !path.exists() || file(root, &args.conversation_id, "deleted")?.exists() { return Err("Conversation is no longer in the local library".into()); }
        let mut meta = args.meta;
        let previous = summary(&path, &mut Vec::new())?;
        // The migration marker is backend-owned; a stale WebView must neither forge nor resurrect it.
        match previous["meta"].get("migrationBlocked").filter(|v| v.is_object()) {
            Some(marker) => meta["migrationBlocked"] = marker.clone(),
            None => if let Some(object) = meta.as_object_mut() { object.remove("migrationBlocked"); },
        }
        if previous["meta"]["shared"].is_object() {
            meta["shared"] = previous["meta"]["shared"].clone();
            if previous["meta"]["sharedLocalChanges"].is_object() && meta["sharedAdoptionResolved"] != true {
                meta["sharedLocalChanges"] = previous["meta"]["sharedLocalChanges"].clone();
                meta["sharedConflict"] = json!(true);
                meta["sharedSyncError"] = previous["meta"]["sharedSyncError"].clone();
            }
            for key in ["title", "titleSource", "pinned", "archivedAt", "order"] {
                if matches!(key, "title" | "titleSource") && meta["shared"]["values"]["titleSource"] != "user"
                    && meta["shared"]["values"]["title"].as_str().is_some_and(|title| title.trim().is_empty()) { continue; }
                let field = if key == "titleSource" { "title" } else { key };
                let pending = meta["sharedPending"].as_array().is_some_and(|items| items.iter().any(|item| item["patch"].get(field).is_some()));
                if !pending && meta["sharedLocalChanges"].get(field).is_none() {
                    if let Some(value) = meta["shared"]["values"].get(key).cloned() { meta[key] = value; }
                }
            }
        }
        append(&path, &Record::Metadata { meta })
    }).await
}

#[derive(Deserialize)]
pub struct WorkspaceArgs { key: String, value: Value }

#[tauri::command]
pub async fn still_agent_save_workspace(app: AppHandle, args: WorkspaceArgs) -> Result<(), StillError> {
    disk(&app, move |root| {
        if args.key.len() > 8192 || !args.value.is_object() || args.value.to_string().len() > 2_000_000 { return Err("Invalid workspace preferences".into()); }
        append(&root.join("workspace.jsonl"), &Record::Workspace { key: args.key, value: args.value })
    }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs { conversation_id: String }

fn delete(root: &Path, id: &str) -> Result<(), String> {
    let marker = file(root, id, "deleted")?;
    OpenOptions::new().create(true).write(true).truncate(true).open(marker).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    sync_directory(root)?;
    let path = file(root, id, "jsonl")?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    let stem = file(root, id, "")?.file_stem().ok_or("Invalid history path")?.to_string_lossy().to_string();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with(&format!("{stem}.interrupted-")) || name.starts_with(&format!("{stem}.checkpoint-")) { fs::remove_file(path).map_err(|e| e.to_string())?; }
    }
    sync_directory(root)
}

#[tauri::command]
pub async fn still_agent_delete_saved(app: AppHandle, args: DeleteArgs) -> Result<(), StillError> {
    let _lease = lease(&app, args.conversation_id.clone()).await?;
    disk(&app, move |root| delete(root, &args.conversation_id)).await
}

#[derive(Deserialize)]
pub struct MigrationArgs { rows: Vec<Value>, deleted: Vec<String>, workspaces: Value }

#[tauri::command]
pub async fn still_agent_migrate(app: AppHandle, args: MigrationArgs) -> Result<Vec<String>, StillError> {
    disk(&app, move |root| migrate(root, args)).await
}

fn migrate(root: &Path, args: MigrationArgs) -> Result<Vec<String>, String> {
        let mut warnings = Vec::new();
        let live: HashSet<String> = args.rows.iter().filter(|row| !args.deleted.iter().any(|id| row["executionId"].as_str() == Some(id))).filter_map(|row| row["meta"]["id"].as_str().map(str::to_owned)).collect();
        for id in &args.deleted { if !live.contains(id) { if let Err(error) = delete(root, id) { warnings.push(error); } } }
        for mut row in args.rows {
            if args.deleted.iter().any(|id| row["executionId"].as_str() == Some(id)) { continue; }
            let Some(id) = row["meta"]["id"].as_str().map(str::to_owned) else { warnings.push("A legacy conversation has no valid identity; its original cache was kept.".into()); continue; };
            if validate_meta(&id, &row["meta"]).is_err() || !row["executionId"].is_string() || !row["localSessionId"].is_string() || !row["cwd"].is_string() || validate_transcript(&row).is_err() {
                warnings.push(format!("Could not migrate conversation {id}; its original cache was kept.")); continue;
            }
            let path = match file(root, &id, "jsonl") { Ok(path) => path, Err(error) => { warnings.push(error); continue; } };
            if file(root, &id, "deleted")?.exists() { continue; }
            if path.exists() {
                if let Err(error) = agent_history::index(&path, &mut warnings) { warnings.push(error); }
                continue;
            }
            row["conversationId"] = json!(id);
            row["pendingPermission"] = Value::Null;
            row["pendingInput"] = Value::Null;
            let execution = row["executionId"].as_str().unwrap().to_owned();
            let previous = row["previousEventCount"].as_u64().unwrap_or(0) as usize;
            let mut phase = 0_u64; let mut last = 0;
            for (index, event) in row["transcript"].as_array_mut().unwrap().iter_mut().enumerate() {
                let sequence = event["sequence"].as_u64().unwrap_or(0);
                if index > 0 && sequence <= last { phase += 1; }
                last = event["endSequence"].as_u64().unwrap_or(sequence);
                if event["attemptId"].is_null() { event["attemptId"] = json!(if index < previous { format!("legacy:{id}:{phase}") } else { execution.clone() }); }
            }
            row["transcript"].as_array_mut().unwrap().retain(|event| !matches!(event["type"].as_str(), Some("permission" | "input")));
            append(&path, &Record::Create { row })?;
        }
        let workspace_path = root.join("workspace.jsonl");
        let existing: HashSet<_> = if workspace_path.exists() { records(&workspace_path, &mut warnings)?.into_iter().filter_map(|r| if let Record::Workspace { key, .. } = r { Some(key) } else { None }).collect() } else { HashSet::new() };
        if let Some(workspaces) = args.workspaces.as_object() {
            for (key, value) in workspaces {
                if !value.is_object() { warnings.push("Invalid legacy workspace preferences were retained in the old cache.".into()); continue; }
                if !existing.contains(key) { append(&workspace_path, &Record::Workspace { key: key.clone(), value: value.clone() })?; }
            }
        }
        Ok(warnings)
}

#[cfg(test)]
fn legacy_row(id: &str, execution: &str) -> Value {
    json!({"executionId":execution,"localSessionId":"terminal","agentId":"opencode","cwd":"/project","lastSequence":0,"transcript":[],"meta":{"id":id,"hostKey":"host","folder":"/project","title":"Saved","pinned":true,"createdAt":1,"activityAt":1,"order":1,"draft":"Draft"}})
}

pub fn report(app: &AppHandle, id: &str, sequence: u64, result: &Result<(), StillError>) {
    let _ = app.emit("still://agent-storage", json!({"conversationId":id,"sequence":sequence,"error":result.as_ref().err().map(|e| &e.message)}));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn summary_cache_tracks_durable_metadata_without_retaining_output_and_detects_external_appends() {
        let root = root();
        let path = file(&root, "cached", "jsonl").unwrap();
        append(&path, &Record::Create { row: legacy_row("cached", "attempt") }).unwrap();
        assert!(summary(&path, &mut Vec::new()).unwrap()["transcript"].as_array().unwrap().is_empty());
        let event: Event = serde_json::from_value(json!({"type":"assistantMessage","sequence":1,"text":"x".repeat(1_000_000)})).unwrap();
        append(&path, &Record::Event { fields: json!({"executionId":"attempt","lastSequence":1,"touchedAt":2}), event }).unwrap();
        append(&path, &Record::Metadata { meta: json!({"id":"cached","title":"Renamed","activityAt":1,"draft":"Draft retained"}) }).unwrap();
        let cached = summary(&path, &mut Vec::new()).unwrap();
        assert_eq!(cached, agent_history::index(&path, &mut Vec::new()).unwrap().row);
        assert!(agent_history::json_size(&cached) < 1024);
        assert_eq!(cached["meta"]["activityAt"], 2);
        let mut external = OpenOptions::new().append(true).open(&path).unwrap();
        serde_json::to_writer(&mut external, &json!({"version":1,"record":{"op":"update","fields":{"lastSequence":2,"state":"detached"}}})).unwrap();
        external.write_all(b"\n").unwrap(); external.sync_all().unwrap(); drop(external);
        assert_eq!(summary(&path, &mut Vec::new()).unwrap()["state"], "detached");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn request_history_retains_identity_and_outcome_without_form_payloads() {
        let question: Event = serde_json::from_value(json!({"sequence":1,"attemptId":"execution","type":"input","input":{"requestId":"q-1","title":"Choose a branch","schema":{"properties":{"secret":{"type":"string","default":"never-store-this"}}}}})).unwrap();
        let safe = history_event(&question);
        assert_eq!(safe.kind,"agentRequest");
        assert_eq!(safe.request.as_ref().unwrap()["requestId"],"q-1");
        assert_eq!(safe.request.as_ref().unwrap()["kind"],"question");
        assert!(!serde_json::to_string(&safe).unwrap().contains("never-store-this"));
        let outcome: Event = serde_json::from_value(json!({"sequence":2,"attemptId":"execution","type":"requestOutcome","requestOutcome":{"requestId":"q-1","kind":"question","title":"Choose a branch","outcome":"answered"}})).unwrap();
        let recovered = replay(vec![Record::Create { row:json!({"executionId":"execution","lastSequence":0,"transcript":[]}) },Record::Event {fields:json!({"executionId":"execution","lastSequence":1}),event:safe},Record::Event {fields:json!({"executionId":"execution","lastSequence":2}),event:outcome}]).unwrap();
        assert_eq!(recovered["transcript"][0]["request"]["requestId"],"q-1");
        assert_eq!(recovered["transcript"][1]["requestOutcome"]["outcome"],"answered");
    }
    #[test]
    fn capability_events_do_not_count_as_conversation_activity() {
        assert!(is_activity_event("userMessage"));
        assert!(!is_activity_event("capabilities"));
        assert!(!is_activity_event("todos"));
    }
    fn shared_fixture() -> (Value, Value) {
        (json!({"hostKey":"host","executionId":"execution","remoteImported":true,
            "meta":{"id":"conversation","title":"Local","titleSource":"agent","pinned":false,"draft":"Never upload this draft","draftAttachments":[{"id":"private-file"}]}}),
         json!({"serverAccountId":"00000000-0000-4000-8000-000000000001","conversationId":"conversation","executionId":"execution",
            "generation":1,"revision":2,"fields":{"title":1,"pinned":0,"archivedAt":0,"order":0},
            "values":{"title":"Remote title","titleSource":"agent","pinned":true,"archivedAt":null,"order":5}}))
    }
    #[test]
    fn shared_projection_preserves_device_drafts_and_attachments() {
        let (row, shared) = shared_fixture();
        let meta = project_shared_metadata(&row, "conversation", "host", shared).unwrap().unwrap();
        assert_eq!(meta["title"], "Remote title");
        assert_eq!(meta["draft"], "Never upload this draft");
        assert_eq!(meta["draftAttachments"][0]["id"], "private-file");
        assert_eq!(row["meta"]["title"], "Local", "projection does not mutate its original recovery input");
    }
    #[test]
    fn an_unindexed_catalog_title_preserves_known_titles_but_user_clearing_is_explicit() {
        let (row, mut shared) = shared_fixture();
        shared["values"]["title"] = json!("");
        shared["values"]["titleSource"] = json!("prompt");
        let meta = project_shared_metadata(&row, "conversation", "host", shared.clone()).unwrap().unwrap();
        assert_eq!(meta["title"], "Local");
        assert_eq!(meta["titleSource"], "agent");
        assert_eq!(meta["draft"], row["meta"]["draft"]);
        shared["values"]["titleSource"] = json!("user");
        let cleared = project_shared_metadata(&row, "conversation", "host", shared).unwrap().unwrap();
        assert_eq!(cleared["title"], "");
        assert_eq!(cleared["titleSource"], "user");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn shared_projection_accepts_real_remote_filesystem_timestamps() {
        let root = root();
        let script = format!("{}\n{}", include_str!("../agent-host/shared-library.mjs"), r#"
            import { utimesSync } from 'node:fs';
            const fixtureHome = process.argv[1];
            const fixtureDirectory = join(fixtureHome, '.local/state/still/agents/execution');
            mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
            const fixtureFile = join(fixtureDirectory, 'state.json');
            writeFileSync(fixtureFile, JSON.stringify({ version: 4, executionId: 'execution', conversationId: 'conversation',
                cwd: '/srv/project', agentId: 'opencode', eventIndex: 2 }), { mode: 0o600 });
            utimesSync(fixtureFile, 1730000000.123456, 1730000000.123456);
            console.log(JSON.stringify(sharedLibrary(fixtureHome).rows[0].shared));
        "#);
        let output = std::process::Command::new("node").args(["--input-type=module", "-e", &script]).arg(&root).output().expect("Node.js is required for the remote metadata contract test");
        fs::remove_dir_all(root).unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let shared: Value = serde_json::from_slice(&output.stdout).unwrap();
        let (row, _) = shared_fixture();
        let meta = project_shared_metadata(&row, "conversation", "host", shared).unwrap().unwrap();
        assert_eq!(meta["shared"]["values"]["order"].as_u64(), Some(1_730_000_000_123));
        assert_eq!(meta["draft"], row["meta"]["draft"]);
        assert_eq!(meta["draftAttachments"], row["meta"]["draftAttachments"]);
    }
    #[test]
    fn shared_projection_retains_a_conflicting_local_organization_for_explicit_adoption() {
        let (mut row, shared) = shared_fixture();
        row["remoteImported"] = json!(false);
        row["meta"]["titleSource"] = json!("user");
        let meta = project_shared_metadata(&row, "conversation", "host", shared).unwrap().unwrap();
        assert_eq!(meta["title"], "Local");
        assert_eq!(meta["titleSource"], "user");
        assert_eq!(meta["sharedLocalChanges"]["title"], "Local");
        assert_eq!(meta["sharedConflict"], true);
    }
    #[test]
    fn shared_projection_rejects_scope_changes_and_ignores_old_server_revisions() {
        let (mut row, mut shared) = shared_fixture();
        assert!(project_shared_metadata(&row, "conversation", "foreign-host", shared.clone()).is_err());
        row["meta"]["shared"] = shared.clone();
        shared["revision"] = json!(1);
        assert!(project_shared_metadata(&row, "conversation", "host", shared.clone()).unwrap().is_none());
        shared["serverAccountId"] = json!("00000000-0000-4000-8000-000000000002");
        assert!(project_shared_metadata(&row, "conversation", "host", shared).is_err());
    }
    #[test]
    fn discovery_refreshes_confirmed_resume_identity_without_changing_execution_state() {
        let mut saved: Snapshot = serde_json::from_value(json!({"conversationId":"conversation","hostKey":"host","executionId":"execution",
            "localSessionId":"local","agentId":"opencode","agentName":"OpenCode","agentSessionId":null,"cwd":"/srv/project",
            "state":"error","transcript":[],"pendingPermission":null,"lastError":"Kept recovery reason","lastSequence":4,
            "turnActive":false,"configOptions":[],"commands":[],"pendingInput":null,"resumable":false})).unwrap();
        let mut incoming = saved.clone();
        incoming.agent_session_id = Some("confirmed-session".into()); incoming.resumable = true;
        assert!(refresh_remote_resume_identity(&mut saved, &incoming).unwrap());
        assert_eq!(saved.agent_session_id.as_deref(), Some("confirmed-session"));
        assert!(saved.resumable);
        assert_eq!(saved.state, "error");
        assert_eq!(saved.last_sequence, 4);
        incoming.resumable = false;
        assert!(!refresh_remote_resume_identity(&mut saved, &incoming).unwrap(), "missing legacy evidence cannot revoke confirmed support");
        incoming.agent_session_id = Some("another-session".into());
        assert!(refresh_remote_resume_identity(&mut saved, &incoming).is_err());
        assert_eq!(saved.agent_session_id.as_deref(), Some("confirmed-session"));
        incoming.agent_session_id = Some("confirmed-session".into()); incoming.host_key = "another-host".into();
        assert!(refresh_remote_resume_identity(&mut saved, &incoming).is_err());
    }
    #[test]
    fn windows_export_matches_real_native_journal_replay_without_modifying_the_source() {
        let root = root();
        let source = root.join("source"); fs::create_dir(&source).unwrap();
        let id = "windows-export-contract";
        let account = r#"["home-work.example.test",22,"Darsh"]"#;
        let mut initial = legacy_row(id, "original-execution");
        initial["hostKey"] = json!(account); initial["agentName"] = json!("OpenCode");
        initial["agentSessionId"] = json!("provider-session"); initial["state"] = json!("complete"); initial["resumable"] = json!(true);
        initial["meta"]["hostKey"] = json!(account); initial["meta"]["title"] = json!("Windows chat title");
        initial["meta"]["titleSource"] = json!("user"); initial["meta"]["draft"] = json!("DEVICE_ONLY_DRAFT");
        let path = file(&source, id, "jsonl").unwrap();
        append(&path, &Record::Create { row: initial }).unwrap();
        for (sequence, kind, text) in [(1, "userMessage", "Original user message"), (2, "assistantChunk", "First "), (3, "assistantChunk", "second")] {
            let event: Event = serde_json::from_value(json!({"sequence":sequence,"attemptId":"original-execution","type":kind,"text":text})).unwrap();
            append(&path, &Record::Event { fields: json!({"executionId":"original-execution","lastSequence":sequence}), event }).unwrap();
        }
        let before = fs::read(&path).unwrap();
        let native = replay(records(&path, &mut Vec::new()).unwrap()).unwrap();
        let exporter = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/migration/export-windows-library.mjs");
        let script = r#"
            import { readFileSync } from 'node:fs';
            import { pathToFileURL } from 'node:url';
            const tool = await import(pathToFileURL(process.argv[2]).href);
            const inventory = tool.inspectLibrary(process.argv[3]);
            const result = tool.exportLibrary({ library: process.argv[3], account: inventory.accounts[0].accountId, output: process.argv[4], includeHistory: true });
            process.stdout.write(readFileSync(result.exportFile));
        "#;
        let output = std::process::Command::new("node").args(["--input-type=module", "-e", script, "export-contract"])
            .arg(exporter).arg(&source).arg(root.join("export")).output().expect("Node.js is required for the Windows export contract test");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let exported: Value = serde_json::from_slice(&output.stdout).unwrap();
        let conversation = &exported["conversations"][0];
        assert_eq!(conversation["conversationId"], native["meta"]["id"]);
        assert_eq!(conversation["organization"]["title"], native["meta"]["title"]);
        assert_eq!(conversation["history"]["events"][0]["text"], native["transcript"][0]["text"]);
        assert_eq!(conversation["history"]["events"][1]["text"], native["transcript"][1]["text"]);
        assert_eq!(conversation["history"]["events"][1]["endSequence"], native["transcript"][1]["endSequence"]);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("DEVICE_ONLY_DRAFT"));
        assert_eq!(fs::read(path).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn library_capabilities_are_scope_validated_and_always_stale() {
        let report = json!({
            "schemaVersion":1,"executionId":"execution-1","agentSessionId":"session-1","cwd":"/srv/project",
            "configGeneration":0,"observedAt":1234,
            "providerRuntime":{"transport":"pi-rpc"},
            "features":{
                "sharedTodos":{"status":"unverified","reason":"Waiting for tool registration."},
                "providerPlans":{"status":"unsupported","evidence":"adapter","reason":"Not integrated."},
                "providerTaskProjection":{"status":"unsupported","evidence":"adapter","reason":"Not integrated."},
                "clientTodoWrite":{"status":"unsupported","evidence":"adapter","reason":"Agent-managed."}
            }
        });
        let mut row = json!({"executionId":"execution-1","agentId":"pi","agentSessionId":"session-1","cwd":"/srv/project","capabilities":report});
        stale_library_capabilities(&mut row);
        assert_eq!(row["capabilities"]["freshness"], "stale");

        row["capabilities"]["features"]["clientTodoWrite"]["status"] = json!("supported");
        row["capabilities"]["features"]["clientTodoWrite"]["evidence"] = json!("observed");
        stale_library_capabilities(&mut row);
        assert!(row.get("capabilities").is_none(), "invalid optional report is omitted without hiding the conversation");
    }
    fn remote_snapshot(execution: &str, session: Option<&str>) -> Snapshot {
        serde_json::from_value(json!({"conversationId":"c","hostKey":"host","executionId":execution,"localSessionId":"agents:host",
            "agentId":"opencode","agentName":"OpenCode","agentSessionId":session,"cwd":"/project","state":"saved","transcript":[],
            "pendingPermission":null,"pendingInput":null,"lastError":null,"lastSequence":0,"turnActive":false,"configOptions":[],"commands":[],
            "persistent":true,"continuity":true,"remoteImported":true,"configGeneration":0,"remoteCursor":0,"resumable":true,
            "historyCapabilities":{"revert":false,"retry":false}})).unwrap()
    }
    fn seed(root: &Path, execution: &str, session: &str, generation: u64, extra: Value) -> PathBuf {
        let path = file(root, "c", "jsonl").unwrap();
        let mut row = serde_json::to_value(remote_snapshot(execution, Some(session))).unwrap();
        row["meta"] = legacy_row("c", execution)["meta"].clone();
        row["meta"]["draft"] = json!("Unsent draft");
        row["meta"]["shared"] = json!({"serverAccountId":"11111111-1111-4111-8111-111111111111","generation":generation});
        if let (Some(target), Some(source)) = (row.as_object_mut(), extra.as_object()) { for (k, v) in source { target.insert(k.clone(), v.clone()); } }
        append(&path, &Record::Create { row }).unwrap();
        path
    }
    fn remote_row(replaces: Option<&str>, generation: u64, lineage: Value) -> Value {
        json!({"executionId":"c-run","replacesExecutionId":replaces,"lineage":lineage,
            "shared":{"serverAccountId":"11111111-1111-4111-8111-111111111111","generation":generation}})
    }
    fn journal_len(path: &Path) -> usize { fs::read_to_string(path).unwrap().lines().count() }
    #[test]
    fn blocked_migration_is_not_an_error_and_appends_only_a_marker() {
        let root = root();
        let path = seed(&root, "a", "s1", 1, json!({"pendingMessageId":"m1"}));
        let before = fs::read_to_string(&path).unwrap();
        let outcome = import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("a"), 2, json!([])), false).unwrap();
        let ImportOutcome::Blocked(block) = outcome else { panic!("expected Blocked") };
        assert_eq!(block.reason, BlockReason::PendingMessage);
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(&before), "existing journal is only appended to");
        assert_eq!(after.lines().count(), before.lines().count() + 1);
        let row = summary(&path, &mut Vec::new()).unwrap();
        assert_eq!(row["executionId"], "a");
        assert_eq!(row["meta"]["draft"], "Unsent draft");
        assert_eq!(row["meta"]["migrationBlocked"]["reason"], "PendingMessage");
        // An identical re-detection does not grow the journal.
        let again = journal_len(&path);
        import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("a"), 2, json!([])), false).unwrap();
        assert_eq!(journal_len(&path), again);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn multi_hop_lineage_requires_consistent_provider_session_and_clears_marker() {
        let root = root();
        let path = seed(&root, "a", "s1", 1, json!({}));
        let ok = json!([{"executionId":"b","agentSessionId":"s1"},{"executionId":"a","agentSessionId":"s1"}]);
        let bad = json!([{"executionId":"b","agentSessionId":"other"},{"executionId":"a","agentSessionId":"s1"}]);
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("b"), 3, bad), false).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::LineageUnproven));
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("changed")), remote_row(Some("b"), 3, ok.clone()), false).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::ProviderSessionChanged));
        assert_eq!(summary(&path, &mut Vec::new()).unwrap()["executionId"], "a");
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("b"), 3, ok), false).unwrap(), ImportOutcome::Imported(_)));
        let row = summary(&path, &mut Vec::new()).unwrap();
        assert_eq!(row["executionId"], "c-run");
        assert!(row["meta"].get("migrationBlocked").is_none());
        assert_eq!(row["meta"]["draft"], "Unsent draft");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lineage_is_bounded_and_cycle_safe() {
        let long: Vec<Value> = (0..65).map(|i| json!({"executionId":format!("x{i}"),"agentSessionId":"s1"})).collect();
        assert!(!lineage_proves(&json!({"executionId":"z","replacesExecutionId":"x0","lineage":long}), "nope", &Some("s1".into())));
        let cyc = json!({"executionId":"z","replacesExecutionId":"b","lineage":[{"executionId":"b","agentSessionId":"s1"},{"executionId":"b","agentSessionId":"s1"},{"executionId":"a","agentSessionId":"s1"}]});
        assert!(!lineage_proves(&cyc, "a", &Some("s1".into())));
    }
    #[test]
    fn explicit_adoption_bypasses_pending_only() {
        let root = root();
        let path = seed(&root, "a", "s1", 1, json!({"pendingMessageId":"m1","recoveryRequired":true}));
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("zzz"), 2, json!([])), true).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::LineageUnproven));
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("a"), 1, json!([])), true).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::GenerationNotNewer));
        let mut other = remote_row(Some("a"), 2, json!([]));
        other["shared"]["serverAccountId"] = json!("22222222-2222-4222-8222-222222222222");
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), other, true).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::DifferentAccount));
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("a"), 2, json!([])), false).unwrap(), ImportOutcome::Blocked(b) if b.reason == BlockReason::PendingMessage));
        assert!(matches!(import_at(&root, remote_snapshot("c-run", Some("s1")), remote_row(Some("a"), 2, json!([])), true).unwrap(), ImportOutcome::Imported(_)));
        let row = summary(&path, &mut Vec::new()).unwrap();
        assert_eq!(row["executionId"], "c-run");
        assert_eq!(row["meta"]["draft"], "Unsent draft");
        assert!(row["pendingMessageId"].is_null());
        fs::remove_dir_all(root).unwrap();
    }
    fn root() -> PathBuf {
        static ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("still-history-{}-{}-{}", std::process::id(), timestamp(), ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap(); root
    }
    #[test]
    fn restart_replays_durable_records_and_recovers_only_incomplete_suffix() {
        let root = root(); let path = file(&root, "conversation", "jsonl").unwrap();
        append(&path, &Record::Create { row: json!({"executionId":"one", "lastSequence":0,"transcript":[],"meta":{"id":"conversation"}}) }).unwrap();
        for sequence in 1..=1500 {
            let event: Event = serde_json::from_value(json!({"sequence":sequence,"attemptId":"one","type":"assistantChunk","text":"x"})).unwrap();
            append(&path, &Record::Event { fields: json!({"executionId":"one","lastSequence":sequence}), event }).unwrap();
        }
        OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"version\":").unwrap();
        let mut warnings = Vec::new(); let row = replay(records(&path, &mut warnings).unwrap()).unwrap();
        assert_eq!(row["transcript"][0]["text"].as_str().unwrap().len(), 1500);
        assert_eq!(row["lastSequence"], 1500); assert_eq!(warnings.len(), 1);
        assert!(records(&path, &mut Vec::new()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn resume_sequences_do_not_replace_prior_attempt_and_tombstone_blocks_import() {
        let root = root(); let path = file(&root, "a/hostile:identity", "jsonl").unwrap();
        append(&path, &Record::Create { row: json!({"executionId":"one", "lastSequence":0,"transcript":[]}) }).unwrap();
        for attempt in ["one", "two"] {
            append(&path, &Record::Update { fields: json!({"executionId":attempt,"lastSequence":0}) }).unwrap();
            let event: Event = serde_json::from_value(json!({"sequence":1,"attemptId":attempt,"type":"assistantChunk","text":attempt})).unwrap();
            for _ in 0..2 { append(&path, &Record::Event { fields: json!({"executionId":attempt,"lastSequence":1}), event:event.clone() }).unwrap(); }
        }
        let row = replay(records(&path, &mut Vec::new()).unwrap()).unwrap();
        assert_eq!(row["transcript"].as_array().unwrap().len(), 2);
        delete(&root, "a/hostile:identity").unwrap(); assert!(!path.exists());
        assert!(file(&root, "a/hostile:identity", "deleted").unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_complete_record_is_preserved_and_not_mistaken_for_empty_history() {
        let root = root(); let path = root.join("bad.jsonl"); fs::write(&path, b"invalid\n").unwrap();
        assert!(records(&path, &mut Vec::new()).is_err()); assert_eq!(fs::read(&path).unwrap(), b"invalid\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn checkpoint_retains_history_identity_drafts_and_latest_workspace_values() {
        let root = root(); let path = file(&root, "checkpoint", "jsonl").unwrap();
        append(&path, &Record::Create { row: json!({"executionId":"attempt","lastSequence":0,"transcript":[],"meta":{"id":"checkpoint"}}) }).unwrap();
        for sequence in 1..=4 {
            let event: Event = serde_json::from_value(json!({"sequence":sequence,"type":"assistantChunk","attemptId":"attempt","text":"token "})).unwrap();
            append(&path, &Record::Event { fields: json!({"executionId":"attempt","lastSequence":sequence}), event }).unwrap();
        }
        append(&path, &Record::Metadata { meta: json!({"id":"checkpoint","draft":"unsent","title":"Kept"}) }).unwrap();
        let before = replay(records(&path, &mut Vec::new()).unwrap()).unwrap();
        checkpoint(&path).unwrap();
        assert_eq!(replay(records(&path, &mut Vec::new()).unwrap()).unwrap(), before);
        let workspace = root.join("workspace.jsonl");
        append(&workspace, &Record::Workspace { key:"library".into(),value:json!({"draft":"first"}) }).unwrap();
        append(&workspace, &Record::Workspace { key:"library".into(),value:json!({"draft":"latest"}) }).unwrap();
        checkpoint(&workspace).unwrap();
        let saved = records(&workspace, &mut Vec::new()).unwrap(); assert_eq!(saved.len(), 1);
        assert!(matches!(&saved[0], Record::Workspace { value, .. } if value["draft"] == "latest"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn provider_revert_is_durable_across_resume_and_checkpoint_compaction() {
        let root = root(); let path = file(&root, "revert-history", "jsonl").unwrap();
        append(&path, &Record::Create { row: json!({"executionId":"first-run","lastSequence":0,"transcript":[],"meta":{"id":"revert-history","title":"Kept title","draft":"Unsent idea"}}) }).unwrap();
        for (sequence, kind, id, text) in [(1,"userMessage","m1","First prompt"),(2,"assistantChunk","a1","First reply"),(3,"userMessage","m2","Later prompt"),(4,"assistantChunk","a2","Later reply")] {
            let event = serde_json::from_value(json!({"sequence":sequence,"attemptId":"first-run","type":kind,"messageId":id,"text":text})).unwrap();
            append(&path, &Record::Event { fields:json!({"executionId":"first-run","lastSequence":sequence}), event }).unwrap();
        }
        let event = serde_json::from_value(json!({"sequence":5,"attemptId":"first-run","type":"messageCheckpoint","messageId":"m2","checkpoint":{"provider":"pi","entryId":"pi-entry"}})).unwrap();
        append(&path, &Record::Event { fields:json!({"executionId":"first-run","lastSequence":5}), event }).unwrap();
        checkpoint(&path).unwrap();
        let saved = replay(records(&path, &mut Vec::new()).unwrap()).unwrap();
        assert_eq!(saved["transcript"][2]["checkpoint"]["entryId"], "pi-entry");
        append(&path, &Record::Update { fields: json!({"executionId":"second-run","lastSequence":0}) }).unwrap();
        let event = serde_json::from_value(json!({"sequence":1,"attemptId":"second-run","type":"threadState","state":"rewinding"})).unwrap();
        append(&path, &Record::Event { fields:json!({"executionId":"second-run","lastSequence":1,"state":"rewinding"}), event }).unwrap();
        let event = serde_json::from_value(json!({"sequence":2,"attemptId":"second-run","type":"historyReverted","messageId":"m2","text":"Later prompt"})).unwrap();
        append(&path, &Record::Event { fields:json!({"executionId":"second-run","lastSequence":2,"agentSessionId":"forked-provider-session","state":"working"}), event }).unwrap();
        let after = replay(records(&path, &mut Vec::new()).unwrap()).unwrap();
        assert_eq!(after["transcript"].as_array().unwrap().len(), 3);
        assert_eq!(after["transcript"][0]["text"], "First prompt");
        assert_eq!(after["transcript"][1]["text"], "First reply");
        assert_eq!(after["agentSessionId"], "forked-provider-session");
        assert_eq!(after["meta"]["draft"], "Unsent idea");
        checkpoint(&path).unwrap();
        assert_eq!(replay(records(&path, &mut Vec::new()).unwrap()).unwrap(), after);
        let retry = serde_json::from_value(json!({"sequence":3,"attemptId":"second-run","type":"userMessage","messageId":"retry","text":"Later prompt"})).unwrap();
        append(&path, &Record::Event { fields:json!({"executionId":"second-run","lastSequence":3}), event:retry }).unwrap();
        assert_eq!(replay(records(&path, &mut Vec::new()).unwrap()).unwrap()["transcript"].as_array().unwrap().len(), 4);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn latest_todos_survive_revert_checkpoint_and_provider_session_replacement() {
        let root = root(); let path = file(&root, "todo-revert-history", "jsonl").unwrap();
        let original = json!({"protocolVersion":3,"revision":7,"toolAvailable":true,"available":true,"activeId":"kept-task",
            "items":[{"id":"kept-task","title":"Do not rewind the shared list","status":"pending","createdBy":"agent","updatedBy":"agent","startedAt":10,"detail":"Still current."}]});
        append(&path, &Record::Create { row:json!({"executionId":"first-run","lastSequence":0,"transcript":[],"meta":{"id":"todo-revert-history","activityAt":1}}) }).unwrap();
        for (sequence, kind) in [(1,"userMessage"),(2,"todos")] {
            let event: Event = serde_json::from_value(json!({"sequence":sequence,"attemptId":"first-run","type":kind,"messageId":"m1","text":"Revert me later","todos":if kind == "todos" {original.clone()}else{Value::Null}})).unwrap();
            append(&path,&Record::Event {fields:json!({"executionId":"first-run","lastSequence":sequence,"todos":original,"todoSync":{"state":"current"}}),event}).unwrap();
        }
        let boundary: Event = serde_json::from_value(json!({"sequence":3,"attemptId":"first-run","type":"historyReverted","messageId":"m1"})).unwrap();
        append(&path,&Record::Event {fields:json!({"executionId":"first-run","agentSessionId":"forked-pi-session","lastSequence":3,"todos":original,"todoSync":{"state":"current"}}),event:boundary}).unwrap();
        checkpoint(&path).unwrap();
        let mut row = replay(records(&path,&mut Vec::new()).unwrap()).unwrap();
        assert!(!row["transcript"].as_array().unwrap().iter().any(|event| event["type"] == "todos"));
        assert_eq!(row["todos"], original);
        append(&path,&Record::Update {fields:json!({"executionId":"resumed-run","lastSequence":0,"agentSessionId":"forked-pi-session","todos":original,"todoSync":{"state":"current"}})}).unwrap();
        checkpoint(&path).unwrap();
        row = replay(records(&path,&mut Vec::new()).unwrap()).unwrap();
        crate::agent::restore_todo_fields(&mut row);
        assert_eq!(row["todos"], original);
        assert_eq!(row["todoSync"]["state"], "stale");
        assert_eq!(row["meta"]["activityAt"], 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unacknowledged_history_change_keeps_original_transcript_and_recovery_state() {
        let original = json!({"executionId":"attempt","lastSequence":1,"transcript":[{"sequence":1,"attemptId":"attempt","type":"userMessage","messageId":"one","text":"Keep me"}],"meta":{"id":"conversation"}});
        let event = serde_json::from_value(json!({"sequence":2,"attemptId":"attempt","type":"threadState","state":"rewinding"})).unwrap();
        let recovered = replay(vec![Record::Create { row: original }, Record::Event { fields:json!({"executionId":"attempt","lastSequence":2,"state":"rewinding"}), event }]).unwrap();
        assert_eq!(recovered["state"], "rewinding");
        assert_eq!(recovered["transcript"][0]["text"], "Keep me");
    }
    #[test]
    fn migration_is_partial_idempotent_and_resumed_legacy_identity_survives() {
        let root = root();
        let first = || MigrationArgs { rows: vec![legacy_row("old", "new-attempt"), Value::Null, legacy_row("deleted", "deleted")], deleted: vec!["old".into(), "deleted".into()], workspaces: json!({"host":{"folders":["/project"]}}) };
        assert_eq!(migrate(&root, first()).unwrap().len(), 1);
        let path = file(&root, "old", "jsonl").unwrap();
        assert_eq!(replay(records(&path, &mut Vec::new()).unwrap()).unwrap()["executionId"], "new-attempt");
        assert_eq!(migrate(&root, first()).unwrap().len(), 1);
        assert_eq!(records(&path, &mut Vec::new()).unwrap().len(), 1);
        assert!(!file(&root, "deleted", "jsonl").unwrap().exists());
        delete(&root, "old").unwrap(); migrate(&root, first()).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an X display; exercises the real Tauri app-data path and command boundary"]
    fn native_app_data_survives_reload_and_preserves_resume_identity() {
        let mut context = tauri::generate_context!();
        context.config_mut().identifier = format!("dev.still.history-test-{}", timestamp());
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default().any_thread().build(context).unwrap();
        let handle = app.handle().clone();
        let root = handle.path().app_data_dir().unwrap();
        tauri::async_runtime::block_on(async {
            let initial = still_agent_library(handle.clone()).await.unwrap();
            assert!(initial["rows"].as_array().unwrap().is_empty());
            still_agent_migrate(handle.clone(), MigrationArgs { rows:vec![legacy_row("local", "attempt-1")], deleted:Vec::new(),workspaces:json!({}) }).await.unwrap();
            still_agent_save_metadata(handle.clone(), MetadataArgs { conversation_id:"local".into(),meta:json!({"id":"local","hostKey":"host","folder":"/project","title":"Renamed","draft":"Kept after restart","pinned":true,"activityAt":1}) }).await.unwrap();
            still_agent_save_workspace(handle.clone(), WorkspaceArgs { key:"library".into(),value:json!({"drafts":{"unassigned":"Offline idea"}}) }).await.unwrap();
            let loaded = still_agent_library(handle.clone()).await.unwrap();
            assert_eq!(loaded["rows"][0]["meta"]["draft"], "Kept after restart");
            assert_eq!(loaded["workspaces"]["library"]["drafts"]["unassigned"], "Offline idea");
            assert_eq!(loaded["rows"][0]["meta"]["id"], "local");
            let live: Snapshot = serde_json::from_value(json!({"conversationId":"native-local","hostKey":"host","executionId":"native-attempt","localSessionId":"server","agentId":"opencode","agentName":"OpenCode","agentSessionId":"provider-session","cwd":"/project","state":"working","transcript":[],"pendingPermission":null,"lastError":null,"lastSequence":0,"turnActive":true,"configOptions":[],"commands":[],"pendingInput":null,"resumable":true})).unwrap();
            let held = lease(&handle, live.conversation_id.clone()).await.unwrap();
            assert!(lease(&handle, live.conversation_id.clone()).await.is_err());
            register(&handle, &live, false).await.unwrap();
            for sequence in 1..=1500 {
                let mut snapshot = live.clone(); snapshot.last_sequence = sequence;
                let output: Event = serde_json::from_value(json!({"sequence":sequence,"attemptId":"native-attempt","type":"assistantChunk","text":"durable "})).unwrap();
                event(&handle, &snapshot, &output).await.unwrap();
            }
            let reloaded = still_agent_library(handle.clone()).await.unwrap();
            let saved = reloaded["rows"].as_array().unwrap().iter().find(|row| row["conversationId"] == "native-local").unwrap();
            assert_eq!(saved["transcript"][0]["text"].as_str().unwrap().len(), 1500 * 8);
            drop(held);
            let resumed = Snapshot { execution_id:"native-resume".into(), ..live };
            register(&handle, &resumed, true).await.unwrap();
            still_agent_delete_saved(handle.clone(), DeleteArgs { conversation_id:"native-local".into() }).await.unwrap();
            still_agent_delete_saved(handle.clone(), DeleteArgs { conversation_id:"local".into() }).await.unwrap();
            assert!(still_agent_library(handle).await.unwrap()["rows"].as_array().unwrap().is_empty());
        });
        fs::remove_dir_all(root).unwrap();
    }
}
