//! Burrow's privileged helper.
//!
//! Takes one argument — the path to a plan file — validates it exhaustively,
//! applies it, and writes a result file beside it. That is the entire program.
//!
//! # What it is for
//!
//! OpenFX and After Effects plugins live in directories only root can write.
//! There is no user-writable alternative a host will look in, so *something*
//! has to run as root. This is the smallest thing that can.
//!
//! # What it will not do
//!
//! - Talk to the network. It has no HTTP client linked in.
//! - Open an archive. It has no decompressor linked in.
//! - Delete a path it did not itself just rename, in this same run.
//! - Write anywhere other than a compiled-in whitelist of plugin directories.
//! - Read Burrow's settings, or anything else the user could have tampered
//!   with to redirect it.
//!
//! Those are structural rather than remembered: see `burrow-plan`, which holds
//! the whitelist and the validator, and this crate's dependency list, which is
//! deliberately three entries long.
//!
//! # The trust chain
//!
//! The plan file is the only input, so it is checked hard before anything runs:
//! it must be a regular file, mode 0600, owned by the user who invoked the
//! elevation, opened without following symlinks, and sitting inside that user's
//! own cache directory. Then every operation in it must pass
//! [`burrow_plan::validate`].
//!
//! A residual race remains — the user could swap the file between the check and
//! the read — and it is accepted knowingly: the only person who can win that
//! race is the person who just typed their password to authorise the
//! operation.

use burrow_plan::{validate, Op, Plan};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Serialize)]
struct Applied {
    op: usize,
    detail: String,
}

#[derive(Serialize)]
struct Failure {
    op: usize,
    message: String,
}

#[derive(Serialize)]
struct Outcome {
    ok: bool,
    applied: Vec<Applied>,
    errors: Vec<Failure>,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: burrow-helper <plan.json>");
        return ExitCode::from(2);
    }
    let plan_path = PathBuf::from(&args[1]);

    let outcome = match run(&plan_path) {
        Ok(o) => o,
        Err(message) => Outcome { ok: false, applied: vec![], errors: vec![Failure { op: 0, message }] },
    };

    // The result goes to a file rather than stdout. macOS runs this through
    // `osascript do shell script`, which mangles and truncates output, and on
    // Windows the helper is a windowed binary with no console at all.
    let result_path = result_path_for(&plan_path);
    let body = serde_json::to_string_pretty(&outcome).unwrap_or_else(|e| {
        format!("{{\"ok\":false,\"errors\":[{{\"op\":0,\"message\":\"{e}\"}}]}}")
    });
    if let Err(e) = fs::write(&result_path, body) {
        eprintln!("could not write {}: {e}", result_path.display());
        return ExitCode::from(3);
    }

    if outcome.ok {
        ExitCode::SUCCESS
    } else {
        for f in &outcome.errors {
            eprintln!("op {}: {}", f.op, f.message);
        }
        ExitCode::FAILURE
    }
}

fn result_path_for(plan: &Path) -> PathBuf {
    let mut s = plan.as_os_str().to_os_string();
    s.push(".result.json");
    PathBuf::from(s)
}

/// Who is this actually running on behalf of?
///
/// Under `sudo` or `osascript ... with administrator privileges` the real uid
/// is root, and `SUDO_UID` names the person who authorised it. That is the
/// account whose cache directory the plan must live in and whose files it may
/// read — not root's.
#[cfg(unix)]
fn invoking_uid() -> u32 {
    std::env::var("SUDO_UID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            // SAFETY: getuid is always safe; it takes no arguments and cannot fail.
            #[allow(unsafe_code)]
            unsafe {
                libc::getuid()
            }
        })
}

#[cfg(not(unix))]
fn invoking_uid() -> u32 {
    0
}

/// Open the plan without following symlinks, and check its provenance.
///
/// `O_NOFOLLOW` matters: without it, a symlink at the plan path could point at
/// a file the checks below would pass on and the read would take from
/// somewhere else entirely.
#[cfg(unix)]
fn read_plan_securely(path: &Path, expect_uid: u32) -> Result<String, String> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::FromRawFd;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "the plan path is not a usable filename".to_string())?;

    // SAFETY: c_path is a valid NUL-terminated string that outlives the call.
    #[allow(unsafe_code)]
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW) };
    if fd < 0 {
        return Err(format!(
            "cannot open the plan at {} ({})",
            path.display(),
            io::Error::last_os_error()
        ));
    }
    // SAFETY: fd is a fresh, valid descriptor this function exclusively owns.
    #[allow(unsafe_code)]
    let mut file = unsafe { fs::File::from_raw_fd(fd) };

    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("the plan is not a regular file".into());
    }
    if meta.uid() != expect_uid {
        return Err(format!(
            "the plan is owned by uid {} but was submitted on behalf of uid {expect_uid}",
            meta.uid()
        ));
    }
    // Group- or world-writable means someone other than the authorising user
    // could have rewritten it between the prompt and now.
    if meta.mode() & 0o077 != 0 {
        return Err(format!(
            "the plan is readable or writable by others (mode {:o}) — refusing it",
            meta.mode() & 0o777
        ));
    }

    use std::io::Read;
    let mut body = String::new();
    file.read_to_string(&mut body).map_err(|e| e.to_string())?;
    Ok(body)
}

#[cfg(not(unix))]
fn read_plan_securely(path: &Path, _expect_uid: u32) -> Result<String, String> {
    // On Windows the equivalent check is an owner-SID comparison, and
    // elevation is via a UAC manifest rather than sudo. Not implemented yet;
    // refusing outright is the honest position, because a helper that runs as
    // Administrator with no provenance check is worse than one that does not
    // run.
    let _ = path;
    Err("the privileged helper is not implemented on Windows yet".into())
}

/// The cache directory belonging to the invoking user.
///
/// Derived from the user's own home directory, never from the plan or from an
/// environment variable the plan could influence — otherwise a plan could
/// widen the set of places it is allowed to copy from.
#[cfg(unix)]
fn cache_root_for(uid: u32) -> Result<PathBuf, String> {
    // SAFETY: getpwuid returns a pointer into a static buffer; it is read
    // immediately and not retained. A null return means "no such user".
    #[allow(unsafe_code)]
    let home = unsafe {
        let pw = libc::getpwuid(uid);
        if pw.is_null() {
            return Err(format!("no account for uid {uid}"));
        }
        let dir = (*pw).pw_dir;
        if dir.is_null() {
            return Err(format!("uid {uid} has no home directory"));
        }
        std::ffi::CStr::from_ptr(dir).to_string_lossy().to_string()
    };
    let home = PathBuf::from(home);
    if cfg!(target_os = "macos") {
        Ok(home.join("Library").join("Caches"))
    } else {
        Ok(home.join(".cache"))
    }
}

#[cfg(not(unix))]
fn cache_root_for(_uid: u32) -> Result<PathBuf, String> {
    Err("unsupported platform".into())
}

fn run(plan_path: &Path) -> Result<Outcome, String> {
    let uid = invoking_uid();
    let body = read_plan_securely(plan_path, uid)?;
    let plan: Plan = serde_json::from_str(&body)
        .map_err(|e| format!("the plan is not readable: {e}"))?;

    if plan.actor_uid != uid {
        return Err(format!(
            "the plan names uid {} but was submitted on behalf of uid {uid}",
            plan.actor_uid
        ));
    }

    let cache_root = cache_root_for(uid)?;
    if !plan_path.starts_with(&cache_root) {
        return Err(format!(
            "the plan is not inside {} — refusing it",
            cache_root.display()
        ));
    }

    // The whole vocabulary check: paths, depth, filenames, the purge nonce.
    validate(&plan, &cache_root).map_err(|r| r.to_string())?;

    Ok(apply(&plan))
}

/// Apply the operations in order, rolling back on the first failure.
fn apply(plan: &Plan) -> Outcome {
    let mut applied: Vec<Applied> = Vec::new();
    // What to undo, newest first, if something goes wrong.
    let mut undo: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (i, op) in plan.ops.iter().enumerate() {
        let result = match op {
            Op::EnsureRoot { path } => ensure_root(path).map(|_| format!("created {}", path.display())),
            Op::Replace { from, to } => {
                replace(from, to, &plan.batch, &mut undo).map(|_| format!("placed {}", to.display()))
            }
            Op::Retire { path } => {
                let aside = with_suffix(path, &plan.batch);
                fs::rename(path, &aside)
                    .map(|_| {
                        undo.push((aside.clone(), path.clone()));
                        format!("moved {} aside", path.display())
                    })
                    .map_err(|e| e.to_string())
            }
            Op::Purge { path } => remove_any(path)
                .map(|_| format!("removed {}", path.display()))
                .map_err(|e| e.to_string()),
        };

        match result {
            Ok(detail) => applied.push(Applied { op: i, detail }),
            Err(message) => {
                for (from, to) in undo.iter().rev() {
                    let _ = fs::rename(from, to);
                }
                return Outcome {
                    ok: false,
                    applied,
                    errors: vec![Failure { op: i, message }],
                };
            }
        }
    }

    Outcome { ok: true, applied, errors: vec![] }
}

fn with_suffix(path: &Path, batch: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(format!(".burrow-old-{batch}"));
    PathBuf::from(s)
}

/// Create a whitelisted plugin directory. Owned by root, world-readable,
/// world-traversable — which is what every host needs to scan it.
fn ensure_root(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|e| format!("{}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Copy a staged payload next to its destination, then swap it in.
///
/// The copy is done here rather than by the unprivileged side because the
/// destination directory is the only admin-writable place guaranteed to be on
/// the destination's own filesystem — which is what makes the final rename
/// atomic rather than an `EXDEV` failure.
fn replace(
    from: &Path,
    to: &Path,
    batch: &str,
    undo: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), String> {
    let parent = to
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", to.display()))?;
    ensure_root(parent)?;

    let mut incoming = to.as_os_str().to_os_string();
    incoming.push(format!(".burrow-new-{batch}"));
    let incoming = PathBuf::from(incoming);

    let _ = remove_any(&incoming);
    copy_tree(from, &incoming).map_err(|e| format!("copying {}: {e}", from.display()))?;

    if to.exists() {
        let aside = with_suffix(to, batch);
        fs::rename(to, &aside).map_err(|e| {
            let _ = remove_any(&incoming);
            format!("moving {} aside: {e}", to.display())
        })?;
        undo.push((aside, to.to_path_buf()));
    }

    fs::rename(&incoming, to).map_err(|e| {
        let _ = remove_any(&incoming);
        format!("placing {}: {e}", to.display())
    })?;
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        // Nothing legitimate in a plugin payload is a symlink, and following
        // one here would copy from wherever it points.
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "refusing to copy a symbolic link",
        ));
    }
    if meta.is_file() {
        fs::copy(from, to)?;
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

fn remove_any(p: &Path) -> io::Result<()> {
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}
