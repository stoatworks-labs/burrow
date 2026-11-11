#!/usr/bin/env node
// Builds a GPT, an injected rootfs and a package tar with the web tools' OWN
// modules, on the inputs examples/crosscheck.rs uses, and compares them byte
// for byte with what Burrow built. Run by hand when either side changes:
//
//   cargo run -p burrow-device --example crosscheck -- /tmp/xc [<kit>]
//   node scripts/crosscheck-play.mjs /tmp/xc <birddog-play-flasher> <birddog-play-patcher> [<kit>]
//
// The two repos are checkouts at the commits being compared (their public/
// directories are imported directly). The randomness the GPT needs and the
// clock the filesystem stamps are fixed here exactly as the Rust side fixes
// them, so any difference is a difference in the code.
//
// <kit> is the patcher's release kit, unzipped (scripts/make-kit.sh in the
// patcher checkout, at the same commit). With it, whole packages are built
// from the kit on both sides: every option on, every option on without its
// birdUI tab, and every option off. The page side packs PACKAGE from fw.js in
// its own order, so a member Burrow lacks, or puts elsewhere, shows here.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [out, flasher, patcher, kitDir] = process.argv.slice(2).map((p) => p && resolve(p));
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

if (kitDir) {
  const fw = await mod(patcher, 'fw.js');
  for (const name of ['all', 'all-no-tabs', 'none']) {
    const req = JSON.parse(readFileSync(join(out, `kit-${name}.json`), 'utf8'));
    compare(`kit package (${name})`, await pagePackage(fw, req), `rust-kit-${name}.tar`);
  }
}

// app.js's build(), with the page's form replaced by a Burrow build request
// (kit::Options, camelCase). What goes in, where and in what mode is fw.js's
// PACKAGE; the with* flags are app.js's, which reads them off the form and the
// manifest. Keep them in step with app.js.
async function pagePackage(fw, req) {
  const { PACKAGE, OPTIONS, Tar, buildConf, cleanTag, extractTailscale, extractMediaMTX, readModule, addModule, sha256Hex } = fw;
  const manifest = JSON.parse(readFileSync(join(kitDir, 'assets/manifest.json'), 'utf8'));
  const has = (...ids) => ids.every((id) => !!manifest[id]);
  const on = {
    ssh: true,
    tailscale: req.tailscale,
    kvm: req.kvm && has('bdkvm'),
    uvc: req.cam && has('bdcam'),
    player: req.play && has('bdplay'),
    gateway: req.gateway && has('bdgw'),
    omt: req.omt && has('bdomt', 'libvmx'),
    output: req.output && has('bdout', 'libbdout'),
    stagetimer: req.stagetimer && has('bdstage'),
  };
  // The tripwire for "Burrow needs telling": an option the page has grown that
  // this script, and so kit.rs, has never heard of.
  for (const o of OPTIONS) {
    if (!(o.id in on)) throw new Error(`fw.js has an option "${o.id}" that Burrow does not build — port it to kit.rs`);
  }
  const modules = [];
  for (const f of req.modules) modules.push(await readModule(new Uint8Array(readFileSync(join(out, f))), f));
  const conf = buildConf({
    tag: cleanTag(req.tag),
    withTailscale: on.tailscale,
    withTailscaleUi: on.tailscale && has('bdts'),
    withKvm: on.kvm,
    withPlay: on.player,
    withCam: on.uvc,
    withCamUi: on.uvc && req.camUi,
    withGateway: on.gateway,
    withGatewayUi: on.gateway && req.gatewayUi,
    withOmt: on.omt,
    withOmtUi: on.omt && req.omtUi,
    withOutput: on.output,
    withOutputUi: on.output && req.outputUi,
    withStagetimer: on.stagetimer,
    withStagetimerUi: on.stagetimer && req.stagetimerUi,
    withModules: modules.length > 0,
    doReboot: req.reboot,
  });
  const fetched = {
    tailscale: on.tailscale ? await extractTailscale(readFileSync(join(out, 'kit-tailscale.tgz'))) : null,
    mediamtx: on.gateway ? await extractMediaMTX(readFileSync(join(out, 'kit-mediamtx.tgz'))) : null,
  };
  const t = new Tar();
  for (const p of PACKAGE) {
    if (p.option && !on[p.option]) continue;
    if (p.input === 'ssh-key') {
      t.text(p.member, req.sshKey.trim() + '\n', p.mode);
    } else if (p.input === 'build.conf') {
      t.text(p.member, conf, p.mode);
      for (const rel of manifest.rootfsOverlay || []) {
        t.file(`./files/${rel}`, new Uint8Array(readFileSync(join(kitDir, 'assets/files', rel))), 0o644);
      }
    } else if (p.fetch === 'tailscale') {
      t.file(p.member, fetched.tailscale[p.take], p.mode);
    } else if (p.fetch === 'mediamtx') {
      const data = p.take === 'mediamtx' ? fetched.mediamtx.mediamtx : p.take === 'LICENSE' ? fetched.mediamtx.license : undefined;
      if (data === undefined) throw new Error(`PACKAGE takes "${p.take}" from MediaMTX — teach this script and kit.rs`);
      if (data) t.file(p.member, data, p.mode);
      else if (p.required) throw new Error(`${p.id}: not in the MediaMTX stand-in`);
    } else if (p.asset) {
      const meta = manifest[p.id];
      if (!meta) {
        if (p.required) throw new Error(`${p.id} is required and missing from the kit`);
        continue;
      }
      const data = new Uint8Array(readFileSync(join(kitDir, 'assets', p.asset)));
      if (data.length !== meta.size || (await sha256Hex(data)) !== meta.sha256) throw new Error(`${p.asset}: not the manifest's`);
      t.file(p.member, data, p.mode);
    } else {
      throw new Error(`PACKAGE member ${p.id} comes from somewhere this script does not know`);
    }
  }
  for (const m of modules) addModule(t, m);
  return new Uint8Array(await t.blob().arrayBuffer());
}

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? 'same' : 'DIFFERENT'}  ${r.name}`
    + (r.ok ? '' : `  (first difference at byte ${r.at}; js ${r.js}, rust ${r.rust})`));
}
process.exit(bad ? 1 : 0);
