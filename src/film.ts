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
  setTab: (t: 'whatsnew' | 'plugins' | 'settings') => void,
  setQuery: (q: string) => void,
): Step[] {
  return [
    // Open where the value is: the whole list, and what needs attention.
    { at: 1200, label: 'plugins', run: () => setTab('plugins') },

    // Search, because "twenty-four plugins" is only a virtue if you can find one.
    { at: 6000, label: 'search', run: () => setQuery('cathode') },
    { at: 10500, label: 'search-clear', run: () => setQuery('') },

    // What changed, in the plugins you already have.
    { at: 13500, label: 'whatsnew', run: () => setTab('whatsnew') },

    // Where things go, and the honest paragraph about what it sends.
    { at: 21000, label: 'settings', run: () => setTab('settings') },

    // Back to the list to end on the thing the app is for.
    { at: 27000, label: 'plugins-end', run: () => setTab('plugins') },
  ]
}

/** Run the choreography, reporting each beat as it fires. */
export function runFilm(
  setTab: (t: 'whatsnew' | 'plugins' | 'settings') => void,
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

export { api }
