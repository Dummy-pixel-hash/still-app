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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // DIAG-ONLY: first native record — proves the diagnostic build runs.
    crate::diag::app_start();
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            still_ping,
            commands::still_connect,
            commands::still_write,
            commands::still_resize,
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
