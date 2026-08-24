//! The plan an elevated Burrow helper accepts, and the validator both sides run.
//!
//! # Why this crate exists at all
//!
//! Installing an OpenFX or After Effects plugin means writing into a directory
//! owned by root — `/Library/OFX/Plugins` on macOS, `Common Files\OFX\Plugins`
//! on Windows. There is no user-writable alternative: the OpenFX reference host
//! searches `/Library/OFX/Plugins` and `$OFX_PLUGIN_PATH` and nothing else, so a
//! plugin installed anywhere Burrow could reach unprivileged is a plugin
//! DaVinci Resolve will never see.
//!
//! So something has to run as root, and the question is how small it can be.
//!
//! This crate is the answer: the *entire* vocabulary of what the privileged
//! helper can do, plus the validator that decides whether a given plan is
//! inside it. It is a separate crate rather than a module so that the helper
//! binary can depend on this and `serde` and nothing else — no HTTP client, no
//! zip decoder, no Tauri. The code that runs as root should not contain a
//! network stack or a decompressor, and making that structurally true is worth
//! more than remembering not to call them.
//!
//! # The shape of the guarantee
//!
//! Four operations, chosen so that "delete an arbitrary path as root" is not
//! expressible:
//!
//! - [`Op::EnsureRoot`] creates a whitelisted directory, and only a whitelisted
//!   directory.
//! - [`Op::Replace`] puts a staged payload at a whitelisted destination.
//! - [`Op::Retire`] renames a whitelisted destination aside, appending this
//!   plan's nonce.
//! - [`Op::Purge`] deletes a path **only** if its name ends in this plan's
//!   nonce — that is, only something a `Retire` in this same plan just created.
//!
//! Uninstall is `Retire` then `Purge`. You can only delete what you just
//! renamed, with a nonce that is unguessable and single-use. There is no
//! primitive that removes a path the helper did not itself just move.
//!
//! Every destination must be a **direct child, exactly one component deep**, of
//! a compiled-in root in [`WHITELIST`]. Not a descendant — a child. That is
//! what stops a plan reaching `/Library/OFX/Plugins/../../../etc/passwd` by any
//! amount of cleverness, and it costs nothing, because a plugin bundle *is* a
//! direct child of the plugins directory.
//!
//! Note what is deliberately absent: a user-configured custom destination is
//! never elevated. Custom paths install unprivileged or not at all. That single
//! rule means a tampered `settings.json` cannot aim a root write anywhere,
//! because settings are not consulted on this path — the whitelist is a `const`
//! in this file.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Bumped when the plan format changes in a way an older helper would
/// misread. The helper refuses a schema it does not know rather than
/// interpreting unknown fields generously.
pub const SCHEMA: u32 = 1;

/// The directories the helper may write into, and their only permitted depth.
///
/// These are compiled in. They are not read from settings, not passed in the
/// plan, and not derived from an environment variable, because every one of
/// those is something an attacker who can write a file gets to influence.
///
/// macOS paths are absolute and fixed. Windows paths carry a `%VAR%` prefix
/// resolved against the *process* environment at validation time — see
/// [`expand_windows_root`] for why that is safe here and what it refuses.
pub const WHITELIST: &[&str] = &[
    // macOS — the OpenFX standard location. The reference host
    // (openfx/HostSupport/src/ofxhPluginCache.cpp) searches exactly this on
    // macOS, plus $OFX_PLUGIN_PATH. There is no ~/Library equivalent.
    "/Library/OFX/Plugins",
    // macOS — After Effects and Premiere share one MediaCore directory. The
    // "7.0" is an Adobe API generation, not a product version: CC 2025 and
    // 2026 both load from here.
    "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore",
    // Windows equivalents.
    "%CommonProgramFiles%\\OFX\\Plugins",
    "%CommonProgramW6432%\\OFX\\Plugins",
    "%ProgramFiles%\\Adobe\\Common\\Plug-ins\\7.0\\MediaCore",
];

/// Filenames the helper will place or remove.
///
/// Restrictive on purpose: these are the only shapes a plugin payload takes
/// across the three formats and two platforms.
///
/// - macOS FFGL: `Tinsel.bundle`
/// - macOS/Windows OpenFX: `Tinsel.ofx.bundle` (matched by the `.bundle` arm)
/// - macOS Adobe: `LumaKey.plugin`
/// - Windows FFGL: `Tinsel.dll`
/// - Windows Adobe: `LumaKey.aex`
///
/// Note the space in the character class — `Downpour Over.bundle` and
/// `Orrery Mask.bundle` are real filenames in this fleet, and a rule that
/// forbade spaces would reject half of downpour's payload.
const NAME_MAX: usize = 128;
const ALLOWED_EXTENSIONS: &[&str] = &["bundle", "plugin", "dll", "aex", "ofx"];

/// A single plan. One batch of work, one authorisation prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub schema: u32,
    /// A 128-bit random hex nonce, unique per batch. It is both the suffix
    /// [`Op::Retire`] appends and the only suffix [`Op::Purge`] will accept, so
    /// a plan cannot delete leftovers from an earlier batch — or from anything
    /// that merely happens to be named like one.
    pub batch: String,
    pub created_at: String,
    /// The uid (macOS) the helper expects to have been invoked on behalf of.
    /// Checked against the plan file's owner and the invoking user.
    pub actor_uid: u32,
    /// Shown to the user in the authorisation prompt. Carried in the plan so
    /// the prompt and the work cannot describe different things.
    pub reason: String,
    pub ops: Vec<Op>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Create a whitelisted root that does not exist yet. `/Library/OFX` is
    /// absent on a clean machine even with Resolve installed, so a first
    /// OpenFX install genuinely has to make it.
    EnsureRoot { path: PathBuf },
    /// Place `from` (a staged payload in the user's cache) at `to`.
    Replace { from: PathBuf, to: PathBuf },
    /// Rename `path` aside, appending `.burrow-old-<batch>`.
    Retire { path: PathBuf },
    /// Delete a path whose name ends in `.burrow-old-<batch>`, and nothing else.
    Purge { path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    UnknownSchema(u32),
    EmptyBatch,
    BadBatchNonce(String),
    NoOps,
    NotAbsolute(PathBuf),
    /// A `..`, a `.`, an empty component, a UNC or verbatim prefix — anything
    /// that makes the textual path and the resolved path disagree.
    NonLexical(PathBuf),
    /// Not a direct child of any whitelisted root, or not one component deep.
    OutsideWhitelist(PathBuf),
    BadFilename(String),
    /// A `Purge` whose target does not carry this plan's nonce.
    PurgeWithoutNonce(PathBuf),
    /// A `from` that is not under the actor's own cache directory.
    StagingOutsideCache(PathBuf),
    NoWhitelistRootOnThisPlatform,
}

impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reject::UnknownSchema(v) => write!(f, "plan schema {v} is not one this helper knows"),
            Reject::EmptyBatch => write!(f, "plan has no batch nonce"),
            Reject::BadBatchNonce(b) => {
                write!(f, "batch nonce {b:?} is not 32 lowercase hex characters")
            }
            Reject::NoOps => write!(f, "plan has no operations"),
            Reject::NotAbsolute(p) => write!(f, "path is not absolute: {}", p.display()),
            Reject::NonLexical(p) => {
                write!(f, "path contains a traversal or non-literal component: {}", p.display())
            }
            Reject::OutsideWhitelist(p) => write!(
                f,
                "path is not a direct child of a permitted plugin directory: {}",
                p.display()
            ),
            Reject::BadFilename(n) => write!(f, "not a plugin payload filename: {n:?}"),
            Reject::PurgeWithoutNonce(p) => write!(
                f,
                "refusing to delete a path this plan did not retire: {}",
                p.display()
            ),
            Reject::StagingOutsideCache(p) => {
                write!(f, "staged payload is not inside the caller's cache: {}", p.display())
            }
            Reject::NoWhitelistRootOnThisPlatform => {
                write!(f, "no permitted plugin directory is defined for this platform")
            }
        }
    }
}

/// Expand a `%VAR%`-prefixed Windows whitelist entry against the environment.
///
/// Only the leading `%VAR%` is expanded, and only against a fixed set of names
/// the OS itself defines. This is not general expansion: a value containing a
/// further `%` is taken literally, and an undefined variable drops the root
/// rather than collapsing it to a relative path. `%CommonProgramFiles%` unset
/// must mean "this root does not exist here", never "the root is
/// `\OFX\Plugins`".
fn expand_windows_root(entry: &str) -> Option<PathBuf> {
    let rest = entry.strip_prefix('%')?;
    let (var, tail) = rest.split_once('%')?;
    if !matches!(
        var,
        "CommonProgramFiles" | "CommonProgramW6432" | "ProgramFiles" | "ProgramW6432"
    ) {
        return None;
    }
    let base = std::env::var(var).ok()?;
    if base.is_empty() {
        return None;
    }
    Some(PathBuf::from(format!("{base}{tail}")))
}

/// The whitelist roots that actually exist as paths on this platform.
pub fn whitelist_roots() -> Vec<PathBuf> {
    WHITELIST
        .iter()
        .filter_map(|entry| {
            if entry.starts_with('%') {
                if cfg!(windows) {
                    expand_windows_root(entry)
                } else {
                    None
                }
            } else if cfg!(windows) {
                None
            } else {
                Some(PathBuf::from(entry))
            }
        })
        .collect()
}

/// True if every component of `p` is a plain name — no `..`, no `.`, no empty
/// component, no UNC/verbatim/drive-relative prefix.
///
/// This is a *lexical* check and is deliberately done before any filesystem
/// call. `realpath` on a path containing `..` would resolve it and hand back
/// something that looks innocent; refusing the text outright means the string
/// the user authorised and the path the helper touches are the same string.
fn is_plain_absolute(p: &Path) -> Result<(), Reject> {
    let mut saw_root = false;
    let mut saw_prefix = false;
    for c in p.components() {
        match c {
            Component::RootDir => saw_root = true,
            // A Windows drive prefix (`C:`) is fine; a UNC or verbatim prefix
            // (`\\?\`, `\\server\share`) is not — those bypass Win32 path
            // normalisation, which is exactly the property we are relying on.
            Component::Prefix(pre) => {
                let raw = pre.as_os_str().to_string_lossy();
                if raw.starts_with(r"\\") {
                    return Err(Reject::NonLexical(p.to_path_buf()));
                }
                saw_prefix = true;
            }
            Component::Normal(seg) => {
                if seg.is_empty() {
                    return Err(Reject::NonLexical(p.to_path_buf()));
                }
            }
            Component::CurDir | Component::ParentDir => {
                return Err(Reject::NonLexical(p.to_path_buf()))
            }
        }
    }
    if !saw_root && !saw_prefix {
        return Err(Reject::NotAbsolute(p.to_path_buf()));
    }
    Ok(())
}

/// A payload filename: bounded, no separators, one of the known extensions.
fn check_filename(name: &str) -> Result<(), Reject> {
    let bad = name.is_empty()
        || name.len() > NAME_MAX
        || name.starts_with('.')
        || !name.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == ' ' || c == '.' || c == '_' || c == '-'
        });
    if bad {
        return Err(Reject::BadFilename(name.to_string()));
    }
    let ext_ok = ALLOWED_EXTENSIONS
        .iter()
        .any(|e| name.to_ascii_lowercase().ends_with(&format!(".{e}")));
    if !ext_ok {
        return Err(Reject::BadFilename(name.to_string()));
    }
    Ok(())
}

/// A destination must be a direct child of a whitelisted root.
fn check_destination(p: &Path, roots: &[PathBuf]) -> Result<(), Reject> {
    is_plain_absolute(p)?;
    let parent = p.parent().ok_or_else(|| Reject::OutsideWhitelist(p.to_path_buf()))?;
    // Exact match on the parent is what enforces "exactly one component deep".
    // `starts_with` would admit /Library/OFX/Plugins/a/b.
    if !roots.iter().any(|r| r == parent) {
        return Err(Reject::OutsideWhitelist(p.to_path_buf()));
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Reject::OutsideWhitelist(p.to_path_buf()))?;
    check_filename(name)
}

fn is_hex_nonce(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Validate a whole plan. Returns the roots it validated against, so a caller
/// that wants to log what it accepted can.
///
/// `cache_root` is the caller's own cache directory; every `from` must live
/// inside it. The helper derives this from the invoking user rather than from
/// the plan, so a plan cannot widen it.
pub fn validate(plan: &Plan, cache_root: &Path) -> Result<(), Reject> {
    if plan.schema != SCHEMA {
        return Err(Reject::UnknownSchema(plan.schema));
    }
    if plan.batch.is_empty() {
        return Err(Reject::EmptyBatch);
    }
    if !is_hex_nonce(&plan.batch) {
        return Err(Reject::BadBatchNonce(plan.batch.clone()));
    }
    if plan.ops.is_empty() {
        return Err(Reject::NoOps);
    }

    let roots = whitelist_roots();
    if roots.is_empty() {
        return Err(Reject::NoWhitelistRootOnThisPlatform);
    }

    let suffix = format!(".burrow-old-{}", plan.batch);

    for op in &plan.ops {
        match op {
            Op::EnsureRoot { path } => {
                is_plain_absolute(path)?;
                // A root, or a missing ancestor of one *within* the same
                // prefix. `/Library/OFX` has to be creatable so that
                // `/Library/OFX/Plugins` can be; `/Library` does not, and
                // neither does anything outside that chain.
                let ok = roots
                    .iter()
                    .any(|r| r == path || r.starts_with(path) && path.components().count() > 1);
                if !ok {
                    return Err(Reject::OutsideWhitelist(path.clone()));
                }
            }
            Op::Replace { from, to } => {
                is_plain_absolute(from)?;
                if !from.starts_with(cache_root) {
                    return Err(Reject::StagingOutsideCache(from.clone()));
                }
                check_destination(to, &roots)?;
            }
            Op::Retire { path } => check_destination(path, &roots)?,
            Op::Purge { path } => {
                is_plain_absolute(path)?;
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| Reject::PurgeWithoutNonce(path.clone()))?;
                // The nonce is the whole guarantee here: this can only remove
                // something a Retire in *this* plan created.
                if !name.ends_with(&suffix) {
                    return Err(Reject::PurgeWithoutNonce(path.clone()));
                }
                let parent =
                    path.parent().ok_or_else(|| Reject::OutsideWhitelist(path.clone()))?;
                if !roots.iter().any(|r| r == parent) {
                    return Err(Reject::OutsideWhitelist(path.clone()));
                }
                // And the name underneath the nonce still has to be a payload
                // name, so a Retire cannot be tricked into creating a
                // purgeable alias for something else.
                let stem = name.strip_suffix(&suffix).unwrap_or_default();
                check_filename(stem)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "9f2c4a7e6b1d03589f2c4a7e6b1d0358";

    fn cache() -> PathBuf {
        PathBuf::from("/Users/x/Library/Caches/com.stoatworkslabs.burrow")
    }

    fn plan(ops: Vec<Op>) -> Plan {
        Plan {
            schema: SCHEMA,
            batch: NONCE.into(),
            created_at: "2026-08-24T20:31:00Z".into(),
            actor_uid: 501,
            reason: "Install OpenFX plugins".into(),
            ops,
        }
    }

    fn ofx(name: &str) -> PathBuf {
        PathBuf::from(format!("/Library/OFX/Plugins/{name}"))
    }

    // ---- the happy paths, so the guards are known to permit real work ----

    #[test]
    #[cfg(unix)]
    fn a_real_openfx_install_validates() {
        let p = plan(vec![
            Op::EnsureRoot { path: "/Library/OFX/Plugins".into() },
            Op::Replace {
                from: cache().join("staging/9f2c/Tinsel.ofx.bundle"),
                to: ofx("Tinsel.ofx.bundle"),
            },
        ]);
        assert_eq!(validate(&p, &cache()), Ok(()));
    }

    #[test]
    #[cfg(unix)]
    fn a_multi_bundle_payload_validates() {
        // downpour ships two bundles, orrery ships "Orrery Mask" with a space.
        let p = plan(vec![
            Op::Replace {
                from: cache().join("s/Downpour.bundle"),
                to: ofx("Downpour.bundle"),
            },
            Op::Replace {
                from: cache().join("s/Downpour Over.bundle"),
                to: ofx("Downpour Over.bundle"),
            },
        ]);
        assert_eq!(validate(&p, &cache()), Ok(()));
    }

    #[test]
    #[cfg(unix)]
    fn uninstall_is_retire_then_purge() {
        let p = plan(vec![
            Op::Retire { path: ofx("Tinsel.ofx.bundle") },
            Op::Purge {
                path: ofx(&format!("Tinsel.ofx.bundle.burrow-old-{NONCE}")),
            },
        ]);
        assert_eq!(validate(&p, &cache()), Ok(()));
    }

    #[test]
    #[cfg(unix)]
    fn mediacore_is_a_permitted_root() {
        let p = plan(vec![Op::Replace {
            from: cache().join("s/LumaKey.plugin"),
            to: "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/LumaKey.plugin"
                .into(),
        }]);
        assert_eq!(validate(&p, &cache()), Ok(()));
    }

    // ---- traversal and escape ----

    #[test]
    #[cfg(unix)]
    fn refuses_dot_dot_traversal() {
        let p = plan(vec![Op::Retire {
            path: "/Library/OFX/Plugins/../../../etc/passwd".into(),
        }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::NonLexical(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_path_two_components_deep() {
        // starts_with would allow this; an exact parent match does not.
        let p = plan(vec![Op::Retire { path: "/Library/OFX/Plugins/a/B.bundle".into() }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::OutsideWhitelist(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_sibling_directory_with_a_shared_prefix() {
        // /Library/OFX/PluginsEvil must not pass because it begins the same way.
        let p = plan(vec![Op::Retire { path: "/Library/OFX/PluginsEvil/X.bundle".into() }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::OutsideWhitelist(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_an_unrelated_absolute_path() {
        let p = plan(vec![Op::Retire { path: "/etc/passwd".into() }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::OutsideWhitelist(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_relative_path() {
        let p = plan(vec![Op::Retire { path: "Plugins/X.bundle".into() }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::NotAbsolute(_))));
    }

    // ---- filenames ----

    #[test]
    #[cfg(unix)]
    fn refuses_a_filename_with_no_known_extension() {
        let p = plan(vec![Op::Retire { path: ofx("passwd") }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::BadFilename(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_dotfile() {
        let p = plan(vec![Op::Retire { path: ofx(".hidden.bundle") }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::BadFilename(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_an_overlong_filename() {
        let name = format!("{}.bundle", "a".repeat(NAME_MAX));
        let p = plan(vec![Op::Retire { path: ofx(&name) }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::BadFilename(_))));
    }

    // ---- the purge nonce, which is the deletion guarantee ----

    #[test]
    #[cfg(unix)]
    fn refuses_a_purge_without_the_nonce() {
        let p = plan(vec![Op::Purge { path: ofx("Tinsel.ofx.bundle") }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::PurgeWithoutNonce(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_purge_carrying_another_batchs_nonce() {
        let other = "0000111122223333444455556666aaaa";
        let p = plan(vec![Op::Purge {
            path: ofx(&format!("Tinsel.ofx.bundle.burrow-old-{other}")),
        }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::PurgeWithoutNonce(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_purge_whose_stem_is_not_a_payload_name() {
        // Without the stem check this would let a plan delete anything that
        // could be made to carry the suffix.
        let p = plan(vec![Op::Purge {
            path: ofx(&format!("passwd.burrow-old-{NONCE}")),
        }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::BadFilename(_))));
    }

    // ---- staging ----

    #[test]
    #[cfg(unix)]
    fn refuses_a_source_outside_the_callers_cache() {
        let p = plan(vec![Op::Replace {
            from: "/tmp/evil/Tinsel.ofx.bundle".into(),
            to: ofx("Tinsel.ofx.bundle"),
        }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::StagingOutsideCache(_))));
    }

    // ---- ensure_root ----

    #[test]
    #[cfg(unix)]
    fn ensure_root_permits_a_missing_ancestor_of_a_root() {
        // /Library/OFX does not exist on a clean machine and must be creatable.
        let p = plan(vec![Op::EnsureRoot { path: "/Library/OFX".into() }]);
        assert_eq!(validate(&p, &cache()), Ok(()));
    }

    #[test]
    #[cfg(unix)]
    fn ensure_root_refuses_something_outside_the_chain() {
        let p = plan(vec![Op::EnsureRoot { path: "/System/Evil".into() }]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::OutsideWhitelist(_))));
    }

    // ---- envelope ----

    #[test]
    #[cfg(unix)]
    fn refuses_an_unknown_schema() {
        let mut p = plan(vec![Op::Retire { path: ofx("Tinsel.ofx.bundle") }]);
        p.schema = 99;
        assert!(matches!(validate(&p, &cache()), Err(Reject::UnknownSchema(99))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_a_non_hex_batch_nonce() {
        let mut p = plan(vec![Op::Retire { path: ofx("Tinsel.ofx.bundle") }]);
        p.batch = "../../etc".into();
        assert!(matches!(validate(&p, &cache()), Err(Reject::BadBatchNonce(_))));
    }

    #[test]
    #[cfg(unix)]
    fn refuses_an_empty_plan() {
        let p = plan(vec![]);
        assert!(matches!(validate(&p, &cache()), Err(Reject::NoOps)));
    }

    #[test]
    fn a_plan_round_trips_through_json() {
        let p = plan(vec![Op::Retire { path: "/Library/OFX/Plugins/T.bundle".into() }]);
        let s = serde_json::to_string(&p).unwrap();
        let back: Plan = serde_json::from_str(&s).unwrap();
        assert_eq!(back.batch, p.batch);
        assert_eq!(back.ops.len(), 1);
    }

    #[test]
    fn an_undefined_windows_variable_drops_the_root_rather_than_relativising_it() {
        // The dangerous alternative is expanding to "" and yielding
        // "\OFX\Plugins", which is a real path on the system drive.
        std::env::remove_var("CommonProgramW6432");
        assert_eq!(expand_windows_root("%CommonProgramW6432%\\OFX\\Plugins"), None);
    }

    #[test]
    fn refuses_to_expand_an_arbitrary_variable() {
        std::env::set_var("EVIL", "/tmp");
        assert_eq!(expand_windows_root("%EVIL%\\OFX\\Plugins"), None);
    }
}
