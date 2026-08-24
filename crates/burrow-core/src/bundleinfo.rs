//! Reading identity out of an installed payload.
//!
//! Only macOS payloads carry any. A Windows FFGL plugin is a bare `.dll` and a
//! Windows OpenFX plugin is a bundle whose `Contents/Win64/` holds the binary
//! and nothing else — no `Info.plist`, no version resource (confirmed: no
//! `.rc` file exists in any plugin repo). So every function here returns an
//! `Option`, and "unknown" is a normal answer rather than a failure.

use std::path::Path;

/// The identifier prefixes this fleet's plugins use.
///
/// `Tinsel.bundle` is `com.stoatworks.ffgl.tinsel`. This is a *secondary*
/// check — the primary one is that the filename is a name the catalogue
/// declares for that plugin — but it is what stops Burrow adopting a
/// third-party bundle that happens to share a name.
///
/// There are two prefixes because there genuinely are two. Surveying the 22
/// bundles installed on the machine this was written on, twenty-one are
/// `com.stoatworks.*` and one is not: `LumaKey.bundle` is
/// `com.allansargeant.ffgl.lumakey`. Luma Keyer is the oldest plugin in the
/// fleet and predates the `com.stoatworks.` convention; the older personal
/// namespace is still in use elsewhere too (av-launcher's bundle identifier is
/// `com.allansargeant.av-launcher`).
///
/// Accepting both is the right call regardless of whether the fleet ever
/// normalises the identifier, because a plugin already installed on someone's
/// machine keeps whatever identifier it shipped with. Recognising only the new
/// one would make every existing Luma Keyer install invisible to Burrow
/// forever.
pub const OWNED_PREFIXES: &[&str] = &["com.stoatworks.", "com.allansargeant."];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleIdentity {
    pub identifier: Option<String>,
    /// `CFBundleVersion`, which the plugins' CMake sets from `PROJECT_VERSION`
    /// — so a released bundle's plist carries the release version.
    pub version: Option<String>,
    pub name: Option<String>,
}

impl BundleIdentity {
    /// Whether this looks like one of ours.
    ///
    /// Used to refuse adopting a third-party bundle that happens to share a
    /// name with one of the fleet's. Burrow reports such a thing as "not ours"
    /// rather than silently treating it as an install it may later replace or
    /// delete.
    pub fn is_ours(&self) -> bool {
        self.identifier
            .as_deref()
            .is_some_and(|id| OWNED_PREFIXES.iter().any(|p| id.starts_with(p)))
    }
}

/// Read `Contents/Info.plist` from a bundle directory.
///
/// Uses a real plist parser rather than a substring scan because plists come
/// in two encodings — the fleet ships XML, but a binary plist is equally valid
/// and a text scan would silently find nothing in one.
pub fn read_bundle(path: &Path) -> Option<BundleIdentity> {
    let plist_path = path.join("Contents").join("Info.plist");
    if !plist_path.is_file() {
        return None;
    }
    let value = plist::Value::from_file(&plist_path).ok()?;
    let dict = value.as_dictionary()?;
    let s = |k: &str| dict.get(k).and_then(|v| v.as_string()).map(str::to_string);
    Some(BundleIdentity {
        identifier: s("CFBundleIdentifier"),
        // CFBundleVersion is what the fleet's CMake stamps with PROJECT_VERSION.
        // CFBundleShortVersionString is the fallback for anything that sets
        // only the marketing version.
        version: s("CFBundleVersion").or_else(|| s("CFBundleShortVersionString")),
        name: s("CFBundleName"),
    })
}

/// The version of an installed payload entry, if it can be known.
///
/// Returns None for every Windows payload and for anything that is not a
/// bundle — which is expected, not exceptional.
pub fn payload_version(entry: &Path) -> Option<String> {
    read_bundle(entry).and_then(|b| b.version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_bundle(root: &Path, name: &str, ident: &str, version: &str) -> std::path::PathBuf {
        let b = root.join(name);
        fs::create_dir_all(b.join("Contents").join("MacOS")).unwrap();
        fs::write(
            b.join("Contents").join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{ident}</string>
  <key>CFBundleName</key><string>Thing</string>
  <key>CFBundleVersion</key><string>{version}</string>
</dict>
</plist>"#
            ),
        )
        .unwrap();
        b
    }

    #[test]
    fn reads_the_version_and_identifier_from_a_bundle() {
        let t = TempDir::new().unwrap();
        let b = make_bundle(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.2");
        let id = read_bundle(&b).unwrap();
        assert_eq!(id.version.as_deref(), Some("1.0.2"));
        assert!(id.is_ours());
    }

    #[test]
    fn the_older_personal_namespace_is_still_ours() {
        // LumaKey is the fleet's oldest plugin and ships
        // com.allansargeant.ffgl.lumakey. Every copy already installed on
        // somebody's machine carries that, whatever the fleet does next, so
        // refusing it would make Luma Keyer permanently invisible to Burrow.
        let t = TempDir::new().unwrap();
        let b = make_bundle(t.path(), "LumaKey.bundle", "com.allansargeant.ffgl.lumakey", "1.0.0");
        assert!(read_bundle(&b).unwrap().is_ours());
    }

    #[test]
    fn a_third_party_bundle_is_not_ours() {
        // The negative control that matters: the Extra Effects folder on a real
        // machine also holds Metal_Gain_Example.bundle and WebLinked.bundle.
        let t = TempDir::new().unwrap();
        let b = make_bundle(t.path(), "Metal_Gain_Example.bundle", "com.example.metalgain", "1.0");
        assert!(!read_bundle(&b).unwrap().is_ours());
    }

    #[test]
    fn a_payload_with_no_plist_has_no_version_and_that_is_not_an_error() {
        // Every Windows FFGL plugin is a bare .dll, and every Windows OpenFX
        // bundle has Contents/Win64 and no plist.
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("Tinsel.dll"), b"MZ").unwrap();
        assert_eq!(payload_version(&t.path().join("Tinsel.dll")), None);

        let ofx = t.path().join("Tinsel.ofx.bundle");
        fs::create_dir_all(ofx.join("Contents").join("Win64")).unwrap();
        fs::write(ofx.join("Contents").join("Win64").join("Tinsel.ofx"), b"MZ").unwrap();
        assert_eq!(payload_version(&ofx), None);
    }

    #[test]
    fn a_missing_path_is_none_rather_than_a_panic() {
        assert_eq!(payload_version(Path::new("/nowhere/at/all.bundle")), None);
    }
}
