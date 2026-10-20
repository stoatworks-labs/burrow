//! RKBOOT, the loader blob (`MiniLoaderAll.bin`) a maskrom PLAY takes over USB.
//!
//! Layout confirmed against the PLAY's own loader, extracted from the factory
//! PLAY_1.0.30.img: tag "BOOT", one ENTRY471 (DDR init), one ENTRY472 (the
//! usbplug), and two ENTRYLOADER records nothing here uses. Entry names are
//! UTF-16LE in 20 code units. The stride is asserted, not assumed: a wrong one
//! shifts every offset and gives a loader that downloads cleanly and then never
//! re-enumerates.
//!
//! The loader is the vendor's and only ever comes out of the user's own image.
//! Burrow never ships one.

pub const ENTRY471: u32 = 1;
pub const ENTRY472: u32 = 2;
pub const ENTRYLOADER: u32 = 4;
const ENTRY_SIZE: usize = 57;

#[derive(Debug, Clone)]
pub struct Entry {
    pub kind: u32,
    pub name: String,
    pub delay_ms: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RkBoot {
    pub chip: String,
    /// Read for the record; entries go out verbatim whatever it says, because
    /// rkdeveloptool's GetEntryData is a plain copy and this flag means "RC4
    /// disabled".
    pub rc4_flag: u8,
    pub entries: Vec<Entry>,
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn utf16le(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .take_while(|&c| c != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

pub fn parse(buf: &[u8]) -> Result<RkBoot, String> {
    if buf.len() < 0x66 || &buf[0..4] != b"BOOT" {
        return Err("not an RKBOOT loader".into());
    }
    let _header_size = u16_at(buf, 0x04);
    let chip = String::from_utf8_lossy(&buf[0x15..0x19]).into_owned();
    let groups = [
        (ENTRY471, buf[0x19] as usize, u32_at(buf, 0x1a) as usize, buf[0x1e] as usize),
        (ENTRY472, buf[0x1f] as usize, u32_at(buf, 0x20) as usize, buf[0x24] as usize),
        (ENTRYLOADER, buf[0x25] as usize, u32_at(buf, 0x26) as usize, buf[0x2a] as usize),
    ];
    let rc4_flag = buf[0x2c];
    let mut entries = Vec::new();
    for (_, count, offset, size) in groups {
        if count > 0 && size != ENTRY_SIZE {
            return Err(format!("unexpected RKBOOT entry stride {size}, expected {ENTRY_SIZE}"));
        }
        for i in 0..count {
            let o = offset + i * size;
            if o + size > buf.len() {
                return Err("an RKBOOT entry runs past the end of the loader".into());
            }
            let kind = u32_at(buf, o + 1);
            let name = utf16le(&buf[o + 5..o + 45]);
            let data_offset = u32_at(buf, o + 45) as usize;
            let data_size = u32_at(buf, o + 49) as usize;
            let delay_ms = u32_at(buf, o + 53);
            if data_offset + data_size > buf.len() {
                return Err(format!("RKBOOT entry {name} runs past the end"));
            }
            entries.push(Entry {
                kind,
                name,
                delay_ms,
                data: buf[data_offset..data_offset + data_size].to_vec(),
            });
        }
    }
    Ok(RkBoot { chip, rc4_flag, entries })
}
