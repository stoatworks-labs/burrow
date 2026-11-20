//! The Device firmware tab's commands: any ESP32 board over its serial port,
//! from the catalogue's firmware packages or from files of your own; a BirdDog
//! PLAY over Rockchip USB, and the PLAY's update packages.
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
//! an ESP32's port reboots it, and probing a PLAY claims it; neither is
//! something to do to a unit nobody pointed Burrow at.
//!
//! One device job at a time, and a write cannot be cancelled: stopping half way
//! through a partition is worse than finishing it.

use burrow_core::archive;
use burrow_core::catalog::{Asset, Catalog, Entry};
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
use burrow_device::play::{
    self,
    gpt,
    kit::{self, Kit, KitOffers},
    plan::{self as play_plan, Assignment, BlockDevice},
    rkfw,
    source::{FileSource, MemSource, Source},
    usb::{self, Found, Loader, Mode},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
    /// The last PLAY package built, held until it is saved or sent. One at a
    /// time: building another replaces it.
    built: Mutex<Option<BuiltPackage>>,
}

#[derive(Clone)]
struct Opened {
    root: PathBuf,
    pkg: Package,
}

struct BuiltPackage {
    id: String,
    name: String,
    fw: Vec<u8>,
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

/// Catalogue devices that are not ESP32 boards. The live catalogue carries the
/// BirdDog PLAY's patcher kit as firmware; it is read by `play_kit` below, not
/// opened as an ESP32 package. Refused by the ESP32 path before anything is
/// downloaded, rather than after fetching 15 MB that is not a firmware
/// package. The tab lists the same ids, and sends them to the PLAY's steps.
const NOT_ESP32: &[&str] = &["birddog-play"];

fn firmware_entry(state: &AppState, slug: &str) -> Result<Entry, String> {
    let catalog = lock(&state.catalog)?;
    firmware_in(catalog.as_ref().ok_or("the catalogue has not loaded yet")?, slug)
}

/// The catalogue's firmware entry for `slug`, refused if it is not for an ESP32.
fn firmware_in(catalog: &Catalog, slug: &str) -> Result<Entry, String> {
    let entry = catalog
        .entries
        .iter()
        .find(|e| e.kind == "firmware" && e.slug == slug && e.device.is_some())
        .cloned()
        .ok_or_else(|| format!("the catalogue carries no firmware called {slug}"))?;
    if entry.device.as_deref().is_some_and(|d| NOT_ESP32.contains(&d)) {
        return Err(format!("{} is not for an ESP32 board; it has its own steps in this tab", entry.name));
    }
    Ok(entry)
}

fn device_entry(state: &AppState, device: &str) -> Result<Entry, String> {
    let catalog = lock(&state.catalog)?;
    device_in(catalog.as_ref().ok_or("the catalogue has not loaded yet")?, device)
}

/// The catalogue's firmware entry for a device that is not an ESP32 board,
/// found by its device id: the PLAY's patcher kit.
fn device_in(catalog: &Catalog, device: &str) -> Result<Entry, String> {
    catalog
        .entries
        .iter()
        .find(|e| e.kind == "firmware" && e.device.as_deref() == Some(device))
        .cloned()
        .ok_or_else(|| format!("the catalogue carries no firmware for {device} yet"))
}

/// Fetch an entry's firmware asset into the cache, check it against the
/// catalogue's SHA-256, and unpack it. A cached copy whose bytes still match is
/// used as it is, so a release is downloaded once.
///
/// The digest is required. A plugin install can be inspected in staging before
/// it goes anywhere; firmware goes straight to a device, so the only check
/// between the network and the flash is this one.
async fn fetch_unpacked(state: &AppState, entry: &Entry, emit: &Emit) -> Result<(PathBuf, String, String), String> {
    let (asset, want) = firmware_asset(entry)?;
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

/// An entry's firmware download and the SHA-256 it must have. No digest, no
/// firmware: this is the only check between the network and the flash.
fn firmware_asset(entry: &Entry) -> Result<(Asset, String), String> {
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
    Ok((asset, want))
}

/// Read an unpacked catalogue release, and refuse it if it is for another
/// device than the catalogue says.
fn open_release(entry: &Entry, root: &Path, known: &[DeviceDef]) -> Result<Package, String> {
    let pkg = open_package_dir(root, known)?;
    if entry.device.as_deref() != Some(pkg.device.id.as_str()) {
        return Err(format!(
            "the catalogue says {} is for {}, and its package is for {}",
            entry.name,
            entry.device.as_deref().unwrap_or("nothing"),
            pkg.device.id
        ));
    }
    Ok(pkg)
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
    let (r, e) = (root.clone(), entry.clone());
    let pkg = off_main(move || open_release(&e, &r, &known)).await.inspect_err(|e| emit.phase("failed", Some(e.clone())))?;
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
pub enum EspSource {
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
fn resolve(fw: &FirmwareState, source: &EspSource, unit: Option<&Description>) -> Result<Result<Resolved, String>, String> {
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
        EspSource::Catalog { slug, release, variant } => from_package(
            &format!("catalog:{slug}"),
            release,
            variant,
            "Every part matched the SHA-256 in its package, and the package the one the catalogue gives.",
        ),
        EspSource::Package { release, variant } => {
            from_package("file", release, variant, "Every part matched the checksum in its manifest.")
        }
        EspSource::Files { typed } => {
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

fn view(fw: &FirmwareState, source: &EspSource) -> Result<PlanView, String> {
    let unit = lock(&fw.unit)?.clone();
    let places = match source {
        EspSource::Files { .. } => {
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
pub async fn esp_plan(fw: State<'_, FirmwareState>, source: EspSource) -> Result<PlanView, String> {
    view(&fw, &source)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EspWrite {
    pub port: String,
    pub source: EspSource,
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

// --- PLAY: finding a unit -----------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayUnit {
    #[serde(flatten)]
    pub found: Found,
    /// What answered, not what bcdUSB claimed: a loader-mode unit can carry
    /// the maskrom bit.
    pub mode: Mode,
    /// The unit's own partition table, when a loader is running to read it.
    pub partitions: Option<Vec<gpt::DevicePartition>>,
    pub sectors: Option<u64>,
}

/// Look for PLAYs in recovery mode. Probing claims a unit and reads one
/// sector, so it happens only here, when asked.
#[tauri::command]
pub async fn play_devices(fw: State<'_, FirmwareState>) -> Result<Vec<PlayUnit>, String> {
    let _busy = Busy::take(&fw.busy)?;
    off_main(|| {
        let mut out = Vec::new();
        for found in usb::list()? {
            let Some(info) = usb::find(&found.key)? else { continue };
            let loader = found.bcd_says == Mode::Loader || usb::probe_is_loader(&info);
            let (partitions, sectors) = if loader {
                match Loader::open(&info) {
                    Ok(mut l) => (
                        l.read_lba(0, 34).ok().and_then(|b| gpt::parse(&b).ok()),
                        l.read_flash_info().ok().map(|i| i.sectors),
                    ),
                    Err(_) => (None, None),
                }
            } else {
                (None, None)
            };
            out.push(PlayUnit { found, mode: if loader { Mode::Loader } else { Mode::Maskrom }, partitions, sectors });
        }
        Ok(out)
    })
    .await
}

// --- PLAY: the factory image -------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSummary {
    pub path: PathBuf,
    pub size: u64,
    pub chip: String,
    pub model: String,
    pub built: String,
    pub partitions: Vec<rkfw::Partition>,
    pub table: Vec<rkfw::ParamPartition>,
    /// How big a package could be injected, in bytes. None when the rootfs is
    /// not something the injector can work with.
    pub package_room: Option<u64>,
}

#[tauri::command]
pub async fn play_inspect_image(path: PathBuf) -> Result<ImageSummary, String> {
    off_main(move || {
        let src = FileSource::open(&path)?;
        let size = src.len();
        let fw = rkfw::parse(src)?;
        let param = play_plan::image_parameter(&fw)?;
        let package_room = (|| {
            let rootfs = fw.partition("rootfs")?;
            let sectors = param.partitions.iter().find(|p| p.name == "rootfs")?.sectors?;
            let fs = play::ext2::Ext2::open(fw.partition_source(rootfs), 0).ok()?;
            let fs_sectors = (fs.sb.blocks_count as u64 * fs.sb.block_size as u64).div_ceil(512);
            let at = fs_sectors.div_ceil(play::inject::PAYLOAD_ALIGN_SECTORS) * play::inject::PAYLOAD_ALIGN_SECTORS;
            Some(sectors.saturating_sub(at) * 512)
        })();
        Ok(ImageSummary {
            path,
            size,
            chip: fw.chip.clone(),
            model: fw.model.clone(),
            built: fw.built.clone(),
            partitions: fw.partitions.clone(),
            table: param.partitions,
            package_room,
        })
    })
    .await
}

// --- PLAY: packages ---------------------------------------------------------------------

async fn load_kit(state: &AppState, emit: &Emit) -> Result<Kit, String> {
    let entry = device_entry(state, "birddog-play")?;
    let (dir, _, _) = fetch_unpacked(state, &entry, emit).await?;
    Kit::load(&dir)
}

#[tauri::command]
pub async fn play_kit(app: AppHandle, state: State<'_, AppState>) -> Result<KitOffers, String> {
    let emit = Emit::new(&app, "play-kit");
    let kit = load_kit(&state, &emit).await?;
    emit.phase("done", None);
    Ok(kit.offers())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    #[serde(flatten)]
    pub options: kit::Options,
    #[serde(default)]
    pub modules: Vec<PathBuf>,
    /// A Tailscale or MediaMTX tarball the user chose instead of fetching.
    #[serde(default)]
    pub tailscale_file: Option<PathBuf>,
    #[serde(default)]
    pub mediamtx_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub tar_sha256: String,
    pub log: Vec<String>,
}

async fn fetch_to_memory(client: &reqwest::Client, url: &str, want_sha: &str, cache: &Path, emit: &Emit, label: &str) -> Result<Vec<u8>, String> {
    let dest = cache.join(format!("{label}-{}", &want_sha[..12]));
    if let Ok(b) = std::fs::read(&dest) {
        if burrow_device::play::fw::sha256_hex(&b) == want_sha {
            return Ok(b);
        }
    }
    emit.phase("downloading", Some(label.to_string()));
    let e2 = emit.clone();
    let got = net::download(client, url, &dest, &move |d, t| e2.bytes("downloading", d, t), &|| false).await?;
    let net::Download::Complete { sha256 } = got else {
        return Err("the download stopped".into());
    };
    if sha256 != want_sha {
        let _ = std::fs::remove_file(&dest);
        return Err(format!("{label} does not match its published SHA-256"));
    }
    std::fs::read(&dest).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn play_build(
    app: AppHandle,
    state: State<'_, AppState>,
    fw: State<'_, FirmwareState>,
    req: BuildRequest,
) -> Result<BuiltInfo, String> {
    let _busy = Busy::take(&fw.busy)?;
    let emit = Emit::new(&app, "play-build");
    let result = async {
        let kit = load_kit(&state, &emit).await?;
        let cache = state.cache_dir.join("firmware");
        let mut fetched = kit::Fetched::default();

        if req.options.tailscale {
            fetched.tailscale_tgz = Some(match &req.tailscale_file {
                Some(p) => std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?,
                None => {
                    let t = &kit.json.tailscale;
                    let client = net::tailscale_client()?;
                    let (version, file, sha) = net::tailscale_latest(&client, &t.index, &t.base, &t.arch).await?;
                    emit.phase("downloading", Some(format!("Tailscale {version}")));
                    fetch_to_memory(&client, &format!("{}{file}", t.base), &sha, &cache, &emit, "tailscale").await?
                }
            });
        }
        if req.options.gateway {
            fetched.mediamtx_tgz = Some(match &req.mediamtx_file {
                Some(p) => std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?,
                None => {
                    let m = &kit.json.mediamtx;
                    let client = net::client()?;
                    let sums = net::fetch_text(&client, &format!("{}{}/{}", m.base, m.version, m.checksums), 64 * 1024).await?;
                    let sha = sums
                        .lines()
                        .filter_map(|l| {
                            let mut it = l.split_whitespace();
                            Some((it.next()?, it.next()?.trim_start_matches('*')))
                        })
                        .find(|(_, f)| *f == m.file)
                        .map(|(h, _)| h.to_ascii_lowercase())
                        .ok_or_else(|| format!("MediaMTX {} publishes no SHA-256 for {}", m.version, m.file))?;
                    fetch_to_memory(&client, &format!("{}{}/{}", m.base, m.version, m.file), &sha, &cache, &emit, "mediamtx").await?
                }
            });
        }

        emit.phase("building", None);
        let (reserved, max) = (kit.reserved(), kit.module_max_bytes());
        let modules = req
            .modules
            .iter()
            .map(|p| {
                let label = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let bytes = std::fs::read(p).map_err(|e| format!("{label}: {e}"))?;
                burrow_device::play::fw::read_module(&bytes, &label, &reserved, max)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let options = req.options.clone();
        let built = off_main(move || kit::build(&kit, &options, fetched, &modules)).await?;
        let mut id_bytes = [0u8; 8];
        getrandom::getrandom(&mut id_bytes).map_err(|e| e.to_string())?;
        let id = hex::encode(id_bytes);
        let info = BuiltInfo {
            id: id.clone(),
            name: built.name.clone(),
            size: built.fw.len() as u64,
            sha256: built.sha256.clone(),
            tar_sha256: built.tar_sha256.clone(),
            log: built.log.clone(),
        };
        *fw.built.lock().map_err(|_| "state lock poisoned")? = Some(BuiltPackage { id, name: built.name, fw: built.fw });
        Ok::<_, String>(info)
    }
    .await;
    match &result {
        Ok(_) => emit.phase("done", None),
        Err(e) => emit.phase("failed", Some(e.clone())),
    }
    result
}

fn built(fw: &FirmwareState, id: &str) -> Result<(String, Vec<u8>), String> {
    let b = fw.built.lock().map_err(|_| "state lock poisoned")?;
    match b.as_ref() {
        Some(p) if p.id == id => Ok((p.name.clone(), p.fw.clone())),
        _ => Err("that package is no longer in hand — build it again".into()),
    }
}

#[tauri::command]
pub async fn play_save(fw: State<'_, FirmwareState>, id: String, path: PathBuf) -> Result<(), String> {
    let (_, bytes) = built(&fw, &id)?;
    off_main(move || std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))).await
}

#[tauri::command]
pub async fn play_send(
    app: AppHandle,
    fw: State<'_, FirmwareState>,
    id: String,
    address: String,
    password: String,
) -> Result<bool, String> {
    let _busy = Busy::take(&fw.busy)?;
    let emit = Emit::new(&app, "play-send");
    let (name, bytes) = built(&fw, &id)?;
    let base = net::birdui_base(&address)?;
    emit.phase("sending", Some(base.clone()));
    let sent = net::birdui_send(&base, &password, &name, bytes).await;
    drop(password);
    if let Err(e) = &sent {
        emit.phase("failed", Some(e.clone()));
    }
    sent?;
    emit.phase("waiting-for-unit", None);
    let back = net::birdui_wait(&base, Duration::from_secs(20), Duration::from_secs(600)).await;
    emit.phase("done", None);
    Ok(back)
}

// --- PLAY: writing a unit -----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayFlash {
    pub key: String,
    pub image: PathBuf,
    /// Inject the package last built here, or a .fw file the user chose.
    #[serde(default)]
    pub inject_built: Option<String>,
    #[serde(default)]
    pub inject_file: Option<PathBuf>,
    #[serde(default = "yes")]
    pub verify: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashOutcome {
    pub notes: Vec<String>,
    pub unverified: Vec<String>,
    pub injected: bool,
}

/// Find the unit again, in loader mode, pushing the image's own loader first
/// if it is in maskrom.
fn loader_for(key: &str, fw: &rkfw::Rkfw, emit: &Emit) -> Result<Loader, String> {
    let info = usb::find(key)?.ok_or("the unit is not there any more — was it unplugged?")?;
    let bcd_loader = usb::list()?.into_iter().any(|f| f.key == key && f.bcd_says == Mode::Loader);
    if bcd_loader || usb::probe_is_loader(&info) {
        return Loader::open(&info);
    }
    emit.phase("pushing-loader", None);
    let loader = fw.loader()?;
    usb::push_loader(&info, &loader, &mut |m| emit.phase("pushing-loader", Some(m.to_string())))?;
    emit.phase("waiting", Some("for the unit to come back with the loader running".into()));
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if let Some(d) = usb::wait_for_any(Duration::from_secs(2))? {
            if usb::probe_is_loader(&d) {
                return Loader::open(&d);
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("the unit did not come back with the loader running. Power it off, put it back in recovery mode and try again".into())
}

fn run_and_verify(dev: &mut Loader, plan: &play_plan::Plan, verify: bool, emit: &Emit) -> Result<Vec<String>, String> {
    let total = plan.total_sectors * 512;
    play_plan::run(dev, plan, &mut |p| emit.bytes("writing", p.done_sectors * 512, Some(total)))?;
    if !verify {
        return Ok(vec!["not read back: verification was turned off".into()]);
    }
    // The read ceiling, found with sectors this write itself filled: above it
    // the unit returns 0xCC whatever is there.
    let probes: Vec<u64> = {
        let mut v: Vec<u64> = plan.ops.iter().filter(|o| o.byte_len() > 0).map(|o| o.start_sector).collect();
        v.sort_unstable();
        v
    };
    let ceiling = play_plan::find_read_ceiling(dev, &probes);
    emit.phase("verifying", ceiling.map(|c| format!("this unit cannot be read back at or above sector 0x{c:x}")));
    let v = play_plan::verify(dev, plan, ceiling, &mut |p| emit.bytes("verifying", p.done_sectors * 512, Some(total)))?;
    if !v.mismatches.is_empty() {
        return Err(format!("{} did not read back as written", v.mismatches.join(", ")));
    }
    Ok(v.unverified)
}

#[tauri::command]
pub async fn play_flash(app: AppHandle, fw_state: State<'_, FirmwareState>, req: PlayFlash) -> Result<FlashOutcome, String> {
    let _busy = Busy::take(&fw_state.busy)?;
    let emit = Emit::new(&app, "play-flash");
    let package: Option<Arc<dyn Source>> = match (&req.inject_built, &req.inject_file) {
        (Some(id), _) => Some(Arc::new(MemSource(built(&fw_state, id)?.1))),
        (None, Some(p)) => Some(FileSource::open(p)? as Arc<dyn Source>),
        (None, None) => None,
    };
    let e = emit.clone();
    let result = off_main(move || {
        e.phase("connecting", None);
        let image = rkfw::parse(FileSource::open(&req.image)?)?;
        let mut dev = loader_for(&req.key, &image, &e)?;
        let sectors = dev.read_flash_info()?.sectors;
        let mut rng = |b: &mut [u8]| getrandom::getrandom(b).expect("the OS random source failed");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as u32)
            .unwrap_or(0);
        let plan = play_plan::build_full(&image, sectors, package, &mut rng, now)?;
        let unverified = run_and_verify(&mut dev, &plan, req.verify, &e)?;
        e.phase("restarting", None);
        dev.reset(usb::RESET_MSC)?;
        Ok(FlashOutcome { notes: plan.notes.clone(), unverified, injected: plan.injected })
    })
    .await;
    match &result {
        Ok(_) => emit.phase("done", None),
        Err(err) => emit.phase("failed", Some(err.clone())),
    }
    result
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionFile {
    pub partition: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayPartitions {
    pub key: String,
    pub files: Vec<PartitionFile>,
    #[serde(default)]
    pub allow_protected: bool,
    #[serde(default = "yes")]
    pub verify: bool,
}

/// Write named partitions to a unit with a loader running, aimed by the unit's
/// own GPT. Loader mode only: a maskrom unit has no table to aim with until a
/// factory image has been restored.
#[tauri::command]
pub async fn play_write_partitions(app: AppHandle, fw: State<'_, FirmwareState>, req: PlayPartitions) -> Result<FlashOutcome, String> {
    let _busy = Busy::take(&fw.busy)?;
    let emit = Emit::new(&app, "play-partitions");
    let e = emit.clone();
    let result = off_main(move || {
        e.phase("connecting", None);
        let info = usb::find(&req.key)?.ok_or("the unit is not there any more — was it unplugged?")?;
        let bcd_loader = usb::list()?.into_iter().any(|f| f.key == req.key && f.bcd_says == Mode::Loader);
        if !bcd_loader && !usb::probe_is_loader(&info) {
            return Err("this unit is in maskrom, with no loader to read its partition table. Restore a factory image first".into());
        }
        let mut dev = Loader::open(&info)?;
        let parts = gpt::parse(&dev.read_lba(0, 34)?)?;
        let mut assignments = Vec::new();
        for f in &req.files {
            assignments.push(Assignment {
                partition: f.partition.clone(),
                label: f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                source: FileSource::open(&f.path)? as Arc<dyn Source>,
            });
        }
        let plan = play_plan::build_partitions(&parts, assignments, req.allow_protected)?;
        let unverified = run_and_verify(&mut dev, &plan, req.verify, &e)?;
        e.phase("restarting", None);
        dev.reset(usb::RESET_MSC)?;
        Ok(FlashOutcome { notes: plan.notes.clone(), unverified, injected: false })
    })
    .await;
    match &result {
        Ok(_) => emit.phase("done", None),
        Err(err) => emit.phase("failed", Some(err.clone())),
    }
    result
}

/// Register the managed state. Called from `run`'s setup.
pub fn manage(app: &AppHandle) {
    app.manage(FirmwareState::default());
}

// --- file pickers ------------------------------------------------------------------

/// What a picker is for, which decides its filters. Opened from Rust so the
/// webview is granted no file-system capability at all.
#[tauri::command]
pub async fn pick_files(app: AppHandle, purpose: String) -> Result<Option<Vec<PathBuf>>, String> {
    use tauri_plugin_dialog::DialogExt;
    off_main(move || {
        let d = app.dialog().file();
        let (d, many) = match purpose.as_str() {
            "image" => (d.add_filter("Recovery image", &["img"]), false),
            "package" => (d.add_filter("PLAY package", &["fw"]), false),
            "module" => (d.add_filter("Module archive", &["tgz", "gz", "tar"]), true),
            "tailscale" | "mediamtx" => (d.add_filter("Tarball", &["tgz", "gz"]), false),
            // A zip, or the images of your own build, for an ESP32 board. No
            // filter: a data image can be called anything, and what a file is
            // gets decided by its bytes.
            "firmware" => (d.set_title("A firmware zip, or the images of your own build"), true),
            "partition" => (d, false),
            other => return Err(format!("no picker for {other}")),
        };
        let picked = if many {
            d.blocking_pick_files().map(|v| v.into_iter().filter_map(|f| f.into_path().ok()).collect())
        } else {
            d.blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| vec![p])
        };
        Ok(picked)
    })
    .await
}

#[tauri::command]
pub async fn pick_save(app: AppHandle, name: String) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    off_main(move || {
        Ok(app
            .dialog()
            .file()
            .set_file_name(&name)
            .add_filter("PLAY package", &["fw"])
            .blocking_save_file()
            .and_then(|f| f.into_path().ok()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live catalogue's firmware, opened the way the tab opens it: the
    /// entry found by slug, its asset and digest, the download checked against
    /// that digest, unpacked by burrow-core, read, matched to its device, every
    /// variant planned, and every direct-download link naming a file that the
    /// release really has. The PLAY's kit is refused by that path and found,
    /// with its digest, by the one `play_kit` takes. Ignored: it needs the
    /// catalogue and the downloads.
    ///
    ///     BURROW_LIVE_CATALOG=<catalog.json> BURROW_LIVE_DOWNLOADS=<dir of release assets> \
    ///       cargo test the_live_catalogue -- --ignored --nocapture
    #[test]
    #[ignore = "needs the live catalogue and its firmware downloads"]
    fn the_live_catalogue_s_firmware_opens_as_the_tab_opens_it() {
        let var = |v: &str| PathBuf::from(std::env::var(v).unwrap_or_else(|_| panic!("set {v}")));
        let (catalog, downloads) = (var("BURROW_LIVE_CATALOG"), var("BURROW_LIVE_DOWNLOADS"));
        let catalog = burrow_core::catalog::parse(&std::fs::read_to_string(catalog).unwrap()).unwrap();
        let mut opened = 0;
        for entry in catalog.entries.iter().filter(|e| e.kind == "firmware" && e.device.is_some()) {
            let found = firmware_in(&catalog, &entry.slug);
            if NOT_ESP32.contains(&entry.device.as_deref().unwrap()) {
                assert!(found.unwrap_err().contains("not for an ESP32 board"), "{}", entry.slug);
                let kit = device_in(&catalog, entry.device.as_deref().unwrap()).unwrap();
                firmware_asset(&kit).unwrap_or_else(|e| panic!("{}: {e}", entry.slug));
                continue;
            }
            let entry = found.unwrap();
            let (asset, want) = firmware_asset(&entry).unwrap();
            let name = asset.url.rsplit('/').next().unwrap();
            let zip = downloads.join(name);
            let bytes = std::fs::read(&zip).unwrap_or_else(|_| panic!("download {} into BURROW_LIVE_DOWNLOADS", asset.url));
            assert_eq!(package::sha256_hex(&bytes), want, "{name}");
            assert_eq!(asset.size, Some(bytes.len() as u64), "{name}");
            let tmp = tempfile::tempdir().unwrap();
            archive::unpack_all(&zip, tmp.path()).unwrap();
            let pkg = open_release(&entry, tmp.path(), &known_devices()).unwrap_or_else(|e| panic!("{}: {e}", entry.slug));
            for r in &pkg.releases {
                for v in &r.variants {
                    let writes = load_variant(tmp.path(), r, v, pkg.device.table_offset()).unwrap();
                    let ctx = PlanContext {
                        projects: Some(&pkg.device.projects),
                        table_offset: pkg.device.table_offset(),
                        ..PlanContext::new(pkg.device.chip().unwrap(), pkg.device.flash_size)
                    };
                    assert_eq!(check_plan(&writes, &ctx), Vec::<String>::new(), "{} {}/{}", entry.slug, r.id, v.id);
                }
            }
            let links = release_links(&pkg.device, &pkg);
            assert!(!links.is_empty(), "{}: a catalogue release should be tagged", entry.slug);
            assert_eq!(links[0].url, asset.url, "{}: the zip link is the catalogue's own download", entry.slug);
            for l in &links {
                assert!(downloads.join(&l.name).exists(), "{} links to {}, which is not in the release", entry.slug, l.url);
            }
            eprintln!("{} {}: {} links, device {}", entry.slug, entry.version.as_deref().unwrap_or("?"), links.len(), pkg.device.id);
            opened += 1;
        }
        assert!(opened > 0, "the catalogue carries no ESP32 firmware");
    }

    #[test]
    fn the_play_kit_goes_to_the_play_steps_and_every_other_device_to_the_esp32_ones() {
        // The live catalogue's shape: ESP32 firmware and the PLAY's patcher kit
        // side by side, all of kind "firmware". The ESP32 path must refuse the
        // kit before downloading it, and the PLAY's path must still find it.
        let fw = |slug: &str, device: &str| {
            format!(
                r#"{{"slug":"{slug}","name":"{slug}","repo":"{slug}","kind":"firmware","device":"{device}","builds":{{}}}}"#
            )
        };
        let body = format!(
            r#"{{"schema":1,"generated":"x","entries":[{},{},{}]}}"#,
            fw("canary-firmware", "canary"),
            fw("cuckoo-firmware", "cuckoo"),
            fw("play-patcher-kit", "birddog-play")
        );
        let catalog = burrow_core::catalog::parse(&body).unwrap();
        assert_eq!(firmware_in(&catalog, "canary-firmware").unwrap().device.as_deref(), Some("canary"));
        assert_eq!(firmware_in(&catalog, "cuckoo-firmware").unwrap().device.as_deref(), Some("cuckoo"));
        let refused = firmware_in(&catalog, "play-patcher-kit").unwrap_err();
        assert!(refused.contains("not for an ESP32 board"), "{refused}");
        assert_eq!(device_in(&catalog, "birddog-play").unwrap().slug, "play-patcher-kit");
        assert!(device_in(&catalog, "something-else").is_err());
    }

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
        let v = view(&fw, &EspSource::Files { typed: vec![] }).unwrap();
        assert_eq!(v.error.as_deref(), Some("choose a firmware zip or the images of your own build"));
        let v = view(&fw, &EspSource::Catalog { slug: "canary".into(), release: "x".into(), variant: "y".into() }).unwrap();
        assert_eq!(v.error.as_deref(), Some("the firmware is not loaded; choose it again"));
    }

    #[test]
    fn own_files_wait_for_a_unit_or_an_offset_and_then_plan() {
        let fw = FirmwareState::default();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/burrow-device/tests/fixtures/cuckoo");
        let mut app = std::fs::read(dir.join("app-head.bin")).unwrap();
        app.resize(852_768, 0xff);
        *fw.loose.lock().unwrap() = vec![("cuckoo_ui.bin".into(), app), ("rp_fw.img".into(), std::fs::read(dir.join("rp_fw.img")).unwrap())];
        let v = view(&fw, &EspSource::Files { typed: vec![] }).unwrap();
        assert_eq!(
            v.error.as_deref(),
            Some("cuckoo_ui.bin, rp_fw.img: Burrow cannot tell where these go until a board is read and its partition table with it. Type an offset.")
        );
        let v = view(&fw, &EspSource::Files { typed: vec!["0x10000".into(), "20000".into()] }).unwrap();
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
        let v = view(&fw, &EspSource::Files { typed: vec![String::new(), "rp_fw".into()] }).unwrap();
        assert_eq!(v.error, None);
        assert_eq!(v.problems, Vec::<String>::new());
        assert_eq!(v.places[0].placed.as_deref(), Some("0x10000"));
        let rows: Vec<(&str, &str)> = v.rows.iter().map(|r| (r.hex.as_str(), r.what.as_str())).collect();
        assert_eq!(rows, [("0x10000", "cuckoo_ui 0.1.0 4300e74 · ESP32-C3"), ("0x260000", "raw data, at the offset you typed")]);
        assert_eq!(v.want.chip.as_deref(), Some("ESP32-C3"));
        // The same files to an S3 are refused by the unit check and the gate.
        fw.unit.lock().unwrap().as_mut().unwrap().facts.chip_name = "ESP32-S3".into();
        let v = view(&fw, &EspSource::Files { typed: vec![String::new(), "rp_fw".into()] }).unwrap();
        assert!(v.problems.join(";").contains("this is an ESP32-S3, and the firmware is for an ESP32-C3"), "{:?}", v.problems);
    }
}
