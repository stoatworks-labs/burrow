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
  BatchPlan,
  CatalogInfo,
  Environment,
  OpRequest,
  PluginView,
  Progress,
  Settings,
} from './types'
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
  videoUrl: (videoId: string) => invoke<string>('video_url', { videoId }),
  openDemo: (slug: string) => invoke<void>('open_demo', { slug }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
}

export const onProgress = (h: (p: Progress) => void) => listenRaw<Progress>('batch-progress', h)
export const onFinished = (h: (o: BatchOutcome) => void) =>
  listenRaw<BatchOutcome>('batch-finished', h)

/** Bytes, for a person. */
export function humanSize(n: number | null | undefined): string {
  if (!n) return ''
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} KB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}

/** A date, for a person. Catalogue dates are plain `YYYY-MM-DD`. */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
