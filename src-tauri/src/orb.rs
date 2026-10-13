//! Still orb — floating companion window management.
//!
//! Owns the `main` <-> `orb` visibility swap:
//! - minimize-to-orb: hide main, show the always-on-top orb circle.
//! - restore-from-orb: hide orb, show + focus main.
//! - taskbar minimize fallback (Win+Down / taskbar) also routes to the orb.
//!
//! The orb is a separate transparent webview (`orb` window, `index.html?orb=1`)
//! so every byte it shows is renderer-owned; no SSH bytes ever flow into it.
//! The snapshot it renders is captured by the MAIN renderer (which stays alive
//! while hidden) and pushed here via `still_orb_push`, and additionally
//! served on demand via `still_orb_snapshot`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const MAIN_LABEL: &str = "main";
pub const ORB_LABEL: &str = "orb";

/// One orb stack row. Metadata-only: never secrets, never raw escape bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbRow {
    pub session_id: String,
    pub name: String,
    pub host: String,
    pub program: String,
    pub status: String,
    pub snippet: String,
    pub changed_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbSnapshot {
    pub rows: Vec<OrbRow>,
}

/// Renderer-pushed snapshot kept as the single source of truth for the orb
/// stack. Updated from the main window whenever hidden.
pub struct OrbState {
    pub snapshot: Mutex<Option<OrbSnapshot>>,
    /// Zero-config classifier memory fed by the `agent_tick` task.
    pub agent_cache: crate::agent_state::AgentCache,
}

impl OrbState {
    pub fn new() -> Self {
        Self {
            snapshot: Mutex::new(None),
            agent_cache: crate::agent_state::AgentCache::new(),
        }
    }
}

fn win(app: &AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(label)
}

/// Hide the main window and float the orb over everything.
/// First show positions it bottom-right of the primary monitor.
pub fn minimize_to_orb(app: &AppHandle) -> Result<(), String> {
    if let Some(orb) = win(app, ORB_LABEL) {
        if !orb.is_visible().unwrap_or(false) {
            position_bottom_right_once(app, &orb);
            orb.show().map_err(|e| e.to_string())?;
        }
    }
    if let Some(main) = win(app, MAIN_LABEL) {
        main.hide().map_err(|e| e.to_string())?;
    }
    push_state(app);
    Ok(())
}

/// Hide the orb, bring the main window back, focus it.
pub fn restore_from_orb(app: &AppHandle) -> Result<(), String> {
    if let Some(orb) = win(app, ORB_LABEL) {
        let _ = orb.hide();
    }
    if let Some(main) = win(app, MAIN_LABEL) {
        main.show().map_err(|e| e.to_string())?;
        let _ = main.set_focus();
    }
    Ok(())
}

/// OS-level minimize (taskbar / Win+Down): route to the orb too, so every
/// road leads to the floating companion.
pub fn on_main_minimize(app: &AppHandle) -> Result<(), String> {
    minimize_to_orb(app)
}

/// Hide only the orb (right-click -> "hide orb", no restore).
pub fn orb_hide(app: &AppHandle) -> Result<(), String> {
    if let Some(orb) = win(app, ORB_LABEL) {
        orb.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Store the latest renderer snapshot and fan it out to the orb window.
pub fn push_state(app: &AppHandle) {
    if let Some(state) = app.try_state::<OrbState>() {
        let snap = state.snapshot.lock().unwrap().clone();
        if let Some(snap) = snap {
            let _ = app.emit_to(ORB_LABEL, "still://orb-state", snap);
        }
    }
}

pub fn set_snapshot(app: &AppHandle, snapshot: OrbSnapshot) {
    if let Some(state) = app.try_state::<OrbState>() {
        // Renderer-pushed rows carry `program: "unknown"` (the webview has no
        // pane command/title). Preserve Rust-classified program/state for
        // sessions we have already sniffed — merge key = session id.
        let enriched: Vec<OrbRow> = {
            let cache = state.agent_cache.entries_snapshot();
            snapshot
                .rows
                .into_iter()
                .map(|mut row| {
                    if row.program == "unknown" {
                        if let Some(hit) = cache.get(&row.session_id) {
                            row.program = hit.program.clone();
                            // Rust sniff wins on state too: fall back only when
                            // we have never observed this session.
                            row.status = hit.state.clone();
                            if row.snippet.is_empty() || row.snippet == "no output — idle" {
                                row.snippet = hit.snippet.clone();
                            }
                        }
                    }
                    row
                })
                .collect()
        };
        *state.snapshot.lock().unwrap() = Some(OrbSnapshot { rows: enriched });
    }
    push_state(app);
}

pub fn get_snapshot(app: &AppHandle) -> OrbSnapshot {
    app.try_state::<OrbState>()
        .and_then(|s| s.snapshot.lock().unwrap().clone())
        .unwrap_or(OrbSnapshot { rows: Vec::new() })
}

/// Zero-config sniff tick: one live session per call (round-robin).
///
/// Called from the background task every ~2.5s. Pastes NOTHING anywhere;
/// the probe opens its own `exec` channel and only reads `capture-pane`.
/// Classified rows land in the snapshot cache immediately so `orb_snapshot`
/// stays fresh even when the main renderer stops pushing (or never has
/// live transcript bytes, e.g. freshly reattached sessions).
pub async fn agent_tick(app: &AppHandle, idx: &mut usize) {
    // Collect candidate sessions (native id + tmux name + connection state)
    // under a short lock, then drop the lock before any network I/O.
    let candidates: Vec<(String, String, String)> = {
        let Some(app_state) = app.try_state::<crate::commands::AppState>() else {
            return;
        };
        let map = app_state.sessions.lock().await;
        let mut out = Vec::new();
        for (native_id, live) in map.iter() {
            let live = live.lock().await;
            let hint = match live.status {
                crate::core::SessionStatus::Live => "connected",
                crate::core::SessionStatus::Connecting => "connecting",
                crate::core::SessionStatus::Error => "error",
                crate::core::SessionStatus::Closed => "closed",
                crate::core::SessionStatus::Idle => "idle",
            };
            if !matches!(live.status, crate::core::SessionStatus::Live) {
                continue;
            }
            out.push((
                native_id.clone(),
                live.config.tmux_session.clone(),
                hint.to_string(),
            ));
        }
        out
    };
    if candidates.is_empty() {
        return;
    }
    *idx = (*idx + 1) % candidates.len();
    let (native_id, tmux_name, hint) = candidates[*idx].clone();

    let Some(probe) =
        crate::ssh_worker::probe_agent_pane(&native_id, &tmux_name).await
    else {
        return; // tmux gone / exec denied: keep last known classification
    };
    let (program, state, snippet) =
        crate::agent_state::classify(&probe, &hint);

    // Layer 1: a fresh hook stamp from the agent itself wins over the
    // scrape. The stamp lives on the REMOTE host (where the agent runs),
    // read over the same throwaway exec channel — never the PTY.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (program, state, snippet, smart_used) =
        match crate::agent_state::read_stamp(&native_id, &tmux_name).await {
            Some(stamp) if stamp.fresh(now_secs) => (
                stamp.program_name(),
                stamp.state(),
                stamp.display_snippet(),
                false,
            ),
            _ => {
                // Layer 1b (Smart, BYO endpoint, default OFF): a confident
                // local-AI verdict beats the keyword scrape. Anything else
                // (disabled, refused, slow, unsure) falls through to it.
                let smart_cfg = app
                    .try_state::<crate::orb_model::SmartState>()
                    .map(|s| s.get());
                let mut verdict = None;
                if let Some(cfg) = smart_cfg {
                    if cfg.enabled {
                        verdict = crate::orb_model::classify(
                            &cfg.endpoint,
                            cfg.cutoff,
                            &probe.text,
                        )
                        .await;
                    }
                }
                match verdict {
                    Some((smart_state, confidence)) => {
                        // Privacy: pane bytes NEVER enter diag. Only the
                        // verdict word + confidence + scrape agreement.
                        crate::diag::record(
                            "rust",
                            "SMART_VERDICT",
                            &tmux_name,
                            "",
                            true,
                            smart_state.as_str(),
                            &format!("conf={confidence:.2}"),
                            None,
                        );
                        // Program id still comes from the pane command/title
                        // (the model only classifies state, never identity);
                        // snippet still comes from the deterministic picker.
                        (program, smart_state, snippet, true)
                    }
                    None => (program, state, snippet, false),
                }
            }
        };
    let _ = smart_used;

    let Some(orb_state) = app.try_state::<OrbState>() else {
        return;
    };
    // Session key = stable tmux name (survives reconnects; native ids do not).
    let (state2, program2, snippet2) = orb_state.agent_cache.observe(
        &tmux_name,
        &program,
        state,
        &snippet,
        &probe.text,
    );
    // Merge into the served snapshot: Rust-owned sidecar row so the orb
    // always has SOMETHING live even before the renderer pushes its first
    // snapshot (fresh reattach, first minimize, …).
    let mut guard = orb_state.snapshot.lock().unwrap();
    if let Some(snap) = guard.as_mut() {
        upsert_sniffed_row(snap, &tmux_name, &program2, &state2, &snippet2);
        // Normalize ordering to the shared urgency vocabulary.
        snap.rows.sort_by_key(|r| urgency(&r.status));
        snap.rows.truncate(4);
    } else {
        let mut snap = OrbSnapshot { rows: Vec::new() };
        upsert_sniffed_row(&mut snap, &tmux_name, &program2, &state2, &snippet2);
        *guard = Some(snap);
    }
    drop(guard);
    push_state(app);
}

fn urgency(status: &str) -> u8 {
    match status {
        "needs-input" => 0,
        "working" => 1,
        "error" => 2,
        "done" => 3,
        "idle" => 4,
        _ => 5,
    }
}

/// Rust-owned sidecar row keyed by tmux name (`still:<tmux>` id), so the orb
/// always has SOMETHING live even before the renderer pushes its first
/// snapshot.
fn upsert_sniffed_row(
    snap: &mut OrbSnapshot,
    tmux_name: &str,
    program: &str,
    state: &crate::agent_state::AgentState,
    snippet: &str,
) {
    let id = format!("still:{tmux_name}");
    let status = state.as_str().to_string();
    if let Some(row) = snap.rows.iter_mut().find(|r| r.session_id == id) {
        row.program = program.to_string();
        row.status = status;
        row.snippet = snippet.to_string();
    } else {
        snap.rows.push(OrbRow {
            session_id: id,
            name: tmux_name.to_string(),
            host: String::new(),
            program: program.to_string(),
            status,
            snippet: snippet.to_string(),
            changed_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
}

/// First-show placement: bottom-right of the primary monitor, ~16px inset.
/// Later moves are user-dragged; the renderer persists those itself.
fn position_bottom_right_once(app: &AppHandle, orb: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;
    let Ok(Some(monitor)) = app.primary_monitor() else { return };
    let pos = monitor.position();
    let size = monitor.size();
    let (w, h) = orb.outer_size().map(|s| (s.width, s.height)).unwrap_or((112, 112));
    let inset: i32 = 16;
    let x = pos.x + size.width as i32 - w as i32 - inset;
    let y = pos.y + size.height as i32 - h as i32 - inset;
    let _ = orb.set_position(PhysicalPosition::new(x.max(pos.x), y.max(pos.y)));
}
