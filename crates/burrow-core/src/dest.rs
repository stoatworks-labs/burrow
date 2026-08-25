//! Where each plugin format goes on this machine, and which hosts are here.
//!
//! The governing rule, borrowed from `pptx-font-manager`: **a destination is
//! located, never guessed at.** A directory that is not there is not returned,
//! so an empty result means "nothing found" and never "look somewhere
//! plausible". Every claim below was measured rather than assumed.

use crate::model::{Format, Platform};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A Resolume product. Only two of them matter, and that is the point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolumeProduct {
    Arena,
    Avenue,
    Alley,
    Wire,
}

impl ResolumeProduct {
    pub const ALL: &'static [ResolumeProduct] = &[
        ResolumeProduct::Arena,
        ResolumeProduct::Avenue,
        ResolumeProduct::Alley,
        ResolumeProduct::Wire,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ResolumeProduct::Arena => "Arena",
            ResolumeProduct::Avenue => "Avenue",
            ResolumeProduct::Alley => "Alley",
            ResolumeProduct::Wire => "Wire",
        }
    }

    /// Whether this product actually scans an `Extra Effects` folder.
    ///
    /// Only Arena and Avenue do. This is measured, not assumed: the
    /// `resolume-ofx-bridge` project checked the strings in each binary and
    /// found the path present in Arena's and absent from Alley's and Wire's —
    /// even though all four link the same FFGL engine, which is exactly why
    /// the obvious assumption is wrong.
    ///
    /// Burrow detects Alley and Wire so it can say "found, but it does not
    /// load effects", which is more useful than not mentioning them: a person
    /// with Alley installed and no Arena needs to know why nothing is on
    /// offer.
    pub fn hosts_effects(self) -> bool {
        matches!(self, ResolumeProduct::Arena | ResolumeProduct::Avenue)
    }
}

/// One place Burrow can install into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    /// Stable id, used as the ledger key and in settings. For FFGL this is the
    /// lowercased product name, so Arena and Avenue are separate destinations
    /// with independent lifecycles.
    pub id: String,
    pub format: Format,
    pub label: String,
    pub path: PathBuf,
    /// The same path with the home directory written as `~`.
    ///
    /// **Shown instead of `path` everywhere a person reads one.** Not tidiness:
    /// a real path carries the account name, and these end up in screenshots,
    /// in bug reports and — this is what prompted it — in a video about the app.
    /// `~/Library/Audio/Plug-Ins/VST3` is also simply easier to read than the
    /// same thing with a stranger's username in the middle of it.
    ///
    /// `path` stays exact, because it is what gets written to and what "Show"
    /// reveals in Finder.
    pub display_path: String,
    pub exists: bool,
    /// Probed by actually trying to create a file, never inferred from mode
    /// bits — see [`probe_writable`].
    pub writable: bool,
    pub needs_elevation: bool,
    /// True when this path came from the user's settings rather than
    /// detection. A user-chosen path is never elevated.
    pub custom: bool,
}

/// Everything Burrow found on this machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub platform: Option<Platform>,
    pub resolume: Vec<DetectedHost>,
    pub other_hosts: Vec<DetectedHost>,
    pub destinations: Vec<Destination>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHost {
    pub name: String,
    /// False for Alley and Wire: present, but they do not load effects.
    pub loads_effects: bool,
    pub note: Option<String>,
}

/// Whether a directory can actually be written to, by *this* user, right now.
///
/// Mode bits are not enough and this is not a theoretical concern. On the Mac
/// this was written on, the After Effects MediaCore directory is
/// `drwxrwxr-x root:wheel` — which reads as group-writable, and would pass any
/// permission-bit inspection — but the user is in `staff` and `admin`, not
/// `wheel`, so writing fails. Anything short of trying it gets this wrong.
///
/// Probes the nearest existing ancestor, so a destination that does not exist
/// yet still yields a useful answer about whether Burrow could create it.
pub fn probe_writable(path: &Path) -> bool {
    let mut probe_dir = path;
    loop {
        if probe_dir.is_dir() {
            break;
        }
        match probe_dir.parent() {
            Some(p) => probe_dir = p,
            None => return false,
        }
    }
    let candidate = probe_dir.join(format!(".burrow-write-probe-{}", std::process::id()));
    match std::fs::File::create(&candidate) {
        Ok(_) => {
            let _ = std::fs::remove_file(&candidate);
            true
        }
        Err(_) => false,
    }
}

/// The user's Documents directory.
///
/// On Windows this **must** come from the known-folder API rather than
/// `%USERPROFILE%\Documents`: with OneDrive's folder backup enabled — the
/// default on a lot of consumer machines — Documents is redirected to
/// `…\OneDrive\Documents`, and a string join installs into a folder Resolume
/// does not read. The caller passes it in because resolving it belongs to
/// Tauri's `PathResolver`, which does the right thing on both platforms.
pub fn resolume_extra_effects(documents: &Path, product: ResolumeProduct) -> PathBuf {
    documents
        .join(format!("Resolume {}", product.name()))
        .join("Extra Effects")
}

/// Which Resolume products are on this machine.
///
/// A product counts as present if either its application folder or its
/// documents folder exists. The documents folder is the one written into and
/// it survives the application being moved or deleted, so checking only
/// `/Applications` would lose a machine whose Resolume lives elsewhere.
pub fn detect_resolume(applications: &Path, documents: &Path) -> Vec<(ResolumeProduct, bool)> {
    ResolumeProduct::ALL
        .iter()
        .filter_map(|&p| {
            let app = applications.join(format!("Resolume {}", p.name()));
            let docs = documents.join(format!("Resolume {}", p.name()));
            (app.exists() || docs.exists()).then_some((p, p.hosts_effects()))
        })
        .collect()
}

/// The OpenFX plugin directory for this platform.
///
/// macOS is `/Library/OFX/Plugins` and nothing else. There is no
/// `~/Library/OFX/Plugins`: the OpenFX reference host implementation
/// (`HostSupport/src/ofxhPluginCache.cpp`) pushes `/Library/OFX/Plugins` and
/// `$OFX_PLUGIN_PATH`, and hosts derive their search from it. That is why
/// OpenFX installs need admin and cannot be talked out of it.
pub fn openfx_dir(platform: Platform) -> Option<PathBuf> {
    match platform {
        Platform::Macos => Some(PathBuf::from("/Library/OFX/Plugins")),
        Platform::Windows => std::env::var("CommonProgramFiles")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|base| PathBuf::from(base).join("OFX").join("Plugins")),
        // The reference host pushes /usr/OFX/Plugins on Linux, and DaVinci
        // Resolve runs there. Correct today even though Burrow has no Linux
        // build of its own — plugins have started shipping Linux OpenFX
        // artefacts, so this is the answer waiting for a client that can use it.
        Platform::Linux => Some(PathBuf::from("/usr/OFX/Plugins")),
        Platform::Unknown => None,
    }
}

/// The Adobe MediaCore directory shared by After Effects and Premiere Pro.
///
/// The `7.0` is an Adobe plug-in API generation, not a product version: CC
/// 2025 and 2026 both load from this one directory, which is why a single
/// install covers every installed Adobe version at once.
pub fn adobe_dir(platform: Platform) -> Option<PathBuf> {
    match platform {
        Platform::Macos => Some(PathBuf::from(
            "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore",
        )),
        Platform::Windows => std::env::var("ProgramFiles")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|base| {
                PathBuf::from(base)
                    .join("Adobe")
                    .join("Common")
                    .join("Plug-ins")
                    .join("7.0")
                    .join("MediaCore")
            }),
        // Adobe ships no Linux host, so there is no destination to offer.
        Platform::Linux | Platform::Unknown => None,
    }
}

/// The per-user VST3 directory.
///
/// macOS has both `~/Library/Audio/Plug-Ins/VST3` and the system-wide
/// `/Library/...` copy, and every host scans both. Burrow uses the user one:
/// it needs no password, it does not touch a directory other software also
/// writes to, and an uninstall cannot affect another account. That is the
/// opposite of the OpenFX story, where there is no per-user directory to
/// choose — which is why one format asks for a password and the other never
/// does.
///
/// Windows has two locations in the VST3 specification —
/// `%CommonProgramFiles%\VST3` for everyone and
/// `%LOCALAPPDATA%\Programs\Common\VST3` for one user — and this uses the
/// per-user one, for the same reasons as macOS. The trade is real and worth
/// stating: a host that scans only the common folder, instead of asking the
/// VST3 SDK where to look, will not see a plugin installed here. The answer to
/// that is the host's own scan-path setting, not a password prompt from Burrow.
pub fn vst3_dir(platform: Platform, home: &Path) -> Option<PathBuf> {
    match platform {
        Platform::Macos => Some(home.join("Library/Audio/Plug-Ins/VST3")),
        Platform::Windows => std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|base| PathBuf::from(base).join("Programs").join("Common").join("VST3")),
        // The VST3 spec's Linux location, and where Reaper and Bitwig look.
        Platform::Linux => Some(home.join(".vst3")),
        Platform::Unknown => None,
    }
}

/// The per-user Audio Units component directory.
///
/// macOS only, and not because Burrow has not got round to the others: Audio
/// Units are a macOS format. An `au` build on Windows is not a missing artefact
/// to apologise for, it is a category error, so the destination does not exist
/// and the slot never appears.
pub fn au_dir(platform: Platform, home: &Path) -> Option<PathBuf> {
    match platform {
        Platform::Macos => Some(home.join("Library/Audio/Plug-Ins/Components")),
        _ => None,
    }
}

/// Where an application goes.
///
/// **No application install ever asks for a password**, and that is a decision
/// rather than a limitation. `/Applications` is `drwxrwxr-x root:admin`: an
/// administrator can write to it directly, and this uses it when the probe says
/// so. A standard user cannot — and the tempting fix, handing `/Applications`
/// to the privileged helper, would mean teaching the one component that runs as
/// root to replace and delete things in the directory holding every application
/// on the machine, in order to install software that has a perfectly good
/// per-user home. macOS indexes `~/Applications` in Spotlight and Launchpad
/// like any other; on a shared Mac a per-user install is the more correct
/// answer anyway.
///
/// On Windows this is `%LOCALAPPDATA%\Programs`, where Squirrel and
/// electron-builder already install per-user, for the same reason. What it does
/// not do is create a Start-menu shortcut — see the note Burrow attaches to a
/// Windows application install.
pub fn applications_dir(platform: Platform, home: &Path) -> Option<PathBuf> {
    match platform {
        Platform::Macos => {
            let shared = PathBuf::from("/Applications");
            Some(if probe_writable(&shared) {
                shared
            } else {
                home.join("Applications")
            })
        }
        Platform::Windows => std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|base| PathBuf::from(base).join("Programs")),
        Platform::Linux | Platform::Unknown => None,
    }
}

/// Where Burrow puts Companion modules.
///
/// **This one is genuinely different, and the difference is not Burrow's.**
/// Bitfocus Companion has no modules directory to find: modules that are not in
/// its store are loaded from a folder the user nominates themselves, in
/// Settings → Developer modules path, and it is empty until they do. There is
/// nothing to locate.
///
/// So this is the only destination in the file that is *proposed* rather than
/// located — a folder in Documents that Burrow will create and fill, leaving
/// the user one setting to point Companion at it. Anyone who already has a
/// modules folder points Burrow at theirs instead, in Settings, and this is
/// never used.
pub fn companion_modules_dir(documents: &Path) -> PathBuf {
    documents.join("Companion Modules")
}

/// Whether Bitfocus Companion is on this machine.
///
/// Only used to say so. It deliberately does not gate the destination: a
/// portable Companion, or one installed somewhere unusual, would fail this
/// check while working perfectly, and a module that cannot be installed with no
/// explanation is worse than one installed for an app that turns up later.
pub fn detect_companion(applications: &Path) -> bool {
    ["Companion.app", "Companion", "Bitfocus Companion.app"]
        .iter()
        .any(|n| applications.join(n).exists())
}

/// A path with the home directory replaced by `~`.
///
/// Textual and exact: only a path that really is inside the home directory is
/// abbreviated, and `/Users/allansargeantine/x` is not inside
/// `/Users/allansargeant`, which a naive prefix match on the string would get
/// wrong. Anything outside — `/Library/OFX/Plugins`, a custom destination on
/// another volume — comes back unchanged.
pub fn abbreviate(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.display()).replace('\\', "/"),
        Err(_) => path.display().to_string(),
    }
}

fn destination(
    id: &str,
    format: Format,
    label: String,
    path: PathBuf,
    home: &Path,
    custom: bool,
) -> Destination {
    let exists = path.is_dir();
    let writable = probe_writable(&path);
    Destination {
        id: id.to_string(),
        format,
        label,
        display_path: abbreviate(&path, home),
        // A custom path is never elevated, whatever it points at. That is what
        // stops a tampered settings file aiming a root write somewhere: the
        // elevated helper's whitelist is compiled in, and settings never reach
        // it.
        needs_elevation: !custom && format.needs_elevation() && !writable,
        path,
        exists,
        writable,
        custom,
    }
}

/// Every destination Burrow can offer, given where the user's folders are.
///
/// `overrides` maps a destination id to a user-chosen path.
pub fn discover(
    platform: Platform,
    applications: &Path,
    documents: &Path,
    home: &Path,
    overrides: &std::collections::BTreeMap<String, PathBuf>,
) -> Vec<Destination> {
    let mut out = Vec::new();

    for (product, hosts_effects) in detect_resolume(applications, documents) {
        if !hosts_effects {
            // Detected, reported in the Environment, but never offered as a
            // place to install: Alley and Wire do not scan Extra Effects, and
            // writing there would produce a plugin that silently never
            // appears.
            continue;
        }
        let id = product.name().to_lowercase();
        let path = overrides
            .get(&id)
            .cloned()
            .unwrap_or_else(|| resolume_extra_effects(documents, product));
        out.push(destination(
            &id,
            Format::Ffgl,
            format!("Resolume {}", product.name()),
            path,
            home,
            overrides.contains_key(&id),
        ));
    }

    if let Some(p) = openfx_dir(platform) {
        let path = overrides.get("openfx").cloned().unwrap_or(p);
        out.push(destination(
            "openfx",
            Format::Openfx,
            "OpenFX hosts".into(),
            path,
            home,
            overrides.contains_key("openfx"),
        ));
    }

    if let Some(p) = adobe_dir(platform) {
        let path = overrides.get("adobe").cloned().unwrap_or(p);
        out.push(destination(
            "adobe",
            Format::Adobe,
            "After Effects & Premiere Pro".into(),
            path,
            home,
            overrides.contains_key("adobe"),
        ));
    }

    if let Some(p) = vst3_dir(platform, home) {
        let path = overrides.get("vst3").cloned().unwrap_or(p);
        out.push(destination(
            "vst3",
            Format::Vst3,
            "VST3 hosts".into(),
            path,
            home,
            overrides.contains_key("vst3"),
        ));
    }

    if let Some(p) = au_dir(platform, home) {
        let path = overrides.get("au").cloned().unwrap_or(p);
        out.push(destination(
            "au",
            Format::Au,
            "Logic Pro & Final Cut Pro".into(),
            path,
            home,
            overrides.contains_key("au"),
        ));
    }

    if let Some(p) = applications_dir(platform, home) {
        let path = overrides.get("applications").cloned().unwrap_or(p);
        out.push(destination(
            "applications",
            Format::App,
            if platform == Platform::Macos { "Applications" } else { "Programs" }.into(),
            path,
            home,
            overrides.contains_key("applications"),
        ));
    }

    if matches!(platform, Platform::Macos | Platform::Windows | Platform::Linux) {
        let path = overrides
            .get("companion")
            .cloned()
            .unwrap_or_else(|| companion_modules_dir(documents));
        out.push(destination(
            "companion",
            Format::Companion,
            "Companion modules".into(),
            path,
            home,
            overrides.contains_key("companion"),
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    #[test]
    fn only_arena_and_avenue_host_effects() {
        assert!(ResolumeProduct::Arena.hosts_effects());
        assert!(ResolumeProduct::Avenue.hosts_effects());
        // Measured from the binaries, not assumed from the shared engine.
        assert!(!ResolumeProduct::Alley.hosts_effects());
        assert!(!ResolumeProduct::Wire.hosts_effects());
    }

    #[test]
    fn a_product_is_detected_from_either_its_app_or_its_documents_folder() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Arena")).unwrap();
        // Avenue: no app, but the documents folder survives the app being moved.
        std::fs::create_dir_all(docs.path().join("Resolume Avenue")).unwrap();

        let found = detect_resolume(apps.path(), docs.path());
        let names: Vec<_> = found.iter().map(|(p, _)| p.name()).collect();
        assert_eq!(names, vec!["Arena", "Avenue"]);
    }

    #[test]
    fn alley_and_wire_are_detected_but_never_offered_as_destinations() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Alley")).unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Wire")).unwrap();

        // Detection sees them...
        let found = detect_resolume(apps.path(), docs.path());
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|(_, hosts)| !hosts));

        // ...and discovery offers no FFGL destination for them.
        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());
        assert!(!dests.iter().any(|d| d.format == Format::Ffgl));
    }

    #[test]
    fn arena_and_avenue_are_separate_destinations() {
        // One FFGL plugin can be installed into both at once; they must have
        // independent ids or uninstalling from one forgets the other.
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Arena")).unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Avenue")).unwrap();

        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());
        let ffgl: Vec<_> = dests
            .iter()
            .filter(|d| d.format == Format::Ffgl)
            .map(|d| d.id.as_str())
            .collect();
        assert_eq!(ffgl, vec!["arena", "avenue"]);
    }

    #[test]
    fn linux_has_an_openfx_home_but_no_adobe_one() {
        // Resolve runs on Linux and loads from /usr/OFX/Plugins; After Effects
        // does not exist there at all.
        assert_eq!(openfx_dir(Platform::Linux), Some(PathBuf::from("/usr/OFX/Plugins")));
        assert_eq!(adobe_dir(Platform::Linux), None);
    }

    #[test]
    fn an_unknown_platform_offers_nothing_rather_than_guessing() {
        assert_eq!(openfx_dir(Platform::Unknown), None);
        assert_eq!(adobe_dir(Platform::Unknown), None);
    }

    #[test]
    fn the_extra_effects_path_is_built_under_documents() {
        let docs = Path::new("/Users/x/Documents");
        assert_eq!(
            resolume_extra_effects(docs, ResolumeProduct::Arena),
            Path::new("/Users/x/Documents/Resolume Arena/Extra Effects")
        );
    }

    #[test]
    fn a_writable_directory_probes_writable_and_a_missing_one_uses_its_ancestor() {
        let dir = TempDir::new().unwrap();
        assert!(probe_writable(dir.path()));
        // A destination that does not exist yet still answers usefully, via
        // the nearest ancestor that does.
        assert!(probe_writable(&dir.path().join("not/created/yet")));
    }

    #[test]
    #[cfg(unix)]
    fn a_root_owned_directory_probes_unwritable() {
        // The concrete case: /Library on macOS is root:wheel and this is what
        // makes OpenFX need elevation at all.
        assert!(!probe_writable(Path::new("/Library")));
    }

    #[test]
    fn a_custom_destination_is_never_marked_for_elevation() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let custom = TempDir::new().unwrap();
        let mut ov = BTreeMap::new();
        ov.insert("openfx".to_string(), custom.path().to_path_buf());

        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &ov);
        let ofx = dests.iter().find(|d| d.id == "openfx").unwrap();
        assert!(ofx.custom);
        assert!(!ofx.needs_elevation);
    }

    #[test]
    fn the_audio_destinations_are_per_user_and_never_ask_for_a_password() {
        // The point of choosing ~/Library over /Library for both: an audio
        // plugin install is the one case where the user directory is scanned
        // by every host, so there is no reason to ask for a password.
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());

        let vst3 = dests.iter().find(|d| d.id == "vst3").unwrap();
        assert_eq!(vst3.path, home.path().join("Library/Audio/Plug-Ins/VST3"));
        assert!(!vst3.needs_elevation);

        let au = dests.iter().find(|d| d.id == "au").unwrap();
        assert_eq!(au.path, home.path().join("Library/Audio/Plug-Ins/Components"));
        assert!(!au.needs_elevation);
    }

    #[test]
    fn audio_units_do_not_exist_off_macos() {
        // Not a missing build to apologise for — a format that does not exist
        // there. No destination, so no slot, so nothing to explain.
        let home = Path::new("/home/x");
        assert!(au_dir(Platform::Windows, home).is_none());
        assert!(au_dir(Platform::Linux, home).is_none());
        assert!(vst3_dir(Platform::Linux, home).is_some());
    }

    #[test]
    fn a_destination_under_the_home_directory_is_shown_with_a_tilde() {
        // What this is for: a real path carries the account name, and these end
        // up in screenshots, in bug reports and in a video about the app.
        let home = Path::new("/Users/someone");
        assert_eq!(
            abbreviate(Path::new("/Users/someone/Library/Audio/Plug-Ins/VST3"), home),
            "~/Library/Audio/Plug-Ins/VST3"
        );
        assert_eq!(abbreviate(home, home), "~");
    }

    #[test]
    fn a_path_outside_the_home_directory_is_left_exactly_as_it_is() {
        let home = Path::new("/Users/someone");
        assert_eq!(
            abbreviate(Path::new("/Library/OFX/Plugins"), home),
            "/Library/OFX/Plugins"
        );
        // And the trap a string prefix match falls into: this account is not
        // that account, and its path must not come back as "~ine/x".
        assert_eq!(
            abbreviate(Path::new("/Users/someoneelse/x"), home),
            "/Users/someoneelse/x"
        );
    }

    #[test]
    fn every_destination_carries_a_path_with_no_account_name_in_it() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());

        let home_str = home.path().display().to_string();
        for d in &dests {
            if d.path.starts_with(home.path()) {
                assert!(d.display_path.starts_with("~/"), "{}", d.display_path);
            }
            assert!(!d.display_path.contains(&home_str), "{}", d.display_path);
        }
    }

    #[test]
    fn no_format_added_for_the_new_categories_can_ask_for_a_password() {
        // The security statement, as a test. Widening the privileged helper's
        // whitelist is a change to what this app *is* (AGENTS.md §6), and
        // adding audio plugins, applications and Companion modules did not
        // require one: every new destination is somewhere the user can already
        // write.
        for f in [Format::Vst3, Format::Au, Format::App, Format::Companion] {
            assert!(!f.needs_elevation(), "{} should never elevate", f.label());
        }
        assert!(Format::Openfx.needs_elevation());
        assert!(Format::Adobe.needs_elevation());
    }

    #[test]
    fn an_application_falls_back_to_the_users_own_folder_rather_than_to_a_password() {
        // A standard user cannot write to /Applications. The answer is
        // ~/Applications, which macOS indexes identically — not root.
        let home = TempDir::new().unwrap();
        let p = applications_dir(Platform::Macos, home.path()).unwrap();
        let shared = Path::new("/Applications");
        if probe_writable(shared) {
            assert_eq!(p, shared);
        } else {
            assert_eq!(p, home.path().join("Applications"));
        }
    }

    #[test]
    fn the_companion_destination_is_offered_even_though_companion_was_not_found() {
        // Companion has no modules directory to locate — the user nominates
        // one in its own settings. Withholding the destination until Companion
        // is detected would leave a portable install with a module it cannot
        // install and no explanation.
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        assert!(!detect_companion(apps.path()));

        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());
        let c = dests.iter().find(|d| d.id == "companion").unwrap();
        assert_eq!(c.path, docs.path().join("Companion Modules"));
        assert!(!c.needs_elevation);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_real_system_directories_need_elevation_on_this_machine() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let home = TempDir::new().unwrap();
        let dests = discover(Platform::Macos, apps.path(), docs.path(), home.path(), &BTreeMap::new());
        for id in ["openfx", "adobe"] {
            let d = dests.iter().find(|d| d.id == id).unwrap();
            assert!(!d.writable, "{id} unexpectedly writable");
            assert!(d.needs_elevation, "{id} should need elevation");
        }
    }
}
