import { useEffect, useMemo, useState } from 'react'
import type {
  Environment,
  OpRequest,
  PluginView,
  Progress,
  Settings,
  Slot,
} from '../api/types'
import { FORMAT_LABEL } from '../api/types'
import { FormatChips } from '../components/FormatChips'
import { PluginArt } from '../components/PluginArt'
import { humanSize } from '../api/backend'

/**
 * The flat list, with a search bar, under three headings.
 *
 * The heading a plugin sits under is computed in Rust (`bucket_for`), so the
 * ordering rule lives with the reconciliation that decides it rather than
 * being reimplemented here. The short version: a plugin installed in some
 * formats and not others is **up to date** so long as what is installed is
 * current — the heading answers "does this need my attention for what I
 * actually have", and a format the user never chose is not a pending update.
 */
export function Plugins({
  plugins,
  env,
  settings,
  busy,
  progress,
  externalQuery,
  onRun,
  onSaveSettings,
  onDemo,
  onOpen,
}: {
  plugins: PluginView[]
  env: Environment
  settings: Settings
  busy: boolean
  progress: Record<string, Progress>
  /** Set by filming mode, which types into the search box for the camera. */
  externalQuery?: string | null
  onRun: (r: OpRequest[]) => void
  onSaveSettings: (s: Settings) => void
  onDemo: (slug: string) => void
  onOpen: (url: string) => void
}) {
  const [query, setQuery] = useState('')

  // Filming mode types into the search box. A plain controlled value would
  // fight the user's own typing, so this only follows it when it changes.
  useEffect(() => {
    if (externalQuery !== null && externalQuery !== undefined) setQuery(externalQuery)
  }, [externalQuery])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(p =>
      [p.name, p.slug, p.hook, p.summary, ...p.tags]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [plugins, query])

  const groups: Array<[string, PluginView['bucket'], string]> = [
    ['Up to date', 'up-to-date', 'Nothing installed yet.'],
    ['Update available', 'update-available', 'Everything you have is current.'],
    [
      'Not installed',
      'not-installed',
      'You have every plugin that has a build for this machine.',
    ],
  ]

  const updates = plugins.filter(p => p.bucket === 'update-available')

  function updateAll() {
    const reqs: OpRequest[] = []
    for (const p of updates) {
      for (const s of p.slots) {
        if (s.state.state === 'update-available') {
          reqs.push({
            slug: p.slug,
            format: s.format,
            destinationId: s.destinationId,
            action: 'update',
          })
        }
      }
    }
    onRun(reqs)
  }

  return (
    <>
      <div className="search">
        <input
          type="search"
          placeholder="Search plugins"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search plugins"
        />
        <span className="n">
          {filtered.length} of {plugins.length}
          {updates.length > 0 && ` · ${updates.length} with updates`}
        </span>
        {updates.length > 1 && (
          <button className="btn primary" disabled={busy} onClick={updateAll}>
            Update all
          </button>
        )}
      </div>

      {plugins.length === 0 && (
        <div className="empty">
          <strong>No plugins to show</strong>
          The plugin list hasn&rsquo;t loaded yet.
        </div>
      )}

      {query && filtered.length === 0 && (
        <div className="empty">
          <strong>Nothing matches &ldquo;{query}&rdquo;</strong>
          <button className="btn quiet" onClick={() => setQuery('')}>
            Clear the search
          </button>
        </div>
      )}

      {groups.map(([label, bucket, emptyText]) => {
        const rows = filtered.filter(p => p.bucket === bucket)
        if (query && rows.length === 0) return null
        return (
          <section key={bucket}>
            <div className="section-head">
              <h2>{label}</h2>
              <span className="n">{rows.length}</span>
            </div>
            {rows.length === 0 ? (
              <div className="section-empty">{emptyText}</div>
            ) : (
              rows.map(p => (
                <Row
                  key={p.slug}
                  plugin={p}
                  settings={settings}
                  busy={busy}
                  progress={progress}
                  onRun={onRun}
                  onSaveSettings={onSaveSettings}
                  onDemo={onDemo}
                  onOpen={onOpen}
                />
              ))
            )}
          </section>
        )
      })}

      <EmptyFolderNote env={env} plugins={plugins} />
    </>
  )
}

function Row({
  plugin,
  settings,
  busy,
  progress,
  onRun,
  onSaveSettings,
  onDemo,
  onOpen,
}: {
  plugin: PluginView
  settings: Settings
  busy: boolean
  progress: Record<string, Progress>
  onRun: (r: OpRequest[]) => void
  onSaveSettings: (s: Settings) => void
  onDemo: (slug: string) => void
  onOpen: (url: string) => void
}) {
  const [showFormats, setShowFormats] = useState(false)

  const behind = plugin.slots.filter(s => s.state.state === 'update-available')
  const installed = plugin.slots.filter(
    s => s.state.state === 'up-to-date' || s.state.state === 'version-unknown',
  )
  const offered = plugin.slots.filter(s => s.state.state === 'not-installed' && !s.foreign)
  const wanted = offered.filter(s => plugin.wantedFormats.includes(s.format))

  const live = plugin.slots
    .map(s => progress[`${plugin.slug}:${s.format}`])
    .find(Boolean)

  function req(slots: Slot[], action: OpRequest['action']): OpRequest[] {
    return slots.map(s => ({
      slug: plugin.slug,
      format: s.format,
      destinationId: s.destinationId,
      action,
    }))
  }

  const installLabel =
    wanted.length > 0
      ? `Install ${wanted.map(s => FORMAT_LABEL[s.format]).join(' + ')}`
      : 'Install'

  return (
    <div className="row">
      <PluginArt plugin={plugin} onOpen={onOpen} />
      <div className="body">
        <div className="title">
          <h3>{plugin.name}</h3>
          {plugin.version && <span className="ver">{plugin.version}</span>}
          {plugin.hasOverride && (
            <span className="chip" title="This plugin has its own format choice">
              custom formats
            </span>
          )}
        </div>
        <div className="hook">{plugin.hook || plugin.summary}</div>

        <FormatChips
          slots={plugin.slots}
          disabled={busy}
          onInstallOne={s => onRun(req([s], 'install'))}
        />

        {plugin.slots.some(s => s.missing.length > 0) && (
          <div className="inline-err">
            Part of this plugin is missing —{' '}
            {plugin.slots.flatMap(s => s.missing).join(', ')}. An uninstall may not have
            finished.
          </div>
        )}

        {live && (
          <div className="progress" aria-label={live.phase}>
            <i
              style={{
                width:
                  live.bytesTotal && live.bytesTotal > 0
                    ? `${Math.min(100, (live.bytesDone / live.bytesTotal) * 100)}%`
                    : '35%',
              }}
            />
          </div>
        )}

        <div className="actions">
          {behind.length > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => onRun(req(behind, 'update'))}>
              Update {behind.length > 1 ? `${behind.length} formats` : FORMAT_LABEL[behind[0].format]}
            </button>
          )}
          {installed.length === 0 && wanted.length > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => onRun(req(wanted, 'install'))}>
              {installLabel}
            </button>
          )}
          {installed.length > 0 && (
            <button className="btn" disabled={busy} onClick={() => onRun(req(installed, 'uninstall'))}>
              Uninstall
            </button>
          )}

          {/* A plugin with no demo gets no button at all, rather than a
              disabled one — a disabled control is a promise the app cannot
              keep, and invites a click that does nothing. */}
          {plugin.demo && (
            <button className="btn quiet" onClick={() => onDemo(plugin.slug)}>
              Try demo
            </button>
          )}
          {plugin.guide && (
            <button className="btn quiet" onClick={() => onOpen(plugin.guide!)}>
              Guide
            </button>
          )}
          <button className="btn quiet" onClick={() => setShowFormats(v => !v)}>
            Formats&hellip;
          </button>
        </div>

        {plugin.extras.length > 0 && (
          <div className="stat">
            Also in the download: {plugin.extras.join(', ')} — not plugins, so Burrow
            leaves them out of your plugin folder.
          </div>
        )}

        {showFormats && (
          <FormatOverride
            plugin={plugin}
            settings={settings}
            onSave={onSaveSettings}
            onClose={() => setShowFormats(false)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Per-plugin format choice.
 *
 * Choosing "use my defaults" **deletes** the key rather than writing today's
 * defaults into it. Writing them looks identical now and silently stops
 * following a later change — the failure only shows up weeks later when the
 * user adds a format to their defaults and one plugin mysteriously does not
 * get it.
 */
function FormatOverride({
  plugin,
  settings,
  onSave,
  onClose,
}: {
  plugin: PluginView
  settings: Settings
  onSave: (s: Settings) => void
  onClose: () => void
}) {
  const custom = plugin.hasOverride
  const current = plugin.wantedFormats
  const available = plugin.slots.filter(s => s.state.state !== 'no-build')

  function setInherit() {
    const next = { ...settings, pluginFormats: { ...settings.pluginFormats } }
    delete next.pluginFormats[plugin.slug]
    onSave(next)
  }

  function toggle(format: string) {
    const set = new Set(current)
    set.has(format as any) ? set.delete(format as any) : set.add(format as any)
    onSave({
      ...settings,
      pluginFormats: { ...settings.pluginFormats, [plugin.slug]: [...set] as any },
    })
  }

  return (
    <div className="field" style={{ marginTop: 12, marginBottom: 4 }}>
      <div className="opt">
        <input type="radio" checked={!custom} onChange={setInherit} id={`inh-${plugin.slug}`} />
        <label htmlFor={`inh-${plugin.slug}`}>
          <div className="t">Use my defaults</div>
          <div className="d">
            {settings.defaultFormats.map(f => FORMAT_LABEL[f] ?? f).join(', ') || 'none'}
          </div>
        </label>
      </div>
      <div className="opt">
        <input
          type="radio"
          checked={custom}
          onChange={() =>
            onSave({
              ...settings,
              pluginFormats: { ...settings.pluginFormats, [plugin.slug]: current as any },
            })
          }
          id={`cus-${plugin.slug}`}
        />
        <label htmlFor={`cus-${plugin.slug}`}>
          <div className="t">Choose for {plugin.name}</div>
        </label>
      </div>
      {custom && (
        <div style={{ paddingLeft: 26 }}>
          {plugin.slots.map(s => {
            const has = available.includes(s)
            return (
              <div className="opt" key={s.destinationId}>
                <input
                  type="checkbox"
                  disabled={!has}
                  checked={current.includes(s.format)}
                  onChange={() => toggle(s.format)}
                  id={`f-${plugin.slug}-${s.format}`}
                />
                <label htmlFor={`f-${plugin.slug}-${s.format}`}>
                  <span className="t">{FORMAT_LABEL[s.format] ?? s.format}</span>
                  {!has && <span className="d"> — no build for this platform</span>}
                </label>
              </div>
            )
          })}
        </div>
      )}
      <button className="btn quiet" onClick={onClose}>
        Done
      </button>
    </div>
  )
}

/**
 * The "0 installed is normal" explanation.
 *
 * A clean machine has no OpenFX plugins at all, even with DaVinci Resolve
 * installed, because Resolve compiles its own effects in rather than shipping
 * loadable bundles. Without this sentence an empty folder reads as Burrow
 * being broken.
 */
function EmptyFolderNote({ env, plugins }: { env: Environment; plugins: PluginView[] }) {
  const ofx = env.destinations.find(d => d.format === 'openfx')
  if (!ofx) return null
  const anyOfxInstalled = plugins.some(p =>
    p.slots.some(
      s =>
        s.format === 'openfx' &&
        (s.state.state === 'up-to-date' ||
          s.state.state === 'update-available' ||
          s.state.state === 'version-unknown'),
    ),
  )
  if (anyOfxInstalled) return null

  return (
    <div className="banner" style={{ marginTop: 20 }}>
      <div>
        <strong>No OpenFX plugins found, which is normal.</strong> DaVinci Resolve
        compiles its own effects into the application rather than installing loadable
        plugins, so <code>{ofx.path}</code>{' '}
        {ofx.exists ? 'is usually empty' : 'usually does not exist yet'} even on a machine
        with Resolve on it. Burrow will {ofx.exists ? 'use it' : 'create it'} the first
        time you install an OpenFX plugin.
        {ofx.needsElevation && ' That needs your password, once.'}
      </div>
    </div>
  )
}

export { humanSize }
