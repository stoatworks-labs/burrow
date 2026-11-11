//! The only CANary code that touches a serial port. Thin on purpose: espflash
//! does the protocol, this decides what is allowed to reach it.
//!
//! Every call blocks. The shell runs them on a blocking thread, one unit at a
//! time.

use super::image::{
    active_ota_slot, identify, ota_slot_offset, parse_partition_table, AppDescription, ImageInfo,
    Partition, OTADATA, OTADATA_LEN, PARTITION_TABLE,
};
use super::plan::{check_device, check_plan, CheckOptions, DeviceFacts, PlannedWrite};
use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::{FlashSize, Flasher};
use espflash::image_format::Segment;
use espflash::target::{Chip, ProgressCallbacks};
use md5::{Digest, Md5};
use serde::Serialize;
use serialport::{FlowControl, SerialPortType, UsbPortInfo};

/// Espressif's USB vendor ID. The S3's built-in USB-Serial-JTAG enumerates as
/// 303a:1001, which is the only port a CANary has: rev A fits no USB-UART
/// bridge.
pub const ESPRESSIF_VID: u16 = 0x303a;
pub const USB_SERIAL_JTAG_PID: u16 = 0x1001;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    /// The S3's own USB port, which resets into the ROM by itself. Anything
    /// else is a bridge and gets the classic DTR/RTS sequence.
    pub usb_serial_jtag: bool,
}

/// Serial ports a CANary could be on: Espressif's VID only, unless `all`.
///
/// On macOS each device appears twice, as `/dev/tty.*` and `/dev/cu.*`. Only
/// `cu` is offered: opening `tty` waits for carrier detect, which a USB CDC port
/// never raises, so it hangs rather than fails.
pub fn list_ports(all: bool) -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("could not list serial ports: {e}"))?;
    let mut out: Vec<PortInfo> = ports
        .into_iter()
        .filter(|p| !(cfg!(target_os = "macos") && p.port_name.starts_with("/dev/tty.")))
        .map(|p| match p.port_type {
            SerialPortType::UsbPort(u) => PortInfo {
                usb_serial_jtag: u.vid == ESPRESSIF_VID && u.pid == USB_SERIAL_JTAG_PID,
                name: p.port_name,
                vid: Some(u.vid),
                pid: Some(u.pid),
                product: u.product,
                serial_number: u.serial_number,
            },
            _ => PortInfo {
                name: p.port_name,
                vid: None,
                pid: None,
                product: None,
                serial_number: None,
                usb_serial_jtag: false,
            },
        })
        .filter(|p| all || p.vid == Some(ESPRESSIF_VID))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// What the bootloader will boot, read off the unit's own flash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub slot: u32,
    pub offset: u32,
    /// None when the slot holds no app image: blank, erased, or not ESP-IDF.
    pub app: Option<AppDescription>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    pub port: String,
    pub facts: DeviceFacts,
    pub mac: Option<String>,
    pub flash_label: String,
    pub partitions: Option<Vec<Partition>>,
    pub running: Option<Running>,
    /// Reasons this unit must not be written, whatever is chosen for it.
    pub problems: Vec<String>,
}

impl Description {
    /// True when the unit boots something that is not a CANary build, or boots
    /// nothing readable. Not a refusal: a blank board is how every CANary
    /// starts. It is what the confirmation has to say out loud.
    pub fn runs_something_else(&self) -> bool {
        match self.running.as_ref().and_then(|r| r.app.as_ref()) {
            Some(app) => !super::image::APP_PROJECTS.contains(&app.project.as_str()),
            None => true,
        }
    }
}

/// Where a write has got to, for the progress strip.
#[derive(Debug, Clone, Copy)]
pub enum Stage {
    Erasing,
    Writing { done: u64, total: u64 },
    Verifying { done: u64, total: u64 },
}

pub struct Unit {
    flasher: Flasher,
    port: PortInfo,
}

fn chip_label(chip: Chip) -> String {
    let s = chip.to_string(); // "esp32s3"
    match s.strip_prefix("esp32") {
        Some("") | None => "ESP32".into(),
        Some(rest) => format!("ESP32-{}", rest.to_uppercase()),
    }
}

fn flash_bytes(size: FlashSize) -> Option<u64> {
    // espflash spells sizes in its serde names ("8MB", "512KB"); there is no
    // public byte count, and matching variants would break on the next one.
    let label = serde_json::to_value(size).ok()?.as_str()?.to_string();
    let (n, unit) = label.split_at(label.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = n.parse().ok()?;
    match unit {
        "KB" => Some(n * 1024),
        "MB" => Some(n * 1024 * 1024),
        _ => None,
    }
}

fn open_connection(port: &PortInfo) -> Result<Connection, String> {
    let serial = serialport::new(&port.name, 115_200)
        .flow_control(FlowControl::None)
        .open_native()
        .map_err(|e| format!("could not open {}: {e}", port.name))?;
    let info = UsbPortInfo {
        vid: port.vid.unwrap_or(0),
        pid: port.pid.unwrap_or(0),
        serial_number: port.serial_number.clone(),
        manufacturer: None,
        product: port.product.clone(),
    };
    let before = if port.usb_serial_jtag {
        ResetBeforeOperation::UsbReset
    } else {
        ResetBeforeOperation::DefaultReset
    };
    Ok(Connection::new(serial, info, ResetAfterOperation::HardReset, before, 115_200))
}

impl Unit {
    /// Reset the unit into its ROM and load the stub. Opening the port alone
    /// resets a USB-Serial-JTAG unit, so there is no such thing as a look that
    /// does not reboot it — the interface says so before the first one.
    ///
    /// 921600 first, and 115200 if the faster rate does not hold. Over the S3's
    /// own USB the number is nominal anyway.
    pub fn open(port: &PortInfo) -> Result<Unit, String> {
        let first = Flasher::connect(open_connection(port)?, true, true, false, None, Some(921_600));
        let flasher = match first {
            Ok(f) => f,
            Err(_) => Flasher::connect(open_connection(port)?, true, true, false, None, None)
                .map_err(|e| format!("could not talk to the unit on {}: {e}", port.name))?,
        };
        Ok(Unit {
            flasher,
            port: port.clone(),
        })
    }

    fn read(&mut self, offset: u32, len: u32) -> Result<Vec<u8>, String> {
        let tmp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        self.flasher
            .read_flash(offset, len, 0x1000, 64, tmp.path().to_path_buf())
            .map_err(|e| format!("reading 0x{offset:x}: {e}"))?;
        std::fs::read(tmp.path()).map_err(|e| e.to_string())
    }

    pub fn describe(&mut self) -> Result<Description, String> {
        let info = self.flasher.device_info().map_err(|e| e.to_string())?;
        let chip = chip_label(info.chip);
        // The S2 and later answer GET_SECURITY_INFO; a classic ESP32 does not,
        // and is refused on its chip anyway.
        let (secure_boot, flash_encryption) = if info.chip == Chip::Esp32 {
            (false, false)
        } else {
            let s = self.flasher.security_info().map_err(|e| e.to_string())?;
            // flash_crypt_cnt counts toggles: encryption is on when an odd
            // number of its bits are set.
            (s.flags & 1 != 0, s.flash_crypt_cnt.count_ones() % 2 == 1)
        };
        let facts = DeviceFacts {
            chip,
            flash_bytes: flash_bytes(info.flash_size),
            secure_boot,
            flash_encryption,
        };
        let problems = check_device(&facts);
        let flash_label = serde_json::to_value(info.flash_size)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".into());

        // What it boots. Read from its own partition table rather than assumed:
        // the flasher hard-codes CANary's slots, which is right for a CANary and
        // misleading for anything else plugged in.
        let (partitions, running) = if problems.iter().any(|p| p.contains("ESP32-S3")) {
            (None, None)
        } else {
            let table = parse_partition_table(&self.read(PARTITION_TABLE, 0xc00)?);
            let running = match &table {
                Some(t) => {
                    let (slot, _) = active_ota_slot(&self.read(OTADATA, OTADATA_LEN as u32)?);
                    match ota_slot_offset(t, slot) {
                        Some(offset) => {
                            let head = self.read(offset, 0x200)?;
                            let app = match identify(&head) {
                                ImageInfo::App { app, .. } => Some(app),
                                _ => None,
                            };
                            Some(Running { slot, offset, app })
                        }
                        None => None,
                    }
                }
                None => None,
            };
            (table, running)
        };

        Ok(Description {
            port: self.port.name.clone(),
            facts,
            mac: info.mac_address,
            flash_label,
            partitions,
            running,
            problems,
        })
    }

    /// Write, then check every region with a digest of our own.
    ///
    /// The gate runs again here against a fresh read of the unit, whatever the
    /// confirmation was drawn from. espflash verifies as it goes; the MD5 after
    /// is the check that does not depend on espflash having sent what we gave
    /// it, so a header patched on the way would fail rather than pass.
    pub fn write(
        &mut self,
        writes: &[PlannedWrite],
        erase_all: bool,
        allow_foreign: bool,
        on_stage: &mut dyn FnMut(Stage),
    ) -> Result<(), String> {
        let d = self.describe()?;
        if !d.problems.is_empty() {
            return Err(d.problems.join("; "));
        }
        let problems = check_plan(
            writes,
            CheckOptions {
                flash_bytes: d.facts.flash_bytes.unwrap_or(0),
                allow_foreign,
            },
        );
        if !problems.is_empty() {
            return Err(format!("will not write this: {}", problems.join("; ")));
        }

        if erase_all {
            on_stage(Stage::Erasing);
            self.flasher.erase_flash().map_err(|e| format!("erasing: {e}"))?;
        }

        let total: u64 = writes.iter().map(|w| w.data.len() as u64).sum();
        let segments: Vec<Segment<'_>> = writes.iter().map(|w| Segment::new(w.offset, &w.data)).collect();
        let mut progress = Progress {
            sizes: writes.iter().map(|w| w.data.len() as u64).collect(),
            index: 0,
            segment_total: 0,
            total,
            on_stage,
        };
        self.flasher
            .write_bins_to_flash(&segments, &mut progress)
            .map_err(|e| format!("writing: {e}"))?;
        let on_stage = progress.on_stage;

        let mut done = 0u64;
        on_stage(Stage::Verifying { done, total });
        for w in writes {
            let device = self
                .flasher
                .checksum_md5(w.offset, w.data.len() as u32)
                .map_err(|e| format!("checking {}: {e}", w.name))?;
            let ours = u128::from_be_bytes(Md5::digest(&w.data).into());
            if device != ours {
                return Err(format!("{} does not match what was sent", w.name));
            }
            done += w.data.len() as u64;
            on_stage(Stage::Verifying { done, total });
        }
        Ok(())
    }

    /// Reboot into whatever is on flash and let go of the port.
    pub fn restart(mut self) -> Result<(), String> {
        let chip = self.flasher.chip();
        self.flasher
            .connection()
            .reset_after(true, chip)
            .map_err(|e| format!("restarting: {e}"))
    }
}

/// espflash reports per segment in compressed bytes; the strip wants one bar
/// for the whole write in real bytes.
struct Progress<'a> {
    sizes: Vec<u64>,
    index: usize,
    segment_total: usize,
    total: u64,
    on_stage: &'a mut dyn FnMut(Stage),
}

impl Progress<'_> {
    fn before(&self) -> u64 {
        self.sizes[..self.index.min(self.sizes.len())].iter().sum()
    }
}

impl ProgressCallbacks for Progress<'_> {
    fn init(&mut self, _addr: u32, total: usize) {
        self.segment_total = total.max(1);
    }
    fn update(&mut self, current: usize) {
        let size = self.sizes.get(self.index).copied().unwrap_or(0);
        let done = self.before() + size * current as u64 / self.segment_total as u64;
        (self.on_stage)(Stage::Writing {
            done,
            total: self.total,
        });
    }
    fn verifying(&mut self) {}
    fn finish(&mut self, _skipped: bool) {
        self.index += 1;
        let done = self.before();
        (self.on_stage)(Stage::Writing {
            done,
            total: self.total,
        });
    }
}
