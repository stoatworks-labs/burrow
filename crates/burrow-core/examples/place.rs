//! Run a real release archive through the whole unprivileged install path.
//!
//!     cargo run --example place -- <archive> <format> <destination> [module-name]
//!
//! extract → validate layout → clear quarantine → commit → verify → uninstall.
//! Writes only inside the destination you name. Use a temporary directory.

use burrow_core::{archive, commit, model::Format, model::Platform, quarantine};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!(
            "usage: place <archive> <ffgl|openfx|adobe|vst3|au|app|companion> \
             <destination-dir> [module-name]"
        );
        std::process::exit(2);
    }
    let zip = PathBuf::from(&args[1]);
    let format = match args[2].as_str() {
        "ffgl" => Format::Ffgl,
        "openfx" => Format::Openfx,
        "adobe" => Format::Adobe,
        "vst3" => Format::Vst3,
        "au" => Format::Au,
        "app" => Format::App,
        "companion" => Format::Companion,
        other => {
            eprintln!("unknown format {other}");
            std::process::exit(2);
        }
    };
    let dest = PathBuf::from(&args[3]);
    // Only a Companion module needs this: its archive is an npm tarball whose
    // single `package/` root carries no name of its own.
    let module_name = args.get(4).map(String::as_str);
    let platform = Platform::current().expect("no plugin platform here");

    let staging = std::env::temp_dir().join(format!("burrow-example-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    println!("archive   {}", zip.display());
    // A macOS application arrives as a disk image, which is mounted rather
    // than unpacked. Everything after this is identical either way.
    let opened = if zip.extension().is_some_and(|e| e.eq_ignore_ascii_case("dmg")) {
        burrow_core::dmg::extract_app(&zip, &staging)
    } else {
        archive::extract(&zip, &staging, format, platform, module_name)
    };
    let unpacked = match opened {
        Ok(u) => u,
        Err(e) => {
            eprintln!("extract failed: {e}");
            std::process::exit(1);
        }
    };
    println!("entries   {:?}", unpacked.entries);
    if !unpacked.extras.is_empty() {
        println!("extras    {:?}  (not placed in the plugin folder)", unpacked.extras);
    }

    if let Err(e) = archive::validate_layout(&staging, &unpacked, format, platform) {
        eprintln!("layout    REJECTED: {e}");
        std::process::exit(1);
    }
    println!("layout    ok for {} on {}", format.label(), platform.id());

    let mut cleared = 0;
    for name in &unpacked.entries {
        cleared += quarantine::clear(&staging.join(name));
    }
    println!("quarantine cleared on {cleared} path(s) (0 is normal for a local build)");

    let batch = commit::new_batch_id();
    match commit::commit(&dest, &staging, &unpacked.entries, &batch) {
        Ok(placed) => println!("committed {placed:?} -> {}", dest.display()),
        Err(e) => {
            eprintln!("commit failed: {e}");
            std::process::exit(1);
        }
    }

    // What is actually in the destination now?
    let mut listing: Vec<String> = std::fs::read_dir(&dest)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    listing.sort();
    println!("destination now: {listing:?}");

    // And the version Burrow would read back.
    for name in &unpacked.entries {
        if let Some(id) = burrow_core::bundleinfo::read_bundle(&dest.join(name)) {
            println!(
                "  {name}: version={:?} identifier={:?} ours={}",
                id.version, id.identifier, id.is_ours()
            );
        } else {
            println!("  {name}: no readable version (normal on Windows payloads)");
        }
    }

    let batch2 = commit::new_batch_id();
    commit::uninstall(&dest, &unpacked.entries, &batch2).expect("uninstall");
    let after: Vec<String> = std::fs::read_dir(&dest)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    println!("after uninstall: {after:?}");

    let _ = std::fs::remove_dir_all(&staging);
}
