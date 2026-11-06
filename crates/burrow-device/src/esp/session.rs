//! The only ESP32 code that touches a serial port. Thin on purpose: espflash
//! does the protocol, this decides what is allowed to reach it. The Stoatworks
//! Flasher's `src/flash.ts`, with espflash where the page has esptool-js.
//!
//! Every call blocks. The shell runs them on a blocking thread, one unit at a
//! time.

use super::chips::{self, SERIAL_VIDS};
use super::image::{
    active_ota_slot, boot_partition, identify, ota_slot, ota_slot_count, otadata_partition, parse_partition_table,
    AppDescription, ImageInfo, Partition,
};
use super::plan::{check_plan, replace_text, unit_problems, PlanContext, PlannedWrite, UnitFacts, Want};
use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};
use espflash::flasher::{FlashSize, Flasher};
use espflash::image_format::Segment;
use espflash::target::{Chip, ProgressCallbacks};
use md5::{Digest, Md5};
use serde::Serialize;
use serialport::{FlowControl, SerialPortType, UsbPortInfo};

/// Espressif's USB vendor ID, and the product ID of the USB-Serial/JTAG
/// peripheral the S3, C3, C6 and later have built in. That port resets into
/// the ROM by itself; a bridge chip needs the DTR/RTS sequence.
pub const ESPRESSIF_VID: u16 = 0x303a;
pub const USB_SERIAL_JTAG_PID: u16 = 0x1001;

/// The flashing speed unless the device says otherwise. Over USB-Serial/JTAG
/// the number is nominal.
pub const DEFAULT_BAUD: u32 = 921_600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub usb_serial_jtag: bool,
}

/// Serial ports an ESP32 could be on: Espressif's own USB and the usual
/// USB-to-UART bridges (CP210x, CH34x, FTDI), unless `all`.
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
                manufacturer: u.manufacturer,
                serial_number: u.serial_number,
            },
            _ => PortInfo {
                name: p.port_name,
                vid: None,
                pid: None,
                product: None,
                manufacturer: None,
                serial_number: None,
                usb_serial_jtag: false,
            },
        })
        .filter(|p| all || p.vid.is_some_and(|v| SERIAL_VIDS.contains(&v)))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// What the bootloader will boot, read off the unit's own flash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    /// The partition's label: factory, ota_0, ota_1 …
    pub partition: String,
    pub offset: u32,
    /// None when the partition holds no app image: blank, erased, or not ESP-IDF.
    pub app: Option<AppDescription>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    pub port: String,
    pub facts: UnitFacts,
    pub mac: Option<String>,
    /// Where the table was looked for.
    pub table_offset: u32,
    /// The unit's partition table, if it has one Burrow can read.
    pub table: Option<Vec<Partition>>,
    pub running: Option<Running>,
    /// Reasons this unit must not be written, whatever is chosen for it.
    pub problems: Vec<String>,
}

/// What a write asks of the unit, checked against a fresh read of it.
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub erase_all: bool,
    /// Project names an app must carry; None for your own file.
    pub projects: Option<Vec<String>>,
    /// The chip the firmware was chosen for; a different unit is refused.
    pub expect_chip: Option<String>,
    /// The least flash the firmware's device has.
    pub min_flash: Option<u64>,
    /// The device's name, for the messages.
    pub name: Option<String>,
    pub table_offset: u32,
    /// The person ticked "replace it" for a unit running something else.
    pub confirm_replace: bool,
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
    chips::chip_label(&chip.to_string())
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
        manufacturer: port.manufacturer.clone(),
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
    /// resets a USB-Serial/JTAG unit, so there is no such thing as a look that
    /// does not reboot it — the interface says so before the first one.
    ///
    /// `baud` (the device's, else 921600) first, and 115200 if that does not
    /// hold: a fly-wired adapter may not carry the faster rate.
    pub fn open(port: &PortInfo, baud: Option<u32>) -> Result<Unit, String> {
        let first = Flasher::connect(
            open_connection(port)?,
            true,
            true,
            false,
            None,
            Some(baud.unwrap_or(DEFAULT_BAUD)),
        );
        let flasher = match first {
            Ok(f) => f,
            Err(_) => Flasher::connect(open_connection(port)?, true, true, false, None, None)
                .map_err(|e| format!("could not talk to the unit on {}: {e}", port.name))?,
        };
        Ok(Unit { flasher, port: port.clone() })
    }

    fn read(&mut self, offset: u32, len: u32) -> Result<Vec<u8>, String> {
        let tmp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        self.flasher
            .read_flash(offset, len, 0x1000, 64, tmp.path().to_path_buf())
            .map_err(|e| format!("reading 0x{offset:x}: {e}"))?;
        std::fs::read(tmp.path()).map_err(|e| e.to_string())
    }

    /// The chip, its flash, its partition table at `table_offset`, and what it
    /// boots: through otadata when the table has one, else the boot partition.
    pub fn describe(&mut self, table_offset: u32) -> Result<Description, String> {
        let info = self.flasher.device_info().map_err(|e| e.to_string())?;
        // The S2 and later answer GET_SECURITY_INFO; a classic ESP32 does not.
        // Its eFuses could still say secure boot, which this does not read: a
        // gap the page has too.
        let (secure_boot, flash_encryption) = if info.chip == Chip::Esp32 {
            (false, false)
        } else {
            let s = self.flasher.security_info().map_err(|e| e.to_string())?;
            // flash_crypt_cnt counts toggles: encryption is on when an odd
            // number of its bits are set.
            (s.flags & 1 != 0, s.flash_crypt_cnt.count_ones() % 2 == 1)
        };
        let facts = UnitFacts {
            chip_name: chip_label(info.chip),
            flash_bytes: flash_bytes(info.flash_size),
            flash_label: serde_json::to_value(info.flash_size)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".into()),
            secure_boot,
            flash_encryption,
        };
        let problems = unit_problems(&facts, &Want::default());

        // A blank or foreign unit has nothing to say here; that is not an error.
        let table = self
            .read(table_offset, chips::TABLE_SIZE)
            .ok()
            .and_then(|b| parse_partition_table(&b));
        let running = match &table {
            Some(t) => self.running(t).ok().flatten(),
            None => None,
        };

        Ok(Description {
            port: self.port.name.clone(),
            facts,
            mac: info.mac_address,
            table_offset,
            table,
            running,
            problems,
        })
    }

    fn running(&mut self, table: &[Partition]) -> Result<Option<Running>, String> {
        let mut part = boot_partition(table);
        if let Some(ota) = otadata_partition(table) {
            let otadata = self.read(ota.offset, ota.size.min(0x2000))?;
            let (slot, seq) = active_ota_slot(&otadata, ota_slot_count(table));
            if seq.is_some() {
                part = ota_slot(table, slot).or(part);
            }
        }
        let Some(part) = part else { return Ok(None) };
        let head = self.read(part.offset, 0x200)?;
        let app = match identify(&head) {
            ImageInfo::App { app, .. } => Some(app),
            _ => None,
        };
        Ok(Some(Running { partition: part.label.clone(), offset: part.offset, app }))
    }

    /// Write, then check every region with a digest of our own.
    ///
    /// The gate runs again here against a fresh read of the unit, whatever the
    /// confirmation was drawn from. espflash verifies as it goes; the MD5 after
    /// is the check that does not depend on espflash having sent what we gave
    /// it, so a header patched on the way would fail rather than pass.
    pub fn write(&mut self, writes: &[PlannedWrite], opts: &WriteOptions, on_stage: &mut dyn FnMut(Stage)) -> Result<(), String> {
        let d = self.describe(opts.table_offset)?;
        let refused = unit_problems(
            &d.facts,
            &Want { chip: opts.expect_chip.as_deref(), min_flash: opts.min_flash, name: opts.name.as_deref() },
        );
        if !refused.is_empty() {
            return Err(refused.join("; "));
        }
        let chip = d.facts.chip().ok_or("this unit's chip is not one Burrow flashes")?;
        let ctx = PlanContext {
            chip,
            flash_bytes: d.facts.flash_bytes.unwrap_or(0),
            projects: opts.projects.as_deref(),
            unit_table: d.table.as_deref(),
            table_offset: opts.table_offset,
        };
        let problems = check_plan(writes, &ctx);
        if !problems.is_empty() {
            return Err(format!("will not write this: {}", problems.join("; ")));
        }
        let running = d.running.as_ref().and_then(|r| r.app.as_ref());
        if let Some(text) = replace_text(running, writes, opts.projects.as_deref()) {
            if !opts.confirm_replace {
                return Err(format!("{text} Tick the box to replace the firmware it runs."));
            }
        }

        if opts.erase_all {
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
        (self.on_stage)(Stage::Writing { done, total: self.total });
    }
    fn verifying(&mut self) {}
    fn finish(&mut self, _skipped: bool) {
        self.index += 1;
        let done = self.before();
        (self.on_stage)(Stage::Writing { done, total: self.total });
    }
}
