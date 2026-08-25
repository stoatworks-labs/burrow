//! Unpacking a release archive, safely, and checking it is what it claims.
//!
//! Everything here runs before a single byte reaches a plugin directory. An
//! archive is extracted into a staging area, inspected, and only then moved
//! into place — so a malformed or hostile zip fails with the destination
//! untouched.

use crate::model::{Format, Platform};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Caps, chosen well above anything the fleet ships (the largest archive is
/// under 1 MB) and well below anything that would hurt.
const MAX_ENTRIES: usize = 10_000;
const MAX_UNCOMPRESSED: u64 = 512 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ArchiveError {
    NotAZip(String),
    /// An entry whose path escapes the extraction root.
    UnsafePath(String),
    /// A symlink member. Refused rather than recreated: a symlink inside a
    /// bundle would let the payload's content — and later its hash — depend on
    /// something outside the payload.
    Symlink(String),
    TooManyEntries(usize),
    TooLarge(u64),
    /// The archive unpacked, but not to the shape this format takes.
    UnexpectedLayout(String),
    Io(String),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveError::NotAZip(w) => write!(f, "that download was not a zip archive ({w})"),
            ArchiveError::UnsafePath(p) => {
                write!(f, "the archive contains a path that points outside it: {p}")
            }
            ArchiveError::Symlink(p) => write!(f, "the archive contains a symbolic link: {p}"),
            ArchiveError::TooManyEntries(n) => write!(f, "the archive has {n} entries"),
            ArchiveError::TooLarge(n) => write!(f, "the archive unpacks to {n} bytes"),
            ArchiveError::UnexpectedLayout(w) => {
                write!(f, "the archive is not laid out like a plugin download ({w})")
            }
            ArchiveError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for ArchiveError {
    fn from(e: io::Error) -> Self {
        ArchiveError::Io(e.to_string())
    }
}

/// A zip's magic bytes.
///
/// Checked before anything else because the realistic failure is not a corrupt
/// archive, it is *an HTML page*: a 404, a captive-portal login, or a
/// rate-limit notice saved under a `.zip` name. `pptx-font-manager` guards its
/// font downloads the same way, for the same reason.
pub fn looks_like_zip(head: &[u8]) -> bool {
    // "PK\x03\x04" for a normal archive; the other two are an empty archive and
    // a spanned one, accepted so the error says something more useful than
    // "not a zip" if either ever turns up.
    matches!(
        head.get(..4),
        Some(b"PK\x03\x04") | Some(b"PK\x05\x06") | Some(b"PK\x07\x08")
    )
}

/// A gzip member's magic bytes, for the Companion modules' `.tgz`.
///
/// Same guard as [`looks_like_zip`] and for the same reason: the realistic
/// failure is an HTML error page saved under the archive's name, and it is
/// worth saying so rather than reporting a tar parse error.
pub fn looks_like_gzip(head: &[u8]) -> bool {
    matches!(head.get(..2), Some(&[0x1f, 0x8b]))
}

/// Normalise one archive member path, or refuse it.
///
/// Refuses anything that is not a sequence of plain names: absolute paths,
/// `..`, drive letters, UNC prefixes. `./` is stripped rather than refused,
/// because `zip -r ./*` produces it legitimately.
///
/// This is done on the *textual* path before any filesystem call. Resolving
/// first and checking afterwards is the classic way to get this wrong.
fn safe_member_path(raw: &str) -> Result<Option<PathBuf>, ArchiveError> {
    if raw.is_empty() {
        return Err(ArchiveError::UnsafePath(raw.into()));
    }
    // Archive paths are always forward-slashed by spec; a backslash in one is
    // a literal character on Unix and a separator on Windows, which is exactly
    // the ambiguity an attacker wants.
    if raw.contains('\\') {
        return Err(ArchiveError::UnsafePath(raw.into()));
    }
    let mut out = PathBuf::new();
    for part in raw.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(ArchiveError::UnsafePath(raw.into())),
            _ => {
                // A Windows drive-relative or UNC-ish component.
                if part.contains(':') {
                    return Err(ArchiveError::UnsafePath(raw.into()));
                }
                out.push(part);
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Ok(None);
    }
    // Belt and braces: the assembled path must still be plain and relative.
    for c in out.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(ArchiveError::UnsafePath(raw.into()));
        }
    }
    Ok(Some(out))
}

/// Archive members that are macOS packaging debris rather than payload.
///
/// `__MACOSX/` and `._*` are resource-fork shadows that `zip` on macOS adds;
/// `.DS_Store` is Finder's. None of them are part of a plugin, and if they were
/// treated as top-level entries the ledger would claim ownership of a
/// `.DS_Store` and delete it on uninstall.
fn is_debris(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "__MACOSX" || s == ".DS_Store" || s.starts_with("._")
    })
}

/// What came out of an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unpacked {
    /// Names a host loads, each one directly inside the staging directory.
    /// These are what get placed.
    ///
    /// Always plain names, never paths, even when the archive nested them —
    /// see [`collect_payload`].
    pub entries: Vec<String>,
    /// Top-level names that are not payload — docs, sample assets, a helper
    /// binary. Kept, but never placed in a plugin directory.
    pub extras: Vec<String>,
}

fn is_payload_name(name: &str, format: Format) -> bool {
    let lower = name.to_ascii_lowercase();
    format
        .payload_extensions()
        .iter()
        .any(|e| lower.ends_with(e))
}

/// Whether a name is an artefact of *some* format Burrow installs.
///
/// Used only to decide what counts as an extra. The audio plugins ship one
/// archive holding `VST3/`, `AU/` and `Standalone/`, and when the VST3 is being
/// installed the other two are neither payload nor "documentation that shipped
/// alongside" — they are the same product in another format, which the user
/// installs from another slot. Calling them extras would put
/// "MixerReturn ships AU, Standalone alongside the plugin" in front of someone,
/// which is both alarming and untrue.
fn is_any_payload_name(name: &str) -> bool {
    Format::SHIPPING
        .iter()
        .any(|f| is_payload_name(name, *f))
}

/// How deep [`collect_payload`] will look for an artefact.
///
/// Two is enough for everything the fleet ships: a video plugin's bundle sits
/// at the top of its archive, and an audio plugin's `VST3/Thing.vst3` one
/// level down. The limit is here so that a malformed archive costs a bounded
/// walk rather than a full tree traversal, and so that "the payload is buried
/// six levels down" fails loudly instead of quietly installing something found
/// in a corner.
const MAX_PAYLOAD_DEPTH: usize = 2;

/// Find this format's artefacts in an extracted tree, and bring them to the
/// top of it.
///
/// **This is the rule that replaces "copy every top-level entry".** An entry is
/// payload because its name ends the way this format's artefacts end — a
/// `.vst3` for VST3, a `.component` for an Audio Unit, a `.app` for an
/// application — and everything else in the archive is an extra, whatever it
/// is. That is what makes it safe to install from an archive nobody probed in
/// advance: a `README.md` is not a `.vst3` and never will be.
///
/// The search is breadth-first and stops at the shallowest level that matches,
/// which is what keeps it from descending into an artefact it has already
/// found. The three audio plugins ship `VST3/`, `AU/` and `Standalone/` side by
/// side in one archive, and each format takes exactly its own.
///
/// Matches are then **flattened**: moved to the root of the staging directory
/// so that everything downstream — layout validation, hashing, quarantine
/// clearing, the commit, the ledger and the privileged helper's plan — keeps
/// dealing in plain one-component names. Nesting is an archive's business and
/// stops here.
fn collect_payload(
    dest: &Path,
    format: Format,
    platform: Platform,
    install_name: Option<&str>,
) -> Result<Unpacked, ArchiveError> {
    let tops = read_names(dest)?;
    if tops.is_empty() {
        return Err(ArchiveError::UnexpectedLayout("it is empty".into()));
    }

    if format.payload_is_whole_archive(platform) {
        let Some(name) = install_name else {
            return Err(ArchiveError::UnexpectedLayout(format!(
                "a {} needs a name from the catalogue, and none was given",
                format.label()
            )));
        };
        return whole_archive(dest, name, &tops, format);
    }

    // Breadth-first, shallowest wins.
    let mut level: Vec<PathBuf> = tops.iter().map(PathBuf::from).collect();
    let mut found: Vec<PathBuf> = Vec::new();
    for _ in 0..MAX_PAYLOAD_DEPTH {
        found = level
            .iter()
            .filter(|rel| {
                rel.file_name()
                    .map(|n| is_payload_name(&n.to_string_lossy(), format))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if !found.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for rel in &level {
            if dest.join(rel).is_dir() {
                for name in read_names(&dest.join(rel))? {
                    next.push(rel.join(name));
                }
            }
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }

    if found.is_empty() {
        return Err(ArchiveError::UnexpectedLayout(format!(
            "nothing in it is a {} a host could load",
            format.label()
        )));
    }

    // Everything found lands at the top under its own name. A collision means
    // two artefacts of one format would have to occupy the same destination
    // name, which no host could tell apart — better said out loud than
    // resolved by whichever one happened to be moved second.
    let mut entries: Vec<String> = Vec::new();
    let mut nested_roots: BTreeSet<String> = BTreeSet::new();
    for rel in &found {
        let name = rel
            .file_name()
            .ok_or_else(|| ArchiveError::UnexpectedLayout("an entry with no name".into()))?
            .to_string_lossy()
            .to_string();
        if entries.contains(&name) {
            return Err(ArchiveError::UnexpectedLayout(format!(
                "it holds two things called {name}"
            )));
        }
        if rel.components().count() > 1 {
            if let Some(Component::Normal(top)) = rel.components().next() {
                nested_roots.insert(top.to_string_lossy().to_string());
            }
            fs::rename(dest.join(rel), dest.join(&name))?;
        }
        entries.push(name);
    }
    entries.sort();

    // A directory that existed only to hold an artefact is not an extra —
    // neither the one this install took nor the ones another format will.
    let extras = tops
        .into_iter()
        .filter(|t| {
            if entries.contains(t) || nested_roots.contains(t) {
                return false;
            }
            let p = dest.join(t);
            if !p.is_dir() {
                return true;
            }
            !read_names(&p)
                .map(|kids| kids.iter().any(|k| is_any_payload_name(k)))
                .unwrap_or(false)
        })
        .collect();

    Ok(Unpacked { entries, extras })
}

/// Gather everything the archive unpacked to into one directory called `name`.
///
/// Two shapes, because both occur. `npm pack` and most Windows zips wrap
/// everything in a single directory, which is simply renamed. electron-builder
/// writes its zips flat — the `.exe`, its DLLs and `resources/` all at the top
/// — and those are gathered.
///
/// The gathering goes via a temporary name so that an archive already
/// containing something called `name` cannot collide with the directory being
/// built around it.
fn whole_archive(
    dest: &Path,
    name: &str,
    tops: &[String],
    format: Format,
) -> Result<Unpacked, ArchiveError> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(ArchiveError::UnsafePath(name.into()));
    }

    let root = if tops.len() == 1 && dest.join(&tops[0]).is_dir() {
        let only = &tops[0];
        if only != name {
            fs::rename(dest.join(only), dest.join(name))?;
        }
        dest.join(name)
    } else {
        let gather = dest.join(format!(".burrow-gather-{}", std::process::id()));
        fs::create_dir_all(&gather)?;
        for t in tops {
            fs::rename(dest.join(t), gather.join(t))?;
        }
        fs::rename(&gather, dest.join(name))?;
        dest.join(name)
    };

    if format == Format::Companion && !root.join("package.json").is_file() {
        return Err(ArchiveError::UnexpectedLayout(
            "there is no package.json in it, so Companion would not load it".into(),
        ));
    }
    if format == Format::App
        && !walk_shallow(&root)?
            .iter()
            .any(|n| n.to_ascii_lowercase().ends_with(".exe"))
    {
        return Err(ArchiveError::UnexpectedLayout(
            "there is no .exe in it, so it is not an application".into(),
        ));
    }

    Ok(Unpacked { entries: vec![name.to_string()], extras: Vec::new() })
}

/// The names one and two levels inside a directory. Enough to find the `.exe`
/// in a Windows program folder, whether it sits at the top or under a
/// `bin/`-style subdirectory, without walking a whole tree to answer a
/// yes/no question.
fn walk_shallow(dir: &Path) -> Result<Vec<String>, ArchiveError> {
    let mut out = read_names(dir)?;
    for name in out.clone() {
        let p = dir.join(&name);
        if p.is_dir() {
            out.extend(read_names(&p)?);
        }
    }
    Ok(out)
}

/// The names directly inside a directory, sorted, skipping packaging debris.
fn read_names(dir: &Path) -> Result<Vec<String>, ArchiveError> {
    let mut out: Vec<String> = Vec::new();
    for e in fs::read_dir(dir)? {
        let name = e?.file_name().to_string_lossy().to_string();
        if is_debris(Path::new(&name)) {
            continue;
        }
        out.push(name);
    }
    out.sort();
    Ok(out)
}

/// Extract an archive into `dest`, which must be empty, and return what of it
/// this format actually installs.
///
/// `install_name` is the name the payload must end up under for the formats
/// that install a whole archive rather than named artefacts — a Companion
/// module, and an application on Windows. Ignored by every other format. See
/// [`Format::payload_is_whole_archive`].
pub fn extract(
    src: &Path,
    dest: &Path,
    format: Format,
    platform: Platform,
    install_name: Option<&str>,
) -> Result<Unpacked, ArchiveError> {
    let mut head = [0u8; 4];
    {
        use std::io::Read;
        let mut f = fs::File::open(src)?;
        let _ = f.read(&mut head)?;
    }

    // The magic check comes before anything is created: a 404 page saved under
    // an archive's name must leave the staging directory untouched.
    let zip = looks_like_zip(&head);
    if !zip && !looks_like_gzip(&head) {
        return Err(ArchiveError::NotAZip(
            "it starts with something else — most likely an error page".into(),
        ));
    }
    fs::create_dir_all(dest)?;
    if zip {
        unpack_zip(src, dest)?;
    } else {
        unpack_tgz(src, dest)?;
    }

    collect_payload(dest, format, platform, install_name)
}

/// Where an extracted member is allowed to land, or an error.
///
/// Shared by both containers so a tarball gets exactly the same treatment as a
/// zip: no absolute paths, no `..`, no symlinks, no packaging debris, and a
/// final check on where the assembled path actually points.
fn member_target(raw: &str, dest: &Path) -> Result<Option<PathBuf>, ArchiveError> {
    let Some(rel) = safe_member_path(raw)? else {
        return Ok(None);
    };
    if is_debris(&rel) {
        return Ok(None);
    }
    let out = dest.join(&rel);
    // The final structural guard. Everything above is textual; this catches
    // anything that slipped through by checking where the path actually landed.
    if !out.starts_with(dest) {
        return Err(ArchiveError::UnsafePath(raw.into()));
    }
    Ok(Some(out))
}

fn unpack_zip(zip_path: &Path, dest: &Path) -> Result<(), ArchiveError> {
    let file = fs::File::open(zip_path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| ArchiveError::NotAZip(e.to_string()))?;

    if zip.len() > MAX_ENTRIES {
        return Err(ArchiveError::TooManyEntries(zip.len()));
    }
    let declared: u64 = (0..zip.len())
        .filter_map(|i| zip.by_index_raw(i).ok().map(|f| f.size()))
        .sum();
    if declared > MAX_UNCOMPRESSED {
        return Err(ArchiveError::TooLarge(declared));
    }

    for i in 0..zip.len() {
        let mut member = zip
            .by_index(i)
            .map_err(|e| ArchiveError::NotAZip(e.to_string()))?;
        let raw = member.name().to_string();

        if let Some(mode) = member.unix_mode() {
            const S_IFMT: u32 = 0o170000;
            const S_IFLNK: u32 = 0o120000;
            if mode & S_IFMT == S_IFLNK {
                return Err(ArchiveError::Symlink(raw));
            }
        }

        let Some(out) = member_target(&raw, dest)? else {
            continue;
        };

        if member.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut sink = fs::File::create(&out)?;
        io::copy(&mut member, &mut sink)?;

        // Restore the executable bit. A plugin's binary is stripped of it by
        // some packaging paths, and a bundle whose executable is not
        // executable fails to load with an error that says nothing useful.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = member.unix_mode() {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o777));
            }
        }
    }
    Ok(())
}

/// Unpack a gzipped tarball — the Companion modules, and nothing else.
///
/// Written out rather than handed to `tar::Archive::unpack`, which resolves
/// paths itself and would take the safety decisions out of this file. The caps
/// are applied to the *decompressed* stream as it is read, because a tarball
/// declares no total size up front: a gzip bomb is a stream that never ends,
/// not a header that admits to being enormous.
fn unpack_tgz(src: &Path, dest: &Path) -> Result<(), ArchiveError> {
    let file = fs::File::open(src)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut count = 0usize;
    let mut total = 0u64;

    for member in tar.entries().map_err(|e| ArchiveError::NotAZip(e.to_string()))? {
        let mut member = member.map_err(|e| ArchiveError::NotAZip(e.to_string()))?;
        let raw = member
            .path()
            .map_err(|e| ArchiveError::UnsafePath(e.to_string()))?
            .to_string_lossy()
            .to_string();

        count += 1;
        if count > MAX_ENTRIES {
            return Err(ArchiveError::TooManyEntries(count));
        }
        total = total.saturating_add(member.size());
        if total > MAX_UNCOMPRESSED {
            return Err(ArchiveError::TooLarge(total));
        }

        let kind = member.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(ArchiveError::Symlink(raw));
        }

        let Some(out) = member_target(&raw, dest)? else {
            continue;
        };

        if kind.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if !kind.is_file() {
            // Devices, fifos and the rest have no business in a module
            // package, and recreating one is not something this should be
            // able to do.
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let mode = member.header().mode().ok();
        let mut sink = fs::File::create(&out)?;
        io::copy(&mut member, &mut sink)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = mode {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o777));
            }
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

/// Check an unpacked payload is the shape this format takes on this platform.
///
/// Extraction has already established that each entry's *name* is right for
/// the format. This checks the thing a name cannot tell you: that the artefact
/// is built the way the format requires — in particular, that a bundle's
/// binary is in the architecture directory the host will actually read.
///
/// That second one is worth the effort because of how it fails. A host reads
/// exactly one architecture directory inside an OFX bundle, and only macOS
/// falls back to `Contents/MacOS`. A Windows bundle whose binary sits in
/// `Contents/MacOS` is not *broken* — it is **invisible**. The scan finds
/// nothing and says nothing, which is indistinguishable from the plugin not
/// being installed.
pub fn validate_layout(
    staged: &Path,
    unpacked: &Unpacked,
    format: Format,
    platform: Platform,
) -> Result<(), ArchiveError> {
    for name in &unpacked.entries {
        let p = staged.join(name);
        let is_dir = p.is_dir();

        match (format, platform) {
            (Format::Ffgl, Platform::Macos) => {
                if !is_dir || !p.join("Contents").join("Info.plist").is_file() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} is not a macOS bundle"
                    )));
                }
            }
            (Format::Ffgl, Platform::Windows) => {
                if is_dir {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} should be a .dll file"
                    )));
                }
            }
            (Format::Openfx, Platform::Macos) => {
                if !is_dir || !p.join("Contents").join("MacOS").is_dir() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} has no Contents/MacOS"
                    )));
                }
            }
            (Format::Openfx, Platform::Windows) => {
                if !is_dir || !p.join("Contents").join("Win64").is_dir() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} has no Contents/Win64 — a host reads exactly one \
                         architecture directory, and would not see this at all"
                    )));
                }
            }
            (Format::Adobe, Platform::Macos) => {
                if !is_dir || !p.join("Contents").join("Info.plist").is_file() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} is not a .plugin bundle"
                    )));
                }
            }
            (Format::Adobe, Platform::Windows) if is_dir => {
                return Err(ArchiveError::UnexpectedLayout(format!(
                    "{name} should be an .aex file"
                )))
            }
            // A VST3 and an Audio Unit are both macOS bundles, and an Audio
            // Unit that Logic will load must carry its Info.plist: that is
            // where the component's type, subtype and manufacturer codes live,
            // and a Components entry without them is registered by nothing.
            (Format::Vst3, Platform::Macos) | (Format::Au, Platform::Macos) => {
                if !is_dir || !p.join("Contents").join("Info.plist").is_file() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} is not a macOS bundle"
                    )));
                }
            }
            // On Windows a VST3 is either a plain DLL under a .vst3 name or a
            // bundle folder with the binary under Contents/x86_64-win. Both are
            // valid and hosts read both, so the only thing worth refusing is a
            // directory that is neither.
            (Format::Vst3, Platform::Windows) => {
                if is_dir && !p.join("Contents").is_dir() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} is a folder with no Contents — no host would load it"
                    )));
                }
            }
            (Format::App, Platform::Macos) => {
                if !is_dir || !p.join("Contents").join("MacOS").is_dir() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} is not an application bundle"
                    )));
                }
            }
            // The Windows and Companion cases are settled during extraction,
            // where the whole archive becomes one directory: an application
            // without an .exe and a module without a package.json are both
            // refused there, before anything is staged.
            (Format::Companion, _) => {
                if !is_dir || !p.join("package.json").is_file() {
                    return Err(ArchiveError::UnexpectedLayout(format!(
                        "{name} has no package.json, so Companion would not load it"
                    )));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::SimpleFileOptions;

    /// Build a zip in-test rather than committing binary fixtures, so the
    /// adversarial cases are readable in the source.
    fn make_zip(path: &Path, members: &[(&str, Option<&[u8]>)]) {
        let f = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        for (name, body) in members {
            match body {
                None => w.add_directory(*name, opts).unwrap(),
                Some(bytes) => {
                    w.start_file(*name, opts).unwrap();
                    w.write_all(bytes).unwrap();
                }
            }
        }
        w.finish().unwrap();
    }

    fn bundle_members(name: &str) -> Vec<(String, Option<Vec<u8>>)> {
        vec![
            (format!("{name}/"), None),
            (format!("{name}/Contents/"), None),
            (format!("{name}/Contents/Info.plist"), Some(b"<plist/>".to_vec())),
            (format!("{name}/Contents/MacOS/"), None),
            (format!("{name}/Contents/MacOS/bin"), Some(b"MZ".to_vec())),
        ]
    }

    fn as_refs(v: &[(String, Option<Vec<u8>>)]) -> Vec<(&str, Option<&[u8]>)> {
        v.iter()
            .map(|(n, b)| (n.as_str(), b.as_deref()))
            .collect()
    }

    #[test]
    fn extracts_a_real_single_bundle_archive() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let m = bundle_members("Tinsel.bundle");
        make_zip(&z, &as_refs(&m));

        let out = t.path().join("out");
        let got = extract(&z, &out, Format::Ffgl, Platform::Macos, None).unwrap();
        assert_eq!(got.entries, vec!["Tinsel.bundle".to_string()]);
        assert!(got.extras.is_empty());
        assert!(out.join("Tinsel.bundle/Contents/Info.plist").is_file());
        validate_layout(&out, &got, Format::Ffgl, Platform::Macos).unwrap();
    }

    #[test]
    fn extracts_a_two_bundle_archive() {
        // downpour ships Downpour.bundle and Downpour Over.bundle.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let mut m = bundle_members("Downpour.bundle");
        m.extend(bundle_members("Downpour Over.bundle"));
        make_zip(&z, &as_refs(&m));

        let got = extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None).unwrap();
        assert_eq!(
            got.entries,
            vec!["Downpour Over.bundle".to_string(), "Downpour.bundle".to_string()]
        );
    }

    #[test]
    fn separates_sample_assets_from_the_plugin() {
        // burin ships example-plate.svg beside its two bundles; flipbook ships
        // example-sheet.png; cartridge ships a LICENSE, a README and a helper.
        // None of those may reach the plugin folder.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let mut m = bundle_members("Cartridge.bundle");
        m.push(("LICENSE".into(), Some(b"MIT".to_vec())));
        m.push(("README.md".into(), Some(b"# hi".to_vec())));
        m.push(("cartridge-helper".into(), Some(b"MZ".to_vec())));
        m.push(("docs/".into(), None));
        m.push(("docs/guide.md".into(), Some(b"x".to_vec())));
        make_zip(&z, &as_refs(&m));

        let got = extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None).unwrap();
        assert_eq!(got.entries, vec!["Cartridge.bundle".to_string()]);
        assert_eq!(
            got.extras,
            vec![
                "LICENSE".to_string(),
                "README.md".to_string(),
                "cartridge-helper".to_string(),
                "docs".to_string()
            ]
        );
    }

    #[test]
    fn an_html_error_page_is_refused_before_anything_is_written() {
        // The realistic failure: a 404 or a captive portal saved as a .zip.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        fs::write(&z, b"<!DOCTYPE html><html>Not Found</html>").unwrap();
        let out = t.path().join("out");
        assert!(matches!(extract(&z, &out, Format::Ffgl, Platform::Macos, None), Err(ArchiveError::NotAZip(_))));
        assert!(!out.exists());
    }

    #[test]
    fn refuses_a_traversing_member() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("../../etc/passwd", Some(b"pwned".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None),
            Err(ArchiveError::UnsafePath(_))
        ));
        assert!(!t.path().join("etc").exists());
    }

    #[test]
    fn refuses_an_absolute_member() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("/tmp/evil.bundle/x", Some(b"x".as_slice()))]);
        // A leading "/" yields an empty first component, which is stripped —
        // so this must land inside dest, never at /tmp.
        let out = t.path().join("out");
        let _ = extract(&z, &out, Format::Ffgl, Platform::Macos, None);
        assert!(!Path::new("/tmp/evil.bundle").exists());
    }

    #[test]
    fn refuses_a_backslash_member() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[(r"..\..\evil.dll", Some(b"x".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None),
            Err(ArchiveError::UnsafePath(_))
        ));
    }

    #[test]
    fn strips_a_leading_dot_slash() {
        // `zip -r ./*` produces these legitimately.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("./Tinsel.dll", Some(b"MZ".as_slice()))]);
        let got = extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None).unwrap();
        assert_eq!(got.entries, vec!["Tinsel.dll".to_string()]);
    }

    #[test]
    fn ignores_macos_packaging_debris() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let mut m = bundle_members("Tinsel.bundle");
        m.push(("__MACOSX/".into(), None));
        m.push(("__MACOSX/._Tinsel.bundle".into(), Some(b"x".to_vec())));
        m.push((".DS_Store".into(), Some(b"x".to_vec())));
        make_zip(&z, &as_refs(&m));

        let got = extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None).unwrap();
        // Crucially not listed as an entry OR an extra — the ledger must never
        // claim ownership of a .DS_Store it would later delete.
        assert_eq!(got.entries, vec!["Tinsel.bundle".to_string()]);
        assert!(got.extras.is_empty());
    }

    #[test]
    fn refuses_an_archive_with_nothing_loadable_in_it() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("README.md", Some(b"# docs".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Ffgl, Platform::Macos, None),
            Err(ArchiveError::UnexpectedLayout(_))
        ));
    }

    #[test]
    fn a_wrapping_directory_is_looked_through_and_the_payload_brought_to_the_top() {
        // The org does produce these: the ofx-bridge download wraps everything
        // in a top-level folder, and the audio plugins ship VST3/, AU/ and
        // Standalone/ side by side in one archive.
        //
        // This used to be refused outright, back when payload meant "a
        // top-level entry with the right suffix". It is now found one level
        // down and flattened, so everything after extraction still deals in
        // plain names — and the wrapper is not reported as an extra, because
        // "bridge-1.0 shipped alongside the plugin" would be nonsense.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(
            &z,
            &[
                ("bridge-1.0/", None),
                ("bridge-1.0/Thing.bundle/", None),
                ("bridge-1.0/Thing.bundle/Contents/Info.plist", Some(b"<plist/>".as_slice())),
            ],
        );
        let out = t.path().join("out");
        let got = extract(&z, &out, Format::Ffgl, Platform::Macos, None).unwrap();
        assert_eq!(got.entries, vec!["Thing.bundle".to_string()]);
        assert!(got.extras.is_empty());
        assert!(out.join("Thing.bundle/Contents/Info.plist").is_file());
        validate_layout(&out, &got, Format::Ffgl, Platform::Macos).unwrap();
    }

    #[test]
    fn each_audio_format_takes_only_its_own_artefact_from_the_shared_archive() {
        // One zip, three formats: zero-eq, contourtonist and mixerreturn all
        // ship VST3/, AU/ and Standalone/ together, and the VST3 install must
        // not carry an Audio Unit into the VST3 folder.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(
            &z,
            &[
                ("VST3/", None),
                ("VST3/Zero EQ.vst3/", None),
                ("VST3/Zero EQ.vst3/Contents/Info.plist", Some(b"<plist/>".as_slice())),
                ("AU/", None),
                ("AU/Zero EQ.component/", None),
                ("AU/Zero EQ.component/Contents/Info.plist", Some(b"<plist/>".as_slice())),
                ("Standalone/", None),
                ("Standalone/Zero EQ.app/", None),
                ("Standalone/Zero EQ.app/Contents/Info.plist", Some(b"<plist/>".as_slice())),
                ("README.md", Some(b"# hi".as_slice())),
            ],
        );

        for (format, want) in [
            (Format::Vst3, "Zero EQ.vst3"),
            (Format::Au, "Zero EQ.component"),
            (Format::App, "Zero EQ.app"),
        ] {
            let out = t.path().join(format!("out-{}", format.id()));
            let got = extract(&z, &out, format, Platform::Macos, None).unwrap();
            assert_eq!(got.entries, vec![want.to_string()], "{}", format.label());
            // The other two formats' folders are not "extras that shipped
            // alongside" either — they are simply not this install's business.
            assert_eq!(got.extras, vec!["README.md".to_string()]);
            assert!(out.join(want).is_dir());
        }
    }

    fn make_tgz(path: &Path, members: &[(&str, Option<&[u8]>)]) {
        let f = fs::File::create(path).unwrap();
        let enc = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
        let mut tar = tar::Builder::new(enc);
        for (name, body) in members {
            let mut h = tar::Header::new_gnu();
            match body {
                Some(b) => {
                    h.set_size(b.len() as u64);
                    h.set_entry_type(tar::EntryType::Regular);
                    h.set_mode(0o644);
                    h.set_cksum();
                    tar.append_data(&mut h, name, *b).unwrap();
                }
                None => {
                    h.set_size(0);
                    h.set_entry_type(tar::EntryType::Directory);
                    h.set_mode(0o755);
                    h.set_cksum();
                    tar.append_data(&mut h, name, std::io::empty()).unwrap();
                }
            }
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn a_companion_module_is_renamed_out_of_npms_package_directory() {
        // What `npm pack` produces, which is what every module in the fleet
        // publishes: one `package/` root that says nothing about which module
        // it is. The name has to come from the catalogue.
        let t = TempDir::new().unwrap();
        let z = t.path().join("m.tgz");
        make_tgz(
            &z,
            &[
                ("package/", None),
                ("package/package.json", Some(br#"{"name":"flock"}"#.as_slice())),
                ("package/main.js", Some(b"//".as_slice())),
            ],
        );

        let out = t.path().join("out");
        let got = extract(&z, &out, Format::Companion, Platform::Macos, Some("companion-module-flock"))
            .unwrap();
        assert_eq!(got.entries, vec!["companion-module-flock".to_string()]);
        assert!(out.join("companion-module-flock/package.json").is_file());
        validate_layout(&out, &got, Format::Companion, Platform::Macos).unwrap();
    }

    #[test]
    fn a_tarball_that_is_not_a_module_is_refused() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("m.tgz");
        make_tgz(&z, &[("package/", None), ("package/README.md", Some(b"# hi".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Companion, Platform::Macos, Some("m")),
            Err(ArchiveError::UnexpectedLayout(_))
        ));
    }

    /// A tarball with one member, written by hand.
    ///
    /// `tar::Builder` refuses to *write* a traversing path, which is decent of
    /// it and useless for testing the reader. A tar header is 512 bytes of
    /// fixed fields, so the hostile archive is assembled directly.
    fn make_raw_tgz(path: &Path, name: &str, body: &[u8]) {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(b"0000644");
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        let size = format!("{:011o}\0", body.len());
        header[124..136].copy_from_slice(size.as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        // The checksum is computed with its own field read as spaces.
        header[148..156].copy_from_slice(b"        ");
        header[156] = b'0';
        let sum: u32 = header.iter().map(|b| *b as u32).sum();
        let chk = format!("{sum:06o}\0 ");
        header[148..156].copy_from_slice(chk.as_bytes());

        let mut raw = header.to_vec();
        raw.extend_from_slice(body);
        raw.resize(raw.len().div_ceil(512) * 512, 0);
        raw.extend_from_slice(&[0u8; 1024]);

        use std::io::Write;
        let mut enc =
            flate2::write::GzEncoder::new(fs::File::create(path).unwrap(), flate2::Compression::fast());
        enc.write_all(&raw).unwrap();
        enc.finish().unwrap();
    }

    #[test]
    fn a_tarball_member_that_escapes_is_refused_like_a_zip_members_would_be() {
        // The tar path is newer than the zip path and gets the same guards, so
        // it gets the same test.
        let t = TempDir::new().unwrap();
        let z = t.path().join("m.tgz");
        make_raw_tgz(&z, "../../etc/passwd", b"pwned");
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Companion, Platform::Macos, Some("m")),
            Err(ArchiveError::UnsafePath(_))
        ));
        assert!(!t.path().join("etc").exists());
    }

    #[test]
    fn a_windows_application_is_gathered_whole_rather_than_reduced_to_its_exe() {
        // electron-builder writes its Windows zips flat. Placing just the .exe
        // — the obvious reading of "install the app" — would put something in
        // Programs that cannot start, because the DLLs and resources beside it
        // are the rest of the application.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(
            &z,
            &[
                ("animATEM.exe", Some(b"MZ".as_slice())),
                ("ffmpeg.dll", Some(b"MZ".as_slice())),
                ("resources/", None),
                ("resources/app.asar", Some(b"x".as_slice())),
            ],
        );

        let out = t.path().join("out");
        let got = extract(&z, &out, Format::App, Platform::Windows, Some("animATEM")).unwrap();
        assert_eq!(got.entries, vec!["animATEM".to_string()]);
        assert!(out.join("animATEM/animATEM.exe").is_file());
        assert!(out.join("animATEM/resources/app.asar").is_file());
        assert!(got.extras.is_empty());
    }

    #[test]
    fn a_windows_zip_that_already_wraps_itself_is_not_wrapped_twice() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(
            &z,
            &[("srt-router-0.2.0/", None), ("srt-router-0.2.0/srt-router.exe", Some(b"MZ".as_slice()))],
        );
        let out = t.path().join("out");
        let got = extract(&z, &out, Format::App, Platform::Windows, Some("SRT Router")).unwrap();
        assert_eq!(got.entries, vec!["SRT Router".to_string()]);
        assert!(out.join("SRT Router/srt-router.exe").is_file());
    }

    #[test]
    fn a_windows_archive_with_no_executable_in_it_is_refused() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("README.md", Some(b"# hi".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::App, Platform::Windows, Some("Thing")),
            Err(ArchiveError::UnexpectedLayout(_))
        ));
    }

    #[test]
    fn an_install_name_that_is_a_path_is_refused() {
        // The name comes from the catalogue, which comes off the network. It
        // ends up as a directory name inside Programs, so it is checked here
        // rather than trusted.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("x.exe", Some(b"MZ".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::App, Platform::Windows, Some("../evil")),
            Err(ArchiveError::UnsafePath(_))
        ));
    }

    #[test]
    fn an_archive_with_no_artefact_of_that_format_is_refused() {
        // A VST3-only archive asked for an Audio Unit: "no build" is the
        // honest answer, and installing the .vst3 into Components would
        // produce a plugin Logic silently ignores.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("Thing.vst3/", None), ("Thing.vst3/x", Some(b"x".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out"), Format::Au, Platform::Macos, None),
            Err(ArchiveError::UnexpectedLayout(_))
        ));
    }

    #[test]
    fn a_windows_openfx_bundle_without_win64_is_rejected() {
        // This is the invisible-plugin case: a host reads exactly one
        // architecture directory and would simply never list this.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let m = bundle_members("Tinsel.ofx.bundle"); // has Contents/MacOS
        make_zip(&z, &as_refs(&m));
        let out = t.path().join("out");
        let got = extract(&z, &out, Format::Ffgl, Platform::Macos, None).unwrap();
        let err = validate_layout(&out, &got, Format::Openfx, Platform::Windows).unwrap_err();
        assert!(matches!(err, ArchiveError::UnexpectedLayout(_)));
    }

    #[test]
    fn a_windows_ffgl_payload_must_be_a_file_not_a_directory() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        let m = bundle_members("Tinsel.bundle");
        make_zip(&z, &as_refs(&m));
        let out = t.path().join("out");
        let got = extract(&z, &out, Format::Ffgl, Platform::Macos, None).unwrap();
        assert!(validate_layout(&out, &got, Format::Ffgl, Platform::Windows).is_err());
    }

    #[test]
    fn zip_magic_recognises_a_zip_and_rejects_html() {
        assert!(looks_like_zip(b"PK\x03\x04rest"));
        assert!(!looks_like_zip(b"<!DO"));
        assert!(!looks_like_zip(b""));
    }
}
