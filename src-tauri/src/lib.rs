#[tauri::command]
fn resize_window(window: tauri::Window, height: f64) {
  let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
    width: 320.0,
    height: height,
  }));
}

#[tauri::command]
fn close_window(window: tauri::Window) {
  let _ = window.close();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![resize_window, close_window])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
