//! The patcher kit, and a package built from it.
//!
//! The kit is the web patcher's own `public/assets/` folder, published as a
//! release asset with a `kit.json` beside it: the installer, the module
//! binaries, and the asset manifest the page itself reads. `build` packs a .fw
//! from it in the order and with the modes the page's `app.js` uses, member for
//! member, so a package from Burrow and one from the page differ only where the
//! inputs do.
//!
//! Tailscale and MediaMTX are not in the kit. The shell fetches them (Tailscale
//! from pkgs.tailscale.com against its .sha256 sidecar, MediaMTX from its
//! pinned GitHub release against checksums.sha256) or the user supplies them,
//! and they arrive here as tarballs.

use super::fw::{self, Flags, Module, Tar};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMtxPin {
    pub version: String,
    pub file: String,
    pub base: String,
    pub checksums: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleSource {
    pub index: String,
    pub base: String,
    pub arch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitJson {
    pub kit: u32,
    pub version: String,
    pub commit: String,
    pub mediamtx: MediaMtxPin,
    pub tailscale: TailscaleSource,
    #[serde(default)]
    pub reserved_module_names: Vec<String>,
    #[serde(default)]
    pub module_max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AssetMeta {
    pub size: u64,
    pub sha256: String,
}

/// `assets/manifest.json` exactly as the patcher's build-assets.sh writes it.
/// An optional binary that was not built is `null`, and its option is off.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetManifest {
    #[serde(default)]
    pub generated: String,
    pub update: AssetMeta,
    pub probe: AssetMeta,
    #[serde(default)]
    pub kvm_run: Option<AssetMeta>,
    #[serde(default)]
    pub bdkvm: Option<AssetMeta>,
    #[serde(default)]
    pub bdcam: Option<AssetMeta>,
    #[serde(default)]
    pub cam_run: Option<AssetMeta>,
    #[serde(default)]
    pub cam_api_run: Option<AssetMeta>,
    #[serde(default)]
    pub bdts: Option<AssetMeta>,
    #[serde(default)]
    pub bdgw: Option<AssetMeta>,
    #[serde(default)]
    pub gw_run: Option<AssetMeta>,
    #[serde(default)]
    pub gw_api_run: Option<AssetMeta>,
    #[serde(default)]
    pub bdplay: Option<AssetMeta>,
    #[serde(default)]
    pub bdpdf: Option<AssetMeta>,
    #[serde(default)]
    pub pdfium: Option<AssetMeta>,
    #[serde(default)]
    pub exfat: Option<AssetMeta>,
    #[serde(default)]
    pub rootfs_overlay: Vec<String>,
}

pub const KIT_SCHEMA: u32 = 1;

pub struct Kit {
    pub root: PathBuf,
    pub json: KitJson,
    pub assets: AssetManifest,
}

/// What the kit can build, for the options shown before anything is fetched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitOffers {
    pub version: String,
    pub tailscale: bool,
    pub tailscale_ui: bool,
    pub kvm: bool,
    pub play: bool,
    pub play_pdf: bool,
    pub play_exfat: bool,
    pub cam: bool,
    pub gateway: bool,
    pub mediamtx_version: String,
}

impl Kit {
    pub fn load(root: &Path) -> Result<Kit, String> {
        let read = |p: &str| std::fs::read_to_string(root.join(p)).map_err(|e| format!("the kit has no {p}: {e}"));
        let json: KitJson = serde_json::from_str(&read("kit.json")?).map_err(|e| format!("kit.json: {e}"))?;
        if json.kit > KIT_SCHEMA {
            return Err(format!(
                "this kit (format {}) is newer than this Burrow understands (format {KIT_SCHEMA}) — update Burrow",
                json.kit
            ));
        }
        let assets: AssetManifest =
            serde_json::from_str(&read("assets/manifest.json")?).map_err(|e| format!("assets/manifest.json: {e}"))?;
        Ok(Kit { root: root.to_path_buf(), json, assets })
    }

    pub fn offers(&self) -> KitOffers {
        let a = &self.assets;
        KitOffers {
            version: self.json.version.clone(),
            tailscale: true,
            tailscale_ui: a.bdts.is_some(),
            kvm: a.bdkvm.is_some(),
            play: a.bdplay.is_some(),
            play_pdf: a.bdpdf.is_some() && a.pdfium.is_some(),
            play_exfat: a.exfat.is_some(),
            cam: a.bdcam.is_some(),
            gateway: a.bdgw.is_some(),
            mediamtx_version: self.json.mediamtx.version.clone(),
        }
    }

    pub fn reserved(&self) -> Vec<String> {
        if self.json.reserved_module_names.is_empty() {
            fw::RESERVED_MODULE_NAMES.iter().map(|s| s.to_string()).collect()
        } else {
            self.json.reserved_module_names.clone()
        }
    }

    pub fn module_max_bytes(&self) -> u64 {
        self.json.module_max_bytes.unwrap_or(fw::MODULE_MAX_BYTES)
    }

    /// One asset, checked against the manifest's size and digest before it is
    /// packed — the page does the same, and a kit is a download.
    fn asset(&self, file: &str, meta: Option<&AssetMeta>) -> Result<Vec<u8>, String> {
        if file.contains("..") || file.starts_with('/') {
            return Err(format!("{file}: not a plain relative path"));
        }
        let data = std::fs::read(self.root.join("assets").join(file)).map_err(|e| format!("kit asset {file}: {e}"))?;
        if let Some(m) = meta {
            if data.len() as u64 != m.size {
                return Err(format!("kit asset {file}: size does not match its manifest"));
            }
            if fw::sha256_hex(&data) != m.sha256 {
                return Err(format!("kit asset {file}: SHA-256 does not match its manifest"));
            }
        }
        Ok(data)
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub ssh_key: String,
    pub tag: String,
    pub tailscale: bool,
    pub kvm: bool,
    pub play: bool,
    pub cam: bool,
    pub cam_ui: bool,
    pub gateway: bool,
    pub gateway_ui: bool,
    pub reboot: bool,
}

/// What the shell fetched or the user chose, already checked against its
/// published digest.
#[derive(Default)]
pub struct Fetched {
    pub tailscale_tgz: Option<Vec<u8>>,
    pub mediamtx_tgz: Option<Vec<u8>>,
}

pub struct Built {
    pub name: String,
    pub fw: Vec<u8>,
    pub sha256: String,
    /// The uncompressed tar's digest: the one to compare with the page's, whose
    /// gzip layer differs by browser.
    pub tar_sha256: String,
    pub log: Vec<String>,
}

/// Pack a .fw, member for member as the web patcher's `app.js` does.
pub fn build(kit: &Kit, o: &Options, fetched: Fetched, modules: &[Module]) -> Result<Built, String> {
    if let Some(err) = fw::validate_key(&o.ssh_key) {
        return Err(err.to_string());
    }
    let a = &kit.assets;
    let mut log = Vec::new();
    let flags = Flags {
        tag: fw::clean_tag(&o.tag, "burrow"),
        tailscale: o.tailscale,
        // The birdUI panel is not a choice of its own: it ships whenever
        // Tailscale does, because a Tailscale install that still needs SSH to
        // finish is the problem it solves.
        tailscale_ui: o.tailscale && a.bdts.is_some(),
        kvm: o.kvm && a.bdkvm.is_some(),
        play: o.play && a.bdplay.is_some(),
        cam: o.cam && a.bdcam.is_some(),
        cam_ui: o.cam && a.bdcam.is_some() && o.cam_ui,
        gateway: o.gateway && a.bdgw.is_some(),
        gateway_ui: o.gateway && a.bdgw.is_some() && o.gateway_ui,
        modules: !modules.is_empty(),
        reboot: o.reboot,
    };
    for (asked, have, what) in [
        (o.kvm, flags.kvm, "NDI KVM"),
        (o.play, flags.play, "USB media player"),
        (o.cam, flags.cam, "UVC converter"),
        (o.gateway, flags.gateway, "streaming gateway"),
    ] {
        if asked && !have {
            return Err(format!("this kit has no {what}"));
        }
    }

    let mut tar = Tar::new();
    tar.file("./update", &kit.asset("update", Some(&a.update))?, 0o755)?;
    tar.file("./probe.sh", &kit.asset("probe.sh", Some(&a.probe))?, 0o755)?;
    tar.file("./authorized_keys", format!("{}\n", o.ssh_key.trim()).as_bytes(), 0o600)?;
    tar.file("./build.conf", fw::build_conf(&flags).as_bytes(), 0o644)?;
    for rel in &a.rootfs_overlay {
        tar.file(&format!("./files/{rel}"), &kit.asset(&format!("files/{rel}"), None)?, 0o644)?;
        log.push(format!("rootfs overlay: /{rel}"));
    }

    if flags.tailscale {
        let tgz = fetched.tailscale_tgz.as_deref().ok_or("Tailscale was asked for and not fetched")?;
        let (daemon, cli) = fw::extract_tailscale(tgz)?;
        tar.file("./userdata/tailscale/tailscaled", &daemon, 0o755)?;
        tar.file("./userdata/tailscale/tailscale", &cli, 0o755)?;
        log.push(format!("tailscale: {} + {}", fw::human_size(daemon.len() as u64), fw::human_size(cli.len() as u64)));
        if flags.tailscale_ui {
            tar.file("./userdata/bd-tailscale-ui/bdts", &kit.asset("bdts-linux-arm64", a.bdts.as_ref())?, 0o755)?;
            log.push("birdUI Tailscale panel: yes, so signing in needs no SSH".into());
        } else {
            log.push("birdUI Tailscale panel: not in this kit, so signing in will need SSH".into());
        }
    }

    if flags.kvm {
        tar.file("./userdata/birddog-kvm/bdkvm", &kit.asset("bdkvm-linux-arm64", a.bdkvm.as_ref())?, 0o755)?;
        tar.file("./userdata/birddog-kvm/run.sh", &kit.asset("kvm-run.sh", a.kvm_run.as_ref())?, 0o755)?;
        log.push("NDI KVM: yes".into());
    }

    if flags.cam {
        tar.file("./userdata/bd-cam/bdcam", &kit.asset("bdcam-linux-arm64", a.bdcam.as_ref())?, 0o755)?;
        tar.file("./userdata/bd-cam/run.sh", &kit.asset("cam-run.sh", a.cam_run.as_ref())?, 0o755)?;
        tar.file("./userdata/bd-cam/api-run.sh", &kit.asset("cam-api-run.sh", a.cam_api_run.as_ref())?, 0o755)?;
        log.push(format!("UVC converter: yes, web UI tab {}", if flags.cam_ui { "yes" } else { "no" }));
    }

    if flags.play {
        // The player is required; its two helpers are optional, and the
        // installer reports what it ended up with.
        for (label, file, dest, meta, required) in [
            ("bdplay", "bdplay-linux-arm64", "./userdata/bd-play/bdplay", a.bdplay.as_ref(), true),
            ("bdpdf", "bdpdf-linux-arm64", "./userdata/bd-play/bdpdf", a.bdpdf.as_ref(), false),
            ("libpdfium.so", "libpdfium.so", "./userdata/bd-play/libpdfium.so", a.pdfium.as_ref(), false),
            ("exFAT helper", "mount.exfat-fuse", "./userdata/bd-play/mount.exfat-fuse", a.exfat.as_ref(), false),
        ] {
            match meta {
                Some(m) => tar.file(dest, &kit.asset(file, Some(m))?, 0o755)?,
                None if required => return Err(format!("{label} is missing from this kit")),
                None => log.push(format!("{label}: not in this kit, skipped")),
            }
        }
        log.push("USB media player: yes".into());
    }

    if flags.gateway {
        let tgz = fetched.mediamtx_tgz.as_deref().ok_or("the streaming gateway was asked for and MediaMTX not fetched")?;
        let (mtx, license) = fw::extract_mediamtx(tgz)?;
        tar.file("./userdata/bd-gw/mediamtx", &mtx, 0o755)?;
        if let Some(l) = license {
            tar.file("./userdata/bd-gw/LICENSE.mediamtx", &l, 0o644)?;
        }
        tar.file("./userdata/bd-gw/bdgw", &kit.asset("bdgw-linux-arm64", a.bdgw.as_ref())?, 0o755)?;
        tar.file("./userdata/bd-gw/run.sh", &kit.asset("gw-run.sh", a.gw_run.as_ref())?, 0o755)?;
        tar.file("./userdata/bd-gw/api-run.sh", &kit.asset("gw-api-run.sh", a.gw_api_run.as_ref())?, 0o755)?;
        log.push(format!(
            "streaming gateway: MediaMTX {}, web UI tab {}",
            kit.json.mediamtx.version,
            if flags.gateway_ui { "yes" } else { "no" }
        ));
    }

    let mut seen = BTreeMap::new();
    for m in modules {
        if let Some(prev) = seen.insert(m.name.clone(), m.version.clone()) {
            return Err(format!("two modules are both called {} ({prev} and {})", m.name, m.version));
        }
        for f in &m.files {
            tar.file(&format!("{}{}/{}", fw::MODULE_PREFIX, m.name, f.path), &f.data, f.mode)?;
        }
        log.push(format!("module {} {}: {} files, {}", m.name, m.version, m.files.len(), fw::human_size(m.size)));
    }

    let tar = tar.finish();
    let tar_sha256 = fw::sha256_hex(&tar);
    let fw_bytes = fw::gzip(&tar);
    Ok(Built {
        name: format!("BirdDog_PLAY-custom-{}.fw", flags.tag),
        sha256: fw::sha256_hex(&fw_bytes),
        fw: fw_bytes,
        tar_sha256,
        log,
    })
}
