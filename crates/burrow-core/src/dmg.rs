//! Getting an application out of a macOS disk image.
//!
//! # Why this exists at all
//!
//! Burrow's other formats arrive as archives, which it unpacks itself. macOS
//! applications do not: every GUI application in this fleet is published as a
//! `.dmg`, and the archives that sit beside them are command-line binaries —
//! `oxbow-0.1.1-macos-universal.zip` holds `oxbow`, a README and a LICENCE, and
//! nothing that `/Applications` has any use for. That was checked across every
//! application in the catalogue rather than assumed, by reading each archive's
//! central directory over HTTP range requests: nine hold a `.app`, two hold a
//! command-line tool, and all eleven publish a disk image.
//!
//! So the disk image is the artefact, and this is what opens one.
//!
//! # What it does, and what it refuses to do
//!
//! `hdiutil attach` — the same call `open` makes — with the flags that keep it
//! silent: no Finder window, read-only, no auto-open, and **`-nobrowse`**, so
//! the image never appears on the desktop or in the sidebar. The application is
//! then copied out and the image detached, in a `finally`-shaped way that
//! detaches even when the copy fails. An image left mounted is not dangerous,
//! but it is litter in somebody's Finder that they did not put there.
//!
//! Two deliberate refusals:
//!
//! **The mount point is ours.** `-mountpoint` names a directory inside Burrow's
//! own staging area rather than letting the image choose `/Volumes/<whatever
//! the image says>`. An image cannot name a mount point that collides with a
//! volume the user already has mounted, and nothing here reads a path out of
//! `hdiutil`'s output.
//!
//! **Exactly one application, at the top.** A disk image is a filesystem and
//! could hold anything. This takes a single top-level `.app` and refuses two,
//! none, or one buried in a subdirectory — the shape every application in this
//! fleet publishes, and the only shape whose meaning is unambiguous.

use crate::archive::{ArchiveError, Unpacked};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

/// A UDIF disk image's trailer.
///
/// A `.dmg` is identified from its *end*, not its start: the `koly` block is
/// the last 512 bytes of the file. Checked for the same reason
/// [`crate::archive::looks_like_zip`] is — the realistic failure is an HTML
/// error page saved under a `.dmg` name, and "that download was not a disk
/// image" is a better thing to say than whatever `hdiutil` says about it.
pub fn looks_like_dmg(trailer: &[u8]) -> bool {
    trailer.len() >= 4 && &trailer[..4] == b"koly"
}

/// Read the last 512 bytes of a file, for [`looks_like_dmg`].
///
/// Compiled on macOS, where the mounting happens, and under `cfg(test)`
/// everywhere so the trailer check keeps its test on every platform CI runs.
#[cfg(any(target_os = "macos", test))]
fn trailer(path: &Path) -> Result<Vec<u8>, ArchiveError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    if len < 512 {
        return Ok(Vec::new());
    }
    f.seek(SeekFrom::Start(len - 512))?;
    let mut buf = vec![0u8; 512];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Mount `image`, copy the application it holds into `dest`, and detach.
///
/// `dest` plays exactly the part the extraction directory plays for an
/// archive: what comes back is a staged payload, already named, ready for the
/// same validation, quarantine clearing, hashing and commit as everything else.
#[cfg(target_os = "macos")]
pub fn extract_app(image: &Path, dest: &Path) -> Result<Unpacked, ArchiveError> {
    use std::process::Command;

    if !looks_like_dmg(&trailer(image)?) {
        return Err(ArchiveError::NotAZip(
            "it is not a disk image — most likely an error page".into(),
        ));
    }

    std::fs::create_dir_all(dest)?;
    // Beside the destination, not inside it: the copy below reads from the
    // mount and writes into `dest`, and a mount point inside `dest` would put
    // the source inside the target.
    let mount = dest.with_extension("mount");
    let _ = std::fs::remove_dir_all(&mount);
    std::fs::create_dir_all(&mount)?;

    let out = Command::new("/usr/bin/hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-noverify", "-mountpoint"])
        .arg(&mount)
        .arg(image)
        // A disk image carrying a licence agreement makes `hdiutil` wait for an
        // answer. With no input to read it fails instead of hanging, which is
        // the behaviour to want in a background job: an install that reports a
        // failure can be retried, and one that hangs cannot be understood.
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| ArchiveError::Io(format!("could not run hdiutil: {e}")))?;

    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&mount);
        let why = String::from_utf8_lossy(&out.stderr);
        let why = why.trim();
        return Err(ArchiveError::Io(format!(
            "the disk image would not open{}{}",
            if why.is_empty() { "" } else { " — " },
            why
        )));
    }

    // Everything from here detaches before it returns, whichever way it goes.
    let result = copy_app_from(&mount, dest);

    let _ = Command::new("/usr/bin/hdiutil")
        .args(["detach", "-quiet"])
        .arg(&mount)
        .output();
    let _ = std::fs::remove_dir_all(&mount);

    result
}

#[cfg(not(target_os = "macos"))]
pub fn extract_app(_image: &Path, _dest: &Path) -> Result<Unpacked, ArchiveError> {
    // A disk image is a macOS filesystem opened by a macOS tool. Nothing else
    // has an `hdiutil`, and nothing else has an `/Applications` to put the
    // result in. The catalogue only offers `.dmg` artefacts for macOS, so this
    // is unreachable rather than a gap.
    Err(ArchiveError::UnexpectedLayout(
        "disk images can only be opened on macOS".into(),
    ))
}

/// Find the one application on a mounted image and copy it into `dest`.
///
/// macOS-only, like everything that can reach it: without the gate this is dead
/// code on Linux and Windows, and CI runs clippy with `-D warnings` on all
/// three. That failure is invisible from a Mac.
#[cfg(target_os = "macos")]
fn copy_app_from(mount: &Path, dest: &Path) -> Result<Unpacked, ArchiveError> {
    let mut apps: Vec<PathBuf> = Vec::new();
    let mut extras: Vec<String> = Vec::new();

    for entry in std::fs::read_dir(mount)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        // `.Trashes`, `.fseventsd` and an alias to /Applications are on
        // essentially every image made by a packaging tool. None of them is
        // payload and none is worth mentioning to anybody.
        if name.starts_with('.') || name == "Applications" || name == " " {
            continue;
        }
        if name.to_ascii_lowercase().ends_with(".app") {
            apps.push(entry.path());
        } else {
            extras.push(name);
        }
    }

    let (Some(app), None) = (apps.first(), apps.get(1)) else {
        return Err(ArchiveError::UnexpectedLayout(if apps.is_empty() {
            "there is no application at the top of the disk image".into()
        } else {
            "the disk image holds more than one application".into()
        }));
    };

    let name = app
        .file_name()
        .ok_or_else(|| ArchiveError::UnexpectedLayout("an application with no name".into()))?
        .to_string_lossy()
        .to_string();

    crate::commit::copy_tree(app, &dest.join(&name))
        .map_err(|e| ArchiveError::Io(format!("could not copy {name} out of the disk image: {e}")))?;

    extras.sort();
    Ok(Unpacked { entries: vec![name], extras })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_page_is_not_a_disk_image() {
        assert!(!looks_like_dmg(b"<!DOCTYPE html>"));
        assert!(!looks_like_dmg(b""));
        assert!(looks_like_dmg(b"koly\0\0\0\x04"));
    }

    #[test]
    fn a_short_file_has_no_trailer_and_is_refused() {
        let t = tempfile::TempDir::new().unwrap();
        let p = t.path().join("x.dmg");
        std::fs::write(&p, b"nope").unwrap();
        assert!(!looks_like_dmg(&trailer(&p).unwrap()));
    }
}
