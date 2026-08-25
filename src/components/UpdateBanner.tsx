import type { UpdateInfo } from '../api/types'

/**
 * "There is a newer Burrow", above the tabs.
 *
 * Only ever appears after a check the user asked for — the button, or the
 * startup check they turned on. Burrow does not announce its own updates
 * uninvited.
 *
 * It can be dismissed, and the dismissal lasts for the session rather than
 * being remembered. A standing "you are out of date" strip that cannot be got
 * rid of is a nag; one that is gone forever after a single stray click is a
 * missed update. Until the next launch is the honest middle.
 */
export function UpdateBanner({
  update,
  installing,
  onInstall,
  onDismiss,
  onSettings,
}: {
  update: UpdateInfo
  installing: boolean
  onInstall: () => void
  onDismiss: () => void
  onSettings: () => void
}) {
  return (
    <div className="banner">
      <div>
        <strong>Burrow {update.available} is available.</strong>{' '}
        {update.blocked ? (
          update.blocked
        ) : (
          <>You are running {update.current}. It takes a restart.</>
        )}
      </div>
      <span className="spacer" />
      {update.blocked ? (
        <button className="btn" onClick={onSettings}>
          Details
        </button>
      ) : (
        <button className="btn primary" onClick={onInstall} disabled={installing}>
          {installing ? 'Installing…' : 'Install and restart'}
        </button>
      )}
      <button className="btn quiet" onClick={onDismiss} disabled={installing}>
        Later
      </button>
    </div>
  )
}
