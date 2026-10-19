import type { BatchPlan, Phase, Progress } from '../api/types'
import { FORMAT_LABEL } from '../api/types'
import { fraction, progressText } from '../api/progress'

/**
 * The phases a batch can still be stopped in.
 *
 * Every unit downloads before any unit is committed, so the first event from
 * the second half means the whole batch is past cancelling: a copy into a
 * plugin folder is not interrupted, and a password prompt has a Cancel of its
 * own. Offering the button then would be offering something that does nothing.
 */
const CANCELLABLE: Phase[] = ['downloading', 'extracting', 'clearing-quarantine', 'staged']

/**
 * What a batch is doing right now, from the moment a button is pressed to the
 * moment the list is current again.
 *
 * Three stages, because the batch itself is only the middle one:
 *
 * - `planning` — the backend is resolving what to fetch and where it goes.
 * - `running` — downloads, unpacking, installs, and perhaps a password.
 * - `finishing` — the batch is done and the list is being re-read, which for
 *   an installed application means hashing it. This used to be the part with
 *   no bar at all, and the part that most looked like a hang.
 *
 * `stopping` is set the moment Cancel is pressed. The backend honours it
 * between units and between download chunks, so there is a gap between the
 * press and the stop, and the strip has to say so or the button reads as
 * broken.
 */
export interface JobState {
  stage: 'planning' | 'running' | 'finishing'
  plan: BatchPlan | null
  stopping: boolean
}

/**
 * The strip above the list while a batch runs.
 *
 * It sits at the top rather than in the row because the row can be on another
 * tab, or scrolled off, or filtered out by the search — and a batch started
 * from the "Update all" button belongs to no one row anyway. The row keeps its
 * own bar; this is the one that is always in view.
 */
export function JobStrip({
  job,
  latest,
  nameOf,
  onCancel,
}: {
  job: JobState | null
  /** The most recent progress event, whichever unit it was for. */
  latest: Progress | null
  nameOf: (slug: string) => string
  onCancel: () => void
}) {
  if (!job) return null

  const verb = verbFor(job.plan)
  const count = job.plan?.units.length ?? 0

  let text: string
  let frac: number | null = null
  if (job.stage === 'planning') {
    text = 'Working out what to do…'
  } else if (job.stage === 'finishing') {
    text = 'Checking what is installed…'
  } else if (latest) {
    const who = `${nameOf(latest.slug)} (${FORMAT_LABEL[latest.format] ?? latest.format})`
    const where = count > 1 ? `${latest.index + 1} of ${count} · ` : ''
    text = `${verb} ${where}${who} · ${progressText(latest)}`
    frac = fraction(latest)
  } else {
    text = `${verb}…`
  }

  const canCancel =
    job.stage === 'running' &&
    job.plan !== null &&
    (latest === null || CANCELLABLE.includes(latest.phase))

  return (
    <div className="job" role="status" aria-live="polite">
      <div className="job-line">
        <span className="job-text">
          {job.stopping ? (
            <>
              <strong>Stopping.</strong> Anything already downloaded will still be installed,
              and nothing will ask for a password.
            </>
          ) : (
            text
          )}
        </span>
        {canCancel && (
          <button className="btn quiet" onClick={onCancel} disabled={job.stopping}>
            {job.stopping ? 'Stopping…' : 'Cancel'}
          </button>
        )}
      </div>
      <div
        className={`progress job-bar${frac === null ? ' indeterminate' : ''}`}
        aria-label={text}
      >
        <i style={frac === null ? undefined : { width: `${frac * 100}%` }} />
      </div>
    </div>
  )
}

/** "Installing", "Updating" or "Removing" — whichever the whole batch is. */
function verbFor(plan: BatchPlan | null): string {
  if (!plan || plan.units.length === 0) return 'Installing'
  const actions = new Set(plan.units.map(u => u.action))
  if (actions.size === 1) {
    const only = [...actions][0]
    if (only === 'uninstall') return 'Removing'
    if (only === 'update') return 'Updating'
  }
  return 'Installing'
}
