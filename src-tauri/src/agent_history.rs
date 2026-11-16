//! Streaming projections of the journal. Never collect a checkpoint's full
//! transcript (or all conversations' transcripts) just to open the library.
use serde::{de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor}, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fmt, fs::{self, File, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, ops::Range, path::Path};

pub const PAGE_EVENTS: usize = 200;
pub const PAGE_BYTES: usize = 512 * 1024;
pub const EVENT_BYTES: usize = 32 * 1024;

#[derive(Default)]
pub struct Index {
    pub row: Value,
    spans: Vec<Range<usize>>,
    messages: Vec<(usize, Value)>,
}

impl Index {
    pub fn total(&self) -> usize { self.spans.iter().map(Range::len).sum() }

    fn event(&mut self, ordinal: usize, event: Value) -> Result<(), String> {
        if !event["type"].is_string() || !event["sequence"].is_u64() { return Err("Invalid saved event".into()); }
        let message_id = event["messageId"].as_str();
        if event["type"] == "messageCheckpoint" {
            if let Some((_, message)) = self.messages.iter_mut().find(|(_, item)| message_id.is_some() && item["messageId"].as_str() == message_id) {
                message["checkpoint"] = event["checkpoint"].clone();
            }
        } else if event["type"] == "historyReverted" {
            if let Some((target, _)) = self.messages.iter().find(|(_, item)| message_id.is_some() && item["messageId"].as_str() == message_id) {
                let target = *target;
                self.spans.retain_mut(|span| { span.end = span.end.min(target); span.start < span.end });
                self.messages.retain(|(ordinal, _)| *ordinal < target);
            }
        }
        if event["type"] == "userMessage" { self.messages.push((ordinal, event)); }
        if let Some(span) = self.spans.last_mut().filter(|span| span.end == ordinal) { span.end += 1; }
        else { self.spans.push(ordinal..ordinal + 1); }
        Ok(())
    }

    fn apply(&mut self, record: ProjectedRecord) -> Result<(), String> {
        match record.op.as_str() {
            "create" => {
                if !record.row.is_object() || !record.row["transcript"].is_array() { return Err("Invalid initial conversation record".into()); }
                if self.row.is_null() {
                    self.row = record.row;
                    for (ordinal, event) in record.initial { self.event(ordinal, event)?; }
                }
            }
            "update" => {
                if !self.row.is_object() || !record.fields.is_object() { return Err("Invalid execution record".into()); }
                merge(&mut self.row, record.fields);
            }
            "metadata" => {
                if !self.row.is_object() || !record.meta.is_object() { return Err("Invalid conversation metadata record".into()); }
                let mut meta = record.meta;
                meta["activityAt"] = json!(self.row["meta"]["activityAt"].as_u64().unwrap_or(0).max(self.row["touchedAt"].as_u64().unwrap_or(0)).max(meta["activityAt"].as_u64().unwrap_or(0)));
                self.row["meta"] = meta;
            }
            "event" => {
                if !self.row.is_object() || !record.fields.is_object() { return Err("Missing initial conversation record".into()); }
                let (ordinal, event) = record.event.ok_or("Missing saved event")?;
                if record.fields["executionId"] == self.row["executionId"] && event["sequence"].as_u64().unwrap_or(0) <= self.row["lastSequence"].as_u64().unwrap_or(0) { return Ok(()); }
                let activity = record.fields["touchedAt"].as_u64();
                merge(&mut self.row, record.fields);
                if let Some(activity) = activity { self.row["meta"]["activityAt"] = json!(activity); }
                self.event(ordinal, event)?;
            }
            _ => return Err("Unexpected record in conversation history".into()),
        }
        Ok(())
    }

    fn selection(&self, start: usize, end: usize) -> HashSet<usize> {
        let mut offset = 0;
        let mut selected = HashSet::new();
        for span in &self.spans {
            let from = start.saturating_sub(offset).min(span.len());
            let to = end.saturating_sub(offset).min(span.len());
            selected.extend(span.start + from..span.start + to);
            offset += span.len();
            if offset >= end { break; }
        }
        selected
    }
}

fn merge(row: &mut Value, fields: Value) {
    if let (Some(row), Value::Object(fields)) = (row.as_object_mut(), fields) { row.extend(fields); }
}

pub fn index(path: &Path, warnings: &mut Vec<String>) -> Result<Index, String> {
    let mut index = Index::default();
    scan(path, &mut Projection::default(), |record| index.apply(record), warnings)?;
    if !index.row.is_object() { return Err("Conversation is missing its initial record".into()); }
    index.row["pendingPermission"] = Value::Null;
    index.row["pendingInput"] = Value::Null;
    index.row["historyLoaded"] = json!(false);
    Ok(index)
}

pub fn page(path: &Path, before: Option<usize>, warnings: &mut Vec<String>) -> Result<Value, String> {
    let index = index(path, warnings)?;
    let total = index.total();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(PAGE_EVENTS);
    let selected = index.selection(start, end);
    let mut projection = Projection { selected: Some(&selected), ..Projection::default() };
    scan(path, &mut projection, |_| Ok(()), warnings)?;
    let mut bytes = 0;
    let mut transcript = Vec::new();
    // Prefer the newest events when a page hits the byte budget. The next
    // cursor includes every omitted event; nothing on disk is truncated.
    for (_, mut event) in projection.picked.into_iter().rev() {
        if event["type"] == "userMessage" {
            if let Some((_, message)) = index.messages.iter().find(|(_, message)| message["messageId"] == event["messageId"]) {
                if let Some(checkpoint) = message.get("checkpoint") { event["checkpoint"] = checkpoint.clone(); }
            }
        }
        let event = preview(event);
        let size = json_size(&event);
        if bytes + size > PAGE_BYTES { break; }
        bytes += size;
        transcript.push(event);
    }
    transcript.reverse();
    let before = end.saturating_sub(transcript.len());
    let mut row = index.row;
    row["transcript"] = json!(transcript);
    row["historyLoaded"] = json!(true);
    row["historyBefore"] = if before > 0 { json!(before) } else { Value::Null };
    row["historyTotal"] = json!(total);
    row["historyLatest"] = json!(end == total);
    Ok(row)
}

/// Prompt identities/checkpoints need to outlive the bounded output window.
/// Only prompts are materialized here, never tool output or assistant history.
pub fn messages(path: &Path) -> Result<Vec<Value>, String> {
    let index = index(path, &mut Vec::new())?;
    let selected = index.messages.iter().map(|(ordinal, _)| *ordinal).collect();
    let mut projection = Projection { selected: Some(&selected), full: true, ..Projection::default() };
    scan(path, &mut projection, |_| Ok(()), &mut Vec::new())?;
    Ok(projection.picked.into_iter().map(|(ordinal, mut event)| {
        if let Some((_, message)) = index.messages.iter().find(|(position, _)| *position == ordinal) {
            if let Some(checkpoint) = message.get("checkpoint") { event["checkpoint"] = checkpoint.clone(); }
        }
        event
    }).collect())
}

struct Counter(usize);
impl Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.0 += bytes.len(); Ok(bytes.len()) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
pub fn json_size(value: &impl Serialize) -> usize {
    let mut counter = Counter(0);
    if serde_json::to_writer(&mut counter, value).is_err() { return usize::MAX; }
    counter.0
}

/// A preview is explicitly lossy; the durable journal always gets the original.
pub fn preview(mut event: Value) -> Value {
    if json_size(&event) <= EVENT_BYTES { return event; }
    event["previewTruncated"] = json!(true);
    fn bound(value: &mut Value, budget: &mut usize) {
        match value {
            Value::String(text) => {
                let mut end = text.len().min((*budget).min(8192));
                while !text.is_char_boundary(end) { end -= 1; }
                *budget = budget.saturating_sub(end);
                if end < text.len() { text.truncate(end); text.push_str("\n[Preview shortened; full content is retained in saved history.]"); }
            }
            Value::Array(items) => { items.truncate(32); for item in items { bound(item, budget); } }
            Value::Object(fields) => { for value in fields.values_mut() { bound(value, budget); } }
            _ => {},
        }
    }
    // Preserve protocol/identity fields. Only display payloads are shortened.
    let mut budget = 12 * 1024;
    for key in ["text", "title", "detail", "content", "rawInput", "rawOutput", "outputDelta", "locations"] {
        if let Some(value) = event.get_mut(key) { bound(value, &mut budget); }
    }
    if json_size(&event) > EVENT_BYTES {
        for key in ["content", "rawInput", "rawOutput", "outputDelta", "locations"] {
            if let Some(value) = event.get_mut(key) { *value = Value::Null; }
        }
        event["text"] = json!("[Large event preview omitted; full content is retained in saved history.]");
    }
    if json_size(&event) > EVENT_BYTES {
        // Unexpected huge provider extensions must not bypass the IPC budget.
        event.as_object_mut().unwrap().retain(|key, value| matches!(key.as_str(), "type" | "sequence" | "endSequence" | "attemptId" | "messageId" | "toolCallId" | "toolKind" | "status" | "text" | "previewTruncated")
            && !value.is_array() && !value.is_object()
            && value.as_str().is_none_or(|text| text.len() <= if key == "text" { 8192 } else { 640 }));
    }
    event
}

#[derive(Default)]
struct Projection<'a> {
    ordinal: usize,
    selected: Option<&'a HashSet<usize>>,
    picked: Vec<(usize, Value)>,
    full: bool,
}
#[derive(Default)]
struct ProjectedRecord { op: String, row: Value, initial: Vec<(usize, Value)>, fields: Value, meta: Value, event: Option<(usize, Value)> }

struct EventSeed<'a, 'b>(&'a mut Projection<'b>);
impl<'de> DeserializeSeed<'de> for EventSeed<'_, '_> {
    type Value = (usize, Value);
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        let ordinal = self.0.ordinal;
        self.0.ordinal += 1;
        if let Some(selected) = self.0.selected {
            if selected.contains(&ordinal) {
                let event = Value::deserialize(deserializer)?;
                self.0.picked.push((ordinal, if self.0.full { event } else { preview(event) }));
            } else { IgnoredAny::deserialize(deserializer)?; }
            return Ok((ordinal, Value::Null));
        }
        struct Header;
        impl<'de> Visitor<'de> for Header {
            type Value = Value;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("a history event") }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
                let mut event = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if matches!(key.as_str(), "type" | "sequence" | "endSequence" | "attemptId" | "messageId" | "checkpoint" | "source") { event.insert(key, map.next_value()?); }
                    else { map.next_value::<IgnoredAny>()?; }
                }
                Ok(Value::Object(event))
            }
        }
        Ok((ordinal, deserializer.deserialize_map(Header)?))
    }
}

struct EventsSeed<'a, 'b>(&'a mut Projection<'b>);
impl<'de> DeserializeSeed<'de> for EventsSeed<'_, '_> {
    type Value = Vec<(usize, Value)>;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for EventsSeed<'_, '_> {
    type Value = Vec<(usize, Value)>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("a transcript") }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut events = Vec::new();
        while let Some(event) = seq.next_element_seed(EventSeed(self.0))? {
            if self.0.selected.is_none() { events.push(event); }
        }
        Ok(events)
    }
}

struct RowSeed<'a, 'b>(&'a mut Projection<'b>);
impl<'de> DeserializeSeed<'de> for RowSeed<'_, '_> {
    type Value = (Value, Vec<(usize, Value)>);
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for RowSeed<'_, '_> {
    type Value = (Value, Vec<(usize, Value)>);
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("a saved conversation") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut row = serde_json::Map::new();
        let mut events = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "transcript" { events = Some(map.next_value_seed(EventsSeed(self.0))?); row.insert(key, json!([])); }
            else if matches!(key.as_str(), "previousTranscript" | "activeMessageIds" | "pendingPermission" | "pendingInput") { map.next_value::<IgnoredAny>()?; }
            else { row.insert(key, map.next_value()?); }
        }
        Ok((Value::Object(row), events.ok_or_else(|| de::Error::custom("Missing saved transcript"))?))
    }
}

// An internally tagged derived enum buffers the whole record before dispatch.
// Dispatch keys as they arrive so a giant Create transcript stays streaming.
struct RecordSeed<'a, 'b>(&'a mut Projection<'b>);
impl<'de> DeserializeSeed<'de> for RecordSeed<'_, '_> {
    type Value = ProjectedRecord;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for RecordSeed<'_, '_> {
    type Value = ProjectedRecord;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("a journal record") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut record = ProjectedRecord::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "op" => record.op = map.next_value()?,
                "row" => { (record.row, record.initial) = map.next_value_seed(RowSeed(self.0))?; }
                "event" => record.event = Some(map.next_value_seed(EventSeed(self.0))?),
                "fields" => record.fields = map.next_value()?,
                "meta" => record.meta = map.next_value()?,
                _ => { map.next_value::<IgnoredAny>()?; },
            }
        }
        Ok(record)
    }
}

struct EnvelopeSeed<'a, 'b>(&'a mut Projection<'b>);
impl<'de> DeserializeSeed<'de> for EnvelopeSeed<'_, '_> {
    type Value = ProjectedRecord;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}
impl<'de> Visitor<'de> for EnvelopeSeed<'_, '_> {
    type Value = ProjectedRecord;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("a journal envelope") }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let (mut version, mut record) = (None, None);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" => version = Some(map.next_value::<u64>()?),
                "record" => record = Some(map.next_value_seed(RecordSeed(self.0))?),
                _ => { map.next_value::<IgnoredAny>()?; },
            }
        }
        if version != Some(1) { return Err(de::Error::custom("Unsupported history version")); }
        record.ok_or_else(|| de::Error::custom("Missing journal record"))
    }
}

fn scan(path: &Path, projection: &mut Projection<'_>, mut consume: impl FnMut(ProjectedRecord) -> Result<(), String>, warnings: &mut Vec<String>) -> Result<(), String> {
    let mut frames = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let mut input = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let mut complete = 0;
    loop {
        // Frame without allocating a line: checkpoints can be tens of MB long.
        let (mut length, mut terminated) = (0, false);
        loop {
            let buffer = frames.fill_buf().map_err(|e| e.to_string())?;
            if buffer.is_empty() { break; }
            let newline = buffer.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(buffer.len(), |position| position + 1);
            frames.consume(consumed);
            length += consumed;
            if newline.is_some() { terminated = true; break; }
        }
        if length == 0 { break; }
        if !terminated { break; }
        if length == 1 { let mut newline = [0]; input.read_exact(&mut newline).map_err(|e| e.to_string())?; }
        else {
            let mut deserializer = serde_json::Deserializer::from_reader((&mut input).take(length as u64));
            let record = EnvelopeSeed(projection).deserialize(&mut deserializer).map_err(|e| format!("History needs recovery: {} ({e}). The original file was kept.", path.display()))?;
            deserializer.end().map_err(|e| e.to_string())?;
            consume(record)?;
        }
        complete += length as u64;
    }
    if complete < frames.get_ref().metadata().map_err(|e| e.to_string())?.len() {
        let backup = path.with_extension(format!("interrupted-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
        fs::copy(path, &backup).map_err(|e| e.to_string())?;
        OpenOptions::new().write(true).open(&backup).and_then(|file| file.sync_all()).map_err(|e| e.to_string())?;
        OpenOptions::new().write(true).open(path).and_then(|file| { file.set_len(complete)?; file.sync_all() }).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        File::open(path.parent().ok_or("Missing storage directory")?).and_then(|file| file.sync_all()).map_err(|e| e.to_string())?;
        warnings.push("Recovered an interrupted history write. All complete records were retained.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::BufWriter, path::PathBuf};

    struct Journal(PathBuf);
    impl Journal {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("still-history-{}-{time}-{id}", std::process::id()));
            fs::create_dir(&root).unwrap();
            Self(root.join("history.jsonl"))
        }
        fn append(&self, record: Value) {
            let mut output = OpenOptions::new().create(true).append(true).open(&self.0).unwrap();
            serde_json::to_writer(&mut output, &json!({"version":1,"record":record})).unwrap();
            output.write_all(b"\n").unwrap();
        }
        fn create(&self, events: Value) {
            self.append(json!({"op":"create","row":{"executionId":"attempt","lastSequence":0,"transcript":events,"meta":{"title":"Saved title","activityAt":1}}}));
        }
        fn event(&self, sequence: u64, kind: &str, message: Option<&str>) {
            self.append(json!({"op":"event","fields":{"executionId":"attempt","lastSequence":sequence},"event":{"type":kind,"sequence":sequence,"attemptId":"attempt","messageId":message,"text":"saved text"}}));
        }
    }
    impl Drop for Journal {
        fn drop(&mut self) {
            // Only the unique test-owned directory, never application data.
            let _ = fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn pages_visit_every_event_without_gaps_or_duplicates() {
        let journal = Journal::new();
        journal.create(json!([]));
        for sequence in 1..=650 { journal.event(sequence, "assistantChunk", None); }
        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let row = page(&journal.0, cursor, &mut Vec::new()).unwrap();
            let events = row["transcript"].as_array().unwrap();
            assert!(events.len() <= PAGE_EVENTS);
            assert!(json_size(events) <= PAGE_BYTES + PAGE_EVENTS + 2);
            seen.extend(events.iter().map(|event| event["sequence"].as_u64().unwrap()));
            cursor = row["historyBefore"].as_u64().map(|value| value as usize);
            if cursor.is_none() { break; }
        }
        seen.sort_unstable();
        assert_eq!(seen, (1..=650).collect::<Vec<_>>());
        assert!(index(&journal.0, &mut Vec::new()).unwrap().row["transcript"].as_array().unwrap().is_empty());
    }

    #[test]
    fn rewind_outside_the_visible_window_does_not_resurrect_removed_output() {
        let journal = Journal::new();
        journal.create(json!([]));
        journal.event(1, "userMessage", Some("keep"));
        journal.event(2, "assistantChunk", None);
        journal.event(3, "userMessage", Some("revert"));
        for sequence in 4..=500 { journal.event(sequence, "toolUpdate", None); }
        journal.event(501, "historyReverted", Some("revert"));
        journal.event(502, "userMessage", Some("replacement"));
        let row = page(&journal.0, None, &mut Vec::new()).unwrap();
        assert_eq!(row["historyTotal"], 4);
        assert_eq!(row["transcript"].as_array().unwrap().iter().map(|event| event["sequence"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 501, 502]);
        assert_eq!(messages(&journal.0).unwrap().iter().map(|event| event["messageId"].as_str().unwrap()).collect::<Vec<_>>(), vec!["keep", "replacement"]);
    }

    #[test]
    fn checkpoints_and_prior_attempts_survive_projection() {
        let journal = Journal::new();
        journal.create(json!([{ "type":"userMessage","sequence":1,"attemptId":"old","messageId":"old-message","text":"exact original prompt" }]));
        journal.event(1, "userMessage", Some("new-message"));
        journal.append(json!({"op":"event","fields":{"executionId":"attempt","lastSequence":2},"event":{"type":"messageCheckpoint","sequence":2,"messageId":"old-message","checkpoint":{"opaque":"provider-reference"}}}));
        journal.event(2, "assistantChunk", None); // duplicate delivery
        let row = page(&journal.0, None, &mut Vec::new()).unwrap();
        assert_eq!(row["historyTotal"], 3);
        assert_eq!(row["transcript"][0]["checkpoint"]["opaque"], "provider-reference");
        assert_eq!(messages(&journal.0).unwrap()[0]["text"], "exact original prompt");
    }

    #[test]
    fn previews_bound_large_payloads_without_changing_the_journal() {
        let journal = Journal::new();
        journal.create(json!([{ "type":"toolUpdate","sequence":1,"toolCallId":"tool","rawOutput":{"nested":["終".repeat(200_000)]},"content":[{"type":"diff","path":"file","newText":"x".repeat(200_000)}] }]));
        let before = fs::read(&journal.0).unwrap();
        let row = page(&journal.0, None, &mut Vec::new()).unwrap();
        assert_eq!(row["transcript"][0]["previewTruncated"], true);
        assert!(json_size(&row["transcript"][0]) <= EVENT_BYTES);
        assert_eq!(fs::read(&journal.0).unwrap(), before);
    }

    #[test]
    fn a_large_checkpoint_cannot_bypass_the_page_budget_or_stall_the_cursor() {
        let journal = Journal::new();
        journal.create(json!([]));
        journal.event(1, "userMessage", Some("message"));
        journal.append(json!({"op":"event","fields":{"executionId":"attempt","lastSequence":2},"event":{"type":"messageCheckpoint","sequence":2,"messageId":"message","checkpoint":{"opaque":"x".repeat(1_000_000)}}}));
        let row = page(&journal.0, None, &mut Vec::new()).unwrap();
        assert_eq!(row["transcript"].as_array().unwrap().len(), 2);
        assert_eq!(row["historyBefore"], Value::Null);
        assert!(json_size(&row["transcript"]) < PAGE_BYTES);
        assert_eq!(row["transcript"][0]["previewTruncated"], true);
        assert_eq!(messages(&journal.0).unwrap()[0]["checkpoint"]["opaque"].as_str().unwrap().len(), 1_000_000);
    }

    #[test]
    fn recovery_keeps_original_and_never_skips_a_corrupt_complete_record() {
        let journal = Journal::new();
        journal.create(json!([]));
        let complete = fs::read(&journal.0).unwrap();
        OpenOptions::new().append(true).open(&journal.0).unwrap().write_all(b"{\"interrupted\":").unwrap();
        let mut warnings = Vec::new();
        index(&journal.0, &mut warnings).unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(fs::read(&journal.0).unwrap(), complete);
        assert_eq!(fs::read_dir(journal.0.parent().unwrap()).unwrap().count(), 2);
        OpenOptions::new().append(true).open(&journal.0).unwrap().write_all(b"{broken}\n").unwrap();
        let corrupt = fs::read(&journal.0).unwrap();
        assert!(index(&journal.0, &mut warnings).is_err());
        assert_eq!(fs::read(&journal.0).unwrap(), corrupt);
    }

    #[test]
    fn large_checkpoint_7323_events_stays_out_of_the_library_payload() {
        let journal = Journal::new();
        let mut output = BufWriter::new(File::create(&journal.0).unwrap());
        output.write_all(br#"{"version":1,"record":{"op":"create","row":{"executionId":"attempt","lastSequence":7323,"meta":{"title":"Large saved conversation"},"transcript":["#).unwrap();
        let text = "x".repeat(11_500);
        for sequence in 1..=7323 {
            if sequence > 1 { output.write_all(b",").unwrap(); }
            serde_json::to_writer(&mut output, &json!({"type":"assistantMessage","sequence":sequence,"attemptId":"attempt","text":text})).unwrap();
        }
        output.write_all(b"]}}}\n").unwrap();
        output.flush().unwrap();
        drop(output);
        assert!(fs::metadata(&journal.0).unwrap().len() > 84_000_000);
        let library = index(&journal.0, &mut Vec::new()).unwrap();
        assert!(json_size(&library.row) < 1024);
        assert_eq!(library.row["historyLoaded"], false);
        assert_eq!(library.total(), 7323);
        let recent = page(&journal.0, None, &mut Vec::new()).unwrap();
        assert_eq!(recent["transcript"].as_array().unwrap().last().unwrap()["sequence"], 7323);
        assert!(json_size(&recent["transcript"]) < PAGE_BYTES + PAGE_EVENTS + 2);
        let older = page(&journal.0, recent["historyBefore"].as_u64().map(|value| value as usize), &mut Vec::new()).unwrap();
        assert_eq!(older["transcript"].as_array().unwrap().last().unwrap()["sequence"], recent["transcript"][0]["sequence"].as_u64().unwrap() - 1);
        eprintln!("journal={} bytes, library={} bytes, recent={} bytes, recent_events={}", fs::metadata(&journal.0).unwrap().len(), json_size(&library.row), json_size(&recent), recent["transcript"].as_array().unwrap().len());
    }
}
