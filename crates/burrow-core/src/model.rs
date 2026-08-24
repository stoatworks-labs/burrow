//! The vocabulary: formats, platforms, versions, and what a plugin's state is.

use serde::{Deserialize, Serialize};

/// A plugin format, which is really "which host family loads this".
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// FFGL — Resolume Arena and Avenue.
    Ffgl,
    /// OpenFX — DaVinci Resolve, Vegas Pro, Nuke, Natron.
    Openfx,
    /// After Effects and Premiere Pro.
    Adobe,
    /// Final Cut Pro and Motion. A live fleet port that ships in no release
    /// yet, so it is representable and not offered — see [`Format::SHIPPING`].
    Fxplug,
    /// A format this build has never heard of, arriving from a newer
    /// catalogue.
    ///
    /// This variant is why the catalogue can gain a format without breaking
    /// every copy of Burrow already installed: an unknown format round-trips
    /// through the cache instead of failing the parse, and is simply never
    /// offered. Without it, adding a format to the website would turn every
    /// older client's refresh into an error.
    #[serde(other)]
    Unknown,
}

impl Format {
    /// The formats Burrow will actually install today.
    ///
    /// The single switch. FxPlug is deliberately absent: the fleet's FCP port
    /// exists but registers without appearing in Final Cut's effects browser,
    /// and no release carries an FxPlug artefact. Offering it would mean
    /// offering an install that cannot succeed.
    pub const SHIPPING: &'static [Format] = &[Format::Ffgl, Format::Openfx, Format::Adobe];

    pub fn is_shipping(self) -> bool {
        Self::SHIPPING.contains(&self)
    }

    pub fn id(self) -> &'static str {
        match self {
            Format::Ffgl => "ffgl",
            Format::Openfx => "openfx",
            Format::Adobe => "adobe",
            Format::Fxplug => "fxplug",
            Format::Unknown => "unknown",
        }
    }

    /// What a person calls it.
    pub fn label(self) -> &'static str {
        match self {
            Format::Ffgl => "FFGL",
            Format::Openfx => "OpenFX",
            Format::Adobe => "Adobe",
            Format::Fxplug => "FxPlug",
            Format::Unknown => "Unknown",
        }
    }

    /// Whether installing this format needs a directory only root can write.
    ///
    /// FFGL goes into the user's own Documents folder. The other two go into
    /// `/Library` or `Program Files`, and there is no user-writable
    /// alternative a host would look in.
    pub fn needs_elevation(self) -> bool {
        matches!(self, Format::Openfx | Format::Adobe)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
}

impl Platform {
    /// The platform this copy of Burrow is running on, or None on a platform
    /// no plugin ships for. Linux builds of Burrow itself are possible; Linux
    /// builds of the plugins are not, so the honest answer there is "none".
    pub fn current() -> Option<Self> {
        if cfg!(target_os = "macos") {
            Some(Platform::Macos)
        } else if cfg!(target_os = "windows") {
            Some(Platform::Windows)
        } else {
            None
        }
    }

    /// The key the catalogue uses.
    pub fn id(self) -> &'static str {
        match self {
            Platform::Macos => "macos",
            Platform::Windows => "windows",
        }
    }
}

/// Strip a leading `v` and any surrounding whitespace.
///
/// Necessary because the same version is spelled two ways in two places that
/// are compared against each other constantly: a git tag and the catalogue say
/// `v1.0.2`, while `CFBundleVersion` inside the bundle says `1.0.2`. Comparing
/// them as strings makes every installed plugin look out of date, forever.
pub fn normalize_version(v: &str) -> &str {
    let v = v.trim();
    v.strip_prefix('v').unwrap_or(v)
}

/// How two versions relate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionCmp {
    Same,
    Older,
    Newer,
    /// Neither side parses as semver, and they are not equal as strings. The
    /// UI must say "differs", not "older" — claiming an ordering we did not
    /// establish is how a downgrade gets presented as an update.
    Differs,
}

pub fn compare_versions(installed: &str, latest: &str) -> VersionCmp {
    let (a, b) = (normalize_version(installed), normalize_version(latest));
    if a == b {
        return VersionCmp::Same;
    }
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) if a < b => VersionCmp::Older,
        (Ok(a), Ok(b)) if a > b => VersionCmp::Newer,
        (Ok(_), Ok(_)) => VersionCmp::Same,
        _ => VersionCmp::Differs,
    }
}

/// Where a version claim came from. Reaches the UI, because "1.0.2 available,
/// 0.2.0 installed" is confusing until you know the 0.2.0 was read out of the
/// bundle on disk rather than out of Burrow's own records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VersionSource {
    /// Read from `Contents/Info.plist`. The truth about what is on disk.
    InfoPlist,
    /// Burrow's record of what it installed, trusted only when the payload
    /// still hashes to what was recorded.
    Ledger,
}

/// What Burrow believes about one (plugin, format) on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum InstallState {
    NotInstalled,
    UpToDate {
        version: String,
        source: VersionSource,
    },
    UpdateAvailable {
        installed: String,
        latest: String,
        source: VersionSource,
    },
    /// Installed, but nothing on disk says which version.
    ///
    /// Not an error, and not rare: a Windows FFGL plugin is a bare `.dll` and
    /// a Windows OpenFX plugin is a bundle with no `Info.plist`, so neither
    /// carries a readable version. Every hand-installed plugin on Windows
    /// lands here permanently, and the UI must offer "reinstall the current
    /// version" rather than "update".
    VersionUnknown { entries: Vec<String> },
    /// The catalogue has no artefact for this format on this platform.
    /// cartridge ships macOS-only; most plugins have no Adobe build.
    NoBuild,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tag_and_a_plist_version_are_the_same_version() {
        // The catalogue says v1.0.2; Tinsel.bundle's Info.plist says 1.0.2.
        assert_eq!(compare_versions("1.0.2", "v1.0.2"), VersionCmp::Same);
        assert_eq!(compare_versions("v1.0.2", "1.0.2"), VersionCmp::Same);
    }

    #[test]
    fn double_digit_patches_compare_numerically_not_lexically() {
        // The trap this test exists for: "1.0.10" < "1.0.9" under string
        // comparison. This fleet cuts point releases weekly and is heading
        // straight for it.
        assert_eq!(compare_versions("1.0.9", "1.0.10"), VersionCmp::Older);
        assert_eq!(compare_versions("v1.0.10", "v1.0.9"), VersionCmp::Newer);
    }

    #[test]
    fn the_live_stale_dev_build_reads_as_an_update() {
        // Tinsel.bundle in ~/Documents/Resolume Arena/Extra Effects on the
        // machine this was written on is 0.2.0 against a 1.0.2 release.
        assert_eq!(compare_versions("0.2.0", "v1.0.2"), VersionCmp::Older);
    }

    #[test]
    fn an_unparseable_version_differs_rather_than_claiming_an_order() {
        assert_eq!(compare_versions("nightly", "1.0.2"), VersionCmp::Differs);
        assert_eq!(compare_versions("1.0.2", "some-branch"), VersionCmp::Differs);
    }

    #[test]
    fn an_identical_unparseable_version_is_still_the_same() {
        assert_eq!(compare_versions("nightly", "nightly"), VersionCmp::Same);
    }

    #[test]
    fn fxplug_is_representable_but_not_offered() {
        assert!(!Format::Fxplug.is_shipping());
        assert!(Format::Ffgl.is_shipping());
    }

    #[test]
    fn only_the_system_directory_formats_need_elevation() {
        assert!(!Format::Ffgl.needs_elevation());
        assert!(Format::Openfx.needs_elevation());
        assert!(Format::Adobe.needs_elevation());
    }

    #[test]
    fn an_unknown_format_from_a_newer_catalogue_parses_instead_of_failing() {
        // The whole point: a website deploy that adds a format must not break
        // refresh for clients already in the field.
        let f: Format = serde_json::from_str("\"fxplug\"").unwrap();
        assert_eq!(f, Format::Fxplug);
        let f: Format = serde_json::from_str("\"something-new\"").unwrap();
        assert_eq!(f, Format::Unknown);
        assert!(!f.is_shipping());
    }
}
