//! The Device firmware tab's commands: a CANary over USB serial, a BirdDog PLAY
//! over Rockchip USB, and the PLAY's update packages.
//!
//! None of this goes near the folder-install machinery in `jobs.rs` — no slot,
//! no staging rename, no ledger, no privileged helper. A device write has
//! nothing to stage and nothing to roll back to, so its safety is the gate in
//! `burrow-device`, run against a fresh read of the unit immediately before the
//! first byte, and a confirmation in the window that says exactly what will be
//! written where.
//!
//! Devices are looked for when the user asks, never in the background. Opening
//! a CANary's port reboots it, and probing a PLAY claims it; neither is
//! something to do to a unit nobody pointed Burrow at.
//!
//! One device job at a time, and a write cannot be cancelled: stopping half way
//! through a partition is worse than finishing it.

use burrow_core::archive;
use burrow_core::catalog::Entry;
use burrow_core::model::Format;
use burrow_device::esp::{
    plan::{with_otadata_reset, PlannedWrite},
    release::{self, Manifest, Variant},
    session::{self, Description, PortInfo, Stage, Unit},
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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::jobs::Gate;
use crate::net;
use crate::off_main;
use crate::state::AppState;

#[derive(Default)]
pub struct FirmwareState {
    busy: Mutex<bool>,
    /// The last package built, held until it is saved or sent. One at a time:
    /// building another replaces it.
    built: Mutex<Option<BuiltPackage>>,
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
        let _ = self.app.emit(
            "firmware-progress",
            FwProgress { job: self.job.clone(), phase, done, total, message },
        );
    }
}

// --- the catalogue's firmware -----------------------------------------------------

fn firmware_entry(state: &AppState, device: &str) -> Result<Entry, String> {
    let catalog = state.catalog.lock().map_err(|_| "state lock poisoned")?;
    let catalog = catalog.as_ref().ok_or("the catalogue has not loaded yet")?;
    catalog
        .entries
        .iter()
        .find(|e| e.kind == "firmware" && e.device.as_deref() == Some(device))
        .cloned()
        .ok_or_else(|| format!("the catalogue carries no firmware for {device} yet"))
}

/// Fetch an entry's firmware asset into the cache, check it against the
/// catalogue's SHA-256, and unpack it. A cached copy whose bytes still match is
/// used as it is.
///
/// The digest is required. A plugin install can be inspected in staging before
/// it goes anywhere; firmware goes straight to a device, so the only check
/// between the network and the flash is this one.
async fn fetch_unpacked(state: &AppState, entry: &Entry, emit: &Emit) -> Result<PathBuf, String> {
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
    let dir = state.cache_dir.join("firmware");
    let zip = dir.join(format!("{}-{}.zip", entry.slug, &want[..12]));
    let unpacked = dir.join(format!("{}-{}", entry.slug, &want[..12]));

    let cached_ok = std::fs::read(&zip).map(|b| burrow_device::play::fw::sha256_hex(&b) == want).unwrap_or(false);
    if !cached_ok {
        emit.phase("downloading", Some(entry.name.clone()));
        let client = net::client()?;
        let e2 = emit.clone();
        let got = net::download(
            &client,
            &asset.url,
            &zip,
            &move |done, total| e2.bytes("downloading", done, total),
            &|| false,
        )
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
    Ok(unpacked)
}

// --- CANary ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanaryRelease {
    pub version: Option<String>,
    pub id: String,
    pub date: String,
    pub commit: String,
    pub variants: Vec<Variant>,
}

fn canary_manifest(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| format!("the release has no manifest: {e}"))?;
    let m: Manifest = serde_json::from_str(&text).map_err(|e| format!("the release manifest: {e}"))?;
    let problems = release::validate(&m);
    if !problems.is_empty() {
        return Err(format!("the release manifest is not valid: {}", problems.join("; ")));
    }
    if m.releases.is_empty() {
        return Err("the release manifest lists no release".into());
    }
    Ok(m)
}

/// The current CANary release from the catalogue: fetched, checked, unpacked.
#[tauri::command]
pub async fn canary_release(app: AppHandle, state: State<'_, AppState>) -> Result<CanaryRelease, String> {
    let entry = firmware_entry(&state, "canary")?;
    let emit = Emit::new(&app, "canary-release");
    let dir = fetch_unpacked(&state, &entry, &emit).await?;
    let m = canary_manifest(&dir)?;
    let r = m.releases[0].clone();
    emit.phase("done", None);
    Ok(CanaryRelease { version: entry.version.clone(), id: r.id, date: r.date, commit: r.commit, variants: r.variants })
}

#[tauri::command]
pub async fn canary_ports(all: bool) -> Result<Vec<PortInfo>, String> {
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
pub async fn canary_describe(fw: State<'_, FirmwareState>, port: String) -> Result<Description, String> {
    let _busy = Busy::take(&fw.busy)?;
    off_main(move || {
        let p = port_by_name(&port)?;
        let mut unit = Unit::open(&p)?;
        let d = unit.describe();
        let _ = unit.restart();
        d
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanaryWrite {
    pub port: String,
    /// A variant of the catalogue's release, or None with `own_files`.
    pub variant: Option<String>,
    #[serde(default)]
    pub own_files: Vec<PathBuf>,
    #[serde(default)]
    pub erase_all: bool,
    #[serde(default)]
    pub allow_foreign: bool,
}

#[tauri::command]
pub async fn canary_write(
    app: AppHandle,
    state: State<'_, AppState>,
    fw: State<'_, FirmwareState>,
    req: CanaryWrite,
) -> Result<(), String> {
    let _busy = Busy::take(&fw.busy)?;
    let emit = Emit::new(&app, "canary-write");
    let writes: Vec<PlannedWrite> = match &req.variant {
        Some(vid) => {
            let entry = firmware_entry(&state, "canary")?;
            let dir = fetch_unpacked(&state, &entry, &emit).await?;
            let m = canary_manifest(&dir)?;
            let r = &m.releases[0];
            let v = r.variants.iter().find(|v| &v.id == vid).ok_or_else(|| format!("the release has no variant {vid}"))?;
            release::load_variant(&dir, r, v)?
        }
        None => {
            if req.own_files.is_empty() {
                return Err("choose a firmware variant or your own files".into());
            }
            let mut files = Vec::new();
            for p in &req.own_files {
                let data = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
                files.push((p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), data));
            }
            with_otadata_reset(release::plan_own_build(files)?).0
        }
    };
    let e = emit.clone();
    let result = off_main(move || {
        e.phase("connecting", None);
        let p = port_by_name(&req.port)?;
        let mut unit = Unit::open(&p)?;
        let r = unit.write(&writes, req.erase_all, req.allow_foreign, &mut |s| match s {
            Stage::Erasing => e.phase("erasing", None),
            Stage::Writing { done, total } => e.bytes("writing", done, Some(total)),
            Stage::Verifying { done, total } => e.bytes("verifying", done, Some(total)),
        });
        // Restart whether or not the write finished: a unit left in the ROM
        // after a failure looks dead, and one that reboots into a half-written
        // app at least says so on its console. Either way BOOT + EN recovers it.
        e.phase("restarting", None);
        let restarted = unit.restart();
        r?;
        restarted
    })
    .await;
    match &result {
        Ok(()) => emit.phase("done", None),
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
    let entry = firmware_entry(state, "birddog-play")?;
    let dir = fetch_unpacked(state, &entry, emit).await?;
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
            "canary-build" => (d.add_filter("ESP-IDF build output", &["bin"]), true),
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
