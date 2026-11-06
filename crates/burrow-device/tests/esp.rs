//! The Stoatworks Flasher's `test/image.test.ts`, ported test for test, plus
//! the gates Burrow adds.
//!
//! The fixtures are real parts from three devices: CANary (ESP32-S3, OTA
//! layout), nanODE (classic ESP32, bootloader at 0x1000, OTA layout and a
//! LittleFS image) and Cuckoo (ESP32-C3, factory app, two raw data partitions
//! for its RP2354A). Each app is its first 4 KB padded back out to its real
//! length with 0xFF, so every size-based rule sees the true numbers; no test
//! reads an app past its descriptor. Bootloaders, tables and Cuckoo's data
//! images are whole.

use burrow_device::esp::chips::{self, Chip, DEFAULT_TABLE_OFFSET};
use burrow_device::esp::files::{chip_of, is_zip, loose_writes, place_files};
use burrow_device::esp::image::{
    active_ota_slot, boot_partition, describe_image, identify, otadata_entry, parse_offset, parse_partition_table,
    ImageInfo, Partition,
};
use burrow_device::esp::package::{
    github_asset, known_devices, load_variant, merged_name, open_package_dir, read_package, validate_device,
    validate_package, zip_name, Package, Release,
};
use burrow_device::esp::plan::{
    check_plan, check_table, components, merge_parts, plan_notes, replace_text, unit_problems, with_otadata_reset,
    PlanContext, PlannedWrite, UnitFacts, Want,
};
use std::path::{Path, PathBuf};

const MB: u64 = 1024 * 1024;
const MB8: u64 = 8 * MB;

fn s3() -> &'static Chip {
    chips::by_name("ESP32-S3").unwrap()
}
fn esp32() -> &'static Chip {
    chips::by_name("ESP32").unwrap()
}
fn c3() -> &'static Chip {
    chips::by_name("ESP32-C3").unwrap()
}

fn fixture(dev: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(dev).join(name)
}

fn read(dev: &str, name: &str) -> Vec<u8> {
    std::fs::read(fixture(dev, name)).unwrap()
}

fn app(dev: &str) -> Vec<u8> {
    let size: usize = std::fs::read_to_string(fixture(dev, "app-size.txt")).unwrap().trim().parse().unwrap();
    let mut a = read(dev, "app-head.bin");
    a.resize(size, 0xff);
    a
}

fn pkg(dev: &str) -> Package {
    let name = if dev == "canary" { "manifest-v2.json" } else { "manifest.json" };
    let json: serde_json::Value = serde_json::from_slice(&read(dev, name)).unwrap();
    let r = read_package(&json, &[]);
    assert_eq!(r.errors, Vec::<String>::new());
    r.pkg.unwrap()
}

/// A storage image that is not blank, the size of nanODE's real one.
fn storage() -> Vec<u8> {
    let mut s = vec![0xffu8; 4 << 20];
    s[..64].copy_from_slice(&[7u8; 64]);
    s
}

/// One device's first variant, as the plan would carry it.
fn bundle_of(dev: &str) -> Vec<PlannedWrite> {
    let p = pkg(dev);
    p.releases[0].variants[0]
        .parts
        .iter()
        .map(|part| {
            let file = Path::new(&part.path).file_name().unwrap().to_str().unwrap();
            let data = match file {
                "bootloader.bin" => read(dev, "bootloader.bin"),
                "partition-table.bin" => read(dev, "partition-table.bin"),
                "ota_data_initial.bin" => vec![0xff; 0x2000],
                "storage.bin" => storage(),
                "rp_ram.img" | "rp_fw.img" => read(dev, file),
                _ => app(dev),
            };
            PlannedWrite::new(part.name.clone(), part.offset, data)
        })
        .collect()
}

/// CANary main-ff4110d standard, as the first tests of the page use it.
fn bundle() -> Vec<PlannedWrite> {
    bundle_of("canary")
}

fn canary_projects() -> Vec<String> {
    vec!["canary".into(), "dbcanary".into()]
}

fn ctx<'a>(projects: Option<&'a [String]>) -> PlanContext<'a> {
    PlanContext { chip: s3(), flash_bytes: MB8, projects, unit_table: None, table_offset: DEFAULT_TABLE_OFFSET }
}

fn at(ws: &mut [PlannedWrite], offset: u32) -> &mut PlannedWrite {
    ws.iter_mut().find(|w| w.offset == offset).unwrap()
}

fn canary_table() -> Vec<Partition> {
    parse_partition_table(&read("canary", "partition-table.bin")).unwrap()
}

/// A partition table's bytes, as gen_esp32part.py writes them (no MD5 entry).
fn table_bytes(parts: &[Partition]) -> Vec<u8> {
    let mut b = vec![0xffu8; 0xc00];
    for (i, p) in parts.iter().enumerate() {
        let o = i * 32;
        b[o..o + 2].copy_from_slice(&0x50aau16.to_le_bytes());
        b[o + 2] = p.kind;
        b[o + 3] = p.subtype;
        b[o + 4..o + 8].copy_from_slice(&p.offset.to_le_bytes());
        b[o + 8..o + 12].copy_from_slice(&p.size.to_le_bytes());
        b[o + 12..o + 28].fill(0);
        b[o + 12..o + 12 + p.label.len()].copy_from_slice(p.label.as_bytes());
        b[o + 28..o + 32].fill(0);
    }
    b
}

/// An image header for `chip_id`; with a project, an app with its descriptor.
fn image(chip_id: u8, project: Option<&str>, size: usize) -> Vec<u8> {
    let mut b = vec![0u8; size];
    b[0] = 0xe9;
    b[12] = chip_id;
    if let Some(project) = project {
        b[32..36].copy_from_slice(&0xabcd_5432u32.to_le_bytes());
        b[32 + 16..32 + 16 + 6].copy_from_slice(b"v1.0.0");
        b[32 + 48..32 + 48 + project.len()].copy_from_slice(project.as_bytes());
    }
    b
}

fn part(label: &str, kind: u8, subtype: u8, offset: u32, size: u32) -> Partition {
    Partition { label: label.into(), kind, subtype, offset, size }
}

/// A Cuckoo-shaped layout: factory app at 0x10000, no otadata, two raw data
/// partitions.
fn factory_table() -> Vec<Partition> {
    vec![
        part("nvs", 1, 2, 0x9000, 0x6000),
        part("phy_init", 1, 1, 0xf000, 0x1000),
        part("factory", 0, 0, 0x10000, 0x1c0000),
        part("rp_ram", 1, 0x40, 0x1d0000, 0x90000),
        part("rp_fw", 1, 0x41, 0x260000, 0x100000),
    ]
}

fn joined(v: &[String]) -> String {
    v.join(",")
}

// --- the bundle -----------------------------------------------------------------------

#[test]
fn every_fixture_package_validates_and_matches_its_parts() {
    for dev in ["canary", "nanode", "cuckoo"] {
        let p = pkg(dev);
        assert_eq!(validate_package(&p), Vec::<String>::new(), "{dev}");
        let v = &p.releases[0].variants[0];
        for (file, data) in [
            ("bootloader.bin", read(dev, "bootloader.bin")),
            ("partition-table.bin", read(dev, "partition-table.bin")),
        ] {
            let part = v.parts.iter().find(|x| x.path.ends_with(file)).unwrap();
            assert_eq!(data.len() as u64, part.size, "{dev} {file}");
            assert_eq!(burrow_device::esp::package::sha256_hex(&data), part.sha256, "{dev} {file}");
        }
    }
}

#[test]
fn the_built_in_canary_definition_is_the_bundles() {
    assert_eq!(known_devices()[0], pkg("canary").device);
}

#[test]
fn every_fixture_variant_passes_the_check_the_page_runs_before_writing() {
    for dev in ["canary", "nanode", "cuckoo"] {
        let p = pkg(dev);
        let d = &p.device;
        let c = PlanContext {
            chip: d.chip().unwrap(),
            flash_bytes: d.flash_size,
            projects: Some(&d.projects),
            unit_table: None,
            table_offset: d.table_offset(),
        };
        assert_eq!(check_plan(&bundle_of(dev), &c), Vec::<String>::new(), "{dev}");
    }
}

#[test]
fn every_fixture_records_the_app_descriptor_that_is_really_in_the_image() {
    for dev in ["canary", "nanode", "cuckoo"] {
        let p = pkg(dev);
        let writes = bundle_of(dev);
        let apps: Vec<_> = components(&writes, p.device.table_offset())
            .into_iter()
            .filter_map(|c| match c.info {
                ImageInfo::App { app, .. } => Some(app),
                _ => None,
            })
            .collect();
        assert_eq!(apps.len(), 1, "{dev}");
        assert_eq!(apps[0], p.releases[0].variants[0].app, "{dev}");
    }
}

#[test]
fn rejects_a_short_commit_a_missing_bootloader_or_a_foreign_project() {
    let mut bad = pkg("canary");
    bad.releases[0].commit = "4bd1ac5".into();
    bad.releases[0].variants[0].parts.retain(|p| p.offset != 0);
    bad.releases[0].variants[1].app.project = "blinky".into();
    let e = validate_package(&bad).join("\n");
    assert!(e.contains("40-character"), "{e}");
    assert!(e.contains("no bootloader at 0x0"), "{e}");
    assert!(e.contains("app project is blinky"), "{e}");
}

#[test]
fn puts_a_classic_esp32s_bootloader_at_0x1000() {
    let mut p = pkg("canary");
    p.device.chip = "ESP32".into();
    assert!(validate_package(&p).join(",").contains("no bootloader at 0x1000"));
    // And nanODE, which is one, has its bootloader there.
    assert!(pkg("nanode").releases[0].variants[0].parts.iter().any(|x| x.offset == 0x1000));
}

#[test]
fn a_device_may_ask_for_a_standard_speed_and_no_other() {
    let mut d = pkg("nanode").device;
    assert_eq!(d.baud, Some(460_800));
    assert!(validate_device(&d).is_empty());
    d.baud = Some(1_000_000);
    assert_eq!(validate_device(&d), vec!["device nanode: baud must be a standard esptool speed".to_string()]);
}

#[test]
fn a_device_definition_is_checked_field_by_field() {
    let mut d = pkg("cuckoo").device;
    d.id = "Cuckoo".into();
    d.chip = "ESP8266".into();
    d.flash_size = 3 << 20;
    d.projects = vec![];
    d.repo = Some("not a repo".into());
    d.table_offset = Some(0x7000);
    let e = validate_device(&d).join("\n");
    for want in [
        "id must be lower-case",
        "chip must be one of ESP32, ESP32-S2",
        "flashSize must be a power of two",
        "needs the project names",
        "repo must be owner/name",
        "bad tableOffset",
    ] {
        assert!(e.contains(want), "{want}: {e}");
    }
}

#[test]
fn a_tag_must_look_like_a_version() {
    let mut p = pkg("cuckoo");
    assert_eq!(p.releases[0].tag.as_deref(), Some("v0.1.0"));
    for good in ["v1.2.3", "v0.10.0-rc.1"] {
        p.releases[0].tag = Some(good.into());
        assert!(validate_package(&p).is_empty(), "{good}");
    }
    for bad in ["1.2.3", "v1.2", "v1.2.3-", "v1.2.3+x"] {
        p.releases[0].tag = Some(bad.into());
        assert!(validate_package(&p).join(",").contains("tag must look like v1.2.3"), "{bad}");
    }
}

#[test]
fn download_names_and_links_are_the_pages() {
    let p = pkg("cuckoo");
    let (r, v) = (&p.releases[0], &p.releases[0].variants[0]);
    assert_eq!(zip_name(&p.device, r), "cuckoo-firmware-main-4300e74.zip");
    assert_eq!(merged_name(&p.device, r, v), "cuckoo-firmware-main-4300e74-bringup.bin");
    assert_eq!(
        github_asset(&p.device, r, &zip_name(&p.device, r)).as_deref(),
        Some("https://github.com/stoatworks-labs/cuckoo-firmware/releases/download/v0.1.0/cuckoo-firmware-main-4300e74.zip")
    );
    let canary = pkg("canary");
    assert_eq!(canary.releases[0].tag.as_deref(), Some("v0.2.1"));
    assert_eq!(github_asset(&canary.device, &canary.releases[1], "x"), None, "no tag, no link");
}

// --- identify ----------------------------------------------------------------------------

#[test]
fn tells_each_real_part_apart_by_content() {
    let b = bundle();
    assert_eq!(identify(&b[0].data).kind(), "bootloader");
    assert_eq!(identify(&b[3].data).kind(), "app");
    assert_eq!(identify(&b[2].data).kind(), "otadata");
    match identify(&b[1].data) {
        ImageInfo::PartitionTable { partitions } => {
            let labels: Vec<&str> = partitions.iter().map(|p| p.label.as_str()).collect();
            assert_eq!(labels, ["nvs", "otadata", "phy_init", "ota_0", "ota_1", "coredump"]);
            assert_eq!(partitions.iter().find(|p| p.label == "ota_1").unwrap().offset, 0x1f0000);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn reads_the_chip_from_both_images_of_every_device() {
    for (dev, want) in [("canary", 9u16), ("nanode", 0), ("cuckoo", 5)] {
        for b in [read(dev, "bootloader.bin"), app(dev)] {
            match identify(&b) {
                ImageInfo::App { chip_id, .. } | ImageInfo::Bootloader { chip_id } => assert_eq!(chip_id, want, "{dev}"),
                other => panic!("{dev}: {other:?}"),
            }
        }
    }
}

#[test]
fn knows_a_whole_flash_image_from_0x0_or_with_a_classic_esp32s_padding() {
    match identify(&merge_parts(&bundle())) {
        ImageInfo::Merged { chip_id, .. } => assert_eq!(chip_id, 9),
        other => panic!("{other:?}"),
    }
    let classic = merge_parts(&[
        PlannedWrite::new("bl", 0x1000, image(0, None, 0x1000)),
        PlannedWrite::new("pt", 0x8000, table_bytes(&factory_table())),
    ]);
    match identify(&classic) {
        ImageInfo::Merged { chip_id, .. } => assert_eq!(chip_id, 0),
        other => panic!("{other:?}"),
    }
    // The real nanODE and Cuckoo bundles, merged.
    for (dev, want) in [("nanode", 0u16), ("cuckoo", 5)] {
        match identify(&merge_parts(&bundle_of(dev))) {
            ImageInfo::Merged { chip_id, .. } => assert_eq!(chip_id, want, "{dev}"),
            other => panic!("{dev}: {other:?}"),
        }
    }
}

#[test]
fn does_not_mistake_a_classic_esp32_bootloader_at_0x0_for_a_whole_flash_image() {
    let wrong = merge_parts(&[
        PlannedWrite::new("bl", 0, image(0, None, 0x1000)),
        PlannedWrite::new("pt", 0x8000, table_bytes(&factory_table())),
    ]);
    assert_ne!(identify(&wrong).kind(), "merged");
}

#[test]
fn calls_random_bytes_and_an_empty_file_unknown() {
    let mut junk: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    junk[0] = 0;
    assert_eq!(identify(&junk).kind(), "unknown");
    assert_eq!(identify(&[]), ImageInfo::Unknown { reason: "the file is empty" });
}

#[test]
fn parses_a_table_it_wrote() {
    assert_eq!(parse_partition_table(&table_bytes(&factory_table())), Some(factory_table()));
}

#[test]
fn says_what_each_part_is_in_a_few_words() {
    let b = bundle();
    assert_eq!(describe_image(&identify(&b[0].data)), "bootloader · ESP32-S3");
    assert_eq!(describe_image(&identify(&b[1].data)), "nvs, otadata, phy_init, ota_0, ota_1, coredump");
    assert_eq!(describe_image(&identify(&b[2].data)), "blank otadata");
    assert_eq!(describe_image(&identify(&b[3].data)), "canary main-ff4110d · ESP32-S3");
    assert_eq!(describe_image(&identify(&merge_parts(&bundle_of("nanode")))), "whole flash · ESP32");
    assert_eq!(describe_image(&identify(&read("cuckoo", "rp_fw.img"))), "raw data");
    assert_eq!(describe_image(&identify(&image(99, None, 64))), "bootloader · chip id 99");
}

// --- check_plan refuses ------------------------------------------------------------------

#[test]
fn an_app_built_for_another_chip() {
    let mut p = bundle();
    at(&mut p, 0x20000).data[12] = 0; // chip id -> ESP32
    let cp = canary_projects();
    assert!(joined(&check_plan(&p, &ctx(Some(&cp)))).contains("built for ESP32, and this is an ESP32-S3"));
}

#[test]
fn the_right_firmware_on_the_wrong_chip() {
    let cp = canary_projects();
    let c = PlanContext { chip: c3(), ..ctx(Some(&cp)) };
    assert!(joined(&check_plan(&bundle(), &c)).contains("built for ESP32-S3, and this is an ESP32-C3"));
}

#[test]
fn an_app_from_another_project_for_a_device_and_lets_it_through_as_your_own_file() {
    let mut p = bundle();
    at(&mut p, 0x20000).data[32 + 48..32 + 48 + 8].copy_from_slice(b"blinky\0\0");
    let cp = canary_projects();
    assert!(joined(&check_plan(&p, &ctx(Some(&cp)))).contains("\"blinky\", not a build for this device"));
    assert_eq!(check_plan(&p, &ctx(None)), Vec::<String>::new());
}

#[test]
fn an_app_built_before_the_rename_as_dbcanary_is_still_a_canarys() {
    let mut p = bundle();
    at(&mut p, 0x20000).data[32 + 48..32 + 48 + 9].copy_from_slice(b"dbcanary\0");
    let cp = canary_projects();
    assert_eq!(check_plan(&p, &ctx(Some(&cp))), Vec::<String>::new());
}

#[test]
fn overlapping_writes() {
    let mut p = bundle();
    at(&mut p, 0xf000).offset = 0x8000; // onto the table
    let e = joined(&check_plan(&p, &ctx(None)));
    assert!(e.contains("overlaps") || e.contains("sector"), "{e}");
}

#[test]
fn an_app_that_is_not_at_the_start_of_an_app_partition() {
    let mut p = bundle();
    at(&mut p, 0x20000).offset = 0x400000;
    assert!(joined(&check_plan(&p, &ctx(None))).contains("0x400000 is not the start of an app partition"));
}

#[test]
fn a_lone_app_with_no_table_on_the_plan_or_the_unit() {
    let lone = vec![at(&mut bundle(), 0x20000).clone()];
    assert!(joined(&check_plan(&lone, &ctx(None))).contains("no partition table to say where an app goes"));
    let t = canary_table();
    assert_eq!(check_plan(&lone, &PlanContext { unit_table: Some(&t), ..ctx(None) }), Vec::<String>::new());
}

#[test]
fn a_bootloader_anywhere_but_its_chips_offset() {
    let mut p: Vec<PlannedWrite> = bundle().into_iter().filter(|w| w.offset != 0).collect();
    p.push(PlannedWrite::new("bl", 0x300000, bundle()[0].data.clone()));
    assert!(joined(&check_plan(&p, &ctx(None))).contains("only boots a bootloader from 0x00000"));
    let classic = vec![PlannedWrite::new("bl", 0, image(0, None, 0x1000))];
    let c = PlanContext { chip: esp32(), ..ctx(None) };
    assert!(joined(&check_plan(&classic, &c)).contains("ESP32 only boots a bootloader from 0x01000"));
    let right = vec![PlannedWrite::new("bl", 0x1000, image(0, None, 0x1000))];
    assert_eq!(check_plan(&right, &c), Vec::<String>::new());
}

#[test]
fn a_unit_with_too_little_flash() {
    let c = PlanContext { flash_bytes: 256 * 1024, ..ctx(None) };
    assert!(joined(&check_plan(&bundle(), &c)).contains("past the end of the 256 KB flash"));
}

#[test]
fn an_unaligned_offset() {
    let mut p = bundle();
    at(&mut p, 0x20000).offset = 0x20010;
    assert!(joined(&check_plan(&p, &ctx(None))).contains("sector boundary"));
}

#[test]
fn nothing_at_all_or_an_empty_file() {
    assert_eq!(check_plan(&[], &ctx(None)), vec!["nothing to write".to_string()]);
    assert_eq!(
        check_plan(&[PlannedWrite::new("e", 0x1000, vec![])], &ctx(None)),
        vec!["e: is empty".to_string()]
    );
}

#[test]
fn raw_data_nobody_placed_and_takes_it_once_an_offset_is_typed() {
    let mut junk: Vec<u8> = (0..0x1000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    junk[0] = 0;
    let t = canary_table();
    let c = PlanContext { unit_table: Some(&t), ..ctx(None) };
    let unplaced = vec![PlannedWrite::new("junk", 0x700000, junk.clone())];
    assert_eq!(
        check_plan(&unplaced, &c),
        vec!["junk: not an ESP-IDF image, partition table, otadata or whole-flash image. Give it an offset to write it as raw data".to_string()]
    );
    let typed = vec![PlannedWrite { raw: true, ..unplaced[0].clone() }];
    assert_eq!(check_plan(&typed, &c), Vec::<String>::new());
}

#[test]
fn a_whole_flash_image_anywhere_but_0x0() {
    let w = vec![PlannedWrite::new("all", 0x10000, merge_parts(&bundle()))];
    assert!(joined(&check_plan(&w, &ctx(None))).contains("only goes at 0x0"));
}

#[test]
fn a_partition_table_whose_partitions_overlap_or_run_off_the_flash() {
    let mut t = factory_table();
    t[4].size = 0x200000;
    assert!(joined(&check_table(&t, 4 * MB, DEFAULT_TABLE_OFFSET)).contains("rp_fw runs past the end of the 4 MB flash"));
    t[3].size = 0xa0000;
    assert!(joined(&check_table(&t, 4 * MB, DEFAULT_TABLE_OFFSET)).contains("rp_ram overlaps rp_fw"));
}

#[test]
fn a_table_below_itself_off_64k_or_with_no_app() {
    let t = vec![part("nvs", 1, 2, 0x8000, 0x1000), part("app", 0, 0x10, 0x18000, 0x10000)];
    let e = check_table(&t, 4 * MB, DEFAULT_TABLE_OFFSET);
    assert_eq!(
        e,
        vec![
            "nvs starts below the end of the partition table".to_string(),
            "app is an app partition not on a 64 KB boundary".to_string()
        ]
    );
    let none = vec![part("nvs", 1, 2, 0x9000, 0x1000)];
    assert_eq!(check_table(&none, 4 * MB, DEFAULT_TABLE_OFFSET), vec!["there is no app partition".to_string()]);
}

#[test]
fn a_table_or_otadata_in_the_wrong_place() {
    let mut p = bundle();
    at(&mut p, 0x8000).offset = 0x9000;
    let e = joined(&check_plan(&p, &ctx(None)));
    assert!(e.contains("the bootloader reads the partition table at 0x08000"), "{e}");
    let mut p = bundle();
    at(&mut p, 0xf000).offset = 0x11000;
    let e = joined(&check_plan(&p, &ctx(None)));
    assert!(e.contains("otadata: otadata goes at 0x0f000"), "{e}");
}

#[test]
fn otadata_on_a_layout_without_it() {
    let w = vec![
        PlannedWrite::new("pt", 0x8000, table_bytes(&factory_table())),
        PlannedWrite::new("ota", 0xd000, vec![0xff; 0x2000]),
    ];
    let c = PlanContext { chip: c3(), flash_bytes: 4 * MB, ..ctx(None) };
    assert!(joined(&check_plan(&w, &c)).contains("ota: the partition table has no otadata partition"));
}

#[test]
fn an_app_bigger_than_its_partition() {
    let t = factory_table();
    let big = vec![PlannedWrite::new("a", 0x10000, image(5, Some("cuckoo_ui"), 0x1c1000))];
    let c = PlanContext { chip: c3(), flash_bytes: 4 * MB, unit_table: Some(&t), ..ctx(None) };
    assert_eq!(check_plan(&big, &c), vec!["a: is bigger than the factory partition".to_string()]);
}

// --- check_plan takes --------------------------------------------------------------------

#[test]
fn a_whole_flash_image_of_a_release_as_the_parts_would_be() {
    let merged = vec![PlannedWrite::new("canary.bin", 0, merge_parts(&bundle()))];
    let cp = canary_projects();
    assert_eq!(check_plan(&merged, &ctx(Some(&cp))), Vec::<String>::new());
    let parts: Vec<(u32, &str)> = components(&merged, DEFAULT_TABLE_OFFSET).iter().map(|c| (c.offset, c.info.kind())).collect();
    assert_eq!(parts, [(0, "bootloader"), (0x8000, "partition-table"), (0x20000, "app")]);
    assert_eq!(components(&merged, DEFAULT_TABLE_OFFSET)[2].name, "canary.bin → ota_0");
}

#[test]
fn whole_flash_images_of_the_classic_esp32_and_c3_bundles() {
    for dev in ["nanode", "cuckoo"] {
        let p = pkg(dev);
        let d = &p.device;
        let merged = vec![PlannedWrite::new("all.bin", 0, merge_parts(&bundle_of(dev)))];
        let c = PlanContext {
            chip: d.chip().unwrap(),
            flash_bytes: d.flash_size,
            projects: Some(&d.projects),
            unit_table: None,
            table_offset: d.table_offset(),
        };
        assert_eq!(check_plan(&merged, &c), Vec::<String>::new(), "{dev}");
        let kinds: Vec<(u32, &str)> = components(&merged, d.table_offset()).iter().map(|c| (c.offset, c.info.kind())).collect();
        let want: &[(u32, &str)] = match dev {
            // otadata is blank, so it is not a piece; storage is data.
            "nanode" => &[(0x1000, "bootloader"), (0x8000, "partition-table"), (0x20000, "app"), (0x3e0000, "unknown")],
            _ => &[(0, "bootloader"), (0x8000, "partition-table"), (0x10000, "app"), (0x1d0000, "unknown"), (0x260000, "unknown")],
        };
        assert_eq!(kinds, want, "{dev}");
    }
}

#[test]
fn refuses_a_whole_flash_image_of_another_devices_firmware_for_a_device() {
    let mut p = bundle();
    at(&mut p, 0x20000).data[32 + 48..32 + 48 + 8].copy_from_slice(b"blinky\0\0");
    let cp = canary_projects();
    let w = vec![PlannedWrite::new("x.bin", 0, merge_parts(&p))];
    assert!(joined(&check_plan(&w, &ctx(Some(&cp)))).contains("\"blinky\""));
}

#[test]
fn data_images_where_they_start_a_data_partition() {
    let t = factory_table();
    let projects = vec!["cuckoo_ui".to_string()];
    let c = PlanContext { chip: c3(), flash_bytes: 4 * MB, projects: Some(&projects), unit_table: Some(&t), table_offset: DEFAULT_TABLE_OFFSET };
    let mut writes = vec![
        PlannedWrite::new("app", 0x10000, image(5, Some("cuckoo_ui"), 0x1000)),
        PlannedWrite::new("rp_ram", 0x1d0000, vec![7; 0x8000]),
        PlannedWrite::new("rp_fw", 0x260000, vec![9; 0x8000]),
    ];
    assert_eq!(check_plan(&writes, &c), Vec::<String>::new());
    writes[2].data = vec![0; 0x101000];
    let e = joined(&check_plan(&writes, &c));
    assert!(e.contains("bigger than the rp_fw partition") || e.contains("past the end"), "{e}");
}

// --- with_otadata_reset --------------------------------------------------------------------

#[test]
fn adds_a_blank_otadata_beside_a_lone_app_in_the_slot_a_blank_otadata_boots() {
    let t = canary_table();
    let lone = vec![at(&mut bundle(), 0x20000).clone()];
    let (writes, added) = with_otadata_reset(lone, Some(&t), DEFAULT_TABLE_OFFSET);
    assert!(added);
    let ota = writes.iter().find(|w| w.offset == 0xf000).unwrap();
    assert_eq!(ota.data.len(), 0x2000);
    assert_eq!(ota.name, "otadata (blank: boot ota_0)");
    assert_eq!(identify(&ota.data).kind(), "otadata");
    assert_eq!(check_plan(&writes, &PlanContext { unit_table: Some(&t), ..ctx(None) }), Vec::<String>::new());
}

#[test]
fn leaves_a_plan_alone_that_already_carries_otadata_or_a_whole_flash_image() {
    assert!(!with_otadata_reset(bundle(), None, DEFAULT_TABLE_OFFSET).1);
    let merged = vec![PlannedWrite::new("m", 0, merge_parts(&bundle()))];
    assert!(!with_otadata_reset(merged, None, DEFAULT_TABLE_OFFSET).1);
}

#[test]
fn has_nothing_to_do_on_a_factory_layout() {
    let t = factory_table();
    let w = vec![PlannedWrite::new("a", 0x10000, image(5, Some("cuckoo_ui"), 0x1000))];
    assert!(!with_otadata_reset(w, Some(&t), DEFAULT_TABLE_OFFSET).1);
}

#[test]
fn says_when_an_app_goes_to_a_slot_nothing_will_boot() {
    let t = canary_table();
    let mut a = at(&mut bundle(), 0x20000).clone();
    a.offset = 0x1f0000;
    let notes = plan_notes(&[a], &PlanContext { unit_table: Some(&t), ..ctx(None) });
    assert!(joined(&notes).contains("goes to ota_1, and nothing here tells the bootloader to start it"));
}

#[test]
fn says_when_a_new_table_moves_things_and_what_it_boots() {
    let t = canary_table();
    let w = vec![PlannedWrite::new("pt", 0x8000, table_bytes(&factory_table()))];
    let notes = plan_notes(&w, &PlanContext { unit_table: Some(&t), ..ctx(None) });
    assert_eq!(
        notes,
        vec![
            "This changes the unit's partition table. Anything in a partition that moved is lost.".to_string(),
            "Nothing is written to factory, which is what the new table boots.".to_string()
        ]
    );
    // The same table again says nothing.
    let same = vec![PlannedWrite::new("pt", 0x8000, read("canary", "partition-table.bin"))];
    assert!(plan_notes(&same, &PlanContext { unit_table: Some(&t), ..ctx(None) }).is_empty());
}

// --- loose files ------------------------------------------------------------------------------

#[test]
fn loose_files_are_placed_by_what_they_are() {
    let files: Vec<(String, Vec<u8>)> = bundle().into_iter().map(|w| (w.name, w.data)).collect();
    let placed = place_files(files, None, DEFAULT_TABLE_OFFSET);
    assert_eq!(placed.iter().map(|f| f.placed).collect::<Vec<_>>(), [Some(0), Some(0x8000), Some(0xf000), Some(0x20000)]);
    // A classic ESP32's bootloader goes to 0x1000 by its own chip id.
    let nb = place_files(vec![("b".into(), read("nanode", "bootloader.bin"))], None, DEFAULT_TABLE_OFFSET);
    assert_eq!(nb[0].placed, Some(0x1000));
    let merged = place_files(vec![("m".into(), merge_parts(&bundle_of("cuckoo")))], None, DEFAULT_TABLE_OFFSET);
    assert_eq!(merged[0].placed, Some(0));
}

#[test]
fn a_lone_app_goes_where_the_units_table_boots() {
    let t = canary_table();
    let f = factory_table();
    assert_eq!(place_files(vec![("a".into(), app("canary"))], Some(&t), DEFAULT_TABLE_OFFSET)[0].placed, Some(0x20000));
    assert_eq!(
        place_files(vec![("a".into(), image(5, Some("cuckoo_ui"), 0x1000))], Some(&f), DEFAULT_TABLE_OFFSET)[0].placed,
        Some(0x10000)
    );
    assert_eq!(place_files(vec![("a".into(), app("canary"))], None, DEFAULT_TABLE_OFFSET)[0].placed, None);
}

#[test]
fn raw_data_waits_for_an_offset_by_number_or_by_partition_name() {
    let t = factory_table();
    let mut f = place_files(vec![("fs.bin".into(), vec![1; 0x1000])], Some(&t), DEFAULT_TABLE_OFFSET);
    assert_eq!(loose_writes(&f, Some(&t)).unplaced, ["fs.bin"]);
    f[0].typed = "rp_fw".into();
    let w = &loose_writes(&f, Some(&t)).writes[0];
    assert_eq!((w.offset, w.raw), (0x260000, true));
    f[0].typed = "20000".into();
    assert_eq!(loose_writes(&f, Some(&t)).bad_typing, ["fs.bin"]);
}

#[test]
fn offsets_are_read_the_way_people_type_them() {
    let t = factory_table();
    assert_eq!(parse_offset("0x20000", None), Some(0x20000));
    assert_eq!(parse_offset("128K", None), Some(0x20000));
    assert_eq!(parse_offset("1M", None), Some(0x100000));
    assert_eq!(parse_offset(" 64 k ", None), Some(0x10000));
    assert_eq!(parse_offset("factory", Some(&t)), Some(0x10000));
    assert_eq!(parse_offset("20000", None), None);
    assert_eq!(parse_offset("", None), None);
    assert_eq!(parse_offset("0x", None), None);
    assert_eq!(parse_offset("0xfffffffff", None), None, "past u32");
    assert_eq!(parse_offset("1µ", None), None);
}

#[test]
fn the_chip_of_a_set_of_files_is_the_first_image_that_says() {
    assert_eq!(chip_of(&bundle_of("nanode")).map(|c| c.name), Some("ESP32"));
    assert_eq!(chip_of(&[PlannedWrite::new("m", 0, merge_parts(&bundle_of("cuckoo")))]).map(|c| c.name), Some("ESP32-C3"));
    assert_eq!(chip_of(&[PlannedWrite::new("d", 0, vec![1; 64])]), None);
    assert!(is_zip(b"PK\x03\x04rest") && !is_zip(&[0xe9, 0, 0, 0]));
}

// --- packages on disk -----------------------------------------------------------------------

fn lay_out() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// Lay a release out as its zip unpacks: the parts at their paths. Apps are
/// the padded fixtures, so each part's size and sha256 are recomputed here.
fn write_parts(dir: &Path, p: &mut Package, dev: &str) {
    let writes = bundle_of(dev);
    for r in &mut p.releases {
        for v in &mut r.variants {
            for part in &mut v.parts {
                let data = writes.iter().find(|w| w.offset == part.offset).unwrap().data.clone();
                part.size = data.len() as u64;
                part.sha256 = burrow_device::esp::package::sha256_hex(&data);
                let path = dir.join(&part.path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, data).unwrap();
            }
        }
    }
}

#[test]
fn a_package_directory_opens_and_its_variant_loads() {
    let mut p = pkg("cuckoo");
    p.releases[0].variants.truncate(1);
    let dir = lay_out();
    write_parts(dir.path(), &mut p, "cuckoo");
    std::fs::write(dir.path().join("manifest.json"), serde_json::to_vec(&p).unwrap()).unwrap();
    let opened = open_package_dir(dir.path(), &known_devices()).unwrap();
    assert_eq!(opened, p);
    let (r, v) = (&opened.releases[0], &opened.releases[0].variants[0]);
    let writes = load_variant(dir.path(), r, v, opened.device.table_offset()).unwrap();
    assert_eq!(writes.iter().map(|w| w.offset).collect::<Vec<_>>(), [0, 0x8000, 0x10000, 0x1d0000, 0x260000]);
}

#[test]
fn a_first_schema_canary_zip_still_opens_as_a_canarys() {
    let legacy: serde_json::Value = serde_json::from_slice(&read("canary", "manifest.json")).unwrap();
    assert!(legacy.get("schema").is_none() && legacy.get("device").is_none());
    let r = read_package(&legacy, &known_devices());
    assert_eq!(r.errors, Vec::<String>::new());
    assert_eq!(r.pkg.unwrap().device.id, "canary");
    let none = read_package(&legacy, &[]);
    assert!(none.pkg.is_none());
    assert_eq!(none.errors, ["a first-schema manifest for canary, which is no device Burrow knows"]);
}

#[test]
fn a_part_that_does_not_match_its_checksum_is_refused() {
    let mut p = pkg("cuckoo");
    let dir = lay_out();
    write_parts(dir.path(), &mut p, "cuckoo");
    std::fs::write(dir.path().join("manifest.json"), serde_json::to_vec(&p).unwrap()).unwrap();
    let victim = dir.path().join(&p.releases[0].variants[1].parts[3].path);
    let mut b = std::fs::read(&victim).unwrap();
    b[100] ^= 1;
    std::fs::write(&victim, b).unwrap();
    let e = open_package_dir(dir.path(), &known_devices()).unwrap_err();
    assert!(e.ends_with("rp_ram.img does not match its checksum"), "{e}");
}

#[test]
fn a_zip_without_a_manifest_or_with_a_bad_one() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        open_package_dir(dir.path(), &known_devices()).unwrap_err(),
        "this zip has no manifest.json, so it is not a firmware package"
    );
    std::fs::write(dir.path().join("manifest.json"), b"{not json").unwrap();
    assert_eq!(open_package_dir(dir.path(), &known_devices()).unwrap_err(), "its manifest.json is not JSON");
    let mut p = pkg("nanode");
    p.schema = 3;
    std::fs::write(dir.path().join("manifest.json"), serde_json::to_vec(&p).unwrap()).unwrap();
    assert_eq!(
        open_package_dir(dir.path(), &known_devices()).unwrap_err(),
        "its manifest is not one Burrow reads: schema is 3, Burrow reads 2"
    );
}

#[test]
fn a_part_path_that_climbs_out_is_refused_before_it_is_read() {
    let p = pkg("canary");
    let r = p.releases[0].clone();
    let mut v = r.variants[0].clone();
    v.parts[0].path = format!("{}/{}/../../../../etc/passwd", r.id, v.id);
    let err = load_variant(Path::new("/nonexistent"), &r, &v, DEFAULT_TABLE_OFFSET).unwrap_err();
    assert!(err.contains("not a plain relative path"), "{err}");
    assert!(validate_package(&Package { releases: vec![Release { variants: vec![v], ..r }], ..p })
        .join(",")
        .contains("is outside its own directory"));
}

#[test]
fn the_manifests_word_for_the_app_is_checked_against_the_app() {
    let mut p = pkg("nanode");
    let dir = lay_out();
    write_parts(dir.path(), &mut p, "nanode");
    let r = p.releases[0].clone();
    let mut v = r.variants[0].clone();
    assert!(load_variant(dir.path(), &r, &v, DEFAULT_TABLE_OFFSET).is_ok());
    v.app.version = "main-0000000".into();
    let e = load_variant(dir.path(), &r, &v, DEFAULT_TABLE_OFFSET).unwrap_err();
    assert_eq!(e, "the app in main-622a72a/standard says it is nanode main-622a72a, and the manifest says nanode main-0000000");
}

// --- the unit ---------------------------------------------------------------------------------

fn unit(chip: &str, flash: Option<u64>) -> UnitFacts {
    UnitFacts {
        chip_name: chip.into(),
        flash_bytes: flash,
        flash_label: flash.map(|f| format!("{}MB", f / MB)).unwrap_or_else(|| "unknown".into()),
        secure_boot: false,
        flash_encryption: false,
    }
}

#[test]
fn a_unit_that_is_the_right_chip_with_enough_flash_passes() {
    let w = Want { chip: Some("ESP32-S3"), min_flash: Some(MB8), name: Some("CANary") };
    assert!(unit_problems(&unit("ESP32-S3", Some(MB8)), &w).is_empty());
    assert!(unit_problems(&unit("ESP32-S3", Some(16 * MB)), &w).is_empty());
}

#[test]
fn a_unit_that_is_the_wrong_chip_too_small_or_says_nothing() {
    let w = Want { chip: Some("ESP32-S3"), min_flash: Some(MB8), name: Some("CANary") };
    assert_eq!(unit_problems(&unit("ESP32-C3", Some(MB8)), &w), ["this is an ESP32-C3, and CANary is for an ESP32-S3"]);
    assert_eq!(unit_problems(&unit("ESP32-S3", Some(4 * MB)), &w), ["this unit has 4MB of flash, and CANary needs 8MB"]);
    assert_eq!(unit_problems(&unit("ESP32-S3", None), &w), ["the unit did not say how much flash it has"]);
    assert_eq!(unit_problems(&unit("ESP8266", Some(MB8)), &Want::default()), ["this is an ESP8266, which Burrow does not flash"]);
    // Your own file asks for no chip of its own beyond what its images say.
    assert!(unit_problems(&unit("ESP32-C3", Some(4 * MB)), &Want::default()).is_empty());
}

#[test]
fn secure_boot_and_flash_encryption_are_refused() {
    let mut u = unit("ESP32-S3", Some(MB8));
    u.secure_boot = true;
    assert!(joined(&unit_problems(&u, &Want::default())).contains("secure boot is on"));
    u.secure_boot = false;
    u.flash_encryption = true;
    assert!(joined(&unit_problems(&u, &Want::default())).contains("flash encryption is on"));
}

#[test]
fn replacing_another_projects_firmware_needs_a_tick() {
    let running = |project: &str| burrow_device::esp::image::AppDescription {
        version: "1.0".into(),
        project: project.into(),
        time: String::new(),
        date: String::new(),
        idf_version: String::new(),
    };
    let cp = canary_projects();
    assert_eq!(replace_text(Some(&running("dbcanary")), &bundle(), Some(&cp)), None);
    assert_eq!(
        replace_text(Some(&running("blinky")), &bundle(), Some(&cp)).as_deref(),
        Some("This board runs blinky 1.0. Replace it with canary main-ff4110d.")
    );
    // Your own file: the file's own project is "ours".
    assert_eq!(replace_text(Some(&running("canary")), &bundle(), None), None);
    assert!(replace_text(Some(&running("cuckoo_ui")), &bundle(), None).is_some());
    // Nothing readable running, or no app in the plan: nothing to replace.
    assert_eq!(replace_text(None, &bundle(), Some(&cp)), None);
    let t = vec![PlannedWrite::new("pt", 0x8000, read("canary", "partition-table.bin"))];
    assert_eq!(replace_text(Some(&running("blinky")), &t, Some(&cp)), None);
}

// --- otadata ---------------------------------------------------------------------------------

#[test]
fn computes_the_entry_crc_the_way_the_bootloader_and_otatool_do() {
    // otatool: binascii.crc32(seq_bytes, 0xFFFFFFFF). Known values from
    // Python's zlib.crc32(struct.pack('<I', seq), 0xffffffff).
    for (seq, want) in [(1u32, 0x4743_989au32), (2, 0x55f6_3774), (7, 0x6228_c746), (0x1234_5678, 0x71d6_a731)] {
        let e = otadata_entry(seq, 2);
        assert_eq!(u32::from_le_bytes([e[28], e[29], e[30], e[31]]), want, "seq {seq}");
    }
}

#[test]
fn picks_the_valid_entry_with_the_higher_sequence() {
    let mut d = vec![0xffu8; 0x2000];
    assert_eq!(active_ota_slot(&d, 2), (0, None));
    d[..32].copy_from_slice(&otadata_entry(1, 2));
    assert_eq!(active_ota_slot(&d, 2).0, 0);
    d[0x1000..0x1020].copy_from_slice(&otadata_entry(2, 2));
    assert_eq!(active_ota_slot(&d, 2), (1, Some(2)));
    d[..32].copy_from_slice(&otadata_entry(3, 2));
    assert_eq!(active_ota_slot(&d, 2), (0, Some(3)));
    // Three slots: seq 3 is ota_2.
    assert_eq!(active_ota_slot(&d, 3), (2, Some(3)));
}

#[test]
fn ignores_an_entry_with_a_bad_crc_or_an_invalid_state() {
    let mut d = vec![0xffu8; 0x2000];
    d[..32].copy_from_slice(&otadata_entry(1, 2));
    let mut corrupt = otadata_entry(2, 2);
    corrupt[28] ^= 1;
    d[0x1000..0x1020].copy_from_slice(&corrupt);
    assert_eq!(active_ota_slot(&d, 2).0, 0);
    d[0x1000..0x1020].copy_from_slice(&otadata_entry(2, 3));
    assert_eq!(active_ota_slot(&d, 2).0, 0);
}

#[test]
fn the_boot_partition_is_factory_then_ota_0_then_the_first_app() {
    assert_eq!(boot_partition(&factory_table()).unwrap().label, "factory");
    assert_eq!(boot_partition(&canary_table()).unwrap().label, "ota_0");
    let odd = vec![part("a", 0, 0x20, 0x10000, 0x10000), part("b", 0, 0x11, 0x20000, 0x10000)];
    assert_eq!(boot_partition(&odd).unwrap().label, "a");
}
