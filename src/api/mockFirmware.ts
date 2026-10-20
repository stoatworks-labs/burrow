/*
 * The Device firmware tab's fake backend.
 *
 *   ?device=both|none|canary|canary-old|canary-foreign|blank|s3-small|
 *           play-maskrom|play-loader|play-win-nodriver
 *                       what "Look for a unit" finds (both = a CANary and a
 *                       PLAY in loader mode)
 *   ?fw=ok|fail         whether a write gets to the end
 *   ?job=slow           every step takes long enough to look at
 *
 * No unit, no USB, no network: the answers are the real shapes, filled with
 * what a real unit said on the bench where there is one to copy.
 */

import type {
  BuiltInfo,
  CanaryRelease,
  Description,
  DevicePartition,
  FlashOutcome,
  FwPhase,
  FwProgress,
  ImageSummary,
  KitOffers,
  PlayUnit,
  PortInfo,
} from './firmware'

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const device = params.get('device') ?? 'both'
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

const CANARY_PORT: PortInfo = {
  name: '/dev/cu.usbmodem1101',
  vid: 0x303a,
  pid: 0x1001,
  product: 'USB JTAG/serial debug unit',
  serialNumber: '7C:DF:A1:E2:4B:10',
  usbSerialJtag: true,
}

const CANARY_TABLE = [
  { label: 'nvs', type: 1, subtype: 2, offset: 0x9000, size: 0x6000 },
  { label: 'otadata', type: 1, subtype: 0, offset: 0xf000, size: 0x2000 },
  { label: 'phy_init', type: 1, subtype: 1, offset: 0x11000, size: 0x1000 },
  { label: 'ota_0', type: 0, subtype: 0x10, offset: 0x20000, size: 0x1d0000 },
  { label: 'ota_1', type: 0, subtype: 0x11, offset: 0x1f0000, size: 0x1d0000 },
  { label: 'coredump', type: 1, subtype: 3, offset: 0x3c0000, size: 0x20000 },
]

function app(project: string, version: string, date: string) {
  return { version, project, time: '14:11:25', date, idfVersion: 'v5.5.5' }
}

function describe(): Description {
  const base: Description = {
    port: CANARY_PORT.name,
    facts: { chip: 'ESP32-S3', flashBytes: 8 * 1024 * 1024, secureBoot: false, flashEncryption: false },
    mac: '7c:df:a1:e2:4b:10',
    flashLabel: '8MB',
    partitions: CANARY_TABLE,
    running: { slot: 0, offset: 0x20000, app: app('dbcanary', 'main-60a871f', 'Sep 26 2026') },
    problems: [],
  }
  switch (device) {
    case 'canary-old':
      return { ...base, running: { slot: 1, offset: 0x1f0000, app: app('dbcanary', 'main-4bd1ac5', 'Sep 20 2026') } }
    case 'canary-foreign':
      return { ...base, running: { slot: 0, offset: 0x10000, app: app('blinky', 'v1.0', 'Jan  4 2026') }, partitions: null }
    case 'blank':
      return { ...base, running: null, partitions: null }
    case 's3-small':
      return {
        ...base,
        facts: { ...base.facts, flashBytes: 4 * 1024 * 1024 },
        flashLabel: '4MB',
        problems: ['this unit has 4 MB of flash, and a CANary has 8 MB'],
      }
    default:
      return base
  }
}

const RELEASE: CanaryRelease = {
  version: 'v0.2.0',
  id: 'main-ff4110d',
  date: '2026-09-27',
  commit: 'ff4110d1fe9e7f60b536112d8fb35dbe3a6a20cc',
  variants: [
    {
      id: 'standard',
      name: 'Standard',
      summary: 'Ethernet bridge only. The USB-C port stays a serial console, so the next flash needs no buttons.',
      recommended: true,
      app: app('canary', 'main-ff4110d', 'Sep 27 2026'),
      parts: [
        { name: 'bootloader', offset: 0x0, path: 'main-ff4110d/standard/bootloader.bin', size: 20928, sha256: '' },
        { name: 'partition table', offset: 0x8000, path: 'main-ff4110d/standard/partition-table.bin', size: 3072, sha256: '' },
        { name: 'otadata', offset: 0xf000, path: 'main-ff4110d/standard/ota_data_initial.bin', size: 8192, sha256: '' },
        { name: 'app', offset: 0x20000, path: 'main-ff4110d/standard/canary.bin', size: 461184, sha256: '' },
      ],
    },
    {
      id: 'usb-network',
      name: 'USB network',
      summary:
        'Ethernet bridge, plus a settings page over the USB-C cable. After 8 s the USB-C port stops being a serial port, so reflashing needs BOOT held while EN is tapped.',
      recommended: false,
      app: app('canary', 'main-ff4110d', 'Sep 27 2026'),
      parts: [
        { name: 'bootloader', offset: 0x0, path: 'main-ff4110d/usb-network/bootloader.bin', size: 20928, sha256: '' },
        { name: 'partition table', offset: 0x8000, path: 'main-ff4110d/usb-network/partition-table.bin', size: 3072, sha256: '' },
        { name: 'otadata', offset: 0xf000, path: 'main-ff4110d/usb-network/ota_data_initial.bin', size: 8192, sha256: '' },
        { name: 'app', offset: 0x20000, path: 'main-ff4110d/usb-network/canary.bin', size: 598704, sha256: '' },
      ],
    },
  ],
}

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
  mediamtxVersion: 'v1.21.0',
}

let lastBuilt: BuiltInfo | null = null

export async function mockFirmware(cmd: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  const a = (args ?? {}) as any
  switch (cmd) {
    case 'canary_release':
      emit('canary-release', 'downloading', 0, 1_104_000)
      await count('canary-release', 'downloading', 1_104_000, 6)
      emit('canary-release', 'done')
      return RELEASE
    case 'canary_ports': {
      if (!device.startsWith('canary') && !['both', 'blank', 's3-small'].includes(device)) {
        return a.all ? [{ name: '/dev/cu.Bluetooth-Incoming-Port', vid: null, pid: null, product: null, serialNumber: null, usbSerialJtag: false }] : []
      }
      const extra = a.all
        ? [{ name: '/dev/cu.Bluetooth-Incoming-Port', vid: null, pid: null, product: null, serialNumber: null, usbSerialJtag: false }]
        : []
      return [CANARY_PORT, ...extra]
    }
    case 'canary_describe':
      await wait(700)
      return describe()
    case 'canary_write': {
      const job = 'canary-write'
      const req = a.req
      const v = RELEASE.variants.find(x => x.id === req.variant) ?? RELEASE.variants[0]
      const total = v.parts.reduce((n, p) => n + p.size, 0)
      emit(job, 'connecting')
      await wait(600)
      if (req.eraseAll) {
        emit(job, 'erasing')
        await wait(1500)
      }
      await count(job, 'writing', total)
      if (fails) {
        emit(job, 'restarting')
        await wait(300)
        const msg = 'writing: the unit stopped answering at 0x3a000'
        emit(job, 'failed', 0, null, msg)
        throw msg
      }
      await count(job, 'verifying', total, 6)
      emit(job, 'restarting')
      await wait(400)
      emit(job, 'done')
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
          req.gateway ? 'streaming gateway: MediaMTX v1.21.0, web UI tab yes' : '',
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
    case 'pick_files':
      return (
        {
          image: ['/Users/you/Downloads/PLAY_1.0.30.img'],
          package: ['/Users/you/Downloads/BirdDog_PLAY-custom-web.fw'],
          module: ['/Users/you/Projects/hello-module.tgz'],
          tailscale: ['/Users/you/Downloads/tailscale_1.90.0_arm64.tgz'],
          mediamtx: ['/Users/you/Downloads/mediamtx_v1.21.0_linux_arm64.tar.gz'],
          'canary-build': ['/Users/you/canary/build/bootloader/bootloader.bin', '/Users/you/canary/build/canary.bin'],
          partition: ['/Users/you/companion-play/boot.img'],
        } as Record<string, string[]>
      )[a.purpose] ?? null
    case 'pick_save':
      return `/Users/you/Downloads/${a.name}`
    default:
      return NOT_MINE
  }
}
