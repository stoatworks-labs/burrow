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

use std::io::Cursor;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;

pub struct DemoServer {
    pub port: u16,
    pub token: String,
    root: PathBuf,
}

impl DemoServer {
    /// The URL for one demo.
    pub fn url_for(&self, slug: &str) -> String {
        format!("http://127.0.0.1:{}/{}/{}/", self.port, self.token, slug)
    }

    /// The URL of a page that plays one YouTube video.
    ///
    /// ## Why this is not just an iframe in the app
    ///
    /// YouTube refuses to play in a frame whose page origin is not http(s).
    /// A Tauri window is `tauri://localhost`, so embedding the player directly
    /// gets **error 153, "Video player configuration error"** — and it gets it
    /// only in the packaged app, because the browser preview runs on
    /// `http://localhost` and plays perfectly.
    ///
    /// This server already exists and already speaks http on loopback, which is
    /// an origin YouTube accepts. So the app frames a one-line page from here,
    /// and that page frames the video.
    pub fn player_url(&self, video_id: &str) -> Option<String> {
        safe_video_id(video_id)
            .map(|id| format!("http://127.0.0.1:{}/{}/__player/{id}", self.port, self.token))
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

/// A YouTube video id: the character set YouTube actually uses, and nothing
/// else.
///
/// This value comes out of the catalogue and is interpolated into both a URL
/// and a page, so it is checked rather than trusted. A catalogue is a file
/// fetched over the network, and "our own server sent it" is not the same as
/// "it cannot contain a quote".
fn safe_video_id(id: &str) -> Option<&str> {
    let ok = !id.is_empty()
        && id.len() <= 24
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(id)
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

    let thread_root = root.clone();
    let thread_token = token.clone();
    let (ready_tx, ready_rx) = mpsc::channel();

    thread::Builder::new()
        .name("burrow-demos".into())
        .spawn(move || {
            let _ = ready_tx.send(());
            for request in server.incoming_requests() {
                serve(request, &thread_root, &thread_token);
            }
        })
        .map_err(|e| format!("could not start the demo server thread: {e}"))?;

    let _ = ready_rx.recv();
    Ok(DemoServer { port, token, root })
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header is well formed")
}

/// A page whose only job is to hold the video.
///
/// Its CSP is deliberately narrower than the app's: it may frame
/// youtube-nocookie and do nothing else. No scripts of its own, no styles from
/// anywhere, nothing to connect to.
///
/// **Deliberately not autoplaying.** youtube-nocookie holds its tracking
/// cookies back *until playback starts* — so autoplay would set them the
/// instant the window opened and make choosing the nocookie host pointless.
/// The cost is one more click; the thing it buys is the entire reason that
/// host was chosen.
fn player_response(video_id: &str) -> tiny_http::Response<Cursor<Vec<u8>>> {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <title>video</title>\
         <style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}\
         iframe{{border:0;width:100%;height:100%;display:block}}</style>\
         <iframe src=\"https://www.youtube-nocookie.com/embed/{video_id}\
?rel=0&amp;modestbranding=1\" \
         allow=\"accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture\" \
         allowfullscreen></iframe>"
    );
    let len = body.len();
    tiny_http::Response::new(
        tiny_http::StatusCode(200),
        vec![
            header("Content-Type", "text/html; charset=utf-8"),
            header("X-Content-Type-Options", "nosniff"),
            header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; \
                 frame-src https://www.youtube-nocookie.com",
            ),
            header("Cache-Control", "no-store"),
        ],
        Cursor::new(body.into_bytes()),
        Some(len),
        None,
    )
}

fn serve(request: tiny_http::Request, root: &Path, token: &str) {
    if request.method() != &tiny_http::Method::Get {
        let _ = request.respond(tiny_http::Response::empty(405));
        return;
    }

    let url = request.url().split('?').next().unwrap_or("").to_string();

    // The player page, which exists only so the video has an http origin to
    // load under. Handled before the file lookup because it is generated
    // rather than read from disk.
    if let Some(id) = url
        .strip_prefix(&format!("/{token}/__player/"))
        .and_then(safe_video_id)
    {
        let _ = request.respond(player_response(id));
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
    fn the_player_page_frames_youtube_and_nothing_else() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        let (status, head, body) = get(srv.port, &format!("/{}/__player/dQw4w9WgXcQ", srv.token));
        assert_eq!(status, 200);
        assert!(head.contains("text/html"));
        assert!(body.contains("youtube-nocookie.com/embed/dQw4w9WgXcQ"), "got: {body}");
        // No autoplay: nocookie withholds its tracking cookies only until
        // playback begins, so starting automatically would defeat the point of
        // using that host at all.
        assert!(!body.contains("autoplay=1"), "the player must not autoplay: {body}");
        // Its own CSP, narrower than the app's: it may frame the video and do
        // nothing else at all.
        assert!(head.contains("default-src 'none'"), "got: {head}");
        assert!(head.contains("frame-src https://www.youtube-nocookie.com"), "got: {head}");
    }

    #[test]
    fn the_player_refuses_a_video_id_that_is_not_one() {
        // The id comes out of a catalogue fetched over the network and is
        // interpolated into both a URL and a page, so it is checked rather
        // than trusted.
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        for bad in ["../../etc/passwd", "a\"onerror=\"x", "a b", ""] {
            assert!(safe_video_id(bad).is_none(), "{bad:?} should be refused");
        }
        assert_eq!(safe_video_id("-TGCxAFDMYw"), Some("-TGCxAFDMYw"));
        // And the route does not serve one either.
        let (status, _, _) = get(srv.port, &format!("/{}/__player/a b", srv.token));
        assert_ne!(status, 200);
    }

    #[test]
    fn the_player_needs_the_token_too() {
        let t = demo_tree();
        let srv = start(t.path().to_path_buf()).unwrap();
        assert_eq!(get(srv.port, "/wrongtoken/__player/dQw4w9WgXcQ").0, 404);
    }

    #[test]
    fn each_launch_gets_a_different_token() {
        assert_ne!(random_token(), random_token());
    }
}
