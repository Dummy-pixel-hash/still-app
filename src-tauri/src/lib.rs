//! Still production native backend entry.
//!
//! Real session engine: SSH (russh) + tmux attach-or-create per session,
//! one worker task per session id, Tauri events back to the renderer.

mod agent;
mod agent_store;
mod commands;
mod orb;
pub mod core;
pub mod diag;
pub mod hostkeys;
pub mod ssh_worker;

use commands::AppState;

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
/// shadow. DWM clips the opaque main window to its rounded shape; the
/// Workspace and terminal overlay keep the matching 8px CSS radius.
/// The main WebView must have an opaque native background for WebView2 to
/// composite CSS backdrop blur correctly. The separately built orb window
/// stays transparent.
/// See https://github.com/MicrosoftEdge/WebView2Feedback/issues/4945.
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .manage(orb::OrbState::default())
        .on_window_event(orb::on_window_event)
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = _app.get_webview_window("main") {
                    tune_windows_frame(&w);
                }
            }
            Ok(())
        });
    #[cfg(desktop)]
    let builder = builder.on_menu_event(orb::on_menu_event);
    builder
        .invoke_handler(tauri::generate_handler![
            still_ping,
            agent::still_agent_start,
            agent::still_agent_attach,
            agent::still_agent_check,
            agent::still_agent_catalog,
            agent::still_agent_resolve_folder,
            agent::still_agent_send,
            agent::still_agent_revert,
            agent::still_agent_set_config,
            agent::still_agent_respond,
            agent::still_agent_cancel,
            agent::still_agent_close,
            agent::still_agent_input,
            agent::still_agent_snapshot,
            agent::still_agent_flush,
            agent_store::still_agent_library,
            agent_store::still_agent_save_metadata,
            agent_store::still_agent_save_workspace,
            agent_store::still_agent_delete_saved,
            agent_store::still_agent_migrate,
            orb::still_orb_configure,
            orb::still_orb_publish,
            orb::still_orb_snapshot,
            orb::still_orb_command,
            commands::still_connect,
            commands::still_write,
            commands::still_resize,
            commands::still_refresh,
            commands::still_upload_image,
            commands::still_open_url,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Still");
}
