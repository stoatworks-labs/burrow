import type { PluginView } from '../api/types'

/**
 * The picture at the left of a plugin's row.
 *
 * Where the plugin has a video, this is the video's own still with a play badge,
 * and clicking it opens the video in the user's browser. Otherwise it falls back
 * to the project card, and where there is neither it renders nothing rather than
 * a broken-image box.
 *
 * ## Why the still is bundled rather than loaded from YouTube
 *
 * Both `i.ytimg.com/vi/<id>/hqdefault.jpg` and an embedded player would work,
 * and both would be wrong here. Burrow's claim — in its README, its user guide
 * and its Settings tab — is that it fetches the plugin list, downloads from
 * GitHub, and talks to nothing else. Loading two dozen thumbnails from Google
 * on every launch makes that false, and it tells Google which plugins somebody
 * is browsing.
 *
 * So the stills ship inside the app (`scripts/sync-assets.sh` gathers them from
 * the same public copy YouTube itself fetched at upload time, so it is the frame
 * that is actually on the video). They work offline, and nothing is requested
 * until the user deliberately clicks one — at which point `VideoModal` loads the
 * embed, for that one video, from youtube-nocookie.com.
 */
export function PluginArt({
  plugin,
  onPlay,
}: {
  plugin: PluginView
  /** Play the video inside the window. */
  onPlay: (plugin: PluginView) => void
}) {
  const hasVideo = Boolean(plugin.youtube)

  const image = hasVideo ? (
    <img
      className="art-img"
      src={`./video/${plugin.slug}.png`}
      alt=""
      // Twenty of the twenty-one plugins with a video have a still bundled.
      // The odd one out falls back to its project card rather than leaving a
      // gap where a picture should be.
      onError={e => {
        const img = e.target as HTMLImageElement
        if (!img.dataset.fellBack) {
          img.dataset.fellBack = '1'
          img.src = `./thumbs/${plugin.slug}.png`
        } else {
          img.style.visibility = 'hidden'
        }
      }}
    />
  ) : (
    <img
      className="art-img"
      src={`./thumbs/${plugin.slug}.png`}
      alt=""
      onError={e => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
    />
  )

  if (!hasVideo) return <div className="art">{image}</div>

  return (
    <button
      className="art art-play"
      onClick={() => onPlay(plugin)}
      title={`Watch the ${plugin.name} video`}
      aria-label={`Watch the ${plugin.name} video`}
    >
      {image}
      <span className="art-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="17" height="17">
          <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
        </svg>
      </span>
    </button>
  )
}
