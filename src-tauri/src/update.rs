//! Burrow updating itself.
//!
//! Everything else in this app installs somebody else's software. This is the
//! one path that replaces the running program, so it is deliberately the most
//! conservative thing here:
//!
//! **The manifest is signed, and the signature is what is trusted.** Not
//! HTTPS, not the hostname. `latest.json` and every artefact it names carry a
//! minisign signature made at release time by a key that never leaves the
//! author's machine and GitHub Actions' secret store; the public half is
//! compiled into this binary from `tauri.conf.json`. An update that does not
//! verify is refused, whoever served it. That matters more here than anywhere
//! else in Burrow: the plugins it installs are checked against a catalogue and
//! land in a plugin folder, whereas this replaces the application that has the
//! user's confidence.
//!
//! **Nothing happens unattended.** The check runs when the user presses the
//! button, or at startup only if they turned that on. There is no silent
//! download and no automatic install, which is also why `check` and `install`
//! are two commands rather than one.
//!
//! **The webview still makes no network request.** The updater is driven from
//! Rust — `AppHandle::updater()` — rather than through the plugin's JavaScript
//! API, so `connect-src` is unchanged and the capability file grants the
//! window nothing new. See the note at the top of `lib.rs`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// What a check found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// The version running right now, without a leading `v`.
    pub current: String,
    /// The newer version, when there is one. `None` means up to date, which is
    /// a different answer from an error and is reported as one.
    pub available: Option<String>,
    /// The release notes, as the release body has them. Markdown, shown as
    /// plain text — a release body is written for people, not parsed here.
    pub notes: Option<String>,
    /// When that release was published, ISO-8601, straight from the manifest.
    pub date: Option<String>,
    /// Why an update could not be installed even if one exists — a copy
    /// running from a disk image, or from a folder this user cannot write.
    ///
    /// A complete sentence, capitalised and stopped, because it is shown both
    /// in the Settings pane and in the banner and neither can know what it is
    /// being joined to.
    ///
    /// Reported by the *check* rather than discovered by the install, because
    /// "you cannot install this here" is worth knowing before a download
    /// starts and a great deal worse halfway through replacing the app.
    pub blocked: Option<String>,
}

/// How far a download has got. Mirrors the shape of `Progress` in `jobs.rs`
/// closely enough to feel like the same app, and is deliberately a separate
/// event so a plugin install and a self-update cannot drive the same bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub version: String,
    pub bytes_done: u64,
    /// The manifest does not have to carry a length, and GitHub does not
    /// always send one, so this really can be absent.
    pub bytes_total: Option<u64>,
    pub done: bool,
}

/// The version this binary was built as.
#[tauri::command]
pub fn client_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Ask the update endpoint what the current release is.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = client_version();
    let blocked = install_obstacle(&app);

    let updater = app.updater().map_err(describe)?;
    match updater.check().await.map_err(describe)? {
        Some(update) => Ok(UpdateInfo {
            current,
            available: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
            blocked,
        }),
        None => Ok(UpdateInfo { current, available: None, notes: None, date: None, blocked }),
    }
}

/// Download the current release, replace this app with it, and restart.
///
/// Checks again rather than acting on what the earlier check found. The extra
/// request costs a few kilobytes and buys the guarantee that what gets
/// installed is what the endpoint says *now* — there is no window in which a
/// stale handle from ten minutes ago is what replaces the application.
///
/// This does not return on success: `restart` replaces the process.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if let Some(why) = install_obstacle(&app) {
        return Err(why);
    }

    let updater = app.updater().map_err(describe)?;
    let Some(update) = updater.check().await.map_err(describe)? else {
        return Err("there is no update to install — Burrow is already current".into());
    };

    let version = update.version.clone();
    let mut done: u64 = 0;

    let on_chunk = {
        let app = app.clone();
        let version = version.clone();
        move |chunk: usize, total: Option<u64>| {
            done += chunk as u64;
            let _ = app.emit(
                "update-progress",
                UpdateProgress {
                    version: version.clone(),
                    bytes_done: done,
                    bytes_total: total,
                    done: false,
                },
            );
        }
    };
    let on_finish = {
        let app = app.clone();
        let version = version.clone();
        move || {
            let _ = app.emit(
                "update-progress",
                UpdateProgress { version: version.clone(), bytes_done: 0, bytes_total: None, done: true },
            );
        }
    };

    update.download_and_install(on_chunk, on_finish).await.map_err(describe)?;

    // Everything above happened in a temporary directory; this is the moment
    // the new copy is in place and the old process is stale. Restarting is not
    // a nicety — on macOS the bundle under this running process has already
    // been replaced.
    app.restart();
}

/// A sentence explaining why this copy cannot replace itself, or `None`.
///
/// Two cases, both real:
///
/// * **Running from the disk image.** Double-clicking Burrow inside the `.dmg`
///   rather than dragging it out is a normal thing to do, and the mount is
///   read-only. Without this check the update downloads perfectly and then
///   fails at the replace, having wasted the download and said nothing useful.
/// * **Installed somewhere this user cannot write.** A copy in `/Applications`
///   on a machine where the user is not an administrator, most obviously.
///
/// Neither is a failure of the update — they are facts about where this copy
/// lives — so they are reported by the check, before anything is downloaded.
fn install_obstacle(app: &AppHandle) -> Option<String> {
    let _ = app;
    let exe = std::env::current_exe().ok()?;
    let root = install_root(&exe)?;

    // The image first: it is the more specific description of the same
    // symptom, and "read-only mount" is a more useful thing to be told than
    // "you cannot write there".
    if is_read_only_image(&root) {
        return Some(
            "Burrow is running from its disk image, which is read-only — drag it to \
             your Applications folder and update from there."
                .into(),
        );
    }
    if !burrow_core::dest::probe_writable(&root) {
        return Some(format!(
            "Burrow is in {}, which you do not have permission to write to — move it \
             somewhere you own, or download the new version yourself.",
            root.display()
        ));
    }
    None
}

/// The directory holding the thing an update replaces.
///
/// On macOS an update replaces the whole `.app`, so what has to be writable is
/// the directory the bundle sits in — `Contents/MacOS/burrow` is three levels
/// down from it. Anywhere else it is the directory holding the executable.
///
/// Kept separate from the check above so it can be tested without an app
/// bundle or a mounted image to hand.
fn install_root(exe: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        // …/Stoatworks Burrow.app/Contents/MacOS/burrow
        let bundle = exe.parent()?.parent()?.parent()?;
        if bundle.extension().is_some_and(|e| e == "app") {
            return bundle.parent().map(Path::to_path_buf);
        }
    }
    exe.parent().map(Path::to_path_buf)
}

/// Whether a path is inside a mounted disk image.
///
/// `/Volumes` is where `hdiutil` mounts one, and it is also where an external
/// drive appears — which is why this is not the only test. `probe_writable`
/// runs first and catches the read-only mount on its own merits; this exists
/// to say *why* in words the user recognises, and only for the case that
/// actually confuses people.
fn is_read_only_image(path: &Path) -> bool {
    cfg!(target_os = "macos") && path.starts_with("/Volumes") && !burrow_core::dest::probe_writable(path)
}

/// The updater's errors in a sentence, rather than a debug rendering.
///
/// Four are worth translating, and the differences between them matter:
///
/// * A **network failure** is worth trying again.
/// * A **signature that does not verify** is not, and must not be softened:
///   it is the one case where "try again later" is the wrong advice.
/// * A **missing manifest** is almost always this project's fault rather than
///   the user's network, and the sentence should not send them to look at
///   their connection.
/// * A **missing platform** in an otherwise good manifest means the release
///   went out incomplete. The release workflow refuses to publish one, so if
///   this is ever seen, that guard has been defeated — hence the ask to report
///   it rather than a shrug.
fn describe(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match e {
        Error::Reqwest(inner) => format!("could not reach the update list — {inner}"),
        Error::Network(inner) => format!("the download did not finish — {inner}"),
        Error::ReleaseNotFound => "the update list could not be read. It may not have been \
             published yet — try the release page."
            .into(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "that release has no update for this kind of machine. Download Burrow from its \
             release page instead, and please report this."
                .into()
        }
        Error::Minisign(_) | Error::SignatureUtf8(_) => {
            "that update did not match its signature and was refused. \
             Download Burrow from its release page instead, and please report this."
                .into()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn the_thing_an_update_replaces_is_the_bundle_not_the_binary() {
        // The failure this pins: probing the *executable's* directory asks
        // whether Contents/MacOS is writable, which it is inside a bundle the
        // user cannot replace. What has to be writable is where the .app sits.
        let exe = Path::new("/Applications/Stoatworks Burrow.app/Contents/MacOS/burrow");
        assert_eq!(install_root(exe), Some(PathBuf::from("/Applications")));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn an_unbundled_binary_falls_back_to_its_own_directory() {
        // `cargo run` and `tauri dev` are not in a bundle, and the check has
        // to yield something rather than refusing to answer.
        let exe = Path::new("/Users/someone/burrow/target/debug/burrow");
        assert_eq!(install_root(exe), Some(PathBuf::from("/Users/someone/burrow/target/debug")));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn the_executable_lives_beside_what_an_update_replaces() {
        let exe = Path::new("C:\\Program Files\\Stoatworks Burrow\\burrow.exe");
        assert_eq!(install_root(exe), Some(PathBuf::from("C:\\Program Files\\Stoatworks Burrow")));
    }

    #[test]
    fn a_writable_place_is_not_reported_as_a_disk_image() {
        let t = tempfile::TempDir::new().unwrap();
        assert!(!is_read_only_image(t.path()));
    }
}
