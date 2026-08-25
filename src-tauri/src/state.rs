//! Application state and the read-only half of the command surface.

use burrow_core::catalog::{self, Catalog};
use burrow_core::dest::{self, Destination, Environment};
use burrow_core::ledger::{self, Ledger};
use burrow_core::model::{Format, InstallState, Platform};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::demos::{self, DemoServer};
use crate::net;
use crate::settings::{self, Settings};

/// Where the catalogue in hand came from. Surfaced in the UI rather than
/// smoothed over: "these versions are from the copy that shipped with the app"
/// is a materially different claim from "these versions are current", and a
/// user deciding whether to trust an "up to date" badge deserves to know
/// which one they are looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Network,
    Cache,
    Baked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInfo {
    pub source: CatalogSource,
    pub generated: String,
    /// Seconds since the epoch. A number rather than a formatted string:
    /// std has no date formatter, and the frontend has to turn it into "two
    /// minutes ago" regardless.
    pub fetched_at_epoch: Option<u64>,
    pub entry_count: usize,
    /// Present when a fetch failed and something older is being shown.
    pub error: Option<String>,
    /// The catalogue was written for a newer Burrow. Not fatal — every field
    /// this build reads is still there — but worth saying.
    pub newer_schema: bool,
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub catalog: Mutex<Option<Catalog>>,
    pub catalog_info: Mutex<Option<CatalogInfo>>,
    pub ledger: Mutex<Ledger>,
    pub demos: Mutex<Option<DemoServer>>,
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub resource_dir: PathBuf,
    pub cancel: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let config_dir = app.path().app_config_dir()?;
        let cache_dir = app.path().app_cache_dir()?;
        let resource_dir = app.path().resource_dir()?;
        std::fs::create_dir_all(&config_dir).ok();
        std::fs::create_dir_all(&cache_dir).ok();

        let settings = settings::load(&config_dir.join("settings.json"));
        let ledger = load_ledger(&config_dir);

        Ok(AppState {
            settings: Mutex::new(settings),
            catalog: Mutex::new(None),
            catalog_info: Mutex::new(None),
            ledger: Mutex::new(ledger),
            demos: Mutex::new(None),
            config_dir,
            cache_dir,
            resource_dir,
            cancel: Mutex::new(None),
        })
    }

    pub fn settings_path(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }
    pub fn ledger_path(&self) -> PathBuf {
        self.config_dir.join("ledger.json")
    }
    pub fn catalog_cache_path(&self) -> PathBuf {
        self.cache_dir.join("catalog.json")
    }
    /// The ETag of the cached catalogue, beside it.
    ///
    /// A separate file rather than a wrapper around the body, so the cache
    /// stays a plain catalogue that the fallback path can read directly even
    /// if this file is missing or garbage.
    pub fn catalog_etag_path(&self) -> PathBuf {
        self.cache_dir.join("catalog.etag")
    }
    pub fn baked_catalog_path(&self) -> PathBuf {
        self.resource_dir.join("assets").join("catalog.json")
    }
    pub fn demo_root(&self) -> PathBuf {
        self.resource_dir.join("assets").join("demos")
    }
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load the ledger — and, unlike settings, do **not** silently reset it.
///
/// A settings file that cannot be read costs the user their preferences, which
/// is annoying. A ledger that cannot be read costs them the record of what
/// Burrow installed and where: every plugin becomes "version unknown", and an
/// uninstall no longer knows which files are its own. Silently starting fresh
/// would hide that, so a corrupt ledger is moved aside and a new one started.
fn load_ledger(config_dir: &std::path::Path) -> Ledger {
    let path = config_dir.join("ledger.json");
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Ledger::default();
    };
    match serde_json::from_str::<Ledger>(&body) {
        Ok(l) => l,
        Err(_) => {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let aside = config_dir.join(format!("ledger.corrupt-{secs}.json"));
            let _ = std::fs::rename(&path, &aside);
            Ledger::default()
        }
    }
}

pub fn save_ledger(state: &AppState) -> Result<(), String> {
    let ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;
    let body = serde_json::to_string_pretty(&*ledger).map_err(|e| e.to_string())?;
    let path = state.ledger_path();
    let dir = path.parent().ok_or("no config directory")?;
    let tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    std::fs::write(tmp.path(), body).map_err(|e| e.to_string())?;
    tmp.persist(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_environment(app: AppHandle, state: State<'_, AppState>) -> Result<Environment, String> {
    let settings = state.settings.lock().map_err(|_| "state is poisoned")?;
    let platform = Platform::current();

    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("could not find your Documents folder: {e}"))?;
    // Through the path resolver for the same reason Documents is: a home
    // directory is not always under /Users, and on Windows it is not always
    // %USERPROFILE% either.
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("could not find your home folder: {e}"))?;
    let applications = PathBuf::from(if cfg!(target_os = "macos") {
        "/Applications"
    } else {
        "C:\\Program Files"
    });

    let overrides = settings.destinations.clone().into_iter().collect();
    let destinations = match platform {
        Some(p) => dest::discover(p, &applications, &documents, &home, &overrides),
        None => Vec::new(),
    };

    let mut resolume = Vec::new();
    for (product, hosts) in dest::detect_resolume(&applications, &documents) {
        resolume.push(dest::DetectedHost {
            name: format!("Resolume {}", product.name()),
            loads_effects: hosts,
            note: (!hosts).then(|| {
                format!(
                    "{} links the same effects engine but does not scan an Extra Effects \
                     folder, so plugins installed for it would never appear.",
                    product.name()
                )
            }),
        });
    }

    // Companion is reported rather than required. Its modules directory is
    // one the user nominates inside Companion itself, so not finding the app
    // says nothing about whether a module can be installed — see
    // `dest::companion_modules_dir`.
    let other_hosts = vec![dest::DetectedHost {
        name: "Bitfocus Companion".into(),
        loads_effects: dest::detect_companion(&applications),
        note: Some(
            if dest::detect_companion(&applications) {
                "Modules go in the folder Companion's Settings → Developer modules path \
                 points at. Set that to the folder below and restart Companion."
            } else {
                "Not found here. Modules can still be installed — point Companion's \
                 Settings → Developer modules path at the folder below when you do have it."
            }
            .into(),
        ),
    }];

    Ok(Environment { platform, resolume, other_hosts, destinations })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|_| "state is poisoned")?.clone())
}

/// Save settings and return the normalised copy.
///
/// Returning the normalised value rather than nothing is what makes this
/// write-through instead of optimistic: the backend may drop a format this
/// build cannot install or an override that has become meaningless, and the UI
/// adopts that correction visibly rather than drifting from it.
#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    mut settings: Settings,
) -> Result<Settings, String> {
    settings.normalise();
    settings::store(&state.settings_path(), &settings)?;
    *state.settings.lock().map_err(|_| "state is poisoned")? = settings.clone();
    Ok(settings)
}

#[tauri::command]
pub fn get_catalog(state: State<'_, AppState>) -> Result<Option<CatalogInfo>, String> {
    Ok(state.catalog_info.lock().map_err(|_| "state is poisoned")?.clone())
}

/// Fetch the catalogue: network, then the on-disk cache, then the copy that
/// shipped inside the app.
///
/// Each fallback is reported rather than hidden. An app that quietly shows
/// three-month-old version numbers as though they were current is worse than
/// one that says it could not reach the network.
#[tauri::command]
pub async fn refresh_catalog(
    app: AppHandle,
    force: bool,
) -> Result<CatalogInfo, String> {
    let (url, cache_path, etag_path, baked_path, config_path) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().map_err(|_| "state is poisoned")?;
        (
            s.catalog_url.clone(),
            state.catalog_cache_path(),
            state.catalog_etag_path(),
            state.baked_catalog_path(),
            state.settings_path(),
        )
    };

    let mut error: Option<String> = None;
    let mut unchanged = false;

    // The ETag from the last successful fetch. Sending it means an unchanged
    // catalogue costs one round trip and no body at all — the file is ~84 KB,
    // and someone who opens Burrow daily would otherwise re-download it every
    // time to learn nothing. A `force` refresh deliberately skips it, so the
    // Refresh button always really asks.
    let etag = (!force)
        .then(|| std::fs::read_to_string(&etag_path).ok())
        .flatten()
        .filter(|t| !t.trim().is_empty());

    match net::client() {
        Ok(client) => match net::fetch_catalog(&client, &url, etag.as_deref()).await {
            Ok(Some(fetched)) => match catalog::parse(&fetched.body) {
                Ok(cat) => {
                    let _ = std::fs::create_dir_all(cache_path.parent().unwrap_or(&cache_path));
                    let _ = std::fs::write(&cache_path, &fetched.body);
                    match fetched.etag {
                        Some(t) => {
                            let _ = std::fs::write(&etag_path, t);
                        }
                        // No ETag on this response: drop any stale one, or the
                        // next request would revalidate against a tag the
                        // server no longer knows and could be told "unchanged"
                        // about a body it never sent.
                        None => {
                            let _ = std::fs::remove_file(&etag_path);
                        }
                    }
                    return Ok(adopt(&app, cat, CatalogSource::Network, None, &config_path));
                }
                Err(e) => error = Some(e.to_string()),
            },
            // 304: the cache is current, not stale. Fall through to read it,
            // but report it as network-fresh rather than as a fallback.
            Ok(None) => unchanged = true,
            Err(e) => error = Some(e),
        },
        Err(e) => error = Some(e),
    }

    // The cached copy from a previous successful fetch.
    if let Ok(body) = std::fs::read_to_string(&cache_path) {
        if let Ok(cat) = catalog::parse(&body) {
            let source = if unchanged { CatalogSource::Network } else { CatalogSource::Cache };
            return Ok(adopt(&app, cat, source, error, &config_path));
        }
    }

    // The copy that shipped with this build. Always present, always parseable,
    // and the reason a first run with no network still shows the whole fleet.
    let body = std::fs::read_to_string(&baked_path).map_err(|_| {
        error
            .clone()
            .unwrap_or_else(|| "the plugin list could not be loaded".to_string())
    })?;
    let cat = catalog::parse(&body).map_err(|e| e.to_string())?;
    Ok(adopt(&app, cat, CatalogSource::Baked, error, &config_path))
}

fn adopt(
    app: &AppHandle,
    cat: Catalog,
    source: CatalogSource,
    error: Option<String>,
    settings_path: &std::path::Path,
) -> CatalogInfo {
    let info = CatalogInfo {
        source,
        generated: cat.generated.clone(),
        fetched_at_epoch: Some(now_epoch()),
        entry_count: cat.entries.len(),
        error,
        newer_schema: cat.schema > catalog::KNOWN_SCHEMA,
    };

    let state = app.state::<AppState>();

    // On the very first run, seed "seen" from whatever catalogue we have, so
    // "What's new" opens saying nothing has changed since this build rather
    // than announcing every plugin in the fleet as new.
    if let Ok(mut s) = state.settings.lock() {
        if s.seen.is_empty() {
            for e in &cat.entries {
                if let Some(v) = &e.version {
                    s.seen.insert(e.slug.clone(), v.clone());
                }
            }
            let _ = settings::store(settings_path, &s);
        }
    }

    if let Ok(mut s) = state.settings.lock() {
        s.last_refresh = Some(crate::settings::RefreshRecord {
            at: now_epoch(),
            ok: info.error.is_none(),
            source: format!("{:?}", source).to_lowercase(),
            error: info.error.clone(),
        });
        let _ = settings::store(settings_path, &s);
    }

    if let Ok(mut slot) = state.catalog.lock() {
        *slot = Some(cat);
    }
    if let Ok(mut slot) = state.catalog_info.lock() {
        *slot = Some(info.clone());
    }
    info
}

/// One plugin, as the UI needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub slug: String,
    pub name: String,
    /// The coarse grouping, kept for anything that still reads it.
    pub category: burrow_core::model::Category,
    /// Which tab this belongs under — the finer one where the catalogue sends
    /// it, the coarse one where it does not.
    pub tab: burrow_core::model::Category,
    /// The project's compose file, for the tools you run as a container.
    pub compose: Option<String>,
    /// `plugin`, `app` or `companion`. Carried through verbatim, including a
    /// value this build has never heard of — the UI shows what it can and the
    /// catalogue stays free to grow.
    pub kind: String,
    /// The software tool this belongs to, for a Companion module. The UI nests
    /// it under that row instead of listing it as a peer.
    pub parent: Option<String>,
    pub hook: String,
    pub summary: String,
    pub blurb: Option<String>,
    pub version: Option<String>,
    pub published: Option<String>,
    pub thumb: Option<String>,
    /// The status id, as the website's own data spells it.
    pub status: Option<String>,
    /// How to say that status out loud — "Field testing", not "testing" — and
    /// what it means. Resolved here from the vocabulary the catalogue sends, so
    /// the app and the website cannot describe a project differently.
    ///
    /// Falls back to the id itself for a status this catalogue did not describe:
    /// showing `beta` is worse than showing "Beta" and better than showing
    /// nothing at all.
    pub status_label: Option<String>,
    pub status_blurb: Option<String>,
    pub tags: Vec<String>,
    pub demo: Option<String>,
    pub guide: Option<String>,
    pub youtube: Option<String>,
    pub video_url: Option<String>,
    pub release_url: Option<String>,
    pub releases_url: Option<String>,
    /// Every (format, destination) this plugin could occupy on this machine.
    pub slots: Vec<Slot>,
    /// The overall bucket: which of the three headings this row sits under.
    pub bucket: Bucket,
    pub has_override: bool,
    pub wanted_formats: Vec<Format>,
    pub notes: Vec<burrow_core::catalog::Note>,
    /// Earlier releases this plugin can be rolled back to, newest first.
    pub versions: Vec<burrow_core::catalog::VersionEntry>,
    /// Files in the archive that are not plugins — docs, sample assets, a CLI
    /// helper. Shown so the user knows they exist and where they went.
    pub extras: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub format: Format,
    pub destination_id: String,
    pub destination_label: String,
    pub state: InstallState,
    pub needs_elevation: bool,
    pub missing: Vec<String>,
    pub foreign: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Bucket {
    UpdateAvailable,
    UpToDate,
    NotInstalled,
}

#[tauri::command]
pub fn list_plugins(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<PluginView>, String> {
    let env = get_environment(app, state.clone())?;
    let catalog = state.catalog.lock().map_err(|_| "state is poisoned")?;
    let Some(cat) = catalog.as_ref() else {
        return Ok(Vec::new());
    };
    let settings = state.settings.lock().map_err(|_| "state is poisoned")?;
    let led = state.ledger.lock().map_err(|_| "state is poisoned")?;
    let platform = match Platform::current() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for entry in &cat.entries {
        let mut slots = Vec::new();
        let mut extras: Vec<String> = Vec::new();

        // Only the destinations this entry could ever occupy. Without this,
        // every video plugin would show empty VST3, Audio Unit and Application
        // slots, and every software tool an empty FFGL one — a row of
        // permanent dashes for a format it was never going to have.
        //
        // A format the entry *does* have somewhere, but not for this machine,
        // still gets a slot: "no build for your platform" is a real answer, and
        // it is how cartridge tells a Windows user it is macOS-only.
        let known = entry.known_formats();

        for d in env.destinations.iter().filter(|d| known.contains(&d.format)) {
            let asset = entry.asset(d.format, platform);
            if let Some(a) = asset {
                for x in &a.extras {
                    if !extras.contains(x) {
                        extras.push(x.clone());
                    }
                }
            }
            let declared = asset.map(|a| a.entries.clone()).unwrap_or_default();
            let r = ledger::reconcile_one(
                &led,
                &entry.slug,
                d.format,
                &d.id,
                &d.path,
                &declared,
                asset.is_some(),
                entry.version.as_deref(),
            );
            slots.push(Slot {
                format: d.format,
                destination_id: d.id.clone(),
                destination_label: d.label.clone(),
                state: r.state,
                needs_elevation: d.needs_elevation,
                missing: r.missing,
                foreign: r.foreign,
                size: asset.and_then(|a| a.size),
            });
        }

        out.push(PluginView {
            bucket: bucket_for(&slots),
            slug: entry.slug.clone(),
            name: entry.name.clone(),
            category: entry.category,
            tab: entry.tab(),
            compose: entry.compose.clone(),
            kind: entry.kind.clone(),
            parent: entry.parent.clone(),
            hook: entry.hook.clone(),
            summary: entry.summary.clone(),
            blurb: entry.blurb.clone(),
            version: entry.version.clone(),
            published: entry.published.clone(),
            thumb: entry.thumb.clone(),
            status_label: entry.status.as_ref().map(|id| {
                cat.statuses
                    .get(id)
                    .map(|s| s.label.clone())
                    .unwrap_or_else(|| title_case(id))
            }),
            status_blurb: entry
                .status
                .as_ref()
                .and_then(|id| cat.statuses.get(id))
                .and_then(|s| s.blurb.clone()),
            status: entry.status.clone(),
            tags: entry.tags.clone(),
            demo: entry.demo.clone(),
            guide: entry.guide.clone(),
            youtube: entry.youtube.clone(),
            video_url: entry.video_url.clone(),
            release_url: entry.release_url.clone(),
            releases_url: entry.releases_url.clone(),
            has_override: settings.has_override(&entry.slug),
            wanted_formats: settings.formats_for(&entry.slug),
            notes: entry.notes.clone(),
            versions: entry.versions.clone(),
            extras,
            slots,
        });
    }
    Ok(out)
}

/// `beta` → `Beta`. Only ever used for a status the catalogue did not describe.
fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Which heading a plugin sits under.
///
/// A plugin installed in some formats and not others counts as **up to date**
/// so long as what is installed is current. The heading answers one question —
/// *does this need my attention for what I actually have?* — and a format the
/// user never chose to install is not a pending update. Filing it under
/// "Update available" would give someone who only uses Resolume a permanent
/// list of OpenFX builds they will never want, and the heading would stop
/// meaning anything within a week.
fn bucket_for(slots: &[Slot]) -> Bucket {
    let mut any_installed = false;
    for s in slots {
        match s.state {
            InstallState::UpdateAvailable { .. } => return Bucket::UpdateAvailable,
            InstallState::UpToDate { .. } | InstallState::VersionUnknown { .. } => {
                any_installed = true
            }
            _ => {}
        }
    }
    if any_installed {
        Bucket::UpToDate
    } else {
        Bucket::NotInstalled
    }
}

#[tauri::command]
pub fn rescan(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<PluginView>, String> {
    list_plugins(app, state)
}

fn ensure_demos(state: &AppState) -> Result<(), String> {
    let mut slot = state.demos.lock().map_err(|_| "state is poisoned")?;
    if slot.is_none() {
        *slot = Some(demos::start(state.demo_root())?);
    }
    // Refresh the video index every time rather than only on start: the
    // catalogue can be replaced by a refresh long after the server came up.
    if let (Some(server), Ok(cat)) = (slot.as_ref(), state.catalog.lock()) {
        if let Some(cat) = cat.as_ref() {
            server.set_videos(
                cat.entries
                    .iter()
                    .filter_map(|e| e.video_url.clone().map(|u| (e.slug.clone(), u)))
                    .collect(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn demo_url(state: State<'_, AppState>, slug: String) -> Result<Option<String>, String> {
    ensure_demos(&state)?;
    let slot = state.demos.lock().map_err(|_| "state is poisoned")?;
    let server = slot.as_ref().ok_or("the demo server is not running")?;
    Ok(server.has(&slug).then(|| server.url_for(&slug)))
}

/// Where the UI should point a `<video>` for one plugin.
///
/// A loopback address, not the GitHub one. GitHub serves release assets with
/// `content-disposition: attachment`, and WebKit will not render media a server
/// has declared a download — the element shows its broken glyph and reports
/// nothing useful. The loopback server passes the same bytes through with the
/// Range header intact and a `video/mp4` label, so streaming and seeking both
/// still work.
#[tauri::command]
pub fn video_url(state: State<'_, AppState>, slug: String) -> Result<Option<String>, String> {
    ensure_demos(&state)?;
    let slot = state.demos.lock().map_err(|_| "state is poisoned")?;
    let server = slot.as_ref().ok_or("the video player is not running")?;
    Ok(server.video_url_for(&slug))
}

/// Open a demo in its own window.
///
/// A separate `WebviewWindow` rather than an iframe: the demos set
/// `frame-ancestors 'none'` and, more to the point, a plugin demo wants the
/// whole window. The window's label is absent from every capability, so the
/// page it loads is granted no IPC at all — a demo cannot call an install
/// command.
#[tauri::command]
pub fn open_demo(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let Some(url) = demo_url(state, slug.clone())? else {
        return Err(format!("{slug} has no demo bundled with this build"));
    };
    let label = format!("demo-{slug}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let parsed = url.parse().map_err(|_| "could not build the demo address")?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(format!("{slug} — demo"))
        .inner_size(1180.0, 820.0)
        .build()
        .map_err(|e| format!("could not open the demo window: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Only ever http(s). A `file:` or a custom scheme arriving here would be
    // the UI being tricked into handing the OS something unexpected.
    if !(url.starts_with("https://") || url.starts_with("http://127.0.0.1:")) {
        return Err("refusing to open that address".into());
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Write a compose file into the user's Downloads folder, and say where.
///
/// **Downloads and a reveal, rather than a save dialog.** A dialog would mean
/// adding `tauri-plugin-dialog` and a capability for it, and this app's
/// permission list is short on purpose. Downloads is where a browser would put
/// it, the app already knows how to reveal a path in Finder, and the button
/// says exactly what it will do.
///
/// The name carries the slug: `docker-compose.flock.yml` stays recognisable in
/// a folder full of other people's downloads, where a bare
/// `docker-compose.yml` would not.
#[tauri::command]
pub fn save_compose(app: AppHandle, slug: String, text: String) -> Result<String, String> {
    // The slug reaches this from the catalogue, which comes off the network,
    // and it is about to become a filename. Anything but the shape a slug
    // actually takes is refused rather than sanitised — quietly rewriting a
    // hostile name into a harmless one hides that it was sent at all.
    if slug.is_empty()
        || slug.len() > 64
        || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("{slug} is not a project name"));
    }

    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("could not find your Downloads folder: {e}"))?;
    let path = dir.join(format!("docker-compose.{slug}.yml"));
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    tauri_plugin_opener::OpenerExt::opener(&app)
        .reveal_item_in_dir(PathBuf::from(path))
        .map_err(|e| e.to_string())
}

/// Is this a filming run?
///
/// Set by `BURROW_FILM=1`. The video toolkit's rule is that everything on
/// screen is the real application — so rather than film a mock, the app drives
/// *itself* through a fixed choreography against the real catalogue and the
/// real contents of this machine's plugin folders. Nothing about the data is
/// staged; only the hand on the trackpad is replaced.
///
/// The mode deliberately cannot install anything. It changes which tab is
/// shown and what is typed into the search box, and nothing else.
#[tauri::command]
pub fn film_mode() -> bool {
    std::env::var("BURROW_FILM").is_ok_and(|v| v == "1")
}

/// Record when a step of the choreography actually happened.
///
/// The video toolkit wants beats that are "when the app was actually told, not
/// an estimate of when it might have reacted" — so the app reports them itself
/// rather than the capture script assuming its own timings held.
/// How long filming mode waits before starting the choreography, in
/// milliseconds.
///
/// Zero unless `BURROW_FILM_DELAY` says otherwise, and it exists for one
/// reason: the choreography used to start the moment the window mounted, which
/// is several seconds before a screen recorder can be up and the window sized.
/// The take then opened part-way through — on the search results rather than on
/// the list — and the beat timings the editor cuts against did not line up with
/// the footage at all. Nothing reported it; the video was simply wrong.
///
/// A capture script sets this to cover its own setup. It changes nothing for
/// anybody else: without `BURROW_FILM=1` the choreography does not run, and
/// without this variable it starts as it always did.
#[tauri::command]
pub fn film_delay() -> u64 {
    std::env::var("BURROW_FILM_DELAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

#[tauri::command]
pub fn film_beat(state: State<'_, AppState>, label: String, at: f64) -> Result<(), String> {
    if !film_mode() {
        return Ok(());
    }
    let path = state.cache_dir.join("film-beats.json");
    let mut beats: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|b| serde_json::from_str(&b).ok())
        .unwrap_or_default();
    beats.push(serde_json::json!({ "label": label, "t": at }));
    std::fs::write(&path, serde_json::to_string_pretty(&beats).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Everything the UI needs to describe one destination.
pub fn destination_by_id<'a>(env: &'a Environment, id: &str) -> Option<&'a Destination> {
    env.destinations.iter().find(|d| d.id == id)
}
