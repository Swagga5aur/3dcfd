#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ai::has_api_key,
            ai::set_api_key,
            ai::delete_api_key,
            ai::ai_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI 3D Studio");
}
