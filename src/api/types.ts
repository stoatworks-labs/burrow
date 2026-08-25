/*
 * The TypeScript mirror of the Rust command surface.
 *
 * Hand-written rather than generated, because the surface is small and a
 * generator would be one more thing to keep running. The rule when changing a
 * `#[tauri::command]` signature is to change this file in the same commit —
 * `serde(rename_all = "camelCase")` on the Rust side is what makes the names
 * line up.
 */

export type FormatId =
  | 'ffgl'
  | 'openfx'
  | 'adobe'
  | 'fxplug'
  | 'vst3'
  | 'au'
  | 'app'
  | 'companion'
  | 'unknown'
export type PlatformId = 'macos' | 'windows'

/**
 * Which tab an entry sits under.
 *
 * `firmware` is representable and empty: the catalogue emits nothing with it
 * yet, and the tab says so. It is here rather than added later so that the day
 * it starts arriving, this build files it correctly instead of dropping it.
 */
export type CategoryId = 'video' | 'audio' | 'netinfra' | 'firmware' | 'unknown'

/** Which of the three headings a plugin sits under. */
export type Bucket = 'update-available' | 'up-to-date' | 'not-installed'

export type CatalogSource = 'network' | 'cache' | 'baked'

export interface CatalogInfo {
  source: CatalogSource
  generated: string
  fetchedAtEpoch: number | null
  entryCount: number
  /** Set when a fetch failed and something older is being shown instead. */
  error: string | null
  newerSchema: boolean
}

/** Mirrors `burrow_core::model::InstallState`, an internally tagged enum. */
export type InstallState =
  | { state: 'not-installed' }
  | { state: 'no-build' }
  | { state: 'up-to-date'; version: string; source: 'info-plist' | 'ledger' }
  | {
      state: 'update-available'
      installed: string
      latest: string
      source: 'info-plist' | 'ledger'
    }
  | { state: 'version-unknown'; entries: string[] }

export interface Slot {
  format: FormatId
  destinationId: string
  destinationLabel: string
  state: InstallState
  needsElevation: boolean
  /** Recorded entries that are no longer on disk — a half-finished uninstall. */
  missing: string[]
  /** Something of that name is there, but it is not ours. */
  foreign: boolean
  size: number | null
}

export interface Note {
  tag: string
  published: string
  url: string
  prerelease: boolean
  /**
   * `notes` — a person wrote this.
   * `commits` — nobody did; these are filtered commit subjects.
   * `maintenance` — the whole release was plumbing.
   * `initial` — a first release, nothing to compare against.
   */
  kind: 'notes' | 'commits' | 'maintenance' | 'initial'
  lines: string[]
  /** How many commits the noise filter removed. Makes the claim checkable. */
  filtered: number
}

export interface VersionEntry {
  tag: string
  published: string
  url: string
  prerelease: boolean
  builds: Partial<Record<FormatId, Partial<Record<PlatformId, { url: string; size: number | null }>>>>
}

export interface PluginView {
  slug: string
  name: string
  category: CategoryId
  /** `plugin`, `app` or `companion` — or something newer this build ignores. */
  kind: string
  /** The software tool this belongs to, for a Companion module. */
  parent: string | null
  hook: string
  summary: string
  blurb: string | null
  version: string | null
  published: string | null
  thumb: string | null
  /** The status id from the website's own data — `testing`, `proven`, … */
  status: string | null
  /** That status said out loud: "Field testing", not "testing". */
  statusLabel: string | null
  /** What it means, for the tooltip. */
  statusBlurb: string | null
  tags: string[]
  demo: string | null
  guide: string | null
  /** Bare YouTube video id, or null. Never a URL. */
  youtube: string | null
  /** A copy Burrow can stream itself. Null means offer YouTube instead. */
  videoUrl: string | null
  releaseUrl: string | null
  releasesUrl: string | null
  slots: Slot[]
  bucket: Bucket
  hasOverride: boolean
  wantedFormats: FormatId[]
  notes: Note[]
  /** Earlier releases this plugin can be rolled back to, newest first. */
  versions: VersionEntry[]
  /** Non-plugin files in the archive: docs, sample assets, a CLI helper. */
  extras: string[]
}

export interface Destination {
  id: string
  format: FormatId
  label: string
  path: string
  exists: boolean
  writable: boolean
  needsElevation: boolean
  custom: boolean
}

export interface DetectedHost {
  name: string
  loadsEffects: boolean
  note: string | null
}

export interface Environment {
  platform: PlatformId | null
  resolume: DetectedHost[]
  otherHosts: DetectedHost[]
  destinations: Destination[]
}

export interface Settings {
  schema: number
  defaultFormats: FormatId[]
  /**
   * Four states, deliberately:
   *   key absent      inherit the global default
   *   `null`          inherit, said explicitly
   *   `[]`            install nothing for this plugin
   *   `['ffgl']`      install exactly this
   */
  pluginFormats: Record<string, FormatId[] | null>
  destinations: Record<string, string>
  catalogUrl: string
  allowGithubFallback: boolean
  seen: Record<string, string>
  seenAt: string | null
  lastRefresh: { at: number; ok: boolean; source: string; error: string | null } | null
}

export type Action = 'install' | 'update' | 'uninstall'

export interface OpRequest {
  slug: string
  format: FormatId
  destinationId: string
  action: Action
  /** A specific release tag, when rolling back. Absent means "current". */
  version?: string | null
}

export interface PlannedUnit {
  slug: string
  name: string
  format: FormatId
  destinationId: string
  destination: string
  action: Action
  url: string | null
  size: number | null
  entries: string[]
  needsElevation: boolean
}

export interface BatchPlan {
  batch: string
  units: PlannedUnit[]
  downloadBytes: number
  needsElevation: boolean
  /** Shown verbatim in the confirmation, so it cannot differ from the work. */
  elevatedDestinations: string[]
  warnings: string[]
}

export interface UnitOutcome {
  slug: string
  format: FormatId
  destinationId: string
  ok: boolean
  /** The user dismissed the password prompt. Not a failure. */
  cancelled: boolean
  error: string | null
}

export interface BatchOutcome {
  batch: string
  units: UnitOutcome[]
  notes: string[]
}

export type Phase =
  | 'downloading'
  | 'extracting'
  | 'clearing-quarantine'
  | 'awaiting-authorization'
  | 'committing'

export interface Progress {
  batch: string
  index: number
  total: number
  slug: string
  format: FormatId
  phase: Phase
  bytesDone: number
  bytesTotal: number | null
  message: string | null
}

export const FORMAT_LABEL: Record<string, string> = {
  ffgl: 'FFGL',
  openfx: 'OpenFX',
  adobe: 'Adobe',
  fxplug: 'FxPlug',
  vst3: 'VST3',
  au: 'Audio Unit',
  app: 'Application',
  companion: 'Companion module',
}

export const FORMAT_HOSTS: Record<string, string> = {
  ffgl: 'Resolume Arena & Avenue',
  openfx: 'DaVinci Resolve, Vegas Pro, Nuke, Natron',
  adobe: 'After Effects & Premiere Pro',
  vst3: 'Ableton Live, REAPER, Cubase, Studio One, SuperRack',
  au: 'Logic Pro, GarageBand, Final Cut Pro',
  app: 'Runs on its own',
  companion: 'Bitfocus Companion',
}

/**
 * The tabs, in order. The label is a fallback: the catalogue sends its own,
 * so the website can rename a category without an app update.
 */
export const CATEGORY_LABEL: Record<CategoryId, string> = {
  video: 'Video',
  audio: 'Audio',
  netinfra: 'Networking & Infrastructure',
  firmware: 'Device firmware',
  unknown: 'Other',
}
