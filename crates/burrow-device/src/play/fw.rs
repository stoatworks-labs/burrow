//! The PLAY's update package: a gzip'd ustar with an executable `./update` at
//! the top. No signature, no encryption, no vendor key — the stock updater does
//! `tar xf` and runs `./update` as root, and that is the whole contract.
//!
//! A port of the web patcher's `public/fw.js`. The tar layer is byte-for-byte
//! the page's (same header fields, same fixed mtime), so the two can be
//! compared. The gzip layer here is deterministic too: a fixed header and one
//! compressor, where the browser's differs between engines.

use flate2::read::GzDecoder;
use flate2::{Compression, GzBuilder};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const BLOCK: usize = 512;
/// 2020-01-01T00:00:00Z. Zero would make GNU tar on the device warn about an
/// implausibly old timestamp on every member.
pub const MTIME: u64 = 1_577_836_800;

fn octal(value: u64, width: usize) -> String {
    format!("{value:0w$o}\0", w = width - 1)
}

pub fn tar_header(name: &str, size: u64, mode: u32, typeflag: u8) -> Result<[u8; BLOCK], String> {
    let mut h = [0u8; BLOCK];
    let mut put = |s: &[u8], offset: usize, len: usize| -> Result<(), String> {
        if s.len() > len {
            return Err(format!("tar field overflow: {}", String::from_utf8_lossy(s)));
        }
        h[offset..offset + s.len()].copy_from_slice(s);
        Ok(())
    };
    if name.len() > 100 {
        return Err(format!("tar name too long: {name}"));
    }
    put(name.as_bytes(), 0, 100)?;
    put(octal(mode as u64, 8).as_bytes(), 100, 8)?;
    put(octal(0, 8).as_bytes(), 108, 8)?;
    put(octal(0, 8).as_bytes(), 116, 8)?;
    put(octal(size, 12).as_bytes(), 124, 12)?;
    put(octal(MTIME, 12).as_bytes(), 136, 12)?;
    put(&[typeflag], 156, 1)?;
    put(b"ustar\0", 257, 6)?;
    put(b"00", 263, 2)?;
    put(b"root", 265, 32)?;
    put(b"root", 297, 32)?;
    // The checksum field reads as spaces while it is summed.
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|&b| b as u32).sum();
    let field = format!("{sum:06o}\0 ");
    h[148..156].copy_from_slice(field.as_bytes());
    Ok(h)
}

/// The archive being built, in member order. Parent directories are added the
/// first time something goes in them, as the page does.
#[derive(Default)]
pub struct Tar {
    out: Vec<u8>,
    dirs: std::collections::BTreeSet<String>,
}

impl Tar {
    pub fn new() -> Tar {
        Tar::default()
    }

    pub fn dir(&mut self, path: &str) -> Result<(), String> {
        if self.dirs.contains(path) {
            return Ok(());
        }
        if let Some(parent) = path.rfind('/').map(|i| &path[..i]) {
            if !parent.is_empty() && parent != "." {
                self.dir(parent)?;
            }
        }
        self.dirs.insert(path.to_string());
        self.out.extend_from_slice(&tar_header(&format!("{path}/"), 0, 0o755, b'5')?);
        Ok(())
    }

    pub fn file(&mut self, path: &str, data: &[u8], mode: u32) -> Result<(), String> {
        if let Some(parent) = path.rfind('/').map(|i| &path[..i]) {
            if !parent.is_empty() && parent != "." {
                self.dir(parent)?;
            }
        }
        self.out.extend_from_slice(&tar_header(path, data.len() as u64, mode, b'0')?);
        self.out.extend_from_slice(data);
        let pad = (BLOCK - data.len() % BLOCK) % BLOCK;
        self.out.extend(std::iter::repeat_n(0u8, pad));
        Ok(())
    }

    /// The finished tar: two zero blocks end it.
    pub fn finish(mut self) -> Vec<u8> {
        self.out.extend(std::iter::repeat_n(0u8, BLOCK * 2));
        self.out
    }
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    // mtime 0, no file name, OS byte "unknown": the same .fw from the same
    // inputs on any machine.
    let mut enc = GzBuilder::new().mtime(0).operating_system(255).write(Vec::new(), Compression::best());
    enc.write_all(data).expect("writing to a Vec cannot fail");
    enc.finish().expect("writing to a Vec cannot fail")
}

/// gunzip that gives up as soon as the output passes `limit`. A few hundred KB
/// of gzip'd zeros unpack to gigabytes, and a user-supplied module must be
/// refused before that, not after.
pub fn gunzip_bounded(data: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(data)
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("not a valid gzip stream: {e}"))?;
    if out.len() as u64 > limit {
        return Err(format!("unpacks to more than {} — refusing to read further", human_size(limit)));
    }
    Ok(out)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// One member of a tar, as the device's GNU tar would see it. Long names arrive
/// whole whether the writer used a ustar prefix, a pax header or GNU's
/// ././@LongLink; the carrier records themselves are consumed.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
    pub mode: u32,
    pub kind: u8,
    pub linkname: String,
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

pub fn tar_entries(view: &[u8]) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let mut off = 0;
    let mut pending_name: Option<String> = None;
    let mut pending_link: Option<String> = None;
    while off + BLOCK <= view.len() {
        let header = &view[off..off + BLOCK];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let field = |o: usize, l: usize| cstr(&header[o..o + l]).trim().to_string();
        let num = |o: usize, l: usize| u64::from_str_radix(&field(o, l), 8).unwrap_or(0);
        let mut name = field(0, 100);
        let mode = num(100, 8) as u32;
        let size = num(124, 12) as usize;
        let kind = match header[156] {
            0 => b'0',
            c => c,
        };
        // POSIX ustar splits a long name across prefix + name. GNU reuses those
        // bytes, so only honour it for real ustar.
        if cstr(&header[257..263]) == "ustar" && header[263] == b'0' {
            let prefix = field(345, 155);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        off += BLOCK;
        if off + size > view.len() {
            return Err("a tar member runs past the end of the archive".into());
        }
        let data = view[off..off + size].to_vec();
        off += size.div_ceil(BLOCK) * BLOCK;
        match kind {
            b'L' => {
                pending_name = Some(cstr(&data));
                continue;
            }
            b'K' => {
                pending_link = Some(cstr(&data));
                continue;
            }
            b'x' | b'g' => {
                let recs = pax_records(&data)?;
                if kind == b'g' {
                    // A global path override would rename every later member.
                    // Refuse rather than stage members under the wrong names.
                    if recs.iter().any(|(k, _)| k == "path" || k == "linkpath") {
                        return Err("archive uses a global pax path override — repack it as plain ustar (tar --format=ustar)".into());
                    }
                    continue;
                }
                for (k, v) in recs {
                    match k.as_str() {
                        "path" => pending_name = Some(v),
                        "linkpath" => pending_link = Some(v),
                        _ => {}
                    }
                }
                continue;
            }
            _ => {}
        }
        if let Some(n) = pending_name.take() {
            name = n;
        }
        let linkname = pending_link.take().unwrap_or_else(|| field(157, 100));
        out.push(Entry { name, data, mode, kind, linkname });
    }
    Ok(out)
}

/// The key=value records of a pax header, split on byte lengths. Each record is
/// "<len> key=value\n" with <len> the byte count of the whole record. Anything
/// that does not frame that way is refused: this is the archive gate, and a
/// record that misdeclares its length would rename the member after it.
pub fn pax_records(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut p = 0;
    while p < bytes.len() {
        let mut sp = p;
        while sp < bytes.len() && bytes[sp] != b' ' {
            sp += 1;
        }
        let len_text = std::str::from_utf8(&bytes[p..sp]).unwrap_or("");
        let len: usize = if !len_text.is_empty() && !len_text.starts_with('0') && len_text.bytes().all(|c| c.is_ascii_digit()) {
            len_text.parse().unwrap_or(0)
        } else {
            0
        };
        if len == 0 || len <= sp - p + 1 || p + len > bytes.len() || bytes[p + len - 1] != b'\n' {
            return Err("malformed pax header record".into());
        }
        let rec = String::from_utf8_lossy(&bytes[sp + 1..p + len - 1]).into_owned();
        if let Some(eq) = rec.find('=') {
            if eq > 0 {
                out.push((rec[..eq].to_string(), rec[eq + 1..].to_string()));
            }
        }
        p += len;
    }
    Ok(out)
}

/// ELF magic, 64-bit, e_machine 0xB7 (AArch64) little-endian.
pub fn is_arm64_elf(d: &[u8]) -> bool {
    d.len() > 20 && d[0..4] == [0x7f, b'E', b'L', b'F'] && d[4] == 2 && d[18] == 0xb7 && d[19] == 0
}

pub fn is_elf(d: &[u8]) -> bool {
    d.len() > 4 && d[0..4] == [0x7f, b'E', b'L', b'F']
}

/// The two binaries out of an official tailscale_<ver>_arm64.tgz.
pub fn extract_tailscale(tgz: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let tar = gunzip_bounded(tgz, 512 * 1024 * 1024)?;
    let (mut daemon, mut cli) = (None, None);
    for e in tar_entries(&tar)? {
        if e.kind != b'0' && e.kind != b'7' {
            continue;
        }
        let name = e.name.trim_start_matches("./");
        let rel: String = name.split('/').skip(1).collect::<Vec<_>>().join("/");
        match rel.as_str() {
            "tailscaled" => daemon = Some(e.data),
            "tailscale" => cli = Some(e.data),
            _ => {}
        }
    }
    let (Some(daemon), Some(cli)) = (daemon, cli) else {
        return Err("that tarball does not contain both tailscaled and tailscale".into());
    };
    if !is_arm64_elf(&daemon) {
        return Err("tailscaled in that tarball is not an aarch64 ELF — wrong architecture".into());
    }
    Ok((daemon, cli))
}

/// The `mediamtx` binary (and its LICENSE) out of a MediaMTX release tarball.
pub fn extract_mediamtx(tgz: &[u8]) -> Result<(Vec<u8>, Option<Vec<u8>>), String> {
    let tar = gunzip_bounded(tgz, 512 * 1024 * 1024)?;
    let (mut bin, mut license) = (None, None);
    for e in tar_entries(&tar)? {
        if e.kind != b'0' && e.kind != b'7' {
            continue;
        }
        match e.name.trim_start_matches("./").rsplit('/').next() {
            Some("mediamtx") => bin = Some(e.data),
            Some("LICENSE") => license = Some(e.data),
            _ => {}
        }
    }
    let bin = bin.ok_or("that tarball does not contain a mediamtx binary")?;
    if !is_arm64_elf(&bin) {
        return Err("mediamtx in that tarball is not an aarch64 ELF — wrong architecture".into());
    }
    Ok((bin, license))
}

// --- modules ------------------------------------------------------------------

pub const MODULE_PREFIX: &str = "./modules/";
/// Names whose /userdata/bd-<name> or unit would collide with a built-in
/// payload. The kit carries the installer's own list; this is the fallback.
pub const RESERVED_MODULE_NAMES: [&str; 11] = [
    "tailscale", "tailscale-ui", "kvm", "cam", "cam-api", "play", "probe", "modules", "gateway", "gw", "mtx",
];
pub const MODULE_MAX_BYTES: u64 = 256 * 1024 * 1024;

fn is_module_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn is_module_version(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(c))
}

/// Shell-style KEY=value, one per line. Read, never sourced — as the installer.
pub fn parse_module_conf(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let kb = k.as_bytes();
        if kb.is_empty()
            || !kb[0].is_ascii_uppercase()
            || !kb.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
        {
            continue;
        }
        let mut v = v.trim();
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            v = &v[1..v.len() - 1];
        }
        out.push((k.to_string(), v.to_string()));
    }
    out
}

/// What a Mac leaves in a tarball: AppleDouble files, .DS_Store, __MACOSX, and
/// pax carrier directories some tools leave behind.
fn is_junk(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    let last = parts.last().copied().unwrap_or("");
    if last.starts_with("._") || last == ".DS_Store" {
        return true;
    }
    for (i, part) in parts.iter().enumerate() {
        if *part == "__MACOSX" {
            return true;
        }
        let pax = part.strip_prefix("PaxHeaders").or_else(|| part.strip_prefix("PaxHeader"));
        if let Some(rest) = pax {
            let numbered = rest.is_empty() || (rest.starts_with('.') && rest.len() > 1 && rest[1..].bytes().all(|c| c.is_ascii_digit()));
            if numbered && i + 1 < parts.len() {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone)]
pub struct ModuleFile {
    pub path: String,
    pub data: Vec<u8>,
    pub mode: u32,
}

#[derive(Debug, Clone)]
pub struct Module {
    pub name: String,
    pub version: String,
    pub description: String,
    pub homepage: String,
    pub files: Vec<ModuleFile>,
    pub size: u64,
}

/// Read a module archive — .tar, .tgz or .tar.gz — the way the installer will
/// see it, and refuse anything the package format or the device cannot carry.
/// Structural only: what `install` does as root is its author's business.
pub fn read_module(buf: &[u8], label: &str, reserved: &[String], max_bytes: u64) -> Result<Module, String> {
    if buf.len() > 1 && buf[0] == 0x50 && buf[1] == 0x4b {
        return Err(format!("{label}: that is a zip file — a module is a .tar.gz (tar czf …)"));
    }
    if buf.len() as u64 > max_bytes {
        return Err(format!("{label}: {} is more than the {} ceiling", human_size(buf.len() as u64), human_size(max_bytes)));
    }
    let bytes = if buf.len() > 1 && buf[0] == 0x1f && buf[1] == 0x8b {
        gunzip_bounded(buf, max_bytes + 1024 * 1024).map_err(|e| format!("{label}: {e}"))?
    } else {
        buf.to_vec()
    };
    if bytes.len() < BLOCK * 2 {
        return Err(format!("{label}: too small to be a tar archive"));
    }
    if &bytes[257..262] != b"ustar" {
        return Err(format!("{label}: not a tar archive (no ustar magic)"));
    }
    let members = tar_entries(&bytes).map_err(|e| format!("{label}: {e}"))?;
    let mut entries: Vec<Entry> = Vec::new();
    for mut e in members {
        let mut p = e.name.as_str();
        while let Some(rest) = p.strip_prefix("./").or_else(|| p.strip_prefix('/')) {
            p = rest;
        }
        let p = p.trim_end_matches('/').to_string();
        if p.is_empty() || p == "." {
            continue;
        }
        if p.split('/').any(|c| c == "..") {
            return Err(format!("{label}: path escapes the archive: {}", e.name));
        }
        if is_junk(&p) {
            continue;
        }
        if e.kind == b'1' || e.kind == b'2' {
            return Err(format!(
                "{label}: {p} is a {} — the package format does not carry links; create it from install instead",
                if e.kind == b'2' { "symlink" } else { "hard link" }
            ));
        }
        if !matches!(e.kind, b'0' | b'7' | b'5') {
            return Err(format!("{label}: {p} has unsupported tar member type '{}'", e.kind as char));
        }
        e.name = p;
        entries.push(e);
    }
    if entries.is_empty() {
        return Err(format!("{label}: the archive is empty"));
    }
    // A single top-level directory wrapping everything is stripped.
    let has_root_conf = |es: &[Entry]| es.iter().any(|e| e.kind != b'5' && e.name == "module.conf");
    if !has_root_conf(&entries) {
        let tops: std::collections::BTreeSet<&str> = entries.iter().map(|e| e.name.split('/').next().unwrap_or("")).collect();
        let nested = entries.iter().any(|e| e.kind != b'5' && e.name.contains('/'));
        if tops.len() == 1 && nested {
            let top = tops.into_iter().next().unwrap_or("").to_string();
            for e in &mut entries {
                e.name = e.name.split('/').skip(1).collect::<Vec<_>>().join("/");
            }
            if !has_root_conf(&entries) {
                return Err(format!("{label}: no module.conf at the root (looked at the top level and inside {top}/)"));
            }
        } else {
            return Err(format!("{label}: no module.conf at the root of the archive"));
        }
    }
    let mut by_path: std::collections::BTreeMap<String, Entry> = std::collections::BTreeMap::new();
    for e in entries.into_iter().filter(|e| e.kind != b'5' && !e.name.is_empty()) {
        by_path.insert(e.name.clone(), e);
    }
    let install = by_path
        .get("install")
        .ok_or_else(|| format!("{label}: no install script at the root — the installer runs modules/<name>/install"))?;
    if install.data.is_empty() {
        return Err(format!("{label}: install is empty"));
    }
    let conf = parse_module_conf(&String::from_utf8_lossy(&by_path["module.conf"].data));
    let get = |k: &str| conf.iter().rev().find(|(ck, _)| ck == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let name = get("NAME");
    if !is_module_name(&name) {
        return Err(format!(
            "{label}: module.conf NAME=\"{name}\" — needs 1–32 characters of a-z, 0-9 and -, starting with a letter or digit (it becomes /userdata/bd-<name>)"
        ));
    }
    if reserved.contains(&name) {
        return Err(format!("{label}: NAME=\"{name}\" collides with a payload this generator already ships"));
    }
    let version = get("VERSION");
    if !is_module_version(&version) {
        return Err(format!("{label}: module.conf VERSION=\"{version}\" — needs 1–32 characters of A-Z, a-z, 0-9, . _ + -"));
    }
    let mut size = 0u64;
    let mut files = Vec::new();
    for (path, e) in by_path {
        let full = format!("{MODULE_PREFIX}{name}/{path}");
        if full.len() > 100 {
            return Err(format!(
                "{label}: path too long for the package format — \"{full}\" is {} bytes, the limit is 100. Shorten it by {}.",
                full.len(),
                full.len() - 100
            ));
        }
        if is_elf(&e.data) && !is_arm64_elf(&e.data) {
            return Err(format!("{label}: {path} is an ELF binary but not aarch64 — it cannot run on a PLAY"));
        }
        let exec = path == "install" || path == "uninstall" || e.mode & 0o111 != 0;
        size += e.data.len() as u64;
        files.push(ModuleFile { path, data: e.data, mode: if exec { 0o755 } else { 0o644 } });
    }
    if size > max_bytes {
        return Err(format!(
            "{label}: {} unpacked is more than the {} ceiling — the updater extracts the whole package into a temp dir on the device",
            human_size(size),
            human_size(max_bytes)
        ));
    }
    Ok(Module {
        name,
        version,
        description: get("DESCRIPTION"),
        homepage: get("HOMEPAGE"),
        files,
        size,
    })
}

// --- the rest of the package -----------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct Flags {
    pub tag: String,
    pub tailscale: bool,
    pub tailscale_ui: bool,
    pub kvm: bool,
    pub play: bool,
    pub cam: bool,
    pub cam_ui: bool,
    pub gateway: bool,
    pub gateway_ui: bool,
    pub modules: bool,
    pub reboot: bool,
}

pub fn build_conf(f: &Flags) -> String {
    let b = |v: bool| if v { 1 } else { 0 };
    format!(
        "BUILD_TAG={}\nWITH_TAILSCALE={}\nWITH_TAILSCALE_UI={}\nWITH_KVM={}\nWITH_PLAY={}\nWITH_CAM={}\nWITH_CAM_UI={}\nWITH_GATEWAY={}\nWITH_GATEWAY_UI={}\nWITH_MODULES={}\nDO_REBOOT={}\n",
        f.tag,
        b(f.tailscale),
        b(f.tailscale && f.tailscale_ui),
        b(f.kvm),
        b(f.play),
        b(f.cam),
        b(f.cam && f.cam_ui),
        b(f.gateway),
        b(f.gateway && f.gateway_ui),
        b(f.modules),
        b(f.reboot),
    )
}

/// The build tag as it may appear in a file name and `build.conf`.
pub fn clean_tag(tag: &str, default: &str) -> String {
    let t = tag.trim();
    let t = if t.is_empty() { default } else { t };
    t.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' })
        .collect()
}

const KEY_TYPES: [&str; 6] = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
];
const SK_ECDSA: &str = "sk-ecdsa-sha2-nistp256@openssh.com";

/// None when the key is usable; otherwise what to tell the user. The OpenSSH
/// one-line public key formats sshd will actually load, and never a private key.
pub fn validate_key(text: &str) -> Option<&'static str> {
    let line = text.trim();
    if line.is_empty() {
        return Some("Paste the public key you want to authorise for root.");
    }
    if line.contains('\n') {
        return Some("That is more than one line — paste a single public key.");
    }
    if line.starts_with("-----BEGIN") {
        return Some("That is a PRIVATE key. Paste the .pub file instead.");
    }
    let mut parts = line.splitn(2, char::is_whitespace);
    let kind = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim_start();
    let blob = rest.split(char::is_whitespace).next().unwrap_or("");
    let body = blob.trim_end_matches('=');
    let pad = blob.len() - body.len();
    let ok = (KEY_TYPES.contains(&kind) || kind == SK_ECDSA)
        && !body.is_empty()
        && pad <= 3
        && body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/');
    if ok {
        None
    } else {
        Some("That does not look like an OpenSSH public key (ssh-ed25519 AAAA…).")
    }
}

pub fn human_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    }
}
