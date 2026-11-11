//! What a PLAY write is: an ordered list of sector writes, built from a factory
//! image (plus an optional package) or from partition files, and run against
//! anything that can read and write sectors.
//!
//! A port of the browser flasher's `plan.js` and `partwrite.js`. Nothing holds
//! more than a few MB: partition contents stay in their `Source` until they are
//! sent, and filesystem changes ride along as patches applied to each chunk in
//! flight.

use super::ext2::Patch;
use super::gpt::{self, DevicePartition, Rng, SECTOR_SIZE};
use super::inject;
use super::rkfw::{parse_parameter, Parameter, Rkfw};
use super::source::{MemSource, Source};
use serde::Serialize;
use std::sync::Arc;

/// rkdeveloptool's DEFAULT_RW_LBA: 64 KiB per command.
pub const SECTORS_PER_TRANSFER: u64 = 128;
const READ_AHEAD: u64 = 4 << 20;

/// Partitions a partition write will not touch unless told to. `uboot`, `trust`
/// and `recovery` are what loader mode and the vendor's restore depend on.
pub const PROTECTED: [&str; 3] = ["uboot", "trust", "recovery"];

/// Anything that reads and writes 512-byte sectors: the PLAY in loader mode,
/// or a file standing in for one in a test.
pub trait BlockDevice {
    fn read_lba(&mut self, sector: u64, count: u64) -> Result<Vec<u8>, String>;
    fn write_lba(&mut self, sector: u64, bytes: &[u8]) -> Result<(), String>;
}

pub struct Op {
    pub name: String,
    pub start_sector: u64,
    pub source: Arc<dyn Source>,
    pub patches: Vec<Patch>,
}

impl Op {
    pub fn byte_len(&self) -> u64 {
        self.source.len()
    }
    pub fn sectors(&self) -> u64 {
        self.byte_len().div_ceil(SECTOR_SIZE as u64)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpSummary {
    pub name: String,
    pub start_sector: u64,
    pub bytes: u64,
}

pub struct Plan {
    pub ops: Vec<Op>,
    pub notes: Vec<String>,
    pub total_sectors: u64,
    pub injected: bool,
}

impl Plan {
    fn new(ops: Vec<Op>, notes: Vec<String>, injected: bool) -> Plan {
        let total_sectors = ops.iter().map(Op::sectors).sum();
        Plan { ops, notes, total_sectors, injected }
    }

    pub fn summary(&self) -> Vec<OpSummary> {
        self.ops
            .iter()
            .map(|o| OpSummary {
                name: o.name.clone(),
                start_sector: o.start_sector,
                bytes: o.byte_len(),
            })
            .collect()
    }
}

/// The partition table from inside an image, read once for both the plan and
/// the summary shown before anything is written.
pub fn image_parameter(fw: &Rkfw) -> Result<Parameter, String> {
    let p = fw
        .partition("parameter")
        .ok_or("the image has no parameter partition")?;
    let raw = fw.source.read_at(p.offset, p.size as usize)?;
    let text: String = raw.iter().map(|&c| c as char).collect();
    let param = parse_parameter(&text);
    if param.partitions.is_empty() {
        return Err("parameter.txt carries no partition table".into());
    }
    Ok(param)
}

/// A whole-device restore from a factory image, optionally with a package to
/// install on first boot.
pub fn build_full(
    fw: &Rkfw,
    disk_sectors: u64,
    package: Option<Arc<dyn Source>>,
    rng: Rng<'_>,
    now: u32,
) -> Result<Plan, String> {
    let param = image_parameter(fw)?;
    let mut ops = Vec::new();
    let mut notes = Vec::new();

    // parameter.txt is NOT written raw. Its RKAF entry claims sector 0, which
    // on a GPT device is the protective MBR's.
    match param.kind.as_deref().map(str::to_uppercase).as_deref() {
        Some("GPT") => {
            let g = gpt::build(&param.partitions, disk_sectors, &gpt::parse_uuid_lines(&param.raw), rng)?;
            ops.push(Op { name: "gpt".into(), start_sector: 0, source: Arc::new(MemSource(g.master)), patches: vec![] });
            ops.push(Op {
                name: "gpt-backup".into(),
                start_sector: g.backup_sector,
                source: Arc::new(MemSource(g.backup)),
                patches: vec![],
            });
        }
        other => return Err(format!("unsupported partition table type {}", other.unwrap_or("(none)"))),
    }

    let mut injection = None;
    if let Some(pkg) = &package {
        let rootfs = fw.partition("rootfs").ok_or("the image has no rootfs partition to inject into")?;
        let rootfs_param = param
            .partitions
            .iter()
            .find(|p| p.name == "rootfs")
            .and_then(|p| p.sectors)
            .ok_or("parameter.txt gives rootfs no size")?;
        let inj = inject::plan(fw.partition_source(rootfs), rootfs_param, pkg.len(), now)?;
        notes.push(format!(
            "package: {} bytes at rootfs+{} ({} sectors still spare)",
            pkg.len(),
            inj.relative_sector,
            inj.spare_sectors - inj.payload_sectors
        ));
        notes.push(format!("filesystem: {} blocks patched", inj.patches.len()));
        injection = Some(inj);
    }

    for p in &fw.partitions {
        if !p.flashed || p.name == "parameter" {
            continue;
        }
        let patches = match (&injection, p.name.as_str()) {
            (Some(inj), "rootfs") => inj.patches.clone(),
            _ => vec![],
        };
        ops.push(Op {
            name: p.name.clone(),
            start_sector: p.flash_addr as u64,
            source: fw.partition_source(p),
            patches,
        });
    }

    if let (Some(inj), Some(pkg)) = (&injection, package) {
        let rootfs = fw.partition("rootfs").expect("checked above");
        ops.push(Op {
            name: "package".into(),
            start_sector: rootfs.flash_addr as u64 + inj.relative_sector,
            source: pkg,
            patches: vec![],
        });
    }

    for op in &ops {
        if op.start_sector + op.sectors() > disk_sectors {
            return Err(format!("{} runs past the end of the device", op.name));
        }
    }
    let injected = injection.is_some();
    Ok(Plan::new(ops, notes, injected))
}

pub struct Assignment {
    pub partition: String,
    pub label: String,
    pub source: Arc<dyn Source>,
}

/// Individual partition files, aimed with the device's own GPT.
pub fn build_partitions(
    parts: &[DevicePartition],
    assignments: Vec<Assignment>,
    allow_protected: bool,
) -> Result<Plan, String> {
    if assignments.is_empty() {
        return Err("nothing to write".into());
    }
    let mut ops = Vec::new();
    let mut notes = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for a in assignments {
        let part = parts.iter().find(|p| p.name == a.partition).ok_or_else(|| {
            format!(
                "this device has no partition called \"{}\". It has: {}",
                a.partition,
                parts.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
            )
        })?;
        if !seen.insert(a.partition.clone()) {
            return Err(format!("two files are both assigned to \"{}\"", a.partition));
        }
        if !allow_protected && PROTECTED.contains(&a.partition.as_str()) {
            return Err(format!(
                "\"{}\" is part of how this device is recovered. Writing it can leave no way back. \
                 Turn on the override only if that is the intent.",
                a.partition
            ));
        }
        let capacity = part.sectors * SECTOR_SIZE as u64;
        if a.source.len() > capacity {
            return Err(format!(
                "{}: {} bytes does not fit in \"{}\" ({capacity} bytes). A larger write is truncated \
                 and the result does not boot.",
                a.label,
                a.source.len(),
                a.partition
            ));
        }
        notes.push(format!(
            "{}: {} bytes at sector 0x{:x} ({}% of the partition)",
            a.partition,
            a.source.len(),
            part.first_lba,
            (a.source.len() * 100 + capacity / 2) / capacity.max(1)
        ));
        ops.push(Op {
            name: a.partition,
            start_sector: part.first_lba,
            source: a.source,
            patches: vec![],
        });
    }
    ops.sort_by_key(|o| o.start_sector);
    Ok(Plan::new(ops, notes, false))
}

/// Overwrite the parts of `chunk` covered by patches. Offsets are op-relative.
fn apply_patches(chunk: &mut [u8], chunk_start: u64, patches: &[Patch]) {
    let chunk_end = chunk_start + chunk.len() as u64;
    for p in patches {
        let end = p.offset + p.bytes.len() as u64;
        if end <= chunk_start || p.offset >= chunk_end {
            continue;
        }
        let from = p.offset.max(chunk_start);
        let to = end.min(chunk_end);
        chunk[(from - chunk_start) as usize..(to - chunk_start) as usize]
            .copy_from_slice(&p.bytes[(from - p.offset) as usize..(to - p.offset) as usize]);
    }
}

/// The bytes of one stretch of an op as they go to the device: read, zero-padded
/// to whole sectors, patched.
fn op_bytes(op: &Op, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut buf = op.source.read_at(offset, len as usize)?;
    let padded = len.div_ceil(SECTOR_SIZE as u64) * SECTOR_SIZE as u64;
    buf.resize(padded as usize, 0);
    apply_patches(&mut buf, offset, &op.patches);
    Ok(buf)
}

#[derive(Debug, Clone, Copy)]
pub struct WriteProgress<'a> {
    pub op: &'a str,
    pub done_sectors: u64,
    pub total_sectors: u64,
}

/// Execute a plan. Whole partitions only, always: a delta write assumes the
/// device matches a local copy, and above sector 0x10000 there is no reading
/// it back to check.
pub fn run(dev: &mut dyn BlockDevice, plan: &Plan, on_progress: &mut dyn FnMut(WriteProgress<'_>)) -> Result<u64, String> {
    let chunk = SECTORS_PER_TRANSFER * SECTOR_SIZE as u64;
    let mut total = 0;
    for op in &plan.ops {
        let len = op.byte_len();
        let mut written = 0;
        while written < len {
            let read_len = READ_AHEAD.min(len - written);
            let buf = op_bytes(op, written, read_len)?;
            for (i, piece) in buf.chunks(chunk as usize).enumerate() {
                let sector = op.start_sector + (written + i as u64 * chunk) / SECTOR_SIZE as u64;
                dev.write_lba(sector, piece)
                    .map_err(|e| format!("writing {} at sector 0x{sector:x}: {e}", op.name))?;
                total += piece.len() as u64 / SECTOR_SIZE as u64;
                on_progress(WriteProgress {
                    op: &op.name,
                    done_sectors: total,
                    total_sectors: plan.total_sectors,
                });
            }
            written += read_len;
        }
    }
    Ok(total)
}

/// MEASURED ON A PLAY, 2026-08-15: reads at or above sector 0x10000 return solid
/// 0xCC — a fill pattern, not data — through u-boot's rockusb and Rockchip's
/// usbplug alike. Factory partitions that were never written read as 0xCC too,
/// so it is the device, not the write. Verification that ignores this reported
/// 57,702 mismatches for a write that was fine.
const FILL_BYTE: u8 = 0xcc;

fn is_fill(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(|&c| c == FILL_BYTE)
}

/// The sector at which reading back stops returning real data, found by reading
/// sectors that must hold something. None when everything probed reads.
pub fn find_read_ceiling(dev: &mut dyn BlockDevice, known: &[u64]) -> Option<u64> {
    for &sector in known {
        match dev.read_lba(sector, 1) {
            Ok(d) if !is_fill(&d) => continue,
            _ => return Some(sector),
        }
    }
    None
}

/// The factory partitions to probe the ceiling with: their content is not ours
/// to have got wrong.
pub fn ceiling_probes(parts: &[DevicePartition]) -> Vec<u64> {
    let mut v: Vec<u64> = parts
        .iter()
        .filter(|p| ["uboot", "trust", "misc", "recovery", "oem"].contains(&p.name.as_str()))
        .map(|p| p.first_lba)
        .collect();
    v.sort_unstable();
    v
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub mismatches: Vec<String>,
    /// Ops that could not be checked from some sector on, because the device
    /// cannot be read back that far. Not failures.
    pub unverified: Vec<String>,
}

pub fn verify(
    dev: &mut dyn BlockDevice,
    plan: &Plan,
    read_ceiling: Option<u64>,
    on_progress: &mut dyn FnMut(WriteProgress<'_>),
) -> Result<Verification, String> {
    let chunk = SECTORS_PER_TRANSFER * SECTOR_SIZE as u64;
    let mut out = Verification::default();
    let mut checked = 0;
    for op in &plan.ops {
        let len = op.byte_len();
        let mut off = 0;
        while off < len {
            let n = chunk.min(len - off);
            let at = op.start_sector + off / SECTOR_SIZE as u64;
            if read_ceiling.is_some_and(|c| at >= c) {
                out.unverified.push(format!("{} from sector 0x{at:x}", op.name));
                break;
            }
            let expect = op_bytes(op, off, n)?;
            let got = dev.read_lba(at, expect.len() as u64 / SECTOR_SIZE as u64)?;
            if got != expect {
                let byte = got.iter().zip(&expect).position(|(a, b)| a != b).unwrap_or(0) as u64;
                out.mismatches.push(format!("{} at byte {}", op.name, off + byte));
                break;
            }
            checked += expect.len() as u64 / SECTOR_SIZE as u64;
            on_progress(WriteProgress {
                op: &op.name,
                done_sectors: checked,
                total_sectors: plan.total_sectors,
            });
            off += n;
        }
    }
    Ok(out)
}
