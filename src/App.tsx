import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, isMock, onFinished, onProgress } from './api/backend'
import { mockInitialTab, isShot } from './api/mock'
import type {
  BatchOutcome,
  CatalogInfo,
  Environment,
  OpRequest,
  PluginView,
  Progress,
  Settings,
} from './api/types'
import { WhatsNew } from './tabs/WhatsNew'
import { Plugins } from './tabs/Plugins'
import { SettingsTab } from './tabs/Settings'
import { Banner } from './components/Banner'
import { RefreshTools } from './components/RefreshTools'
import { isFilming, runFilm } from './film'

type TabId = 'whatsnew' | 'plugins' | 'settings'

export function App() {
  const [tab, setTab] = useState<TabId>(
    (['whatsnew', 'plugins', 'settings'].includes(mockInitialTab)
      ? mockInitialTab
      : 'plugins') as TabId,
  )
  const [env, setEnv] = useState<Environment | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [catalog, setCatalog] = useState<CatalogInfo | null>(null)
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [filmQuery, setFilmQuery] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<number | null>(null)
  const [refreshResult, setRefreshResult] = useState<string | null>(null)

  /*
   * Subscribe once, on mount, before any job can start.
   *
   * The listeners are registered before the first `run_batch` is reachable —
   * `busy` gates the buttons until this effect has run — because a progress
   * event that arrives before its listener exists is simply lost, and the
   * result is a progress bar that never moves for the first install of a
   * session and works fine thereafter. Maddening to reproduce, easy to avoid.
   */
  useEffect(() => {
    const offs: Array<() => void> = []
    let cancelled = false
    ;(async () => {
      const offP = await onProgress(p => {
        setProgress(prev => ({ ...prev, [`${p.slug}:${p.format}`]: p }))
      })
      const offF = await onFinished((o: BatchOutcome) => {
        setProgress({})
        setNotes(o.notes)
        const failed = o.units.filter(u => !u.ok && !u.cancelled)
        if (failed.length > 0) {
          setError(
            failed
              .map(u => `${u.slug} (${u.format}): ${u.error ?? 'failed'}`)
              .join('\n'),
          )
        }
      })
      if (cancelled) {
        offP()
        offF()
        return
      }
      offs.push(offP, offF)
    })()
    return () => {
      cancelled = true
      offs.forEach(f => f())
    }
  }, [])

  /** What changed between two views of the list, in one short sentence. */
  const summarise = useCallback((before: PluginView[], after: PluginView[]): string => {
    const was = new Map(before.map(p => [p.slug, p]))
    let newlyBehind = 0
    let versionMoved = 0
    let installChanged = 0
    for (const p of after) {
      const b = was.get(p.slug)
      if (!b) continue
      if (b.version !== p.version) versionMoved++
      if (b.bucket !== 'update-available' && p.bucket === 'update-available') newlyBehind++
      const state = (v: PluginView) => v.slots.map(s => s.state.state).join(',')
      if (state(b) !== state(p)) installChanged++
    }
    const parts: string[] = []
    if (versionMoved) parts.push(`${versionMoved} new version${versionMoved === 1 ? '' : 's'}`)
    if (newlyBehind) parts.push(`${newlyBehind} now needs updating`)
    if (installChanged && !newlyBehind) {
      parts.push(`${installChanged} changed on disk`)
    }
    if (after.length !== before.length) {
      const d = after.length - before.length
      parts.push(d > 0 ? `${d} new plugin${d === 1 ? '' : 's'}` : `${-d} removed`)
    }
    return parts.length ? parts.join(' · ') : 'Nothing changed'
  }, [])

  const reload = useCallback(async () => {
    try {
      const [e, s, list] = await Promise.all([
        api.getEnvironment(),
        api.getSettings(),
        api.listPlugins(),
      ])
      setEnv(e)
      setSettings(s)
      setPlugins(list)
      setLastScan(Math.floor(Date.now() / 1000))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const info = await api.refreshCatalog(false)
        setCatalog(info)
      } catch (err) {
        setError(String(err))
      }
      await reload()
    })()
  }, [reload])

  /** Fetch the plugin list. The only one of the two that uses the network. */
  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    setRefreshResult(null)
    const before = plugins
    try {
      setCatalog(await api.refreshCatalog(true))
      const after = await api.listPlugins()
      setPlugins(after)
      setRefreshResult(summarise(before, after))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }, [plugins, summarise])

  /**
   * Re-read the plugin folders. No network, so it works offline and stays fast
   * — and it is the right button after installing or deleting something by
   * hand, which the catalogue knows nothing about.
   */
  const rescan = useCallback(async () => {
    setScanning(true)
    setError(null)
    setRefreshResult(null)
    const before = plugins
    try {
      const after = await api.rescan()
      setPlugins(after)
      setLastScan(Math.floor(Date.now() / 1000))
      setRefreshResult(summarise(before, after))
    } catch (err) {
      setError(String(err))
    } finally {
      setScanning(false)
    }
  }, [plugins, summarise])

  const runOps = useCallback(
    async (requests: OpRequest[]) => {
      if (requests.length === 0) return
      setBusy(true)
      setError(null)
      setNotes([])
      try {
        const plan = await api.planBatch(requests)
        await api.runBatch(plan)
        await reload()
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(false)
        setProgress({})
      }
    },
    [reload],
  )

  const saveSettings = useCallback(
    async (next: Settings) => {
      // Optimistic locally, then replaced wholesale by whatever the backend
      // normalises it to — so a correction (a format this build cannot
      // install, an override that no longer means anything) is adopted
      // visibly rather than drifting.
      setSettings(next)
      try {
        const canonical = await api.saveSettings(next)
        setSettings(canonical)
        await reload()
      } catch (err) {
        setError(String(err))
        await reload()
      }
    },
    [reload],
  )

  /*
   * Filming mode: the app drives itself through a fixed choreography for the
   * project video. Off unless BURROW_FILM=1, and it cannot install anything —
   * see src/film.ts.
   */
  useEffect(() => {
    let stop: (() => void) | undefined
    ;(async () => {
      if (await isFilming()) stop = runFilm(setTab, q => setFilmQuery(q))
    })()
    return () => stop?.()
  }, [])

  const updateCount = useMemo(
    () => plugins.filter(p => p.bucket === 'update-available').length,
    [plugins],
  )

  const loading = env === null || settings === null

  return (
    <>
      <header className="head">
        <h1>Stoatworks Burrow</h1>
        <span className="sub">Video plugins</span>
        <span className="spacer" />
        {isMock && !isShot && <span className="sub">preview — no backend</span>}
      </header>


      <nav className="tabs" role="tablist">
        <button
          className="tab"
          role="tab"
          aria-selected={tab === 'whatsnew'}
          onClick={() => setTab('whatsnew')}
        >
          What&rsquo;s new
          {updateCount > 0 && <span className="count">{updateCount}</span>}
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === 'plugins'}
          onClick={() => setTab('plugins')}
        >
          Plugin management
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === 'settings'}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </nav>

      <RefreshTools
        catalog={catalog}
        busy={busy}
        scanning={scanning}
        lastScanEpoch={lastScan}
        result={refreshResult}
        onRescan={rescan}
        onCheck={refresh}
      />

      <Banner catalog={catalog} error={error} notes={notes} busy={busy} onRefresh={refresh} />

      {loading ? (
        <div className="empty">Looking at what you have installed&hellip;</div>
      ) : tab === 'whatsnew' ? (
        <WhatsNew
          plugins={plugins}
          settings={settings!}
          busy={busy}
          onRun={runOps}
          onSaveSettings={saveSettings}
          onOpen={api.openExternal}
          onDemo={api.openDemo}
        />
      ) : tab === 'plugins' ? (
        <Plugins
          plugins={plugins}
          env={env!}
          settings={settings!}
          busy={busy}
          progress={progress}
          externalQuery={filmQuery}
          onRun={runOps}
          onSaveSettings={saveSettings}
          onDemo={api.openDemo}
          onOpen={api.openExternal}
        />
      ) : (
        <SettingsTab
          env={env!}
          settings={settings!}
          catalog={catalog}
          busy={busy}
          onSave={saveSettings}
          onRefresh={refresh}
          onReveal={api.revealPath}
        />
      )}
    </>
  )
}
