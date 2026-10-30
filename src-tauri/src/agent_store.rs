//! Device-owned agent history. Each conversation has an append-only journal;
//! acknowledged records are flushed before returning, independently of WebView life.
use crate::{agent::{Event, Snapshot}, core::StillError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, fs::{self, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use tauri::{AppHandle, Emitter, Manager};

static WRITER: Mutex<()> = Mutex::new(());
static VALIDATED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static CHECKPOINT_SIZES: OnceLock<Mutex<std::collections::HashMap<PathBuf, u64>>> = OnceLock::new();

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
        let existing = records(path, &mut Vec::new())?;
        if path.file_stem().and_then(|v| v.to_str()) != Some("workspace") { replay(existing)?; }
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
            records(path, &mut Vec::new())?;
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
    // Maintenance is never an acknowledgement failure: the appended record is
    // already durable, and a failed checkpoint leaves that journal authoritative.
    let boundary = matches!(record, Record::Metadata { .. } | Record::Workspace { .. })
        || matches!(record, Record::Event { event, .. } if matches!(event.kind.as_str(), "threadComplete" | "threadError" | "historyReverted"));
    if boundary {
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
        "agentId": snapshot.agent_id, "agentName": snapshot.agent_name,
        "agentSessionId": snapshot.agent_session_id, "resumable": snapshot.resumable,
        "cwd": snapshot.cwd, "state": snapshot.state, "turnActive": snapshot.turn_active,
        "lastError": snapshot.last_error, "lastSequence": snapshot.last_sequence, "historyCapabilities": snapshot.history_capabilities,
        "persistent":snapshot.persistent,"remoteCursor":snapshot.remote_cursor,"promptId":snapshot.prompt_id,"recoveryRequired":snapshot.recovery_required,"todos":snapshot.todos})
}

pub async fn load_snapshot(app: &AppHandle, id: String) -> Result<Snapshot, StillError> {
    disk(app, move |root| {
        if file(root, &id, "deleted")?.exists() { return Err("This conversation was deleted from this device".into()); }
        let row = replay(records(&file(root, &id, "jsonl")?, &mut Vec::new())?)?;
        serde_json::from_value(row).map_err(|error| error.to_string())
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

pub async fn register(app: &AppHandle, snapshot: &Snapshot, resume: bool) -> Result<(), StillError> {
    let mut snapshot = snapshot.clone();
    snapshot.transcript.clear();
    disk(app, move |root| {
        let path = file(root, &snapshot.conversation_id, "jsonl")?;
        if file(root, &snapshot.conversation_id, "deleted")?.exists() { return Err("This conversation was deleted".into()); }
        if resume {
            let row = replay(records(&path, &mut Vec::new())?)?;
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
        let row = replay(records(&file(root, &id, "jsonl")?, &mut Vec::new())?)?;
        row["transcript"].as_array().ok_or("History has no transcript")?.iter().filter(|event| event["type"] == "userMessage")
            .map(|event| serde_json::from_value(event.clone()).map_err(|error| error.to_string())).collect()
    }).await
}

pub async fn event(app: &AppHandle, snapshot: &Snapshot, event: &Event) -> Result<(), StillError> {
    let id = snapshot.conversation_id.clone();
    let mut header = fields(snapshot);
    if let Some(configs) = &event.config_options { header["configOptions"] = json!(configs); }
    if let Some(commands) = &event.commands { header["commands"] = commands.clone(); }
    if matches!(event.kind.as_str(), "userMessage" | "threadComplete" | "threadError" | "permission" | "input" | "requestOutcome") { header["touchedAt"] = json!(timestamp()); }
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
            let result = records(&path, &mut warnings);
            if path.file_stem().and_then(|v| v.to_str()) == Some("workspace") {
                match result {
                    Ok(records) => for record in records { if let Record::Workspace { key, value } = record { workspace[key] = value; } },
                    Err(error) => warnings.push(error),
                }
            } else {
                match result.and_then(replay) { Ok(row) => rows.push(row), Err(error) => warnings.push(error) }
            }
        }
        Ok(json!({"rows":rows,"workspaces":workspace,"storagePath":root.to_string_lossy(),"warnings":warnings}))
    }).await?;
    library["liveExecutions"] = json!(crate::agent::live_executions().await);
    Ok(library)
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
        append(&path, &Record::Metadata { meta: args.meta })
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
                if let Err(error) = records(&path, &mut warnings).and_then(replay) { warnings.push(error); }
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
