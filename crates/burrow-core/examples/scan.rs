//! Scan this machine against a real catalogue and print what Burrow would say.
//!
//! Not a test — a way to point the reconciliation logic at a real, messy
//! plugin folder and read the answer, before any of it is behind a GUI.
//!
//!     cargo run --example scan -- path/to/catalog.json
//!
//! It reads. It writes nothing, creates nothing and downloads nothing.

use burrow_core::{catalog, dest, ledger, model::Platform, InstallState};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: scan <catalog.json>");
        std::process::exit(2);
    });

    let body = std::fs::read_to_string(&path).expect("read catalog");
    let cat = match catalog::parse(&body) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let platform = Platform::current().expect("no plugin platform here");
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let documents = home.join("Documents");
    let applications = PathBuf::from("/Applications");

    println!(
        "catalogue: schema {} generated {} — {} entries\n",
        cat.schema,
        cat.generated,
        cat.entries.len()
    );

    println!("hosts found:");
    for (product, hosts) in dest::detect_resolume(&applications, &documents) {
        let note = if hosts {
            "scans Extra Effects"
        } else {
            "does NOT scan Extra Effects — measured, not assumed"
        };
        println!("  Resolume {:<7} {note}", product.name());
    }

    let destinations = dest::discover(platform, &applications, &documents, &BTreeMap::new());
    println!("\ndestinations:");
    for d in &destinations {
        println!(
            "  {:<8} {:<28} exists={:<5} writable={:<5} elevate={}",
            d.id,
            d.path.display().to_string().replace(home.to_str().unwrap(), "~"),
            d.exists,
            d.writable,
            d.needs_elevation
        );
    }

    let led = ledger::Ledger::default(); // nothing installed by Burrow yet
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    println!("\nplugins:");

    for entry in &cat.entries {
        for d in &destinations {
            let asset = entry.asset(d.format, platform);
            let declared: Vec<String> = asset.map(|a| a.entries.clone()).unwrap_or_default();
            let r = ledger::reconcile_one(
                &led,
                &entry.slug,
                d.format,
                &d.id,
                &d.path,
                &declared,
                entry.version.as_deref(),
            );

            let label = match &r.state {
                InstallState::NotInstalled if r.foreign => "foreign",
                InstallState::NotInstalled => "not-installed",
                InstallState::NoBuild => "no-build",
                InstallState::UpToDate { .. } => "up-to-date",
                InstallState::UpdateAvailable { .. } => "update",
                InstallState::VersionUnknown { .. } => "version-unknown",
            };
            *counts.entry(label).or_default() += 1;

            // Only print the interesting ones; "not installed" for 24 plugins
            // across 3 destinations is noise.
            match &r.state {
                InstallState::UpToDate { version, source } => println!(
                    "  {:<22} {:<7} {:<8} {version} ({source:?})",
                    entry.slug, d.format.id(), label
                ),
                InstallState::UpdateAvailable { installed, latest, source } => println!(
                    "  {:<22} {:<7} {:<8} {installed} -> {latest} ({source:?})",
                    entry.slug, d.format.id(), label
                ),
                InstallState::VersionUnknown { entries } => println!(
                    "  {:<22} {:<7} {:<8} {entries:?}",
                    entry.slug, d.format.id(), label
                ),
                _ if r.foreign => println!(
                    "  {:<22} {:<7} {:<8} (a bundle of that name is there, but it is not ours)",
                    entry.slug, d.format.id(), label
                ),
                _ => {}
            }
        }
    }

    println!("\nsummary: {counts:?}");
}
