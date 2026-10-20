//! The PLAY half, without a PLAY.
//!
//! A factory image is put together in memory (RKFW → RKAF → parameter.txt and
//! partitions, with a real ext2 rootfs made by mke2fs), restored into a disk
//! that is only a Vec, and read back: the GPT parses, every partition lands at
//! its sector, the package sits in the rootfs tail, and the injected files are
//! there for anyone who mounts the filesystem. Where e2fsprogs is installed,
//! `e2fsck -fn` has the last word on the filesystem.

use burrow_device::play::ext2::Ext2;
use burrow_device::play::fw::{self, Tar};
use burrow_device::play::gpt;
use burrow_device::play::inject;
use burrow_device::play::kit::{self, Kit, Options};
use burrow_device::play::plan::{self, Assignment, BlockDevice};
use burrow_device::play::rkfw::{self, parse_parameter};
use burrow_device::play::source::{MemSource, Source};
use burrow_device::play::usb::maskrom_requests;
use flate2::read::GzDecoder;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const SECTOR: usize = 512;
const NOW: u32 = 1_760_000_000;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/play").join(name)
}

fn rootfs() -> Vec<u8> {
    let gz = std::fs::read(fixture("rootfs.ext2.gz")).unwrap();
    let mut out = Vec::new();
    GzDecoder::new(&gz[..]).read_to_end(&mut out).unwrap();
    out
}

/// A counter, standing in for the OS RNG so a GPT can be built twice the same.
fn counter() -> impl FnMut(&mut [u8]) {
    let mut n: u8 = 0;
    move |b: &mut [u8]| {
        for x in b {
            n = n.wrapping_add(37);
            *x = n;
        }
    }
}

struct Disk(Vec<u8>);

impl BlockDevice for Disk {
    fn read_lba(&mut self, sector: u64, count: u64) -> Result<Vec<u8>, String> {
        let s = sector as usize * SECTOR;
        Ok(self.0[s..s + count as usize * SECTOR].to_vec())
    }
    fn write_lba(&mut self, sector: u64, bytes: &[u8]) -> Result<(), String> {
        assert_eq!(bytes.len() % SECTOR, 0, "a write that is not whole sectors");
        let s = sector as usize * SECTOR;
        self.0[s..s + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
}

/// A disk that reads 0xCC above a sector, as a PLAY does above 0x10000.
struct Fill(Disk, u64);

impl BlockDevice for Fill {
    fn read_lba(&mut self, sector: u64, count: u64) -> Result<Vec<u8>, String> {
        if sector >= self.1 {
            return Ok(vec![0xcc; count as usize * SECTOR]);
        }
        self.0.read_lba(sector, count)
    }
    fn write_lba(&mut self, sector: u64, bytes: &[u8]) -> Result<(), String> {
        self.0.write_lba(sector, bytes)
    }
}

fn loader() -> Vec<u8> {
    // A minimal RKBOOT: header, one 471 entry, one 472 entry.
    let mut b = vec![0u8; 0x66];
    b[0..4].copy_from_slice(b"BOOT");
    b[0x04..0x06].copy_from_slice(&0x66u16.to_le_bytes());
    b[0x15..0x19].copy_from_slice(b"H223");
    let entries_at = 0x66usize;
    b[0x19] = 1;
    b[0x1a..0x1e].copy_from_slice(&(entries_at as u32).to_le_bytes());
    b[0x1e] = 57;
    b[0x1f] = 1;
    b[0x20..0x24].copy_from_slice(&((entries_at + 57) as u32).to_le_bytes());
    b[0x24] = 57;
    b.resize(entries_at + 2 * 57, 0);
    let data_at = b.len();
    let ddr = vec![0x47u8; 4094]; // the length that needs the trailing pending byte
    let usbplug = vec![0x72u8; 5000];
    for (i, (kind, len, off, delay)) in [(1u32, ddr.len(), data_at, 1u32), (2, usbplug.len(), data_at + ddr.len(), 0)].iter().enumerate() {
        let o = entries_at + i * 57;
        b[o + 1..o + 5].copy_from_slice(&kind.to_le_bytes());
        for (j, c) in "rk3328_ddr".encode_utf16().enumerate() {
            b[o + 5 + j * 2..o + 7 + j * 2].copy_from_slice(&c.to_le_bytes());
        }
        b[o + 45..o + 49].copy_from_slice(&(*off as u32).to_le_bytes());
        b[o + 49..o + 53].copy_from_slice(&(*len as u32).to_le_bytes());
        b[o + 53..o + 57].copy_from_slice(&delay.to_le_bytes());
    }
    b.extend_from_slice(&ddr);
    b.extend_from_slice(&usbplug);
    b
}

const PARAMETER: &str = "FIRMWARE_VER: 1.0\nMACHINE_MODEL: PLAY\nTYPE: GPT\n\
CMDLINE: mtdparts=rk29xxnand:0x00002000@0x00004000(uboot),0x00002000@0x00006000(trust),0x00010000@0x00008000(boot),0x00004000@0x00018000(rootfs),-@0x0001c000(userdata:grow)\n\
uuid:rootfs=614e0000-0000-4b53-8000-1d28000054a9\n";

/// An RKFW image: header, loader, RKAF with parameter, uboot, boot, rootfs and
/// a metadata entry that must never be written.
fn image() -> Vec<u8> {
    let parts: Vec<(&str, Vec<u8>, u32)> = vec![
        ("parameter", PARAMETER.as_bytes().to_vec(), 0),
        ("uboot", vec![0x11; 3000], 0x4000),
        ("boot", vec![0x22; 70_000], 0x8000),
        ("rootfs", rootfs(), 0x18000),
        ("package-file", b"package-file stuff".to_vec(), 0xffff_ffff),
    ];
    let ldr = loader();
    let mut af = vec![0u8; 0x2000];
    af[0..4].copy_from_slice(b"RKAF");
    af[0x08..0x0c].copy_from_slice(b"PLAY");
    af[0x88..0x8c].copy_from_slice(&(parts.len() as i32).to_le_bytes());
    let mut pos = af.len();
    let mut data = Vec::new();
    for (i, (name, bytes, flash)) in parts.iter().enumerate() {
        let o = 0x8c + i * 112;
        af[o..o + name.len()].copy_from_slice(name.as_bytes());
        af[o + 32..o + 32 + name.len()].copy_from_slice(name.as_bytes());
        af[o + 96..o + 100].copy_from_slice(&(pos as u32).to_le_bytes());
        af[o + 100..o + 104].copy_from_slice(&flash.to_le_bytes());
        af[o + 108..o + 112].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
        data.extend_from_slice(bytes);
        pos += bytes.len();
    }
    af.extend_from_slice(&data);

    let mut img = vec![0u8; 0x66];
    img[0..4].copy_from_slice(b"RKFW");
    img[0x15..0x19].copy_from_slice(b"RK33");
    let loader_at = 0x66u32;
    img[0x19..0x1d].copy_from_slice(&loader_at.to_le_bytes());
    img[0x1d..0x21].copy_from_slice(&(ldr.len() as u32).to_le_bytes());
    let af_at = loader_at + ldr.len() as u32;
    img[0x21..0x25].copy_from_slice(&af_at.to_le_bytes());
    img[0x25..0x29].copy_from_slice(&(af.len() as u32).to_le_bytes());
    img.extend_from_slice(&ldr);
    img.extend_from_slice(&af);
    img
}

const DISK_SECTORS: u64 = 0x30000;

fn e2fsck() -> Option<PathBuf> {
    ["/opt/homebrew/opt/e2fsprogs/sbin/e2fsck", "/usr/local/opt/e2fsprogs/sbin/e2fsck", "/sbin/e2fsck", "/usr/sbin/e2fsck"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

// --- the image and its partition table ---------------------------------------

#[test]
fn the_image_parses_and_metadata_is_not_flashed() {
    let fw = rkfw::parse(Arc::new(MemSource(image()))).unwrap();
    let names: Vec<&str> = fw.partitions.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["parameter", "uboot", "boot", "rootfs", "package-file"]);
    assert!(!fw.partition("package-file").unwrap().flashed);
    assert_eq!(fw.loader().unwrap(), loader());
}

#[test]
fn parameter_txt_gives_sizes_and_the_growing_partition() {
    let p = parse_parameter(PARAMETER);
    assert_eq!(p.kind.as_deref(), Some("GPT"));
    let rootfs = p.partitions.iter().find(|x| x.name == "rootfs").unwrap();
    assert_eq!((rootfs.start_sector, rootfs.sectors, rootfs.grow), (0x18000, Some(0x4000), false));
    let userdata = p.partitions.last().unwrap();
    assert_eq!((userdata.name.as_str(), userdata.sectors, userdata.grow), ("userdata", None, true));
}

#[test]
fn a_built_gpt_reads_back_and_honours_the_uuid_lines() {
    let p = parse_parameter(PARAMETER);
    let uuids = gpt::parse_uuid_lines(PARAMETER);
    let mut rng = counter();
    let g = gpt::build(&p.partitions, DISK_SECTORS, &uuids, &mut rng).unwrap();
    let parts = gpt::parse(&g.master).unwrap();
    assert_eq!(parts.len(), 5);
    let userdata = parts.iter().find(|x| x.name == "userdata").unwrap();
    assert_eq!(userdata.last_lba, DISK_SECTORS - 34, "a :grow partition ends at the last usable sector");
    // The rootfs unique guid is the one parameter.txt gave, stored mixed-endian.
    let entry = 2 * SECTOR + 3 * 128;
    assert_eq!(&g.master[entry + 16..entry + 32], &gpt::parse_uuid("614e0000-0000-4b53-8000-1d28000054a9").unwrap());
    assert_eq!(g.master[entry + 16..entry + 20], [0x00, 0x00, 0x4e, 0x61]);
    // Same randomness, same table.
    let mut rng2 = counter();
    assert_eq!(gpt::build(&p.partitions, DISK_SECTORS, &uuids, &mut rng2).unwrap().master, g.master);
}

#[test]
fn a_gpt_whose_header_checksum_is_wrong_is_not_believed() {
    let p = parse_parameter(PARAMETER);
    let mut rng = counter();
    let mut g = gpt::build(&p.partitions, DISK_SECTORS, &Default::default(), &mut rng).unwrap();
    g.master[SECTOR + 40] ^= 1;
    assert!(gpt::parse(&g.master).unwrap_err().contains("checksum"));
}

// --- a whole restore into a fake disk ----------------------------------------

fn restore(package: Option<Vec<u8>>) -> (Disk, plan::Plan) {
    let fw = rkfw::parse(Arc::new(MemSource(image()))).unwrap();
    let pkg = package.map(|p| Arc::new(MemSource(p)) as Arc<dyn Source>);
    let mut rng = counter();
    let plan = plan::build_full(&fw, DISK_SECTORS, pkg, &mut rng, NOW).unwrap();
    let mut disk = Disk(vec![0u8; DISK_SECTORS as usize * SECTOR]);
    let mut last = 0;
    let written = plan::run(&mut disk, &plan, &mut |p| last = p.done_sectors).unwrap();
    assert_eq!(written, plan.total_sectors);
    assert_eq!(last, plan.total_sectors);
    (disk, plan)
}

#[test]
fn a_restore_puts_every_partition_at_its_sector_and_never_writes_metadata() {
    let (mut disk, plan) = restore(None);
    let names: Vec<&str> = plan.ops.iter().map(|o| o.name.as_str()).collect();
    assert_eq!(names, ["gpt", "gpt-backup", "uboot", "boot", "rootfs"], "parameter and package-file are not written");
    let parts = gpt::parse(&disk.read_lba(0, 34).unwrap()).unwrap();
    assert_eq!(parts.iter().find(|p| p.name == "boot").unwrap().first_lba, 0x8000);
    let boot = disk.read_lba(0x8000, 70_000u64.div_ceil(512)).unwrap();
    assert!(boot[..70_000].iter().all(|&b| b == 0x22));
    assert!(boot[70_000..].iter().all(|&b| b == 0), "the tail of the last sector is zero-padded");
    let rootfs_image = rootfs();
    let on_disk = disk.read_lba(0x18000, (rootfs_image.len() / SECTOR) as u64).unwrap();
    assert_eq!(on_disk, rootfs_image, "no package, so rootfs goes on untouched");
    let v = plan::verify(&mut disk, &plan, None, &mut |_| {}).unwrap();
    assert!(v.mismatches.is_empty() && v.unverified.is_empty(), "{v:?}");
}

#[test]
fn a_package_is_injected_into_the_rootfs_tail_and_the_filesystem_stays_sound() {
    let package = fw::gzip(b"pretend this is a package");
    let (mut disk, plan) = restore(Some(package.clone()));
    assert!(plan.injected);
    let pkg_op = plan.ops.iter().find(|o| o.name == "package").unwrap();
    // 4096 1 KiB blocks = 8192 sectors, rounded up to the 2048-sector alignment.
    assert_eq!(pkg_op.start_sector, 0x18000 + 8192);
    let back = disk.read_lba(pkg_op.start_sector, 1).unwrap();
    assert_eq!(&back[..package.len()], &package[..]);

    // Mount it, as it were, with our own reader...
    let fs_bytes = disk.read_lba(0x18000, 8192).unwrap();
    let fs = Ext2::open(Arc::new(MemSource(fs_bytes.clone())), NOW).unwrap();
    let script = fs.read_file(&fs.resolve("/usr/local/bin/bd-inject.sh").unwrap()).unwrap();
    assert_eq!(String::from_utf8(script).unwrap(), inject::inject_script(8192, package.len() as u64));
    let unit = fs.read_file(&fs.resolve("/etc/systemd/system/BirdDogInject.service").unwrap()).unwrap();
    assert_eq!(String::from_utf8(unit).unwrap(), inject::inject_unit());
    let link = fs.resolve("/etc/systemd/system/multi-user.target.wants/BirdDogInject.service").unwrap();
    assert_eq!(fs.read_file(&link).unwrap(), b"/etc/systemd/system/BirdDogInject.service");
    let wants = fs.resolve("/etc/systemd/system/multi-user.target.wants").unwrap();
    assert_eq!(wants.flags & 0x1000, 0, "the htree index flag is dropped on the directory written to");

    // ...and with e2fsck's, where it is installed.
    match e2fsck() {
        Some(bin) => {
            let dir = tempfile::tempdir().unwrap();
            let img = dir.path().join("rootfs.ext2");
            std::fs::write(&img, &fs_bytes).unwrap();
            let out = std::process::Command::new(bin).arg("-fn").arg(&img).output().unwrap();
            assert!(
                out.status.success(),
                "e2fsck found problems:\n{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        None => eprintln!("e2fsck not installed: the filesystem was checked with Burrow's own reader only"),
    }
    let v = plan::verify(&mut disk, &plan, None, &mut |_| {}).unwrap();
    assert!(v.mismatches.is_empty(), "{v:?}");
}

#[test]
fn a_package_too_big_for_the_gap_is_refused_before_anything_is_written() {
    let fw = rkfw::parse(Arc::new(MemSource(image()))).unwrap();
    // rootfs is 0x4000 sectors; the filesystem takes 8192; 8192 are spare.
    let big: Arc<dyn Source> = Arc::new(MemSource(vec![0x1f; 8193 * 512]));
    let mut rng = counter();
    let err = plan::build_full(&fw, DISK_SECTORS, Some(big), &mut rng, NOW).err().unwrap();
    assert!(err.contains("only 8192 are free"), "{err}");
}

#[test]
fn verification_above_the_read_ceiling_is_unverified_not_failed() {
    let (disk, plan) = restore(None);
    let mut dev = Fill(disk, 0x10000);
    assert_eq!(plan::find_read_ceiling(&mut dev, &[0x4000, 0x6000, 0x18000]), Some(0x18000));
    let v = plan::verify(&mut dev, &plan, Some(0x10000), &mut |_| {}).unwrap();
    assert!(v.mismatches.is_empty(), "{v:?}");
    assert!(v.unverified.iter().any(|u| u.starts_with("rootfs")), "{v:?}");
    // Without the ceiling the same device "fails", which is the 57,702
    // mismatches the browser flasher once reported for a good write.
    let v = plan::verify(&mut dev, &plan, None, &mut |_| {}).unwrap();
    assert!(!v.mismatches.is_empty());
}

// --- partition writes -----------------------------------------------------------

#[test]
fn partition_writes_are_aimed_by_the_device_gpt_and_protect_the_way_back() {
    let (mut disk, _) = restore(None);
    let parts = gpt::parse(&disk.read_lba(0, 34).unwrap()).unwrap();
    let new_boot: Arc<dyn Source> = Arc::new(MemSource(vec![0x33; 4096]));
    let p = plan::build_partitions(
        &parts,
        vec![Assignment { partition: "boot".into(), label: "boot.img".into(), source: new_boot.clone() }],
        false,
    )
    .unwrap();
    plan::run(&mut disk, &p, &mut |_| {}).unwrap();
    assert!(disk.read_lba(0x8000, 8).unwrap().iter().all(|&b| b == 0x33));

    let refuse = |name: &str, allow: bool| {
        plan::build_partitions(
            &parts,
            vec![Assignment { partition: name.into(), label: "x".into(), source: new_boot.clone() }],
            allow,
        )
        .err()
    };
    assert!(refuse("uboot", false).unwrap().contains("part of how this device is recovered"));
    assert!(refuse("uboot", true).is_none());
    assert!(refuse("nonesuch", false).unwrap().contains("It has: uboot, trust, boot, rootfs, userdata"));
    let huge: Arc<dyn Source> = Arc::new(MemSource(vec![0; 0x2001 * 512]));
    let err = plan::build_partitions(&parts, vec![Assignment { partition: "trust".into(), label: "t".into(), source: huge }], false)
        .err()
        .unwrap();
    assert!(err.contains("trust") && err.contains("part of how"), "protected is checked first: {err}");
}

// --- the maskrom push ---------------------------------------------------------------

#[test]
fn the_loader_goes_471_then_472_with_at_least_200ms_between() {
    let r = maskrom_requests(&loader()).unwrap();
    assert_eq!(r.iter().map(|x| x.0).collect::<Vec<_>>(), [0x0471, 0x0472]);
    assert_eq!(r[0].1.len(), 4094);
    assert!(r.iter().all(|x| x.2 >= 200));
}

#[test]
fn a_loader_with_the_wrong_entry_stride_is_refused() {
    let mut l = loader();
    l[0x1e] = 56;
    assert!(burrow_device::play::rkboot::parse(&l).unwrap_err().contains("stride"));
}

// --- packages -------------------------------------------------------------------------

#[test]
fn the_tar_header_checksum_is_ustar_s() {
    let h = fw::tar_header("./update", 1234, 0o755, b'0').unwrap();
    let mut sum: u32 = h.iter().map(|&b| b as u32).sum();
    // The stored checksum counts its own field as spaces.
    sum = sum - h[148..156].iter().map(|&b| b as u32).sum::<u32>() + 8 * 32;
    let stored = u32::from_str_radix(std::str::from_utf8(&h[148..154]).unwrap(), 8).unwrap();
    assert_eq!(stored, sum);
    assert_eq!(&h[257..263], b"ustar\0");
}

#[test]
fn a_tar_reads_back_as_written_and_python_agrees() {
    let mut t = Tar::new();
    t.file("./update", b"#!/bin/sh\necho ok\n", 0o755).unwrap();
    t.file("./userdata/bd-play/bdplay", &[0x7f, b'E', b'L', b'F'], 0o755).unwrap();
    let tar = t.finish();
    let e = fw::tar_entries(&tar).unwrap();
    let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, ["./update", "./userdata/", "./userdata/bd-play/", "./userdata/bd-play/bdplay"]);
    assert_eq!(e[0].mode, 0o755);
    if let Ok(out) = std::process::Command::new("python3")
        .args(["-c", "import sys,tarfile; t=tarfile.open(sys.argv[1]); print(' '.join(f'{m.name}:{m.mode:o}:{m.uid}' for m in t))"])
        .arg({
            let dir = tempfile::tempdir().unwrap().keep();
            let p = dir.join("t.tar");
            std::fs::write(&p, &tar).unwrap();
            p
        })
        .output()
    {
        if out.status.success() {
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim(),
                "./update:755:0 ./userdata:755:0 ./userdata/bd-play:755:0 ./userdata/bd-play/bdplay:755:0"
            );
        }
    }
}

#[test]
fn the_same_inputs_give_the_same_fw() {
    assert_eq!(fw::gzip(b"same"), fw::gzip(b"same"));
}

fn module_tgz(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut t = Tar::new();
    for (p, d, m) in files {
        t.file(p, d, *m).unwrap();
    }
    fw::gzip(&t.finish())
}

fn reserved() -> Vec<String> {
    fw::RESERVED_MODULE_NAMES.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_module_is_read_and_a_wrapping_directory_stripped() {
    let tgz = module_tgz(&[
        ("hello/module.conf", b"NAME=hello\nVERSION=\"1.2\"\nDESCRIPTION=says hi\n", 0o644),
        ("hello/install", b"#!/bin/sh\n", 0o644),
        ("hello/payload/run.sh", b"#!/bin/sh\n", 0o755),
        ("hello/._install", b"apple double", 0o644),
    ]);
    let m = fw::read_module(&tgz, "hello.tgz", &reserved(), fw::MODULE_MAX_BYTES).unwrap();
    assert_eq!((m.name.as_str(), m.version.as_str(), m.description.as_str()), ("hello", "1.2", "says hi"));
    let files: Vec<(&str, u32)> = m.files.iter().map(|f| (f.path.as_str(), f.mode)).collect();
    assert_eq!(files, [("install", 0o755), ("module.conf", 0o644), ("payload/run.sh", 0o755)]);
}

#[test]
fn a_module_that_breaks_the_contract_is_refused_with_a_reason() {
    let r = |files: &[(&str, &[u8], u32)]| fw::read_module(&module_tgz(files), "m", &reserved(), fw::MODULE_MAX_BYTES).unwrap_err();
    assert!(r(&[("module.conf", b"NAME=x\nVERSION=1\n", 0o644)]).contains("no install script"));
    assert!(r(&[("module.conf", b"NAME=kvm\nVERSION=1\n", 0o644), ("install", b"x", 0o755)]).contains("collides"));
    assert!(r(&[("module.conf", b"NAME=Bad\nVERSION=1\n", 0o644), ("install", b"x", 0o755)]).contains("NAME=\"Bad\""));
    assert!(r(&[("module.conf", b"NAME=x\nVERSION=1\n", 0o644), ("install", b"x", 0o755), ("../evil", b"x", 0o644)]).contains("escapes"));
    let x86 = [0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x3e, 0, 1, 0];
    assert!(r(&[("module.conf", b"NAME=x\nVERSION=1\n", 0o644), ("install", b"x", 0o755), ("bin", &x86, 0o755)]).contains("not aarch64"));
    let long = format!("{}/f", "d".repeat(90));
    assert!(r(&[("module.conf", b"NAME=x\nVERSION=1\n", 0o644), ("install", b"x", 0o755), (&long, b"x", 0o644)]).contains("path too long"));

    // A symlink member, made by hand because Tar never writes one.
    let mut tar = Vec::new();
    tar.extend_from_slice(&fw::tar_header("module.conf", 18, 0o644, b'0').unwrap());
    let mut conf = b"NAME=x\nVERSION=1\n\n".to_vec();
    conf.resize(512, 0);
    tar.extend_from_slice(&conf);
    tar.extend_from_slice(&fw::tar_header("link", 0, 0o777, b'2').unwrap());
    tar.extend_from_slice(&[0u8; 1024]);
    assert!(fw::read_module(&tar, "m", &reserved(), fw::MODULE_MAX_BYTES).unwrap_err().contains("symlink"));

    let zip = b"PK\x03\x04rest";
    assert!(fw::read_module(zip, "m.zip", &reserved(), fw::MODULE_MAX_BYTES).unwrap_err().contains("zip file"));
}

#[test]
fn a_gzip_bomb_is_stopped_at_the_ceiling() {
    let bomb = fw::gzip(&vec![0u8; 4 * 1024 * 1024]);
    let err = fw::read_module(&bomb, "bomb", &reserved(), 1024 * 1024).unwrap_err();
    assert!(err.contains("refusing to read further"), "{err}");
}

#[test]
fn only_a_one_line_public_key_is_accepted() {
    assert_eq!(fw::validate_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop"), None);
    assert_eq!(fw::validate_key("ecdsa-sha2-nistp256 AAAAE2VjZHNh=="), None);
    assert!(fw::validate_key("-----BEGIN OPENSSH PRIVATE KEY-----").unwrap().contains("PRIVATE"));
    assert!(fw::validate_key("ssh-ed25519 AAAA\nssh-rsa BBBB").unwrap().contains("more than one line"));
    assert!(fw::validate_key("ssh-dss AAAAB3").is_some());
    assert!(fw::validate_key("").is_some());
}

// --- a package from a kit --------------------------------------------------------------

fn arm64(tag: u8) -> Vec<u8> {
    let mut e = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0xb7, 0];
    e.extend(std::iter::repeat_n(tag, 64));
    e
}

fn fake_kit() -> (tempfile::TempDir, Kit) {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    let files: Vec<(&str, &str, Vec<u8>)> = vec![
        ("update", "update", b"#!/bin/sh\n# the installer\n".to_vec()),
        ("probe", "probe.sh", b"#!/bin/sh\n# probe\n".to_vec()),
        ("kvmRun", "kvm-run.sh", b"#!/bin/sh\n# kvm\n".to_vec()),
        ("bdkvm", "bdkvm-linux-arm64", arm64(1)),
        ("bdts", "bdts-linux-arm64", arm64(2)),
        ("bdplay", "bdplay-linux-arm64", arm64(3)),
        ("exfat", "mount.exfat-fuse", arm64(4)),
    ];
    let mut manifest = serde_json::Map::new();
    manifest.insert("generated".into(), "2026-10-20T00:00:00Z".into());
    for (key, file, data) in &files {
        std::fs::write(assets.join(file), data).unwrap();
        manifest.insert((*key).into(), serde_json::json!({ "size": data.len(), "sha256": fw::sha256_hex(data) }));
    }
    for absent in ["bdcam", "bdgw", "bdpdf", "pdfium"] {
        manifest.insert(absent.into(), serde_json::Value::Null);
    }
    manifest.insert("rootfsOverlay".into(), serde_json::json!([]));
    std::fs::write(assets.join("manifest.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
    std::fs::write(
        dir.path().join("kit.json"),
        serde_json::json!({
            "kit": 1, "version": "0.3.0", "commit": "0".repeat(40),
            "mediamtx": { "version": "v1.21.0", "file": "mediamtx_v1.21.0_linux_arm64.tar.gz",
                          "base": "https://github.com/bluenviron/mediamtx/releases/download/", "checksums": "checksums.sha256" },
            "tailscale": { "index": "https://pkgs.tailscale.com/stable/?mode=json", "base": "https://pkgs.tailscale.com/stable/", "arch": "arm64" },
            "reservedModuleNames": fw::RESERVED_MODULE_NAMES,
            "moduleMaxBytes": fw::MODULE_MAX_BYTES
        })
        .to_string(),
    )
    .unwrap();
    let kit = Kit::load(dir.path()).unwrap();
    (dir, kit)
}

fn tailscale_tgz() -> Vec<u8> {
    let mut t = Tar::new();
    t.file("tailscale_1.90.0_arm64/tailscaled", &arm64(9), 0o755).unwrap();
    t.file("tailscale_1.90.0_arm64/tailscale", &arm64(8), 0o755).unwrap();
    t.file("tailscale_1.90.0_arm64/systemd/tailscaled.service", b"[Unit]", 0o644).unwrap();
    fw::gzip(&t.finish())
}

#[test]
fn a_package_is_packed_member_for_member_as_the_page_packs_it() {
    let (_dir, kit) = fake_kit();
    let o = Options {
        ssh_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop".into(),
        tag: "show night!".into(),
        tailscale: true,
        kvm: true,
        play: true,
        reboot: true,
        ..Default::default()
    };
    let module = fw::read_module(
        &module_tgz(&[("module.conf", b"NAME=hello\nVERSION=1\n", 0o644), ("install", b"#!/bin/sh\n", 0o755)]),
        "hello",
        &kit.reserved(),
        kit.module_max_bytes(),
    )
    .unwrap();
    let fetched = kit::Fetched { tailscale_tgz: Some(tailscale_tgz()), mediamtx_tgz: None };
    let built = kit::build(&kit, &o, fetched, &[module]).unwrap();
    assert_eq!(built.name, "BirdDog_PLAY-custom-show-night-.fw");
    let tar = fw::gunzip_bounded(&built.fw, 64 << 20).unwrap();
    assert_eq!(fw::sha256_hex(&tar), built.tar_sha256);
    let members: Vec<(String, u32)> = fw::tar_entries(&tar).unwrap().into_iter().map(|e| (e.name, e.mode)).collect();
    let want: Vec<(&str, u32)> = vec![
        ("./update", 0o755),
        ("./probe.sh", 0o755),
        ("./authorized_keys", 0o600),
        ("./build.conf", 0o644),
        ("./userdata/", 0o755),
        ("./userdata/tailscale/", 0o755),
        ("./userdata/tailscale/tailscaled", 0o755),
        ("./userdata/tailscale/tailscale", 0o755),
        ("./userdata/bd-tailscale-ui/", 0o755),
        ("./userdata/bd-tailscale-ui/bdts", 0o755),
        ("./userdata/birddog-kvm/", 0o755),
        ("./userdata/birddog-kvm/bdkvm", 0o755),
        ("./userdata/birddog-kvm/run.sh", 0o755),
        ("./userdata/bd-play/", 0o755),
        ("./userdata/bd-play/bdplay", 0o755),
        ("./userdata/bd-play/mount.exfat-fuse", 0o755),
        ("./modules/", 0o755),
        ("./modules/hello/", 0o755),
        ("./modules/hello/install", 0o755),
        ("./modules/hello/module.conf", 0o644),
    ];
    assert_eq!(members, want.iter().map(|(n, m)| (n.to_string(), *m)).collect::<Vec<_>>());
    let conf = fw::tar_entries(&tar).unwrap().into_iter().find(|e| e.name == "./build.conf").unwrap();
    assert_eq!(
        String::from_utf8(conf.data).unwrap(),
        "BUILD_TAG=show-night-\nWITH_TAILSCALE=1\nWITH_TAILSCALE_UI=1\nWITH_KVM=1\nWITH_PLAY=1\nWITH_CAM=0\nWITH_CAM_UI=0\nWITH_GATEWAY=0\nWITH_GATEWAY_UI=0\nWITH_MODULES=1\nDO_REBOOT=1\n"
    );
}

#[test]
fn a_kit_asset_that_does_not_match_its_manifest_stops_the_build() {
    let (dir, kit) = fake_kit();
    std::fs::write(dir.path().join("assets/bdkvm-linux-arm64"), arm64(7)).unwrap();
    let o = Options { ssh_key: "ssh-ed25519 AAAAC3Nz".into(), kvm: true, ..Default::default() };
    let err = kit::build(&kit, &o, kit::Fetched::default(), &[]).err().unwrap();
    assert!(err.contains("bdkvm-linux-arm64: SHA-256 does not match"), "{err}");
    let o = Options { ssh_key: "ssh-ed25519 AAAAC3Nz".into(), gateway: true, ..Default::default() };
    assert!(kit::build(&kit, &o, kit::Fetched::default(), &[]).err().unwrap().contains("no streaming gateway"));
}

#[test]
fn a_tailscale_tarball_for_another_architecture_is_refused() {
    let mut t = Tar::new();
    let mut x86 = arm64(1);
    x86[18] = 0x3e;
    t.file("tailscale_1.90.0_amd64/tailscaled", &x86, 0o755).unwrap();
    t.file("tailscale_1.90.0_amd64/tailscale", &x86, 0o755).unwrap();
    assert!(fw::extract_tailscale(&fw::gzip(&t.finish())).unwrap_err().contains("wrong architecture"));
}
