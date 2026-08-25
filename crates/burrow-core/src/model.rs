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
    /// VST3 — every DAW and live-sound host worth naming.
    Vst3,
    /// Audio Units. macOS only, and there is no Windows equivalent to fall
    /// back to: `au` on a Windows machine is not a missing build, it is a
    /// format that does not exist there.
    Au,
    /// An application, placed whole rather than loaded by a host.
    ///
    /// The fleet's software tools ship a `.app` on macOS and a program folder
    /// on Windows, and Burrow places them the same way it places a plugin:
    /// staged, validated, de-quarantined, then renamed into place.
    App,
    /// A Bitfocus Companion module.
    ///
    /// The odd one out in two ways. Its archive is an npm `.tgz` rather than a
    /// zip, and its destination is a folder the *user* nominates in Companion's
    /// own settings — Companion has no fixed modules directory to find. See
    /// [`crate::dest::companion_modules_dir`].
    Companion,
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
    pub const SHIPPING: &'static [Format] = &[
        Format::Ffgl,
        Format::Openfx,
        Format::Adobe,
        Format::Vst3,
        Format::Au,
        Format::App,
        Format::Companion,
    ];

    pub fn is_shipping(self) -> bool {
        Self::SHIPPING.contains(&self)
    }

    pub fn id(self) -> &'static str {
        match self {
            Format::Ffgl => "ffgl",
            Format::Openfx => "openfx",
            Format::Adobe => "adobe",
            Format::Fxplug => "fxplug",
            Format::Vst3 => "vst3",
            Format::Au => "au",
            Format::App => "app",
            Format::Companion => "companion",
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
            Format::Vst3 => "VST3",
            Format::Au => "Audio Unit",
            Format::App => "Application",
            Format::Companion => "Companion module",
            Format::Unknown => "Unknown",
        }
    }

    /// Whether installing this format *may* need a directory only root can
    /// write. The final answer is this AND the destination probing unwritable
    /// — see [`crate::dest`].
    ///
    /// FFGL goes into the user's own Documents folder, and both audio plugin
    /// formats have a per-user directory every host scans, so none of those
    /// three ever need a password. OpenFX and Adobe go into `/Library` or
    /// `Program Files` with no user-writable alternative any host looks in.
    ///
    /// Applications are the interesting omission. `/Applications` does need a
    /// password for a standard user — and rather than teach the privileged
    /// helper to write there, Burrow installs into `~/Applications` instead.
    /// See [`crate::dest::applications_dir`]. Nothing in this list widens what
    /// the helper can touch, which is the point: the four formats added for the
    /// audio, application and Companion categories introduced no new elevated
    /// path at all.
    pub fn needs_elevation(self) -> bool {
        matches!(self, Format::Openfx | Format::Adobe)
    }

    /// What a payload of this format is called, as filename suffixes.
    ///
    /// This is the rule that replaces "copy every top-level entry", and it is
    /// load-bearing: it is what lets Burrow take exactly the `.vst3` out of an
    /// archive that also contains an `.component`, a `Standalone/` app and a
    /// `README`, without a probe having told it the names in advance.
    ///
    /// Empty where the format has no suffix to recognise: see
    /// [`Format::payload_is_whole_archive`]. Empty means "this format cannot
    /// be recognised by suffix", never "anything goes".
    pub fn payload_extensions(self) -> &'static [&'static str] {
        match self {
            // `.ofx.bundle` is covered by `.bundle`.
            Format::Ffgl => &[".bundle", ".dll"],
            Format::Openfx => &[".ofx", ".bundle"],
            Format::Adobe => &[".plugin", ".aex", ".bundle"],
            Format::Vst3 => &[".vst3"],
            Format::Au => &[".component"],
            Format::App => &[".app", ".exe"],
            Format::Fxplug => &[".fxplug"],
            Format::Companion | Format::Unknown => &[],
        }
    }

    /// Whether the *whole* archive is the thing installed, under a name the
    /// catalogue supplies, rather than named artefacts picked out of it.
    ///
    /// Two cases, both of which look nothing like a plugin:
    ///
    /// A **Companion module** is an `npm pack` tarball: one `package/`
    /// directory with a `package.json` in it, and no suffix anywhere to
    /// recognise it by.
    ///
    /// A **Windows application** is a folder, not a file. The `.exe` at the
    /// top of the archive is useless without the DLLs and the `resources/`
    /// beside it, so picking out the executable — the obvious reading of
    /// "install the app" — would place something that cannot start. macOS is
    /// the opposite: a `.app` *is* the whole thing, and the archive may hold
    /// other things beside it.
    pub fn payload_is_whole_archive(self, platform: Platform) -> bool {
        matches!(
            (self, platform),
            (Format::Companion, _) | (Format::App, Platform::Windows)
        )
    }
}

/// Which part of the fleet an entry belongs to.
///
/// A tab in the app, and an open vocabulary in the catalogue: the website
/// decides what goes where, sends the label alongside the id, and a client
/// that has never heard of a category keeps parsing rather than failing. The
/// same lesson as [`Platform::Unknown`], applied before it could bite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    /// The coarse one, and what a client older than the split reads. Still on
    /// every entry the catalogue emits.
    Video,
    /// The two halves of it, split by kind: an effect you load into a host is a
    /// different errand from an application you launch.
    VideoPlugins,
    VideoTools,
    Audio,
    /// Networking & infrastructure: the tools that move signals around a
    /// network and the ones that keep a rack running.
    Netinfra,
    /// Things you run rather than install: the tools that ship a
    /// `docker-compose.yml`, and the browser tools that run on the website and
    /// can be cloned and run anywhere.
    ///
    /// It cuts across the others — a container that talks to an ATEM is still
    /// video — because *how you run it* is the thing that decides what you do
    /// with the row. Nothing here has an installer.
    SelfHosted,
    /// Device firmware. Nothing carries this yet — the tab says so — but the
    /// value is representable so that the day the catalogue starts emitting it,
    /// clients already in the field file it correctly instead of dropping it.
    Firmware,
    #[serde(other)]
    Unknown,
}

impl Category {
    /// The categories this build shows a tab for, in tab order.
    pub const SHOWN: &'static [Category] = &[
        Category::VideoPlugins,
        Category::VideoTools,
        Category::Audio,
        Category::Netinfra,
        Category::SelfHosted,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Category::Video => "video",
            Category::VideoPlugins => "video-plugins",
            Category::VideoTools => "video-tools",
            Category::Audio => "audio",
            Category::Netinfra => "netinfra",
            Category::SelfHosted => "selfhosted",
            Category::Firmware => "firmware",
            Category::Unknown => "unknown",
        }
    }

    /// The fallback label, used only when the catalogue did not send one.
    pub fn label(self) -> &'static str {
        match self {
            Category::Video => "Video",
            Category::VideoPlugins => "Video plugins",
            Category::VideoTools => "Video tools",
            Category::Audio => "Audio",
            Category::Netinfra => "Networking & Infrastructure",
            Category::SelfHosted => "Self-hosted",
            Category::Firmware => "Device firmware",
            Category::Unknown => "Other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    /// Plugins have begun shipping Linux OpenFX builds — DaVinci Resolve runs
    /// there and loads from `/usr/OFX/Plugins`. Burrow itself has no Linux
    /// build yet, so this is carried and not offered.
    Linux,
    /// A platform this build has never heard of.
    ///
    /// This exists for the same reason `Format::Unknown` does, and it was added
    /// after learning the lesson the expensive way: `Format` had the fallback
    /// from the start, `Platform` did not, and the day three plugins gained
    /// Linux OpenFX builds every shipped client stopped being able to parse the
    /// catalogue at all — `unknown variant "linux", expected "macos" or
    /// "windows"`. The whole file failed, not the one key.
    ///
    /// A website deploy must never be able to do that. Anywhere the catalogue
    /// carries an open vocabulary, the client tolerates a value it does not
    /// know and ignores it.
    #[serde(other)]
    Unknown,
}

impl Platform {
    /// The platform this copy of Burrow is running on, or None where it does
    /// not ship.
    ///
    /// Linux deliberately returns None for now: plugins have started shipping
    /// Linux OpenFX builds, but Burrow has no Linux build of its own, so
    /// nothing can reach this on Linux anyway. Return `Some(Linux)` here the
    /// day that changes.
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
            Platform::Linux => "linux",
            Platform::Unknown => "unknown",
        }
    }
}

/// A machine architecture, as the catalogue spells it.
///
/// Only present because the software tools need it. Every video plugin in the
/// fleet ships one universal macOS bundle and one x64 Windows DLL, so the
/// question never came up; almost every application ships a separate arm64 and
/// x64 build, and handing someone the wrong one produces a download that
/// simply will not launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Arch {
    X64,
    Arm64,
    /// One binary that runs on both. The default when the catalogue says
    /// nothing, because that is what every artefact predating this field was.
    #[default]
    Universal,
    #[serde(other)]
    Unknown,
}

impl Arch {
    /// The architecture this copy of Burrow was built for.
    ///
    /// Note what this is *not*: the architecture of the machine. A Burrow
    /// built for x86_64 running under Rosetta on Apple silicon reports x64,
    /// and that is the right answer for a plugin it is about to hand to a
    /// host — but it is the wrong one for an application the user will launch
    /// themselves. Nothing depends on the difference yet; it will the day a
    /// universal build of Burrow exists.
    pub fn current() -> Self {
        match std::env::consts::ARCH {
            "x86_64" => Arch::X64,
            "aarch64" => Arch::Arm64,
            _ => Arch::Unknown,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Arch::X64 => "x64",
            Arch::Arm64 => "arm64",
            Arch::Universal => "universal",
            Arch::Unknown => "unknown",
        }
    }

    /// What a person calls it, for a download the app cannot place itself.
    pub fn label(self) -> &'static str {
        match self {
            Arch::X64 => "Intel",
            Arch::Arm64 => "Apple silicon",
            Arch::Universal => "Universal",
            Arch::Unknown => "Unknown",
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
    fn an_unknown_platform_does_not_fail_the_parse() {
        // The bug this exists for: three plugins gained Linux OpenFX builds,
        // the catalogue gained a `linux` platform key, and every shipped client
        // stopped being able to read the whole file — not the one key, the
        // whole file.
        let p: Platform = serde_json::from_str("\"linux\"").unwrap();
        assert_eq!(p, Platform::Linux);
        let p: Platform = serde_json::from_str("\"haiku\"").unwrap();
        assert_eq!(p, Platform::Unknown);
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
