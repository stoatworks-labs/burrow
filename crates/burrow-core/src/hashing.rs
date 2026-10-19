//! A deterministic hash of an installed payload.
//!
//! Used to decide whether the ledger's record still describes the bytes on
//! disk. It has to be stable across platforms and across directory-traversal
//! order, or the check produces false "somebody changed this" on every scan.
//!
//! ⚠️ **The byte stream is a format, and every ledger on every machine holds
//! hashes of it.** Change what is fed to the hasher — the record layout, the
//! discriminants, the ordering — and every installed payload stops matching its
//! ledger entry at the next scan: Windows payloads all become "version unknown"
//! and nothing says why. The streaming rewrite below reproduces the original
//! stream byte for byte, and `the_stream_is_the_documented_format` pins it.

use sha2::{Digest, Sha256};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Called with the running total of file bytes hashed so far.
///
/// A payload is hashed after it is installed and again on every scan, and an
/// application is hundreds of megabytes: without this the "verifying" step is a
/// bar that sits still for as long as the copy took.
pub type OnBytes<'a> = &'a mut dyn FnMut(u64);

/// What one node in the tree is. The discriminant is fed into the hash, so a
/// file and a link of the same name and content cannot collide.
///
/// A file is held by path and length, not by content: the payload used to be
/// read into memory in full and hashed afterwards, which for an application
/// meant holding the whole `.app` in RAM. The content is streamed through the
/// hasher when its turn comes, and the length prefix — which the format needs
/// before the bytes — comes from the metadata. A file that changes size between
/// the two is being written by somebody else at that moment, and no hash of it
/// is worth anything anyway.
enum Node {
    Dir,
    File(PathBuf, u64),
    Link(Vec<u8>),
}

/// Hash one payload entry — a file, or a bundle directory.
///
/// Feeds a length-prefixed record per node so that no two different trees can
/// produce the same byte stream by concatenation. Paths are normalised to
/// forward slashes, or the same bundle hashes differently on Windows and macOS
/// and a cross-platform ledger becomes meaningless.
///
/// Symlinks are recorded by their target and never followed. Recording them
/// matters now that applications are installed: an `.app` is full of framework
/// links, and skipping them entirely would mean a payload whose links had been
/// repointed still hashed as untouched. Following them would make the hash
/// depend on whatever they point at, which is the thing to avoid.
fn feed(hasher: &mut Sha256, root: &Path, done: &mut u64, on_bytes: OnBytes<'_>) -> io::Result<()> {
    let mut nodes: Vec<(String, Node)> = Vec::new();

    if root.is_file() {
        nodes.push((
            root.file_name().unwrap_or_default().to_string_lossy().to_string(),
            Node::File(root.to_path_buf(), std::fs::metadata(root)?.len()),
        ));
    } else {
        for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
            let entry = entry.map_err(io::Error::other)?;
            let rel = entry
                .path()
                .strip_prefix(root)
                .map_err(io::Error::other)?
                .to_string_lossy()
                .replace('\\', "/");
            if entry.file_type().is_symlink() {
                let target = std::fs::read_link(entry.path())?;
                nodes.push((
                    rel,
                    Node::Link(target.to_string_lossy().replace('\\', "/").into_bytes()),
                ));
            } else if entry.file_type().is_dir() {
                nodes.push((rel, Node::Dir));
            } else if entry.file_type().is_file() {
                nodes.push((rel, Node::File(entry.path().to_path_buf(), entry.metadata()?.len())));
            }
        }
    }

    // Sorting by the normalised relative path makes the result independent of
    // the order the filesystem happened to hand entries back in.
    nodes.sort_by(|a, b| a.0.cmp(&b.0));

    let mut buf = vec![0u8; 256 * 1024];
    for (rel, node) in nodes {
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        match node {
            Node::Dir => hasher.update([0u8]),
            Node::File(path, len) => {
                hasher.update([1u8]);
                hasher.update(len.to_le_bytes());
                let mut f = std::fs::File::open(&path)?;
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                    *done += n as u64;
                    on_bytes(*done);
                }
            }
            Node::Link(target) => {
                hasher.update([2u8]);
                hasher.update((target.len() as u64).to_le_bytes());
                hasher.update(&target);
            }
        }
    }
    Ok(())
}

/// Hash a whole payload — every top-level entry a plugin installed, in a
/// stable order.
pub fn hash_entries(dir: &Path, entries: &[String]) -> io::Result<String> {
    hash_entries_with(dir, entries, &mut |_| {})
}

/// [`hash_entries`], reporting the running byte count as it goes.
pub fn hash_entries_with(dir: &Path, entries: &[String], on_bytes: OnBytes<'_>) -> io::Result<String> {
    let mut names: Vec<&String> = entries.iter().collect();
    names.sort();
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    for name in names {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        feed(&mut hasher, &dir.join(name), &mut done, on_bytes)?;
    }
    Ok(hex::encode(hasher.finalize()))
}

/// How many file bytes a payload holds — the total a progress bar over a copy
/// or a hash of it runs to.
///
/// Symlinks are not followed and count for nothing, matching what the hash and
/// the copy do with them. A missing entry is zero rather than an error: this
/// sizes a bar, and the operation it is sizing will report the missing entry
/// itself.
pub fn payload_size(dir: &Path, entries: &[String]) -> u64 {
    entries
        .iter()
        .map(|name| {
            WalkDir::new(dir.join(name))
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum::<u64>()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tree(root: &Path, name: &str, body: &[u8]) {
        let b = root.join(name);
        fs::create_dir_all(b.join("Contents").join("MacOS")).unwrap();
        fs::write(b.join("Contents").join("MacOS").join("bin"), body).unwrap();
        fs::write(b.join("Contents").join("Info.plist"), b"<plist/>").unwrap();
    }

    #[test]
    fn the_same_tree_hashes_the_same_twice() {
        let t = TempDir::new().unwrap();
        tree(t.path(), "A.bundle", b"binary");
        let e = vec!["A.bundle".to_string()];
        assert_eq!(
            hash_entries(t.path(), &e).unwrap(),
            hash_entries(t.path(), &e).unwrap()
        );
    }

    #[test]
    fn one_changed_byte_changes_the_hash() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        tree(a.path(), "A.bundle", b"binary");
        tree(b.path(), "A.bundle", b"binarY");
        let e = vec!["A.bundle".to_string()];
        assert_ne!(hash_entries(a.path(), &e).unwrap(), hash_entries(b.path(), &e).unwrap());
    }

    #[test]
    fn entry_order_does_not_change_the_hash() {
        // downpour's two bundles must hash the same whichever order the
        // catalogue happens to list them in.
        let t = TempDir::new().unwrap();
        tree(t.path(), "Downpour.bundle", b"one");
        tree(t.path(), "Downpour Over.bundle", b"two");
        let fwd = vec!["Downpour.bundle".to_string(), "Downpour Over.bundle".to_string()];
        let rev = vec!["Downpour Over.bundle".to_string(), "Downpour.bundle".to_string()];
        assert_eq!(hash_entries(t.path(), &fwd).unwrap(), hash_entries(t.path(), &rev).unwrap());
    }

    #[test]
    fn a_file_moved_between_names_changes_the_hash() {
        // Guards against a concatenation collision: the same bytes under a
        // different name must not hash the same.
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        fs::write(a.path().join("X.dll"), b"same").unwrap();
        fs::write(b.path().join("Y.dll"), b"same").unwrap();
        assert_ne!(
            hash_entries(a.path(), &["X.dll".to_string()]).unwrap(),
            hash_entries(b.path(), &["Y.dll".to_string()]).unwrap()
        );
    }

    #[test]
    fn a_missing_entry_is_an_error_rather_than_a_silently_empty_hash() {
        let t = TempDir::new().unwrap();
        assert!(hash_entries(t.path(), &["Gone.bundle".to_string()]).is_err());
    }

    /// The stream, spelled out by hand, so a rewrite of `feed` cannot quietly
    /// invalidate every ledger in the field.
    ///
    /// This is the format as it was when the ledger first recorded a hash: a
    /// length-prefixed entry name, then per node a length-prefixed relative
    /// path, a one-byte kind, and for a file a length-prefixed body. The
    /// streaming implementation has to produce exactly this.
    #[test]
    fn the_stream_is_the_documented_format() {
        let t = TempDir::new().unwrap();
        let b = t.path().join("A.bundle");
        fs::create_dir_all(b.join("Contents")).unwrap();
        fs::write(b.join("Contents").join("bin"), b"binary").unwrap();

        let mut expected = Sha256::new();
        let rec = |h: &mut Sha256, s: &str| {
            h.update((s.len() as u64).to_le_bytes());
            h.update(s.as_bytes());
        };
        rec(&mut expected, "A.bundle");
        // Nodes in relative-path order: the root itself is "" and a directory.
        rec(&mut expected, "");
        expected.update([0u8]);
        rec(&mut expected, "Contents");
        expected.update([0u8]);
        rec(&mut expected, "Contents/bin");
        expected.update([1u8]);
        expected.update((6u64).to_le_bytes());
        expected.update(b"binary");

        assert_eq!(
            hash_entries(t.path(), &["A.bundle".to_string()]).unwrap(),
            hex::encode(expected.finalize())
        );
    }

    #[test]
    fn progress_counts_every_file_byte_once_and_ends_on_the_payload_size() {
        let t = TempDir::new().unwrap();
        tree(t.path(), "A.bundle", b"binary");
        let e = vec!["A.bundle".to_string()];
        let mut seen: Vec<u64> = Vec::new();
        hash_entries_with(t.path(), &e, &mut |n| seen.push(n)).unwrap();
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "the count must only rise: {seen:?}");
        assert_eq!(seen.last().copied(), Some(payload_size(t.path(), &e)));
        assert_eq!(payload_size(t.path(), &e), ("binary".len() + "<plist/>".len()) as u64);
    }

    #[test]
    fn payload_size_ignores_links_and_treats_a_missing_entry_as_nothing() {
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("X.dll"), b"12345").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("X.dll", t.path().join("Y.dll")).unwrap();
        assert_eq!(payload_size(t.path(), &["X.dll".to_string()]), 5);
        #[cfg(unix)]
        assert_eq!(payload_size(t.path(), &["Y.dll".to_string()]), 0);
        assert_eq!(payload_size(t.path(), &["Gone.dll".to_string()]), 0);
    }
}
