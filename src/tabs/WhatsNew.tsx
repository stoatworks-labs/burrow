import { useMemo } from 'react'
import type { Note, OpRequest, PluginView, Settings } from '../api/types'
import { FORMAT_LABEL } from '../api/types'
import { humanDate } from '../api/backend'
import { PluginArt } from '../components/PluginArt'

/**
 * What has changed since the user last looked.
 *
 * Two kinds of card: an update to something installed, and a plugin released
 * recently that is not. They are genuinely different — a plugin you have never
 * had has no "what's new", so it gets the pitch rather than a changelog.
 *
 * The baseline is `settings.seen`, seeded on first run from the catalogue that
 * shipped inside the app. That is what stops a first launch announcing all
 * twenty-four plugins as new: "new" honestly means "newer than this build of
 * Burrow", until a real refresh gives it something better.
 */
export function WhatsNew({
  plugins,
  settings,
  busy,
  onRun,
  onSaveSettings,
  onOpen,
  onDemo,
  onPlay,
}: {
  plugins: PluginView[]
  settings: Settings
  busy: boolean
  onRun: (r: OpRequest[]) => void
  onSaveSettings: (s: Settings) => void
  onOpen: (url: string) => void
  onDemo: (slug: string) => void
  onPlay: (plugin: PluginView) => void
}) {
  const updates = useMemo(
    () => plugins.filter(p => p.bucket === 'update-available'),
    [plugins],
  )

  const fresh = useMemo(() => {
    return plugins
      .filter(p => p.bucket === 'not-installed' && p.version)
      .filter(p => settings.seen[p.slug] !== p.version)
      .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
      .slice(0, 8)
  }, [plugins, settings.seen])

  function dismiss(p: PluginView) {
    onSaveSettings({
      ...settings,
      seen: { ...settings.seen, [p.slug]: p.version ?? '' },
    })
  }

  if (updates.length === 0 && fresh.length === 0) {
    return (
      <div className="empty">
        <strong>Nothing new</strong>
        Everything you have installed is current, and there are no releases you
        haven&rsquo;t seen.
      </div>
    )
  }

  return (
    <>
      {updates.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Updates</h2>
            <span className="n">{updates.length}</span>
          </div>
          {updates.map(p => (
            <UpdateCard key={p.slug} plugin={p} busy={busy} onRun={onRun} onOpen={onOpen} onPlay={onPlay} />
          ))}
        </section>
      )}

      {fresh.length > 0 && (
        <section>
          <div className="section-head">
            <h2>New to you</h2>
            <span className="n">{fresh.length}</span>
          </div>
          {fresh.map(p => (
            <NewCard
              key={p.slug}
              plugin={p}
              busy={busy}
              onRun={onRun}
              onDemo={onDemo}
              onPlay={onPlay}
              onOpen={onOpen}
              onDismiss={() => dismiss(p)}
            />
          ))}
        </section>
      )}
    </>
  )
}

function UpdateCard({
  plugin,
  busy,
  onRun,
  onOpen,
  onPlay,
}: {
  plugin: PluginView
  busy: boolean
  onRun: (r: OpRequest[]) => void
  onOpen: (url: string) => void
  onPlay: (plugin: PluginView) => void
}) {
  const behind = plugin.slots.filter(s => s.state.state === 'update-available')
  const installedVersion =
    behind[0]?.state.state === 'update-available' ? behind[0].state.installed : null

  // Every note strictly between what is installed and what is current, newest
  // first — someone two releases behind should see both, which is the whole
  // reason the catalogue carries history rather than just the latest note.
  const relevant = plugin.notes.filter(n => {
    if (!installedVersion) return true
    return cmp(n.tag, installedVersion) > 0
  })
  const shown = relevant.slice(0, 3)
  const older = relevant.length - shown.length

  return (
    <div className="card">
      <div className="card-head">
        <PluginArt plugin={plugin} onPlay={onPlay} onOpen={onOpen} />
        <div style={{ flex: 1 }}>
          <h3>{plugin.name}</h3>
          <div className="when">
            {installedVersion && `${installedVersion.replace(/^v/, '')} → `}
            {plugin.version?.replace(/^v/, '')}
            {plugin.published && ` · ${humanDate(plugin.published)}`}
            {plugin.statusLabel && (
              <span
                className={`chip status status-${plugin.status ?? 'unknown'}`}
                style={{ marginLeft: 8 }}
                title={plugin.statusBlurb ?? undefined}
              >
                {plugin.statusLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {shown.map(n => (
        <NoteBody key={n.tag} note={n} onOpen={onOpen} />
      ))}
      {older > 0 && (
        <div className="note">
          <button className="btn quiet" onClick={() => plugin.releasesUrl && onOpen(plugin.releasesUrl)}>
            &hellip;and {older} earlier release{older === 1 ? '' : 's'}
          </button>
        </div>
      )}

      <div className="actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            onRun(
              behind.map(s => ({
                slug: plugin.slug,
                format: s.format,
                destinationId: s.destinationId,
                action: 'update' as const,
              })),
            )
          }
        >
          Update {behind.map(s => FORMAT_LABEL[s.format]).join(' + ')}
        </button>
        {plugin.releaseUrl && (
          <button className="btn quiet" onClick={() => onOpen(plugin.releaseUrl!)}>
            View on GitHub
          </button>
        )}
      </div>
    </div>
  )
}

function NewCard({
  plugin,
  busy,
  onRun,
  onDemo,
  onPlay,
  onOpen,
  onDismiss,
}: {
  plugin: PluginView
  busy: boolean
  onRun: (r: OpRequest[]) => void
  onDemo: (slug: string) => void
  onPlay: (plugin: PluginView) => void
  onOpen: (url: string) => void
  onDismiss: () => void
}) {
  const wanted = plugin.slots.filter(
    s => s.state.state === 'not-installed' && plugin.wantedFormats.includes(s.format),
  )
  return (
    <div className="card">
      <div className="card-head">
        <PluginArt plugin={plugin} onPlay={onPlay} onOpen={onOpen} />
        <div style={{ flex: 1 }}>
          <h3>{plugin.name}</h3>
          <div className="when">
            {plugin.version} {plugin.published && `· ${humanDate(plugin.published)}`}
            {plugin.statusLabel && (
              <span
                className={`chip status status-${plugin.status ?? 'unknown'}`}
                style={{ marginLeft: 8 }}
                title={plugin.statusBlurb ?? undefined}
              >
                {plugin.statusLabel}
              </span>
            )}
          </div>
          <div className="hook" style={{ marginTop: 6 }}>
            {plugin.blurb ?? plugin.summary ?? plugin.hook}
          </div>
        </div>
      </div>
      <div className="actions">
        {wanted.length > 0 && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              onRun(
                wanted.map(s => ({
                  slug: plugin.slug,
                  format: s.format,
                  destinationId: s.destinationId,
                  action: 'install' as const,
                })),
              )
            }
          >
            Install {wanted.map(s => FORMAT_LABEL[s.format]).join(' + ')}
          </button>
        )}
        {plugin.demo && (
          <button className="btn" onClick={() => onDemo(plugin.slug)}>
            Try demo
          </button>
        )}
        <button className="btn quiet" onClick={onDismiss}>
          Not for me
        </button>
      </div>
    </div>
  )
}

/**
 * One release note, rendered by kind.
 *
 * The `commits` label is the honest part. Most releases in this fleet have no
 * hand-written notes, and showing a bare commit subject as though it were a
 * changelog entry misrepresents it — saying where the text came from lets the
 * reader weigh it correctly. `maintenance` is the same instinct taken further:
 * a release that only re-vendored shared scripts genuinely changed nothing in
 * the plugin, and saying so plainly is more useful than an empty card.
 */
function NoteBody({ note, onOpen }: { note: Note; onOpen: (url: string) => void }) {
  return (
    <div className={`note ${note.kind}`}>
      <div className="note-ver">
        {note.tag}
        {note.published && ` · ${humanDate(note.published)}`}
        {note.prerelease && ' · pre-release'}
      </div>

      {note.kind === 'notes' && <div className="prose">{trim(note.lines[0] ?? '')}</div>}

      {note.kind === 'commits' && (
        <>
          <div className="label">No written notes for this release — from the commit log:</div>
          <ul>
            {note.lines.slice(0, 6).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      )}

      {note.kind === 'maintenance' && (
        <div className="prose">
          Rebuilt and re-signed against the current shared release tooling. Nothing in the
          plugin itself changed
          {note.filtered > 0 && ` (${note.filtered} housekeeping commits)`}.
        </div>
      )}

      {note.kind === 'initial' && <div className="prose">First public release.</div>}

      {note.url && (
        <button className="btn quiet" onClick={() => onOpen(note.url)}>
          Read the full notes
        </button>
      )}
    </div>
  )
}

/** Release bodies are markdown; show the opening rather than render it all. */
function trim(body: string, max = 420): string {
  const plain = body
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'))
  return `${cut.slice(0, stop > 120 ? stop + 1 : max)}…`
}

/** Compare two version tags, tolerating a `v` prefix and unparseable text. */
function cmp(a: string, b: string): number {
  const norm = (s: string) => s.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const [x, y] = [norm(a), norm(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
