//! The catalogue Burrow reads from `stoatworks-labs.com/catalog.json`.
//!
//! Parsing is deliberately forgiving about *additions* and strict about
//! *shape*. A newer catalogue may carry formats, fields and entry kinds this
//! build has never heard of, and it must still load — a website deploy should
//! never brick a copy of Burrow already in the field. What it may not do is
//! arrive as something other than the catalogue: see [`parse`].

use crate::model::{Arch, Category, Format, Platform};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The schema this build understands.
pub const KNOWN_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    pub schema: u32,
    pub generated: String,
    #[serde(default)]
    pub formats: BTreeMap<String, FormatInfo>,
    /// Category id → how to name it, sent for the same reason `formats` is:
    /// so the website can add a category and have it appear correctly labelled
    /// in a copy of Burrow nobody has updated. Empty on a schema-1 catalogue,
    /// which predates categories entirely — see [`Entry::category`].
    #[serde(default)]
    pub categories: BTreeMap<String, CategoryInfo>,
    /// Status id → how to say it out loud, and what it means.
    ///
    /// The vocabulary lives in the website's `projects.json` and is sent whole
    /// for the same reason `formats` and `categories` are: an entry carries the
    /// id, and a status this build has never heard of still arrives with its own
    /// label attached.
    #[serde(default)]
    pub statuses: BTreeMap<String, StatusInfo>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusInfo {
    pub label: String,
    #[serde(default)]
    pub blurb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryInfo {
    pub label: String,
    #[serde(default)]
    pub blurb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormatInfo {
    pub label: String,
    pub hosts: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub slug: String,
    pub name: String,
    pub repo: String,
    /// `plugin` today; `app` when Burrow learns to install one. An entry whose
    /// kind this build does not manage is kept and not offered.
    pub kind: String,
    /// Which tab this belongs under.
    ///
    /// Defaults to [`Category::Video`] rather than to unknown, and the reason
    /// is the cached and baked copies: every catalogue written before this
    /// field existed is video plugins and nothing else, so "absent" means
    /// video as a matter of fact, not as a guess. A newer catalogue always
    /// says.
    #[serde(default = "video")]
    pub category: Category,
    /// The slug of the software tool this belongs to, for a thing that is not
    /// used on its own.
    ///
    /// Set on the Companion modules, which exist to drive one specific app —
    /// the app is the reason anyone would install the module. The UI nests
    /// them under their parent rather than listing them as peers.
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub hook: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub blurb: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub release_url: Option<String>,
    #[serde(default)]
    pub releases_url: Option<String>,
    /// The slug of the demo bundled inside Burrow, if there is one.
    #[serde(default)]
    pub demo: Option<String>,
    #[serde(default)]
    pub demo_url: Option<String>,
    #[serde(default)]
    pub guide: Option<String>,
    /// The bare YouTube video id, never a URL.
    ///
    /// Burrow ships each video's still image and opens the video in the user's
    /// own browser, so it never makes a request to YouTube on their behalf —
    /// which would both break the "talks to nothing else" claim and tell
    /// Google which plugins somebody is looking at.
    #[serde(default)]
    pub youtube: Option<String>,
    /// A copy of the video Burrow can stream itself, on a GitHub release.
    ///
    /// Playing our own copy rather than embedding YouTube is what lets the app
    /// say it talks to nothing beyond the plugin list and GitHub, without a
    /// paragraph of caveats. GitHub is already in the trust set: every plugin
    /// comes from there.
    ///
    /// None where no encoded copy exists — the app then offers YouTube in the
    /// browser rather than showing a player that cannot play.
    #[serde(default)]
    pub video_url: Option<String>,
    #[serde(default)]
    pub builds: BTreeMap<Format, BTreeMap<Platform, Asset>>,
    /// Every artefact, flat, with its architecture.
    ///
    /// `builds` cannot express two archives for one (format, platform), and
    /// the software tools need exactly that: almost all of them ship a
    /// separate arm64 and x64 build, where a video plugin ships one universal
    /// bundle. The obvious fix — a third level of nesting inside `builds` —
    /// would change the shape of a field that shipped clients already parse,
    /// and this project has already had one website deploy stop every copy of
    /// Burrow in the field from reading the catalogue at all. So this is
    /// **additive**: a new list beside the old map, preferred when it is
    /// there, ignored by anything that has never heard of it.
    ///
    /// `builds` stays authoritative for anything absent here.
    #[serde(default)]
    pub assets: Vec<FlatAsset>,
    #[serde(default)]
    pub notes: Vec<Note>,
    /// Earlier releases a user can roll back to, newest first.
    ///
    /// Rolling back matters more for this fleet than for most software: the
    /// people using these plugins are often mid-show-week, and a version that
    /// misbehaves on the night needs undoing, not diagnosing.
    ///
    /// Thinner than `builds` on purpose — url and size only. The payload entry
    /// names are not carried, because Burrow reads the real ones out of the
    /// archive as it installs. Assuming an old release had the same bundles
    /// would be wrong: plugins here have gained a second bundle between
    /// versions.
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub tag: String,
    #[serde(default)]
    pub published: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub builds: BTreeMap<Format, BTreeMap<Platform, Asset>>,
    #[serde(default)]
    pub assets: Vec<FlatAsset>,
}

impl VersionEntry {
    /// The artefact to roll back to, for this machine's architecture.
    pub fn asset(&self, format: Format, platform: Platform) -> Option<&Asset> {
        pick(&self.assets, &self.builds, format, platform, Arch::current())
    }
}

/// One artefact, with everything needed to choose between two of them.
///
/// Flattened rather than nested so that adding a dimension — architecture
/// today, something else later — is a new field on a row instead of a new
/// level of map that older clients cannot parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatAsset {
    pub format: Format,
    pub platform: Platform,
    #[serde(default)]
    pub arch: Arch,
    #[serde(flatten)]
    pub asset: Asset,
}

/// Choose the artefact for a (format, platform) on a machine of this
/// architecture, preferring the flat list and falling back to `builds`.
///
/// An exact architecture match wins; a universal build serves anything; and an
/// artefact that names no architecture at all is taken as universal, because
/// that is what it meant for every catalogue written before this field
/// existed. A build for the *other* architecture is never chosen — an arm64
/// binary on an Intel machine is not a degraded install, it is one that cannot
/// run, and "no build" is the honest answer.
fn pick<'a>(
    assets: &'a [FlatAsset],
    builds: &'a BTreeMap<Format, BTreeMap<Platform, Asset>>,
    format: Format,
    platform: Platform,
    arch: Arch,
) -> Option<&'a Asset> {
    let matching = || {
        assets
            .iter()
            .filter(|a| a.format == format && a.platform == platform)
    };
    if let Some(a) = matching().find(|a| a.arch == arch) {
        return Some(&a.asset);
    }
    if let Some(a) = matching().find(|a| a.arch == Arch::Universal) {
        return Some(&a.asset);
    }
    if matching().next().is_some() {
        // The flat list covers this (format, platform) and none of its rows
        // run here. Falling through to `builds` would hand back exactly the
        // artefact just rejected.
        return None;
    }
    builds.get(&format)?.get(&platform)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub url: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub arch: Option<String>,
    /// True when the URL names a specific version rather than the
    /// `/releases/latest/download/` alias. amber and cartridge publish no
    /// alias, so without accepting pinned URLs they would vanish from Burrow
    /// entirely.
    #[serde(default)]
    pub pinned: bool,
    /// The top-level names the archive unpacks to that a host actually loads —
    /// read from the archive's central directory at release time, so Burrow
    /// knows them before downloading anything. This is what lets it recognise
    /// a plugin somebody installed by hand, and remove exactly the right files
    /// when uninstalling one.
    ///
    /// Empty when the probe failed. Burrow then learns the names when it
    /// installs, and until it does it cannot see a hand-installed copy — which
    /// is a degraded answer, not a wrong one.
    #[serde(default)]
    pub entries: Vec<String>,
    /// Everything else in the archive: documentation, sample assets, and in
    /// cartridge's case a command-line helper binary. These ship in the same
    /// zip and must **not** go into a plugin folder — putting a `README.md` and
    /// a `LICENSE` in the user's Resolume directory would be bad enough, but
    /// recording them as ours means a later uninstall deletes files that may
    /// not be.
    #[serde(default)]
    pub extras: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub tag: String,
    #[serde(default)]
    pub published: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub prerelease: bool,
    /// `notes` — a person wrote it. `commits` — nobody did, these are filtered
    /// commit subjects. `maintenance` — the release was entirely plumbing.
    /// `initial` — a first release with nothing to compare against.
    pub kind: String,
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub filtered: u32,
}

fn video() -> Category {
    Category::Video
}

impl Entry {
    /// The artefact for a format on a platform, for this machine's
    /// architecture, if the catalogue has one.
    pub fn asset(&self, format: Format, platform: Platform) -> Option<&Asset> {
        self.asset_for(format, platform, Arch::current())
    }

    /// The same, for a stated architecture. Split out so the choice can be
    /// tested for a machine that is not this one.
    pub fn asset_for(&self, format: Format, platform: Platform, arch: Arch) -> Option<&Asset> {
        pick(&self.assets, &self.builds, format, platform, arch)
    }

    /// Every format this entry has an artefact for *somewhere*, whatever the
    /// platform or architecture.
    ///
    /// This is what decides which destinations an entry is even asked about.
    /// Without it, adding the audio and application formats would give every
    /// video plugin a row of empty VST3, Audio Unit and Application slots, and
    /// every software tool a row of empty FFGL ones.
    ///
    /// A format present here but absent for *this* platform is a real answer —
    /// "no build for your machine" — and that distinction is the whole reason
    /// this is not just `formats_for`.
    pub fn known_formats(&self) -> std::collections::BTreeSet<Format> {
        self.builds
            .keys()
            .copied()
            .chain(self.assets.iter().map(|a| a.format))
            .collect()
    }

    /// The formats this entry actually offers on this platform, in a stable
    /// order, excluding anything this build does not install.
    pub fn formats_for(&self, platform: Platform) -> Vec<Format> {
        Format::SHIPPING
            .iter()
            .copied()
            .filter(|f| self.asset(*f, platform).is_some())
            .collect()
    }

    pub fn is_installable(&self, platform: Platform) -> bool {
        !self.formats_for(platform).is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    /// The body was not JSON, or not this shape. Includes the case that
    /// matters most in practice: a 404 HTML page served with a 200, or a
    /// captive-portal login page, arriving where the catalogue should be.
    NotACatalog(String),
    /// Parsed, but written for a schema this build predates.
    TooNew { found: u32, known: u32 },
    Empty,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogError::NotACatalog(why) => {
                write!(f, "that did not look like the plugin catalogue ({why})")
            }
            CatalogError::TooNew { found, known } => write!(
                f,
                "the catalogue is version {found} and this copy of Burrow understands {known} — update Burrow"
            ),
            CatalogError::Empty => write!(f, "the catalogue was empty"),
        }
    }
}

/// Parse a catalogue body.
///
/// The `TooNew` case is a *warning* in practice, not a wall: the caller may
/// choose to use the entries anyway, because every field this build reads is
/// still present and correct. What must never happen is a newer catalogue
/// being treated as a network failure and silently discarding a working
/// refresh.
pub fn parse(body: &str) -> Result<Catalog, CatalogError> {
    let cat: Catalog = serde_json::from_str(body)
        .map_err(|e| CatalogError::NotACatalog(e.to_string()))?;
    if cat.entries.is_empty() {
        return Err(CatalogError::Empty);
    }
    Ok(cat)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"{
      "schema": 1,
      "generated": "2026-08-24T20:00:00Z",
      "formats": { "ffgl": { "label": "FFGL", "hosts": "Resolume" } },
      "entries": [{
        "slug": "tinsel", "name": "Tinsel", "repo": "tinsel", "kind": "plugin",
        "version": "v1.0.2",
        "builds": {
          "ffgl": { "macos": { "url": "https://example/t.zip", "size": 1, "arch": "universal" } },
          "openfx": { "macos": { "url": "https://example/t-ofx.zip" } }
        },
        "notes": [{ "tag": "v1.0.2", "kind": "commits", "lines": ["did a thing"], "filtered": 4 }]
      }]
    }"#;

    #[test]
    fn parses_a_catalogue() {
        let c = parse(MINIMAL).unwrap();
        assert_eq!(c.entries.len(), 1);
        let e = &c.entries[0];
        assert_eq!(e.formats_for(Platform::Macos), vec![Format::Ffgl, Format::Openfx]);
        assert!(e.asset(Format::Adobe, Platform::Macos).is_none());
        assert!(e.asset(Format::Ffgl, Platform::Windows).is_none());
    }

    #[test]
    fn an_html_error_page_is_refused_rather_than_half_parsed() {
        // The live failure mode: the catalogue URL 404s and returns an HTML
        // body. Treating that as an empty catalogue would tell the user the
        // whole fleet had disappeared.
        let err = parse("<!DOCTYPE html><html><body>Not found</body></html>").unwrap_err();
        assert!(matches!(err, CatalogError::NotACatalog(_)));
    }

    #[test]
    fn an_empty_catalogue_is_an_error_not_a_valid_answer() {
        let body = r#"{"schema":1,"generated":"x","entries":[]}"#;
        assert_eq!(parse(body).unwrap_err(), CatalogError::Empty);
    }

    #[test]
    fn a_newer_catalogue_still_parses() {
        // The guarantee that a website deploy cannot brick clients in the
        // field: unknown formats and unknown fields must not fail the parse.
        let body = MINIMAL
            .replace("\"schema\": 1", "\"schema\": 2")
            .replace(
                "\"openfx\": { \"macos\": { \"url\": \"https://example/t-ofx.zip\" } }",
                "\"openfx\": { \"macos\": { \"url\": \"https://example/t-ofx.zip\" } },\
                 \"hologram\": { \"macos\": { \"url\": \"https://example/t-holo.zip\" } }",
            );
        let c = parse(&body).unwrap();
        assert_eq!(c.schema, 2);
        let e = &c.entries[0];
        // The unknown format is retained but never offered.
        assert_eq!(e.formats_for(Platform::Macos), vec![Format::Ffgl, Format::Openfx]);
    }

    #[test]
    fn a_pinned_asset_is_marked_so_the_ui_can_say_so() {
        let body = MINIMAL.replace(
            "\"url\": \"https://example/t.zip\", \"size\": 1",
            "\"url\": \"https://example/t-0.1.1.zip\", \"pinned\": true, \"size\": 1",
        );
        let c = parse(&body).unwrap();
        assert!(c.entries[0].asset(Format::Ffgl, Platform::Macos).unwrap().pinned);
    }
}
