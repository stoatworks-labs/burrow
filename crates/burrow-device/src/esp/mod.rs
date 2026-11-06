//! Any ESP32 written over its serial port: a CANary, a nanODE, a Cuckoo, or a
//! board with an image of your own.
//!
//! The Stoatworks Flasher's `src/` in Rust, module for module: `chips`,
//! `image`, `plan`, `package` and `files` are pure and tested against the real
//! images; `session` is the only part that opens a port.

pub mod chips;
pub mod files;
pub mod image;
pub mod package;
pub mod plan;
pub mod session;
