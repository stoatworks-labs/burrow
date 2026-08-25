#!/usr/bin/env bash
#
# Gather everything Burrow ships inside itself:
#
#   src-tauri/assets/catalog.json   the catalogue as of this build
#   src-tauri/assets/demos/<slug>/  each plugin's browser demo
#   public/thumbs/                  one picture per plugin
#   public/video/                   each plugin's video still
#   src-tauri/bin/burrow-helper-*   the privileged helper, per target triple
#
# The split between the two destinations is not arbitrary. `src-tauri/assets`
# is a Tauri *resource*, reachable from Rust and served by the loopback demo
# server. `public/` is a frontend asset, bundled into dist and addressable from
# the UI as `./thumbs/x.png`.
#
# The images have to be the second kind. They were in assets/ first, and the
# packaged app showed no pictures at all: `./video/x.png` resolves against the
# frontend bundle, which did not contain them. Nothing failed loudly — every
# image just quietly did not appear.
#
# Same arrangement as stoatworks-backend/resolume-demo/sync.sh, and for the
# same reason: these are *build inputs* copied from the source of truth, never
# edited here. Re-run it at every Burrow release, or the built-in demos and the
# offline catalogue quietly describe an older fleet than the one on the site.
#
#   ./scripts/sync-assets.sh           gather everything
#   ./scripts/sync-assets.sh --check   exit non-zero if anything has drifted
#   ./scripts/sync-assets.sh --no-helper   skip the cargo build
#
# The baked catalogue is not a nicety. It does three jobs:
#   1. a first run with no network still shows the whole fleet;
#   2. it is the baseline that stops "What's new" announcing all 24 plugins on
#      first launch;
#   3. the GitHub fallback cannot *discover* which repos exist — only the baked
#      copy can tell it.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
projects="${PROJECTS_ROOT:-$HOME/Projects}"
plugins="$projects/resolume"
website="$projects/infrastructure/stoatworks-website"

assets="$here/src-tauri/assets"
demos="$assets/demos"
thumbs="$here/public/thumbs"
video_out="$here/public/video"

check_only=0
build_helper=1
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --no-helper) build_helper=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$website" ]; then
  echo "cannot find the website checkout at $website" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# the catalogue
# ---------------------------------------------------------------------------
built="$website/dist/catalog.json"
if [ ! -f "$built" ]; then
  echo "no built catalogue at $built" >&2
  echo "run 'npm run build' in the website checkout first." >&2
  exit 2
fi

# A catalogue with no entries would tell every copy of Burrow that the fleet is
# empty. The route already refuses to emit one; this is the second gate,
# because baking a bad file is much harder to notice than failing to build one.
entries=$(python3 -c "import json,sys; print(len(json.load(open('$built'))['entries']))")
if [ "$entries" -lt 1 ]; then
  echo "the built catalogue has no entries — refusing to bake it" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# demos
# ---------------------------------------------------------------------------
# Two shapes exist: most plugins use the shared kit in `demo/`, while burin,
# flipbook and outrun are hand-written apps under `web/public/`. Both are
# static with relative asset paths, so both are a plain copy.
#
# The exclusions match each demo's own .assetsignore — except that three of the
# nineteen have no .assetsignore at all, so the list is applied uniformly here
# rather than read per repo. The demo server refuses to serve them too; this is
# the belt to that braces, and keeps them out of the download.
copy_demo() {
  local slug="$1" src="$2" dst="$demos/$1"
  rm -rf "$dst"; mkdir -p "$dst"
  rsync -a \
    --exclude 'README.md' \
    --exclude '.assetsignore' \
    --exclude '_headers' \
    --exclude 'tools/' \
    --exclude '.wrangler/' \
    --exclude 'node_modules/' \
    "$src/" "$dst/"
}

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

count=0
missing=()
while IFS= read -r slug; do
  repo="$plugins/$slug"
  if   [ -d "$repo/demo" ];        then src="$repo/demo"
  elif [ -d "$repo/web/public" ];  then src="$repo/web/public"
  else missing+=("$slug"); continue
  fi
  demos="$stage/demos"; mkdir -p "$demos"
  copy_demo "$slug" "$src"
  count=$((count + 1))
done < <(python3 -c "
import json
for e in json.load(open('$built'))['entries']:
    if e.get('demo'): print(e['slug'])
")
demos="$assets/demos"

# ---------------------------------------------------------------------------
# thumbnails
# ---------------------------------------------------------------------------
# Downscaled on the way in. At full size the 24 PNGs are about 7 MB, which is
# more than every demo put together, and they are rendered in a list row about
# 96 pixels wide.
mkdir -p "$stage/thumbs"
thumb_count=0
while IFS= read -r slug; do
  src="$website/public/thumbs/$slug.png"
  [ -f "$src" ] || continue
  if command -v sips >/dev/null 2>&1; then
    sips -Z 480 "$src" --out "$stage/thumbs/$slug.png" >/dev/null 2>&1 || cp "$src" "$stage/thumbs/$slug.png"
  else
    cp "$src" "$stage/thumbs/$slug.png"
  fi
  thumb_count=$((thumb_count + 1))
done < <(python3 -c "
import json
for e in json.load(open('$built'))['entries']: print(e['slug'])
")

# ---------------------------------------------------------------------------
# video stills
# ---------------------------------------------------------------------------
# Each plugin's YouTube video gets a still in the row, with a play badge, and
# clicking it opens the video in the user's own browser.
#
# The still is BUNDLED rather than fetched from i.ytimg.com, and that is not an
# optimisation. Burrow's whole claim is that it fetches the plugin list and
# downloads from GitHub and talks to nothing else — loading two dozen
# thumbnails from Google on every launch would make that false, and would tell
# Google which plugins the user is looking at. Shipping the images keeps the
# claim true and works offline besides.
#
# They come from the `thumbnails` repo, which is the same public copy YouTube
# itself fetches at upload time, so the still in the app is the frame on the
# video rather than a lookalike.
#
# Two places to look, because the release checklist commits the still to both
# and only about half the fleet has ended up in both: the thumbnails repo is
# the copy YouTube fetches at upload time, and `docs/video-thumb.png` is the
# copy the project's own README embeds. Nine plugins with a video are missing
# from the thumbnails repo and eight of those have the repo copy, so taking
# either gets 20 of 21 rather than 12.
mkdir -p "$stage/video"
video_count=0
no_still=()
video_src="$projects/publishing/thumbnails/video"
while IFS= read -r slug; do
  src=""
  [ -f "$video_src/$slug.png" ] && src="$video_src/$slug.png"
  [ -z "$src" ] && [ -f "$plugins/$slug/docs/video-thumb.png" ] \
    && src="$plugins/$slug/docs/video-thumb.png"
  if [ -z "$src" ]; then no_still+=("$slug"); continue; fi
  if command -v sips >/dev/null 2>&1; then
    sips -Z 480 "$src" --out "$stage/video/$slug.png" >/dev/null 2>&1 \
      || cp "$src" "$stage/video/$slug.png"
  else
    cp "$src" "$stage/video/$slug.png"
  fi
  video_count=$((video_count + 1))
done < <(python3 -c "
import json
for e in json.load(open('$built'))['entries']:
    if e.get('youtube'): print(e['slug'])
")

cp "$built" "$stage/catalog.json"

# ---------------------------------------------------------------------------
# apply, or report drift
# ---------------------------------------------------------------------------
if [ "$check_only" -eq 1 ]; then
  drift=0
  if ! diff -q "$stage/catalog.json" "$assets/catalog.json" >/dev/null 2>&1; then
    echo "drift: catalog.json"; drift=1
  fi
  if ! diff -rq "$stage/thumbs" "$thumbs" >/dev/null 2>&1; then
    echo "drift: thumbs"; drift=1
  fi
  if ! diff -rq "$stage/video" "$video_out" >/dev/null 2>&1; then
    echo "drift: video stills"; drift=1
  fi
  if [ -d "$stage/demos" ] && ! diff -rq "$stage/demos" "$demos" >/dev/null 2>&1; then
    echo "drift: demos"; drift=1
  fi
  [ "$drift" -eq 0 ] && echo "assets are up to date"
  exit "$drift"
fi

mkdir -p "$assets"
cp "$stage/catalog.json" "$assets/catalog.json"
mkdir -p "$here/public"
rm -rf "$thumbs"; cp -R "$stage/thumbs" "$thumbs"
rm -rf "$video_out"; cp -R "$stage/video" "$video_out"
[ -d "$stage/demos" ] && { rm -rf "$demos"; cp -R "$stage/demos" "$demos"; }

# ---------------------------------------------------------------------------
# the privileged helper
# ---------------------------------------------------------------------------
# Tauri's externalBin wants the target triple in the filename. Shipping it
# inside the app bundle is what puts it under the app's own code signature —
# it cannot be swapped for something else without invalidating the signature,
# which is the reason Burrow itself must be signed even though it is the
# plugins that get installed.
if [ "$build_helper" -eq 1 ]; then
  triple="$(rustc -vV | awk '/^host:/ {print $2}')"
  ( cd "$here" && cargo build --release -p burrow-helper )
  mkdir -p "$here/src-tauri/bin"
  cp "$here/target/release/burrow-helper" "$here/src-tauri/bin/burrow-helper-$triple"
  echo "helper:   burrow-helper-$triple"
fi

echo "catalogue: $entries entries"
echo "demos:     $count bundled$([ ${#missing[@]} -gt 0 ] && echo " (no demo: ${missing[*]})")"
echo "thumbs:    $thumb_count"
echo "video:     $video_count still(s)$([ ${#no_still[@]} -gt 0 ] && echo " (no still: ${no_still[*]})")"
du -sh "$assets" 2>/dev/null | awk '{print "resources: " $1}'
du -sh "$here/public/thumbs" "$here/public/video" 2>/dev/null \
  | awk '{s=$1; print "public:    " $1 "  " $2}'
