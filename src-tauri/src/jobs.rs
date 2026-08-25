//! Installing, updating and removing — as a batch, with one prompt at most.
//!
//! # The shape of a batch
//!
//! A batch is planned first and run second. [`plan_batch`] resolves every unit
//! and touches nothing, so the UI can show a truthful confirmation — including
//! whether this will ask for a password and exactly which directories it will
//! write into. [`run_batch`] then executes the plan the user actually saw.
//!
//! # The ordering that matters
//!
//! Within a run:
//!
//! 1. Everything is downloaded, verified, extracted, validated, de-quarantined
//!    and hashed. Nothing has touched a plugin directory yet, and the whole
//!    phase is cancellable.
//! 2. Every **unprivileged** commit happens.
//! 3. Only then, if anything needs it, one authorisation prompt.
//!
//! Step 2 before step 3 is deliberate. Someone who queues FFGL and OpenFX
//! together and then thinks better of typing their password still gets their
//! Resolume plugins, and the OpenFX half reports *cancelled* rather than
//! *failed* — because nothing went wrong, they said no.

use burrow_core::model::{Format, Platform};
use burrow_core::{archive, commit, dmg, ledger, quarantine};
use burrow_plan::Op;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::elevate::{self, Elevation};
use crate::net;
use crate::state::{self, AppState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Install,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpRequest {
    pub slug: String,
    pub format: Format,
    pub destination_id: String,
    pub action: Action,
    /// A specific release tag to install, rather than the current one.
    ///
    /// Absent means "whatever is current", which is what every ordinary
    /// install and update wants. Present means the user deliberately chose an
    /// older version from the row's version menu.
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedUnit {
    pub slug: String,
    pub name: String,
    /// The release this unit installs. The ledger records it, so a rolled-back
    /// plugin does not later claim to be the current version.
    #[serde(default)]
    pub version: Option<String>,
    pub format: Format,
    pub destination_id: String,
    pub destination: PathBuf,
    pub action: Action,
    pub url: Option<String>,
    pub size: Option<u64>,
    pub entries: Vec<String>,
    pub needs_elevation: bool,
    /// The single name the payload must end up under, for the two formats
    /// whose archive *is* the payload: a Companion module (named from the
    /// repository, because `npm pack` calls every tarball's root `package/`)
    /// and a Windows application (named from the catalogue, because a program
    /// folder has no name of its own). None for everything else, which is
    /// named by what the archive holds.
    #[serde(default)]
    pub install_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub batch: String,
    pub units: Vec<PlannedUnit>,
    pub download_bytes: u64,
    pub needs_elevation: bool,
    /// Shown verbatim in the confirmation, so the prompt and the work cannot
    /// describe different things.
    pub elevated_destinations: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitOutcome {
    pub slug: String,
    pub format: Format,
    pub destination_id: String,
    pub ok: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOutcome {
    pub batch: String,
    pub units: Vec<UnitOutcome>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    batch: String,
    index: usize,
    total: usize,
    slug: String,
    format: Format,
    phase: &'static str,
    bytes_done: u64,
    bytes_total: Option<u64>,
    message: Option<String>,
}

/// A unit that has been fetched, checked and staged, and is ready to be put
/// into place. Everything expensive and everything fallible has already
/// happened by the time one of these exists.
struct Ready {
    unit: PlannedUnit,
    staged: PathBuf,
    entries: Vec<String>,
    sha: Option<String>,
}

/// A path as a person should read it: with the home directory written as `~`.
///
/// The same abbreviation `dest::discover` puts on every destination, applied to
/// the paths that reach the user through the batch notes. A note is as likely to
/// end up in a screenshot as the Settings pane is, and a path carries the account
/// name.
///
/// Falls back to the exact path when the home directory cannot be resolved,
/// which is the right way round: a slightly long note beats no note.
fn shown(path: &std::path::Path) -> String {
    match std::env::var("HOME").ok().filter(|h| !h.is_empty()) {
        Some(home) => burrow_core::dest::abbreviate(path, std::path::Path::new(&home)),
        None => path.display().to_string(),
    }
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit("batch-progress", p);
}

#[tauri::command]
pub fn plan_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    requests: Vec<OpRequest>,
) -> Result<BatchPlan, String> {
    let env = state::get_environment(app.clone(), state.clone())?;
    let catalog = state.catalog.lock().map_err(|_| "state is poisoned")?;
    let cat = catalog.as_ref().ok_or("the plugin list has not loaded yet")?;
    let led = state.ledger.lock().map_err(|_| "state is poisoned")?;
    let platform = Platform::current().ok_or("no plugin hosts are supported on this platform")?;

    let mut units = Vec::new();
    let mut warnings = Vec::new();
    let mut download_bytes = 0u64;
    let mut elevated_destinations: Vec<PathBuf> = Vec::new();

    for req in &requests {
        let entry = cat
            .entries
            .iter()
            .find(|e| e.slug == req.slug)
            .ok_or_else(|| format!("{} is not in the plugin list", req.slug))?;
        let dest = state::destination_by_id(&env, &req.destination_id)
            .ok_or_else(|| format!("no destination called {}", req.destination_id))?;

        let (url, size, entries) = match req.action {
            Action::Uninstall => {
                // Prefer the exact names recorded at install time; fall back to
                // what the catalogue declares for a hand-installed copy.
                let recorded = led
                    .key(&req.slug, req.format, &req.destination_id)
                    .map(|e| e.entries.clone());
                let declared = entry
                    .asset(req.format, platform)
                    .map(|a| a.entries.clone())
                    .unwrap_or_default();
                (None, None, recorded.unwrap_or(declared))
            }
            _ => {
                // A named version comes from the row's version menu; anything
                // else is the current release.
                let asset = match &req.version {
                    Some(tag) => entry
                        .versions
                        .iter()
                        .find(|v| &v.tag == tag)
                        .and_then(|v| v.asset(req.format, platform))
                        .ok_or_else(|| {
                            format!(
                                "{} {tag} has no {} build for this platform",
                                entry.name,
                                req.format.label()
                            )
                        })?,
                    None => entry.asset(req.format, platform).ok_or_else(|| {
                        format!(
                            "{} has no {} build for this platform",
                            entry.name,
                            req.format.label()
                        )
                    })?,
                };
                if let Some(s) = asset.size {
                    download_bytes += s;
                }
                if asset.pinned {
                    warnings.push(format!(
                        "{} publishes only version-specific downloads, so Burrow installs \
                         {} specifically rather than whatever is newest.",
                        entry.name,
                        entry.version.clone().unwrap_or_else(|| "that version".into())
                    ));
                }
                (Some(asset.url.clone()), asset.size, asset.entries.clone())
            }
        };

        if entries.is_empty() {
            warnings.push(format!(
                "Burrow does not know what {}'s {} download contains, so it will \
                 find out while installing.",
                entry.name,
                req.format.label()
            ));
        }

        if dest.needs_elevation && !elevated_destinations.contains(&dest.path) {
            elevated_destinations.push(dest.path.clone());
        }

        let install_name = if req.format.payload_is_whole_archive(platform) {
            Some(match req.format {
                // The repository name, which is what a Companion developer
                // modules folder holds a directory of.
                Format::Companion => entry.repo.clone(),
                _ => entry.name.clone(),
            })
        } else {
            None
        };

        units.push(PlannedUnit {
            slug: req.slug.clone(),
            name: entry.name.clone(),
            version: req.version.clone().or_else(|| entry.version.clone()),
            format: req.format,
            destination_id: req.destination_id.clone(),
            destination: dest.path.clone(),
            action: req.action,
            url,
            size,
            entries,
            needs_elevation: dest.needs_elevation,
            install_name,
        });
    }

    // Unprivileged first, so a cancelled prompt still leaves that work done.
    units.sort_by_key(|u| u.needs_elevation);

    Ok(BatchPlan {
        batch: commit::new_batch_id(),
        needs_elevation: !elevated_destinations.is_empty(),
        elevated_destinations,
        download_bytes,
        warnings,
        units,
    })
}

#[tauri::command]
pub fn cancel_batch(state: State<'_, AppState>, batch: String) -> Result<(), String> {
    *state.cancel.lock().map_err(|_| "state is poisoned")? = Some(batch);
    Ok(())
}

fn cancelled(state: &AppState, batch: &str) -> bool {
    state
        .cancel
        .lock()
        .map(|c| c.as_deref() == Some(batch))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn run_batch(app: AppHandle, plan: BatchPlan) -> Result<BatchOutcome, String> {
    let (cache_dir, helper) = {
        let state = app.state::<AppState>();
        (state.cache_dir.clone(), helper_path(&app))
    };
    let platform = Platform::current().ok_or("no plugin hosts are supported on this platform")?;
    let staging_root = cache_dir.join("staging").join(&plan.batch);
    let downloads = cache_dir.join("downloads");
    let _ = std::fs::create_dir_all(&staging_root);

    let client = net::client()?;
    let total = plan.units.len();
    let mut outcomes: Vec<UnitOutcome> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    // ---- phase one: everything that does not touch a plugin directory ----
    // Cancellable throughout, and if it all fails, nothing has been disturbed.
    let mut ready: Vec<Ready> = Vec::new();

    for (i, unit) in plan.units.iter().enumerate() {
        if cancelled(&app.state::<AppState>(), &plan.batch) {
            outcomes.push(cancel_outcome(unit));
            continue;
        }
        if unit.action == Action::Uninstall {
            ready.push(Ready {
                unit: unit.clone(),
                staged: PathBuf::new(),
                entries: unit.entries.clone(),
                sha: None,
            });
            continue;
        }

        let Some(url) = unit.url.clone() else {
            outcomes.push(fail(unit, "no download for that format"));
            continue;
        };

        emit(&app, progress(&plan, i, total, unit, "downloading", 0, unit.size, None));
        // Named for what it is: a macOS application arrives as a disk image, a
        // Companion module as an npm tarball, everything else as a zip. The
        // container is settled by the file's own magic bytes rather than by
        // this name — but a half-downloaded file left in the cache by a crash
        // should not lie about its format.
        let is_image = url.to_ascii_lowercase().ends_with(".dmg");
        let suffix = if is_image {
            "dmg"
        } else if unit.format == Format::Companion {
            "tgz"
        } else {
            "zip"
        };
        let file = downloads.join(format!(
            "{}-{}-{}.{suffix}",
            unit.slug,
            unit.format.id(),
            plan.batch
        ));

        let app_for_progress = app.clone();
        let plan_id = plan.batch.clone();
        let slug = unit.slug.clone();
        let fmt = unit.format;
        let cb = move |done: u64, tot: Option<u64>| {
            let _ = app_for_progress.emit(
                "batch-progress",
                Progress {
                    batch: plan_id.clone(),
                    index: i,
                    total,
                    slug: slug.clone(),
                    format: fmt,
                    phase: "downloading",
                    bytes_done: done,
                    bytes_total: tot,
                    message: None,
                },
            );
        };

        let sha = match net::download(&client, &url, &file, &cb).await {
            Ok(s) => s,
            Err(e) => {
                outcomes.push(fail(unit, &e));
                continue;
            }
        };

        emit(&app, progress(&plan, i, total, unit, "extracting", 0, None, None));
        let staged = staging_root.join(format!("{}-{}", unit.slug, unit.format.id()));
        // A disk image is mounted rather than unpacked; everything after this
        // point is identical either way, which is the whole point of both
        // returning an `Unpacked`.
        let opened = if is_image {
            dmg::extract_app(&file, &staged)
        } else {
            archive::extract(
                &file,
                &staged,
                unit.format,
                platform,
                unit.install_name.as_deref(),
            )
        };
        let unpacked = match opened {
            Ok(u) => u,
            Err(e) => {
                let _ = std::fs::remove_file(&file);
                outcomes.push(fail(unit, &e.to_string()));
                continue;
            }
        };
        let _ = std::fs::remove_file(&file);

        if let Err(e) = archive::validate_layout(&staged, &unpacked, unit.format, platform) {
            outcomes.push(fail(unit, &e.to_string()));
            continue;
        }

        // On the staged copy, before anything moves — which is what keeps the
        // privileged helper out of the quarantine business entirely.
        emit(&app, progress(&plan, i, total, unit, "clearing-quarantine", 0, None, None));
        for name in &unpacked.entries {
            quarantine::clear(&staged.join(name));
        }

        if !unpacked.extras.is_empty() {
            notes.push(format!(
                "{} ships {} alongside the plugin. Those are not plugins, so they were \
                 not put in the plugin folder.",
                unit.name,
                unpacked.extras.join(", ")
            ));
        }

        // Two installs finish somewhere other than where the user expects, and
        // both are worth a sentence rather than a support question.
        if unit.format == Format::Companion && unit.action != Action::Uninstall {
            notes.push(format!(
                "Point Companion's Settings → Developer modules path at {} and restart it — \
                 Companion reads that folder when it starts, so {} will not appear until \
                 you do.",
                shown(&unit.destination),
                unit.name
            ));
        }
        if unit.format == Format::App
            && platform == Platform::Windows
            && unit.action != Action::Uninstall
        {
            notes.push(format!(
                "{} is in {}. No Start-menu shortcut was created — Burrow places the \
                 program folder and does not write anywhere else.",
                unit.name,
                shown(&unit.destination)
            ));
        }

        ready.push(Ready {
            unit: unit.clone(),
            staged,
            entries: unpacked.entries,
            sha: Some(sha),
        });
    }

    // ---- phase two: unprivileged commits ----
    let mut elevated: Vec<Ready> = Vec::new();

    for r in ready {
        if r.unit.needs_elevation {
            elevated.push(r);
            continue;
        }
        let outcome = apply_unprivileged(&app, &plan, &r);
        outcomes.push(outcome);
    }

    // ---- phase three: one prompt, if anything still needs one ----
    if !elevated.is_empty() {
        let mut ops: Vec<Op> = Vec::new();
        let mut roots: Vec<PathBuf> = Vec::new();

        for r in &elevated {
            if !roots.contains(&r.unit.destination) {
                roots.push(r.unit.destination.clone());
                ops.push(Op::EnsureRoot { path: r.unit.destination.clone() });
            }
            match r.unit.action {
                Action::Uninstall => {
                    for name in &r.entries {
                        let live = r.unit.destination.join(name);
                        ops.push(Op::Retire { path: live.clone() });
                        let mut aside = live.into_os_string();
                        aside.push(format!(".burrow-old-{}", plan.batch));
                        ops.push(Op::Purge { path: PathBuf::from(aside) });
                    }
                }
                _ => {
                    for name in &r.entries {
                        ops.push(Op::Replace {
                            from: r.staged.join(name),
                            to: r.unit.destination.join(name),
                        });
                    }
                }
            }
        }

        let what = describe(&elevated);
        let plan_file = {
            let state = app.state::<AppState>();
            let p = elevate::build_plan(plan.batch.clone(), what.clone(), ops);
            elevate::write_plan(&state.cache_dir, &p)?
        };

        for r in &elevated {
            emit(&app, progress(&plan, 0, total, &r.unit, "awaiting-authorization", 0, None,
                                Some(what.clone())));
        }

        let result = elevate::run_elevated(&helper, &plan_file, &what);
        let _ = std::fs::remove_file(&plan_file);
        let mut result_file = plan_file.into_os_string();
        result_file.push(".result.json");
        let _ = std::fs::remove_file(PathBuf::from(result_file));

        for r in &elevated {
            match &result {
                Elevation::Applied => {
                    record(&app, r, &plan.batch);
                    outcomes.push(ok(&r.unit));
                }
                Elevation::Cancelled => outcomes.push(cancel_outcome(&r.unit)),
                Elevation::Failed(e) => outcomes.push(fail(&r.unit, e)),
            }
        }
        if matches!(result, Elevation::Cancelled) && outcomes.iter().any(|o| o.ok) {
            notes.push(
                "You cancelled the password prompt, so the plugins that needed \
                 administrator rights were not installed. Everything else was."
                    .into(),
            );
        }
    }

    let _ = std::fs::remove_dir_all(&staging_root);
    let _ = state::save_ledger(&app.state::<AppState>());
    if let Ok(mut c) = app.state::<AppState>().inner().cancel.lock() {
        if c.as_deref() == Some(plan.batch.as_str()) {
            *c = None;
        }
    }

    if outcomes.iter().any(|o| o.ok) {
        notes.push("Restart your host to pick up the change.".into());
    }

    let outcome = BatchOutcome { batch: plan.batch.clone(), units: outcomes, notes };
    let _ = app.emit("batch-finished", outcome.clone());
    Ok(outcome)
}

fn apply_unprivileged(app: &AppHandle, plan: &BatchPlan, r: &Ready) -> UnitOutcome {
    let result = if r.unit.action == Action::Uninstall {
        commit::uninstall(&r.unit.destination, &r.entries, &plan.batch).map(|_| Vec::new())
    } else {
        commit::commit(&r.unit.destination, &r.staged, &r.entries, &plan.batch)
    };
    match result {
        Ok(_) => {
            record(app, r, &plan.batch);
            ok(&r.unit)
        }
        Err(e) => fail(&r.unit, &e.to_string()),
    }
}

/// Update the ledger to match what just happened.
fn record(app: &AppHandle, r: &Ready, batch: &str) {
    let state = app.state::<AppState>();
    let Ok(mut led) = state.ledger.lock() else { return };

    if r.unit.action == Action::Uninstall {
        led.remove(&r.unit.slug, r.unit.format, &r.unit.destination_id);
        return;
    }

    let payload_sha = burrow_core::hashing::hash_entries(&r.unit.destination, &r.entries)
        .unwrap_or_else(|_| String::new());
    let _ = r.sha;
    let _ = batch;

    led.upsert(ledger::LedgerEntry {
        slug: r.unit.slug.clone(),
        format: r.unit.format,
        destination_id: r.unit.destination_id.clone(),
        destination: r.unit.destination.clone(),
        entries: r.entries.clone(),
        version: r.unit.version.clone().unwrap_or_default(),
        installed_at: now_rfc3339(),
        payload_sha256: payload_sha,
    });
}

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

fn describe(units: &[Ready]) -> String {
    let dirs: Vec<String> = {
        let mut v: Vec<String> = units
            .iter()
            .map(|r| r.unit.destination.display().to_string())
            .collect();
        v.sort();
        v.dedup();
        v
    };
    format!(
        "Stoatworks Burrow needs permission to update plugins in {}.",
        dirs.join(" and ")
    )
}

/// Where the privileged helper actually is.
///
/// Tauri places an `externalBin` sidecar **next to the main executable** —
/// `Contents/MacOS/` inside a macOS bundle — and strips the target triple from
/// its name. Not in `Resources/`, which is where the catalogue and demos go.
///
/// Getting this wrong is not a compile error and not a startup error: the app
/// runs perfectly until somebody installs an OpenFX plugin, and then fails at
/// the moment it asks for a password. So all three plausible locations are
/// tried, and the dev-build path is included deliberately — `tauri dev` has no
/// bundle at all, and elevation should be testable without packaging first.
fn helper_path(app: &AppHandle) -> PathBuf {
    let name = if cfg!(windows) { "burrow-helper.exe" } else { "burrow-helper" };

    // Beside the executable: the packaged case.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    // In Resources: not where Tauri puts sidecars, but cheap to tolerate.
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    // `cargo tauri dev`: the workspace's own build output.
    if let Ok(exe) = std::env::current_exe() {
        for up in [3usize, 4] {
            let mut dir = exe.clone();
            for _ in 0..up {
                dir.pop();
            }
            for profile in ["release", "debug"] {
                let candidate = dir.join("target").join(profile).join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(name)
}

fn progress(
    plan: &BatchPlan,
    index: usize,
    total: usize,
    unit: &PlannedUnit,
    phase: &'static str,
    bytes_done: u64,
    bytes_total: Option<u64>,
    message: Option<String>,
) -> Progress {
    Progress {
        batch: plan.batch.clone(),
        index,
        total,
        slug: unit.slug.clone(),
        format: unit.format,
        phase,
        bytes_done,
        bytes_total,
        message,
    }
}

fn ok(u: &PlannedUnit) -> UnitOutcome {
    UnitOutcome {
        slug: u.slug.clone(),
        format: u.format,
        destination_id: u.destination_id.clone(),
        ok: true,
        cancelled: false,
        error: None,
    }
}

fn fail(u: &PlannedUnit, e: &str) -> UnitOutcome {
    UnitOutcome {
        slug: u.slug.clone(),
        format: u.format,
        destination_id: u.destination_id.clone(),
        ok: false,
        cancelled: false,
        error: Some(e.to_string()),
    }
}

fn cancel_outcome(u: &PlannedUnit) -> UnitOutcome {
    UnitOutcome {
        slug: u.slug.clone(),
        format: u.format,
        destination_id: u.destination_id.clone(),
        ok: false,
        cancelled: true,
        error: None,
    }
}
