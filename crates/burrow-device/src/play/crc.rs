//! The two checksums the PLAY's boot chain uses.
//!
//! CRC-16 here is Rockchip's variant: poly 0x1021, init 0x0000, no reflection,
//! no final xor, appended big-endian to every maskrom vendor request. It is not
//! CRC-16/CCITT-FALSE (init 0xFFFF): a wrong init looks exactly like a corrupt
//! loader, and the device answers a bad CRC by silently doing nothing.

const fn ccitt_table() -> [u16; 256] {
    let mut t = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut acc: u16 = 0;
        let mut data: u16 = (i as u16) << 8;
        let mut j = 0;
        while j < 8 {
            acc = if (data ^ acc) & 0x8000 != 0 { (acc << 1) ^ 0x1021 } else { acc << 1 };
            data <<= 1;
            j += 1;
        }
        t[i] = acc;
        i += 1;
    }
    t
}

const CCITT: [u16; 256] = ccitt_table();

pub fn crc16_ccitt(bytes: &[u8]) -> u16 {
    let mut acc: u16 = 0;
    for &b in bytes {
        acc = (acc << 8) ^ CCITT[(((acc >> 8) as u8) ^ b) as usize];
    }
    acc
}

const fn crc32_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut j = 0;
        while j < 8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            j += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
}

const CRC32: [u32; 256] = crc32_table();

/// Standard CRC-32 (zlib, GPT): reflected, init 0xFFFFFFFF, final xor.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in bytes {
        c = CRC32[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}
