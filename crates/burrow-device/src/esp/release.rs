//! A CANary firmware release as it arrives: a zip holding the flasher's own
//! `manifest.json` (one release) and the parts it names.
//!
//! The shape is the CANary Flasher's `src/manifest.ts`, unchanged, because the
//! zip is exported from the flasher's `public/firmware/` and the page and Burrow
//! should be unable to disagree about what a release contains. `validate` is its
//! `validateManifest`.

use super::image::{identify, read_app_description, AppDescription, ImageInfo, APP, APP_PROJECTS};
use super::plan::PlannedWrite;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Release {
    /// Also the directory the parts sit under.
    pub id: String,
    pub date: String,
    /// Full commit of the firmware repo the images were built from.
    pub commit: String,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Variant {
    pub id: String,
    pub name: String,
    pub summary: String,
    #[serde(default)]
    pub recommended: bool,
    pub app: ManifestApp,
    pub parts: Vec<Part>,
}

/// `AppDescription` as the manifest spells it (camelCase, as written by the
/// flasher's import script).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestApp {
    pub version: String,
    pub project: String,
    pub time: String,
    pub date: String,
    pub idf_version: String,
}

impl From<&AppDescription> for ManifestApp {
    fn from(a: &AppDescription) -> Self {
        ManifestApp {
            version: a.version.clone(),
            project: a.project.clone(),
            time: a.time.clone(),
            date: a.date.clone(),
            idf_version: a.idf_version.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Part {
    pub name: String,
    pub offset: u32,
    /// Relative to the manifest.
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

pub fn validate(m: &Manifest) -> Vec<String> {
    let mut e = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for r in &m.releases {
        let at = format!("release {}", r.id);
        if !is_id(&r.id) {
            e.push(format!("{at}: id must be lower-case letters, digits, . _ -"));
        }
        if !ids.insert(r.id.clone()) {
            e.push(format!("{at}: duplicate id"));
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
            if !APP_PROJECTS.contains(&v.app.project.as_str()) {
                e.push(format!("{vat}: app project is {}", v.app.project));
            }
            for need in [0x0u32, 0x8000, 0xf000, 0x20000] {
                if !v.parts.iter().any(|p| p.offset == need) {
                    e.push(format!("{vat}: nothing at 0x{need:x}"));
                }
            }
            for p in &v.parts {
                if !p.path.starts_with(&format!("{}/{}/", r.id, v.id)) {
                    e.push(format!("{vat}: {} is outside its own directory", p.path));
                }
                if !is_hex(&p.sha256, 64) {
                    e.push(format!("{vat}: {} has no sha256", p.name));
                }
            }
        }
    }
    e
}

/// The parts of one variant, read from `root` (the extracted zip) and checked
/// against the manifest byte for byte before anything else sees them. The path
/// check matters: a manifest is data from a download, and `..` in it would
/// otherwise read anything on the disk.
pub fn load_variant(root: &Path, release: &Release, variant: &Variant) -> Result<Vec<PlannedWrite>, String> {
    let mut out = Vec::new();
    for p in &variant.parts {
        let rel = Path::new(&p.path);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(format!("{} is not a plain relative path", p.path));
        }
        let data = std::fs::read(root.join(rel)).map_err(|e| format!("{}: {e}", p.path))?;
        if data.len() as u64 != p.size {
            return Err(format!("{} is {} bytes, not {}", p.path, data.len(), p.size));
        }
        if hex::encode(Sha256::digest(&data)) != p.sha256 {
            return Err(format!("{} does not match its checksum", p.path));
        }
        out.push(PlannedWrite {
            name: p.name.clone(),
            offset: p.offset,
            data,
        });
    }
    // The manifest's word for what is in the app is checked against the app.
    let app = out
        .iter()
        .find(|w| w.offset == APP)
        .ok_or_else(|| format!("{}/{} has no app", release.id, variant.id))?;
    match read_app_description(&app.data) {
        Some(d) if ManifestApp::from(&d) == variant.app => Ok(out),
        Some(d) => Err(format!(
            "the app in {}/{} says it is {} {}, and the manifest says {} {}",
            release.id, variant.id, d.project, d.version, variant.app.project, variant.app.version
        )),
        None => Err(format!("the app in {}/{} has no app descriptor", release.id, variant.id)),
    }
}

/// Files someone built themselves, placed by what they are rather than what
/// they are called. Anything that is not a recognisable part is refused here,
/// before the gate, so the message can name the file.
pub fn plan_own_build(files: Vec<(String, Vec<u8>)>) -> Result<Vec<PlannedWrite>, String> {
    let mut out = Vec::new();
    for (name, data) in files {
        let info = identify(&data);
        let offset = match &info {
            ImageInfo::Unknown { reason } => return Err(format!("{name}: {reason}")),
            other => super::image::default_offset(other).expect("known kinds have an offset"),
        };
        out.push(PlannedWrite { name, offset, data });
    }
    Ok(out)
}
