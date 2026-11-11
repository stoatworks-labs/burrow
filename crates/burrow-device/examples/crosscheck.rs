//! Writes what Burrow builds for the PLAY, from fixed inputs, so
//! `scripts/crosscheck-play.mjs` can build the same with the web tools' own
//! modules and compare the bytes. Not a test: it needs node and the two web
//! repos, so it is run by hand when either side changes.
//!
//!     cargo run -p burrow-device --example crosscheck -- <out-dir>

use burrow_device::play::fw::Tar;
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
    println!("{}", out.display());
}
