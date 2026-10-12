//! Still production native backend entry.
//!
//! Real session engine: SSH (russh) + tmux attach-or-create per session,
//! one worker task per session id, Tauri events back to the renderer.

mod commands;
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

/// Strip Win11 DWM chrome that config alone cannot remove.
///
/// `decorations: false` drops the titlebar; `shadow: false` drops the drop
/// shadow. But on Windows 11 DWM still applies `DWMWCP_ROUND` rounded
/// corners to frameless windows, which renders as a faint 1px halo around
/// the dark UI. Force `DWMWCP_DONOTROUND` so the window is square and
/// fully edge-to-edge (zero chrome).
#[cfg(target_os = "windows")]
fn strip_windows_chrome(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let pref: u32 = DWMWCP_DONOTROUND as u32;
    // Best-effort: if the attribute call fails, we keep the DWM default
    // instead of crashing the window create.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const u32 as *const std::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // DIAG-ONLY: first native record — proves the diagnostic build runs.
    crate::diag::app_start();
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = _app.get_webview_window("main") {
                    strip_windows_chrome(&w);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Still");
}
