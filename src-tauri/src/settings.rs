//! What the user chose, on disk.
//!
//! Follows the fleet convention set by av-launcher: pretty JSON in the app's
//! config directory, **loaded infallibly** and stored fallibly. Every failure
//! path on load — no config directory, no file, unparseable JSON, a field of
//! the wrong type — yields defaults, because a corrupt settings file must not
//! be able to prevent the app from starting. Saving does report failure, since
//! a setting that silently did not persist is worse than an error.
//!
//! Note the deliberate divergence from that convention in `ledger.rs`: a
//! corrupt *ledger* is moved aside and reported rather than silently reset,
//! because silently forgetting it orphans files on the user's disk.

use burrow_core::model::Format;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const DEFAULT_CATALOG_URL: &str = "https://stoatworks-labs.com/catalog.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "one")]
    pub schema: u32,

    /// Which formats to install when nothing more specific is set.
    #[serde(default = "default_formats")]
    pub default_formats: Vec<Format>,

    /// Per-plugin override of the above.
    ///
    /// The nesting is load-bearing and worth the awkwardness. Four states have
    /// to be distinguishable in plain JSON:
    ///
    ///   key absent            inherit the global default
    ///   `"tinsel": null`      inherit, said explicitly
    ///   `"tinsel": []`        install nothing for this one
    ///   `"tinsel": ["ffgl"]`  install exactly this
    ///
    /// A flat `BTreeMap<String, Vec<Format>>` collapses the middle two the
    /// moment anyone writes `unwrap_or_default()`, and then "I deliberately
    /// want no formats for this plugin" silently becomes "use my defaults".
    #[serde(default)]
    pub plugin_formats: BTreeMap<String, Option<Vec<Format>>>,

    /// Destination overrides, keyed by destination id (`arena`, `openfx`, …).
    /// Absent means "use the detected default".
    ///
    /// A custom destination is never elevated — see `dest::discover`. That
    /// rule is what stops a tampered settings file aiming a root write.
    #[serde(default)]
    pub destinations: BTreeMap<String, PathBuf>,

    #[serde(default = "default_catalog_url")]
    pub catalog_url: String,

    /// Whether to fall back to the GitHub releases API when the catalogue
    /// cannot be reached. On by default; it is still only public release
    /// metadata, and it is what keeps the app useful when the site is down.
    #[serde(default = "yes")]
    pub allow_github_fallback: bool,

    /// Whether to ask about a new *Burrow* when the app starts.
    ///
    /// Off unless the user turns it on, and deliberately so: the promise in
    /// the Settings pane is that Burrow talks to the network when you ask it
    /// to, and a check that runs itself at every launch quietly stops that
    /// being true. There is a button either way — this only decides whether
    /// the question also gets asked once at startup.
    ///
    /// No schema bump: absent means `false`, which is what an existing
    /// settings file should mean. A migration is for a default whose *meaning*
    /// changed, not for a setting that did not exist.
    #[serde(default)]
    pub check_updates_on_launch: bool,

    /// The last version of each plugin the user has seen in "What's new".
    ///
    /// Seeded on first run from the catalogue that shipped inside the app, so
    /// a first launch reads "nothing new since this build" rather than
    /// announcing all 24 plugins as new.
    #[serde(default)]
    pub seen: BTreeMap<String, String>,

    #[serde(default)]
    pub seen_at: Option<String>,

    #[serde(default)]
    pub last_refresh: Option<RefreshRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRecord {
    /// Seconds since the epoch — see CatalogInfo::fetched_at_epoch.
    pub at: u64,
    pub ok: bool,
    pub source: String,
    pub error: Option<String>,
}

/// The current settings schema.
///
/// 1 → 2 added the formats that came with the audio, application and Companion
/// categories. See [`Settings::migrate`].
pub const SCHEMA: u32 = 2;

fn one() -> u32 {
    1
}
fn yes() -> bool {
    true
}
fn default_catalog_url() -> String {
    DEFAULT_CATALOG_URL.to_string()
}
fn default_formats() -> Vec<Format> {
    // Everything that needs no password. Installing OpenFX or Adobe by default
    // would mean the very first install prompts for an administrator password,
    // which is a bad first impression and, for someone who only uses Resolume,
    // entirely unnecessary.
    //
    // The rule reads the same as it did when it was "FFGL only" — that was the
    // whole of the password-free list at the time. It is not a wider default so
    // much as the same default, now that there is more than one kind of thing
    // in the catalogue: a video plugin has no VST3 build to install, and an
    // audio plugin has no FFGL one.
    Format::SHIPPING
        .iter()
        .copied()
        .filter(|f| !f.needs_elevation())
        .collect()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema: SCHEMA,
            default_formats: default_formats(),
            plugin_formats: BTreeMap::new(),
            destinations: BTreeMap::new(),
            catalog_url: default_catalog_url(),
            allow_github_fallback: true,
            check_updates_on_launch: false,
            seen: BTreeMap::new(),
            seen_at: None,
            last_refresh: None,
        }
    }
}

impl Settings {
    /// The formats to install for one plugin.
    pub fn formats_for(&self, slug: &str) -> Vec<Format> {
        match self.plugin_formats.get(slug) {
            Some(Some(explicit)) => explicit.clone(),
            _ => self.default_formats.clone(),
        }
    }

    pub fn has_override(&self, slug: &str) -> bool {
        matches!(self.plugin_formats.get(slug), Some(Some(_)))
    }

    /// Bring an older settings file forward.
    ///
    /// Only one migration so far, and it exists because leaving it out would
    /// have been invisible rather than noisy: a settings file written before
    /// the audio and application categories says `"defaultFormats": ["ffgl"]`,
    /// which was "everything that needs no password" when it was written and
    /// silently becomes "no audio plugins, no applications, no Companion
    /// modules" afterwards. Every existing user would have found the new tabs
    /// full of software with nothing on offer, and nothing would have said why.
    ///
    /// A format the user explicitly took *away* is not restored — only formats
    /// that did not exist to be chosen are added.
    fn migrate(&mut self) {
        if self.schema < 2 {
            for f in default_formats() {
                // FFGL is not re-added: if it is absent from a schema-1 file,
                // the user removed it on purpose.
                if f != Format::Ffgl && !self.default_formats.contains(&f) {
                    self.default_formats.push(f);
                }
            }
        }
        self.schema = SCHEMA;
    }

    /// Drop anything meaningless before writing, so the file stays readable
    /// and an override that merely repeats the defaults does not silently stop
    /// tracking a later change to them.
    pub fn normalise(&mut self) {
        self.default_formats.retain(|f| f.is_shipping());
        self.default_formats.sort();
        self.default_formats.dedup();

        self.plugin_formats.retain(|_, v| v.is_some());
        for v in self.plugin_formats.values_mut() {
            if let Some(list) = v {
                list.retain(|f| f.is_shipping());
                list.sort();
                list.dedup();
            }
        }
        if self.catalog_url.trim().is_empty() {
            self.catalog_url = default_catalog_url();
        }
    }
}

/// Read settings, falling back to defaults on every failure.
pub fn load(path: &std::path::Path) -> Settings {
    let Ok(body) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&body) {
        Ok(mut s) => {
            s.migrate();
            s.normalise();
            s
        }
        // A settings file we cannot read is not a reason to refuse to start.
        Err(_) => Settings::default(),
    }
}

/// Write settings. Reports failure, unlike load.
///
/// Written to a temporary file in the same directory and renamed, so an
/// interrupted write cannot leave a half-written file that the next load
/// silently discards.
pub fn store(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "settings path has no directory".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let body = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialise settings: {e}"))?;

    let tmp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("could not write in {}: {e}", dir.display()))?;
    std::fs::write(tmp.path(), &body).map_err(|e| format!("could not write settings: {e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("could not save settings: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_missing_file_yields_defaults_rather_than_an_error() {
        let s = load(std::path::Path::new("/nowhere/settings.json"));
        assert!(s.default_formats.contains(&Format::Ffgl));
        // The defining property of the defaults, which is not "FFGL": nothing
        // Burrow offers out of the box can ask for a password.
        assert!(s.default_formats.iter().all(|f| !f.needs_elevation()));
    }

    #[test]
    fn a_corrupt_file_yields_defaults_rather_than_bricking_the_app() {
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(&p, "{ this is not json").unwrap();
        assert_eq!(load(&p).default_formats, Settings::default().default_formats);
    }

    #[test]
    fn a_settings_file_written_before_the_new_categories_gains_their_formats() {
        // The invisible failure this exists for: "defaultFormats": ["ffgl"]
        // meant "everything that needs no password" when it was written, and
        // would silently mean "no audio plugins and no applications" now.
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(&p, r#"{"schema":1,"defaultFormats":["ffgl"]}"#).unwrap();

        let s = load(&p);
        assert_eq!(s.schema, SCHEMA);
        for f in [Format::Ffgl, Format::Vst3, Format::Au, Format::App, Format::Companion] {
            assert!(s.default_formats.contains(&f), "{} missing", f.label());
        }
        // And it does not quietly turn on the two that would prompt.
        assert!(!s.default_formats.contains(&Format::Openfx));
    }

    #[test]
    fn migration_does_not_restore_a_format_the_user_removed() {
        // Someone who took FFGL out of their defaults gets it back only by
        // putting it back. The migration adds what did not exist to be chosen;
        // it does not overrule a choice.
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(&p, r#"{"schema":1,"defaultFormats":["openfx"]}"#).unwrap();

        let s = load(&p);
        assert!(!s.default_formats.contains(&Format::Ffgl));
        assert!(s.default_formats.contains(&Format::Openfx));
        assert!(s.default_formats.contains(&Format::Vst3));
    }

    #[test]
    fn a_current_settings_file_is_left_alone() {
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(&p, r#"{"schema":2,"defaultFormats":["ffgl"]}"#).unwrap();
        assert_eq!(load(&p).default_formats, vec![Format::Ffgl]);
    }

    #[test]
    fn an_existing_settings_file_does_not_start_checking_for_updates_by_itself() {
        // Adding the field must not turn the behaviour on for people who never
        // asked for it. `serde(default)` gives false — this pins that, because
        // a `default = "yes"` typed out of habit would silently opt in every
        // existing user.
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(&p, r#"{"schema":2,"defaultFormats":["ffgl"]}"#).unwrap();
        assert!(!load(&p).check_updates_on_launch);
        assert!(!Settings::default().check_updates_on_launch);
    }

    #[test]
    fn settings_round_trip() {
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        let mut s = Settings::default();
        s.default_formats = vec![Format::Ffgl, Format::Openfx];
        store(&p, &s).unwrap();
        let back = load(&p);
        assert_eq!(back.default_formats, vec![Format::Ffgl, Format::Openfx]);
    }

    #[test]
    fn an_absent_override_inherits_the_defaults() {
        let mut s = Settings::default();
        s.default_formats = vec![Format::Ffgl, Format::Openfx];
        assert_eq!(s.formats_for("tinsel"), vec![Format::Ffgl, Format::Openfx]);
        assert!(!s.has_override("tinsel"));
    }

    #[test]
    fn an_explicit_empty_override_means_none_not_inherit() {
        // The distinction the Option<Vec<_>> exists for. Collapse these and
        // "install nothing for this plugin" silently becomes "use my
        // defaults", which is the opposite instruction.
        let mut s = Settings::default();
        s.default_formats = vec![Format::Ffgl];
        s.plugin_formats.insert("tinsel".into(), Some(vec![]));
        assert!(s.formats_for("tinsel").is_empty());
        assert!(s.has_override("tinsel"));
    }

    #[test]
    fn an_explicit_null_override_inherits() {
        let mut s = Settings::default();
        s.default_formats = vec![Format::Ffgl];
        s.plugin_formats.insert("tinsel".into(), None);
        assert_eq!(s.formats_for("tinsel"), vec![Format::Ffgl]);
        assert!(!s.has_override("tinsel"));
    }

    #[test]
    fn normalising_drops_a_null_override_so_it_keeps_following_the_defaults() {
        let mut s = Settings::default();
        s.plugin_formats.insert("tinsel".into(), None);
        s.normalise();
        assert!(!s.plugin_formats.contains_key("tinsel"));
    }

    #[test]
    fn normalising_removes_a_format_this_build_does_not_install() {
        // FxPlug is representable but ships in no release. Left in the
        // defaults it would produce an install that cannot succeed.
        let mut s = Settings::default();
        s.default_formats = vec![Format::Ffgl, Format::Fxplug];
        s.normalise();
        assert_eq!(s.default_formats, vec![Format::Ffgl]);
    }

    #[test]
    fn unknown_fields_from_a_newer_build_do_not_break_loading() {
        let t = TempDir::new().unwrap();
        let p = t.path().join("settings.json");
        std::fs::write(
            &p,
            r#"{"schema":2,"defaultFormats":["ffgl"],"somethingNew":{"a":1}}"#,
        )
        .unwrap();
        assert_eq!(load(&p).default_formats, vec![Format::Ffgl]);
    }
}
