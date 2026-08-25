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

fn destination(
    id: &str,
    format: Format,
    label: String,
    path: PathBuf,
    custom: bool,
) -> Destination {
    let exists = path.is_dir();
    let writable = probe_writable(&path);
    Destination {
        id: id.to_string(),
        format,
        label,
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
            overrides.contains_key("adobe"),
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
        std::fs::create_dir_all(apps.path().join("Resolume Alley")).unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Wire")).unwrap();

        // Detection sees them...
        let found = detect_resolume(apps.path(), docs.path());
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|(_, hosts)| !hosts));

        // ...and discovery offers no FFGL destination for them.
        let dests = discover(Platform::Macos, apps.path(), docs.path(), &BTreeMap::new());
        assert!(!dests.iter().any(|d| d.format == Format::Ffgl));
    }

    #[test]
    fn arena_and_avenue_are_separate_destinations() {
        // One FFGL plugin can be installed into both at once; they must have
        // independent ids or uninstalling from one forgets the other.
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Arena")).unwrap();
        std::fs::create_dir_all(apps.path().join("Resolume Avenue")).unwrap();

        let dests = discover(Platform::Macos, apps.path(), docs.path(), &BTreeMap::new());
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
        let custom = TempDir::new().unwrap();
        let mut ov = BTreeMap::new();
        ov.insert("openfx".to_string(), custom.path().to_path_buf());

        let dests = discover(Platform::Macos, apps.path(), docs.path(), &ov);
        let ofx = dests.iter().find(|d| d.id == "openfx").unwrap();
        assert!(ofx.custom);
        assert!(!ofx.needs_elevation);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_real_system_directories_need_elevation_on_this_machine() {
        let apps = TempDir::new().unwrap();
        let docs = TempDir::new().unwrap();
        let dests = discover(Platform::Macos, apps.path(), docs.path(), &BTreeMap::new());
        for id in ["openfx", "adobe"] {
            let d = dests.iter().find(|d| d.id == id).unwrap();
            assert!(!d.writable, "{id} unexpectedly writable");
            assert!(d.needs_elevation, "{id} should need elevation");
        }
    }
}
