import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, humanSize, onFirmwareProgress } from '../api/backend'
import type { PluginView } from '../api/types'
import {
  FW_PHASE_LABEL,
  type Description,
  type DeviceDef,
  type EspRelease,
  type FwProgress,
  type Link,
  type OpenedFiles,
  type Package,
  type PlanView,
  type PortInfo,
  type Release,
  type Source,
  type Variant,
} from '../api/firmware'

/**
 * Device firmware: any ESP32 board over its serial port. The catalogue's
 * firmware for the fleet's hardware (CANary, nanODE, Cuckoo …), or a file of
 * your own: a release zip, a whole-flash image, or the parts of an ESP-IDF
 * build.
 *
 * The same packages and the same gate as the Stoatworks Flasher in a browser:
 * burrow-device is a port of the page's checks, message for message.
 *
 * ## Nothing happens until it is asked for
 *
 * Opening this tab fetches nothing and touches no board. Reading a board
 * restarts it (opening an ESP32's port resets it), so that is a button, never
 * a side effect of looking at the tab. A release is downloaded when it is
 * chosen, once: the cached copy is used while its SHA-256 still matches.
 *
 * ## A write says what it will do, then cannot be stopped
 *
 * Every write goes through a confirmation listing what lands where, and Rust
 * re-reads the board and runs the same gate again immediately before the
 * first byte. Once it starts there is no Cancel: stopping half way through a
 * partition is worse than finishing it, and an ESP32 recovers from a failed
 * write the same way it takes a good one — by being written again from
 * download mode.
 */
export function Firmware({ plugins, onOpen }: { plugins: PluginView[]; onOpen: (url: string) => void }) {
  const entries = plugins.filter(p => p.kind === 'firmware' && p.device)
  const [mode, setMode] = useState<'ours' | 'file'>('ours')
  const [progress, setProgress] = useState<Record<string, FwProgress>>({})
  const [busy, setBusy] = useState(false)
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

  useEffect(() => {
    let off: (() => void) | undefined
    onFirmwareProgress(p => setProgress(prev => ({ ...prev, [p.job]: p }))).then(u => (off = u))
    return () => off?.()
  }, [])

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

  /** Run one device job; clears its last progress first so a new one starts clean. */
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
    const paths = await api.pickFiles()
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
    <div className="firmware">
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
            <JobLine p={progress['describe']} />
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
            <JobLine p={progress['esp-write']} />
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
    </div>
  )
}

type Pick = { release: string; variant: string }

/**
 * Catalogue devices that are not ESP32 boards: shown, never offered. The live
 * catalogue carries the BirdDog PLAY's patcher kit as firmware, and its writer
 * is not in this build. firmware.rs refuses the same ids.
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

function JobLine({ p }: { p: FwProgress | undefined }) {
  // A finished or failed job says so in its own words beside it; a bare
  // "Done" or "Stopped" under that would only repeat it.
  if (!p || p.phase === 'done' || p.phase === 'failed') return null
  const frac = p.total ? Math.min(1, p.done / p.total) : null
  const label = FW_PHASE_LABEL[p.phase] + (p.total ? ` — ${humanSize(p.done)} of ${humanSize(p.total)}` : '')
  return (
    <div className="row-progress">
      <div className={`progress${frac === null ? ' indeterminate' : ''}`} aria-label={label}>
        <i style={frac === null ? undefined : { width: `${frac * 100}%` }} />
      </div>
      <div className="progress-text">
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
                  {other ? 'Not for an ESP32 board, and this Burrow writes only those.' : e.hook || e.summary}
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
