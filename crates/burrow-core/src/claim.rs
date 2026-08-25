//! Adopting a copy somebody installed by hand.
//!
//! # What this is for
//!
//! Burrow can already see a hand-installed *video plugin*: the catalogue
//! declares what its payload is called, so `reconcile_one` knows which names
//! to look at, and the bundle identifier confirms whose it is. Nothing probes
//! an application, an audio plugin or a Companion module — see AGENTS §4 — so
//! for those the catalogue declares no names, there is nothing to look for,
//! and a copy the user installed themselves is invisible. They get told it is
//! not installed, next to a download button, while it sits in
//! `/Applications`.
//!
//! Claiming is the user saying: *that one is this project — manage it.* It
//! writes the same ledger entry an install would, so from then on the row
//! reports its version, offers an update, and can uninstall it.
//!
//! # Why this is allowed to read a directory
//!
//! The fleet's hardest rule is that Burrow never enumerates a plugin folder
//! (AGENTS §3): a real `Extra Effects` holds other people's work, and an
//! installer that lists a directory it does not own is one bug away from
//! deleting somebody else's file.
//!
//! That rule is about what Burrow will *act* on. Scanning here produces
//! **candidates to show a person**, never an adoption. Nothing in this module
//! writes, moves or deletes anything, and a candidate only becomes a ledger
//! entry when the user picks it. The scan is also not a name match: a
//! directory entry is a candidate only when the identifier inside it is one
//! the catalogue lists for that project. That is a far narrower test than the
//! name-based one used everywhere else, because an identifier is inside the
//! bundle and cannot be arranged by giving a file a familiar name.
//!
//! # What cannot be recognised
//!
//! Anything with no identifier to read: every Windows payload, a bare `.dll`,
//! an OpenFX bundle with no plist, and every Companion module. Those can still
//! be claimed, but only by the user naming the project themselves — there is
//! no evidence to offer, and [`Candidate::evidence`] says so.

use crate::bundleinfo;
use crate::hashing;
use crate::ledger::LedgerEntry;
use crate::model::Format;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Identifier → slug, built once from the catalogue.
///
/// A map rather than a scan of every entry per candidate: one destination can
/// hold a hundred bundles and the catalogue sixty-eight projects, and the
/// answer has to be exact rather than nearly right.
#[derive(Debug, Clone, Default)]
pub struct IdentifierIndex(HashMap<String, String>);

impl IdentifierIndex {
    /// Build from `(slug, identifiers)` pairs.
    ///
    /// A duplicate identifier across two projects is dropped rather than
    /// arbitrarily assigned — a candidate that could be either is one Burrow
    /// must not guess about. The website asserts there are none, so this is a
    /// belt to that brace rather than an expected case.
    pub fn build<'a>(entries: impl Iterator<Item = (&'a str, &'a [String])>) -> Self {
        let mut seen: HashMap<String, Option<String>> = HashMap::new();
        for (slug, ids) in entries {
            for id in ids {
                seen.entry(id.clone())
                    .and_modify(|v| {
                        if v.as_deref() != Some(slug) {
                            *v = None;
                        }
                    })
                    .or_insert_with(|| Some(slug.to_string()));
            }
        }
        IdentifierIndex(seen.into_iter().filter_map(|(k, v)| v.map(|s| (k, s))).collect())
    }

    pub fn slug_for(&self, identifier: &str) -> Option<&str> {
        self.0.get(identifier).map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Why Burrow believes a candidate is what it says it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Evidence {
    /// The identifier inside the payload is one the catalogue lists for this
    /// project. The only evidence worth the name.
    Identifier,
    /// Nothing in the payload says whose it is — every Windows one, and any
    /// bundle with no plist. Offered only because the user asked about this
    /// project specifically, and adopted only on their say-so.
    UserAsserted,
}

/// Something on disk that could be claimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The catalogue entry this belongs to.
    pub slug: String,
    /// The top-level name, exactly as it is on disk. Never a pattern, and it
    /// is this string that a claim records.
    pub name: String,
    pub identifier: Option<String>,
    /// From the payload's own plist. `None` for anything that carries none,
    /// which a claim records as an unknown version rather than inventing one.
    pub version: Option<String>,
    pub evidence: Evidence,
}

/// Everything in `dest` that the catalogue can identify, and is not already
/// recorded.
///
/// `already` is the set of names the ledger holds for this destination —
/// passed in rather than looked up so this stays free of the ledger's shape
/// and can be tested with a literal.
pub fn scan(
    dest: &Path,
    index: &IdentifierIndex,
    already: &[String],
) -> Vec<Candidate> {
    let Ok(dir) = std::fs::read_dir(dest) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in dir.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        // A dotfile is never a payload, and `.DS_Store` is in every folder
        // anyone has ever opened in the Finder.
        if name.starts_with('.') || already.contains(&name) {
            continue;
        }
        let Some(id) = bundleinfo::read_bundle(&item.path()) else {
            continue;
        };
        let Some(identifier) = id.identifier.clone() else {
            continue;
        };
        let Some(slug) = index.slug_for(&identifier) else {
            continue;
        };
        out.push(Candidate {
            slug: slug.to_string(),
            name,
            identifier: Some(identifier),
            version: id.version.clone(),
            evidence: Evidence::Identifier,
        });
    }
    // Stable order, so the same folder always presents the same list.
    out.sort_by(|a, b| (&a.slug, &a.name).cmp(&(&b.slug, &b.name)));
    out
}

/// The ledger entry a claim writes.
///
/// Deliberately the same shape an install writes, because a claimed payload is
/// managed exactly like an installed one — that was the explicit choice. The
/// hash is taken now, over what is actually there, so the ledger's version
/// claim is checkable against the bytes in the same way and stops being
/// believed the moment somebody replaces the payload by hand.
///
/// `claimed` is recorded but nothing reads it: it is there so the file says
/// how an entry got in, which matters when somebody is looking at a ledger
/// wondering why Burrow thinks it owns something.
pub fn entry_for(
    slug: &str,
    format: Format,
    destination_id: &str,
    dest: &Path,
    names: &[String],
    version: Option<&str>,
    now: &str,
) -> Result<LedgerEntry, String> {
    if names.is_empty() {
        return Err("nothing named to claim".into());
    }
    for n in names {
        if !dest.join(n).exists() {
            return Err(format!("{n} is not in {}", dest.display()));
        }
    }
    let payload_sha256 = hashing::hash_entries(dest, names)
        .map_err(|e| format!("could not read what is there: {e}"))?;
    Ok(LedgerEntry {
        slug: slug.to_string(),
        format,
        destination_id: destination_id.to_string(),
        destination: dest.to_path_buf(),
        entries: names.to_vec(),
        // An empty version is what the rest of the code already uses for "no
        // readable version"; reconciliation then falls back to the disk and,
        // failing that, reports version-unknown.
        version: version.unwrap_or_default().to_string(),
        installed_at: now.to_string(),
        payload_sha256,
        claimed: true,
    })
}

/// Candidates that cannot both be claimed, because the ledger keys on
/// (slug, format, destination) and so has room for one payload per project per
/// folder.
///
/// Not hypothetical, and found by running the scan over a real
/// `/Applications` rather than by reasoning about it: flock ships `flock.app`
/// **and** `flock Launcher.app`, RFutils and SRT Router do the same, and
/// LEQtion has a stable and a NEXT beta installed side by side under one
/// identifier. Claiming the second would overwrite the record of the first and
/// orphan a file Burrow had been told it owns.
///
/// The UI uses this to say so on the row before the user picks, rather than
/// letting them find out by having the first claim quietly disappear.
pub fn contested(candidates: &[Candidate]) -> Vec<(String, Vec<String>)> {
    let mut by_slug: HashMap<&str, Vec<String>> = HashMap::new();
    for c in candidates {
        by_slug.entry(&c.slug).or_default().push(c.name.clone());
    }
    let mut out: Vec<(String, Vec<String>)> = by_slug
        .into_iter()
        .filter(|(_, names)| names.len() > 1)
        .map(|(slug, mut names)| {
            names.sort();
            (slug.to_string(), names)
        })
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn index() -> IdentifierIndex {
        let tinsel = vec!["com.stoatworks.ffgl.tinsel".to_string()];
        let weblinked = vec!["works.stoat.weblinked".to_string()];
        let bridge = vec!["wsm-wwb-bridge".to_string()];
        let v: Vec<(&str, Vec<String>)> = vec![
            ("tinsel", tinsel),
            ("weblinked", weblinked),
            ("wsm-wwb-bridge", bridge),
        ];
        let leaked: &'static Vec<(&str, Vec<String>)> = Box::leak(Box::new(v));
        IdentifierIndex::build(leaked.iter().map(|(s, i)| (*s, i.as_slice())))
    }

    fn app(dir: &Path, name: &str, identifier: &str, version: &str) {
        let c = dir.join(name).join("Contents");
        fs::create_dir_all(&c).unwrap();
        fs::write(
            c.join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{identifier}</string>
<key>CFBundleVersion</key><string>{version}</string>
</dict></plist>"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn a_namespace_no_prefix_test_would_accept_is_still_matched() {
        // The reason the catalogue carries identifiers at all. Both of these
        // are real: WebLinked's app is `works.stoat.weblinked` and the WSM
        // bridge's is a bare `wsm-wwb-bridge` with no reversed domain. A test
        // on `com.stoatworks.` would call this fleet's own software foreign.
        let t = TempDir::new().unwrap();
        app(t.path(), "WebLinked.app", "works.stoat.weblinked", "1.0.0");
        app(t.path(), "wsm-wwb-bridge.app", "wsm-wwb-bridge", "1.1.0");
        let found = scan(t.path(), &index(), &[]);
        let slugs: Vec<&str> = found.iter().map(|c| c.slug.as_str()).collect();
        assert_eq!(slugs, vec!["weblinked", "wsm-wwb-bridge"]);
        assert!(found.iter().all(|c| c.evidence == Evidence::Identifier));
    }

    #[test]
    fn somebody_elses_bundle_is_not_a_candidate() {
        // The whole safety property: a folder Burrow does not own is full of
        // other people's work, and only an identifier the catalogue lists gets
        // as far as being offered.
        let t = TempDir::new().unwrap();
        app(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.3");
        app(t.path(), "Metal_Gain_Example.bundle", "com.apple.example.metalgain", "1.0");
        app(t.path(), "SomeoneElse.app", "org.example.someoneelse", "3.0");
        let found = scan(t.path(), &index(), &[]);
        assert_eq!(found.len(), 1, "only the declared identifier is a candidate");
        assert_eq!(found[0].slug, "tinsel");
        assert_eq!(found[0].version.as_deref(), Some("1.0.3"));
    }

    #[test]
    fn a_name_that_looks_right_is_not_enough() {
        // Naming a file `Tinsel.bundle` must not get it adopted. Everywhere
        // else in Burrow the name is the primary key and the identifier the
        // secondary check; here the identifier is the only thing that counts,
        // because the user has not yet said anything about this file.
        let t = TempDir::new().unwrap();
        app(t.path(), "Tinsel.bundle", "com.somebody.else.tinsel", "9.9.9");
        assert!(scan(t.path(), &index(), &[]).is_empty());
    }

    #[test]
    fn something_already_in_the_ledger_is_not_offered_again() {
        let t = TempDir::new().unwrap();
        app(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.3");
        let already = vec!["Tinsel.bundle".to_string()];
        assert!(scan(t.path(), &index(), &already).is_empty());
    }

    #[test]
    fn an_identifier_two_projects_claim_is_dropped_rather_than_guessed() {
        let both: Vec<(&str, Vec<String>)> = vec![
            ("one", vec!["com.example.shared".to_string()]),
            ("two", vec!["com.example.shared".to_string()]),
        ];
        let idx = IdentifierIndex::build(both.iter().map(|(s, i)| (*s, i.as_slice())));
        assert!(idx.slug_for("com.example.shared").is_none());
    }

    #[test]
    fn claiming_records_the_exact_names_and_hashes_what_is_there() {
        let t = TempDir::new().unwrap();
        app(t.path(), "Tinsel.bundle", "com.stoatworks.ffgl.tinsel", "1.0.3");
        let names = vec!["Tinsel.bundle".to_string()];
        let e = entry_for(
            "tinsel",
            Format::Ffgl,
            "arena",
            t.path(),
            &names,
            Some("1.0.3"),
            "2026-08-25T00:00:00Z",
        )
        .unwrap();
        assert_eq!(e.entries, names);
        assert_eq!(e.version, "1.0.3");
        assert!(e.claimed);
        assert!(!e.payload_sha256.is_empty());
        // The hash must describe what is on disk now, so that reconciliation
        // stops believing the version the moment somebody replaces it.
        let again = hashing::hash_entries(t.path(), &names).unwrap();
        assert_eq!(e.payload_sha256, again);
    }

    #[test]
    fn claiming_something_that_is_not_there_is_an_error_not_an_empty_record() {
        let t = TempDir::new().unwrap();
        let names = vec!["Nothing.app".to_string()];
        assert!(entry_for("x", Format::App, "apps", t.path(), &names, None, "now").is_err());
    }

    #[test]
    fn a_payload_with_no_readable_version_claims_as_unknown() {
        // Every Windows payload. Recording an empty version is what makes
        // reconciliation fall through to "version unknown" rather than assert
        // something invented.
        let t = TempDir::new().unwrap();
        fs::write(t.path().join("thing.dll"), b"MZ").unwrap();
        let names = vec!["thing.dll".to_string()];
        let e = entry_for("x", Format::Ffgl, "arena", t.path(), &names, None, "now").unwrap();
        assert_eq!(e.version, "");
    }

    #[test]
    fn two_bundles_of_one_project_in_one_folder_are_reported_as_contested() {
        // Real: flock ships `flock.app` and `flock Launcher.app`, and LEQtion
        // has a stable and a NEXT beta side by side under one identifier. The
        // ledger has room for one payload per project per folder, so the
        // second claim would orphan the first — the UI has to say so before
        // the user picks, not after.
        let c = |slug: &str, name: &str| Candidate {
            slug: slug.into(),
            name: name.into(),
            identifier: None,
            version: None,
            evidence: Evidence::Identifier,
        };
        let found = vec![
            c("flock", "flock Launcher.app"),
            c("flock", "flock.app"),
            c("simplevis", "simpleVIS.app"),
        ];
        assert_eq!(
            contested(&found),
            vec![("flock".to_string(), vec!["flock Launcher.app".to_string(), "flock.app".to_string()])]
        );
    }

    #[test]
    fn a_destination_that_does_not_exist_yields_nothing_rather_than_failing() {
        assert!(scan(Path::new("/nowhere/at/all"), &index(), &[]).is_empty());
    }
}
