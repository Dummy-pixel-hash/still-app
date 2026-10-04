//! Temporary Windows-connection diagnostics (milestone: DIAGNOSTICS ONLY).
//!
//! Append-only JSON-lines log at a deterministic per-user location so the
//! packaged Windows artifact (`windows_subsystem = "windows"`, no console)
//! still yields evidence. No behavior change: logging only, never alters
//! control flow. NEVER log secrets — only ids, stages, elapsed ms, and
//! short error code/message strings.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Max chars kept per free-form field (code/message). Prevents runaway lines.
const FIELD_CAP: usize = 300;

/// Process-wide append mutex: keeps concurrent worker/forward tasks from
/// interleaving bytes mid-line. Short critical section; poison-tolerant
/// (diagnostics must never panic or break the product path).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Resolve the deterministic per-user diagnostic log path.
///
/// Windows release: `%LOCALAPPDATA%\Still\logs\still-diag.log`.
/// Other OSes (local verification): `$XDG_STATE_HOME/still/logs/`,
/// `~/.local/state/still/logs/`, or tempdir fallback. Directory is created
/// on first write; failures are silent (diagnostics must never break prod).
pub fn log_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.trim().is_empty() {
                return PathBuf::from(local)
                    .join("Still")
                    .join("logs")
                    .join("still-diag.log");
            }
        }
        // Fallback: USERPROFILE\AppData\Local
        if let Ok(home) = std::env::var("USERPROFILE") {
            return PathBuf::from(home)
                .join("AppData")
                .join("Local")
                .join("Still")
                .join("logs")
                .join("still-diag.log");
        }
        PathBuf::from("still-diag.log")
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
            if !xdg.trim().is_empty() {
                return PathBuf::from(xdg).join("still/logs/still-diag.log");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local/state/still/logs/still-diag.log");
        }
        std::env::temp_dir().join("still-diag.log")
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn cap(s: &str) -> String {
    let mut out: String = s.chars().take(FIELD_CAP).collect();
    if s.chars().count() > FIELD_CAP {
        out.push('…');
    }
    // Keep JSONL one-line: strip control chars.
    out.replace(['\n', '\r'], " ")
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Core append: one JSON object per line. Synchronous, fire-and-forget.
/// Safe to call from async code (short blocking section, errors swallowed).
/// - creates parent dirs automatically
/// - opens/creates the file automatically
/// - flushes promptly so a killed/hung app still leaves evidence
/// - never panics, never affects connection behavior
/// - process-wide mutex keeps concurrent writes line-atomic
pub fn record(
    layer: &str,
    stage: &str,
    local_id: &str,
    native_id: &str,
    ok: bool,
    code: &str,
    message: &str,
    elapsed_ms: Option<u128>,
) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = format!(
        "{{\"ts\":{},\"layer\":\"{}\",\"stage\":\"{}\",\"localId\":\"{}\",\"nativeId\":\"{}\",\"ok\":{},\"code\":\"{}\",\"message\":\"{}\",\"elapsedMs\":{}}}\n",
        now_ms(),
        esc(layer),
        esc(stage),
        esc(&cap(local_id)),
        esc(&cap(native_id)),
        ok,
        esc(&cap(code)),
        esc(&cap(message)),
        elapsed_ms
            .map(|e| e.to_string())
            .unwrap_or_else(|| "null".to_string()),
    );
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path)
    {
        // Mutex keeps lines atomic across concurrent workers; a poisoned
        // mutex still proceeds (diagnostics never panic).
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _ = f.write_all(line.as_bytes());
        // Prompt flush: evidence must survive a hung/crashed process.
        let _ = f.flush();
        // Belt-and-braces on Windows: also push bytes to disk.
        let _ = f.sync_all();
    }
}

/// Convenience: successful checkpoint.
pub fn ok(layer: &str, stage: &str, local_id: &str, native_id: &str) {
    record(layer, stage, local_id, native_id, true, "", "", None);
}

/// Convenience: successful checkpoint with elapsed time.
pub fn ok_elapsed(
    layer: &str,
    stage: &str,
    local_id: &str,
    native_id: &str,
    elapsed_ms: u128,
) {
    record(layer, stage, local_id, native_id, true, "", "", Some(elapsed_ms));
}

/// Convenience: failed checkpoint with short classification (no secrets).
pub fn fail(
    layer: &str,
    stage: &str,
    local_id: &str,
    native_id: &str,
    code: &str,
    message: &str,
) {
    record(layer, stage, local_id, native_id, false, code, message, None);
}

/// Convenience: failed checkpoint with elapsed time.
pub fn fail_elapsed(
    layer: &str,
    stage: &str,
    local_id: &str,
    native_id: &str,
    code: &str,
    message: &str,
    elapsed_ms: u128,
) {
    record(
        layer,
        stage,
        local_id,
        native_id,
        false,
        code,
        message,
        Some(elapsed_ms),
    );
}

/// Short, secret-free error classification for anyhow failures.
/// Keeps first line only, capped — never includes secrets by construction
/// (callers pass only stage context + the error's Display).
pub fn classify(err: &anyhow::Error) -> (String, String) {
    let full = format!("{err:#}");
    let first = full.lines().next().unwrap_or("error").trim();
    let lower = first.to_lowercase();
    let code = if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("refused") {
        "refused"
    } else if lower.contains("unreachable") || lower.contains("no route") {
        "unreachable"
    } else if lower.contains("auth") {
        "auth"
    } else if lower.contains("host key") || lower.contains("hostkey") {
        "hostkey"
    } else {
        "error"
    };
    (code.to_string(), cap(first))
}

/// DIAG-ONLY definitive startup marker.
///
/// Proves the artifact actually contains the diagnostic build: written once
/// at native startup (before any window/IPC), carrying platform + build
/// identity. `commit` prefers the `STILL_BUILD_COMMIT` env baked at CI
/// time, else falls back to `"unknown"` (never empty, never a secret).
/// This is also where the resolved log path is recorded first.
pub fn app_start() {
    let commit = option_env!("STILL_BUILD_COMMIT").unwrap_or("unknown");
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let msg = format!(
        "os={} arch={} profile={} version={} commit={} path={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        profile,
        env!("CARGO_PKG_VERSION"),
        commit,
        log_path().display(),
    );
    record("rust", "APP_START", "", "", true, "", &msg, None);
}
