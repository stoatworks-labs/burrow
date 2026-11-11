//! The device half of Burrow from a terminal, for the bench: the same code the
//! Firmware tab calls, with everything it decides printed.
//!
//!     cargo run -p burrow-device --example bench -- canary-ports [--all]
//!     cargo run -p burrow-device --example bench -- canary-describe <port>
//!     cargo run -p burrow-device --example bench -- canary-write <port> <unzipped-release> <variant> [--erase-all]
//!     cargo run -p burrow-device --example bench -- play-list
//!     cargo run -p burrow-device --example bench -- play-info <key>
//!     cargo run -p burrow-device --example bench -- play-flash <key> <image> [--package <fw>] [--no-verify]
//!
//! Every write asks for "yes" on stdin first. It is a bench tool, not a way
//! round the app's confirmation.

use burrow_device::esp::release::{load_variant, Manifest};
use burrow_device::esp::session::{self, Stage, Unit};
use burrow_device::play::plan::{self, BlockDevice};
use burrow_device::play::source::{FileSource, Source};
use burrow_device::play::{gpt, rkfw, usb};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn confirm(what: &str) -> bool {
    print!("{what}\nType yes to go on: ");
    std::io::stdout().flush().ok();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok();
    line.trim() == "yes"
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let after = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    match args.first().map(String::as_str) {
        Some("canary-ports") => {
            for p in session::list_ports(flag("--all"))? {
                println!("{}", serde_json::to_string(&p).unwrap());
            }
        }
        Some("canary-describe") => {
            let p = port(&args[1])?;
            let mut unit = Unit::open(&p)?;
            let d = unit.describe();
            let r = unit.restart();
            println!("{}", serde_json::to_string_pretty(&d?).unwrap());
            r?;
        }
        Some("canary-write") => {
            let (p, root, vid) = (port(&args[1])?, PathBuf::from(&args[2]), &args[3]);
            let m: Manifest = serde_json::from_str(&std::fs::read_to_string(root.join("manifest.json")).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let r = &m.releases[0];
            let v = r.variants.iter().find(|v| &v.id == vid).ok_or("no such variant")?;
            let writes = load_variant(&root, r, v)?;
            for w in &writes {
                println!("  {:<16} 0x{:06x}  {} bytes", w.name, w.offset, w.data.len());
            }
            let erase = flag("--erase-all");
            if !confirm(&format!("Write {} ({}) to {}{}?", r.id, v.name, p.name, if erase { ", erasing everything first" } else { "" })) {
                return Ok(());
            }
            let mut unit = Unit::open(&p)?;
            let mut last = String::new();
            let result = unit.write(&writes, erase, false, &mut |s| {
                let line = match s {
                    Stage::Erasing => "erasing".to_string(),
                    Stage::Writing { done, total } => format!("writing {}%", done * 100 / total.max(1)),
                    Stage::Verifying { done, total } => format!("verifying {}%", done * 100 / total.max(1)),
                };
                if line != last {
                    println!("  {line}");
                    last = line;
                }
            });
            let restarted = unit.restart();
            result?;
            restarted?;
            println!("written and restarted");
        }
        Some("play-list") => {
            for f in usb::list()? {
                let info = usb::find(&f.key)?.ok_or("vanished")?;
                let loader = f.bcd_says == usb::Mode::Loader || usb::probe_is_loader(&info);
                println!("{}  bcd says {:?}, answers as {}", serde_json::to_string(&f).unwrap(), f.bcd_says, if loader { "loader" } else { "maskrom" });
            }
        }
        Some("play-info") => {
            let info = usb::find(&args[1])?.ok_or("no such unit")?;
            let mut l = usb::Loader::open(&info)?;
            println!("sectors: {}", l.read_flash_info()?.sectors);
            for p in gpt::parse(&l.read_lba(0, 34)?)? {
                println!("  {:<10} 0x{:08x}  {} sectors", p.name, p.first_lba, p.sectors);
            }
        }
        Some("play-flash") => {
            let key = &args[1];
            let image = rkfw::parse(FileSource::open(&PathBuf::from(&args[2]))?)?;
            let package: Option<Arc<dyn Source>> = match after("--package") {
                Some(p) => Some(FileSource::open(&PathBuf::from(p))?),
                None => None,
            };
            for p in image.partitions.iter().filter(|p| p.flashed) {
                println!("  {:<10} sector 0x{:06x}  {} bytes", p.name, p.flash_addr, p.size);
            }
            if !confirm("This ERASES the PLAY completely, serial and /userdata included.") {
                return Ok(());
            }
            let info = usb::find(key)?.ok_or("no such unit")?;
            let loader_up = usb::list()?.into_iter().any(|f| &f.key == key && f.bcd_says == usb::Mode::Loader) || usb::probe_is_loader(&info);
            let mut dev = if loader_up {
                usb::Loader::open(&info)?
            } else {
                println!("maskrom: pushing the image's loader");
                usb::push_loader(&info, &image.loader()?, &mut |m| println!("  {m}"))?;
                let mut found = None;
                for _ in 0..20 {
                    if let Some(d) = usb::wait_for_any(Duration::from_secs(1))? {
                        if usb::probe_is_loader(&d) {
                            found = Some(usb::Loader::open(&d)?);
                            break;
                        }
                    }
                }
                found.ok_or("the unit did not come back with the loader running")?
            };
            let sectors = dev.read_flash_info()?.sectors;
            let mut rng = |b: &mut [u8]| {
                // The bench has no RNG crate; the clock and a counter are random
                // enough for GPT GUIDs nobody reads.
                let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                for (i, x) in b.iter_mut().enumerate() {
                    *x = (t >> ((i % 16) * 8)) as u8 ^ (i as u8).wrapping_mul(151);
                }
            };
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as u32;
            let p = plan::build_full(&image, sectors, package, &mut rng, now)?;
            for n in &p.notes {
                println!("  {n}");
            }
            let mut last = 0;
            plan::run(&mut dev, &p, &mut |w| {
                let pct = w.done_sectors * 100 / w.total_sectors.max(1);
                if pct != last {
                    print!("\r  writing {pct}%  ({})", w.op);
                    std::io::stdout().flush().ok();
                    last = pct;
                }
            })?;
            println!();
            if !flag("--no-verify") {
                let mut probes: Vec<u64> = p.ops.iter().map(|o| o.start_sector).collect();
                probes.sort_unstable();
                let ceiling = plan::find_read_ceiling(&mut dev, &probes);
                println!("  read ceiling: {ceiling:?}");
                let v = plan::verify(&mut dev, &p, ceiling, &mut |_| {})?;
                println!("  mismatches: {:?}\n  unverified: {:?}", v.mismatches, v.unverified);
            }
            dev.reset(usb::RESET_MSC)?;
            println!("written; the unit is restarting");
        }
        _ => return Err("see the comment at the top of examples/bench.rs".into()),
    }
    Ok(())
}

fn port(name: &str) -> Result<session::PortInfo, String> {
    session::list_ports(true)?.into_iter().find(|p| p.name == name).ok_or_else(|| format!("no port {name}"))
}
