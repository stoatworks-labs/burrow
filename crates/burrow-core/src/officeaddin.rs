//! PowerPoint add-ins: the manifest, where PowerPoint looks for one, and how
//! to tell which copy is which.
//!
//! # What installing one means
//!
//! An Office add-in has no code on the machine. It is a web page PowerPoint
//! opens in a pane, and the only file involved is the *manifest* — a few
//! kilobytes of XML naming the add-in, its buttons and the address it runs
//! from. Outside Microsoft Marketplace and an M365 admin deployment, the one
//! way to give PowerPoint a manifest is to sideload it, and that is what this
//! does, in exactly the places the add-ins' own installers use, so that
//! Burrow and those installers each see what the other did:
//!
//! - **macOS:** a file in the `wef` folder inside PowerPoint's sandbox
//!   container. The add-in's own `.pkg` names it `stoatworks-<name>.xml`,
//!   and so does the catalogue, which is where Burrow gets the name.
//! - **Windows:** `%LOCALAPPDATA%\Programs\Stoatworks\<Name>\manifest.xml`,
//!   and a string value under `HKCU\Software\Microsoft\Office\16.0\Wef\Developer`
//!   named after the add-in's `<Id>` and holding that path. That is what the
//!   add-in's `Setup.exe` writes, and what Microsoft's own
//!   `office-addin-dev-settings` writes to sideload one.
//!
//! PowerPoint reads both when it starts, so nothing here takes effect until it
//! is restarted.
//!
//! # The add-in's identity is its `<Id>`
//!
//! Office knows an add-in by the GUID in its manifest and nothing else — not
//! the file name, which differs between a sideload script, an installer and
//! Burrow. So every question here is asked by Id, the way the add-ins' own
//! installers ask it: a copy is *this add-in* when its manifest carries one of
//! the Ids the catalogue lists for it, wherever it came from. Two manifests
//! with one Id confuse PowerPoint, so an install takes out any other copy.

use crate::ledger::{LedgerEntry, Reconciled};
use crate::model::{compare_versions, Format, InstallState, VersionCmp, VersionSource};
use quick_xml::events::Event;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};

/// A manifest is about five kilobytes. Anything past this is not one, and is
/// not read into memory to find out.
pub const MAX_MANIFEST: u64 = 1024 * 1024;

/// PowerPoint for Mac's sandbox container, under the home directory.
///
/// macOS creates it the first time PowerPoint runs, so its existence is the
/// test for "PowerPoint has been opened on this account" — the same test the
/// add-ins' own `.pkg` makes, and for the same reason: making the folder by
/// hand before then is asking for a container macOS does not recognise.
pub fn container_dir(home: &Path) -> PathBuf {
    home.join("Library/Containers/com.microsoft.Powerpoint")
}

/// The folder PowerPoint for Mac reads sideloaded manifests from.
pub fn wef_dir(home: &Path) -> PathBuf {
    container_dir(home).join("Data/Documents/wef")
}

/// The registry key PowerPoint for Windows reads sideloaded add-ins from,
/// under `HKEY_CURRENT_USER`. `16.0` covers Office 2016 to 2024 and
/// Microsoft 365.
pub const DEVELOPER_KEY: &str = r"Software\Microsoft\Office\16.0\Wef\Developer";

/// What the manifest is called inside its folder on Windows, as the add-ins'
/// `Setup.exe` names it.
pub const WINDOWS_FILE: &str = "manifest.xml";

/// What Burrow reads out of a manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    /// The add-in's GUID, lower-cased. Office compares them without regard to
    /// case, and so does everything here.
    pub id: String,
    /// The *manifest's* version, which is not the release's — see
    /// [`VersionSource::Checksum`]. Read, and deliberately not compared.
    pub version: Option<String>,
    /// The `Name` of each `<Host>` it declares: `Presentation` for PowerPoint.
    pub hosts: Vec<String>,
}

impl Manifest {
    pub fn is_for_powerpoint(&self) -> bool {
        self.hosts.iter().any(|h| h == "Presentation")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    NotXml(String),
    /// Well-formed XML, but its root is not `<OfficeApp>`.
    NotAnAddin,
    NoId,
    /// An `<Id>` that is not a GUID. Office refuses those, so this would never
    /// load, and it is not something to compare other files against either.
    BadId(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::NotXml(why) => write!(f, "it is not readable XML ({why})"),
            ManifestError::NotAnAddin => write!(f, "it is not an Office add-in manifest"),
            ManifestError::NoId => write!(f, "it has no <Id>"),
            ManifestError::BadId(id) => write!(f, "its <Id> {id:?} is not a GUID"),
        }
    }
}

/// Read a manifest's Id, version and hosts.
///
/// Only the direct children of `<OfficeApp>` count. `<VersionOverrides>`
/// further down has `<Hosts>` of its own, and a comment can say anything —
/// the manifests in this fleet open with a long one — so neither a search of
/// the text nor a first match anywhere is good enough to delete a file on.
pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, ManifestError> {
    let mut reader = quick_xml::Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    // The local names of the open elements, outermost first.
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut id: Option<String> = None;
    let mut version: Option<String> = None;
    let mut hosts: Vec<String> = Vec::new();

    let host_name = |e: &quick_xml::events::BytesStart<'_>| -> Option<String> {
        e.try_get_attribute("Name")
            .ok()
            .flatten()
            .and_then(|a| {
                a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .ok()
                    .map(|v| v.trim().to_string())
            })
    };

    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| ManifestError::NotXml(e.to_string()))?;
        match event {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_vec();
                if path.is_empty() && name != b"OfficeApp" {
                    return Err(ManifestError::NotAnAddin);
                }
                if path.len() == 2 && path[1] == b"Hosts" && name == b"Host" {
                    hosts.extend(host_name(&e));
                }
                path.push(name);
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_vec();
                if path.is_empty() {
                    return Err(ManifestError::NotAnAddin);
                }
                if path.len() == 2 && path[1] == b"Hosts" && name == b"Host" {
                    hosts.extend(host_name(&e));
                }
            }
            Event::End(_) => {
                path.pop();
                if path.is_empty() {
                    break;
                }
            }
            Event::Text(t) if path.len() == 2 => {
                let text = t
                    .decode()
                    .map_err(|e| ManifestError::NotXml(e.to_string()))?
                    .trim()
                    .to_string();
                match path[1].as_slice() {
                    b"Id" if id.is_none() => id = Some(text),
                    b"Version" if version.is_none() => version = Some(text),
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let id = id.ok_or(if hosts.is_empty() && version.is_none() {
        ManifestError::NotAnAddin
    } else {
        ManifestError::NoId
    })?;
    if !is_guid(&id) {
        return Err(ManifestError::BadId(id));
    }
    Ok(Manifest { id: id.to_ascii_lowercase(), version, hosts })
}

/// `8-4-4-4-12` hexadecimal, which is the only shape Office accepts.
pub fn is_guid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The ids a catalogue entry lists, as they are compared: lower case, and only
/// the ones that are GUIDs. An entry's `identifiers` is shared with bundle
/// identifiers, and a `com.stoatworks…` string can never be an add-in's Id.
pub fn addin_ids(identifiers: &[String]) -> Vec<String> {
    identifiers
        .iter()
        .filter(|i| is_guid(i))
        .map(|i| i.to_ascii_lowercase())
        .collect()
}

/// What an add-in is called where it is installed: on a Mac the file name in
/// `wef`, on Windows the folder under `Programs\Stoatworks`.
///
/// The catalogue's `entries` say, per platform, because the add-ins' own
/// installers chose the names (`stoatworks-font-manager.xml`, and a folder
/// named for the product) and Burrow has to use the same ones for each to see
/// the other's install as the same install. Where the catalogue says nothing,
/// a name derived from the project's own is used instead — found again by Id
/// either way, so the only cost is the file name differing from the
/// installer's.
pub fn install_name(declared: &[String], slug: &str, name: &str, platform: crate::model::Platform) -> String {
    if let Some(n) = declared.first().filter(|n| !n.is_empty()) {
        return n.clone();
    }
    match platform {
        crate::model::Platform::Windows => name.to_string(),
        _ => format!("stoatworks-{slug}.xml"),
    }
}

/// The Id of the manifest at `path`, for an add-in whose catalogue entry lists
/// none: the file Burrow itself placed says which add-in it is.
pub fn id_of(path: &Path) -> Option<String> {
    read_manifest(path).map(|(m, _)| m.id)
}

/// The Ids to look for: the catalogue's, or, where it lists none, the one in
/// the copy Burrow placed under `installed`.
pub fn ids_for(
    identifiers: &[String],
    dest: &Path,
    installed: &str,
    platform: crate::model::Platform,
) -> Vec<String> {
    let ids = addin_ids(identifiers);
    if !ids.is_empty() {
        return ids;
    }
    let placed = match platform {
        crate::model::Platform::Windows => dest.join(installed).join(WINDOWS_FILE),
        _ => dest.join(installed),
    };
    id_of(&placed).into_iter().collect()
}

/// Every installed copy of an add-in on this machine: the files in `wef` on a
/// Mac, the registry's answer on Windows.
pub fn find_installed(platform: crate::model::Platform, dest: &Path, ids: &[String]) -> Vec<Found> {
    match platform {
        crate::model::Platform::Macos => find_in_wef(dest, ids),
        #[cfg(windows)]
        crate::model::Platform::Windows => find_registered(&WefDeveloper, ids),
        _ => {
            let _ = dest;
            Vec::new()
        }
    }
}

/// One copy of an add-in, found where PowerPoint looks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// What to call it in the window: the file's name in `wef`, or on Windows
    /// the path the registry names.
    pub name: String,
    pub path: PathBuf,
    pub id: String,
    /// The SHA-256 of the file. None where the registry names a file that is
    /// not there, or not readable.
    pub sha256: Option<String>,
}

/// Read one file as a manifest, if it is a regular file small enough to be
/// one. Errors are folded into None: a file that is not a manifest is simply
/// not this add-in.
fn read_manifest(path: &Path) -> Option<(Manifest, String)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let m = parse_manifest(&bytes).ok()?;
    Some((m, sha256_hex(&bytes)))
}

/// Every manifest in `wef` carrying one of `ids`.
///
/// ⚠️ **This reads a folder Burrow does not own**, and it is the second place
/// that does, after claiming. It is allowed because of what it matches on:
/// not a name or a prefix but the add-in's GUID, which is the add-in as far as
/// PowerPoint is concerned. A file carrying it is this add-in whoever put it
/// there — Burrow, the add-in's own `.pkg`, or a sideload script — and every
/// other file in the folder is opened, found not to carry it, and left
/// exactly as it was. It is also precisely what the add-ins' own installers do
/// before they write and when they uninstall, so Burrow takes out nothing they
/// would not.
///
/// Only regular files ending `.xml` are looked at, which is what PowerPoint
/// reads. A symlink is skipped rather than followed: whatever it points at is
/// somebody's working copy, not an install.
pub fn find_in_wef(wef: &Path, ids: &[String]) -> Vec<Found> {
    let mut out = Vec::new();
    if ids.is_empty() {
        return out;
    }
    let Ok(dir) = std::fs::read_dir(wef) else {
        return out;
    };
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".xml") {
            continue;
        }
        let path = entry.path();
        let Some((m, sha)) = read_manifest(&path) else { continue };
        if ids.contains(&m.id) {
            out.push(Found { name, path, id: m.id, sha256: Some(sha) });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// What can go wrong placing or removing an add-in, worded for the person
/// reading it.
#[derive(Debug)]
pub enum AddinError {
    /// macOS has no container for PowerPoint, so PowerPoint has never run on
    /// this account and has nowhere to keep add-ins.
    PowerPointNeverOpened,
    NotAManifest(ManifestError),
    NotForPowerPoint,
    /// The download is an add-in, but not the one the catalogue says it is.
    WrongAddin { found: String },
    /// A name from the catalogue that is not a plain file or folder name.
    BadName(String),
    Io { doing: String, error: io::Error },
}

impl std::fmt::Display for AddinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AddinError::PowerPointNeverOpened => write!(
                f,
                "PowerPoint hasn’t been opened on this account yet, so it has nowhere to keep \
                 add-ins. Open PowerPoint once, quit it, then install again."
            ),
            AddinError::NotAManifest(why) => {
                write!(f, "the download is not a PowerPoint add-in manifest: {why}")
            }
            AddinError::NotForPowerPoint => {
                write!(f, "the download is an Office add-in, but not one for PowerPoint")
            }
            AddinError::WrongAddin { found } => write!(
                f,
                "the download is a different add-in (Id {found}) from the one the catalogue \
                 lists, so it was not installed"
            ),
            AddinError::BadName(n) => write!(f, "{n:?} is not a name Burrow will write"),
            AddinError::Io { doing, error } if error.kind() == io::ErrorKind::PermissionDenied => {
                write!(
                    f,
                    "macOS refused Burrow while {doing} ({error}). PowerPoint keeps add-ins in its \
                     own app container: if macOS asked whether Burrow may access data from other \
                     apps, allow it — it can be changed in System Settings ▸ Privacy & Security — \
                     and try again."
                )
            }
            AddinError::Io { doing, error } => write!(f, "could not finish {doing}: {error}"),
        }
    }
}

impl std::error::Error for AddinError {}

fn io_err(doing: impl Into<String>) -> impl FnOnce(io::Error) -> AddinError {
    let doing = doing.into();
    move |error| AddinError::Io { doing, error }
}

/// A name the catalogue supplied, checked before it becomes part of a path:
/// one component, nothing hidden, nothing a Windows path would read as
/// something else.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// The manifest, checked against what the catalogue says it should be.
///
/// `ids` empty means the catalogue lists none yet, and then the manifest's own
/// Id is believed: nothing could be matched before it was installed, but what
/// is installed is still found by that Id from then on, via the ledger.
pub fn check(bytes: &[u8], ids: &[String]) -> Result<Manifest, AddinError> {
    let m = parse_manifest(bytes).map_err(AddinError::NotAManifest)?;
    if !m.is_for_powerpoint() {
        return Err(AddinError::NotForPowerPoint);
    }
    if !ids.is_empty() && !ids.contains(&m.id) {
        return Err(AddinError::WrongAddin { found: m.id });
    }
    Ok(m)
}

/// What an install changed besides putting the file in place.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Placed {
    /// Other copies of the same add-in that were taken out: the sideload
    /// script's file, or an earlier install under another name.
    pub removed: Vec<String>,
    /// On Windows, where the registry pointed before, if that was somewhere
    /// else.
    pub previous: Option<String>,
}

/// A file written beside its destination under a name PowerPoint does not
/// read, then renamed into place. Not `.xml`, and hidden, so a PowerPoint that
/// starts mid-install never sees half a manifest.
fn write_then_rename(dest: &Path, bytes: &[u8], batch: &str) -> Result<(), AddinError> {
    let dir = dest.parent().ok_or_else(|| AddinError::BadName(dest.display().to_string()))?;
    let file = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = dir.join(format!(".{file}.burrow-{batch}"));
    std::fs::write(&tmp, bytes).map_err(io_err(format!("writing into {}", dir.display())))?;
    // As for every other payload: unconditionally, and before it goes live. A
    // file written by a downloaded copy of Burrow can inherit the flag.
    crate::quarantine::clear(&tmp);
    std::fs::rename(&tmp, dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        AddinError::Io { doing: format!("putting {file} in place"), error }
    })
}

/// Install on a Mac: `bytes` into PowerPoint's `wef` folder as `name`.
///
/// The new file is in place before anything is removed, so an install that
/// fails part-way never leaves PowerPoint with no copy at all; then any other
/// copy of the same add-in is taken out, matched on the Id.
pub fn install_mac(
    home: &Path,
    name: &str,
    bytes: &[u8],
    ids: &[String],
    batch: &str,
) -> Result<Placed, AddinError> {
    if !plain_name(name) || !name.to_ascii_lowercase().ends_with(".xml") {
        return Err(AddinError::BadName(name.to_string()));
    }
    let m = check(bytes, ids)?;
    if !container_dir(home).is_dir() {
        return Err(AddinError::PowerPointNeverOpened);
    }
    let wef = wef_dir(home);
    std::fs::create_dir_all(&wef).map_err(io_err("making PowerPoint’s add-in folder"))?;
    write_then_rename(&wef.join(name), bytes, batch)?;

    let mut placed = Placed::default();
    for other in find_in_wef(&wef, std::slice::from_ref(&m.id)) {
        if other.name == name {
            continue;
        }
        std::fs::remove_file(&other.path)
            .map_err(io_err(format!("removing the older copy {}", other.name)))?;
        placed.removed.push(other.name);
    }
    Ok(placed)
}

/// Uninstall on a Mac: every copy in `wef` carrying one of `ids`, and nothing
/// else. Returns the names removed.
pub fn uninstall_mac(home: &Path, ids: &[String]) -> Result<Vec<String>, AddinError> {
    let mut removed = Vec::new();
    for f in find_in_wef(&wef_dir(home), ids) {
        std::fs::remove_file(&f.path).map_err(io_err(format!("removing {}", f.name)))?;
        removed.push(f.name);
    }
    Ok(removed)
}

/// The values under [`DEVELOPER_KEY`], as far as an add-in needs them.
///
/// A trait so that the Windows logic — which value to write, which file goes
/// with it, what an uninstall leaves alone — runs in `cargo test` on any
/// machine. The real one is [`WefDeveloper`], and only exists on Windows.
pub trait Developer {
    /// The path registered for this Id, if any.
    fn get(&self, id: &str) -> io::Result<Option<String>>;
    fn set(&mut self, id: &str, path: &str) -> io::Result<()>;
    /// Remove the value named `id`, and the key of the same name beneath
    /// [`DEVELOPER_KEY`] where Office keeps that add-in's debugging flags, if
    /// either is there. Both are named for this add-in and nothing else.
    fn remove(&mut self, id: &str) -> io::Result<()>;
}

/// Every registered copy of an add-in carrying one of `ids`.
///
/// Office resolves an Id to exactly one path, so this is at most one per Id. A
/// registration whose file has gone is still reported — with no checksum — so
/// it reads as installed-but-wrong rather than not installed, and an uninstall
/// still clears it.
pub fn find_registered(reg: &dyn Developer, ids: &[String]) -> Vec<Found> {
    let mut out = Vec::new();
    for id in ids {
        let Ok(Some(path)) = reg.get(id) else { continue };
        let p = PathBuf::from(&path);
        let sha = read_manifest(&p).filter(|(m, _)| &m.id == id).map(|(_, sha)| sha);
        out.push(Found { name: path, path: p, id: id.clone(), sha256: sha });
    }
    out
}

/// Install on Windows: `bytes` as `root\<folder>\manifest.xml`, then point the
/// registry at it.
///
/// The file goes first: a registry value naming a file that is not there yet
/// would be the half-finished state. If the registry write fails, the file is
/// taken back out again — on its own it does nothing.
pub fn install_windows(
    root: &Path,
    folder: &str,
    bytes: &[u8],
    ids: &[String],
    batch: &str,
    reg: &mut dyn Developer,
) -> Result<Placed, AddinError> {
    if !plain_name(folder) {
        return Err(AddinError::BadName(folder.to_string()));
    }
    let m = check(bytes, ids)?;
    let dir = root.join(folder);
    std::fs::create_dir_all(&dir).map_err(io_err(format!("making {}", dir.display())))?;
    let dest = dir.join(WINDOWS_FILE);
    write_then_rename(&dest, bytes, batch)?;

    let path = dest.display().to_string();
    let previous = reg.get(&m.id).ok().flatten().filter(|p| !p.eq_ignore_ascii_case(&path));
    if let Err(error) = reg.set(&m.id, &path) {
        let _ = std::fs::remove_file(&dest);
        let _ = std::fs::remove_dir(&dir);
        return Err(AddinError::Io { doing: "registering the add-in with Office".into(), error });
    }
    Ok(Placed { removed: Vec::new(), previous })
}

/// Uninstall on Windows: the registration for each of `ids`, and the manifest
/// in Burrow's own folder for it.
///
/// A registration pointing anywhere else — a developer's checkout, a network
/// share — loses its registry value and keeps its file: the value is this
/// add-in's, the file is somebody's. The folders go only if they are empty, so
/// the add-in's own `Setup.exe`, whose uninstaller and icon share that folder,
/// keeps working.
pub fn uninstall_windows(
    root: &Path,
    folder: &str,
    ids: &[String],
    reg: &mut dyn Developer,
) -> Result<Vec<String>, AddinError> {
    if !plain_name(folder) {
        return Err(AddinError::BadName(folder.to_string()));
    }
    let mut removed = Vec::new();
    for id in ids {
        if let Ok(Some(path)) = reg.get(id) {
            removed.push(path);
        }
        reg.remove(id).map_err(io_err("removing the add-in’s registration"))?;
    }
    let dir = root.join(folder);
    let ours = dir.join(WINDOWS_FILE);
    if read_manifest(&ours).is_some_and(|(m, _)| ids.contains(&m.id)) {
        std::fs::remove_file(&ours).map_err(io_err(format!("removing {}", ours.display())))?;
        let shown = ours.display().to_string();
        if !removed.iter().any(|p| p.eq_ignore_ascii_case(&shown)) {
            removed.push(shown);
        }
    }
    let _ = std::fs::remove_dir(&dir);
    let _ = std::fs::remove_dir(root);
    Ok(removed)
}

/// The real registry, on Windows.
#[cfg(windows)]
pub struct WefDeveloper;

#[cfg(windows)]
impl Developer for WefDeveloper {
    fn get(&self, id: &str) -> io::Result<Option<String>> {
        use winreg::enums::HKEY_CURRENT_USER;
        let key = match winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(DEVELOPER_KEY) {
            Ok(k) => k,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        match key.get_value::<String, _>(id) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn set(&mut self, id: &str, path: &str) -> io::Result<()> {
        use winreg::enums::HKEY_CURRENT_USER;
        let (key, _) = winreg::RegKey::predef(HKEY_CURRENT_USER).create_subkey(DEVELOPER_KEY)?;
        key.set_value(id, &path.to_string())
    }

    fn remove(&mut self, id: &str) -> io::Result<()> {
        use winreg::enums::HKEY_CURRENT_USER;
        let key = match winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            DEVELOPER_KEY,
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        ) {
            Ok(k) => k,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        for result in [key.delete_value(id), key.delete_subkey_all(id)] {
            match result {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

/// What a row should say about one add-in, from what was found.
///
/// The question is never "which version is this", because nothing in the file
/// says: a manifest carries its own `<Version>`, which Office wants at 1.0 or
/// more and caches by, and which moves only when the manifest does. The add-in
/// itself runs from its website and is always the current release. So:
///
/// 1. **One copy, byte for byte the current release's manifest** (by the
///    catalogue's SHA-256): up to date, at the catalogue's version.
/// 2. **One copy that is what Burrow last installed** (the ledger's hash), and
///    the catalogue has moved on: an update, from the version Burrow recorded.
/// 3. **Anything else** — a copy from an older release's installer, a sideload
///    script's rewrite pointing at localhost, two copies at once: version
///    unknown, which offers Reinstall, which leaves exactly one current copy.
///
/// Never foreign. A file carrying this add-in's Id *is* this add-in, whoever
/// wrote it.
#[allow(clippy::too_many_arguments)]
pub fn reconcile(
    slug: &str,
    dest_id: &str,
    found: &[Found],
    record: Option<&LedgerEntry>,
    has_asset: bool,
    latest: Option<&str>,
    latest_sha: Option<&str>,
) -> Reconciled {
    let mut base = Reconciled {
        slug: slug.to_string(),
        format: Format::Powerpoint,
        destination_id: dest_id.to_string(),
        state: InstallState::NotInstalled,
        missing: Vec::new(),
        foreign: false,
    };
    if found.is_empty() {
        if !has_asset && record.is_none() {
            base.state = InstallState::NoBuild;
        }
        return base;
    }

    let same = |a: Option<&str>, b: Option<&str>| match (a, b) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    };
    let only = (found.len() == 1).then(|| found[0].sha256.as_deref()).flatten();

    base.state = if only.is_some() && same(only, latest_sha) {
        InstallState::UpToDate {
            version: latest.unwrap_or("current").to_string(),
            source: VersionSource::Checksum,
        }
    } else if let Some(rec) = record.filter(|r| same(only, Some(&r.payload_sha256))) {
        match latest {
            Some(latest) if compare_versions(&rec.version, latest) != VersionCmp::Same => {
                InstallState::UpdateAvailable {
                    installed: rec.version.clone(),
                    latest: latest.to_string(),
                    source: VersionSource::Ledger,
                }
            }
            _ => InstallState::UpToDate { version: rec.version.clone(), source: VersionSource::Ledger },
        }
    } else {
        InstallState::VersionUnknown { entries: found.iter().map(|f| f.name.clone()).collect() }
    };
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    const FM: &str = "abc06eaf-2365-4fb4-a75d-6c5591af1cf6";
    const EXPORTER: &str = "5521a520-0338-4007-abe7-46f826fd92b0";

    /// The shape of the fleet's real manifests, cut down: a long comment
    /// first, the Id, and a `<VersionOverrides>` with `<Hosts>` of its own.
    fn manifest(id: &str, host: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!--
  A comment that mentions <Id>00000000-0000-0000-0000-000000000000</Id> and
  <Version>9.9.9</Version>, which must not count.
-->
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp">
  <Id>{id}</Id>
  <Version>1.0.0</Version>
  <ProviderName>Stoatworks</ProviderName>
  <DisplayName DefaultValue="Font Manager" />
  <Hosts>
    <Host Name="{host}" />
  </Hosts>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides">
    <Hosts><Host xsi:type="Workbook"><Id>not-this-one</Id></Host></Hosts>
  </VersionOverrides>
</OfficeApp>
"#
        )
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// A home directory with PowerPoint's container in it, as after
    /// PowerPoint's first launch.
    fn home_with_powerpoint() -> TempDir {
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(container_dir(home.path()).join("Data/Documents")).unwrap();
        home
    }

    #[test]
    fn the_id_and_hosts_come_from_officeapp_itself_not_from_comments_or_overrides() {
        let m = parse_manifest(manifest(FM, "Presentation").as_bytes()).unwrap();
        assert_eq!(m.id, FM);
        assert_eq!(m.version.as_deref(), Some("1.0.0"));
        assert_eq!(m.hosts, vec!["Presentation".to_string()]);
        assert!(m.is_for_powerpoint());
    }

    #[test]
    fn the_real_font_manager_manifest_parses() {
        // The v0.2.0 release asset's opening, verbatim in shape: XML
        // declaration, a long comment, the namespaced root.
        let real = include_str!("../tests/fixtures/font-manager-manifest.xml");
        let m = parse_manifest(real.as_bytes()).unwrap();
        assert_eq!(m.id, FM);
        assert!(m.is_for_powerpoint());
    }

    #[test]
    fn an_upper_case_id_is_the_same_add_in() {
        let m = parse_manifest(manifest(&FM.to_uppercase(), "Presentation").as_bytes()).unwrap();
        assert_eq!(m.id, FM);
        assert_eq!(addin_ids(&ids(&[&FM.to_uppercase()])), ids(&[FM]));
    }

    #[test]
    fn things_that_are_not_manifests_are_refused() {
        assert!(matches!(parse_manifest(b"<html><body>404</body></html>"), Err(ManifestError::NotAnAddin)));
        assert!(parse_manifest(b"not xml at all <").is_err());
        assert!(matches!(
            parse_manifest(b"<OfficeApp><Id>abc</Id></OfficeApp>"),
            Err(ManifestError::BadId(_))
        ));
        assert!(matches!(
            parse_manifest(b"<OfficeApp><Version>1.0</Version></OfficeApp>"),
            Err(ManifestError::NoId)
        ));
    }

    #[test]
    fn the_installed_name_is_the_catalogues_and_falls_back_to_the_projects() {
        use crate::model::Platform;
        let declared = ids(&["stoatworks-font-manager.xml"]);
        assert_eq!(
            install_name(&declared, "pptx-font-manager-addin", "Font Manager for PowerPoint", Platform::Macos),
            "stoatworks-font-manager.xml"
        );
        assert_eq!(
            install_name(&[], "pptx-font-manager-addin", "Font Manager for PowerPoint", Platform::Macos),
            "stoatworks-pptx-font-manager-addin.xml"
        );
        assert_eq!(
            install_name(&[], "pptx-font-manager-addin", "Font Manager for PowerPoint", Platform::Windows),
            "Font Manager for PowerPoint"
        );
    }

    #[test]
    fn bundle_identifiers_are_never_taken_for_add_in_ids() {
        let list = ids(&["com.stoatworks.ffgl.tinsel", FM]);
        assert_eq!(addin_ids(&list), ids(&[FM]));
    }

    #[test]
    fn a_manifest_for_another_host_or_another_add_in_is_not_installed() {
        let home = home_with_powerpoint();
        let word = manifest(FM, "Document");
        assert!(matches!(
            install_mac(home.path(), "stoatworks-font-manager.xml", word.as_bytes(), &ids(&[FM]), "b"),
            Err(AddinError::NotForPowerPoint)
        ));
        let other = manifest(EXPORTER, "Presentation");
        assert!(matches!(
            install_mac(home.path(), "stoatworks-font-manager.xml", other.as_bytes(), &ids(&[FM]), "b"),
            Err(AddinError::WrongAddin { .. })
        ));
        assert!(!wef_dir(home.path()).join("stoatworks-font-manager.xml").exists());
    }

    #[test]
    fn no_container_means_powerpoint_has_never_been_opened_and_nothing_is_made() {
        let home = TempDir::new().unwrap();
        let err = install_mac(
            home.path(),
            "stoatworks-font-manager.xml",
            manifest(FM, "Presentation").as_bytes(),
            &ids(&[FM]),
            "b",
        )
        .unwrap_err();
        assert!(matches!(err, AddinError::PowerPointNeverOpened));
        assert!(err.to_string().contains("Open PowerPoint once"));
        // Making the folder by hand would invent a container macOS never made.
        assert!(!container_dir(home.path()).exists());
    }

    #[test]
    fn a_mac_install_replaces_every_other_copy_of_the_same_add_in_and_nothing_else() {
        let home = home_with_powerpoint();
        let wef = wef_dir(home.path());
        std::fs::create_dir_all(&wef).unwrap();
        // The old sideload script's copy of this add-in, the Exporter's own
        // manifest, and a file that is not a manifest at all.
        std::fs::write(wef.join("pptx-font-manager.manifest.xml"), manifest(FM, "Presentation")).unwrap();
        std::fs::write(wef.join("stoatworks-advanced-exporter.xml"), manifest(EXPORTER, "Presentation")).unwrap();
        std::fs::write(wef.join("notes.xml"), "<notes/>").unwrap();

        let fresh = manifest(FM, "Presentation").replace("1.0.0", "1.0.1");
        let placed = install_mac(home.path(), "stoatworks-font-manager.xml", fresh.as_bytes(), &ids(&[FM]), "b1")
            .unwrap();
        assert_eq!(placed.removed, vec!["pptx-font-manager.manifest.xml".to_string()]);

        let mut left: Vec<String> = std::fs::read_dir(&wef)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        assert_eq!(left, vec!["notes.xml", "stoatworks-advanced-exporter.xml", "stoatworks-font-manager.xml"]);
        assert_eq!(std::fs::read_to_string(wef.join("stoatworks-font-manager.xml")).unwrap(), fresh);
    }

    #[test]
    fn a_mac_install_makes_the_wef_folder_when_powerpoint_has_none_yet() {
        let home = home_with_powerpoint();
        install_mac(
            home.path(),
            "stoatworks-font-manager.xml",
            manifest(FM, "Presentation").as_bytes(),
            &ids(&[FM]),
            "b",
        )
        .unwrap();
        assert!(wef_dir(home.path()).join("stoatworks-font-manager.xml").is_file());
    }

    #[test]
    fn a_name_from_the_catalogue_cannot_climb_out_of_wef() {
        let home = home_with_powerpoint();
        for bad in ["../evil.xml", "sub/dir.xml", ".hidden.xml", "manifest.txt", ""] {
            assert!(
                matches!(
                    install_mac(home.path(), bad, manifest(FM, "Presentation").as_bytes(), &ids(&[FM]), "b"),
                    Err(AddinError::BadName(_))
                ),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_mac_uninstall_takes_every_copy_of_this_add_in_and_leaves_the_rest() {
        let home = home_with_powerpoint();
        let wef = wef_dir(home.path());
        std::fs::create_dir_all(&wef).unwrap();
        std::fs::write(wef.join("stoatworks-font-manager.xml"), manifest(FM, "Presentation")).unwrap();
        std::fs::write(wef.join("pptx-font-manager.manifest.xml"), manifest(FM, "Presentation")).unwrap();
        std::fs::write(wef.join("stoatworks-advanced-exporter.xml"), manifest(EXPORTER, "Presentation")).unwrap();

        let removed = uninstall_mac(home.path(), &ids(&[FM])).unwrap();
        assert_eq!(removed, vec!["pptx-font-manager.manifest.xml", "stoatworks-font-manager.xml"]);
        assert!(wef.join("stoatworks-advanced-exporter.xml").exists());
        // Nothing left to find, and a second run is a no-op rather than an error.
        assert!(find_in_wef(&wef, &ids(&[FM])).is_empty());
        assert!(uninstall_mac(home.path(), &ids(&[FM])).unwrap().is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_in_wef_is_somebodys_working_copy_and_is_left_alone() {
        let home = home_with_powerpoint();
        let wef = wef_dir(home.path());
        std::fs::create_dir_all(&wef).unwrap();
        let elsewhere = home.path().join("checkout-manifest.xml");
        std::fs::write(&elsewhere, manifest(FM, "Presentation")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, wef.join("dev.xml")).unwrap();
        assert!(find_in_wef(&wef, &ids(&[FM])).is_empty());
        uninstall_mac(home.path(), &ids(&[FM])).unwrap();
        assert!(wef.join("dev.xml").exists());
    }

    /// The registry as a map, for the Windows logic on any machine.
    #[derive(Default)]
    struct FakeReg(BTreeMap<String, String>);
    impl Developer for FakeReg {
        fn get(&self, id: &str) -> io::Result<Option<String>> {
            Ok(self.0.get(&id.to_ascii_lowercase()).cloned())
        }
        fn set(&mut self, id: &str, path: &str) -> io::Result<()> {
            self.0.insert(id.to_ascii_lowercase(), path.to_string());
            Ok(())
        }
        fn remove(&mut self, id: &str) -> io::Result<()> {
            self.0.remove(&id.to_ascii_lowercase());
            Ok(())
        }
    }

    #[test]
    fn a_windows_install_writes_the_file_where_setup_exe_does_and_registers_it() {
        let root = TempDir::new().unwrap();
        let mut reg = FakeReg::default();
        reg.set(EXPORTER, r"C:\somewhere\exporter.xml").unwrap();

        let placed = install_windows(
            root.path(),
            "Font Manager for PowerPoint",
            manifest(FM, "Presentation").as_bytes(),
            &ids(&[FM]),
            "b",
            &mut reg,
        )
        .unwrap();
        let file = root.path().join("Font Manager for PowerPoint").join("manifest.xml");
        assert!(file.is_file());
        assert_eq!(reg.get(FM).unwrap(), Some(file.display().to_string()));
        assert_eq!(placed.previous, None);
        // Another add-in's registration is untouched.
        assert_eq!(reg.get(EXPORTER).unwrap().as_deref(), Some(r"C:\somewhere\exporter.xml"));

        let found = find_registered(&reg, &ids(&[FM]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sha256.as_deref(), Some(sha256_hex(manifest(FM, "Presentation").as_bytes()).as_str()));
    }

    #[test]
    fn a_windows_install_over_a_developer_registration_says_where_it_pointed() {
        let root = TempDir::new().unwrap();
        let mut reg = FakeReg::default();
        reg.set(FM, r"C:\dev\pptx-font-manager-addin\manifest.xml").unwrap();
        let placed = install_windows(
            root.path(),
            "Font Manager for PowerPoint",
            manifest(FM, "Presentation").as_bytes(),
            &ids(&[FM]),
            "b",
            &mut reg,
        )
        .unwrap();
        assert_eq!(placed.previous.as_deref(), Some(r"C:\dev\pptx-font-manager-addin\manifest.xml"));
    }

    #[test]
    fn a_windows_uninstall_keeps_a_file_it_did_not_put_there_and_folders_that_are_not_empty() {
        let root = TempDir::new().unwrap();
        let mut reg = FakeReg::default();
        install_windows(
            root.path(),
            "Font Manager for PowerPoint",
            manifest(FM, "Presentation").as_bytes(),
            &ids(&[FM]),
            "b",
            &mut reg,
        )
        .unwrap();
        // Setup.exe's own uninstaller and icon share the folder.
        let dir = root.path().join("Font Manager for PowerPoint");
        std::fs::write(dir.join("Uninstall.exe"), b"MZ").unwrap();

        let removed = uninstall_windows(root.path(), "Font Manager for PowerPoint", &ids(&[FM]), &mut reg).unwrap();
        assert_eq!(removed, vec![dir.join("manifest.xml").display().to_string()]);
        assert_eq!(reg.get(FM).unwrap(), None);
        assert!(!dir.join("manifest.xml").exists());
        assert!(dir.join("Uninstall.exe").exists(), "the folder is not Burrow's alone");

        // A registration pointing at a developer's checkout loses the value and
        // keeps the file.
        let checkout = TempDir::new().unwrap();
        let theirs = checkout.path().join("manifest.xml");
        std::fs::write(&theirs, manifest(FM, "Presentation")).unwrap();
        reg.set(FM, &theirs.display().to_string()).unwrap();
        uninstall_windows(root.path(), "Font Manager for PowerPoint", &ids(&[FM]), &mut reg).unwrap();
        assert_eq!(reg.get(FM).unwrap(), None);
        assert!(theirs.exists());
    }

    #[test]
    fn a_registration_whose_file_has_gone_is_found_without_a_checksum() {
        let mut reg = FakeReg::default();
        reg.set(FM, "/nowhere/manifest.xml").unwrap();
        let found = find_registered(&reg, &ids(&[FM]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sha256, None);
        let r = reconcile("fm", "powerpoint", &found, None, true, Some("v0.2.0"), Some("abc"));
        assert!(matches!(r.state, InstallState::VersionUnknown { .. }), "{:?}", r.state);
    }

    fn found(name: &str, sha: &str) -> Found {
        Found { name: name.into(), path: PathBuf::from(name), id: FM.into(), sha256: Some(sha.into()) }
    }

    fn record(version: &str, sha: &str) -> LedgerEntry {
        LedgerEntry {
            slug: "pptx-font-manager-addin".into(),
            format: Format::Powerpoint,
            destination_id: "powerpoint".into(),
            destination: PathBuf::from("/wef"),
            entries: vec!["stoatworks-font-manager.xml".into()],
            version: version.into(),
            installed_at: "epoch:0".into(),
            payload_sha256: sha.into(),
            claimed: false,
        }
    }

    #[test]
    fn the_current_releases_manifest_is_up_to_date_whoever_installed_it() {
        // Installed by the add-in's own .pkg: no ledger record at all.
        let r = reconcile("fm", "powerpoint", &[found("a.xml", "AAAA")], None, true, Some("v0.2.0"), Some("aaaa"));
        assert_eq!(
            r.state,
            InstallState::UpToDate { version: "v0.2.0".into(), source: VersionSource::Checksum }
        );
        assert!(!r.foreign);
    }

    #[test]
    fn what_burrow_installed_is_behind_once_the_catalogue_moves_on() {
        let r = reconcile(
            "fm",
            "powerpoint",
            &[found("a.xml", "old")],
            Some(&record("v0.2.0", "old")),
            true,
            Some("v0.3.0"),
            Some("new"),
        );
        assert!(
            matches!(r.state, InstallState::UpdateAvailable { ref installed, .. } if installed == "v0.2.0"),
            "{:?}",
            r.state
        );
    }

    #[test]
    fn a_manifest_nobody_can_place_is_version_unknown_and_so_is_a_duplicate() {
        let r = reconcile("fm", "powerpoint", &[found("a.xml", "zzz")], None, true, Some("v0.2.0"), Some("aaa"));
        assert!(matches!(r.state, InstallState::VersionUnknown { .. }));
        // Two copies, even if one is current: Reinstall is what leaves one.
        let r = reconcile(
            "fm",
            "powerpoint",
            &[found("a.xml", "aaa"), found("b.xml", "aaa")],
            None,
            true,
            Some("v0.2.0"),
            Some("aaa"),
        );
        assert!(matches!(r.state, InstallState::VersionUnknown { ref entries } if entries.len() == 2));
    }

    #[test]
    fn nothing_found_is_not_installed_and_no_asset_is_no_build() {
        let r = reconcile("fm", "powerpoint", &[], None, true, Some("v0.2.0"), Some("aaa"));
        assert_eq!(r.state, InstallState::NotInstalled);
        assert!(r.missing.is_empty());
        let r = reconcile("fm", "powerpoint", &[], None, false, Some("v0.2.0"), None);
        assert_eq!(r.state, InstallState::NoBuild);
    }
}
