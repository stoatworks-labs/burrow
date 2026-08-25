/*
 * A fake backend, driven by query parameters.
 *
 * Every state the real app can be in that is awkward to reproduce on demand —
 * offline, a stale catalogue, a plugin installed by somebody else, a cancelled
 * password prompt — is reachable here by adding a parameter to the URL. That
 * makes them reviewable in a browser and capturable as screenshots.
 *
 *   ?tab=whatsnew|video|audio|netinfra|firmware|settings   (`plugins` = video)
 *   ?source=network|cache|baked        where the catalogue came from
 *   ?state=ok|offline|error            what the last refresh did
 *   ?installed=tinsel:ffgl@1.0.1,orrery:ffgl,idler:ffgl@?
 *                                      version behind / current / unknown
 *   ?ofx=missing|empty|readonly|ok     the OpenFX destination's condition
 *   ?job=running|failed|cancelled
 *   ?seen=none|current                 first run, or a real baseline
 *
 * It serves the catalogue that actually ships in the app, so the data under
 * test is the data users get.
 */

import type {
  BatchOutcome,
  BatchPlan,
  CatalogInfo,
  CategoryId,
  Destination,
  FormatId,
  InstallState,
  Note,
  OpRequest,
  PluginView,
  Progress,
  Settings,
  Slot,
} from './types'

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
)
const p = (k: string, fallback = '') => params.get(k) ?? fallback

type CatalogEntry = {
  slug: string
  name: string
  category?: CategoryId
  kind?: string
  parent?: string | null
  hook: string
  summary: string
  blurb: string | null
  version: string | null
  published: string | null
  thumb: string | null
  status: string | null
  tags: string[]
  demo: string | null
  guide: string | null
  youtube: string | null
  videoUrl: string | null
  releaseUrl: string | null
  releasesUrl: string | null
  builds: Record<string, Record<string, { url: string; size?: number; entries?: string[]; extras?: string[] }>>
  /** The arch-aware flat list. Preferred over `builds` where it exists. */
  assets?: Array<{
    format: FormatId
    platform: string
    arch?: string
    url: string
    size?: number
    extras?: string[]
  }>
  notes: Note[]
  versions?: any[]
}

let catalogCache: CatalogEntry[] | null = null

async function catalog(): Promise<CatalogEntry[]> {
  if (catalogCache) return catalogCache
  try {
    const res = await fetch('./catalog.json')
    const data = await res.json()
    catalogCache = data.entries as CatalogEntry[]
  } catch {
    catalogCache = []
  }
  return catalogCache!
}

/** `?installed=tinsel:ffgl@1.0.1,orrery:ffgl+openfx,idler:ffgl@?` */
function installedSpec(): Map<string, Map<FormatId, string | null>> {
  const out = new Map<string, Map<FormatId, string | null>>()
  const raw = p('installed')
  if (!raw) return out
  for (const item of raw.split(',')) {
    const [slug, rest] = item.split(':')
    if (!slug || !rest) continue
    const [formats, version] = rest.split('@')
    const m = out.get(slug) ?? new Map<FormatId, string | null>()
    for (const f of formats.split('+')) {
      m.set(f as FormatId, version === '?' ? null : version ?? 'current')
    }
    out.set(slug, m)
  }
  return out
}

function destinations(): Destination[] {
  const ofx = p('ofx', 'missing')
  return [
    {
      id: 'arena',
      format: 'ffgl',
      label: 'Resolume Arena',
      path: '~/Documents/Resolume Arena/Extra Effects',
      exists: true,
      writable: true,
      needsElevation: false,
      custom: false,
    },
    {
      id: 'openfx',
      format: 'openfx',
      label: 'OpenFX hosts',
      path: '/Library/OFX/Plugins',
      exists: ofx !== 'missing',
      writable: ofx === 'ok',
      needsElevation: ofx !== 'ok',
      custom: false,
    },
    {
      id: 'adobe',
      format: 'adobe',
      label: 'After Effects & Premiere Pro',
      path: '/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore',
      exists: true,
      writable: false,
      needsElevation: true,
      custom: false,
    },
    // None of these four can ask for a password — see dest::applications_dir
    // and the test that pins it. The mock says so too, or the preview would
    // show a padlock the real app never shows.
    {
      id: 'vst3',
      format: 'vst3',
      label: 'VST3 hosts',
      path: '~/Library/Audio/Plug-Ins/VST3',
      exists: true,
      writable: true,
      needsElevation: false,
      custom: false,
    },
    {
      id: 'au',
      format: 'au',
      label: 'Logic Pro & Final Cut Pro',
      path: '~/Library/Audio/Plug-Ins/Components',
      exists: true,
      writable: true,
      needsElevation: false,
      custom: false,
    },
    {
      id: 'applications',
      format: 'app',
      label: 'Applications',
      path: '/Applications',
      exists: true,
      writable: true,
      needsElevation: false,
      custom: false,
    },
    {
      id: 'companion',
      format: 'companion',
      label: 'Companion modules',
      path: '~/Documents/Companion Modules',
      exists: false,
      writable: true,
      needsElevation: false,
      custom: false,
    },
  ]
}

function stateFor(
  slug: string,
  format: FormatId,
  latest: string | null,
  has: Map<string, Map<FormatId, string | null>>,
  offered: boolean,
): InstallState {
  if (!offered) return { state: 'no-build' }
  const entry = has.get(slug)?.get(format)
  if (entry === undefined) return { state: 'not-installed' }
  if (entry === null) return { state: 'version-unknown', entries: [`${slug}.bundle`] }
  if (entry === 'current' || entry === latest?.replace(/^v/, '')) {
    return { state: 'up-to-date', version: latest ?? '1.0.0', source: 'info-plist' }
  }
  return {
    state: 'update-available',
    installed: entry,
    latest: latest ?? '1.0.0',
    source: 'info-plist',
  }
}

let currentSettings: Settings = {
  schema: 2,
  // Everything that needs no password, as the real defaults are.
  defaultFormats: ['ffgl', 'vst3', 'au', 'app', 'companion'],
  pluginFormats: {},
  destinations: {},
  catalogUrl: 'https://stoatworks-labs.com/catalog.json',
  allowGithubFallback: true,
  seen: {},
  seenAt: null,
  lastRefresh: null,
}

const progressHandlers: Array<(p: Progress) => void> = []
const finishedHandlers: Array<(o: BatchOutcome) => void> = []

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case 'get_environment':
      return {
        platform: 'macos',
        resolume: [
          { name: 'Resolume Arena', loadsEffects: true, note: null },
          {
            name: 'Resolume Alley',
            loadsEffects: false,
            note: 'Alley links the same effects engine but does not scan an Extra Effects folder, so plugins installed for it would never appear.',
          },
        ],
        otherHosts: [
          {
            name: 'Bitfocus Companion',
            loadsEffects: true,
            note: "Modules go in the folder Companion's Settings → Developer modules path points at. Set that to the folder below and restart Companion.",
          },
        ],
        destinations: destinations(),
      } as T

    case 'get_settings':
      return currentSettings as T

    case 'save_settings': {
      currentSettings = args!.settings as Settings
      return currentSettings as T
    }

    case 'get_catalog':
    case 'refresh_catalog': {
      const entries = await catalog()
      const state = p('state', 'ok')
      const info: CatalogInfo = {
        source: (p('source', state === 'ok' ? 'network' : 'baked') as any),
        generated: new Date().toISOString(),
        fetchedAtEpoch: Math.floor(Date.now() / 1000),
        entryCount: entries.length,
        error:
          state === 'offline'
            ? 'could not connect — check the network'
            : state === 'error'
              ? 'that address returned text/html rather than the plugin list — most likely an error page or a network sign-in screen'
              : null,
        newerSchema: false,
      }
      return info as T
    }

    case 'list_plugins':
    case 'rescan': {
      const entries = await catalog()
      const has = installedSpec()
      const dests = destinations()
      const views: PluginView[] = entries.map(e => {
        // Mirrors `Entry::known_formats` in Rust: a row is only asked about
        // destinations its own catalogue entry could ever occupy.
        const known = new Set<string>([
          ...Object.keys(e.builds ?? {}),
          ...(e.assets ?? []).map(a => a.format),
        ])
        const assetFor = (format: string) =>
          (e.assets ?? []).find(a => a.format === format && a.platform === 'macos') ??
          e.builds?.[format]?.macos
        const slots: Slot[] = dests
          .filter(d => known.has(d.format))
          .map(d => {
          const offered = Boolean(assetFor(d.format))
          return {
            format: d.format,
            destinationId: d.id,
            destinationLabel: d.label,
            state: stateFor(e.slug, d.format, e.version, has, offered),
            needsElevation: d.needsElevation,
            missing: [],
            foreign: false,
            size: assetFor(d.format)?.size ?? null,
          }
        })
        const bucket = slots.some(s => s.state.state === 'update-available')
          ? 'update-available'
          : slots.some(
                s => s.state.state === 'up-to-date' || s.state.state === 'version-unknown',
              )
            ? 'up-to-date'
            : 'not-installed'
        return {
          slug: e.slug,
          name: e.name,
          category: e.category ?? 'video',
          kind: e.kind ?? 'plugin',
          parent: e.parent ?? null,
          hook: e.hook,
          summary: e.summary,
          blurb: e.blurb,
          version: e.version,
          published: e.published,
          thumb: e.thumb,
          status: e.status,
          tags: e.tags ?? [],
          demo: e.demo,
          guide: e.guide,
          youtube: e.youtube,
          videoUrl: e.videoUrl ?? null,
          releaseUrl: e.releaseUrl,
          releasesUrl: e.releasesUrl,
          slots,
          bucket,
          hasOverride: Boolean(currentSettings.pluginFormats[e.slug]),
          wantedFormats: currentSettings.pluginFormats[e.slug] ?? currentSettings.defaultFormats,
          notes: e.notes ?? [],
          versions: e.versions ?? [],
          extras: [
            ...Object.values(e.builds ?? {}).flatMap(pl =>
              Object.values(pl).flatMap(a => a.extras ?? []),
            ),
            ...(e.assets ?? []).flatMap(a => a.extras ?? []),
          ],
        }
      })
      return views as T
    }

    case 'plan_batch': {
      const requests = args!.requests as OpRequest[]
      const entries = await catalog()
      const dests = destinations()
      const plan: BatchPlan = {
        batch: 'mock' + Math.random().toString(16).slice(2, 10),
        units: requests.map(r => {
          const e = entries.find(x => x.slug === r.slug)
          const d = dests.find(x => x.id === r.destinationId)!
          return {
            slug: r.slug,
            name: e?.name ?? r.slug,
            format: r.format,
            destinationId: r.destinationId,
            destination: d.path,
            action: r.action,
            url: e?.builds?.[r.format]?.macos?.url ?? null,
            size: e?.builds?.[r.format]?.macos?.size ?? null,
            entries: e?.builds?.[r.format]?.macos?.entries ?? [],
            needsElevation: d.needsElevation,
          }
        }),
        downloadBytes: 0,
        needsElevation: requests.some(
          r => dests.find(d => d.id === r.destinationId)?.needsElevation,
        ),
        elevatedDestinations: dests.filter(d => d.needsElevation).map(d => d.path),
        warnings: [],
      }
      plan.downloadBytes = plan.units.reduce((a, u) => a + (u.size ?? 0), 0)
      return plan as T
    }

    case 'run_batch': {
      const plan = args!.plan as BatchPlan
      const mode = p('job', 'ok')
      for (const [i, unit] of plan.units.entries()) {
        for (const phase of ['downloading', 'extracting', 'committing'] as const) {
          progressHandlers.forEach(h =>
            h({
              batch: plan.batch,
              index: i,
              total: plan.units.length,
              slug: unit.slug,
              format: unit.format,
              phase,
              bytesDone: phase === 'downloading' ? (unit.size ?? 0) : 0,
              bytesTotal: unit.size,
              message: null,
            }),
          )
          await new Promise(r => setTimeout(r, 120))
        }
      }
      const outcome: BatchOutcome = {
        batch: plan.batch,
        units: plan.units.map(u => ({
          slug: u.slug,
          format: u.format,
          destinationId: u.destinationId,
          ok: mode === 'ok',
          cancelled: mode === 'cancelled' && u.needsElevation,
          error: mode === 'failed' ? 'the download failed (503)' : null,
        })),
        notes:
          mode === 'ok' ? ['Restart your host to pick up the change.'] : [],
      }
      finishedHandlers.forEach(h => h(outcome))
      return outcome as T
    }

    case 'cancel_batch':
    case 'open_external':
    case 'reveal_path':
      return undefined as T

    case 'demo_url':
      return `about:blank#${(args as any).slug}` as T

    // In a browser there is no loopback server and no CSP, so the published
    // URL is used directly. It still will not *play* — GitHub marks it a
    // download — which is exactly the failure the real app's proxy exists to
    // avoid, so leaving it visible here is honest.
    case 'video_url': {
      const e = (await catalog()).find(x => x.slug === (args as any).slug)
      return ((e as any)?.videoUrl ?? null) as T
    }


    case 'open_demo':
      // eslint-disable-next-line no-console
      console.info('[mock] would open the demo for', (args as any).slug)
      return undefined as T

    default:
      throw new Error(`the mock backend has no ${cmd}`)
  }
}

export async function mockListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (event === 'batch-progress') {
    progressHandlers.push(handler as any)
    return () => {
      const i = progressHandlers.indexOf(handler as any)
      if (i >= 0) progressHandlers.splice(i, 1)
    }
  }
  if (event === 'batch-finished') {
    finishedHandlers.push(handler as any)
    return () => {
      const i = finishedHandlers.indexOf(handler as any)
      if (i >= 0) finishedHandlers.splice(i, 1)
    }
  }
  return () => {}
}

export const mockInitialTab = p('tab', 'plugins')

/**
 * `?shot=1` — hide the "preview — no backend" badge for documentation images.
 *
 * The badge exists so nobody mistakes the browser preview for the running app.
 * In a README screenshot it is the wrong warning: what the image shows *is* the
 * real interface, with real plugin names, versions and release notes from the
 * catalogue that ships in the app. Only the answers about what is installed are
 * staged, which is true of every product screenshot ever taken.
 */
export const isShot = p('shot') === '1'
