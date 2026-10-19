//! Stoatworks Burrow — the Tauri layer.
//!
//! Everything worth testing lives in `burrow-core` and `burrow-plan`, which
//! know nothing about Tauri. This crate is the shell around them: the network,
//! the command surface, the job runner, the demo server, and the elevation
//! prompt.
//!
//! One design note that is easy to lose: **the webview never makes a network
//! request.** The catalogue, every download and the app's own update are
//! fetched from Rust, which is why `tauri.conf.json`'s `connect-src` lists only
//! `ipc:` and the feedback intake origin. The UI cannot reach the internet even
//! if something in it tried to — the updater included, which is driven through
//! `update.rs` rather than through its plugin's JavaScript API.

#![deny(unsafe_code)]

mod claims;
mod demos;
mod elevate;
mod jobs;
mod net;
mod settings;
mod state;
mod update;

use state::AppState;
use tauri::Manager;

/// Run a command's body on the blocking pool, off the thread the window lives on.
///
/// ⚠️ A `#[tauri::command]` that is not `async` runs **inline in the IPC
/// handler**, and on macOS that is the webview's message delegate on the main
/// thread: for as long as the body takes, nothing repaints, no click lands and
/// the window is, to the person holding the mouse, hung. That is fine for a
/// command that reads a mutex and returns; it is not fine for one that probes
/// every plugin folder, reads every bundle's plist, or hashes an installed
/// application. Every command that touches the disk goes through here.
///
/// `spawn_blocking` rather than `async_runtime::spawn`: the body is plain
/// synchronous I/O, and parking it on one of the runtime's worker threads would
/// stall whichever async work — a catalogue refresh, an update check — shared
/// that thread.
pub(crate) async fn off_main<T: Send + 'static>(
    body: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(body)
        .await
        .map_err(|e| format!("the work stopped unexpectedly: {e}"))?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Driven from Rust, never from the webview: see the module note in
        // update.rs. The capability file grants the window nothing for it.
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            update::client_version,
            update::check_update,
            update::install_update,
            claims::scan_claimable,
            claims::list_claimed,
            claims::claim,
            claims::release,
            jobs::plan_batch,
            jobs::run_batch,
            jobs::cancel_batch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stoatworks Burrow");
}
