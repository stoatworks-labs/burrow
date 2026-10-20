//! A BirdDog PLAY: its update packages, and its Rockchip recovery flash.
//!
//! Everything but `usb` is pure and tested without a unit. The loader that a
//! maskrom unit needs and the factory image it is restored from are the
//! vendor's and only ever come from the user's own file: Burrow neither ships
//! nor downloads either.

pub mod crc;
pub mod ext2;
pub mod fw;
pub mod gpt;
pub mod inject;
pub mod kit;
pub mod plan;
pub mod rkboot;
pub mod rkfw;
pub mod source;
pub mod usb;
