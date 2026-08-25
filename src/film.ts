/*
 * Filming mode — the app driving itself, for the project video.
 *
 * The video toolkit's governing rule is that everything on screen is the real
 * application: nothing mocked up, nothing reconstructed in a design tool. Burrow
 * has no control surface a capture script could talk to, and it is a native
 * window rather than a page, so the Chrome DevTools route the other projects use
 * cannot reach it.
 *
 * So it drives itself. This runs against the **real** catalogue and the **real**
 * contents of this machine's plugin folders — the plugin names, versions,
 * release notes and update counts on screen are all genuine. Only the hand on
 * the trackpad is replaced.
 *
 * It cannot install, update or remove anything. The choreography changes which
 * tab is showing and what is in the search box. That is the whole of it — a take
 * should never be the first time a piece of software writes to somebody's disk.
 *
 * Each step reports the moment it actually happened back to Rust, so the beats
 * the editor cuts against are when the app was really told, not an estimate.
 */

import { api } from './api/backend'

export interface Step {
  /** Milliseconds after the choreography starts. */
  at: number
  label: string
  run: () => void
}

const invokeBeat = async (label: string, at: number) => {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('film_beat', { label, at })
  } catch {
    // Filming without a backend is not a thing worth failing over.
  }
}

/**
 * The take.
 *
 * Paced for a 30–60 second cut: long enough on each beat that a viewer can read
 * the screen, short enough that the whole thing moves.
 */
export function choreography(
  setTab: (t: 'whatsnew' | 'video' | 'audio' | 'netinfra' | 'settings') => void,
  setQuery: (q: string) => void,
): Step[] {
  return [
    // Open where the value is: the whole list, and what needs attention.
    { at: 1200, label: 'video', run: () => setTab('video') },

    // Search, because "twenty-four plugins" is only a virtue if you can find one.
    { at: 6000, label: 'search', run: () => setQuery('cathode') },
    { at: 10500, label: 'search-clear', run: () => setQuery('') },

    // The fleet is wider than the plugins now, and one tab move says so
    // better than any caption would.
    { at: 13500, label: 'audio', run: () => setTab('audio') },

    // What changed, in the plugins you already have.
    { at: 18000, label: 'whatsnew', run: () => setTab('whatsnew') },

    // Where things go, and the honest paragraph about what it sends.
    { at: 24000, label: 'settings', run: () => setTab('settings') },

    // Back to the list to end on the thing the app is for.
    { at: 30000, label: 'video-end', run: () => setTab('video') },

    // A marker, not a move — nothing happens here.
    //
    // `assemble.body_end` cuts the footage at the *last* beat and gives every
    // other beat a caption running until the next one. So whatever the last beat
    // is, its caption is never shown: without this, the closing line played over
    // nothing and the cut ended on the Settings pane it had just left.
    { at: 36000, label: 'end', run: () => {} },
  ]
}

/** Run the choreography, reporting each beat as it fires. */
export function runFilm(
  setTab: (t: 'whatsnew' | 'video' | 'audio' | 'netinfra' | 'settings') => void,
  setQuery: (q: string) => void,
): () => void {
  const started = performance.now()
  const timers: number[] = []

  for (const step of choreography(setTab, setQuery)) {
    timers.push(
      window.setTimeout(() => {
        step.run()
        void invokeBeat(step.label, (performance.now() - started) / 1000)
      }, step.at),
    )
  }
  void invokeBeat('start', 0)
  return () => timers.forEach(t => window.clearTimeout(t))
}

export async function isFilming(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<boolean>('film_mode')
  } catch {
    return false
  }
}

/**
 * How long to wait before the choreography starts, in milliseconds.
 *
 * The window mounts several seconds before a capture script can have a recorder
 * running and the window sized, and the choreography used to start regardless —
 * so the take opened part-way through it, with beat timings that matched nothing
 * in the footage. The capture script sets `BURROW_FILM_DELAY` to cover its own
 * setup; see `film_delay` in state.rs.
 */
export async function filmDelay(): Promise<number> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<number>('film_delay')
  } catch {
    return 0
  }
}

export { api }
