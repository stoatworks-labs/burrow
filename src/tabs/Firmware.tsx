import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, humanSize, onFirmwareProgress } from '../api/backend'
import type { PluginView } from '../api/types'
import {
  FW_PHASE_LABEL,
  hex,
  type BuiltInfo,
  type CanaryRelease,
  type Description,
  type FlashOutcome,
  type FwProgress,
  type ImageSummary,
  type KitOffers,
  type PlayUnit,
  type PortInfo,
} from '../api/firmware'

/**
 * Device firmware: a CANary over its own USB port, a BirdDog PLAY over
 * Rockchip USB, and the PLAY's update packages.
 *
 * ## Nothing happens until it is asked for
 *
 * Opening this tab fetches nothing and touches no device. Looking at a CANary
 * reboots it (opening its USB port resets the S3), and probing a PLAY claims it,
 * so each is a button, never a side effect of looking at the tab. Firmware and
 * the patcher kit are downloaded when a step needs them.
 *
 * ## A write says what it will do, then cannot be stopped
 *
 * Every write goes through a confirmation listing what lands where, and Rust
 * re-reads the unit and runs the same gate again immediately before the first
 * byte. Once it starts there is no Cancel: stopping half way through a
 * partition is worse than finishing it, and both devices recover from a failed
 * write the same way they recover from a good one — by being written again.
 */
export function Firmware({ plugins, onOpen }: { plugins: PluginView[]; onOpen: (url: string) => void }) {
  const entries = plugins.filter(p => p.tab === 'firmware' || p.kind === 'firmware')
  const canary = entries.find(e => e.device === 'canary') ?? null
  const kit = entries.find(e => e.device === 'birddog-play') ?? null
  const unknown = entries.filter(e => e.device !== 'canary' && e.device !== 'birddog-play')

  const [progress, setProgress] = useState<Record<string, FwProgress>>({})
  const [busy, setBusy] = useState(false)
  const [built, setBuilt] = useState<BuiltInfo | null>(null)

  useEffect(() => {
    let off: (() => void) | undefined
    onFirmwareProgress(p => setProgress(prev => ({ ...prev, [p.job]: p }))).then(u => (off = u))
    return () => off?.()
  }, [])

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

  return (
    <div className="firmware">
      <CanarySection entry={canary} progress={progress} busy={busy} job={job} onOpen={onOpen} />
      <PackageSection entry={kit} progress={progress} busy={busy} job={job} built={built} onBuilt={setBuilt} />
      <RecoverySection progress={progress} busy={busy} job={job} built={built} />

      {unknown.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Other devices</h2>
            <span className="n">{unknown.length}</span>
          </div>
          {unknown.map(e => (
            <div className="row" key={e.slug}>
              <div className="body">
                <div className="title">
                  <h3>{e.name}</h3>
                  {e.version && <span className="ver">{e.version}</span>}
                </div>
                <div className="hook">{e.hook || e.summary}</div>
                <div className="section-empty">
                  This Burrow does not know how to write to this device. A newer one will.
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

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
// shared pieces
// ---------------------------------------------------------------------------

function JobLine({ p }: { p: FwProgress | undefined }) {
  // A finished job says so in its own words beside it; a bare "Done" under that
  // would only repeat it.
  if (!p || p.phase === 'done') return null
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

// ---------------------------------------------------------------------------
// CANary
// ---------------------------------------------------------------------------

function CanarySection({
  entry,
  progress,
  busy,
  job,
  onOpen,
}: {
  entry: PluginView | null
  progress: Record<string, FwProgress>
  busy: boolean
  job: Job
  onOpen: (url: string) => void
}) {
  const [all, setAll] = useState(false)
  const [ports, setPorts] = useState<PortInfo[] | null>(null)
  const [release, setRelease] = useState<CanaryRelease | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function look() {
    setError(null)
    try {
      setPorts(await api.canaryPorts(all))
    } catch (e) {
      setError(String(e))
    }
  }

  async function loadRelease(): Promise<CanaryRelease | null> {
    if (release) return release
    try {
      const r = await job('canary-release', () => api.canaryRelease())
      setRelease(r)
      return r
    } catch (e) {
      setError(String(e))
      return null
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>CANary</h2>
        {ports && <span className="n">{ports.length}</span>}
      </div>
      <div className="row">
        <div className="body">
          <div className="title">
            <h3>CANary firmware</h3>
            {entry?.version && <span className="ver">{entry.version}</span>}
            {release && <span className="chip">{release.id}</span>}
          </div>
          <div className="hook">
            {entry?.hook ||
              'The open IP-to-CAN converter for the d&b amplifier ecosystem, written over its own USB-C port.'}
          </div>
          {!entry && (
            <div className="section-empty">
              The catalogue carries no CANary firmware yet, so only your own build can be written.
            </div>
          )}
          <div className="fw-help">
            Plug the unit in by its USB-C port. Looking at it restarts it: opening that port resets
            the ESP32-S3, so do this when it is not on a show.
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={look}>
              Look for a unit
            </button>
            <Tick checked={all} onChange={setAll}>
              show every serial port
            </Tick>
            {entry?.releaseUrl && (
              <button className="btn quiet" onClick={() => onOpen(entry.releaseUrl!)}>
                Release notes
              </button>
            )}
          </div>
          <Err text={error} />
          {ports && ports.length === 0 && (
            <div className="section-empty">
              No CANary on USB. A unit running the USB network firmware stops being a serial port 8
              seconds after it starts: plug it in and look within those 8 seconds, or hold BOOT, tap
              EN, release BOOT, and look again.
            </div>
          )}
          {ports?.map(p => (
            <CanaryUnit
              key={p.name}
              port={p}
              entry={entry}
              release={release}
              loadRelease={loadRelease}
              busy={busy}
              job={job}
            />
          ))}
          <JobLine p={progress['canary-release']} />
          <JobLine p={progress['canary-write']} />
        </div>
      </div>
    </section>
  )
}

function CanaryUnit({
  port,
  entry,
  release,
  loadRelease,
  busy,
  job,
}: {
  port: PortInfo
  entry: PluginView | null
  release: CanaryRelease | null
  loadRelease: () => Promise<CanaryRelease | null>
  busy: boolean
  job: Job
}) {
  const [d, setD] = useState<Description | null>(null)
  const [variant, setVariant] = useState<string | null>(null)
  const [keep, setKeep] = useState(true)
  const [confirm, setConfirm] = useState<'release' | 'own' | null>(null)
  const [own, setOwn] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function read() {
    setError(null)
    setDone(null)
    try {
      setD(await job('canary-describe', () => api.canaryDescribe(port.name)))
      if (entry) {
        const r = await loadRelease()
        if (r && !variant) setVariant((r.variants.find(v => v.recommended) ?? r.variants[0])?.id ?? null)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function chooseOwn() {
    const files = await api.pickFiles('canary-build')
    if (files?.length) {
      setOwn(files)
      setConfirm('own')
    }
  }

  async function write(req: { variant: string | null; ownFiles: string[]; allowForeign: boolean }) {
    setConfirm(null)
    setError(null)
    setDone(null)
    try {
      await job('canary-write', () => api.canaryWrite({ port: port.name, eraseAll: !keep, ...req }))
      const v = release?.variants.find(x => x.id === req.variant)
      setDone(
        v?.id === 'usb-network'
          ? 'Written and restarted. In 8 seconds its USB-C port becomes a network adapter; the settings page is at http://192.168.7.1/.'
          : 'Written and restarted into the new firmware.',
      )
      setD(null)
    } catch (e) {
      setError(`${e}. The unit is recoverable: hold BOOT, tap EN, look again and write it again.`)
    }
  }

  const running = d?.running?.app
  const ours = running && ['canary', 'dbcanary'].includes(running.project)
  const chosen = release?.variants.find(v => v.id === variant) ?? null
  const current = chosen && running && running.version === chosen.app.version

  return (
    <div className="fw-unit">
      <div className="fw-unit-head">
        <code>{port.name}</code>
        <span className="d">{port.usbSerialJtag ? 'ESP32-S3 USB' : port.product ?? 'serial port'}</span>
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={read}>
          {d ? 'Read it again' : 'Read it'}
        </button>
      </div>

      {d && (
        <dl className="fw-facts">
          <dt>Chip</dt>
          <dd className={d.facts.chip === 'ESP32-S3' ? '' : 'bad'}>{d.facts.chip}</dd>
          <dt>MAC</dt>
          <dd>{d.mac ?? 'unknown'}</dd>
          <dt>Flash</dt>
          <dd>{d.flashLabel}</dd>
          <dt>Boots</dt>
          <dd>
            {running
              ? `${running.project} ${running.version}, built ${running.date}, from ota_${d.running!.slot}`
              : d.running
                ? `ota_${d.running.slot}, which holds no app image`
                : 'nothing Burrow can read — a blank board looks like this'}
            {current && <span className="chip ok">current</span>}
          </dd>
        </dl>
      )}
      {d?.problems.map(p => <Err key={p} text={`Will not write to this unit: ${p}.`} />)}

      {d && d.problems.length === 0 && (
        <div className="fw-choose">
          {release ? (
            release.variants.map(v => (
              <label className="opt" key={v.id}>
                <input type="radio" name={`variant-${port.name}`} checked={variant === v.id} onChange={() => setVariant(v.id)} />
                <span>
                  <span className="t">
                    {v.name} {v.recommended && <span className="chip">recommended</span>}
                  </span>
                  <span className="d"> — {v.summary}</span>
                </span>
              </label>
            ))
          ) : (
            entry && <div className="section-empty">Fetching the release&hellip;</div>
          )}
          <Tick checked={keep} onChange={setKeep}>
            Keep this unit&rsquo;s settings{' '}
            <span className="d">— its name, port and LAN address. Off erases the whole flash and it comes back on factory settings.</span>
          </Tick>
          <div className="actions">
            {release && (
              <button className="btn primary" disabled={busy || !chosen} onClick={() => setConfirm('release')}>
                Write {release.id}&hellip;
              </button>
            )}
            <button className="btn quiet" disabled={busy} onClick={chooseOwn}>
              Write your own build&hellip;
            </button>
          </div>
        </div>
      )}
      <Err text={error} />
      {done && <div className="fw-done">{done}</div>}

      {confirm === 'release' && chosen && release && (
        <WriteConfirm
          title={`Write ${release.id} (${chosen.name}) to ${port.name}`}
          rows={chosen.parts.map(p => [p.name, hex(p.offset), humanSize(p.size)])}
          d={d!}
          ours={Boolean(ours)}
          keep={keep}
          usbNetwork={chosen.id === 'usb-network'}
          foreignTick={false}
          onCancel={() => setConfirm(null)}
          onConfirm={allowForeign => write({ variant: chosen.id, ownFiles: [], allowForeign })}
        />
      )}
      {confirm === 'own' && (
        <WriteConfirm
          title={`Write your own build to ${port.name}`}
          rows={own.map(f => [fileName(f), 'by its contents', ''])}
          d={d!}
          ours={Boolean(ours)}
          keep={keep}
          usbNetwork={false}
          foreignTick
          onCancel={() => setConfirm(null)}
          onConfirm={allowForeign => write({ variant: null, ownFiles: own, allowForeign })}
        />
      )}
    </div>
  )
}

function WriteConfirm({
  title,
  rows,
  d,
  ours,
  keep,
  usbNetwork,
  foreignTick,
  onConfirm,
  onCancel,
}: {
  title: string
  rows: string[][]
  d: Description
  ours: boolean
  keep: boolean
  usbNetwork: boolean
  /** Own builds only: let an app that is not a CANary build through. */
  foreignTick: boolean
  onConfirm: (allowForeign: boolean) => void
  onCancel: () => void
}) {
  const [replace, setReplace] = useState(false)
  const [foreign, setForeign] = useState(false)
  const app = d.running?.app
  return (
    <Confirm title={title} action="Write it" ready={ours || replace} onConfirm={() => onConfirm(foreign)} onCancel={onCancel}>
      <table className="fw-parts">
        <tbody>
          {rows.map(r => (
            <tr key={r[0]}>
              {r.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {!keep
          ? 'The whole flash is erased first. It comes back on factory settings.'
          : ours
            ? 'Only those regions are written. Its settings — name, port, LAN address — and its stored crash log stay.'
            : 'Only those regions are written, and whatever else is on its flash stays. For a board that was not a CANary, turning off “Keep this unit’s settings” to erase it first is usually the better idea.'}
      </p>
      {usbNetwork && (
        <p>
          After 8 seconds its USB-C port becomes a network adapter and stops being a serial port.
          To write it again later, hold BOOT and tap EN first.
        </p>
      )}
      {!ours && (
        <>
          <Err
            text={
              app
                ? `This unit boots ${app.project} ${app.version}, which is not CANary firmware.`
                : 'This unit boots nothing Burrow can read. A blank board looks like this; so does one that is not a CANary.'
            }
          />
          <Tick checked={replace} onChange={setReplace}>
            Replace what is on it
          </Tick>
        </>
      )}
      {foreignTick && (
        <Tick checked={foreign} onChange={setForeign}>
          Allow an app that is not a CANary build <span className="d">— for your own experiments, never a default</span>
        </Tick>
      )}
      <p className="fw-help">
        Once it starts the write cannot be stopped. If it fails part way the unit is not bricked: the
        ESP32-S3&rsquo;s boot ROM cannot be overwritten, so hold BOOT, tap EN and write it again.
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
      onBuilt(await job('play-build', () => api.playBuild({ sshKey: key, tag, modules, ...opt })))
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
    <section>
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
            USB media player, the UVC converter and the streaming gateway. It carries no vendor key
            and needs none.
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
