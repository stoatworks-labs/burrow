import { useEffect, useMemo, useState } from 'react'
import type { OpRequest, PluginView, Slot } from '../api/types'
import { humanSize } from '../api/backend'

/*
 * The bulk buttons over a list, and the rule that decides what they do.
 *
 * The helpers sit in this file rather than beside the rows they describe
 * because it is the section heading that has to agree with them: a button
 * acting on twenty plugins at once is only safe while it is provably the same
 * thing each of those twenty rows offers on its own.
 */

/**
 * The slots each of a row's three buttons acts on.
 *
 * Module-level and shared with the section headings deliberately: a bulk
 * button is defined as its rows' own button pressed for every row, so
 * "Install all" cannot come to mean something the rows themselves do not
 * offer.
 *
 * `present` — what an uninstall targets — includes formats that are behind.
 * A plugin whose only installed format has an update is still installed, and
 * it used to get an Update button and no way to remove it. Nothing foreign is
 * ever in here: a bundle sharing a name that Burrow did not put there is
 * reported as not-installed for exactly this reason.
 */
export function rowSlots(plugin: PluginView) {
  const behind = plugin.slots.filter(s => s.state.state === 'update-available')
  const current = plugin.slots.filter(
    s => s.state.state === 'up-to-date' || s.state.state === 'version-unknown',
  )
  const offered = plugin.slots.filter(s => s.state.state === 'not-installed' && !s.foreign)
  return {
    behind,
    current,
    present: [...current, ...behind],
    offered,
    wanted: offered.filter(s => plugin.wantedFormats.includes(s.format)),
  }
}

export function ops(plugin: PluginView, slots: Slot[], action: OpRequest['action']): OpRequest[] {
  return slots.map(s => ({
    slug: plugin.slug,
    format: s.format,
    destinationId: s.destinationId,
    action,
  }))
}

/** Exactly what each of a row's three buttons would run. */
export function rowOps(plugin: PluginView) {
  const { behind, current, present, wanted } = rowSlots(plugin)
  return {
    // Matched to the row: a plugin with something already installed is not
    // offered a blanket Install, because adding one more format is the
    // format chips' job and says which format it is.
    install: current.length === 0 ? ops(plugin, wanted, 'install') : [],
    update: ops(plugin, behind, 'update'),
    uninstall: ops(plugin, present, 'uninstall'),
  }
}

type BulkKind = 'install' | 'update' | 'uninstall'

/**
 * A section heading, and the bulk buttons for the rows under it.
 *
 * Each button is its rows' own button pressed for all of them — both read
 * `rowOps` — so the two can never come to mean different things. They act on
 * the rows **on screen**, never on ones the search is hiding, which is why the
 * count is in the label rather than left implied.
 *
 * Only shown for more than one row. With a single row its own button is a
 * centimetre below, and two ways to press the same thing is not a convenience.
 *
 * Install and Remove ask first; Update does not. Update keeps what the user
 * already chose to have current, and it was one click before this existed. The
 * other two change what is on the machine, and at this scale a misclick is
 * twenty plugins rather than one.
 */
export function SectionHead({
  label,
  rows,
  busy,
  onRun,
}: {
  label: string
  rows: PluginView[]
  busy: boolean
  onRun: (r: OpRequest[]) => void
}) {
  const [confirming, setConfirming] = useState<BulkKind | null>(null)

  const bulk = useMemo(() => {
    const each = rows.map(p => ({ slots: rowSlots(p), ops: rowOps(p) }))
    const pick = (kind: BulkKind, slotsOf: (s: ReturnType<typeof rowSlots>) => Slot[]) => {
      const hit = each.filter(e => e.ops[kind].length > 0)
      const slots = hit.flatMap(e => slotsOf(e.slots))
      return {
        reqs: hit.flatMap(e => e.ops[kind]),
        n: hit.length,
        bytes: slots.reduce((a, s) => a + (s.size ?? 0), 0),
        elevated: slots.some(s => s.needsElevation),
      }
    }
    return {
      install: pick('install', s => s.wanted),
      update: pick('update', s => s.behind),
      uninstall: pick('uninstall', s => s.present),
    }
  }, [rows])

  // A pending confirmation counts the rows that were there when it was opened.
  // A finished job moves plugins between sections and a search changes what is
  // in this one, so the question is withdrawn rather than left on screen
  // describing a list that has moved on.
  const identity = rows.map(p => p.slug).join(',')
  useEffect(() => setConfirming(null), [identity])

  function run(kind: BulkKind) {
    setConfirming(null)
    onRun(bulk[kind].reqs)
  }

  return (
    <>
      <div className="section-head">
        <h2>{label}</h2>
        <span className="n">{rows.length}</span>
        <span className="spacer" />
        {bulk.update.n > 1 && (
          <button className="btn primary" disabled={busy} onClick={() => run('update')}>
            Update all {bulk.update.n}
          </button>
        )}
        {bulk.install.n > 1 && (
          <button
            // Primary unless an Update sits beside it: in "Not installed" this
            // is the section's whole point, but it never outranks an update.
            className={bulk.update.n > 1 ? 'btn' : 'btn primary'}
            disabled={busy}
            onClick={() => setConfirming(c => (c === 'install' ? null : 'install'))}
          >
            Install all {bulk.install.n}
          </button>
        )}
        {bulk.uninstall.n > 1 && (
          <button
            className="btn quiet"
            disabled={busy}
            onClick={() => setConfirming(c => (c === 'uninstall' ? null : 'uninstall'))}
          >
            Remove all {bulk.uninstall.n}
          </button>
        )}
      </div>

      {confirming === 'install' && (
        <div className="section-confirm">
          <span>
            Install {bulk.install.n} items
            {bulk.install.bytes > 0 && ` — ${humanSize(bulk.install.bytes)} to download`}.
            {bulk.install.elevated &&
              ' Some of them go in a folder that asks for your password.'}
          </span>
          <span className="spacer" />
          <button className="btn primary" disabled={busy} onClick={() => run('install')}>
            Install {bulk.install.n}
          </button>
          <button className="btn quiet" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}

      {confirming === 'uninstall' && (
        <div className="section-confirm bad">
          <span>
            Remove {bulk.uninstall.n} items. Only the files Burrow installed are
            deleted — anything else in those folders is left alone.
            {bulk.uninstall.elevated && ' Some of it asks for your password.'}
          </span>
          <span className="spacer" />
          <button className="btn danger" disabled={busy} onClick={() => run('uninstall')}>
            Remove {bulk.uninstall.n}
          </button>
          <button className="btn quiet" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}
    </>
  )
}
