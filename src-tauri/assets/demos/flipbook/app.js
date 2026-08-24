// `?embed=1` -- output only, for use as a video source (OBS browser source,
// WebLinked). Set before anything renders so the canvas measures the full
// viewport on its first sizing pass rather than the boxed layout's.
const embedParam = new URLSearchParams(location.search).get('embed');
if (embedParam !== null && embedParam !== '0') document.body.dataset.embed = '';
/*
    The Flipbook web demo: the real playback and placement running in WebGL2.

    Drop a sprite sheet on it and it plays. That is the demo — a plugin whose
    whole job is playing somebody else's artwork is best argued for with the
    visitor's own artwork, and a page that can only show two sheets we made
    is a page that has assumed the answer.

    ## What is a port and what is a reimplementation

    The shader passes in shaders.js are a PORT of source/Shaders.cpp — same
    arithmetic, ES 3.00 header. The three blocks below (Controls, Playback,
    Placement) are ports of the C++ files of the same names, line for line,
    and they are the ones to check when the plugin's maths changes:

      Controls.cpp   the 0..1 slider curves
      Playback.cpp   FrameClock / FrameOffset / RunLength
      Placement.cpp  SolveCopies, and the short-edge correction

    They are ports rather than shared code because nothing here is compiled:
    this is a demo, not a second build of the plugin, and the plugin's own
    harness (fbtest) is what actually tests the C++.

    ## What this demo cannot do

    An animated GIF loads as its first frame only, because that is all a
    browser's <img> decoder gives back. The plugin decodes every frame and
    lays them out into a grid itself. The page says so rather than quietly
    showing one still.
*/

import { BACKGROUND_VERT, BACKGROUND_FRAG, SPRITE_VERT, SPRITE_FRAG } from './shaders.js';

const canvas = document.getElementById('view');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true });
const failBox = document.getElementById('fail');
const fail = (msg) => {
	failBox.textContent = msg;
	failBox.style.display = 'block';
	throw new Error(msg);
};
if (!gl) fail('This demo needs WebGL2, which this browser refused to give it.');

const MAX_COPIES = 64;
const MAX_GRID = 64;

// --------------------------------------------------------------------------
// Controls.cpp — every continuous parameter is 0..1 and mapped here.
// --------------------------------------------------------------------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const geometric = (v, lo, hi) => lo * Math.pow(hi / lo, clamp01(v));
const linear = (v, lo, hi) => lo + (hi - lo) * clamp01(v);

const map = {
	rate: (v) => geometric(v, 0.5, 60.0),
	scale: (v) => {
		// Two geometric segments meeting at exactly 1.0 in the middle. A single
		// 0.05..4 exponential would put 1.0 at 0.73 of the travel.
		const t = clamp01(v);
		return t <= 0.5 ? geometric(t / 0.5, 0.05, 1.0) : geometric((t - 0.5) / 0.5, 1.0, 4.0);
	},
	rotation: (v) => linear(v, -Math.PI, Math.PI),
	spread: (v) => linear(v, 0.0, 1.5),
	stagger: (v) => {
		// A dead zone at the bottom, so "all copies in step" is reachable by
		// dragging to zero rather than by luck.
		const t = clamp01(v);
		return t < 0.05 ? 0.0 : linear((t - 0.05) / 0.95, 0.0, 8.0);
	},
	seed: (v) => 1 + Math.round(clamp01(v) * 9998),
	tolerance: (v) => clamp01(v) * clamp01(v),
	softness: (v) => clamp01(v) * clamp01(v) * 0.5,
};

// --------------------------------------------------------------------------
// Playback.cpp
// --------------------------------------------------------------------------
function runLength(start, frameCount, cells) {
	const total = Math.max(1, cells);
	const from = Math.min(Math.max(start, 0), total - 1);
	if (frameCount <= 0) return Math.max(1, total - from);
	// Not clamped to the end of the sheet: CellRect wraps, so a run that starts
	// near the last cell and asks for more comes round to the beginning.
	return Math.max(1, Math.min(frameCount, total));
}

function frameClock(seconds, rate, manualPhase, length, manual) {
	const run = Math.max(1, length);
	if (manual) {
		// Across exactly one pass. The span is length - 1 so the top of the
		// travel is the LAST frame rather than one past it.
		return clamp01(manualPhase) * (run - 1);
	}
	return seconds * rate;
}

function frameOffset(framePos, length, mode) {
	const run = Math.max(1, length);
	if (run === 1) return 0;

	// Floor, not truncate: a negative clock would otherwise stutter on one
	// frame every time it crossed the origin.
	const floored = Math.floor(framePos);

	if (mode === 2) return Math.min(Math.max(floored, 0), run - 1);   // Once
	if (mode === 1) {
		// Period 2N-2, not 2N, so the first and last frames are held for one
		// frame each like every other — the naive version holds both ends for
		// two, which reads as a hitch at each turn.
		const period = 2 * run - 2;
		let step = floored % period;
		if (step < 0) step += period;
		return step < run ? step : period - step;
	}
	let step = floored % run;                                          // Loop
	if (step < 0) step += run;
	return step;
}

// --------------------------------------------------------------------------
// Placement.cpp
// --------------------------------------------------------------------------
function hashU32(x) {
	x = (x ^ 61) ^ (x >>> 16);
	x = (x + (x << 3)) >>> 0;
	x = x ^ (x >>> 4);
	x = Math.imul(x, 0x27d4eb2d) >>> 0;
	x = x ^ (x >>> 15);
	return x >>> 0;
}
const hash2 = (a, b) => hashU32((Math.imul(a, 0x9e3779b9) >>> 0) ^ hashU32(b));
const hash01 = (a, b) => hash2(a, b) / 4294967296;
const hash11 = (a, b) => hash01(a, b) * 2 - 1;

function shortEdge(width, height) {
	// A size given as a fraction of the short edge has to be divided by the long
	// axis's length in short-edge units before it can be a fraction of that
	// axis. On 16:9 that is (9/16, 1).
	if (width <= 0 || height <= 0) return [1, 1];
	return width >= height ? [height / width, 1] : [1, width / height];
}

function solveCopies(s) {
	const count = Math.min(Math.max(s.copies, 1), MAX_COPIES);
	const [sx, sy] = shortEdge(s.width, s.height);
	const frameAspect = s.height > 0 ? s.width / s.height : 1;
	const cellAspect = s.cellAspect > 0.0001 ? s.cellAspect : 1;

	// Fit decides the base half-extents; Scale multiplies whichever it was, so
	// 1.0 means "the size Fit said" in all three modes.
	let halfW = 0.5, halfH = 0.5;
	if (s.fit === 0) {                    // Native
		halfH = 0.5 * sy;
		halfW = 0.5 * cellAspect * sx;
	} else if (s.fit === 1) {             // Fill — defined against the frame, so
		if (cellAspect > frameAspect) {   // no short-edge correction anywhere
			halfH = 0.5;
			halfW = 0.5 * cellAspect / frameAspect;
		} else {
			halfW = 0.5;
			halfH = 0.5 * frameAspect / cellAspect;
		}
	}                                     // Stretch: 0.5, 0.5

	halfW *= s.scale;
	halfH *= s.scale;

	// Applied to the half-extents rather than to the texture coordinates, so a
	// flip composes with rotation the way it looks like it should.
	if (s.flipH) halfW = -halfW;
	if (s.flipV) halfH = -halfH;

	const gridColumns = Math.max(1, Math.ceil(Math.sqrt(count)));
	const gridRows = Math.max(1, Math.ceil(count / gridColumns));

	const out = [];
	for (let i = 0; i < count; i++) {
		const copy = {
			cx: s.centreX, cy: s.centreY,
			halfW, halfH,
			// A chase, not chaos: copy i is i * stagger frames behind copy 0 in
			// every arrangement, scattered ones included.
			phaseOffset: i * s.stagger,
		};

		if (s.arrange === 1) {            // Ring — twelve o'clock first, clockwise
			const angle = -Math.PI * 0.5 + 2 * Math.PI * i / count;
			const r = s.spread * 0.5;
			copy.cx = s.centreX + Math.cos(angle) * r * sx;
			copy.cy = s.centreY + Math.sin(angle) * r * sy;
		} else if (s.arrange === 2) {     // Scatter — seeded by the copy index, so
			                              // adding a copy leaves the rest put
			copy.cx = s.centreX + hash11(i, s.seed) * s.spread * 0.5 * sx;
			copy.cy = s.centreY + hash11(i, (s.seed ^ 0x5bf03635) >>> 0) * s.spread * 0.5 * sy;
		} else if (count > 1) {           // Grid — centred on the whole grid
			const column = i % gridColumns;
			const row = Math.floor(i / gridColumns);
			const offsetX = column - (gridColumns - 1) * 0.5;
			const offsetY = row - (gridRows - 1) * 0.5;
			const step = s.spread / Math.max(gridColumns, gridRows);
			copy.cx = s.centreX + offsetX * step * sx;
			copy.cy = s.centreY + offsetY * step * sy;
		}

		out.push(copy);
	}
	return out;
}

// --------------------------------------------------------------------------
// Sheet.cpp — the grid arithmetic. Wrap, not clamp.
// --------------------------------------------------------------------------
function cellRect(columns, rows, index) {
	const cells = Math.max(1, columns * rows);
	let cell = index % cells;
	if (cell < 0) cell += cells;
	const cw = 1 / columns, ch = 1 / rows;
	const u0 = (cell % columns) * cw;
	const v0 = Math.floor(cell / columns) * ch;
	return [u0, v0, u0 + cw, v0 + ch];
}

// --------------------------------------------------------------------------
// GL
// --------------------------------------------------------------------------
function compile(vertSrc, fragSrc, label) {
	const make = (type, src) => {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
			fail(`${label} would not compile: ${gl.getShaderInfoLog(sh)}`);
		return sh;
	};
	const program = gl.createProgram();
	gl.attachShader(program, make(gl.VERTEX_SHADER, vertSrc));
	gl.attachShader(program, make(gl.FRAGMENT_SHADER, fragSrc));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS))
		fail(`${label} would not link: ${gl.getProgramInfoLog(program)}`);
	return program;
}

const background = compile(BACKGROUND_VERT, BACKGROUND_FRAG, 'the background pass');
const sprite = compile(SPRITE_VERT, SPRITE_FRAG, 'the sprite pass');

// Core profile will not draw without one bound, even attributeless.
const emptyVAO = gl.createVertexArray();

// A sampler rather than texture parameters, mirroring the plugin — where it
// exists because the input-as-sheet mode borrows the host's texture and must
// not modify it.
const sampler = gl.createSampler();
gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const sheetTexture = gl.createTexture();
let sheetWidth = 1, sheetHeight = 1;
let sheetLoaded = false;

function uploadSheet(image) {
	gl.bindTexture(gl.TEXTURE_2D, sheetTexture);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	// UNPACK_PREMULTIPLY_ALPHA off: the shader wants straight alpha, because the
	// key is asked before anything is multiplied. This is the browser's version
	// of the same decision Sheet.h explains.
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
	// No mipmaps, deliberately: a mip level averages across cell boundaries, so
	// mip 3 of a sprite sheet is every sprite faintly containing its neighbours.
	gl.bindTexture(gl.TEXTURE_2D, null);
	sheetWidth = image.width;
	sheetHeight = image.height;
	sheetLoaded = true;
}

const uni = (program, name) => gl.getUniformLocation(program, name);
const U = {
	backColour: uni(background, 'BackColour'),
	xform: uni(sprite, 'Xform'),
	cell: uni(sprite, 'Cell'),
	rotation: uni(sprite, 'Rotation'),
	sheet: uni(sprite, 'Sheet'),
	inset: uni(sprite, 'Inset'),
	keyMode: uni(sprite, 'KeyMode'),
	keyColour: uni(sprite, 'KeyColour'),
	keyTolerance: uni(sprite, 'KeyTolerance'),
	keySoftness: uni(sprite, 'KeySoftness'),
	tint: uni(sprite, 'Tint'),
	opacity: uni(sprite, 'Opacity'),
};

// --------------------------------------------------------------------------
// State, in the plugin's own parameter space
// --------------------------------------------------------------------------
const state = {
	columns: 5, rows: 4, start: 0, frameCount: 0, sampling: 0,
	rate: 0.664, mode: 0, phase: 0, manual: false,
	fit: 0, centreX: 0.5, centreY: 0.5, scale: 0.5, rotation: 0.5, flipH: false, flipV: false,
	copies: 1, arrange: 0, spread: 0.6, stagger: 0, seed: 0,
	key: 0, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0,
	tintR: 1, tintG: 1, tintB: 1, opacity: 1,
	backR: 0, backG: 0, backB: 0, backOpacity: 1,
};

// Presets.h, verbatim, in the same order. A preset never touches the Sheet
// group — the visitor's own grid is not ours to redefine.
const PRESETS = {
	'As Exported': { rate: 0.664, mode: 0, sampling: 0, fit: 0, scale: 0.5, rotation: 0.5, copies: 1, arrange: 0, spread: 0.6, stagger: 0, key: 0, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'Full Frame': { rate: 0.52, mode: 0, sampling: 0, fit: 1, scale: 0.5, rotation: 0.5, copies: 1, arrange: 0, spread: 0.6, stagger: 0, key: 3, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'One Shot': { rate: 0.75, mode: 2, sampling: 0, fit: 0, scale: 0.72, rotation: 0.5, copies: 1, arrange: 0, spread: 0.6, stagger: 0, key: 1, keyR: 1, keyG: 1, keyB: 1, tolerance: 0.30, softness: 0.35, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'Swarm': { rate: 0.70, mode: 0, sampling: 0, fit: 0, scale: 0.24, rotation: 0.5, copies: 24, arrange: 2, spread: 0.60, stagger: 0.28, key: 0, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'Carousel': { rate: 0.664, mode: 0, sampling: 0, fit: 0, scale: 0.30, rotation: 0.5, copies: 12, arrange: 1, spread: 0.44, stagger: 0.17, key: 0, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'Pixel Nine': { rate: 0.62, mode: 0, sampling: 1, fit: 0, scale: 0.30, rotation: 0.5, copies: 9, arrange: 0, spread: 0.66, stagger: 0.13, key: 2, keyR: 0.10, keyG: 0.13, keyB: 0.22, tolerance: 0.22, softness: 0.12, tintR: 1, tintG: 1, tintB: 1, opacity: 1, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
	'Ghost': { rate: 0.35, mode: 1, sampling: 0, fit: 1, scale: 0.5, rotation: 0.5, copies: 1, arrange: 0, spread: 0.6, stagger: 0, key: 0, keyR: 0, keyG: 0, keyB: 0, tolerance: 0, softness: 0, tintR: 0.80, tintG: 0.86, tintB: 1.00, opacity: 0.35, backR: 0, backG: 0, backB: 0, backOpacity: 1 },
};

// --------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------
const xformData = new Float32Array(MAX_COPIES * 4);
const cellData = new Float32Array(MAX_COPIES * 4);
let started = performance.now();

function frame() {
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
	const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}

	gl.viewport(0, 0, width, height);
	gl.bindVertexArray(emptyVAO);
	gl.disable(gl.BLEND);

	gl.useProgram(background);
	gl.uniform4f(U.backColour, state.backR, state.backG, state.backB, state.backOpacity);
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

	if (sheetLoaded) {
		const cells = Math.max(1, state.columns * state.rows);
		const length = runLength(state.start, state.frameCount, cells);
		const seconds = (performance.now() - started) / 1000;
		const pos = frameClock(seconds, map.rate(state.rate), state.phase, length, state.manual);

		const cellW = sheetWidth / state.columns;
		const cellH = sheetHeight / state.rows;

		const copies = solveCopies({
			copies: state.copies, arrange: state.arrange,
			spread: map.spread(state.spread), stagger: map.stagger(state.stagger),
			seed: map.seed(state.seed),
			centreX: state.centreX, centreY: state.centreY,
			scale: map.scale(state.scale), fit: state.fit,
			cellAspect: cellH > 0 ? cellW / cellH : 1,
			width, height, flipH: state.flipH, flipV: state.flipV,
		});

		for (let i = 0; i < copies.length; i++) {
			const c = copies[i];
			xformData[i * 4 + 0] = c.cx;
			xformData[i * 4 + 1] = c.cy;
			xformData[i * 4 + 2] = c.halfW;
			xformData[i * 4 + 3] = c.halfH;

			const index = state.start + frameOffset(pos + c.phaseOffset, length, state.mode);
			const rect = cellRect(state.columns, state.rows, index);
			cellData.set(rect, i * 4);
		}

		gl.useProgram(sprite);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, sheetTexture);

		const filter = state.sampling === 1 ? gl.NEAREST : gl.LINEAR;
		gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
		gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
		gl.bindSampler(0, sampler);

		gl.uniform1i(U.sheet, 0);
		gl.uniform2f(U.inset, 0.5 / sheetWidth, 0.5 / sheetHeight);
		gl.uniform1f(U.rotation, map.rotation(state.rotation));
		gl.uniform1i(U.keyMode, state.key);
		gl.uniform3f(U.keyColour, state.keyR, state.keyG, state.keyB);
		gl.uniform1f(U.keyTolerance, map.tolerance(state.tolerance));
		gl.uniform1f(U.keySoftness, map.softness(state.softness));
		gl.uniform3f(U.tint, state.tintR, state.tintG, state.tintB);
		gl.uniform1f(U.opacity, state.opacity);
		gl.uniform4fv(U.xform, xformData.subarray(0, copies.length * 4));
		gl.uniform4fv(U.cell, cellData.subarray(0, copies.length * 4));

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, copies.length);

		gl.bindSampler(0, null);
	}

	requestAnimationFrame(frame);
}

// --------------------------------------------------------------------------
// Loading a sheet
// --------------------------------------------------------------------------
const sheetNote = document.getElementById('sheet-note');

function loadImage(src, name, columns, rows, animatedGif) {
	const image = new Image();
	image.crossOrigin = 'anonymous';
	image.onload = () => {
		uploadSheet(image);
		if (columns) setControl('columns', columns);
		if (rows) setControl('rows', rows);
		started = performance.now();
		let note = `${name} — ${image.width}×${image.height}`;
		if (animatedGif)
			note += '. An animated GIF loads as its FIRST FRAME here — a browser will not '
			      + 'give a page the rest. The plugin decodes them all and lays them out itself.';
		else if (image.width % state.columns || image.height % state.rows)
			note += `. Does not divide exactly by ${state.columns}×${state.rows} — expect a sliver `
			      + 'of the neighbouring cell down one edge.';
		sheetNote.textContent = note;
	};
	image.onerror = () => { sheetNote.textContent = `${name} would not decode.`; };
	image.src = src;
}

function acceptFile(file) {
	if (!file || !file.type.startsWith('image/')) {
		sheetNote.textContent = 'That is not an image.';
		return;
	}
	const reader = new FileReader();
	reader.onload = () => loadImage(reader.result, file.name, null, null, file.type === 'image/gif');
	reader.readAsDataURL(file);
}

const drop = document.getElementById('drop');
['dragenter', 'dragover'].forEach((event) =>
	drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((event) =>
	drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => acceptFile(e.dataTransfer.files[0]));

// The whole page accepts a drop, not only the little box: aiming at a 200px
// target with a file in hand is a worse experience than it needs to be.
['dragover', 'drop'].forEach((event) =>
	document.addEventListener(event, (e) => e.preventDefault()));
document.addEventListener('drop', (e) => {
	if (!drop.contains(e.target)) acceptFile(e.dataTransfer.files[0]);
});

document.getElementById('file').addEventListener('change', (e) => acceptFile(e.target.files[0]));

document.querySelectorAll('[data-sheet]').forEach((button) => {
	button.addEventListener('click', () => {
		loadImage(button.dataset.sheet, button.textContent.trim(),
		          Number(button.dataset.columns), Number(button.dataset.rows), false);
		if (button.dataset.preset) applyPreset(button.dataset.preset);
	});
});

// --------------------------------------------------------------------------
// Controls
// --------------------------------------------------------------------------
function setControl(key, value) {
	state[key] = value;
	const el = document.querySelector(`[data-key="${key}"]`);
	if (!el) return;
	if (el.type === 'checkbox') el.checked = !!value;
	else el.value = value;
	const readout = document.querySelector(`[data-readout="${key}"]`);
	if (readout) readout.textContent = format(key, value);
}

// Slider readouts in the units the parameter actually means, because "0.664"
// tells a visitor nothing and "12.0 fps" tells them everything.
function format(key, value) {
	const v = Number(value);
	switch (key) {
		case 'rate': return `${map.rate(v).toFixed(1)} fps`;
		case 'scale': return `${map.scale(v).toFixed(2)}×`;
		case 'rotation': return `${(map.rotation(v) * 180 / Math.PI).toFixed(0)}°`;
		case 'stagger': return `${map.stagger(v).toFixed(2)} frames`;
		case 'spread': return map.spread(v).toFixed(2);
		case 'seed': return String(map.seed(v));
		case 'copies': case 'columns': case 'rows':
		case 'start': case 'frameCount': return String(v);
		default: return v.toFixed(2);
	}
}

document.querySelectorAll('[data-key]').forEach((el) => {
	const key = el.dataset.key;
	const read = () => {
		if (el.type === 'checkbox') return el.checked;
		if (el.type === 'range') return Number(el.value);
		return Number(el.value);
	};
	el.addEventListener('input', () => {
		state[key] = read();
		const readout = document.querySelector(`[data-readout="${key}"]`);
		if (readout) readout.textContent = format(key, state[key]);
		if (key === 'mode' || key === 'start' || key === 'frameCount') started = performance.now();
	});
	const readout = document.querySelector(`[data-readout="${key}"]`);
	if (readout) readout.textContent = format(key, state[key]);
});

document.getElementById('manual').addEventListener('change', (e) => {
	state.manual = e.target.checked;
	document.getElementById('phase-row').style.opacity = state.manual ? '1' : '0.35';
});

function applyPreset(name) {
	const preset = PRESETS[name];
	if (!preset) return;
	Object.entries(preset).forEach(([key, value]) => setControl(key, value));
	started = performance.now();
}

document.querySelectorAll('[data-preset]').forEach((button) => {
	if (button.dataset.sheet) return;// handled by the sheet buttons
	button.addEventListener('click', () => applyPreset(button.dataset.preset));
});

document.getElementById('restart').addEventListener('click', () => { started = performance.now(); });

// The colour pickers. Here rather than in a second inline module in the page,
// which is where they started and where they did not work: both scripts are
// modules, modules are deferred and run in document order, so app.js dispatched
// its "ready" event before the inline listener existed and the three pickers
// were silently dead. A colour input is the one control whose value is not the
// number the plugin uses, which is the whole reason it needs its own handler —
// it does not need its own script.
const hexToRgb = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
const bindColour = (id, keys) => {
	const el = document.getElementById(id);
	if (!el) return;
	el.addEventListener('input', () => {
		const rgb = hexToRgb(el.value);
		keys.forEach((key, i) => { state[key] = rgb[i]; });
	});
};
bindColour('keyColour', ['keyR', 'keyG', 'keyB']);
bindColour('tint', ['tintR', 'tintG', 'tintB']);
bindColour('back', ['backR', 'backG', 'backB']);

// Exposed for the browser console and for the page's own smoke test.
window.flipbookState = state;

// Start on the burst, because a page that opens on nothing has to be read
// before it can be understood.
loadImage('example-sheet.png', 'example-sheet.png', 5, 4, false);
requestAnimationFrame(frame);
