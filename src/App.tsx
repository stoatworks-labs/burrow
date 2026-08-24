import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, isMock, onFinished, onProgress } from './api/backend'
import { mockInitialTab } from './api/mock'
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

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setCatalog(await api.refreshCatalog(true))
      await reload()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }, [reload])

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
        {isMock && <span className="sub">preview — no backend</span>}
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
