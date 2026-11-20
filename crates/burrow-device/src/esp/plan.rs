//! The one gate every ESP32 write goes through.
//!
//! `check_plan`, `check_table`, `plan_notes`, `with_otadata_reset` and
//! `merge_parts` are the Stoatworks Flasher's `src/plan.ts`, rule for rule and
//! message for message, and `unit_problems` is its `flash.ts` function of the
//! same name. Burrow adds one thing the page has no way to read: a unit with
//! secure boot or flash encryption on is refused, because plain firmware
//! written to either does not boot.
//!
//! Both run when the plan is drawn and again, against a fresh read of the unit,
//! immediately before the first byte goes out. A board swapped between the two
//! is a different board.

use super::chips::{self, Chip, DEFAULT_TABLE_OFFSET, TABLE_SIZE};
use super::image::{
    boot_partition, hex, identify, otadata_partition, partition_at, ImageInfo, Partition, PART_APP, PART_DATA,
};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedWrite {
    pub name: String,
    pub offset: u32,
    pub data: Vec<u8>,
    /// The person typed this offset for data nobody can identify. Raw writes
    /// skip the "is this firmware" checks, never the flash-geometry ones.
    pub raw: bool,
}

impl PlannedWrite {
    pub fn new(name: impl Into<String>, offset: u32, data: Vec<u8>) -> PlannedWrite {
        PlannedWrite { name: name.into(), offset, data, raw: false }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PlanContext<'a> {
    /// The chip being written: the connected unit's, or the device's before one
    /// is connected.
    pub chip: &'static Chip,
    pub flash_bytes: u64,
    /// ESP-IDF project names an app must carry. None means any project: your
    /// own file.
    pub projects: Option<&'a [String]>,
    /// The partition table read off the unit, used when the plan brings none.
    pub unit_table: Option<&'a [Partition]>,
    /// Where the bootloader reads the table. 0x8000 unless the device says
    /// otherwise.
    pub table_offset: u32,
}

impl<'a> PlanContext<'a> {
    pub fn new(chip: &'static Chip, flash_bytes: u64) -> PlanContext<'a> {
        PlanContext { chip, flash_bytes, projects: None, unit_table: None, table_offset: DEFAULT_TABLE_OFFSET }
    }
}

/// One thing the plan puts on flash: a write, or a piece of a whole-flash image.
#[derive(Debug, Clone)]
pub struct Component<'a> {
    pub name: String,
    pub offset: u32,
    pub data: &'a [u8],
    pub info: ImageInfo,
    pub raw: bool,
}

fn blank(b: &[u8]) -> bool {
    b.iter().all(|&x| x == 0xff)
}

fn bootloader_start(b: &[u8]) -> usize {
    for at in [0x0usize, 0x1000, 0x2000] {
        if b.get(at) == Some(&0xe9) {
            return at;
        }
    }
    0
}

/// The plan as the bootloader will see it: every write, with a whole-flash
/// image broken into its bootloader, partition table and non-blank partitions.
pub fn components(writes: &[PlannedWrite], table_offset: u32) -> Vec<Component<'_>> {
    let mut out = Vec::new();
    for w in writes {
        let info = identify(&w.data);
        let ImageInfo::Merged { partitions, .. } = &info else {
            let raw = w.raw && matches!(info, ImageInfo::Unknown { .. });
            out.push(Component { name: w.name.clone(), offset: w.offset, data: &w.data, info, raw });
            continue;
        };
        let mut piece = |name: &str, from: usize, to: usize| {
            let to = to.min(w.data.len());
            if from >= to {
                return;
            }
            let data = &w.data[from..to];
            if !blank(data) {
                out.push(Component {
                    name: format!("{} → {name}", w.name),
                    offset: w.offset.saturating_add(from as u32),
                    data,
                    info: identify(data),
                    raw: false,
                });
            }
        };
        let t = table_offset as usize;
        piece("bootloader", bootloader_start(&w.data), t);
        piece("partition table", t, t + TABLE_SIZE as usize);
        for p in partitions {
            if (p.offset as usize) < w.data.len() {
                piece(&p.label, p.offset as usize, p.offset as usize + p.size as usize);
            }
        }
    }
    out
}

/// The partition table the plan leaves on the unit: its own if it writes one,
/// else the unit's.
pub fn effective_table<'a>(parts: &'a [Component<'_>], unit_table: Option<&'a [Partition]>) -> Option<&'a [Partition]> {
    for c in parts {
        if let ImageInfo::PartitionTable { partitions } = &c.info {
            return Some(partitions);
        }
    }
    unit_table
}

/// "8 MB", "256 KB", the way the page writes a JavaScript number.
fn mb(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{} MB", n as f64 / 1024.0 / 1024.0)
    } else {
        format!("{} KB", n as f64 / 1024.0)
    }
}

/// Everything that must be true before a set of writes goes near a unit. The
/// reasons it must not, empty when it may.
pub fn check_plan(writes: &[PlannedWrite], ctx: &PlanContext) -> Vec<String> {
    let mut problems = Vec::new();
    let table_offset = ctx.table_offset;
    if writes.is_empty() {
        return vec!["nothing to write".into()];
    }

    // Geometry, on the writes as given.
    let mut sorted: Vec<&PlannedWrite> = writes.iter().collect();
    sorted.sort_by_key(|w| w.offset);
    for (i, w) in sorted.iter().enumerate() {
        let end = w.offset as u64 + w.data.len() as u64;
        if w.offset % 0x1000 != 0 {
            problems.push(format!("{}: offset {} is not on a 4 KB sector boundary", w.name, hex(w.offset)));
        }
        if w.data.is_empty() {
            problems.push(format!("{}: is empty", w.name));
        }
        if end > ctx.flash_bytes {
            problems.push(format!("{}: runs past the end of the {} flash", w.name, mb(ctx.flash_bytes)));
        }
        if let Some(next) = sorted.get(i + 1) {
            if end > next.offset as u64 {
                problems.push(format!("{} overlaps {}", w.name, next.name));
            }
        }
    }
    if !problems.is_empty() {
        return problems;
    }

    let parts = components(writes, table_offset);
    let table = effective_table(&parts, ctx.unit_table);
    let chip_ok = |problems: &mut Vec<String>, c: &Component, chip_id: u16| {
        if chip_id != ctx.chip.image_id {
            problems.push(format!(
                "{}: built for {}, and this is an {}",
                c.name,
                chips::label(chip_id),
                ctx.chip.name
            ));
        }
    };

    for w in writes {
        if matches!(identify(&w.data), ImageInfo::Merged { .. }) && w.offset != 0 {
            problems.push(format!("{}: a whole-flash image only goes at 0x0", w.name));
        }
    }

    for c in &parts {
        match &c.info {
            // A merged image nested in a merged image is just data.
            ImageInfo::Merged { .. } => {}
            ImageInfo::Bootloader { chip_id } => {
                chip_ok(&mut problems, c, *chip_id);
                if c.offset != ctx.chip.bootloader {
                    problems.push(format!(
                        "{}: an {} only boots a bootloader from {}",
                        c.name,
                        ctx.chip.name,
                        hex(ctx.chip.bootloader)
                    ));
                }
            }
            ImageInfo::PartitionTable { partitions } => {
                if c.offset != table_offset {
                    problems.push(format!(
                        "{}: the bootloader reads the partition table at {}",
                        c.name,
                        hex(table_offset)
                    ));
                }
                for p in check_table(partitions, ctx.flash_bytes, table_offset) {
                    problems.push(format!("{}: {p}", c.name));
                }
            }
            ImageInfo::App { chip_id, app } => {
                chip_ok(&mut problems, c, *chip_id);
                if let Some(projects) = ctx.projects {
                    if !projects.iter().any(|p| p == &app.project) {
                        problems.push(format!("{}: this is \"{}\", not a build for this device", c.name, app.project));
                    }
                }
                let Some(table) = table else {
                    problems.push(format!(
                        "{}: there is no partition table to say where an app goes, so include one",
                        c.name
                    ));
                    continue;
                };
                match partition_at(table, c.offset) {
                    Some(p) if p.kind == PART_APP => {
                        if c.data.len() as u64 > p.size as u64 {
                            problems.push(format!("{}: is bigger than the {} partition", c.name, p.label));
                        }
                    }
                    _ => problems.push(format!("{}: {} is not the start of an app partition", c.name, hex(c.offset))),
                }
            }
            ImageInfo::Otadata => {
                let Some(table) = table else {
                    problems.push(format!("{}: there is no partition table to say where otadata goes", c.name));
                    continue;
                };
                match otadata_partition(table) {
                    None => problems.push(format!("{}: the partition table has no otadata partition", c.name)),
                    Some(p) if c.offset != p.offset => {
                        problems.push(format!("{}: otadata goes at {}", c.name, hex(p.offset)))
                    }
                    Some(p) if c.data.len() as u64 > p.size as u64 => {
                        problems.push(format!("{}: is bigger than the otadata partition", c.name))
                    }
                    Some(_) => {}
                }
            }
            ImageInfo::Unknown { reason } => {
                if c.raw {
                    continue;
                }
                // A data image (a filesystem, an image for a co-processor) is
                // fine where it starts a data partition and fits in it.
                // Anything else needs an offset somebody chose on purpose.
                match table.and_then(|t| partition_at(t, c.offset)) {
                    Some(p) if p.kind == PART_DATA && c.data.len() as u64 <= p.size as u64 => {}
                    Some(p) if p.kind == PART_DATA => {
                        problems.push(format!("{}: is bigger than the {} partition", c.name, p.label))
                    }
                    _ => problems.push(format!("{}: {reason}. Give it an offset to write it as raw data", c.name)),
                }
            }
        }
    }
    problems
}

/// What is wrong with a partition table as the bootloader would read it.
pub fn check_table(table: &[Partition], flash_bytes: u64, table_offset: u32) -> Vec<String> {
    let mut problems = Vec::new();
    let mut sorted: Vec<&Partition> = table.iter().collect();
    sorted.sort_by_key(|p| p.offset);
    for (i, p) in sorted.iter().enumerate() {
        let end = p.offset as u64 + p.size as u64;
        if (p.offset as u64) < table_offset as u64 + 0x1000 {
            problems.push(format!("{} starts below the end of the partition table", p.label));
        }
        if end > flash_bytes {
            problems.push(format!("{} runs past the end of the {} flash", p.label, mb(flash_bytes)));
        }
        if p.kind == PART_APP && p.offset % 0x10000 != 0 {
            problems.push(format!("{} is an app partition not on a 64 KB boundary", p.label));
        }
        if let Some(next) = sorted.get(i + 1) {
            if end > next.offset as u64 {
                problems.push(format!("{} overlaps {}", p.label, next.label));
            }
        }
    }
    if boot_partition(table).is_none() {
        problems.push("there is no app partition".into());
    }
    problems
}

fn same_table(a: &[Partition], b: &[Partition]) -> bool {
    let key = |t: &[Partition]| {
        let mut k: Vec<String> =
            t.iter().map(|p| format!("{}/{}/{}/{}/{}", p.label, p.kind, p.subtype, p.offset, p.size)).collect();
        k.sort();
        k.join(";")
    };
    key(a) == key(b)
}

/// Things worth saying that are not reasons to refuse: which partition will
/// boot, and what a new partition table leaves behind.
pub fn plan_notes(writes: &[PlannedWrite], ctx: &PlanContext) -> Vec<String> {
    let mut notes = Vec::new();
    let parts = components(writes, ctx.table_offset);
    let Some(table) = effective_table(&parts, ctx.unit_table) else {
        return notes;
    };
    let boot = boot_partition(table);
    let apps: Vec<&Component> = parts.iter().filter(|c| matches!(c.info, ImageInfo::App { .. })).collect();
    let writes_otadata = parts.iter().any(|c| matches!(c.info, ImageInfo::Otadata));
    for a in &apps {
        if let (Some(p), Some(b)) = (partition_at(table, a.offset), boot) {
            if !std::ptr::eq(p, b) && !writes_otadata && otadata_partition(table).is_some() {
                notes.push(format!(
                    "{} goes to {}, and nothing here tells the bootloader to start it.",
                    a.name, p.label
                ));
            }
        }
    }
    let new_table = parts.iter().any(|c| matches!(c.info, ImageInfo::PartitionTable { .. }));
    if let (true, Some(unit)) = (new_table, ctx.unit_table) {
        if !same_table(table, unit) {
            notes.push("This changes the unit's partition table. Anything in a partition that moved is lost.".into());
            if let Some(b) = boot {
                if !apps.iter().any(|a| a.offset == b.offset) {
                    notes.push(format!("Nothing is written to {}, which is what the new table boots.", b.label));
                }
            }
        }
    }
    notes
}

/// A lone app image boots only if otadata points at the slot it went into.
/// When the plan writes an app to the partition a blank otadata boots and says
/// nothing about otadata itself, add a blank one. Without it, a unit that last
/// updated over the air keeps booting its other slot and the write looks as
/// though it did nothing.
pub fn with_otadata_reset(
    writes: Vec<PlannedWrite>,
    unit_table: Option<&[Partition]>,
    table_offset: u32,
) -> (Vec<PlannedWrite>, bool) {
    let add = {
        let parts = components(&writes, table_offset);
        let table = effective_table(&parts, unit_table);
        match table.and_then(|t| Some((boot_partition(t)?, otadata_partition(t)?))) {
            None => None,
            Some((boot, ota)) => {
                let has_boot_app = parts.iter().any(|c| matches!(c.info, ImageInfo::App { .. }) && c.offset == boot.offset);
                let ota_end = ota.offset as u64 + ota.size as u64;
                let touches = writes
                    .iter()
                    .any(|w| (w.offset as u64) < ota_end && w.offset as u64 + w.data.len() as u64 > ota.offset as u64);
                if has_boot_app && !touches {
                    Some(PlannedWrite::new(
                        format!("otadata (blank: boot {})", boot.label),
                        ota.offset,
                        vec![0xff; ota.size as usize],
                    ))
                } else {
                    None
                }
            }
        }
    };
    match add {
        Some(w) => {
            let mut writes = writes;
            writes.push(w);
            (writes, true)
        }
        None => (writes, false),
    }
}

/// Lay parts end to end as one whole-flash image from 0x0, gaps filled with
/// 0xFF (erased flash), as `esptool merge-bin` does. Written at 0x0 it is the
/// same flash as the parts written one by one.
pub fn merge_parts(writes: &[PlannedWrite]) -> Vec<u8> {
    let end = writes.iter().map(|w| w.offset as usize + w.data.len()).max().unwrap_or(0);
    let mut out = vec![0xffu8; end];
    for w in writes {
        out[w.offset as usize..w.offset as usize + w.data.len()].copy_from_slice(&w.data);
    }
    out
}

// --- the unit itself ------------------------------------------------------------------

/// What a connected unit said about itself, as far as the gate cares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitFacts {
    /// What the ROM says it is, in esptool's spelling ("ESP32-S3").
    pub chip_name: String,
    /// None when the flash size could not be read. A refusal, not a guess.
    pub flash_bytes: Option<u64>,
    pub flash_label: String,
    pub secure_boot: bool,
    pub flash_encryption: bool,
}

impl UnitFacts {
    /// The chip table's entry, or None for a chip Burrow does not flash.
    pub fn chip(&self) -> Option<&'static Chip> {
        chips::by_name(&self.chip_name)
    }
}

/// What the chosen firmware asks of the unit it goes on.
#[derive(Debug, Clone, Copy, Default)]
pub struct Want<'a> {
    pub chip: Option<&'a str>,
    pub min_flash: Option<u64>,
    /// The device's name, for the messages.
    pub name: Option<&'a str>,
}

/// Reasons the connected unit itself is wrong for the firmware, before any file
/// is looked at.
pub fn unit_problems(u: &UnitFacts, want: &Want) -> Vec<String> {
    let mut p = Vec::new();
    let name = want.name.unwrap_or("the firmware");
    match u.chip() {
        None => p.push(format!("this is an {}, which Burrow does not flash", u.chip_name)),
        Some(c) => {
            if let Some(w) = want.chip {
                if c.name != w {
                    p.push(format!("this is an {}, and {name} is for an {w}", u.chip_name));
                }
            }
        }
    }
    if let (Some(min), Some(have)) = (want.min_flash, u.flash_bytes) {
        if min > 0 && have > 0 && have < min {
            p.push(format!(
                "this unit has {} of flash, and {name} needs {}MB",
                u.flash_label,
                min as f64 / 1024.0 / 1024.0
            ));
        }
    }
    if u.flash_bytes.unwrap_or(0) == 0 {
        p.push("the unit did not say how much flash it has".into());
    }
    if u.secure_boot {
        p.push("secure boot is on, and firmware not signed for this unit would not boot".into());
    }
    if u.flash_encryption {
        p.push("flash encryption is on, so plain firmware written to it would not boot".into());
    }
    p
}

/// Writing over firmware other than this device's (or, for your own file,
/// other than the file's own) needs a tick. The words for that tick, or None
/// when no tick is needed.
pub fn replace_text(
    running: Option<&super::image::AppDescription>,
    writes: &[PlannedWrite],
    projects: Option<&[String]>,
) -> Option<String> {
    let running = running?;
    let apps: Vec<super::image::AppDescription> = components(writes, DEFAULT_TABLE_OFFSET)
        .into_iter()
        .filter_map(|c| match c.info {
            ImageInfo::App { app, .. } => Some(app),
            _ => None,
        })
        .collect();
    let first = apps.first()?;
    let ours: Vec<&str> = match projects {
        Some(p) => p.iter().map(String::as_str).collect(),
        None => apps.iter().map(|a| a.project.as_str()).collect(),
    };
    if ours.contains(&running.project.as_str()) {
        return None;
    }
    Some(format!(
        "This board runs {} {}. Replace it with {} {}.",
        running.project, running.version, first.project, first.version
    ))
}
