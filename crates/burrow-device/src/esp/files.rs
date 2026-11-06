//! From files a person hands Burrow to a plan: each is placed by what it is,
//! never by what it is called. The Stoatworks Flasher's `src/files.ts`.
//!
//! A release zip does not come through here. The shell unpacks it and
//! [`super::package::open_package_dir`] reads it as a package.

use super::chips;
use super::image::{boot_partition, identify, otadata_partition, parse_offset, ImageInfo, Partition};
use super::plan::PlannedWrite;

/// One file of "your own build", with where it goes.
#[derive(Debug, Clone)]
pub struct LooseFile {
    pub name: String,
    pub data: Vec<u8>,
    pub info: ImageInfo,
    /// Where its kind belongs, or None when nothing says.
    pub placed: Option<u32>,
    /// What the person typed instead, if anything.
    pub typed: String,
}

/// Where each loose file goes. A bootloader goes to its chip's offset, a table
/// to the table offset, a whole-flash image to 0x0; an app and otadata go where
/// the partition table says: the one among the files if there is one, else the
/// unit's.
pub fn place_files(files: Vec<(String, Vec<u8>)>, unit_table: Option<&[Partition]>, table_offset: u32) -> Vec<LooseFile> {
    let infos: Vec<(String, Vec<u8>, ImageInfo)> = files
        .into_iter()
        .map(|(name, data)| {
            let info = identify(&data);
            (name, data, info)
        })
        .collect();
    let own: Option<Vec<Partition>> = infos.iter().find_map(|(_, _, i)| match i {
        ImageInfo::PartitionTable { partitions } => Some(partitions.clone()),
        _ => None,
    });
    let table: Option<&[Partition]> = own.as_deref().or(unit_table);
    infos
        .into_iter()
        .map(|(name, data, info)| {
            let placed = match &info {
                ImageInfo::Merged { .. } => Some(0),
                ImageInfo::Bootloader { chip_id } => chips::by_image_id(*chip_id).map(|c| c.bootloader),
                ImageInfo::PartitionTable { .. } => Some(table_offset),
                ImageInfo::App { .. } => table.and_then(boot_partition).map(|p| p.offset),
                ImageInfo::Otadata => table.and_then(otadata_partition).map(|p| p.offset),
                ImageInfo::Unknown { .. } => None,
            };
            LooseFile { name, data, info, placed, typed: String::new() }
        })
        .collect()
}

/// The writes for a set of loose files, or the files still waiting for an offset.
#[derive(Debug, Clone, Default)]
pub struct LooseWrites {
    pub writes: Vec<PlannedWrite>,
    pub unplaced: Vec<String>,
    pub bad_typing: Vec<String>,
}

pub fn loose_writes(files: &[LooseFile], table: Option<&[Partition]>) -> LooseWrites {
    let mut out = LooseWrites::default();
    for f in files {
        if !f.typed.trim().is_empty() {
            match parse_offset(&f.typed, table) {
                None => out.bad_typing.push(f.name.clone()),
                Some(at) => out.writes.push(PlannedWrite {
                    name: f.name.clone(),
                    offset: at,
                    data: f.data.clone(),
                    raw: matches!(f.info, ImageInfo::Unknown { .. }),
                }),
            }
        } else if let Some(at) = f.placed {
            out.writes.push(PlannedWrite::new(f.name.clone(), at, f.data.clone()));
        } else {
            out.unplaced.push(f.name.clone());
        }
    }
    out
}

/// The table a set of loose files leaves: their own if one of them is a table,
/// else the unit's.
pub fn loose_table<'a>(files: &'a [LooseFile], unit_table: Option<&'a [Partition]>) -> Option<&'a [Partition]> {
    files
        .iter()
        .find_map(|f| match &f.info {
            ImageInfo::PartitionTable { partitions } => Some(partitions.as_slice()),
            _ => None,
        })
        .or(unit_table)
}

/// The chip a set of writes was built for, from the first image that says.
pub fn chip_of(writes: &[PlannedWrite]) -> Option<&'static chips::Chip> {
    for c in super::plan::components(writes, chips::DEFAULT_TABLE_OFFSET) {
        match c.info {
            ImageInfo::App { chip_id, .. } | ImageInfo::Bootloader { chip_id } => return chips::by_image_id(chip_id),
            _ => {}
        }
    }
    None
}

/// A zip, by its first four bytes.
pub fn is_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04")
}
