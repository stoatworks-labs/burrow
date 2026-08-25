//! What Burrow installed, and reconciling that against what is actually there.
//!
//! # Why a ledger exists at all
//!
//! On macOS an installed bundle carries its version in `Contents/Info.plist`,
//! so Burrow could in principle read the disk and never keep records. On
//! Windows it cannot: an FFGL plugin is a bare `.dll` and an OpenFX one is a
//! bundle with no plist, and neither carries a version resource. Without a
//! ledger, every Windows install would be permanently "version unknown".
//!
//! # Why the ledger is not simply believed
//!
//! Because it is a claim about the past and the disk is the present, and they
//! diverge in a way that is not hypothetical. On the machine this was written
//! on, `~/Documents/Resolume Arena/Extra Effects/Tinsel.bundle` reports
//! `CFBundleVersion 0.2.0` while the shipping release is `1.0.2` — a local
//! development build, dropped there by `cmake --install`, long after any
//! Burrow install would have recorded 1.0.2.
//!
//! So the precedence is: **the plist beats the ledger**, and the ledger is
//! trusted only when the payload still hashes to what was recorded. The ledger
//! answers "what did I put here", the disk answers "what is here", and when
//! they disagree the disk wins, because the disk is what the host will load.
//!
//! # Why nothing is ever globbed
//!
//! A real `Extra Effects` folder is shared. The one on this machine also holds
//! `WebLinked.bundle`, `Metal_Gain_Example.bundle` and five `OFX_*_Example`
//! bundles from the FFGL SDK. Burrow considers **only** entry names the
//! catalogue declares for a given plugin and format, and on macOS additionally
//! requires the bundle identifier to start with `com.stoatworks.`. Anything
//! else is invisible to it — not skipped, not listed, not counted. An
//! installer that enumerates a directory it does not own is one bug away from
//! deleting somebody else's work.

use crate::bundleinfo;
use crate::hashing;
use crate::model::{compare_versions, Format, InstallState, VersionCmp, VersionSource};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ledger {
    pub schema: u32,
    pub entries: Vec<LedgerEntry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger { schema: SCHEMA, entries: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub slug: String,
    pub format: Format,
    /// Which destination this went into.
    ///
    /// Part of the identity key, not decoration: on macOS one FFGL plugin can
    /// be installed into Arena *and* Avenue at once. Keying on (slug, format)
    /// alone would make uninstalling from Arena silently forget the Avenue
    /// copy and orphan it forever.
    pub destination_id: String,
    pub destination: PathBuf,
    /// The exact top-level names written. Never a pattern.
    ///
    /// A list because one release can carry several: downpour ships
    /// `Downpour.bundle` and `Downpour Over.bundle`, orrery ships
    /// `Orrery Mask.bundle`, vectrix ships `Vectrix Trace.bundle`.
    pub entries: Vec<String>,
    pub version: String,
    pub installed_at: String,
    /// Deterministic hash of what was written, so the ledger's version claim
    /// can be checked against the bytes still on disk.
    pub payload_sha256: String,
    /// This entry came from the user adopting something already on disk rather
    /// than from an install Burrow performed.
    ///
    /// A claimed payload is managed exactly like an installed one — that is
    /// the whole point of claiming — so **nothing about install, update or
    /// uninstall branches on this**. It is read for one thing only: listing
    /// what the user adopted, so they can hand it back without deleting it.
    /// Releasing is the only non-destructive way out of a wrong claim, and it
    /// cannot be offered without knowing which entries were claims.
    ///
    /// It also means a person reading `ledger.json` and wondering why Burrow
    /// believes it owns something can see the answer. `serde(default)` keeps
    /// every file written before claiming existed loading unchanged.
    #[serde(default)]
    pub claimed: bool,
}

impl Ledger {
    pub fn key(&self, slug: &str, format: Format, dest_id: &str) -> Option<&LedgerEntry> {
        self.entries.iter().find(|e| {
            e.slug == slug && e.format == format && e.destination_id == dest_id
        })
    }

    pub fn upsert(&mut self, entry: LedgerEntry) {
        if let Some(existing) = self.entries.iter_mut().find(|e| {
            e.slug == entry.slug
                && e.format == entry.format
                && e.destination_id == entry.destination_id
        }) {
            *existing = entry;
        } else {
            self.entries.push(entry);
        }
    }

    pub fn remove(&mut self, slug: &str, format: Format, dest_id: &str) {
        self.entries
            .retain(|e| !(e.slug == slug && e.format == format && e.destination_id == dest_id));
    }
}

/// What reconciliation found for one (plugin, format, destination).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciled {
    pub slug: String,
    pub format: Format,
    pub destination_id: String,
    pub state: InstallState,
    /// Entries the ledger records that are no longer on disk. A non-empty list
    /// alongside a present install is the signature of a half-finished
    /// uninstall, and the UI can offer to finish it.
    pub missing: Vec<String>,
    /// A payload is present under a name we expect, but it is not ours.
    pub foreign: bool,
}

/// Reconcile one (plugin, format, destination) against the disk.
///
/// `declared` is what the catalogue says this plugin's payload is called for
/// this format and platform — the only names that will be looked at.
/// `has_asset` is whether the catalogue has an artefact here at all.
/// `latest` is the catalogue's current version.
///
/// # Why those are two arguments and not one
///
/// They used to be one: an empty `declared` meant "no build for this platform",
/// which was true while every entry in the catalogue was a video plugin, since
/// those carry payload names read out of the archive at release time.
///
/// It stopped being true the moment the catalogue grew applications, audio
/// plugins and Companion modules, whose names nothing has probed. Left as it
/// was, every one of them would have reported "no build for your machine" while
/// sitting beside a perfectly good download — the most confusing possible way
/// to fail, because the row would look like a platform problem.
///
/// So: `has_asset` decides whether there is anything on offer, and `declared`
/// decides what to look for. Where the catalogue declares nothing, the ledger's
/// own record of what it installed is used instead — which is exact for
/// anything Burrow installed, and blank for a copy somebody installed by hand.
/// Not being able to see a hand-installed application is a degraded answer, not
/// a wrong one; Burrow learns the names the first time it installs one.
///
/// A pure-ish function: it reads the filesystem but makes no decisions from
/// anything else, which is what makes it the single most testable and most
/// valuable unit in the project.
///
/// Eight arguments, which clippy is right to raise and wrong about here: every
/// one of them is a distinct fact this needs, none can be derived from the
/// others, and bundling them into a struct would move the argument list to the
/// call site without shortening it. The alternative it is warning against —
/// passing the catalogue entry and the destination whole — is what would make
/// this untestable, because a test would then have to build both.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_one(
    ledger: &Ledger,
    slug: &str,
    format: Format,
    dest_id: &str,
    dest: &Path,
    declared: &[String],
    has_asset: bool,
    latest: Option<&str>,
) -> Reconciled {
    let record = ledger.key(slug, format, dest_id);

    let mut base = Reconciled {
        slug: slug.to_string(),
        format,
        destination_id: dest_id.to_string(),
        state: InstallState::NotInstalled,
        missing: Vec::new(),
        foreign: false,
    };

    // No artefact for this format on this platform — cartridge has no Windows
    // build, most plugins have no Adobe build. Distinct from "not installed",
    // because there is nothing to offer.
    if !has_asset && record.is_none() {
        base.state = InstallState::NoBuild;
        return base;
    }

    // Only declared names are ever considered — never a directory listing.
    // This is the line that keeps every foreign bundle in a shared folder
    // invisible, and it is why the fallback below is the ledger rather than
    // "whatever is in there".
    let recorded: Vec<String> = record.map(|r| r.entries.clone()).unwrap_or_default();
    let names: &[String] = if declared.is_empty() { &recorded } else { declared };
    if names.is_empty() {
        return base;
    }
    let present: Vec<&String> = names.iter().filter(|n| dest.join(n).exists()).collect();

    if let Some(rec) = record {
        base.missing = rec
            .entries
            .iter()
            .filter(|n| !dest.join(n).exists())
            .cloned()
            .collect();
    }

    if present.is_empty() {
        return base;
    }

    // Attribution. On macOS a bundle tells us whether it is ours; a foreign
    // bundle sharing a name is reported rather than adopted, because adopting
    // it makes Burrow willing to replace or delete somebody else's file.
    let mut identity_version: Option<String> = None;
    let mut saw_ours = false;
    let mut saw_foreign = false;
    for name in &present {
        let p = dest.join(name);
        match bundleinfo::read_bundle(&p) {
            Some(id) if id.is_ours() => {
                saw_ours = true;
                if identity_version.is_none() {
                    identity_version = id.version;
                }
            }
            Some(_) => saw_foreign = true,
            // No plist: every Windows payload, and any non-bundle. Not
            // evidence either way about ownership.
            None => {}
        }
    }
    if saw_foreign && !saw_ours {
        base.foreign = true;
        base.state = InstallState::NotInstalled;
        return base;
    }

    // Version, in precedence order.
    let resolved: Option<(String, VersionSource)> = if let Some(v) = identity_version {
        Some((v, VersionSource::InfoPlist))
    } else if let Some(rec) = record {
        // The ledger is believed only if the bytes still match what it
        // describes. Without this gate it would keep asserting a version for a
        // payload somebody has since replaced by hand.
        let unchanged = hashing::hash_entries(dest, &rec.entries)
            .map(|h| h == rec.payload_sha256)
            .unwrap_or(false);
        unchanged.then(|| (rec.version.clone(), VersionSource::Ledger))
    } else {
        None
    };

    base.state = match (resolved, latest) {
        (Some((installed, source)), Some(latest)) => {
            match compare_versions(&installed, latest) {
                VersionCmp::Same => InstallState::UpToDate { version: installed, source },
                // Older, newer or merely different all mean "what is here is
                // not what the catalogue ships". A locally built 0.2.0 and a
                // future 2.0.0 are both worth showing.
                _ => InstallState::UpdateAvailable {
                    installed,
                    latest: latest.to_string(),
                    source,
                },
            }
        }
        (Some((version, source)), None) => InstallState::UpToDate { version, source },
        (None, _) => InstallState::VersionUnknown {
            entries: present.iter().map(|s| s.to_string()).collect(),
        },
    };

    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn bundle(root: &Path, name: &str, ident: &str, version: &str) {
        let b = root.join(name);
        fs::create_dir_all(b.join("Contents").join("MacOS")).unwrap();
        fs::write(b.join("Contents").join("MacOS").join("bin"), b"binary").unwrap();
        fs::write(
            b.join("Contents").join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{ident}</string>
<key>CFBundleVersion</key><string>{version}</string>
</dict></plist>"#
            ),
        )
        .unwrap();
    }

    fn decl(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn go(
        ledger: &Ledger,
        dest: &Path,
        declared: &[String],
        latest: Option<&str>,
    ) -> Reconciled {
        // The tests here are all video plugins, which always have both: an
        // artefact and the payload names read out of it at release time.
        reconcile_one(ledger, "tinsel", Format::Ffgl, "arena", dest, declared, !declared.is_empty(), latest)
    }

    #[test]
    fn nothing_on_disk_is_not_installed() {
        let t = TempDir::new().unwrap();
        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert_eq!(r.state, InstallState::NotInstalled);
    }

    #[test]
    fn no_declared_artefact_is_no_build_not_not_installed() {
        // cartridge on Windows: there is nothing to offer, which is a
        // different thing from "you have not installed it yet".
        let t = TempDir::new().unwrap();
        let r = go(&Ledger::default(), t.path(), &[], Some("v0.1.1"));
        assert_eq!(r.state, InstallState::NoBuild);
    }

    #[test]
    fn a_current_bundle_is_up_to_date_from_its_plist() {
        let t = TempDir::new().unwrap();
        bundle(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.2");
        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert_eq!(
            r.state,
            InstallState::UpToDate {
                version: "1.0.2".into(),
                source: VersionSource::InfoPlist
            }
        );
    }

    #[test]
    fn the_live_stale_dev_build_reads_as_an_update_with_no_ledger_at_all() {
        // Exactly the state of this machine: a hand-built 0.2.0 sitting in
        // Extra Effects, never installed by Burrow, against a 1.0.2 release.
        let t = TempDir::new().unwrap();
        bundle(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "0.2.0");
        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert_eq!(
            r.state,
            InstallState::UpdateAvailable {
                installed: "0.2.0".into(),
                latest: "v1.0.2".into(),
                source: VersionSource::InfoPlist
            }
        );
    }

    #[test]
    fn the_plist_beats_a_ledger_that_disagrees_with_it() {
        // Burrow installed 1.0.2, then someone ran `cmake --install` over it.
        // The ledger says 1.0.2; the disk says 0.2.0; the host will load
        // 0.2.0, so that is what the user must be told.
        let t = TempDir::new().unwrap();
        bundle(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "0.2.0");
        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "tinsel".into(),
            format: Format::Ffgl,
            destination_id: "arena".into(),
            destination: t.path().into(),
            entries: vec!["Tinsel.bundle".into()],
            version: "v1.0.2".into(),
            installed_at: "2026-08-24T00:00:00Z".into(),
            payload_sha256: "stale-hash".into(),
            claimed: false,
        });
        let r = go(&l, t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        match r.state {
            InstallState::UpdateAvailable { installed, source, .. } => {
                assert_eq!(installed, "0.2.0");
                assert_eq!(source, VersionSource::InfoPlist);
            }
            other => panic!("expected an update from the plist, got {other:?}"),
        }
    }

    #[test]
    fn a_windows_style_payload_with_no_plist_is_version_unknown() {
        // The permanent state of every Windows install, and it is normal.
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("Tinsel.dll"), b"MZ").unwrap();
        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.dll"]), Some("v1.0.2"));
        assert_eq!(
            r.state,
            InstallState::VersionUnknown { entries: vec!["Tinsel.dll".into()] }
        );
    }

    #[test]
    fn the_ledger_supplies_the_version_when_the_payload_cannot_and_still_matches() {
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("Tinsel.dll"), b"MZ real content").unwrap();
        let entries = vec!["Tinsel.dll".to_string()];
        let hash = hashing::hash_entries(t.path(), &entries).unwrap();
        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "tinsel".into(),
            format: Format::Ffgl,
            destination_id: "arena".into(),
            destination: t.path().into(),
            entries: entries.clone(),
            version: "v1.0.2".into(),
            installed_at: "2026-08-24T00:00:00Z".into(),
            payload_sha256: hash,
            claimed: false,
        });
        let r = go(&l, t.path(), &entries, Some("v1.0.2"));
        assert_eq!(
            r.state,
            InstallState::UpToDate {
                version: "v1.0.2".into(),
                source: VersionSource::Ledger
            }
        );
    }

    #[test]
    fn a_ledger_whose_payload_changed_underneath_it_is_not_believed() {
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("Tinsel.dll"), b"MZ replaced by hand").unwrap();
        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "tinsel".into(),
            format: Format::Ffgl,
            destination_id: "arena".into(),
            destination: t.path().into(),
            entries: vec!["Tinsel.dll".into()],
            version: "v1.0.2".into(),
            installed_at: "2026-08-24T00:00:00Z".into(),
            payload_sha256: "hash-of-something-else".into(),
            claimed: false,
        });
        let r = go(&l, t.path(), &decl(&["Tinsel.dll"]), Some("v1.0.2"));
        // Falls back to unknown rather than asserting a version for bytes it
        // no longer describes.
        assert!(matches!(r.state, InstallState::VersionUnknown { .. }));
    }

    #[test]
    fn a_foreign_bundle_sharing_a_name_is_reported_not_adopted() {
        let t = TempDir::new().unwrap();
        bundle(t.path(), "Tinsel.bundle", "com.someoneelse.tinsel", "9.9.9");
        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert!(r.foreign);
        assert_eq!(r.state, InstallState::NotInstalled);
    }

    #[test]
    fn foreign_bundles_in_the_same_folder_are_completely_invisible() {
        // The real Extra Effects folder on this machine holds all of these.
        // Reconciliation must not see, count or mention any of them.
        let t = TempDir::new().unwrap();
        for name in [
            "WebLinked.bundle",
            "Metal_Gain_Example.bundle",
            "OFX_Gain_Example.bundle",
            "OFX_Invert_Example.bundle",
            "OpenCL_Gain_Example.bundle",
        ] {
            bundle(t.path(), name, "com.example.thing", "1.0");
        }
        bundle(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.2");

        let r = go(&Ledger::default(), t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert!(!r.foreign);
        assert!(matches!(r.state, InstallState::UpToDate { .. }));
    }

    #[test]
    fn a_multi_bundle_plugin_reports_a_half_finished_uninstall() {
        // downpour ships two bundles. One removed by hand is not "installed"
        // and not "gone" — it is a mess, and the UI should offer to finish it.
        let t = TempDir::new().unwrap();
        bundle(t.path(), "Downpour.bundle", "com.stoatworks.ffgl.downpour", "1.0.2");
        let entries = vec!["Downpour.bundle".to_string(), "Downpour Over.bundle".to_string()];
        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "downpour".into(),
            format: Format::Ffgl,
            destination_id: "arena".into(),
            destination: t.path().into(),
            entries: entries.clone(),
            version: "v1.0.2".into(),
            installed_at: "2026-08-24T00:00:00Z".into(),
            payload_sha256: "whatever".into(),
            claimed: false,
        });
        let r = reconcile_one(
            &l,
            "downpour",
            Format::Ffgl,
            "arena",
            t.path(),
            &entries,
            true,
            Some("v1.0.2"),
        );
        assert_eq!(r.missing, vec!["Downpour Over.bundle".to_string()]);
        assert!(matches!(r.state, InstallState::UpToDate { .. }));
    }

    #[test]
    fn an_artefact_with_no_declared_names_is_offered_rather_than_reported_as_no_build() {
        // The bug this exists for, in the form it would have taken: every
        // application, audio plugin and Companion module reading "no build for
        // your machine" while sitting beside a perfectly good download,
        // because nothing has probed their archives for payload names.
        let t = TempDir::new().unwrap();
        let r = reconcile_one(
            &Ledger::default(),
            "simplevis",
            Format::App,
            "applications",
            t.path(),
            &[],
            true, // there is an artefact
            Some("v0.4.0"),
        );
        assert_eq!(r.state, InstallState::NotInstalled);

        // And with no artefact either, it is still "no build".
        let r = reconcile_one(
            &Ledger::default(),
            "simplevis",
            Format::App,
            "applications",
            t.path(),
            &[],
            false,
            Some("v0.4.0"),
        );
        assert_eq!(r.state, InstallState::NoBuild);
    }

    #[test]
    fn what_burrow_installed_is_recognised_from_the_ledger_when_the_catalogue_declares_nothing() {
        // The other half: once Burrow has installed an application it knows
        // exactly what it placed, so the row reports the truth from then on
        // even though the catalogue never named it.
        let t = TempDir::new().unwrap();
        bundle(t.path(), "simpleVIS.app", "com.allansargeant.simplevis", "0.4.0");

        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "simplevis".into(),
            format: Format::App,
            destination_id: "applications".into(),
            destination: t.path().into(),
            entries: vec!["simpleVIS.app".into()],
            version: "v0.4.0".into(),
            installed_at: "2026-08-25T00:00:00Z".into(),
            payload_sha256: "whatever".into(),
            claimed: false,
        });

        let r = reconcile_one(
            &l,
            "simplevis",
            Format::App,
            "applications",
            t.path(),
            &[],
            true,
            Some("v0.4.0"),
        );
        assert!(matches!(r.state, InstallState::UpToDate { .. }), "{:?}", r.state);
        assert!(!r.foreign);
    }

    #[test]
    fn the_same_plugin_in_two_destinations_is_two_independent_records() {
        let arena = TempDir::new().unwrap();
        let avenue = TempDir::new().unwrap();
        bundle(arena.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.2");
        // Avenue has nothing.
        let d = decl(&["Tinsel.bundle"]);
        let a = reconcile_one(
            &Ledger::default(), "tinsel", Format::Ffgl, "arena", arena.path(), &d, true, Some("v1.0.2"),
        );
        let b = reconcile_one(
            &Ledger::default(), "tinsel", Format::Ffgl, "avenue", avenue.path(), &d, true, Some("v1.0.2"),
        );
        assert!(matches!(a.state, InstallState::UpToDate { .. }));
        assert_eq!(b.state, InstallState::NotInstalled);
    }

    #[test]
    fn a_ledger_row_whose_files_all_vanished_reads_as_not_installed() {
        let t = TempDir::new().unwrap();
        let mut l = Ledger::default();
        l.upsert(LedgerEntry {
            slug: "tinsel".into(),
            format: Format::Ffgl,
            destination_id: "arena".into(),
            destination: t.path().into(),
            entries: vec!["Tinsel.bundle".into()],
            version: "v1.0.2".into(),
            installed_at: "2026-08-24T00:00:00Z".into(),
            payload_sha256: "x".into(),
            claimed: false,
        });
        let r = go(&l, t.path(), &decl(&["Tinsel.bundle"]), Some("v1.0.2"));
        assert_eq!(r.state, InstallState::NotInstalled);
        assert_eq!(r.missing, vec!["Tinsel.bundle".to_string()]);
    }

    #[test]
    fn the_ledger_keys_on_destination_so_arena_and_avenue_do_not_collide() {
        let mut l = Ledger::default();
        for dest in ["arena", "avenue"] {
            l.upsert(LedgerEntry {
                slug: "tinsel".into(),
                format: Format::Ffgl,
                destination_id: dest.into(),
                destination: PathBuf::from("/x").join(dest),
                entries: vec!["Tinsel.bundle".into()],
                version: "v1.0.2".into(),
                installed_at: "2026-08-24T00:00:00Z".into(),
                payload_sha256: "x".into(),
                claimed: false,
            });
        }
        assert_eq!(l.entries.len(), 2);
        l.remove("tinsel", Format::Ffgl, "arena");
        assert_eq!(l.entries.len(), 1);
        assert_eq!(l.entries[0].destination_id, "avenue");
    }
}
