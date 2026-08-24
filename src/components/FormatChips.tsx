import type { Slot } from '../api/types'
import { FORMAT_LABEL } from '../api/types'

/**
 * The per-format state of one plugin, as a row of pills.
 *
 * Six visually distinct states rather than three plus tooltips, because a
 * plugin really can be in six different conditions and collapsing them loses
 * the thing the user needs to know:
 *
 *   installed, current      FFGL ✓ 1.0.2
 *   installed, behind       FFGL 1.0.1 → 1.0.2
 *   offered, not installed  OpenFX +          (clickable: installs just this)
 *   installed, no version   FFGL ✓ ?          (normal on Windows; not an error)
 *   not offered at all      Adobe —
 *   something foreign       FFGL ⚠            (there, but not ours)
 */
export function FormatChips({
  slots,
  onInstallOne,
  disabled,
}: {
  slots: Slot[]
  onInstallOne?: (slot: Slot) => void
  disabled?: boolean
}) {
  return (
    <div className="chips">
      {slots.map(slot => {
        const label = FORMAT_LABEL[slot.format] ?? slot.format
        const s = slot.state

        if (s.state === 'no-build') {
          return (
            <span key={slot.destinationId} className="chip none" title={`No ${label} build`}>
              {label} —
            </span>
          )
        }
        if (slot.foreign) {
          return (
            <span
              key={slot.destinationId}
              className="chip unknown"
              title="Something with that name is already there, but Burrow did not put it there and will not replace it."
            >
              {label} ⚠ not ours
            </span>
          )
        }
        if (s.state === 'up-to-date') {
          return (
            <span key={slot.destinationId} className="chip current" title={slot.destinationLabel}>
              {label} ✓ {s.version.replace(/^v/, '')}
            </span>
          )
        }
        if (s.state === 'update-available') {
          return (
            <span key={slot.destinationId} className="chip behind" title={slot.destinationLabel}>
              {label} {s.installed.replace(/^v/, '')} → {s.latest.replace(/^v/, '')}
            </span>
          )
        }
        if (s.state === 'version-unknown') {
          return (
            <span
              key={slot.destinationId}
              className="chip unknown"
              title={`Installed (${s.entries.join(', ')}), but nothing on disk says which version. Normal on Windows, where plugins carry no version.`}
            >
              {label} ✓ version unknown
            </span>
          )
        }
        // Offered and not installed. The chip is the install control.
        return (
          <button
            key={slot.destinationId}
            className="chip available"
            disabled={disabled}
            onClick={() => onInstallOne?.(slot)}
            title={
              slot.needsElevation
                ? `Install for ${slot.destinationLabel} — asks for your password`
                : `Install for ${slot.destinationLabel}`
            }
          >
            {label} +{slot.needsElevation ? ' · admin' : ''}
          </button>
        )
      })}
    </div>
  )
}
