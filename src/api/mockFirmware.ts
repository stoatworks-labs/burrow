/*
 * The Device firmware tab's fake backend.
 *
 *   ?device=both|none|canary|canary-old|canary-foreign|blank|s3-small|secure|
 *           nanode|cuckoo|play-maskrom|play-loader|play-win-nodriver
 *                       what "Look for boards" and "Look for a PLAY" find, and
 *                       what reading a board says (both = a CANary and a PLAY
 *                       in loader mode)
 *   ?files=loose|zip    what "Open a file…" picks
 *   ?fw=ok|fail         whether a write gets to the end
 *   ?job=slow           every step takes long enough to look at
 *
 * No unit, no serial port, no USB, no network. The ESP32 packages are the real
 * manifests burrow-device's tests use; the plan is a rough copy of what Rust
 * works out, enough to see each state of the tab, never a substitute for the
 * gate. The PLAY's answers are the real shapes, filled with what a real unit
 * said on the bench where there is one to copy.
 */

import canaryManifest from '../../crates/burrow-device/tests/fixtures/canary/manifest-v2.json'
import cuckooManifest from '../../crates/burrow-device/tests/fixtures/cuckoo/manifest.json'
import nanodeManifest from '../../crates/burrow-device/tests/fixtures/nanode/manifest.json'
import type {
  BuiltInfo,
  Description,
  DevicePartition,
  EspPartition,
  EspRelease,
  FlashOutcome,
  FwPhase,
  FwProgress,
  ImageSummary,
  KitOffers,
  Link,
  OpenedFiles,
  Package,
  PlanView,
  PlayUnit,
  PortInfo,
  Source,
  WantView,
} from './firmware'
import { hex, mb } from './firmware'

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const device = params.get('device') ?? 'both'
const files = params.get('files') ?? 'loose'
const fails = params.get('fw') === 'fail'
const slow = params.get('job') === 'slow'

export const NOT_MINE = Symbol('not a firmware command')

const handlers: Array<(p: FwProgress) => void> = []

export function listenFirmware(h: (p: FwProgress) => void): () => void {
  handlers.push(h)
  return () => {
    const i = handlers.indexOf(h)
    if (i >= 0) handlers.splice(i, 1)
  }
}

function emit(job: string, phase: FwPhase, done = 0, total: number | null = null, message: string | null = null) {
  handlers.forEach(h => h({ job, phase, done, total, message }))
}

const wait = (ms: number) => new Promise(r => setTimeout(r, slow ? ms * 6 : ms))

async function count(job: string, phase: FwPhase, total: number, steps = 20) {
  for (let i = 1; i <= steps; i++) {
    await wait(90)
    emit(job, phase, Math.round((total * i) / steps), total)
  }
}

/** One release, as a catalogue zip carries it. */
const one = (m: unknown): Package => {
  const p = m as Package
  return { ...p, releases: [p.releases[0]] }
}
const PACKAGES: Record<string, Package> = {
  'canary-firmware': one(canaryManifest),
  'nanode-firmware': one(nanodeManifest),
  'cuckoo-firmware': one(cuckooManifest),
}

/** The published release zips' SHA-256, as the live catalogue gives them (2026-11-06). */
const ZIP_SHA256: Record<string, string> = {
  'canary-firmware': 'ef1c935f160ade7ef2396e33c2784ebabf9a3dd6d349c15323800c9ccf2af95b',
  'nanode-firmware': '4c08c80fa7ff4e1ecec4d91b43c46032aca81c07e6c501a2cc7181811e25bd2f',
  'cuckoo-firmware': 'ceb529bfd32d51e0d6a5969a4ed6689beef9d969117fca1739e225e8eeb4bc2a',
}

function links(p: Package): Link[] {
  const d = p.device
  const out: Link[] = []
  for (const r of p.releases) {
    if (!d.repo || !r.tag) continue
    const base = `https://github.com/${d.repo}/releases/download/${r.tag}/`
    out.push({ label: `${r.id} release zip`, name: `${d.id}-firmware-${r.id}.zip`, url: base + `${d.id}-firmware-${r.id}.zip` })
    for (const v of r.variants) {
      const name = `${d.id}-firmware-${r.id}-${v.id}.bin`
      out.push({ label: `${r.id} ${v.name}, whole flash`, name, url: base + name })
    }
  }
  return out
}

const table = (...p: [string, number, number, number, number][]): EspPartition[] =>
  p.map(([label, type, subtype, offset, size]) => ({ label, type, subtype, offset, size }))

const TABLES: Record<string, EspPartition[]> = {
  canary: table(
    ['nvs', 1, 2, 0x9000, 0x6000],
    ['otadata', 1, 0, 0xf000, 0x2000],
    ['phy_init', 1, 1, 0x11000, 0x1000],
    ['ota_0', 0, 0x10, 0x20000, 0x1d0000],
    ['ota_1', 0, 0x11, 0x1f0000, 0x1d0000],
    ['coredump', 1, 3, 0x3c0000, 0x20000],
  ),
  nanode: table(
    ['nvs', 1, 2, 0x9000, 0x6000],
    ['otadata', 1, 0, 0xf000, 0x2000],
    ['phy_init', 1, 1, 0x11000, 0x1000],
    ['ota_0', 0, 0x10, 0x20000, 0x1e0000],
    ['ota_1', 0, 0x11, 0x200000, 0x1e0000],
    ['storage', 1, 0x83, 0x3e0000, 0x400000],
    ['coredump', 1, 3, 0x7e0000, 0x20000],
  ),
  // ESP-IDF's own "single factory app" layout, which an example project uses.
  idfDefault: table(
    ['nvs', 1, 2, 0x9000, 0x6000],
    ['phy_init', 1, 1, 0xf000, 0x1000],
    ['factory', 0, 0, 0x10000, 0x100000],
  ),
  cuckoo: table(
    ['nvs', 1, 2, 0x9000, 0x6000],
    ['phy_init', 1, 1, 0xf000, 0x1000],
    ['factory', 0, 0, 0x10000, 0x1c0000],
    ['rp_ram', 1, 0x40, 0x1d0000, 0x90000],
    ['rp_fw', 1, 0x41, 0x260000, 0x100000],
  ),
}

const app = (project: string, version: string, date: string) => ({ version, project, time: '14:11:25', date, idfVersion: 'v5.5.5' })

const PORTS: Record<string, PortInfo> = {
  usb: {
    name: '/dev/cu.usbmodem1101',
    vid: 0x303a,
    pid: 0x1001,
    product: 'USB JTAG/serial debug unit',
    manufacturer: 'Espressif',
    serialNumber: '7C:DF:A1:E2:4B:10',
    usbSerialJtag: true,
  },
  bridge: {
    name: '/dev/cu.usbserial-0001',
    vid: 0x10c4,
    pid: 0xea60,
    product: 'CP2102N USB to UART Bridge Controller',
    manufacturer: 'Silicon Labs',
    serialNumber: '0001',
    usbSerialJtag: false,
  },
}

function describe(port: string): Description {
  const base: Description = {
    port,
    facts: { chipName: 'ESP32-S3', flashBytes: 8 << 20, flashLabel: '8MB', secureBoot: false, flashEncryption: false },
    mac: '7c:df:a1:e2:4b:10',
    tableOffset: 0x8000,
    table: TABLES.canary,
    running: { partition: 'ota_0', offset: 0x20000, app: app('dbcanary', 'main-60a871f', 'Sep 26 2026') },
    problems: [],
  }
  switch (device) {
    case 'canary-old':
      return { ...base, running: { partition: 'ota_1', offset: 0x1f0000, app: app('dbcanary', 'main-4bd1ac5', 'Sep 20 2026') } }
    case 'canary-foreign':
      return { ...base, running: { partition: 'factory', offset: 0x10000, app: app('blink', 'v1.0', 'Jan  4 2026') }, table: TABLES.idfDefault }
    case 'blank':
      return { ...base, running: null, table: null }
    case 's3-small':
      return { ...base, facts: { ...base.facts, flashBytes: 4 << 20, flashLabel: '4MB' } }
    case 'secure':
      return {
        ...base,
        facts: { ...base.facts, secureBoot: true },
        problems: ['secure boot is on, and firmware not signed for this unit would not boot'],
      }
    case 'nanode':
      return {
        ...base,
        facts: { ...base.facts, chipName: 'ESP32' },
        mac: '24:0a:c4:11:22:33',
        table: TABLES.nanode,
        running: { partition: 'ota_0', offset: 0x20000, app: app('nanode', 'main-622a72a', 'Nov  6 2026') },
      }
    case 'cuckoo':
      return {
        ...base,
        facts: { ...base.facts, chipName: 'ESP32-C3', flashBytes: 4 << 20, flashLabel: '4MB' },
        mac: '34:85:18:aa:bb:cc',
        table: TABLES.cuckoo,
        running: { partition: 'factory', offset: 0x10000, app: app('cuckoo_ui', '0.1.0 4300e74', 'Nov  6 2026') },
      }
    default:
      return base
  }
}

let unit: Description | null = null
let opened: { kind: 'package'; pkg: Package } | { kind: 'loose' } | null = null
const loaded: Record<string, Package> = {}

const LOOSE = [
  { name: 'bootloader.bin', size: 18544, what: 'bootloader · ESP32-C3', kind: 'bootloader', placed: 0x0 },
  { name: 'partition-table.bin', size: 3072, what: 'nvs, phy_init, factory, rp_ram, rp_fw', kind: 'partition-table', placed: 0x8000 },
  { name: 'cuckoo_ui.bin', size: 852768, what: 'cuckoo_ui 0.1.0 4300e74 · ESP32-C3', kind: 'app', placed: 0x10000 },
  { name: 'fs.img', size: 0x10000, what: 'raw data', kind: 'unknown', placed: null as number | null },
]

function what(name: string, p: Package, v: Package['releases'][0]['variants'][0]): string {
  const d = p.device
  if (name === 'bootloader') return `bootloader · ${d.chip}`
  if (name === 'partition table') return TABLES[d.id]?.map(t => t.label).join(', ') ?? 'partition table'
  if (name === 'otadata') return 'blank otadata'
  if (name === 'app') return `${v.app.project} ${v.app.version} · ${d.chip}`
  return `data for the ${name} partition`
}

function plan(source: Source): PlanView {
  const view: PlanView = {
    error: null,
    rows: [],
    problems: [],
    notes: [],
    replace: null,
    want: { device: null, chip: null, projects: null, minFlash: null, tableOffset: 0x8000, baud: null, after: null },
    places: [],
    unitRead: unit !== null,
  }
  let projects: string[] | null = null
  let appName = ''
  if (source.kind === 'files') {
    if (!opened || opened.kind !== 'loose') return { ...view, error: 'choose a firmware zip or the images of your own build' }
    view.places = LOOSE.map(f => ({ name: f.name, placed: f.placed === null ? null : hex(f.placed) }))
    const typed = source.typed[3]?.trim() ?? ''
    if (!typed) return { ...view, error: 'fs.img: Burrow cannot tell where this goes. Type an offset.' }
    const at = typed === 'rp_fw' ? 0x260000 : /^0x[0-9a-f]+$/i.test(typed) ? parseInt(typed, 16) : null
    if (at === null) return { ...view, error: 'fs.img: type the offset as 0x…, as 128K or 1M, or as a partition’s name.' }
    view.rows = [
      ...LOOSE.slice(0, 3).map(f => ({ name: f.name, offset: f.placed!, hex: hex(f.placed!), size: f.size, what: f.what })),
      { name: 'fs.img', offset: at, hex: hex(at), size: 0x10000, what: 'raw data, at the offset you typed' },
    ]
    view.want = { ...view.want, chip: 'ESP32-C3' }
    appName = 'cuckoo_ui 0.1.0 4300e74'
  } else {
    const pkg = source.kind === 'catalog' ? loaded[source.slug] : opened?.kind === 'package' ? opened.pkg : undefined
    if (!pkg) return { ...view, error: 'the firmware is not loaded; choose it again' }
    const r = pkg.releases.find(x => x.id === source.release)
    const v = r?.variants.find(x => x.id === source.variant)
    if (!r || !v) return { ...view, error: `the package has no ${source.release}/${source.variant}` }
    const d = pkg.device
    view.rows = v.parts.map(p => ({ name: p.name, offset: p.offset, hex: hex(p.offset), size: p.size, what: what(p.name, pkg, v) }))
    view.want = {
      device: d.name,
      chip: d.chip,
      projects: d.projects,
      minFlash: d.flashSize,
      tableOffset: d.tableOffset ?? 0x8000,
      baud: d.baud ?? null,
      after: v.after ?? null,
    } satisfies WantView
    projects = d.projects
    appName = `${v.app.project} ${v.app.version}`
    view.notes.push(
      source.kind === 'catalog'
        ? 'Every part matched the SHA-256 in its package, and the package the one the catalogue gives.'
        : 'Every part matched the checksum in its manifest.',
    )
  }
  if (!unit) {
    view.notes.push('Read a board, and this is checked against it before Write is offered.')
    return view
  }
  const w = view.want
  const f = unit.facts
  if (w.chip && f.chipName !== w.chip) view.problems.push(`this is an ${f.chipName}, and ${w.device ?? 'the firmware'} is for an ${w.chip}`)
  if (w.minFlash && f.flashBytes && f.flashBytes < w.minFlash) {
    view.problems.push(`this unit has ${f.flashLabel} of flash, and ${w.device} needs ${w.minFlash / 1048576}MB`)
  }
  for (const r of view.rows) {
    if (f.flashBytes && r.offset + r.size > f.flashBytes) view.problems.push(`${r.name}: runs past the end of the ${mb(f.flashBytes)} flash`)
  }
  view.problems.push(...unit.problems)
  if (view.problems.length) view.notes = []
  const running = unit.running?.app
  const ours = projects ?? [appName.split(' ')[0]]
  if (running && !ours.includes(running.project)) {
    view.replace = `This board runs ${running.project} ${running.version}. Replace it with ${appName}.`
  }
  return view
}

// ---- BirdDog PLAY ----

const PLAY_PARTS: DevicePartition[] = [
  ['uboot', 0x4000, 0x2000],
  ['trust', 0x6000, 0x2000],
  ['misc', 0x8000, 0x2000],
  ['boot', 0xa000, 0x20000],
  ['recovery', 0x2a000, 0x30000],
  ['backup', 0x5a000 - 0x10000, 0x10000],
  ['oem', 0x5a000, 0x20000],
  ['rootfs', 0x7a000, 0x700000],
  ['userdata', 0x77a000, 15269888 - 34 - 0x77a000 + 1],
].map(([name, firstLba, sectors]) => ({
  name: name as string,
  firstLba: firstLba as number,
  sectors: sectors as number,
  lastLba: (firstLba as number) + (sectors as number) - 1,
}))

function playUnits(): PlayUnit[] {
  const loader: PlayUnit = {
    key: 'DeviceId(4294971399)',
    productId: 0x320c,
    product: null,
    bcdSays: 'maskrom',
    driver: null,
    mode: 'loader',
    partitions: PLAY_PARTS,
    sectors: 15269888,
  }
  switch (device) {
    case 'play-loader':
    case 'both':
      return [loader]
    case 'play-maskrom':
      return [{ ...loader, mode: 'maskrom', partitions: null, sectors: null }]
    case 'play-win-nodriver':
      return [{ ...loader, mode: 'maskrom', partitions: null, sectors: null, driver: 'rkusb' }]
    default:
      return []
  }
}

const IMAGE: ImageSummary = {
  path: '/Users/you/Downloads/PLAY_1.0.30.img',
  size: 2_466_382_848,
  chip: 'RK33',
  model: 'PLAY',
  built: '2025-11-03 09:41:12',
  partitions: [
    ['package-file', 'package-file', 553, 0xffffffff],
    ['bootloader', 'Image/MiniLoaderAll.bin', 190_000, 0xffffffff],
    ['parameter', 'Image/parameter.txt', 523, 0],
    ['uboot', 'Image/uboot.img', 4_194_304, 0x4000],
    ['trust', 'Image/trust.img', 4_194_304, 0x6000],
    ['boot', 'Image/boot.img', 17_000_000, 0xa000],
    ['recovery', 'Image/recovery.img', 22_000_000, 0x2a000],
    ['oem', 'Image/oem.img', 16_777_216, 0x5a000],
    ['rootfs', 'Image/rootfs.img', 2_399_595_520, 0x7a000],
  ].map(([name, file, size, flashAddr]) => ({
    name: name as string,
    file: file as string,
    size: size as number,
    flashAddr: flashAddr as number,
    offset: 0,
    flashed: flashAddr !== 0xffffffff && name !== 'parameter',
  })),
  table: PLAY_PARTS.map(p => ({ name: p.name, grow: p.name === 'userdata', startSector: p.firstLba, sectors: p.sectors })),
  packageRoom: 1_339_031_552,
}

const KIT: KitOffers = {
  version: '0.3.0',
  tailscale: true,
  tailscaleUi: true,
  kvm: true,
  play: true,
  playPdf: true,
  playExfat: true,
  cam: true,
  gateway: true,
  omt: true,
  output: true,
  stagetimer: true,
  mediamtxVersion: 'v1.21.0',
}

let lastBuilt: BuiltInfo | null = null

export async function mockFirmware(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const a = (args ?? {}) as any
  switch (cmd) {
    case 'esp_release': {
      const pkg = PACKAGES[a.slug]
      if (!pkg) throw new Error(`the catalogue carries no firmware called ${a.slug}`)
      const job = `release:${a.slug}`
      emit(job, 'downloading', 0, null, pkg.device.name)
      await count(job, 'downloading', 614545, 10)
      emit(job, 'done')
      loaded[a.slug] = pkg
      return {
        slug: a.slug,
        version: pkg.releases[0].tag ?? null,
        package: pkg,
        zipUrl: `https://github.com/${pkg.device.repo}/releases/download/${pkg.releases[0].tag}/${pkg.device.id}-firmware-${pkg.releases[0].id}.zip`,
        zipSha256: ZIP_SHA256[a.slug],
        links: links(pkg),
      } satisfies EspRelease
    }
    case 'esp_ports':
      await wait(250)
      if (device === 'none' || device.startsWith('play-')) return []
      return device === 'nanode' || a.all ? [PORTS.bridge, ...(device === 'nanode' ? [] : [PORTS.usb])] : [PORTS.usb]
    case 'esp_describe':
      await wait(900)
      unit = describe(a.port)
      return unit
    case 'esp_forget_unit':
      unit = null
      return undefined
    case 'pick_files':
      if (a.purpose === 'firmware') {
        return files === 'zip'
          ? ['/Users/you/Downloads/cuckoo-firmware-main-4300e74.zip']
          : LOOSE.map(f => `/Users/you/cuckoo/build/${f.name}`)
      }
      return (
        {
          image: ['/Users/you/Downloads/PLAY_1.0.30.img'],
          package: ['/Users/you/Downloads/BirdDog_PLAY-custom-web.fw'],
          module: ['/Users/you/Projects/hello-module.tgz'],
          tailscale: ['/Users/you/Downloads/tailscale_1.90.0_arm64.tgz'],
          mediamtx: ['/Users/you/Downloads/mediamtx_v1.21.0_linux_arm64.tar.gz'],
          partition: ['/Users/you/companion-play/boot.img'],
        } as Record<string, string[]>
      )[a.purpose] ?? null
    case 'esp_open_files': {
      await wait(300)
      if (files === 'zip') {
        const pkg = PACKAGES['cuckoo-firmware']
        opened = { kind: 'package', pkg }
        return { kind: 'package', package: pkg, links: links(pkg) } satisfies OpenedFiles
      }
      opened = { kind: 'loose' }
      return { kind: 'loose', files: LOOSE.map(({ placed: _, ...f }) => f) } satisfies OpenedFiles
    }
    case 'esp_plan':
      return plan(a.source as Source)
    case 'esp_write': {
      const job = 'esp-write'
      const p = plan(a.req.source as Source)
      const total = p.rows.reduce((s, r) => s + r.size, 0)
      emit(job, 'connecting')
      await wait(700)
      if (a.req.eraseAll) {
        emit(job, 'erasing')
        await wait(1500)
      }
      await count(job, 'writing', total)
      if (fails) {
        emit(job, 'restarting')
        await wait(400)
        const msg = 'writing: the unit stopped answering'
        emit(job, 'failed', 0, null, msg)
        unit = null
        throw new Error(msg)
      }
      await count(job, 'verifying', total, 6)
      emit(job, 'restarting')
      await wait(500)
      emit(job, 'done', 0, null, p.want.after)
      unit = null
      return undefined
    }
    case 'play_devices':
      await wait(500)
      return playUnits()
    case 'play_inspect_image':
      await wait(400)
      return { ...IMAGE, path: a.path }
    case 'play_kit':
      await count('play-kit', 'downloading', 31_400_000, 8)
      emit('play-kit', 'done')
      return KIT
    case 'play_build': {
      const job = 'play-build'
      const req = a.req
      if (req.tailscale) await count(job, 'downloading', 34_100_000, 8)
      if (req.gateway) await count(job, 'downloading', 29_800_000, 8)
      emit(job, 'building')
      await wait(900)
      const tag = (req.tag || 'burrow').trim().replace(/[^A-Za-z0-9._-]/g, '-')
      lastBuilt = {
        id: '9f2c1a7b3e5d4c60',
        name: `BirdDog_PLAY-custom-${tag}.fw`,
        size: 49_800_000,
        sha256: '3b9a0f2c7d1e4a8b9c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b',
        tarSha256: 'c4d3e2f1a0b9c8d7e6f5a4b3b9a0f2c7d1e4a8b9c6d5e4f3a2b1c0d9e8f7a6b5',
        log: [
          req.tailscale ? 'tailscale: 21.4 MB + 12.0 MB' : '',
          req.tailscale ? 'birdUI Tailscale panel: yes, so signing in needs no SSH' : '',
          req.kvm ? 'NDI KVM: yes' : '',
          req.play ? 'USB media player: yes' : '',
          req.cam ? `UVC converter: yes, web UI tab ${req.camUi ? 'yes' : 'no'}` : '',
          req.gateway ? `streaming gateway: MediaMTX v1.21.0, web UI tab ${req.gatewayUi ? 'yes' : 'no'}` : '',
          req.omt ? `OMT receiver: yes, web UI tab ${req.omtUi ? 'yes' : 'no'}` : '',
          req.output
            ? `HDMI formats and area of interest: yes, web UI tab ${req.outputUi ? 'yes' : 'no'}; the decoder restarts so the shim loads`
            : '',
          req.stagetimer ? `Stagetimer: yes, web UI tab ${req.stagetimerUi ? 'yes' : 'no'}` : '',
          ...(req.modules as string[]).map(m => `module ${m.split('/').pop()?.replace(/\.t?gz$/, '')} 1.0: 4 files, 3.1 KB`),
        ].filter(Boolean),
      }
      emit(job, 'done')
      return lastBuilt
    }
    case 'play_save':
      return undefined
    case 'play_send': {
      const job = 'play-send'
      emit(job, 'sending', 0, null, `http://${a.address}`)
      await wait(1500)
      if (fails) {
        emit(job, 'failed', 0, null, 'BirdUI did not accept that password')
        throw 'BirdUI did not accept that password'
      }
      emit(job, 'waiting-for-unit')
      await wait(2500)
      emit(job, 'done')
      return true
    }
    case 'play_flash':
    case 'play_write_partitions': {
      const job = cmd === 'play_flash' ? 'play-flash' : 'play-partitions'
      emit(job, 'connecting')
      await wait(500)
      if (cmd === 'play_flash' && playUnits()[0]?.mode === 'maskrom') {
        emit(job, 'pushing-loader', 0, null, 'loader: 0x0471, 4094 bytes')
        await wait(900)
        emit(job, 'pushing-loader', 0, null, 'loader: 0x0472, 176512 bytes')
        await wait(900)
        emit(job, 'waiting', 0, null, 'for the unit to come back with the loader running')
        await wait(1500)
      }
      const total = cmd === 'play_flash' ? 2_463_000_000 : 17_000_000
      await count(job, 'writing', total, 30)
      if (fails) {
        const msg = 'writing rootfs at sector 0x1a4000: the unit stopped answering'
        emit(job, 'failed', 0, null, msg)
        throw msg
      }
      emit(job, 'verifying', 0, null, 'this unit cannot be read back at or above sector 0x10000')
      await count(job, 'verifying', total, 6)
      emit(job, 'restarting')
      await wait(400)
      emit(job, 'done')
      const outcome: FlashOutcome =
        cmd === 'play_flash'
          ? {
              notes: a.req.injectBuilt || a.req.injectFile
                ? ['package: 49800000 bytes at rootfs+4687872 (2552832 sectors still spare)', 'filesystem: 9 blocks patched']
                : [],
              unverified: ['boot from sector 0x0a000', 'recovery from sector 0x2a000', 'oem from sector 0x5a000', 'rootfs from sector 0x7a000'],
              injected: Boolean(a.req.injectBuilt || a.req.injectFile),
            }
          : { notes: ['boot: 17000000 bytes at sector 0xa000 (81% of the partition)'], unverified: ['boot from sector 0x0a000'], injected: false }
      return outcome
    }
    case 'pick_save':
      return `/Users/you/Downloads/${a.name}`
    default:
      return NOT_MINE
  }
}
