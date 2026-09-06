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
/// ⚠️ **A third one, added 2026-08-25, and it is still not the whole story.**
/// `com.stoatworkslabs.` — note the `labs` — is in real use: Burrow itself,
/// mynah and aquilon-vpu-map all ship it, and none of them started with
/// `com.stoatworks.` because the prefix has a dot in it.
///
/// Reading the identity out of the twenty-two applications on the author's own
/// disk found four namespaces no prefix list would have predicted:
/// `works.stoat.weblinked`, `com.presentationcommander.client`, a bare
/// `wsm-wwb-bridge` and a bare `resolve-configurator-gui`. So this list is a
/// useful heuristic and **not** an ownership test. Where it matters — deciding
/// which project a payload belongs to — the authority is the identifier list
/// the catalogue carries per entry. See `catalog::Entry::identifiers`.
pub const OWNED_PREFIXES: &[&str] =
    &["com.stoatworks.", "com.stoatworkslabs.", "com.allansargeant."];

/// Whether a plist version string is a packager's "nobody set one" default.
///
/// PyInstaller stamps `CFBundleShortVersionString = 0.0.0` when the build hands
/// it no version, and Tauri and Electron default to the same string. Nothing in
/// this fleet has ever released an all-zero version — they start at 0.1.0 — so
/// reading one is evidence that the packaging forgot, not that the payload
/// really is release 0.0.0.
///
/// ⚠️ **This is a version claim being refused, not a version being guessed.**
/// It matters because the plist outranks the ledger in [`crate::ledger`]'s
/// `reconcile_one`, on the grounds that it is the truth about what is on disk —
/// and a truthful read of a plist the packaging never filled in is still wrong.
///
/// Resolve Configurator shipped exactly that for five releases: the DMG around
/// it was named from the tag and correct, and only the bundle inside said
/// 0.0.0. The row read "0.0.0, update available" against the very v0.1.5 the
/// ledger recorded installing, and reinstalling could not clear it — the
/// replacement bundle said 0.0.0 too, so the one control offered was the one
/// thing guaranteed not to work.
///
/// Treating it as absent falls through to the ledger, which is exact whenever
/// Burrow did the install, and to `VersionUnknown` when it did not: an honest
/// "cannot tell from here" instead of a confident wrong number.
pub fn is_unset_version(version: &str) -> bool {
    let v = version.trim().trim_start_matches('v');
    !v.is_empty() && v.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b == b'0'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleIdentity {
    pub identifier: Option<String>,
    /// `CFBundleVersion`, which the plugins' CMake sets from `PROJECT_VERSION`
    /// — so a released bundle's plist carries the release version.
    ///
    /// None both for a bundle that carries no version key and for one whose
    /// version is a packager's all-zero default; see [`is_unset_version`].
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
    // Per key rather than to the result: a bundle whose CFBundleVersion is an
    // all-zero default but whose short string is real should yield the real one.
    let version = |k: &str| s(k).filter(|v| !is_unset_version(v));
    Some(BundleIdentity {
        identifier: s("CFBundleIdentifier"),
        // CFBundleVersion is what the fleet's CMake stamps with PROJECT_VERSION.
        // CFBundleShortVersionString is the fallback for anything that sets
        // only the marketing version.
        version: version("CFBundleVersion").or_else(|| version("CFBundleShortVersionString")),
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
    #[test]
    fn the_labs_prefix_is_recognised_and_the_odd_ones_are_honestly_not() {
        use super::BundleIdentity;
        let id = |s: &str| BundleIdentity {
            identifier: Some(s.to_string()),
            version: None,
            name: None,
        };
        // The one this list was missing. `com.stoatworkslabs.burrow` does not
        // start with `com.stoatworks.` — the prefix ends in a dot.
        assert!(id("com.stoatworkslabs.burrow").is_ours());
        assert!(id("com.stoatworks.ffgl.tinsel").is_ours());
        assert!(id("com.allansargeant.ffgl.lumakey").is_ours());
        assert!(!id("com.example.somebody").is_ours());

        // And the honest part: these four are all this fleet's own software,
        // read off a real disk, and no prefix test will ever accept them. It
        // is why the catalogue carries identifiers per entry.
        for theirs in [
            "works.stoat.weblinked",
            "com.presentationcommander.client",
            "wsm-wwb-bridge",
            "resolve-configurator-gui",
        ] {
            assert!(!id(theirs).is_ours(), "{theirs}");
        }
    }

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
    fn an_all_zero_version_reads_as_no_version_rather_than_release_zero() {
        // Byte for byte the plist Resolve Configurator v0.1.5 shipped:
        // PyInstaller's default short string, and no CFBundleVersion at all.
        let t = TempDir::new().unwrap();
        let b = t.path().join("resolve-configurator-gui.app");
        fs::create_dir_all(b.join("Contents")).unwrap();
        fs::write(
            b.join("Contents").join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>resolve-configurator-gui</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
</dict></plist>"#,
        )
        .unwrap();
        assert_eq!(payload_version(&b), None, "0.0.0 is a default, not a release");
        // The rest of the identity is still read — this refuses one claim, it
        // does not discard the bundle.
        assert_eq!(
            read_bundle(&b).unwrap().identifier.as_deref(),
            Some("resolve-configurator-gui")
        );
    }

    #[test]
    fn a_zero_long_version_does_not_hide_a_real_short_one() {
        let t = TempDir::new().unwrap();
        let b = t.path().join("Thing.app");
        fs::create_dir_all(b.join("Contents")).unwrap();
        fs::write(
            b.join("Contents").join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleVersion</key><string>0.0.0</string>
<key>CFBundleShortVersionString</key><string>1.4.2</string>
</dict></plist>"#,
        )
        .unwrap();
        assert_eq!(payload_version(&b).as_deref(), Some("1.4.2"));
    }

    #[test]
    fn only_an_all_zero_version_counts_as_unset() {
        for unset in ["0.0.0", "0.0", "0", "0.0.0.0", "v0.0.0", " 0.0.0 "] {
            assert!(is_unset_version(unset), "{unset}");
        }
        // Everything a real release looks like, including the smallest one any
        // project in the fleet has actually cut.
        for real in ["0.0.1", "0.1.0", "1.0.0", "v0.1.5", "0.0.0-beta", "", "unknown"] {
            assert!(!is_unset_version(real), "{real}");
        }
    }

    #[test]
    fn a_missing_path_is_none_rather_than_a_panic() {
        assert_eq!(payload_version(Path::new("/nowhere/at/all.bundle")), None);
    }
}
