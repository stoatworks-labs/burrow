//! Asking for administrator rights, once per batch.
//!
//! Burrow itself never runs as root. When a batch needs to write into a
//! system plugin directory it builds a [`burrow_plan::Plan`], writes it to a
//! private file, and invokes the helper binary through the platform's own
//! authorisation prompt. The helper validates the plan again on its side and
//! applies it.
//!
//! Two properties are worth stating plainly because they shape the UX:
//!
//! - **One prompt per batch**, not per plugin. Installing eight OpenFX plugins
//!   asks for the password once.
//! - **Unprivileged work happens first.** If the user cancels at the prompt,
//!   every FFGL plugin in the same batch is already installed. Cancelling is
//!   reported as cancelled, never as a failure.

use burrow_plan::{Op, Plan, SCHEMA};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum Elevation {
    Applied,
    /// The user dismissed the prompt, or got the password wrong three times.
    /// Distinct from a failure: nothing went wrong, they said no.
    Cancelled,
    Failed(String),
}

/// Write the plan somewhere only this user can read it.
///
/// Mode 0600 and inside the user's own cache directory, both of which the
/// helper re-checks before trusting it.
pub fn write_plan(cache_dir: &Path, plan: &Plan) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| format!("could not prepare {}: {e}", cache_dir.display()))?;
    let path = cache_dir.join(format!("plan-{}.json", plan.batch));
    let body = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write the plan: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("could not secure the plan file: {e}"))?;
    }
    Ok(path)
}

pub fn build_plan(batch: String, reason: String, ops: Vec<Op>) -> Plan {
    Plan {
        schema: SCHEMA,
        batch,
        created_at: now_rfc3339(),
        actor_uid: current_uid(),
        reason,
        ops,
    }
}

fn now_rfc3339() -> String {
    // Seconds since the epoch is enough for a plan's own record of when it was
    // made, and avoids a date-formatting dependency in a security-adjacent path.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid takes no arguments and cannot fail.
    #[allow(unsafe_code)]
    unsafe {
        libc_getuid()
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

/// Run the helper under the platform's authorisation prompt.
#[cfg(target_os = "macos")]
pub fn run_elevated(helper: &Path, plan_path: &Path, reason: &str) -> Elevation {
    use std::process::Command;

    let script = format!(
        "do shell script {} with administrator privileges with prompt {}",
        applescript_quote(&format!(
            "{} {}",
            shell_quote(&helper.to_string_lossy()),
            shell_quote(&plan_path.to_string_lossy())
        )),
        applescript_quote(reason)
    );

    let out = match Command::new("/usr/bin/osascript").arg("-e").arg(&script).output() {
        Ok(o) => o,
        Err(e) => return Elevation::Failed(format!("could not ask for permission: {e}")),
    };

    if out.status.success() {
        return read_result(plan_path);
    }

    let stderr = String::from_utf8_lossy(&out.stderr);
    // osascript reports a dismissed prompt as error -128. Three wrong
    // passwords also ends here. Neither is a failure of the operation.
    if stderr.contains("-128") || stderr.contains("User canceled") {
        Elevation::Cancelled
    } else {
        Elevation::Failed(stderr.trim().to_string())
    }
}

#[cfg(target_os = "windows")]
pub fn run_elevated(_helper: &Path, _plan_path: &Path, _reason: &str) -> Elevation {
    // The Windows path needs a UAC-manifested helper and a ShellExecuteExW
    // "runas" invocation, plus an owner-SID provenance check on the plan in
    // place of the uid comparison. Not written yet — and saying so is better
    // than a stub that appears to work.
    Elevation::Failed(
        "Installing OpenFX and Adobe plugins on Windows is not supported by this build yet. \
         FFGL plugins for Resolume install normally."
            .into(),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn run_elevated(_helper: &Path, _plan_path: &Path, _reason: &str) -> Elevation {
    Elevation::Failed("no plugin hosts are supported on this platform".into())
}

fn read_result(plan_path: &Path) -> Elevation {
    let mut p = plan_path.as_os_str().to_os_string();
    p.push(".result.json");
    let path = PathBuf::from(p);
    let Ok(body) = std::fs::read_to_string(&path) else {
        return Elevation::Failed("the helper produced no result".into());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Elevation::Failed("the helper's result was unreadable".into());
    };
    if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Elevation::Applied
    } else {
        let msg = value
            .get("errors")
            .and_then(|e| e.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("the helper refused the plan")
            .to_string();
        Elevation::Failed(msg)
    }
}

/// Quote a string for the shell, for embedding in `do shell script`.
///
/// Single quotes, with any embedded single quote closed and reopened. An
/// application bundle can easily sit at a path with a space in it, and the
/// helper path comes from the bundle's own resource directory.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote a string as an AppleScript literal.
///
/// The shell-quoted command is *itself* embedded in an AppleScript string, so
/// it gets escaped twice. Getting this wrong is not a syntax error you notice
/// — it is a command that runs with the wrong arguments, as root.
pub fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_survives_a_path_with_spaces() {
        assert_eq!(shell_quote("/Applications/Stoatworks Burrow.app/x"),
                   "'/Applications/Stoatworks Burrow.app/x'");
    }

    #[test]
    fn shell_quoting_neutralises_an_embedded_single_quote() {
        // A user's home directory can contain an apostrophe — "Sam's Mac".
        assert_eq!(shell_quote("/Users/sam's/x"), r"'/Users/sam'\''s/x'");
    }

    #[test]
    fn shell_quoting_neutralises_a_command_substitution_attempt() {
        let q = shell_quote("/tmp/$(touch /tmp/pwned)/x");
        assert!(q.starts_with('\''), "must be single-quoted: {q}");
        assert!(!q.contains("')"), "quote must not be closed early: {q}");
    }

    #[test]
    fn applescript_quoting_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(applescript_quote(r"a\b"), r#""a\\b""#);
    }

    #[test]
    fn the_double_quoting_round_trips_a_hostile_path() {
        // The realistic disaster: a path that closes the AppleScript string
        // and appends another command.
        let path = r#"/tmp/x" & (do shell script "touch /tmp/pwned") & ""#;
        let inner = shell_quote(path);
        let outer = applescript_quote(&inner);
        // Every embedded double quote is escaped, so the literal cannot end early.
        let unescaped = outer.matches('"').count() - outer.matches(r#"\""#).count();
        assert_eq!(unescaped, 2, "only the opening and closing quotes may be bare: {outer}");
    }

    #[test]
    fn a_plan_carries_this_users_uid_so_the_helper_can_check_it() {
        let p = build_plan("a".repeat(32), "test".into(), vec![]);
        assert_eq!(p.schema, SCHEMA);
        #[cfg(unix)]
        assert_eq!(p.actor_uid, current_uid());
    }

    #[test]
    fn a_written_plan_is_private_to_this_user() {
        let t = tempfile::TempDir::new().unwrap();
        let plan = build_plan("b".repeat(32), "test".into(), vec![]);
        let path = write_plan(t.path(), &plan).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            // The helper refuses anything group- or world-accessible.
            assert_eq!(mode & 0o077, 0, "plan is readable by others: {:o}", mode);
        }
    }
}
