import { useEffect, useRef, useState } from 'react'
import { api } from '../api/backend'
import type { PluginView } from '../api/types'

/**
 * A plugin's video, playing inside the window.
 *
 * ## Burrow streams its own copy
 *
 * Not a YouTube embed. The video is an ordinary `.mp4` on a GitHub release,
 * played by an ordinary `<video>` element.
 *
 * That is the whole point. Burrow's claim is that it fetches the plugin list,
 * downloads plugins from GitHub, and talks to nothing else — and GitHub is
 * already in that trust set, because every plugin comes from there. Embedding
 * YouTube made the claim false and needed a paragraph of caveats;
 * `youtube-nocookie.com` only withheld tracking cookies *until playback
 * started*, so it bought a qualification rather than a guarantee. It also
 * refused to play at all from a `tauri://` origin, which needed a loopback
 * page purely to give it an http one.
 *
 * Playing our own copy means no third party, no cookies, no ads, no suggested
 * videos, and nothing to explain. It also means autoplay is fine again, because
 * there is no longer anything being withheld until you press play.
 *
 * The files are 720p, around 11 MB each, encoded with `-movflags +faststart`
 * so the moov atom sits at the front and playback begins on the first range
 * request rather than after the whole download.
 *
 * ## Why the src is a loopback address and not the GitHub one
 *
 * GitHub serves release assets with `content-disposition: attachment`, and
 * WebKit will not render media a server has declared a download — the element
 * shows its broken-playback glyph and reports nothing useful. The content type
 * is fine (`application/octet-stream` gets sniffed); the disposition is not.
 *
 * So Burrow's own loopback server passes the bytes through, forwarding the
 * Range header upstream and the Content-Range back, labelled `video/mp4`.
 * Streaming and seeking survive, nothing is buffered to disk, and the bytes
 * still come from the same GitHub release.
 *
 * ## When there is no copy
 *
 * `videoUrl` is null for a plugin whose video has no encoded copy. The modal
 * never opens for those — the row offers YouTube in the browser instead, which
 * is honest about being a different thing rather than showing a player that
 * cannot play.
 */
export function VideoModal({
  plugin,
  onClose,
  onOpenExternal,
}: {
  plugin: PluginView
  onClose: () => void
  onOpenExternal: (url: string) => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api
      .videoUrl(plugin.slug)
      .then(u => live && setSrc(u))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [plugin.slug])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    const video = videoRef.current
    return () => {
      window.removeEventListener('keydown', onKey)
      // Stop the download as well as the playback. Closing a modal should not
      // leave eleven megabytes still arriving in the background.
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${plugin.name} video`}
    >
      {/* Clicks inside the panel must not fall through to the backdrop's close
          handler — otherwise using the player's own controls dismisses the
          thing you are trying to use. */}
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{plugin.name}</strong>
          <span className="spacer" />
          {plugin.youtube && (
            <button
              className="btn quiet"
              onClick={() =>
                onOpenExternal(`https://www.youtube.com/watch?v=${plugin.youtube}`)
              }
            >
              Open on YouTube
            </button>
          )}
          <button className="btn quiet" ref={closeRef} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="modal-video">
          <video
            ref={videoRef}
            src={src ?? undefined}
            onError={() => setFailed(true)}
            // The bundled still, so the frame is filled before a byte arrives.
            poster={`./video/${plugin.slug}.png`}
            controls
            autoPlay
            playsInline
            preload="metadata"
          />
          {failed && (
            <div className="modal-failed">
              That video could not be played.
              {plugin.youtube && (
                <button
                  className="btn"
                  onClick={() =>
                    onOpenExternal(`https://www.youtube.com/watch?v=${plugin.youtube}`)
                  }
                >
                  Watch it on YouTube instead
                </button>
              )}
            </div>
          )}
        </div>
        <div className="modal-note">
          Streamed from this project&rsquo;s own GitHub release — the same place
          its plugins come from. No third party, no cookies, no ads.
        </div>
      </div>
    </div>
  )
}
