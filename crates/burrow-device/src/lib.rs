//! Writing firmware to the fleet's devices.
//!
//! Nothing in here downloads, prompts or runs as root. The shell fetches a
//! release, this crate decides whether it may be written to the unit in front
//! of it, writes it, and says how far it got. A device write is not a file
//! install: there is no staging copy to fall back on and no rollback, so the
//! gates here run before the first byte and again against a fresh read of the
//! unit immediately before it.

#![deny(unsafe_code)]

pub mod esp;
pub mod play;
