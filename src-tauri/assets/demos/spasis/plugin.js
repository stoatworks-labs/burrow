/**
 * Spasis — the browser demo.
 *
 * **This is not the plugin.** It is a port: the GLSL from `source/render/Shaders.h`
 * copied across unedited, and JavaScript ports of the analysis in
 * `source/analysis/` and the geometry in `source/render/Builder.cpp`, running in
 * WebGL2 with the parameters the plugins' constructors declare.
 *
 * ## Why this demo has more ported into it than its siblings
 *
 * The other demos in this kit are a fragment shader over a texture: the shader IS
 * the plugin, so running it for real is most of the job. Spasis is not shaped like
 * that. Its shaders are three small passes — a trace, a decay and a composite —
 * and everything that makes it interesting happens *before* them, on the CPU: the
 * FFT, the field law, the width figure and the mesh construction. Showing only the
 * shaders would be showing the least of it.
 *
 * So the analysis and the builder are ported rather than skipped, and ported
 * literally — same band edges, same ballistics, same `place()`, same hash. Where
 * this file and the C++ disagree, the C++ is right and this is a bug.
 *
 * ## What is NOT here, and cannot be
 *
 * The plugin opens **its own multichannel capture device** — that is the whole
 * reason it exists in the shape it does, because FFGL hands a plugin nothing but a
 * mono magnitude spectrum. A web page cannot open a Dante receiver or a loopback,
 * so this one generates the same synthetic programme the offline harness and the
 * project video use: correlated bass, a pair of mid tones panned apart, and a
 * deliberately decorrelated top end. That is why the width plot rises rather than
 * sitting flat.
 *
 * **Audio Input and Rescan Inputs are therefore shown but inert**, and the page
 * says so rather than hiding them — they are two of the plugin's real controls and
 * a demo that quietly dropped them would be describing a different plugin.
 */
import { Program, Quad, PassBuffer, bindTexture } from './vendor/gl.js';
import { mountDemo } from './vendor/demo.js';

const PI = Math.PI;
const MIN_MAG = 1e-9;

//---------------------------------------------------------------------------
// Speaker layouts — port of source/analysis/Layout.cpp
//---------------------------------------------------------------------------

const deg = (d) => (d * PI) / 180;
const at = (degrees) => ({ azimuth: deg(degrees), elevation: 0, lfe: false });
const lfeChannel = () => ({ azimuth: 0, elevation: 0, lfe: true });

const LAYOUTS = {
  mono: () => [at(0)],
  // ±45, not ±30. This is the number that makes the generalised field law
  // reproduce the classic goniometer — see the project's own Frame.h.
  stereo: () => [at(-45), at(45)],
  quad: () => [at(-45), at(45), at(-135), at(135)],
  // ITU-R BS.775 in SMPTE order: L R C LFE Ls Rs.
  surround51: () => [at(-30), at(30), at(0), lfeChannel(), at(-110), at(110)],
  surround71: () => [at(-30), at(30), at(0), lfeChannel(),
                     at(-90), at(90), at(-150), at(150)],
  ring: (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      let a = (2 * PI * i) / n;
      if (a > PI) a -= 2 * PI;
      out.push({ azimuth: a, elevation: 0, lfe: false });
    }
    return out;
  },
};

function layoutForChannelCount(n) {
  switch (n) {
    case 0: return [];
    case 1: return LAYOUTS.mono();
    case 2: return LAYOUTS.stereo();
    case 4: return LAYOUTS.quad();
    case 6: return LAYOUTS.surround51();
    case 8: return LAYOUTS.surround71();
    default: return LAYOUTS.ring(n);
  }
}

/** The Speakers dropdown, in the plugin's own element order. */
function layoutFor(choice, channels) {
  switch (choice) {
    case 1: return LAYOUTS.stereo();
    case 2: return LAYOUTS.quad();
    case 3: return LAYOUTS.surround51();
    case 4: return LAYOUTS.surround71();
    case 5: return LAYOUTS.ring(channels);
    default: return layoutForChannelCount(channels);   // Auto
  }
}

/** Bin centres, spanning the full circle from straight ahead.
 *
 *  The half-bin offset matters: without it bin 0 straddles 0° and a
 *  centre-panned signal splits its energy between the first and last bin, which
 *  reads as two lobes. */
function roseAngle(i, n) {
  if (n <= 0) return 0;
  const step = (2 * PI) / n;
  let a = (i + 0.5) * step;
  if (a > PI) a -= 2 * PI;
  return a;
}

//---------------------------------------------------------------------------
// FFT — port of source/analysis/FFT.cpp (radix-2, in place)
//---------------------------------------------------------------------------

function makeFFT(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error(`FFT size ${n} is not a power of two`);
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((-2 * PI * i) / n);
    sin[i] = Math.sin((-2 * PI * i) / n);
  }
  return function forward(re, im) {
    // Bit reversal.
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j += 1, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] - im[l] * sin[k];
          const tim = re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre;        im[j] += tim;
        }
      }
    }
  };
}

//---------------------------------------------------------------------------
// The programme — port of makeProgramme() in tools/sptest/Render.cpp
//---------------------------------------------------------------------------

/**
 * A stereo programme that exercises every display at once.
 *
 * Bass centred and correlated, a pair of mid tones panned apart, and a top end
 * that is deliberately DE-CORRELATED — which is what a real mix does and what
 * makes the width plot show a rising curve rather than a flat line. A test signal
 * of one correlated tone would draw four perfectly plausible pictures and prove
 * nothing about any of them.
 *
 * Byte-for-byte the harness's programme, so this page, the contact sheet in the
 * repository and the project video are all showing the same audio.
 */
function makeProgramme(out, frames, channels, sampleRate, t0) {
  for (let i = 0; i < frames; i += 1) {
    const t = t0 + i / sampleRate;

    const bass = 0.55 * Math.sin(2 * PI * 70 * t);
    const midL = 0.25 * Math.sin(2 * PI * 640 * t);
    const midR = 0.25 * Math.sin(2 * PI * 970 * t + 1.1);
    // Two high tones a hair apart in frequency drift through every phase
    // relationship, which is a decorrelated top end without needing noise.
    const airL = 0.16 * Math.sin(2 * PI * 6300 * t);
    const airR = 0.16 * Math.sin(2 * PI * 6480 * t);

    const l = bass + midL * 1.2 + midR * 0.4 + airL;
    const r = bass + midL * 0.4 + midR * 1.2 + airR;

    for (let c = 0; c < channels; c += 1) {
      // Beyond stereo, wrap the two signals round the ring at decreasing level
      // so a surround layout has something in every speaker.
      const base = c % 2 === 0 ? l : r;
      out[i * channels + c] = base * (1 / (1 + 0.6 * Math.floor(c / 2)));
    }
  }
}

//---------------------------------------------------------------------------
// Analyser — port of source/analysis/Analyser.cpp
//---------------------------------------------------------------------------

const CONFIG = {
  fftSize: 2048,
  bands: 48,
  roseBins: 180,
  fieldPoints: 2048,
  releaseSeconds: 0.15,
  floorDb: -60,
};

/** dB above `floorDb`, mapped to 0..1 and clamped. */
function toDisplay(magnitude, floorDb) {
  const db = 20 * Math.log10(Math.max(magnitude, MIN_MAG));
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 * (1 - Math.cos((2 * PI * i) / (n - 1)));
  return w;
}

class Analyser {
  constructor() { this.channels = 0; }

  configure(channels, sampleRate, layout) {
    const n = CONFIG.fftSize;
    this.n = n;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.layout = layout.length === channels ? layout : layoutForChannelCount(channels);
    this.fft = makeFFT(n);
    this.window = hann(n);

    // Coherent gain of the window, so a full-scale sine reads full scale rather
    // than 6 dB down. Computed rather than assumed, which keeps the two in step
    // if the window is ever changed.
    let sum = 0;
    for (const w of this.window) sum += w;
    this.windowGain = sum > 0 ? sum / n : 1;

    // Band edges, not centres, so adjacent bands tile the spectrum exactly once
    // — overlapping bands double-count energy and make a pink-noise display sag
    // in the middle.
    const nyq = n / 2;
    const binHz = sampleRate / n;
    const fLow = 20;
    const fHigh = Math.min(20000, sampleRate * 0.45);
    this.bandLo = []; this.bandHi = [];
    this.bandFreq = new Float32Array(CONFIG.bands);
    for (let b = 0; b < CONFIG.bands; b += 1) {
      const f0 = fLow * (fHigh / fLow) ** (b / CONFIG.bands);
      const f1 = fLow * (fHigh / fLow) ** ((b + 1) / CONFIG.bands);
      let lo = Math.floor(f0 / binHz);
      let hi = Math.ceil(f1 / binHz);
      lo = Math.max(1, Math.min(lo, nyq - 1));      // bin 0 is DC, never wanted
      hi = Math.max(lo + 1, Math.min(hi, nyq));     // at least one bin per band
      this.bandLo.push(lo); this.bandHi.push(hi);
      this.bandFreq[b] = Math.sqrt(f0 * f1);
    }

    const bands = CONFIG.bands;
    this.frame = {
      channels, sampleRate, live: true, layout: this.layout,
      field: new Float32Array(CONFIG.fieldPoints * 2),
      rose: new Float32Array(CONFIG.roseBins),
      bandFreq: this.bandFreq,
      bandMag: new Float32Array(bands),
      bandWidth: new Float32Array(bands),
      chRms: new Float32Array(Math.max(0, channels)),
      bandCount: bands,
      roseCount: CONFIG.roseBins,
      fieldCount: CONFIG.fieldPoints,
    };
    this.heldBandMag = new Float32Array(bands);
    this.heldRose = new Float32Array(CONFIG.roseBins);
    this.heldRms = new Float32Array(Math.max(0, channels));

    this.scratch = new Float32Array(n * Math.max(1, channels));
    this.re = new Float32Array(n * Math.max(1, channels));
    this.im = new Float32Array(n * Math.max(1, channels));
    this.roseAcc = new Float32Array(CONFIG.roseBins);
  }

  /** Instant attack, exponential release. */
  release(previous, target, dt) {
    if (target >= previous) return target;
    if (CONFIG.releaseSeconds <= 0 || dt <= 0) return target;
    return target + (previous - target) * Math.exp(-dt / CONFIG.releaseSeconds);
  }

  analyse(dt) {
    const { n, channels: ch, frame } = this;
    if (ch <= 0 || n < 2) return frame;

    //-- Speaker unit vectors ---------------------------------------------
    const ux = new Float32Array(ch);
    const uy = new Float32Array(ch);
    const usable = new Array(ch).fill(false);
    for (let c = 0; c < ch; c += 1) {
      if (c >= this.layout.length) continue;
      const p = this.layout[c];
      if (p.lfe) continue;      // no direction to contribute
      ux[c] = Math.sin(p.azimuth);
      uy[c] = Math.cos(p.azimuth);
      usable[c] = true;
    }

    //-- Sample domain: the field trace and per-channel levels -------------
    const points = CONFIG.fieldPoints;
    const first = n - points;
    const sumSq = new Float32Array(ch);
    const peak = new Float32Array(ch);

    for (let i = 0; i < points; i += 1) {
      let px = 0; let py = 0;
      for (let c = 0; c < ch; c += 1) {
        if (!usable[c]) continue;
        const s = this.scratch[(first + i) * ch + c];
        // The whole law, and the only place it is written: amplitude-weighted
        // sum of the unit vectors to each speaker. At a stereo ±45 layout this
        // is (side, mid) and therefore the classic goniometer exactly.
        px += s * ux[c];
        py += s * uy[c];
      }
      frame.field[i * 2] = px;
      frame.field[i * 2 + 1] = py;
    }

    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < ch; c += 1) {
        const s = this.scratch[i * ch + c];
        sumSq[c] += s * s;
        peak[c] = Math.max(peak[c], Math.abs(s));
      }
    }
    for (let c = 0; c < ch; c += 1) {
      const rms = Math.sqrt(sumSq[c] / n);
      const target = toDisplay(rms, CONFIG.floorDb);
      this.heldRms[c] = this.release(this.heldRms[c], target, dt);
      frame.chRms[c] = this.heldRms[c];
    }

    //-- The rose: field energy by angle -----------------------------------
    this.roseAcc.fill(0);
    const binsPerTurn = CONFIG.roseBins / (2 * PI);
    for (let i = 0; i < points; i += 1) {
      const px = frame.field[i * 2];
      const py = frame.field[i * 2 + 1];
      const mag = Math.sqrt(px * px + py * py);
      if (mag < MIN_MAG) continue;
      let a = Math.atan2(px, py);        // audio convention: 0 ahead, +ve right
      if (a < 0) a += 2 * PI;
      let b = Math.floor(a * binsPerTurn);
      b = Math.max(0, Math.min(CONFIG.roseBins - 1, b));
      this.roseAcc[b] += mag * mag;
    }
    let roseMax = 0;
    for (const v of this.roseAcc) roseMax = Math.max(roseMax, v);
    for (let i = 0; i < CONFIG.roseBins; i += 1) {
      const target = roseMax > 0 ? Math.sqrt(this.roseAcc[i] / roseMax) : 0;
      this.heldRose[i] = this.release(this.heldRose[i], target, dt);
      frame.rose[i] = this.heldRose[i];
    }

    //-- Frequency domain ---------------------------------------------------
    for (let c = 0; c < ch; c += 1) {
      const re = this.re.subarray(c * n, (c + 1) * n);
      const im = this.im.subarray(c * n, (c + 1) * n);
      for (let i = 0; i < n; i += 1) {
        re[i] = this.scratch[i * ch + c] * this.window[i];
        im[i] = 0;
      }
      this.fft(re, im);
    }

    const scale = 2 / (n * this.windowGain);
    const use = Math.min(ch, 8);
    for (let b = 0; b < CONFIG.bands; b += 1) {
      // One complex value per channel for this band. Summing the complex bins
      // (not the magnitudes) is what keeps the phase relationship between
      // channels alive — and phase between channels is the entire subject of
      // three of the four plugins.
      let total = 0; let power = 0;
      let cohRe = 0; let cohIm = 0;
      for (let c = 0; c < use; c += 1) {
        const re = this.re.subarray(c * n, (c + 1) * n);
        const im = this.im.subarray(c * n, (c + 1) * n);
        let ar = 0; let ai = 0;
        for (let k = this.bandLo[b]; k < this.bandHi[b]; k += 1) { ar += re[k]; ai += im[k]; }
        ar *= scale; ai *= scale;
        const mag = Math.hypot(ar, ai);
        total += mag;
        power += mag * mag;
        cohRe += ar; cohIm += ai;
      }

      // width = 1 - |sum X_c|^2 / ( N * sum |X_c|^2 )
      //
      // N identical correlated channels give 0; an anti-phase pair gives 1; a
      // hard-panned stereo signal gives 0.5, which is exactly what the
      // |S|/(|M|+|S|) meter every mastering engineer already owns reads for the
      // same signal.
      const cohP = cohRe * cohRe + cohIm * cohIm;
      frame.bandWidth[b] = power > MIN_MAG * MIN_MAG
        ? Math.min(1, Math.max(0, 1 - cohP / (use * power)))
        : 0;

      const target = toDisplay(total / Math.max(1, use), CONFIG.floorDb);
      this.heldBandMag[b] = this.release(this.heldBandMag[b], target, dt);
      frame.bandMag[b] = this.heldBandMag[b];
    }

    return frame;
  }
}

//---------------------------------------------------------------------------
// Builder — port of source/render/Builder.cpp
//---------------------------------------------------------------------------

/** Deterministic scatter for the particle style.
 *
 *  A real RNG would make the display fizz differently every frame and the
 *  picture would never settle, which reads as noise rather than as a signal that
 *  happens to be noisy. */
function hash(n) {
  n = (n << 13) ^ n;
  n = (n * ((n * n * 15731 + 789221) | 0) + 1376312589) | 0;
  return (n & 0x7fffffff) / 0x7fffffff;
}

const GEOM = { CIRCULAR: 0, SEMI: 1, RASTER: 2 };
const STYLE = { SCOPE: 0, BARS: 1, PARTICLE: 2 };

/** The geometry mapping, and the only one. */
function place(t, v, view) {
  v = Math.max(0, Math.min(1, v * view.gain));
  const out = { x: 0, y: 0, intensity: v, size: 1 };

  if (view.geometry === GEOM.RASTER) {
    // Full frame, bottom-anchored. No aspect correction: a raster plot is not a
    // circle and has nothing to keep round.
    out.x = t * 2 - 1;
    out.y = v * 2 - 1;
    return out;
  }

  // Angle runs clockwise from straight up, matching the audio convention used
  // everywhere in the analysis — 0 ahead, positive right.
  const sweep = view.geometry === GEOM.CIRCULAR ? 2 * PI : PI;
  const start = view.geometry === GEOM.CIRCULAR ? 0 : -PI * 0.5;
  const angle = start + t * sweep + view.rotation;
  const radius = view.innerRadius + v * (1 - view.innerRadius);

  out.x = Math.sin(angle) * radius;
  out.y = Math.cos(angle) * radius;

  // Aspect correction shrinks the wide axis rather than stretching the narrow
  // one, so the figure always fits.
  if (view.aspect > 1) out.x /= view.aspect;
  else if (view.aspect > 0) out.y *= view.aspect;
  return out;
}

function placeField(px, py, view) {
  // 1/sqrt2 puts a full-scale correlated stereo signal exactly on the rim, which
  // is the convention every goniometer uses and the reason an over reads as a
  // trace that leaves the circle instead of one that flattens against it.
  const K = 0.70710678;
  let x = px * K * view.gain;
  let y = py * K * view.gain;

  if (view.rotation !== 0) {
    const c = Math.cos(view.rotation);
    const s = Math.sin(view.rotation);
    const rx = x * c - y * s;
    y = x * s + y * c;
    x = rx;
  }

  const out = { x: 0, y: 0, intensity: Math.min(1, Math.hypot(x, y)), size: 1 };

  if (view.geometry === GEOM.SEMI) {
    // Fold the lower half up. A goniometer trace is symmetric through the
    // origin, so this discards nothing.
    if (y < 0) { x = -x; y = -y; }
    // The half disc needs height r and width 2r on screen, so the largest r
    // that fits is min(aspect, 2). Mapping y from 0..1 onto -1..1 instead is
    // the obvious thing and it is wrong: it stretches the disc by the output
    // aspect and an out-of-phase signal stops lying at 90° to a mono one.
    const a = view.aspect > 0 ? view.aspect : 1;
    const r = Math.min(a, 2);
    out.x = (x * r) / a;
    out.y = -1 + y * r;
    return out;
  }

  if (view.geometry === GEOM.RASTER) {
    out.x = x; out.y = y;
    return out;
  }

  if (view.aspect > 1) x /= view.aspect;
  else if (view.aspect > 0) y *= view.aspect;
  out.x = x; out.y = y;
  return out;
}

/** A vertex sink that writes straight into a growable Float32Array. */
class MeshSink {
  constructor() { this.data = new Float32Array(4096 * 4); this.count = 0; this.primitive = 'points'; }
  clear() { this.count = 0; }
  push(v) {
    if ((this.count + 1) * 4 > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const o = this.count * 4;
    this.data[o] = v.x; this.data[o + 1] = v.y;
    this.data[o + 2] = v.intensity; this.data[o + 3] = v.size;
    this.count += 1;
  }
  quad(a, b, c, d) { this.push(a); this.push(b); this.push(c); this.push(a); this.push(c); this.push(d); }
}

function buildField(frame, view, out) {
  out.clear();
  const n = frame.fieldCount;
  if (n === 0) return;

  if (view.style === STYLE.BARS) {
    // A bargraph of a 2D cloud is a density histogram: bin the points by angle
    // and draw the extent. Anything else would be a bar chart of x against
    // sample index, which is a waveform, not a field.
    const BINS = 64;
    const extent = new Float32Array(BINS);
    for (let i = 0; i < n; i += 1) {
      const px = frame.field[i * 2]; const py = frame.field[i * 2 + 1];
      let a = Math.atan2(px, py);
      if (a < 0) a += 2 * PI;
      const b = Math.min(BINS - 1, Math.floor((a / (2 * PI)) * BINS));
      extent[b] = Math.max(extent[b], Math.hypot(px, py) * 0.70710678);
    }
    const width = (1 / BINS) * 0.8 * view.thickness;
    for (let b = 0; b < BINS; b += 1) {
      const t = (b + 0.5) / BINS;
      out.quad(place(t - width * 0.5, 0, view), place(t + width * 0.5, 0, view),
               place(t + width * 0.5, extent[b], view), place(t - width * 0.5, extent[b], view));
    }
    out.primitive = 'triangles';
    return;
  }

  for (let i = 0; i < n; i += 1) {
    const v = placeField(frame.field[i * 2], frame.field[i * 2 + 1], view);
    if (view.style === STYLE.PARTICLE) {
      // Scatter proportional to magnitude: a loud passage becomes a cloud, a
      // quiet one stays a thread. Scattering by a constant would make silence
      // look like noise.
      const spread = 0.02 * view.thickness * v.intensity;
      v.x += (hash(i * 2) - 0.5) * spread;
      v.y += (hash(i * 2 + 1) - 0.5) * spread;
      v.size = 1 + 3 * view.thickness;
    } else {
      v.size = 1 + view.thickness;
    }
    out.push(v);
  }
  out.primitive = view.style === STYLE.SCOPE ? 'linestrip' : 'points';
}

/** Shared by every (t, v) display. Bin centres for bars, endpoints for a curve. */
function buildPlot(values, n, view, out) {
  out.clear();
  if (!values || n <= 0) return;

  if (view.style === STYLE.BARS) {
    const width = (1 / n) * 0.8 * Math.max(0.1, view.thickness);
    for (let i = 0; i < n; i += 1) {
      const t = (i + 0.5) / n;
      out.quad(place(t - width * 0.5, 0, view), place(t + width * 0.5, 0, view),
               place(t + width * 0.5, values[i], view), place(t - width * 0.5, values[i], view));
    }
    out.primitive = 'triangles';
    return;
  }

  if (view.style === STYLE.PARTICLE) {
    // A column of particles whose height is the reading and whose density
    // carries it a second time, which survives being seen at a distance.
    const PER_BAND = 24;
    for (let i = 0; i < n; i += 1) {
      const t = (i + 0.5) / n;
      const count = Math.floor(values[i] * PER_BAND);
      for (let k = 0; k < count; k += 1) {
        const seed = i * 977 + k;
        const v = values[i] * hash(seed);
        const q = place(t + (hash(seed * 3) - 0.5) / n, v, view);
        q.size = 1 + 3 * view.thickness;
        q.intensity = 1 - v * 0.4;
        out.push(q);
      }
    }
    out.primitive = 'points';
    return;
  }

  for (let i = 0; i < n; i += 1) {
    const t = n > 1 ? i / (n - 1) : 0.5;
    const q = place(t, values[i], view);
    q.size = 1 + view.thickness;
    out.push(q);
  }
  // Close the loop in the full circle, or the curve has a seam at 0.
  if (view.geometry === GEOM.CIRCULAR && out.count > 0) {
    out.push({ x: out.data[0], y: out.data[1], intensity: out.data[2], size: out.data[3] });
  }
  out.primitive = 'linestrip';
}

function buildSpeakers(frame, view, out) {
  out.clear();
  const n = Math.min(frame.chRms.length, frame.layout.length);
  if (n <= 0) return;

  // A lobe per channel, centred on where that speaker actually is. Unlike the
  // rose this makes no attempt to be a distribution: it is N meters arranged in
  // a circle, which is what a surround level display has always been.
  const STEPS = 12;
  for (let c = 0; c < n; c += 1) {
    const p = frame.layout[c];
    if (p.lfe) continue;          // no direction; drawing it would invent one
    const level = frame.chRms[c];
    if (level <= 0) continue;

    // Height channels are shaded rather than moved — a flat picture cannot show
    // elevation and pretending otherwise puts a ceiling speaker somewhere on
    // the horizontal plane where a floor speaker could be.
    const shade = 1 - 0.45 * Math.min(1, Math.abs(p.elevation) / (PI * 0.5));
    const halfWidth = (PI / Math.max(3, n)) * 0.45 * Math.max(0.2, view.thickness);
    const centre = p.azimuth;

    for (let s = 0; s < STEPS; s += 1) {
      const a0 = centre - halfWidth + 2 * halfWidth * (s / STEPS);
      const a1 = centre - halfWidth + 2 * halfWidth * ((s + 1) / STEPS);
      // A cosine taper, so adjacent speakers at similar levels read as two
      // lobes rather than one wide block.
      const f0 = Math.cos(((a0 - centre) / halfWidth) * PI * 0.5);
      const f1 = Math.cos(((a1 - centre) / halfWidth) * PI * 0.5);

      const sweep = view.geometry === GEOM.CIRCULAR ? 2 * PI : PI;
      const start = view.geometry === GEOM.CIRCULAR ? 0 : -PI * 0.5;
      const t0 = (a0 - start) / sweep;
      const t1 = (a1 - start) / sweep;

      const q0 = place(t0, 0, view);
      const q1 = place(t1, 0, view);
      const q2 = place(t1, level * f1, view);
      const q3 = place(t0, level * f0, view);
      q2.intensity *= shade; q3.intensity *= shade;
      out.quad(q0, q1, q2, q3);
    }
  }
  out.primitive = 'triangles';
}

function buildGraticule(frame, view, out, dim) {
  out.clear();
  out.primitive = 'lines';
  if (dim <= 0) return;

  const unit = { ...view, gain: 1 };   // the graticule is fixed, never scaled

  const segment = (a, b, intensity) => {
    a.intensity = intensity; b.intensity = intensity;
    a.size = 1; b.size = 1;
    out.push(a); out.push(b);
  };

  if (view.geometry === GEOM.RASTER) {
    // A baseline and a few horizontal rules. A grid dense enough to be a grid
    // would compete with the trace.
    for (let i = 0; i <= 4; i += 1) {
      const v = i / 4;
      segment(place(0, v, unit), place(1, v, unit), dim * (i === 0 ? 1 : 0.4));
    }
    return;
  }

  const steps = view.geometry === GEOM.CIRCULAR ? 96 : 48;
  const ring = (v, intensity, count) => {
    for (let i = 0; i < count; i += 1) {
      segment(place(i / count, v, unit), place((i + 1) / count, v, unit), intensity);
    }
  };
  ring(1, dim, steps);
  if (view.innerRadius > 0.001) ring(0, dim * 0.7, steps / 2);

  // Taken from the LAYOUT rather than drawn at fixed angles, so a 5.1 rose gets
  // marks where its speakers are.
  const sweep = view.geometry === GEOM.CIRCULAR ? 2 * PI : PI;
  const start = view.geometry === GEOM.CIRCULAR ? 0 : -PI * 0.5;
  const angles = [0];
  for (const p of frame.layout) if (!p.lfe) angles.push(p.azimuth);
  if (frame.layout.length <= 2) {
    // Stereo also gets the horizontal, which is where an out-of-phase signal
    // lies and the one line anybody actually looks for.
    angles.push(PI * 0.5, -PI * 0.5);
  }

  for (const a of angles) {
    let t = (a - start) / sweep;
    // Azimuths are signed — 0 ahead, NEGATIVE to the left — so every speaker on
    // the left half gives a negative t. In the full circle that is a legal
    // position and has to WRAP; in a half circle it is genuinely off the
    // display. Range-checking without wrapping first drops every mark on the
    // left, which on a 5.1 layout is half of them.
    if (view.geometry === GEOM.CIRCULAR) t -= Math.floor(t);
    else if (t < -0.001 || t > 1.001) continue;
    segment(place(t, 0, unit), place(t, 1, unit), dim * (Math.abs(a) < 0.001 ? 0.9 : 0.45));
  }
}

//---------------------------------------------------------------------------
// The shaders — copied unedited from source/render/Shaders.h
//---------------------------------------------------------------------------

const TRACE_VERT = `#version 410 core
layout( location = 0 ) in vec2 vPosition;
layout( location = 1 ) in float vIntensity;
layout( location = 2 ) in float vSize;
out float fIntensity;
void main()
{
	fIntensity = vIntensity;
	gl_PointSize = vSize;
	gl_Position = vec4( vPosition, 0.0, 1.0 );
}
`;

const TRACE_FRAG = `#version 410 core
uniform float pointMode;
in float fIntensity;
out vec4 fragColour;
void main()
{
	// gl_PointCoord is UNDEFINED for every primitive but GL_POINTS. On Apple's
	// Metal GL the value it takes is (0,0) -- the far corner of the disc -- so
	// an unconditional falloff evaluates to zero and every line and every bar
	// renders pure black. The uniform is cheaper than that afternoon.
	float falloff = 1.0;
	if( pointMode > 0.5 )
	{
		vec2 d = gl_PointCoord - vec2( 0.5 );
		falloff = clamp( 1.0 - dot( d, d ) * 4.0, 0.0, 1.0 );
	}
	fragColour = vec4( vec3( fIntensity * falloff ), 1.0 );
}
`;

const COMPOSITE_FRAG = `#version 410 core
uniform sampler2D accumTexture;
uniform vec4 foreground;
uniform vec4 background;
in vec2 uv;
out vec4 fragColour;
void main()
{
	float energy = texture( accumTexture, uv ).r;

	// The accumulator holds unbounded additive energy. A hard clamp turns every
	// busy passage into a flat white shape, which throws away exactly the
	// dynamic range the instrument exists to show, so this is a soft knee that
	// approaches 1 without reaching it.
	float level = 1.0 - exp( -energy * 2.0 );

	vec3 rgb = mix( background.rgb, foreground.rgb, level );
	float a = mix( background.a, foreground.a, level );

	fragColour = vec4( rgb * a, a );
}
`;

const DECAY_FRAG = `#version 410 core
uniform sampler2D accumTexture;
uniform float decay;
in vec2 uv;
out vec4 fragColour;
void main()
{
	fragColour = texture( accumTexture, uv ) * decay;
}
`;

/** Not the plugin's: the plugin has no video input at all. This draws the demo's
 *  clip behind the display, which is what the layer underneath does in Resolume
 *  when Background is left transparent. */
const BLIT_FRAG = `#version 410 core
uniform sampler2D clipTexture;
in vec2 uv;
out vec4 fragColour;
void main()
{
	fragColour = texture( clipTexture, uv );
}
`;

const QUAD_VERT = `#version 410 core
layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;
out vec2 uv;
void main()
{
	uv = vUV;
	gl_Position = vPosition;
}
`;

//---------------------------------------------------------------------------
// The plugin's own parameter conversions — from source/Spasis.cpp
//---------------------------------------------------------------------------

const GainDb = (v) => v * 36 - 12;
const GainLinear = (v) => 10 ** (GainDb(v) / 20);
const PersistHalfLife = (v) => 0.02 + v * v * 2;

/** HSV to RGB, for the Hue/Saturation/Brightness trio. */
function hsv(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

//---------------------------------------------------------------------------

const DISPLAY = { FIELD: 'field', ROSE: 'rose', WIDTH: 'width', BALANCE: 'balance' };

function createRenderer(gl) {
  // Raw sources: Program ports 410-core -> ES 3.00 itself, and porting them here
  // first leaves a second #version line in the middle of the source.
  //
  // The trace shader needs its own attribute bindings. The kit's default is the
  // quad's {vPosition: 0, vUV: 1}, and this geometry is not a quad -- location 1
  // is vIntensity and location 2 is vSize, matching the interleaved buffer below
  // and the plugin's own vertex layout.
  const traceShader = new Program(gl, TRACE_VERT, TRACE_FRAG, 'trace',
                                  { attribs: { vPosition: 0, vIntensity: 1, vSize: 2 } });
  const decayShader = new Program(gl, QUAD_VERT, DECAY_FRAG, 'decay');
  const compositeShader = new Program(gl, QUAD_VERT, COMPOSITE_FRAG, 'composite');
  const blitShader = new Program(gl, QUAD_VERT, BLIT_FRAG, 'blit');
  const quad = new Quad(gl);
  const accum = [new PassBuffer(gl), new PassBuffer(gl)];
  let current = 0;
  let clearPending = true;
  // PassBuffer.ensure() returns `this` whether or not it rebuilt, so a resize is
  // tracked here rather than inferred from it. A stale accumulator at the wrong
  // size is the one thing that must force a clear.
  let lastW = 0;
  let lastH = 0;
  let lastTime = null;

  const vbo = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
  gl.bindVertexArray(null);

  const analyser = new Analyser();
  let configuredFor = '';
  let audioClock = 0;

  const mesh = new MeshSink();
  const graticule = new MeshSink();
  const SAMPLE_RATE = 48000;

  const MODES = { points: 0, linestrip: 0, lines: 0, triangles: 0 };
  MODES.points = 1;   // pointMode uniform: only GL_POINTS may read gl_PointCoord

  function drawMesh(sink) {
    if (sink.count === 0) return;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, sink.data.subarray(0, sink.count * 4), gl.STREAM_DRAW);
    traceShader.set('pointMode', sink.primitive === 'points' ? 1 : 0);
    const mode = sink.primitive === 'linestrip' ? gl.LINE_STRIP
      : sink.primitive === 'lines' ? gl.LINES
        : sink.primitive === 'triangles' ? gl.TRIANGLES : gl.POINTS;
    gl.drawArrays(mode, 0, sink.count);
    gl.bindVertexArray(null);
  }

  return {
    dispose() {
      for (const p of [traceShader, decayShader, compositeShader, blitShader]) p.dispose();
      for (const b of accum) b.dispose();
      quad.dispose();
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
    },

    render({ input, params, width, height, time, variant }) {
      const display = variant ?? DISPLAY.FIELD;

      const layoutChoice = params.get('layout');
      const maxChannels = Math.max(1, Math.round(1 + params.get('channels') * 7));
      // Auto has no device to ask, so it follows Max Channels — the page says so
      // in its disclosure rather than pretending a device answered.
      const channels = layoutChoice === 1 ? 2 : layoutChoice === 2 ? 4
        : layoutChoice === 3 ? 6 : layoutChoice === 4 ? 8 : maxChannels;
      const layout = layoutFor(layoutChoice, channels);

      const key = `${channels}`;
      if (key !== configuredFor) {
        analyser.configure(channels, SAMPLE_RATE, layout);
        configuredFor = key;
        clearPending = true;
      }
      analyser.layout = layout;
      analyser.frame.layout = layout;

      // One FFT window of fresh audio per frame, advancing a monotonic clock so
      // the programme is continuous across frames rather than restarting.
      makeProgramme(analyser.scratch, analyser.n, channels, SAMPLE_RATE, audioClock);
      audioClock += analyser.n / SAMPLE_RATE;

      // The kit hands render() a clock, not a frame period. Deriving dt from it
      // keeps the ballistics and the persistence honest on a display that is not
      // 60 Hz; the clamp stops a backgrounded tab's multi-second gap from
      // flushing the whole trail in one frame.
      const dt = lastTime === null ? 1 / 60 : Math.min(0.25, Math.max(1e-4, time - lastTime));
      lastTime = time;
      const frame = analyser.analyse(dt);

      const view = {
        geometry: params.get('shape'),
        style: params.get('style'),
        gain: GainLinear(params.get('gain')),
        thickness: params.get('thickness'),
        innerRadius: params.get('inner') * 0.6,
        aspect: width / height,
        rotation: (params.get('rotation') - 0.5) * 2 * PI,
      };

      switch (display) {
        case DISPLAY.ROSE:
          if (params.get('lobes') === 1) buildSpeakers(frame, view, mesh);
          else buildPlot(frame.rose, frame.roseCount, view, mesh);
          break;
        case DISPLAY.WIDTH: buildPlot(frame.bandWidth, frame.bandCount, view, mesh); break;
        case DISPLAY.BALANCE: buildPlot(frame.bandMag, frame.bandCount, view, mesh); break;
        default: buildField(frame, view, mesh); break;
      }
      buildGraticule(frame, view, graticule, 0.14);

      //-- The canvas, in the order source/render/Canvas.cpp uses -----------
      accum[0].ensure(width, height, gl.R16F);
      accum[1].ensure(width, height, gl.R16F);
      if (width !== lastW || height !== lastH) { lastW = width; lastH = height; clearPending = true; }

      const src = current;
      const dst = 1 - current;

      accum[dst].bind();
      if (clearPending) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        clearPending = false;
      } else {
        gl.disable(gl.BLEND);
        decayShader.use();
        bindTexture(gl, 0, accum[src].texture);
        decayShader.set('accumTexture', 0);
        // Half-life in seconds -> per-frame multiplier, so persistence means
        // the same thing whatever the page's frame rate is.
        decayShader.set('decay', Math.pow(0.5, dt / PersistHalfLife(params.get('persist'))));
        quad.draw();
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      traceShader.use();
      drawMesh(mesh);
      current = dst;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);

      // The clip first. Spasis is a SOURCE and has no video input, so this is
      // not the plugin doing it -- it is standing in for the layer underneath,
      // which is what Background at zero leaves showing through in Resolume.
      if (input?.texture) {
        blitShader.use();
        bindTexture(gl, 0, input.texture);
        blitShader.set('clipTexture', 0);
        quad.draw();
      }

      const [r, g, b] = hsv(params.get('hue'), params.get('saturation'), params.get('brightness'));
      // The composite writes PREMULTIPLIED alpha -- Resolume composites
      // premultiplied, and returning straight alpha makes every edge darker
      // than it should be against anything but black.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      compositeShader.use();
      bindTexture(gl, 0, accum[current].texture);
      compositeShader.set('accumTexture', 0);
      compositeShader.set('foreground', r, g, b, 1);
      compositeShader.set('background', 0, 0, 0, params.get('background'));
      quad.draw();

      // The graticule sits OVER the composite rather than in the accumulator,
      // so it never decays.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      traceShader.use();
      drawMesh(graticule);
      gl.disable(gl.BLEND);
    },
  };
}

//---------------------------------------------------------------------------

mountDemo({
  name: 'Spasis',
  pluginId: 'SP01',
  tagline: 'The shape of the stereo and surround field, as four Resolume sources',
  repo: 'https://github.com/stoatworks-labs/spasis',
  page: 'https://stoatworks-labs.com/software/spasis/',
  needFloat: true,
  needFloatBlend: true,
  showBackdrop: true,

  // The kit's stock sentence says the page runs "on generated clips", which is
  // true of an effect and wrong here: Spasis is a SOURCE with no video input,
  // driven by audio. The clip behind the display is a backdrop standing in for
  // the layer underneath, not an input.
  blurb: "It is Spasis's own GLSL plus JavaScript ports of its analysis and its geometry, "
       + "running in WebGL2 on a generated audio programme — same parameters, same maths, "
       + "no install. The plugins capture their own multichannel audio, which a web page "
       + "cannot, so the clip behind the display is only a backdrop.",

  differences: [
    'The plugin opens its own multichannel capture device — a loopback, a Dante Virtual Soundcard, or an interface with the desk feeding it. A web page cannot, so this one generates the synthetic programme the project\'s own offline harness uses: correlated bass, a pair of mid tones panned apart, and a deliberately decorrelated top end. That is why the width plot rises rather than sitting flat.',
    'Audio Input and Rescan Inputs are shown because the plugin declares them, and they do nothing here. They are the two controls a browser has no way to honour.',
    'Speakers picks both the layout AND the channel count here, because there is no device to report one. In the plugin the count comes from the device and Max Channels caps it.',
    'The host-FFT fallback — where Audio Input is left on "Resolume (mono)" and only Balance can be drawn — is not reproduced. In the plugin that path leaves Field, Rose and Width deliberately empty.',
    'GLSL ES 3.00 rather than desktop GL 4.1 core, and the accumulator is half-float via EXT_color_buffer_float rather than R16F.',
    'The analysis and the geometry are JavaScript ports of source/analysis/ and source/render/Builder.cpp, not the compiled C++. The three shaders are the plugin\'s own, copied unedited.',
  ],

  variants: {
    label: 'Plugin',
    default: DISPLAY.FIELD,
    options: [
      { id: DISPLAY.FIELD, name: 'Spasis Field', hint: 'The goniometer. Where the signal sits, instant by instant.' },
      { id: DISPLAY.ROSE, name: 'Spasis Rose', hint: 'Polar level: energy against direction, or a lobe per speaker.' },
      { id: DISPLAY.WIDTH, name: 'Spasis Width', hint: 'Stereo width against frequency.' },
      { id: DISPLAY.BALANCE, name: 'Spasis Balance', hint: 'Tonal balance.' },
    ],
  },

  sources: ['scene', 'spot', 'grid', 'bars', 'detail'],

  presets: {
    'Goniometer': { shape: 0, style: 0, gain: 0.5, thickness: 0.3, persist: 0.6, hue: 0.5 },
    'Polar sample': { shape: 1, style: 2, gain: 0.55, thickness: 0.5, persist: 0.75, hue: 0.45 },
    'Surround lobes': { shape: 1, style: 1, layout: 3, lobes: 1, thickness: 0.6, hue: 0.16 },
    'Width sweep': { shape: 2, style: 0, gain: 0.5, thickness: 0.4, persist: 0.4, hue: 0.08 },
  },

  params: [
    // ---- Audio -----------------------------------------------------------
    {
      id: 'input', name: 'Audio Input', type: 'option', default: 0, group: 'Audio',
      elements: ['Resolume (mono)', '(no devices in a browser)'],
      hint: 'INERT HERE. In the plugin this lists every capture device the machine offers, and choosing one is the single piece of setup Spasis needs — three of the four displays draw only their graticule until you do. A page cannot open a Dante receiver, so this demo generates a programme instead.',
    },
    {
      id: 'rescan', name: 'Rescan Inputs', type: 'boolean', default: 0, group: 'Audio',
      hint: 'INERT HERE. Re-reads the device list. Devices are remembered by name rather than by index, so a rescan never silently moves your selection onto a different box.',
    },
    {
      id: 'layout', name: 'Speakers', type: 'option', default: 1, group: 'Audio',
      elements: ['Auto', 'Stereo', 'Quad', '5.1', '7.1', 'Ring'],
      hint: 'What the channels MEAN. Stereo is ±45°, not the ITU ±30° — at 45° the generalised field law comes out as exactly (side, mid), which IS the classic goniometer. It is the most consequential number in the project. LFE contributes a level and never a direction.',
    },
    {
      id: 'channels', name: 'Max Channels', type: 'standard', default: 1 / 7, group: 'Audio',
      display: (v) => `${Math.max(1, Math.round(1 + v * 7))} ch`,
      hint: 'Caps how many channels are opened, 1 to 8. A device offering more is capped rather than refused — a 112-channel L-ISA bridge opens as 8. Here it only has an effect on Auto and Ring.',
    },

    // ---- Display ---------------------------------------------------------
    {
      id: 'shape', name: 'Shape', type: 'option', default: 0, group: 'Display',
      elements: ['Circle', 'Half Circle', 'Raster'],
      hint: 'Where the picture is laid out. Half Circle is the goniometer\'s own frame — a trace is symmetric through the origin, so folding the lower half up discards nothing and doubles the density of what is drawn.',
    },
    {
      id: 'style', name: 'Style', type: 'option', default: 0, group: 'Display',
      elements: ['Scope', 'Bars', 'Particles'],
      hint: 'What it is drawn with. Independent of Shape on purpose: four displays × three shapes × three styles is thirty-six pictures out of one set of controls, and an operator who learns them on one plugin already knows the others.',
    },
    {
      id: 'gain', name: 'Gain', type: 'standard', default: 0.5, group: 'Display',
      display: (v) => `${GainDb(v) >= 0 ? '+' : ''}${GainDb(v).toFixed(1)} dB`,
      hint: 'A decibel control, not a linear one: the slider spans −12 dB to +24 dB, so the centre default is +6 dB rather than unity. The field is not normalised by the analysis, so an over reads as a trace that leaves the circle instead of one that flattens against it.',
    },
    {
      id: 'thickness', name: 'Thickness', type: 'standard', default: 0.3, group: 'Display',
      hint: 'Line or bar weight; point size and scatter in Particles. The particle scatter is proportional to magnitude, so a loud passage becomes a cloud and a quiet one stays a thread — scattering by a constant would make silence look like noise.',
    },
    {
      id: 'inner', name: 'Inner Radius', type: 'standard', default: 0.12, group: 'Display',
      hint: 'The hole in the middle of a circular plot. No effect on Raster, which has no centre.',
    },
    {
      id: 'rotation', name: 'Rotation', type: 'standard', default: 0.5, group: 'Display',
      display: (v) => `${(((v - 0.5) * 360)).toFixed(0)}°`,
      hint: 'A full turn across the slider, upright at centre.',
    },
    {
      id: 'persist', name: 'Persistence', type: 'standard', default: 0.6, group: 'Display',
      display: (v) => `${(PersistHalfLife(v) * 1000).toFixed(0)} ms`,
      hint: 'A half-life, not a fade time, from 20 ms to about two seconds — so the bottom of the travel is roughly one frame rather than instantaneous. A parameter change never clears the trail; a change of geometry does, or the old shape would smear into the new one.',
    },
    {
      id: 'lobes', name: 'Lobes', type: 'option', default: 0, group: 'Display',
      elements: ['Field', 'Speakers'],
      hint: 'ROSE ONLY. Field draws energy against direction as one continuous distribution; Speakers draws one lobe per speaker from the channel meters and the layout. They are genuinely different measurements — a discrete surround feed and a wide stereo mix look nothing alike in Field mode.',
    },

    // ---- Colour ----------------------------------------------------------
    {
      id: 'hue', name: 'Hue', type: 'standard', default: 0.5, group: 'Colour',
      display: (v) => `${(v * 360).toFixed(0)}°`,
      hint: 'Colour is applied once, in the composite, rather than being baked into the accumulator — so changing it does not mean waiting for the persistence to refill.',
    },
    { id: 'saturation', name: 'Saturation', type: 'standard', default: 0.65, group: 'Colour' },
    { id: 'brightness', name: 'Brightness', type: 'standard', default: 1.0, group: 'Colour' },
    {
      id: 'background', name: 'Background', type: 'standard', default: 0, group: 'Colour',
      hint: 'Background opacity. At zero the background is transparent, so only the trace and the graticule composite over whatever is underneath — which is what the clip behind this canvas is showing you.',
    },
  ],

  createRenderer,
});
