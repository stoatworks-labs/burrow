//! The one gate every CANary write goes through.
//!
//! `check_plan` is the flasher's `checkPlan`, rule for rule and message for
//! message. `check_device` adds what the page left to the README and never
//! enforced: the chip, the 8 MB, and secure boot or flash encryption, either of
//! which turns a plain write into one the unit refuses to boot.
//!
//! Both are run when the confirmation is drawn and again, against a fresh read
//! of the unit, immediately before the first byte goes out. A board swapped
//! between the two is a different board.

use super::image::{
    chip_name, identify, ImageInfo, APP, APP_PROJECTS, BOOTLOADER, CHIP_ID_ESP32S3, OTADATA,
    OTADATA_LEN,
};
use serde::Serialize;

/// What a CANary needs. The partition table ends at 0x3E0000 and a 4 MB part
/// would hold every image the flasher has ever shipped, so this is not about
/// fitting. It is about the board being the board the firmware was built for.
pub const CANARY_FLASH_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct PlannedWrite {
    pub name: String,
    pub offset: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CheckOptions {
    pub flash_bytes: u64,
    /// Lets an app that is not a CANary build through. A deliberate override
    /// for someone writing their own build, never a default.
    pub allow_foreign: bool,
}

/// Everything that must be true of the files before they go near a unit. Empty
/// when they may.
pub fn check_plan(writes: &[PlannedWrite], opts: CheckOptions) -> Vec<String> {
    let mut problems = Vec::new();
    if writes.is_empty() {
        problems.push("nothing to write".to_string());
    }
    let mut sorted: Vec<&PlannedWrite> = writes.iter().collect();
    sorted.sort_by_key(|w| w.offset);
    for (i, w) in sorted.iter().enumerate() {
        let end = w.offset as u64 + w.data.len() as u64;
        if w.offset % 0x1000 != 0 {
            problems.push(format!(
                "{}: offset 0x{:x} is not on a 4 KB sector boundary",
                w.name, w.offset
            ));
        }
        if end > opts.flash_bytes {
            problems.push(format!("{}: runs past the end of flash", w.name));
        }
        if let Some(next) = sorted.get(i + 1) {
            if end > next.offset as u64 {
                problems.push(format!("{} overlaps {}", w.name, next.name));
            }
        }
        let info = identify(&w.data);
        if let ImageInfo::App { chip_id, .. } | ImageInfo::Bootloader { chip_id } = &info {
            if *chip_id != CHIP_ID_ESP32S3 {
                problems.push(format!(
                    "{}: built for {}, and a CANary is an ESP32-S3",
                    w.name,
                    chip_name(*chip_id)
                ));
            }
        }
        match &info {
            ImageInfo::App { app, .. } => {
                if !APP_PROJECTS.contains(&app.project.as_str()) && !opts.allow_foreign {
                    problems.push(format!(
                        "{}: this is \"{}\", not a CANary build",
                        w.name, app.project
                    ));
                }
                if w.offset < APP {
                    problems.push(format!(
                        "{}: an app image below 0x{:x} would overwrite the bootloader or partition table",
                        w.name, APP
                    ));
                }
            }
            ImageInfo::Bootloader { .. } if w.offset != BOOTLOADER => {
                problems.push(format!("{}: a bootloader only boots from 0x0", w.name));
            }
            _ => {}
        }
    }
    problems
}

/// A lone app image boots only if otadata points at the slot it went into.
/// When a plan writes an app to ota_0 and says nothing about otadata, add a
/// blank one — the bootloader reads that as "boot ota_0". Without it a unit
/// that last updated over the air keeps booting ota_1, and the write looks as
/// though it did nothing.
pub fn with_otadata_reset(mut writes: Vec<PlannedWrite>) -> (Vec<PlannedWrite>, bool) {
    let has_app0 = writes.iter().any(|w| w.offset == APP);
    let has_otadata = writes.iter().any(|w| w.offset == OTADATA);
    if !has_app0 || has_otadata {
        return (writes, false);
    }
    writes.push(PlannedWrite {
        name: "otadata (blank, so it boots ota_0)".into(),
        offset: OTADATA,
        data: vec![0xff; OTADATA_LEN],
    });
    (writes, true)
}

/// What a connected unit told us about itself, as far as the gate cares.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFacts {
    pub chip: String,
    /// None when the flash size could not be read. Treated as a refusal, not as
    /// "probably 8 MB": the page assumed 8 MB in one place and 0 in another.
    pub flash_bytes: Option<u64>,
    pub secure_boot: bool,
    pub flash_encryption: bool,
}

/// Reasons this unit must not be written at all, whatever the files.
pub fn check_device(d: &DeviceFacts) -> Vec<String> {
    let mut problems = Vec::new();
    if d.chip != "ESP32-S3" {
        problems.push(format!("this is an {}; a CANary is an ESP32-S3", d.chip));
    }
    match d.flash_bytes {
        None => problems.push("could not read how much flash this unit has".into()),
        Some(n) if n < CANARY_FLASH_BYTES => problems.push(format!(
            "this unit has {} MB of flash, and a CANary has 8 MB",
            n / (1024 * 1024)
        )),
        Some(_) => {}
    }
    if d.secure_boot {
        problems.push("secure boot is on, and CANary firmware is not signed for it".into());
    }
    if d.flash_encryption {
        problems.push(
            "flash encryption is on, so plain firmware written to it would not boot".into(),
        );
    }
    problems
}
