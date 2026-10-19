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
//!
//! # Where the work runs
//!
//! Not on the thread the window lives on, and not on the async runtime's
//! workers either. The download is genuinely asynchronous and stays on the
//! runtime; everything after it — unpacking, hashing, copying, and the
//! password prompt, which blocks for as long as the person takes to read it —
//! is plain blocking work and goes to the blocking pool. See [`crate::off_main`]
//! for why the distinction is not academic.
//!
//! What the window hears about it is rate-limited: see [`Reporter`].

use burrow_core::model::{Format, Platform};
use burrow_core::{archive, commit, dmg, hashing, ledger, quarantine};
use burrow_plan::Op;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
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

/// One step of one unit, as the window draws it.
///
/// `bytes_total` is present for every phase that can know it — a download
/// with a Content-Length, a zip with a central directory, a copy or a hash of
/// a payload already on disk — and absent where nothing can: a tarball, and
/// the wait for a password. The window draws an indeterminate bar for those.
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

/// Progress, rate-limited on its way to the window.
///
/// Every event is an `eval` on the webview's main thread and a re-render of
/// the list on the far side of it, and a download hands back a chunk every few
/// kilobytes. Reporting each one meant thousands of events a second, and the
/// window they were meant to inform stopped answering for the duration — which
/// is how a working download came to be reported as a hang.
///
/// So a byte count goes out at most every tenth of a second. A change of
/// phase, and a count reaching its total, always go out: a bar must never be
/// left short of its end or under the wrong label because the last event
/// happened to fall inside the gap.
struct Reporter {
    app: AppHandle,
    batch: String,
    total: usize,
    gate: Gate,
}

/// The rate limit on its own, so it can be tested without a window.
struct Gate {
    started: Instant,
    /// Milliseconds after `started` at the last emit; `u64::MAX` for never.
    last: AtomicU64,
}

impl Gate {
    const MIN_GAP_MS: u64 = 100;

    fn new() -> Self {
        Gate { started: Instant::now(), last: AtomicU64::new(u64::MAX) }
    }

    /// Should a count go out now? Yes once it reaches its total, and yes once
    /// enough time has passed since the last one; otherwise it is held back.
    fn due(&self, done: u64, total: Option<u64>) -> bool {
        if total.is_some_and(|t| done >= t) {
            return true;
        }
        let last = self.last.load(Ordering::Relaxed);
        last == u64::MAX || self.now().saturating_sub(last) >= Self::MIN_GAP_MS
    }

    fn mark(&self) {
        self.last.store(self.now(), Ordering::Relaxed);
    }

    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

impl Reporter {
    fn new(app: AppHandle, batch: String, total: usize) -> Self {
        Reporter { app, batch, total, gate: Gate::new() }
    }

    /// A unit has entered a phase. Always sent.
    fn phase(
        &self,
        index: usize,
        unit: &PlannedUnit,
        phase: &'static str,
        bytes_total: Option<u64>,
        message: Option<String>,
    ) {
        self.send(index, unit, phase, 0, bytes_total, message);
    }

    /// A unit has finished a phase and is waiting on the batch — staged, with
    /// the next unit's download ahead of its own commit. Always sent, with a
    /// full bar, or the row would go on showing the last thing it was doing.
    fn parked(&self, index: usize, unit: &PlannedUnit, phase: &'static str, size: u64) {
        self.send(index, unit, phase, size, Some(size), None);
    }

    /// A unit has moved within a phase. Sent when due, or when done.
    fn bytes(&self, index: usize, unit: &PlannedUnit, phase: &'static str, done: u64, total: Option<u64>) {
        if self.gate.due(done, total) {
            self.send(index, unit, phase, done, total, None);
        }
    }

    fn send(
        &self,
        index: usize,
        unit: &PlannedUnit,
        phase: &'static str,
        bytes_done: u64,
        bytes_total: Option<u64>,
        message: Option<String>,
    ) {
        self.gate.mark();
        let _ = self.app.emit(
            "batch-progress",
            Progress {
                batch: self.batch.clone(),
                index,
                total: self.total,
                slug: unit.slug.clone(),
                format: unit.format,
                phase,
                bytes_done,
                bytes_total,
                message,
            },
        );
    }
}

/// A unit that has been fetched, checked and staged, and is ready to be put
/// into place. Everything expensive and everything fallible has already
/// happened by the time one of these exists.
struct Ready {
    /// Its position in the plan, for the progress the commit still reports.
    index: usize,
    unit: PlannedUnit,
    staged: PathBuf,
    entries: Vec<String>,
    /// The payload's size on disk: the total for the copy and the hash to come.
    size: u64,
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

/// Resolve every request against the catalogue and this machine, touching
/// nothing. Off the main thread because it needs the environment, which probes
/// every destination.
#[tauri::command]
pub async fn plan_batch(app: AppHandle, requests: Vec<OpRequest>) -> Result<BatchPlan, String> {
    crate::off_main(move || plan(&app, &requests)).await
}

fn plan(app: &AppHandle, requests: &[OpRequest]) -> Result<BatchPlan, String> {
    let env = state::environment(app)?;
    let state = app.state::<AppState>();
    let catalog = state.catalog.lock().map_err(|_| "state is poisoned")?;
    let cat = catalog.as_ref().ok_or("the plugin list has not loaded yet")?;
    let led = state.ledger.lock().map_err(|_| "state is poisoned")?;
    let platform = Platform::current().ok_or("no plugin hosts are supported on this platform")?;

    let mut units = Vec::new();
    let mut warnings = Vec::new();
    let mut download_bytes = 0u64;
    let mut elevated_destinations: Vec<PathBuf> = Vec::new();

    for req in requests {
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
    let reporter = Arc::new(Reporter::new(app.clone(), plan.batch.clone(), total));
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
                index: i,
                unit: unit.clone(),
                staged: PathBuf::new(),
                entries: unit.entries.clone(),
                size: 0,
                sha: None,
            });
            continue;
        }

        let Some(url) = unit.url.clone() else {
            outcomes.push(fail(unit, "no download for that format"));
            continue;
        };

        reporter.phase(i, unit, "downloading", unit.size, None);
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

        let on_bytes = |done: u64, tot: Option<u64>| reporter.bytes(i, unit, "downloading", done, tot);
        let should_stop = || cancelled(&app.state::<AppState>(), &plan.batch);
        let sha = match net::download(&client, &url, &file, &on_bytes, &should_stop).await {
            Ok(net::Download::Complete { sha256 }) => sha256,
            Ok(net::Download::Cancelled) => {
                outcomes.push(cancel_outcome(unit));
                continue;
            }
            Err(e) => {
                outcomes.push(fail(unit, &e));
                continue;
            }
        };

        // Unpacking, checking and de-quarantining are blocking work on a file
        // that is now local: off the runtime, so a download for the next unit
        // could in principle share the wait, and so nothing async is starved
        // while a disk image is copied off its mount.
        let staged = staging_root.join(format!("{}-{}", unit.slug, unit.format.id()));
        let staging = {
            let reporter = reporter.clone();
            let unit = unit.clone();
            let file = file.clone();
            let staged = staged.clone();
            tauri::async_runtime::spawn_blocking(move || {
                stage(&reporter, i, &unit, &file, &staged, platform, is_image)
            })
            .await
            .map_err(|e| format!("the install stopped unexpectedly: {e}"))?
        };
        let (unpacked, size) = match staging {
            Ok(s) => s,
            Err(e) => {
                outcomes.push(fail(unit, &e));
                continue;
            }
        };

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

        reporter.parked(i, unit, "staged", size);
        ready.push(Ready {
            index: i,
            unit: unit.clone(),
            staged,
            entries: unpacked.entries,
            size,
            sha: Some(sha),
        });
    }

    // ---- phases two and three: the commits, and the prompt ----
    // Blocking from here to the end: copies into plugin folders, hashes of what
    // was placed, and a password prompt that returns when the person does.
    let finished = {
        let app = app.clone();
        let reporter = reporter.clone();
        let batch = plan.batch.clone();
        tauri::async_runtime::spawn_blocking(move || finish(&app, &reporter, &batch, &helper, ready))
            .await
            .map_err(|e| format!("the install stopped unexpectedly: {e}"))?
    };
    outcomes.extend(finished.0);
    notes.extend(finished.1);

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

/// Turn a downloaded file into a staged, validated, de-quarantined payload.
///
/// Returns what was unpacked and its size on disk. The download is deleted
/// whichever way this goes: a file that failed to unpack is not worth keeping,
/// and one that unpacked has been superseded by its contents.
fn stage(
    reporter: &Reporter,
    index: usize,
    unit: &PlannedUnit,
    file: &Path,
    staged: &Path,
    platform: Platform,
    is_image: bool,
) -> Result<(archive::Unpacked, u64), String> {
    reporter.phase(index, unit, "extracting", None, None);
    let mut on_progress = |done: u64, total: Option<u64>| {
        reporter.bytes(index, unit, "extracting", done, total)
    };
    // A disk image is mounted rather than unpacked; everything after this
    // point is identical either way, which is the whole point of both
    // returning an `Unpacked`.
    let opened = if is_image {
        dmg::extract_app_with(file, staged, &mut on_progress)
    } else {
        archive::extract_with(
            file,
            staged,
            unit.format,
            platform,
            unit.install_name.as_deref(),
            &mut on_progress,
        )
    };
    let _ = std::fs::remove_file(file);
    let unpacked = opened.map_err(|e| e.to_string())?;

    archive::validate_layout(staged, &unpacked, unit.format, platform).map_err(|e| e.to_string())?;

    // On the staged copy, before anything moves — which is what keeps the
    // privileged helper out of the quarantine business entirely.
    reporter.phase(index, unit, "clearing-quarantine", None, None);
    for name in &unpacked.entries {
        quarantine::clear(&staged.join(name));
    }

    let size = hashing::payload_size(staged, &unpacked.entries);
    Ok((unpacked, size))
}

/// Phases two and three. Returns the outcomes and notes to append.
fn finish(
    app: &AppHandle,
    reporter: &Reporter,
    batch: &str,
    helper: &Path,
    ready: Vec<Ready>,
) -> (Vec<UnitOutcome>, Vec<String>) {
    let mut outcomes: Vec<UnitOutcome> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    // ---- phase two: unprivileged commits ----
    let mut elevated: Vec<Ready> = Vec::new();

    for r in ready {
        if r.unit.needs_elevation {
            elevated.push(r);
            continue;
        }
        outcomes.push(apply_unprivileged(app, reporter, batch, &r));
    }

    // ---- phase three: one prompt, if anything still needs one ----
    if elevated.is_empty() {
        return (outcomes, notes);
    }

    // A person who pressed Cancel is not then asked for their password. What
    // was already staged for an unprivileged folder went in above, because
    // that asks nothing of them; this would.
    if cancelled(&app.state::<AppState>(), batch) {
        outcomes.extend(elevated.iter().map(|r| cancel_outcome(&r.unit)));
        return (outcomes, notes);
    }

    let ops = elevated_ops(&elevated, batch);
    let what = describe(&elevated);
    let plan_file = {
        let state = app.state::<AppState>();
        let p = elevate::build_plan(batch.to_string(), what.clone(), ops);
        match elevate::write_plan(&state.cache_dir, &p) {
            Ok(f) => f,
            Err(e) => {
                outcomes.extend(elevated.iter().map(|r| fail(&r.unit, &e)));
                return (outcomes, notes);
            }
        }
    };

    for r in &elevated {
        reporter.phase(r.index, &r.unit, "awaiting-authorization", None, Some(what.clone()));
    }

    let result = elevate::run_elevated(helper, &plan_file, &what);
    let _ = std::fs::remove_file(&plan_file);
    let mut result_file = plan_file.into_os_string();
    result_file.push(".result.json");
    let _ = std::fs::remove_file(PathBuf::from(result_file));

    for r in &elevated {
        match &result {
            Elevation::Applied => {
                record(app, reporter, r);
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

    (outcomes, notes)
}

/// What the privileged helper is asked to do for the units that need a password.
///
/// An install or update over an existing copy is a `Replace`, and the helper's
/// replace moves the old payload aside under this batch's nonce rather than
/// deleting it — that is what lets it roll back. So every replacement is
/// followed by a `Purge` of that aside copy, the same tidy-up `commit` does
/// for an unprivileged folder. Without it each update through the password
/// prompt left the previous version in `/Library/OFX/Plugins` as
/// `Name.ofx.bundle.burrow-old-<nonce>`, found there on the author's Mac.
///
/// The purges go last, after every replacement: a replacement that fails rolls
/// the whole plan back, and it can only put back what has not been deleted yet.
/// A fresh install has nothing aside, and purging a path that is not there is
/// a no-op in the helper.
fn elevated_ops(elevated: &[Ready], batch: &str) -> Vec<Op> {
    let mut ops: Vec<Op> = Vec::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut superseded: Vec<PathBuf> = Vec::new();

    for r in elevated {
        if !roots.contains(&r.unit.destination) {
            roots.push(r.unit.destination.clone());
            ops.push(Op::EnsureRoot { path: r.unit.destination.clone() });
        }
        match r.unit.action {
            Action::Uninstall => {
                for name in &r.entries {
                    let live = r.unit.destination.join(name);
                    ops.push(Op::Retire { path: live.clone() });
                    ops.push(Op::Purge { path: aside(&live, batch) });
                }
            }
            _ => {
                for name in &r.entries {
                    let to = r.unit.destination.join(name);
                    superseded.push(aside(&to, batch));
                    ops.push(Op::Replace { from: r.staged.join(name), to });
                }
            }
        }
    }

    ops.extend(superseded.into_iter().map(|path| Op::Purge { path }));
    ops
}

/// Where the helper puts a payload it has moved out of the way: the same name
/// with this batch's nonce on the end, which is the only thing a `Purge` in
/// this batch is allowed to delete.
fn aside(live: &Path, batch: &str) -> PathBuf {
    let mut s = live.as_os_str().to_os_string();
    s.push(format!(".burrow-old-{batch}"));
    PathBuf::from(s)
}

fn apply_unprivileged(app: &AppHandle, reporter: &Reporter, batch: &str, r: &Ready) -> UnitOutcome {
    let result = if r.unit.action == Action::Uninstall {
        reporter.phase(r.index, &r.unit, "removing", None, None);
        commit::uninstall(&r.unit.destination, &r.entries, batch).map(|_| Vec::new())
    } else {
        reporter.phase(r.index, &r.unit, "committing", Some(r.size), None);
        commit::commit_with(&r.unit.destination, &r.staged, &r.entries, batch, &mut |done| {
            reporter.bytes(r.index, &r.unit, "committing", done, Some(r.size))
        })
    };
    match result {
        Ok(_) => {
            record(app, reporter, r);
            ok(&r.unit)
        }
        Err(e) => fail(&r.unit, &e.to_string()),
    }
}

/// Update the ledger to match what just happened.
fn record(app: &AppHandle, reporter: &Reporter, r: &Ready) {
    let state = app.state::<AppState>();
    let Ok(mut led) = state.ledger.lock() else { return };

    if r.unit.action == Action::Uninstall {
        led.remove(&r.unit.slug, r.unit.format, &r.unit.destination_id);
        return;
    }

    // Hashed where it landed, not where it was staged: the ledger's claim is
    // about the bytes in the plugin folder, and this is the one moment those
    // are known to be exactly what Burrow put there.
    reporter.phase(r.index, &r.unit, "verifying", Some(r.size), None);
    let payload_sha =
        hashing::hash_entries_with(&r.unit.destination, &r.entries, &mut |done| {
            reporter.bytes(r.index, &r.unit, "verifying", done, Some(r.size))
        })
        .unwrap_or_else(|_| String::new());
    let _ = r.sha;

    led.upsert(ledger::LedgerEntry {
        slug: r.unit.slug.clone(),
        format: r.unit.format,
        destination_id: r.unit.destination_id.clone(),
        destination: r.unit.destination.clone(),
        entries: r.entries.clone(),
        version: r.unit.version.clone().unwrap_or_default(),
        installed_at: now_stamp(),
        payload_sha256: payload_sha,
        claimed: false,
    });
}

/// When something was written into the ledger.
///
/// **Not RFC 3339, whatever this was called before.** Nothing in this workspace
/// pulls in a date library, and `installed_at` is only ever read by a person
/// looking at `ledger.json` — so it is seconds since the epoch, labelled as
/// such. A value that says what it is beats one shaped like a date and wrong.
pub(crate) fn now_stamp() -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The reporter's whole reason to exist: a byte count arriving on every
    /// chunk must not go out on every chunk.
    #[test]
    fn a_byte_count_is_rate_limited_but_never_dropped_at_the_end() {
        let g = Gate::new();
        // The first one goes: nothing has been sent yet.
        assert!(g.due(10, Some(100)));
        g.mark();
        // Straight after, an intermediate count is held back...
        assert!(!g.due(20, Some(100)));
        // ...but reaching the total is not.
        assert!(g.due(100, Some(100)));
    }

    #[test]
    fn a_count_with_no_total_is_still_rate_limited() {
        let g = Gate::new();
        assert!(g.due(10, None));
        g.mark();
        assert!(!g.due(20, None));
    }

    const BATCH: &str = "9f2c4a7e6b1d03589f2c4a7e6b1d0358";

    fn ready(slug: &str, action: Action, entries: &[&str]) -> Ready {
        let staged = PathBuf::from("/Users/x/Library/Caches/com.stoatworkslabs.burrow/staging")
            .join(BATCH)
            .join(format!("{slug}-openfx"));
        let entries: Vec<String> = entries.iter().map(|e| e.to_string()).collect();
        Ready {
            index: 0,
            unit: PlannedUnit {
                slug: slug.into(),
                name: slug.into(),
                version: Some("v1.0.0".into()),
                format: Format::Openfx,
                destination_id: "openfx".into(),
                destination: PathBuf::from("/Library/OFX/Plugins"),
                action,
                url: None,
                size: None,
                entries: entries.clone(),
                needs_elevation: true,
                install_name: None,
            },
            staged,
            entries,
            size: 0,
            sha: None,
        }
    }

    fn ofx(name: &str) -> PathBuf {
        PathBuf::from("/Library/OFX/Plugins").join(name)
    }

    /// The leftover found on a real Mac: `Rebate.ofx.bundle.burrow-old-<nonce>`
    /// beside the new Rebate, after an update through the password prompt.
    #[test]
    fn an_update_through_the_password_prompt_deletes_what_it_moved_aside() {
        let units = [
            ready("downpour", Action::Update, &["Downpour.ofx.bundle", "Downpour Over.ofx.bundle"]),
            ready("rebate", Action::Install, &["Rebate.ofx.bundle"]),
        ];
        let ops = elevated_ops(&units, BATCH);

        let purged: Vec<&PathBuf> = ops
            .iter()
            .filter_map(|o| match o {
                Op::Purge { path } => Some(path),
                _ => None,
            })
            .collect();
        let old = |n: &str| ofx(&format!("{n}.burrow-old-{BATCH}"));
        assert_eq!(
            purged,
            vec![&old("Downpour.ofx.bundle"), &old("Downpour Over.ofx.bundle"), &old("Rebate.ofx.bundle")]
        );

        // Every purge after every replacement, so a replacement that fails can
        // still be rolled back to the copy it moved aside.
        let last_replace = ops.iter().rposition(|o| matches!(o, Op::Replace { .. })).unwrap();
        let first_purge = ops.iter().position(|o| matches!(o, Op::Purge { .. })).unwrap();
        assert!(last_replace < first_purge, "{ops:?}");

        // One EnsureRoot for the shared folder, not one per unit.
        assert_eq!(ops.iter().filter(|o| matches!(o, Op::EnsureRoot { .. })).count(), 1);
    }

    /// And the helper's own validator accepts the result: the purges name only
    /// what this batch's nonce marks, so nothing was widened to allow them.
    #[test]
    #[cfg(target_os = "macos")]
    fn the_plan_with_its_purges_passes_the_helpers_validator() {
        let units = [ready("rebate", Action::Update, &["Rebate.ofx.bundle"])];
        let plan = elevate::build_plan(BATCH.into(), "test".into(), elevated_ops(&units, BATCH));
        let cache = PathBuf::from("/Users/x/Library/Caches/com.stoatworkslabs.burrow");
        assert_eq!(burrow_plan::validate(&plan, &cache), Ok(()));
    }

    #[test]
    fn an_uninstall_through_the_password_prompt_is_still_retire_then_purge() {
        let units = [ready("rebate", Action::Uninstall, &["Rebate.ofx.bundle"])];
        let ops = elevated_ops(&units, BATCH);
        assert!(matches!(&ops[0], Op::EnsureRoot { .. }));
        assert!(matches!(&ops[1], Op::Retire { path } if *path == ofx("Rebate.ofx.bundle")));
        assert!(
            matches!(&ops[2], Op::Purge { path } if *path == ofx(&format!("Rebate.ofx.bundle.burrow-old-{BATCH}")))
        );
        assert_eq!(ops.len(), 3);
    }

    #[test]
    fn the_gate_reopens_once_the_gap_has_passed() {
        // A gate that has been open for a second, with its last emit exactly
        // one gap ago — backdated rather than slept for.
        let g = Gate {
            started: Instant::now() - std::time::Duration::from_secs(1),
            last: AtomicU64::new(1000 - Gate::MIN_GAP_MS),
        };
        assert!(g.due(20, Some(100)));
        g.mark();
        assert!(!g.due(30, Some(100)));
    }
}
