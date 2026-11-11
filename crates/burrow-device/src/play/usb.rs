//! The PLAY's Rockchip USB: the boot ROM's maskrom protocol and the loader's
//! CBW/CSW one. A port of the browser flasher's `rockusb.js` onto nusb.
//!
//! Every constant is from rkdeveloptool's source. Two are easy to get wrong and
//! neither fails loudly: the maskrom vendor request puts 0x0471/0x0472 in
//! wIndex with wValue 0, and dwAddress and usLength inside the CBWCB are
//! BIG-endian while the CBW around them is little-endian.
//!
//! Three things learned on a PLAY (2026-08-15, fleet notes) shape this file:
//!
//! - **The mode is probed with a read, not trusted from bcdUSB.** A loader-mode
//!   PLAY can report the maskrom bit, and pushing a loader into a running loader
//!   hangs it — after which the maskrom refuses a fresh 471 until power-cycled,
//!   and a healthy unit looks bricked.
//! - **The maskrom push claims nothing.** Those are control transfers to the
//!   device; claiming the interface first made 471 succeed and 472 time out
//!   every time.
//! - **The device re-enumerates once the loader runs**, so it is looked for
//!   again before the first loader command.

use super::crc::crc16_ccitt;
use super::plan::BlockDevice;
use super::rkboot::{self, ENTRY471, ENTRY472};
use nusb::descriptors::TransferType;
use nusb::transfer::{Buffer, Bulk, ControlOut, ControlType, Direction, In, Out, Recipient};
use nusb::{Device, DeviceInfo, Endpoint, Interface, MaybeFuture};
use serde::Serialize;
use std::time::{Duration, Instant};

pub const RK_VENDOR_ID: u16 = 0x2207;
pub const SECTOR_SIZE: usize = 512;

const CBW_SIGN: u32 = 0x4342_5355; // "USBC"
const CSW_SIGN: u32 = 0x5342_5355; // "USBS"

const OP_READ_LBA: u8 = 0x14;
const OP_WRITE_LBA: u8 = 0x15;
const OP_READ_FLASH_INFO: u8 = 0x1a;
const OP_DEVICE_RESET: u8 = 0xff;
/// Reset subcode the page sends, and the one that has rebooted a PLAY.
pub const RESET_MSC: u8 = 1;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
const BULK_TIMEOUT: Duration = Duration::from_secs(20);
/// The probe read is the one command expected to fail on a maskrom unit, so
/// it is the one with a short fuse.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Maskrom,
    Loader,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Stable for as long as the unit stays plugged in and in the same mode.
    pub key: String,
    pub product_id: u16,
    pub product: Option<String>,
    /// What bcdUSB says. A hint only: see the module comment.
    pub bcd_says: Mode,
    /// Windows only: the driver bound to it. nusb needs WinUSB, and Rockchip's
    /// own driver is not WinUSB.
    pub driver: Option<String>,
}

fn key(d: &DeviceInfo) -> String {
    format!("{:?}", d.id())
}

pub fn list() -> Result<Vec<Found>, String> {
    let devices = nusb::list_devices().wait().map_err(|e| format!("could not list USB devices: {e}"))?;
    Ok(devices
        .filter(|d| d.vendor_id() == RK_VENDOR_ID)
        .map(|d| Found {
            key: key(&d),
            product_id: d.product_id(),
            product: d.product_string().map(str::to_string),
            bcd_says: if d.usb_version() & 1 == 1 { Mode::Loader } else { Mode::Maskrom },
            #[cfg(target_os = "windows")]
            driver: d.driver().map(str::to_string),
            #[cfg(not(target_os = "windows"))]
            driver: None,
        })
        .collect())
}

/// The unit that `key` names, if it is still there.
pub fn find(key_wanted: &str) -> Result<Option<DeviceInfo>, String> {
    let devices = nusb::list_devices().wait().map_err(|e| e.to_string())?;
    Ok(devices.into_iter().find(|d| d.vendor_id() == RK_VENDOR_ID && key(d) == key_wanted))
}

/// Wait for any Rockchip device to appear, for as long as `timeout`. Used after
/// the loader push, when the unit re-enumerates and comes back under a new key.
pub fn wait_for_any(timeout: Duration) -> Result<Option<DeviceInfo>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let devices = nusb::list_devices().wait().map_err(|e| e.to_string())?;
        if let Some(d) = devices.into_iter().find(|d| d.vendor_id() == RK_VENDOR_ID) {
            return Ok(Some(d));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Whether a loader is answering: open it as a loader, read one sector, let go.
/// Success means loader mode; anything else is taken as maskrom.
pub fn probe_is_loader(info: &DeviceInfo) -> bool {
    match Loader::open_with(info, PROBE_TIMEOUT) {
        Ok(mut l) => l.read_lba(0x4000, 1).is_ok(),
        Err(_) => false,
    }
}

/// One maskrom vendor request: the data, CRC-16 appended big-endian, in
/// 4096-byte control transfers. The two padding cases come straight from
/// rkdeveloptool's RKU_DeviceRequest and exist so the CRC never lands astride a
/// packet boundary.
fn vendor_request(send: &mut dyn FnMut(&[u8]) -> Result<(), String>, data: &[u8]) -> Result<(), String> {
    let mut size = data.len();
    let mut send_pending = false;
    match size % 4096 {
        4095 => size += 1,
        4094 => send_pending = true,
        _ => {}
    }
    let mut buf = vec![0u8; size + 2];
    buf[..data.len()].copy_from_slice(data);
    let crc = crc16_ccitt(&buf[..size]);
    buf[size] = (crc >> 8) as u8;
    buf[size + 1] = crc as u8;
    for chunk in buf.chunks(4096) {
        send(chunk)?;
    }
    if send_pending {
        send(&[0])?;
    }
    Ok(())
}

/// The bytes the maskrom push sends, in order: every 471 entry, then every 472.
/// Separate from the USB so a test can check the framing.
pub fn maskrom_requests(loader: &[u8]) -> Result<Vec<(u16, Vec<u8>, u32)>, String> {
    let boot = rkboot::parse(loader)?;
    let mut out = Vec::new();
    for kind in [ENTRY471, ENTRY472] {
        for e in boot.entries.iter().filter(|e| e.kind == kind && !e.data.is_empty()) {
            let index = if kind == ENTRY471 { 0x0471 } else { 0x0472 };
            out.push((index, e.data.clone(), e.delay_ms.max(200)));
        }
    }
    if !out.iter().any(|r| r.0 == 0x0471) || !out.iter().any(|r| r.0 == 0x0472) {
        return Err("that loader has no DDR init (471) or no usbplug (472) entry".into());
    }
    Ok(out)
}

/// Push the image's own loader into a maskrom unit. The device re-enumerates
/// afterwards; the caller looks for it again.
pub fn push_loader(info: &DeviceInfo, loader: &[u8], on_step: &mut dyn FnMut(&str)) -> Result<(), String> {
    let requests = maskrom_requests(loader)?;
    let device = info.open().wait().map_err(|e| format!("could not open the unit: {e}"))?;
    let mut send = control_sender(&device)?;
    for (index, data, delay_ms) in requests {
        on_step(&format!("loader: 0x{index:04x}, {} bytes", data.len()));
        vendor_request(&mut |chunk| send(index, chunk), &data)
            .map_err(|e| format!("maskrom request 0x{index:04x} failed: {e}"))?;
        std::thread::sleep(Duration::from_millis(delay_ms as u64));
    }
    std::thread::sleep(Duration::from_millis(1000));
    Ok(())
}

type Sender = Box<dyn FnMut(u16, &[u8]) -> Result<(), String>>;

/// macOS and Linux send device control transfers with nothing claimed, which
/// is what the PLAY needs.
#[cfg(not(target_os = "windows"))]
fn control_sender(device: &Device) -> Result<Sender, String> {
    let device = device.clone();
    Ok(Box::new(move |index, data| {
        device
            .control_out(
                ControlOut {
                    control_type: ControlType::Vendor,
                    recipient: Recipient::Device,
                    request: 0x0c,
                    value: 0,
                    index,
                    data,
                },
                CONTROL_TIMEOUT,
            )
            .wait()
            .map_err(|e| e.to_string())
    }))
}

/// Windows (WinUSB) has no device-level control transfer: one must go through
/// a claimed interface. That is the claim rkdeveloptool never makes, so this
/// path is unproven, and the interface says so.
#[cfg(target_os = "windows")]
fn control_sender(device: &Device) -> Result<Sender, String> {
    let iface = device
        .claim_interface(0)
        .wait()
        .map_err(|e| format!("could not claim the unit (is WinUSB bound to it? Zadig does that): {e}"))?;
    Ok(Box::new(move |index, data| {
        iface
            .control_out(
                ControlOut {
                    control_type: ControlType::Vendor,
                    recipient: Recipient::Device,
                    request: 0x0c,
                    value: 0,
                    index,
                    data,
                },
                CONTROL_TIMEOUT,
            )
            .wait()
            .map_err(|e| e.to_string())
    }))
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashInfo {
    /// The eMMC's size in 512-byte sectors.
    pub sectors: u64,
}

/// One loader command, as the CBW carries it.
struct Cmd {
    opcode: u8,
    transfer_length: u32,
    address: u32,
    length: u16,
    sub_code: u8,
    data_in: bool,
    cb_len: u8,
}

impl Cmd {
    fn new(cb_len: u8) -> Cmd {
        Cmd { opcode: 0, transfer_length: 0, address: 0, length: 0, sub_code: 0, data_in: false, cb_len }
    }
}

/// A unit with a loader running: sector reads and writes over CBW/CSW.
pub struct Loader {
    _device: Device,
    _iface: Interface,
    ep_in: Endpoint<Bulk, In>,
    ep_out: Endpoint<Bulk, Out>,
    tag: u32,
    timeout: Duration,
}

impl Loader {
    pub fn open(info: &DeviceInfo) -> Result<Loader, String> {
        Self::open_with(info, BULK_TIMEOUT)
    }

    fn open_with(info: &DeviceInfo, timeout: Duration) -> Result<Loader, String> {
        let device = info.open().wait().map_err(|e| format!("could not open the unit: {e}"))?;
        let config = device.active_configuration().map_err(|e| e.to_string())?;
        let mut chosen = None;
        for iface in config.interfaces() {
            let alt = iface.first_alt_setting();
            let bulk = |dir: Direction| {
                alt.endpoints()
                    .find(|e| e.transfer_type() == TransferType::Bulk && e.direction() == dir)
                    .map(|e| e.address())
            };
            if let (Some(i), Some(o)) = (bulk(Direction::In), bulk(Direction::Out)) {
                chosen = Some((iface.interface_number(), i, o));
                break;
            }
        }
        let (number, ep_in, ep_out) = chosen.ok_or("no bulk endpoint pair on this unit")?;
        let iface = device
            .claim_interface(number)
            .wait()
            .map_err(|e| format!("could not claim the unit: {e}"))?;
        let ep_in = iface.endpoint::<Bulk, In>(ep_in).map_err(|e| e.to_string())?;
        let ep_out = iface.endpoint::<Bulk, Out>(ep_out).map_err(|e| e.to_string())?;
        Ok(Loader {
            _device: device,
            _iface: iface,
            ep_in,
            ep_out,
            tag: 1,
            timeout,
        })
    }

    fn cbw(&mut self, cmd: Cmd) -> ([u8; 31], u32) {
        let Cmd { opcode, transfer_length, address, length, sub_code, data_in, cb_len } = cmd;
        let mut c = [0u8; 31];
        let tag = self.tag;
        self.tag = self.tag.wrapping_add(1);
        c[0..4].copy_from_slice(&CBW_SIGN.to_le_bytes());
        c[4..8].copy_from_slice(&tag.to_le_bytes());
        c[8..12].copy_from_slice(&transfer_length.to_le_bytes());
        c[12] = if data_in { 0x80 } else { 0x00 };
        c[13] = 0; // LUN
        c[14] = cb_len;
        c[15] = opcode;
        c[16] = sub_code;
        c[17..21].copy_from_slice(&address.to_be_bytes());
        c[21] = 0;
        c[22..24].copy_from_slice(&length.to_be_bytes());
        (c, tag)
    }

    fn bulk_out(&mut self, data: &[u8]) -> Result<(), String> {
        let done = self.ep_out.transfer_blocking(Buffer::from(data), self.timeout);
        done.status.map_err(|e| e.to_string())
    }

    fn bulk_in(&mut self, len: usize) -> Result<Vec<u8>, String> {
        // An IN request must be a whole number of packets; a short packet ends
        // it early, which is how the 13-byte CSW and 11-byte info arrive.
        let mps = self.ep_in.max_packet_size().max(1);
        let req = len.div_ceil(mps).max(1) * mps;
        let done = self.ep_in.transfer_blocking(Buffer::new(req), self.timeout);
        done.status.map_err(|e| e.to_string())?;
        Ok(done.buffer.to_vec())
    }

    fn csw(&mut self, tag: u32) -> Result<(), String> {
        let d = self.bulk_in(13)?;
        if d.len() < 13 {
            return Err("short CSW".into());
        }
        if u32::from_le_bytes([d[0], d[1], d[2], d[3]]) != CSW_SIGN {
            return Err("bad CSW signature".into());
        }
        if u32::from_le_bytes([d[4], d[5], d[6], d[7]]) != tag {
            return Err("CSW tag mismatch".into());
        }
        if d[12] != 0 {
            return Err(format!("the unit reported a command failure (status {})", d[12]));
        }
        Ok(())
    }

    pub fn read_flash_info(&mut self) -> Result<FlashInfo, String> {
        let (c, tag) = self.cbw(Cmd { opcode: OP_READ_FLASH_INFO, transfer_length: 11, data_in: true, ..Cmd::new(6) });
        self.bulk_out(&c)?;
        let d = self.bulk_in(11)?;
        self.csw(tag)?;
        if d.len() < 4 {
            return Err("short flash info".into());
        }
        Ok(FlashInfo {
            sectors: u32::from_le_bytes([d[0], d[1], d[2], d[3]]) as u64,
        })
    }

    pub fn reset(&mut self, sub_code: u8) -> Result<(), String> {
        let (c, tag) = self.cbw(Cmd { opcode: OP_DEVICE_RESET, sub_code, ..Cmd::new(6) });
        self.bulk_out(&c)?;
        self.csw(tag)
    }
}

impl BlockDevice for Loader {
    fn read_lba(&mut self, sector: u64, count: u64) -> Result<Vec<u8>, String> {
        let bytes = count as usize * SECTOR_SIZE;
        let (c, tag) = self.cbw(Cmd {
            opcode: OP_READ_LBA,
            transfer_length: bytes as u32,
            address: sector as u32,
            length: count as u16,
            data_in: true,
            ..Cmd::new(10)
        });
        self.bulk_out(&c)?;
        let mut d = self.bulk_in(bytes)?;
        self.csw(tag)?;
        if d.len() < bytes {
            return Err(format!("short read: {} of {bytes} bytes", d.len()));
        }
        d.truncate(bytes);
        Ok(d)
    }

    fn write_lba(&mut self, sector: u64, bytes: &[u8]) -> Result<(), String> {
        if !bytes.len().is_multiple_of(SECTOR_SIZE) {
            return Err("LBA writes must be whole sectors".into());
        }
        let count = (bytes.len() / SECTOR_SIZE) as u16;
        let (c, tag) = self.cbw(Cmd {
            opcode: OP_WRITE_LBA,
            transfer_length: bytes.len() as u32,
            address: sector as u32,
            length: count,
            ..Cmd::new(10)
        });
        self.bulk_out(&c)?;
        self.bulk_out(bytes)?;
        self.csw(tag)
    }
}
