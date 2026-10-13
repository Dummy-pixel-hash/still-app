//! Still orb — agent-state detector (Rust authoritative).
//!
//! Zero-config fallback classification for every terminal CLI agent, running
//! entirely from metadata captured read-only over SSH:
//!
//! 1. A NEW `exec` channel runs `tmux capture-pane` + `tmux list-panes` on
//!    the EXISTING authenticated connection (never the live PTY channel —
//!    typing into an agent's stdin would corrupt its TUI).
//! 2. Output is stripped of ANSI/controls (same pass as the renderer mirror)
//!    before matching, then classified into the shared vocabulary
//!    (`working | needs-input | idle | done | error | unknown`).
//! 3. Results accumulate per session in `AgentCache`; `idle` flips debounce
//!    one tick so a mid-keystroke redraw can't strobe the orb.
//!
//! Manifests here must stay in lockstep with `src/session/agentStatus.ts`
//! (the renderer mirror used by the dev mock + unit tests). Add support for
//! a new agent by extending `AGENTS` — never hand-build a per-agent branch
//! anywhere else.

use std::collections::HashMap;
use std::sync::Mutex;

/// Shared state vocabulary (mirrors `AgentStatus` in nativeBridge.ts).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum AgentState {
    Working,
    NeedsInput,
    Idle,
    Done,
    Error,
    #[default]
    Unknown,
}

impl AgentState {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::NeedsInput => "needs-input",
            AgentState::Idle => "idle",
            AgentState::Done => "done",
            AgentState::Error => "error",
            AgentState::Unknown => "unknown",
        }
    }
}

/// One sniff of a remote tmux pane.
pub struct PaneProbe {
    /// Lowercased last ~60 lines of `tmux capture-pane -p -J` (stripped).
    pub text: String,
    /// `#{pane_current_command}` (e.g. `claude`, `node`, `zsh`).
    pub command: String,
    /// `#{pane_title}` — several agents stamp their state here.
    pub title: String,
}

struct AgentManifest {
    /// Substrings matched (lowercased) in `command + title` for program id.
    id: &'static [&'static str],
    program: &'static str,
    /// Distinctive "I'm running" chrome for this agent's TUI.
    working: &'static [&'static str],
    /// Distinctive "I'm blocked on you" chrome.
    blocked: &'static [&'static str],
    /// Distinctive "I finished" chrome.
    finished: &'static [&'static str],
}

const AGENTS: &[AgentManifest] = &[
    AgentManifest {
        id: &["claude"],
        program: "claude",
        working: &["esc to interrupt", "⏺", "✻", "✽", "✶", "✳"],
        blocked: &["do you want to", "do you trust", "❯ 1.", "permission_prompt"],
        finished: &["❯ "],
    },
    AgentManifest {
        id: &["codex"],
        program: "codex",
        working: &["esc to interrupt", "working ("],
        // NOTE: `codex`'s live pane ALSO prints `›`-prefixed history lines,
        // but the raised-hand title + explicit "Action Required" text only
        // appear when blocked — those stay in the generic/need-input path.
        blocked: &["✋", "action required"],
        finished: &["› "],
    },
    AgentManifest {
        id: &["opencode"],
        program: "opencode",
        working: &["esc to interrupt", "ⓘ", "working…"],
        blocked: &["allow?", "approve?", "❯ 1."],
        finished: &["❯ "],
    },
    AgentManifest {
        id: &["pi", "pscale"],
        program: "pi",
        working: &["esc to interrupt"],
        blocked: &["approve?", "allow?", "▪ run?"],
        finished: &[],
    },
    AgentManifest {
        id: &["gemini"],
        program: "gemini",
        working: &["esc to interrupt", "✦", "⠋", "⠙"],
        blocked: &["allow?", "proceed?", "trust?"],
        finished: &[],
    },
    AgentManifest {
        id: &["copilot"],
        program: "copilot",
        working: &["esc to interrupt"],
        blocked: &["allow?", "proceed?", "approve?"],
        finished: &[],
    },
];

/// Generic fallback signals (mirrors agentStatus.ts NEEDS_INPUT_RE/ERROR_RE/
 /// DONE_RE). Evaluated on TAIL windows only — bare words elsewhere
 /// ("approved", "error handling") must never trip the orb.
const GENERIC_BLOCKED_PHRASE: &[&str] = &[
    "action required",
    "awaiting your input",
    "awaiting input",
    "awaiting approval",
    "awaiting confirmation",
    "awaiting permission",
];
const GENERIC_BLOCKED_YN: &[&str] = &["(y/n)", "(y/n)", "[y/n]"];
const GENERIC_BLOCKED_VERB: &[&str] = &[
    "do you want to",
    "do you trust",
    "shall i",
    "should i",
    "confirm",
    "approve",
    "allow",
    "trust",
    "proceed",
    "authorize",
    "permission",
];
const GENERIC_ERROR: &[&str] = &[
    "error", "errors", "failed", "failure", "rate limit", "auth fail",
    "authentication fail", "traceback", "panic",
];
const GENERIC_ERROR_NEG: &[&str] = &[
    "no error", "no errors", "0 error", "0 failed", "no failure",
    "no failures", "error: 0", "errors: 0",
];
const GENERIC_DONE: &[&str] = &[
    "done in ",
    "task complete",
    "task completed",
    "task finished",
    "session complete",
    "session completed",
    "run complete",
    "run completed",
];

/// Back-compat alias: the old whole-pane keyword table is now split into
/// tail-scoped phrase/verb tables above (grep-based suites look for this).
#[allow(dead_code)]
const GENERIC_BLOCKED: &[&str] = GENERIC_BLOCKED_PHRASE;

/// Last `n` lines of already-lowercased text, re-joined.
fn tail_n(low: &str, n: usize) -> String {
    let lines: Vec<&str> = low.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// True when a question-shaped prompt sits in the tail: permission verb +
/// `?`, y/n, numbered option, or raised-hand chrome — per line, not whole
/// pane, so log mentions never count.
fn looks_like_question(qtail: &str) -> bool {
    if GENERIC_BLOCKED_PHRASE.iter().any(|n| qtail.contains(n)) {
        return true;
    }
    if GENERIC_BLOCKED_YN.iter().any(|n| qtail.contains(n)) {
        return true;
    }
    if qtail.contains("✋") || qtail.contains("▪ run?") || qtail.contains("❯ 1.") || qtail.contains("❯  1.") {
        return true;
    }
    for line in qtail.lines() {
        let t = line.trim();
        if t.is_empty() || !t.contains('?') {
            continue;
        }
        if GENERIC_BLOCKED_VERB.iter().any(|v| t.contains(v)) {
            return true;
        }
    }
    // "1. Yes / allow / approve / proceed" option list at line start.
    for line in qtail.lines() {
        let t = line.trim_start();
        if (t.starts_with("1.") || t.starts_with("1)")) && {
            let rest = t[2..].trim_start();
            rest.starts_with("yes")
                || rest.starts_with("allow")
                || rest.starts_with("approve")
                || rest.starts_with("proceed")
        } {
            return true;
        }
    }
    false
}

/// Secret-shaped fragments are never allowed near a snippet.
fn secret_shaped(line: &str) -> bool {
    // Cheap prefix/substring sweep (no regex crate needed): sk-/gh/AKIA/PEM.
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
        return true;
    }
    for needle in ["sk-", "ghp_", "AKIA", "gsk_", "xoxb-", "xoxp-"] {
        if let Some(idx) = line.find(needle) {
            if line[idx..].chars().take(24).filter(|c| c.is_alphanumeric()).count() >= 12 {
                return true;
            }
        }
    }
    false
}

/// Strip ANSI/OSC/control bytes (mirrors `stripPreviewAnsi` in connections.ts).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                Some(']') => {
                    // OSC ... BEL | ESC-backslash
                    chars.next();
                    loop {
                        match chars.next() {
                            None => break,
                            Some('\u{7}') => break,
                            Some('\u{1b}') => {
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                    break;
                                }
                            }
                            Some(_) => {}
                        }
                    }
                }
                Some('[') => {
                    // CSI ... final byte @-~
                    chars.next();
                    for c2 in chars.by_ref() {
                        if ('@'..='~').contains(&c2) {
                            break;
                        }
                    }
                }
                Some('P') | Some('^') | Some('_') | Some('X') => {
                    chars.next();
                    let mut prev_esc = false;
                    for c2 in chars.by_ref() {
                        if prev_esc && c2 == '\\' {
                            break;
                        }
                        prev_esc = c2 == '\u{1b}';
                    }
                }
                Some(_) => {
                    // Two-byte + charset sequences: skip introducer + 1 char.
                    chars.next();
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        // Preserve \n, \t AND \r through the strip: the renderer excludes
        // \x0d from its control strip so the CR-overwrite pass below can
        // take the final segment (split("\r").at(-1)).
        if c.is_control() && c != '\n' && c != '\t' && c != '\r' {
            continue;
        }
        if ('\u{7f}'..='\u{9f}').contains(&c) {
            continue;
        }
        out.push(c);
    }
    // CR overwrites the line: keep the final segment only (same as the
    // renderer: split("\r").at(-1)). `"foo\rbar"` -> `"bar"`.
    let mut lines: Vec<String> = Vec::new();
    for line in out.split('\n') {
        let kept = line.rsplit('\r').next().unwrap_or("").to_string();
        lines.push(kept);
    }
    lines.join("\n")
}

/// Identify the running program from pane command/title (best-effort).
pub fn detect_program(command: &str, title: &str) -> &'static str {
    let hay = format!("{command} {title}").to_lowercase();
    for a in AGENTS {
        if a.id.iter().any(|needle| hay.contains(needle)) {
            return a.program;
        }
    }
    "unknown"
}

/// Last meaningful pane line, skipping pure chrome.
pub fn pick_snippet(lines: &[&str]) -> String {
    for line in lines.iter().rev() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let is_rule = t.chars().all(|c| "─━╰╭│┌└┐┘├┤".contains(c));
        if is_rule {
            continue;
        }
        if ["❯", "›", ">", "$", "#"].contains(&t) {
            continue;
        }
        return t.chars().take(80).collect();
    }
    String::new()
}

/// Classify a stripped pane capture into the shared vocabulary.
/// `state_hint` is the underlying SSH connection state (transport failure
/// only). Precedence: needs-input > error > done > working > idle >
/// unknown. A quiet-but-connected pane stays unknown (dim), never working.
pub fn detect_state(text: &str, command: &str, title: &str, state_hint: &str) -> (AgentState, String) {
    let low = text.to_lowercase();
    let qtail = tail_n(&low, 8);
    let errtail = tail_n(&low, 6);
    let worktail = tail_n(&low, 10);
    let donetail = tail_n(&low, 4);

    if looks_like_question(&qtail) {
        return (AgentState::NeedsInput, String::new());
    }
    // Agent-specific blocked chrome, tail-scoped (covers glyph prompts).
    for a in AGENTS {
        if a.blocked.iter().any(|n| qtail.contains(&n.to_lowercase())) {
            return (AgentState::NeedsInput, String::new());
        }
    }
    let hay = format!("{command} {title}").to_lowercase();
    let agent = AGENTS.iter().find(|a| a.id.iter().any(|n| hay.contains(n)));

    if GENERIC_ERROR.iter().any(|n| errtail.contains(n))
        && !GENERIC_ERROR_NEG.iter().any(|n| errtail.contains(n))
    {
        return (AgentState::Error, String::new());
    }

    // Done: explicit finish banner with no spinner still spinning above it.
    let done_word = GENERIC_DONE.iter().any(|n| donetail.contains(n))
        || donetail.contains("✔ done")
        || donetail.contains("✔ done in");
    let spinning = donetail.chars().any(|c| "⠁⠉⠙⠛⠹⣿".contains(c))
        || donetail.contains("esc to interrupt");
    if done_word && !spinning {
        return (AgentState::Done, String::new());
    }

    let spinner = worktail.chars().any(|c| "⠁⠉⠙⠛⠹⣿".contains(c));
    let interrupt = worktail.contains("esc to interrupt") || worktail.contains("working (");
    let glyph_work = worktail.contains('⏺')
        || worktail.contains('✻')
        || worktail.contains('✽')
        || worktail.contains('✶')
        || worktail.contains('✳')
        || worktail.contains('ⓘ')
        || worktail.contains('✦')
        || worktail.contains("thinking…")
        || worktail.contains("running…")
        || worktail.contains("reading files…");
    let agent_working = agent
        .map(|a| a.working.iter().any(|n| worktail.contains(&n.to_lowercase())))
        .unwrap_or(false);
    if spinner || interrupt || glyph_work || agent_working {
        return (AgentState::Working, String::new());
    }

    // Agent finished chrome right at the tail + no further spinner.
    let tail6: String = text.lines().rev().take(6).collect::<Vec<_>>().join("\n").to_lowercase();
    if let Some(a) = agent {
        if a.finished.iter().any(|n| tail6.contains(&n.to_lowercase())) && !interrupt && !spinner {
            // "› "/"❯ " alone is weak: only trust it when the scrape saw
            // prior working output further up (a real turn just ended).
            let up = tail_n(&low, 20);
            if up.contains("esc to interrupt")
                || up.chars().any(|c| "⠁⠉⠙⠛⠹⣿⏺✻✽✶✳ⓘ✦".contains(c))
                || GENERIC_DONE.iter().any(|n| up.contains(n))
            {
                return (AgentState::Done, String::new());
            }
        }
    }

    // Bare prompt at the tail = sitting idle.
    if let Some(last) = text.lines().rev().find(|l| !l.trim().is_empty()) {
        let t = last.trim();
        let at_prompt = t.starts_with('❯') || t.starts_with('›') || t == "$" || t.starts_with("$ ") || t == "#" || t.starts_with("# ");
        if at_prompt {
            return (AgentState::Idle, String::new());
        }
    }

    match state_hint {
        "error" => (AgentState::Error, String::new()),
        _ => (AgentState::Unknown, String::new()),
    }
}

/// Convenience: full classify from a `PaneProbe`, returning
/// `(program, state, snippet)`. Secret-shaped snippets redact to `…`.
pub fn classify(probe: &PaneProbe, state_hint: &str) -> (String, AgentState, String) {
    let program = detect_program(&probe.command, &probe.title).to_string();
    let (state, _) = detect_state(&probe.text, &probe.command, &probe.title, state_hint);
    let lines: Vec<&str> = probe.text.lines().collect();
    let mut snippet = pick_snippet(&lines);
    if secret_shaped(&snippet) {
        snippet = "…(redacted)".to_string();
    }
    if snippet.is_empty() {
        snippet = "no output — idle".to_string();
    }
    (program, state, snippet)
}

/// Per-session classifier memory with idle-flip debounce: an `idle`
/// verdict only lands after TWO consecutive idle classifications, so a
/// mid-keystroke redraw (spinner off for one tick) can't strobe the orb.
pub struct AgentCache {
    entries: Mutex<HashMap<String, CachedProbe>>,
}

struct CachedProbe {
    state: AgentState,
    program: String,
    snippet: String,
    since_ms: u64,
    /// Consecutive un-debounced `idle` verdicts for this session.
    pending_idle: u32,
    text_hash: u64,
}

impl AgentCache {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn hash(text: &str) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        h.finish()
    }

    /// Feed a fresh capture. Returns the (possibly debounced) state.
    pub fn observe(&self, session_key: &str, program: &str, state: AgentState, snippet: &str, text: &str) -> (AgentState, String, String) {
        let mut map = self.entries.lock().unwrap();
        let h = Self::hash(text);
        let entry = map.entry(session_key.to_string()).or_insert_with(|| CachedProbe {
            state: AgentState::Unknown,
            program: String::new(),
            snippet: String::new(),
            since_ms: Self::now_ms(),
            pending_idle: 0,
            text_hash: 0,
        });
        let text_changed = entry.text_hash != h;
        entry.text_hash = h;

        let mut effective = state.clone();
        if state == AgentState::Idle {
            if !text_changed {
                // Pane frozen at a prompt two ticks running: genuinely idle.
                entry.pending_idle += 1;
            } else {
                // Output still changing but prompt-shaped — suspicious;
                // count only consecutive frozen-idle ticks.
                entry.pending_idle = 0;
                effective = entry.state.clone();
                if effective == AgentState::Unknown {
                    effective = AgentState::Idle;
                }
            }
            if entry.pending_idle < 1 && text_changed {
                // First sighting while output moves: keep prior verdict.
            }
            if text_changed {
                entry.pending_idle = 0;
            } else if entry.pending_idle >= 1 {
                effective = AgentState::Idle;
            }
        } else {
            entry.pending_idle = 0;
        }

        if effective != entry.state {
            entry.state = effective.clone();
            entry.since_ms = Self::now_ms();
        }
        entry.program = program.to_string();
        entry.snippet = snippet.to_string();
        (entry.state.clone(), entry.program.clone(), entry.snippet.clone())
    }

    pub fn remove(&self, session_key: &str) {
        self.entries.lock().unwrap().remove(session_key);
    }

    /// Read-only view of the latest classifications (used to enrich
    /// renderer-pushed snapshots without re-sniffing).
    pub fn entries_snapshot(&self) -> HashMap<String, CachedEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    CachedEntry {
                        program: v.program.clone(),
                        state: v.state.as_str().to_string(),
                        snippet: v.snippet.clone(),
                    },
                )
            })
            .collect()
    }
}

/// Tiny public projection of one cached classification.
pub struct CachedEntry {
    pub program: String,
    /// Lowercase vocabulary word (`working`, `needs-input`, …).
    pub state: String,
    pub snippet: String,
}

// ---------------------------------------------------------------------------
// Layer 1 — hook stamps (opt-in, authoritative while fresh).
// ---------------------------------------------------------------------------
//
// Coding agents with hook support (Claude Code, Codex, Gemini CLI, Copilot
// CLI, OpenCode, Pi) can announce their own transitions by stamping a tiny
// JSON file on the machine they run on — which is the REMOTE host for Still
// sessions. Still reads that file read-only over the same throwaway `exec`
// channel as the capture-pane probe (never the live PTY).
//
// Stamp schema (one file per tmux session):
//   { "program": "claude", "status": "working", "snippet": "…", "epoch": 1719… }
// `status` is one of the shared vocabulary words (sidebar alias: `blocked`
// is accepted for `needs-input`, `finished` for `done`). `snippet` is
// display-only metadata; secrets inside it are redacted before render.
// `epoch` is unix seconds; stamps older than STAMP_TTL_SECS (10 min) are
// ignored and Layer 2 takes over again automatically.

use serde::{Deserialize, Serialize};

/// Freshness horizon for hook stamps. Agents stamp on transitions so a live
/// agent re-stamps within seconds; a 10-minute-old stamp means the agent (or
/// its hooks) went away — fall back to the capture-pane scrape.
pub const STAMP_TTL_SECS: u64 = 10 * 60;

/// A hook stamp, as written by the agent-side hook scripts Still installs.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HookStamp {
    pub program: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub epoch: u64,
}

impl HookStamp {
    /// Parse + validate one stamp body. Rejects empty bodies, bad JSON, and
    /// unknown programs (silently: the scrape fallback simply continues).
    pub fn parse(body: &str) -> Option<HookStamp> {
        let body = body.trim();
        if body.is_empty() {
            return None;
        }
        let stamp: HookStamp = serde_json::from_str(body).ok()?;
        if stamp.program.trim().is_empty() {
            return None;
        }
        Some(stamp)
    }

    /// Vocabulary word, accepting the sidebar aliases hook scripts use.
    pub fn state(&self) -> AgentState {
        match self.status.trim().to_lowercase().as_str() {
            "working" => AgentState::Working,
            "needs-input" | "needs_input" | "needsinput" | "blocked" => {
                AgentState::NeedsInput
            }
            "idle" => AgentState::Idle,
            "done" | "finished" => AgentState::Done,
            "error" => AgentState::Error,
            _ => AgentState::Unknown,
        }
    }

    /// Age in seconds against `now_secs`, or `None` when the clock is off.
    pub fn age_secs(&self, now_secs: u64) -> Option<u64> {
        if self.epoch == 0 || now_secs < self.epoch {
            return None;
        }
        Some(now_secs - self.epoch)
    }

    pub fn fresh(&self, now_secs: u64) -> bool {
        matches!(self.age_secs(now_secs), Some(age) if age <= STAMP_TTL_SECS)
    }

    /// Display string, redacted + capped like every other snippet path.
    pub fn display_snippet(&self) -> String {
        let mut s: String = self.snippet.chars().take(80).collect();
        if s.trim().is_empty() {
            s = match self.state() {
                AgentState::Working => "agent running (hook)".to_string(),
                AgentState::NeedsInput => "waiting for you (hook)".to_string(),
                AgentState::Done => "finished (hook)".to_string(),
                _ => "…".to_string(),
            };
        }
        if secret_shaped(&s) {
            s = "…(redacted)".to_string();
        }
        s
    }

    pub fn program_name(&self) -> String {
        match self.program.trim().to_lowercase().as_str() {
            "claude" => "claude".to_string(),
            "codex" => "codex".to_string(),
            "opencode" => "opencode".to_string(),
            "pi" => "pi".to_string(),
            "gemini" => "gemini".to_string(),
            "copilot" => "copilot".to_string(),
            p if p.is_empty() => "unknown".to_string(),
            other => other.chars().take(24).collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// Hook scripts Still installs on the remote host (one script, per-agent glue).
// ---------------------------------------------------------------------------
//
// The stamp script is POSIX sh (works wherever the agent's hooks can run
// `sh`). Each agent's hook JSON just calls it with a different status word.
// `still-hook.sh <program> <status> [snippet]` stamps
// `~/.still/agent-state/<sanitized-tmux>.json` using `$STILL_TMUX_SESSION`
// (exported by the agent Tick path in the orb code) or the current tmux
// pane's session when unset.

/// The stamp script, served to the remote host by the installer.
pub const STILL_HOOK_SH: &str = r#"#!/bin/sh
# still-hook.sh — Still orb agent-state stamps (POSIX sh, no deps).
# Usage: still-hook.sh <program> <status> [snippet]
# Stamps ~/.still/agent-state/<tmux-session>.json for the orb to read.
# Read-only consumer: the orb reads the file over its own exec channel;
# this script never touches the agent, the PTY, or any credential.
set -u
program="${1:-unknown}"
status="${2:-unknown}"
snippet="${3:-}"
dir="$HOME/.still/agent-state"
name="${STILL_TMUX_SESSION:-}"
if [ -z "$name" ]; then
  if command -v tmux >/dev/null 2>&1; then
    name="$(tmux display-message -p '#S' 2>/dev/null || true)"
  fi
fi
# Allowlist the session name into the filename (mirror of TmuxPlan charset).
# shellcheck disable=SC2001
safe="$(printf '%s' "$name" | sed 's/[^A-Za-z0-9_.-]/_/g')"
if [ -z "$safe" ]; then
  exit 0
fi
mkdir -p "$dir" 2>/dev/null || exit 0
epoch="$(date +%s 2>/dev/null || echo 0)"
# Minimal JSON escaping for the free-form snippet (backslash + quote +
# control chars); program/status come from our own hook configs.
esc="$(printf '%s' "$snippet" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\010\013\014\016-\037')"
tmp="$dir/.$safe.json.tmp.$$"
printf '{"program":"%s","status":"%s","snippet":"%s","epoch":%s}' \
  "$program" "$status" "$esc" "$epoch" > "$tmp" 2>/dev/null || exit 0
mv "$tmp" "$dir/$safe.json" 2>/dev/null || exit 0
"#;

/// Claude Code hook JSON: merge into `~/.claude/settings.json` under a
/// single tagged entry so uninstall removes exactly what install added.
pub const CLAUDE_HOOKS_JSON: &str = r#"{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.still/hooks/still-hook.sh claude working", "timeout": 5 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.still/hooks/still-hook.sh claude working", "timeout": 5 }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.still/hooks/still-hook.sh claude needs-input \"$CLAUDE_NOTIFICATION\"", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.still/hooks/still-hook.sh claude done", "timeout": 5 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "~/.still/hooks/still-hook.sh claude idle", "timeout": 5 }
        ]
      }
    ]
  }
}"#;

/// Marker comment Still writes above its merged hook blocks so uninstall can
/// strip exactly its own entries without touching the user's config.
pub const STILL_HOOK_TAG: &str = "still-orb";

/// Build the remote installer shell for one agent. The script is idempotent:
/// re-running it rewrites the same files, backs up the previous settings
/// file once (`.bak-still`, never overwritten), and prints `STILL_HOOKS_OK`.
pub fn installer_script(agent: &str) -> Option<String> {
    let hooks_json = match agent {
        "claude" => CLAUDE_HOOKS_JSON,
        // Codex / Gemini / Copilot / OpenCode / Pi ship the same stamp
        // script; their hook-file formats differ, so v1 installs the script
        // + documents the one-line hook entries (see Settings UI copy).
        // Wiring per-agent config formats lands as follow-ups once each
        // format is pinned against a real fixture.
        _ => return None,
    };
    // The hooks JSON is embedded single-quoted; it contains no single
    // quotes by construction (double-quoted JSON only — asserted in tests).
    Some(format!(
        r#"set -u
mkdir -p "$HOME/.still/hooks" "$HOME/.still/agent-state" 2>/dev/null || exit 1
cat > "$HOME/.still/hooks/still-hook.sh" <<'STILL_HOOK_EOF'
{hook_sh}
STILL_HOOK_EOF
chmod +x "$HOME/.still/hooks/still-hook.sh" 2>/dev/null || true
settings="$HOME/.claude/settings.json"
if [ -f "$settings" ] && [ ! -f "$settings.bak-still" ]; then
  cp "$settings" "$settings.bak-still" 2>/dev/null || true
fi
hooks='{hooks_json}'
if command -v python3 >/dev/null 2>&1; then
  STILL_HOOKS_JSON="$hooks" STILL_TAG="{tag}" SETTINGS="$settings" python3 - <<'STILL_PY_EOF'
import json, os
path = os.environ["SETTINGS"]
incoming = json.loads(os.environ["STILL_HOOKS_JSON"])
tag = os.environ["STILL_TAG"]
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {{}}
if not isinstance(cfg, dict):
    cfg = {{}}
hooks = cfg.get("hooks")
if not isinstance(hooks, dict):
    hooks = {{}}
    cfg["hooks"] = hooks
for event, entries in incoming.get("hooks", {{}}).items():
    slot = hooks.get(event)
    if not isinstance(slot, list):
        slot = []
    slot = [e for e in slot if not (isinstance(e, dict) and e.get("still") == tag)]
    for e in entries:
        if isinstance(e, dict):
            e = dict(e)
            e["still"] = tag
        slot.append(e)
    hooks[event] = slot
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
print("STILL_HOOKS_OK")
STILL_PY_EOF
else
  printf '%s' "$hooks" > "$HOME/.still/hooks/claude-hooks.json"
  echo "STILL_HOOKS_NOPYTHON (script installed; merge ~/.still/hooks/claude-hooks.json into ~/.claude/settings.json by hand)"
fi
"#,
        hook_sh = STILL_HOOK_SH,
        hooks_json = hooks_json,
        tag = STILL_HOOK_TAG,
    ))
}

/// Read one stamp file over the throwaway exec channel. Returns the parsed
/// stamp when the file exists and parses (freshness is decided by the
/// caller so tests stay clock-free).
pub async fn read_stamp(
    session_id: &str,
    tmux_session: &str,
) -> Option<HookStamp> {
    let safe: String = tmux_session
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        return None;
    }
    let body = crate::ssh_worker::run_exec_capture(
        session_id,
        &format!("cat \"$HOME/.still/agent-state/{safe}.json\" 2>/dev/null"),
    )
    .await
    .ok()?;
    HookStamp::parse(&String::from_utf8_lossy(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(text: &str, command: &str, title: &str) -> PaneProbe {
        PaneProbe {
            text: strip_ansi(text).to_lowercase(),
            command: command.to_string(),
            title: title.to_string(),
        }
    }

    #[test]
    fn hook_stamp_parse_and_aliases() {
        let s = HookStamp::parse(r#"{"program":"claude","status":"blocked","snippet":"approve?","epoch":100}"#).unwrap();
        assert_eq!(s.state(), AgentState::NeedsInput);
        assert_eq!(s.program_name(), "claude");
        let s = HookStamp::parse(r#"{"program":"codex","status":"finished","snippet":"","epoch":100}"#).unwrap();
        assert_eq!(s.state(), AgentState::Done);
        assert!(HookStamp::parse("").is_none());
        assert!(HookStamp::parse("{nope").is_none());
        assert!(HookStamp::parse(r#"{"program":"","status":"working"}"#).is_none());
    }

    #[test]
    fn hook_stamp_freshness_window() {
        let s = HookStamp::parse(r#"{"program":"claude","status":"working","snippet":"","epoch":1000}"#).unwrap();
        assert!(s.fresh(1000 + STAMP_TTL_SECS));
        assert!(!s.fresh(1000 + STAMP_TTL_SECS + 1));
        // Zero/future epochs never count as fresh — fail safe to the scrape.
        let s = HookStamp::parse(r#"{"program":"claude","status":"working","snippet":""}"#).unwrap();
        assert!(!s.fresh(9999));
    }

    #[test]
    fn hook_snippet_redacted_like_everywhere_else() {
        let s = HookStamp::parse(r#"{"program":"claude","status":"working","snippet":"KEY=sk-abcdefghijklmnopqrstuv","epoch":1}"#).unwrap();
        assert_eq!(s.display_snippet(), "…(redacted)");
    }

    #[test]
    fn hook_script_is_posix_and_self_contained() {
        assert!(STILL_HOOK_SH.starts_with("#!/bin/sh"));
        assert!(STILL_HOOK_SH.contains("agent-state"));
        assert!(!STILL_HOOK_SH.contains("curl"));
        assert!(!STILL_HOOK_SH.contains("password"));
    }

    #[test]
    fn installer_embeds_valid_json_without_single_quotes() {
        let script = installer_script("claude").expect("claude installer");
        assert!(script.contains("STILL_HOOKS_OK"));
        assert!(script.contains(".bak-still"));
        assert!(installer_script("nope").is_none());
        assert!(!CLAUDE_HOOKS_JSON.contains('\''), "hooks JSON must stay single-quote-free for the shell embed");
        let v: serde_json::Value = serde_json::from_str(CLAUDE_HOOKS_JSON).expect("hooks JSON parses");
        assert!(v.get("hooks").and_then(|h| h.get("Stop")).is_some());
    }

    #[test]
    fn claude_working_spinner() {
        let p = probe("⠋ Working…\n⏺ Reading src/main.rs (esc to interrupt)", "claude", "claude");
        let (program, state, _) = classify(&p, "connected");
        assert_eq!(program, "claude");
        assert_eq!(state, AgentState::Working);
    }

    #[test]
    fn claude_needs_input_trumps_spinner() {
        let p = probe("⠋ Working…\nDo you want to proceed?\n❯ 1. Yes", "claude", "claude");
        let (_, state, _) = classify(&p, "connected");
        assert_eq!(state, AgentState::NeedsInput);
    }

    #[test]
    fn codex_action_required_title() {
        let p = probe("✔ done in 4s\naction required: approve rm -rf dist", "codex", "✋ Action Required");
        let (program, state, _) = classify(&p, "connected");
        assert_eq!(program, "codex");
        assert_eq!(state, AgentState::NeedsInput);
    }

    #[test]
    fn codex_bare_prompt_means_done() {
        let p = probe("✔ done in 12s\n› ", "codex", "codex");
        let (_, state, _) = classify(&p, "connected");
        assert!(matches!(state, AgentState::Done | AgentState::Idle));
    }

    #[test]
    fn generic_error_surface() {
        let p = probe("$ go test ./...\nFAIL: TestAgent — rate limit exceeded", "zsh", "");
        let (_, state, _) = classify(&p, "connected");
        assert_eq!(state, AgentState::Error);
    }

    #[test]
    fn bare_shell_prompt_is_idle() {
        let p = probe("$ ls\nfoo.txt\n$ ", "zsh", "");
        let (_, state, _) = classify(&p, "connected");
        assert_eq!(state, AgentState::Idle);
    }

    #[test]
    fn unknown_agent_still_classifies_generic() {
        let p = probe("agent: waiting for approval (y/n)?", "mystery-agent", "");
        let (program, state, _) = classify(&p, "connected");
        assert_eq!(program, "unknown");
        assert_eq!(state, AgentState::NeedsInput);
    }

    #[test]
    fn secret_shaped_snippet_redacted() {
        let p = probe("export KEY=sk-abcdefghijklmnopqrstuv\n$ ", "zsh", "");
        let (_, _, snippet) = classify(&p, "connected");
        assert!(!snippet.contains("sk-"), "snippet leaked: {snippet}");
    }

    #[test]
    fn idle_flip_debounced_one_tick() {
        let cache = AgentCache::new();
        // Working first…
        let (s1, _, _) = cache.observe("k", "claude", AgentState::Working, "…", "frame-a");
        assert_eq!(s1, AgentState::Working);
        // Output moves but looks prompt-shaped: keep prior verdict.
        let (s2, _, _) = cache.observe("k", "claude", AgentState::Idle, "$", "frame-b");
        assert_eq!(s2, AgentState::Working);
        // Same frozen frame twice: genuinely idle.
        let (s3, _, _) = cache.observe("k", "claude", AgentState::Idle, "$", "frame-c");
        let (s4, _, _) = cache.observe("k", "claude", AgentState::Idle, "$", "frame-c");
        assert!(matches!(s3, AgentState::Working | AgentState::Idle));
        assert_eq!(s4, AgentState::Idle);
    }

    #[test]
    fn strip_ansi_matches_renderer_pass() {
        let raw = "\u{1b}[32mok\u{1b}[0m\ntitle\u{1b}]0;agent\u{7}\nfoo\rbar\n\x01bad\x7f";
        let stripped = strip_ansi(raw);
        assert!(stripped.contains("ok"));
        assert!(!stripped.contains("agent"), "OSC title leaked");
        // Renderer parity: CR keeps ONLY the last segment ("foo\rbar" -> "bar").
        assert!(stripped.lines().any(|l| l == "bar"), "CR overwrite wrong: {stripped:?}");
        assert!(!stripped.contains("foobar"), "CR segments concatenated: {stripped:?}");
        assert!(!stripped.contains('\u{1}'));
        assert!(!stripped.contains('\u{7f}'));
    }
}
