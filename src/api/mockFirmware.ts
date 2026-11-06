/*
 * The Device firmware tab's fake backend.
 *
 *   ?device=canary|canary-old|canary-foreign|blank|s3-small|secure|nanode|cuckoo|none
 *                       what "Look for boards" finds and what reading it says
 *   ?files=loose|zip    what "Open a file…" picks
 *   ?fw=ok|fail         whether a write gets to the end
 *   ?job=slow           every step takes long enough to look at
 *
 * No unit, no serial port, no network. The packages are the real manifests
 * burrow-device's tests use; the plan is a rough copy of what Rust works out,
 * enough to see each state of the tab, never a substitute for the gate.
 */

import canaryManifest from '../../crates/burrow-device/tests/fixtures/canary/manifest-v2.json'
import cuckooManifest from '../../crates/burrow-device/tests/fixtures/cuckoo/manifest.json'
import nanodeManifest from '../../crates/burrow-device/tests/fixtures/nanode/manifest.json'
import type {
  Description,
  EspPartition,
  EspRelease,
  FwPhase,
  FwProgress,
  Link,
  OpenedFiles,
  Package,
  PlanView,
  PortInfo,
  Source,
  WantView,
} from './firmware'
import { hex, mb } from './firmware'

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const device = params.get('device') ?? 'canary'
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
        zipSha256: '68187de72cc85a5feaab371c1423d33af2e83eee59ba9af3228c6679e0f6e5c8',
        links: links(pkg),
      } satisfies EspRelease
    }
    case 'esp_ports':
      await wait(250)
      if (device === 'none') return []
      return device === 'nanode' || a.all ? [PORTS.bridge, ...(device === 'nanode' ? [] : [PORTS.usb])] : [PORTS.usb]
    case 'esp_describe':
      await wait(900)
      unit = describe(a.port)
      return unit
    case 'esp_forget_unit':
      unit = null
      return undefined
    case 'pick_files':
      return files === 'zip'
        ? ['/Users/you/Downloads/cuckoo-firmware-main-4300e74.zip']
        : LOOSE.map(f => `/Users/you/cuckoo/build/${f.name}`)
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
    default:
      return NOT_MINE
  }
}
