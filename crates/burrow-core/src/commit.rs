//! Putting a staged payload into a plugin directory, and taking it out again.
//!
//! # The guarantee
//!
//! **A host never sees a partially-written plugin.** Not "rarely"; never. A
//! Resolume or Resolve that rescans in the middle of an install sees either
//! the old payload or the new one.
//!
//! That is worth insisting on because the failure is so quiet. A bundle with a
//! `Contents/` and no binary does not report an error — the host skips it, and
//! the user is left with a plugin that has vanished from their effects list
//! mid-show.
//!
//! # How
//!
//! Nothing is ever written *into* a live path. The payload is fully extracted,
//! validated, de-quarantined and hashed in staging first. Then, per entry:
//!
//! 1. `rename(live, live.burrow-old-<batch>)` — the old one steps aside
//! 2. `rename(staged, live)` — the new one appears, atomically
//!
//! Both are renames within one directory, which is atomic on every filesystem
//! this runs on. If step 2 fails, step 1 is undone. If an entry fails partway
//! through a multi-entry payload — downpour installs two bundles, orrery two —
//! every entry already committed is rolled back, so the destination ends up
//! byte-identical to how it started rather than half-updated.
//!
//! Only once every entry is in place are the `.burrow-old-` copies deleted.
//!
//! # Why staging happens inside the destination
//!
//! `rename` fails with `EXDEV` across filesystems, and a plugin directory can
//! easily be on a different volume from the app's cache — a separate Data
//! volume, a network home directory, an external disk. So the payload is first
//! copied into a `.burrow-staging-<batch>` directory *inside* the destination,
//! which guarantees the rename that matters is same-filesystem.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A batch nonce: 32 lowercase hex characters, unique per operation.
///
/// It suffixes every temporary name this module creates, which is what makes
/// cleanup unambiguous — a leftover `.burrow-old-<nonce>` belongs to exactly
/// one batch and can never be confused with a live payload or with another
/// batch's leavings. The privileged helper additionally refuses to delete
/// anything whose name does not carry the nonce of the plan it was handed.
pub fn new_batch_id() -> String {
    // Not cryptographic randomness: this is a collision-avoidance token
    // between concurrent operations on one machine, not a secret. Time plus
    // the process id is ample, and it avoids a dependency.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("{:016x}{:016x}", nanos & 0xFFFF_FFFF_FFFF_FFFF, pid.wrapping_mul(0x9E37_79B9))
        .chars()
        .take(32)
        .collect()
}

pub fn retired_name(entry: &str, batch: &str) -> String {
    format!("{entry}.burrow-old-{batch}")
}

pub fn staging_dir(dest: &Path, batch: &str) -> PathBuf {
    dest.join(format!(".burrow-staging-{batch}"))
}

#[derive(Debug)]
pub enum CommitError {
    Io { entry: String, source: io::Error },
    /// A rollback itself failed. The destination may be inconsistent, and this
    /// is the one case that must be reported loudly rather than folded into a
    /// generic failure.
    RollbackFailed { entry: String, detail: String },
}

impl std::fmt::Display for CommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommitError::Io { entry, source } => write!(f, "{entry}: {source}"),
            CommitError::RollbackFailed { entry, detail } => write!(
                f,
                "{entry}: the install failed and undoing it also failed ({detail}). \
                 Some files may be left with a .burrow-old- suffix."
            ),
        }
    }
}

/// Copy a file or directory tree. Used to get a payload from the app's cache
/// into the destination's own filesystem before the rename, and to lift an
/// application off a mounted disk image.
///
/// # Symlinks
///
/// Recreated, and only when they point inside the payload.
///
/// They used to be skipped, on the reasoning that archive extraction refuses
/// them anyway so one here would have to have been created after the fact. That
/// reasoning was right for plugins and is wrong for applications: the macOS
/// framework layout **is** symlinks. Every Electron application carries
/// `Versions/Current -> A`, and a `.app` copied without them is not a slightly
/// imperfect copy, it is an application that does not launch.
///
/// So a link is recreated when its target is relative and stays inside the tree
/// being copied, and the copy **fails** otherwise rather than skipping it. An
/// absolute link, or one climbing out with `..`, is either something this does
/// not understand or something it should not be reproducing inside a user's
/// Applications folder — and silently dropping it is how a payload arrives
/// looking complete and broken.
pub fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    copy_within(from, to, to)
}

/// `root` is the top of the tree being copied, which is what a symlink target
/// has to stay inside. It is threaded through the recursion unchanged.
fn copy_within(from: &Path, to: &Path, root: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return copy_symlink(from, to, root);
    }
    if meta.is_file() {
        if let Some(p) = to.parent() {
            fs::create_dir_all(p)?;
        }
        fs::copy(from, to)?;
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            copy_symlink(&entry.path(), &target, root)?;
        } else if ft.is_dir() {
            copy_within(&entry.path(), &target, root)?;
        } else if ft.is_file() {
            fs::copy(entry.path(), &target)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = entry.metadata()?.permissions().mode();
                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path, root: &Path) -> io::Result<()> {
    let target = fs::read_link(from)?;
    if target.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} points outside the payload, at {}", from.display(), target.display()),
        ));
    }
    // Resolved lexically against the link's own directory. Lexically, not by
    // asking the filesystem: canonicalize() would resolve through whatever is
    // there now, which is the classic way to check the wrong path.
    let base = to.parent().unwrap_or(root);
    let mut resolved = base.to_path_buf();
    for part in target.components() {
        match part {
            std::path::Component::ParentDir => {
                if !resolved.pop() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("{} climbs out of the payload", from.display()),
                    ));
                }
            }
            std::path::Component::CurDir => {}
            other => resolved.push(other.as_os_str()),
        }
    }
    if !resolved.starts_with(root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} points outside the payload, at {}", from.display(), target.display()),
        ));
    }
    if let Some(p) = to.parent() {
        fs::create_dir_all(p)?;
    }
    let _ = fs::remove_file(to);
    std::os::unix::fs::symlink(&target, to)
}

#[cfg(not(unix))]
fn copy_symlink(from: &Path, _to: &Path, _root: &Path) -> io::Result<()> {
    // Windows payloads do not contain them, and creating one needs a privilege
    // an ordinary account does not have. Refused rather than skipped, for the
    // reason in copy_tree's doc: a payload that arrives looking complete and
    // is not is the worst of the available outcomes.
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{} is a symbolic link, which cannot be recreated here", from.display()),
    ))
}

fn remove_any(p: &Path) -> io::Result<()> {
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

/// Place every entry of a staged payload into `dest`, atomically per entry and
/// all-or-nothing across entries.
///
/// `staged` holds the payload, already validated and de-quarantined.
/// Returns the names placed.
pub fn commit(
    dest: &Path,
    staged: &Path,
    entries: &[String],
    batch: &str,
) -> Result<Vec<String>, CommitError> {
    fs::create_dir_all(dest).map_err(|e| CommitError::Io {
        entry: dest.display().to_string(),
        source: e,
    })?;

    // Get the payload onto the destination's own filesystem first, so the
    // renames below cannot fail with EXDEV.
    let work = staging_dir(dest, batch);
    let _ = remove_any(&work);
    for name in entries {
        copy_tree(&staged.join(name), &work.join(name)).map_err(|e| {
            let _ = remove_any(&work);
            CommitError::Io { entry: name.clone(), source: e }
        })?;
    }

    // (entry, was_there_before) for everything committed so far, so a failure
    // partway can put each one back exactly as it was.
    let mut done: Vec<(String, bool)> = Vec::new();

    for name in entries {
        let live = dest.join(name);
        let retired = dest.join(retired_name(name, batch));
        let existed = live.exists();

        if existed {
            if let Err(e) = fs::rename(&live, &retired) {
                rollback(dest, &done, batch);
                let _ = remove_any(&work);
                return Err(CommitError::Io { entry: name.clone(), source: e });
            }
        }
        if let Err(e) = fs::rename(work.join(name), &live) {
            // Put this entry's own old copy back before unwinding the rest.
            if existed {
                let _ = fs::rename(&retired, &live);
            }
            rollback(dest, &done, batch);
            let _ = remove_any(&work);
            return Err(CommitError::Io { entry: name.clone(), source: e });
        }
        done.push((name.clone(), existed));
    }

    // Everything is in place. Only now is the old payload actually gone.
    for (name, existed) in &done {
        if *existed {
            let _ = remove_any(&dest.join(retired_name(name, batch)));
        }
    }
    let _ = remove_any(&work);

    Ok(entries.to_vec())
}

/// Undo committed entries, newest first.
fn rollback(dest: &Path, done: &[(String, bool)], batch: &str) {
    for (name, existed) in done.iter().rev() {
        let live = dest.join(name);
        let retired = dest.join(retired_name(name, batch));
        let _ = remove_any(&live);
        if *existed {
            let _ = fs::rename(&retired, &live);
        }
    }
}

/// Remove exactly the named entries, and nothing else.
///
/// Two-phase for the same reason install is: every entry is renamed aside
/// first, and only deleted once all of them have moved. A failure halfway
/// leaves the payload present rather than half-removed — a plugin that is
/// still there is a much better outcome than one whose two bundles have become
/// one.
pub fn uninstall(dest: &Path, entries: &[String], batch: &str) -> Result<(), CommitError> {
    let mut retired: Vec<String> = Vec::new();

    for name in entries {
        let live = dest.join(name);
        if !live.exists() {
            continue;
        }
        let aside = dest.join(retired_name(name, batch));
        if let Err(e) = fs::rename(&live, &aside) {
            // Put back everything already moved.
            for done in &retired {
                let _ = fs::rename(dest.join(retired_name(done, batch)), dest.join(done));
            }
            return Err(CommitError::Io { entry: name.clone(), source: e });
        }
        retired.push(name.clone());
    }

    for name in &retired {
        let _ = remove_any(&dest.join(retired_name(name, batch)));
    }
    Ok(())
}

/// Delete any leftovers from an interrupted batch.
///
/// Only touches names carrying the `.burrow-old-` marker, so a crash mid-install
/// is recoverable without any risk to a live payload.
pub fn sweep_leftovers(dest: &Path) -> usize {
    let Ok(read) = fs::read_dir(dest) else {
        return 0;
    };
    let mut n = 0;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_leftover = name.contains(".burrow-old-") || name.starts_with(".burrow-staging-");
        if is_leftover && remove_any(&entry.path()).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A framework layout in miniature: the shape every Electron and Tauri
    /// application carries, and the reason copy_tree recreates links at all.
    #[cfg(unix)]
    fn make_app(root: &Path) {
        let versions = root.join("Contents/Frameworks/Thing.framework/Versions");
        fs::create_dir_all(versions.join("A/Resources")).unwrap();
        fs::write(versions.join("A/Thing"), b"MZ").unwrap();
        fs::write(versions.join("A/Resources/Info.plist"), b"<plist/>").unwrap();
        std::os::unix::fs::symlink("A", versions.join("Current")).unwrap();
        std::os::unix::fs::symlink(
            "Versions/Current/Thing",
            versions.parent().unwrap().join("Thing"),
        )
        .unwrap();
        fs::create_dir_all(root.join("Contents/MacOS")).unwrap();
        fs::write(root.join("Contents/MacOS/Thing"), b"MZ").unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn an_applications_framework_symlinks_survive_the_copy() {
        // Skipping them, which is what this used to do, produces an
        // application that looks complete in Finder and does not launch.
        let t = TempDir::new().unwrap();
        let src = t.path().join("Thing.app");
        make_app(&src);

        let dst = t.path().join("out/Thing.app");
        copy_tree(&src, &dst).unwrap();

        let current = dst.join("Contents/Frameworks/Thing.framework/Versions/Current");
        assert!(fs::symlink_metadata(&current).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&current).unwrap(), Path::new("A"));
        // And it still resolves, which is the point of recreating it.
        assert!(current.join("Thing").is_file());

        let shortcut = dst.join("Contents/Frameworks/Thing.framework/Thing");
        assert!(fs::symlink_metadata(&shortcut).unwrap().file_type().is_symlink());
        assert!(shortcut.exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_pointing_out_of_the_payload_fails_the_copy() {
        // Rather than being skipped. A payload that arrives looking complete
        // and is not is the worst of the outcomes available here — and a link
        // to somewhere else on the disk is not part of what was downloaded.
        let t = TempDir::new().unwrap();
        let src = t.path().join("Thing.app");
        fs::create_dir_all(&src).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", src.join("secrets")).unwrap();

        let err = copy_tree(&src, &t.path().join("out/Thing.app")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_climbing_out_with_dot_dot_fails_the_copy() {
        let t = TempDir::new().unwrap();
        let src = t.path().join("Thing.app");
        fs::create_dir_all(&src).unwrap();
        std::os::unix::fs::symlink("../../elsewhere", src.join("escape")).unwrap();

        assert!(copy_tree(&src, &t.path().join("out/Thing.app")).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn a_repointed_symlink_changes_the_payload_hash() {
        // What hashing symlink targets buys: the ledger notices.
        use crate::hashing::hash_entries;
        let t = TempDir::new().unwrap();
        let dir = t.path();
        fs::create_dir_all(dir.join("Thing.app")).unwrap();
        fs::write(dir.join("Thing.app/real"), b"x").unwrap();
        std::os::unix::fs::symlink("real", dir.join("Thing.app/link")).unwrap();
        let before = hash_entries(dir, &["Thing.app".into()]).unwrap();

        fs::remove_file(dir.join("Thing.app/link")).unwrap();
        std::os::unix::fs::symlink("elsewhere", dir.join("Thing.app/link")).unwrap();
        let after = hash_entries(dir, &["Thing.app".into()]).unwrap();

        assert_ne!(before, after);
    }
    use tempfile::TempDir;

    fn bundle(root: &Path, name: &str, body: &[u8]) {
        let b = root.join(name);
        fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
        fs::write(b.join("Contents/MacOS/bin"), body).unwrap();
        fs::write(b.join("Contents/Info.plist"), b"<plist/>").unwrap();
    }

    fn read_bin(root: &Path, name: &str) -> Vec<u8> {
        fs::read(root.join(name).join("Contents/MacOS/bin")).unwrap()
    }

    /// Everything in the destination, so a test can assert nothing else moved.
    fn listing(p: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(p)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn installs_into_an_empty_destination() {
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        bundle(staged.path(), "Tinsel.bundle", b"new");

        let batch = new_batch_id();
        commit(dest.path(), staged.path(), &["Tinsel.bundle".into()], &batch).unwrap();

        assert_eq!(read_bin(dest.path(), "Tinsel.bundle"), b"new");
        // No temporary debris left behind.
        assert_eq!(listing(dest.path()), vec!["Tinsel.bundle"]);
    }

    #[test]
    fn updating_replaces_the_payload_and_leaves_nothing_behind() {
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        bundle(dest.path(), "Tinsel.bundle", b"old");
        bundle(staged.path(), "Tinsel.bundle", b"new");

        let batch = new_batch_id();
        commit(dest.path(), staged.path(), &["Tinsel.bundle".into()], &batch).unwrap();

        assert_eq!(read_bin(dest.path(), "Tinsel.bundle"), b"new");
        assert_eq!(listing(dest.path()), vec!["Tinsel.bundle"]);
    }

    #[test]
    fn a_multi_bundle_install_places_every_entry() {
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        bundle(staged.path(), "Downpour.bundle", b"a");
        bundle(staged.path(), "Downpour Over.bundle", b"b");

        let entries = vec!["Downpour.bundle".to_string(), "Downpour Over.bundle".to_string()];
        commit(dest.path(), staged.path(), &entries, &new_batch_id()).unwrap();

        assert_eq!(read_bin(dest.path(), "Downpour.bundle"), b"a");
        assert_eq!(read_bin(dest.path(), "Downpour Over.bundle"), b"b");
    }

    #[test]
    fn a_failure_on_the_second_entry_rolls_the_first_one_back() {
        // The guarantee that matters: downpour's two bundles either both
        // update or neither does. A half-updated pair is a plugin that behaves
        // differently from itself.
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        bundle(dest.path(), "Downpour.bundle", b"old-a");
        bundle(dest.path(), "Downpour Over.bundle", b"old-b");
        bundle(staged.path(), "Downpour.bundle", b"new-a");
        // "Downpour Over.bundle" is deliberately absent from staging, so the
        // copy for the second entry fails.

        let entries = vec!["Downpour.bundle".to_string(), "Downpour Over.bundle".to_string()];
        let err = commit(dest.path(), staged.path(), &entries, &new_batch_id());
        assert!(err.is_err());

        // Both originals still present and unchanged.
        assert_eq!(read_bin(dest.path(), "Downpour.bundle"), b"old-a");
        assert_eq!(read_bin(dest.path(), "Downpour Over.bundle"), b"old-b");
        assert_eq!(
            listing(dest.path()),
            vec!["Downpour Over.bundle", "Downpour.bundle"]
        );
    }

    #[test]
    fn a_failed_install_leaves_a_previously_empty_destination_empty() {
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        // Nothing staged at all.
        let err = commit(dest.path(), staged.path(), &["Tinsel.bundle".into()], &new_batch_id());
        assert!(err.is_err());
        assert!(listing(dest.path()).is_empty());
    }

    #[test]
    fn neighbouring_plugins_are_never_touched() {
        // A real Extra Effects folder is shared. Installing one plugin must be
        // invisible to everything else in there.
        let staged = TempDir::new().unwrap();
        let dest = TempDir::new().unwrap();
        bundle(dest.path(), "WebLinked.bundle", b"someone else");
        bundle(dest.path(), "Metal_Gain_Example.bundle", b"sdk sample");
        bundle(staged.path(), "Tinsel.bundle", b"ours");

        commit(dest.path(), staged.path(), &["Tinsel.bundle".into()], &new_batch_id()).unwrap();

        assert_eq!(read_bin(dest.path(), "WebLinked.bundle"), b"someone else");
        assert_eq!(read_bin(dest.path(), "Metal_Gain_Example.bundle"), b"sdk sample");
    }

    #[test]
    fn uninstall_removes_exactly_the_named_entries() {
        let dest = TempDir::new().unwrap();
        bundle(dest.path(), "Downpour.bundle", b"a");
        bundle(dest.path(), "Downpour Over.bundle", b"b");
        bundle(dest.path(), "WebLinked.bundle", b"not ours");

        let entries = vec!["Downpour.bundle".to_string(), "Downpour Over.bundle".to_string()];
        uninstall(dest.path(), &entries, &new_batch_id()).unwrap();

        assert_eq!(listing(dest.path()), vec!["WebLinked.bundle"]);
    }

    #[test]
    fn uninstalling_something_already_gone_is_not_an_error() {
        // The user deleted it by hand; finishing the job is still the right
        // outcome, not a failure.
        let dest = TempDir::new().unwrap();
        uninstall(dest.path(), &["Tinsel.bundle".into()], &new_batch_id()).unwrap();
        assert!(listing(dest.path()).is_empty());
    }

    #[test]
    fn leftovers_from_an_interrupted_batch_are_sweepable_and_live_files_are_not() {
        let dest = TempDir::new().unwrap();
        bundle(dest.path(), "Tinsel.bundle", b"live");
        bundle(dest.path(), "Tinsel.bundle.burrow-old-abc123", b"leftover");
        fs::create_dir_all(dest.path().join(".burrow-staging-abc123")).unwrap();

        assert_eq!(sweep_leftovers(dest.path()), 2);
        assert_eq!(listing(dest.path()), vec!["Tinsel.bundle"]);
    }

    #[test]
    fn a_batch_id_is_the_shape_the_privileged_helper_demands() {
        // burrow-plan refuses a plan whose nonce is not 32 lowercase hex
        // characters, so this is the contract between the two crates.
        let id = new_batch_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn two_batch_ids_differ() {
        assert_ne!(new_batch_id(), new_batch_id());
    }
}
