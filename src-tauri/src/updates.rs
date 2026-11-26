//! Android's OS-managed APK download/install path. Windows uses the Tauri updater.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AndroidUpdateAction {
    Check,
    Status,
    Install,
    SetCellular,
}

#[cfg(target_os = "android")]
struct AndroidUpdates(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("still-updates")
        .setup(|app, api| {
            app.manage(AndroidUpdates(
                api.register_android_plugin("dev.still.app", "UpdaterPlugin")?,
            ));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn still_android_update(
    window: tauri::WebviewWindow,
    action: AndroidUpdateAction,
    force: Option<bool>,
    allow_cellular: Option<bool>,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Only the main window can manage updates.".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let method = match action {
            AndroidUpdateAction::Check => "checkUpdate",
            AndroidUpdateAction::Status => "updateStatus",
            AndroidUpdateAction::Install => "installUpdate",
            AndroidUpdateAction::SetCellular => "setCellular",
        };
        window
            .state::<AndroidUpdates>()
            .0
            .run_mobile_plugin_async(
                method,
                serde_json::json!({
                    "force": force.unwrap_or(false),
                    "allowCellular": allow_cellular.unwrap_or(false),
                }),
            )
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (action, force, allow_cellular);
        Err("APK updates are only supported on Android.".into())
    }
}
