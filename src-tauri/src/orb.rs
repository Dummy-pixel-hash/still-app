//! Opt-in smoked-glass companion. No SSH operations, terminal scraping, or model calls.
//! Main publishes bounded metadata; the companion never owns a connection.

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const MAIN: &str = "main";
const ORB: &str = "orb";
const MAX_ROWS: usize = 64;
const OUTPUT_ACTIVE_MS: u64 = 8_000;
const STALE_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OrbSpeed {
    Slow,
    Normal,
    Fast,
}
impl Default for OrbSpeed {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrbPreferences {
    enabled: bool,
    size: u32,
    paused: bool,
    #[serde(default)]
    speed: OrbSpeed,
}
impl Default for OrbPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            size: 64,
            paused: false,
            speed: OrbSpeed::Normal,
        }
    }
}
impl OrbPreferences {
    fn validate(&self) -> Result<(), String> {
        if ![48, 64, 96].contains(&self.size) {
            return Err("Unsupported orb size".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Signal {
    Connected,
    Connecting,
    Auth,
    HostKey,
    HostKeyChanged,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrbRow {
    session_id: String,
    name: String,
    signal: Signal,
    changed_at: u64,
    last_output_at: Option<u64>,
}
impl OrbRow {
    fn active(&self, now: u64) -> bool {
        self.signal == Signal::Connected
            && self
                .last_output_at
                .is_some_and(|at| at <= now && now - at < OUTPUT_ACTIVE_MS)
    }
    fn priority(&self, now: u64) -> u8 {
        match self.signal {
            Signal::Auth | Signal::HostKey => 0,
            Signal::HostKeyChanged | Signal::Error => 1,
            Signal::Connected if self.active(now) => 2,
            Signal::Connecting => 3,
            _ => 4,
        }
    }
    #[cfg(desktop)]
    fn label(&self, now: u64) -> &'static str {
        match self.signal {
            Signal::Auth => "Sign-in required",
            Signal::HostKey => "Review host key",
            Signal::HostKeyChanged => "Host key changed",
            Signal::Error => "Connection error",
            Signal::Connecting => "Connecting",
            Signal::Connected if self.active(now) => "Output active",
            Signal::Connected => "Connected · agent status unknown",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbSnapshot {
    revision: u64,
    published_at: u64,
    preferences: OrbPreferences,
    rows: Vec<OrbRow>,
}
impl OrbSnapshot {
    fn fresh(&self, now: u64) -> bool {
        self.published_at > 0 && self.published_at <= now && now - self.published_at <= STALE_MS
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum OrbCommand {
    Open {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
    Workspace,
    Hide,
    Pause {
        paused: bool,
    },
    Reset,
    Focus,
    Drag,
    Nudge {
        dx: f64,
        dy: f64,
    },
    Menu,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum OrbAction {
    Open {
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
    },
    Preferences {
        preferences: OrbPreferences,
    },
    Reset,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct SavedPosition {
    x: i32,
    y: i32,
}

#[derive(Default)]
struct Runtime {
    snapshot: OrbSnapshot,
    position: Option<SavedPosition>,
    position_loaded: bool,
    closing: bool,
    #[cfg(desktop)]
    menu: Option<tauri::menu::Menu<tauri::Wry>>,
}

#[derive(Default)]
pub struct OrbState {
    inner: Mutex<Runtime>,
    // Window creation/configuration/actions are serialized, never the SSH engine.
    configure: tokio::sync::Mutex<()>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}
fn allowed(label: &str, main_only: bool) -> Result<(), String> {
    if label == MAIN || (!main_only && label == ORB) {
        Ok(())
    } else {
        Err("This window cannot access the orb command".into())
    }
}
fn snapshot(app: &AppHandle) -> OrbSnapshot {
    app.state::<OrbState>()
        .inner
        .lock()
        .unwrap()
        .snapshot
        .clone()
}
fn emit_snapshot(app: &AppHandle) {
    let _ = app.emit_to(ORB, "still://orb-state", snapshot(app));
}
fn action(app: &AppHandle, event: OrbAction) {
    let _ = app.emit_to(MAIN, "still://orb-action", event);
}
fn sort_rows(rows: &mut [OrbRow], now: u64) {
    rows.sort_by(|a, b| {
        a.priority(now)
            .cmp(&b.priority(now))
            .then(b.changed_at.cmp(&a.changed_at))
            .then(a.session_id.cmp(&b.session_id))
    });
}
fn validate_rows(rows: &mut [OrbRow], now: u64) -> Result<(), String> {
    if rows.len() > MAX_ROWS {
        return Err("Too many orb rows".into());
    }
    let mut ids = HashSet::new();
    for row in rows.iter_mut() {
        if row.session_id.is_empty()
            || row.session_id.len() > 128
            || !row
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !ids.insert(row.session_id.clone())
        {
            return Err("Invalid or duplicate orb session id".into());
        }
        if row.name.trim().is_empty()
            || row.name.chars().count() > 100
            || row.name.chars().any(char::is_control)
        {
            return Err("Invalid orb display name".into());
        }
        row.changed_at = row.changed_at.min(now);
        row.last_output_at = row.last_output_at.filter(|at| {
            row.signal == Signal::Connected && *at <= now && now - *at < OUTPUT_ACTIVE_MS
        });
    }
    sort_rows(rows, now);
    Ok(())
}

#[tauri::command]
pub async fn still_orb_publish(
    app: AppHandle,
    window: WebviewWindow,
    mut rows: Vec<OrbRow>,
) -> Result<(), String> {
    allowed(window.label(), true)?;
    let now = now_ms();
    validate_rows(&mut rows, now)?;
    {
        let state = app.state::<OrbState>();
        let mut inner = state.inner.lock().unwrap();
        if inner.closing {
            return Err("Still is closing".into());
        }
        inner.snapshot.rows = rows;
        inner.snapshot.published_at = now;
        inner.snapshot.revision += 1;
    }
    emit_snapshot(&app);
    Ok(())
}

#[tauri::command]
pub fn still_orb_snapshot(app: AppHandle, window: WebviewWindow) -> Result<OrbSnapshot, String> {
    allowed(window.label(), false)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn still_orb_configure(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, OrbState>,
    preferences: OrbPreferences,
) -> Result<OrbSnapshot, String> {
    allowed(window.label(), true)?;
    preferences.validate()?;
    let _gate = state.configure.lock().await;
    if state.inner.lock().unwrap().closing {
        return Err("Still is closing".into());
    }
    #[cfg(desktop)]
    configure_window(&app, &preferences)?;
    #[cfg(mobile)]
    if preferences.enabled {
        return Err("The floating companion is desktop-only".into());
    }
    {
        let mut inner = state.inner.lock().unwrap();
        inner.snapshot.preferences = preferences;
        inner.snapshot.revision += 1;
    }
    emit_snapshot(&app);
    Ok(snapshot(&app))
}

fn window_side(size: u32) -> f64 {
    (f64::from(size) * 1.4).ceil() + 8.0
}

/// Work-area clamping in PHYSICAL pixels, including negative monitor origins.
fn clamp_position(position: SavedPosition, area: (i32, i32, u32, u32), side: u32) -> SavedPosition {
    let (x, y, width, height) = area;
    let right = i64::from(x) + i64::from(width.saturating_sub(side));
    let bottom = i64::from(y) + i64::from(height.saturating_sub(side));
    SavedPosition {
        x: i64::from(position.x).clamp(i64::from(x), right) as i32,
        y: i64::from(position.y).clamp(i64::from(y), bottom) as i32,
    }
}

#[cfg(desktop)]
fn configure_window(app: &AppHandle, preferences: &OrbPreferences) -> Result<(), String> {
    if !preferences.enabled {
        if let Some(orb) = app.get_webview_window(ORB) {
            save_position(app);
            orb.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let existing = app.get_webview_window(ORB);
    let first = existing.is_none();
    let orb = if let Some(orb) = existing {
        orb
    } else {
        // Called from an ASYNC command, not the UI event callback: avoids the
        // Windows WebView2 synchronous-window-creation deadlock.
        tauri::WebviewWindowBuilder::new(
            app,
            ORB,
            tauri::WebviewUrl::App("index.html?orb=1".into()),
        )
        .title("Still orb")
        .inner_size(window_side(preferences.size), window_side(preferences.size))
        .min_inner_size(window_side(preferences.size), window_side(preferences.size))
        .max_inner_size(window_side(preferences.size), window_side(preferences.size))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        // GTK ignores size changes on a non-resizable hidden window. Equal
        // min/max bounds above still prevent interactive resizing on Linux.
        .resizable(cfg!(target_os = "linux"))
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .build()
        .map_err(|e| e.to_string())?
    };
    let was_visible = orb.is_visible().unwrap_or(false);
    let previous_size = snapshot(app).preferences.size;
    if first || previous_size != preferences.size {
        let old_position = orb.outer_position().ok();
        set_orb_size(&orb, preferences.size)?;
        let requested = if first {
            load_position(app)
        } else {
            let scale = orb.scale_factor().unwrap_or(1.0);
            // Use the last requested logical extent, not an asynchronously cached
            // GTK outer_size (which can still be the pre-resize 200px allocation).
            let delta = ((window_side(previous_size) - window_side(preferences.size)) * scale / 2.0)
                .round() as i32;
            old_position.map(|pos| SavedPosition {
                x: pos.x + delta,
                y: pos.y + delta,
            })
        };
        place(app, &orb, requested, preferences.size)?;
    } else if !was_visible {
        let requested = orb
            .outer_position()
            .ok()
            .map(|p| SavedPosition { x: p.x, y: p.y });
        place(app, &orb, requested, preferences.size)?;
    }
    if app.state::<OrbState>().inner.lock().unwrap().closing {
        let _ = orb.destroy();
        return Err("Still is closing".into());
    }
    // Never re-show an already-visible window on a preference update. New/showing
    // windows cannot take focus; an explicit drag or menu interaction enables it.
    if !was_visible {
        orb.set_focusable(false).map_err(|e| e.to_string())?;
        orb.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(desktop)]
fn set_orb_size(orb: &WebviewWindow, size: u32) -> Result<(), String> {
    let side = window_side(size);
    let unit = Some(tauri::PixelUnit::Logical(tauri::LogicalUnit(side)));
    // GTK's first hidden configure can otherwise fix an undecorated window at
    // its 200px natural minimum. Explicit, equal bounds keep the hitbox compact
    // and also let user-selected size changes replace the previous fixed bounds.
    orb.set_size_constraints(tauri::WindowSizeConstraints {
        min_width: unit,
        min_height: unit,
        max_width: unit,
        max_height: unit,
    })
    .map_err(|e| e.to_string())?;
    orb.set_size(tauri::LogicalSize::new(side, side))
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn place(
    app: &AppHandle,
    orb: &WebviewWindow,
    requested: Option<SavedPosition>,
    size: u32,
) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let requested_monitor = requested.and_then(|p| {
        monitors
            .iter()
            .find(|monitor| {
                let rect = monitor.work_area();
                i64::from(p.x) >= i64::from(rect.position.x)
                    && i64::from(p.x) < i64::from(rect.position.x) + i64::from(rect.size.width)
                    && i64::from(p.y) >= i64::from(rect.position.y)
                    && i64::from(p.y) < i64::from(rect.position.y) + i64::from(rect.size.height)
            })
            .cloned()
    });
    let main_monitor = app
        .get_webview_window(MAIN)
        .and_then(|main| main.current_monitor().ok().flatten());
    // Nudge beyond an edge clamps on the current display rather than jumping
    // back to the main window's display. Reset (no requested position) uses main.
    let current_monitor = requested.and_then(|_| orb.current_monitor().ok().flatten());
    let monitor = requested_monitor
        .or(current_monitor)
        .or(main_monitor)
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| "No display available for the orb".to_string())?;
    let rect = monitor.work_area();
    // Predict the physical extent at the destination monitor, including DPI.
    // Native geometry getters may still contain a pre-configure allocation.
    let side = (window_side(size) * monitor.scale_factor()).round() as u32;
    let inset = (16.0 * monitor.scale_factor()).round() as i32;
    let fallback = SavedPosition {
        x: rect.position.x + rect.size.width as i32 - side as i32 - inset,
        y: rect.position.y + rect.size.height as i32 - side as i32 - inset,
    };
    // A monitor that disappeared must not strand the orb offscreen.
    let position = clamp_position(
        requested.unwrap_or(fallback),
        (
            rect.position.x,
            rect.position.y,
            rect.size.width,
            rect.size.height,
        ),
        side,
    );
    orb.set_position(tauri::PhysicalPosition::new(position.x, position.y))
        .map_err(|e| e.to_string())?;
    app.state::<OrbState>().inner.lock().unwrap().position = Some(position);
    Ok(())
}

fn position_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("orb-position.v1.json"))
}
fn load_position(app: &AppHandle) -> Option<SavedPosition> {
    let state = app.state::<OrbState>();
    {
        let inner = state.inner.lock().unwrap();
        if inner.position_loaded {
            return inner.position;
        }
    }
    let position = position_path(app).and_then(|path| {
        if std::fs::metadata(&path).ok()?.len() > 256 {
            return None;
        }
        serde_json::from_slice::<SavedPosition>(&std::fs::read(path).ok()?).ok()
    });
    let mut inner = state.inner.lock().unwrap();
    inner.position_loaded = true;
    inner.position = position;
    position
}
fn save_position(app: &AppHandle) {
    let position = app.state::<OrbState>().inner.lock().unwrap().position;
    if let (Some(position), Some(path)) = (position, position_path(app)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(&position) {
            let _ = std::fs::write(path, bytes);
        }
    }
}

async fn show_main(app: &AppHandle, session_id: Option<String>) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "Still workspace is unavailable".to_string())?;
    main.show().map_err(|e| e.to_string())?;
    main.unminimize().map_err(|e| e.to_string())?;
    // Restoring is asynchronous on GTK/window managers. A focus request sent
    // before the window is mapped is lost. This is a bounded state wait for an
    // explicit user action, not a delay anywhere in the connection path.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
    loop {
        if !main.is_minimized().map_err(|e| e.to_string())? {
            main.set_focus().map_err(|e| e.to_string())?;
            if main.is_focused().map_err(|e| e.to_string())? {
                break;
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("The workspace could not take focus; open Still from the taskbar".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }
    action(app, OrbAction::Open { session_id });
    Ok(())
}
fn update_preferences(app: &AppHandle, update: impl FnOnce(&mut OrbPreferences)) {
    let preferences = {
        let state = app.state::<OrbState>();
        let mut inner = state.inner.lock().unwrap();
        update(&mut inner.snapshot.preferences);
        inner.snapshot.revision += 1;
        inner.snapshot.preferences.clone()
    };
    emit_snapshot(app);
    action(app, OrbAction::Preferences { preferences });
}

#[tauri::command]
pub async fn still_orb_command(
    app: AppHandle,
    window: WebviewWindow,
    command: OrbCommand,
) -> Result<(), String> {
    allowed(window.label(), false)?;
    if matches!(
        command,
        OrbCommand::Focus | OrbCommand::Drag | OrbCommand::Nudge { .. } | OrbCommand::Menu
    ) && window.label() != ORB
    {
        return Err("Only the companion can move its window or open its menu".into());
    }
    execute(&app, command).await
}

async fn execute(app: &AppHandle, command: OrbCommand) -> Result<(), String> {
    let state = app.state::<OrbState>();
    let _gate = state.configure.lock().await;
    if state.inner.lock().unwrap().closing {
        return Err("Still is closing".into());
    }
    match command {
        OrbCommand::Open { session_id } => {
            let mut snap = snapshot(app);
            let now = now_ms();
            if !snap.fresh(now) {
                return show_main(app, None).await;
            }
            sort_rows(&mut snap.rows, now);
            let id = session_id.or_else(|| snap.rows.first().map(|row| row.session_id.clone()));
            // A menu can outlive a removed row. Restore Still, never activate an unvalidated id.
            let id = id.filter(|id| snap.rows.iter().any(|row| row.session_id == *id));
            show_main(app, id).await
        }
        OrbCommand::Workspace => show_main(app, None).await,
        OrbCommand::Hide => {
            if let Some(orb) = app.get_webview_window(ORB) {
                orb.hide().map_err(|e| e.to_string())?;
            }
            save_position(app);
            update_preferences(app, |preferences| preferences.enabled = false);
            Ok(())
        }
        OrbCommand::Pause { paused } => {
            update_preferences(app, |preferences| preferences.paused = paused);
            Ok(())
        }
        OrbCommand::Reset => {
            #[cfg(desktop)]
            if let Some(orb) = app.get_webview_window(ORB) {
                place(app, &orb, None, snapshot(app).preferences.size)?;
                save_position(app);
            }
            action(app, OrbAction::Reset);
            Ok(())
        }
        OrbCommand::Focus => {
            let orb = app
                .get_webview_window(ORB)
                .ok_or_else(|| "Orb is not open".to_string())?;
            orb.set_focusable(true).map_err(|e| e.to_string())?;
            orb.set_focus().map_err(|e| e.to_string())
        }
        OrbCommand::Drag => {
            let orb = app
                .get_webview_window(ORB)
                .ok_or_else(|| "Orb is not open".to_string())?;
            orb.set_focusable(true).map_err(|e| e.to_string())?;
            orb.set_focus().map_err(|e| e.to_string())?;
            orb.start_dragging().map_err(|e| e.to_string())
        }
        OrbCommand::Nudge { dx, dy } => {
            if !dx.is_finite() || !dy.is_finite() || dx.abs() > 32.0 || dy.abs() > 32.0 {
                return Err("Invalid orb movement".into());
            }
            #[cfg(desktop)]
            {
                let orb = app
                    .get_webview_window(ORB)
                    .ok_or_else(|| "Orb is not open".to_string())?;
                let pos = orb.outer_position().map_err(|e| e.to_string())?;
                let scale = orb.scale_factor().map_err(|e| e.to_string())?;
                place(
                    app,
                    &orb,
                    Some(SavedPosition {
                        x: pos.x + (dx * scale).round() as i32,
                        y: pos.y + (dy * scale).round() as i32,
                    }),
                    snapshot(app).preferences.size,
                )?;
            }
            Ok(())
        }
        OrbCommand::Menu => {
            #[cfg(desktop)]
            {
                show_menu(app)
            }
            #[cfg(mobile)]
            {
                Err("The floating companion is desktop-only".into())
            }
        }
    }
}

#[cfg(desktop)]
fn show_menu(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let orb = app
        .get_webview_window(ORB)
        .ok_or_else(|| "Orb is not open".to_string())?;
    orb.set_focusable(true).map_err(|e| e.to_string())?;
    orb.set_focus().map_err(|e| e.to_string())?;
    let mut snap = snapshot(app);
    let now = now_ms();
    sort_rows(&mut snap.rows, now);
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    let add = |id: String, label: &str, enabled: bool| -> Result<(), String> {
        let item = MenuItem::with_id(app, id, label.replace('&', "&&"), enabled, None::<&str>)
            .map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())
    };
    add("still-orb:workspace".into(), "Open Still", true)?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !snap.fresh(now) || snap.rows.is_empty() {
        add(
            "still-orb:status".into(),
            if snap.fresh(now) {
                "No active connections"
            } else {
                "Status unavailable"
            },
            false,
        )?;
    } else {
        for row in snap.rows.iter().take(12) {
            add(
                format!("still-orb:session:{}", row.session_id),
                &format!("{} — {}", row.name, row.label(now)),
                true,
            )?;
        }
        if snap.rows.len() > 12 {
            add("still-orb:more".into(), "More sessions in Still…", true)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    add(
        "still-orb:pause".into(),
        if snap.preferences.paused {
            "Resume motion"
        } else {
            "Pause motion"
        },
        true,
    )?;
    add("still-orb:reset".into(), "Reset position", true)?;
    add("still-orb:hide".into(), "Hide orb", true)?;
    app.state::<OrbState>().inner.lock().unwrap().menu = Some(menu.clone());
    orb.popup_menu_at(
        &menu,
        tauri::LogicalPosition::new(
            window_side(snap.preferences.size) / 2.0,
            window_side(snap.preferences.size) / 2.0,
        ),
    )
    .map_err(|e| e.to_string())
}

#[cfg(desktop)]
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let command = match id {
        "still-orb:workspace" | "still-orb:more" => OrbCommand::Workspace,
        "still-orb:hide" => OrbCommand::Hide,
        "still-orb:reset" => OrbCommand::Reset,
        "still-orb:pause" => OrbCommand::Pause {
            paused: !snapshot(app).preferences.paused,
        },
        _ => match id.strip_prefix("still-orb:session:") {
            Some(id) => OrbCommand::Open {
                session_id: Some(id.to_owned()),
            },
            None => return,
        },
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = execute(&app, command).await;
    });
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let app = window.app_handle();
    if window.label() == MAIN && matches!(event, tauri::WindowEvent::Destroyed) {
        app.state::<OrbState>().inner.lock().unwrap().closing = true;
        save_position(app);
        // A second window must not keep the application/SSH workers alive after Quit.
        if let Some(orb) = app.get_webview_window(ORB) {
            let _ = orb.destroy();
        }
        return;
    }
    if window.label() != ORB {
        return;
    }
    match event {
        tauri::WindowEvent::Moved(pos) => {
            // In-memory only during a drag. Flush on hide/close, not on every pixel.
            app.state::<OrbState>().inner.lock().unwrap().position =
                Some(SavedPosition { x: pos.x, y: pos.y });
        }
        tauri::WindowEvent::Destroyed => {
            save_position(app);
            if !app.state::<OrbState>().inner.lock().unwrap().closing {
                update_preferences(app, |preferences| preferences.enabled = false);
            }
        }
        #[cfg(desktop)]
        tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<OrbState>();
                let _gate = state.configure.lock().await;
                if state.inner.lock().unwrap().closing {
                    return;
                }
                if let Some(orb) = app.get_webview_window(ORB) {
                    let _ = set_orb_size(&orb, snapshot(&app).preferences.size);
                    let position = orb
                        .outer_position()
                        .ok()
                        .map(|p| SavedPosition { x: p.x, y: p.y });
                    let _ = place(&app, &orb, position, snapshot(&app).preferences.size);
                }
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: &str, signal: Signal) -> OrbRow {
        OrbRow {
            session_id: id.into(),
            name: "Session".into(),
            signal,
            changed_at: 10,
            last_output_at: None,
        }
    }
    #[test]
    fn only_main_can_publish_or_configure() {
        assert!(allowed("main", true).is_ok());
        assert!(allowed("orb", true).is_err());
        assert!(allowed("other", false).is_err());
        assert!(allowed("orb", false).is_ok());
    }
    #[test]
    fn preferences_default_off_and_sizes_are_bounded() {
        assert!(!OrbPreferences::default().enabled);
        assert_eq!(OrbPreferences::default().speed, OrbSpeed::Normal);
        // Older payloads without a speed stay valid; unknown speeds do not.
        assert!(serde_json::from_str::<OrbPreferences>(
            r#"{"enabled":false,"size":64,"paused":false}"#
        )
        .is_ok());
        assert!(serde_json::from_str::<OrbPreferences>(
            r#"{"enabled":false,"size":64,"paused":false,"speed":"warp"}"#
        )
        .is_err());
        for size in [48, 64, 96] {
            assert!(
                OrbPreferences {
                    size,
                    ..Default::default()
                }
                .validate()
                .is_ok()
            );
        }
        assert!(
            OrbPreferences {
                size: 400,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn metadata_rejects_extra_fields_duplicates_controls_and_excess() {
        assert!(serde_json::from_str::<OrbRow>(r#"{"sessionId":"s-1","name":"A","signal":"connected","changedAt":0,"lastOutputAt":null,"secret":"never"}"#).is_err());
        assert!(
            validate_rows(
                &mut [row("s-1", Signal::Connected), row("s-1", Signal::Error)],
                100
            )
            .is_err()
        );
        assert!(validate_rows(&mut [row("bad:id", Signal::Connected)], 100).is_err());
        let mut bad = row("s-1", Signal::Connected);
        bad.name = "bad\nname".into();
        assert!(validate_rows(&mut [bad], 100).is_err());
        assert!(validate_rows(&mut vec![row("a", Signal::Connected); MAX_ROWS + 1], 100).is_err());
    }
    #[test]
    fn activity_expires_and_never_becomes_completion() {
        let mut live = row("s-1", Signal::Connected);
        live.last_output_at = Some(100);
        assert!(live.active(200));
        assert!(!live.active(8100));
        assert!(!live.active(50));
        assert_eq!(live.signal, Signal::Connected);
        validate_rows(std::slice::from_mut(&mut live), 9000).unwrap();
        assert_eq!(live.last_output_at, None);
        assert_eq!(live.priority(4000), 4);
    }
    #[test]
    fn urgency_and_stale_snapshots_are_deterministic() {
        let mut rows = vec![
            row("z", Signal::Connected),
            row("e", Signal::Error),
            row("a", Signal::Auth),
        ];
        sort_rows(&mut rows, 100);
        assert_eq!(
            rows.iter()
                .map(|r| r.session_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "e", "z"]
        );
        let snap = OrbSnapshot {
            published_at: 100,
            ..Default::default()
        };
        assert!(snap.fresh(1000));
        assert!(!snap.fresh(15_101));
        assert!(!OrbSnapshot::default().fresh(1));
    }
    #[test]
    fn placement_handles_negative_origins_small_displays_and_taskbars() {
        let area = (-1920, 0, 1920, 1040);
        assert_eq!(
            clamp_position(SavedPosition { x: 400, y: 2000 }, area, 98),
            SavedPosition { x: -98, y: 942 }
        );
        assert_eq!(
            clamp_position(SavedPosition { x: -5000, y: -100 }, area, 98),
            SavedPosition { x: -1920, y: 0 }
        );
        assert_eq!(
            clamp_position(SavedPosition { x: 99, y: 99 }, (0, 0, 50, 50), 98),
            SavedPosition { x: 0, y: 0 }
        );
        assert_eq!(window_side(64), 98.0);
    }
}
