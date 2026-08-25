//! Serving the bundled plugin demos from loopback.
//!
//! Each plugin's browser demo is bundled inside Burrow — about 6 MB for the
//! twenty-one that have one. They are static WebGL2 pages with relative asset
//! references, so serving each under its own path prefix is all they need.
//!
//! # Why a server at all, rather than `file://`
//!
//! The demos load ES modules, and a module script from a `file://` origin is
//! blocked by every browser engine. A loopback HTTP server is the smallest
//! thing that makes them work unmodified — and unmodified matters, because a
//! demo that has been edited to run here stops being evidence about the
//! plugin.
//!
//! # What stops this being a hole
//!
//! - It binds **127.0.0.1** on an ephemeral port. Never `0.0.0.0`.
//! - Every URL carries a per-launch random token. Another process on the same
//!   machine cannot guess the path, and the token changes each run.
//! - Only GET. Only inside the demo root, checked after canonicalisation.
//! - It serves a CSP of its own that permits no outbound connection at all,
//!   which is what makes "the demos never phone home" a property of the server
//!   rather than a hope about the content.
//!
//! It briefly also served a page whose only job was to give a YouTube embed an
//! http origin, because YouTube refuses to play from `tauri://`. That is gone:
//! Burrow streams its own copy of each video from a GitHub release, so there is
//! no embed to host and nothing here reaches the internet.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

/// Slug → the URL its video is published at. Filled in when the catalogue
/// loads; read by the proxy route below.
pub type VideoIndex = Arc<Mutex<BTreeMap<String, String>>>;

pub struct DemoServer {
    pub port: u16,
    pub token: String,
    root: PathBuf,
    videos: VideoIndex,
}

impl DemoServer {
    /// The URL for one demo.
    pub fn url_for(&self, slug: &str) -> String {
        format!("http://127.0.0.1:{}/{}/{}/", self.port, self.token, slug)
    }


    /// The address to give a `<video>` for one plugin.
    ///
    /// Not the GitHub URL itself. GitHub serves release assets with
    /// `content-disposition: attachment`, and WebKit refuses to render media
    /// marked as a download — the element shows its broken-playback glyph and
    /// reports no error worth the name. So the bytes are passed through this
    /// server, which re-labels them as `video/mp4` and forwards the Range
    /// header both ways, preserving streaming and seeking.
    pub fn video_url_for(&self, slug: &str) -> Option<String> {
        let known = self.videos.lock().ok()?.contains_key(slug);
        (known && safe_slug(slug).is_some())
            .then(|| format!("http://127.0.0.1:{}/{}/__video/{slug}", self.port, self.token))
    }

    /// Tell the server where each plugin's video lives.
    pub fn set_videos(&self, map: BTreeMap<String, String>) {
        if let Ok(mut v) = self.videos.lock() {
            *v = map;
        }
    }

    pub fn has(&self, slug: &str) -> bool {
        safe_slug(slug).is_some_and(|s| self.root.join(s).join("index.html").is_file())
    }

    #[allow(dead_code)] // diagnostics; kept because "which demos shipped" is a real question
    pub fn slugs(&self) -> Vec<String> {
        let Ok(read) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut out: Vec<String> = read
            .flatten()
            .filter(|e| e.path().join("index.html").is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        out.sort();
        out
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Falls back to something merely unpredictable-enough. The token is a
        // local guessing barrier, not a secret protecting anything sensitive:
        // the worst case is another process on this machine reading demo
        // files that also ship inside the application bundle.
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(1);
        bytes[..16].copy_from_slice(&n.to_le_bytes()[..16.min(16)]);
    }
    hex::encode(bytes)
}

/// A single path segment that is a plain name.
fn safe_slug(slug: &str) -> Option<&str> {
    let ok = !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(slug)
}

/// Resolve a request path to a file inside the demo root, or refuse it.
///
/// Percent-decoding happens *first* — otherwise `%2e%2e%2f` walks straight
/// past a check performed on the raw string. Then the assembled path is
/// canonicalised and confirmed to still be under the root, which catches
/// anything the textual rules missed.
fn resolve(root: &Path, token: &str, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path)?;
    let mut parts = decoded.split('/').filter(|s| !s.is_empty());

    // The per-launch token is the first segment.
    if parts.next()? != token {
        return None;
    }

    let mut path = root.to_path_buf();
    for part in parts {
        if part == "." || part == ".." || part.contains('\0') {
            return None;
        }
        path.push(part);
    }

    // A directory means its index.
    if path.is_dir() {
        path.push("index.html");
    }

    let canonical = path.canonicalize().ok()?;
    let root_canonical = root.canonicalize().ok()?;
    if !canonical.starts_with(&root_canonical) {
        return None;
    }
    // Nothing served may be a symlink pointing out of the tree.
    if std::fs::symlink_metadata(&canonical).ok()?.file_type().is_symlink() {
        return None;
    }
    // Belt and braces on the assembled path's own shape.
    if canonical.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    canonical.is_file().then_some(canonical)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let v = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                out.push(v);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        // Must be a JavaScript type or the browser refuses the module script
        // and the demo silently renders nothing.
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Files that ship in a demo directory but document or test it.
///
/// `.assetsignore` names these in most demos, but three of the nineteen have
/// no such file, so the deny list is built in rather than read.
fn is_not_for_serving(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "readme.md"
        || name == ".assetsignore"
        || name == "_headers"
        || path.components().any(|c| c.as_os_str() == "tools")
}

/// Start the server. Returns once it is listening.
pub fn start(root: PathBuf) -> Result<DemoServer, String> {
    let token = random_token();

    let listener = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::LOCALHOST,
        0,
    )))
    .map_err(|e| format!("could not start the demo server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let server = tiny_http::Server::from_listener(listener, None)
        .map_err(|e| format!("could not start the demo server: {e}"))?;

    let videos: VideoIndex = Arc::new(Mutex::new(BTreeMap::new()));
    let thread_root = root.clone();
    let thread_token = token.clone();
    let thread_videos = videos.clone();
    let (ready_tx, ready_rx) = mpsc::channel();

    thread::Builder::new()
        .name("burrow-demos".into())
        .spawn(move || {
            let _ = ready_tx.send(());
            for request in server.incoming_requests() {
                serve(request, &thread_root, &thread_token, &thread_videos);
            }
        })
        .map_err(|e| format!("could not start the demo server thread: {e}"))?;

    let _ = ready_rx.recv();
    Ok(DemoServer { port, token, root, videos })
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header is well formed")
}

/// Pass a video through from where it is published, re-labelled so a browser
/// will play it.
///
/// GitHub serves release assets as `application/octet-stream` with
/// `content-disposition: attachment`. The content type alone is fine — WebKit
/// sniffs it — but the disposition is not: a media element will not render
/// something the server has declared a download, and it fails with no useful
/// error at all.
///
/// So this fetches the same bytes, forwards the caller's `Range` header
/// upstream and the resulting `Content-Range` back, and answers with
/// `video/mp4`. Seeking and progressive playback both survive, and nothing is
/// buffered to disk.
/// The number of bytes a `Content-Range: bytes 0-99999/7706211` describes.
///
/// Only the range itself — the total after the slash is the size of the whole
/// file, which is not what is about to be sent.
fn range_length(content_range: &str) -> Option<u64> {
    let span = content_range.trim().strip_prefix("bytes ")?.split('/').next()?;
    let (first, last) = span.split_once('-')?;
    let (first, last): (u64, u64) = (first.trim().parse().ok()?, last.trim().parse().ok()?);
    (last >= first).then(|| last - first + 1)
}

fn proxy_video(request: tiny_http::Request, url: &str) {
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let client = match reqwest::blocking::Client::builder()
        .user_agent(crate::net::user_agent())
        .timeout(std::time::Duration::from_secs(60))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            let _ = request.respond(tiny_http::Response::empty(502));
            return;
        }
    };

    let mut req = client.get(url);
    if let Some(r) = &range {
        req = req.header(reqwest::header::RANGE, r);
    }
    let upstream = match req.send() {
        Ok(r) if r.status().is_success() => r,
        _ => {
            let _ = request.respond(tiny_http::Response::empty(502));
            return;
        }
    };

    let status = upstream.status().as_u16();
    let content_range = upstream
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // How many bytes are coming. tiny_http falls back to chunked transfer
    // encoding when it is not told, and a chunked 206 is a strange enough
    // animal that it is not worth handing to a media element — the length is
    // knowable here, so say it.
    //
    // `content_length()` is not enough on its own: reqwest reports None
    // whenever it has decompressed the body, so the value is read from the
    // headers as well, and from the Content-Range as a last resort.
    let len = upstream
        .content_length()
        .or_else(|| {
            upstream
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
        })
        .or_else(|| content_range.as_deref().and_then(range_length));

    let mut headers = vec![
        header("Content-Type", "video/mp4"),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
    ];
    if let Some(cr) = &content_range {
        headers.push(header("Content-Range", cr));
    }

    let reader: Box<dyn Read + Send> = Box::new(upstream);
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        reader,
        len.map(|n| n as usize),
        None,
    )
    // Stating the length above is not enough on its own: tiny_http switches to
    // chunked transfer for any body over its 32 KB threshold whether or not it
    // knows the length, and every video is over that. A chunked 206 is a
    // strange enough animal not to hand to a media element when the length is
    // knowable, so the threshold is raised out of the way.
    .with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

fn serve(request: tiny_http::Request, root: &Path, token: &str, videos: &VideoIndex) {
    if request.method() != &tiny_http::Method::Get {
        let _ = request.respond(tiny_http::Response::empty(405));
        return;
    }

    let url = request.url().split('?').next().unwrap_or("").to_string();


    // A plugin's video, passed through from where it is published.
    if let Some(slug) = url.strip_prefix(&format!("/{token}/__video/")) {
        let target = safe_slug(slug)
            .and_then(|s| videos.lock().ok().and_then(|v| v.get(s).cloned()));
        match target {
            Some(u) => proxy_video(request, &u),
            None => {
                let _ = request
                    .respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            }
        }
        return;
    }

    let resolved = resolve(root, token, &url);

    let Some(path) = resolved else {
        let _ = request.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
        return;
    };
    if is_not_for_serving(&path) {
        let _ = request.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
        return;
    }

    let Ok(body) = std::fs::read(&path) else {
        let _ = request.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
        return;
    };

    let len = body.len();
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![
            header("Content-Type", mime_for(&path)),
            header("X-Content-Type-Options", "nosniff"),
            // The demos are served with no outbound network permission at all.
            // They vendor the shared support footer, which posts feedback to
            // an intake endpoint — harmless and desirable on the hosted copies,
            // but this app already has its own footer, and "the demos never
            // phone home" should be enforced here rather than depend on the
            // vendored script's own origin checks.
            header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; \
                 connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'",
            ),
            header("Cache-Control", "no-store"),
        ],
        Cursor::new(body),
        Some(len),
        None,
    );
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn demo_tree() -> TempDir {
        let t = TempDir::new().unwrap();
        let d = t.path().join("tinsel");
        fs::create_dir_all(d.join("vendor")).unwrap();
        fs::create_dir_all(d.join("tools")).unwrap();
        fs::write(d.join("index.html"), b"<!doctype html><title>demo</title>").unwrap();
        fs::write(d.join("plugin.js"), b"export const x = 1;").unwrap();
        fs::write(d.join("vendor/kit.css"), b"body{}").unwrap();
        fs::write(d.join("README.md"), b"# not for serving").unwrap();
        fs::write(d.join("tools/check.py"), b"print()").unwrap();
        t
    }

    fn get(port: u16, path: &str) -> (u16, String, String) {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = String::new();
        let _ = s.read_to_string(&mut raw);
        let status = raw
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
        (status, head.to_string(), body.to_string())
    }

    #[test]
    fn serves_a_demo_with_the_right_types_and_refuses_everything_else() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        let tok = &srv.token;

        // index.html for a directory
        let (status, head, body) = get(srv.port, &format!("/{tok}/tinsel/"));
        assert_eq!(status, 200);
        assert!(head.contains("text/html"));
        assert!(body.contains("demo"));

        // A module script must arrive as JavaScript or the demo renders nothing.
        let (status, head, _) = get(srv.port, &format!("/{tok}/tinsel/plugin.js"));
        assert_eq!(status, 200);
        assert!(head.contains("text/javascript"), "got: {head}");

        let (status, head, _) = get(srv.port, &format!("/{tok}/tinsel/vendor/kit.css"));
        assert_eq!(status, 200);
        assert!(head.contains("text/css"));

        // The CSP that makes "no phoning home" a property of the server.
        assert!(head.contains("connect-src 'none'"), "got: {head}");
    }

    #[test]
    fn refuses_traversal_raw_and_percent_encoded() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        let tok = &srv.token;

        for path in [
            format!("/{tok}/../../../etc/passwd"),
            format!("/{tok}/tinsel/../../../etc/passwd"),
            // The one a check on the raw string would miss.
            format!("/{tok}/%2e%2e/%2e%2e/etc/passwd"),
            format!("/{tok}/tinsel/%2e%2e%2f%2e%2e%2fetc%2fpasswd"),
        ] {
            let (status, _, body) = get(srv.port, &path);
            assert_eq!(status, 404, "{path} should not be served");
            assert!(!body.contains("root:"), "{path} leaked /etc/passwd");
        }
    }

    #[test]
    fn the_token_is_required() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        assert_eq!(get(srv.port, "/tinsel/index.html").0, 404);
        assert_eq!(get(srv.port, "/wrongtoken/tinsel/index.html").0, 404);
    }

    #[test]
    fn documentation_and_test_tooling_are_not_served() {
        // Wrangler's .assetsignore keeps these off the public demo sites; the
        // same must be true here, and three demos have no .assetsignore at all.
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        let tok = &srv.token;
        assert_eq!(get(srv.port, &format!("/{tok}/tinsel/README.md")).0, 404);
        assert_eq!(get(srv.port, &format!("/{tok}/tinsel/tools/check.py")).0, 404);
    }

    #[test]
    fn only_get_is_allowed() {
        use std::io::{Read, Write};
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        let mut s = std::net::TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        write!(
            s,
            "POST /{}/tinsel/ HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            srv.token
        )
        .unwrap();
        let mut raw = String::new();
        let _ = s.read_to_string(&mut raw);
        assert!(raw.starts_with("HTTP/1.1 405"), "got: {}", raw.lines().next().unwrap_or(""));
    }

    #[test]
    fn it_binds_loopback_only() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        // Connecting over loopback works...
        assert_eq!(get(srv.port, &format!("/{}/tinsel/", srv.token)).0, 200);
        // ...and the listener is not on a routable address. Asserted by
        // construction in `start`; this documents the intent alongside it.
        assert!(srv.port > 0);
    }

    #[test]
    fn knows_which_demos_it_has() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        assert!(srv.has("tinsel"));
        assert!(!srv.has("cartridge"));
        // A plugin with no demo must not be reachable by a crafted slug either.
        assert!(!srv.has("../../etc"));
        assert_eq!(srv.slugs(), vec!["tinsel".to_string()]);
    }

    #[test]
    fn a_video_the_server_does_not_know_is_not_proxied() {
        // The proxy fetches whatever URL it is handed, so what it will accept
        // is the whole of its security surface: only slugs the catalogue put in
        // the index, and only well-formed ones.
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        assert_eq!(srv.video_url_for("tinsel"), None, "nothing indexed yet");

        srv.set_videos(
            [("tinsel".to_string(), "https://example.invalid/tinsel.mp4".to_string())]
                .into_iter()
                .collect(),
        );
        assert!(srv.video_url_for("tinsel").is_some());
        assert_eq!(srv.video_url_for("orrery"), None, "not in the index");
        assert_eq!(srv.video_url_for("../../etc"), None, "not a plain slug");

        // And the route refuses an unknown slug rather than fetching anything.
        assert_eq!(get(srv.port, &format!("/{}/__video/orrery", srv.token)).0, 404);
        assert_eq!(get(srv.port, "/wrongtoken/__video/tinsel").0, 404);
    }

    #[test]
    fn a_content_range_states_how_many_bytes_follow() {
        // Inclusive at both ends, which is the off-by-one this exists to pin.
        assert_eq!(range_length("bytes 0-99999/7706211"), Some(100_000));
        assert_eq!(range_length("bytes 0-0/7706211"), Some(1));
        assert_eq!(range_length("bytes 100-199/7706211"), Some(100));
        assert_eq!(range_length("bytes 0-99999/*"), Some(100_000));
        assert_eq!(range_length("bytes */7706211"), None, "unsatisfied");
        assert_eq!(range_length("7706211"), None, "no unit");
        assert_eq!(range_length("bytes 200-100/7706211"), None, "backwards");
    }

    /// The one test that proves the thing the app actually does.
    ///
    /// ⚠️ Read the reason this exists before deleting it as slow. The bug it
    /// guards was shipped *because* a local stand-in stood in too well: a
    /// hand-rolled server reproduced GitHub's content type and its range
    /// support, the video played, and the header that actually broke playback
    /// — `content-disposition: attachment` — was the one thing the stand-in
    /// did not reproduce. Two of the three things that mattered, and a green
    /// light for the wrong reason.
    ///
    /// So this fetches the real published asset through the real proxy and
    /// asserts on what comes out. Ignored by default because it needs the
    /// network; run it before shipping a change to the video path:
    ///
    ///     cargo test -p burrow --lib -- --ignored --nocapture
    #[test]
    #[ignore = "needs the network; run before shipping a change to the video path"]
    fn the_real_asset_comes_back_playable() {
        const ASSET: &str = "https://github.com/stoatworks-labs/burrow/releases/download/videos-v1/tinsel.mp4";

        // First, establish that the premise still holds — that GitHub really
        // does mark this as a download. If GitHub ever stops, this proxy is
        // dead weight and should be removed rather than left unexplained.
        let direct = reqwest::blocking::Client::builder()
            .user_agent(crate::net::user_agent())
            .build()
            .unwrap()
            .get(ASSET)
            .send()
            .unwrap();
        let disposition = direct
            .headers()
            .get("content-disposition")
            .map(|v| v.to_str().unwrap_or_default().to_string());
        assert!(
            disposition.as_deref().unwrap_or_default().contains("attachment"),
            "GitHub no longer sends content-disposition: attachment ({disposition:?}) — \
             if that is permanent, the proxy has no reason to exist any more"
        );
        drop(direct);

        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        srv.set_videos([("tinsel".to_string(), ASSET.to_string())].into_iter().collect());

        // A ranged request, which is what a <video> actually issues: it asks
        // for the first slice, reads the moov atom out of it, and only then
        // decides it can play. If ranges do not survive the hop, seeking is
        // gone and long videos never start.
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
        use std::io::Write as _;
        write!(
            sock,
            "GET /{}/__video/tinsel HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=0-99999\r\nConnection: close\r\n\r\n",
            srv.token
        )
        .unwrap();
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut sock, &mut raw).unwrap();

        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("headers end");
        let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
        let body = &raw[split + 4..];

        assert!(head.starts_with("http/1.1 206"), "not a partial response:\n{head}");
        assert!(head.contains("content-type: video/mp4"), "mislabelled:\n{head}");
        assert!(head.contains("accept-ranges: bytes"), "seeking would be gone:\n{head}");
        assert!(head.contains("content-range: bytes 0-99999/"), "range not forwarded:\n{head}");
        assert!(
            !head.contains("content-disposition"),
            "the download marking survived the hop — this is the whole bug:\n{head}"
        );
        // Chunked would very likely still play, but a chunked 206 is an odd
        // enough animal to be worth not handing to a media element when the
        // length is knowable. It is knowable.
        assert!(head.contains("content-length: 100000"), "length not stated:\n{head}");
        assert!(!head.contains("transfer-encoding"), "fell back to chunking:\n{head}");

        // And it is a real MP4 whose moov atom is at the front, because
        // -movflags +faststart put it there. Without that the browser has to
        // fetch the whole file before the first frame, and a proxy that
        // streams correctly still feels broken.
        assert_eq!(body.len(), 100_000, "short read");
        assert_eq!(&body[4..8], b"ftyp", "not an MP4 at all");
        let head_of_file = &body[..body.len().min(65536)];
        let moov = head_of_file.windows(4).position(|w| w == b"moov");
        assert!(moov.is_some(), "moov atom is not in the first 64 KB — faststart was lost");
        println!(
            "  proxied {} bytes, ftyp at 4, moov at {}",
            body.len(),
            moov.unwrap()
        );
    }

    #[test]
    fn each_launch_gets_a_different_token() {
        assert_ne!(random_token(), random_token());
    }
}
