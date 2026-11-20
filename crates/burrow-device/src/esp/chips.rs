//! The ESP32 family as far as flashing cares: what each chip is called, the id
//! its images carry, and where its bootloader goes.
//!
//! The Stoatworks Flasher's `src/chips.ts`, entry for entry. `name` is
//! esptool's `CHIP_NAME`, which is also what [`chip_label`] makes of espflash's
//! chip, so a unit and a package can be compared as strings. `image_id` is
//! `esp_chip_id_t`, bytes 12–13 of every ESP-IDF image's extended header.
//! `bootloader` is the chip's `BOOTLOADER_FLASH_OFFSET`: the classic ESP32 and
//! the S2 boot from 0x1000, the C5, P4 and H4 from 0x2000, the rest from 0x0.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chip {
    pub name: &'static str,
    pub image_id: u16,
    pub bootloader: u32,
}

pub const CHIPS: &[Chip] = &[
    Chip { name: "ESP32", image_id: 0, bootloader: 0x1000 },
    Chip { name: "ESP32-S2", image_id: 2, bootloader: 0x1000 },
    Chip { name: "ESP32-C3", image_id: 5, bootloader: 0x0 },
    Chip { name: "ESP32-S3", image_id: 9, bootloader: 0x0 },
    Chip { name: "ESP32-C2", image_id: 12, bootloader: 0x0 },
    Chip { name: "ESP32-C6", image_id: 13, bootloader: 0x0 },
    Chip { name: "ESP32-H2", image_id: 16, bootloader: 0x0 },
    Chip { name: "ESP32-P4", image_id: 18, bootloader: 0x2000 },
    Chip { name: "ESP32-C61", image_id: 20, bootloader: 0x0 },
    Chip { name: "ESP32-C5", image_id: 23, bootloader: 0x2000 },
    Chip { name: "ESP32-H4", image_id: 28, bootloader: 0x2000 },
];

pub fn by_name(name: &str) -> Option<&'static Chip> {
    CHIPS.iter().find(|c| c.name == name)
}

pub fn by_image_id(id: u16) -> Option<&'static Chip> {
    CHIPS.iter().find(|c| c.image_id == id)
}

/// A readable name for an image's chip id, even one this table does not know.
pub fn label(image_id: u16) -> String {
    by_image_id(image_id).map(|c| c.name.to_string()).unwrap_or_else(|| format!("chip id {image_id}"))
}

/// "esp32s3" (espflash's and ESP-IDF's spelling) → "ESP32-S3" (esptool's).
pub fn chip_label(lower: &str) -> String {
    match lower.strip_prefix("esp32") {
        Some("") => "ESP32".into(),
        Some(rest) => format!("ESP32-{}", rest.to_uppercase()),
        None => lower.to_uppercase(),
    }
}

/// Where ESP-IDF puts the partition table unless CONFIG_PARTITION_TABLE_OFFSET moves it.
pub const DEFAULT_TABLE_OFFSET: u32 = 0x8000;
/// The table's partition: 0xC00 bytes of entries and the MD5 entry, padded to a sector.
pub const TABLE_SIZE: u32 = 0xc00;

/// USB vendor ids listed by default: Espressif's own USB (USB-Serial/JTAG and
/// the S2/S3 OTG ROM) and the USB-to-UART bridges ESP32 boards use. A board on
/// anything else is still reachable with "show every serial port".
pub const SERIAL_VIDS: &[u16] = &[
    0x303a, // Espressif
    0x10c4, // Silicon Labs CP210x
    0x1a86, // WCH CH340/CH343/CH9102
    0x0403, // FTDI
];
