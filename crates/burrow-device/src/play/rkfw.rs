//! RKFW, the Rockchip recovery image a PLAY is restored from (PLAY_1.0.30.img).
//!
//! ```text
//!   RKFW  ->  loader (MiniLoaderAll.bin)
//!         ->  RKAF  ->  partitions (parameter.txt, boot.img, rootfs.img, ...)
//! ```
//!
//! A port of the browser flasher's `rkfw.js`. Read lazily through a `Source`
//! so a 2.4 GB image is never held in memory. A partition whose flash address is
//! 0xFFFFFFFF is metadata, not something written to a sector: `package-file`
//! and `bootloader` are both marked that way, and writing them to sector −1
//! would be a very bad day.

use super::source::{Slice, Source};
use serde::Serialize;
use std::sync::Arc;

const NOT_FLASHED: u32 = 0xffff_ffff;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    pub name: String,
    pub file: String,
    pub size: u64,
    /// Destination sector on the eMMC.
    pub flash_addr: u32,
    /// Where the bytes live in the image.
    pub offset: u64,
    pub flashed: bool,
}

pub struct Rkfw {
    pub source: Arc<dyn Source>,
    pub chip: String,
    pub built: String,
    pub model: String,
    pub id: String,
    pub manufacturer: String,
    pub loader_offset: u64,
    pub loader_size: u64,
    pub partitions: Vec<Partition>,
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    // latin1, as the page decodes it: every byte is a character.
    b[..end].iter().map(|&c| c as char).collect()
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn parse(source: Arc<dyn Source>) -> Result<Rkfw, String> {
    if source.len() < 0x66 {
        return Err("too small to be a recovery image".into());
    }
    let head = source.read_at(0, 0x66)?;
    if &head[0..4] != b"RKFW" {
        return Err("not a Rockchip recovery image (no RKFW header)".into());
    }
    let built = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        u16_at(&head, 0x0e),
        head[0x10],
        head[0x11],
        head[0x12],
        head[0x13],
        head[0x14]
    );
    let chip = cstr(&head[0x15..0x19]);
    let loader_offset = u32_at(&head, 0x19) as u64;
    let loader_size = u32_at(&head, 0x1d) as u64;
    let image_offset = u32_at(&head, 0x21) as u64;

    if image_offset + 0x2000 > source.len() {
        return Err("the inner image runs past the end of the file".into());
    }
    let af = source.read_at(image_offset, 0x2000)?;
    if &af[0..4] != b"RKAF" {
        return Err("the inner image is not RKAF".into());
    }
    let model = cstr(&af[0x08..0x08 + 34]).trim().to_string();
    let id = cstr(&af[0x2a..0x2a + 30]).trim().to_string();
    let manufacturer = cstr(&af[0x48..0x48 + 56]).trim().to_string();
    let count = i32::from_le_bytes([af[0x88], af[0x89], af[0x8a], af[0x8b]]);
    if !(0..=64).contains(&count) {
        return Err(format!("implausible RKAF partition count {count}"));
    }
    let mut partitions = Vec::new();
    for i in 0..count as usize {
        let o = 0x8c + i * 112;
        let size = u32_at(&af, o + 108) as u64;
        let flash_addr = u32_at(&af, o + 100);
        let offset = image_offset + u32_at(&af, o + 96) as u64;
        if offset + size > source.len() {
            return Err(format!("partition {} runs past the end of the image", cstr(&af[o..o + 32])));
        }
        partitions.push(Partition {
            name: cstr(&af[o..o + 32]),
            file: cstr(&af[o + 32..o + 92]),
            size,
            flash_addr,
            offset,
            flashed: flash_addr != NOT_FLASHED && size > 0,
        });
    }
    if loader_offset + loader_size > source.len() {
        return Err("the loader runs past the end of the image".into());
    }
    Ok(Rkfw {
        source,
        chip,
        built,
        model,
        id,
        manufacturer,
        loader_offset,
        loader_size,
        partitions,
    })
}

impl Rkfw {
    pub fn partition(&self, name: &str) -> Option<&Partition> {
        self.partitions.iter().find(|p| p.name == name)
    }

    /// The loader, read whole: about 190 KB.
    pub fn loader(&self) -> Result<Vec<u8>, String> {
        self.source.read_at(self.loader_offset, self.loader_size as usize)
    }

    pub fn partition_source(&self, p: &Partition) -> Arc<dyn Source> {
        Arc::new(Slice {
            inner: self.source.clone(),
            offset: p.offset,
            len: p.size,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamPartition {
    pub name: String,
    pub grow: bool,
    pub start_sector: u64,
    /// None for the partition that grows to the end of the device.
    pub sectors: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct Parameter {
    pub raw: String,
    pub kind: Option<String>,
    pub partitions: Vec<ParamPartition>,
}

/// `parameter.txt` carries the partition table as an mtdparts CMDLINE. The RKAF
/// says where each image is written, but only this says how big each partition
/// is — which is what makes the gap at the end of rootfs (3.5 GiB partition,
/// 2.235 GiB filesystem) visible and so usable.
pub fn parse_parameter(text: &str) -> Parameter {
    let mut out = Parameter {
        raw: text.to_string(),
        ..Default::default()
    };
    let mut cmdline = String::new();
    for line in text.split('\n') {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(':') {
            if !key.is_empty() && key.bytes().all(|c| c.is_ascii_uppercase() || c == b'_') {
                match key {
                    "TYPE" => out.kind = Some(value.trim().to_string()),
                    "CMDLINE" => cmdline = value.trim().to_string(),
                    _ => {}
                }
            }
        }
    }
    let Some(at) = cmdline.find("mtdparts=") else {
        return out;
    };
    let rest = &cmdline[at + "mtdparts=".len()..];
    let Some((_, specs)) = rest.split_once(':') else {
        return out;
    };
    // 0x00020000@0x0000a000(boot): size@offset(name), both in 512-byte
    // sectors. A size of '-' means "to the end of the device".
    for spec in specs.split(',') {
        let spec = spec.trim();
        let Some((size, rest)) = spec.split_once('@') else { continue };
        let Some((start, rest)) = rest.split_once('(') else { continue };
        let Some((name, _)) = rest.split_once(')') else { continue };
        let Some(start) = parse_hex(start) else { continue };
        let grow_size = size == "-";
        let sectors = if grow_size {
            None
        } else {
            match parse_hex(size) {
                Some(n) => Some(n),
                None => continue,
            }
        };
        out.partitions.push(ParamPartition {
            name: name.trim_end_matches(":grow").to_string(),
            grow: grow_size || name.ends_with(":grow"),
            start_sector: start,
            sectors,
        });
    }
    out
}

fn parse_hex(s: &str) -> Option<u64> {
    u64::from_str_radix(s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?, 16).ok()
}
