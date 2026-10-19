import type { Phase, Progress } from './types'
import { humanSize } from './backend'

/**
 * A phase, as a person reads it.
 *
 * The backend's names describe what the code is doing; these describe what the
 * person is waiting for. "Verifying" is a hash of what was just installed,
 * which nobody asked for and nobody needs explained — "Checking the copy"
 * says what it is for. "Committing" is not "Installing", because the strip
 * already says that about the batch as a whole, and the bytes it counts are
 * the copy into the plugin folder.
 */
export const PHASE_LABEL: Record<Phase, string> = {
  downloading: 'Downloading',
  extracting: 'Unpacking',
  'clearing-quarantine': 'Clearing quarantine',
  staged: 'Downloaded',
  committing: 'Copying into place',
  removing: 'Removing',
  verifying: 'Checking the copy',
  'awaiting-authorization': 'Waiting for your password',
}

export function phaseLabel(phase: Phase): string {
  return PHASE_LABEL[phase] ?? phase
}

/** How far through the phase, from 0 to 1 — or null when nothing can say. */
export function fraction(p: Progress): number | null {
  if (!p.bytesTotal || p.bytesTotal <= 0) return null
  return Math.min(1, p.bytesDone / p.bytesTotal)
}

/**
 * "Downloading · 12.3 MB of 40.1 MB", or "Unpacking…" when the phase has no
 * total to count against. One line, for a row and for the strip alike.
 */
export function progressText(p: Progress): string {
  const label = phaseLabel(p.phase)
  // Parked with a full bar: a count would say "364 KB of 364 KB", which is
  // true and not the point.
  if (p.phase === 'staged') return `${label} · waiting to be installed`
  if (p.bytesTotal && p.bytesTotal > 0) {
    return `${label} · ${humanSize(p.bytesDone) || '0 B'} of ${humanSize(p.bytesTotal)}`
  }
  return `${label}…`
}
