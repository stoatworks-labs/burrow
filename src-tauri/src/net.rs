//! Every outbound request Burrow makes, in one file.
//!
//! There are exactly two kinds, and this module is deliberately the only place
//! either happens, so "what does this app send anywhere" is answerable by
//! reading one screen:
//!
//! 1. **The catalogue** — one GET of `stoatworks-labs.com/catalog.json`, or
//!    the GitHub releases API when that fails.
//! 2. **A plugin archive** — a GET of a GitHub release asset, when the user
//!    asks to install something.
//!
//! No identifier is sent, no list of what is installed, no usage data. The
//! requests carry a User-Agent naming the app and version — which GitHub
//! requires, and which is the only thing about the caller that leaves the
//! machine.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

/// Hosts a download may be redirected to.
///
/// GitHub release downloads bounce through `objects.githubusercontent.com` or
/// `release-assets.githubusercontent.com` (a signed blob URL), so an allowlist
/// has to include them. It exists so a compromised or mistyped catalogue
/// cannot turn an install into a fetch from anywhere at all.
const REDIRECT_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
    "api.github.com",
    "stoatworks-labs.com",
];

/// Nothing this fleet ships is remotely near this. It exists so a wrong URL
/// cannot fill the user's disk.
const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
const MAX_CATALOG: usize = 8 * 1024 * 1024;

pub fn user_agent() -> String {
    format!("stoatworks-burrow/{}", env!("CARGO_PKG_VERSION"))
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            match attempt.url().host_str() {
                Some(h) if REDIRECT_HOSTS.iter().any(|a| h == *a || h.ends_with(&format!(".{a}"))) => {
                    attempt.follow()
                }
                _ => attempt.error("redirected somewhere unexpected"),
            }
        }))
        .build()
        .map_err(|e| format!("could not start the network client: {e}"))
}

#[derive(Debug)]
pub struct Fetched {
    pub body: String,
    pub etag: Option<String>,
}

/// Fetch the catalogue, gated hard on what came back.
///
/// The gate is not defensive programming for its own sake. The realistic
/// failure is **not** a network error: it is a 200 or a 404 carrying an HTML
/// body — a site that has not deployed the route yet, a captive portal, a
/// corporate proxy's block page. `stoatworks-labs.com/catalog.json` returned
/// exactly that (404, `content-type: text/html`) right up until this feature
/// was deployed.
///
/// Treating any of those as "the catalogue" would show the user a fleet that
/// had apparently vanished. So: status, content type, size, then parse — and a
/// failure at any step must leave the cached copy untouched.
pub async fn fetch_catalog(
    client: &reqwest::Client,
    url: &str,
    etag: Option<&str>,
) -> Result<Option<Fetched>, String> {
    let mut req = client.get(url);
    if let Some(tag) = etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let resp = req.send().await.map_err(|e| friendly(&e))?;

    // Unchanged since last time. Nothing to do, and the cache stays valid.
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "the plugin list could not be fetched ({} from {url})",
            resp.status().as_u16()
        ));
    }

    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !ctype.starts_with("application/json") && !ctype.starts_with("text/json") {
        return Err(format!(
            "that address returned {} rather than the plugin list — \
             most likely an error page or a network sign-in screen",
            if ctype.is_empty() { "no content type" } else { &ctype }
        ));
    }

    let new_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let bytes = resp.bytes().await.map_err(|e| friendly(&e))?;
    if bytes.len() > MAX_CATALOG {
        return Err("the plugin list is implausibly large — refusing it".into());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "the plugin list was not readable text".to_string())?;

    Ok(Some(Fetched { body, etag: new_etag }))
}

/// Progress callback: (bytes so far, total if the server said).
pub type OnProgress<'a> = &'a (dyn Fn(u64, Option<u64>) + Send + Sync);

/// Download an archive to `dest`, streaming, with progress.
///
/// Returns the SHA-256 of what arrived. The caller compares it against the
/// digest GitHub publishes for the asset; where there is none to compare
/// against, it is still recorded in the ledger so a later scan can tell
/// whether the bytes on disk are still the bytes that were installed.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    on_progress: OnProgress<'_>,
) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| friendly(&e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "the download failed ({} from {url})",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length();
    if let Some(n) = total {
        if n > MAX_DOWNLOAD {
            return Err(format!("that download is {n} bytes — refusing it"));
        }
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("could not write the download: {e}"))?;

    let mut hasher = Sha256::new();
    let mut seen: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| friendly(&e))?;
        seen += chunk.len() as u64;
        if seen > MAX_DOWNLOAD {
            // Enforced against what actually arrives, not only against the
            // declared length — a server is free to lie about Content-Length.
            let _ = tokio::fs::remove_file(dest).await;
            return Err("that download grew beyond a plausible size".into());
        }
        hasher.update(&chunk);
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write the download: {e}"))?;
        on_progress(seen, total);
    }
    use tokio::io::AsyncWriteExt;
    file.flush().await.map_err(|e| e.to_string())?;

    Ok(hex::encode(hasher.finalize()))
}

/// Turn a transport error into something worth showing a person.
fn friendly(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the connection timed out".into()
    } else if e.is_connect() {
        "could not connect — check the network".into()
    } else if e.is_redirect() {
        "the download was redirected somewhere unexpected and was refused".into()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_user_agent_names_the_app_and_version() {
        // GitHub 403s a request with no User-Agent, and a vague one makes an
        // abuse report impossible to trace back.
        let ua = user_agent();
        assert!(ua.starts_with("stoatworks-burrow/"));
    }

    #[test]
    fn the_client_builds() {
        assert!(client().is_ok());
    }

    #[test]
    fn the_redirect_allowlist_covers_the_host_github_actually_uses() {
        // Measured: a release asset download lands on
        // release-assets.githubusercontent.com. Missing it would break every
        // install while looking like a network fault.
        assert!(REDIRECT_HOSTS.contains(&"release-assets.githubusercontent.com"));
        assert!(REDIRECT_HOSTS.contains(&"objects.githubusercontent.com"));
    }
}
