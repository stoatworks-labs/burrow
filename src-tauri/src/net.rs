//! Every outbound request Burrow makes, in one file.
//!
//! This module is deliberately the only place any of them happens, so "what
//! does this app send anywhere" is answerable by reading one file:
//!
//! 1. **The catalogue** — one GET of `stoatworks-labs.com/catalog.json`.
//! 2. **A release asset** — a GET from GitHub, when the user asks to install
//!    something or to write firmware.
//! 3. **Tailscale**, from `pkgs.tailscale.com` — only when a PLAY package is
//!    built with Tailscale in it. The latest stable arm64 tarball, checked
//!    against the `.sha256` Tailscale publishes beside it.
//! 4. **A PLAY on the local network**, at an address the user typed — only when
//!    they ask Burrow to send it a package. A login with the BirdUI password
//!    they typed, the upload, and then asking the unit's front page whether it
//!    is back, for a bounded few minutes. Plain HTTP, because that is all
//!    BirdUI speaks.
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
        // A *read* timeout, not `timeout()`. That one is a deadline on the whole
        // request, body included, and at sixty seconds it failed every download
        // that took longer than a minute — an application on an ordinary
        // connection — with "the connection timed out", which is exactly what it
        // was not. What a download needs caught is a stall: a minute with no
        // bytes at all.
        .read_timeout(Duration::from_secs(60))
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

/// Asked between chunks: should this download stop now?
pub type ShouldStop<'a> = &'a (dyn Fn() -> bool + Send + Sync);

/// How a download ended.
#[derive(Debug)]
pub enum Download {
    /// Every byte arrived, and this is the SHA-256 of them.
    Complete { sha256: String },
    /// The caller asked to stop. The partial file is already gone.
    Cancelled,
}

/// Download an archive to `dest`, streaming, with progress.
///
/// Returns the SHA-256 of what arrived. The caller compares it against the
/// digest GitHub publishes for the asset; where there is none to compare
/// against, it is still recorded in the ledger so a later scan can tell
/// whether the bytes on disk are still the bytes that were installed.
///
/// `should_stop` is consulted between chunks, so a cancelled batch stops
/// within one chunk of being asked rather than at the end of the file — for
/// an application that is the difference between a second and a minute.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    on_progress: OnProgress<'_>,
    should_stop: ShouldStop<'_>,
) -> Result<Download, String> {
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
        if should_stop() {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Ok(Download::Cancelled);
        }
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

    Ok(Download::Complete { sha256: hex::encode(hasher.finalize()) })
}

/// A small text body: an index, a checksum file. Capped, because each is a
/// few hundred bytes and anything much larger is not what was asked for.
pub async fn fetch_text(client: &reqwest::Client, url: &str, max: usize) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| friendly(&e))?;
    if !resp.status().is_success() {
        return Err(format!("{} from {url}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| friendly(&e))?;
    if bytes.len() > max {
        return Err(format!("{url} sent more than expected — refusing it"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{url} was not readable text"))
}

/// The client for pkgs.tailscale.com, which may hand a download on to another
/// Tailscale host and nowhere else.
pub fn tailscale_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent())
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            match attempt.url().host_str() {
                Some(h) if h == "tailscale.com" || h.ends_with(".tailscale.com") => attempt.follow(),
                _ => attempt.error("redirected somewhere unexpected"),
            }
        }))
        .build()
        .map_err(|e| format!("could not start the network client: {e}"))
}

/// The latest stable Tailscale for arm64: (version, file name, published sha256).
/// The same three requests the web patcher's Worker makes, made from here.
pub async fn tailscale_latest(client: &reqwest::Client, index: &str, base: &str, arch: &str) -> Result<(String, String, String), String> {
    let body = fetch_text(client, index, 256 * 1024).await?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "Tailscale's index was not JSON".to_string())?;
    let version = v["TarballsVersion"].as_str().unwrap_or("").to_string();
    let file = v["Tarballs"][arch].as_str().unwrap_or("").to_string();
    let plausible = |s: &str| {
        let parts: Vec<&str> = s.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|c| c.is_ascii_digit()))
    };
    if !plausible(&version) || file.is_empty() || file.contains('/') {
        return Err(format!("Tailscale's index has no {arch} tarball Burrow recognises"));
    }
    let sidecar = fetch_text(client, &format!("{base}{file}.sha256"), 4096).await?;
    let sha = sidecar.split_whitespace().next().unwrap_or("").to_string();
    if sha.len() != 64 || !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Tailscale published no usable SHA-256 for that tarball".into());
    }
    Ok((version, file, sha.to_ascii_lowercase()))
}

/// Where a PLAY's BirdUI is, from what the user typed: a host name or an IPv4
/// address, optionally with a port. Nothing with a scheme, a path or a user in
/// it, so the address cannot be turned into a request anywhere else.
pub fn birdui_base(address: &str) -> Result<String, String> {
    let a = address.trim();
    let ok = !a.is_empty()
        && a.len() <= 253
        && a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b':')
        && a.matches(':').count() <= 1;
    if !ok {
        return Err("that is not a host name or address — type just the PLAY's address, like 192.168.1.40".into());
    }
    Ok(format!("http://{a}"))
}

/// The client for a PLAY: a cookie for the BirdUI session, and redirects only
/// within the unit itself.
pub fn birdui_client(base: &str) -> Result<reqwest::Client, String> {
    let host = reqwest::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .ok_or("bad address")?;
    reqwest::Client::builder()
        .user_agent(user_agent())
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(10))
        // /login has been seen to take 15–20 s on a unit that has been idle.
        .read_timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 || attempt.url().host_str() != Some(host.as_str()) {
                return attempt.error("redirected off the unit");
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| format!("could not start the network client: {e}"))
}

/// What BirdUI shows when the session is not logged in.
const BIRDUI_LOGIN_MARKER: &str = "auth_form";

/// Log in and upload a package through BirdUI's System Update form, as a
/// browser on its settings page does: `POST /login` with the password, then a
/// multipart `POST /settings` carrying `update_file` and `button=update`.
pub async fn birdui_send(base: &str, password: &str, file_name: &str, fw: Vec<u8>) -> Result<(), String> {
    let client = birdui_client(base)?;
    // One retry: the first /login after a unit has been idle can outlast a
    // generous timeout on its own (flock, measured on 1.0.18).
    let mut last = None;
    for _ in 0..2 {
        match client.post(format!("{base}/login")).form(&[("auth_password", password)]).send().await {
            Ok(_) => {
                last = None;
                break;
            }
            Err(e) => last = Some(friendly(&e)),
        }
    }
    if let Some(e) = last {
        return Err(format!("could not reach BirdUI at {base}: {e}"));
    }
    let page = client
        .get(format!("{base}/settings"))
        .send()
        .await
        .map_err(|e| friendly(&e))?
        .text()
        .await
        .map_err(|e| friendly(&e))?;
    if page.contains(BIRDUI_LOGIN_MARKER) {
        return Err("BirdUI did not accept that password".into());
    }
    if !page.contains("update_file") {
        return Err("that unit's System page has no update form Burrow recognises".into());
    }
    let part = reqwest::multipart::Part::bytes(fw)
        .file_name(file_name.to_string())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("update_file", part).text("button", "update");
    let resp = client
        .post(format!("{base}/settings"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| friendly(&e))?;
    if !resp.status().is_success() {
        return Err(format!("BirdUI answered the upload with {}", resp.status().as_u16()));
    }
    Ok(())
}

/// After a send: does the unit's front page answer? Asked every few seconds
/// until it does or `limit` passes — the one loop in this file, and it runs
/// only because the user just asked for something that restarts the unit.
pub async fn birdui_wait(base: &str, settle: Duration, limit: Duration) -> bool {
    let Ok(client) = birdui_client(base) else { return false };
    tokio::time::sleep(settle).await;
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        if let Ok(r) = client.get(format!("{base}/")).timeout(Duration::from_secs(5)).send().await {
            if r.status().is_success() || r.status().is_redirection() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    false
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
    fn a_play_address_is_a_host_and_nothing_else() {
        assert_eq!(birdui_base(" 192.168.1.40 ").unwrap(), "http://192.168.1.40");
        assert_eq!(birdui_base("play-1.local:8080").unwrap(), "http://play-1.local:8080");
        for bad in ["http://192.168.1.40", "192.168.1.40/settings", "user@host", "", "a:b:c", "evil.com/../"] {
            assert!(birdui_base(bad).is_err(), "{bad}");
        }
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
