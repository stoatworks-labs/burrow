//! Writes what Burrow builds for the PLAY, from fixed inputs, so
//! `scripts/crosscheck-play.mjs` can build the same with the web tools' own
//! modules and compare the bytes. Not a test: it needs node and the two web
//! repos, so it is run by hand when either side changes.
//!
//!     cargo run -p burrow-device --example crosscheck -- <out-dir> [<kit-dir>]
//!
//! With a kit (the patcher's release kit, unzipped: kit.json and assets/), it
//! also builds whole packages from it, every option on and every option off,
//! and writes the stand-in Tailscale, MediaMTX and module tarballs it used, so
//! the page's code can pack the same inputs.

use burrow_device::play::fw::{self, Tar};
use burrow_device::play::kit::{self, Kit, Options};
use burrow_device::play::{gpt, inject, rkfw, source::MemSource};
use flate2::read::GzDecoder;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

pub const NOW: u32 = 1_760_000_000;
pub const PARAMETER: &str = "FIRMWARE_VER: 1.0\nMACHINE_MODEL: PLAY\nTYPE: GPT\n\
CMDLINE: mtdparts=rk29xxnand:0x00002000@0x00004000(uboot),0x00002000@0x00006000(trust),0x00010000@0x00008000(boot),0x00004000@0x00018000(rootfs),-@0x0001c000(userdata:grow)\n\
uuid:rootfs=614e0000-0000-4b53-8000-1d28000054a9\n";
pub const DISK_SECTORS: u64 = 0x30000;
pub const PACKAGE_BYTES: u64 = 123_457;

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).expect("usage: crosscheck <out-dir>"));
    std::fs::create_dir_all(&out).unwrap();

    let mut n: u8 = 0;
    let mut rng = |b: &mut [u8]| {
        for x in b {
            n = n.wrapping_add(37);
            *x = n;
        }
    };
    let p = rkfw::parse_parameter(PARAMETER);
    let g = gpt::build(&p.partitions, DISK_SECTORS, &gpt::parse_uuid_lines(PARAMETER), &mut rng).unwrap();
    std::fs::write(out.join("rust-gpt-master.bin"), &g.master).unwrap();
    std::fs::write(out.join("rust-gpt-backup.bin"), &g.backup).unwrap();

    let gz = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/play/rootfs.ext2.gz")).unwrap();
    let mut image = Vec::new();
    GzDecoder::new(&gz[..]).read_to_end(&mut image).unwrap();
    std::fs::write(out.join("rootfs.ext2"), &image).unwrap();
    let inj = inject::plan(Arc::new(MemSource(image.clone())), 0x4000, PACKAGE_BYTES, NOW).unwrap();
    for patch in &inj.patches {
        image[patch.offset as usize..patch.offset as usize + patch.bytes.len()].copy_from_slice(&patch.bytes);
    }
    std::fs::write(out.join("rust-rootfs-injected.ext2"), &image).unwrap();
    std::fs::write(out.join("rust-relative-sector.txt"), inj.relative_sector.to_string()).unwrap();

    let mut t = Tar::new();
    t.file("./update", b"#!/bin/sh\necho update\n", 0o755).unwrap();
    t.file("./authorized_keys", b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop\n", 0o600).unwrap();
    t.file("./userdata/tailscale/tailscaled", &vec![0x5a; 1000], 0o755).unwrap();
    t.file("./modules/hello/install", b"#!/bin/sh\n", 0o755).unwrap();
    std::fs::write(out.join("rust-package.tar"), t.finish()).unwrap();

    if let Some(dir) = std::env::args().nth(2) {
        kit_packages(&out, &PathBuf::from(dir));
    }
    println!("{}", out.display());
}

fn arm64(tag: u8, len: usize) -> Vec<u8> {
    let mut e = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0];
    e.extend(std::iter::repeat_n(tag, len));
    e
}

/// Whole packages from a real kit. Tailscale and MediaMTX are fetched, never
/// shipped, so stand-ins with their real layout take their place; both sides
/// unpack the same bytes.
fn kit_packages(out: &std::path::Path, dir: &std::path::Path) {
    let kit = Kit::load(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));

    let mut ts = Tar::new();
    ts.file("tailscale_1.90.0_arm64/tailscaled", &arm64(0x71, 70_000), 0o755).unwrap();
    ts.file("tailscale_1.90.0_arm64/tailscale", &arm64(0x72, 30_000), 0o755).unwrap();
    ts.file("tailscale_1.90.0_arm64/systemd/tailscaled.service", b"[Unit]\n", 0o644).unwrap();
    let ts = fw::gzip(&ts.finish());
    let mut mtx = Tar::new();
    mtx.file("mediamtx", &arm64(0x6d, 90_000), 0o755).unwrap();
    mtx.file("mediamtx.yml", b"logLevel: info\n", 0o644).unwrap();
    mtx.file("LICENSE", b"MIT License\n", 0o644).unwrap();
    let mtx = fw::gzip(&mtx.finish());
    let mut module = Tar::new();
    module.file("hello/module.conf", b"NAME=hello\nVERSION=1.0\nDESCRIPTION=says hi\n", 0o644).unwrap();
    module.file("hello/install", b"#!/bin/sh\necho hi\n", 0o755).unwrap();
    module.file("hello/payload/bin", &arm64(0x68, 4_000), 0o755).unwrap();
    let module = fw::gzip(&module.finish());
    std::fs::write(out.join("kit-tailscale.tgz"), &ts).unwrap();
    std::fs::write(out.join("kit-mediamtx.tgz"), &mtx).unwrap();
    std::fs::write(out.join("kit-module.tgz"), &module).unwrap();
    let modules = [fw::read_module(&module, "hello.tgz", &kit.reserved(), kit.module_max_bytes()).unwrap()];

    let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop".to_string();
    let all = |tabs: bool| Options {
        ssh_key: key.clone(),
        tag: "crosscheck".into(),
        tailscale: true,
        kvm: true,
        play: true,
        cam: true,
        cam_ui: tabs,
        gateway: true,
        gateway_ui: tabs,
        omt: true,
        omt_ui: tabs,
        output: true,
        output_ui: tabs,
        stagetimer: true,
        stagetimer_ui: tabs,
        reboot: true,
    };
    let none = Options { ssh_key: key.clone(), tag: "crosscheck".into(), ..Default::default() };
    for (name, o, with_modules) in [("all", all(true), true), ("all-no-tabs", all(false), false), ("none", none, false)] {
        let fetched = kit::Fetched { tailscale_tgz: Some(ts.clone()), mediamtx_tgz: Some(mtx.clone()) };
        let mods: &[fw::Module] = if with_modules { &modules } else { &[] };
        let built = kit::build(&kit, &o, fetched, mods).unwrap_or_else(|e| panic!("{name}: {e}"));
        let tar = fw::gunzip_bounded(&built.fw, 1 << 30).unwrap();
        assert_eq!(fw::sha256_hex(&tar), built.tar_sha256);
        std::fs::write(out.join(format!("rust-kit-{name}.tar")), &tar).unwrap();
        let mut req = serde_json::to_value(&o).unwrap();
        req["modules"] = serde_json::json!(if with_modules { vec!["kit-module.tgz"] } else { vec![] });
        std::fs::write(out.join(format!("kit-{name}.json")), serde_json::to_string_pretty(&req).unwrap()).unwrap();
        eprintln!("kit package {name}: {} members, {} bytes of tar", fw::tar_entries(&tar).unwrap().len(), tar.len());
    }
}
