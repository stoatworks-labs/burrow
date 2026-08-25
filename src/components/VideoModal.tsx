import { useEffect, useRef, useState } from 'react'
import { api } from '../api/backend'

/**
 * A plugin's video, playing inside the window.
 *
 * ## Click to play, and why the poster is local
 *
 * The still behind this is bundled with the app, so the plugin list itself
 * makes no request to Google — you can browse all twenty-four plugins offline
 * and nothing is fetched. Only opening this modal loads anything, and only for
 * the one video you chose.
 *
 * That is the difference between "this app talks to YouTube" and "this app
 * opens a video when you ask it to", and it is worth the extra component.
 *
 * ## The extra hop, and why it is not optional
 *
 * The app does not frame YouTube directly. It frames a one-line page served by
 * Burrow's own loopback server, and *that* page frames the video.
 *
 * YouTube refuses to play in a frame whose page origin is not http(s), and a
 * Tauri window is `tauri://localhost`. Embedding it directly gives **error 153,
 * "Video player configuration error"** — and only in the packaged app, because
 * a browser preview runs on `http://localhost` and plays perfectly. That is a
 * particularly unhelpful shape of bug, so the hop stays even though it looks
 * redundant from here.
 *
 * ## youtube-nocookie.com
 *
 * The embed uses `youtube-nocookie.com` — YouTube's privacy-enhanced host. It
 * does not set its tracking cookies until playback actually starts, and it
 * keeps what it does store out of the profile used for ad personalisation.
 *
 * Being precise about what that does and does not buy: it is still Google's
 * server, and loading this page still tells Google an IP address asked for this
 * video. What it avoids is the persistent identifier that would tie that
 * request to the rest of somebody's browsing. Burrow's Settings tab says
 * exactly this rather than implying the embed is invisible.
 *
 * `rel=0` keeps the end-screen suggestions to the same channel; `modestbranding`
 * drops the YouTube wordmark from the control bar.
 */
export function VideoModal({
  videoId,
  title,
  watchUrl,
  onClose,
  onOpenExternal,
}: {
  videoId: string
  title: string
  watchUrl: string
  onClose: () => void
  onOpenExternal: (url: string) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .videoUrl(videoId)
      .then(url => live && setSrc(url))
      .catch(e => live && setFailed(String(e)))
    return () => {
      live = false
    }
  }, [videoId])

  useEffect(() => {
    // Escape closes it, which is what anyone will try first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} video`}
    >
      {/* Clicks inside the panel must not fall through to the backdrop's
          close handler — otherwise using the player's own controls dismisses
          the thing you are trying to use. */}
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="btn quiet" onClick={() => onOpenExternal(watchUrl)}>
            Open on YouTube
          </button>
          <button className="btn quiet" ref={closeRef} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="modal-video">
          {src && (
            <iframe
              src={src}
              title={`${title} — video`}
              allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          )}
          {failed && (
            <div className="modal-failed">
              The video player could not start ({failed}).
              <button className="btn" onClick={() => onOpenExternal(watchUrl)}>
                Open on YouTube instead
              </button>
            </div>
          )}
        </div>
        <div className="modal-note">
          Played from youtube-nocookie.com, which does not set tracking cookies
          until playback starts. It is still Google&rsquo;s server — nothing is
          loaded from it until you open a video.
        </div>
      </div>
    </div>
  )
}
