//! Still production native backend entry.
//!
//! Real session engine: SSH (russh) + tmux attach-or-create per session,
//! one worker task per session id, Tauri events back to the renderer.

mod commands;
pub mod core;
pub mod diag;
pub mod hostkeys;
pub mod orb;
pub mod agent_state;
pub mod orb_model;
pub mod ssh_worker;

use commands::AppState;
use tauri::Manager;

/// Typed response for the `still_ping` IPC probe.
#[derive(Debug, serde::Serialize)]
pub struct PingResponse {
    pub status: String,
    pub app: String,
    pub version: String,
}

#[tauri::command]
fn still_ping(state: tauri::State<'_, AppState>) -> PingResponse {
    // DIAG-ONLY: IPC health-check boundaries (answers "can the packaged
    // WebView invoke ANY Tauri command?"). No behavior change, no gating.
    let t0 = std::time::Instant::now();
    crate::diag::record("rust", "STILL_PING_ENTERED", "", "", true, "", "", None);
    let ping_no = state.record_ping();
    let res = PingResponse {
        status: format!("ok (native runtime, ping #{ping_no})"),
        app: "still-app".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    crate::diag::ok_elapsed("rust", "STILL_PING_RETURNED", "", "", t0.elapsed().as_millis());
    res
}

/// Ask Win11 DWM for round window corners.
///
/// `decorations: false` drops the titlebar; `shadow: false` drops the drop
/// shadow. The window itself is transparent, so the visible shape comes
/// from the web content: the Workspace root and the full-window terminal
/// overlay both clip to the same 8px radius (see `rounded-lg`), which
/// matches `DWMWCP_ROUND` exactly — a larger CSS radius would be sliced
/// by the window shape and look broken at the corner tips.
///
/// The second call kills the persistent 1px native frame: frameless
/// windows keep `WS_THICKFRAME` for resizing, and DWM draws its edge as
/// a visible border. Extending the frame over the whole client area
/// (margins -1) makes DWM compose the glass surface instead, so the
/// border disappears. Purely visual — hit-testing and resizing are
/// unaffected.
#[cfg(target_os = "windows")]
fn tune_windows_frame(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;

    let Ok(hwnd) = window.hwnd() else { return };
    // Best-effort: if either attribute call fails, we keep the DWM
    // defaults instead of crashing the window create.
    let pref: u32 = DWMWCP_ROUND as u32;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    let margins = MARGINS {
        cxLeftWidth: -1,
        cxRightWidth: -1,
        cyTopHeight: -1,
        cyBottomHeight: -1,
    };
    let _ = unsafe { DwmExtendFrameIntoClientArea(hwnd.0 as _, &margins) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // DIAG-ONLY: first native record — proves the diagnostic build runs.
    crate::diag::app_start();
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .manage(crate::orb::OrbState::new())
        .manage(crate::orb_model::SmartState::new())
        .setup(|app| {
            // Taskbar minimize (Win+Down / taskbar icon) never fires the
            // renderer, so watch the main window's visibility here: when it
            // becomes non-visible while not closing, route to the orb as well.
            let app = app.handle();
            for label in ["main", crate::orb::ORB_LABEL] {
                let app_window = app.clone();
                if let Some(w) = app.get_webview_window(label) {
                    w.on_window_event(move |event| {
                        match event {
                            tauri::WindowEvent::CloseRequested { .. } => {
                                // Closing EITHER window quits Still. The orb always
                                // exists (invisible at startup), so a plain window
                                // close could otherwise strand the hidden main.
                                app_window.exit(0);
                            }
                            _ => {}
                        }
                    });
                }
            }
            // Zero-config agent sniffing for the orb: every ~2.5s (staggered),
            // per LIVE session only, run `tmux capture-pane` over a throwaway
            // exec channel and classify into the shared vocabulary. Runs only
            // while someone could be looking (orb visible or main hidden) and
            // stops on its own when nothing is live — ~2 tiny execs per tick
            // per session, each bounded + capped.
            let app_sniff = app.clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Manager as _;
                let mut idx: usize = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                    let orb_visible = app_sniff
                        .get_webview_window(crate::orb::ORB_LABEL)
                        .map(|o| o.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    let main_visible = app_sniff
                        .get_webview_window("main")
                        .map(|m| m.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if !orb_visible && main_visible {
                        continue; // nobody looking: stay quiet
                    }
                    crate::orb::agent_tick(&app_sniff, &mut idx).await;
                }
            });
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    tune_windows_frame(&w);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            still_ping,
            commands::still_connect,
            commands::still_write,
            commands::still_resize,
            commands::still_upload_image,
            commands::still_status,
            commands::still_disconnect,
            commands::still_forget_secret,
            commands::still_has_secret,
            commands::still_save_key,
            commands::still_has_key,
            commands::still_forget_key,
            commands::still_probe_host,
            commands::still_trust_host,
            commands::still_forget_host,
            commands::still_diag_record,
            commands::still_minimize_to_orb,
            commands::still_restore_from_orb,
            commands::still_orb_hide,
            commands::still_orb_snapshot,
            commands::still_orb_push,
            commands::still_orb_get_position,
            commands::still_hooks_install,
            commands::still_orb_smart_status,
            commands::still_orb_smart_set,
            commands::still_orb_smart_probe,
            commands::still_app_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Still");
}
