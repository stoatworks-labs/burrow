//! Random access into something too big to hold: a 2.4 GB factory image is read
//! a slice at a time, never whole. The browser flasher does this with Blob
//! slices; this is the same idea with a file.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub trait Source: Send + Sync {
    fn len(&self) -> u64;
    fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>, String>;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A file on disk, opened once and read where asked.
pub struct FileSource {
    path: PathBuf,
    file: Mutex<File>,
    len: u64,
}

impl FileSource {
    pub fn open(path: &Path) -> Result<Arc<FileSource>, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        Ok(Arc::new(FileSource {
            path: path.to_path_buf(),
            file: Mutex::new(file),
            len,
        }))
    }
}

impl Source for FileSource {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        if offset + len as u64 > self.len {
            return Err(format!("{}: read past the end of the file", self.path.display()));
        }
        let mut f = self.file.lock().map_err(|_| "file lock poisoned".to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len];
        f.read_exact(&mut buf).map_err(|e| format!("{}: {e}", self.path.display()))?;
        Ok(buf)
    }
}

/// Bytes already in memory: a built package, a GPT, a test image.
pub struct MemSource(pub Vec<u8>);

impl Source for MemSource {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let start = offset as usize;
        self.0
            .get(start..start + len)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "read past the end".to_string())
    }
}

/// A window onto part of another source: one partition inside an image.
pub struct Slice {
    pub inner: Arc<dyn Source>,
    pub offset: u64,
    pub len: u64,
}

impl Source for Slice {
    fn len(&self) -> u64 {
        self.len
    }
    fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        if offset + len as u64 > self.len {
            return Err("read past the end of the slice".into());
        }
        self.inner.read_at(self.offset + offset, len)
    }
}
