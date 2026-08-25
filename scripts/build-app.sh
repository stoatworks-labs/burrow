#!/usr/bin/env bash
#
# Build a local, runnable Stoatworks Burrow.app for testing.
#
#   ./scripts/build-app.sh          build it
#   ./scripts/build-app.sh --open   build it and launch it
#
# This is the *testing* path, not the release path. A real release goes through
# stoatworks-backend/release/release-lib.sh, which builds the .dmg and .pkg and
# signs with the Developer ID — Tauri's own dmg step drives Finder over
# AppleScript and fails headless.
#
# ## The trap this script exists for
#
# `tauri build` signs the bundle ad-hoc, and then the bundler places
# `Contents/Resources/assets/` — the catalogue, demos and thumbnails — which the
# signature does not cover. The result verifies as:
#
#     code has no resources but signature indicates they must be present
#
# The app still launches from a local build, because Gatekeeper only assesses
# bundles carrying the quarantine attribute and a locally built one does not.
# But a *downloaded* copy in that state is refused outright, and the failure
# would first appear on somebody else's machine. So this re-signs afterwards,
# nested binaries first, which is the order rl_adhoc_sign uses and the order
# codesign requires.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

open_after=0
for arg in "$@"; do
  case "$arg" in
    --open) open_after=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "==> gathering the catalogue, demos, thumbnails and helper"
./scripts/sync-assets.sh

echo "==> building"
npx tauri build --bundles app

app="$here/src-tauri/target/release/bundle/macos/Stoatworks Burrow.app"
[ -d "$app" ] || { echo "no .app was produced" >&2; exit 1; }

echo "==> re-signing (nested binaries first)"
# Every Mach-O inside the bundle, then the bundle itself. Signing the bundle
# first leaves the nested binary unsigned inside a sealed container, which
# codesign reports as a nested-code failure rather than as the ordering mistake
# it is.
while IFS= read -r bin; do
  codesign --force --sign - --timestamp=none "$bin" >/dev/null 2>&1
done < <(find "$app/Contents/MacOS" -type f -perm +111 ! -name "$(basename "$app" .app)")
codesign --force --sign - --timestamp=none "$app" >/dev/null 2>&1

echo "==> verifying"
codesign --verify --deep --strict "$app" && echo "    signature valid"

# Confirm the pieces the app cannot run without are actually in there. Each of
# these is a silent runtime failure rather than a build failure: a missing
# helper only shows up when somebody installs an OpenFX plugin, and a missing
# catalogue only when the network is also unavailable.
#
# Two different places, because Tauri treats them differently and getting that
# wrong is exactly how the pictures went missing once:
#
#   Contents/Resources/  is where `bundle.resources` files land, on disk.
#   the binary itself    is where the FRONTEND lives — generate_context! embeds
#                        dist/ at compile time, so there is no dist directory in
#                        the bundle to look at. The images are addressed as
#                        ./thumbs/x.png from the UI and must be in dist.
for required in \
  "Contents/MacOS/burrow-helper" \
  "Contents/Resources/assets/catalog.json" \
  "Contents/Resources/assets/demos"
do
  [ -e "$app/$required" ] || { echo "MISSING: $required" >&2; exit 1; }
done

for required in dist/thumbs dist/video; do
  [ -d "$here/$required" ] || {
    echo "MISSING: $required — run scripts/sync-assets.sh" >&2; exit 1; }
done
# And prove the embed actually happened, rather than trusting that dist/ existed
# at the right moment: the compiled binary should carry the filenames.
grep -q "thumbs/tinsel.png" "$app/Contents/MacOS/burrow" 2>/dev/null || {
  echo "the frontend does not appear to carry the images — was dist/ built before cargo ran?" >&2
  exit 1
}
echo "    helper, catalogue, $(ls "$app/Contents/Resources/assets/demos" | wc -l | tr -d ' ') demos, \
$(ls "$here/dist/thumbs" | wc -l | tr -d ' ') thumbnails and \
$(ls "$here/dist/video" | wc -l | tr -d ' ') video stills all present"

echo
echo "$app"
du -sh "$app" | awk '{print "  " $1}'

if [ "$open_after" -eq 1 ]; then
  open "$app"
fi
