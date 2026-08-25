//! Stoatworks Burrow — the parts that do not need Tauri.
//!
//! The catalogue model, host and destination discovery, payload identity, the
//! install ledger and reconciliation. Kept free of Tauri so `cargo test` can
//! reach all of it on every platform in CI, including the Windows paths that
//! cannot be exercised by hand on the Mac this was written on.

// `deny` rather than `forbid`: there is exactly one unsafe block in this crate
// — the `removexattr` call in `quarantine` — and it carries an explicit
// `allow` with its own safety note. `forbid` cannot be overridden locally, so
// it would force the choice between dropping the lint everywhere or wrapping a
// three-line libc call in a dependency. Anything else that wants unsafe has to
// justify itself the same way, in the same visible manner.
#![deny(unsafe_code)]

pub mod archive;
pub mod bundleinfo;
pub mod catalog;
pub mod commit;
pub mod dest;
pub mod dmg;
pub mod hashing;
pub mod ledger;
pub mod model;
pub mod quarantine;

pub use model::{Format, InstallState, Platform, VersionSource};
