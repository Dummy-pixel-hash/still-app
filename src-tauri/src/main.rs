//! Still production bootstrap — desktop binary entry.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Real setup lives in lib.rs::run for desktop+mobile sharing,
    // so the same React frontend can later target Tauri Mobile.
    still_app::run()
}
