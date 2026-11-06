//! Burrow against the artefacts the Stoatworks Flasher really publishes: its
//! whole firmware bundle, and the release zips and whole-flash images its
//! export script writes. The same inputs the page's own tests run over, so the
//! two programs are checked against the same bytes.
//!
//! Ignored by default: the bundle is tens of MB and lives in another repo. Run
//! by hand when the format, or a bundled release, changes:
//!
//!     BURROW_FLASHER_FIRMWARE=<flasher>/public/firmware \
//!     BURROW_FLASHER_EXPORT=<dir of unzipped exports and .bins> \
//!     cargo test -p burrow-device --test real_artefacts -- --ignored
//!
//! `BURROW_FLASHER_EXPORT` is what `node scripts/export-release.ts --device
//! <id> --out <dir>` writes for each device: the release zip and a `.bin` per
//! variant. The zips are unpacked here with burrow-core's extractor, the one
//! the shell uses on a download.

use burrow_device::esp::files::place_files;
use burrow_device::esp::image::{identify, ImageInfo};
use burrow_device::esp::package::{
    known_devices, load_variant, merged_name, open_package_dir, read_package, validate_package, zip_name, Package,
};
use burrow_device::esp::plan::{check_plan, components, merge_parts, PlanContext};
use std::path::PathBuf;

fn dir(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| panic!("set {var}")))
}

fn devices(root: &std::path::Path) -> Vec<String> {
    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("index.json")).unwrap()).unwrap();
    assert_eq!(index["schema"], 2);
    index["devices"].as_array().unwrap().iter().map(|d| d.as_str().unwrap().to_string()).collect()
}

fn ctx(p: &Package) -> PlanContext<'_> {
    PlanContext {
        chip: p.device.chip().unwrap(),
        flash_bytes: p.device.flash_size,
        projects: Some(&p.device.projects),
        unit_table: None,
        table_offset: p.device.table_offset(),
    }
}

#[test]
#[ignore]
fn every_bundled_release_opens_loads_and_passes_the_gate() {
    let root = dir("BURROW_FLASHER_FIRMWARE");
    let ids = devices(&root);
    assert!(!ids.is_empty());
    for id in ids {
        let at = root.join(&id);
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(at.join("manifest.json")).unwrap()).unwrap();
        let read = read_package(&json, &[]);
        assert_eq!(read.errors, Vec::<String>::new(), "{id}");
        let pkg = open_package_dir(&at, &known_devices()).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(validate_package(&pkg), Vec::<String>::new());
        assert_eq!(pkg.device.id, id);
        for r in &pkg.releases {
            for v in &r.variants {
                let writes = load_variant(&at, r, v, pkg.device.table_offset())
                    .unwrap_or_else(|e| panic!("{id} {}/{}: {e}", r.id, v.id));
                assert_eq!(check_plan(&writes, &ctx(&pkg)), Vec::<String>::new(), "{id} {}/{}", r.id, v.id);
                // Merged, it is a whole-flash image that passes the same gate.
                let merged = merge_parts(&writes);
                assert_eq!(identify(&merged).kind(), "merged", "{id}");
                let w = vec![burrow_device::esp::plan::PlannedWrite::new("m", 0, merged)];
                assert_eq!(check_plan(&w, &ctx(&pkg)), Vec::<String>::new(), "{id} merged");
                // Handed over as loose files, each lands where the manifest put it.
                let loose: Vec<(String, Vec<u8>)> = writes.iter().map(|w| (w.name.clone(), w.data.clone())).collect();
                let placed = place_files(loose, None, pkg.device.table_offset());
                for (f, w) in placed.iter().zip(&writes) {
                    if !matches!(f.info, ImageInfo::Unknown { .. }) {
                        assert_eq!(f.placed, Some(w.offset), "{id} {}", w.name);
                    }
                }
            }
        }
    }
}

#[test]
#[ignore]
fn every_exported_zip_and_whole_flash_image_is_what_burrow_would_make() {
    let firmware = dir("BURROW_FLASHER_FIRMWARE");
    let export = dir("BURROW_FLASHER_EXPORT");
    let mut seen = 0;
    for id in devices(&firmware) {
        let bundled = open_package_dir(&firmware.join(&id), &known_devices()).unwrap();
        for r in &bundled.releases {
            let zip = export.join(zip_name(&bundled.device, r));
            if !zip.exists() {
                continue;
            }
            seen += 1;
            let tmp = tempfile::tempdir().unwrap();
            let unzipped = tmp.path().join("unpacked");
            burrow_core::archive::unpack_all(&zip, &unzipped).unwrap_or_else(|e| panic!("{}: {e}", zip.display()));
            let pkg = open_package_dir(&unzipped, &known_devices()).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert_eq!(pkg, Package { releases: vec![r.clone()], ..bundled.clone() }, "{id} {}", r.id);
            for v in &r.variants {
                let writes = load_variant(&unzipped, r, v, pkg.device.table_offset()).unwrap();
                let bin = std::fs::read(export.join(merged_name(&pkg.device, r, v))).unwrap();
                assert!(merge_parts(&writes) == bin, "{id} {}/{}: Burrow's merge differs from the export", r.id, v.id);
                let parts: Vec<u32> = components(&[burrow_device::esp::plan::PlannedWrite::new("m", 0, bin)], pkg.device.table_offset())
                    .iter()
                    .map(|c| c.offset)
                    .collect();
                assert!(!parts.is_empty());
            }
        }
    }
    assert!(seen > 0, "no exported release found under BURROW_FLASHER_EXPORT");
}
