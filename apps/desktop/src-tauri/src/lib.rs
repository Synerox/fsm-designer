// Desktop shell for the FSM editor (apps/editor). The editor does all the
// drawing and exporting; this side only reads and writes files the user picked.

mod files;

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request};

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
    fs::read(&path)
        .map(|b| files::decode_text(&b))
        .map_err(|e| format!("{path}: {e}"))
}

/// The editor sends the bytes as the raw body and the path, URI-encoded, in a
/// header (see saveFile in apps/editor/src/platform.ts). Where the webview
/// falls back to postMessage IPC the body arrives as a JSON array instead.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("file-path")
        .and_then(|v| v.to_str().ok())
        .map(files::percent_decode)
        .ok_or("write_file: no file path")?;
    let json;
    let contents: &[u8] = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(v) => {
            json =
                serde_json::from_value::<Vec<u8>>(v.clone()).map_err(|e| format!("{path}: {e}"))?;
            &json
        }
    };
    files::write_replacing(Path::new(&path), contents).map_err(|e| format!("{path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchFile(Mutex::new(files::launch_arg(
            std::env::args_os().skip(1),
        ))))
        .invoke_handler(tauri::generate_handler![
            launch_file,
            read_text_file,
            write_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running FSM Designer");
}
