/*
 * The bridge to Rust — and, when there is no Rust, a mock.
 *
 * The mock is not a toy. It is how the whole UI gets driven in an ordinary
 * browser: every awkward state (offline, a stale catalogue, a half-finished
 * uninstall, a foreign bundle, a cancelled password prompt) is reachable from
 * a query parameter, which means they can be *looked at* during development
 * and captured as screenshots without a machine in that state.
 *
 * av-launcher does the same thing in `src/main.js`, and its screenshot script
 * drives it with headless Chrome to produce the README images.
 */

import type {
  BatchOutcome,
  FormatId,
  BatchPlan,
  CatalogInfo,
  Environment,
  OpRequest,
  PluginView,
  Progress,
  Settings,
  Claimable,
  ClaimedEntry,
  UpdateInfo,
  UpdateProgress,
} from './types'
import type {
  BuildRequest,
  BuiltInfo,
  CanaryRelease,
  Description,
  FlashOutcome,
  FwProgress,
  ImageSummary,
  KitOffers,
  PlayUnit,
  PortInfo,
} from './firmware'
import { mockInvoke, mockListen } from './mock'

const hasTauri =
  typeof window !== 'undefined' && Boolean((window as any).__TAURI__?.core)

export const isMock = !hasTauri

async function realInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

async function realListen<T>(event: string, handler: (p: T) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, e => handler(e.payload))
}

const invoke = hasTauri ? realInvoke : mockInvoke
const listenRaw = hasTauri ? realListen : mockListen

export const api = {
  getEnvironment: () => invoke<Environment>('get_environment'),
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<Settings>('save_settings', { settings }),
  getCatalog: () => invoke<CatalogInfo | null>('get_catalog'),
  refreshCatalog: (force: boolean) => invoke<CatalogInfo>('refresh_catalog', { force }),
  listPlugins: () => invoke<PluginView[]>('list_plugins'),
  rescan: () => invoke<PluginView[]>('rescan'),
  planBatch: (requests: OpRequest[]) => invoke<BatchPlan>('plan_batch', { requests }),
  runBatch: (plan: BatchPlan) => invoke<BatchOutcome>('run_batch', { plan }),
  cancelBatch: (batch: string) => invoke<void>('cancel_batch', { batch }),
  demoUrl: (slug: string) => invoke<string | null>('demo_url', { slug }),
  videoUrl: (slug: string) => invoke<string | null>('video_url', { slug }),
  openDemo: (slug: string) => invoke<void>('open_demo', { slug }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  saveCompose: (slug: string, text: string) =>
    invoke<string>('save_compose', { slug, text }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  /** Everything on this machine Burrow could adopt but has not. */
  scanClaimable: () => invoke<Claimable[]>('scan_claimable'),
  /** What the user has adopted, so it can be handed back. */
  listClaimed: () => invoke<ClaimedEntry[]>('list_claimed'),
  /** Adopt one payload. Returns the refreshed list, so the row updates. */
  claim: (request: {
    slug: string
    format: FormatId
    destinationId: string
    names: string[]
    version: string | null
  }) => invoke<PluginView[]>('claim', { request }),
  /** Stop managing it. Deletes nothing. */
  release: (slug: string, format: FormatId, destinationId: string) =>
    invoke<PluginView[]>('release', { slug, format, destinationId }),
  clientVersion: () => invoke<string>('client_version'),
  checkUpdate: () => invoke<UpdateInfo>('check_update'),
  /** Does not resolve on success: the app restarts into the new version. */
  installUpdate: () => invoke<void>('install_update'),

  // Device firmware. Every one of these acts only when asked: nothing scans
  // for devices or fetches firmware because the tab was opened.
  canaryRelease: () => invoke<CanaryRelease>('canary_release'),
  canaryPorts: (all: boolean) => invoke<PortInfo[]>('canary_ports', { all }),
  canaryDescribe: (port: string) => invoke<Description>('canary_describe', { port }),
  canaryWrite: (req: {
    port: string
    variant: string | null
    ownFiles: string[]
    eraseAll: boolean
    allowForeign: boolean
  }) => invoke<void>('canary_write', { req }),
  playDevices: () => invoke<PlayUnit[]>('play_devices'),
  playInspectImage: (path: string) => invoke<ImageSummary>('play_inspect_image', { path }),
  playKit: () => invoke<KitOffers>('play_kit'),
  playBuild: (req: BuildRequest) => invoke<BuiltInfo>('play_build', { req }),
  playSave: (id: string, path: string) => invoke<void>('play_save', { id, path }),
  /** True when the unit answered again after taking the package. */
  playSend: (id: string, address: string, password: string) =>
    invoke<boolean>('play_send', { id, address, password }),
  playFlash: (req: {
    key: string
    image: string
    injectBuilt: string | null
    injectFile: string | null
    verify: boolean
  }) => invoke<FlashOutcome>('play_flash', { req }),
  playWritePartitions: (req: {
    key: string
    files: { partition: string; path: string }[]
    allowProtected: boolean
    verify: boolean
  }) => invoke<FlashOutcome>('play_write_partitions', { req }),
  pickFiles: (purpose: string) => invoke<string[] | null>('pick_files', { purpose }),
  pickSave: (name: string) => invoke<string | null>('pick_save', { name }),
}

export const onProgress = (h: (p: Progress) => void) => listenRaw<Progress>('batch-progress', h)
export const onFinished = (h: (o: BatchOutcome) => void) =>
  listenRaw<BatchOutcome>('batch-finished', h)
/* Its own event, not `batch-progress`: a self-update and a plugin install must
   not be able to drive the same progress bar. */
export const onUpdateProgress = (h: (p: UpdateProgress) => void) =>
  listenRaw<UpdateProgress>('update-progress', h)
/* Its own event too: a device write has nothing to do with a plugin batch,
   and must not be able to drive the strip that shows one. */
export const onFirmwareProgress = (h: (p: FwProgress) => void) =>
  listenRaw<FwProgress>('firmware-progress', h)

/**
 * Bytes, for a person.
 *
 * Goes as far as GB because a whole section's worth of downloads does: one
 * plugin is never a gigabyte, forty of them are, and "1214.2 MB" is a number
 * to decode rather than read.
 */
export function humanSize(n: number | null | undefined): string {
  if (!n) return ''
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} KB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}

/** A date, for a person. Catalogue dates are plain `YYYY-MM-DD`. */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
