//! What an ESP-IDF file is, from its bytes. Pure: no serial port, no files.
//!
//! A port of the CANary Flasher's `src/image.ts`, kept rule for rule so the page
//! and Burrow refuse the same things. Where this file and that one disagree, one
//! of them has a bug.

use serde::Serialize;

/// ESP-IDF image magic, byte 0 of every bootloader and app image.
pub const IMAGE_MAGIC: u8 = 0xe9;
/// `esp_app_desc_t.magic_word`, the first word of an app's first segment.
pub const APP_DESC_MAGIC: u32 = 0xabcd_5432;
/// `esp_chip_id_t` for the ESP32-S3, as the image's extended header carries it.
pub const CHIP_ID_ESP32S3: u16 = 9;
/// Magic of each 32-byte entry in an ESP-IDF partition table.
pub const PARTITION_MAGIC: u16 = 0x50aa;

/// Where an ESP32-S3 build puts each part. The bootloader sits at 0x0 on the S3;
/// the classic ESP32 puts it at 0x1000, which is one of the things that makes a
/// wrong-chip image dangerous rather than merely useless.
pub const BOOTLOADER: u32 = 0x0;
pub const PARTITION_TABLE: u32 = 0x8000;
pub const OTADATA: u32 = 0xf000;
pub const APP: u32 = 0x20000;
pub const OTADATA_LEN: usize = 0x2000;

/// The ESP-IDF project names a CANary app carries: `canary` since the rename
/// (2026-09-27), `dbcanary` before it. A unit's own older build is still ours.
pub const APP_PROJECTS: [&str; 2] = ["canary", "dbcanary"];

pub fn chip_name(id: u16) -> String {
    match id {
        0 => "ESP32".into(),
        2 => "ESP32-S2".into(),
        5 => "ESP32-C3".into(),
        9 => "ESP32-S3".into(),
        12 => "ESP32-C2".into(),
        13 => "ESP32-C6".into(),
        16 => "ESP32-H2".into(),
        18 => "ESP32-P4".into(),
        23 => "ESP32-C5".into(),
        other => format!("chip id {other}"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDescription {
    pub version: String,
    pub project: String,
    pub time: String,
    pub date: String,
    pub idf_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Partition {
    pub label: String,
    #[serde(rename = "type")]
    pub kind: u8,
    pub subtype: u8,
    pub offset: u32,
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageInfo {
    App { chip_id: u16, app: AppDescription },
    Bootloader { chip_id: u16 },
    PartitionTable { partitions: Vec<Partition> },
    Otadata,
    Unknown { reason: &'static str },
}

impl ImageInfo {
    pub fn kind(&self) -> &'static str {
        match self {
            ImageInfo::App { .. } => "app",
            ImageInfo::Bootloader { .. } => "bootloader",
            ImageInfo::PartitionTable { .. } => "partition table",
            ImageInfo::Otadata => "otadata",
            ImageInfo::Unknown { .. } => "unknown",
        }
    }
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32_at(b: &[u8], o: usize) -> u32 {
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

/// Work out what a file is from its bytes, never its name.
pub fn identify(b: &[u8]) -> ImageInfo {
    if b.is_empty() {
        return ImageInfo::Unknown { reason: "the file is empty" };
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
    if b.len() == OTADATA_LEN && b.iter().all(|&x| x == 0xff) {
        return ImageInfo::Otadata;
    }
    ImageInfo::Unknown {
        reason: "not an ESP-IDF image, partition table or otadata file",
    }
}

/// Where a file of this kind goes. An app goes to the first app partition.
pub fn default_offset(info: &ImageInfo) -> Option<u32> {
    match info {
        ImageInfo::Bootloader { .. } => Some(BOOTLOADER),
        ImageInfo::PartitionTable { .. } => Some(PARTITION_TABLE),
        ImageInfo::Otadata => Some(OTADATA),
        ImageInfo::App { .. } => Some(APP),
        ImageInfo::Unknown { .. } => None,
    }
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

/// Which OTA slot the bootloader will pick, from the 8 KB otadata partition: two
/// sectors each holding an `esp_ota_select_entry_t` (seq u32, label[20], state
/// u32, crc u32). The valid entry with the higher sequence wins, and slot =
/// (seq − 1) mod 2. Blank, or no valid entry, means the factory choice: ota_0.
pub fn active_ota_slot(otadata: &[u8]) -> (u32, Option<u32>) {
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
        Some(seq) => ((seq - 1) % 2, Some(seq)),
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

/// The app partitions a table declares, in the order the bootloader numbers
/// them: ota_0 is subtype 0x10, ota_1 is 0x11, and so on.
pub fn ota_slot_offset(table: &[Partition], slot: u32) -> Option<u32> {
    const APP_TYPE: u8 = 0x00;
    table
        .iter()
        .find(|p| p.kind == APP_TYPE && p.subtype == 0x10 + slot as u8)
        .map(|p| p.offset)
}

pub fn hex(n: u32) -> String {
    format!("0x{n:05x}")
}
