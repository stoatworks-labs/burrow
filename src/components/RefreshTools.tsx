import type { CatalogInfo } from '../api/types'

/**
 * The two refresh actions, side by side in the header.
 *
 * They are separate controls rather than one "Refresh" because they do
 * genuinely different things, and which one you want depends on what you just
 * did:
 *
 * **Rescan installed** reads your plugin folders. No network. Use it after
 * installing or deleting something by hand, or after a host has written to the
 * folder — Burrow will pick the change up without being told twice.
 *
 * **Check for updates** fetches the plugin list. This is the one that finds new
 * versions and new release notes, and the only one that touches the network.
 *
 * One button doing both would make the fast, offline, private operation
 * unavailable to anyone who is not online — and would make it impossible to say
 * which half failed when something goes wrong.
 *
 * Both report what they actually did. A refresh button that gives no feedback
 * leaves you unsure whether it ran, so you press it again.
 */
export function RefreshTools({
  catalog,
  busy,
  scanning,
  lastScanEpoch,
  result,
  onRescan,
  onCheck,
}: {
  catalog: CatalogInfo | null
  busy: boolean
  scanning: boolean
  lastScanEpoch: number | null
  /** What the last refresh of either kind actually changed. */
  result: string | null
  onRescan: () => void
  onCheck: () => void
}) {
  const checked = catalog?.fetchedAtEpoch ?? null
  const offline = catalog !== null && catalog.source !== 'network'

  return (
    <div className="tools">
      {result && <span className="tools-result">{result}</span>}

      <button
        className="btn quiet"
        onClick={onRescan}
        disabled={busy || scanning}
        title="Re-read your plugin folders. Does not use the network."
      >
        {scanning ? 'Scanning…' : 'Rescan installed'}
        <span className="tools-when">{ago(lastScanEpoch)}</span>
      </button>

      <button
        className="btn quiet"
        onClick={onCheck}
        disabled={busy}
        title="Fetch the plugin list — new versions and release notes."
      >
        {busy ? 'Checking…' : 'Check for updates'}
        <span className={`tools-when${offline ? ' stale' : ''}`}>
          {offline ? 'not checked' : ago(checked)}
        </span>
      </button>
    </div>
  )
}

/**
 * "just now" / "4 min ago" / "yesterday".
 *
 * Deliberately coarse. The exact second is never the question — the question is
 * whether what you are looking at is minutes old or days old, and a precise
 * timestamp reads as more authority than it has.
 */
function ago(epochSeconds: number | null): string {
  if (!epochSeconds) return ''
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (secs < 45) return 'just now'
  if (secs < 90) return 'a minute ago'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return 'a while ago'
}
