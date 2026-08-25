import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, isMock, onFinished, onProgress, onUpdateProgress } from './api/backend'
import { mockInitialTab, isShot } from './api/mock'
import type {
  BatchOutcome,
  CatalogInfo,
  CategoryId,
  Environment,
  OpRequest,
  PluginView,
  Progress,
  Settings,
  UpdateInfo,
  UpdateProgress,
} from './api/types'
import { CATEGORY_LABEL } from './api/types'
import { WhatsNew } from './tabs/WhatsNew'
import { Plugins } from './tabs/Plugins'
import { Firmware } from './tabs/Firmware'
import { SettingsTab } from './tabs/Settings'
import { Banner } from './components/Banner'
import { RefreshTools } from './components/RefreshTools'
import { VideoModal } from './components/VideoModal'
import { ComposeModal } from './components/ComposeModal'
import { UpdateBanner } from './components/UpdateBanner'
import { filmDelay, isFilming, runFilm } from './film'

/**
 * A category tab is the category's own id, so `tab === p.category` is the
 * filter and there is no second vocabulary mapping one to the other.
 */
type TabId = 'whatsnew' | CategoryId | 'settings'

/** The category tabs, in order. Firmware is last and empty on purpose. */
const CATEGORY_TABS: CategoryId[] = [
  'video-plugins',
  'video-tools',
  'audio',
  'netinfra',
  'firmware',
]

const TABS: TabId[] = ['whatsnew', ...CATEGORY_TABS, 'settings']

/**
 * The tab a `?tab=` preview URL asks for.
 *
 * `plugins` is what the video tab was called when it was the only one, and it
 * is in the film script and in saved preview URLs — aliased rather than left to
 * fall through, so an old link lands where it meant to.
 */
function initialTab(asked: string): TabId {
  // `plugins` was this tab's name when there was one of them, and `video` was
  // its name before the split. Both are in the film script and in saved preview
  // URLs, so both land where they meant to rather than on the default.
  const alias: Record<string, TabId> = { plugins: 'video-plugins', video: 'video-plugins' }
  const wanted = alias[asked] ?? asked
  return TABS.includes(wanted as TabId) ? (wanted as TabId) : 'video-plugins'
}

export function App() {
  const [tab, setTab] = useState<TabId>(initialTab(mockInitialTab))
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
  const [playing, setPlaying] = useState<PluginView | null>(null)
  const [composing, setComposing] = useState<PluginView | null>(null)

  /*
   * Burrow's own version and update, owned here rather than in the Settings
   * tab: the banner and the Settings pane have to be looking at the same
   * answer, and the startup check happens before that tab has ever been
   * opened.
   */
  const [clientVersion, setClientVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [installingUpdate, setInstallingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

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
      const offU = await onUpdateProgress(setUpdateProgress)
      if (cancelled) {
        offP()
        offF()
        offU()
        return
      }
      offs.push(offP, offF, offU)
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
      // Burrow's own version, which is local and cannot fail in a way worth
      // reporting — the update section shows a dash if it somehow does.
      api.clientVersion().then(setClientVersion).catch(() => {})
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

  /** Ask whether there is a newer Burrow. Never installs anything. */
  const checkUpdate = useCallback(async () => {
    setCheckingUpdate(true)
    setUpdateError(null)
    try {
      setUpdate(await api.checkUpdate())
      setUpdateDismissed(false)
    } catch (err) {
      setUpdateError(String(err))
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  /**
   * Replace this app and restart.
   *
   * On success this never resolves — the process is replaced — so the busy
   * state is deliberately not cleared in a `finally`. Clearing it there would
   * make the button go live again for the instant between the install
   * finishing and the app going away, which is the one moment it must not be
   * pressable.
   */
  const installUpdate = useCallback(async () => {
    setInstallingUpdate(true)
    setUpdateError(null)
    setUpdateProgress(null)
    try {
      await api.installUpdate()
    } catch (err) {
      setUpdateError(String(err))
      setInstallingUpdate(false)
      setUpdateProgress(null)
    }
  }, [])

  /*
   * The startup check, if the user asked for one.
   *
   * Runs off `settings` rather than at mount, because settings arrive from the
   * backend a moment later — and only once per launch, which is what the ref
   * guards. Failure is silent here: an app that greets you with a network
   * error you did not ask for, about itself, is worse than one that quietly
   * has not checked. The Settings pane still reports it if you go and look.
   */
  const askedAtLaunch = useRef(false)
  useEffect(() => {
    if (!settings?.checkUpdatesOnLaunch || askedAtLaunch.current) return
    askedAtLaunch.current = true
    ;(async () => {
      try {
        setUpdate(await api.checkUpdate())
      } catch {
        /* see above */
      }
    })()
  }, [settings])

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
    let timer: number | undefined
    ;(async () => {
      if (!(await isFilming())) return
      // The wait is the capture script's, not the app's — see filmDelay.
      const delay = await filmDelay()
      timer = window.setTimeout(() => {
        stop = runFilm(setTab, q => setFilmQuery(q))
      }, delay)
    })()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      stop?.()
    }
  }, [])

  const updateCount = useMemo(
    () => plugins.filter(p => p.bucket === 'update-available').length,
    [plugins],
  )

  /** How many things in each category need updating. */
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of CATEGORY_TABS) out[c] = 0
    for (const p of plugins) {
      if (p.bucket === 'update-available' && p.tab in out) out[p.tab]++
    }
    return out
  }, [plugins])

  const loading = env === null || settings === null

  return (
    <>
      <header className="head">
        <h1>Stoatworks Burrow</h1>
        <span className="sub">Plugins, tools &amp; modules</span>
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
        {CATEGORY_TABS.map(c => (
          <button
            key={c}
            className="tab"
            role="tab"
            aria-selected={tab === c}
            onClick={() => setTab(c)}
          >
            {CATEGORY_LABEL[c]}
            {/* The count is what each tab is worth glancing at: how much in
                here needs attention. Firmware has nothing in it and says so
                in the panel rather than with a zero. */}
            {counts[c] > 0 && <span className="count">{counts[c]}</span>}
          </button>
        ))}
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

      {update?.available && !updateDismissed && (
        <UpdateBanner
          update={update}
          installing={installingUpdate}
          onInstall={installUpdate}
          onDismiss={() => setUpdateDismissed(true)}
          onSettings={() => setTab('settings')}
        />
      )}

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
          onPlay={setPlaying}
        />
      ) : tab === 'firmware' ? (
        <Firmware />
      ) : tab !== 'settings' ? (
        <Plugins
          category={tab}
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
          onPlay={setPlaying}
          onCompose={setComposing}
        />
      ) : (
        <SettingsTab
          env={env!}
          settings={settings!}
          catalog={catalog}
          busy={busy}
          client={{
            version: clientVersion,
            update,
            checking: checkingUpdate,
            installing: installingUpdate,
            progress: updateProgress,
            error: updateError,
            onCheck: checkUpdate,
            onInstall: installUpdate,
          }}
          onSave={saveSettings}
          onRefresh={refresh}
          onReveal={api.revealPath}
          onOpen={api.openExternal}
        />
      )}

      {composing?.compose && (
        <ComposeModal
          plugin={composing}
          onClose={() => setComposing(null)}
          onReveal={api.revealPath}
        />
      )}

      {playing?.videoUrl && (
        <VideoModal
          plugin={playing}
          onClose={() => setPlaying(null)}
          onOpenExternal={api.openExternal}
        />
      )}
    </>
  )
}
