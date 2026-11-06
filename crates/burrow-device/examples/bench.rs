//! The device half of Burrow from a terminal, for the bench: the same code the
//! Firmware tab calls, with everything it decides printed.
//!
//!     cargo run -p burrow-device --example bench -- esp-ports [--all]
//!     cargo run -p burrow-device --example bench -- esp-describe <port> [--baud <n>] [--table-offset 0x8000]
//!     cargo run -p burrow-device --example bench -- esp-plan <unzipped-package> [<release> <variant>]
//!     cargo run -p burrow-device --example bench -- esp-write <port> <unzipped-package> <release> <variant> [--erase-all] [--replace]
//!
//! `esp-plan` opens nothing: it reads the package and prints what would be
//! written and what the gate says about it, against the device's own chip and
//! flash. Every write asks for "yes" on stdin first. It is a bench tool, not a
//! way round the app's confirmation.

use burrow_device::esp::image::{describe_image, hex, parse_offset};
use burrow_device::esp::package::{known_devices, load_variant, open_package_dir, Package, Release, Variant};
use burrow_device::esp::plan::{check_plan, components, plan_notes, PlanContext};
use burrow_device::esp::session::{self, Stage, Unit, WriteOptions};
use std::io::Write;
use std::path::PathBuf;

fn confirm(what: &str) -> bool {
    print!("{what}\nType yes to go on: ");
    std::io::stdout().flush().ok();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok();
    line.trim() == "yes"
}

fn pick<'a>(pkg: &'a Package, release: Option<&String>, variant: Option<&String>) -> Result<(&'a Release, &'a Variant), String> {
    let r = match release {
        Some(id) => pkg.releases.iter().find(|r| &r.id == id).ok_or("no such release")?,
        None => &pkg.releases[0],
    };
    let v = match variant {
        Some(id) => r.variants.iter().find(|v| &v.id == id).ok_or("no such variant")?,
        None => r.variants.iter().find(|v| v.recommended).unwrap_or(&r.variants[0]),
    };
    Ok((r, v))
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let after = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let positional: Vec<&String> = {
        let mut out = Vec::new();
        let mut skip = false;
        for a in &args {
            if skip {
                skip = false;
            } else if a == "--baud" || a == "--table-offset" {
                skip = true;
            } else if !a.starts_with("--") {
                out.push(a);
            }
        }
        out
    };
    match positional.first().map(|s| s.as_str()) {
        Some("esp-ports") => {
            for p in session::list_ports(flag("--all"))? {
                println!("{}", serde_json::to_string(&p).unwrap());
            }
        }
        Some("esp-describe") => {
            let p = port(positional.get(1).ok_or("which port?")?)?;
            let baud = after("--baud").map(|b| b.parse::<u32>().map_err(|e| e.to_string())).transpose()?;
            let table_offset = match after("--table-offset") {
                Some(t) => parse_offset(&t, None).ok_or("--table-offset: type it as 0x…")?,
                None => 0x8000,
            };
            let mut unit = Unit::open(&p, baud)?;
            let d = unit.describe(table_offset);
            let r = unit.restart();
            println!("{}", serde_json::to_string_pretty(&d?).unwrap());
            r?;
        }
        Some("esp-plan") => {
            let root = PathBuf::from(positional.get(1).ok_or("which package?")?);
            let pkg = open_package_dir(&root, &known_devices())?;
            let (r, v) = pick(&pkg, positional.get(2).copied(), positional.get(3).copied())?;
            let d = &pkg.device;
            let writes = load_variant(&root, r, v, d.table_offset())?;
            println!("{} {} / {} ({}, {} bytes of flash)", d.name, r.id, v.id, d.chip, d.flash_size);
            for c in components(&writes, d.table_offset()) {
                println!("  {:<24} {}  {:>8} bytes  {}", c.name, hex(c.offset), c.data.len(), describe_image(&c.info));
            }
            let ctx = PlanContext {
                chip: d.chip().ok_or("unknown chip")?,
                flash_bytes: d.flash_size,
                projects: Some(&d.projects),
                unit_table: None,
                table_offset: d.table_offset(),
            };
            let problems = check_plan(&writes, &ctx);
            println!("problems: {problems:?}");
            println!("notes: {:?}", plan_notes(&writes, &ctx));
        }
        Some("esp-write") => {
            let p = port(positional.get(1).ok_or("which port?")?)?;
            let root = PathBuf::from(positional.get(2).ok_or("which package?")?);
            let pkg = open_package_dir(&root, &known_devices())?;
            let (r, v) = pick(&pkg, positional.get(3).copied(), positional.get(4).copied())?;
            let d = &pkg.device;
            let writes = load_variant(&root, r, v, d.table_offset())?;
            for w in &writes {
                println!("  {:<16} {}  {} bytes", w.name, hex(w.offset), w.data.len());
            }
            let erase = flag("--erase-all");
            if !confirm(&format!(
                "Write {} {} ({}) to {}{}?",
                d.name,
                r.id,
                v.name,
                p.name,
                if erase { ", erasing everything first" } else { "" }
            )) {
                return Ok(());
            }
            let opts = WriteOptions {
                erase_all: erase,
                projects: Some(d.projects.clone()),
                expect_chip: Some(d.chip.clone()),
                min_flash: Some(d.flash_size),
                name: Some(d.name.clone()),
                table_offset: d.table_offset(),
                confirm_replace: flag("--replace"),
            };
            let mut unit = Unit::open(&p, d.baud)?;
            let mut last = String::new();
            let result = unit.write(&writes, &opts, &mut |s| {
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
            if let Some(a) = &v.after {
                println!("{a}");
            }
        }
        _ => return Err("see the comment at the top of examples/bench.rs".into()),
    }
    Ok(())
}

fn port(name: &str) -> Result<session::PortInfo, String> {
    session::list_ports(true)?.into_iter().find(|p| p.name == name).ok_or_else(|| format!("no port {name}"))
}
