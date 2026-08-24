#!/usr/bin/env bash
#
# README and user-guide screenshots, from the real UI.
#
#   ./scripts/screenshot.sh
#
# Drives the built front end in headless Chrome against the mock backend, which
# is the same code path the app uses with Rust behind it — the components,
# styles and catalogue are all the real ones. Only the answers to
# `invoke` are synthesised.
#
# That is the point: several of these states are awkward or slow to produce on
# a real machine, and one of them (a cancelled password prompt) would mean
# cancelling a password prompt on cue. Driving them from a query parameter
# makes the set reproducible, so a screenshot can be regenerated months later
# and differ only where the UI actually changed.
#
# The catalogue served here is `public/catalog.json`, copied from the same file
# that ships inside the app, so the plugin names, versions and release notes in
# the images are the real ones.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

out="docs/screenshots"
port=5197
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$chrome" ] || chrome="/Applications/Chromium.app/Contents/MacOS/Chromium"
[ -x "$chrome" ] || { echo "no Chrome or Chromium found" >&2; exit 2; }

# The mock reads the catalogue and thumbnails from the served root, so both have
# to be beside the built assets.
cp src-tauri/assets/catalog.json public/catalog.json
rm -rf public/thumbs && cp -R src-tauri/assets/thumbs public/thumbs
npm run build >/dev/null

python3 -m http.server "$port" --directory dist >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
until curl -fs -o /dev/null "http://127.0.0.1:$port/"; do sleep 0.3; done

mkdir -p "$out"

# A machine mid-way through: some plugins current, several behind, one whose
# version cannot be read, and OpenFX not yet set up. That is what a real
# Resolume user's first run looks like, and it exercises every chip state.
INSTALLED='tinsel:ffgl@0.2.0,downpour:ffgl@0.2.0,orrery:ffgl@0.2.0,asciify:ffgl,porthole:ffgl,idler:ffgl@?'

shot() {
  local name="$1" query="$2" height="${3:-900}"
  "$chrome" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size="1180,$height" \
    --virtual-time-budget=2500 \
    --screenshot="$out/$name.png" \
    "http://127.0.0.1:$port/?$query" >/dev/null 2>&1
  echo "  $out/$name.png"
}

echo "writing screenshots:"
shot plugins   "shot=1&tab=plugins&installed=$INSTALLED&ofx=missing"
shot whatsnew  "shot=1&tab=whatsnew&installed=tinsel:ffgl@0.2.0,idler:ffgl@1.0.2"
shot settings  "shot=1&tab=settings&ofx=missing" 1000
shot offline   "shot=1&tab=plugins&state=offline&source=baked&installed=$INSTALLED"

# Trim the working copies back out — they are build inputs for the mock, not
# things the repo should carry twice.
rm -f public/catalog.json
rm -rf public/thumbs

echo
echo "done. Commit only the images that actually changed — a re-render with no UI"
echo "change still produces new bytes, and a diff of four PNGs hides the one that matters."
