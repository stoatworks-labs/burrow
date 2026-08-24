import type { CatalogInfo } from '../api/types'
import { humanDate } from '../api/backend'

/**
 * The strip above the tabs: where the plugin list came from, and anything that
 * went wrong.
 *
 * It is a persistent strip rather than a toast on purpose. "These version
 * numbers are from the copy that shipped inside the app" is a standing caveat
 * on everything below it, not a momentary notification — and a toast about it
 * is gone before the user looks at the list it applies to.
 */
export function Banner({
  catalog,
  error,
  notes,
  busy,
  onRefresh,
}: {
  catalog: CatalogInfo | null
  error: string | null
  notes: string[]
  busy: boolean
  onRefresh: () => void
}) {
  const stale = catalog && catalog.source !== 'network'

  return (
    <>
      {error && (
        <div className="banner bad">
          <div>
            <strong>That didn&rsquo;t work.</strong>
            <div style={{ whiteSpace: 'pre-wrap' }}>{error}</div>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="banner">
          <div>
            {notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        </div>
      )}

      {stale && (
        <div className="banner">
          <div>
            <strong>
              {catalog!.source === 'baked'
                ? 'Showing the plugin list that came with this app.'
                : 'Showing the last plugin list Burrow downloaded.'}
            </strong>{' '}
            {catalog!.error ? (
              <>Couldn&rsquo;t check for a newer one — {catalog!.error}.</>
            ) : (
              <>Burrow hasn&rsquo;t been able to check for a newer one.</>
            )}{' '}
            {catalog!.generated && (
              <>It was written on {humanDate(catalog!.generated.slice(0, 10))}. </>
            )}
            Versions below may be out of date.
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onRefresh} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      {catalog?.newerSchema && (
        <div className="banner">
          <div>
            <strong>This plugin list was written for a newer version of Burrow.</strong>{' '}
            Everything Burrow understands is shown, but there may be more to see after
            an update.
          </div>
        </div>
      )}
    </>
  )
}
