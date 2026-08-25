import type {
  Claimable,
  ClaimedEntry,
  CatalogInfo,
  Environment,
  FormatId,
  Settings,
  UpdateInfo,
  UpdateProgress,
} from '../api/types'
import { FORMAT_HOSTS, FORMAT_LABEL } from '../api/types'
import { humanDate } from '../api/backend'
import { ClientUpdate } from '../components/ClientUpdate'
import { ClaimPanel } from '../components/ClaimPanel'

/**
 * Every format Burrow installs, in the order they are offered.
 *
 * Two of them ask for a password and the rest never do, which is the only
 * distinction worth making here — see the note under the list.
 */
const INSTALLABLE: FormatId[] = ['ffgl', 'openfx', 'adobe', 'vst3', 'au', 'app', 'companion']

export function SettingsTab({
  env,
  settings,
  catalog,
  busy,
  client,
  claims,
  onSave,
  onRefresh,
  onReveal,
  onOpen,
}: {
  env: Environment
  settings: Settings
  catalog: CatalogInfo | null
  busy: boolean
  /** Burrow's own version and update state, owned by App. */
  client: {
    version: string | null
    update: UpdateInfo | null
    checking: boolean
    installing: boolean
    progress: UpdateProgress | null
    error: string | null
    onCheck: () => void
    onInstall: () => void
  }
  /** Adopting software already on the machine, owned by App. */
  claims: {
    claimable: Claimable[] | null
    claimed: ClaimedEntry[]
    scanning: boolean
    error: string | null
    errorKey: string | null
    onScan: () => void
    onClaim: (c: Claimable) => void
    onRelease: (c: ClaimedEntry) => void
  }
  onSave: (s: Settings) => void
  onRefresh: () => void
  onReveal: (path: string) => void
  onOpen: (url: string) => void
}) {
  function toggleFormat(f: FormatId) {
    const set = new Set(settings.defaultFormats)
    set.has(f) ? set.delete(f) : set.add(f)
    onSave({ ...settings, defaultFormats: [...set] })
  }

  return (
    <>
      <div className="field">
        <span className="lab">What to install by default</span>
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
          Applies to whatever a given thing actually has — a video plugin has no
          VST3 build, and an audio plugin has no FFGL one. You can choose
          differently for any single one of them from its row, under
          <em> Formats&hellip;</em>.
        </div>
      </div>

      <div className="field">
        <span className="lab">Where things go</span>
        {env.destinations.map(d => (
          <div key={d.id} style={{ marginBottom: 13 }}>
            <div className="opt" style={{ padding: 0 }}>
              <div style={{ flex: 1 }}>
                <div className="t">
                  {d.label} <span className="d">· {FORMAT_LABEL[d.format]}</span>
                </div>
                {/* The abbreviated one: a real path carries the account
                    name, and this pane ends up in screenshots. `d.path` is
                    still what Show reveals. */}
                <div className="path">{d.displayPath}</div>
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
            {d.format === 'companion' && (
              <div className="help">
                Companion has no fixed modules folder — it reads the one you name in
                its own <em>Settings &rarr; Developer modules path</em>. Point that at
                this folder, and restart Companion after installing a module: it reads
                the folder once, at startup. Already have a modules folder? Change this
                path to it.
              </div>
            )}
            {d.format === 'app' && (
              <div className="help">
                Applications are placed here directly, and never with a password: if
                this machine&rsquo;s {d.path.startsWith('/Applications')
                  ? 'Applications folder were not writable by you, Burrow would use your own ~/Applications instead'
                  : 'shared folder is not writable by you, this is your own per-user one'}
                .
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

      {env.otherHosts.length > 0 && (
        <div className="field">
          <span className="lab">Other hosts</span>
          {env.otherHosts.map(h => (
            <div className="opt" key={h.name}>
              <div>
                <div className="t">
                  {h.name}
                  {!h.loadsEffects && <span className="d"> — not found here</span>}
                </div>
                {h.note && <div className="d">{h.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="field">
        <span className="lab">The list Burrow reads</span>
        <div className="path">{settings.catalogUrl}</div>
        <div className="stat">
          {catalog ? (
            <>
              {catalog.entryCount} plugins, tools and modules ·{' '}
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
            {busy ? 'Checking…' : 'Fetch the list now'}
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
            <div className="t">Ask GitHub directly if that list is unreachable</div>
            <div className="d">
              Public release information only. Turning this off means Burrow shows the
              last list it has when the site is down, rather than checking each project.
            </div>
          </label>
        </div>
      </div>

      <ClaimPanel
        claimable={claims.claimable}
        claimed={claims.claimed}
        scanning={claims.scanning}
        busy={busy}
        error={claims.error}
        errorKey={claims.errorKey}
        onScan={claims.onScan}
        onClaim={claims.onClaim}
        onRelease={claims.onRelease}
      />

      <ClientUpdate
        version={client.version}
        update={client.update}
        checking={client.checking}
        installing={client.installing}
        progress={client.progress}
        error={client.error}
        settings={settings}
        onCheck={client.onCheck}
        onInstall={client.onInstall}
        onSave={onSave}
        onOpen={onOpen}
      />

      <div className="field">
        <span className="lab">What Burrow sends</span>
        <div className="prose-block">
          <p>
            Burrow fetches one list from <code>stoatworks-labs.com</code> and
            downloads the archives, disk images and project videos from GitHub. That
            is everything it does on the network, and there is no third party in it
            anywhere.
          </p>
          <p>
            Checking for a new Burrow adds one more request, to Burrow&rsquo;s own
            GitHub release, asking what the current version is. It happens when you
            press the button above &mdash; and at startup too, if you asked it to.
            Nothing about this machine goes with the question.
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
            Plugin videos play from each project&rsquo;s own GitHub release — the
            same place its plugins come from. Not a YouTube embed, so there are no
            cookies, no ads, no suggested videos and nobody else watching. The
            still images are part of the app, so nothing is fetched at all until
            you press play.
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
