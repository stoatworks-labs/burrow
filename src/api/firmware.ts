/*
 * The Device firmware tab's half of the bridge: the shapes the Rust commands
 * in src-tauri/src/firmware.rs return, field for field.
 */

export interface PortInfo {
  name: string
  vid: number | null
  pid: number | null
  product: string | null
  serialNumber: string | null
  /** The S3's own USB port, which resets into its ROM by itself. */
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

export interface Description {
  port: string
  facts: { chip: string; flashBytes: number | null; secureBoot: boolean; flashEncryption: boolean }
  mac: string | null
  flashLabel: string
  partitions: EspPartition[] | null
  /** What the bootloader will boot. Null when the table could not be read. */
  running: { slot: number; offset: number; app: AppDescription | null } | null
  /** Reasons this unit must not be written at all. */
  problems: string[]
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
  recommended: boolean
  app: AppDescription
  parts: Part[]
}

export interface CanaryRelease {
  /** The catalogue's version, the GitHub release tag. */
  version: string | null
  /** The firmware's own id, as a unit reports it. */
  id: string
  date: string
  commit: string
  variants: Variant[]
}

export interface DevicePartition {
  name: string
  firstLba: number
  lastLba: number
  sectors: number
}

export type PlayMode = 'maskrom' | 'loader'

export interface PlayUnit {
  key: string
  productId: number
  product: string | null
  bcdSays: PlayMode
  /** Windows only: the driver bound to the unit. */
  driver: string | null
  mode: PlayMode
  partitions: DevicePartition[] | null
  sectors: number | null
}

export interface RkPartition {
  name: string
  file: string
  size: number
  flashAddr: number
  offset: number
  flashed: boolean
}

export interface ImageSummary {
  path: string
  size: number
  chip: string
  model: string
  built: string
  partitions: RkPartition[]
  table: { name: string; grow: boolean; startSector: number; sectors: number | null }[]
  /** The largest package that can be injected, in bytes. */
  packageRoom: number | null
}

export interface KitOffers {
  version: string
  tailscale: boolean
  tailscaleUi: boolean
  kvm: boolean
  play: boolean
  playPdf: boolean
  playExfat: boolean
  cam: boolean
  gateway: boolean
  mediamtxVersion: string
}

export interface BuildRequest {
  sshKey: string
  tag: string
  tailscale: boolean
  kvm: boolean
  play: boolean
  cam: boolean
  camUi: boolean
  gateway: boolean
  gatewayUi: boolean
  reboot: boolean
  modules: string[]
  tailscaleFile?: string | null
  mediamtxFile?: string | null
}

export interface BuiltInfo {
  id: string
  name: string
  size: number
  sha256: string
  /** The tar's digest, the one to compare with the web patcher's. */
  tarSha256: string
  log: string[]
}

export interface FlashOutcome {
  notes: string[]
  /** Stretches the unit cannot be read back across. Not failures. */
  unverified: string[]
  injected: boolean
}

export type FwPhase =
  | 'downloading'
  | 'connecting'
  | 'erasing'
  | 'pushing-loader'
  | 'waiting'
  | 'writing'
  | 'verifying'
  | 'restarting'
  | 'building'
  | 'sending'
  | 'waiting-for-unit'
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
  connecting: 'Talking to the unit',
  erasing: 'Erasing the whole flash',
  'pushing-loader': 'Starting the loader',
  waiting: 'Waiting for the unit',
  writing: 'Writing — do not unplug it',
  verifying: 'Checking what was written',
  restarting: 'Restarting it',
  building: 'Building the package',
  sending: 'Sending to the PLAY',
  'waiting-for-unit': 'Waiting for the PLAY to come back',
  done: 'Done',
  failed: 'Stopped',
}

export function hex(n: number, width = 5): string {
  return '0x' + n.toString(16).padStart(width, '0')
}
