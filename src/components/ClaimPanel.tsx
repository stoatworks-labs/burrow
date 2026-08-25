import { useState } from 'react'
import type { Claimable, ClaimedEntry } from '../api/types'
import { FORMAT_LABEL } from '../api/types'

/**
 * Adopting software that is already on the machine.
 *
 * The gap this fills: Burrow can see a hand-installed *video plugin*, because
 * the catalogue declares what its payload is called and the bundle confirms
 * itself. Nothing probes an application, an audio plugin or a Companion
 * module, so for those there are no names to look for — and a copy the user
 * installed themselves shows as *not installed*, next to a download button,
 * while it sits in their Applications folder.
 *
 * Claiming is the user saying "that one is this project". It records the exact
 * names and what the payload hashes to now, and from then on the row reports a
 * version and offers updates.
 *
 * **Everything is shown before anything is recorded** — the project, the file,
 * the folder and the version — because a claim is also what makes Burrow
 * willing to replace and delete those files later. That is the whole reason
 * the list is offered rather than adopted automatically.
 */
export function ClaimPanel({
  claimable,
  claimed,
  scanning,
  busy,
  error,
  errorKey,
  onScan,
  onClaim,
  onRelease,
}: {
  claimable: Claimable[] | null
  claimed: ClaimedEntry[]
  scanning: boolean
  busy: boolean
  error: string | null
  /** Which candidate the error belongs to, so it lands on that row. */
  errorKey: string | null
  onScan: () => void
  onClaim: (c: Claimable) => void
  onRelease: (c: ClaimedEntry) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const key = (c: Claimable) => `${c.slug}:${c.format}:${c.destinationId}:${c.name}`

  return (
    <div className="field">
      <span className="lab">Software already on this machine</span>

      <div className="help" style={{ marginTop: 0, marginBottom: 9 }}>
        If you installed something yourself, Burrow does not know about it — an
        application or an audio plugin carries no name the catalogue declares, so
        it reads as not installed. Claiming one hands it over: Burrow then reports
        its version and offers updates, and can remove it like anything else it
        manages.
      </div>

      <div className="actions">
        <button className="btn" onClick={onScan} disabled={scanning || busy}>
          {scanning ? 'Looking…' : claimable === null ? 'Look for it' : 'Look again'}
        </button>
      </div>

      {error && !errorKey && <div className="inline-err">{error}</div>}

      {claimable !== null && claimable.length === 0 && (
        <div className="stat" style={{ marginTop: 8 }}>
          Nothing found that Burrow could take over. Everything it recognises here
          it already manages.
        </div>
      )}

      {claimable?.map(c => (
        <div className="opt" key={key(c)} style={{ alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div className="t">
              {c.nameOfProject}
              <span className="d">
                {' · '}
                {FORMAT_LABEL[c.format] ?? c.format}
                {c.version ? ` · version ${c.version}` : ' · version unknown'}
              </span>
            </div>
            {/* The file and the folder, both, and the folder abbreviated. This
                is the line that has to be right before somebody presses the
                button — it is the only place the exact thing being adopted is
                named. */}
            <div className="stat">
              <code>{c.name}</code> in {c.destinationDisplayPath}
            </div>
            {c.contested && (
              <div className="stat">
                <span className="warn">More than one of these is here.</span> Burrow
                tracks one {FORMAT_LABEL[c.format] ?? c.format} per project per folder,
                so claiming one means not claiming the other.
              </div>
            )}
            {c.evidence === 'identifier' ? (
              <div className="stat">
                <span className="ok">Identified</span> by its bundle identifier,{' '}
                <code>{c.identifier}</code>.
              </div>
            ) : (
              <div className="stat">
                <span className="warn">Nothing inside it says whose it is.</span> This
                would be your word for it.
              </div>
            )}
          </div>
          {errorKey === key(c) && error && (
            <div className="inline-err" style={{ flexBasis: '100%' }}>
              {error}
            </div>
          )}
          {confirming === key(c) ? (
            <>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setConfirming(null)
                  onClaim(c)
                }}
              >
                Take it over
              </button>
              <button className="btn quiet" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setConfirming(key(c))}>
              Claim
            </button>
          )}
        </div>
      ))}

      {confirming && (
        <div className="help">
          Burrow will record that file as its own. It can then replace it when there
          is an update, and delete it if you uninstall — the same as anything it
          installed itself. <em>Release</em> undoes this without touching the file.
        </div>
      )}

      {claimed.length > 0 && (
        <>
          <div className="lab" style={{ marginTop: 16 }}>
            Claimed
          </div>
          {claimed.map(c => (
            <div
              className="opt"
              key={`${c.slug}:${c.format}:${c.destinationId}`}
              style={{ alignItems: 'center' }}
            >
              <div style={{ flex: 1 }}>
                <div className="t">
                  {c.nameOfProject}
                  <span className="d">
                    {' · '}
                    {FORMAT_LABEL[c.format] ?? c.format}
                    {c.version ? ` · ${c.version}` : ''}
                  </span>
                </div>
                <div className="stat">{c.names.join(', ')}</div>
              </div>
              <button className="btn quiet" disabled={busy} onClick={() => onRelease(c)}>
                Release
              </button>
            </div>
          ))}
          <div className="help">
            Releasing only makes Burrow forget it. The files stay exactly where they
            are.
          </div>
        </>
      )}
    </div>
  )
}
