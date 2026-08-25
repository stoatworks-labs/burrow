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

# A free port, found rather than assumed.
#
# ⚠️ This was a fixed 5197, and on 2026-08-25 another session on this machine
# already had a server there — serving a bare `<video>` test page. `http.server`
# failed to bind, the readiness `curl` succeeded against *their* server, and the
# script wrote seven screenshots of somebody else's video player without a word.
# It exits non-zero now if it cannot find a port, and checks below that what it
# is photographing is actually Burrow.
port=""
for candidate in $(seq 5197 5210); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
    port="$candidate"
    break
  fi
done
[ -n "$port" ] || { echo "no free port in 5197-5210" >&2; exit 2; }
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$chrome" ] || chrome="/Applications/Chromium.app/Contents/MacOS/Chromium"
[ -x "$chrome" ] || { echo "no Chrome or Chromium found" >&2; exit 2; }

# The mock reads the catalogue from the served root, so it has to be beside the
# built assets. The thumbnails are already there — `public/` is where they live
# and are committed, because a frontend asset has to be in the vite bundle to
# resolve as `./thumbs/x.png`.
#
# ⚠️ This used to `rm -rf public/thumbs` and copy them in from
# `src-tauri/assets/thumbs`, which is where they lived until they were moved for
# exactly that reason. After the move the source did not exist, so the line
# deleted 65 committed images and then failed on the copy — with `set -e`
# turning a destroyed working tree into a script that "just errored". Do not
# reintroduce a delete of a directory this script does not own.
cp src-tauri/assets/catalog.json public/catalog.json
npm run build >/dev/null

python3 -m http.server "$port" --directory dist >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
until curl -fs -o /dev/null "http://127.0.0.1:$port/"; do sleep 0.3; done

# What answered has to be Burrow. Binding is not proof: if the bind silently
# lost a race, this is what catches it before seven images are overwritten.
if ! curl -fs "http://127.0.0.1:$port/" | grep -q "Stoatworks Burrow"; then
  echo "something else is answering on port $port — refusing to screenshot it" >&2
  exit 2
fi

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
shot plugins   "shot=1&tab=video&installed=$INSTALLED&ofx=missing"
shot whatsnew  "shot=1&tab=whatsnew&installed=tinsel:ffgl@0.2.0,idler:ffgl@1.0.2"
shot settings  "shot=1&tab=settings&ofx=missing" 1150
shot offline   "shot=1&tab=video&state=offline&source=baked&installed=$INSTALLED"

# The other three tabs. Audio is where a plugin, an application and a Companion
# module are all visible at once, which is the whole point of the categories —
# so it gets a shot with one of each in a different state.
# `%2B`, not `+`: a literal plus in a query string decodes to a space, and the
# multi-format spec would silently install nothing.
shot audio     "shot=1&tab=audio&installed=simplecue:app@0.3.0,zero-eq:vst3%2Bau"
shot netinfra  "shot=1&tab=netinfra&installed=srt-router:app"
shot firmware  "shot=1&tab=firmware" 520

# Trim the working copy back out — it is a build input for the mock, not
# something the repo should carry twice. The thumbnails stay: they are committed
# assets, not a copy of anything.
rm -f public/catalog.json

echo
echo "done. Commit only the images that actually changed — a re-render with no UI"
echo "change still produces new bytes, and a diff of four PNGs hides the one that matters."
