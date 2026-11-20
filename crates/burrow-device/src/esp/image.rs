//! What an ESP-IDF file is, from its bytes. Pure: no serial port, no files.
//!
//! The Stoatworks Flasher's `src/image.ts`, rule for rule, so the page and
//! Burrow refuse the same things. Where this file and that one disagree, one of
//! them has a bug.

use super::chips::{self, CHIPS, DEFAULT_TABLE_OFFSET, TABLE_SIZE};
use serde::{Deserialize, Serialize};

/// ESP-IDF image magic, byte 0 of every bootloader and app image.
pub const IMAGE_MAGIC: u8 = 0xe9;
/// `esp_app_desc_t.magic_word`, the first word of an app's first segment.
pub const APP_DESC_MAGIC: u32 = 0xabcd_5432;
/// Magic of each 32-byte entry in an ESP-IDF partition table.
pub const PARTITION_MAGIC: u16 = 0x50aa;

pub const PART_APP: u8 = 0x00;
pub const PART_DATA: u8 = 0x01;
pub const SUB_FACTORY: u8 = 0x00;
pub const SUB_OTA_0: u8 = 0x10;
pub const SUB_OTADATA: u8 = 0x00;

/// `esp_app_desc_t` as far as anyone reads it. camelCase on the wire, because
/// the package manifest spells it that way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDescription {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub idf_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Partition {
    pub label: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub subtype: u8,
    pub offset: u32,
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ImageInfo {
    #[serde(rename_all = "camelCase")]
    App { chip_id: u16, app: AppDescription },
    #[serde(rename_all = "camelCase")]
    Bootloader { chip_id: u16 },
    PartitionTable { partitions: Vec<Partition> },
    Otadata,
    /// A whole-flash image from 0x0 (`esptool merge-bin`, or a read-back):
    /// bootloader, partition table and whatever partitions follow, in one file.
    #[serde(rename_all = "camelCase")]
    Merged { chip_id: u16, partitions: Vec<Partition> },
    Unknown { reason: &'static str },
}

impl ImageInfo {
    /// The TS `kind`, word for word.
    pub fn kind(&self) -> &'static str {
        match self {
            ImageInfo::App { .. } => "app",
            ImageInfo::Bootloader { .. } => "bootloader",
            ImageInfo::PartitionTable { .. } => "partition-table",
            ImageInfo::Otadata => "otadata",
            ImageInfo::Merged { .. } => "merged",
            ImageInfo::Unknown { .. } => "unknown",
        }
    }
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

pub fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// A NUL-terminated string in a fixed field. Lossy, because these come off a
/// device that may hold anything, and a name we cannot read is still a name.
fn cstr(b: &[u8], start: usize, len: usize) -> String {
    let field = &b[start..start + len];
    let end = field.iter().position(|&c| c == 0).unwrap_or(len);
    String::from_utf8_lossy(&field[..end]).into_owned()
}

/// The app descriptor sits at the very start of the first segment: 24 bytes of
/// image header, 8 of segment header, then `esp_app_desc_t`. None when the magic
/// is not there, which is what a bootloader image looks like.
pub fn read_app_description(b: &[u8]) -> Option<AppDescription> {
    const D: usize = 24 + 8;
    if b.len() < D + 256 || u32_at(b, D) != APP_DESC_MAGIC {
        return None;
    }
    // magic(4) secure_version(4) reserv1[2](8) version[32] project_name[32]
    // time[16] date[16] idf_ver[32] app_elf_sha256[32] ...
    Some(AppDescription {
        version: cstr(b, D + 16, 32),
        project: cstr(b, D + 48, 32),
        time: cstr(b, D + 80, 16),
        date: cstr(b, D + 96, 16),
        idf_version: cstr(b, D + 112, 32),
    })
}

/// Chip ID from the extended image header, bytes 12–13.
pub fn image_chip_id(b: &[u8]) -> u16 {
    u16_at(b, 12)
}

pub fn parse_partition_table(b: &[u8]) -> Option<Vec<Partition>> {
    let mut out = Vec::new();
    let mut o = 0;
    while o + 32 <= b.len() {
        match u16_at(b, o) {
            // End of the table on erased flash, or the MD5 entry that follows
            // the last partition.
            0xffff | 0xebeb => break,
            PARTITION_MAGIC => {}
            _ => return if out.is_empty() { None } else { Some(out) },
        }
        out.push(Partition {
            kind: b[o + 2],
            subtype: b[o + 3],
            offset: u32_at(b, o + 4),
            size: u32_at(b, o + 8),
            label: cstr(b, o + 12, 16),
        });
        o += 32;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// A whole-flash image: the bootloader at its chip's offset and a partition
/// table at 0x8000, in one file that starts at 0x0. Space below the bootloader
/// (the first 4 or 8 KB on the chips that boot from 0x1000 or 0x2000) is
/// padding.
fn as_merged(b: &[u8]) -> Option<ImageInfo> {
    let t = DEFAULT_TABLE_OFFSET as usize;
    if b.len() < t + 32 || u16_at(b, t) != PARTITION_MAGIC {
        return None;
    }
    let mut seen: Vec<u32> = Vec::new();
    for c in CHIPS {
        if seen.contains(&c.bootloader) {
            continue;
        }
        seen.push(c.bootloader);
        let at = c.bootloader as usize;
        if b.len() < at + 24 || b[at] != IMAGE_MAGIC {
            continue;
        }
        let chip_id = image_chip_id(&b[at..]);
        if chips::by_image_id(chip_id).map(|c| c.bootloader) != Some(c.bootloader) {
            continue;
        }
        let end = (t + TABLE_SIZE as usize).min(b.len());
        if let Some(partitions) = parse_partition_table(&b[t..end]) {
            return Some(ImageInfo::Merged { chip_id, partitions });
        }
    }
    None
}

/// Work out what a file is from its bytes, never its name.
pub fn identify(b: &[u8]) -> ImageInfo {
    if b.is_empty() {
        return ImageInfo::Unknown { reason: "the file is empty" };
    }
    if let Some(m) = as_merged(b) {
        return m;
    }
    if b[0] == IMAGE_MAGIC && b.len() >= 24 {
        let chip_id = image_chip_id(b);
        return match read_app_description(b) {
            Some(app) => ImageInfo::App { chip_id, app },
            None => ImageInfo::Bootloader { chip_id },
        };
    }
    if b.len() >= 2 && u16_at(b, 0) == PARTITION_MAGIC {
        if let Some(partitions) = parse_partition_table(b) {
            return ImageInfo::PartitionTable { partitions };
        }
    }
    // ota_data_initial.bin is two erased 4 KB sectors: all 0xFF, 8 KB long.
    if b.len() == 0x2000 && b.iter().all(|&x| x == 0xff) {
        return ImageInfo::Otadata;
    }
    ImageInfo::Unknown {
        reason: "not an ESP-IDF image, partition table, otadata or whole-flash image",
    }
}

/// What a file is, in a few words, for a table on screen.
pub fn describe_image(info: &ImageInfo) -> String {
    match info {
        ImageInfo::App { chip_id, app } => format!("{} {} · {}", app.project, app.version, chips::label(*chip_id)),
        ImageInfo::Bootloader { chip_id } => format!("bootloader · {}", chips::label(*chip_id)),
        ImageInfo::PartitionTable { partitions } => {
            partitions.iter().map(|p| p.label.as_str()).collect::<Vec<_>>().join(", ")
        }
        ImageInfo::Otadata => "blank otadata".into(),
        ImageInfo::Merged { chip_id, .. } => format!("whole flash · {}", chips::label(*chip_id)),
        ImageInfo::Unknown { .. } => "raw data".into(),
    }
}

// --- partitions -------------------------------------------------------------------

/// The app partition the bootloader starts when otadata is blank: factory if
/// there is one, otherwise ota_0.
pub fn boot_partition(table: &[Partition]) -> Option<&Partition> {
    let apps: Vec<&Partition> = table.iter().filter(|p| p.kind == PART_APP).collect();
    apps.iter()
        .find(|p| p.subtype == SUB_FACTORY)
        .or_else(|| apps.iter().find(|p| p.subtype == SUB_OTA_0))
        .or(apps.first())
        .copied()
}

pub fn otadata_partition(table: &[Partition]) -> Option<&Partition> {
    table.iter().find(|p| p.kind == PART_DATA && p.subtype == SUB_OTADATA)
}

pub fn partition_at(table: &[Partition], offset: u32) -> Option<&Partition> {
    table.iter().find(|p| p.offset == offset)
}

pub fn partition_containing(table: &[Partition], offset: u32, length: u64) -> Option<&Partition> {
    table
        .iter()
        .find(|p| offset >= p.offset && offset as u64 + length <= p.offset as u64 + p.size as u64)
}

/// The app partition ota_N, or None if the table has no such slot.
pub fn ota_slot(table: &[Partition], n: u32) -> Option<&Partition> {
    table
        .iter()
        .find(|p| p.kind == PART_APP && p.subtype as u32 == SUB_OTA_0 as u32 + n)
}

/// How many OTA app slots a table declares (ota_0 … ota_15).
pub fn ota_slot_count(table: &[Partition]) -> u32 {
    table
        .iter()
        .filter(|p| p.kind == PART_APP && p.subtype >= SUB_OTA_0 && p.subtype < SUB_OTA_0 + 16)
        .count() as u32
}

/// `esp_rom_crc32_le` as the bootloader calls it on otadata: seeded with
/// `u32::MAX`, inverted on the way in and out.
fn crc32le(seed: u32, b: &[u8]) -> u32 {
    let mut crc = !seed;
    for &x in b {
        crc ^= x as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Which OTA slot the bootloader will pick, from the 8 KB otadata partition:
/// two sectors each holding an `esp_ota_select_entry_t` (seq u32, label[20],
/// state u32, crc u32). The valid entry with the higher sequence wins, and slot
/// = (seq − 1) mod (number of OTA slots). Blank, or no valid entry, means the
/// factory choice: `seq` is None and the caller picks [`boot_partition`].
pub fn active_ota_slot(otadata: &[u8], slots: u32) -> (u32, Option<u32>) {
    let mut best: Option<u32> = None;
    for base in [0usize, 0x1000] {
        if otadata.len() < base + 32 {
            continue;
        }
        let seq = u32_at(otadata, base);
        if seq == 0xffff_ffff || seq == 0 {
            continue;
        }
        if crc32le(0xffff_ffff, &otadata[base..base + 4]) != u32_at(otadata, base + 28) {
            continue;
        }
        // ESP_OTA_IMG_INVALID (3) and ABORTED (4) are skipped by the bootloader.
        let state = u32_at(otadata, base + 24);
        if state == 3 || state == 4 {
            continue;
        }
        if best.is_none_or(|b| seq > b) {
            best = Some(seq);
        }
    }
    match best {
        Some(seq) => ((seq - 1) % slots.max(1), Some(seq)),
        None => (0, None),
    }
}

/// Test hook: a valid otadata entry, as `esp_ota_set_boot_partition` writes one.
pub fn otadata_entry(seq: u32, state: u32) -> [u8; 32] {
    let mut e = [0xffu8; 32];
    e[0..4].copy_from_slice(&seq.to_le_bytes());
    e[4..24].fill(0);
    e[24..28].copy_from_slice(&state.to_le_bytes());
    let crc = crc32le(0xffff_ffff, &e[0..4]);
    e[28..32].copy_from_slice(&crc.to_le_bytes());
    e
}

pub fn hex(n: u32) -> String {
    format!("0x{n:05x}")
}

/// An offset as a person types it: "0x20000", "128K", "1M", or a partition
/// label. Bare digits are refused: esptool reads "20000" as decimal and most
/// people mean hex, and a write is the wrong place to guess which.
pub fn parse_offset(text: &str, table: Option<&[Partition]>) -> Option<u32> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(p) = table.and_then(|t2| t2.iter().find(|p| p.label == t)) {
        return Some(p.offset);
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        if !h.is_empty() && h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return u32::from_str_radix(h, 16).ok();
        }
        return None;
    }
    let mult: u64 = match t.chars().last() {
        Some('K' | 'k') => 1024,
        Some('M' | 'm') => 1024 * 1024,
        _ => return None,
    };
    let num = t[..t.len() - 1].trim_end();
    if num.is_empty() || !num.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: u64 = num.parse().ok()?;
    u32::try_from(n.checked_mul(mult)?).ok()
}
