/**
 * Idler — the browser demo.
 *
 * The Windows 95/98 screensaver suite, as two FFGL plugins: a source (`Idler`)
 * and an effect that composites over the clip (`Idler Mask`). This page runs the
 * plugin's own two shader programs on real pixels, driven by a JavaScript port
 * of the plugin's 3D engine and its savers.
 *
 * ## What is the plugin's, and what is not
 *
 * Idler is the odd one out in this fleet, and it is worth being exact about it
 * because the honesty question has a different answer here than on the other
 * demos.
 *
 * On tinsel, orrery, downpour and the rest, the plugin *is* a fragment shader:
 * copying the shader across means the demo runs the plugin's actual work. Idler
 * is not shaped like that. `source/Shaders.cpp` is 242 lines and two programs,
 * and almost nothing lives there — the scene shader lights and fogs a triangle
 * soup, and the composite shader blends the result over the clip. Everything
 * that makes Idler *Idler* is CPU-side: a small 3D engine and eleven savers that
 * build meshes into a `Scene`.
 *
 * So on this page:
 *
 * - **The two shader programs are the plugin's, copied character for character**
 *   from `source/Shaders.cpp`. `demo/tools/check_shaders.py` proves that, and it
 *   runs in `tools/verify.sh`.
 * - **Everything else is a hand port**, and a hand port is a second
 *   implementation. `Vec.h`, `Scene.h`, `Mesh.cpp`, `Hash.h`, `Controls.cpp` and
 *   the savers were translated by hand into the JavaScript below. Nothing checks
 *   that translation — there is no equivalent of `idtest --replay` or
 *   `--geometry` here. Where the C++ harness is the reason to believe the maths,
 *   this page is not. That is said on the page too, in `differences`.
 *
 * ## The one thing most likely to be subtly wrong
 *
 * Nine of the eleven savers are pure arithmetic on time. **3D Pipes and 3D Maze
 * grow**: where a pipe goes next depends on where it has been. They are made
 * pure by *deterministic replay* — the state at time `t` is by definition the
 * state reached by replaying from the seed to tick `floor(t * tickRate)`. The
 * cache is an optimisation that must never change the answer, so a changed seed,
 * a changed growth parameter, or a time earlier than the cache rebuilds from
 * tick zero.
 *
 * `Random` below is counter-based rather than a state machine for exactly this
 * reason: draw `n` is `Hash2(n, seed)` and depends on nothing before it, so a
 * replay resumed from a checkpoint draws the same numbers a replay from zero
 * would have. Get that wrong and the picture is still plausible — it is simply a
 * different maze.
 *
 * A browser tab that loses focus throttles, so a scrubbed or backgrounded page
 * can ask for a large forward jump; `kMaxReplaySteps` bounds it, as it does in
 * the plugin.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture } from './vendor/gl.js';

//===========================================================================
// The shaders, from source/Shaders.cpp.
//
// Copied, not rewritten. `port()` in the kit handles the version line and the
// precision qualifiers and nothing else. check_shaders.py compares these
// against the C++ character for character.
//===========================================================================

const SCENE_VERTEX = `#version 410 core

layout( location = 0 ) in vec3 vPosition;
layout( location = 1 ) in vec3 vNormal;
layout( location = 2 ) in vec4 vColour;
layout( location = 3 ) in vec3 vBarycentric;

uniform mat4 View;
uniform mat4 Proj;

out vec3 fNormal;
out vec4 fColour;
out vec3 fBarycentric;
out float fViewDepth;

void main()
{
	vec4 viewPosition = View * vec4( vPosition, 1.0 );

	// mat3( View ) is the correct normal matrix only because nothing here
	// scales non-uniformly -- the savers bake their scaling into the vertex
	// positions on the CPU. If one ever needs a non-uniform model scale it
	// needs the inverse transpose, and the symptom of skipping that is
	// lighting that slides across a stretched face.
	fNormal      = mat3( View ) * vNormal;
	fColour      = vColour;
	fBarycentric = vBarycentric;

	// Positive distance in front of the camera, for the fog. Negated because
	// the camera looks down -Z.
	fViewDepth = -viewPosition.z;

	gl_Position = Proj * viewPosition;
}
`;

const SCENE_FRAGMENT = `#version 410 core

in vec3 fNormal;
in vec4 fColour;
in vec3 fBarycentric;
in float fViewDepth;

out vec4 FragColour;

// 0 flat, 1 lit, 2 wireframe. An int rather than three programs because the
// branch is uniform across the draw call and costs nothing measurable, and
// three programs would be three things to keep in step.
uniform int ShadingMode;

// The direction the light travels, in VIEW space -- so the lighting does not
// swing round as a saver's camera orbits. A light fixed in world space reads as
// a searchlight following the object, which is not what any of these did.
uniform vec3 LightDirection;
uniform float Ambient;

// x = start, y = end, in view-space units. Disabled when y <= x.
uniform vec2 FogRange;

// Wireframe line half-width, in pixels.
uniform float EdgeWidth;

void main()
{
	vec3 rgb    = fColour.rgb;
	float alpha = fColour.a;

	if( ShadingMode != 0 )
	{
		vec3 n = normalize( fNormal );

		// Two-sided. The meshes here are closed solids, so a visible back face
		// means the near plane has cut into one -- which happens constantly in
		// 3D Maze, where the camera is inside the corridor. Lighting it by the
		// unflipped normal makes those fragments black and the wall looks
		// holed.
		if( !gl_FrontFacing )
			n = -n;

		float diffuse = max( dot( n, -LightDirection ), 0.0 );

		// Wrapped rather than clamped at the terminator. A pure Lambert on a
		// single light leaves half of every pipe dead black, and the original
		// used a second fill light to avoid exactly that; this is the cheap
		// equivalent.
		diffuse = diffuse * 0.75 + 0.25 * ( 0.5 + 0.5 * dot( n, -LightDirection ) );

		rgb *= Ambient + ( 1.0 - Ambient ) * diffuse;
	}

	if( ShadingMode == 2 )
	{
		// Distance to the nearest edge, in the barycentric's own units, scaled
		// by how fast it changes across a pixel -- which turns it into a
		// distance in pixels and keeps the line the same weight whatever the
		// triangle's size or the output resolution.
		vec3 delta = fwidth( fBarycentric );
		vec3 edges = smoothstep( vec3( 0.0 ), delta * EdgeWidth, fBarycentric );
		float edge = 1.0 - min( min( edges.x, edges.y ), edges.z );

		alpha *= edge;

		// Discard rather than write a transparent fragment: this runs with the
		// depth test on, and a fully transparent fragment still writes depth
		// and would punch a hole in whatever is behind it.
		if( alpha < 0.004 )
			discard;
	}

	if( FogRange.y > FogRange.x )
	{
		float fog = clamp( ( fViewDepth - FogRange.x ) / ( FogRange.y - FogRange.x ), 0.0, 1.0 );

		// Fades toward NOTHING, not toward black. That is what lets a corridor
		// recede into whatever is behind the plugin instead of into a black
		// rectangle the shape of the frame -- and it only works because the
		// target is premultiplied.
		alpha *= 1.0 - fog;
	}

	FragColour = vec4( rgb * alpha, alpha );
}
`;

const COMPOSITE_VERTEX = `#version 410 core

out vec2 fUV;

void main()
{
	vec2 position = vec2( ( gl_VertexID << 1 ) & 2, gl_VertexID & 2 );
	fUV = position;
	gl_Position = vec4( position * 2.0 - 1.0, 0.0, 1.0 );
}
`;

/**
 * The composite fragment shader.
 *
 * The C++ builds this by concatenation around a `#define`, so unlike every other
 * shader in the fleet it is not a single literal. `COMPOSITE_FRAGMENT_BODY` is
 * the literal part — that is what check_shaders.py compares — and this function
 * reproduces the same assembly the C++ `CompositeFragmentShader( bool )` does.
 */
const COMPOSITE_FRAGMENT_BODY = `
in vec2 fUV;
out vec4 FragColour;

// Premultiplied, from the off-screen target.
uniform sampler2D SceneTexture;

// 0 Over, 1 Reveal, 2 Hide, 3 Colourise. Only read when there is an input.
uniform int MaskMode;
uniform float MixAmount;

#ifdef HAS_INPUT
uniform sampler2D InputTexture;

// The input texture can be BIGGER than the picture -- the host hands over a
// power-of-two or pooled texture and says how much of it was really drawn.
// Sampling the whole thing pulls in undrawn padding down two edges.
uniform vec2 MaxUV;
#endif

void main()
{
	vec4 scene = texture( SceneTexture, fUV );

#ifdef HAS_INPUT
	// Half a texel inside, so that GL_LINEAR at the picture edge does not take
	// half its weight from the padding beyond MaxUV.
	vec2 inputUV = fUV * MaxUV;
	vec4 clip = texture( InputTexture, inputUV );

	vec4 result;
	if( MaskMode == 1 )// Reveal
	{
		result = clip * scene.a;
	}
	else if( MaskMode == 2 )// Hide
	{
		result = clip * ( 1.0 - scene.a );
	}
	else if( MaskMode == 3 )// Colourise
	{
		// Un-premultiply the saver's colour before tinting, or the tint is
		// darkened a second time by its own alpha at every soft edge.
		vec3 tint = scene.a > 0.0001 ? scene.rgb / scene.a : vec3( 0.0 );
		result = vec4( clip.rgb * tint, clip.a ) * scene.a;
	}
	else// Over
	{
		result = scene + clip * ( 1.0 - scene.a );
	}

	// Mix crossfades between the untouched clip and the result, so 0 is an
	// exact bypass in every mask mode -- including Hide, where "no effect" is
	// the clip and not transparency.
	FragColour = mix( clip, result, MixAmount );
#else
	// The source has nothing to composite against, so Mix is a straight fade
	// to transparent.
	FragColour = scene * MixAmount;
#endif
}
`;

function compositeFragmentShader(hasInput) {
  let source = '#version 410 core\n';
  if (hasInput) source += '#define HAS_INPUT 1\n';
  source += COMPOSITE_FRAGMENT_BODY;
  return source;
}

//===========================================================================
// Vec.h — just enough linear algebra, and no more.
//
// Column-major, like GL: m[c * 4 + r] is row r of column c, so a Float32Array
// of these goes straight to uniformMatrix4fv with transpose = false.
//===========================================================================

const kPi = 3.14159265358979323846;
const kTwoPi = 6.28318530717958647692;

const v3 = (x, y, z) => ({ x, y, z });
const v4 = (x, y, z, w) => ({ x, y, z, w });

const add3 = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul3 = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const mulv3 = (a, b) => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
const neg3 = (a) => ({ x: -a.x, y: -a.y, z: -a.z });

const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const cross3 = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const length3 = (v) => Math.sqrt(dot3(v, v));

/**
 * Normalise, tolerating a zero vector rather than returning NaNs.
 *
 * A NaN normal poisons the lighting for the whole draw call, not just that
 * triangle, because it propagates through the smooth-normal accumulation into
 * every vertex that shares the position.
 */
function normalise3(v) {
  const len = length3(v);
  if (len < 1e-12) return { x: 0, y: 0, z: 1 };
  return mul3(v, 1 / len);
}

const lerp3 = (a, b, t) => add3(a, mul3(sub3(b, a), t));

function mat4Identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Translate(t) {
  const m = mat4Identity();
  m[12] = t.x; m[13] = t.y; m[14] = t.z;
  return m;
}

function mat4Scale(s) {
  const m = mat4Identity();
  m[0] = s.x; m[5] = s.y; m[10] = s.z;
  return m;
}

function mat4RotateX(radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const m = mat4Identity();
  m[5] = c; m[6] = s;
  m[9] = -s; m[10] = c;
  return m;
}

function mat4RotateY(radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const m = mat4Identity();
  m[0] = c; m[2] = -s;
  m[8] = s; m[10] = c;
  return m;
}

function mat4RotateZ(radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  const m = mat4Identity();
  m[0] = c; m[1] = s;
  m[4] = -s; m[5] = c;
  return m;
}

/**
 * A rotation taking +Z onto `dir`.
 *
 * The up vector is chosen away from `dir` rather than fixed, because a pipe
 * travelling straight up is exactly the case a fixed +Y up vector degenerates
 * on — and pipes travel straight up constantly.
 */
function mat4AlignZTo(dir) {
  const f = normalise3(dir);
  const hint = Math.abs(f.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const r = normalise3(cross3(hint, f));
  const u = cross3(f, r);

  const out = mat4Identity();
  out[0] = r.x; out[1] = r.y; out[2] = r.z;
  out[4] = u.x; out[5] = u.y; out[6] = u.z;
  out[8] = f.x; out[9] = f.y; out[10] = f.z;
  return out;
}

function mat4LookAt(eye, centre, up) {
  const f = normalise3(sub3(centre, eye));
  const s = normalise3(cross3(f, up));
  const u = cross3(s, f);

  const r = mat4Identity();
  r[0] = s.x; r[4] = s.y; r[8] = s.z;
  r[1] = u.x; r[5] = u.y; r[9] = u.z;
  r[2] = -f.x; r[6] = -f.y; r[10] = -f.z;
  r[12] = -dot3(s, eye);
  r[13] = -dot3(u, eye);
  r[14] = dot3(f, eye);
  return r;
}

/**
 * Perspective projection, `fovY` in radians, vertical.
 *
 * Vertical rather than horizontal so that a saver composed for the frame height
 * keeps its framing as the composition gets wider — the behaviour a VJ expects
 * when the same clip is dropped on a 16:9 screen and a 4:1 LED banner.
 */
function mat4Perspective(fovY, aspect, nearZ, farZ) {
  const t = 1 / Math.tan(fovY * 0.5);
  const r = new Float32Array(16);
  r[0] = t / aspect;
  r[5] = t;
  r[10] = (farZ + nearZ) / (nearZ - farZ);
  r[11] = -1;
  r[14] = (2 * farZ * nearZ) / (nearZ - farZ);
  return r;
}

/** Orthographic projection, for the 2D savers. Same pipeline, depth test off. */
function mat4Ortho(l, r_, b, t, n, f) {
  const r = mat4Identity();
  r[0] = 2 / (r_ - l);
  r[5] = 2 / (t - b);
  r[10] = -2 / (f - n);
  r[12] = -(r_ + l) / (r_ - l);
  r[13] = -(t + b) / (t - b);
  r[14] = -(f + n) / (f - n);
  return r;
}

function mat4Mul(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = sum;
    }
  }
  return r;
}

/** Transform a point (w = 1), returning xyz. */
function mat4Point(m, v) {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14],
  };
}

/** Transform a direction: the rotation and scale, without the translation. */
function mat4Direction(m, v) {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z,
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z,
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z,
  };
}

/** HSV to RGB, hue in turns rather than degrees. */
function hsvToRgb(hueTurns, s, v) {
  const h = (hueTurns - Math.floor(hueTurns)) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));

  switch (i) {
    case 0: return v3(v, t, p);
    case 1: return v3(q, v, p);
    case 2: return v3(p, v, t);
    case 3: return v3(p, q, v);
    case 4: return v3(t, p, v);
    default: return v3(v, p, q);
  }
}

/**
 * A triangle wave on 0..1 with period 1, which is how every bounce in this
 * plugin is expressed.
 *
 * A bounce written as a triangle wave is a pure function of time; written as
 * "add velocity, test for a wall, negate" it is an integration whose speed is
 * whatever the frame rate happened to be.
 */
function triangleWave(t) {
  const f = t - Math.floor(t);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

//===========================================================================
// Hash.h — an exact integer hash, and the deterministic stream built on it.
//
// An integer hash rather than fract(sin(x) * 43758.5453) because the usual one
// is transcendental and differs between GPUs, drivers and CPUs. Pipes and Maze
// are REPLAYED from the seed, so a single hash disagreeing in its last bit does
// not shift one pixel — it sends the pipe down a different corridor.
//
// JavaScript has no uint32, so every step is forced back into 32 bits: `>>> 0`
// after the xorshifts and `Math.imul` for the multiplies. Writing `x * 0x7feb352d`
// instead would go through a double and lose the low bits — silently, and with a
// perfectly plausible-looking maze at the other end.
//===========================================================================

function hash32(x) {
  x = x >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}

/** Hash2(index, seed), so nudging the seed reshuffles rather than rotates. */
function hash2(a, b) {
  return hash32((a ^ hash32((b + 0x9e3779b9) >>> 0)) >>> 0);
}

function hash3(a, b, c) {
  return hash32((hash2(a, b) ^ hash32((c + 0x85ebca6b) >>> 0)) >>> 0);
}

/**
 * A hash to 0..1.
 *
 * Takes the TOP 24 bits — the widest slice that converts to a float32 without
 * rounding, so the conversion is exact and two machines cannot disagree in the
 * last bit.
 */
const unit = (h) => (h >>> 8) * (1 / 16777216);

const signed = (h) => unit(h) * 2 - 1;

/**
 * A counter-based random stream.
 *
 * This is a counter, not a state machine: draw `n` is `Hash2(n, seed)` and
 * depends on nothing that came before it. That is the property that makes replay
 * cheap and correct — a checkpoint is one integer, and a replay resumed at tick
 * 400 draws exactly the numbers a replay from tick 0 would have drawn by then.
 */
class Random {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.counter = 0;
  }

  reset(newSeed) {
    this.seed = newSeed >>> 0;
    this.counter = 0;
  }

  next() {
    const h = hash2(this.counter >>> 0, this.seed);
    this.counter = (this.counter + 1) >>> 0;
    return h;
  }

  unit01() { return unit(this.next()); }

  signed11() { return signed(this.next()); }

  /** A whole number in [0, n). */
  below(n) {
    return n <= 1 ? 0 : this.next() % (n >>> 0);
  }

  range(lo, hi) { return lo + (hi - lo) * this.unit01(); }
}

//===========================================================================
// Scene.h + Mesh.cpp — what a saver hands back, and the only thing the
// renderer knows how to draw.
//
// Eleven savers, one draw call. A saver never touches GL: it fills a Scene — a
// camera, a shading mode, and one triangle mesh — and the renderer uploads that.
//
// EVERYTHING IS TRIANGLES, INCLUDING THE LINES. A core profile is only required
// to support a line width of 1.0, and that is exactly what macOS gives, so
// glLineWidth(4) raises no error, sets no state, and draws hairlines. WebGL2 is
// no better. Since the whole look of Mystify is a fat ribbon, the line width has
// to be real geometry.
//===========================================================================

/** Wireframe line half-width in pixels, from the Line Width control. */
function edgeWidthPixels(lineWidth, width, height) {
  return 0.5 + lineWidth * 3.0 * Math.min(width, height) / 1080.0;
}

/** Shading modes, matching the enum in Scene.h. */
const Shading = { Flat: 0, Lit: 1, Wireframe: 2, Count: 3 };

const kFlatNormal = { x: 0, y: 0, z: 1 };

/** Perpendicular to a 2D direction, left-hand side. */
const perp2 = (d) => ({ x: -d.y, y: d.x });

function normaliseSafe2(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

/**
 * An indexed triangle mesh, plus the builders the savers actually use.
 *
 * Positions, normals and colours are kept in flat arrays rather than an array of
 * objects: this is rebuilt from scratch every frame at up to a few hundred
 * thousand vertices, and a fresh {x,y,z} per vertex per frame is how a demo like
 * this ends up spending its time in the garbage collector instead of on screen.
 */
class Mesh {
  constructor() {
    this.px = []; this.py = []; this.pz = [];
    this.nx = []; this.ny = []; this.nz = [];
    this.cr = []; this.cg = []; this.cb = []; this.ca = [];
    this.indices = [];
  }

  clear() {
    this.px.length = 0; this.py.length = 0; this.pz.length = 0;
    this.nx.length = 0; this.ny.length = 0; this.nz.length = 0;
    this.cr.length = 0; this.cg.length = 0; this.cb.length = 0; this.ca.length = 0;
    this.indices.length = 0;
  }

  get empty() { return this.indices.length === 0; }

  get triangleCount() { return this.indices.length / 3; }

  /** Index of the next vertex to be added. Callers use this as their base. */
  mark() { return this.px.length; }

  addVertex(p, n, c) {
    this.px.push(p.x); this.py.push(p.y); this.pz.push(p.z);
    this.nx.push(n.x); this.ny.push(n.y); this.nz.push(n.z);
    this.cr.push(c.x); this.cg.push(c.y); this.cb.push(c.z); this.ca.push(c.w);
  }

  addTriangle(a, b, c) {
    this.indices.push(a, b, c);
  }

  /** Two triangles over four already-added vertices, wound a-b-c-d. */
  addQuad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
  }

  //-------------------------------------------------------------------------
  // Flat builders, for the 2D savers. Z is written but the depth test is off;
  // draw order is index order.
  //-------------------------------------------------------------------------

  /**
   * A thick line segment in the XY plane, as a quad.
   *
   * `width` is the FULL width, so the quad reaches half of it either side of the
   * centre line — which is what makes a two-pixel line look two pixels wide
   * rather than four.
   */
  addLine(a, b, width, colourA, colourB) {
    const dir = normaliseSafe2({ x: b.x - a.x, y: b.y - a.y });
    const pn = perp2(dir);
    const n = { x: pn.x * width * 0.5, y: pn.y * width * 0.5 };

    const base = this.mark();
    this.addVertex({ x: a.x - n.x, y: a.y - n.y, z: 0 }, kFlatNormal, colourA);
    this.addVertex({ x: a.x + n.x, y: a.y + n.y, z: 0 }, kFlatNormal, colourA);
    this.addVertex({ x: b.x + n.x, y: b.y + n.y, z: 0 }, kFlatNormal, colourB);
    this.addVertex({ x: b.x - n.x, y: b.y - n.y, z: 0 }, kFlatNormal, colourB);
    this.addQuad(base, base + 1, base + 2, base + 3);
  }

  /**
   * A polyline with mitred joins.
   *
   * Mitred rather than each segment drawn on its own, because separate quads
   * leave a wedge-shaped notch on the outside of every corner. On a Mystify
   * polygon — which is nothing but corners — that reads as the line being
   * dashed. The mitre is limited to four times the width; past that the corner
   * is so sharp that an exact mitre would shoot a spike off across the frame, so
   * it falls back to a bevel.
   */
  addPolyline(points, count, closed, width, colours) {
    if (count < 2) return;

    const half = width * 0.5;
    const kMitreLimit = 4.0;

    const segmentCount = closed ? count : count - 1;
    const base = this.mark();

    for (let i = 0; i < count; i += 1) {
      const here = points[i];

      const hasPrev = closed || i > 0;
      const hasNext = closed || i < count - 1;

      const prevDir = hasPrev
        ? normaliseSafe2({ x: here.x - points[(i - 1 + count) % count].x, y: here.y - points[(i - 1 + count) % count].y })
        : normaliseSafe2({ x: points[i + 1].x - here.x, y: points[i + 1].y - here.y });
      const nextDir = hasNext
        ? normaliseSafe2({ x: points[(i + 1) % count].x - here.x, y: points[(i + 1) % count].y - here.y })
        : normaliseSafe2({ x: here.x - points[i - 1].x, y: here.y - points[i - 1].y });

      // The mitre direction bisects the two segment normals; its length is
      // 1/cos(theta/2), which is what makes the outer edge meet cleanly.
      const nPrev = perp2(prevDir);
      const nNext = perp2(nextDir);
      let mitre = normaliseSafe2({ x: nPrev.x + nNext.x, y: nPrev.y + nNext.y });

      const cosHalf = mitre.x * nPrev.x + mitre.y * nPrev.y;
      let scale = Math.abs(cosHalf) < 1e-4 ? kMitreLimit : 1 / cosHalf;
      if (scale > kMitreLimit || scale < -kMitreLimit) {
        mitre = nNext;
        scale = 1;
      }

      const offset = { x: mitre.x * half * scale, y: mitre.y * half * scale };
      const colour = colours ? colours[i] : v4(1, 1, 1, 1);

      this.addVertex({ x: here.x - offset.x, y: here.y - offset.y, z: 0 }, kFlatNormal, colour);
      this.addVertex({ x: here.x + offset.x, y: here.y + offset.y, z: 0 }, kFlatNormal, colour);
    }

    for (let s = 0; s < segmentCount; s += 1) {
      const i0 = base + s * 2;
      const i1 = base + ((s + 1) % count) * 2;
      this.addQuad(i0, i0 + 1, i1 + 1, i1);
    }
  }

  /** A filled axis-aligned rectangle. */
  addRect(min, max, colour) {
    const base = this.mark();
    this.addVertex({ x: min.x, y: min.y, z: 0 }, kFlatNormal, colour);
    this.addVertex({ x: max.x, y: min.y, z: 0 }, kFlatNormal, colour);
    this.addVertex({ x: max.x, y: max.y, z: 0 }, kFlatNormal, colour);
    this.addVertex({ x: min.x, y: max.y, z: 0 }, kFlatNormal, colour);
    this.addQuad(base, base + 1, base + 2, base + 3);
  }

  //-------------------------------------------------------------------------
  // Solid builders, for the 3D savers.
  //-------------------------------------------------------------------------

  addBox(centre, halfExtent, colour) {
    this.addTransformedBox(mat4Translate(centre), halfExtent, colour);
  }

  /**
   * A box transformed by an arbitrary matrix.
   *
   * Flat shaded, so each face carries its own four vertices. Sharing the eight
   * corners would average the three face normals at every corner and give a box
   * that looks like a rounded die.
   */
  addTransformedBox(transform, halfExtent, colour) {
    const corner = [
      v3(-halfExtent.x, -halfExtent.y, halfExtent.z),
      v3(halfExtent.x, -halfExtent.y, halfExtent.z),
      v3(halfExtent.x, halfExtent.y, halfExtent.z),
      v3(-halfExtent.x, halfExtent.y, halfExtent.z),
      v3(-halfExtent.x, -halfExtent.y, -halfExtent.z),
      v3(halfExtent.x, -halfExtent.y, -halfExtent.z),
      v3(halfExtent.x, halfExtent.y, -halfExtent.z),
      v3(-halfExtent.x, halfExtent.y, -halfExtent.z),
    ];

    for (let f = 0; f < 6; f += 1) {
      const base = this.mark();
      const n = normalise3(mat4Direction(transform, kBoxFaceNormals[f]));
      for (let c = 0; c < 4; c += 1) {
        this.addVertex(mat4Point(transform, corner[kBoxFaceCorners[f][c]]), n, colour);
      }
      this.addQuad(base, base + 1, base + 2, base + 3);
    }
  }

  /**
   * A cylinder along +Z from z=0 to z=length. Smooth-shaded around the barrel,
   * flat on the caps.
   */
  addCylinder(transform, radius, length, sides, colour, capStart, capEnd) {
    sides = Math.max(3, sides);

    const ringBase = this.mark();
    for (let i = 0; i <= sides; i += 1) {
      // The seam vertex is duplicated (i == sides repeats i == 0).
      const a = kTwoPi * (i % sides) / sides;
      const ca = Math.cos(a), sa = Math.sin(a);
      const n = normalise3(mat4Direction(transform, v3(ca, sa, 0)));

      this.addVertex(mat4Point(transform, v3(ca * radius, sa * radius, 0)), n, colour);
      this.addVertex(mat4Point(transform, v3(ca * radius, sa * radius, length)), n, colour);
    }

    for (let i = 0; i < sides; i += 1) {
      const a = ringBase + i * 2;
      this.addQuad(a, a + 2, a + 3, a + 1);
    }

    const addCap = (z, facingPositiveZ) => {
      const n = normalise3(mat4Direction(transform, v3(0, 0, facingPositiveZ ? 1 : -1)));
      const base = this.mark();

      this.addVertex(mat4Point(transform, v3(0, 0, z)), n, colour);
      for (let i = 0; i < sides; i += 1) {
        const a = kTwoPi * i / sides;
        this.addVertex(mat4Point(transform, v3(Math.cos(a) * radius, Math.sin(a) * radius, z)), n, colour);
      }
      for (let i = 0; i < sides; i += 1) {
        const a = base + 1 + i;
        const b = base + 1 + ((i + 1) % sides);
        if (facingPositiveZ) this.addTriangle(base, a, b);
        else this.addTriangle(base, b, a);
      }
    };

    if (capStart) addCap(0, false);
    if (capEnd) addCap(length, true);
  }

  /** A UV sphere, smooth shaded. */
  addSphere(transform, radius, rings, segments, colour) {
    rings = Math.max(2, rings);
    segments = Math.max(3, segments);

    const base = this.mark();
    for (let r = 0; r <= rings; r += 1) {
      const phi = kPi * r / rings;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let s = 0; s <= segments; s += 1) {
        const theta = kTwoPi * (s % segments) / segments;
        const nLocal = v3(sp * Math.cos(theta), cp, sp * Math.sin(theta));
        const n = normalise3(mat4Direction(transform, nLocal));
        this.addVertex(mat4Point(transform, mul3(nLocal, radius)), n, colour);
      }
    }

    const stride = segments + 1;
    for (let r = 0; r < rings; r += 1) {
      for (let s = 0; s < segments; s += 1) {
        const a = base + r * stride + s;
        const b = a + stride;
        this.addQuad(a, b, b + 1, a + 1);
      }
    }
  }

  /** A torus in the XY plane, smooth shaded. */
  addTorus(transform, majorRadius, minorRadius, majorSegments, minorSegments, colour) {
    majorSegments = Math.max(3, majorSegments);
    minorSegments = Math.max(3, minorSegments);

    const base = this.mark();
    for (let i = 0; i <= majorSegments; i += 1) {
      const u = kTwoPi * (i % majorSegments) / majorSegments;
      const cu = Math.cos(u), su = Math.sin(u);
      for (let j = 0; j <= minorSegments; j += 1) {
        const vv = kTwoPi * (j % minorSegments) / minorSegments;
        const cv = Math.cos(vv), sv = Math.sin(vv);

        const nLocal = v3(cu * cv, su * cv, sv);
        const pLocal = v3(
          cu * (majorRadius + minorRadius * cv),
          su * (majorRadius + minorRadius * cv),
          minorRadius * sv,
        );

        this.addVertex(mat4Point(transform, pLocal), normalise3(mat4Direction(transform, nLocal)), colour);
      }
    }

    const stride = minorSegments + 1;
    for (let i = 0; i < majorSegments; i += 1) {
      for (let j = 0; j < minorSegments; j += 1) {
        const a = base + i * stride + j;
        const b = a + stride;
        this.addQuad(a, a + 1, b + 1, b);
      }
    }
  }

  /**
   * Recompute every normal by area-weighted accumulation over the faces that
   * share each position.
   *
   * Un-normalised face normals on purpose: the magnitude is twice the triangle
   * area, so large faces pull harder than the slivers a morph throws off, which
   * stops a single degenerate triangle steering the shading of a whole region.
   *
   * Vertices at the same position must share a normal or the seam shows as a
   * crease, and the key is the EXACT bit pattern — the savers that call this
   * build their surfaces from patches that meet exactly, computed from the same
   * expression on both sides, not merely close. The C++ hashes the float bits;
   * here the key is the three numbers joined into a string, which distinguishes
   * exactly the same set of positions.
   */
  smoothNormals(fromVertex) {
    for (let i = fromVertex; i < this.px.length; i += 1) {
      this.nx[i] = 0; this.ny[i] = 0; this.nz[i] = 0;
    }

    const accumulated = new Map();
    const key = (i) => `${this.px[i]},${this.py[i]},${this.pz[i]}`;

    for (let t = 0; t + 2 < this.indices.length; t += 3) {
      const ia = this.indices[t], ib = this.indices[t + 1], ic = this.indices[t + 2];
      if (ia < fromVertex) continue;

      const ax = this.px[ia], ay = this.py[ia], az = this.pz[ia];
      const bx = this.px[ib] - ax, by = this.py[ib] - ay, bz = this.pz[ib] - az;
      const cx = this.px[ic] - ax, cy = this.py[ic] - ay, cz = this.pz[ic] - az;

      const fx = by * cz - bz * cy;
      const fy = bz * cx - bx * cz;
      const fz = bx * cy - by * cx;

      for (const index of [ia, ib, ic]) {
        const k = key(index);
        const acc = accumulated.get(k);
        if (acc) { acc.x += fx; acc.y += fy; acc.z += fz; }
        else accumulated.set(k, { x: fx, y: fy, z: fz });
      }
    }

    for (let i = fromVertex; i < this.px.length; i += 1) {
      const acc = accumulated.get(key(i)) ?? { x: 0, y: 0, z: 0 };
      const n = normalise3(acc);
      this.nx[i] = n.x; this.ny[i] = n.y; this.nz[i] = n.z;
    }
  }

  /** Append `other`, transformed. Every 3D Text glyph, every Flying Object. */
  append(other, transform) {
    const base = this.mark();
    for (let i = 0; i < other.px.length; i += 1) {
      const p = mat4Point(transform, v3(other.px[i], other.py[i], other.pz[i]));
      const n = normalise3(mat4Direction(transform, v3(other.nx[i], other.ny[i], other.nz[i])));
      this.px.push(p.x); this.py.push(p.y); this.pz.push(p.z);
      this.nx.push(n.x); this.ny.push(n.y); this.nz.push(n.z);
      this.cr.push(other.cr[i]); this.cg.push(other.cg[i]);
      this.cb.push(other.cb[i]); this.ca.push(other.ca[i]);
    }
    for (const i of other.indices) this.indices.push(base + i);
  }
}

// Counter-clockwise seen from outside, so back-face culling keeps the outside.
const kBoxFaceNormals = [
  v3(0, 0, 1), v3(0, 0, -1),
  v3(1, 0, 0), v3(-1, 0, 0),
  v3(0, 1, 0), v3(0, -1, 0),
];
const kBoxFaceCorners = [
  [0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2],
  [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0],
];

/**
 * One frame's worth of everything the renderer needs.
 *
 * Rebuilt from scratch every frame. There is no scene graph and nothing persists
 * between frames — the growing savers keep their state in their own objects, and
 * what lands here is always the finished picture for one instant.
 */
class Scene {
  constructor() {
    this.view = mat4Identity();
    this.proj = mat4Identity();
    this.mesh = new Mesh();
    this.depthTest = false;
    this.shading = Shading.Flat;
    this.lightDirection = normalise3(v3(-0.35, -0.6, -0.72));
    this.ambient = 0.28;
    this.background = v4(0, 0, 0, 1);
    this.fogStart = 0;
    this.fogEnd = 0;
  }

  clear() {
    this.mesh.clear();
    this.view = mat4Identity();
    this.proj = mat4Identity();
    this.depthTest = false;
    this.shading = Shading.Flat;
    this.fogStart = 0;
    this.fogEnd = 0;
  }
}

//===========================================================================
// Controls.h / Controls.cpp — host parameters, and what they mean.
//
// EVERY numeric parameter Idler declares is a plain 0..1 float, even where it
// stands for a maze size, a field of view in degrees or a seed. That is not a
// style preference: SetParamInfo clamps an FF_TYPE_STANDARD default into 0..1
// BEFORE returning, and SetParamRange can only be called afterwards — so a
// parameter declared in degrees cannot declare a default in degrees. The range
// lives in the conversion, and the host only ever sees 0..1.
//
// Option parameters are the exception: they hold the element value, not 0..1.
//===========================================================================

/** The savers, in the order they appear in the dropdown. */
const SaverKind = {
  Mystify: 0, Beziers: 1, Curves: 2, FlyingWindows: 3, Starfield: 4,
  Marquee: 5, Maze: 6, Pipes: 7, FlyingObjects: 8, FlowerBox: 9, Text3D: 10,
  Count: 11,
};

const SAVER_NAMES = [
  'Mystify', 'Beziers', 'Curves and Colors', 'Flying Windows',
  'Flying Through Space', 'Scrolling Marquee', '3D Maze', '3D Pipes',
  '3D Flying Objects', '3D FlowerBox', '3D Text',
];

const SYNC_NAMES = ['Free', 'Beat', 'Bar', 'Manual'];
const COLOUR_MODE_NAMES = ['Classic', 'Tint', 'Spread', 'Cycle'];
const MASK_MODE_NAMES = ['Over', 'Reveal', 'Hide', 'Colourise'];

const ColourMode = { Classic: 0, Tint: 1, Spread: 2, Cycle: 3, Count: 4 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * A slider that is exactly `centreValue` at 0.5 and exponential either side.
 *
 * Used wherever "off", "normal" or "none" sits in the middle of a range and has
 * to be findable by feel. A linear slider through 1 on a 0..4 range puts unity
 * at a quarter of the travel, which nobody hits by accident.
 */
function exponential(value, lo, centreValue, hi) {
  value = clamp01(value);
  if (value < 0.5) return lo * Math.pow(centreValue / lo, value * 2);
  return centreValue * Math.pow(hi / centreValue, (value - 0.5) * 2);
}

/**
 * Speed multiplier. 0..4, exponential, exactly 1 at the centre.
 *
 * The dead zone is a dead zone rather than an asymptote: an exponential curve
 * never reaches zero, so without it the only way to stop the animation is to
 * drag to exactly 0.0 and hope the host sends it.
 */
function speedFromParam(value) {
  value = clamp01(value);
  if (value < 0.02) return 0;
  return exponential((value - 0.02) / 0.98, 0.05, 1.0, 4.0);
}

/** Phase offset in seconds. 0..60. */
const phaseFromParam = (value) => clamp01(value) * 60;

/** The seed. 1..9999 — an integer, so nudging grows a DIFFERENT maze. */
function seedFromParam(value) {
  return (1 + Math.trunc(clamp01(value) * 9998 + 0.5)) >>> 0;
}

/** Vertical field of view in radians. 20..120 degrees. */
function fovFromParam(value) {
  const degrees = 20 + clamp01(value) * 100;
  return degrees * kPi / 180;
}

/** Camera tilt in radians. -60..60 degrees, exactly 0 at the centre. */
function camTiltFromParam(value) {
  return (clamp01(value) * 2 - 1) * (60 * kPi / 180);
}

const hueSpreadFromParam = (value) => clamp01(value);

/**
 * Hue rotation in turns per second. -0.5..0.5, exactly 0 at the centre.
 *
 * Squared so the useful slow drift occupies most of the travel; a linear slider
 * spends nine tenths of itself on speeds that strobe.
 */
function hueCycleFromParam(value) {
  const centred = clamp01(value) * 2 - 1;
  return centred * Math.abs(centred) * 0.5;
}

/**
 * Read an option parameter.
 *
 * Option parameters do NOT hold 0..1 — they hold the element value the operator
 * chose. The clamp is for a stale composition naming an element that no longer
 * exists.
 */
function option(value, count) {
  const index = Math.trunc(value + 0.5);
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * A colour for object `index` of `count`, honouring the colour mode.
 *
 * `classic` is what that saver would have used, so a saver states its own
 * palette and gets the four modes for free.
 */
function settingsColour(s, classic, index, count) {
  // The fan across a set is by index, so it is stable frame to frame: object 3
  // of 8 is the same hue next frame whatever the others did. Deriving it from
  // position or age instead would make the palette crawl.
  const fraction = count > 1 ? index / (count - 1) : 0;

  let rgb;
  switch (s.colourMode) {
    case ColourMode.Classic:
      rgb = classic;
      break;

    case ColourMode.Tint:
      // The classic colour's luminance, in the chosen hue. Keeping the luminance
      // is what stops Tint flattening a lit 3D saver into a silhouette — the
      // shading is in that number.
      rgb = mul3(s.tint, 0.2126 * classic.x + 0.7152 * classic.y + 0.0722 * classic.z);
      break;

    case ColourMode.Spread:
    case ColourMode.Cycle: {
      // The chosen colour sets the base hue and the saturation; the classic
      // colour still sets the brightness, for the same reason as above.
      const maxC = Math.max(s.tint.x, s.tint.y, s.tint.z);
      const minC = Math.min(s.tint.x, s.tint.y, s.tint.z);
      const sat = maxC > 1e-5 ? (maxC - minC) / maxC : 0;

      let baseHue = 0;
      if (maxC - minC > 1e-5) {
        const d = maxC - minC;
        if (maxC === s.tint.x) baseHue = (s.tint.y - s.tint.z) / d / 6;
        else if (maxC === s.tint.y) baseHue = (2 + (s.tint.z - s.tint.x) / d) / 6;
        else baseHue = (4 + (s.tint.x - s.tint.y) / d) / 6;
      }

      const spread = s.colourMode === ColourMode.Spread ? s.hueSpread * fraction : 0;
      const cycle = s.hueCycle * s.time;
      const value = 0.2126 * classic.x + 0.7152 * classic.y + 0.0722 * classic.z;

      rgb = hsvToRgb(baseHue + spread + cycle, sat > 0.02 ? sat : 1, value);
      break;
    }

    default:
      rgb = classic;
      break;
  }

  return v4(rgb.x, rgb.y, rgb.z, s.opacity);
}

/**
 * Every host parameter, mapped into a Settings — the one home.
 *
 * The FFGL plugin and the OpenFX one both call the C++ version of this with
 * their own 0..1 array, so the curves, ranges and the background premultiply
 * have exactly one home there. This is the port of it. `time` is saver time with
 * speed, sync and phase already folded in.
 */
function settingsFromParams(p, width, height, time, text, audioLevel) {
  const s = {};

  s.saver = option(p.get('saver'), SaverKind.Count);

  s.density = clamp01(p.get('density'));
  s.complexity = clamp01(p.get('complexity'));
  s.size = clamp01(p.get('size'));
  s.length = clamp01(p.get('length'));
  s.lineWidth = clamp01(p.get('lineWidth'));
  s.variation = clamp01(p.get('variation'));
  s.shading = option(p.get('shading'), Shading.Count);

  s.time = time;
  s.seed = seedFromParam(p.get('seed'));

  s.fov = fovFromParam(p.get('fov'));
  s.camDistance = clamp01(p.get('camDistance'));
  s.camTilt = camTiltFromParam(p.get('camTilt'));
  s.fog = clamp01(p.get('fog'));

  s.colourMode = option(p.get('colourMode'), ColourMode.Count);
  s.tint = v3(clamp01(p.get('colourR')), clamp01(p.get('colourG')), clamp01(p.get('colourB')));
  s.hueSpread = hueSpreadFromParam(p.get('hueSpread'));
  s.hueCycle = hueCycleFromParam(p.get('hueCycle'));
  s.opacity = clamp01(p.get('opacity'));

  const backAlpha = clamp01(p.get('backOpacity'));
  // Premultiplied, because that is what the target is cleared to and what the
  // scene shader writes.
  s.background = v4(
    clamp01(p.get('backR')) * backAlpha,
    clamp01(p.get('backG')) * backAlpha,
    clamp01(p.get('backB')) * backAlpha,
    backAlpha,
  );

  s.aspect = height > 0 ? width / height : 1;
  s.text = text;

  s.audioLevel = audioLevel;
  s.audioSize = clamp01(p.get('audioSize'));
  s.audioSpeed = clamp01(p.get('audioSpeed'));

  return s;
}

//===========================================================================
// Savers.cpp — the shared helpers, and the growing-saver base.
//===========================================================================

/**
 * The orthographic camera the 2D savers draw through.
 *
 * X runs -aspect..+aspect and Y runs -1..+1, so ONE UNIT IS HALF THE FRAME
 * HEIGHT at any aspect ratio. A saver sizing something in these units keeps its
 * proportions when the composition gets wider, and a circle is round. Getting
 * this wrong is invisible on a square render and draws ellipses on every real
 * output.
 */
function setFlatCamera(s, scene) {
  const halfWidth = Math.max(0.01, s.aspect);
  scene.proj = mat4Ortho(-halfWidth, halfWidth, -1, 1, -1, 1);
  scene.view = mat4Identity();
  scene.depthTest = false;
  scene.shading = Shading.Flat;
}

/**
 * A point bouncing inside the flat camera's box, as a pure function of time.
 *
 * Each point gets its own rate and starting phase from the hash, and each axis
 * is an independent triangle wave — so it travels in a straight line, turns the
 * instant it touches an edge, and does it without anything integrating a
 * velocity or testing for a collision.
 */
function bouncePoint(seed, index, time, rate, aspect, margin) {
  const hx = hash3(index >>> 0, seed, 0x1111);
  const hy = hash3(index >>> 0, seed, 0x2222);

  // Rates spread over roughly 3:2 rather than 1:2. Anything wider and the slow
  // axis is visibly slower than the fast one, which reads as the point sliding
  // along a wall rather than travelling across the box; anything narrower and
  // every point moves at the same speed and the polygon keeps its shape instead
  // of writhing.
  const rateX = rate * (0.8 + unit(hx) * 0.5);
  const rateY = rate * (0.8 + unit(hy) * 0.5);

  const phaseX = unit(hash3(index >>> 0, seed, 0x3333));
  const phaseY = unit(hash3(index >>> 0, seed, 0x4444));

  const halfWidth = Math.max(0.05, aspect - margin);
  const halfHeight = Math.max(0.05, 1 - margin);

  return {
    x: (triangleWave(time * rateX + phaseX) * 2 - 1) * halfWidth,
    y: (triangleWave(time * rateY + phaseY) * 2 - 1) * halfHeight,
  };
}

/**
 * One object flying out of the middle of the screen toward the viewer.
 *
 * Shared by Flying Through Space and Flying Windows, which are the same motion
 * with a different thing drawn at each point. The object travels along a fixed
 * direction from the origin at a constant rate in Z, and the perspective divide
 * does the rest — so it accelerates across the screen as it approaches, which is
 * what makes it read as depth rather than as something being scaled up.
 *
 * `age` wraps, so object `i` is ALWAYS somewhere on its run: the field is full
 * from the first frame rather than filling up over the first ten seconds, which
 * matters because a VJ triggering the clip wants it already going.
 */
function flyingPoint(seed, index, time, rate) {
  const h = hash2(index >>> 0, seed);

  const angle = unit(h) * kTwoPi;
  const radius = 0.15 + unit(hash2(h, 0x5555)) * 0.85;
  const offset = unit(hash2(h, 0x6666));

  // Each object gets its own speed, but over a narrow range. A wide spread reads
  // as objects at different depths moving at different speeds, which is
  // physically backwards — in a real flight everything shares one velocity and
  // the perspective divide supplies the difference.
  const speed = rate * (0.85 + unit(hash2(h, 0x7777)) * 0.3);

  let age = time * speed + offset;
  age -= Math.floor(age);

  // Z from far to near. Never reaches zero: at the near plane the scale diverges,
  // and an object of infinite size for one frame is a full-screen flash.
  const kFar = 1.0;
  const kNear = 0.06;
  const z = kFar + (kNear - kFar) * age;

  const scale = 0.35 / z;

  return {
    screen: { x: Math.cos(angle) * radius * scale, y: Math.sin(angle) * radius * scale },
    scale,
    age,
  };
}

/**
 * Map the generic 0..1 `density` onto a whole number in [lo, hi].
 *
 * Quadratic, because the difference between 3 and 4 of something is a
 * different-looking picture and the difference between 51 and 52 is nothing — so
 * a linear slider would spend most of its travel on choices nobody makes.
 */
function countFromDensity(density, lo, hi) {
  const clamped = Math.max(0, Math.min(1, density));
  const curved = clamped * clamped;
  return lo + Math.trunc(curved * (hi - lo) + 0.5);
}

/**
 * The base for the two savers that grow.
 *
 * A subclass supplies the tick rate, a reset, a step and a draw. This class
 * supplies the replay, the cache and the invalidation, so that neither subclass
 * can get the "cache must not change the answer" rule subtly wrong in its own
 * way.
 */
class GrowingSaver {
  constructor() {
    this.rng = new Random(1);
    this.cachedKey = '';
    this.cachedTick = -1;
  }

  /**
   * The ceiling on one frame's replay. Reached only by a wild clock or a scrub
   * to the far end of a long composition — and in a browser, by a tab that lost
   * focus, throttled, and came back asking for a large forward jump.
   */
  static get kMaxReplaySteps() { return 400000; }

  invalidate() { this.cachedTick = -1; }

  build(s, scene) {
    const rate = Math.max(0.01, this.tickRate(s));

    // Negative time is reachable: Phase is an offset and Speed can be zero, so a
    // clock that has not started yet plus a phase of nothing lands slightly
    // below zero. Clamp rather than let floor() run the tick index negative,
    // which would rebuild every frame.
    const t = Math.max(0, s.time);
    const exactTick = t * rate;

    const wantedTick = Math.trunc(Math.min(exactTick, GrowingSaver.kMaxReplaySteps));
    const alpha = exactTick - Math.floor(exactTick);

    const key = this.growthKey(s);

    // The cache is an optimisation and MUST NOT change the answer. It is used
    // ONLY to skip forward within one growth key; anything else starts again.
    const mustRebuild = this.cachedTick < 0 || key !== this.cachedKey || wantedTick < this.cachedTick;
    if (mustRebuild) {
      this.rng.reset(s.seed);
      this.resetState(s, this.rng);
      this.cachedKey = key;
      this.cachedTick = 0;
    }

    while (this.cachedTick < wantedTick) {
      this.step(s, this.rng);
      this.cachedTick += 1;
    }

    this.draw(s, alpha, scene);
  }
}

//===========================================================================
// The savers.
//===========================================================================

/**
 * Mystify Your Mind.
 *
 * Polygons whose corners bounce around the screen, each polygon leaving a trail
 * of its own recent shapes behind it, the whole thing cycling through colours.
 *
 * Scene controls: Density = polygons (1..6). Complexity = corners (2..8).
 * Length = trail steps (1..24). Line Width = stroke weight. Variation = how fast
 * the corners travel relative to each other. Size = how far from the edge the
 * corners may go.
 *
 * THE TRAIL IS NOT A BUFFER. Trail step `i` is the polygon evaluated at
 * `time - i * dt` — a window backwards through the same pure function that draws
 * the head. Nothing is stored, the spacing is exact at any frame rate, and
 * scrubbing works.
 */
const kTrailStep = 1 / 15;

class Mystify {
  build(s, scene) {
    setFlatCamera(s, scene);

    const polygons = countFromDensity(s.density, 1, 6);
    const corners = 2 + Math.trunc(s.complexity * 6 + 0.5);
    const trail = 1 + Math.trunc(s.length * 23 + 0.5);

    // A line's own width has to be kept inside the box or the outer half of the
    // stroke is clipped at every bounce, which reads as the polygon snagging on
    // the edge.
    const width = 0.004 + s.lineWidth * 0.03;
    const margin = width * 0.5 + (1 - s.size) * 0.6;

    // Variation spreads the corner rates. At zero every corner of every polygon
    // travels at the same speed, which keeps the shape rigid and is a legitimate
    // — if static — look.
    const rate = 0.09 * (0.4 + s.variation * 1.2) * (1 + s.audioLevel * s.audioSize * 2);

    const points = new Array(corners);
    const colours = new Array(corners);

    for (let p = 0; p < polygons; p += 1) {
      // Each polygon gets its own seed space so that adding a polygon does not
      // reshuffle the ones already on screen.
      const polygonSeed = hash2(p >>> 0, s.seed);

      // Oldest first, so the head of the trail is drawn last and lands on top.
      // There is no depth test here — draw order is the only ordering a flat
      // scene has.
      for (let step = trail - 1; step >= 0; step -= 1) {
        const when = s.time - step * kTrailStep;

        // Fade along the trail. The head keeps full opacity; the tail reaches a
        // quarter rather than zero, because a trail that fades all the way out
        // just looks shorter than it is.
        const alongTrail = trail > 1 ? step / (trail - 1) : 0;
        const fade = 1 - alongTrail * 0.75;

        // The classic colour: a full-saturation hue that cycles, with each trail
        // step a little behind the one in front, so the trail is a smear through
        // the palette rather than one flat colour. That banding IS the look.
        const classic = hsvToRgb(p * 0.37 + when * 0.08, 1, 1);

        const colour = settingsColour(s, classic, p, polygons);
        const faded = v4(colour.x, colour.y, colour.z, colour.w * fade);

        for (let c = 0; c < corners; c += 1) {
          points[c] = bouncePoint(polygonSeed, c, when, rate, s.aspect, margin);
          colours[c] = faded;
        }

        // Closed for three corners or more; a two-corner "polygon" is a line,
        // and closing it would draw it twice at double width.
        scene.mesh.addPolyline(points, corners, corners > 2, width, colours);
      }
    }
  }
}

/**
 * Beziers.
 *
 * Mystify's motion with a curve through it instead of straight edges: the
 * bouncing points are control points, and what gets drawn is the Bezier they
 * define. Everything about the trail and the colour cycle is the same, which is
 * why this is short.
 *
 * Density = curves (1..5). Complexity = control points (3..9). Length = trail
 * steps (1..24). Line Width, Variation and Size as Mystify.
 *
 * DE CASTELJAU, NOT THE POLYNOMIAL. The polynomial form needs binomial
 * coefficients, and at nine control points those are big enough that the terms
 * alternate in sign and lose precision against each other — the curve develops a
 * wobble near the ends that looks like a bug in the bouncing. Repeated linear
 * interpolation is a few more multiplies and is stable at any order this saver
 * can reach.
 */
const kBezierSamples = 48;

function deCasteljau(control, count, t) {
  // At most nine control points.
  const work = new Array(9);
  const n = Math.min(count, 9);
  for (let i = 0; i < n; i += 1) work[i] = control[i];

  for (let level = n - 1; level > 0; level -= 1) {
    for (let i = 0; i < level; i += 1) {
      work[i] = {
        x: work[i].x + (work[i + 1].x - work[i].x) * t,
        y: work[i].y + (work[i + 1].y - work[i].y) * t,
      };
    }
  }

  return work[0];
}

class Beziers {
  build(s, scene) {
    setFlatCamera(s, scene);

    const curves = countFromDensity(s.density, 1, 5);
    const controls = 3 + Math.trunc(s.complexity * 6 + 0.5);
    const trail = 1 + Math.trunc(s.length * 23 + 0.5);

    const width = 0.004 + s.lineWidth * 0.03;
    const margin = width * 0.5 + (1 - s.size) * 0.6;
    const rate = 0.09 * (0.4 + s.variation * 1.2) * (1 + s.audioLevel * s.audioSize * 2);

    const control = new Array(controls);
    const points = new Array(kBezierSamples);
    const colours = new Array(kBezierSamples);

    for (let c = 0; c < curves; c += 1) {
      const curveSeed = hash2(c >>> 0, s.seed);

      for (let step = trail - 1; step >= 0; step -= 1) {
        const when = s.time - step * kTrailStep;

        const alongTrail = trail > 1 ? step / (trail - 1) : 0;
        const fade = 1 - alongTrail * 0.75;

        const classic = hsvToRgb(c * 0.29 + when * 0.06, 1, 1);
        const colour = settingsColour(s, classic, c, curves);
        const faded = v4(colour.x, colour.y, colour.z, colour.w * fade);

        for (let i = 0; i < controls; i += 1) {
          control[i] = bouncePoint(curveSeed, i, when, rate, s.aspect, margin);
        }

        for (let i = 0; i < kBezierSamples; i += 1) {
          const t = i / (kBezierSamples - 1);
          points[i] = deCasteljau(control, controls, t);
          colours[i] = faded;
        }

        scene.mesh.addPolyline(points, kBezierSamples, false, width, colours);
      }
    }
  }
}

/**
 * Curves and Colors.
 *
 * A spirograph figure drawing itself, on a palette that rotates as it goes. The
 * head of the curve advances, the tail rubs out behind it, and the ratio driving
 * the figure drifts so it never quite repeats.
 *
 * Density = curves on screen (1..4). Complexity = the frequency ratio (1..9).
 * Length = how much of the figure is drawn. Size = radius. Variation = how far
 * the inner radius sits from the outer, which turns a circle into a rosette and
 * then into a star.
 *
 * THE RATIO IS NOT SNAPPED TO A WHOLE NUMBER. An integer ratio closes the figure
 * exactly and it repeats forever; a ratio a hair off an integer makes the whole
 * figure precess slowly, which is the difference between a logo and something
 * that stays interesting for an hour.
 */
// High, because a spirograph's curvature spikes at the cusps and an
// under-sampled cusp shows as a visible corner.
const kCurveSamples = 512;

class Curves {
  build(s, scene) {
    setFlatCamera(s, scene);

    const curves = countFromDensity(s.density, 1, 4);

    // The roulette: a point on a circle of radius `inner` rolling inside one of
    // radius `outer`, offset from the rolling circle's centre by `arm`.
    const ratio = 1 + s.complexity * 8;
    const outer = (0.25 + s.size * 0.7) * (1 + s.audioLevel * s.audioSize * 0.4);
    const inner = outer / ratio;
    const arm = inner * (0.4 + s.variation * 1.6);

    const width = 0.003 + s.lineWidth * 0.02;

    // The figure closes after `ratio` turns of the outer circle when the ratio
    // is whole, so that is the natural full extent.
    const span = (0.08 + s.length * 0.92) * kTwoPi * ratio;

    // Deliberately slow: the original drew at a leisurely rate and speeding it
    // up turns the figure into a flicker.
    const head = s.time * 0.55;

    const points = new Array(kCurveSamples);
    const colours = new Array(kCurveSamples);

    for (let c = 0; c < curves; c += 1) {
      // Curves are spaced around the figure rather than given their own seeds,
      // so they read as one drawing being traced several times over rather than
      // as several unrelated drawings.
      const offset = c / curves * kTwoPi * ratio;

      for (let i = 0; i < kCurveSamples; i += 1) {
        const alongCurve = i / (kCurveSamples - 1);
        const theta = head + offset - span * (1 - alongCurve);

        // Hypotrochoid.
        const k = (outer - inner) / inner;
        points[i] = {
          x: (outer - inner) * Math.cos(theta) + arm * Math.cos(k * theta),
          y: (outer - inner) * Math.sin(theta) - arm * Math.sin(k * theta),
        };

        // The palette rotates along the curve AND with time, which is what "and
        // Colors" meant: the figure is a moving slice through a rotating rainbow
        // rather than a coloured line.
        const classic = hsvToRgb(theta * 0.02 + s.time * 0.05, 0.85, 1);
        const colour = settingsColour(s, classic, c, curves);

        // The tail fades out rather than stopping dead, which is what makes the
        // figure look like it is being drawn instead of scrolling.
        const fade = Math.min(1, alongCurve * 6);
        colours[i] = v4(colour.x, colour.y, colour.z, colour.w * fade);
      }

      scene.mesh.addPolyline(points, kCurveSamples, false, width, colours);
    }
  }
}

/**
 * Flying Through Space.
 *
 * White dots streaming out of the middle of the screen. The one everybody
 * remembers, and the one with the least in it.
 *
 * Density = stars (20..1200). Size = how big a near star gets. Length = streak;
 * at zero a star is a dot, as it shipped. Line Width = the streak's thickness.
 * Variation = how much brightness varies between stars. Complexity = how quickly
 * a star fades in as it arrives.
 *
 * THE STREAK IS THE LAST INSTANT OF THE SAME FUNCTION — the tail is the star's
 * position at `time - dt`, not a remembered previous position. So the streak
 * length is exact at any frame rate and correct on the very first frame.
 *
 * The one thing to be careful of is the wrap: a star that passed the near plane
 * between `time - dt` and `time` has a tail on the OTHER side of the screen, and
 * joining those two points draws a line straight across the frame. That is the
 * single ugliest artefact this saver can produce, and it only appears at high
 * streak lengths — which is exactly where nobody thinks to look.
 */
class Starfield {
  build(s, scene) {
    setFlatCamera(s, scene);

    const stars = countFromDensity(s.density, 20, 1200);
    const rate = 0.12 * (1 + s.audioLevel * s.audioSize * 3);

    const dotSize = 0.004 + s.size * 0.022;
    const streakDt = s.length * 0.55;
    const streakWide = (0.5 + s.lineWidth) * dotSize;

    // How fast a star reaches full brightness after it appears at the far plane.
    // Without this stars pop into existence at the horizon, which the original
    // avoided by simply being dim out there.
    const fadeIn = 0.02 + s.complexity * 0.35;

    for (let i = 0; i < stars; i += 1) {
      const now = flyingPoint(s.seed, i, s.time, rate);

      // Near stars are brighter, plus a per-star constant so the field does not
      // look like one object photocopied.
      const vary = 1 - s.variation * unit(hash3(i >>> 0, s.seed, 0xABCD)) * 0.7;
      const arrival = Math.min(1, now.age / Math.max(1e-4, fadeIn));
      const brightness = Math.min(1, 0.25 + now.scale * 0.9) * vary * arrival;

      const classic = v3(brightness, brightness, brightness);
      const colour = settingsColour(s, classic, i, stars);

      if (streakDt <= 0.001) {
        const r = dotSize * Math.min(3, now.scale);
        scene.mesh.addRect(
          { x: now.screen.x - r, y: now.screen.y - r },
          { x: now.screen.x + r, y: now.screen.y + r }, colour,
        );
        continue;
      }

      const before = flyingPoint(s.seed, i, s.time - streakDt, rate);

      // The wrap check. If the star passed the near plane during the streak
      // interval its `age` went backwards, and the two ends are on opposite
      // sides of the frame.
      if (before.age > now.age) {
        const r = dotSize * Math.min(3, now.scale);
        scene.mesh.addRect(
          { x: now.screen.x - r, y: now.screen.y - r },
          { x: now.screen.x + r, y: now.screen.y + r }, colour,
        );
        continue;
      }

      // The tail is dimmer, which is what makes a streak read as motion rather
      // than as a rod.
      const tail = v4(colour.x, colour.y, colour.z, colour.w * 0.15);
      scene.mesh.addLine(before.screen, now.screen,
        streakWide * Math.min(3, now.scale), tail, colour);
    }
  }
}

/**
 * Flying Windows.
 *
 * The four-pane logo, streaming out of the middle of the screen. Same flight as
 * Flying Through Space — see `flyingPoint` — with a logo drawn at each point
 * instead of a dot. They were the same trick on the machine and they are the
 * same trick here.
 *
 * Density = logos (4..120). Size = how big a near logo gets. Complexity = the
 * gap between the four panes. Variation = brightness spread. Line Width = the
 * pane corner inset, which is as close as a flat quad gets to the original's
 * rounded look. Length is unused.
 *
 * The logo is four quads in the four colours, sheared into a parallelogram and
 * stacked so the top two are narrower than the bottom two — the perspective of
 * the original mark, faked with a shear because it is drawn flat. It is a
 * recognisable gesture rather than a reproduction, which is the right side of the
 * line for something that ships as a plugin: it reads as the logo at speed, and
 * nothing here is a copy of Microsoft's artwork.
 */
const kPaneColours = [
  v3(0.95, 0.28, 0.20), // red
  v3(0.40, 0.75, 0.25), // green
  v3(0.20, 0.50, 0.90), // blue
  v3(0.98, 0.78, 0.18), // yellow
];

class FlyingWindows {
  build(s, scene) {
    setFlatCamera(s, scene);

    const logos = countFromDensity(s.density, 4, 120);
    const rate = 0.1 * (1 + s.audioLevel * s.audioSize * 2.5);

    const logoUnit = 0.03 + s.size * 0.09;
    const gap = 0.06 + s.complexity * 0.35;
    const inset = s.lineWidth * 0.18;

    // The shear that fakes the mark's perspective. Constant, because it is part
    // of the shape rather than something to animate.
    const kShear = 0.22;
    // How much narrower the top row is than the bottom.
    const kTaper = 0.78;

    for (let i = 0; i < logos; i += 1) {
      const flight = flyingPoint(s.seed, i, s.time, rate);

      const scale = logoUnit * flight.scale;
      if (scale < 0.0005) continue;

      const vary = 1 - s.variation * unit(hash3(i >>> 0, s.seed, 0x5A5A)) * 0.6;

      // Fade in from the far plane, out at the near one. The near fade matters:
      // without it a logo covering half the frame vanishes between one frame and
      // the next.
      const arrival = Math.min(1, flight.age * 12);
      const departure = Math.min(1, (1 - flight.age) * 6);
      const alpha = arrival * departure;

      for (let pane = 0; pane < 4; pane += 1) {
        const column = pane % 2;
        const row = Math.trunc(pane / 2);

        const rowTaper = row === 0 ? kTaper : 1;

        // Pane centre in logo units, before the shear.
        const cx = (column - 0.5) * (1 + gap) * rowTaper;
        const cy = (0.5 - row) * (1 + gap);

        const halfW = 0.5 * rowTaper * (1 - inset);
        const halfH = 0.5 * (1 - inset);

        // Sheared quad, so it is built corner by corner rather than as an
        // axis-aligned rect.
        const corners = [
          { x: cx - halfW, y: cy - halfH },
          { x: cx + halfW, y: cy - halfH },
          { x: cx + halfW, y: cy + halfH },
          { x: cx - halfW, y: cy + halfH },
        ];

        const classic = mul3(kPaneColours[pane], vary);
        const colour = settingsColour(s, classic, i, logos);
        const faded = v4(colour.x, colour.y, colour.z, colour.w * alpha);

        const base = scene.mesh.mark();
        for (const corner of corners) {
          const x = (corner.x + corner.y * kShear) * scale + flight.screen.x;
          const y = corner.y * scale + flight.screen.y;
          scene.mesh.addVertex({ x, y, z: 0 }, { x: 0, y: 0, z: 1 }, faded);
        }
        scene.mesh.addQuad(base, base + 1, base + 2, base + 3);
      }
    }
  }
}

//---------------------------------------------------------------------------
// Font.cpp — the vector letterforms the Marquee draws.
//
// Two characters to a point, '0'-'9' then 'A'-'F' for 10 to 15, on an 8x12 grid.
// A space starts a new stroke. Indexed by `character - 32`. An empty string
// means "no glyph": it advances and draws nothing.
//---------------------------------------------------------------------------

/// Grid height. Cap height is the full 12, so a capital is exactly 1.0 tall.
const kGridHeight = 12.0;
/// Space either side of a glyph, in grid units.
const kSideBearing = 3.0;
/// Advance of a space character, in grid units.
const kSpaceAdvance = 7.0;
const kSmallCapScale = 0.72;

const kGlyphs = [
  /* 32 ' ' */ '',
  /* 33 '!' */ '4C43 4140',
  /* 34 '"' */ '3C3A 5C5A',
  /* 35 '#' */ '303C 505C 1474 1878',
  /* 36 '$' */ '8A6C2C0A0826668482602002 4C40',
  /* 37 '%' */ '008C 0A2C 6082',
  /* 38 '&' */ '80272A4C6A680301205084',
  /* 39 '\'' */ '4C4A',
  /* 40 '(' */ '6C282460',
  /* 41 ')' */ '2C686420',
  /* 42 '*' */ '266A 2A66 464B',
  /* 43 '+' */ '1676 4349',
  /* 44 ',' */ '4220',
  /* 45 '-' */ '1676',
  /* 46 '.' */ '3040413130',
  /* 47 '/' */ '008C',
  /* 48 '0' */ '2060828A6C2C0A0220',
  /* 49 '1' */ '2A4C40 2060',
  /* 50 '2' */ '0A2C6C8A880080',
  /* 51 '3' */ '0C8C37678582602002',
  /* 52 '4' */ '606C0484',
  /* 53 '5' */ '8C0C07578582602002',
  /* 54 '6' */ '8A6C2C080220608285672705',
  /* 55 '7' */ '0C8C30',
  /* 56 '8' */ '27090B2C6C8B896727 2705022060828567',
  /* 57 '9' */ '022060848A6C2C0A07256587',
  /* 58 ':' */ '4847 4241',
  /* 59 ';' */ '4847 4220',
  /* 60 '<' */ '8A0682',
  /* 61 '=' */ '1474 1878',
  /* 62 '>' */ '0A8602',
  /* 63 '?' */ '0A2C6C8A884543 4140',
  /* 64 '@' */ '2060828A6C2C0A0220 3646',
  /* 65 'A' */ '004C80 2464',
  /* 66 'B' */ '000C 0C5C7A785606 066684826000',
  /* 67 'C' */ '8A6C2C0A02206082',
  /* 68 'D' */ '000C 0C4C8A824000',
  /* 69 'E' */ '80000C8C 0656',
  /* 70 'F' */ '000C8C 0656',
  /* 71 'G' */ '8A6C2C0A022060828656',
  /* 72 'H' */ '000C 808C 0686',
  /* 73 'I' */ '404C',
  /* 74 'J' */ '6C62402002',
  /* 75 'K' */ '000C 8C0580',
  /* 76 'L' */ '0C0080',
  /* 77 'M' */ '000C468C80',
  /* 78 'N' */ '000C808C',
  /* 79 'O' */ '2060828A6C2C0A0220',
  /* 80 'P' */ '000C 0C6C8A886606',
  /* 81 'Q' */ '2060828A6C2C0A0220 5380',
  /* 82 'R' */ '000C 0C6C8A886606 4680',
  /* 83 'S' */ '8A6C2C0A0826668482602002',
  /* 84 'T' */ '0C8C 4C40',
  /* 85 'U' */ '0C022060828C',
  /* 86 'V' */ '0C408C',
  /* 87 'W' */ '0C2047608C',
  /* 88 'X' */ '008C 0C80',
  /* 89 'Y' */ '0C468C 4640',
  /* 90 'Z' */ '0C8C0080',
  /* 91 '[' */ '6C2C2060',
  /* 92 '\\' */ '0C80',
  /* 93 ']' */ '2C6C6020',
  /* 94 '^' */ '284C68',
  /* 95 '_' */ '0080',
];

const kFirstGlyph = 32;

function hexValue(c) {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'F') return 10 + (c.charCodeAt(0) - 65);
  return -1;
}

function decodeGlyph(encoded) {
  const glyph = { strokes: [], width: 0, advance: 0 };
  if (encoded == null) return glyph;

  let current = [];
  let maxX = 0;

  for (let p = 0; p < encoded.length;) {
    if (encoded[p] === ' ') {
      // A stroke of one point draws nothing and is almost certainly a typo in
      // the table, so it is dropped rather than emitted.
      if (current.length >= 2) glyph.strokes.push(current);
      current = [];
      p += 1;
      continue;
    }

    const x = hexValue(encoded[p]);
    const y = p + 1 < encoded.length ? hexValue(encoded[p + 1]) : -1;
    if (x < 0 || y < 0) break;

    current.push({ x: x / kGridHeight, y: y / kGridHeight });
    maxX = Math.max(maxX, x);
    p += 2;
  }

  if (current.length >= 2) glyph.strokes.push(current);

  glyph.width = maxX / kGridHeight;

  // Advance is measured off the strokes rather than stored, so a glyph and its
  // advance cannot get out of step when one is edited.
  glyph.advance = (glyph.strokes.length === 0 ? kSpaceAdvance : maxX + kSideBearing) / kGridHeight;

  return glyph;
}

const EMPTY_GLYPH = { strokes: [], width: 0, advance: kSpaceAdvance / kGridHeight };

const GLYPH_TABLE = (() => {
  const table = new Array(128).fill(EMPTY_GLYPH);
  for (let i = 0; i < kGlyphs.length; i += 1) {
    const code = kFirstGlyph + i;
    if (code < 128) table[code] = decodeGlyph(kGlyphs[i]);
  }
  return table;
})();

function getGlyph(c) {
  const code = c.charCodeAt(0);
  if (code >= 128) return EMPTY_GLYPH;

  // Lowercase folds to a capital; the caller scales it.
  const folded = code >= 97 && code <= 122 ? code - 97 + 65 : code;
  if (folded < kFirstGlyph) return EMPTY_GLYPH;

  return GLYPH_TABLE[folded];
}

const isSmall = (c) => c >= 'a' && c <= 'z';

function measureText(text) {
  if (text == null) return 0;
  let total = 0;
  for (const c of text) {
    total += getGlyph(c).advance * (isSmall(c) ? kSmallCapScale : 1);
  }
  return total;
}

/**
 * Scrolling Marquee.
 *
 * A line of text crossing the frame, bouncing gently up and down, in a colour
 * that cycles. The saver everybody used to leave a message on their monitor.
 *
 * Size = cap height as a fraction of the frame height. Line Width = stroke
 * weight. Density = copies in flight. Length = how far it bounces vertically.
 * Complexity = how fast it bounces. Variation = how much the copies differ in
 * hue.
 *
 * The string comes from the Text parameter. Empty falls back to the plugin's
 * name rather than drawing nothing, because an empty marquee looks exactly like
 * a broken one.
 *
 * The scroll position is `time * speed` reduced modulo one repeat length, so it
 * is a pure function of time and never accumulates. The repeat length is the
 * text's own width plus a gap, which means A LONGER MESSAGE SCROLLS WITH THE
 * SAME GAP RATHER THAN THE SAME PERIOD — the behaviour you want, and the one you
 * do not get by dividing the frame into a fixed number of slots.
 */
class Marquee {
  build(s, scene) {
    setFlatCamera(s, scene);

    const message = s.text != null && s.text.length > 0 ? s.text : 'Idler';

    const capHeight = 0.1 + s.size * 0.8;
    const width = (0.02 + s.lineWidth * 0.12) * capHeight;
    const copies = countFromDensity(s.density, 1, 6);

    const textWidth = measureText(message) * capHeight;
    // The gap scales with the text so a short message does not end up with a gap
    // many times its own length.
    const repeat = textWidth + capHeight * 2 + s.aspect * 0.5;

    const scrollSpeed = 0.35 * (1 + s.audioLevel * s.audioSize * 2);
    let scroll = s.time * scrollSpeed;
    scroll -= Math.floor(scroll / repeat) * repeat;

    const bounceHeight = s.length * (1 - capHeight * 0.5);
    const bounceRate = 0.05 + s.complexity * 0.35;

    // Enough copies to cover the frame plus one entering and one leaving.
    const span = Math.trunc((s.aspect * 2 + repeat) / repeat) + 2;

    for (let copy = 0; copy < copies; copy += 1) {
      // Copies are stacked at different heights and phases rather than simply
      // repeated, so a Density above one reads as a band of text rather than as
      // one line drawn several times.
      const copyFraction = copies > 1 ? copy / copies : 0;

      const bounce = (triangleWave(s.time * bounceRate + copyFraction) * 2 - 1) * bounceHeight;
      const baseline = bounce - capHeight * 0.5;

      const classic = hsvToRgb(s.time * 0.07 + copyFraction * s.variation, 0.9, 1);
      const colour = settingsColour(s, classic, copy, copies);

      for (let repeatIndex = -1; repeatIndex < span; repeatIndex += 1) {
        const x = s.aspect + capHeight - scroll + repeatIndex * repeat - copyFraction * repeat;

        // Cheap reject before laying out a whole string of glyphs.
        if (x > s.aspect + capHeight || x + textWidth < -s.aspect - capHeight) continue;

        Marquee.drawText(scene, message, x, baseline, capHeight, width, colour);
      }
    }
  }

  static drawText(scene, message, x, baseline, capHeight, width, colour) {
    for (const c of message) {
      const scale = capHeight * (isSmall(c) ? kSmallCapScale : 1);
      const glyph = getGlyph(c);

      for (const stroke of glyph.strokes) {
        const points = new Array(stroke.length);
        const colours = new Array(stroke.length);
        for (let i = 0; i < stroke.length; i += 1) {
          points[i] = { x: x + stroke[i].x * scale, y: baseline + stroke[i].y * scale };
          colours[i] = colour;
        }
        scene.mesh.addPolyline(points, points.length, false, width, colours);
      }

      x += glyph.advance * scale;
    }
  }
}

//---------------------------------------------------------------------------
// Teapot.cpp — a profile-revolved teapot, small enough to drop where a ball
// would have gone.
//---------------------------------------------------------------------------

/// Segments around the axis of revolution. Low, because this is drawn at the
/// size of a pipe elbow and there can be several dozen of them in the box.
const kTeapotAround = 12;

/**
 * The body profile, as (radius, height) pairs from the base upwards.
 *
 * Normalised so the tallest point is 1.0 and the widest is about 0.75. The shape
 * is the recognisable one: a nearly flat base, a belly a little below the middle,
 * a waist, and a rim that flares back out.
 */
const kTeapotProfile = [
  { x: 0.00, y: 0.02 },
  { x: 0.26, y: 0.00 },
  { x: 0.44, y: 0.04 },
  { x: 0.60, y: 0.14 },
  { x: 0.72, y: 0.30 },
  { x: 0.75, y: 0.44 },
  { x: 0.70, y: 0.56 },
  { x: 0.60, y: 0.64 },
  { x: 0.52, y: 0.68 },
  { x: 0.56, y: 0.70 }, // the rim, flaring back out
  { x: 0.54, y: 0.72 },
];

/// The lid: a shallow dome and a knob.
const kTeapotLidProfile = [
  { x: 0.54, y: 0.72 },
  { x: 0.48, y: 0.78 },
  { x: 0.34, y: 0.83 },
  { x: 0.16, y: 0.85 },
  { x: 0.07, y: 0.86 },
  { x: 0.07, y: 0.92 },
  { x: 0.15, y: 0.97 },
  { x: 0.09, y: 1.00 },
  { x: 0.00, y: 1.00 },
];

/**
 * Revolve a profile about the Y axis.
 *
 * Normals come from smoothNormals afterwards rather than from the profile's
 * tangent, because the profile has a deliberate crease at the rim: accumulating
 * the face normals reproduces that crease correctly, while an analytic normal
 * from a straight-line segment would round it off.
 */
function revolve(mesh, transform, profile, count, scale, colour) {
  const base = mesh.mark();

  for (let i = 0; i < count; i += 1) {
    for (let a = 0; a <= kTeapotAround; a += 1) {
      const angle = kTwoPi * (a % kTeapotAround) / kTeapotAround;
      const local = v3(
        profile[i].x * Math.cos(angle) * scale,
        profile[i].y * scale,
        profile[i].x * Math.sin(angle) * scale,
      );
      mesh.addVertex(mat4Point(transform, local), { x: 0, y: 1, z: 0 }, colour);
    }
  }

  const stride = kTeapotAround + 1;
  for (let i = 0; i + 1 < count; i += 1) {
    for (let a = 0; a < kTeapotAround; a += 1) {
      const v = base + i * stride + a;
      mesh.addQuad(v, v + stride, v + stride + 1, v + 1);
    }
  }
}

/** A tube swept along a curve, tapering. Used for the spout and the handle. */
function sweep(mesh, transform, path, startRadius, endRadius, colour) {
  if (path.length < 2) return;

  const sides = 8;
  const base = mesh.mark();

  for (let i = 0; i < path.length; i += 1) {
    // The direction at this point: the average of the segments either side, so
    // the tube does not kink at a joint.
    const forward = normalise3(
      i === 0 ? sub3(path[1], path[0])
        : i + 1 === path.length ? sub3(path[i], path[i - 1])
          : sub3(path[i + 1], path[i - 1]),
    );

    const frame = mat4Mul(mat4Translate(path[i]), mat4AlignZTo(forward));

    const t = i / (path.length - 1);
    const radius = startRadius + (endRadius - startRadius) * t;

    for (let a = 0; a <= sides; a += 1) {
      const angle = kTwoPi * (a % sides) / sides;
      const local = v3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      mesh.addVertex(mat4Point(transform, mat4Point(frame, local)), { x: 0, y: 1, z: 0 }, colour);
    }
  }

  const stride = sides + 1;
  for (let i = 0; i + 1 < path.length; i += 1) {
    for (let a = 0; a < sides; a += 1) {
      const v = base + i * stride + a;
      mesh.addQuad(v, v + stride, v + stride + 1, v + 1);
    }
  }
}

function addTeapot(mesh, transform, scale, colour) {
  // The profile is 1.0 tall and 0.75 wide plus a spout that reaches further, so
  // this keeps the whole thing inside `scale` of the centre and puts the centre
  // of mass on the origin — which is what lets Pipes drop one in where a ball
  // would have gone.
  const unitScale = scale * 0.9;
  const place = mat4Mul(transform, mat4Translate(v3(0, -unitScale * 0.45, 0)));

  const start = mesh.mark();

  revolve(mesh, place, kTeapotProfile, kTeapotProfile.length, unitScale, colour);
  revolve(mesh, place, kTeapotLidProfile, kTeapotLidProfile.length, unitScale, colour);

  // The spout: out of the belly, rising above the rim, narrowing.
  const spout = [
    v3(0.55 * unitScale, 0.30 * unitScale, 0),
    v3(0.80 * unitScale, 0.36 * unitScale, 0),
    v3(1.00 * unitScale, 0.52 * unitScale, 0),
    v3(1.08 * unitScale, 0.72 * unitScale, 0),
    v3(1.06 * unitScale, 0.82 * unitScale, 0),
  ];
  sweep(mesh, place, spout, 0.17 * unitScale, 0.07 * unitScale, colour);

  // The handle: an arc out of the other side and back.
  const handle = [];
  for (let i = 0; i <= 8; i += 1) {
    const t = i / 8;
    const angle = kPi * (0.15 + t * 0.7);
    handle.push(v3(
      -(0.48 + 0.36 * Math.sin(angle)) * unitScale,
      (0.30 + 0.38 * (1 - Math.cos(angle))) * unitScale,
      0,
    ));
  }
  sweep(mesh, place, handle, 0.09 * unitScale, 0.09 * unitScale, colour);

  // One pass over everything just added. Vertices at the same position get the
  // same normal, so the body and the lid meet at the rim without a seam, while
  // the deliberate crease in the profile survives because the faces either side
  // of it really do point in different directions.
  mesh.smoothNormals(start);
}

/**
 * 3D Flying Objects.
 *
 * Lit solids tumbling slowly through space, drifting past the camera and round
 * again.
 *
 * Density = objects (1..24). Complexity = which solids are in the mix — turning
 * it up brings in the more elaborate ones, so the low end is boxes and balls and
 * the high end has toruses and teapots in it. Size, Length = how deep the volume
 * is. Variation = spread in size and tumble rate. Line Width = wireframe weight.
 *
 * Each object's position is three sines at rates drawn from its own hash — a
 * Lissajous in three dimensions, which never repeats exactly and never needs a
 * bounds test, because a sine is already bounded. There is no integration and no
 * collision, which is what makes it seekable.
 *
 * They DO pass through each other, and it is left alone: keeping a dozen
 * tumbling solids apart means either a collision response (state, and the
 * seekability goes with it) or spacing them so far apart the frame is mostly
 * empty. The original let them overlap too.
 */
const Solid = { Box: 0, Sphere: 1, Cylinder: 2, Torus: 3, Teapot: 4, Count: 5 };

class FlyingObjects {
  build(s, scene) {
    const depth = 3 + s.length * 9;
    FlyingObjects.setCamera(s, scene, depth);

    const count = countFromDensity(s.density, 1, 24);

    // Complexity opens up the shape list rather than picking one shape, so that
    // moving the slider adds variety instead of swapping the picture for a
    // different picture.
    const available = 1 + Math.trunc(s.complexity * (Solid.Count - 1) + 0.5);

    const baseSize = (0.15 + s.size * 0.5) * (1 + s.audioLevel * s.audioSize);

    for (let i = 0; i < count; i += 1) {
      const h = hash2(i >>> 0, s.seed);

      // The rates are close to each other but not equal, so the paths are all of
      // a family without any two objects sharing one.
      const rx = 0.05 + unit(hash2(h, 0x11)) * 0.06;
      const ry = 0.05 + unit(hash2(h, 0x22)) * 0.06;
      const rz = 0.04 + unit(hash2(h, 0x33)) * 0.05;

      const px = unit(hash2(h, 0x44)) * kTwoPi;
      const py = unit(hash2(h, 0x55)) * kTwoPi;
      const pz = unit(hash2(h, 0x66)) * kTwoPi;

      const spread = 1.6 + s.length * 2.5;

      const position = v3(
        Math.sin(s.time * rx * kTwoPi + px) * spread * s.aspect * 0.6,
        Math.sin(s.time * ry * kTwoPi + py) * spread * 0.6,
        -depth * 0.5 + Math.sin(s.time * rz * kTwoPi + pz) * depth * 0.35,
      );

      const tumble = 0.4 + unit(hash2(h, 0x77)) * s.variation * 2;
      const orientation = mat4Mul(
        mat4Mul(mat4RotateY(s.time * tumble * 0.7), mat4RotateX(s.time * tumble * 0.43)),
        mat4RotateZ(s.time * tumble * 0.29),
      );

      const size = baseSize * (1 - s.variation * 0.6 * unit(hash2(h, 0x88)));

      const place = mat4Mul(mat4Translate(position), orientation);

      const solid = hash2(h, 0x99) % (available >>> 0);
      const classic = hsvToRgb(unit(hash2(h, 0xAA)), 0.7, 1);
      const colour = settingsColour(s, classic, i, count);

      switch (solid) {
        case Solid.Box:
          scene.mesh.addTransformedBox(place, v3(size, size, size), colour);
          break;

        case Solid.Sphere:
          scene.mesh.addSphere(place, size, 10, 16, colour);
          break;

        case Solid.Cylinder:
          // Placed back half its own length so it tumbles about its middle.
          // addCylinder builds from z = 0 forwards, so without this it would
          // swing round one end like a thrown baton.
          scene.mesh.addCylinder(mat4Mul(place, mat4Translate(v3(0, 0, -size))),
            size * 0.6, size * 2, 14, colour, true, true);
          break;

        case Solid.Torus:
          scene.mesh.addTorus(place, size, size * 0.38, 20, 10, colour);
          break;

        case Solid.Teapot:
        default:
          addTeapot(scene.mesh, place, size * 1.3, colour);
          break;
      }
    }
  }

  static setCamera(s, scene, depth) {
    scene.depthTest = true;
    scene.shading = s.shading === Shading.Flat ? Shading.Lit : s.shading;

    const back = 0.5 + s.camDistance * 3;

    scene.view = mat4LookAt(
      v3(0, Math.sin(s.camTilt) * back, back),
      v3(0, 0, -depth * 0.4), v3(0, 1, 0),
    );
    scene.proj = mat4Perspective(s.fov, Math.max(0.01, s.aspect), 0.05, depth * 4 + 10);

    if (s.fog > 0.001) {
      // Deep, so objects fade out at the back of the volume rather than
      // disappearing at the far plane.
      scene.fogStart = back + depth * (0.2 + (1 - s.fog) * 0.6);
      scene.fogEnd = back + depth * 1.3;
    }
  }
}

/**
 * 3D FlowerBox.
 *
 * A solid sitting on the spot, turning over, its surface swelling in and out
 * between a box, a ball and a many-lobed flower.
 *
 * Complexity = lobes (2..9). Size. Length = how far the morph travels. Density =
 * surface resolution, 12..48 segments — the one place Density means "how much
 * geometry" rather than "how many things", because there is only ever one of
 * these. Variation = how much the two morph terms differ in rate.
 *
 * The shape is a sphere whose radius is a function of direction:
 *
 *     r(theta, phi) = 1 + A * sin(m*theta) * sin(n*phi) + B * boxiness
 *
 * THE NORMALS ARE ACCUMULATED RATHER THAN DERIVED. The analytic normal is
 * available and is not used: at the extremes of the morph the surface folds
 * through itself, and where it does the analytic normal is correct and useless —
 * it points into the fold, and the shading goes to pieces exactly where the shape
 * is most interesting.
 */
class FlowerBox {
  build(s, scene) {
    FlowerBox.setCamera(s, scene);

    const segments = 12 + Math.trunc(s.density * 36 + 0.5);
    const rings = Math.trunc(segments / 2) + 2;

    const lobes = 2 + s.complexity * 7;
    const reach = s.length * (0.55 + s.audioLevel * s.audioSize * 0.5);
    const scale = 0.4 + s.size * 0.9;

    // Two rates that do not divide into each other, so the pair does not return
    // to the same pose on a short cycle. Ratios like 3:2 look deliberately
    // periodic within about twenty seconds.
    const rateA = 0.11 * (0.6 + s.variation);
    const rateB = 0.077;

    const flower = Math.sin(s.time * rateA) * reach;
    const boxness = (Math.sin(s.time * rateB) * 0.5 + 0.5) * reach;

    const start = scene.mesh.mark();

    for (let r = 0; r <= rings; r += 1) {
      const phi = kPi * r / rings;
      const sp = Math.sin(phi), cp = Math.cos(phi);

      for (let a = 0; a <= segments; a += 1) {
        const theta = kTwoPi * (a % segments) / segments;

        const direction = v3(sp * Math.cos(theta), cp, sp * Math.sin(theta));

        // The flower term.
        let radius = 1 + flower * Math.sin(lobes * theta) * Math.sin(lobes * phi);

        // The box term. Dividing by the Chebyshev norm pushes a point on the
        // unit sphere out onto the surface of the unit cube, so interpolating
        // between 1 and that is a sphere-to-cube morph that stays continuous at
        // the corners.
        const chebyshev = Math.max(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z));
        if (chebyshev > 1e-4) {
          radius = radius * (1 - boxness) + (radius / chebyshev) * boxness;
        }

        const position = mul3(direction, radius * scale);

        // The colour follows the direction rather than the position, so it stays
        // put on the surface as the shape swells instead of sliding about.
        const classic = hsvToRgb(theta / kTwoPi + s.time * 0.03, 0.55 + 0.35 * Math.abs(cp), 1);
        const colour = settingsColour(s, classic, a, segments);

        scene.mesh.addVertex(position, direction, colour);
      }
    }

    const stride = segments + 1;
    for (let r = 0; r < rings; r += 1) {
      for (let a = 0; a < segments; a += 1) {
        const v = start + r * stride + a;
        scene.mesh.addQuad(v, v + stride, v + stride + 1, v + 1);
      }
    }

    scene.mesh.smoothNormals(start);
  }

  static setCamera(s, scene) {
    scene.depthTest = true;
    scene.shading = s.shading === Shading.Flat ? Shading.Lit : s.shading;

    const distance = 2.4 + s.camDistance * 3;
    const angle = s.time * 0.13;

    const eye = v3(
      Math.sin(angle) * distance,
      Math.sin(s.camTilt) * distance,
      Math.cos(angle) * distance,
    );

    scene.view = mat4LookAt(eye, v3(0, 0, 0), v3(0, 1, 0));
    scene.proj = mat4Perspective(s.fov, Math.max(0.01, s.aspect), 0.05, 40);

    if (s.fog > 0.001) {
      scene.fogStart = distance * 0.7;
      scene.fogEnd = distance * (1.4 + (1 - s.fog) * 2);
    }
  }
}

/**
 * 3D Text.
 *
 * Lettering with real depth, turning on the spot.
 *
 * Size = cap height. Line Width = stroke weight, and it is the control that most
 * changes the character of the thing: thin reads as neon, heavy as a chrome logo.
 * Length = extrusion depth. Complexity = how the text tumbles, from a plain spin
 * about the vertical to a full three-axis roll. Density = copies stacked in
 * depth. Variation = hue spread across the copies.
 *
 * HOW A STROKE BECOMES A SOLID. The font is strokes down the middle of each
 * letter rather than outlines, so a stroke is turned into a slab: the polyline is
 * offset either side by half the weight — with the same mitred joins the 2D line
 * builder uses — and that ribbon is given a front face, a back face and walls all
 * the way round. The result has silhouette, catches the light on its sides as it
 * turns, and there is nothing to see through. What it is NOT is a typeface
 * extruded: the letters have a constant stroke weight, like signage.
 *
 * THE MITRE LIMIT MATTERS MORE HERE THAN IN 2D. An unlimited mitre on a sharp
 * corner — the apex of an A, the point of a V — sends the offset point off to
 * infinity. In 2D that draws a spike; here it drags a SOLID spike across the
 * frame, and because it is real geometry with real depth it also fights the depth
 * buffer of everything behind it. Load bearing rather than cosmetic.
 */
const kTextMitreLimit = 4.0;

/** Offset a polyline either side by `half`, with mitred joins. */
function offsetStroke(stroke, half) {
  const count = stroke.length;
  const left = new Array(count);
  const right = new Array(count);

  for (let i = 0; i < count; i += 1) {
    const here = stroke[i];

    const previousDirection = i > 0
      ? normaliseSafe2({ x: here.x - stroke[i - 1].x, y: here.y - stroke[i - 1].y })
      : normaliseSafe2({ x: stroke[1].x - here.x, y: stroke[1].y - here.y });
    const nextDirection = i + 1 < count
      ? normaliseSafe2({ x: stroke[i + 1].x - here.x, y: stroke[i + 1].y - here.y })
      : normaliseSafe2({ x: here.x - stroke[i - 1].x, y: here.y - stroke[i - 1].y });

    const previousNormal = perp2(previousDirection);
    const nextNormal = perp2(nextDirection);

    let mitre = normaliseSafe2({ x: previousNormal.x + nextNormal.x, y: previousNormal.y + nextNormal.y });
    const cosHalf = mitre.x * previousNormal.x + mitre.y * previousNormal.y;

    let scale = Math.abs(cosHalf) < 1e-4 ? kTextMitreLimit : 1 / cosHalf;
    if (scale > kTextMitreLimit || scale < -kTextMitreLimit) {
      mitre = nextNormal;
      scale = 1;
    }

    const offset = { x: mitre.x * half * scale, y: mitre.y * half * scale };
    left[i] = { x: here.x + offset.x, y: here.y + offset.y };
    right[i] = { x: here.x - offset.x, y: here.y - offset.y };
  }

  return { left, right };
}

/** A stroke as a closed solid slab, in the XY plane, extruded to +-`depth`. */
function addSlab(mesh, transform, stroke, half, depth, colour) {
  const { left, right } = offsetStroke(stroke, half);

  const count = left.length;
  if (count < 2) return;

  const place = (p, z) => mat4Point(transform, v3(p.x, p.y, z));

  const front = normalise3(mat4Direction(transform, v3(0, 0, 1)));
  const back = neg3(front);

  // Front and back faces.
  for (let i = 0; i + 1 < count; i += 1) {
    const base = mesh.mark();
    mesh.addVertex(place(left[i], depth), front, colour);
    mesh.addVertex(place(right[i], depth), front, colour);
    mesh.addVertex(place(right[i + 1], depth), front, colour);
    mesh.addVertex(place(left[i + 1], depth), front, colour);
    mesh.addQuad(base, base + 1, base + 2, base + 3);

    const backBase = mesh.mark();
    mesh.addVertex(place(left[i], -depth), back, colour);
    mesh.addVertex(place(left[i + 1], -depth), back, colour);
    mesh.addVertex(place(right[i + 1], -depth), back, colour);
    mesh.addVertex(place(right[i], -depth), back, colour);
    mesh.addQuad(backBase, backBase + 1, backBase + 2, backBase + 3);
  }

  // The two side walls.
  const wall = (edge, flip) => {
    for (let i = 0; i + 1 < count; i += 1) {
      const a = edge[i];
      const b = edge[i + 1];

      let outward = perp2(normaliseSafe2({ x: b.x - a.x, y: b.y - a.y }));
      if (flip) outward = { x: -outward.x, y: -outward.y };
      const normal = normalise3(mat4Direction(transform, v3(outward.x, outward.y, 0)));

      const base = mesh.mark();
      mesh.addVertex(place(a, -depth), normal, colour);
      mesh.addVertex(place(b, -depth), normal, colour);
      mesh.addVertex(place(b, depth), normal, colour);
      mesh.addVertex(place(a, depth), normal, colour);
      mesh.addQuad(base, base + 1, base + 2, base + 3);
    }
  };
  wall(left, false);
  wall(right, true);

  // End caps, so a stroke is closed rather than a tube open at both ends.
  // Without these a letter reads as hollow the moment it turns edge-on.
  const cap = (index, atStart) => {
    const l = left[index];
    const r = right[index];

    const along = normaliseSafe2(atStart
      ? { x: stroke[0].x - stroke[1].x, y: stroke[0].y - stroke[1].y }
      : { x: stroke[count - 1].x - stroke[count - 2].x, y: stroke[count - 1].y - stroke[count - 2].y });
    const normal = normalise3(mat4Direction(transform, v3(along.x, along.y, 0)));

    const base = mesh.mark();
    mesh.addVertex(place(l, -depth), normal, colour);
    mesh.addVertex(place(r, -depth), normal, colour);
    mesh.addVertex(place(r, depth), normal, colour);
    mesh.addVertex(place(l, depth), normal, colour);
    mesh.addQuad(base, base + 1, base + 2, base + 3);
  };
  cap(0, true);
  cap(count - 1, false);
}

class Text3D {
  build(s, scene) {
    scene.depthTest = true;
    scene.shading = s.shading === Shading.Flat ? Shading.Lit : s.shading;

    const message = s.text != null && s.text.length > 0 ? s.text : 'Idler';

    const capHeight = 0.35 + s.size * 1.1;
    const weight = (0.05 + s.lineWidth * 0.16) * capHeight;
    const depth = (0.03 + s.length * 0.35) * capHeight;

    const textWidth = measureText(message) * capHeight;

    // Framing off the text's own width, so a long message is pulled back far
    // enough to fit rather than running off both sides. This is the thing that
    // makes the saver usable with a real message in it.
    const distance = (1.2 + s.camDistance * 2.5)
      * Math.max(1, textWidth / (2.2 * Math.max(0.5, s.aspect)))
      + capHeight;

    scene.view = mat4LookAt(
      v3(0, Math.sin(s.camTilt) * distance * 0.5, distance),
      v3(0, 0, 0), v3(0, 1, 0),
    );
    scene.proj = mat4Perspective(s.fov, Math.max(0.01, s.aspect), 0.05, distance * 6);

    if (s.fog > 0.001) {
      scene.fogStart = distance * 0.6;
      scene.fogEnd = distance * (1.5 + (1 - s.fog) * 3);
    }

    const copies = countFromDensity(s.density, 1, 8);

    // Complexity opens the tumble out from one axis to three. At zero it is the
    // plain spin about the vertical the original did.
    const roll = s.complexity;
    const tumble = mat4Mul(
      mat4Mul(mat4RotateY(s.time * 0.5), mat4RotateX(Math.sin(s.time * 0.31) * roll * 0.6)),
      mat4RotateZ(Math.sin(s.time * 0.23) * roll * 0.4),
    );

    for (let copy = 0; copy < copies; copy += 1) {
      const behind = copy * capHeight * 0.9;
      const place = mat4Mul(tumble, mat4Translate(v3(-textWidth * 0.5, -capHeight * 0.5, -behind)));

      const fraction = copies > 1 ? copy / (copies - 1) : 0;

      const classic = hsvToRgb(s.time * 0.05 + fraction * s.variation, 0.55, 1 - fraction * 0.5);
      const colour = settingsColour(s, classic, copy, copies);

      let pen = 0;
      for (const c of message) {
        const scale = capHeight * (isSmall(c) ? kSmallCapScale : 1);
        const glyph = getGlyph(c);

        for (const stroke of glyph.strokes) {
          // The glyph's own strokes are in cap-height units, so the scale goes
          // into the transform rather than into every point — which also keeps
          // the extrusion depth in the letter's units instead of the world's.
          const glyphPlace = mat4Mul(
            mat4Mul(place, mat4Translate(v3(pen, 0, 0))),
            mat4Scale(v3(scale, scale, scale)),
          );

          addSlab(scene.mesh, glyphPlace, stroke, weight / scale * 0.5, depth / scale, colour);
        }

        pen += glyph.advance * scale;
      }
    }
  }
}

/**
 * 3D Pipes.
 *
 * Plumbing growing into a box, one elbow at a time, until it fills up and starts
 * again.
 *
 * WHY THIS ONE NEEDS REPLAY. Where a pipe goes next depends on where it has
 * already been — it must not run back through itself — so the state at segment
 * 400 is not computable from the clock without segments 1 to 399. It is made pure
 * by GrowingSaver: the state at time t is DEFINED as the state reached by
 * replaying from the seed to tick floor(t * tickRate).
 *
 * A tick is ONE CELL OF TRAVEL. That is the natural unit: the smallest thing that
 * can happen, and what the alpha inside a tick interpolates — the growing tip of
 * the pipe, the only part of the picture that moves smoothly.
 *
 * Density = pipes growing at once (1..5). Complexity = the grid, 6..18 cells a
 * side. Size = pipe radius. Length = how full the box gets before it clears.
 * Variation = how often a pipe turns.
 *
 * Every so often a joint comes out as a TEAPOT instead of a ball. That was in the
 * original and it is the detail people remember, so it is here — chosen by hash
 * off the pipe and the joint index rather than by a counter, which is what keeps
 * it in the same place on a replay.
 *
 * CLEARING IS A STEP, NOT A SPECIAL CASE. When the box is full the state resets
 * inside step(), so growth carries on for as long as the clock does and the
 * replay stays a plain loop. Nothing outside this class knows a reset happened.
 */
/// Cells of travel per second.
const kPipesTickRate = 7.0;

/// The six directions a pipe can travel, ordered in opposing pairs so that the
/// reverse of direction `d` is `d ^ 1`.
const kPipeDirections = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

const kPipeBoxSize = 2.0;

class Pipes extends GrowingSaver {
  constructor() {
    super();
    this.occupied = new Uint8Array(0);
    this.pipes = [];
    this.grid = 10;
    this.placed = 0;
  }

  tickRate() { return kPipesTickRate; }

  /**
   * Only what growth reads. Size, colour and the camera all change the picture
   * without changing where the plumbing goes, and rebuilding the network when
   * somebody nudges a hue slider would make that slider stutter.
   *
   * The C++ packs these into a uint64; a string does the same job here, and
   * avoids JavaScript's bitwise operators — which are 32-bit, so the shifts the
   * C++ uses would silently collapse the top four fields onto each other.
   */
  growthKey(s) {
    return [
      s.seed,
      countFromDensity(s.density, 1, 5),
      Pipes.gridSize(s),
      Math.trunc(s.length * 255),
      Math.trunc(s.variation * 255),
    ].join(':');
  }

  resetState(s, rng) {
    this.grid = Pipes.gridSize(s);
    this.occupied = new Uint8Array(this.grid * this.grid * this.grid);
    this.pipes = [];
    this.placed = 0;

    const count = countFromDensity(s.density, 1, 5);
    for (let i = 0; i < count; i += 1) this.startPipe(rng);
  }

  step(s, rng) {
    const turnChance = 0.08 + s.variation * 0.5;

    // Fullness at which the box clears. The original did not fill the box solid
    // before restarting — it stopped while there was still space — and stopping
    // early is what keeps the shape readable.
    const capacity = Math.trunc(this.occupied.length * (0.12 + s.length * 0.5));

    let anyAlive = false;

    for (const pipe of this.pipes) {
      if (!pipe.alive) continue;

      const head = pipe.path[pipe.path.length - 1];

      // Keep going, or turn. The straight-ahead cell is tested as well as the
      // dice, so a pipe that cannot continue straight still gets to turn rather
      // than dying with space all round it.
      let direction = pipe.direction;
      if (rng.unit01() < turnChance || !this.free(Pipes.advance(head, direction))) {
        direction = this.chooseDirection(head, pipe.direction, rng);
      }

      if (direction < 0) {
        pipe.alive = false;
        continue;
      }

      const next = Pipes.advance(head, direction);
      this.occupy(next);
      pipe.path.push(next);
      pipe.direction = direction;
      this.placed += 1;
      anyAlive = true;
    }

    // Everything boxed in, or the box is as full as it is allowed to get. Both
    // mean start again — and doing it here rather than in build() is what keeps
    // the replay a plain loop with no special cases in it.
    if (!anyAlive || this.placed >= capacity) this.resetState(s, rng);
  }

  draw(s, alpha, scene) {
    this.setCamera(s, scene);

    const cell = kPipeBoxSize / this.grid;
    const radius = cell * (0.12 + s.size * 0.3);

    // Eight is where a cylinder stops reading as a prism at the sizes these are
    // drawn; more is bandwidth for nothing, and there can be a thousand of them.
    const sides = 8;

    let pipeIndex = 0;
    for (const pipe of this.pipes) {
      const colour = settingsColour(s, pipe.colour, pipeIndex, this.pipes.length);

      for (let i = 0; i + 1 < pipe.path.length; i += 1) {
        const from = this.world(pipe.path[i], cell);
        let to = this.world(pipe.path[i + 1], cell);

        // The last segment of a live pipe is the growing tip: it extends across
        // the tick rather than appearing whole. This is the only thing `alpha`
        // is for, and it is what stops the picture stepping at the tick rate.
        const isTip = pipe.alive && i + 2 === pipe.path.length;
        if (isTip) to = lerp3(from, to, Math.max(0.02, alpha));

        const along = sub3(to, from);
        scene.mesh.addCylinder(mat4Mul(mat4Translate(from), mat4AlignZTo(along)),
          radius, length3(along), sides, colour, false, false);
      }

      // A ball capping the very start, so a pipe does not begin with an open
      // tube end.
      if (pipe.path.length > 0) {
        scene.mesh.addSphere(mat4Translate(this.world(pipe.path[0], cell)),
          radius * 1.28, 6, sides, colour);
      }

      // A ball at each CORNER, covering the mitre the two cylinders do not make.
      //
      // Only at corners. Putting one at every cell — which is cheaper, because
      // it needs no comparison — turns every straight run into a string of
      // beads: the ball has to be wider than the pipe to cover the mitre, and
      // 28% wider is not subtle.
      for (let i = 1; i + 1 < pipe.path.length; i += 1) {
        const before = pipe.path[i - 1];
        const here = pipe.path[i];
        const after = pipe.path[i + 1];

        const straight = (here.x - before.x === after.x - here.x)
          && (here.y - before.y === after.y - here.y)
          && (here.z - before.z === after.z - here.z);
        if (straight) continue;

        const at = this.world(pipe.path[i], cell);

        if (hash3(pipeIndex >>> 0, i >>> 0, s.seed) % 37 === 0) {
          addTeapot(scene.mesh, mat4Translate(at), radius * 2.6, colour);
        } else {
          scene.mesh.addSphere(mat4Translate(at), radius * 1.28, 6, sides, colour);
        }
      }

      pipeIndex += 1;
    }
  }

  static gridSize(s) { return 6 + Math.trunc(s.complexity * 12 + 0.5); }

  static advance(c, direction) {
    return {
      x: c.x + kPipeDirections[direction][0],
      y: c.y + kPipeDirections[direction][1],
      z: c.z + kPipeDirections[direction][2],
    };
  }

  inBounds(c) {
    return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < this.grid && c.y < this.grid && c.z < this.grid;
  }

  index(c) {
    return (c.z * this.grid + c.y) * this.grid + c.x;
  }

  free(c) { return this.inBounds(c) && this.occupied[this.index(c)] === 0; }

  occupy(c) { this.occupied[this.index(c)] = 1; }

  world(c, cell) {
    const half = kPipeBoxSize * 0.5;
    return v3(
      (c.x + 0.5) * cell - half,
      (c.y + 0.5) * cell - half,
      (c.z + 0.5) * cell - half,
    );
  }

  /** A free direction out of `from`, never a reversal. -1 when boxed in. */
  chooseDirection(from, current, rng) {
    const candidates = [];
    const reverse = current ^ 1;

    for (let d = 0; d < 6; d += 1) {
      if (d === reverse) continue;
      if (this.free(Pipes.advance(from, d))) candidates.push(d);
    }

    if (candidates.length === 0) return -1;

    return candidates[rng.below(candidates.length)];
  }

  startPipe(rng) {
    // A bounded number of tries for a free cell rather than a search of the whole
    // grid. Late in a fill most of the box is taken and an exhaustive search
    // would run every tick; giving up and leaving the pipe unstarted is fine,
    // because the box is about to clear anyway.
    //
    // How many numbers this draws depends on how many attempts it took, which is
    // fine and worth being clear about: the attempts are a function of the
    // occupancy, and the occupancy is a function of the replay so far. A replay
    // and a live run take the same number of attempts and so draw the same
    // numbers. What would break that is an early exit on anything outside the
    // replay — a wall-clock timeout, say — and there is none.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const start = { x: rng.below(this.grid), y: rng.below(this.grid), z: rng.below(this.grid) };
      if (!this.free(start)) continue;

      const pipe = { path: [], direction: 0, colour: v3(1, 1, 1), alive: true };
      this.occupy(start);
      pipe.path.push(start);
      pipe.direction = rng.below(6);

      // The classic look is saturated plastic rather than pastel, which is why
      // the saturation and value are pinned high and only the hue is drawn.
      pipe.colour = hsvToRgb(rng.unit01(), 0.85, 1);

      // One cell of pipe laid down immediately, so a fresh network has something
      // in it. Without this the frame at t = 0 is empty — a single cell is a
      // point, and it takes two to make a segment — and a generator that renders
      // nothing on the frame you trigger it is broken for the only way anybody
      // uses one.
      const second = Pipes.advance(start, pipe.direction);
      if (this.free(second)) {
        this.occupy(second);
        pipe.path.push(second);
        this.placed += 1;
      }

      this.pipes.push(pipe);
      this.placed += 1;
      return;
    }
  }

  setCamera(s, scene) {
    scene.depthTest = true;
    scene.shading = s.shading;

    // A slow orbit. The original's camera was fixed and the pipes grew toward
    // it; the orbit is the one change that earns its place, because a fixed
    // camera on a plugin someone leaves running for an hour is a still picture
    // with something crawling in it.
    const angle = s.time * 0.06;
    const distance = 2.6 + s.camDistance * 4;

    const eye = v3(
      Math.sin(angle) * distance,
      Math.sin(s.camTilt) * distance,
      Math.cos(angle) * distance,
    );

    scene.view = mat4LookAt(eye, v3(0, 0, 0), v3(0, 1, 0));
    scene.proj = mat4Perspective(s.fov, Math.max(0.01, s.aspect), 0.05, 40);

    if (s.fog > 0.001) {
      // Measured from the camera, so the fog keeps its depth as the camera pulls
      // back rather than swallowing the whole box.
      scene.fogStart = distance * (0.4 + (1 - s.fog) * 0.8);
      scene.fogEnd = distance + kPipeBoxSize * 1.4;
    }
  }
}

/**
 * 3D Maze.
 *
 * A first-person walk down brick corridors, taking whatever turning comes up,
 * forever.
 *
 * WHY THIS ONE NEEDS REPLAY. Which corridor the camera is in depends on every
 * junction it has already taken. Like Pipes, it is made a pure function of time
 * by GrowingSaver.
 *
 * A tick is one cell of travel, and the alpha inside it slides the camera from
 * one cell to the next — and swings the heading round a corner. That turn is the
 * only thing here that is not a straight line, and it is EASED rather than
 * linear, because a linear heading interpolation whips round the corner at a
 * constant rate and reads as a camera on rails rather than as walking.
 *
 * Complexity = the maze, 6..16 cells a side. Density = how often the walk prefers
 * a turn. Size = corridor width against wall height. Fog = how far you can see,
 * and it is the control that matters most: a corridor ending in a hard-edged wall
 * at the far clip reads as a bug, and the original faded to black too. Variation
 * = wall colour spread, which stands in for the brick texture.
 *
 * THE BRICKS ARE GEOMETRY, NOT A TEXTURE. A maze walk spends a lot of its time
 * facing a wall — you travel up to a junction and the thing in front of you is a
 * wall half a cell away. With a flat-shaded wall that frame becomes a single
 * rectangle of one colour, and it reads as the renderer having failed rather than
 * as a wall. With courses of brick on it, the same frame reads as a wall you have
 * walked up to. The geometry was right the whole time; the picture was not.
 */
/// Cells of travel per second. Slower than Pipes: a walking pace, and the
/// original's was famously unhurried.
const kMazeTickRate = 1.6;

/// Wall bits per cell.
const kNorth = 1; // -Z
const kSouth = 2; // +Z
const kWest = 4;  // -X
const kEast = 8;  // +X

/// Heading indices, and the cell offsets they mean.
const kHeadingDX = [0, 1, 0, -1];
const kHeadingDZ = [-1, 0, 1, 0];
const kHeadingWall = [kNorth, kEast, kSouth, kWest];

class Maze extends GrowingSaver {
  constructor() {
    super();
    this.cells = new Uint8Array(0);
    // How many times the walk has left each cell along each heading, indexed
    // index(cx, cz) * 4 + heading. Part of the walk's state, so it replays with
    // it. See chooseHeading().
    this.passes = new Uint32Array(0);
    this.grid = 10;
    this.x = 0; this.z = 0;
    this.previousX = 0; this.previousZ = 0;
    // The corridor being travelled along, and the one that will be taken out of
    // the cell being arrived at. See the note on step().
    this.headingIn = 0;
    this.headingOut = 0;
    // Drives the per-cell wall shade. Drawn from the stream at generation time
    // so it belongs to the maze rather than to the frame.
    this.seedForWalls = 0;
  }

  tickRate() { return kMazeTickRate; }

  growthKey(s) {
    return [s.seed, Maze.gridSize(s), Math.trunc(s.density * 255)].join(':');
  }

  resetState(s, rng) {
    this.grid = Maze.gridSize(s);
    this.generate(rng);

    // One counter per way out of every cell. Cleared here rather than in
    // generate() because it belongs to the WALK, not to the maze.
    this.passes = new Uint32Array(this.grid * this.grid * 4);

    this.x = rng.below(this.grid);
    this.z = rng.below(this.grid);

    // The first heading has to be one there is actually a corridor along, or the
    // walk opens by driving into a wall.
    this.headingIn = this.firstOpenHeading(this.x, this.z, rng);
    this.headingOut = this.chooseHeading(this.x, this.z, this.headingIn, 0.3, rng);

    this.previousX = this.x;
    this.previousZ = this.z;
  }

  /**
   * One cell of travel.
   *
   * The state carries TWO headings: the one being travelled along right now, and
   * the one that will be taken out of the cell being arrived at.
   *
   * That second one is the whole reason this is not simply "move, then decide".
   * With one heading the camera arrives at each cell still facing the corridor it
   * came down — so at the end of every move that ends in a turn, it is looking
   * directly at a wall a third of a metre away, and the frame is a flat rectangle
   * of brick. It looked like a rendering bug and it was a sequencing one.
   */
  step(s, rng) {
    this.previousX = this.x;
    this.previousZ = this.z;
    this.headingIn = this.headingOut;

    // Mark the way out before taking it. This is the whole of what stops the
    // walk retracing itself for ever — see chooseHeading().
    this.passes[this.index(this.x, this.z) * 4 + this.headingIn] += 1;

    this.x += kHeadingDX[this.headingIn];
    this.z += kHeadingDZ[this.headingIn];

    const turnBias = 0.1 + s.density * 0.6;
    this.headingOut = this.chooseHeading(this.x, this.z, this.headingIn, turnBias, rng);
  }

  draw(s, alpha, scene) {
    scene.depthTest = true;
    scene.shading = s.shading === Shading.Flat ? Shading.Lit : s.shading;

    const cell = 1.0;
    const height = cell * (0.55 + (1 - s.size) * 1.6);

    // The camera. Position slides linearly between cells; the facing holds the
    // corridor being travelled for the first part of the move and then swings
    // round to the next one, so the camera arrives already looking where it is
    // about to go.
    const kTurnStart = 0.45;
    const turnProgress = Math.max(0, (alpha - kTurnStart) / (1 - kTurnStart));
    const ease = turnProgress * turnProgress * (3 - 2 * turnProgress);

    const from = this.cellCentre(this.previousX, this.previousZ, cell);
    const to = this.cellCentre(this.x, this.z, cell);
    const eye = lerp3(from, to, alpha);
    eye.y = height * 0.5;

    // Shortest way round, so a turn from heading 3 to heading 0 goes forwards
    // through the corner rather than three-quarters of the way back round.
    // Without this, one turn in four spins the camera.
    let delta = this.headingOut - this.headingIn;
    if (delta > 2) delta -= 4;
    if (delta < -2) delta += 4;

    const angle = (this.headingIn + delta * ease) * (kPi * 0.5);

    const forward = v3(Math.sin(angle), 0, -Math.cos(angle));
    const target = add3(add3(eye, forward), v3(0, Math.sin(s.camTilt), 0));

    scene.view = mat4LookAt(eye, target, v3(0, 1, 0));
    scene.proj = mat4Perspective(s.fov, Math.max(0.01, s.aspect), 0.02, 60);

    if (s.fog > 0.001) {
      // Short. Seeing more than a few cells makes the maze read as a model
      // rather than as a place you are inside.
      scene.fogStart = cell * (0.5 + (1 - s.fog) * 5);
      scene.fogEnd = scene.fogStart + cell * (1.5 + (1 - s.fog) * 10);
    }

    const thickness = cell * 0.06;
    const half = cell * 0.5;

    for (let cz = 0; cz < this.grid; cz += 1) {
      for (let cx = 0; cx < this.grid; cx += 1) {
        const walls = this.cells[this.index(cx, cz)];
        const centre = this.cellCentre(cx, cz, cell);

        // Each face takes its shade from the cell hash.
        const shade = 0.72 + unit(hash3(cx >>> 0, cz >>> 0, this.seedForWalls))
          * 0.28 * (0.2 + s.variation);

        // The classic maze was red brick with a grey floor.
        const brick = v3(0.78 * shade, 0.30 * shade, 0.22 * shade);
        const wallColour = settingsColour(s, brick, cx + cz * this.grid, this.grid * this.grid);

        const mid = { x: centre.x, y: height * 0.5, z: centre.z };
        const cellKey = (hash2(cx >>> 0, cz >>> 0) ^ this.seedForWalls) >>> 0;

        if (walls & kNorth) {
          Maze.addBrickWall(scene.mesh, v3(mid.x, mid.y, mid.z - half), v3(half, height * 0.5, thickness),
            true, wallColour, (cellKey ^ 0x11) >>> 0, s.variation);
        }
        if (walls & kWest) {
          Maze.addBrickWall(scene.mesh, v3(mid.x - half, mid.y, mid.z), v3(thickness, height * 0.5, half),
            false, wallColour, (cellKey ^ 0x22) >>> 0, s.variation);
        }

        // South and east only on the far edge of the grid: every other one is
        // some other cell's north or west, and drawing both leaves two coplanar
        // faces fighting for the same depth.
        if ((walls & kSouth) && cz === this.grid - 1) {
          Maze.addBrickWall(scene.mesh, v3(mid.x, mid.y, mid.z + half), v3(half, height * 0.5, thickness),
            true, wallColour, (cellKey ^ 0x33) >>> 0, s.variation);
        }
        if ((walls & kEast) && cx === this.grid - 1) {
          Maze.addBrickWall(scene.mesh, v3(mid.x + half, mid.y, mid.z), v3(thickness, height * 0.5, half),
            false, wallColour, (cellKey ^ 0x44) >>> 0, s.variation);
        }

        const floorGrey = v3(0.28 * shade, 0.28 * shade, 0.30 * shade);
        const floorColour = settingsColour(s, floorGrey, cx + cz * this.grid, this.grid * this.grid);
        scene.mesh.addBox(v3(centre.x, -thickness, centre.z), v3(half, thickness, half), floorColour);

        const ceilingGrey = v3(0.16 * shade, 0.16 * shade, 0.19 * shade);
        const ceilingColour = settingsColour(s, ceilingGrey, cx + cz * this.grid, this.grid * this.grid);
        scene.mesh.addBox(v3(centre.x, height + thickness, centre.z), v3(half, thickness, half), ceilingColour);
      }
    }
  }

  static gridSize(s) { return 6 + Math.trunc(s.complexity * 10 + 0.5); }

  index(cx, cz) { return cz * this.grid + cx; }

  cellCentre(cx, cz, cell) {
    const offset = this.grid * cell * 0.5;
    return v3((cx + 0.5) * cell - offset, 0, (cz + 0.5) * cell - offset);
  }

  /**
   * A perfect maze by depth-first backtracking, with an explicit stack.
   *
   * Recursion would be the obvious way to write it and would blow the stack on a
   * large grid — the corridor this carves is a single path that can reach every
   * cell, so the recursion depth is the cell count.
   */
  generate(rng) {
    const total = this.grid * this.grid;
    this.cells = new Uint8Array(total).fill(kNorth | kSouth | kWest | kEast);

    const visited = new Uint8Array(total);
    const stack = [];

    this.seedForWalls = rng.next();

    let cx = rng.below(this.grid);
    let cz = rng.below(this.grid);
    visited[this.index(cx, cz)] = 1;
    stack.push(this.index(cx, cz));

    while (stack.length > 0) {
      const here = stack[stack.length - 1];
      cx = here % this.grid;
      cz = Math.trunc(here / this.grid);

      const options = [];
      for (let h = 0; h < 4; h += 1) {
        const nx = cx + kHeadingDX[h];
        const nz = cz + kHeadingDZ[h];
        if (nx < 0 || nz < 0 || nx >= this.grid || nz >= this.grid) continue;
        if (visited[this.index(nx, nz)]) continue;
        options.push(h);
      }

      if (options.length === 0) {
        stack.pop();
        continue;
      }

      const h = options[rng.below(options.length)];
      const nx = cx + kHeadingDX[h];
      const nz = cz + kHeadingDZ[h];

      // Knock out both sides of the wall. Removing only one leaves a corridor
      // you can walk into and not out of, and the walk tests the cell it is
      // standing in — so a one-sided wall shows up as the camera walking through
      // a wall it can still see.
      this.cells[this.index(cx, cz)] &= ~kHeadingWall[h];
      this.cells[this.index(nx, nz)] &= ~kHeadingWall[(h + 2) % 4];

      visited[this.index(nx, nz)] = 1;
      stack.push(this.index(nx, nz));
    }
  }

  /**
   * A wall slab whose two broad faces are laid up in courses of brick.
   *
   * `alongX` says which way the wall runs, which decides which axis the courses
   * run along and which pair of faces gets them. The narrow faces — the top of
   * the wall and its two ends — are left plain: they are a few centimetres wide
   * and nobody has ever looked at one.
   *
   * Bricks are inset by a mortar gap and alternate courses are offset by half a
   * brick, because a running bond is what makes it read as masonry rather than
   * as tiling.
   */
  static addBrickWall(mesh, centre, halfExtent, alongX, colour, key, variation) {
    const kCourses = 6;
    const kPerCourse = 4;
    const kMortar = 0.06; // fraction of a brick
    const faceHalf = alongX ? halfExtent.x : halfExtent.z;
    const depth = alongX ? halfExtent.z : halfExtent.x;

    // The solid slab, so the wall is still opaque seen end-on and from above.
    // The bricks sit proud of its two broad faces, so what shows between them is
    // this — which makes the slab the MORTAR, and it has to be darker than the
    // brick or the courses read as bright lines with dark gaps between them,
    // which is masonry inside out.
    const mortar = v4(colour.x * 0.45, colour.y * 0.45, colour.z * 0.5, colour.w);
    mesh.addBox(centre, halfExtent, mortar);

    const brickHeight = (halfExtent.y * 2) / kCourses;
    const brickWidth = (faceHalf * 2) / kPerCourse;

    // Proud of the slab by a hair. Enough to win the depth test at the distances
    // this is seen from, small enough not to show at a grazing angle.
    const proud = depth + 0.0015;

    for (let side = 0; side < 2; side += 1) {
      const offset = side === 0 ? proud : -proud;
      const normal = alongX
        ? v3(0, 0, side === 0 ? 1 : -1)
        : v3(side === 0 ? 1 : -1, 0, 0);

      for (let course = 0; course < kCourses; course += 1) {
        // Running bond: every other course starts half a brick along.
        const shift = course % 2 === 0 ? 0 : brickWidth * 0.5;

        // One extra brick per offset course, so the shift does not leave a gap
        // at the end of the wall. The pair that overhang are clipped by the
        // courses above and below and by the next cell's wall.
        for (let brick = -1; brick <= kPerCourse; brick += 1) {
          const u0 = -faceHalf + shift + brick * brickWidth;
          const u1 = u0 + brickWidth;

          const clampedU0 = Math.max(u0, -faceHalf);
          const clampedU1 = Math.min(u1, faceHalf);
          if (clampedU1 - clampedU0 < brickWidth * 0.15) continue;

          const v0 = -halfExtent.y + course * brickHeight;
          const v1 = v0 + brickHeight;

          const insetU = brickWidth * kMortar;
          const insetV = brickHeight * kMortar;

          const a0 = clampedU0 + insetU, a1 = clampedU1 - insetU;
          const b0 = v0 + insetV, b1 = v1 - insetV;
          if (a1 <= a0 || b1 <= b0) continue;

          // Above 1, so a brick is always brighter than the mortar behind it
          // however the variation is set.
          const shade = 1 + unit(hash3(key, course >>> 0, ((brick + 1) * 2 + side) >>> 0))
            * (0.1 + variation * 0.5);

          const brickColour = v4(colour.x * shade, colour.y * shade, colour.z * shade, colour.w);

          const corner = (u, vv) => (alongX
            ? v3(centre.x + u, centre.y + vv, centre.z + offset)
            : v3(centre.x + offset, centre.y + vv, centre.z + u));

          const base = mesh.mark();
          mesh.addVertex(corner(a0, b0), normal, brickColour);
          mesh.addVertex(corner(a1, b0), normal, brickColour);
          mesh.addVertex(corner(a1, b1), normal, brickColour);
          mesh.addVertex(corner(a0, b1), normal, brickColour);
          mesh.addQuad(base, base + 1, base + 2, base + 3);
        }
      }
    }
  }

  /** The first heading out of a cell that has a corridor along it. */
  firstOpenHeading(cx, cz, rng) {
    const options = [];
    for (let h = 0; h < 4; h += 1) {
      if ((this.cells[this.index(cx, cz)] & kHeadingWall[h]) === 0) options.push(h);
    }

    // A perfect maze has no fully walled cell, so this is never empty — but the
    // fallback costs a line and the alternative is reading past the end.
    return options.length === 0 ? 0 : options[rng.below(options.length)];
  }

  /**
   * Where to go on leaving `(cx, cz)`, having arrived along `arrived`.
   *
   * Reversing is a last resort, which is what makes the walk read as exploring
   * rather than as pacing up and down one corridor.
   *
   * The choice is made among the exits this walk has used LEAST, and that is
   * what stops it falling into a short loop and staying there. A perfect maze
   * is a tree, so what it has instead of cycles is dead ends: the walk turns
   * round at one, and carrying straight on at each junction on the way back is
   * exactly the corridor it arrived down — so it retraced its approach, hit the
   * dead end at the far end, and did it again, for minutes. Counting exits
   * fixes it, because the retrace is by definition the exit just used.
   *
   * Counting EXITS rather than CELLS is load bearing: with cell counts the walk
   * can sit between two dead ends bouncing off each in turn and never spend the
   * visit that would make the third way out the least visited.
   */
  chooseHeading(cx, cz, arrived, turnBias, rng) {
    let options = [];
    const reverse = (arrived + 2) % 4;
    let fewest = Infinity;

    for (let h = 0; h < 4; h += 1) {
      if (h === reverse) continue;
      if ((this.cells[this.index(cx, cz)] & kHeadingWall[h]) !== 0) continue;

      const used = this.passes[this.index(cx, cz) * 4 + h];
      if (used < fewest) {
        fewest = used;
        options = [];
      }
      if (used === fewest) options.push(h);
    }

    if (options.length === 0) {
      // A dead end. Turn round — and draw a number anyway, so the number of
      // draws does not depend on the branch taken. A replay that consumed a
      // different count here would diverge from a live run at the first dead
      // end, which is the sort of bug that shows up as "the maze is different
      // after you scrub".
      rng.next();
      return reverse;
    }

    // Straight on, if straight on is one of the least-walked ways out. Testing
    // membership rather than merely "is the wall open" is the whole point: an
    // open corridor the walk has already been down is not a candidate while an
    // unwalked one is on offer.
    //
    // The short-circuit is load bearing: when straight on is not a candidate,
    // unit01() is NOT drawn. The C++ has the same short-circuit, and a port
    // that always drew here would consume one extra number per turn and walk a
    // different maze from the first junction onwards.
    const straightOpen = options.indexOf(arrived) >= 0;
    if (straightOpen && rng.unit01() >= turnBias) return arrived;

    return options[rng.below(options.length)];
  }
}

//===========================================================================
// Which savers this page has.
//
// A saver that is not ported is ABSENT from the dropdown rather than present
// and dead, and it is named in `differences`. That means the dropdown index is
// not the SaverKind index, so everything crossing that boundary — the preset
// table, the renderer — goes through these two maps.
//===========================================================================

// All eleven, in the plugin's own SaverKind order — so the dropdown here is the
// dropdown there, element for element and index for index. Grouped as they were
// on the machine: the ones that shipped with Windows first, then the OpenGL ones
// that came with Plus! and became stock in 98.
const PORTED = [
  SaverKind.Mystify,
  SaverKind.Beziers,
  SaverKind.Curves,
  SaverKind.FlyingWindows,
  SaverKind.Starfield,
  SaverKind.Marquee,
  SaverKind.Maze,
  SaverKind.Pipes,
  SaverKind.FlyingObjects,
  SaverKind.FlowerBox,
  SaverKind.Text3D,
];

const saverKindFromOption = (index) => PORTED[Math.max(0, Math.min(PORTED.length - 1, index))] ?? SaverKind.Mystify;
const optionFromSaverKind = (kind) => Math.max(0, PORTED.indexOf(kind));

const SAVER_FACTORIES = {
  [SaverKind.Mystify]: () => new Mystify(),
  [SaverKind.Beziers]: () => new Beziers(),
  [SaverKind.Curves]: () => new Curves(),
  [SaverKind.Starfield]: () => new Starfield(),
  [SaverKind.FlyingWindows]: () => new FlyingWindows(),
  [SaverKind.Marquee]: () => new Marquee(),
  [SaverKind.FlyingObjects]: () => new FlyingObjects(),
  [SaverKind.FlowerBox]: () => new FlowerBox(),
  [SaverKind.Text3D]: () => new Text3D(),
  [SaverKind.Maze]: () => new Maze(),
  [SaverKind.Pipes]: () => new Pipes(),
};

//===========================================================================
// The parameters, from IdlerPlugin's constructor.
//
// Same names, same groups, same order, same defaults, same dropdown elements.
// Every numeric default is a 0..1 host value; `convert` is the plugin's own
// mapping and `display` is what the readout says, so the number beside a slider
// is the number the plugin is working in.
//===========================================================================

const degrees = (radians) => `${(radians * 180 / kPi).toFixed(0)}°`;

function buildParams(variant) {
  const isEffect = variant === 'effect';

  return [
    // ---- Saver ------------------------------------------------------------
    {
      id: 'saver', name: 'Saver', type: 'option', group: 'Saver', default: 0,
      elements: PORTED.map((k) => SAVER_NAMES[k]),
      hint: 'Which screensaver. The eleven are grouped as they were on the machine: the ones that shipped with Windows first, then the OpenGL ones from Plus!',
    },
    {
      id: 'preset', name: 'Preset', type: 'option', group: 'Saver', default: 0,
      elements: ['Custom', ...PRESET_TABLE.map((p) => p.name)],
      hint: 'The first eleven are each saver as it actually ran — the reference. Picking a saver from the dropdown alone gives you that saver driven by whatever the sliders happen to say.',
    },

    // ---- Scene ------------------------------------------------------------
    { id: 'density', name: 'Density', type: 'standard', group: 'Scene', default: 0.35, hint: 'How many of the thing: Mystify polygons, stars, pipes, flying windows.' },
    { id: 'complexity', name: 'Complexity', type: 'standard', group: 'Scene', default: 0.2, hint: 'How involved each one is: corners per polygon, the order of a Bezier, the size of the maze grid, how often a pipe turns.' },
    { id: 'size', name: 'Size', type: 'standard', group: 'Scene', default: 0.5 },
    { id: 'length', name: 'Length', type: 'standard', group: 'Scene', default: 0.45 },
    { id: 'lineWidth', name: 'Line Width', type: 'standard', group: 'Scene', default: 0.25, hint: 'Stroke weight. All lines here are real geometry — a core profile only guarantees a line width of 1.0, so glLineWidth draws hairlines and is never used.' },
    { id: 'variation', name: 'Variation', type: 'standard', group: 'Scene', default: 0.5 },
    {
      id: 'shading', name: 'Shading', type: 'option', group: 'Scene', default: Shading.Flat,
      elements: ['Flat', 'Lit', 'Wireframe'],
      hint: 'Wireframe de-indexes the mesh so each vertex can carry its own barycentric corner; every other mode leaves it shared.',
    },

    // ---- Motion -----------------------------------------------------------
    {
      id: 'sync', name: 'Sync', type: 'option', group: 'Motion', default: 0,
      elements: SYNC_NAMES,
      hint: 'Where the clock comes from. Beat and Bar need a host tempo, and a browser has none — see the notes at the foot of the page.',
    },
    {
      id: 'speed', name: 'Speed', type: 'standard', group: 'Motion', default: 0.5,
      convert: speedFromParam,
      display: (v) => `${speedFromParam(v).toFixed(2)}×`,
    },
    {
      id: 'phase', name: 'Phase', type: 'standard', group: 'Motion', default: 0,
      convert: phaseFromParam,
      display: (v) => `${phaseFromParam(v).toFixed(1)} s`,
    },
    {
      id: 'seed', name: 'Seed', type: 'standard', group: 'Motion', default: 0,
      convert: seedFromParam,
      display: (v) => String(seedFromParam(v)),
      hint: 'An integer 1..9999, so nudging the slider grows a different maze rather than an imperceptibly different one.',
    },

    // ---- Camera -----------------------------------------------------------
    {
      id: 'fov', name: 'Field of View', type: 'standard', group: 'Camera', default: 0.4,
      convert: fovFromParam,
      display: (v) => degrees(fovFromParam(v)),
      hint: 'Vertical, 20..120 degrees. Vertical so a saver composed for the frame height keeps its framing as the composition gets wider.',
    },
    { id: 'camDistance', name: 'Camera Distance', type: 'standard', group: 'Camera', default: 0.5 },
    {
      id: 'camTilt', name: 'Camera Tilt', type: 'standard', group: 'Camera', default: 0.5,
      convert: camTiltFromParam,
      display: (v) => degrees(camTiltFromParam(v)),
    },
    { id: 'fog', name: 'Fog', type: 'standard', group: 'Camera', default: 0, hint: 'Fades toward NOTHING, not toward black — which is what lets a corridor recede into whatever is behind the plugin.' },

    // ---- Colour -----------------------------------------------------------
    {
      id: 'colourMode', name: 'Colour Mode', type: 'option', group: 'Colour', default: 0,
      elements: COLOUR_MODE_NAMES,
      hint: 'Classic is each saver\'s own palette, as it was.',
    },
    { id: 'colourR', name: 'Colour', type: 'colour', group: 'Colour', default: 1 },
    { id: 'colourG', name: 'Colour_Green', type: 'colour', group: 'Colour', default: 1 },
    { id: 'colourB', name: 'Colour_Blue', type: 'colour', group: 'Colour', default: 1 },
    {
      id: 'hueSpread', name: 'Hue Spread', type: 'standard', group: 'Colour', default: 0.3,
      convert: hueSpreadFromParam,
      display: (v) => `${(hueSpreadFromParam(v) * 360).toFixed(0)}°`,
    },
    {
      id: 'hueCycle', name: 'Hue Cycle', type: 'standard', group: 'Colour', default: 0.5,
      convert: hueCycleFromParam,
      display: (v) => `${hueCycleFromParam(v).toFixed(3)} turn/s`,
    },
    { id: 'opacity', name: 'Opacity', type: 'standard', group: 'Colour', default: 1 },
    { id: 'backR', name: 'Background', type: 'colour', group: 'Colour', default: 0 },
    { id: 'backG', name: 'Background_Green', type: 'colour', group: 'Colour', default: 0 },
    { id: 'backB', name: 'Background_Blue', type: 'colour', group: 'Colour', default: 0 },
    {
      id: 'backOpacity', name: 'Background Alpha', type: 'standard', group: 'Colour',
      // The SOURCE wants opaque black — that is what makes it usable as a luma
      // mask on a layer above. The EFFECT wants the opposite: an opaque
      // background covers the clip it exists to draw over, and makes Reveal,
      // Hide and Colourise no-ops (scene alpha is 1 everywhere, so there is
      // nothing to cut against).
      default: isEffect ? 0 : 1,
    },

    // ---- Text -------------------------------------------------------------
    {
      id: 'text', name: 'Text', type: 'text', group: 'Text', default: 'Idler',
      placeholder: 'Scrolling Marquee and 3D Text',
    },

    // ---- Output -----------------------------------------------------------
    {
      id: 'maskMode', name: 'Mask Mode', type: 'option', group: 'Output', default: 0,
      elements: MASK_MODE_NAMES,
      hint: 'What the effect does with the clip. The source has nothing to mask against and ignores it — both plugins declare it so a composition can move between them without the parameter list shifting.',
    },
    { id: 'mix', name: 'Mix', type: 'standard', group: 'Output', default: 1, hint: '0 is an exact bypass in every mask mode, including Hide, where "no effect" is the clip and not transparency.' },

    // ---- Audio ------------------------------------------------------------
    { id: 'audioSize', name: 'Audio Size', type: 'standard', group: 'Audio', default: 0 },
    { id: 'audioSpeed', name: 'Audio Speed', type: 'standard', group: 'Audio', default: 0 },
  ];
}

/**
 * The factory presets, from Presets.h.
 *
 * The C++ table is positional; this names each field so the two can be compared
 * by eye. A preset covers the saver, the scene, the camera and the colour, and
 * leaves alone Sync, Phase, Seed, the text, Mask Mode, Mix and the audio
 * controls — the operator's own settings.
 */
const PRESET_TABLE = [
  // --- The eleven, as they ran ---
  { name: 'Mystify', saver: 0, density: 0.55, complexity: 0.35, size: 0.5, length: 0.45, lineWidth: 0.25, variation: 0.5, shading: 0, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Beziers', saver: 1, density: 0.3, complexity: 0.35, size: 0.5, length: 0.5, lineWidth: 0.25, variation: 0.5, shading: 0, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Curves and Colors', saver: 2, density: 0.25, complexity: 0.45, size: 0.6, length: 0.7, lineWidth: 0.2, variation: 0.5, shading: 0, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.5, hueCycle: 0.55, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Flying Windows', saver: 3, density: 0.45, complexity: 0.5, size: 0.5, length: 0.5, lineWidth: 0.3, variation: 0.4, shading: 0, speed: 0.5, fov: 0.45, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Flying Through Space', saver: 4, density: 0.55, complexity: 0.5, size: 0.35, length: 0.1, lineWidth: 0.3, variation: 0.5, shading: 0, speed: 0.5, fov: 0.45, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Scrolling Marquee', saver: 5, density: 0.5, complexity: 0.5, size: 0.55, length: 0.5, lineWidth: 0.45, variation: 0.0, shading: 0, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: '3D Maze', saver: 6, density: 0.4, complexity: 0.4, size: 0.5, length: 0.5, lineWidth: 0.3, variation: 0.5, shading: 1, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.55, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: '3D Pipes', saver: 7, density: 0.62, complexity: 0.45, size: 0.5, length: 0.6, lineWidth: 0.3, variation: 0.5, shading: 1, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.3, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.6, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: '3D Flying Objects', saver: 8, density: 0.5, complexity: 0.5, size: 0.5, length: 0.5, lineWidth: 0.3, variation: 0.6, shading: 1, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.2, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.4, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: '3D FlowerBox', saver: 9, density: 0.5, complexity: 0.55, size: 0.55, length: 0.5, lineWidth: 0.3, variation: 0.5, shading: 1, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.7, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: '3D Text', saver: 10, density: 0.5, complexity: 0.5, size: 0.55, length: 0.35, lineWidth: 0.4, variation: 0.5, shading: 1, speed: 0.5, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 0, colourR: 1.0, colourG: 1.0, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },

  // --- Looks that were never on anybody's monitor ---
  { name: 'Maze Wireframe', saver: 6, density: 0.4, complexity: 0.4, size: 0.5, length: 0.5, lineWidth: 0.4, variation: 0.5, shading: 2, speed: 0.55, fov: 0.5, camDistance: 0.5, camTilt: 0.5, fog: 0.6, colourMode: 1, colourR: 0.2, colourG: 1.0, colourB: 0.9, hueSpread: 0.3, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 0.0 },
  { name: 'Warp Speed', saver: 4, density: 0.85, complexity: 0.5, size: 0.3, length: 0.8, lineWidth: 0.3, variation: 0.5, shading: 0, speed: 0.75, fov: 0.6, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 3, colourR: 0.5, colourG: 0.7, colourB: 1.0, hueSpread: 0.3, hueCycle: 0.56, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Mystify Overdrive', saver: 0, density: 0.8, complexity: 0.6, size: 0.5, length: 0.9, lineWidth: 0.4, variation: 0.8, shading: 0, speed: 0.62, fov: 0.4, camDistance: 0.5, camTilt: 0.5, fog: 0.0, colourMode: 2, colourR: 1.0, colourG: 0.2, colourB: 0.6, hueSpread: 1.0, hueCycle: 0.53, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 1.0 },
  { name: 'Pipes Overlay', saver: 7, density: 0.45, complexity: 0.6, size: 0.4, length: 0.7, lineWidth: 0.3, variation: 0.5, shading: 1, speed: 0.6, fov: 0.35, camDistance: 0.6, camTilt: 0.5, fog: 0.0, colourMode: 2, colourR: 0.1, colourG: 0.9, colourB: 1.0, hueSpread: 0.8, hueCycle: 0.5, opacity: 1.0, backR: 0.0, backG: 0.0, backB: 0.0, backOpacity: 0.0 },
];

/**
 * The preset table in the shape the kit's menu wants, for one variant.
 *
 * Two things happen here that the C++ `applyPreset` also does:
 *
 * - The stored `saver` is a SaverKind, and the dropdown's value is an index into
 *   the ported list, so it is translated. A preset naming a saver this page has
 *   not ported is dropped from the menu entirely rather than silently landing on
 *   the wrong one.
 * - **On the effect variant the background entries are skipped**, for the same
 *   reason Mask Mode is: an effect's background is a compositing decision about
 *   somebody else's clip, not a property of how the saver looked. Without this,
 *   picking any preset re-covers the clip with opaque black.
 */
function buildPresets(variant) {
  const isEffect = variant === 'effect';
  const out = {};

  for (const preset of PRESET_TABLE) {
    if (!PORTED.includes(preset.saver)) continue;

    const { name, saver, backR, backG, backB, backOpacity, ...rest } = preset;
    out[name] = {
      ...rest,
      saver: optionFromSaverKind(saver),
      ...(isEffect ? {} : { backR, backG, backB, backOpacity }),
    };
  }

  return out;
}

//===========================================================================
// The renderer.
//===========================================================================

/** Floats per uploaded vertex: pos3, normal3, colour4, barycentric3. */
const kFloatsPerVertex = 13;

class IdlerRenderer {
  constructor(gl) {
    this.gl = gl;

    this.sceneProgram = new Program(gl, SCENE_VERTEX, SCENE_FRAGMENT, 'scene', {
      attribs: {
        vPosition: 0, vNormal: 1, vColour: 2, vBarycentric: 3,
      },
    });

    // Two composite programs, because the C++ compiles two: the HAS_INPUT
    // define is a compile-time branch, not a uniform. Building both up front
    // means switching variant does not compile a shader mid-frame.
    this.compositeSource = new Program(gl, COMPOSITE_VERTEX, compositeFragmentShader(false), 'composite (source)');
    this.compositeEffect = new Program(gl, COMPOSITE_VERTEX, compositeFragmentShader(true), 'composite (effect)');

    // Idler is the only plugin in the fleet that allocates its own framebuffer:
    // six of its savers are perspective 3D with self-overlapping geometry, and a
    // depth test needs a depth buffer. The host's is colour-only.
    this.target = new PassBuffer(gl, { filter: 'linear', depth: true });

    this.vao = gl.createVertexArray();
    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    const stride = kFloatsPerVertex * 4;
    const attribute = (location, size, offsetFloats) => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offsetFloats * 4);
    };
    attribute(0, 3, 0);
    attribute(1, 3, 3);
    attribute(2, 4, 6);
    attribute(3, 3, 10);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // A core profile refuses to draw with no VAO bound at all, even when the
    // shader sources nothing — the composite pass builds its triangle from
    // gl_VertexID, so it still needs an empty one to point at.
    this.emptyVAO = gl.createVertexArray();

    this.scene = new Scene();
    this.savers = new Map();
    this.uploadBuffer = new Float32Array(0);
    this.indexScratch = new Uint32Array(0);
  }

  saverFor(kind) {
    if (!this.savers.has(kind)) this.savers.set(kind, SAVER_FACTORIES[kind]());
    return this.savers.get(kind);
  }

  /**
   * Saver time: the host clock with speed, sync and phase folded in.
   *
   * `audioTime` is always zero here. In Resolume PT_AUDIO is an FFT buffer the
   * host fills, and a browser page has no host audio analysis — which lands
   * exactly on the plugin's own no-audio-routed path, where the two Audio knobs
   * do nothing rather than the picture twitching to a phantom signal.
   */
  currentTime(p, hostSeconds) {
    const sync = option(p.get('sync'), 4);
    const speed = speedFromParam(p.get('speed'));
    const manual = phaseFromParam(p.get('phase'));

    this.updatePhaseAnchor(sync, speed, hostSeconds);

    let driven = 0;

    switch (sync) {
      case 0: // Free
        // Not hostSeconds * speed -- see updatePhaseAnchor. Until the slider has
        // been moved this is exactly that product, because the anchor starts at
        // clock zero at time zero.
        driven = this.phaseAnchor + (hostSeconds - this.anchorClock) * speed;
        break;

      case 1: // Beat
      case 2: { // Bar
        // The plugin recovers a continuous bar number from the host's tempo and
        // its position within the bar. A browser has neither, so this lands on
        // the plugin's own fallback tempo of 120 BPM with the bar position taken
        // from the same clock — which makes Beat and Bar deterministic
        // functions of time rather than locked to anything. Said on the page.
        const tempo = 120;
        const barSeconds = 240 / tempo; // four beats to the bar
        const estimate = hostSeconds / barSeconds;
        const within = clamp01(estimate - Math.floor(estimate));

        const bars = within + Math.round(estimate - within);
        driven = (sync === 1 ? bars * 4 : bars) * speed;
        break;
      }

      case 3: // Manual
      default:
        // Speed is deliberately ignored. This is the mode for driving Phase from
        // a keyframe or a MIDI fader, and a second clock underneath it would
        // fight whatever is doing the driving.
        driven = 0;
        break;
    }

    return driven + manual;
  }

  /**
   * Carry the time reached forward across a Speed change.
   *
   * `time = clock * speed` moves the picture by `clock * delta` the instant
   * Speed changes, and here `clock` is how long the page has been open -- so
   * dragging the slider a few minutes in jumps the saver to an unrelated point
   * in its animation. Mirrors Idler.h's UpdatePhaseAnchor; this page is where a
   * visitor is guaranteed to be dragging a Speed slider, so it needs it at least
   * as much as the plugin does.
   *
   * Free only. Beat and Bar re-lock deliberately, and Manual ignores Speed; both
   * keep the anchor following so that returning to Free resumes rather than
   * leaps.
   */
  updatePhaseAnchor(sync, speed, hostSeconds) {
    if (this.phaseAnchor === undefined) {
      this.phaseAnchor = 0;
      this.anchorClock = 0;
      this.anchorSpeed = -1;
    }

    if (sync !== 0) {
      this.anchorClock = hostSeconds;
      this.anchorSpeed = speed;
      return;
    }

    if (this.anchorSpeed < 0) {
      // First frame: anchor stays at clock zero at time zero, so the expression
      // above is exactly the old product until Speed is touched.
      this.anchorSpeed = speed;
      return;
    }

    if (speed !== this.anchorSpeed) {
      // Once per change, not once per frame.
      this.phaseAnchor += (hostSeconds - this.anchorClock) * this.anchorSpeed;
      this.anchorClock = hostSeconds;
      this.anchorSpeed = speed;
    }
  }

  /**
   * Interleave the mesh into the upload buffer.
   *
   * A shared vertex cannot carry three different barycentric corners at once, so
   * WIREFRAME PAYS FOR ITS OWN DE-INDEXING and only wireframe does. In every
   * other mode the barycentric is (1,1,1) and the shader ignores it.
   */
  uploadMesh() {
    const gl = this.gl;
    const mesh = this.scene.mesh;
    const deIndex = this.scene.shading === Shading.Wireframe;

    const vertexCount = deIndex ? mesh.indices.length : mesh.px.length;
    const indexCount = mesh.indices.length;

    if (this.uploadBuffer.length < vertexCount * kFloatsPerVertex) {
      this.uploadBuffer = new Float32Array(vertexCount * kFloatsPerVertex);
    }
    if (this.indexScratch.length < indexCount) {
      this.indexScratch = new Uint32Array(indexCount);
    }

    const buf = this.uploadBuffer;
    let o = 0;

    const push = (i, b0, b1, b2) => {
      buf[o] = mesh.px[i]; buf[o + 1] = mesh.py[i]; buf[o + 2] = mesh.pz[i];
      buf[o + 3] = mesh.nx[i]; buf[o + 4] = mesh.ny[i]; buf[o + 5] = mesh.nz[i];
      buf[o + 6] = mesh.cr[i]; buf[o + 7] = mesh.cg[i];
      buf[o + 8] = mesh.cb[i]; buf[o + 9] = mesh.ca[i];
      buf[o + 10] = b0; buf[o + 11] = b1; buf[o + 12] = b2;
      o += kFloatsPerVertex;
    };

    if (deIndex) {
      for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        push(mesh.indices[t], 1, 0, 0);
        push(mesh.indices[t + 1], 0, 1, 0);
        push(mesh.indices[t + 2], 0, 0, 1);
        this.indexScratch[t] = t;
        this.indexScratch[t + 1] = t + 1;
        this.indexScratch[t + 2] = t + 2;
      }
    } else {
      for (let i = 0; i < mesh.px.length; i += 1) push(i, 1, 1, 1);
      this.indexScratch.set(mesh.indices);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, vertexCount * kFloatsPerVertex), gl.STREAM_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexScratch.subarray(0, indexCount), gl.STREAM_DRAW);

    return indexCount;
  }

  render({ input, params, width, height, time, variant }) {
    const gl = this.gl;
    const isEffect = variant === 'effect';

    const saverTime = this.currentTime(params, time);
    const settings = settingsFromParams(params, width, height, saverTime, params.get('text'), 0);
    settings.saver = saverKindFromOption(option(params.get('saver'), PORTED.length));

    this.scene.clear();
    this.scene.background = settings.background;
    this.saverFor(settings.saver).build(settings, this.scene);

    //-----------------------------------------------------------------------
    // Pass one: the scene, into our own target.
    //-----------------------------------------------------------------------
    this.target.ensure(width, height);
    const bg = this.scene.background;
    this.target.clearTo(bg.x, bg.y, bg.z, bg.w);

    if (this.scene.depthTest) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }

    // Culling stays OFF. Several savers are deliberately single-sided surfaces
    // seen from both sides — the Flying Windows logo, a FlowerBox mid-morph
    // where the surface passes through itself — and the fragment shader already
    // flips the normal for a back face. Culling would make those disappear from
    // one side, which reads as geometry randomly vanishing.
    gl.disable(gl.CULL_FACE);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (!this.scene.mesh.empty) {
      const indexCount = this.uploadMesh();

      const p = this.sceneProgram.use();
      gl.uniformMatrix4fv(p.location('View'), false, this.scene.view);
      gl.uniformMatrix4fv(p.location('Proj'), false, this.scene.proj);

      p.setInt('ShadingMode', this.scene.shading);
      p.set('LightDirection', this.scene.lightDirection.x, this.scene.lightDirection.y, this.scene.lightDirection.z);
      p.set('Ambient', this.scene.ambient);
      p.set('FogRange', this.scene.fogStart, this.scene.fogEnd);
      p.set('EdgeWidth', edgeWidthPixels(settings.lineWidth, width, height));

      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    }

    //-----------------------------------------------------------------------
    // Pass two: the target onto the output.
    //-----------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const composite = (isEffect ? this.compositeEffect : this.compositeSource).use();

    bindTexture(gl, 0, this.target.texture);
    // setSampler, NOT set(). set() would emit glUniform1f, GL would reject it,
    // and every sampler would stay on texture unit 0 — a completely plausible
    // picture built from the wrong texture.
    composite.setSampler('SceneTexture', 0);

    if (isEffect) {
      // The kit hands over `{ texture, width, height }`, not a bare texture.
      bindTexture(gl, 1, input.texture);
      composite.setSampler('InputTexture', 1);
      // 1,1 because the kit's clips fill their texture exactly — the generated
      // ones are rendered at the composition size and a dropped-in image gets a
      // texture its own size. In Resolume this is where a pooled or
      // power-of-two input texture says how much of itself was really drawn,
      // and sampling the whole thing would pull in undrawn padding down two
      // edges.
      composite.set('MaxUV', 1, 1);
    }

    composite.setInt('MaskMode', option(params.get('maskMode'), 4));
    composite.set('MixAmount', clamp01(params.get('mix')));

    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    bindTexture(gl, 1, null);
    bindTexture(gl, 0, null);
  }
}

//===========================================================================
// Exported for demo/tools/check_geometry.mjs, which builds every saver's mesh
// under Node and compares the triangle count, the vertex count and the bounding
// box against `idtest --geometry`. Nothing else imports these.
//===========================================================================

export {
  SaverKind, SAVER_NAMES, Shading, PORTED, SAVER_FACTORIES, PRESET_TABLE,
  buildParams, settingsFromParams, Scene, option,
};

//===========================================================================
// Mount.
//
// Guarded, because check_geometry.mjs imports this module under Node where
// there is no window and nothing to mount.
//===========================================================================

const NOT_PORTED = SAVER_NAMES.filter((_, k) => !PORTED.includes(k));

const VARIANT = typeof window === 'undefined'
  ? 'source'
  : (new URLSearchParams(window.location.search).get('variant') === 'effect' ? 'effect' : 'source');

const mounted = typeof window === 'undefined' ? null : mountDemo({
  name: VARIANT === 'effect' ? 'Idler Mask' : 'Idler',
  pluginId: 'ID01',
  tagline: 'The Windows 95/98 screensavers — Mystify, 3D Pipes, 3D Maze and the rest — as an FFGL source and mask for Resolume.',
  repo: 'https://github.com/stoatworks-labs/idler',
  page: 'https://stoatworks-labs.com/software/idler/',
  showBackdrop: true,
  sources: ['bars', 'geometry', 'detail'],
  variants: {
    label: 'Plugin',
    default: VARIANT,
    options: [
      { id: 'source', name: 'Idler', hint: 'The source: the saver on its own background.' },
      { id: 'effect', name: 'Idler Mask', hint: 'The effect: the saver composited over the clip.' },
    ],
  },
  params: buildParams(VARIANT),
  presets: buildPresets(VARIANT),
  differences: [
    ...(NOT_PORTED.length
      ? [`Only ${PORTED.length} of the eleven savers are ported to this page. Missing: ${NOT_PORTED.join(', ')}. A saver that is not here is absent from the dropdown rather than present and dead.`]
      : []),
    'The two shader programs are the plugin\'s own text, copied across and checked character for character. Everything else — the 3D engine, the eleven savers, the parameter conversions — is a HAND PORT, and a hand port is a second implementation of the thing this plugin actually does.',
    'That port is checked, but only so far. Every saver\'s mesh is built offline and compared against the plugin\'s own `idtest --geometry`: same triangle count, same vertex count, same bounding box, all eleven. That catches a mis-ported loop bound or a conversion curve that has drifted — the errors that look fine on screen. It does not compare individual vertices, colours or normals, and there is no equivalent here of `idtest --replay`, which is what proves the two growing savers rebuild identically after a scrub. A bounding box is a coarse instrument.',
    'Sync offers Free, Beat, Bar and Manual because the plugin declares all four, but a browser has no host tempo and no transport. Beat and Bar therefore run on the plugin\'s own fallback of 120 BPM with the bar position taken from the same clock, which makes them deterministic functions of time rather than locked to anything.',
    'The Audio parameter itself is not here. In Resolume it is an FFT buffer the host fills from an audio source picker, and a page has no host analysis — so the audio level is always zero, which is the plugin\'s own behaviour with nothing routed: Audio Size and Audio Speed do nothing rather than the picture twitching to a phantom signal.',
    'The display-only About parameter is not shown; it carries the plugin\'s version and licence text, which the header links cover here.',
    'Picking a preset here resets every parameter the preset does not name back to its default, where the plugin leaves Sync, Phase, Seed, the text, Mask Mode, Mix and the audio controls exactly as the operator left them.',
    'The plugin allocates its own framebuffer with a depth buffer, because a host framebuffer is colour-only and six of the savers need a depth test. This page does the same, but a browser gives no promise about the depth precision it hands back, so coplanar surfaces may z-fight here where they do not there.',
  ],
  createRenderer: (gl) => new IdlerRenderer(gl),
});

// Switching variant is instantiating the OTHER plugin, and a fresh instance runs
// its own constructor — which is where Background Alpha differs. Re-applying
// that default on the switch is what the plugin does, not something invented for
// the page; without it the effect comes up with an opaque background covering
// the clip it exists to draw over.
if (mounted) {
  let lastVariant = mounted.state.variant;
  document.addEventListener('demo:state', () => {
    if (mounted.state.variant === lastVariant) return;
    lastVariant = mounted.state.variant;

    const wanted = mounted.state.variant === 'effect' ? 0 : 1;
    mounted.params.defaults.backOpacity = wanted;
    mounted.params.set('backOpacity', wanted);
  });
}
