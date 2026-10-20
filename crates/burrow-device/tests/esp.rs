//! The CANary Flasher's `test/image.test.ts`, ported against the same release
//! (main-ff4110d), plus the gates Burrow adds.
//!
//! The fixtures are the real bootloader and partition table and the first 4 KB
//! of the real app, padded back out to the app's real length with 0xFF so every
//! size-based rule sees the true numbers. A full app image is 450 KB of binary
//! that no test reads past its descriptor.

use burrow_device::esp::image::{
    active_ota_slot, identify, otadata_entry, ImageInfo, APP, OTADATA, OTADATA_LEN, PARTITION_TABLE,
};
use burrow_device::esp::plan::{
    check_device, check_plan, with_otadata_reset, CheckOptions, DeviceFacts, PlannedWrite,
};
use burrow_device::esp::release::{load_variant, plan_own_build, validate, Manifest};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MB8: u64 = 8 * 1024 * 1024;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/canary").join(name)
}

fn app() -> Vec<u8> {
    let size: usize = std::fs::read_to_string(fixture("app-size.txt")).unwrap().trim().parse().unwrap();
    let mut a = std::fs::read(fixture("app-head.bin")).unwrap();
    a.resize(size, 0xff);
    a
}

fn bundle() -> Vec<PlannedWrite> {
    vec![
        PlannedWrite { name: "bootloader".into(), offset: 0, data: std::fs::read(fixture("bootloader.bin")).unwrap() },
        PlannedWrite { name: "partition table".into(), offset: PARTITION_TABLE, data: std::fs::read(fixture("partition-table.bin")).unwrap() },
        PlannedWrite { name: "otadata".into(), offset: OTADATA, data: vec![0xff; OTADATA_LEN] },
        PlannedWrite { name: "app".into(), offset: APP, data: app() },
    ]
}

fn opts() -> CheckOptions {
    CheckOptions { flash_bytes: MB8, allow_foreign: false }
}

fn manifest() -> Manifest {
    serde_json::from_str(&std::fs::read_to_string(fixture("manifest.json")).unwrap()).unwrap()
}

fn find(p: &mut [PlannedWrite], offset: u32) -> &mut PlannedWrite {
    p.iter_mut().find(|w| w.offset == offset).unwrap()
}

// --- the manifest ---------------------------------------------------------

#[test]
fn the_release_manifest_validates() {
    assert_eq!(validate(&manifest()), Vec::<String>::new());
}

#[test]
fn the_manifest_records_the_descriptor_really_in_the_app() {
    let m = manifest();
    let r = &m.releases[0];
    let v = r.variants.iter().find(|v| v.id == "standard").unwrap();
    match identify(&app()) {
        ImageInfo::App { app, .. } => {
            assert_eq!(app.version, v.app.version);
            assert_eq!(app.project, v.app.project);
            assert_eq!(app.idf_version, v.app.idf_version);
        }
        other => panic!("not an app: {other:?}"),
    }
}

#[test]
fn the_manifest_records_the_real_bootloader_and_table_hashes() {
    let m = manifest();
    let v = m.releases[0].variants.iter().find(|v| v.id == "standard").unwrap();
    for (offset, file) in [(0u32, "bootloader.bin"), (PARTITION_TABLE, "partition-table.bin")] {
        let part = v.parts.iter().find(|p| p.offset == offset).unwrap();
        let data = std::fs::read(fixture(file)).unwrap();
        assert_eq!(data.len() as u64, part.size, "{file}");
        assert_eq!(hex::encode(Sha256::digest(&data)), part.sha256, "{file}");
    }
}

#[test]
fn a_short_commit_or_a_missing_bootloader_is_refused() {
    let mut m = manifest();
    m.releases[0].commit = "4bd1ac5".into();
    m.releases[0].variants[0].parts.retain(|p| p.offset != 0);
    let e = validate(&m).join("\n");
    assert!(e.contains("40-character"), "{e}");
    assert!(e.contains("nothing at 0x0"), "{e}");
}

#[test]
fn a_part_path_that_climbs_out_is_refused_before_it_is_read() {
    let mut m = manifest();
    let r = m.releases[0].clone();
    let mut v = r.variants[0].clone();
    v.parts[0].path = format!("{}/{}/../../../../etc/passwd", r.id, v.id);
    m.releases[0].variants[0] = v.clone();
    let err = load_variant(Path::new("/nonexistent"), &r, &v).unwrap_err();
    assert!(err.contains("not a plain relative path"), "{err}");
}

#[test]
fn load_variant_checks_every_byte_and_the_descriptor() {
    let m = manifest();
    let r = &m.releases[0];
    let v = r.variants.iter().find(|v| v.id == "standard").unwrap();
    // Lay the fixtures out as the zip will, then corrupt the table.
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join(&r.id).join(&v.id);
    std::fs::create_dir_all(&base).unwrap();
    for p in &v.parts {
        let name = Path::new(&p.path).file_name().unwrap().to_str().unwrap().to_string();
        let data = match p.offset {
            0 => std::fs::read(fixture("bootloader.bin")).unwrap(),
            0x8000 => std::fs::read(fixture("partition-table.bin")).unwrap(),
            0xf000 => vec![0xff; OTADATA_LEN],
            _ => app(),
        };
        std::fs::write(base.join(name), data).unwrap();
    }
    // The padded app is not the real app, so its hash will not match: that is
    // the refusal this test wants to see first.
    let err = load_variant(dir.path(), r, v).unwrap_err();
    assert!(err.contains("canary.bin does not match its checksum"), "{err}");
}

// --- identify ---------------------------------------------------------------

#[test]
fn each_real_part_is_told_apart_by_content() {
    let b = bundle();
    assert_eq!(identify(&b[0].data).kind(), "bootloader");
    assert_eq!(identify(&b[3].data).kind(), "app");
    assert_eq!(identify(&b[2].data).kind(), "otadata");
    match identify(&b[1].data) {
        ImageInfo::PartitionTable { partitions } => {
            let labels: Vec<&str> = partitions.iter().map(|p| p.label.as_str()).collect();
            assert_eq!(labels, ["nvs", "otadata", "phy_init", "ota_0", "ota_1", "coredump"]);
            assert_eq!(partitions.iter().find(|p| p.label == "ota_1").unwrap().offset, 0x1f0000);
            assert_eq!(burrow_device::esp::image::ota_slot_offset(&partitions, 0), Some(0x20000));
            assert_eq!(burrow_device::esp::image::ota_slot_offset(&partitions, 1), Some(0x1f0000));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn both_images_say_esp32_s3() {
    for w in [&bundle()[0], &bundle()[3]] {
        match identify(&w.data) {
            ImageInfo::App { chip_id, .. } | ImageInfo::Bootloader { chip_id } => assert_eq!(chip_id, 9),
            other => panic!("{other:?}"),
        }
    }
}

#[test]
fn junk_and_an_empty_file_are_unknown() {
    let junk: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    let mut junk = junk;
    junk[0] = 0;
    assert_eq!(identify(&junk).kind(), "unknown");
    assert_eq!(identify(&[]).kind(), "unknown");
}

// --- check_plan refuses -----------------------------------------------------

#[test]
fn the_real_bundle_passes() {
    assert_eq!(check_plan(&bundle(), opts()), Vec::<String>::new());
}

#[test]
fn an_app_built_for_another_chip() {
    let mut p = bundle();
    find(&mut p, APP).data[12] = 0;
    assert!(check_plan(&p, opts()).join("; ").contains("built for ESP32,"));
}

#[test]
fn an_app_from_another_project_unless_overridden() {
    let mut p = bundle();
    find(&mut p, APP).data[32 + 48..32 + 48 + 8].copy_from_slice(b"blinky\0\0");
    assert!(check_plan(&p, opts()).join("; ").contains("\"blinky\", not a CANary"));
    assert!(check_plan(&p, CheckOptions { allow_foreign: true, ..opts() }).is_empty());
}

#[test]
fn an_app_built_before_the_rename_is_still_ours() {
    let mut p = bundle();
    find(&mut p, APP).data[32 + 48..32 + 48 + 9].copy_from_slice(b"dbcanary\0");
    assert!(check_plan(&p, opts()).is_empty());
}

#[test]
fn overlapping_writes() {
    let mut p = bundle();
    find(&mut p, OTADATA).offset = 0x8000;
    let e = check_plan(&p, opts()).join("; ");
    assert!(e.contains("overlaps") || e.contains("sector"), "{e}");
}

#[test]
fn an_app_over_the_partition_table() {
    let mut p: Vec<PlannedWrite> = bundle().into_iter().filter(|w| w.offset != PARTITION_TABLE).collect();
    find(&mut p, APP).offset = 0x8000;
    assert!(check_plan(&p, opts()).join("; ").contains("would overwrite the bootloader"));
}

#[test]
fn a_bootloader_anywhere_but_zero() {
    let mut p: Vec<PlannedWrite> = bundle().into_iter().filter(|w| w.offset != 0).collect();
    p.push(PlannedWrite { name: "bl".into(), offset: 0x300000, data: bundle()[0].data.clone() });
    assert!(check_plan(&p, opts()).join("; ").contains("only boots from 0x0"));
}

#[test]
fn too_little_flash() {
    let e = check_plan(&bundle(), CheckOptions { flash_bytes: 256 * 1024, ..opts() }).join("; ");
    assert!(e.contains("past the end of flash"), "{e}");
}

#[test]
fn an_unaligned_offset() {
    let mut p = bundle();
    find(&mut p, APP).offset = 0x20010;
    assert!(check_plan(&p, opts()).join("; ").contains("sector boundary"));
}

#[test]
fn nothing_at_all() {
    assert_eq!(check_plan(&[], opts()), vec!["nothing to write".to_string()]);
}

// --- check_device: what the page left to its README -------------------------

fn s3() -> DeviceFacts {
    DeviceFacts { chip: "ESP32-S3".into(), flash_bytes: Some(MB8), secure_boot: false, flash_encryption: false }
}

#[test]
fn a_plain_s3_with_8mb_passes() {
    assert!(check_device(&s3()).is_empty());
}

#[test]
fn a_4mb_s3_is_refused_although_the_images_would_fit() {
    let d = DeviceFacts { flash_bytes: Some(4 * 1024 * 1024), ..s3() };
    assert_eq!(check_device(&d), vec!["this unit has 4 MB of flash, and a CANary has 8 MB".to_string()]);
    // The images themselves fit, which is exactly why the page let it through.
    assert!(check_plan(&bundle(), CheckOptions { flash_bytes: 4 * 1024 * 1024, ..opts() }).is_empty());
}

#[test]
fn an_unreadable_flash_size_is_a_refusal_not_a_guess() {
    let d = DeviceFacts { flash_bytes: None, ..s3() };
    assert!(check_device(&d).join("; ").contains("could not read"));
}

#[test]
fn another_chip_secure_boot_and_flash_encryption_are_refused() {
    assert!(check_device(&DeviceFacts { chip: "ESP32-C3".into(), ..s3() }).join("; ").contains("a CANary is an ESP32-S3"));
    assert!(check_device(&DeviceFacts { secure_boot: true, ..s3() }).join("; ").contains("secure boot"));
    assert!(check_device(&DeviceFacts { flash_encryption: true, ..s3() }).join("; ").contains("flash encryption"));
}

// --- otadata ----------------------------------------------------------------

#[test]
fn the_entry_crc_is_the_one_otatool_computes() {
    // otatool: binascii.crc32(seq_bytes, 0xFFFFFFFF), i.e. zlib crc32 seeded
    // with 0xFFFFFFFF. Known values computed with Python's zlib.
    for (seq, want) in [(1u32, 0x4743_989au32), (2, 0x55f6_3774)] {
        let e = otadata_entry(seq, 2);
        let got = u32::from_le_bytes([e[28], e[29], e[30], e[31]]);
        assert_eq!(got, want, "seq {seq}");
    }
}

#[test]
fn the_valid_entry_with_the_higher_sequence_wins() {
    let mut d = vec![0xffu8; OTADATA_LEN];
    assert_eq!(active_ota_slot(&d), (0, None));
    d[..32].copy_from_slice(&otadata_entry(1, 2));
    assert_eq!(active_ota_slot(&d).0, 0);
    d[0x1000..0x1020].copy_from_slice(&otadata_entry(2, 2));
    assert_eq!(active_ota_slot(&d), (1, Some(2)));
    d[..32].copy_from_slice(&otadata_entry(3, 2));
    assert_eq!(active_ota_slot(&d), (0, Some(3)));
}

#[test]
fn a_bad_crc_or_an_invalid_state_is_ignored() {
    let mut d = vec![0xffu8; OTADATA_LEN];
    d[..32].copy_from_slice(&otadata_entry(1, 2));
    let mut corrupt = otadata_entry(2, 2);
    corrupt[28] ^= 1;
    d[0x1000..0x1020].copy_from_slice(&corrupt);
    assert_eq!(active_ota_slot(&d).0, 0);
    d[0x1000..0x1020].copy_from_slice(&otadata_entry(2, 3));
    assert_eq!(active_ota_slot(&d).0, 0);
}

// --- with_otadata_reset and own builds ---------------------------------------

#[test]
fn a_lone_app_gets_a_blank_otadata() {
    let lone = vec![bundle().remove(3)];
    let (writes, added) = with_otadata_reset(lone);
    assert!(added);
    let ota = writes.iter().find(|w| w.offset == OTADATA).unwrap();
    assert_eq!(identify(&ota.data).kind(), "otadata");
    assert!(check_plan(&writes, opts()).is_empty());
}

#[test]
fn a_plan_that_carries_otadata_is_left_alone() {
    assert!(!with_otadata_reset(bundle()).1);
}

#[test]
fn an_own_build_is_placed_by_content_and_junk_is_named() {
    let files = vec![
        ("whatever.bin".to_string(), app()),
        ("table".to_string(), std::fs::read(fixture("partition-table.bin")).unwrap()),
    ];
    let p = plan_own_build(files).unwrap();
    assert_eq!(p.iter().map(|w| w.offset).collect::<Vec<_>>(), [APP, PARTITION_TABLE]);
    let err = plan_own_build(vec![("notes.txt".into(), b"hello".to_vec())]).unwrap_err();
    assert!(err.starts_with("notes.txt: not an ESP-IDF image"), "{err}");
}
