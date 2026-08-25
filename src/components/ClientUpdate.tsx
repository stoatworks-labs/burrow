import type { Settings, UpdateInfo, UpdateProgress } from '../api/types'
import { humanDate, humanSize } from '../api/backend'

/**
 * Burrow's own version, and the one control that replaces it.
 *
 * The distinction this pane has to keep clear is that there are **two**
 * different "check for updates" in this app, and they are not the same
 * question:
 *
 *   the header's *Check for updates*  → the plugin list. What is new in the
 *                                        fleet.
 *   this section's *Check for a new
 *   version*                          → Burrow itself.
 *
 * So this one is labelled by what it replaces rather than by the word
 * "update", and it sits under a heading that names the app.
 *
 * Nothing here is automatic unless the checkbox at the bottom says so, and it
 * is off until somebody turns it on — see `check_updates_on_launch` in
 * settings.rs for why that default is the honest one.
 */
export function ClientUpdate({
  version,
  update,
  checking,
  installing,
  progress,
  error,
  settings,
  onCheck,
  onInstall,
  onSave,
  onOpen,
}: {
  version: string | null
  update: UpdateInfo | null
  checking: boolean
  installing: boolean
  progress: UpdateProgress | null
  error: string | null
  settings: Settings
  onCheck: () => void
  onInstall: () => void
  onSave: (s: Settings) => void
  onOpen: (url: string) => void
}) {
  const available = update?.available ?? null
  // Somewhere to send anyone this copy cannot update itself for — a read-only
  // disk image, or a folder they do not own.
  const releases = 'https://github.com/stoatworks-labs/burrow/releases/latest'

  return (
    <div className="field">
      <span className="lab">Burrow itself</span>

      <div className="opt" style={{ padding: 0 }}>
        <div style={{ flex: 1 }}>
          <div className="t">
            Version {version ?? '—'}
            {available && <span className="d"> · {available} is available</span>}
          </div>
          <div className="stat">
            {checking ? (
              'Asking GitHub what the current release is…'
            ) : installing ? (
              progress?.done ? (
                'Installed. Burrow is restarting…'
              ) : (
                <>
                  Downloading {available}
                  {progress?.bytesTotal
                    ? ` — ${humanSize(progress.bytesDone)} of ${humanSize(progress.bytesTotal)}`
                    : progress
                      ? ` — ${humanSize(progress.bytesDone)}`
                      : ''}
                </>
              )
            ) : available ? (
              <>
                <span className="warn">There is a newer Burrow.</span>
                {update?.date && ` Released ${humanDate(update.date.slice(0, 10))}.`}
              </>
            ) : update ? (
              <span className="ok">Up to date.</span>
            ) : error ? (
              // The error itself is below. This line only has to stop saying
              // "not checked" about a check that plainly happened.
              <span className="warn">That check did not get an answer.</span>
            ) : (
              'Not checked. Burrow does not ask unless you do.'
            )}
          </div>
        </div>

        {!installing && (
          <button className="btn" onClick={onCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Check for a new version'}
          </button>
        )}
      </div>

      {installing && (
        <div className="progress" aria-label="downloading the update">
          <i
            style={{
              width:
                progress?.done
                  ? '100%'
                  : progress?.bytesTotal
                    ? `${Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100)}%`
                    : '35%',
            }}
          />
        </div>
      )}

      {/* The release body, as written. Shown before the install rather than
          after it: "what am I about to be given" is the question, and an app
          that replaces itself and *then* says what changed has the order
          backwards. */}
      {available && update?.notes && !installing && (
        <div className="release-notes">{update.notes}</div>
      )}

      {available && !installing && (
        <div className="actions" style={{ marginTop: 9 }}>
          {update?.blocked ? (
            <button className="btn" onClick={() => onOpen(releases)}>
              Open the download page
            </button>
          ) : (
            <button className="btn primary" onClick={onInstall}>
              Install {available} and restart
            </button>
          )}
        </div>
      )}

      {update?.blocked && (
        <div className="help">
          <strong>This copy cannot replace itself.</strong> {update.blocked}
        </div>
      )}

      {error && <div className="inline-err">{error}</div>}

      <div className="opt" style={{ marginTop: 6 }}>
        <input
          type="checkbox"
          id="upd-launch"
          checked={settings.checkUpdatesOnLaunch}
          onChange={() =>
            onSave({ ...settings, checkUpdatesOnLaunch: !settings.checkUpdatesOnLaunch })
          }
        />
        <label htmlFor="upd-launch">
          <div className="t">Check when Burrow starts</div>
          <div className="d">
            One request to GitHub at launch, asking only what the current version is.
            Nothing is downloaded or installed without you pressing the button.
          </div>
        </label>
      </div>

      <div className="help">
        An update is downloaded from Burrow&rsquo;s own GitHub release and checked
        against a signature made when it was built. One that does not match is
        refused rather than installed — which is the reason this is a button in the
        app rather than a link to a file.
      </div>
    </div>
  )
}
