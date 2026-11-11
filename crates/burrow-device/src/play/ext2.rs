//! A read/write ext2 driver, just large enough to put three small files into
//! the PLAY's factory rootfs.
//!
//! The factory rootfs.img is plain ext2: `dir_index filetype` and nothing else.
//! No journal, no extents, no metadata_csum, no 64bit. That is what makes this
//! tractable — there is no checksum to get wrong and nothing to replay.
//!
//! Nothing is held whole: the image is read through a `Source`, and every
//! change lands in an overlay of whole blocks that the flasher applies while it
//! streams the partition to USB. A port of the browser flasher's `ext2.js`, with
//! its limits kept and enforced: created files fit in the 12 direct blocks, and
//! no indirect trees are built.
//!
//! Two departures, both only safer. The group descriptor table is placed at
//! block `first_data_block + 1`, which is the same block as the page uses at
//! 1 KiB (the PLAY's size) and the right one at 4 KiB, where the page's formula
//! gives block 0. And a new inode's record is zeroed before it is filled, so
//! nothing a deleted file left in the inode table survives into it.

use super::source::Source;
use std::collections::BTreeMap;
use std::sync::Arc;

const EXT2_SUPER_MAGIC: u16 = 0xef53;
const ROOT_INO: u32 = 2;
const INDEX_FL: u32 = 0x1000;

pub const S_IFDIR: u16 = 0x4000;
pub const S_IFREG: u16 = 0x8000;
pub const S_IFLNK: u16 = 0xa000;

const FT_REG: u8 = 1;
const FT_LNK: u8 = 7;

fn round_up4(n: usize) -> usize {
    (n + 3) & !3
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn put_u16(b: &mut [u8], o: usize, v: u16) {
    b[o..o + 2].copy_from_slice(&v.to_le_bytes());
}

fn put_u32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

#[derive(Debug, Clone)]
pub struct Superblock {
    pub inodes_count: u32,
    pub blocks_count: u32,
    pub free_blocks: u32,
    pub free_inodes: u32,
    pub first_data_block: u32,
    pub block_size: usize,
    pub blocks_per_group: u32,
    pub inodes_per_group: u32,
    pub first_ino: u32,
    pub inode_size: usize,
}

#[derive(Debug, Clone)]
struct Group {
    block_bitmap: u32,
    inode_bitmap: u32,
    inode_table: u32,
    free_blocks: u16,
    free_inodes: u16,
    used_dirs: u16,
}

#[derive(Debug, Clone)]
pub struct Inode {
    pub ino: u32,
    pub mode: u16,
    pub uid: u16,
    pub size: u32,
    pub atime: u32,
    pub ctime: u32,
    pub mtime: u32,
    pub gid: u16,
    pub links: u16,
    pub blocks512: u32,
    pub flags: u32,
    pub block: [u32; 15],
}

pub struct Ext2 {
    source: Arc<dyn Source>,
    pub sb: Superblock,
    groups: Vec<Group>,
    gd_block: u32,
    gd_block_count: u32,
    overlay: BTreeMap<u32, Vec<u8>>,
    /// The timestamp every change is stamped with. Passed in, so a test can
    /// build the same overlay twice and compare it with the page's.
    now: u32,
}

struct DirEntry {
    ino: u32,
    name: Vec<u8>,
}

impl Ext2 {
    pub fn open(source: Arc<dyn Source>, now: u32) -> Result<Ext2, String> {
        let head = source.read_at(1024, 1024)?;
        if u16_at(&head, 56) != EXT2_SUPER_MAGIC {
            return Err("not an ext2 filesystem".into());
        }
        let log_block_size = u32_at(&head, 24);
        if log_block_size > 2 {
            return Err("implausible ext2 block size".into());
        }
        let rev_level = u32_at(&head, 76);
        let mut sb = Superblock {
            inodes_count: u32_at(&head, 0),
            blocks_count: u32_at(&head, 4),
            free_blocks: u32_at(&head, 12),
            free_inodes: u32_at(&head, 16),
            first_data_block: u32_at(&head, 20),
            block_size: 1024usize << log_block_size,
            blocks_per_group: u32_at(&head, 32),
            inodes_per_group: u32_at(&head, 40),
            first_ino: u32_at(&head, 84),
            inode_size: u16_at(&head, 88) as usize,
        };
        if rev_level == 0 {
            sb.inode_size = 128;
            sb.first_ino = 11;
        }
        // Anything beyond filetype in incompat — extents, 64bit, meta_bg,
        // journal recovery — is a layout this driver does not implement.
        // Refuse rather than corrupt.
        let incompat = u32_at(&head, 96);
        let ro_compat = u32_at(&head, 100);
        if incompat & !0x0002 != 0 {
            return Err(format!("unsupported ext incompat features 0x{incompat:x}"));
        }
        if ro_compat & !0x0003 != 0 {
            return Err(format!("unsupported ext ro_compat features 0x{ro_compat:x}"));
        }
        if sb.blocks_per_group == 0 || sb.inodes_per_group == 0 || sb.inode_size < 128 {
            return Err("implausible ext2 superblock".into());
        }

        let group_count =
            (sb.blocks_count - sb.first_data_block).div_ceil(sb.blocks_per_group) as usize;
        let gd_block = sb.first_data_block + 1;
        let gd_bytes = group_count * 32;
        let gd_block_count = gd_bytes.div_ceil(sb.block_size) as u32;
        let raw = source.read_at(
            gd_block as u64 * sb.block_size as u64,
            gd_block_count as usize * sb.block_size,
        )?;
        let groups = (0..group_count)
            .map(|i| {
                let o = i * 32;
                Group {
                    block_bitmap: u32_at(&raw, o),
                    inode_bitmap: u32_at(&raw, o + 4),
                    inode_table: u32_at(&raw, o + 8),
                    free_blocks: u16_at(&raw, o + 12),
                    free_inodes: u16_at(&raw, o + 14),
                    used_dirs: u16_at(&raw, o + 16),
                }
            })
            .collect();
        Ok(Ext2 {
            source,
            sb,
            groups,
            gd_block,
            gd_block_count,
            overlay: BTreeMap::new(),
            now,
        })
    }

    // ---- blocks ------------------------------------------------------------

    fn read_block(&self, n: u32) -> Result<Vec<u8>, String> {
        if let Some(b) = self.overlay.get(&n) {
            return Ok(b.clone());
        }
        if n >= self.sb.blocks_count {
            return Err(format!("block {n} is past the end of the filesystem"));
        }
        self.source.read_at(n as u64 * self.sb.block_size as u64, self.sb.block_size)
    }

    fn dirty_block(&mut self, n: u32) -> Result<&mut Vec<u8>, String> {
        if !self.overlay.contains_key(&n) {
            let b = self.read_block(n)?;
            self.overlay.insert(n, b);
        }
        Ok(self.overlay.get_mut(&n).expect("just inserted"))
    }

    fn put_block(&mut self, n: u32, bytes: Vec<u8>) {
        debug_assert_eq!(bytes.len(), self.sb.block_size);
        self.overlay.insert(n, bytes);
    }

    // ---- inodes ------------------------------------------------------------

    fn inode_location(&self, ino: u32) -> (u32, usize) {
        let g = ((ino - 1) / self.sb.inodes_per_group) as usize;
        let idx = ((ino - 1) % self.sb.inodes_per_group) as usize;
        let byte_off = idx * self.sb.inode_size;
        (
            self.groups[g].inode_table + (byte_off / self.sb.block_size) as u32,
            byte_off % self.sb.block_size,
        )
    }

    pub fn read_inode(&self, ino: u32) -> Result<Inode, String> {
        if ino == 0 || ino > self.sb.inodes_count {
            return Err(format!("inode {ino} out of range"));
        }
        let (block, offset) = self.inode_location(ino);
        let b = self.read_block(block)?;
        let d = &b[offset..offset + self.sb.inode_size];
        let mut blocks = [0u32; 15];
        for (i, slot) in blocks.iter_mut().enumerate() {
            *slot = u32_at(d, 40 + i * 4);
        }
        Ok(Inode {
            ino,
            mode: u16_at(d, 0),
            uid: u16_at(d, 2),
            size: u32_at(d, 4),
            atime: u32_at(d, 8),
            ctime: u32_at(d, 12),
            mtime: u32_at(d, 16),
            gid: u16_at(d, 24),
            links: u16_at(d, 26),
            blocks512: u32_at(d, 28),
            flags: u32_at(d, 32),
            block: blocks,
        })
    }

    fn write_inode(&mut self, inode: &Inode, fresh: bool) -> Result<(), String> {
        let (block, offset) = self.inode_location(inode.ino);
        let size = self.sb.inode_size;
        let b = self.dirty_block(block)?;
        let d = &mut b[offset..offset + size];
        if fresh {
            d.fill(0);
        }
        put_u16(d, 0, inode.mode);
        put_u16(d, 2, inode.uid);
        put_u32(d, 4, inode.size);
        put_u32(d, 8, inode.atime);
        put_u32(d, 12, inode.ctime);
        put_u32(d, 16, inode.mtime);
        put_u32(d, 20, 0); // dtime: a live inode has none
        put_u16(d, 24, inode.gid);
        put_u16(d, 26, inode.links);
        put_u32(d, 28, inode.blocks512);
        put_u32(d, 32, inode.flags);
        for i in 0..15 {
            put_u32(d, 40 + i * 4, inode.block[i]);
        }
        Ok(())
    }

    /// Blocks holding a file's data, through one level of indirection.
    fn data_blocks(&self, inode: &Inode) -> Result<Vec<u32>, String> {
        let mut out: Vec<u32> = inode.block[..12].iter().copied().take_while(|&b| b != 0).collect();
        if inode.block[12] != 0 {
            let ind = self.read_block(inode.block[12])?;
            for i in 0..self.sb.block_size / 4 {
                let b = u32_at(&ind, i * 4);
                if b != 0 {
                    out.push(b);
                }
            }
        }
        if inode.block[13] != 0 || inode.block[14] != 0 {
            return Err("a file uses double or triple indirect blocks, which this does not read".into());
        }
        Ok(out)
    }

    pub fn read_file(&self, inode: &Inode) -> Result<Vec<u8>, String> {
        if inode.mode & 0xf000 == S_IFLNK && inode.size < 60 {
            return Ok((0..inode.size as usize)
                .map(|i| (inode.block[i >> 2] >> ((i % 4) * 8)) as u8)
                .collect());
        }
        let mut out = Vec::with_capacity(inode.size as usize);
        for b in self.data_blocks(inode)? {
            if out.len() >= inode.size as usize {
                break;
            }
            let blk = self.read_block(b)?;
            let n = (inode.size as usize - out.len()).min(self.sb.block_size);
            out.extend_from_slice(&blk[..n]);
        }
        Ok(out)
    }

    // ---- paths -------------------------------------------------------------

    fn read_dir(&self, inode: &Inode) -> Result<Vec<DirEntry>, String> {
        let mut out = Vec::new();
        for b in self.data_blocks(inode)? {
            let blk = self.read_block(b)?;
            let mut o = 0;
            while o + 8 <= blk.len() {
                let ino = u32_at(&blk, o);
                let rec_len = u16_at(&blk, o + 4) as usize;
                let name_len = blk[o + 6] as usize;
                if rec_len < 8 {
                    break;
                }
                if ino != 0 && o + 8 + name_len <= blk.len() {
                    out.push(DirEntry {
                        ino,
                        name: blk[o + 8..o + 8 + name_len].to_vec(),
                    });
                }
                o += rec_len;
            }
        }
        Ok(out)
    }

    fn lookup(&self, dir: &Inode, name: &str) -> Result<Option<u32>, String> {
        Ok(self
            .read_dir(dir)?
            .into_iter()
            .find(|e| e.name == name.as_bytes())
            .map(|e| e.ino))
    }

    pub fn resolve(&self, path: &str) -> Result<Inode, String> {
        let mut inode = self.read_inode(ROOT_INO)?;
        for part in path.split('/').filter(|p| !p.is_empty()) {
            let ino = self
                .lookup(&inode, part)?
                .ok_or_else(|| format!("no such path: {path} (missing {part})"))?;
            inode = self.read_inode(ino)?;
        }
        Ok(inode)
    }

    // ---- allocation --------------------------------------------------------

    fn alloc_block(&mut self) -> Result<u32, String> {
        for g in 0..self.groups.len() {
            if self.groups[g].free_blocks == 0 {
                continue;
            }
            let in_group = self
                .sb
                .blocks_per_group
                .min(self.sb.blocks_count - self.sb.first_data_block - g as u32 * self.sb.blocks_per_group);
            let bitmap = self.groups[g].block_bitmap;
            let bmp = self.dirty_block(bitmap)?;
            for i in 0..in_group as usize {
                if bmp[i >> 3] & (1 << (i & 7)) == 0 {
                    bmp[i >> 3] |= 1 << (i & 7);
                    self.groups[g].free_blocks -= 1;
                    self.sb.free_blocks -= 1;
                    return Ok(self.sb.first_data_block + g as u32 * self.sb.blocks_per_group + i as u32);
                }
            }
        }
        Err("no free blocks left in the filesystem".into())
    }

    fn alloc_inode(&mut self) -> Result<u32, String> {
        for g in 0..self.groups.len() {
            if self.groups[g].free_inodes == 0 {
                continue;
            }
            let bitmap = self.groups[g].inode_bitmap;
            let ipg = self.sb.inodes_per_group;
            let first_ino = self.sb.first_ino;
            let bmp = self.dirty_block(bitmap)?;
            for i in 0..ipg as usize {
                let ino = g as u32 * ipg + i as u32 + 1;
                if ino < first_ino {
                    continue;
                }
                if bmp[i >> 3] & (1 << (i & 7)) == 0 {
                    bmp[i >> 3] |= 1 << (i & 7);
                    self.groups[g].free_inodes -= 1;
                    self.sb.free_inodes -= 1;
                    return Ok(ino);
                }
            }
        }
        Err("no free inodes left in the filesystem".into())
    }

    // ---- changes -----------------------------------------------------------

    /// Insert a directory entry, splitting slack in an existing record.
    fn add_dir_entry(&mut self, dir: &mut Inode, name: &str, ino: u32, file_type: u8) -> Result<(), String> {
        if dir.flags & INDEX_FL != 0 {
            // An htree directory's leaf blocks are ordinary linear dirent
            // blocks and its root block ends in a fake entry, so dropping the
            // index flag leaves a directory the kernel and e2fsck both read
            // linearly.
            dir.flags &= !INDEX_FL;
            self.write_inode(dir, false)?;
        }
        let name_bytes = name.as_bytes();
        if name_bytes.len() > 255 {
            return Err(format!("{name}: name too long for ext2"));
        }
        let need = round_up4(8 + name_bytes.len());
        let blocks = self.data_blocks(dir)?;
        for &b in &blocks {
            let blk = self.dirty_block(b)?;
            let mut o = 0;
            while o + 8 <= blk.len() {
                let e_ino = u32_at(blk, o);
                let rec_len = u16_at(blk, o + 4) as usize;
                let name_len = blk[o + 6] as usize;
                if rec_len < 8 {
                    break;
                }
                let used = if e_ino == 0 { 0 } else { round_up4(8 + name_len) };
                if rec_len >= used + need {
                    let n = if e_ino == 0 {
                        o
                    } else {
                        put_u16(blk, o + 4, used as u16);
                        o + used
                    };
                    let len = if e_ino == 0 { rec_len } else { rec_len - used };
                    put_u32(blk, n, ino);
                    put_u16(blk, n + 4, len as u16);
                    blk[n + 6] = name_bytes.len() as u8;
                    blk[n + 7] = file_type;
                    blk[n + 8..n + 8 + name_bytes.len()].copy_from_slice(name_bytes);
                    return Ok(());
                }
                o += rec_len;
            }
        }
        // No slack anywhere: give the directory another block.
        if blocks.len() >= 12 {
            return Err("the directory would need an indirect block, which this does not build".into());
        }
        let nb = self.alloc_block()?;
        let mut blk = vec![0u8; self.sb.block_size];
        put_u32(&mut blk, 0, ino);
        put_u16(&mut blk, 4, self.sb.block_size as u16);
        blk[6] = name_bytes.len() as u8;
        blk[7] = file_type;
        blk[8..8 + name_bytes.len()].copy_from_slice(name_bytes);
        self.put_block(nb, blk);
        dir.block[blocks.len()] = nb;
        dir.size += self.sb.block_size as u32;
        dir.blocks512 += (self.sb.block_size / 512) as u32;
        self.write_inode(dir, false)
    }

    pub fn create_file(&mut self, dir_path: &str, name: &str, bytes: &[u8], mode: u16) -> Result<u32, String> {
        let max_direct = 12 * self.sb.block_size;
        if bytes.len() > max_direct {
            return Err(format!("{name} is {} bytes; the limit is {max_direct}", bytes.len()));
        }
        let mut dir = self.resolve(dir_path)?;
        if self.lookup(&dir, name)?.is_some() {
            return Err(format!("{dir_path}/{name} already exists"));
        }
        let ino = self.alloc_inode()?;
        let mut block = [0u32; 15];
        let bs = self.sb.block_size;
        for (i, chunk) in bytes.chunks(bs).enumerate() {
            let b = self.alloc_block()?;
            let mut data = vec![0u8; bs];
            data[..chunk.len()].copy_from_slice(chunk);
            self.put_block(b, data);
            block[i] = b;
        }
        let count = bytes.len().div_ceil(bs);
        let inode = Inode {
            ino,
            mode: S_IFREG | mode,
            uid: 0,
            gid: 0,
            size: bytes.len() as u32,
            atime: self.now,
            ctime: self.now,
            mtime: self.now,
            links: 1,
            blocks512: (count * (bs / 512)) as u32,
            flags: 0,
            block,
        };
        self.write_inode(&inode, true)?;
        self.add_dir_entry(&mut dir, name, ino, FT_REG)?;
        Ok(ino)
    }

    pub fn create_symlink(&mut self, dir_path: &str, name: &str, target: &str) -> Result<u32, String> {
        let bytes = target.as_bytes();
        if bytes.len() >= 60 {
            return Err("only fast symlinks (under 60 bytes) are supported".into());
        }
        let mut dir = self.resolve(dir_path)?;
        if self.lookup(&dir, name)?.is_some() {
            return Err(format!("{dir_path}/{name} already exists"));
        }
        let ino = self.alloc_inode()?;
        let mut block = [0u32; 15];
        for (i, &c) in bytes.iter().enumerate() {
            block[i >> 2] |= (c as u32) << ((i % 4) * 8);
        }
        let inode = Inode {
            ino,
            mode: S_IFLNK | 0o777,
            uid: 0,
            gid: 0,
            size: bytes.len() as u32,
            atime: self.now,
            ctime: self.now,
            mtime: self.now,
            links: 1,
            blocks512: 0,
            flags: 0,
            block,
        };
        self.write_inode(&inode, true)?;
        self.add_dir_entry(&mut dir, name, ino, FT_LNK)?;
        Ok(ino)
    }

    /// Write back the superblock and group descriptors that allocation moved.
    /// Only the primary copies: e2fsck does not compare the backups on a normal
    /// pass, and every group of this filesystem carries one.
    pub fn flush_metadata(&mut self) -> Result<(), String> {
        let (sb_block, sb_offset) = if self.sb.block_size == 1024 { (1, 0) } else { (0, 1024) };
        let (free_blocks, free_inodes, now) = (self.sb.free_blocks, self.sb.free_inodes, self.now);
        let b = self.dirty_block(sb_block)?;
        put_u32(b, sb_offset + 12, free_blocks);
        put_u32(b, sb_offset + 16, free_inodes);
        put_u32(b, sb_offset + 48, now); // s_wtime
        put_u16(b, sb_offset + 58, 1); // s_state = clean
        let per_block = self.sb.block_size / 32;
        for i in 0..self.gd_block_count {
            let groups = self.groups.clone();
            let blk = self.dirty_block(self.gd_block + i)?;
            for j in 0..per_block {
                let g = i as usize * per_block + j;
                let Some(group) = groups.get(g) else { break };
                put_u16(blk, j * 32 + 12, group.free_blocks);
                put_u16(blk, j * 32 + 14, group.free_inodes);
                put_u16(blk, j * 32 + 16, group.used_dirs);
            }
        }
        Ok(())
    }

    /// The overlay as byte-offset patches into the partition image.
    pub fn patches(&self) -> Vec<Patch> {
        self.overlay
            .iter()
            .map(|(&n, bytes)| Patch {
                offset: n as u64 * self.sb.block_size as u64,
                bytes: bytes.clone(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub offset: u64,
    pub bytes: Vec<u8>,
}
