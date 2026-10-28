// Desktop shell for the FSM editor (apps/editor). The editor does all the
// drawing and exporting; this side only reads and writes files the user picked.

mod files;

use std::fs;
use std::sync::Mutex;

/// A .fsm.json path given on the command line (e.g. opening a file with the app).
struct LaunchFile(Mutex<Option<String>>);

/// The launch path, handed out once: a reload of the page must restore the
/// autosave, which holds the unsaved edits, not reopen the file from disk.
#[tauri::command]
fn launch_file(launch: tauri::State<'_, LaunchFile>) -> Option<String> {
    launch.0.lock().ok()?.take()
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
        .manage(LaunchFile(Mutex::new(files::launch_arg(std::env::args_os().skip(1)))))
        .invoke_handler(tauri::generate_handler![launch_file, read_text_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running FSM Designer");
}
