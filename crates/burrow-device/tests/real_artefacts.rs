//! Burrow against the artefacts it will really download: the CANary firmware
//! release and the PLAY patcher kit, unpacked from their GitHub releases.
//!
//! Ignored by default — CI should not fetch 15 MB on every push. Run by hand
//! when either release changes:
//!
//!     BURROW_CANARY_DIR=/path/to/unzipped/canary \
//!     BURROW_PLAY_KIT_DIR=/path/to/unzipped/kit \
//!     cargo test -p burrow-device --test real_artefacts -- --ignored

use burrow_device::esp::image::{identify, ImageInfo, APP};
use burrow_device::esp::plan::{check_plan, CheckOptions};
use burrow_device::esp::release::{load_variant, validate, Manifest};
use burrow_device::play::fw::{self, Tar};
use burrow_device::play::kit::{self, Kit, Options};
use std::path::PathBuf;

fn dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| panic!("set {var} to the unpacked release")))
}

#[test]
#[ignore]
fn the_canary_release_loads_and_passes_the_gate_for_every_variant() {
    let root = dir("BURROW_CANARY_DIR");
    let m: Manifest = serde_json::from_str(&std::fs::read_to_string(root.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(validate(&m), Vec::<String>::new());
    assert_eq!(m.releases.len(), 1, "a release zip carries one release");
    let r = &m.releases[0];
    for v in &r.variants {
        let writes = load_variant(&root, r, v).unwrap_or_else(|e| panic!("{}/{}: {e}", r.id, v.id));
        assert_eq!(check_plan(&writes, CheckOptions { flash_bytes: 8 << 20, allow_foreign: false }), Vec::<String>::new());
        let app = writes.iter().find(|w| w.offset == APP).unwrap();
        match identify(&app.data) {
            ImageInfo::App { app, .. } => assert_eq!(app.version, r.id, "the app reports the release id"),
            other => panic!("{other:?}"),
        }
    }
}

#[test]
#[ignore]
fn the_play_kit_loads_and_packs_every_option_it_offers() {
    let root = dir("BURROW_PLAY_KIT_DIR");
    let kit = Kit::load(&root).unwrap();
    let offers = kit.offers();
    assert!(offers.kvm && offers.play && offers.cam && offers.gateway && offers.tailscale_ui, "{offers:?}");

    // Tailscale and MediaMTX are fetched, not shipped; stand-ins with the
    // right shape stand in for them here.
    let elf = |t: u8| {
        let mut e = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0];
        e.extend(std::iter::repeat_n(t, 64));
        e
    };
    let mut ts = Tar::new();
    ts.file("tailscale_1.90.0_arm64/tailscaled", &elf(1), 0o755).unwrap();
    ts.file("tailscale_1.90.0_arm64/tailscale", &elf(2), 0o755).unwrap();
    let mut mtx = Tar::new();
    mtx.file("mediamtx", &elf(3), 0o755).unwrap();
    mtx.file("LICENSE", b"MIT", 0o644).unwrap();
    let fetched = kit::Fetched { tailscale_tgz: Some(fw::gzip(&ts.finish())), mediamtx_tgz: Some(fw::gzip(&mtx.finish())) };

    let o = Options {
        ssh_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop".into(),
        tag: "real-kit".into(),
        tailscale: true,
        kvm: true,
        play: true,
        cam: true,
        cam_ui: true,
        gateway: true,
        gateway_ui: true,
        reboot: true,
    };
    let built = kit::build(&kit, &o, fetched, &[]).unwrap();
    let tar = fw::gunzip_bounded(&built.fw, 512 << 20).unwrap();
    let names: Vec<String> = fw::tar_entries(&tar).unwrap().into_iter().filter(|e| e.kind == b'0').map(|e| e.name).collect();
    for want in [
        "./update",
        "./probe.sh",
        "./authorized_keys",
        "./build.conf",
        "./userdata/tailscale/tailscaled",
        "./userdata/bd-tailscale-ui/bdts",
        "./userdata/birddog-kvm/bdkvm",
        "./userdata/birddog-kvm/run.sh",
        "./userdata/bd-cam/bdcam",
        "./userdata/bd-cam/api-run.sh",
        "./userdata/bd-play/bdplay",
        "./userdata/bd-play/libpdfium.so",
        "./userdata/bd-play/mount.exfat-fuse",
        "./userdata/bd-gw/mediamtx",
        "./userdata/bd-gw/LICENSE.mediamtx",
        "./userdata/bd-gw/bdgw",
        "./userdata/bd-gw/run.sh",
    ] {
        assert!(names.iter().any(|n| n == want), "{want} is missing from the package: {names:?}");
    }
    eprintln!("{} — {} bytes, tar sha256 {}", built.name, built.fw.len(), built.tar_sha256);
}
