//! A CANary: an ESP32-S3 written over its own USB port.
//!
//! `image`, `plan` and `release` are pure and tested against the real images;
//! `session` is the only part that opens a port.

pub mod image;
pub mod plan;
pub mod release;
pub mod session;
