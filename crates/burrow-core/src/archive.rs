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
    /// Top-level names a host loads. These are what get placed.
    pub entries: Vec<String>,
    /// Top-level names that are not payload — docs, sample assets, a helper
    /// binary. Kept, but never placed in a plugin directory.
    pub extras: Vec<String>,
}

/// The extensions that make a top-level entry something a host loads.
/// `.ofx.bundle` is covered by `.bundle`.
const PAYLOAD_EXTENSIONS: &[&str] = &[".bundle", ".plugin", ".dll", ".ofx", ".aex"];

fn is_payload_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    PAYLOAD_EXTENSIONS.iter().any(|e| lower.ends_with(e))
}

/// Extract an archive into `dest`, which must be empty.
///
/// Returns the top-level names, split into payload and extras.
pub fn extract(zip_path: &Path, dest: &Path) -> Result<Unpacked, ArchiveError> {
    let mut head = [0u8; 4];
    {
        use std::io::Read;
        let mut f = fs::File::open(zip_path)?;
        let _ = f.read(&mut head)?;
    }
    if !looks_like_zip(&head) {
        return Err(ArchiveError::NotAZip(
            "it starts with something else — most likely an error page".into(),
        ));
    }

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

    fs::create_dir_all(dest)?;
    let mut tops: BTreeSet<String> = BTreeSet::new();

    for i in 0..zip.len() {
        let mut member = zip
            .by_index(i)
            .map_err(|e| ArchiveError::NotAZip(e.to_string()))?;
        let raw = member.name().to_string();

        let Some(rel) = safe_member_path(&raw)? else {
            continue;
        };
        if is_debris(&rel) {
            continue;
        }

        if let Some(mode) = member.unix_mode() {
            const S_IFMT: u32 = 0o170000;
            const S_IFLNK: u32 = 0o120000;
            if mode & S_IFMT == S_IFLNK {
                return Err(ArchiveError::Symlink(raw));
            }
        }

        if let Some(Component::Normal(top)) = rel.components().next() {
            tops.insert(top.to_string_lossy().to_string());
        }

        let out = dest.join(&rel);
        // The final structural guard. Everything above is textual; this
        // catches anything that slipped through by checking where the path
        // actually landed.
        if !out.starts_with(dest) {
            return Err(ArchiveError::UnsafePath(raw));
        }

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

    if tops.is_empty() {
        return Err(ArchiveError::UnexpectedLayout("it is empty".into()));
    }

    let (entries, extras): (Vec<String>, Vec<String>) =
        tops.into_iter().partition(|t| is_payload_name(t));

    if entries.is_empty() {
        return Err(ArchiveError::UnexpectedLayout(
            "nothing in it is a plugin a host could load".into(),
        ));
    }

    Ok(Unpacked { entries, extras })
}

/// Check an unpacked payload is the shape this format takes on this platform.
///
/// Catches two things worth catching separately from extraction: an archive
/// with a wrapping top-level directory (which the org does produce — the
/// ofx-bridge download is laid out that way), and a bundle whose binary is in
/// the wrong architecture directory.
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
        let got = extract(&z, &out).unwrap();
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

        let got = extract(&z, &t.path().join("out")).unwrap();
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

        let got = extract(&z, &t.path().join("out")).unwrap();
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
        assert!(matches!(extract(&z, &out), Err(ArchiveError::NotAZip(_))));
        assert!(!out.exists());
    }

    #[test]
    fn refuses_a_traversing_member() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("../../etc/passwd", Some(b"pwned".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out")),
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
        let _ = extract(&z, &out);
        assert!(!Path::new("/tmp/evil.bundle").exists());
    }

    #[test]
    fn refuses_a_backslash_member() {
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[(r"..\..\evil.dll", Some(b"x".as_slice()))]);
        assert!(matches!(
            extract(&z, &t.path().join("out")),
            Err(ArchiveError::UnsafePath(_))
        ));
    }

    #[test]
    fn strips_a_leading_dot_slash() {
        // `zip -r ./*` produces these legitimately.
        let t = TempDir::new().unwrap();
        let z = t.path().join("a.zip");
        make_zip(&z, &[("./Tinsel.dll", Some(b"MZ".as_slice()))]);
        let got = extract(&z, &t.path().join("out")).unwrap();
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

        let got = extract(&z, &t.path().join("out")).unwrap();
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
            extract(&z, &t.path().join("out")),
            Err(ArchiveError::UnexpectedLayout(_))
        ));
    }

    #[test]
    fn a_wrapping_directory_is_caught_by_layout_validation() {
        // The org does produce these: the ofx-bridge download wraps everything
        // in a top-level folder.
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
        // "bridge-1.0" is not a payload name, so extraction refuses it outright.
        assert!(matches!(
            extract(&z, &t.path().join("out")),
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
        let got = extract(&z, &out).unwrap();
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
        let got = extract(&z, &out).unwrap();
        assert!(validate_layout(&out, &got, Format::Ffgl, Platform::Windows).is_err());
    }

    #[test]
    fn zip_magic_recognises_a_zip_and_rejects_html() {
        assert!(looks_like_zip(b"PK\x03\x04rest"));
        assert!(!looks_like_zip(b"<!DO"));
        assert!(!looks_like_zip(b""));
    }
}
