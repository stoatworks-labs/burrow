import type { CatalogInfo, Environment, FormatId, Settings } from '../api/types'
import { FORMAT_HOSTS, FORMAT_LABEL } from '../api/types'
import { humanDate } from '../api/backend'

const INSTALLABLE: FormatId[] = ['ffgl', 'openfx', 'adobe']

export function SettingsTab({
  env,
  settings,
  catalog,
  busy,
  onSave,
  onRefresh,
  onReveal,
}: {
  env: Environment
  settings: Settings
  catalog: CatalogInfo | null
  busy: boolean
  onSave: (s: Settings) => void
  onRefresh: () => void
  onReveal: (path: string) => void
}) {
  function toggleFormat(f: FormatId) {
    const set = new Set(settings.defaultFormats)
    set.has(f) ? set.delete(f) : set.add(f)
    onSave({ ...settings, defaultFormats: [...set] })
  }

  return (
    <>
      <div className="field">
        <span className="lab">Formats to install by default</span>
        {INSTALLABLE.map(f => (
          <div className="opt" key={f}>
            <input
              type="checkbox"
              id={`fmt-${f}`}
              checked={settings.defaultFormats.includes(f)}
              onChange={() => toggleFormat(f)}
            />
            <label htmlFor={`fmt-${f}`}>
              <div className="t">{FORMAT_LABEL[f]}</div>
              <div className="d">{FORMAT_HOSTS[f]}</div>
            </label>
          </div>
        ))}
        <div className="help">
          You can choose differently for any single plugin from its row in Plugin
          management.
        </div>
      </div>

      <div className="field">
        <span className="lab">Where plugins go</span>
        {env.destinations.map(d => (
          <div key={d.id} style={{ marginBottom: 13 }}>
            <div className="opt" style={{ padding: 0 }}>
              <div style={{ flex: 1 }}>
                <div className="t">
                  {d.label} <span className="d">· {FORMAT_LABEL[d.format]}</span>
                </div>
                <div className="path">{d.path}</div>
                <div className="stat">
                  {d.exists ? (
                    <span className="ok">exists</span>
                  ) : (
                    <span>does not exist yet — Burrow will create it</span>
                  )}
                  {' · '}
                  {d.writable ? (
                    <span className="ok">writable</span>
                  ) : (
                    <span className="warn">needs your password</span>
                  )}
                  {d.custom && ' · custom location'}
                </div>
              </div>
              {d.exists && (
                <button className="btn quiet" onClick={() => onReveal(d.path)}>
                  Show
                </button>
              )}
            </div>
            {d.format === 'openfx' && (
              <div className="help">
                This is the only place an OpenFX host looks, and it belongs to the
                system — which is why installing an OpenFX plugin asks for your
                password. It is normally empty even with DaVinci Resolve installed,
                because Resolve builds its own effects into the application.
              </div>
            )}
          </div>
        ))}
      </div>

      {env.resolume.length > 0 && (
        <div className="field">
          <span className="lab">Resolume</span>
          {env.resolume.map(h => (
            <div className="opt" key={h.name}>
              <div>
                <div className="t">
                  {h.name}
                  {!h.loadsEffects && <span className="d"> — not a plugin destination</span>}
                </div>
                {h.note && <div className="d">{h.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="field">
        <span className="lab">Plugin list</span>
        <div className="path">{settings.catalogUrl}</div>
        <div className="stat">
          {catalog ? (
            <>
              {catalog.entryCount} plugins ·{' '}
              {catalog.source === 'network'
                ? 'downloaded just now'
                : catalog.source === 'cache'
                  ? 'the last copy Burrow downloaded'
                  : 'the copy that came with this app'}
              {catalog.generated && ` · written ${humanDate(catalog.generated.slice(0, 10))}`}
            </>
          ) : (
            'not loaded yet'
          )}
        </div>
        {catalog?.error && <div className="inline-err">{catalog.error}</div>}
        <div className="actions" style={{ marginTop: 9 }}>
          <button className="btn" onClick={onRefresh} disabled={busy}>
            {busy ? 'Checking…' : 'Check for updates now'}
          </button>
        </div>
        <div className="opt" style={{ marginTop: 6 }}>
          <input
            type="checkbox"
            id="gh"
            checked={settings.allowGithubFallback}
            onChange={() =>
              onSave({ ...settings, allowGithubFallback: !settings.allowGithubFallback })
            }
          />
          <label htmlFor="gh">
            <div className="t">Ask GitHub directly if the plugin list is unreachable</div>
            <div className="d">
              Public release information only. Turning this off means Burrow shows the
              last list it has when the site is down, rather than checking each project.
            </div>
          </label>
        </div>
      </div>

      <div className="field">
        <span className="lab">What Burrow sends</span>
        <div className="prose-block">
          <p>
            Burrow fetches the plugin list from{' '}
            <code>stoatworks-labs.com</code> and downloads plugin archives from GitHub.
            That is all it does on the network.
          </p>
          <p>
            There is no account and no sign-in. It sends no identifier, no list of what
            you have installed, and no usage data — those requests carry nothing but the
            address being asked for and a line naming the app and its version, which
            GitHub requires.
          </p>
          <p>
            The demos run entirely inside this app from a local address, and are served
            with no permission to make network requests at all.
          </p>
          <p>
            The <em>Send feedback</em> button at the bottom of this window is the one
            exception, and only when you use it: it sends what you type into it, plus
            the app version.
          </p>
        </div>
      </div>
    </>
  )
}
