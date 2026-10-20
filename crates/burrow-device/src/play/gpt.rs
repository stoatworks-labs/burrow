//! A GPT built from `parameter.txt`, and a GPT read back off a device.
//!
//! `parameter.txt` says `TYPE: GPT` and its RKAF entry claims sector 0, but its
//! 523 bytes are never written there. The vendor tool turns the mtdparts
//! CMDLINE into a partition table and writes that instead; writing the file raw
//! would leave a device with no partition table at all, which is exactly the
//! state a recovery flash exists to undo.
//!
//! Ported from the browser flasher's `gpt.js`, itself from rkdeveloptool's
//! `create_gpt_buffer`. Two details are copied on purpose although they look
//! wrong: each entry's partition TYPE guid is random, because Rockchip's u-boot
//! and kernel find partitions by name and matching the vendor tool matters more
//! than tidiness; and a `:grow` partition ends at the last usable sector, not at
//! its declared size.
//!
//! Randomness comes from the caller, so the crate needs no RNG and a test can
//! build the same table twice.

use super::crc::crc32;
use super::rkfw::ParamPartition;
use serde::Serialize;
use std::collections::HashMap;

pub const SECTOR_SIZE: usize = 512;
const GPT_ENTRIES: usize = 128;
const GPT_ENTRY_SIZE: usize = 128;
const HEADER_SIZE: usize = 92;

pub type Rng<'a> = &'a mut dyn FnMut(&mut [u8]);

fn random_uuid(rng: Rng<'_>) -> [u8; 16] {
    let mut b = [0u8; 16];
    rng(&mut b);
    b[7] = (b[7] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    b
}

/// "614e0000-0000-4b53-8000-1d28000054a9" as GPT stores it: the first three
/// fields little-endian, the rest as written.
pub fn parse_uuid(text: &str) -> Option<[u8; 16]> {
    let hex: String = text.chars().filter(|&c| c != '-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut b = [0u8; 16];
    for i in 0..16 {
        b[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    b[0..4].reverse();
    b[4..6].reverse();
    b[6..8].reverse();
    Some(b)
}

/// `uuid:<name>=<value>` lines in parameter.txt, by partition name. A malformed
/// one is ignored, as the page ignores it.
pub fn parse_uuid_lines(text: &str) -> HashMap<String, [u8; 16]> {
    let mut out = HashMap::new();
    let mut rest = text;
    while let Some(at) = rest.find("uuid:") {
        rest = &rest[at + 5..];
        let Some(eq) = rest.find('=') else { break };
        let name = rest[..eq].trim_end();
        if name.is_empty() || name.chars().any(char::is_whitespace) {
            continue;
        }
        let value: String = rest[eq + 1..]
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .collect();
        if let Some(u) = parse_uuid(&value) {
            out.insert(name.to_string(), u);
        }
    }
    out
}

pub struct Gpt {
    /// LBA 0–33: protective MBR, header, entries.
    pub master: Vec<u8>,
    /// The last 33 sectors: entries, then the backup header.
    pub backup: Vec<u8>,
    pub backup_sector: u64,
}

fn put_u32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

fn put_u64(b: &mut [u8], o: usize, v: u64) {
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

pub fn build(
    partitions: &[ParamPartition],
    disk_sectors: u64,
    uuids: &HashMap<String, [u8; 16]>,
    rng: Rng<'_>,
) -> Result<Gpt, String> {
    if disk_sectors < 100 {
        return Err("implausible disk size".into());
    }
    if partitions.len() > GPT_ENTRIES {
        return Err("too many partitions for one GPT".into());
    }
    let mut m = vec![0u8; 34 * SECTOR_SIZE];

    // 1. protective MBR
    m[446 + 4] = 0xee;
    put_u32(&mut m, 446 + 8, 1);
    put_u32(&mut m, 446 + 12, 0xffff_ffff);
    m[510] = 0x55;
    m[511] = 0xaa;

    // 2. header at LBA 1
    let h = SECTOR_SIZE;
    m[h..h + 8].copy_from_slice(b"EFI PART");
    put_u32(&mut m, h + 8, 0x0001_0000);
    put_u32(&mut m, h + 12, HEADER_SIZE as u32);
    put_u64(&mut m, h + 24, 1);
    put_u64(&mut m, h + 32, disk_sectors - 1);
    put_u64(&mut m, h + 40, 34);
    put_u64(&mut m, h + 48, disk_sectors - 34);
    let disk_guid = random_uuid(rng);
    m[h + 56..h + 72].copy_from_slice(&disk_guid);
    put_u64(&mut m, h + 72, 2);
    put_u32(&mut m, h + 80, GPT_ENTRIES as u32);
    put_u32(&mut m, h + 84, GPT_ENTRY_SIZE as u32);

    // 3. entries from LBA 2
    let base = 2 * SECTOR_SIZE;
    for (i, p) in partitions.iter().enumerate() {
        let o = base + i * GPT_ENTRY_SIZE;
        let kind = random_uuid(rng);
        m[o..o + 16].copy_from_slice(&kind);
        let unique = match uuids.get(&p.name) {
            Some(u) => *u,
            None => random_uuid(rng),
        };
        m[o + 16..o + 32].copy_from_slice(&unique);
        let end = if p.grow {
            disk_sectors - 34
        } else {
            let sectors = p.sectors.ok_or_else(|| format!("partition {} has no size", p.name))?;
            (p.start_sector + sectors).saturating_sub(1)
        };
        if end >= disk_sectors {
            return Err(format!("partition {} runs past the end of the device", p.name));
        }
        put_u64(&mut m, o + 32, p.start_sector);
        put_u64(&mut m, o + 40, end);
        // The page writes charCodeAt as UTF-16LE: one code unit per character,
        // at most 36. Partition names are ASCII in every image there has been.
        for (j, unit) in p.name.encode_utf16().take(36).enumerate() {
            m[o + 56 + j * 2..o + 58 + j * 2].copy_from_slice(&unit.to_le_bytes());
        }
    }

    let entries_crc = crc32(&m[base..base + GPT_ENTRIES * GPT_ENTRY_SIZE]);
    put_u32(&mut m, h + 88, entries_crc);
    let header_crc = crc32(&m[h..h + HEADER_SIZE]);
    put_u32(&mut m, h + 16, header_crc);

    // 4. backup: 32 sectors of entries, then the header
    let mut b = vec![0u8; 33 * SECTOR_SIZE];
    b[..32 * SECTOR_SIZE].copy_from_slice(&m[base..base + 32 * SECTOR_SIZE]);
    let bh = 32 * SECTOR_SIZE;
    b[bh..bh + SECTOR_SIZE].copy_from_slice(&m[h..h + SECTOR_SIZE]);
    put_u64(&mut b, bh + 24, disk_sectors - 1);
    put_u64(&mut b, bh + 32, 1);
    put_u64(&mut b, bh + 72, disk_sectors - 34 + 1);
    put_u32(&mut b, bh + 16, 0);
    let backup_crc = crc32(&b[bh..bh + HEADER_SIZE]);
    put_u32(&mut b, bh + 16, backup_crc);

    Ok(Gpt {
        master: m,
        backup: b,
        backup_sector: disk_sectors - 33,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePartition {
    pub name: String,
    pub first_lba: u64,
    pub last_lba: u64,
    pub sectors: u64,
}

/// Read a GPT out of a device's first 34 sectors.
///
/// This is what a partition write is aimed with: the table the DEVICE has,
/// not offsets copied from a parameter file. The two agree on a factory unit,
/// and a unit flashed with something else, or not a PLAY at all, is exactly
/// where writing to a hard-coded sector does real damage. The header checksum
/// is checked before any offset in it is believed.
pub fn parse(lba0to33: &[u8]) -> Result<Vec<DevicePartition>, String> {
    if lba0to33.len() < 34 * SECTOR_SIZE {
        return Err("need the first 34 sectors to read a GPT".into());
    }
    let h = SECTOR_SIZE;
    if &lba0to33[h..h + 8] != b"EFI PART" {
        return Err("no GPT on this device (no EFI PART magic)".into());
    }
    let u32_at = |o: usize| u32::from_le_bytes([lba0to33[o], lba0to33[o + 1], lba0to33[o + 2], lba0to33[o + 3]]);
    let u64_at = |o: usize| {
        let mut a = [0u8; 8];
        a.copy_from_slice(&lba0to33[o..o + 8]);
        u64::from_le_bytes(a)
    };
    let header_size = u32_at(h + 12) as usize;
    if !(92..=SECTOR_SIZE).contains(&header_size) {
        return Err("implausible GPT header size".into());
    }
    let stored = u32_at(h + 16);
    let mut copy = lba0to33[h..h + header_size].to_vec();
    copy[16..20].fill(0);
    if crc32(&copy) != stored {
        return Err("GPT header checksum does not match".into());
    }
    let entry_lba = u64_at(h + 72) as usize;
    let count = u32_at(h + 80) as usize;
    let size = u32_at(h + 84) as usize;
    if size < 128 || count > 512 {
        return Err("implausible GPT entry table".into());
    }
    let mut out = Vec::new();
    for i in 0..count {
        let o = entry_lba * SECTOR_SIZE + i * size;
        if o + size > lba0to33.len() {
            break;
        }
        let first_lba = u64_at(o + 32);
        let last_lba = u64_at(o + 40);
        if first_lba == 0 && last_lba == 0 {
            continue;
        }
        let units: Vec<u16> = (0..36)
            .map(|j| u16::from_le_bytes([lba0to33[o + 56 + j * 2], lba0to33[o + 57 + j * 2]]))
            .take_while(|&c| c != 0)
            .collect();
        out.push(DevicePartition {
            name: String::from_utf16_lossy(&units),
            first_lba,
            last_lba,
            sectors: last_lba.saturating_sub(first_lba) + 1,
        });
    }
    Ok(out)
}
