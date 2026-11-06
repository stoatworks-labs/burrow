//! A firmware package: what one device's firmware is, and where its parts go.
//!
//! The Stoatworks Flasher's `src/package.ts` and its `docs/PACKAGE.md`
//! (schema 2), which is the specification: the page and Burrow read the same
//! files, so a change there is a change here.
//!
//! A release zip (`<device>-firmware-<release>.zip`) holds `manifest.json`, a
//! [`Package`] whose `releases` has one entry, and the parts at
//! `<release>/<variant>/<file>`. The shell unpacks it (burrow-core's guarded
//! extractor) and this module reads the directory: the page reads the zip in
//! memory instead, to the same effect.

use super::chips::{self, Chip, CHIPS, DEFAULT_TABLE_OFFSET};
use super::image::{AppDescription, ImageInfo};
use super::plan::{components, PlannedWrite};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub const SCHEMA: u32 = 2;

/// The serial speeds a device may ask to be flashed at: esptool's standard ones.
pub const BAUDS: [u32; 6] = [115_200, 230_400, 460_800, 921_600, 1_500_000, 2_000_000];

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbId {
    pub vendor_id: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDef {
    /// Lower case; the directory under public/firmware/ and the start of every
    /// download name.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// esptool's CHIP_NAME, e.g. "ESP32-S3".
    #[serde(default)]
    pub chip: String,
    /// Bytes of flash every unit has. A unit with less is refused.
    #[serde(default)]
    pub flash_size: u64,
    /// ESP-IDF project names this device's apps carry, newest first.
    #[serde(default)]
    pub projects: Vec<String>,
    /// owner/name of the public GitHub repo whose releases carry the zips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// Said once, plainly, wherever the device is offered: how proven the
    /// firmware is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb: Option<Vec<UsbId>>,
    /// Steps to get the unit talking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<Vec<String>>,
    /// Paragraphs for "it will not connect", before the download-mode steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Vec<String>>,
    /// Steps to force the ROM's download mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_mode: Option<Vec<String>>,
    /// What an ordinary write (no full erase) leaves on the unit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keeps: Option<String>,
    /// CONFIG_PARTITION_TABLE_OFFSET, when it is not 0x8000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_offset: Option<u32>,
    /// Serial speed for flashing, when 921600 is too fast for the wiring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baud: Option<u32>,
}

impl DeviceDef {
    pub fn table_offset(&self) -> u32 {
        self.table_offset.unwrap_or(DEFAULT_TABLE_OFFSET)
    }
    /// The chip table's entry. Only None for a definition that does not validate.
    pub fn chip(&self) -> Option<&'static Chip> {
        chips::by_name(&self.chip)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    #[serde(default)]
    pub schema: u32,
    pub device: DeviceDef,
    /// Newest first. The first is the default.
    #[serde(default)]
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The firmware build: also the directory its parts sit under.
    #[serde(default)]
    pub id: String,
    /// The GitHub release on device.repo that carries this release's downloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default)]
    pub date: String,
    /// Full commit of the firmware source the images were built from.
    #[serde(default)]
    pub commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variant {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub recommended: bool,
    /// Shown once the unit has rebooted into this variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default = "empty_app")]
    pub app: AppDescription,
    #[serde(default)]
    pub parts: Vec<Part>,
}

fn empty_app() -> AppDescription {
    AppDescription {
        version: String::new(),
        project: String::new(),
        time: String::new(),
        date: String::new(),
        idf_version: String::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(default)]
    pub name: String,
    pub offset: u32,
    /// Relative to the manifest.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
}

// --- validation -------------------------------------------------------------------

/// `^[a-z0-9][a-z0-9._-]*$`
fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `^\d{4}-\d{2}-\d{2}$`
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// `^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$`
fn is_repo(s: &str) -> bool {
    let Some((owner, name)) = s.split_once('/') else { return false };
    !owner.is_empty()
        && !name.is_empty()
        && owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

/// `^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`
fn is_tag(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('v') else { return false };
    let (core, pre) = match rest.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (rest, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    nums.len() == 3
        && nums.iter().all(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'))
}

pub fn validate_device(d: &DeviceDef) -> Vec<String> {
    let mut e = Vec::new();
    let at = format!("device {}", d.id);
    if !is_id(&d.id) {
        e.push(format!("{at}: id must be lower-case letters, digits, . _ -"));
    }
    if d.name.is_empty() {
        e.push(format!("{at}: needs a name"));
    }
    if d.chip().is_none() {
        let names: Vec<&str> = CHIPS.iter().map(|c| c.name).collect();
        e.push(format!("{at}: chip must be one of {}", names.join(", ")));
    }
    if d.flash_size < 1 << 20 || !d.flash_size.is_power_of_two() {
        e.push(format!("{at}: flashSize must be a power of two of at least 1 MB, in bytes"));
    }
    if d.projects.is_empty() || d.projects.iter().any(String::is_empty) {
        e.push(format!("{at}: needs the project names its apps carry"));
    }
    if d.repo.as_deref().is_some_and(|r| !is_repo(r)) {
        e.push(format!("{at}: repo must be owner/name"));
    }
    if d.table_offset.is_some_and(|t| t % 0x1000 != 0 || t < 0x8000) {
        e.push(format!("{at}: bad tableOffset"));
    }
    if d.baud.is_some_and(|b| !BAUDS.contains(&b)) {
        e.push(format!("{at}: baud must be a standard esptool speed"));
    }
    e
}

/// Everything wrong with a package that can be told without its bytes.
pub fn validate_package(m: &Package) -> Vec<String> {
    let mut e = Vec::new();
    if m.schema != SCHEMA {
        e.push(format!("schema is {}, Burrow reads {SCHEMA}", m.schema));
    }
    e.extend(validate_device(&m.device));
    if m.releases.is_empty() {
        e.push("releases is not a list, or is empty".into());
        return e;
    }
    if !e.is_empty() {
        return e;
    }
    let chip = m.device.chip().expect("validated");
    let table_offset = m.device.table_offset();
    let mut ids = std::collections::BTreeSet::new();
    for r in &m.releases {
        let at = format!("release {}", r.id);
        if !is_id(&r.id) {
            e.push(format!("{at}: id must be lower-case letters, digits, . _ -"));
        }
        if !ids.insert(r.id.clone()) {
            e.push(format!("{at}: duplicate id"));
        }
        if r.tag.as_deref().is_some_and(|t| !is_tag(t)) {
            e.push(format!("{at}: tag must look like v1.2.3"));
        }
        if !is_date(&r.date) {
            e.push(format!("{at}: date must be YYYY-MM-DD"));
        }
        if !is_hex(&r.commit, 40) {
            e.push(format!("{at}: commit must be a full 40-character sha"));
        }
        if r.variants.is_empty() {
            e.push(format!("{at}: no variants"));
        }
        let mut vids = std::collections::BTreeSet::new();
        for v in &r.variants {
            let vat = format!("{at}/{}", v.id);
            if !is_id(&v.id) {
                e.push(format!("{vat}: bad id"));
            }
            if !vids.insert(v.id.clone()) {
                e.push(format!("{vat}: duplicate variant"));
            }
            if v.name.is_empty() || v.summary.is_empty() {
                e.push(format!("{vat}: needs a name and a summary"));
            }
            if !m.device.projects.contains(&v.app.project) {
                e.push(format!("{vat}: app project is {}, not one of {}'s", v.app.project, m.device.id));
            }
            let offsets: Vec<u32> = v.parts.iter().map(|p| p.offset).collect();
            if !offsets.contains(&chip.bootloader) {
                e.push(format!("{vat}: no bootloader at 0x{:x}", chip.bootloader));
            }
            if !offsets.contains(&table_offset) {
                e.push(format!("{vat}: no partition table at 0x{table_offset:x}"));
            }
            if offsets.len() < 3 {
                e.push(format!("{vat}: needs a bootloader, a partition table and an app at least"));
            }
            let dir = format!("{}/{}/", r.id, v.id);
            for p in &v.parts {
                if p.name.is_empty() {
                    e.push(format!("{vat}: a part has no name"));
                }
                if p.offset % 0x1000 != 0 {
                    e.push(format!("{vat}: {} is not on a 4 KB sector boundary", p.name));
                }
                if !p.path.starts_with(&dir) || p.path.contains("..") {
                    e.push(format!("{vat}: {} is outside its own directory", p.path));
                }
                if p.size == 0 {
                    e.push(format!("{vat}: {} has no size", p.name));
                }
                if !is_hex(&p.sha256, 64) {
                    e.push(format!("{vat}: {} has no sha256", p.name));
                }
            }
        }
    }
    e
}

/// The package, or what kept it from being one.
#[derive(Debug, Clone)]
pub struct ReadPackage {
    pub pkg: Option<Package>,
    pub errors: Vec<String>,
}

/// A package from a manifest of either schema. The first schema (canary
/// v0.2.0's zip) is a bare `{ releases }` naming no device, so it takes the
/// first known device whose project names cover every variant's app.
pub fn read_package(json: &serde_json::Value, known: &[DeviceDef]) -> ReadPackage {
    let fail = |e: String| ReadPackage { pkg: None, errors: vec![e] };
    let Some(obj) = json.as_object() else {
        return fail("not a package".into());
    };
    if obj.get("schema").is_none() && obj.get("releases").is_some_and(|r| r.is_array()) {
        let releases: Vec<Release> = match serde_json::from_value(obj["releases"].clone()) {
            Ok(r) => r,
            Err(e) => return fail(format!("its releases are not ones Burrow reads: {e}")),
        };
        let mut projects: Vec<String> = Vec::new();
        for v in releases.iter().flat_map(|r| &r.variants) {
            if !projects.contains(&v.app.project) {
                projects.push(v.app.project.clone());
            }
        }
        let Some(device) = known.iter().find(|d| projects.iter().all(|p| d.projects.contains(p))) else {
            return fail(format!(
                "a first-schema manifest for {}, which is no device Burrow knows",
                projects.join(", ")
            ));
        };
        let pkg = Package { schema: SCHEMA, device: device.clone(), releases };
        let errors = validate_package(&pkg);
        return ReadPackage { pkg: Some(pkg), errors };
    }
    if obj.get("device").is_none_or(|d| !d.is_object()) {
        let mut errors = Vec::new();
        if obj.get("schema").and_then(|s| s.as_u64()) != Some(SCHEMA as u64) {
            errors.push(format!("schema is {}, Burrow reads {SCHEMA}", obj.get("schema").unwrap_or(&serde_json::Value::Null)));
        }
        errors.push("no device".into());
        return ReadPackage { pkg: None, errors };
    }
    match serde_json::from_value::<Package>(json.clone()) {
        Ok(pkg) => {
            let errors = validate_package(&pkg);
            ReadPackage { pkg: Some(pkg), errors }
        }
        Err(e) => fail(format!("its manifest is not one Burrow reads: {e}")),
    }
}

/// The CANary's definition, as `devices/canary.json` in the Stoatworks Flasher
/// has it. Only here for the first schema, whose manifests name no device.
pub fn known_devices() -> Vec<DeviceDef> {
    vec![serde_json::from_str(include_str!("canary.json")).expect("the built-in CANary definition parses")]
}

pub fn zip_name(d: &DeviceDef, r: &Release) -> String {
    format!("{}-firmware-{}.zip", d.id, r.id)
}

pub fn merged_name(d: &DeviceDef, r: &Release, v: &Variant) -> String {
    format!("{}-firmware-{}-{}.bin", d.id, r.id, v.id)
}

/// A release asset's direct link: pinned to its tag, never latest/download.
pub fn github_asset(d: &DeviceDef, r: &Release, name: &str) -> Option<String> {
    match (&d.repo, &r.tag) {
        (Some(repo), Some(tag)) => Some(format!("https://github.com/{repo}/releases/download/{tag}/{name}")),
        _ => None,
    }
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// --- reading the bytes ------------------------------------------------------------

/// A manifest path as a path under `root`. A manifest is data from a download,
/// and `..` or an absolute path in it would otherwise read anything on disk.
fn part_path(root: &Path, p: &Part) -> Result<std::path::PathBuf, String> {
    let rel = Path::new(&p.path);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{} is not a plain relative path", p.path));
    }
    Ok(root.join(rel))
}

fn read_part(root: &Path, p: &Part) -> Result<Vec<u8>, String> {
    let path = part_path(root, p)?;
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("{} is named in the manifest and missing from the package", p.path))
        }
        Err(e) => return Err(format!("{}: {e}", p.path)),
    };
    if data.len() as u64 != p.size {
        return Err(format!("{} is {} bytes, the manifest says {}", p.path, data.len(), p.size));
    }
    if sha256_hex(&data) != p.sha256 {
        return Err(format!("{} does not match its checksum", p.path));
    }
    Ok(data)
}

/// A package directory (an unpacked release zip), checked the way the page
/// checks a zip: the manifest validates, and every part of every release is
/// there with the size and SHA-256 it names. A first-schema CANary zip is read
/// as a CANary's.
pub fn open_package_dir(root: &Path, known: &[DeviceDef]) -> Result<Package, String> {
    let text = match std::fs::read(root.join("manifest.json")) {
        Ok(t) => t,
        Err(_) => return Err("this zip has no manifest.json, so it is not a firmware package".into()),
    };
    let json: serde_json::Value =
        serde_json::from_slice(&text).map_err(|_| "its manifest.json is not JSON".to_string())?;
    let read = read_package(&json, known);
    let pkg = match read.pkg {
        Some(p) if read.errors.is_empty() => p,
        _ => {
            return Err(format!(
                "its manifest is not one Burrow reads: {}",
                read.errors.first().map(String::as_str).unwrap_or("it is empty")
            ))
        }
    };
    for r in &pkg.releases {
        for v in &r.variants {
            for p in &v.parts {
                read_part(root, p)?;
            }
        }
    }
    Ok(pkg)
}

/// The writes for one variant, read from `root` and checked against the
/// manifest byte for byte before anything else sees them.
///
/// Burrow also checks that the manifest's word for the app is the app: exactly
/// one app among the parts, carrying the descriptor the manifest records. The
/// page's tests check the same of every bundled variant; here it is checked of
/// whatever arrived.
pub fn load_variant(root: &Path, release: &Release, variant: &Variant, table_offset: u32) -> Result<Vec<PlannedWrite>, String> {
    let mut out = Vec::new();
    for p in &variant.parts {
        out.push(PlannedWrite::new(p.name.clone(), p.offset, read_part(root, p)?));
    }
    let apps: Vec<AppDescription> = components(&out, table_offset)
        .into_iter()
        .filter_map(|c| match c.info {
            ImageInfo::App { app, .. } => Some(app),
            _ => None,
        })
        .collect();
    match apps.as_slice() {
        [app] if *app == variant.app => Ok(out),
        [app] => Err(format!(
            "the app in {}/{} says it is {} {}, and the manifest says {} {}",
            release.id, variant.id, app.project, app.version, variant.app.project, variant.app.version
        )),
        [] => Err(format!("{}/{} has no app image", release.id, variant.id)),
        _ => Err(format!("{}/{} has more than one app image", release.id, variant.id)),
    }
}
