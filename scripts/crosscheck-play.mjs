#!/usr/bin/env node
// Builds a GPT, an injected rootfs and a package tar with the web tools' OWN
// modules, on the inputs examples/crosscheck.rs uses, and compares them byte
// for byte with what Burrow built. Run by hand when either side changes:
//
//   cargo run -p burrow-device --example crosscheck -- /tmp/xc
//   node scripts/crosscheck-play.mjs /tmp/xc <birddog-play-flasher> <birddog-play-patcher>
//
// The two repos are checkouts at the commits being compared (their public/
// directories are imported directly). The randomness the GPT needs and the
// clock the filesystem stamps are fixed here exactly as the Rust side fixes
// them, so any difference is a difference in the code.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, flasher, patcher] = process.argv.slice(2).map((p) => p && resolve(p));
if (!out || !flasher || !patcher) {
  console.error('usage: crosscheck-play.mjs <out-dir> <flasher-repo> <patcher-repo>');
  process.exit(2);
}

const NOW = 1_760_000_000;
const DISK_SECTORS = 0x30000;
const PACKAGE_BYTES = 123_457;
const PARAMETER = 'FIRMWARE_VER: 1.0\nMACHINE_MODEL: PLAY\nTYPE: GPT\n'
  + 'CMDLINE: mtdparts=rk29xxnand:0x00002000@0x00004000(uboot),0x00002000@0x00006000(trust),0x00010000@0x00008000(boot),0x00004000@0x00018000(rootfs),-@0x0001c000(userdata:grow)\n'
  + 'uuid:rootfs=614e0000-0000-4b53-8000-1d28000054a9\n';

let n = 0;
globalThis.crypto.getRandomValues = (b) => {
  for (let i = 0; i < b.length; i++) { n = (n + 37) & 0xff; b[i] = n; }
  return b;
};
Date.now = () => NOW * 1000;

const mod = (repo, f) => import(pathToFileURL(join(repo, 'public', f)).href);
const { parseParameter } = await mod(flasher, 'rkfw.js');
const { buildGpt, parseUuidLines } = await mod(flasher, 'gpt.js');
const { planInjection } = await mod(flasher, 'inject.js');
const { Tar } = await mod(patcher, 'fw.js');

const results = [];
function compare(name, js, rustFile) {
  const rust = new Uint8Array(readFileSync(join(out, rustFile)));
  writeFileSync(join(out, `js-${rustFile.replace(/^rust-/, '')}`), js);
  let at = -1;
  const len = Math.max(js.length, rust.length);
  for (let i = 0; i < len; i++) if (js[i] !== rust[i]) { at = i; break; }
  results.push({ name, ok: at === -1, at, js: js.length, rust: rust.length });
}

const param = parseParameter(PARAMETER);
const gpt = buildGpt(param.partitions, DISK_SECTORS, parseUuidLines(PARAMETER));
compare('GPT (master)', gpt.master, 'rust-gpt-master.bin');
compare('GPT (backup)', gpt.backup, 'rust-gpt-backup.bin');

const image = new Uint8Array(readFileSync(join(out, 'rootfs.ext2')));
const inj = await planInjection(new Blob([image]), 0x4000, PACKAGE_BYTES);
const patched = image.slice();
for (const p of inj.patches) patched.set(p.bytes, p.offset);
compare('injected rootfs', patched, 'rust-rootfs-injected.ext2');
const rustSector = Number(readFileSync(join(out, 'rust-relative-sector.txt'), 'utf8'));
results.push({ name: 'package sector', ok: rustSector === inj.relativeSector, at: -1, js: inj.relativeSector, rust: rustSector });

const t = new Tar();
t.file('./update', new TextEncoder().encode('#!/bin/sh\necho update\n'), 0o755);
t.text('./authorized_keys', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample you@laptop\n', 0o600);
t.file('./userdata/tailscale/tailscaled', new Uint8Array(1000).fill(0x5a), 0o755);
t.file('./modules/hello/install', new TextEncoder().encode('#!/bin/sh\n'), 0o755);
compare('package tar', new Uint8Array(await t.blob().arrayBuffer()), 'rust-package.tar');

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'same' : 'DIFFERENT'}  ${r.name}`
    + (r.ok ? '' : `  (first difference at byte ${r.at}; js ${r.js}, rust ${r.rust})`));
}
process.exit(bad ? 1 : 0);
