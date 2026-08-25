//! A deterministic hash of an installed payload.
//!
//! Used to decide whether the ledger's record still describes the bytes on
//! disk. It has to be stable across platforms and across directory-traversal
//! order, or the check produces false "somebody changed this" on every scan.

use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;
use walkdir::WalkDir;

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
/// What one node in the tree is. The discriminant is fed into the hash, so a
/// file and a link of the same name and content cannot collide.
enum Node {
    Dir,
    File(Vec<u8>),
    Link(Vec<u8>),
}

fn feed(hasher: &mut Sha256, root: &Path) -> io::Result<()> {
    let mut nodes: Vec<(String, Node)> = Vec::new();

    if root.is_file() {
        nodes.push((
            root.file_name().unwrap_or_default().to_string_lossy().to_string(),
            Node::File(std::fs::read(root)?),
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
                nodes.push((rel, Node::File(std::fs::read(entry.path())?)));
            }
        }
    }

    // Sorting by the normalised relative path makes the result independent of
    // the order the filesystem happened to hand entries back in.
    nodes.sort_by(|a, b| a.0.cmp(&b.0));

    for (rel, node) in nodes {
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        match node {
            Node::Dir => hasher.update([0u8]),
            Node::File(bytes) => {
                hasher.update([1u8]);
                hasher.update((bytes.len() as u64).to_le_bytes());
                hasher.update(&bytes);
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
    let mut names: Vec<&String> = entries.iter().collect();
    names.sort();
    let mut hasher = Sha256::new();
    for name in names {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        feed(&mut hasher, &dir.join(name))?;
    }
    Ok(hex::encode(hasher.finalize()))
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
}
