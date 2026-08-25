import { useEffect, useRef, useState } from 'react'
import { api } from '../api/backend'
import type { PluginView } from '../api/types'

/**
 * A tool's `docker-compose.yml`, in a window, with a way to take it away.
 *
 * ## Why the text is here at all
 *
 * Eight of the fleet's tools are things you run as a container, and for those
 * the compose file *is* the instruction — more use than any prose about it. It
 * arrives inside the catalogue rather than being fetched when this opens, so
 * this window works with no network at all and Burrow's claim about what it
 * talks to does not gain a third host. See `sync-compose.py` in the website.
 *
 * ## Copy, and why there is a fallback
 *
 * `navigator.clipboard.writeText` is the right call and usually works in the
 * webview. When it does not — an older WebKit, a context it considers
 * insecure — it rejects rather than throwing synchronously, and a button that
 * silently does nothing is worse than one that says it could not. So the
 * failure is caught, a `document.execCommand` fallback is tried, and if that
 * fails too the window says so instead of pretending.
 *
 * ## Save, and why it is "to Downloads" rather than a dialog
 *
 * A save dialog would mean adding `tauri-plugin-dialog` and a capability for
 * it. This app's permission list is two entries long on purpose. Downloads is
 * where a browser would put it, the app can already reveal a path in Finder,
 * and the button says exactly where it is going — so nobody has to guess and
 * nothing new is granted. The written name carries the slug, because a bare
 * `docker-compose.yml` is unfindable in a folder of other people's downloads.
 */
export function ComposeModal({
  plugin,
  onClose,
  onReveal,
}: {
  plugin: PluginView
  onClose: () => void
  onReveal: (path: string) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Escape closes, and focus starts on Close — the same as the video window, so
  // the two behave alike rather than each having its own habits.
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const text = plugin.compose ?? ''

  async function copy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
      return
    } catch {
      // Fall through to the older route rather than give up.
    }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      setCopied(ok ? 'yes' : 'no')
    } catch {
      setCopied('no')
    }
  }

  async function save() {
    setError(null)
    try {
      setSaved(await api.saveCompose(plugin.slug, text))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${plugin.name} compose file`}
    >
      {/* Clicks inside the panel must not reach the backdrop's close handler,
          or selecting the text dismisses the window you are reading. */}
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{plugin.name}</strong>
          <span className="d">docker-compose.yml</span>
          <span className="spacer" />
          <button className="btn quiet" onClick={copy}>
            {copied === 'yes' ? 'Copied' : copied === 'no' ? 'Could not copy' : 'Copy'}
          </button>
          <button className="btn quiet" onClick={save}>
            Save to Downloads
          </button>
          <button className="btn quiet" ref={closeRef} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <pre className="modal-code" tabIndex={0}>
          {text}
        </pre>

        {saved && (
          <div className="modal-note">
            Saved to <code>{saved}</code>{' '}
            <button className="btn quiet" onClick={() => onReveal(saved)}>
              Show
            </button>
          </div>
        )}
        {error && <div className="inline-err">{error}</div>}
        {!saved && !error && (
          <div className="modal-note">
            Shipped in the plugin list, so this window needs no connection. Run it
            with <code>docker compose up -d</code> in a folder holding this file.
          </div>
        )}
      </div>
    </div>
  )
}
