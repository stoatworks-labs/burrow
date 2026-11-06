/*
 * The Device firmware tab's half of the bridge: the shapes the Rust commands
 * in src-tauri/src/firmware.rs return, field for field.
 *
 * The package types (DeviceDef, Package, Release, Variant, Part) are the
 * Stoatworks Flasher's schema 2, its docs/PACKAGE.md, as burrow-device reads
 * them.
 */

export interface PortInfo {
  name: string
  vid: number | null
  pid: number | null
  product: string | null
  manufacturer: string | null
  serialNumber: string | null
  /** Espressif's own USB-Serial/JTAG port, which resets into the ROM by itself. */
  usbSerialJtag: boolean
}

export interface AppDescription {
  version: string
  project: string
  time: string
  date: string
  idfVersion: string
}

export interface EspPartition {
  label: string
  type: number
  subtype: number
  offset: number
  size: number
}

export interface UnitFacts {
  /** esptool's spelling: "ESP32-S3". */
  chipName: string
  flashBytes: number | null
  flashLabel: string
  secureBoot: boolean
  flashEncryption: boolean
}

export interface Description {
  port: string
  facts: UnitFacts
  mac: string | null
  tableOffset: number
  /** The unit's partition table, if it has one Burrow can read. */
  table: EspPartition[] | null
  /** What the bootloader will boot. Null when the table could not be read. */
  running: { partition: string; offset: number; app: AppDescription | null } | null
  /** Reasons this unit must not be written at all. */
  problems: string[]
}

export interface DeviceDef {
  id: string
  name: string
  chip: string
  flashSize: number
  projects: string[]
  repo?: string
  page?: string
  status?: string
  usb?: { vendorId: number; productId?: number; label?: string }[]
  connect?: string[]
  notes?: string[]
  bootMode?: string[]
  keeps?: string
  tableOffset?: number
  baud?: number
}

export interface Part {
  name: string
  offset: number
  path: string
  size: number
  sha256: string
}

export interface Variant {
  id: string
  name: string
  summary: string
  recommended?: boolean
  after?: string
  app: AppDescription
  parts: Part[]
}

export interface Release {
  id: string
  tag?: string
  date: string
  commit: string
  notes?: string
  variants: Variant[]
}

export interface Package {
  schema: number
  device: DeviceDef
  releases: Release[]
}

export interface Link {
  label: string
  name: string
  url: string
}

export interface EspRelease {
  slug: string
  /** The catalogue's version for the entry. */
  version: string | null
  package: Package
  zipUrl: string
  zipSha256: string
  /** Direct downloads on the device's GitHub repo, for a tagged release. */
  links: Link[]
}

export interface LooseInfo {
  name: string
  size: number
  what: string
  kind: string
}

export type OpenedFiles =
  | { kind: 'package'; package: Package; links: Link[] }
  | { kind: 'loose'; files: LooseInfo[] }

export type Source =
  | { kind: 'catalog'; slug: string; release: string; variant: string }
  | { kind: 'package'; release: string; variant: string }
  | { kind: 'files'; typed: string[] }

export interface WantView {
  device: string | null
  chip: string | null
  projects: string[] | null
  minFlash: number | null
  tableOffset: number
  baud: number | null
  after: string | null
}

export interface PlanRow {
  name: string
  offset: number
  hex: string
  size: number
  what: string
}

export interface PlanView {
  error: string | null
  rows: PlanRow[]
  problems: string[]
  notes: string[]
  replace: string | null
  want: WantView
  places: { name: string; placed: string | null }[]
  unitRead: boolean
}

export type FwPhase =
  | 'downloading'
  | 'connecting'
  | 'erasing'
  | 'writing'
  | 'verifying'
  | 'restarting'
  | 'done'
  | 'failed'

export interface FwProgress {
  job: string
  phase: FwPhase
  done: number
  total: number | null
  message: string | null
}

export const FW_PHASE_LABEL: Record<FwPhase, string> = {
  downloading: 'Downloading',
  connecting: 'Talking to the board',
  erasing: 'Erasing the whole flash',
  writing: 'Writing — do not unplug it',
  verifying: 'Checking what was written',
  restarting: 'Restarting it',
  done: 'Done',
  failed: 'Stopped',
}

export function hex(n: number, width = 5): string {
  return '0x' + n.toString(16).padStart(width, '0')
}

/** "8 MB", "256 KB", as the gate writes them. */
export function mb(n: number): string {
  return n >= 1048576 ? `${n / 1048576} MB` : `${n / 1024} KB`
}
