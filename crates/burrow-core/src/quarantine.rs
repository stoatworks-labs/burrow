//! Clearing `com.apple.quarantine` from a staged payload.
//!
//! # Why this matters more than it looks
//!
//! A quarantined plugin is **skipped silently by Resolume**. Not refused with a
//! message, not listed as broken — it simply is not in the effects browser, and
//! the user's conclusion is that the plugin does not work. The
//! `resolume-ofx-bridge` project's notes record it as "quarantine, almost
//! always" being the answer to "the bundle generated but Resolume doesn't show
//! it".
//!
//! # Why it runs unconditionally
//!
//! The flag is **inherited from the writing process**, not copied from the
//! source file. An application that was itself downloaded — which is to say,
//! every copy of Burrow anyone actually installs — carries the attribute, and
//! marks everything it writes.
//!
//! That case cannot be reproduced from a local build. Running Burrow out of
//! `cargo run` or a freshly compiled `.app` produces unquarantined output every
//! time, so a conditional "clear it if present" would test clean forever and
//! fail in the field. So this runs on every install whether or not the
//! attribute is there, exactly as the C++ that is proven against Resolume does.
//!
//! # Why it runs on the staged copy
//!
//! Clearing happens in the staging directory, before anything is moved into a
//! plugin folder. That means the privileged helper never needs the capability:
//! by the time root is involved, the payload is already clean.

use std::path::Path;
use walkdir::WalkDir;

/// Remove the quarantine attribute from a path and everything under it.
///
/// Never fails the install. `removexattr` returns `ENOATTR` when the attribute
/// is absent, which is the *normal* case for a locally built app, so an error
/// here is not evidence of a problem. The count of paths that actually carried
/// one is returned for logging.
pub fn clear(root: &Path) -> usize {
    let mut cleared = 0;
    for entry in WalkDir::new(root).follow_links(false) {
        let Ok(entry) = entry else { continue };
        if remove_one(entry.path()) {
            cleared += 1;
        }
    }
    cleared
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // the one unsafe call in this crate; see the SAFETY note below
fn remove_one(path: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    const NAME: &[u8] = b"com.apple.quarantine\0";
    // XATTR_NOFOLLOW. Deliberate: a symlink's own attribute is what we mean,
    // never its target's. The `xattr` crate's remove() follows links and gives
    // no way to say otherwise, which is why this is a direct call.
    const XATTR_NOFOLLOW: libc::c_int = 0x0001;

    let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: both pointers are valid, NUL-terminated C strings that outlive
    // the call, and removexattr does not retain them.
    let rc = unsafe {
        libc::removexattr(
            c_path.as_ptr(),
            NAME.as_ptr() as *const libc::c_char,
            XATTR_NOFOLLOW,
        )
    };
    rc == 0
}

/// Quarantine is a macOS idea. Everywhere else this is a no-op, so callers
/// need no `cfg` of their own.
#[cfg(not(target_os = "macos"))]
fn remove_one(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn clearing_a_clean_tree_is_harmless_and_leaves_it_intact() {
        // The everyday case: nothing is quarantined, and that must not be
        // reported as a failure or disturb the files.
        let t = TempDir::new().unwrap();
        let b = t.path().join("Tinsel.bundle");
        fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
        fs::write(b.join("Contents/MacOS/bin"), b"MZ").unwrap();

        assert_eq!(clear(&b), 0);
        assert!(b.join("Contents/MacOS/bin").is_file());
    }

    #[test]
    fn a_missing_path_does_not_panic() {
        assert_eq!(clear(Path::new("/nowhere/at/all")), 0);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_quarantined_tree_is_cleared_recursively() {
        use std::process::Command;

        let t = TempDir::new().unwrap();
        let b = t.path().join("Tinsel.bundle");
        fs::create_dir_all(b.join("Contents/MacOS")).unwrap();
        fs::write(b.join("Contents/MacOS/bin"), b"MZ").unwrap();

        // Set the real attribute the way a download would.
        let set = Command::new("xattr")
            .args([
                "-w",
                "com.apple.quarantine",
                "0081;00000000;Burrow;",
                b.join("Contents/MacOS/bin").to_str().unwrap(),
            ])
            .status()
            .expect("xattr");
        assert!(set.success());

        let present = Command::new("xattr")
            .args(["-p", "com.apple.quarantine", b.join("Contents/MacOS/bin").to_str().unwrap()])
            .output()
            .unwrap();
        assert!(present.status.success(), "attribute should be set before clearing");

        assert!(clear(&b) >= 1);

        let after = Command::new("xattr")
            .args(["-p", "com.apple.quarantine", b.join("Contents/MacOS/bin").to_str().unwrap()])
            .output()
            .unwrap();
        assert!(!after.status.success(), "attribute should be gone");
    }
}
