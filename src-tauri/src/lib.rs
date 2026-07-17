#[tauri::command]
fn resize_window(window: tauri::Window, width: Option<f64>, height: f64) {
  let w = width.unwrap_or(320.0);
  let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
    width: w,
    height: height,
  }));
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, on_top: bool) {
  let _ = window.set_always_on_top(on_top);
}

#[tauri::command]
fn close_window(window: tauri::Window) {
  let _ = window.close();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![resize_window, close_window, set_always_on_top])
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
