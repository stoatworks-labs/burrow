#!/usr/bin/env bash
#
# Gather everything Burrow ships inside itself:
#
#   src-tauri/assets/catalog.json   the catalogue as of this build
#   src-tauri/assets/demos/<slug>/  each plugin's browser demo
#   src-tauri/assets/thumbs/        one picture per plugin
#   src-tauri/bin/burrow-helper-*   the privileged helper, per target triple
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
thumbs="$assets/thumbs"

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
  if [ -d "$stage/demos" ] && ! diff -rq "$stage/demos" "$demos" >/dev/null 2>&1; then
    echo "drift: demos"; drift=1
  fi
  [ "$drift" -eq 0 ] && echo "assets are up to date"
  exit "$drift"
fi

mkdir -p "$assets"
cp "$stage/catalog.json" "$assets/catalog.json"
rm -rf "$thumbs"; cp -R "$stage/thumbs" "$thumbs"
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
du -sh "$assets" 2>/dev/null | awk '{print "total:     " $1}'
