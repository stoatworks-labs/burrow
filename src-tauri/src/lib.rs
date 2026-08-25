//! Stoatworks Burrow — the Tauri layer.
//!
//! Everything worth testing lives in `burrow-core` and `burrow-plan`, which
//! know nothing about Tauri. This crate is the shell around them: the network,
//! the command surface, the job runner, the demo server, and the elevation
//! prompt.
//!
//! One design note that is easy to lose: **the webview never makes a network
//! request.** The catalogue and every download are fetched from Rust, which is
//! why `tauri.conf.json`'s `connect-src` lists only `ipc:` and the feedback
//! intake origin. The UI cannot reach the internet even if something in it
//! tried to.

#![deny(unsafe_code)]

mod demos;
mod elevate;
mod jobs;
mod net;
mod settings;
mod state;

use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::get_environment,
            state::get_settings,
            state::save_settings,
            state::get_catalog,
            state::refresh_catalog,
            state::rescan,
            state::list_plugins,
            state::demo_url,
            state::video_url,
            state::open_demo,
            state::open_external,
            state::reveal_path,
            state::save_compose,
            state::film_mode,
            state::film_delay,
            state::film_beat,
            jobs::plan_batch,
            jobs::run_batch,
            jobs::cancel_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stoatworks Burrow");
}
