//! The Device firmware tab's commands: any ESP32 board over its serial port,
//! from the catalogue's firmware packages or from files of your own.
//!
//! None of this goes near the folder-install machinery in `jobs.rs` — no slot,
//! no staging rename, no ledger, no privileged helper. A device write has
//! nothing to stage and nothing to roll back to, so its safety is the gate in
//! `burrow-device`, run against a fresh read of the unit immediately before the
//! first byte, and a confirmation in the window that says exactly what will be
//! written where.
//!
//! The package format is the Stoatworks Flasher's (its `docs/PACKAGE.md`,
//! schema 2), so the page and this tab read the same release zips. The page
//! reads a zip in memory; here it is unpacked with burrow-core's guarded
//! extractor and read from the cache.
//!
//! Devices are looked for when the user asks, never in the background. Opening
//! an ESP32's port reboots it, which is not something to do to a unit nobody
//! pointed Burrow at.
//!
//! One device job at a time, and a write cannot be cancelled: stopping half way
//! through a partition is worse than finishing it.

use burrow_core::archive;
use burrow_core::catalog::Entry;
use burrow_core::model::Format;
use burrow_device::esp::{
    chips::DEFAULT_TABLE_OFFSET,
    files::{chip_of, is_zip, loose_table, loose_writes, place_files, LooseFile},
    image::{describe_image, hex, partition_at, ImageInfo},
    package::{self, github_asset, known_devices, load_variant, merged_name, open_package_dir, zip_name, DeviceDef, Package},
    plan::{
        check_plan, components, effective_table, plan_notes, replace_text, unit_problems, with_otadata_reset,
        PlanContext, PlannedWrite, Want,
    },
    session::{self, Description, PortInfo, Stage, Unit, WriteOptions},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::jobs::Gate;
use crate::net;
use crate::off_main;
use crate::state::AppState;

/// Bigger than any ESP32's flash. A file past this is not an image, and
/// reading it into memory to say so would be the wrong way round.
const MAX_FILE: u64 = 64 << 20;

#[derive(Default)]
pub struct FirmwareState {
    busy: Mutex<bool>,
    /// Packages read this session, by token: `catalog:<slug>` for the
    /// catalogue's, `file` for a zip somebody opened.
    packages: Mutex<HashMap<String, Opened>>,
    /// The files of your own build last opened, bytes and all.
    loose: Mutex<Vec<(String, Vec<u8>)>>,
    /// The last unit read, so a plan can be checked against it.
    unit: Mutex<Option<Description>>,
}

#[derive(Clone)]
struct Opened {
    root: PathBuf,
    pkg: Package,
}

/// Holding this is holding the one device job.
struct Busy<'a>(&'a Mutex<bool>);

impl<'a> Busy<'a> {
    fn take(m: &'a Mutex<bool>) -> Result<Busy<'a>, String> {
        let mut b = m.lock().map_err(|_| "state lock poisoned")?;
        if *b {
            return Err("another device job is still running".into());
        }
        *b = true;
        Ok(Busy(m))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        if let Ok(mut b) = self.0.lock() {
            *b = false;
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    m.lock().map_err(|_| "state lock poisoned".to_string())
}

// --- progress ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FwProgress {
    job: String,
    phase: &'static str,
    done: u64,
    total: Option<u64>,
    message: Option<String>,
}

/// Progress for one device job, rate-limited the way a plugin batch's is.
#[derive(Clone)]
struct Emit {
    app: AppHandle,
    job: String,
    gate: Arc<Gate>,
}

impl Emit {
    fn new(app: &AppHandle, job: &str) -> Emit {
        Emit { app: app.clone(), job: job.to_string(), gate: Arc::new(Gate::new()) }
    }
    fn phase(&self, phase: &'static str, message: Option<String>) {
        self.send(phase, 0, None, message);
    }
    fn bytes(&self, phase: &'static str, done: u64, total: Option<u64>) {
        if self.gate.due(done, total) {
            self.send(phase, done, total, None);
        }
    }
    fn send(&self, phase: &'static str, done: u64, total: Option<u64>, message: Option<String>) {
        self.gate.mark();
        let _ = self.app.emit("firmware-progress", FwProgress { job: self.job.clone(), phase, done, total, message });
    }
}

// --- the catalogue's firmware -----------------------------------------------------

/// Catalogue devices that are not ESP32 boards, which this build does not
/// write. The live catalogue carries the BirdDog PLAY's patcher kit as
/// firmware; its writer is held on `claude/device-firmware`. Refused before
/// anything is downloaded, rather than after fetching 15 MB that is not a
/// firmware package. The tab lists the same ids, shown and not offered.
const NOT_ESP32: &[&str] = &["birddog-play"];

fn firmware_entry(state: &AppState, slug: &str) -> Result<Entry, String> {
    let catalog = lock(&state.catalog)?;
    let catalog = catalog.as_ref().ok_or("the catalogue has not loaded yet")?;
    let entry = catalog
        .entries
        .iter()
        .find(|e| e.kind == "firmware" && e.slug == slug && e.device.is_some())
        .cloned()
        .ok_or_else(|| format!("the catalogue carries no firmware called {slug}"))?;
    if entry.device.as_deref().is_some_and(|d| NOT_ESP32.contains(&d)) {
        return Err(format!("{} is not for an ESP32 board, and this Burrow writes only those", entry.name));
    }
    Ok(entry)
}

/// Fetch an entry's firmware asset into the cache, check it against the
/// catalogue's SHA-256, and unpack it. A cached copy whose bytes still match is
/// used as it is, so a release is downloaded once.
///
/// The digest is required. A plugin install can be inspected in staging before
/// it goes anywhere; firmware goes straight to a device, so the only check
/// between the network and the flash is this one.
async fn fetch_unpacked(state: &AppState, entry: &Entry, emit: &Emit) -> Result<(PathBuf, String, String), String> {
    let asset = entry
        .assets
        .iter()
        .find(|a| a.format == Format::Firmware)
        .map(|a| a.asset.clone())
        .ok_or_else(|| format!("{} has no firmware download in the catalogue", entry.name))?;
    let want = asset
        .sha256
        .clone()
        .ok_or_else(|| format!("the catalogue gives no SHA-256 for {}, so Burrow will not write it", entry.name))?
        .to_ascii_lowercase();
    if want.len() != 64 || !want.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("the catalogue's SHA-256 for {} is not one", entry.name));
    }
    let dir = state.cache_dir.join("firmware");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join(format!("{}-{}.zip", entry.slug, &want[..12]));
    let unpacked = dir.join(format!("{}-{}", entry.slug, &want[..12]));

    let cached_ok = std::fs::read(&zip).map(|b| package::sha256_hex(&b) == want).unwrap_or(false);
    if !cached_ok {
        emit.phase("downloading", Some(entry.name.clone()));
        let client = net::client()?;
        let e2 = emit.clone();
        let got = net::download(&client, &asset.url, &zip, &move |done, total| e2.bytes("downloading", done, total), &|| false)
            .await?;
        let net::Download::Complete { sha256 } = got else {
            return Err("the download stopped".into());
        };
        if sha256 != want {
            let _ = std::fs::remove_file(&zip);
            return Err(format!("{} does not match the SHA-256 the catalogue gives for it", entry.name));
        }
    }
    let _ = std::fs::remove_dir_all(&unpacked);
    let (z, u) = (zip.clone(), unpacked.clone());
    off_main(move || archive::unpack_all(&z, &u).map_err(|e| e.to_string())).await?;
    Ok((unpacked, asset.url.clone(), want))
}

/// Every device Burrow knows a definition for: the built-in CANary (for the
/// first schema, which names none) and each package read this session.
fn known(fw: &FirmwareState) -> Vec<DeviceDef> {
    let mut out = known_devices();
    if let Ok(p) = fw.packages.lock() {
        for o in p.values() {
            if !out.iter().any(|d| d.id == o.pkg.device.id) {
                out.push(o.pkg.device.clone());
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub label: String,
    pub name: String,
    pub url: String,
}

/// A release's direct downloads on its device's GitHub repo: the zip and a
/// whole-flash image per variant. Only for a tagged release; a link to
/// latest/download would move under the person holding it.
fn release_links(d: &DeviceDef, pkg: &Package) -> Vec<Link> {
    let mut out = Vec::new();
    for r in &pkg.releases {
        let zip = zip_name(d, r);
        if let Some(url) = github_asset(d, r, &zip) {
            out.push(Link { label: format!("{} release zip", r.id), name: zip, url });
        }
        for v in &r.variants {
            let name = merged_name(d, r, v);
            if let Some(url) = github_asset(d, r, &name) {
                out.push(Link { label: format!("{} {}, whole flash", r.id, v.name), name, url });
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EspRelease {
    pub slug: String,
    /// The catalogue's version for the entry.
    pub version: Option<String>,
    pub package: Package,
    /// The zip Burrow downloaded, and the digest it was checked against.
    pub zip_url: String,
    pub zip_sha256: String,
    pub links: Vec<Link>,
}

/// A catalogue firmware package: fetched (once), checked, unpacked, read.
#[tauri::command]
pub async fn esp_release(
    app: AppHandle,
    state: State<'_, AppState>,
    fw: State<'_, FirmwareState>,
    slug: String,
) -> Result<EspRelease, String> {
    let entry = firmware_entry(&state, &slug)?;
    let emit = Emit::new(&app, &format!("release:{slug}"));
    let (root, zip_url, zip_sha256) = match fetch_unpacked(&state, &entry, &emit).await {
        Ok(x) => x,
        Err(e) => {
            emit.phase("failed", Some(e.clone()));
            return Err(e);
        }
    };
    let known = known(&fw);
    let r = root.clone();
    let pkg = off_main(move || open_package_dir(&r, &known)).await.inspect_err(|e| emit.phase("failed", Some(e.clone())))?;
    if entry.device.as_deref() != Some(pkg.device.id.as_str()) {
        let e = format!(
            "the catalogue says {} is for {}, and its package is for {}",
            entry.name,
            entry.device.as_deref().unwrap_or("nothing"),
            pkg.device.id
        );
        emit.phase("failed", Some(e.clone()));
        return Err(e);
    }
    lock(&fw.packages)?.insert(format!("catalog:{slug}"), Opened { root, pkg: pkg.clone() });
    emit.phase("done", None);
    Ok(EspRelease {
        slug,
        version: entry.version.clone(),
        links: release_links(&pkg.device, &pkg),
        package: pkg,
        zip_url,
        zip_sha256,
    })
}

// --- files of your own -------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OpenedFiles {
    /// A release zip: a package, every part checked against its manifest.
    #[serde(rename_all = "camelCase")]
    Package { package: Box<Package>, links: Vec<Link> },
    /// Images of your own, each identified by its bytes.
    #[serde(rename_all = "camelCase")]
    Loose { files: Vec<LooseInfo> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LooseInfo {
    pub name: String,
    pub size: u64,
    /// What it is, in a few words.
    pub what: String,
    pub kind: &'static str,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Read what somebody picked. One zip is a package; anything else is a set of
/// images placed by what they are. Nothing here goes near a unit.
#[tauri::command]
pub async fn esp_open_files(
    state: State<'_, AppState>,
    fw: State<'_, FirmwareState>,
    paths: Vec<PathBuf>,
) -> Result<OpenedFiles, String> {
    if paths.is_empty() {
        return Err("choose a firmware zip or the images of your own build".into());
    }
    let mut files = Vec::new();
    for p in &paths {
        let size = std::fs::metadata(p).map_err(|e| format!("{}: {e}", file_name(p)))?.len();
        if size > MAX_FILE {
            return Err(format!("{} is {} MB, bigger than any ESP32's flash", file_name(p), size >> 20));
        }
        files.push((p.clone(), std::fs::read(p).map_err(|e| format!("{}: {e}", file_name(p)))?));
    }
    lock(&fw.packages)?.remove("file");
    lock(&fw.loose)?.clear();
    if files.iter().any(|(_, d)| is_zip(d)) {
        if files.len() > 1 {
            return Err("choose a release zip on its own".into());
        }
        let (src, _) = &files[0];
        let root = state.cache_dir.join("firmware").join("opened");
        let _ = std::fs::remove_dir_all(&root);
        let (s, r) = (src.clone(), root.clone());
        off_main(move || archive::unpack_all(&s, &r).map_err(|e| format!("this zip could not be read: {e}"))).await?;
        let known = known(&fw);
        let r = root.clone();
        let pkg = off_main(move || open_package_dir(&r, &known)).await?;
        lock(&fw.packages)?.insert("file".into(), Opened { root, pkg: pkg.clone() });
        return Ok(OpenedFiles::Package { links: release_links(&pkg.device, &pkg), package: Box::new(pkg) });
    }
    let infos = files
        .iter()
        .map(|(p, d)| {
            let info = burrow_device::esp::image::identify(d);
            LooseInfo { name: file_name(p), size: d.len() as u64, what: describe_image(&info), kind: info.kind() }
        })
        .collect();
    *lock(&fw.loose)? = files.into_iter().map(|(p, d)| (file_name(&p), d)).collect();
    Ok(OpenedFiles::Loose { files: infos })
}

// --- the unit ------------------------------------------------------------------------

#[tauri::command]
pub async fn esp_ports(all: bool) -> Result<Vec<PortInfo>, String> {
    off_main(move || session::list_ports(all)).await
}

fn port_by_name(name: &str) -> Result<PortInfo, String> {
    session::list_ports(true)?
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("{name} is not there any more — was the unit unplugged?"))
}

/// Read a unit. Opening its port resets it into the ROM, so this restarts it
/// again afterwards: a look leaves it running, not parked in download mode.
#[tauri::command]
pub async fn esp_describe(
    fw: State<'_, FirmwareState>,
    port: String,
    baud: Option<u32>,
    table_offset: Option<u32>,
) -> Result<Description, String> {
    let _busy = Busy::take(&fw.busy)?;
    *lock(&fw.unit)? = None;
    let d = off_main(move || {
        let p = port_by_name(&port)?;
        let mut unit = Unit::open(&p, baud)?;
        let d = unit.describe(table_offset.unwrap_or(DEFAULT_TABLE_OFFSET));
        let _ = unit.restart();
        d
    })
    .await?;
    *lock(&fw.unit)? = Some(d.clone());
    Ok(d)
}

/// Forget the unit last read: it was unplugged, or the person said so.
#[tauri::command]
pub async fn esp_forget_unit(fw: State<'_, FirmwareState>) -> Result<(), String> {
    *lock(&fw.unit)? = None;
    Ok(())
}

// --- the plan ----------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Source {
    /// A catalogue package, loaded with `esp_release`.
    #[serde(rename_all = "camelCase")]
    Catalog { slug: String, release: String, variant: String },
    /// The zip last opened with `esp_open_files`.
    #[serde(rename_all = "camelCase")]
    Package { release: String, variant: String },
    /// The images last opened, with whatever offset was typed for each, in
    /// the order they were opened.
    #[serde(rename_all = "camelCase")]
    Files {
        #[serde(default)]
        typed: Vec<String>,
    },
}

/// What the chosen firmware asks of the unit, and what to tell the person.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WantView {
    /// The device's name; None for files of your own.
    pub device: Option<String>,
    pub chip: Option<String>,
    pub projects: Option<Vec<String>>,
    pub min_flash: Option<u64>,
    pub table_offset: u32,
    pub baud: Option<u32>,
    /// Shown once the unit has rebooted into it.
    pub after: Option<String>,
}

struct Resolved {
    writes: Vec<PlannedWrite>,
    notes: Vec<String>,
    want: WantView,
}

fn want_for(d: &DeviceDef, after: Option<String>) -> WantView {
    WantView {
        device: Some(d.name.clone()),
        chip: Some(d.chip.clone()),
        projects: Some(d.projects.clone()),
        min_flash: Some(d.flash_size),
        table_offset: d.table_offset(),
        baud: d.baud,
        after,
    }
}

/// The writes for a source, read from disk and checked against the package's
/// own SHA-256 every time, or the reason there are none.
fn resolve(fw: &FirmwareState, source: &Source, unit: Option<&Description>) -> Result<Result<Resolved, String>, String> {
    let from_package = |key: &str, release: &str, variant: &str, note: &str| -> Result<Result<Resolved, String>, String> {
        let opened = lock(&fw.packages)?.get(key).cloned();
        let Some(o) = opened else {
            return Ok(Err("the firmware is not loaded; choose it again".into()));
        };
        let Some(r) = o.pkg.releases.iter().find(|r| r.id == release) else {
            return Ok(Err(format!("the package has no release {release}")));
        };
        let Some(v) = r.variants.iter().find(|v| v.id == variant) else {
            return Ok(Err(format!("{release} has no variant {variant}")));
        };
        Ok(load_variant(&o.root, r, v, o.pkg.device.table_offset()).map(|writes| Resolved {
            writes,
            notes: vec![note.to_string()],
            want: want_for(&o.pkg.device, v.after.clone()),
        }))
    };
    match source {
        Source::Catalog { slug, release, variant } => from_package(
            &format!("catalog:{slug}"),
            release,
            variant,
            "Every part matched the SHA-256 in its package, and the package the one the catalogue gives.",
        ),
        Source::Package { release, variant } => {
            from_package("file", release, variant, "Every part matched the checksum in its manifest.")
        }
        Source::Files { typed } => {
            let files = lock(&fw.loose)?.clone();
            if files.is_empty() {
                return Ok(Err("choose a firmware zip or the images of your own build".into()));
            }
            let unit_table = unit.and_then(|u| u.table.as_deref());
            let mut loose: Vec<LooseFile> = place_files(files, unit_table, DEFAULT_TABLE_OFFSET);
            for (f, t) in loose.iter_mut().zip(typed) {
                f.typed = t.clone();
            }
            let lw = loose_writes(&loose, loose_table(&loose, unit_table));
            if !lw.bad_typing.is_empty() {
                return Ok(Err(format!(
                    "{}: type the offset as 0x…, as 128K or 1M, or as a partition's name.",
                    lw.bad_typing.join(", ")
                )));
            }
            if !lw.unplaced.is_empty() {
                return Ok(Err(format!(
                    "{}: Burrow cannot tell where {}{}. Type an offset.",
                    lw.unplaced.join(", "),
                    if lw.unplaced.len() > 1 { "these go" } else { "this goes" },
                    if unit.is_some() { "" } else { " until a board is read and its partition table with it" }
                )));
            }
            let (writes, added) = with_otadata_reset(lw.writes, unit_table, DEFAULT_TABLE_OFFSET);
            let notes = if added {
                vec!["A blank otadata is added so the board boots the app you just wrote, not whatever it last updated to over the air.".into()]
            } else {
                vec![]
            };
            let chip = chip_of(&writes).map(|c| c.name.to_string());
            Ok(Ok(Resolved { writes, notes, want: WantView { chip, table_offset: DEFAULT_TABLE_OFFSET, ..Default::default() } }))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub name: String,
    pub offset: u32,
    pub hex: String,
    pub size: u64,
    pub what: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoosePlace {
    pub name: String,
    /// Where it goes by its kind, as 0x…, or None when nothing says.
    pub placed: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    /// Why there is no plan: a part that failed its checksum, a file with no
    /// offset. Nothing else is filled in when this is.
    pub error: Option<String>,
    pub rows: Vec<PlanRow>,
    /// Reasons it must not be written to the unit last read. Empty with no unit.
    pub problems: Vec<String>,
    pub notes: Vec<String>,
    /// The words for the "replace it" tick, when the unit runs something else.
    pub replace: Option<String>,
    pub want: WantView,
    /// For files of your own: where each would go.
    pub places: Vec<LoosePlace>,
    pub unit_read: bool,
}

fn view(fw: &FirmwareState, source: &Source) -> Result<PlanView, String> {
    let unit = lock(&fw.unit)?.clone();
    let places = match source {
        Source::Files { .. } => {
            let files = lock(&fw.loose)?.clone();
            place_files(files, unit.as_ref().and_then(|u| u.table.as_deref()), DEFAULT_TABLE_OFFSET)
                .into_iter()
                .map(|f| LoosePlace { name: f.name, placed: f.placed.map(hex) })
                .collect()
        }
        _ => vec![],
    };
    let mut v = PlanView {
        error: None,
        rows: vec![],
        problems: vec![],
        notes: vec![],
        replace: None,
        want: WantView::default(),
        places,
        unit_read: unit.is_some(),
    };
    let r = match resolve(fw, source, unit.as_ref())? {
        Ok(r) => r,
        Err(e) => {
            v.error = Some(e);
            return Ok(v);
        }
    };
    let parts = components(&r.writes, r.want.table_offset);
    let table = effective_table(&parts, unit.as_ref().and_then(|u| u.table.as_deref()));
    let mut rows: Vec<PlanRow> = parts
        .iter()
        .map(|c| {
            let home = table.and_then(|t| partition_at(t, c.offset));
            let what = match (&c.info, c.raw, home) {
                (ImageInfo::Unknown { .. }, true, _) => "raw data, at the offset you typed".to_string(),
                (ImageInfo::Unknown { .. }, false, Some(p)) => format!("data for the {} partition", p.label),
                (ImageInfo::Unknown { .. }, false, None) => "data".to_string(),
                (info, _, _) => describe_image(info),
            };
            PlanRow { name: c.name.clone(), offset: c.offset, hex: hex(c.offset), size: c.data.len() as u64, what }
        })
        .collect();
    rows.sort_by_key(|r| r.offset);
    v.rows = rows;

    if let Some(u) = &unit {
        let w = &r.want;
        v.problems = unit_problems(
            &u.facts,
            &Want { chip: w.chip.as_deref(), min_flash: w.min_flash, name: w.device.as_deref() },
        );
        if let Some(chip) = u.facts.chip() {
            let ctx = PlanContext {
                chip,
                flash_bytes: u.facts.flash_bytes.unwrap_or(0),
                projects: w.projects.as_deref(),
                unit_table: u.table.as_deref(),
                table_offset: w.table_offset,
            };
            v.problems.extend(check_plan(&r.writes, &ctx));
            if v.problems.is_empty() {
                v.notes.extend(r.notes.clone());
                v.notes.extend(plan_notes(&r.writes, &ctx));
            }
        }
        v.replace = replace_text(u.running.as_ref().and_then(|x| x.app.as_ref()), &r.writes, w.projects.as_deref());
    } else {
        v.notes = r.notes.clone();
        v.notes.push("Read a board, and this is checked against it before Write is offered.".into());
    }
    v.want = r.want;
    Ok(v)
}

/// What would be written, and what the gate says about it against the unit
/// last read. Opens nothing.
#[tauri::command]
pub async fn esp_plan(fw: State<'_, FirmwareState>, source: Source) -> Result<PlanView, String> {
    view(&fw, &source)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EspWrite {
    pub port: String,
    pub source: Source,
    #[serde(default)]
    pub erase_all: bool,
    #[serde(default)]
    pub confirm_replace: bool,
}

#[tauri::command]
pub async fn esp_write(app: AppHandle, fw: State<'_, FirmwareState>, req: EspWrite) -> Result<(), String> {
    let _busy = Busy::take(&fw.busy)?;
    let emit = Emit::new(&app, "esp-write");
    let unit = lock(&fw.unit)?.clone();
    let resolved = match resolve(&fw, &req.source, unit.as_ref())? {
        Ok(r) => r,
        Err(e) => {
            emit.phase("failed", Some(e.clone()));
            return Err(e);
        }
    };
    let w = resolved.want.clone();
    let opts = WriteOptions {
        erase_all: req.erase_all,
        projects: w.projects.clone(),
        expect_chip: w.chip.clone(),
        min_flash: w.min_flash,
        name: w.device.clone(),
        table_offset: w.table_offset,
        confirm_replace: req.confirm_replace,
    };
    let writes = resolved.writes;
    let e = emit.clone();
    let port = req.port.clone();
    let result = off_main(move || {
        e.phase("connecting", None);
        let p = port_by_name(&port)?;
        let mut unit = Unit::open(&p, w.baud)?;
        let r = unit.write(&writes, &opts, &mut |s| match s {
            Stage::Erasing => e.phase("erasing", None),
            Stage::Writing { done, total } => e.bytes("writing", done, Some(total)),
            Stage::Verifying { done, total } => e.bytes("verifying", done, Some(total)),
        });
        // Restart whether or not the write finished: a unit left in the ROM
        // after a failure looks dead, and one that reboots into a half-written
        // app at least says so on its console. Either way download mode
        // recovers it.
        e.phase("restarting", None);
        let restarted = unit.restart();
        r?;
        restarted
    })
    .await;
    // What was read before is not what is on it now.
    *lock(&fw.unit)? = None;
    match &result {
        Ok(()) => emit.phase("done", resolved.want.after.clone()),
        Err(err) => emit.phase("failed", Some(err.clone())),
    }
    result
}

/// Register the managed state. Called from `run`'s setup.
pub fn manage(app: &AppHandle) {
    app.manage(FirmwareState::default());
}

// --- file picker ------------------------------------------------------------------

/// A zip, or the images of your own build. Opened from Rust so the webview is
/// granted no file-system capability at all. No filter: a data image can be
/// called anything, and what a file is gets decided by its bytes.
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Result<Option<Vec<PathBuf>>, String> {
    use tauri_plugin_dialog::DialogExt;
    off_main(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("A firmware zip, or the images of your own build")
            .blocking_pick_files()
            .map(|v| v.into_iter().filter_map(|f| f.into_path().ok()).collect()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tagged_release_gets_a_link_per_file_and_an_untagged_one_none() {
        let pkg: Package = serde_json::from_str(include_str!(
            "../../crates/burrow-device/tests/fixtures/cuckoo/manifest.json"
        ))
        .unwrap();
        let links = release_links(&pkg.device, &pkg);
        let names: Vec<&str> = links.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "cuckoo-firmware-main-4300e74.zip",
                "cuckoo-firmware-main-4300e74-bringup.bin",
                "cuckoo-firmware-main-4300e74-bridge.bin"
            ]
        );
        assert!(links[0].url.starts_with("https://github.com/stoatworks-labs/cuckoo-firmware/releases/download/v0.1.0/"));
        let mut untagged = pkg.clone();
        untagged.releases[0].tag = None;
        assert!(release_links(&untagged.device, &untagged).is_empty());
    }

    #[test]
    fn a_plan_with_nothing_opened_says_so_and_opens_nothing() {
        let fw = FirmwareState::default();
        let v = view(&fw, &Source::Files { typed: vec![] }).unwrap();
        assert_eq!(v.error.as_deref(), Some("choose a firmware zip or the images of your own build"));
        let v = view(&fw, &Source::Catalog { slug: "canary".into(), release: "x".into(), variant: "y".into() }).unwrap();
        assert_eq!(v.error.as_deref(), Some("the firmware is not loaded; choose it again"));
    }

    #[test]
    fn own_files_wait_for_a_unit_or_an_offset_and_then_plan() {
        let fw = FirmwareState::default();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/burrow-device/tests/fixtures/cuckoo");
        let mut app = std::fs::read(dir.join("app-head.bin")).unwrap();
        app.resize(852_768, 0xff);
        *fw.loose.lock().unwrap() = vec![("cuckoo_ui.bin".into(), app), ("rp_fw.img".into(), std::fs::read(dir.join("rp_fw.img")).unwrap())];
        let v = view(&fw, &Source::Files { typed: vec![] }).unwrap();
        assert_eq!(
            v.error.as_deref(),
            Some("cuckoo_ui.bin, rp_fw.img: Burrow cannot tell where these go until a board is read and its partition table with it. Type an offset.")
        );
        let v = view(&fw, &Source::Files { typed: vec!["0x10000".into(), "20000".into()] }).unwrap();
        assert_eq!(v.error.as_deref(), Some("rp_fw.img: type the offset as 0x…, as 128K or 1M, or as a partition's name."));
        // Cuckoo's table on the unit: the app is placed, rp_fw is typed by name.
        let table = burrow_device::esp::image::parse_partition_table(&std::fs::read(dir.join("partition-table.bin")).unwrap()).unwrap();
        *fw.unit.lock().unwrap() = Some(Description {
            port: "/dev/cu.test".into(),
            facts: burrow_device::esp::plan::UnitFacts {
                chip_name: "ESP32-C3".into(),
                flash_bytes: Some(4 << 20),
                flash_label: "4MB".into(),
                secure_boot: false,
                flash_encryption: false,
            },
            mac: None,
            table_offset: DEFAULT_TABLE_OFFSET,
            table: Some(table),
            running: None,
            problems: vec![],
        });
        let v = view(&fw, &Source::Files { typed: vec![String::new(), "rp_fw".into()] }).unwrap();
        assert_eq!(v.error, None);
        assert_eq!(v.problems, Vec::<String>::new());
        assert_eq!(v.places[0].placed.as_deref(), Some("0x10000"));
        let rows: Vec<(&str, &str)> = v.rows.iter().map(|r| (r.hex.as_str(), r.what.as_str())).collect();
        assert_eq!(rows, [("0x10000", "cuckoo_ui 0.1.0 4300e74 · ESP32-C3"), ("0x260000", "raw data, at the offset you typed")]);
        assert_eq!(v.want.chip.as_deref(), Some("ESP32-C3"));
        // The same files to an S3 are refused by the unit check and the gate.
        fw.unit.lock().unwrap().as_mut().unwrap().facts.chip_name = "ESP32-S3".into();
        let v = view(&fw, &Source::Files { typed: vec![String::new(), "rp_fw".into()] }).unwrap();
        assert!(v.problems.join(";").contains("this is an ESP32-S3, and the firmware is for an ESP32-C3"), "{:?}", v.problems);
    }
}
