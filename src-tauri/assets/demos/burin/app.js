// Burin — web demo.
//
// A port of the plugin's DECISIONS, not of its rasteriser. The scale ladder,
// the cache rule, the motion, the reveal timing and the style selection are the
// same arithmetic as source/Raster.cpp, Motion.cpp, Reveal.cpp and Style.cpp.
// The thing that actually turns paths into pixels is the browser's own SVG
// engine rather than nanosvg — see web/README.md for why, and for the two
// places that difference shows.
//
// Nothing is uploaded. The dropped file is read with FileReader and stays here.

'use strict';

//---------------------------------------------------------------------------
// Controls.cpp — the same curves.
//---------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const expMap = (v, lo, hi) => lo * Math.pow(hi / lo, clamp01(v));

const zoomFromParam = (v) => expMap(v, 0.125, 8.0);
const zoomMoveFromParam = (v) => 3.0 * clamp01(v) * clamp01(v);
const panFromParam = (v) => clamp01(v) * 2.0 - 1.0;
const driftFromParam = (v) => clamp01(v) * clamp01(v);
const rotateFromParam = (v) => (clamp01(v) * 2.0 - 1.0) * Math.PI;
const rateFromParam = (v) => expMap(v, 0.01, 4.0);

// The cycle count, carried forward across a Rate change.
//
// `seconds * rate` moves the drawing by `seconds * delta` the instant Rate
// changes, and here `seconds` is how long the page has been open -- so dragging
// the slider a few minutes in teleports the zoom and the drift instead of
// simply changing their pace. Mirrors Burin.h's UpdateMotionAnchor. This page is
// where a visitor is guaranteed to be dragging a Rate slider, so it needs this
// at least as much as the plugin does.
let cycleAnchor = 0;
let anchorSeconds = 0;
let anchorRate = -1;

function motionCycles(seconds, rate) {
  if (anchorRate < 0) {
    // First frame: anchor stays at zero, so this is exactly the old product
    // until Rate is touched.
    anchorRate = rate;
  } else if (rate !== anchorRate) {
    // Once per change, not once per frame.
    cycleAnchor += (seconds - anchorSeconds) * anchorRate;
    anchorSeconds = seconds;
    anchorRate = rate;
  }

  return cycleAnchor + (seconds - anchorSeconds) * rate;
}
const revealStaggerFromParam = (v) => {
  const t = clamp01(v);
  if (t < 0.05) return 0.0;
  const u = (t - 0.05) / 0.95;
  return u * u * 4.0;
};
function spinFromParam(v) {
  const x = clamp01(v) * 2.0 - 1.0;
  const m = Math.pow(Math.abs(x), 3.0);
  return (x < 0 ? -m : m) * 4.0;
}
function strokeScaleFromParam(v) {
  const t = clamp01(v);
  if (t <= 0.5) { const u = t * 2.0; return u * u; }
  const u = (t - 0.5) * 2.0;
  return 1.0 + u * u * 7.0;
}
function detailFromParam(v) {
  const t = clamp01(v);
  if (t <= 0.5) return expMap(t * 2.0, 0.25, 1.0);
  return expMap((t - 0.5) * 2.0, 1.0, 2.0);
}

//---------------------------------------------------------------------------
// Motion.cpp
//---------------------------------------------------------------------------
const frac = (x) => x - Math.floor(x);

function waveValue(wave, cycles) {
  const t = frac(cycles);
  switch (wave) {
    case 0: return Math.sin(t * Math.PI * 2);
    case 1: return t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4;
    case 2: return t * 2 - 1;
    default: return t < 0.5 ? 1 : -1;
  }
}

function solveMotion(s, cycles) {
  const wx = waveValue(s.wave, cycles);
  // A quarter cycle apart, so a pair of drifts is an ellipse and not a diagonal.
  const wy = waveValue(s.wave, cycles + 0.25);
  return {
    zoom: s.zoom * Math.pow(2, s.zoomMove * wx),
    panX: s.panX + s.driftX * wx,
    panY: s.panY + s.driftY * wy,
    rotate: s.rotate + s.spin * cycles * Math.PI * 2,
  };
}

//---------------------------------------------------------------------------
// Raster.cpp — the ladder. The whole point of the demo's HUD.
//---------------------------------------------------------------------------
const RUNGS_PER_OCTAVE = 2;
const COVER_MARGIN = 0.125;
const MAX_RASTER_PX = 8192;

function snapScale(scale, extraRungs = 0) {
  if (!(scale > 0) || !isFinite(scale)) return 1;
  const rungs = Math.log2(scale) * RUNGS_PER_OCTAVE;
  // The epsilon before the ceil is not cosmetic: 1.0 is a rung, and an
  // un-zoomed drawing sits on it. Without this, accumulated error pushes the
  // most ordinary configuration there is onto the next rung and doubles its
  // pixel count.
  const snapped = Math.ceil(rungs - 1e-4) + extraRungs;
  return Math.pow(2, snapped / RUNGS_PER_OCTAVE);
}

const isAxisAligned = (rad) => {
  const turns = rad / (Math.PI / 2);
  return Math.abs(turns - Math.round(turns)) < 1e-3;
};

//---------------------------------------------------------------------------
// Reveal.cpp — the stagger arithmetic.
//---------------------------------------------------------------------------
function shapeProgress(slot, slotCount, globalProgress, stagger) {
  if (slot < 0 || slotCount <= 0) return 0;
  const p = clamp01(globalProgress);
  const s = Math.max(stagger, 0);
  if (s <= 0 || slotCount === 1) return p;
  const span = 1 + (slotCount - 1) * s;
  return clamp01(p * span - slot * s);
}

//---------------------------------------------------------------------------
// The drawing.
//---------------------------------------------------------------------------
const SHAPE_TAGS = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
const UNSUPPORTED_TAGS = ['text', 'tspan', 'image', 'use', 'clipPath', 'mask', 'filter', 'pattern'];

class Drawing {
  constructor(text) {
    this.ok = false;
    this.note = '';
    this.warnings = [];

    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) { this.note = 'not valid SVG'; return; }

    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') { this.note = 'no <svg> root'; return; }

    // The browser needs the element in a document to measure anything, so it is
    // parked off-screen rather than measured in the detached tree.
    this.svg = svg;
    this.stage = document.getElementById('measure');
    this.stage.innerHTML = '';
    this.stage.appendChild(svg);

    // Viewport, from viewBox or width/height.
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every((n) => isFinite(n))) {
      this.viewport = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    } else {
      const w = parseFloat(svg.getAttribute('width')) || 300;
      const h = parseFloat(svg.getAttribute('height')) || 150;
      this.viewport = { x: 0, y: 0, w, h };
    }

    // Shapes, with a snapshot of what the file said — the same job ShapeInfo
    // does in Document.h, and for the same reason: everything below writes into
    // these elements, so something has to remember the original.
    this.shapes = [];
    for (const el of svg.querySelectorAll(SHAPE_TAGS.join(','))) {
      let length = 0;
      try { length = typeof el.getTotalLength === 'function' ? el.getTotalLength() : 0; } catch (e) { length = 0; }
      const cs = getComputedStyle(el);
      this.shapes.push({
        el,
        length,
        fill: el.getAttribute('fill') ?? cs.fill ?? null,
        stroke: el.getAttribute('stroke') ?? cs.stroke ?? null,
        strokeWidth: parseFloat(el.getAttribute('stroke-width') ?? cs.strokeWidth) || 1,
        dashArray: el.getAttribute('stroke-dasharray'),
        dashOffset: el.getAttribute('stroke-dashoffset'),
        hasFill: (el.getAttribute('fill') ?? cs.fill ?? 'black') !== 'none',
        hasStroke: (el.getAttribute('stroke') ?? cs.stroke ?? 'none') !== 'none',
      });
    }

    // Content bounds, from the browser's own measurement, expanded for stroke.
    try {
      const b = svg.getBBox();
      this.content = { x: b.x, y: b.y, w: b.width, h: b.height };
    } catch (e) {
      this.content = { ...this.viewport };
    }
    if (!(this.content.w > 0 && this.content.h > 0)) this.content = { ...this.viewport };

    for (const tag of UNSUPPORTED_TAGS) {
      const n = svg.getElementsByTagName(tag).length;
      if (n > 0) this.warnings.push(`${n} <${tag}>`);
    }

    this.ok = this.shapes.length > 0;
    this.note = this.ok
      ? `${this.shapes.length} shape${this.shapes.length === 1 ? '' : 's'}, ` +
        `${Math.round(this.viewport.w)}×${Math.round(this.viewport.h)}`
      : 'nothing this can draw';
  }

  reset() {
    for (const s of this.shapes) {
      const set = (k, v) => (v === null || v === undefined ? s.el.removeAttribute(k) : s.el.setAttribute(k, v));
      set('fill', s.fill);
      set('stroke', s.stroke);
      s.el.setAttribute('stroke-width', s.strokeWidth);
      set('stroke-dasharray', s.dashArray);
      set('stroke-dashoffset', s.dashOffset);
      s.el.style.display = '';
    }
  }
}

//---------------------------------------------------------------------------
// Style.cpp + Reveal.cpp, applied to the DOM instead of to NSVGshape.
//---------------------------------------------------------------------------
function hueRotate(hex, turns) {
  if (!turns) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d <= 0) return hex;                       // a grey has no hue to rotate
  let h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  h = h / 6 + turns; h -= Math.floor(h);
  const s = mx > 0 ? d / mx : 0, v = mx;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  [r, g, b] = [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6];
  const to = (x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function applyStyleAndReveal(drawing, S, deviceScale) {
  drawing.reset();

  const n = drawing.shapes.length;
  const first = Math.min(Math.max(S.firstShape | 0, 0), Math.max(n - 1, 0));
  const count = Math.min(S.shapeCount > 0 ? S.shapeCount : n, n - first);
  const span = count > 1 ? count - 1 : 1;

  // The reveal order — a sort, cached in the plugin, recomputed here because a
  // demo is not the place to optimise.
  const members = [];
  for (let i = first; i < first + count; i++) members.push(i);
  const L = (i) => drawing.shapes[i].length;
  if (S.order === 1) members.reverse();
  else if (S.order === 2) members.sort((a, b) => L(b) - L(a));
  else if (S.order === 3) members.sort((a, b) => L(a) - L(b));
  else if (S.order === 4) members.sort((a, b) => ((a * 2654435761) % 1013) - ((b * 2654435761) % 1013));
  const slotOf = new Map(members.map((idx, slot) => [idx, slot]));

  for (let i = 0; i < n; i++) {
    const s = drawing.shapes[i];
    if (i < first || i >= first + count) { s.el.style.display = 'none'; continue; }

    // --- which halves are painted ---
    if (S.draw === 1) s.el.setAttribute('stroke', 'none');
    else if (S.draw === 2) s.el.setAttribute('fill', 'none');

    // --- stroke width, with the device-pixel floor ---
    let w = s.strokeWidth * S.strokeScale;
    if (S.strokeMinPx > 0 && deviceScale > 0) w = Math.max(w, S.strokeMinPx / deviceScale);
    s.el.setAttribute('stroke-width', w);

    // --- colour ---
    if (S.recolour) {
      const t = count > 1 ? (i - first) / span : 0;
      const col = hueRotate(S.colour, S.colourSpread * t);
      if ((S.recolour === 1 || S.recolour === 3) && S.draw !== 2 && s.hasFill) s.el.setAttribute('fill', col);
      if ((S.recolour === 2 || S.recolour === 3) && S.draw !== 1 && s.hasStroke) s.el.setAttribute('stroke', col);
    }

    // --- the reveal ---
    if (S.revealMode) {
      const slot = slotOf.get(i);
      let p = shapeProgress(slot === undefined ? -1 : slot, count, S.progress, S.stagger);
      if (S.revealMode === 2) p = 1 - p;

      const drawsStroke = S.draw !== 1 && s.hasStroke;
      if (drawsStroke && s.length > 0) {
        // The same two special cases as Reveal.cpp, and for the same reasons:
        // at the ends a dash entry would be zero, and a finished stroke has to
        // be UNDASHED or every line join becomes a pair of caps.
        if (p <= 1e-3) s.el.setAttribute('stroke', 'none');
        else if (p >= 1 - 1e-3) { /* leave it alone */ }
        else {
          s.el.setAttribute('stroke-dasharray', `${s.length * p} ${s.length * (1 - p)}`);
          s.el.setAttribute('stroke-dashoffset', '0');
        }
      }

      if (S.draw !== 2 && s.hasFill) {
        let a;
        if (S.fillWindow <= 0) a = p > 0 ? 1 : 0;
        else {
          const x = clamp01((p - (1 - S.fillWindow)) / S.fillWindow);
          a = x * x * (3 - 2 * x);
        }
        s.el.setAttribute('fill-opacity', a);
      }
    } else {
      s.el.removeAttribute('fill-opacity');
    }
  }
}

//---------------------------------------------------------------------------
// The demo itself.
//---------------------------------------------------------------------------
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const noteEl = document.getElementById('note');
const warnEl = document.getElementById('warn');

let drawing = null;
let raster = { canvas: document.createElement('canvas'), scale: 1, cover: null, w: 0, h: 0 };
let cacheKey = '';
let rebuilds = 0;
let pending = false;
let startTime = performance.now();

const P = {};
function readControls() {
  for (const el of document.querySelectorAll('[data-param]')) {
    P[el.dataset.param] = el.type === 'checkbox' ? (el.checked ? 1 : 0)
      : el.type === 'color' ? el.value
      : parseFloat(el.value);
  }
}

function settings() {
  return {
    draw: P.draw | 0,
    strokeScale: strokeScaleFromParam(P.strokeWidth),
    strokeMinPx: P.strokeMin * 4,
    recolour: P.recolour | 0,
    colour: P.colour,
    colourSpread: P.colourSpread * 2 - 1,
    firstShape: P.firstShape | 0,
    shapeCount: P.shapeCount | 0,
    revealMode: P.revealMode | 0,
    stagger: revealStaggerFromParam(P.stagger),
    order: P.order | 0,
    fillWindow: P.fillFade,
    progress: 1,
  };
}

function transformFor(motion, box, frameW, frameH) {
  const sx = frameW / Math.max(box.w, 1e-6);
  const sy = frameH / Math.max(box.h, 1e-6);
  const base = P.fit === 0 ? Math.min(sx, sy) : Math.max(sx, sy);
  let ax = 1, ay = 1;
  if (P.fit === 2) { ax = sx / base; ay = sy / base; }

  const scaleX = base * motion.zoom * ax;
  const scaleY = base * motion.zoom * ay;
  const c = Math.cos(motion.rotate), s = Math.sin(motion.rotate);
  const panX = motion.panX * box.w * base;
  const panY = motion.panY * box.h * base;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  const a = c * scaleX, b = s * scaleX, cc = -s * scaleY, d = c * scaleY;
  return {
    a, b, c: cc, d,
    e: frameW / 2 + panX - (a * cx + cc * cy),
    f: frameH / 2 + panY - (b * cx + d * cy),
    base,
  };
}

function invert(t) {
  const det = t.a * t.d - t.b * t.c;
  if (Math.abs(det) < 1e-12) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const i = 1 / det;
  return {
    a: t.d * i, b: -t.b * i, c: -t.c * i, d: t.a * i,
    e: (t.c * t.f - t.d * t.e) * i, f: (t.b * t.e - t.a * t.f) * i,
  };
}

function visibleRect(inv, w, h, margin) {
  const xs = [], ys = [];
  for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    xs.push(inv.a * px + inv.c * py + inv.e);
    ys.push(inv.b * px + inv.d * py + inv.f);
  }
  let minx = Math.min(...xs), maxx = Math.max(...xs);
  let miny = Math.min(...ys), maxy = Math.max(...ys);
  const mx = (maxx - minx) * margin, my = (maxy - miny) * margin;
  return { minx: minx - mx, maxx: maxx + mx, miny: miny - my, maxy: maxy + my };
}

function rebuild(S, want, scale) {
  if (pending) return;                       // one rasterise in flight at a time
  pending = true;

  const w = Math.max(1, Math.min(MAX_RASTER_PX, Math.ceil((want.maxx - want.minx) * scale)));
  const h = Math.max(1, Math.min(MAX_RASTER_PX, Math.ceil((want.maxy - want.miny) * scale)));

  applyStyleAndReveal(drawing, S, scale);

  // The window of the document being covered, expressed as a viewBox — which is
  // how the browser is told to rasterise a sub-rectangle at a chosen size.
  const svg = drawing.svg;
  const savedVB = svg.getAttribute('viewBox');
  const savedW = svg.getAttribute('width');
  const savedH = svg.getAttribute('height');
  svg.setAttribute('viewBox', `${want.minx} ${want.miny} ${want.maxx - want.minx} ${want.maxy - want.miny}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  const text = new XMLSerializer().serializeToString(svg);

  if (savedVB === null) svg.removeAttribute('viewBox'); else svg.setAttribute('viewBox', savedVB);
  if (savedW === null) svg.removeAttribute('width'); else svg.setAttribute('width', savedW);
  if (savedH === null) svg.removeAttribute('height'); else svg.setAttribute('height', savedH);

  const img = new Image();
  img.onload = () => {
    raster.canvas.width = w;
    raster.canvas.height = h;
    const rc = raster.canvas.getContext('2d');
    rc.clearRect(0, 0, w, h);
    rc.drawImage(img, 0, 0, w, h);
    raster.scale = scale;
    raster.cover = want;
    raster.w = w; raster.h = h;
    rebuilds++;
    pending = false;
  };
  img.onerror = () => { pending = false; };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
}

function frame() {
  requestAnimationFrame(frame);
  if (!drawing || !drawing.ok) return;

  readControls();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const frameW = Math.round(cssW * dpr), frameH = Math.round(cssH * dpr);
  if (canvas.width !== frameW || canvas.height !== frameH) {
    canvas.width = frameW; canvas.height = frameH;
  }

  const seconds = (performance.now() - startTime) / 1000;
  const rate = rateFromParam(P.rate);
  const cycles = P.sync === 1 ? clamp01(P.phase) : motionCycles(seconds, rate);

  const motion = solveMotion({
    zoom: zoomFromParam(P.zoom),
    zoomMove: zoomMoveFromParam(P.zoomMove),
    panX: panFromParam(P.posX), panY: panFromParam(P.posY),
    driftX: driftFromParam(P.driftX), driftY: driftFromParam(P.driftY),
    rotate: rotateFromParam(P.rotate), spin: spinFromParam(P.spin),
    wave: P.wave | 0,
  }, cycles);

  const S = settings();
  S.progress = S.revealMode === 3 || P.sync === 1 ? clamp01(P.progress)
    : S.revealMode === 0 ? 1 : frac(cycles);
  if (S.revealMode === 3) S.revealMode = 1;

  const box = P.bounds === 1 ? drawing.content : drawing.viewport;
  const fwd = transformFor(motion, box, frameW, frameH);
  const inv = invert(fwd);

  const deviceScale = Math.sqrt(Math.abs(fwd.a * fwd.d - fwd.b * fwd.c));
  const extra = isAxisAligned(motion.rotate) ? 0 : 1;
  const scale = snapScale(deviceScale * detailFromParam(P.detail), extra);

  const need = visibleRect(inv, frameW, frameH, 0);
  const want = visibleRect(inv, frameW, frameH, COVER_MARGIN);

  const pad = 3 / Math.max(scale, 1e-6);
  const ink = drawing.content;
  const clip = { minx: ink.x - pad, miny: ink.y - pad, maxx: ink.x + ink.w + pad, maxy: ink.y + ink.h + pad };
  for (const r of [need, want]) {
    r.minx = Math.max(r.minx, clip.minx); r.miny = Math.max(r.miny, clip.miny);
    r.maxx = Math.min(r.maxx, clip.maxx); r.maxy = Math.min(r.maxy, clip.maxy);
  }

  // The cache rule, and the reason there are two rectangles: the test is
  // against `need`, so a pan is free until it has travelled the whole margin.
  const key = JSON.stringify([scale, S]);
  const covered = raster.cover &&
    raster.cover.minx <= need.minx && raster.cover.miny <= need.miny &&
    raster.cover.maxx >= need.maxx && raster.cover.maxy >= need.maxy;

  if (want.maxx > want.minx && want.maxy > want.miny && (key !== cacheKey || !covered)) {
    cacheKey = key;
    rebuild(S, want, scale);
  }

  // --- draw ---
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, frameW, frameH);
  if (P.backOpacity > 0) {
    ctx.globalAlpha = P.backOpacity;
    ctx.fillStyle = P.background;
    ctx.fillRect(0, 0, frameW, frameH);
    ctx.globalAlpha = 1;
  }

  if (raster.cover && raster.w > 0) {
    ctx.save();
    ctx.globalAlpha = clamp01(P.opacity);
    ctx.imageSmoothingQuality = 'high';
    // Document units -> frame pixels, then the raster's own origin and scale.
    ctx.setTransform(fwd.a, fwd.b, fwd.c, fwd.d, fwd.e, fwd.f);
    ctx.translate(raster.cover.minx, raster.cover.miny);
    ctx.scale(1 / raster.scale, 1 / raster.scale);
    ctx.drawImage(raster.canvas, 0, 0);
    ctx.restore();
  }

  hud.textContent =
    `wants ${deviceScale.toFixed(2)} px/unit   ` +
    `rung ${scale.toFixed(2)}   ` +
    `raster ${raster.w}×${raster.h}   ` +
    `rebuilds ${rebuilds}`;
}

//---------------------------------------------------------------------------
// Loading
//---------------------------------------------------------------------------
function load(text, name) {
  const d = new Drawing(text);
  if (!d.ok) {
    noteEl.textContent = `${name}: ${d.note}`;
    noteEl.className = 'note bad';
    return;
  }
  drawing = d;
  raster.cover = null;
  cacheKey = '';
  rebuilds = 0;
  startTime = performance.now();

  noteEl.textContent = `${name} — ${d.note}`;
  noteEl.className = 'note';

  // The warning that matters most. The browser renders text and the plugin does
  // not, so a file that looks perfect here can come out missing in Resolume --
  // which would make this demo a way of recommending a file that then fails.
  const text_ = d.warnings.filter((w) => /<text|<tspan/.test(w));
  if (d.warnings.length) {
    warnEl.innerHTML = text_.length
      ? `<strong>This drawing contains live text.</strong> The browser is drawing it; ` +
        `<strong>the plugin will not</strong> — nanosvg has no text support at all. ` +
        `Convert text to outlines before using this file in Resolume. ` +
        `(Also ignored: ${d.warnings.join(', ')}.)`
      : `The plugin ignores: ${d.warnings.join(', ')}. They are drawn here and will be missing there.`;
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => load(String(reader.result), file.name);
  reader.readAsText(file);
}

document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
document.getElementById('file').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

document.getElementById('reset').addEventListener('click', () => {
  for (const el of document.querySelectorAll('[data-param]')) el.value = el.dataset.default ?? el.value;
  startTime = performance.now();
  rebuilds = 0;
});

fetch('example-plate.svg')
  .then((r) => r.text())
  .then((t) => load(t, 'example-plate.svg'))
  .catch(() => { noteEl.textContent = 'drop an SVG to begin'; });

readControls();
requestAnimationFrame(frame);
