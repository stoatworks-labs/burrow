import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, humanSize, onFirmwareProgress } from '../api/backend'
import type { PluginView } from '../api/types'
import {
  FW_PHASE_LABEL,
  hex,
  type BuiltInfo,
  type Description,
  type DeviceDef,
  type EspRelease,
  type FlashOutcome,
  type FwProgress,
  type ImageSummary,
  type KitOffers,
  type Link,
  type OpenedFiles,
  type Package,
  type PlanView,
  type PlayUnit,
  type PortInfo,
  type Release,
  type Source,
  type Variant,
} from '../api/firmware'

/**
 * Device firmware: any ESP32 board over its serial port, a BirdDog PLAY over
 * Rockchip USB, and the PLAY's update packages.
 *
 * An ESP32 board takes three steps, Firmware, Board and Write: the catalogue's
 * firmware for the fleet's hardware (CANary, nanODE, Cuckoo …), or a file of
 * your own — a release zip, a whole-flash image, or the parts of an ESP-IDF
 * build. The same packages and the same gate as the Stoatworks Flasher in a
 * browser: burrow-device is a port of the page's checks, message for message.
 * The PLAY has a section of its own below them: building an update package
 * from the patcher kit, and restoring a unit from a factory image.
 *
 * ## Nothing happens until it is asked for
 *
 * Opening this tab fetches nothing and touches no device. Reading a board
 * restarts it (opening an ESP32's port resets it), and probing a PLAY claims
 * it, so each is a button, never a side effect of looking at the tab. A
 * release is downloaded when it is chosen, once: the cached copy is used while
 * its SHA-256 still matches. The patcher kit is downloaded when a package is
 * set up.
 *
 * ## A write says what it will do, then cannot be stopped
 *
 * Every write goes through a confirmation listing what lands where, and Rust
 * re-reads the unit and runs the same gate again immediately before the first
 * byte. Once it starts there is no Cancel: stopping half way through a
 * partition is worse than finishing it, and both kinds of device recover from
 * a failed write the same way they take a good one — by being written again,
 * an ESP32 from download mode, a PLAY from recovery mode.
 */
export function Firmware({ plugins, onOpen }: { plugins: PluginView[]; onOpen: (url: string) => void }) {
  const entries = plugins.filter(p => p.kind === 'firmware' && p.device)
  const kit = entries.find(e => e.device === 'birddog-play') ?? null

  const [progress, setProgress] = useState<Record<string, FwProgress>>({})
  const [busy, setBusy] = useState(false)
  const [built, setBuilt] = useState<BuiltInfo | null>(null)

  useEffect(() => {
    let off: (() => void) | undefined
    onFirmwareProgress(p => setProgress(prev => ({ ...prev, [p.job]: p }))).then(u => (off = u))
    return () => off?.()
  }, [])

  /**
   * Run one device job; clears its last progress first so a new one starts
   * clean. One flag for both halves, because Rust runs one device job at a
   * time whichever device it is.
   */
  async function job<T>(name: string, body: () => Promise<T>): Promise<T> {
    setProgress(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setBusy(true)
    try {
      return await body()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="firmware">
      <EspBoards entries={entries} progress={progress} busy={busy} job={job} onOpen={onOpen} />
      <PackageSection entry={kit} progress={progress} busy={busy} job={job} built={built} onBuilt={setBuilt} />
      <RecoverySection progress={progress} busy={busy} job={job} built={built} />

      <p className="fw-small">
        Not affiliated with, endorsed by, or supported by BirdDog. BirdDog is a trademark of its
        owner; Burrow ships none of their software, and the PLAY&rsquo;s factory image and loader
        only ever come from your own copy.
      </p>
    </div>
  )
}

type Job = <T>(name: string, body: () => Promise<T>) => Promise<T>

// ---------------------------------------------------------------------------
// ESP32 boards: 1 · Firmware, 2 · Board, 3 · Write
// ---------------------------------------------------------------------------

function EspBoards({
  entries,
  progress,
  busy,
  job,
  onOpen,
}: {
  entries: PluginView[]
  progress: Record<string, FwProgress>
  busy: boolean
  job: Job
  onOpen: (url: string) => void
}) {
  const [mode, setMode] = useState<'ours' | 'file'>('ours')
  const [error, setError] = useState<string | null>(null)

  // Our firmware
  const [slug, setSlug] = useState<string | null>(null)
  const [releases, setReleases] = useState<Record<string, EspRelease>>({})
  const [pick, setPick] = useState<Pick | null>(null)

  // A file of your own
  const [opened, setOpened] = useState<OpenedFiles | null>(null)
  const [filePick, setFilePick] = useState<Pick | null>(null)
  const [typed, setTyped] = useState<string[]>([])

  // The board
  const [all, setAll] = useState(false)
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  const [unit, setUnit] = useState<Description | null>(null)

  // The write
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [replace, setReplace] = useState(false)
  const [eraseAll, setEraseAll] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const current = slug ? releases[slug] : undefined
  const pkg: Package | null =
    mode === 'ours' ? current?.package ?? null : opened?.kind === 'package' ? opened.package : null
  /** The device whose instructions apply: the chosen one, or the one an opened zip is for. */
  const help: DeviceDef | null = pkg?.device ?? null

  const source: Source | null = useMemo(() => {
    if (mode === 'ours') return slug && pick && current ? { kind: 'catalog', slug, ...pick } : null
    if (opened?.kind === 'package') return filePick ? { kind: 'package', ...filePick } : null
    if (opened?.kind === 'loose') return { kind: 'files', typed }
    return null
  }, [mode, slug, pick, current, opened, filePick, typed])

  const sourceKey = JSON.stringify(source)
  useEffect(() => {
    if (!source) {
      setPlan(null)
      return
    }
    let stale = false
    api
      .espPlan(source)
      .then(p => !stale && setPlan(p))
      .catch(e => {
        if (stale) return
        setPlan(null)
        setError(said(e))
      })
    return () => {
      stale = true
    }
    // The plan depends on the source, compared by value, and on the board last
    // read, which Rust keeps and plans against.
  }, [sourceKey, unit])

  // A tick to replace one board's firmware is not a tick for the next board, or
  // for other firmware: it is cleared whenever what it answers changes.
  useEffect(() => setReplace(false), [plan?.replace, unit])

  async function chooseEntry(e: PluginView) {
    setSlug(e.slug)
    setError(null)
    setOutcome(null)
    if (releases[e.slug]) {
      setPick(defaultPick(releases[e.slug].package))
      return
    }
    setPick(null)
    try {
      const r = await job(`release:${e.slug}`, () => api.espRelease(e.slug))
      setReleases(prev => ({ ...prev, [e.slug]: r }))
      setPick(defaultPick(r.package))
    } catch (err) {
      setError(said(err))
    }
  }

  async function openFiles() {
    setError(null)
    setOutcome(null)
    const paths = await api.pickFiles('firmware')
    if (!paths?.length) return
    setOpened(null)
    setFilePick(null)
    setTyped([])
    try {
      const o = await job('open', () => api.espOpenFiles(paths))
      setOpened(o)
      if (o.kind === 'package') setFilePick(defaultPick(o.package))
      else setTyped(o.files.map(() => ''))
    } catch (err) {
      setError(said(err))
    }
  }

  async function look() {
    setError(null)
    try {
      setPorts(await api.espPorts(all))
    } catch (e) {
      setError(said(e))
    }
  }

  async function read(port: PortInfo) {
    setError(null)
    setOutcome(null)
    setUnit(null)
    try {
      const d = await job('describe', () => api.espDescribe(port.name, help?.baud ?? null, help?.tableOffset ?? null))
      setUnit(d)
      // A board already running one of our devices' firmware picks that device.
      const project = d.running?.app?.project
      if (mode === 'ours' && project) {
        const match = Object.values(releases).find(r => r.package.device.projects.includes(project))
        if (match && match.slug !== slug) {
          setSlug(match.slug)
          setPick(defaultPick(match.package))
        }
      }
    } catch (e) {
      setError(`Could not talk to the board: ${said(e)}. See “No port listed, or it will not connect?” above.`)
    }
  }

  async function forget() {
    await api.espForgetUnit()
    setUnit(null)
  }

  async function write() {
    if (!unit || !source || !plan) return
    setConfirm(false)
    setError(null)
    setOutcome(null)
    const after = plan.want.after
    const t0 = performance.now()
    try {
      await job('esp-write', () => api.espWrite({ port: unit.port, source, eraseAll, confirmReplace: replace }))
      const secs = ((performance.now() - t0) / 1000).toFixed(1)
      setOutcome({ ok: true, text: `Done in ${secs} s. The board has restarted into the new firmware.${after ? ' ' + after : ''}` })
    } catch (e) {
      const steps = (help?.bootMode ?? DEFAULT_BOOT).join(' ').replace(/\.?\s*$/, '')
      setOutcome({
        ok: false,
        text: `Writing stopped: ${said(e)}. The board is recoverable: ${steps}, then read it and write it again.`,
      })
    }
    // Rust forgets the board after a write, whatever happened: what was read
    // before is not what is on it now.
    setUnit(null)
  }

  // Rust runs the same gate again before the first byte; this only decides
  // whether the button is offered. A plan with problems has said why in red
  // above the button, so the hint beside it stays quiet rather than repeat it.
  const refused = !plan || Boolean(plan.error) || plan.problems.length > 0
  const why = !unit
    ? 'Read a board first.'
    : !plan
      ? 'Choose firmware.'
      : !refused && plan.replace && !replace
        ? 'Tick the box to replace the firmware it runs.'
        : ''
  const offered = Boolean(unit) && !refused && (!plan?.replace || replace)

  return (
    <>
      <section>
        <div className="section-head">
          <h2>1 · Firmware</h2>
        </div>
        <div className="row">
          <div className="body">
            <div className="fw-seg" role="tablist">
              <button role="tab" aria-selected={mode === 'ours'} onClick={() => setMode('ours')}>
                Our firmware
              </button>
              <button role="tab" aria-selected={mode === 'file'} onClick={() => setMode('file')}>
                A file of your own
              </button>
            </div>
            {mode === 'ours' ? (
              <Ours
                entries={entries}
                slug={slug}
                current={current}
                pick={pick}
                busy={busy}
                progress={progress}
                onChoose={chooseEntry}
                onPick={setPick}
                onOpen={onOpen}
              />
            ) : (
              <OwnFile
                opened={opened}
                pick={filePick}
                typed={typed}
                places={plan?.places ?? []}
                busy={busy}
                onOpenFiles={openFiles}
                onPick={setFilePick}
                onType={setTyped}
                onOpen={onOpen}
              />
            )}
            <Err text={error} />
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>2 · Board</h2>
          {ports && <span className="n">{ports.length}</span>}
        </div>
        <div className="row">
          <div className="body">
            <BoardHelp d={help} />
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={look}>
                Look for boards
              </button>
              <Tick checked={all} onChange={setAll}>
                show every serial port
              </Tick>
            </div>
            {ports && ports.length === 0 && (
              <div className="section-empty">
                No board on a serial port Burrow lists. Tick “show every serial port”, or put it in
                download mode and look again.
              </div>
            )}
            {ports?.map(p => (
              <div className="fw-unit" key={p.name}>
                <div className="fw-unit-head">
                  <code>{p.name}</code>
                  <span className="d">{portLabel(p)}</span>
                  <span className="spacer" />
                  {unit?.port === p.name && (
                    <button className="btn quiet" disabled={busy} onClick={forget}>
                      Forget it
                    </button>
                  )}
                  <button className="btn" disabled={busy} onClick={() => read(p)}>
                    {unit?.port === p.name ? 'Read it again' : 'Read it'}
                  </button>
                </div>
                {unit?.port === p.name && <Facts d={unit} plan={plan} />}
              </div>
            ))}
            <JobLine p={progress['describe']} quietWhenFailed />
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>3 · Write</h2>
        </div>
        <div className="row">
          <div className="body">
            <PlanTable plan={plan} />
            {plan?.error && <Err text={plan.error} />}
            {plan && !plan.error && plan.problems.length > 0 && (
              <Err text={`Will not write this: ${plan.problems.join('; ')}.`} />
            )}
            {plan && !plan.error && plan.problems.length === 0 && plan.notes.length > 0 && (
              <div className="fw-help">{plan.notes.join(' ')}</div>
            )}
            {plan?.replace && (
              <Tick checked={replace} onChange={setReplace}>
                {plan.replace}
              </Tick>
            )}
            <Tick checked={eraseAll} onChange={setEraseAll}>
              Erase the whole flash first <span className="d">— {eraseHint(help)}</span>
            </Tick>
            <div className="actions">
              <button className="btn primary" disabled={busy || !offered} onClick={() => setConfirm(true)}>
                Write it&hellip;
              </button>
              {!busy && why && <span className="fw-why">{why}</span>}
            </div>
            <JobLine p={progress['esp-write']} quietWhenFailed />
            {outcome && (outcome.ok ? <div className="fw-done">{outcome.text}</div> : <Err text={outcome.text} />)}
          </div>
        </div>
      </section>

      {confirm && unit && plan && (
        <WriteConfirm
          unit={unit}
          plan={plan}
          eraseAll={eraseAll}
          help={help}
          onCancel={() => setConfirm(false)}
          onConfirm={write}
        />
      )}
    </>
  )
}

type Pick = { release: string; variant: string }

/**
 * Catalogue devices that are not ESP32 boards: listed among the ESP32
 * firmware, never offered there, and pointed at their own section. The live
 * catalogue carries the BirdDog PLAY's patcher kit as firmware; the PLAY's
 * steps below read it. firmware.rs refuses the same ids on the ESP32 path.
 */
const NOT_ESP32 = ['birddog-play']

/** A command's refusal. Tauri rejects with the Rust error's text; anything else is an Error. */
function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function defaultPick(p: Package): Pick | null {
  const r = p.releases[0]
  if (!r) return null
  const v = r.variants.find(x => x.recommended) ?? r.variants[0]
  return v ? { release: r.id, variant: v.id } : null
}

const DEFAULT_CONNECT = [
  'Plug the board’s USB port into this computer.',
  'Press Look for boards, then Read it beside its port.',
]
const DEFAULT_BOOT = ['Hold BOOT (sometimes IO0).', 'Tap EN or RESET.', 'Release BOOT and read it again.']

function eraseHint(d: DeviceDef | null): string {
  return d?.keeps
    ? `off, it keeps ${d.keeps}. On, it comes back on factory defaults: for a board whose settings or update state you do not trust.`
    : 'off, only the parts being written are erased, so settings stored on the board survive. On, the whole flash is erased first, as from the factory.'
}

function portLabel(p: PortInfo): string {
  const id = p.vid !== null ? ` (${p.vid.toString(16).padStart(4, '0')}:${(p.pid ?? 0).toString(16).padStart(4, '0')})` : ''
  return `${p.usbSerialJtag ? 'Espressif USB' : p.product ?? 'serial port'}${id}`
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

function JobLine({ p, quietWhenFailed = false }: { p: FwProgress | undefined; quietWhenFailed?: boolean }) {
  // A finished job says so in its own words beside it; a bare "Done" under that
  // would only repeat it. The ESP32 steps say why a job stopped in their own
  // words too, so they pass quietWhenFailed; the PLAY's sections show it here.
  if (!p || p.phase === 'done' || (quietWhenFailed && p.phase === 'failed')) return null
  const frac = p.total ? Math.min(1, p.done / p.total) : null
  const counting = p.phase !== 'failed'
  const label =
    FW_PHASE_LABEL[p.phase] +
    (p.total && counting ? ` — ${humanSize(p.done)} of ${humanSize(p.total)}` : '')
  return (
    <div className="row-progress">
      {counting && (
        <div className={`progress${frac === null ? ' indeterminate' : ''}`} aria-label={label}>
          <i style={frac === null ? undefined : { width: `${frac * 100}%` }} />
        </div>
      )}
      <div className={`progress-text${p.phase === 'failed' ? ' bad' : ''}`}>
        {label}
        {p.message && <span className="progress-note"> — {p.message}</span>}
      </div>
    </div>
  )
}

function Confirm({
  title,
  action,
  ready,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  action: string
  ready: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="modal-backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal fw-confirm" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
          <span className="spacer" />
        </div>
        <div className="fw-confirm-body">{children}</div>
        <div className="modal-note fw-confirm-actions">
          <button className="btn primary" disabled={!ready} onClick={onConfirm}>
            {action}
          </button>
          <button className="btn quiet" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function Tick({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="opt">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="t">{children}</span>
    </label>
  )
}

function Err({ text }: { text: string | null }) {
  return text ? <div className="inline-err">{text}</div> : null
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p

function Links({ links, onOpen }: { links: Link[]; onOpen: (url: string) => void }) {
  if (!links.length) return null
  return (
    <div className="fw-links">
      Download:{' '}
      {links.map((l, i) => (
        <span key={l.url}>
          {i > 0 && ' · '}
          <a
            href={l.url}
            title={l.name}
            onClick={e => {
              e.preventDefault()
              onOpen(l.url)
            }}
          >
            {l.label}
          </a>
        </span>
      ))}
    </div>
  )
}

/** Release select (when there is more than one) and the variant cards. */
function ReleasePick({
  pkg,
  pick,
  name,
  onPick,
}: {
  pkg: Package
  pick: Pick | null
  name: string
  onPick: (p: Pick) => void
}) {
  const r: Release = pkg.releases.find(x => x.id === pick?.release) ?? pkg.releases[0]
  return (
    <div className="fw-choose">
      {pkg.releases.length > 1 && (
        <select
          className="fw-select"
          value={r.id}
          onChange={e => {
            const nr = pkg.releases.find(x => x.id === e.target.value)!
            const v = nr.variants.find(x => x.recommended) ?? nr.variants[0]
            onPick({ release: nr.id, variant: v.id })
          }}
        >
          {pkg.releases.map((x, i) => (
            <option key={x.id} value={x.id}>
              {x.id} · {x.date}
              {x.tag ? ` · ${x.tag}` : ''}
              {i === 0 ? ' (latest)' : ''}
            </option>
          ))}
        </select>
      )}
      <div className="fw-help">
        {r.id}
        {r.tag ? ` (${r.tag})` : ''}, built {r.date} from {pkg.device.name} {r.commit.slice(0, 7)} with ESP-IDF{' '}
        {r.variants[0]?.app.idfVersion}.{r.notes ? ` ${r.notes}` : ''}
      </div>
      {r.variants.map((v: Variant) => (
        <label className="opt" key={v.id}>
          <input
            type="radio"
            name={name}
            checked={pick?.release === r.id && pick?.variant === v.id}
            onChange={() => onPick({ release: r.id, variant: v.id })}
          />
          <span>
            <span className="t">
              {v.name} {v.recommended && <span className="chip">recommended</span>}
            </span>
            <span className="d"> — {v.summary}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 1 · firmware
// ---------------------------------------------------------------------------

function Ours({
  entries,
  slug,
  current,
  pick,
  busy,
  progress,
  onChoose,
  onPick,
  onOpen,
}: {
  entries: PluginView[]
  slug: string | null
  current: EspRelease | undefined
  pick: Pick | null
  busy: boolean
  progress: Record<string, FwProgress>
  onChoose: (e: PluginView) => void
  onPick: (p: Pick) => void
  onOpen: (url: string) => void
}) {
  if (entries.length === 0) {
    return (
      <div className="section-empty">
        The catalogue carries no firmware yet. A file of your own still works.
      </div>
    )
  }
  const d = current?.package.device
  return (
    <>
      <div className="fw-cards">
        {entries.map(e => {
          const other = NOT_ESP32.includes(e.device!)
          return (
            <label className={`fw-card${e.slug === slug ? ' on' : ''}${other ? ' off' : ''}`} key={e.slug}>
              <input
                type="radio"
                name="fw-device"
                checked={e.slug === slug}
                disabled={busy || other}
                onChange={() => onChoose(e)}
              />
              <span>
                <span className="t">
                  {e.name}
                  {e.version && <span className="ver">{e.version}</span>}
                </span>
                <span className="d">
                  {other ? (
                    <>
                      Not an ESP32 board: its update package and recovery flash are under{' '}
                      <a
                        href="#fw-play"
                        onClick={ev => {
                          ev.preventDefault()
                          document.getElementById('fw-play')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                      >
                        BirdDog PLAY
                      </a>{' '}
                      below.
                    </>
                  ) : (
                    e.hook || e.summary
                  )}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {slug && <JobLine p={progress[`release:${slug}`]} />}
      {d && current && (
        <>
          <div className="fw-help">
            {d.chip}, {d.flashSize / 1048576} MB flash.{' '}
            {d.page && (
              <a
                href={d.page}
                onClick={e => {
                  e.preventDefault()
                  onOpen(d.page!)
                }}
              >
                About the {d.name}
              </a>
            )}
          </div>
          {d.status && <div className="fw-status">{d.status}</div>}
          <ReleasePick pkg={current.package} pick={pick} name="fw-variant" onPick={onPick} />
          <Links links={current.links} onOpen={onOpen} />
        </>
      )}
    </>
  )
}

function OwnFile({
  opened,
  pick,
  typed,
  places,
  busy,
  onOpenFiles,
  onPick,
  onType,
  onOpen,
}: {
  opened: OpenedFiles | null
  pick: Pick | null
  typed: string[]
  places: { name: string; placed: string | null }[]
  busy: boolean
  onOpenFiles: () => void
  onPick: (p: Pick) => void
  onType: (t: string[]) => void
  onOpen: (url: string) => void
}) {
  return (
    <>
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={onOpenFiles}>
          Open a file&hellip;
        </button>
      </div>
      <div className="fw-help">
        Any of these: a <b>release zip</b> from the Stoatworks Flasher or GitHub; a <b>whole-flash
        image</b> (esptool <code>merge-bin</code>, or one of the <code>.bin</code> downloads), which goes
        at 0x0; or the <b>parts of an ESP-IDF build</b> — <code>bootloader.bin</code>,{' '}
        <code>partition-table.bin</code>, <code>ota_data_initial.bin</code> and the app, or just the app.
        Each file is identified by its contents, not its name, and put where its kind belongs.
        Anything else, a filesystem image say, waits for an offset you type: <code>0x3E0000</code>,{' '}
        <code>1M</code>, or a partition&rsquo;s name.
      </div>
      {opened?.kind === 'package' && (
        <>
          <div className="fw-help">
            A {opened.package.device.name} firmware package ({opened.package.device.chip}). Every part
            matched its checksum.
          </div>
          <ReleasePick pkg={opened.package} pick={pick} name="fw-file-variant" onPick={onPick} />
          <Links links={opened.links} onOpen={onOpen} />
        </>
      )}
      {opened?.kind === 'loose' && (
        <table className="fw-parts fw-loose">
          <thead>
            <tr>
              <th>File</th>
              <th>What it is</th>
              <th>Offset</th>
            </tr>
          </thead>
          <tbody>
            {opened.files.map((f, i) => (
              <tr key={f.name + i}>
                <td>{f.name}</td>
                <td>{f.what}</td>
                <td>
                  <input
                    className="fw-offset"
                    type="text"
                    spellCheck={false}
                    value={typed[i] ?? ''}
                    placeholder={places[i]?.placed ?? 'offset?'}
                    onChange={e => {
                      const next = [...typed]
                      next[i] = e.target.value
                      onType(next)
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 2 · board
// ---------------------------------------------------------------------------

function BoardHelp({ d }: { d: DeviceDef | null }) {
  const connect = d?.connect?.length ? d.connect : DEFAULT_CONNECT
  const boot = d?.bootMode?.length ? d.bootMode : DEFAULT_BOOT
  return (
    <>
      <ol className="fw-steps">
        {connect.map(s => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="fw-help">
        Reading a board restarts it: opening an ESP32&rsquo;s serial port resets it. Do it when it is
        not on a show.
      </div>
      <details className="fw-details">
        <summary>No port listed, or it will not connect?</summary>
        {d?.notes?.map(n => (
          <p key={n}>{n}</p>
        ))}
        <p>Put it in download mode, where the board waits until it is written or reset:</p>
        <ol className="fw-steps">
          {boot.map(s => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p>
          A board with a USB-to-serial chip (CP2102, CH340) may need that chip&rsquo;s driver on older
          systems. Tick “show every serial port” if it is on a chip Burrow does not list by default.
        </p>
      </details>
    </>
  )
}

function Facts({ d, plan }: { d: Description; plan: PlanView | null }) {
  const want = plan && !plan.error ? plan.want : null
  const chipOk = !want?.chip || want.chip === d.facts.chipName
  const flashOk = !want?.minFlash || (d.facts.flashBytes ?? 0) >= want.minFlash
  const r = d.running
  return (
    <>
      <dl className="fw-facts">
        <dt>Chip</dt>
        <dd className={chipOk ? '' : 'bad'}>{d.facts.chipName}</dd>
        <dt>MAC</dt>
        <dd>{d.mac ?? 'unknown'}</dd>
        <dt>Flash</dt>
        <dd className={flashOk ? '' : 'bad'}>
          {d.facts.flashLabel}
          {!flashOk && want && ` (${want.device ?? 'this firmware'} needs ${want.minFlash! / 1048576}MB)`}
        </dd>
        <dt>Partitions</dt>
        <dd>{d.table ? d.table.map(p => p.label).join(', ') : 'none (blank, or a layout Burrow cannot read)'}</dd>
        <dt>Boots</dt>
        <dd>
          {!r
            ? 'unknown'
            : r.app
              ? `${r.app.project} ${r.app.version} from ${r.partition}, built ${r.app.date}`
              : `${r.partition}, which holds no app image`}
        </dd>
      </dl>
      {d.problems.map(p => (
        <Err key={p} text={`Will not write to this board: ${p}.`} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// 3 · write
// ---------------------------------------------------------------------------

function PlanTable({ plan }: { plan: PlanView | null }) {
  if (!plan || plan.error || plan.rows.length === 0) {
    return plan ? null : <div className="section-empty">Choose firmware, and what would be written shows here.</div>
  }
  return (
    <table className="fw-parts">
      <thead>
        <tr>
          <th>Part</th>
          <th>Offset</th>
          <th>Size</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {plan.rows.map(r => (
          <tr key={r.name + r.offset}>
            <td>{r.name}</td>
            <td className="mono">{r.hex}</td>
            <td className="mono">{humanSize(r.size)}</td>
            <td>{r.what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WriteConfirm({
  unit,
  plan,
  eraseAll,
  help,
  onConfirm,
  onCancel,
}: {
  unit: Description
  plan: PlanView
  eraseAll: boolean
  help: DeviceDef | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const what = plan.want.device ?? 'your own build'
  const boot = (help?.bootMode ?? DEFAULT_BOOT).join(' ')
  return (
    <Confirm title={`Write ${what} to ${unit.port}`} action="Write it" ready onConfirm={onConfirm} onCancel={onCancel}>
      <table className="fw-parts">
        <tbody>
          {plan.rows.map(r => (
            <tr key={r.name + r.offset}>
              <td>{r.name}</td>
              <td>{r.hex}</td>
              <td>{humanSize(r.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {eraseAll
          ? 'The whole flash is erased first. It comes back on factory defaults.'
          : help?.keeps
            ? `Only those regions are written. It keeps ${help.keeps}.`
            : 'Only those regions are written, and whatever else is on its flash stays.'}
      </p>
      {plan.replace && <p>{plan.replace}</p>}
      {plan.want.after && <p>Afterwards: {plan.want.after}</p>}
      <p className="fw-help">
        Once it starts the write cannot be stopped. If it fails part way the board is not bricked:
        an ESP32&rsquo;s boot ROM cannot be overwritten. {boot} Then read it and write it again.
      </p>
    </Confirm>
  )
}

// ---------------------------------------------------------------------------
// PLAY packages
// ---------------------------------------------------------------------------

const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(\s+\S.*)?$/

function keyProblem(text: string): string | null {
  const line = text.trim()
  if (!line) return null
  if (line.includes('\n')) return 'That is more than one line — paste a single public key.'
  if (line.startsWith('-----BEGIN')) return 'That is a PRIVATE key. Paste the .pub file instead.'
  if (!KEY_RE.test(line)) return 'That does not look like an OpenSSH public key (ssh-ed25519 AAAA…).'
  return null
}

function PackageSection({
  entry,
  progress,
  busy,
  job,
  built,
  onBuilt,
}: {
  entry: PluginView | null
  progress: Record<string, FwProgress>
  busy: boolean
  job: Job
  built: BuiltInfo | null
  onBuilt: (b: BuiltInfo | null) => void
}) {
  const [offers, setOffers] = useState<KitOffers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [tag, setTag] = useState('')
  const [opt, setOpt] = useState({
    tailscale: true,
    kvm: false,
    play: false,
    cam: false,
    camUi: true,
    gateway: false,
    gatewayUi: true,
    omt: false,
    omtUi: true,
    output: false,
    outputUi: true,
    stagetimer: false,
    stagetimerUi: true,
    reboot: true,
  })
  const [modules, setModules] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [send, setSend] = useState<{ address: string; password: string } | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const set = (k: keyof typeof opt) => (v: boolean) => setOpt(o => ({ ...o, [k]: v }))

  async function setUp() {
    setError(null)
    try {
      setOffers(await job('play-kit', () => api.playKit()))
    } catch (e) {
      setError(String(e))
    }
  }

  async function build() {
    setError(null)
    setSaved(null)
    setSent(null)
    try {
      // A tick shows unticked when the kit lacks its option, but its state can
      // still be on; what is sent is what is shown.
      const o = offers
        ? {
            ...opt,
            kvm: opt.kvm && offers.kvm,
            play: opt.play && offers.play,
            cam: opt.cam && offers.cam,
            gateway: opt.gateway && offers.gateway,
            omt: opt.omt && offers.omt,
            output: opt.output && offers.output,
            stagetimer: opt.stagetimer && offers.stagetimer,
          }
        : opt
      onBuilt(await job('play-build', () => api.playBuild({ sshKey: key, tag, modules, ...o })))
    } catch (e) {
      setError(String(e))
    }
  }

  async function save() {
    if (!built) return
    const path = await api.pickSave(built.name)
    if (!path) return
    try {
      await api.playSave(built.id, path)
      setSaved(path)
    } catch (e) {
      setError(String(e))
    }
  }

  async function sendIt() {
    if (!built || !send) return
    const { address, password } = send
    setSend({ address, password: '' })
    setError(null)
    setSent(null)
    try {
      const back = await job('play-send', () => api.playSend(built.id, address, password))
      setSent(
        back
          ? `Sent. ${address} took it, installed it and is answering again.`
          : `Sent. ${address} took it and has not answered since — an install with Tailscale and a reboot can take a few minutes. Look at its front panel before trying again.`,
      )
      setSend(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const keyErr = keyProblem(key)
  const live = progress['play-build'] ?? progress['play-kit']

  return (
    <section id="fw-play">
      <div className="section-head">
        <h2>BirdDog PLAY</h2>
      </div>
      <div className="row">
        <div className="body">
          <div className="title">
            <h3>Update package</h3>
            {(offers?.version || entry?.version) && <span className="ver">kit {offers?.version ?? entry?.version}</span>}
          </div>
          <div className="hook">
            A package BirdUI&rsquo;s System Update installs: SSH, Tailscale, the NDI KVM endpoint, the
            USB media player, the UVC converter, the streaming gateway, the OMT receiver, HDMI formats
            and area of interest, and Stagetimer. It carries no vendor key and needs none.
          </div>
          {!entry && <div className="section-empty">The catalogue carries no patcher kit yet.</div>}
          {entry && !offers && (
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={setUp}>
                Set up a package
              </button>
              <span className="fw-help">Downloads the patcher kit from GitHub, about 30 MB.</span>
            </div>
          )}

          {offers && (
            <div className="fw-form">
              <div className="field">
                <label htmlFor="fw-key">SSH public key</label>
                <textarea
                  id="fw-key"
                  className={keyErr ? 'bad' : ''}
                  rows={2}
                  spellCheck={false}
                  placeholder="ssh-ed25519 AAAA… you@laptop"
                  value={key}
                  onChange={e => setKey(e.target.value)}
                />
                <div className="help">
                  {keyErr ?? 'Installed to /root/.ssh/authorized_keys. SSH on the PLAY listens on port 9031.'}
                </div>
              </div>
              <Tick checked={opt.tailscale} onChange={set('tailscale')}>
                Tailscale{' '}
                <span className="d">
                  — fetched from pkgs.tailscale.com and checked against the SHA-256 Tailscale publishes.
                  {offers.tailscaleUi ? ' Sign in afterwards from the Tailscale panel in BirdUI.' : ' Signing in will need SSH.'}
                </span>
              </Tick>
              <Tick checked={opt.kvm && offers.kvm} onChange={set('kvm')}>
                NDI KVM endpoint {!offers.kvm && <span className="d">— not in this kit</span>}
              </Tick>
              <Tick checked={opt.play && offers.play} onChange={set('play')}>
                USB media player{' '}
                <span className="d">
                  — video, stills{offers.playPdf ? ' and PDFs' : ''} from a stick
                  {offers.playExfat ? ', exFAT included' : ''}. Beta.
                </span>
              </Tick>
              <Tick checked={opt.cam && offers.cam} onChange={set('cam')}>
                UVC converter <span className="d">— a USB camera out as NDI, SRT or HDMI</span>
              </Tick>
              {opt.cam && (
                <div className="fw-indent">
                  <Tick checked={opt.camUi} onChange={set('camUi')}>
                    with a tab in BirdUI
                  </Tick>
                </div>
              )}
              <Tick checked={opt.gateway && offers.gateway} onChange={set('gateway')}>
                Streaming gateway{' '}
                <span className="d">
                  — MediaMTX {offers.mediamtxVersion}, from GitHub. Not yet run on a PLAY, and its ports are
                  open without credentials.
                </span>
              </Tick>
              {opt.gateway && (
                <div className="fw-indent">
                  <Tick checked={opt.gatewayUi} onChange={set('gatewayUi')}>
                    with a tab in BirdUI
                  </Tick>
                </div>
              )}
              <Tick checked={opt.omt && offers.omt} onChange={set('omt')}>
                OMT receiver{' '}
                <span className="d">
                  {offers.omt
                    ? '— an Open Media Transport source on the HDMI output, with its sound. Not yet run on a PLAY.'
                    : '— not in this kit'}
                </span>
              </Tick>
              {opt.omt && offers.omt && (
                <div className="fw-indent">
                  <Tick checked={opt.omtUi} onChange={set('omtUi')}>
                    with a tab in BirdUI
                  </Tick>
                </div>
              )}
              <Tick checked={opt.output && offers.output} onChange={set('output')}>
                HDMI formats and area of interest{' '}
                <span className="d">
                  {offers.output
                    ? '— the HDMI format you choose, and part of the picture anywhere on the screen. The PLAY’s decoder restarts so its shim loads. Not yet run on a PLAY.'
                    : '— not in this kit'}
                </span>
              </Tick>
              {opt.output && offers.output && (
                <div className="fw-indent">
                  <Tick checked={opt.outputUi} onChange={set('outputUi')}>
                    with a tab in BirdUI
                  </Tick>
                </div>
              )}
              <Tick checked={opt.stagetimer && offers.stagetimer} onChange={set('stagetimer')}>
                Stagetimer{' '}
                <span className="d">
                  {offers.stagetimer
                    ? '— a stagetimer.io room on the HDMI output. Not yet run on a PLAY.'
                    : '— not in this kit'}
                </span>
              </Tick>
              {opt.stagetimer && offers.stagetimer && (
                <div className="fw-indent">
                  <Tick checked={opt.stagetimerUi} onChange={set('stagetimerUi')}>
                    with a tab in BirdUI, where the room is entered
                  </Tick>
                </div>
              )}
              <Tick checked={opt.reboot} onChange={set('reboot')}>
                Restart the PLAY when it has installed
              </Tick>
              <div className="field fw-row">
                <label htmlFor="fw-tag">Build tag</label>
                <input id="fw-tag" value={tag} placeholder="burrow" onChange={e => setTag(e.target.value)} />
              </div>
              <div className="field">
                <span className="lab">Your own modules</span>
                {modules.map(m => (
                  <div className="fw-file" key={m}>
                    <code>{fileName(m)}</code>
                    <button className="btn quiet" onClick={() => setModules(ms => ms.filter(x => x !== m))}>
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  className="btn quiet"
                  onClick={async () => {
                    const f = await api.pickFiles('module')
                    if (f) setModules(ms => [...ms, ...f.filter(x => !ms.includes(x))])
                  }}
                >
                  Add a module&hellip;
                </button>
                <div className="help">
                  A .tar.gz with module.conf and install at its root. Its install runs as root on the PLAY.
                </div>
              </div>
              <div className="actions">
                <button className="btn primary" disabled={busy || !key.trim() || Boolean(keyErr)} onClick={build}>
                  Build the package
                </button>
              </div>
              <div className="fw-help">
                Installing this will not do your warranty any favours. Treat the first install as an
                experiment on a unit you can afford to have offline. The PLAY&rsquo;s own API on port 8080
                has no authentication, so keep it on a network you trust.
              </div>
            </div>
          )}

          <JobLine p={live} />
          <Err text={error} />

          {built && (
            <div className="fw-built">
              <div>
                <strong>{built.name}</strong> <span className="d">{humanSize(built.size)}</span>
              </div>
              <div className="fw-sha">SHA-256 {built.sha256}</div>
              {built.log.length > 0 && (
                <ul className="fw-log">
                  {built.log.map(l => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
              <div className="actions">
                <button className="btn" disabled={busy} onClick={save}>
                  Save&hellip;
                </button>
                <button className="btn" disabled={busy} onClick={() => setSend({ address: '', password: '' })}>
                  Send to a PLAY&hellip;
                </button>
              </div>
              {saved && (
                <div className="fw-done">
                  Saved to <code>{saved}</code>. Upload it from BirdUI&rsquo;s System page, under System
                  Update.
                </div>
              )}
              {send && (
                <div className="fw-send">
                  <input
                    aria-label="PLAY address"
                    placeholder="the PLAY's address, like 192.168.1.40"
                    value={send.address}
                    onChange={e => setSend({ ...send, address: e.target.value })}
                  />
                  <input
                    aria-label="BirdUI password"
                    type="password"
                    placeholder="BirdUI password"
                    value={send.password}
                    onChange={e => setSend({ ...send, password: e.target.value })}
                  />
                  <button className="btn primary" disabled={busy || !send.address.trim()} onClick={sendIt}>
                    Send
                  </button>
                  <button className="btn quiet" onClick={() => setSend(null)}>
                    Cancel
                  </button>
                  <div className="fw-help">
                    Burrow logs in to BirdUI with that password, uploads the package through its System
                    Update form, then asks the unit&rsquo;s front page whether it is back, for up to ten
                    minutes. Plain HTTP, which is all BirdUI speaks. The password is used for this send
                    and kept nowhere.
                  </div>
                </div>
              )}
              <JobLine p={progress['play-send']} />
              {sent && <div className="fw-done">{sent}</div>}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// PLAY recovery
// ---------------------------------------------------------------------------

function RecoverySection({
  progress,
  busy,
  job,
  built,
}: {
  progress: Record<string, FwProgress>
  busy: boolean
  job: Job
  built: BuiltInfo | null
}) {
  const [image, setImage] = useState<ImageSummary | null>(null)
  const [inject, setInject] = useState<'none' | 'built' | 'file'>('none')
  const [injectFile, setInjectFile] = useState<string | null>(null)
  const [units, setUnits] = useState<PlayUnit[] | null>(null)
  const [verify, setVerify] = useState(true)
  const [confirm, setConfirm] = useState<PlayUnit | null>(null)
  const [parts, setParts] = useState<PlayUnit | null>(null)
  const [outcome, setOutcome] = useState<FlashOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (inject === 'built' && !built) setInject('none')
  }, [built, inject])

  async function chooseImage() {
    const f = await api.pickFiles('image')
    if (!f?.[0]) return
    setError(null)
    try {
      setImage(await api.playInspectImage(f[0]))
    } catch (e) {
      setError(String(e))
    }
  }

  async function look() {
    setError(null)
    try {
      setUnits(await job('play-devices', () => api.playDevices()))
    } catch (e) {
      setError(String(e))
    }
  }

  async function flash(u: PlayUnit) {
    setConfirm(null)
    setError(null)
    setOutcome(null)
    try {
      setOutcome(
        await job('play-flash', () =>
          api.playFlash({
            key: u.key,
            image: image!.path,
            injectBuilt: inject === 'built' ? built?.id ?? null : null,
            injectFile: inject === 'file' ? injectFile : null,
            verify,
          }),
        ),
      )
      setUnits(null)
    } catch (e) {
      setError(`${e}. The unit is in an incomplete state: leave it in recovery mode and write it again — that is what recovers it.`)
    }
  }

  const written = image?.partitions.filter(p => p.flashed) ?? []
  const pkgSize = inject === 'built' ? built?.size ?? null : null

  return (
    <section>
      <div className="row">
        <div className="body">
          <div className="title">
            <h3>Recovery flash</h3>
          </div>
          <div className="hook">
            Restore a PLAY from a factory image over USB, and optionally have a package installed on
            its first boot. The image is your own copy of BirdDog&rsquo;s; Burrow neither ships nor
            downloads one.
          </div>
          <ol className="fw-steps">
            <li>Power the PLAY off.</li>
            <li>Push a paperclip into the 3.5 mm headphone socket — the recovery button is inside it — and hold it.</li>
            <li>Apply power, still holding, and connect its USB-C port to this computer.</li>
            <li>Release, then look for it below.</li>
          </ol>

          <div className="actions">
            <button className="btn" disabled={busy} onClick={chooseImage}>
              {image ? 'Choose another image…' : 'Choose a factory image…'}
            </button>
            <button className="btn" disabled={busy} onClick={look}>
              Look for a PLAY
            </button>
            <Tick checked={verify} onChange={setVerify}>
              read back what can be read
            </Tick>
          </div>

          {image && (
            <div className="fw-image">
              <div>
                <code>{fileName(image.path)}</code>{' '}
                <span className="d">
                  {image.model || 'unnamed'} · built {image.built} · {humanSize(image.size)} · {written.length} partitions
                </span>
              </div>
              <div className="fw-choose">
                <label className="opt">
                  <input type="radio" name="inject" checked={inject === 'none'} onChange={() => setInject('none')} />
                  <span className="t">Factory image only</span>
                </label>
                <label className="opt">
                  <input
                    type="radio"
                    name="inject"
                    disabled={!built}
                    checked={inject === 'built'}
                    onChange={() => setInject('built')}
                  />
                  <span className="t">
                    With the package built above {built ? <span className="d">— {built.name}</span> : <span className="d">— build one first</span>}
                  </span>
                </label>
                <label className="opt">
                  <input
                    type="radio"
                    name="inject"
                    checked={inject === 'file'}
                    onChange={async () => {
                      const f = await api.pickFiles('package')
                      if (f?.[0]) {
                        setInjectFile(f[0])
                        setInject('file')
                      }
                    }}
                  />
                  <span className="t">
                    With a .fw file {injectFile && inject === 'file' && <span className="d">— {fileName(injectFile)}</span>}
                  </span>
                </label>
                {image.packageRoom !== null && (
                  <div className="fw-help">
                    A package goes in the unused end of the rootfs partition, which holds up to{' '}
                    {humanSize(image.packageRoom)}.
                    {pkgSize !== null && pkgSize > image.packageRoom && ' The package built above is too big for it.'}
                  </div>
                )}
              </div>
            </div>
          )}

          <Err text={error} />
          {units && units.length === 0 && (
            <div className="section-empty">
              No PLAY in recovery mode. Go through the steps above again; the button has to be held
              while USB is connected.
            </div>
          )}
          {units?.map(u => (
            <div className="fw-unit" key={u.key}>
              <div className="fw-unit-head">
                <span className={`chip ${u.mode === 'loader' ? 'ok' : ''}`}>{u.mode === 'loader' ? 'loader mode' : 'maskrom'}</span>
                <span className="d">
                  {u.sectors ? `${humanSize(u.sectors * 512)} eMMC` : 'Rockchip RK3328'}
                  {u.partitions && ` · ${u.partitions.length} partitions`}
                </span>
                <span className="spacer" />
                <button className="btn primary" disabled={busy || !image} onClick={() => setConfirm(u)}>
                  Erase and write&hellip;
                </button>
                <button className="btn quiet" disabled={busy || u.mode !== 'loader' || !u.partitions} onClick={() => setParts(u)}>
                  Write partitions&hellip;
                </button>
              </div>
              {u.driver && u.driver.toLowerCase() !== 'winusb' && (
                <Err
                  text={`Windows has the ${u.driver} driver on this unit, and Burrow needs WinUSB. Zadig (zadig.akeo.ie) switches it: pick the Rockchip device, choose WinUSB, Replace Driver. Windows on ARM cannot do this at all.`}
                />
              )}
              {u.mode === 'maskrom' && (
                <div className="fw-help">
                  In maskrom the loader comes out of your factory image and is started first. Partition
                  writes need a factory image restored before them.
                </div>
              )}
              {!image && <div className="fw-help">Choose a factory image to restore it.</div>}
            </div>
          ))}

          <JobLine p={progress['play-flash'] ?? progress['play-partitions']} />
          {outcome && (
            <div className="fw-done">
              Written. The unit is restarting.
              {outcome.injected &&
                ' First boot installs the package and restarts again; give it a few minutes before expecting video.'}
              {outcome.unverified.length > 0 && (
                <div className="fw-help">
                  Not read back, because this unit returns fill above sector 0x10000 whatever is there:{' '}
                  {outcome.unverified.join(', ')}. That is the device, not the write.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirm && image && (
        <FlashConfirm
          unit={confirm}
          image={image}
          injecting={inject !== 'none'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => flash(confirm)}
        />
      )}
      {parts && (
        <PartitionsConfirm
          unit={parts}
          verify={verify}
          busy={busy}
          job={job}
          onClose={() => setParts(null)}
          onDone={o => {
            setParts(null)
            setOutcome(o)
          }}
        />
      )}
    </section>
  )
}

function FlashConfirm({
  unit,
  image,
  injecting,
  onConfirm,
  onCancel,
}: {
  unit: PlayUnit
  image: ImageSummary
  injecting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [sure, setSure] = useState(false)
  const rows = image.partitions.filter(p => p.flashed)
  return (
    <Confirm title={`Restore this PLAY from ${fileName(image.path)}`} action="Erase and write" ready={sure} onConfirm={onConfirm} onCancel={onCancel}>
      <p>
        <strong>This erases the unit completely</strong> — its serial, its hostname and everything under
        /userdata — and writes:
      </p>
      <table className="fw-parts">
        <tbody>
          <tr>
            <td>a new partition table</td>
            <td>from the image&rsquo;s parameter.txt</td>
            <td />
          </tr>
          {rows.map(p => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>sector {hex(p.flashAddr)}</td>
              <td>{humanSize(p.size)}</td>
            </tr>
          ))}
          {injecting && (
            <tr>
              <td>the package</td>
              <td>the unused end of rootfs</td>
              <td>installed on first boot</td>
            </tr>
          )}
        </tbody>
      </table>
      {unit.mode === 'maskrom' && <p>The unit is in maskrom, so the image&rsquo;s own loader is started first.</p>}
      <Tick checked={sure} onChange={setSure}>
        I understand this PLAY is wiped
      </Tick>
      <p className="fw-help">
        Once it starts the write cannot be stopped. If it fails part way, leave the unit in recovery
        mode and write it again: that is what recovers it.
      </p>
    </Confirm>
  )
}

const PROTECTED = ['uboot', 'trust', 'recovery']

function PartitionsConfirm({
  unit,
  verify,
  busy,
  job,
  onClose,
  onDone,
}: {
  unit: PlayUnit
  verify: boolean
  busy: boolean
  job: Job
  onClose: () => void
  onDone: (o: FlashOutcome) => void
}) {
  const [files, setFiles] = useState<{ partition: string; path: string }[]>([])
  const [allowProtected, setAllowProtected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = useMemo(() => unit.partitions?.map(p => p.name) ?? [], [unit])
  const touchesProtected = files.some(f => PROTECTED.includes(f.partition))

  async function add() {
    const f = await api.pickFiles('partition')
    if (!f?.[0]) return
    const lower = fileName(f[0]).toLowerCase()
    const guess = [...names].sort((a, b) => b.length - a.length).find(n => lower.includes(n)) ?? names[0] ?? ''
    setFiles(fs => [...fs, { partition: guess, path: f[0] }])
  }

  async function write() {
    setError(null)
    try {
      onDone(await job('play-partitions', () => api.playWritePartitions({ key: unit.key, files, allowProtected, verify })))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Confirm
      title="Write partitions to this PLAY"
      action="Write them"
      ready={!busy && files.length > 0 && (!touchesProtected || allowProtected)}
      onConfirm={write}
      onCancel={onClose}
    >
      <p>
        Each file goes into the partition you choose, found by name in the unit&rsquo;s own partition
        table. Everything else is left as it is.
      </p>
      {files.map((f, i) => (
        <div className="fw-file" key={f.path}>
          <code>{fileName(f.path)}</code>
          <span>&rarr;</span>
          <select
            value={f.partition}
            onChange={e => setFiles(fs => fs.map((x, j) => (j === i ? { ...x, partition: e.target.value } : x)))}
          >
            {names.map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button className="btn quiet" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button className="btn quiet" onClick={add}>
        Add a file&hellip;
      </button>
      {touchesProtected && (
        <>
          <Err text="uboot, trust and recovery are how this unit is recovered. Writing one can leave no way back." />
          <Tick checked={allowProtected} onChange={setAllowProtected}>
            Write it anyway
          </Tick>
        </>
      )}
      <Err text={error} />
    </Confirm>
  )
}
