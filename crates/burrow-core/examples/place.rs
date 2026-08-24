//! Run a real release archive through the whole unprivileged install path.
//!
//!     cargo run --example place -- <archive.zip> <format> <destination>
//!
//! extract → validate layout → clear quarantine → commit → verify → uninstall.
//! Writes only inside the destination you name. Use a temporary directory.

use burrow_core::{archive, commit, model::Format, model::Platform, quarantine};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: place <archive.zip> <ffgl|openfx|adobe> <destination-dir>");
        std::process::exit(2);
    }
    let zip = PathBuf::from(&args[1]);
    let format = match args[2].as_str() {
        "ffgl" => Format::Ffgl,
        "openfx" => Format::Openfx,
        "adobe" => Format::Adobe,
        other => {
            eprintln!("unknown format {other}");
            std::process::exit(2);
        }
    };
    let dest = PathBuf::from(&args[3]);
    let platform = Platform::current().expect("no plugin platform here");

    let staging = std::env::temp_dir().join(format!("burrow-example-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);

    println!("archive   {}", zip.display());
    let unpacked = match archive::extract(&zip, &staging) {
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
