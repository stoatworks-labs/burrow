/*
 * Compose the update manifest Burrow's in-app updater reads.
 *
 *   node scripts/make-latest-json.mjs <tag> <artifact-dir> [notes-file] > latest.json
 *
 * The manifest names, for each platform, the artefact to download and the
 * minisign signature of *that exact file*. The signature is the security
 * boundary: Burrow verifies it against a public key compiled into the binary,
 * so a manifest served by anyone but us — or an artefact swapped after the
 * fact — is refused rather than installed. See src-tauri/src/update.rs.
 *
 * ⚠️ **A missing platform is a hard failure, not a smaller manifest.**
 * If the Windows job failed and this quietly emitted a manifest with only the
 * two macOS entries, every Windows copy of Burrow would ask and be told *the
 * platform `windows-x86_64` was not found* — an error about the release, shown
 * to a user who can do nothing about it, on every check until somebody
 * reported it. The whole release should fail here instead, where it is one
 * red job and no user sees anything.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [tag, dir, notesFile] = process.argv.slice(2)
if (!tag || !dir) {
  console.error('usage: make-latest-json.mjs <tag> <artifact-dir> [notes-file]')
  process.exit(2)
}

const version = tag.replace(/^v/, '')

/** Every file under the artifact directory, however deeply the download nested it. */
function walk(root) {
  const out = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const files = walk(dir)

/**
 * The three artefacts an update can be, and the platform key Tauri asks for.
 *
 * macOS is per-architecture because Burrow ships two separate builds rather
 * than one universal binary — the updater picks by the key, so a machine can
 * only ever be offered its own.
 */
const wanted = [
  { key: 'darwin-aarch64', match: /-macos-aarch64\.app\.tar\.gz$/ },
  { key: 'darwin-x86_64', match: /-macos-x86_64\.app\.tar\.gz$/ },
  { key: 'windows-x86_64', match: /-setup\.exe$/ },
]

/**
 * What GitHub called the asset, which is not always what we called the file.
 *
 * ⚠️ **Release assets are renamed on upload.** `Stoatworks Burrow_0.2.3_x64-setup.exe`
 * is published as `Stoatworks.Burrow_0.2.3_x64-setup.exe` — every space becomes
 * a dot. A manifest built from the local filename therefore names a URL that
 * 404s, and it does so for exactly one platform while the other two work.
 *
 * That is what shipped in v0.2.3: macOS updated fine and every Windows copy
 * would have failed the download. The published release is the authority on
 * what its own assets are called, so ask it rather than assume.
 *
 * `GH_ASSET_NAMES` is that list, newline-separated, passed in by the workflow —
 * so this stays a pure function of its inputs and can still be run by hand.
 * With no list the local name is used unchanged, which is right for a dry run
 * over artefacts that have not been published yet.
 */
const published = (process.env.GH_ASSET_NAMES || '')
  .split('\n')
  .map(x => x.trim())
  .filter(Boolean)

/** GitHub's substitution, applied to both sides so the comparison is fair. */
const ghNormalise = name => name.replace(/[^A-Za-z0-9._-]/g, '.')

function publishedName(local) {
  if (published.length === 0 || published.includes(local)) return local
  const hit = published.filter(n => ghNormalise(n) === ghNormalise(local))
  if (hit.length === 1) return hit[0]
  // Refuse rather than emit a URL that will 404 — invisible until somebody
  // presses the button, and then only on one platform.
  console.error(`cannot match local artefact ${local} to a published asset`)
  console.error('published assets:')
  for (const n of published) console.error(`  ${n}`)
  process.exit(1)
}

const platforms = {}
const missing = []

for (const { key, match } of wanted) {
  const file = files.find(f => match.test(f))
  if (!file) {
    missing.push(key)
    continue
  }
  const sig = files.find(f => f === `${file}.sig`)
  if (!sig) {
    missing.push(`${key} (no signature beside ${file})`)
    continue
  }
  platforms[key] = {
    signature: readFileSync(sig, 'utf8').trim(),
    // By tag, not by the /latest/ alias: a manifest that pointed at "whatever
    // is newest" would describe one release and hand over another the moment
    // the next one is cut.
    url: `https://github.com/stoatworks-labs/burrow/releases/download/${tag}/${encodeURIComponent(
      publishedName(file.split('/').pop()),
    )}`,
  }
}

if (missing.length > 0) {
  console.error(`no update artefact for: ${missing.join(', ')}`)
  console.error('files seen:')
  for (const f of files) console.error(`  ${f}`)
  process.exit(1)
}

/**
 * What the app shows before installing.
 *
 * The release body opens with a standing description of what Burrow is, which
 * is the wrong thing to read when deciding whether to accept an update — so
 * the generated "What's Changed" section is preferred where there is one, and
 * the whole body is the fallback.
 */
function notes() {
  if (!notesFile) return `Stoatworks Burrow ${version}`
  const body = readFileSync(notesFile, 'utf8')
  const changed = body.indexOf("## What's Changed")
  return (changed >= 0 ? body.slice(changed) : body).trim() || `Stoatworks Burrow ${version}`
}

console.log(
  JSON.stringify(
    { version, notes: notes(), pub_date: new Date().toISOString(), platforms },
    null,
    2,
  ),
)
