// Desktop shell for the FSM editor (apps/editor). The editor does all the
// drawing and exporting; this side only reads and writes files the user picked.

mod files;

use std::fs;

/// A .fsm.json path given on the command line (e.g. opening a file with the app).
#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-'))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read(&path).map(|b| files::decode_text(&b)).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![launch_file, read_text_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running FSM Designer");
}
