/**
 * Coinop — browser demo.
 *
 * `VERTEX_SHADER` and `CELL_SHADER` below are copied unedited from
 * `source/Shaders.cpp`, `#ifdef COINOP_OVER_INPUT` branches included — the two
 * bundles really are one shader compiled twice, and the picker in the transport
 * bar compiles it both ways here for the same reason.
 *
 * Everything else is a port of the simulation: `Rng.h`, `Grid.h`, `Input.h`,
 * `Sim.cpp`'s accumulator, `Controls.cpp`'s mappings, and one game class per
 * game from `source/games/`.
 *
 * **This plugin breaks the fleet's rule, knowingly, and so does this page.**
 * Everywhere else in this set a frame is a pure function of (something, phase).
 * A game cannot be written that way — Snake *is* accumulated state, and there is
 * no closed form for "where is the snake at t=91.3" that does not involve having
 * played the first 91.3 seconds. So `Sim` contains the damage with three
 * defences, all three of which are ported here because all three matter as much
 * in a browser tab as in a host:
 *
 *   1. Steps come from the clock, never from frames. A frame rate drop makes the
 *      game render less smoothly; it does not make it play slower.
 *   2. A frame with no elapsed time redraws and does not step.
 *   3. Catch-up is capped, so a backgrounded tab does not come back owing four
 *      hundred ticks and kill the snake before a pixel reaches the screen.
 *
 * The consequence for this page is worth stating plainly: **Step and Restart do
 * not mean here what they mean on the other demos.** There, any frame renders on
 * its own. Here, Step advances the simulation by one frame's worth of time and
 * cannot go back, and Restart starts a new game rather than rewinding this one.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, bindTexture } from './vendor/gl.js';

//===========================================================================
// The shaders. Copied from source/Shaders.cpp.
//===========================================================================

const VERTEX_SHADER = `#version 410 core

layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;

out vec2 uv;

void main()
{
	gl_Position = vPosition;
	uv = vUV;
}
`;

const EFFECT_DEFINE = '#define COINOP_OVER_INPUT 1\n';

const CELL_SHADER = `#version 410 core

in vec2 uv;
out vec4 fragColor;

//---------------------------------------------------------------------------
// The playfield.
//
// CellTexture is GL_RGBA8UI and read with texelFetch, never with texture().
// A normalised byte texture would hand this shader 0..1 floats and recovering
// the cell type would mean int( t.r * 255.0 + 0.5 ) and trusting every driver
// to land on the same float. An integer texture reads back the byte that was
// written, which for a value that selects a branch is the only safe thing.
//---------------------------------------------------------------------------
uniform usampler2D CellTexture;
uniform vec2  GridSize;      //cells across, cells down
uniform vec2  Resolution;    //render target, pixels
uniform int   FitMode;       //0 fit, 1 fill, 2 stretch

uniform int   PaletteMode;
uniform float CellRound;     //0 square, 1 circle
uniform float CellGap;       //0 touching, 1 mostly gap
uniform float Glow;
uniform float Scanline;
uniform float Reactive;      //how much Intensity pushes the look
uniform float Intensity;     //0..1 from the game

uniform vec4  BackColor;

#ifdef COINOP_OVER_INPUT
uniform sampler2D InputTexture;
uniform vec2  MaxUV;
uniform float Mix;
uniform int   ClipBricks;    //1: bricks show the clip through themselves
#endif

//Cell types. These match the Cell enum in Grid.h and the numbers are a
//contract -- appending is safe, reordering is not.
const uint CELL_EMPTY  = 0u;
const uint CELL_WALL   = 1u;
const uint CELL_BODY   = 2u;
const uint CELL_HEAD   = 3u;
const uint CELL_FOOD   = 4u;
const uint CELL_BRICK  = 5u;
const uint CELL_PADDLE = 6u;
const uint CELL_BALL   = 7u;
const uint CELL_ENEMY  = 8u;

//---------------------------------------------------------------------------
// Palettes. Six sets of six, indexed by role rather than by cell type, so a
// palette does not have to know what a Marcher is.
//
// Roles: 0 structure (walls), 1 primary (snake, paddle), 2 accent (head, ball),
// 3 target (food, bricks), 4 secondary (brick rows), 5 hazard (anything
// hunting the player).
//
// Hazard is its own role rather than a reuse of target because the two mean
// opposite things to the player -- one is what you are trying to reach and the
// other is what you are trying to avoid -- and a maze in which the pursuers and
// the pellets are the same colour is not a maze anybody can read. It sits
// opposite \`primary\` in every palette for that reason.
//---------------------------------------------------------------------------
vec3 paletteColor( int mode, int role, float tint )
{
	vec3 structure, primary, accent, target, secondary, hazard;

	if( mode == 0 )       //Phosphor
	{
		structure = vec3( 0.05, 0.30, 0.12 );
		primary   = vec3( 0.20, 0.95, 0.35 );
		accent    = vec3( 0.75, 1.00, 0.80 );
		target    = vec3( 0.95, 0.85, 0.25 );
		secondary = vec3( 0.10, 0.65, 0.30 );
		hazard    = vec3( 1.00, 0.25, 0.30 );
	}
	else if( mode == 1 )  //Amber
	{
		structure = vec3( 0.30, 0.14, 0.02 );
		primary   = vec3( 1.00, 0.62, 0.10 );
		accent    = vec3( 1.00, 0.92, 0.70 );
		target    = vec3( 1.00, 0.35, 0.10 );
		secondary = vec3( 0.72, 0.40, 0.06 );
		hazard    = vec3( 0.95, 0.98, 1.00 );
	}
	else if( mode == 2 )  //Ice
	{
		structure = vec3( 0.06, 0.16, 0.32 );
		primary   = vec3( 0.35, 0.75, 1.00 );
		accent    = vec3( 0.90, 0.98, 1.00 );
		target    = vec3( 0.60, 0.40, 1.00 );
		secondary = vec3( 0.20, 0.50, 0.85 );
		hazard    = vec3( 1.00, 0.30, 0.55 );
	}
	else if( mode == 3 )  //Candy
	{
		structure = vec3( 0.22, 0.10, 0.28 );
		primary   = vec3( 1.00, 0.35, 0.65 );
		accent    = vec3( 1.00, 0.90, 0.45 );
		target    = vec3( 0.45, 1.00, 0.80 );
		secondary = vec3( 0.70, 0.35, 1.00 );
		hazard    = vec3( 1.00, 0.30, 0.15 );
	}
	else if( mode == 4 )  //Mono
	{
		structure = vec3( 0.22 );
		primary   = vec3( 0.90 );
		accent    = vec3( 1.00 );
		target    = vec3( 0.62 );
		secondary = vec3( 0.45 );
		//Mono has no hue to spend, so the hazard is the one thing here that is
		//allowed to be brighter than the player. On a single-colour wall that is
		//the only channel left to say "this one kills you".
		hazard    = vec3( 0.78 );
	}
	else                  //Fire
	{
		structure = vec3( 0.20, 0.05, 0.02 );
		primary   = vec3( 1.00, 0.30, 0.05 );
		accent    = vec3( 1.00, 0.90, 0.55 );
		target    = vec3( 1.00, 0.72, 0.15 );
		secondary = vec3( 0.75, 0.12, 0.05 );
		//Fire is red all the way through, so a red hazard would vanish into it.
		//Violet is the only thing on that wheel far enough from the rest.
		hazard    = vec3( 0.85, 0.45, 1.00 );
	}

	vec3 c = primary;
	if( role == 0 )      c = structure;
	else if( role == 2 ) c = accent;
	else if( role == 3 ) c = target;
	else if( role == 4 ) c = secondary;
	else if( role == 5 ) c = hazard;

	//Tint rotates between the role's colour and the secondary end of the
	//palette, which is how one brick field gets per-row colour without six more
	//uniforms -- and how four pursuers, or four light-cycle riders, are told
	//apart without four more cell types.
	if( tint > 0.0 )
		c = mix( c, secondary, clamp( tint, 0.0, 1.0 ) * 0.75 );

	return c;
}

int roleFor( uint type )
{
	if( type == CELL_WALL )   return 0;
	if( type == CELL_BODY )   return 1;
	if( type == CELL_PADDLE ) return 1;
	if( type == CELL_HEAD )   return 2;
	if( type == CELL_BALL )   return 2;
	if( type == CELL_FOOD )   return 3;
	if( type == CELL_BRICK )  return 4;
	if( type == CELL_ENEMY )  return 5;
	return 1;
}

//---------------------------------------------------------------------------
// Playfield mapping. The grid's aspect comes from a parameter and the render
// target's from the host, and they are almost never the same -- see
// Controls.h for why the grid is deliberately not derived from the resolution.
//---------------------------------------------------------------------------
vec2 playfieldUV( vec2 p, out bool inside )
{
	float gridAR = GridSize.x / max( GridSize.y, 1.0 );
	float outAR  = Resolution.x / max( Resolution.y, 1.0 );

	if( FitMode == 2 )
	{
		inside = true;
		return p;
	}

	//Fit letterboxes, Fill crops. The only difference is which way the
	//comparison goes.
	bool wider = ( FitMode == 0 ) ? ( outAR > gridAR ) : ( outAR < gridAR );

	if( wider )
	{
		float s = gridAR / outAR;
		p.x = ( p.x - 0.5 ) / s + 0.5;
	}
	else
	{
		float s = outAR / gridAR;
		p.y = ( p.y - 0.5 ) / s + 0.5;
	}

	inside = all( greaterThanEqual( p, vec2( 0.0 ) ) ) &&
	         all( lessThan( p, vec2( 1.0 ) ) );
	return p;
}

//Signed distance to a rounded box, used for the cell shape. Negative inside.
float roundedBox( vec2 local, float halfSize, float radius )
{
	vec2 d = abs( local ) - vec2( halfSize - radius );
	return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 ) - radius;
}

//Coverage of one cell at a local position, 0 outside and 1 inside, with an
//edge softened by roughly a pixel so the shape does not alias.
float cellCoverage( vec2 local, float px )
{
	float halfSize = mix( 0.5, 0.22, clamp( CellGap, 0.0, 1.0 ) );
	float radius   = clamp( CellRound, 0.0, 1.0 ) * halfSize;
	float d        = roundedBox( local - 0.5, halfSize, radius );
	return 1.0 - smoothstep( -px, px, d );
}

void main()
{
	bool inside;
	vec2 p = playfieldUV( uv, inside );

	vec3 col = BackColor.rgb;
	float alpha = BackColor.a;

#ifdef COINOP_OVER_INPUT
	vec2 clipUV = uv * MaxUV;
	vec4 clip   = texture( InputTexture, clipUV );

	//The clip is underneath, the plugin's own background veils it, and the
	//playfield draws on top. Background Alpha therefore keeps exactly the
	//meaning it has in the source plugin.
	col   = mix( clip.rgb, BackColor.rgb, BackColor.a );
	alpha = max( clip.a, BackColor.a );
#endif

	if( inside )
	{
		//Row 0 of the cell texture is the top of the playfield; FFGL's origin
		//is bottom-left, so y flips here and nowhere else.
		vec2 cellF  = vec2( p.x, 1.0 - p.y ) * GridSize;
		ivec2 cell  = ivec2( floor( cellF ) );
		vec2 local  = fract( cellF );

		ivec2 maxCell = ivec2( GridSize ) - ivec2( 1 );
		cell = clamp( cell, ivec2( 0 ), maxCell );

		uvec4 c = texelFetch( CellTexture, cell, 0 );
		uint type = c.r;

		//Softening width in cell-local units: one output pixel, expressed in
		//the space \`local\` lives in. Without this the cells alias hard at small
		//grid sizes and shimmer when the playfield is scaled.
		float px = max( GridSize.x / max( Resolution.x, 1.0 ),
		                GridSize.y / max( Resolution.y, 1.0 ) ) * 0.5;
		px = clamp( px, 0.002, 0.5 );

		float boost = 1.0 + Intensity * Reactive * 1.4;

		if( type != CELL_EMPTY )
		{
			float shade = float( c.g ) / 255.0;
			float tint  = float( c.b ) / 5.0;

			vec3 cc = paletteColor( PaletteMode, roleFor( type ), tint );

			//Shade is a gradient within a type -- the snake's tail, a brick's
			//remaining hit points. Never taken to zero, or the tail tip
			//disappears entirely and the snake looks severed.
			cc *= mix( 0.35, 1.0, shade );
			cc *= boost;

#ifdef COINOP_OVER_INPUT
			//The reason the effect variant exists: the brick field is the clip.
			//Breaking a brick punches a hole through to the layer below.
			if( ClipBricks == 1 && type == CELL_BRICK )
				cc = clip.rgb * ( 0.65 + 0.35 * shade ) * boost;
#endif

			float cov = cellCoverage( local, px );
			col = mix( col, cc, cov );
			alpha = max( alpha, cov );
		}

		//---------------------------------------------------------------
		// Glow. Nine texelFetches of the neighbourhood, weighted by
		// distance. Cheap, and it is what stops a 32x24 playfield from
		// looking like a spreadsheet.
		//---------------------------------------------------------------
		if( Glow > 0.001 )
		{
			vec3 bloom = vec3( 0.0 );
			for( int dy = -1; dy <= 1; ++dy )
			{
				for( int dx = -1; dx <= 1; ++dx )
				{
					ivec2 n = clamp( cell + ivec2( dx, dy ), ivec2( 0 ), maxCell );
					uvec4 nc = texelFetch( CellTexture, n, 0 );
					if( nc.r == CELL_EMPTY )
						continue;

					vec2 centre = vec2( n - cell ) + vec2( 0.5 );
					float d = length( local - centre );
					float w = exp( -d * d * 1.6 );

					bloom += paletteColor( PaletteMode, roleFor( nc.r ),
					                       float( nc.b ) / 5.0 ) *
					         w * ( float( nc.g ) / 255.0 * 0.7 + 0.3 );
				}
			}

			col += bloom * Glow * 0.28 * boost;
			alpha = max( alpha, min( 1.0, length( bloom ) * Glow * 0.28 ) );
		}
	}

	//Scanlines, in output space rather than cell space -- they are a property
	//of the imagined display, not of the playfield, so they must not scale with
	//the grid.
	if( Scanline > 0.001 )
	{
		float line = 0.5 + 0.5 * cos( uv.y * Resolution.y * 3.14159265 );
		col *= mix( 1.0, 0.55 + 0.45 * line, clamp( Scanline, 0.0, 1.0 ) );
	}

#ifdef COINOP_OVER_INPUT
	col   = mix( clip.rgb, col, clamp( Mix, 0.0, 1.0 ) );
	alpha = mix( clip.a, alpha, clamp( Mix, 0.0, 1.0 ) );
#endif

	fragColor = vec4( col, clamp( alpha, 0.0, 1.0 ) );
}
`;

/// Insert a define after the `#version` line, which must come first.
function withDefines(shader, defines) {
  if (!defines) return shader;
  const afterVersion = shader.indexOf('\n');
  return afterVersion === -1
    ? shader
    : shader.slice(0, afterVersion + 1) + defines + shader.slice(afterVersion + 1);
}

//===========================================================================
// Port of source/Rng.h
//
// xorshift64*, in BigInt because it has to be exact in 64 bits. "Same seed, same
// game" is what makes the Seed parameter mean anything, and it is what lets a
// run somebody liked be got back — so this cannot be Math.random, and it cannot
// be a 53-bit approximation of the C++ either.
//===========================================================================

const U64 = (1n << 64n) - 1n;

class Rng {
  constructor(seed) {
    this.reseed(seed);
  }

  /// A zero state is xorshift's one fixed point — it emits zero forever. Seed 0
  /// is exactly the seed a user leaves the slider on, so it is remapped rather
  /// than left to produce a game where the food never moves.
  reseed(seed) {
    this.state = BigInt.asUintN(64, seed) || 0x9e3779b97f4a7c15n;
  }

  next() {
    let s = this.state;
    s ^= s >> 12n;
    s = (s ^ (s << 25n)) & U64;
    s ^= s >> 27n;
    this.state = s;
    return (s * 0x2545f4914f6cdd1dn) & U64;
  }

  /**
   * Uniform in [0, n). Rejection rather than `% n`, because modulo is biased
   * toward low values whenever n does not divide 2^32 — and n here is a grid
   * width, which never does. The bias is small, but it is a bias in *where the
   * food appears*, which is the one thing a player would notice over a long run.
   */
  below(n) {
    if (n === 0) return 0;
    const bn = BigInt(n >>> 0);
    const limit = ((1n << 32n) % bn); // 2^32 mod n, as C++'s uint32(-int32(n)) % n
    let v;
    do {
      v = this.next() >> 32n;
    } while (v < limit);
    return Number(v % bn);
  }

  /// Uniform in [0, 1). 24 bits, which is every value a float can hold in that
  /// range without repeats.
  unit() {
    return Number(this.next() >> 40n) * (1 / 16777216);
  }

  range(lo, hi) {
    return lo + (hi - lo) * this.unit();
  }

  chance(p) {
    return this.unit() < p;
  }
}

//===========================================================================
// Port of source/Controls.cpp
//===========================================================================

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FIT_NAMES = ['Fit', 'Fill', 'Stretch'];
const ASPECT_NAMES = ['16:9', '4:3', '1:1', '32:9', '9:16'];
const PALETTE_NAMES = ['Phosphor', 'Amber', 'Ice', 'Candy', 'Mono', 'Fire'];
// The plugin's full dropdown, in GameId order. The page only offers the ones
// `GAMES` actually carries a port of — see PORTED_GAME_NAMES below, and the
// notice the page prints when the two lists disagree.
const GAME_NAMES = [
  'Snake', 'Bricks', 'Marchers', 'Rally', 'Drift',
  'Stacker', 'Chase', 'Girders', 'Swarm', 'Trails', 'Reflex', 'Rafters', 'Duel',
  'Flapper',
];

/// 12 to 128, squared. A pixel map is usually at the coarse end and that is
/// where the slider needs its resolution.
const gridWidth = (t) => Math.round(12 + 116 * clamp01(t) * clamp01(t));

function gridHeight(width, aspect) {
  let ratio = 9 / 16;
  if (aspect === 1) ratio = 3 / 4;
  else if (aspect === 2) ratio = 1;
  else if (aspect === 3) ratio = 9 / 32;
  else if (aspect === 4) ratio = 16 / 9;
  // Floor of 8 rows. Below that Marchers has nowhere to put a formation and
  // Snake has no room to turn, and both would spend their whole life dying.
  return clamp(Math.round(width * ratio), 8, 256);
}

/**
 * Spread the 4096 steps across the 64-bit space rather than using them raw.
 * Adjacent seeds should give unrelated games; 1 and 2 fed straight into
 * xorshift give streams that are visibly related for the first few draws, which
 * shows up as two layers on neighbouring seeds putting the first apple in nearly
 * the same place.
 */
function seedValue(t) {
  const step = BigInt(Math.round(clamp01(t) * 4095));
  let z = (step * 0x9e3779b97f4a7c15n + 0xda3e39cb94b95bdbn) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

//===========================================================================
// Port of source/Grid.h
//
// Four bytes per cell, uploaded verbatim as RGBA8UI and read in GLSL with a
// usampler2D and texelFetch. An integer texture and not a normalised one,
// deliberately: recovering a cell type from a 0..1 float means trusting every
// driver's normalise to land on the same value, and when it does not, one cell
// type is silently mistaken for its neighbour.
//===========================================================================

const Cell = {
  Empty: 0,
  Wall: 1,
  Body: 2,
  Head: 3,
  Food: 4,
  Brick: 5,
  Paddle: 6,
  Ball: 7,
  Enemy: 8,
};

class Grid {
  constructor() {
    this.w = 0;
    this.h = 0;
    this.cells = new Uint8Array(0);
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.cells = new Uint8Array(w * h * 4);
  }

  /// Wipe to Empty. Keeps the allocation — this runs every tick.
  clear() {
    this.cells.fill(0);
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  /// Out-of-bounds writes are dropped rather than asserted. A game that
  /// rasterises a paddle straddling the edge, or a ball mid-escape on the tick
  /// before the miss is detected, is not a bug worth crashing a live show over.
  set(x, y, type, shade = 0, tint = 0, flash = 0) {
    x |= 0;
    y |= 0;
    if (!this.inBounds(x, y)) return;
    const i = (y * this.w + x) * 4;
    this.cells[i] = type;
    this.cells[i + 1] = shade;
    this.cells[i + 2] = tint;
    this.cells[i + 3] = flash;
  }

  typeAt(x, y) {
    if (!this.inBounds(x, y)) return Cell.Wall;
    return this.cells[(y * this.w + x) * 4];
  }
}

//===========================================================================
// Port of source/Input.h
//
// FFGL has no input events — it has parameters, and you poll them. A press and
// release that both happen between two frames is invisible to a poll, and at
// 50fps that is a 20 ms window a drummer hits constantly. So presses are latched
// when they arrive and drained once per tick, and it is a QUEUE rather than a
// counter because order matters: Left then Up must turn left and then up.
//===========================================================================

const Button = { Left: 0, Right: 1, Up: 2, Down: 3, Fire: 4, Reset: 5 };

class Input {
  constructor() {
    this.queue = [];
    this.held = 0;
    this.axis = 0.5;
  }

  press(b) {
    // A full queue drops the oldest, not the newest: the recent intent is what
    // the player still means.
    if (this.queue.length >= 64) this.queue.shift();
    this.queue.push(b);
  }

  pop() {
    return this.queue.length ? this.queue.shift() : null;
  }

  clear() {
    this.queue.length = 0;
  }

  setHeld(b, down) {
    const bit = 1 << b;
    this.held = down ? this.held | bit : this.held & ~bit;
  }

  isHeld(b) {
    return (this.held & (1 << b)) !== 0;
  }
}

//===========================================================================
// Port of source/Vec.h
//===========================================================================

const Dir = { Up: 0, Right: 1, Down: 2, Left: 3 };

function ahead(p, d) {
  if (d === Dir.Up) return { x: p.x, y: p.y - 1 };
  if (d === Dir.Right) return { x: p.x + 1, y: p.y };
  if (d === Dir.Down) return { x: p.x, y: p.y + 1 };
  return { x: p.x - 1, y: p.y };
}

const turnLeft = (d) => (d + 3) % 4;
const turnRight = (d) => (d + 1) % 4;
const opposite = (d) => (d + 2) % 4;

//===========================================================================
// Port of source/games/Snake.cpp
//
// The reference game: the one that is genuinely a grid all the way down, so
// nothing here has to be reconciled with anything continuous.
//
// The autopilot has to be beatable. A perfect Snake AI exists — follow a
// Hamiltonian cycle and it never dies — and it is unwatchable, and for this
// plugin it never resets, so the layer shows the same slowly-lengthening snake
// for the whole show. So it is greedy-toward-food gated by a survivability
// check, with Skill governing how often it bothers to run the check.
//===========================================================================

class Snake {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.body = [];
    this.turns = [];
    this.visited = new Uint8Array(this.w * this.h);

    // Start mid-left facing right, three long. Three and not one because a
    // one-cell snake has no body to collide with, so the first few seconds would
    // not exercise the rule that kills it.
    const cy = Math.floor(this.h / 2);
    const cx = Math.max(3, Math.floor(this.w / 4));
    this.body.push({ x: cx, y: cy });
    this.body.push({ x: cx - 1, y: cy });
    this.body.push({ x: cx - 2, y: cy });

    this.dir = Dir.Right;
    this.lastDir = Dir.Right;
    this.grow = 0;
    this.score = 0;
    this.dead = false;
    this.ticksSinceFood = 0;
    this.food = { x: 0, y: 0 };

    this.placeFood(rng);
  }

  /// Playable area, inset by the one-cell wall border.
  minX() { return 1; }
  minY() { return 1; }
  maxX() { return this.w - 2; }
  maxY() { return this.h - 2; }

  /**
   * Four to twenty-two cells a second. The curve is squared because the
   * interesting half of that range is the slow half — the difference between 4
   * and 7 is a different-feeling game, the difference between 18 and 22 is
   * nothing anybody can follow.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 4 + 18 * t * t;
  }

  blocked(p, ignoreTail) {
    if (p.x < this.minX() || p.y < this.minY() || p.x > this.maxX() || p.y > this.maxY()) {
      return true;
    }

    // The tail cell vacates on the same tick the head arrives, so moving into it
    // is legal — unless the snake is about to grow, in which case it does not
    // vacate. Getting this wrong costs one length of slack in every corner and
    // makes the autopilot far more timid than it needs to be.
    const last = this.body.length ? this.body.length - 1 : 0;
    for (let i = 0; i < this.body.length; i += 1) {
      if (ignoreTail && i === last && this.grow === 0) continue;
      if (this.body[i].x === p.x && this.body[i].y === p.y) return true;
    }

    return false;
  }

  placeFood(rng) {
    const playW = this.maxX() - this.minX() + 1;
    const playH = this.maxY() - this.minY() + 1;
    if (playW <= 0 || playH <= 0) return;

    // Rejection sampling, capped. On a nearly-full board the cap can expire, so
    // there is a deterministic sweep behind it — without that, a long snake
    // makes this loop run for an unbounded time on the render thread.
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const p = { x: this.minX() + rng.below(playW), y: this.minY() + rng.below(playH) };
      if (!this.blocked(p, false)) {
        this.food = p;
        return;
      }
    }

    for (let y = this.minY(); y <= this.maxY(); y += 1) {
      for (let x = this.minX(); x <= this.maxX(); x += 1) {
        const p = { x, y };
        if (!this.blocked(p, false)) {
          this.food = p;
          return;
        }
      }
    }

    // Board full: the snake has won. Nothing left to place.
    this.food = { ...this.body[0] };
  }

  /**
   * Free cells reachable from `from`. Used to reject a move that seals the snake
   * into a pocket smaller than itself — the trap that kills every naive greedy
   * Snake AI within thirty seconds.
   */
  reachableSpace(from) {
    this.visited.fill(0);

    if (from.x < this.minX() || from.y < this.minY() || from.x > this.maxX() || from.y > this.maxY()) {
      return 0;
    }

    // Iterative flood fill with an explicit stack, as in the plugin: recursion
    // would be a 768-deep call chain on a snaking corridor.
    const stack = [from];
    let count = 0;

    while (stack.length) {
      const p = stack.pop();

      if (p.x < this.minX() || p.y < this.minY() || p.x > this.maxX() || p.y > this.maxY()) continue;

      const idx = p.y * this.w + p.x;
      if (this.visited[idx]) continue;
      if (this.blocked(p, true)) continue;

      this.visited[idx] = 1;
      count += 1;

      for (let d = 0; d < 4; d += 1) stack.push(ahead(p, d));
    }

    return count;
  }

  chooseAutopilot(cfg, rng) {
    const forward = this.lastDir;
    const options = [forward, turnLeft(forward), turnRight(forward)];
    const skill = clamp01(cfg.skill);

    // A flat chance of ignoring the analysis entirely. This is the whole reason
    // the autopilot is beatable: at skill 1.0 it never fires, and below that it
    // is what eventually walks the snake into a wall so the layer gets a fresh
    // game. Deliberate incompetence, not a fallback.
    if (rng.chance((1 - skill) * 0.18)) return options[rng.below(3)];

    let bestScore = -1;
    let best = forward;
    let found = false;

    for (const d of options) {
      const next = ahead(this.body[0], d);
      if (this.blocked(next, true)) continue;

      // Manhattan distance to the food, inverted so bigger is better.
      const dist = Math.abs(next.x - this.food.x) + Math.abs(next.y - this.food.y);
      let score = this.w + this.h - dist;

      // The survivability gate. A move that leaves less open space than the
      // snake is long is a move into a pocket it cannot get out of, and it is
      // how every greedy Snake AI dies. Skill decides whether it is consulted,
      // so a mediocre autopilot walks into the trap a good one sees.
      if (rng.chance(skill)) {
        const space = this.reachableSpace(next);
        if (space < this.body.length) score -= 1000;
        else score += Math.min(space, 200);
      }

      if (!found || score > bestScore) {
        bestScore = score;
        best = d;
        found = true;
      }
    }

    // Every direction is fatal. Carry straight on and take it — there is nothing
    // better available and the death is what restarts the game.
    return found ? best : forward;
  }

  step(cfg, input, rng) {
    if (this.dead || !this.body.length) return;

    // Drain the queue into turns. Directions are absolute (a pad with four
    // buttons); Fire also works as a relative right turn for two-button play.
    for (let b = input.pop(); b !== null; b = input.pop()) {
      if (b === Button.Up) this.turns.push(Dir.Up);
      else if (b === Button.Down) this.turns.push(Dir.Down);
      else if (b === Button.Left) this.turns.push(Dir.Left);
      else if (b === Button.Right) this.turns.push(Dir.Right);
      else if (b === Button.Fire) {
        this.turns.push(turnRight(this.turns.length ? this.turns[this.turns.length - 1] : this.lastDir));
      }
    }

    if (cfg.autopilot) {
      this.turns.length = 0;
      this.dir = this.chooseAutopilot(cfg, rng);
    } else if (this.turns.length) {
      // One turn per tick, validated against the direction actually last
      // travelled — not against whatever the previous queued turn was. Guarding
      // against the current direction does not work: at the moment Left is
      // applied the direction is already Up, so Left passes the guard and the
      // snake eats its own neck for no visible reason.
      const want = this.turns.shift();
      if (want !== opposite(this.lastDir)) this.dir = want;

      // Cap the backlog. A held-down MIDI note repeating at 100 Hz would queue
      // turns faster than a 6 Hz tick can spend them.
      if (this.turns.length > 4) this.turns = this.turns.slice(-4);
    }

    const next = ahead(this.body[0], this.dir);
    this.lastDir = this.dir;

    if (this.blocked(next, true)) {
      this.dead = true;
      return;
    }

    this.body.unshift(next);

    if (next.x === this.food.x && next.y === this.food.y) {
      this.score += 1;
      this.grow += 2;
      this.ticksSinceFood = 0;

      // Board full — treat it as a finish so the respawn timer restarts the
      // layer, rather than leaving a solid rectangle on screen for the rest of
      // the show.
      const playCells = (this.maxX() - this.minX() + 1) * (this.maxY() - this.minY() + 1);
      if (this.body.length >= playCells) {
        this.dead = true;
        return;
      }

      this.placeFood(rng);
    } else {
      this.ticksSinceFood += 1;
    }

    if (this.grow > 0) this.grow -= 1;
    else this.body.pop();

    // A snake that has not eaten in a very long time is stuck in a loop the
    // autopilot cannot break. Ending it is better than an immortal layer that
    // stopped changing.
    if (this.ticksSinceFood > this.w * this.h * 2) this.dead = true;
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    grid.set(this.food.x, this.food.y, Cell.Food, 255);

    // Tail gradient. Drawn back-to-front so the head wins where the body
    // overlaps it on the tick it dies.
    const n = this.body.length;
    for (let i = n - 1; i >= 0; i -= 1) {
      const t = n > 1 ? i / (n - 1) : 0;
      // TRUNCATE, not round. The C++ is `uint8_t( 255.0f * ( 1.0f - t ) )`, and
      // a C cast to an integer type truncates toward zero — so a segment landing
      // on 127.5 is 127 there and would be 128 here under Math.round. Two cells
      // of the tail gradient, one shade level apart, invisible on screen and
      // caught only by demo/tools/check_sim.mjs diffing the raw cell bytes.
      const shade = Math.trunc(255 * (1 - t));
      grid.set(this.body[i].x, this.body[i].y, i === 0 ? Cell.Head : Cell.Body, shade);
    }
  }

  finished() {
    return this.dead;
  }

  /// Length as a fraction of a board-filling snake, softened. Gives the shader
  /// something that climbs through a run and resets when it dies.
  intensity() {
    const playCells = Math.max(1, (this.w - 2) * (this.h - 2));
    return Math.min(1, (this.body.length / playCells) * 4);
  }
}

//===========================================================================
// Port of source/games/Bricks.cpp
//
// The one that is continuous inside a discrete world: a ball that only ever sits
// on cell centres can travel at four angles, and a paddle that snaps to cells
// cannot be steered with a fader — so the ball and paddle live in float
// playfield coordinates and are rasterised at draw time. The bricks stay a grid,
// because they genuinely are one.
//
// Three traps, all of which ship in first drafts of this game, and all three are
// ported rather than smoothed over: tunnelling (movement is substepped to a
// quarter cell), the horizontal lock (vy is held above a floor), and the sticky
// corner (x and y are resolved separately).
//===========================================================================

const MIN_VERTICAL_SPEED = 0.35;
/// Nonzero so that a perfectly centred return cannot be perfectly vertical.
const MIN_PADDLE_OFFSET = 0.18;
const BRICK_WIDTH = 2;

class Bricks {
  /**
   * Fixed and high. Unlike Snake, Speed here scales the ball's velocity rather
   * than the tick rate — a ball advanced 8 times a second is a ball that
   * visibly teleports, however fast it is nominally travelling.
   */
  tickHz() {
    return 90;
  }

  brickCols() { return Math.floor((this.w - 2) / BRICK_WIDTH); }
  brickRow(y) { return y - this.brickTop; }
  brickIndex(col, row) { return row * this.brickCols() + col; }

  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.paddleY = this.h - 3;
    this.paddleHalf = Math.max(1.5, this.w * 0.09);
    this.paddleX = this.w * 0.5;

    this.score = 0;
    this.lives = 3;
    this.level = 0;
    this.flash = 0;

    this.ball = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };
    this.aiTarget = 0;
    this.aiCooldown = 0;
    this.brickTop = 2;
    this.brickRows = 5;
    this.bricks = [];
    this.tint = [];

    this.buildField(cfg, rng);
    this.launchBall(rng);
  }

  buildField(cfg, rng) {
    const cols = Math.max(1, this.brickCols());

    this.brickTop = 2;
    this.brickRows = clamp(Math.trunc(3 + cfg.difficulty * 5), 3, Math.max(3, Math.floor(this.h / 3)));

    this.bricks = new Uint8Array(cols * this.brickRows);
    this.tint = new Uint8Array(cols * this.brickRows);

    for (let row = 0; row < this.brickRows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const i = this.brickIndex(col, row);

        // Higher rows are tougher, which gives the field a shape as it erodes
        // rather than dissolving uniformly. One extra hit point is plenty — two
        // makes the first minute a grind.
        this.bricks[i] = row < Math.floor(this.brickRows / 3) ? 2 : 1;
        this.tint[i] = row % 6;

        // A few gaps, seeded. Purely cosmetic, but a perfectly solid wall looks
        // generated and a slightly holed one looks played-in.
        if (rng.chance(0.06)) this.bricks[i] = 0;
      }
    }
  }

  launchBall(rng) {
    this.ball = { x: this.paddleX, y: this.paddleY - 1 };
    this.waiting = true;
    this.waitTicks = 0;

    // Always upward, at a randomised angle well clear of vertical — a ball
    // launched at 90 degrees just goes up and comes back down the same column,
    // which looks broken even though it is correct.
    const angle = rng.range(0.6, 1.1) * (rng.chance(0.5) ? 1 : -1);
    this.vel = { x: Math.sin(angle), y: -Math.cos(angle) };
  }

  /// Returns the brick index, or -1.
  brickAt(x, y) {
    const row = this.brickRow(y);
    if (row < 0 || row >= this.brickRows) return -1;
    if (x < 1 || x >= this.w - 1) return -1;

    const col = Math.floor((x - 1) / BRICK_WIDTH);
    if (col < 0 || col >= this.brickCols()) return -1;

    const idx = this.brickIndex(col, row);
    if (idx < 0 || idx >= this.bricks.length || this.bricks[idx] === 0) return -1;
    return idx;
  }

  /// Trap 2. Preserve speed, force the vertical component above a floor.
  clampVertical() {
    const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
    if (speed <= 0.0001) {
      this.vel = { x: 0, y: -1 };
      return;
    }

    const minVy = speed * MIN_VERTICAL_SPEED;
    if (Math.abs(this.vel.y) < minVy) {
      this.vel.y = this.vel.y < 0 ? -minVy : minVy;

      // Rescale x so the ball does not speed up as a side effect of being
      // straightened out.
      const remaining = speed * speed - this.vel.y * this.vel.y;
      const newVx = Math.sqrt(Math.max(0, remaining));
      this.vel.x = this.vel.x < 0 ? -newVx : newVx;
    }
  }

  reflectOffPaddle() {
    let offset = clamp((this.ball.x - this.paddleX) / this.paddleHalf, -1, 1);
    const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);

    // The vertical lock, and the one that only shows up once the autopilot is
    // good. A ball returned from the exact centre leaves straight up; if the
    // column above is cleared it hits the ceiling, comes straight back down the
    // same column, and the paddle — which has had a full traversal to centre
    // itself perfectly on it — returns it at offset 0 again. The better the
    // paddle, the more perfectly the loop closes. Measured before this guard:
    // at Skill 1.0 the ball hit 14 bricks in 74 minutes and the game never
    // ended.
    if (Math.abs(offset) < MIN_PADDLE_OFFSET) {
      offset = this.vel.x < 0 ? -MIN_PADDLE_OFFSET : MIN_PADDLE_OFFSET;
    }

    // Angle from where on the paddle it landed — the control that makes the
    // game playable rather than a coin flip. 60 degrees at the tips.
    const angle = offset * 1.05;
    this.vel = { x: Math.sin(angle) * speed, y: -Math.abs(Math.cos(angle) * speed) };
    this.clampVertical();
  }

  /**
   * Straight-line prediction with wall reflections, ignoring bricks. Bricks
   * would change the answer, but the autopilot re-predicts constantly, so being
   * wrong about a brick two seconds out costs nothing.
   */
  predictLandingX() {
    if (this.vel.y <= 0) return this.paddleX;

    const dist = this.paddleY - 1 - this.ball.y;
    if (dist <= 0) return this.ball.x;

    const x = this.ball.x + this.vel.x * (dist / this.vel.y);

    // Fold the unbounded x back into the playfield — a triangle wave over the
    // playable width, which is exactly what repeated wall reflections do.
    const lo = 1;
    const hi = this.w - 1;
    const span = Math.max(1, hi - lo);

    let t = (x - lo) % (span * 2);
    if (t < 0) t += span * 2;
    if (t > span) t = span * 2 - t;

    return lo + t;
  }

  step(cfg, input, rng) {
    if (this.finished()) return;

    if (this.flash > 0) this.flash = this.flash > 24 ? this.flash - 24 : 0;

    const hz = this.tickHz(cfg);
    const dt = 1 / hz;

    // --- Paddle ---------------------------------------------------------
    if (cfg.autopilot) {
      const skill = clamp01(cfg.skill);

      // Reaction lag: re-aim every few ticks rather than every tick. A paddle
      // that tracks perfectly every frame reads as a machine; one that commits
      // to a target and corrects looks like someone playing.
      this.aiCooldown -= 1;
      if (this.aiCooldown <= 0) {
        this.aiCooldown = Math.trunc(2 + (1 - skill) * 14);

        // Error scaled by skill, and by how far the ball still has to travel —
        // misjudging a ball that is about to arrive is what actually loses a
        // life, so the error is largest early.
        const travel = Math.max(0, this.paddleY - this.ball.y) / this.h;
        const err = (1 - skill) * this.paddleHalf * 2.2 * (0.3 + travel);

        this.aiTarget = this.predictLandingX() + rng.range(-err, err);
      }

      // Move at a finite speed. An autopilot that teleports the paddle never
      // misses regardless of how bad its aim is, which makes Skill do nothing.
      const maxStep = (14 + skill * 26) * dt;
      const delta = clamp(this.aiTarget - this.paddleX, -maxStep, maxStep);
      this.paddleX += delta;
    } else {
      // The axis is the good control here: a fader or an OSC float maps straight
      // onto paddle position across the playfield.
      const want = clamp01(input.axis);
      this.paddleX = this.paddleHalf + want * (this.w - 2 * this.paddleHalf);

      // Buttons still nudge it, for surfaces with no fader to spare.
      for (let b = input.pop(); b !== null; b = input.pop()) {
        if (b === Button.Left) this.paddleX -= 1.5;
        else if (b === Button.Right) this.paddleX += 1.5;
        else if (b === Button.Fire) this.waiting = false;
      }
    }

    this.paddleX = clamp(this.paddleX, this.paddleHalf + 1, this.w - 1 - this.paddleHalf);

    // --- Ball -----------------------------------------------------------
    if (this.waiting) {
      this.ball = { x: this.paddleX, y: this.paddleY - 1 };

      // Autoplay launches itself after a beat; a human gets to wait. Either way
      // there is a cap, so a layer left alone never sits on a held ball.
      this.waitTicks += 1;
      if (this.waitTicks > Math.trunc(hz * (cfg.autopilot ? 0.6 : 3))) this.waiting = false;

      return;
    }

    const speed = (9 + cfg.speed * 22) * (0.7 + cfg.difficulty * 0.9) * (1 + this.level * 0.16);
    let remaining = speed * dt;

    // Trap 1. Never advance more than a quarter cell between collision tests.
    while (remaining > 0) {
      const stepLen = Math.min(remaining, 0.25);
      remaining -= stepLen;

      const vlen = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
      if (vlen < 0.0001) break;

      const sx = (this.vel.x / vlen) * stepLen;
      const sy = (this.vel.y / vlen) * stepLen;

      // Trap 3. X and Y resolved separately.
      {
        const nx = this.ball.x + sx;
        const cx = Math.floor(nx);
        const cy = Math.floor(this.ball.y);

        const brick = this.brickAt(cx, cy);
        if (cx < 1 || cx >= this.w - 1) {
          this.vel.x = -this.vel.x;
        } else if (brick >= 0) {
          this.bricks[brick] -= 1;
          this.score += 1;
          this.flash = 255;
          this.vel.x = -this.vel.x;
        } else {
          this.ball.x = nx;
        }
      }

      {
        const ny = this.ball.y + sy;
        const cx = Math.floor(this.ball.x);
        const cy = Math.floor(ny);

        const brick = this.brickAt(cx, cy);
        if (cy < 1) {
          this.vel.y = -this.vel.y;
        } else if (brick >= 0) {
          this.bricks[brick] -= 1;
          this.score += 1;
          this.flash = 255;
          this.vel.y = -this.vel.y;
        } else if (
          this.vel.y > 0
          && cy >= this.paddleY
          && this.ball.y < this.paddleY
          && Math.abs(this.ball.x - this.paddleX) <= this.paddleHalf + 0.5
        ) {
          this.ball.y = this.paddleY - 0.01;
          this.reflectOffPaddle();
        } else {
          this.ball.y = ny;
        }
      }

      this.clampVertical();

      if (this.ball.y > this.h) {
        this.lives -= 1;
        if (this.lives > 0) this.launchBall(rng);
        return;
      }
    }

    // --- Level clear ----------------------------------------------------
    if (this.bricksLeft() === 0) {
      this.level += 1;
      this.buildField(cfg, rng);
      this.launchBall(rng);
    }
  }

  bricksLeft() {
    let n = 0;
    for (const hp of this.bricks) if (hp > 0) n += 1;
    return n;
  }

  draw(cfg, grid) {
    grid.clear();

    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }
    for (let x = 0; x < this.w; x += 1) grid.set(x, 0, Cell.Wall);

    // Bricks. Each brick is BRICK_WIDTH cells wide and one tall, so the shader
    // gets cell-accurate edges and the effect variant samples the clip exactly
    // under each surviving cell.
    const cols = this.brickCols();
    for (let row = 0; row < this.brickRows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const hp = this.bricks[this.brickIndex(col, row)];
        if (hp === 0) continue;

        const tint = this.tint[this.brickIndex(col, row)];
        for (let k = 0; k < BRICK_WIDTH; k += 1) {
          grid.set(1 + col * BRICK_WIDTH + k, this.brickTop + row, Cell.Brick, (hp * 100) & 255, tint);
        }
      }
    }

    const px0 = Math.floor(this.paddleX - this.paddleHalf);
    const px1 = Math.ceil(this.paddleX + this.paddleHalf);
    for (let x = px0; x <= px1; x += 1) grid.set(x, this.paddleY, Cell.Paddle, 255);

    grid.set(Math.floor(this.ball.x), Math.floor(this.ball.y), Cell.Ball, 255, 0);
  }

  finished() {
    return this.lives <= 0;
  }

  /// Rises as the field empties, plus a kick on every hit.
  intensity() {
    if (!this.bricks.length) return 0;
    const cleared = 1 - this.bricksLeft() / this.bricks.length;
    return Math.min(1, cleared * 0.7 + (this.flash / 255) * 0.5);
  }
}

//===========================================================================
// Port of source/games/Rally.cpp
//
// The only game of the five with no built-in failure state: two competent
// paddles rally forever, and a layer that never resets stops being interesting
// after ninety seconds. So there is a target score, and neither paddle may be
// perfect — the error floor is non-zero even at Skill 1.0, so a long enough
// rally eventually produces a miss and somebody wins.
//
// Two-player is the reason the input model is what it is: the left paddle takes
// the Axis parameter, the right takes Up/Down. Map a fader to one and two pads
// to the other and two people play from one instance.
//===========================================================================

const RALLY_TARGET = 7;

class Rally {
  tickHz() {
    return 90;
  }

  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.half = Math.max(1.5, this.h * 0.11);
    this.paddleL = this.h * 0.5;
    this.paddleR = this.h * 0.5;
    this.targetL = this.paddleL;
    this.targetR = this.paddleR;

    this.scoreL = 0;
    this.scoreR = 0;
    this.rally = 0;
    this.flash = 0;
    this.cooldownL = 0;
    this.cooldownR = 0;
    this.serveDelay = 0;
    this.ball = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };

    this.serve(rng, rng.chance(0.5) ? -1 : 1);
  }

  serve(rng, toward) {
    this.ball = { x: this.w * 0.5, y: this.h * 0.5 };

    // Angle kept well off horizontal and well off vertical: a near-horizontal
    // serve is a straight line nobody has to move for, and a near-vertical one
    // bounces off the top and bottom without crossing the court.
    const angle = rng.range(0.35, 0.85) * (rng.chance(0.5) ? 1 : -1);
    this.vel = { x: Math.cos(angle) * toward, y: Math.sin(angle) };

    this.serveDelay = 40;
    this.rally = 0;
  }

  predictY(atX) {
    if (Math.abs(this.vel.x) < 0.0001) return this.ball.y;

    const dist = (atX - this.ball.x) / this.vel.x;
    if (dist <= 0) return this.h * 0.5;

    // Triangle-wave fold, same trick as Bricks: repeated reflections off the top
    // and bottom walls are exactly a fold of the unbounded straight line.
    const y = this.ball.y + this.vel.y * dist;
    const lo = 1;
    const hi = this.h - 1;
    const span = Math.max(1, hi - lo);

    let t = (y - lo) % (span * 2);
    if (t < 0) t += span * 2;
    if (t > span) t = span * 2 - t;

    return lo + t;
  }

  /// `side` is -1 for the left paddle, +1 for the right. Returns the new y.
  drivePaddle(y, which, cfg, rng, side) {
    const skill = clamp01(cfg.skill);
    const dt = 1 / this.tickHz(cfg);

    // Only re-aim when the ball is coming this way. A paddle that tracks a
    // receding ball looks like it is following a magnet rather than playing.
    const incoming = (side < 0 && this.vel.x < 0) || (side > 0 && this.vel.x > 0);

    const cdKey = which === 'L' ? 'cooldownL' : 'cooldownR';
    const tKey = which === 'L' ? 'targetL' : 'targetR';

    this[cdKey] -= 1;
    if (this[cdKey] <= 0) {
      this[cdKey] = Math.trunc(2 + (1 - skill) * 16);

      if (incoming) {
        const wall = side < 0 ? 2 : this.w - 3;

        // The error floor is what makes the match end. Even at Skill 1.0 this is
        // non-zero, so a long enough rally eventually produces a miss.
        const err = (0.12 + (1 - skill) * 2.4) * this.half;
        this[tKey] = this.predictY(wall) + rng.range(-err, err);
      } else {
        // Drift back toward the middle between rallies.
        this[tKey] = this.h * 0.5;
      }
    }

    const maxStep = (10 + skill * 24) * dt;
    let next = y + clamp(this[tKey] - y, -maxStep, maxStep);
    next = clamp(next, this.half + 1, this.h - 1 - this.half);
    return next;
  }

  step(cfg, input, rng) {
    if (this.finished()) return;

    if (this.flash > 0) this.flash = this.flash > 20 ? this.flash - 20 : 0;

    const dt = 1 / this.tickHz(cfg);

    // --- Paddles --------------------------------------------------------
    if (cfg.autopilot) {
      this.paddleL = this.drivePaddle(this.paddleL, 'L', cfg, rng, -1);
      this.paddleR = this.drivePaddle(this.paddleR, 'R', cfg, rng, 1);
    } else {
      // Left paddle: the Axis parameter, i.e. a fader.
      const want = clamp01(input.axis);
      this.paddleL = this.half + 1 + want * (this.h - 2 - 2 * this.half);

      // Right paddle: Up/Down. Two players, one plugin instance.
      for (let b = input.pop(); b !== null; b = input.pop()) {
        if (b === Button.Up) this.paddleR -= 1.5;
        else if (b === Button.Down) this.paddleR += 1.5;
      }

      if (input.isHeld(Button.Up)) this.paddleR -= 40 * dt;
      if (input.isHeld(Button.Down)) this.paddleR += 40 * dt;

      this.paddleR = clamp(this.paddleR, this.half + 1, this.h - 1 - this.half);
    }

    if (this.serveDelay > 0) {
      this.serveDelay -= 1;
      return;
    }

    // --- Ball -----------------------------------------------------------
    const speed = (10 + cfg.speed * 24) * (0.7 + cfg.difficulty * 0.8) * (1 + this.rally * 0.02);
    let remaining = speed * dt;

    while (remaining > 0) {
      const stepLen = Math.min(remaining, 0.25);
      remaining -= stepLen;

      const vlen = Math.sqrt(this.vel.x * this.vel.x + this.vel.y * this.vel.y);
      if (vlen < 0.0001) break;

      this.ball.x += (this.vel.x / vlen) * stepLen;
      this.ball.y += (this.vel.y / vlen) * stepLen;

      if (this.ball.y < 1) {
        this.ball.y = 1;
        this.vel.y = Math.abs(this.vel.y);
      } else if (this.ball.y > this.h - 1) {
        this.ball.y = this.h - 1;
        this.vel.y = -Math.abs(this.vel.y);
      }

      // Paddle faces sit one cell in from each wall.
      const faceL = 2;
      const faceR = this.w - 3;

      if (this.vel.x < 0 && this.ball.x <= faceL) {
        if (Math.abs(this.ball.y - this.paddleL) <= this.half + 0.5) {
          this.ball.x = faceL;
          const offset = clamp((this.ball.y - this.paddleL) / this.half, -1, 1);
          this.vel = { x: Math.abs(this.vel.x), y: offset * 0.9 };
          this.rally += 1;
          this.flash = 255;
        }
      } else if (this.vel.x > 0 && this.ball.x >= faceR) {
        if (Math.abs(this.ball.y - this.paddleR) <= this.half + 0.5) {
          this.ball.x = faceR;
          const offset = clamp((this.ball.y - this.paddleR) / this.half, -1, 1);
          this.vel = { x: -Math.abs(this.vel.x), y: offset * 0.9 };
          this.rally += 1;
          this.flash = 255;
        }
      }

      if (this.ball.x < 0) {
        this.scoreR += 1;
        this.serve(rng, 1);
        return;
      }
      if (this.ball.x > this.w) {
        this.scoreL += 1;
        this.serve(rng, -1);
        return;
      }
    }
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }

    // Centre line, dashed. Costs four lines and is most of what makes it read as
    // a court rather than as two bars and a dot.
    for (let y = 1; y < this.h - 1; y += 2) {
      grid.set(Math.floor(this.w / 2), y, Cell.Wall, 90);
    }

    const lo = Math.floor(-this.half);
    const hi = Math.ceil(this.half);

    for (let k = lo; k <= hi; k += 1) {
      grid.set(1, Math.floor(this.paddleL) + k, Cell.Paddle, 255, 0);
      grid.set(this.w - 2, Math.floor(this.paddleR) + k, Cell.Paddle, 255, 3);
    }

    grid.set(Math.floor(this.ball.x), Math.floor(this.ball.y), Cell.Ball, 255);
  }

  finished() {
    return this.scoreL >= RALLY_TARGET || this.scoreR >= RALLY_TARGET;
  }

  /// Climbs through a rally and spikes on each return.
  intensity() {
    return Math.min(1, this.rally * 0.05 + (this.flash / 255) * 0.5);
  }
}

/**
 * Port of source/games/Marchers.{h,cpp} — a formation that steps down the
 * screen while you shoot up at it.
 *
 * The best grid fit of the five: the formation genuinely is a rectangular array
 * moving in whole-cell steps, so unlike Bricks there is nothing continuous to
 * reconcile against the cells.
 *
 * THE TICK RATE IS THE DIFFICULTY. The original's famous acceleration was an
 * accident of hardware — the machine redrew every alien every frame, so as they
 * died the survivors sped up. It is reproduced deliberately here: the march
 * interval is a function of how many are left, because "the last one moves fast"
 * is the whole character of the game.
 *
 * BOMBS COME FROM THE BOTTOM OF A COLUMN, not from anywhere. Picking a random
 * live invader lets one shoot through the two rows beneath it, which looks like
 * a bug even to someone who has never seen the original.
 */
class Marchers {
  /// Shots and the cannon want a smooth rate; the formation marches on a
  /// counter underneath it rather than on its own clock.
  tickHz(cfg) {
    return 20 + clamp01(cfg.speed) * 40;
  }

  reset(cfg, rng) {
    void rng;
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.scoreValue = 0;
    this.lives = 3;
    this.wave = 0;
    this.landed = false;
    this.cannonX = Math.trunc(this.w / 2);
    this.hitFlash = 0;

    this.aiCooldown = 0;

    this.buildWave(cfg);
  }

  buildWave(cfg) {
    // Two cells per invader horizontally so they read as objects rather than as
    // a solid block at low grid sizes.
    this.cols = clamp(Math.trunc((this.w - 4) / 2), 3, 11);
    this.rows = clamp(3 + Math.trunc(cfg.difficulty * 3), 3, Math.max(3, Math.trunc((this.h - 8) / 2)));

    this.alive = new Uint8Array(this.cols * this.rows).fill(1);

    this.offsetX = 1;
    this.offsetY = 1 + Math.min(this.wave, 4); // Each wave starts lower.
    this.marchDir = 1;
    this.marchTimer = 0;

    this.bullet = { x: 0, y: 0, vy: 0, live: false };
    this.bombs = [];
  }

  index(col, row) { return row * this.cols + col; }

  aliveAt(col, row) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return false;
    return this.alive[this.index(col, row)] !== 0;
  }

  aliveCount() {
    let n = 0;
    for (let i = 0; i < this.alive.length; i += 1) n += this.alive[i] ? 1 : 0;
    return n;
  }

  lowestInColumn(col) {
    for (let row = this.rows - 1; row >= 0; row -= 1) {
      if (this.aliveAt(col, row)) return row;
    }
    return -1;
  }

  formationLeft() {
    for (let col = 0; col < this.cols; col += 1) {
      for (let row = 0; row < this.rows; row += 1) {
        if (this.aliveAt(col, row)) return this.offsetX + col * 2;
      }
    }
    return this.offsetX;
  }

  formationRight() {
    for (let col = this.cols - 1; col >= 0; col -= 1) {
      for (let row = 0; row < this.rows; row += 1) {
        if (this.aliveAt(col, row)) return this.offsetX + col * 2;
      }
    }
    return this.offsetX;
  }

  marchStep() {
    const left = this.formationLeft();
    const right = this.formationRight();

    if ((this.marchDir > 0 && right + 1 >= this.w - 1) || (this.marchDir < 0 && left - 1 <= 0)) {
      this.marchDir = -this.marchDir;
      this.offsetY += 1;
    } else {
      this.offsetX += this.marchDir;
    }

    // Landed. Not a life lost — the game is simply over, as it should be.
    for (let col = 0; col < this.cols; col += 1) {
      const row = this.lowestInColumn(col);
      if (row >= 0 && this.offsetY + row >= this.h - 3) {
        this.landed = true;
        return;
      }
    }
  }

  step(cfg, input, rng) {
    if (this.finished()) return;

    if (this.hitFlash > 0) this.hitFlash -= 1;

    const hz = this.tickHz(cfg);
    const dt = 1 / hz;
    const cannonY = this.h - 2;

    // --- March timer ------------------------------------------------------
    //
    // The acceleration. Interval falls with the survivor count, so the last
    // invader moves several times faster than a full formation.
    const total = Math.max(1, this.alive.length);
    const alive = Math.max(1, this.aliveCount());
    const frac = alive / total;
    const interval = Math.max(1, Math.trunc((2 + 16 * frac) / (0.6 + cfg.difficulty)));

    this.marchTimer += 1;
    if (this.marchTimer >= interval) {
      this.marchTimer = 0;
      this.marchStep();
      if (this.landed) return;
    }

    // --- Cannon -----------------------------------------------------------
    let wantFire = false;

    if (cfg.autopilot) {
      const skill = clamp01(cfg.skill);

      this.aiCooldown -= 1;
      if (this.aiCooldown <= 0) {
        this.aiCooldown = Math.trunc(1 + (1 - skill) * 8);

        // Aim at the lowest-hanging column — the one that will land first and
        // the one most likely to be shooting back.
        let bestCol = -1;
        let bestRow = -1;
        for (let col = 0; col < this.cols; col += 1) {
          const row = this.lowestInColumn(col);
          if (row > bestRow) {
            bestRow = row;
            bestCol = col;
          }
        }

        let target = bestCol >= 0 ? this.offsetX + bestCol * 2 : this.cannonX;

        // Dodging, at high skill only. A bomb in the cannon's column is worth
        // stepping out of; a poor player does not notice.
        for (const bomb of this.bombs) {
          if (!bomb.live) continue;

          if (Math.abs(bomb.x - this.cannonX) <= 1
            && bomb.y > this.h * 0.4 && rng.chance(skill)) {
            target = this.cannonX + (bomb.x <= this.cannonX ? 3 : -3);
          }
        }

        // Aim error, so a low skill misses honestly rather than by refusing to
        // shoot.
        if (rng.chance(1 - skill)) target += Math.trunc(rng.range(-3, 3));

        this.cannonX += (target > this.cannonX) ? 1 : (target < this.cannonX ? -1 : 0);
      }

      wantFire = !this.bullet.live && rng.chance(0.15 + skill * 0.35);
    } else {
      let b = input.pop();
      while (b !== null) {
        if (b === Button.Left) this.cannonX -= 1;
        else if (b === Button.Right) this.cannonX += 1;
        else if (b === Button.Fire) wantFire = true;
        b = input.pop();
      }

      if (input.isHeld(Button.Left)) this.cannonX -= 1;
      if (input.isHeld(Button.Right)) this.cannonX += 1;
    }

    this.cannonX = clamp(this.cannonX, 1, this.w - 2);

    if (wantFire && !this.bullet.live) {
      this.bullet.live = true;
      this.bullet.x = this.cannonX;
      this.bullet.y = cannonY - 1;
      this.bullet.vy = -28;
    }

    // --- Player shot ------------------------------------------------------
    if (this.bullet.live) {
      // Substepped for the same tunnelling reason as the ball in Bricks: a fast
      // shot must not step over the invader it should have hit.
      let travel = Math.abs(this.bullet.vy) * dt;
      while (travel > 0 && this.bullet.live) {
        const stepLen = Math.min(travel, 0.5);
        travel -= stepLen;
        this.bullet.y -= stepLen;

        if (this.bullet.y < 1) {
          this.bullet.live = false;
          break;
        }

        const row = Math.floor(this.bullet.y) - this.offsetY;
        if (row >= 0 && row < this.rows) {
          const col = this.bullet.x - this.offsetX;
          if (col >= 0 && (col % 2) === 0 && Math.trunc(col / 2) < this.cols
            && this.aliveAt(Math.trunc(col / 2), row)) {
            this.alive[this.index(Math.trunc(col / 2), row)] = 0;
            this.scoreValue += 10;
            this.bullet.live = false;
            this.hitFlash = 6;
          }
        }
      }
    }

    // --- Bombs ------------------------------------------------------------
    const bombChance = (0.01 + cfg.difficulty * 0.05) * (1 - frac * 0.5);
    if (rng.chance(bombChance) && this.bombs.length < 12) {
      const col = rng.below(this.cols);
      const row = this.lowestInColumn(col);
      if (row >= 0) {
        this.bombs.push({
          x: this.offsetX + col * 2,
          y: this.offsetY + row + 1,
          vy: 7 + cfg.difficulty * 9,
          live: true,
        });
      }
    }

    for (const bomb of this.bombs) {
      if (!bomb.live) continue;

      bomb.y += bomb.vy * dt;

      if (bomb.y >= cannonY && Math.abs(bomb.x - this.cannonX) <= 1) {
        bomb.live = false;
        this.lives -= 1;
        this.hitFlash = 12;
      } else if (bomb.y > this.h) {
        bomb.live = false;
      }
    }

    this.bombs = this.bombs.filter((s) => s.live);

    // --- Wave clear -------------------------------------------------------
    if (this.aliveCount() === 0) {
      this.wave += 1;
      this.scoreValue += 100;
      this.buildWave(cfg);
    }
  }

  draw(cfg, grid) {
    void cfg;
    grid.clear();

    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }
    for (let x = 0; x < this.w; x += 1) grid.set(x, 0, Cell.Wall);

    // Formation. Tint by row so the shader can colour the ranks differently.
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        if (!this.aliveAt(col, row)) continue;
        grid.set(this.offsetX + col * 2, this.offsetY + row, Cell.Brick, 255, row % 6);
      }
    }

    const cannonY = this.h - 2;
    grid.set(this.cannonX, cannonY, Cell.Paddle, 255);
    grid.set(this.cannonX - 1, cannonY, Cell.Paddle, 160);
    grid.set(this.cannonX + 1, cannonY, Cell.Paddle, 160);
    grid.set(this.cannonX, cannonY - 1, Cell.Paddle, 200);

    if (this.bullet.live) {
      grid.set(this.bullet.x, Math.floor(this.bullet.y), Cell.Ball, 255);
    }

    for (const bomb of this.bombs) {
      if (bomb.live) grid.set(bomb.x, Math.floor(bomb.y), Cell.Food, 200);
    }
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0 || this.landed; }

  intensity() {
    if (this.alive.length === 0) return 0;
    const cleared = 1 - this.aliveCount() / this.alive.length;
    return Math.min(1, cleared * 0.8 + (this.hitFlash / 12) * 0.4);
  }
}

//===========================================================================
// Port of source/Raster.h — drawing vector shapes into a cell grid.
//
// WHY DRIFT IS A GRID GAME AT ALL. Asteroids was never a grid: a rotating ship,
// a rock tumbling at 23 degrees, everything drifting at sub-cell speeds. The
// obvious move is a second renderer with real antialiased GL lines, and it is
// wrong twice — architecturally, because it means a second set of aspect-ratio
// bugs and a shader that has to know which game is running; and for the actual
// job, because a one-pixel antialiased line sampled onto a 30 mm pitch LED wall
// lands between fixtures and disappears. A chunky rasterised line is the only
// Asteroids that survives the trip to the lights.
//
// So state stays continuous and only the picture is discrete.
//===========================================================================

/**
 * Integer Bresenham. Used rather than a float DDA because the grid is small and
 * a DDA's rounding lets a near-horizontal line drop a cell here and there — on a
 * 32-wide playfield a one-cell gap in a rock's outline is a hole you can see the
 * background through.
 */
function drawLine(grid, x0, y0, x1, y1, type, shade = 255, tint = 0) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  // A degenerate line is one cell, not an infinite loop. Two rocks that have
  // drifted onto the same point produce exactly this.
  for (let guard = 0; guard < 4096; guard += 1) {
    grid.set(x0, y0, type, shade, tint);

    if (x0 === x1 && y0 === y1) return;

    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * A closed polygon in playfield coordinates, wrapped at the edges.
 *
 * Wrapping is done by drawing the shape up to nine times at offset origins
 * rather than by clipping each segment: a rock straddling the left edge has to
 * appear on the right, and a rock in a corner in all four. Cheap redraws into a
 * 3 KB grid are less code than a correct wrapping clipper, and `set` already
 * drops what lands out of bounds.
 */
function drawPolyWrapped(grid, xs, ys, n, type, shade = 255, tint = 0) {
  if (n < 2) return;

  const w = grid.w;
  const h = grid.h;

  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;

        const x0 = Math.floor(xs[i]) + ox * w;
        const y0 = Math.floor(ys[i]) + oy * h;
        const x1 = Math.floor(xs[j]) + ox * w;
        const y1 = Math.floor(ys[j]) + oy * h;

        // Skip the offsets that cannot touch the grid, so a screen full of
        // rocks is not nine times the work.
        const loX = x0 < x1 ? x0 : x1;
        const hiX = x0 < x1 ? x1 : x0;
        const loY = y0 < y1 ? y0 : y1;
        const hiY = y0 < y1 ? y1 : y0;
        if (hiX < 0 || loX >= w || hiY < 0 || loY >= h) continue;

        drawLine(grid, x0, y0, x1, y1, type, shade, tint);
      }
    }
  }
}

/**
 * Wrap a scalar into [0, extent).
 *
 * A plain remainder keeps the sign, so a ship that drifts off the left edge at
 * -0.5 comes back as -0.5 and never reappears.
 */
function wrapF(v, extent) {
  if (extent <= 0) return 0;
  v %= extent;
  return v < 0 ? v + extent : v;
}

/**
 * Shortest signed distance from a to b on a wrapped axis.
 *
 * Needed by the autopilot: the nearest rock to a ship at x=1 may be at x=31, and
 * a plain subtraction says it is thirty cells away and points the guns the wrong
 * way.
 */
function wrapDelta(a, b, extent) {
  let d = b - a;
  while (d > extent * 0.5) d -= extent;
  while (d < -extent * 0.5) d += extent;
  return d;
}

/**
 * Port of source/games/Drift.{h,cpp} — a ship with momentum, rocks that split,
 * and a wrapping playfield.
 *
 * MOMENTUM IS THE GAME. The temptation with a ship on a grid is to make the
 * controls positional — press left, move left. That is a different and much
 * worse game. Rotation and thrust with no braking, drifting through your own
 * previous velocity, is the whole character of it, and it is why the autopilot
 * is mostly a problem of *not* accelerating.
 *
 * WRAPPED DISTANCE, EVERYWHERE. Every comparison between two things on this
 * playfield goes through wrapDelta. A rock at x=31 on a 32-wide field is one
 * cell from a ship at x=0, not thirty-one, and a plain subtraction gets that
 * wrong in the two places it matters most: collision detection, which then
 * misses, and target selection, which then aims at the wrong rock and turns the
 * long way round to do it.
 */
const kDriftPi = 3.14159265358979323846;
const kRockVerts = 8;

class Drift {
  tickHz() {
    return 60;
  }

  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.scoreValue = 0;
    this.lives = 3;
    this.wave = 0;
    this.hitFlash = 0;
    this.fireCooldown = 0;
    this.thrusting = false;

    this.bullets = [];
    this.rocks = [];
    this.respawnShip();
    this.spawnWave(cfg, rng);
  }

  respawnShip() {
    this.ship = { x: this.w * 0.5, y: this.h * 0.5 };
    this.shipVel = { x: 0, y: 0 };
    this.angle = 0;

    // Grace period. Respawning into the rock that just killed you, and losing
    // the next life instantly, burns all three in under a second.
    this.invulnTicks = 90;
  }

  makeRock(size, at, rng, cfg) {
    const r = {
      pos: { x: at.x, y: at.y },
      vel: { x: 0, y: 0 },
      ang: 0,
      spin: 0,
      radius: 1 + size * 1.6,
      size,
      shape: new Array(kRockVerts).fill(0),
    };

    r.ang = rng.range(0, kDriftPi * 2);
    r.spin = rng.range(-1.4, 1.4);

    const speed = (1.6 + (2 - size) * 1.1) * (0.5 + cfg.difficulty * 1.2);
    const dir = rng.range(0, kDriftPi * 2);
    r.vel = { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed };

    // A jagged silhouette. Perfectly circular rocks read as bubbles, and at this
    // resolution the jaggedness is most of what says "rock".
    for (let i = 0; i < kRockVerts; i += 1) r.shape[i] = rng.range(0.68, 1.25);

    return r;
  }

  spawnWave(cfg, rng) {
    const count = clamp(3 + this.wave + Math.trunc(cfg.difficulty * 3), 3, 9);

    this.rocks = [];
    for (let i = 0; i < count; i += 1) {
      // Spawn clear of the centre, or a new wave can materialise on top of the
      // ship before the player has moved.
      let at = { x: 0, y: 0 };
      for (let attempt = 0; attempt < 32; attempt += 1) {
        at = { x: rng.range(0, this.w), y: rng.range(0, this.h) };

        const dx = wrapDelta(at.x, this.ship.x, this.w);
        const dy = wrapDelta(at.y, this.ship.y, this.h);
        if (Math.sqrt(dx * dx + dy * dy) > Math.min(this.w, this.h) * 0.28) break;
      }

      this.rocks.push(this.makeRock(2, at, rng, cfg));
    }
  }

  splitRock(index, rng, cfg) {
    const parent = this.rocks[index];

    this.rocks.splice(index, 1);
    this.scoreValue += (3 - parent.size) * 20;
    this.hitFlash = 8;

    if (parent.size <= 0) return;

    for (let i = 0; i < 2; i += 1) {
      const child = this.makeRock(parent.size - 1, parent.pos, rng, cfg);

      // Inherit some of the parent's momentum so the two halves visibly continue
      // what the parent was doing, rather than scattering at random.
      child.vel.x = child.vel.x * 0.7 + parent.vel.x * 0.6;
      child.vel.y = child.vel.y * 0.7 + parent.vel.y * 0.6;
      this.rocks.push(child);
    }
  }

  /** Returns whether to fire. */
  autopilot(cfg, rng) {
    const skill = clamp01(cfg.skill);
    const dt = 1 / this.tickHz(cfg);

    // Nearest rock by wrapped distance.
    let bestDist = 1e9;
    let bestBear = 0;
    let nearest = null;

    for (const r of this.rocks) {
      const dx = wrapDelta(this.ship.x, r.pos.x, this.w);
      const dy = wrapDelta(this.ship.y, r.pos.y, this.h);
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d < bestDist) {
        bestDist = d;
        // Screen y grows downward, so the bearing is atan2(dx, -dy) for an angle
        // measured clockwise from up.
        bestBear = Math.atan2(dx, -dy);
        nearest = r;
      }
    }

    if (!nearest) return false;

    // Shortest signed turn onto the bearing.
    let delta = bestBear - this.angle;
    while (delta > kDriftPi) delta -= kDriftPi * 2;
    while (delta < -kDriftPi) delta += kDriftPi * 2;

    // Aim error, so a low skill sprays. Scaled by distance because misjudging a
    // far rock is forgivable and misjudging a near one is what kills.
    const aimErr = (1 - skill) * 0.5;
    delta += rng.range(-aimErr, aimErr);

    const turnRate = (2.2 + skill * 1.6) * dt;
    this.angle += clamp(delta, -turnRate, turnRate);

    // Fire when roughly on target. The tolerance loosens as skill drops, which
    // makes a poor autopilot shoot more and hit less — the right shape.
    let fire = Math.abs(delta) < (0.12 + (1 - skill) * 0.5);

    // Evasion. Thrust away from anything close, but only if the autopilot is
    // good enough to have noticed. This is the main thing Skill buys here: below
    // about 0.5 the ship mostly sits still and gets hit.
    this.thrusting = false;
    if (bestDist < nearest.radius + 5 && rng.chance(skill)) {
      const away = bestBear + kDriftPi;
      let fleeDelta = away - this.angle;
      while (fleeDelta > kDriftPi) fleeDelta -= kDriftPi * 2;
      while (fleeDelta < -kDriftPi) fleeDelta += kDriftPi * 2;

      this.angle += clamp(fleeDelta, -turnRate, turnRate);
      this.thrusting = true;
      fire = false;
    } else if (Math.sqrt(this.shipVel.x * this.shipVel.x + this.shipVel.y * this.shipVel.y) < 0.5
      && rng.chance(0.01)) {
      // Occasional drift so a safe ship does not sit motionless in the middle of
      // the screen for a whole wave.
      this.thrusting = true;
    }

    return fire;
  }

  step(cfg, input, rng) {
    if (this.finished()) return;

    const dt = 1 / this.tickHz(cfg);

    if (this.invulnTicks > 0) this.invulnTicks -= 1;
    if (this.hitFlash > 0) this.hitFlash -= 1;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    let fire = false;

    if (cfg.autopilot) {
      fire = this.autopilot(cfg, rng);
    } else {
      this.thrusting = input.isHeld(Button.Up);

      const turnRate = 3.4 * dt;
      if (input.isHeld(Button.Left)) this.angle -= turnRate;
      if (input.isHeld(Button.Right)) this.angle += turnRate;

      let b = input.pop();
      while (b !== null) {
        if (b === Button.Fire) fire = true;
        else if (b === Button.Left) this.angle -= 0.25;
        else if (b === Button.Right) this.angle += 0.25;
        else if (b === Button.Up) this.thrusting = true;
        b = input.pop();
      }
    }

    // --- Ship -------------------------------------------------------------
    if (this.thrusting) {
      const accel = 14 * dt;
      this.shipVel.x += Math.sin(this.angle) * accel;
      this.shipVel.y += -Math.cos(this.angle) * accel;
    }

    // Drag, and a speed cap. No drag at all is more authentic and much less
    // playable on a field this small — the ship reaches a speed where it crosses
    // the playfield faster than anyone can react.
    const drag = Math.pow(0.985, dt * 60);
    this.shipVel.x *= drag;
    this.shipVel.y *= drag;

    const sp = Math.sqrt(this.shipVel.x * this.shipVel.x + this.shipVel.y * this.shipVel.y);
    const maxSp = 16;
    if (sp > maxSp) {
      this.shipVel.x *= maxSp / sp;
      this.shipVel.y *= maxSp / sp;
    }

    this.ship.x = wrapF(this.ship.x + this.shipVel.x * dt, this.w);
    this.ship.y = wrapF(this.ship.y + this.shipVel.y * dt, this.h);

    // --- Bullets ----------------------------------------------------------
    if (fire && this.fireCooldown <= 0 && this.bullets.length < 6) {
      const muzzle = 1.2;
      this.bullets.push({
        pos: {
          x: wrapF(this.ship.x + Math.sin(this.angle) * muzzle, this.w),
          y: wrapF(this.ship.y - Math.cos(this.angle) * muzzle, this.h),
        },
        vel: {
          x: Math.sin(this.angle) * 26 + this.shipVel.x,
          y: -Math.cos(this.angle) * 26 + this.shipVel.y,
        },
        life: 0.9,
      });

      this.fireCooldown = 0.18;
    }

    for (const b of this.bullets) {
      b.life -= dt;
      b.pos.x = wrapF(b.pos.x + b.vel.x * dt, this.w);
      b.pos.y = wrapF(b.pos.y + b.vel.y * dt, this.h);
    }

    this.bullets = this.bullets.filter((b) => b.life > 0);

    // --- Rocks ------------------------------------------------------------
    for (const r of this.rocks) {
      r.pos.x = wrapF(r.pos.x + r.vel.x * dt, this.w);
      r.pos.y = wrapF(r.pos.y + r.vel.y * dt, this.h);
      r.ang += r.spin * dt;
    }

    // --- Bullet/rock ------------------------------------------------------
    for (let bi = 0; bi < this.bullets.length;) {
      let consumed = false;

      for (let ri = 0; ri < this.rocks.length; ri += 1) {
        const dx = wrapDelta(this.bullets[bi].pos.x, this.rocks[ri].pos.x, this.w);
        const dy = wrapDelta(this.bullets[bi].pos.y, this.rocks[ri].pos.y, this.h);

        if (dx * dx + dy * dy <= this.rocks[ri].radius * this.rocks[ri].radius) {
          this.bullets.splice(bi, 1);
          this.splitRock(ri, rng, cfg);
          consumed = true;
          break;
        }
      }

      if (!consumed) bi += 1;
    }

    // --- Ship/rock --------------------------------------------------------
    if (this.invulnTicks === 0) {
      for (const r of this.rocks) {
        const dx = wrapDelta(this.ship.x, r.pos.x, this.w);
        const dy = wrapDelta(this.ship.y, r.pos.y, this.h);

        // Ship treated as a point with a small hull radius. Polygon-exact
        // collision would be more correct and, at this resolution, entirely
        // invisible.
        const hull = r.radius + 0.7;
        if (dx * dx + dy * dy <= hull * hull) {
          this.lives -= 1;
          this.hitFlash = 20;
          this.bullets = [];
          if (this.lives > 0) this.respawnShip();
          return;
        }
      }
    }

    // --- Wave clear -------------------------------------------------------
    if (this.rocks.length === 0) {
      this.wave += 1;
      this.scoreValue += 150;
      this.spawnWave(cfg, rng);
    }
  }

  draw(cfg, grid) {
    void cfg;
    grid.clear();

    // No border. This playfield wraps, and drawing walls around a wrapping field
    // tells the viewer the opposite of the truth.

    for (const r of this.rocks) {
      const xs = new Array(kRockVerts);
      const ys = new Array(kRockVerts);

      for (let i = 0; i < kRockVerts; i += 1) {
        const a = r.ang + i * (kDriftPi * 2 / kRockVerts);
        xs[i] = r.pos.x + Math.cos(a) * r.radius * r.shape[i];
        ys[i] = r.pos.y + Math.sin(a) * r.radius * r.shape[i];
      }

      drawPolyWrapped(grid, xs, ys, kRockVerts, Cell.Brick, 140 + r.size * 40, r.size);
    }

    for (const b of this.bullets) {
      grid.set(Math.floor(b.pos.x), Math.floor(b.pos.y), Cell.Ball, 255);
    }

    // Ship: a nose, two flanks and a notched tail. Four points is the smallest
    // shape that still reads as pointing somewhere at this size.
    if (this.lives > 0) {
      const nose = 1.9;
      const flank = 1.3;
      const sweep = 2.5;

      const pts = [
        [0, -nose],
        [flank, sweep * 0.45],
        [0, sweep * 0.12],
        [-flank, sweep * 0.45],
      ];

      const xs = new Array(4);
      const ys = new Array(4);
      const c = Math.cos(this.angle);
      const s = Math.sin(this.angle);

      for (let i = 0; i < 4; i += 1) {
        xs[i] = this.ship.x + pts[i][0] * c - pts[i][1] * s;
        ys[i] = this.ship.y + pts[i][0] * s + pts[i][1] * c;
      }

      // Blink while invulnerable, which is both the convention and the only way
      // to tell that a respawned ship is not yet solid.
      const visible = this.invulnTicks === 0 || Math.trunc(this.invulnTicks / 6) % 2 === 0;
      if (visible) drawPolyWrapped(grid, xs, ys, 4, Cell.Head, 255);

      if (this.thrusting && visible) {
        const fx = this.ship.x - s * (sweep * 0.8);
        const fy = this.ship.y + c * (sweep * 0.8);
        grid.set(Math.floor(fx), Math.floor(fy), Cell.Food, 220);
      }
    }
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    return Math.min(1, this.rocks.length * 0.08 + (this.hitFlash / 20) * 0.6);
  }
}

//===========================================================================
// Port of source/games/Stacker.{h,cpp}
//
// The falling-block game, and the one whose *differences* from the obvious
// implementation are the point: a piece set that is not the seven tetrominoes,
// a well that is whatever the Grid parameter says, and a clear rule that takes
// any contiguous run of `runNeeded` cells rather than a full row.
//
// Every part of this game is integer, deliberately — including the placement
// search. It is the one port here with nothing for a JavaScript double to
// disagree with the C++ float about.
//===========================================================================

const STACKER_MAX_CELLS = 5;

/**
 * Ten polyominoes across three sizes. Two trominoes, four tetrominoes, four
 * pentominoes — a set, not *the* set.
 *
 * The weights matter more than they look: an even draw puts a five-cell piece
 * in front of the player two times in five, and the board fills faster than any
 * placement can clear it.
 */
const STACKER_PIECES = [
  { x: [0, 1, 2], y: [0, 0, 0], weight: 4 }, // bar
  { x: [0, 0, 1], y: [0, 1, 1], weight: 4 }, // corner
  { x: [0, 1, 0, 1], y: [0, 0, 1, 1], weight: 3 }, // square
  { x: [0, 1, 2, 1], y: [0, 0, 0, 1], weight: 3 }, // tee
  { x: [1, 2, 0, 1], y: [0, 0, 1, 1], weight: 2 }, // skew
  { x: [0, 0, 1, 2], y: [0, 1, 1, 1], weight: 3 }, // foot
  { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 0], weight: 1 }, // long bar
  { x: [0, 2, 0, 1, 2], y: [0, 0, 1, 1, 1], weight: 1 }, // cup
  { x: [0, 1, 0, 1, 0], y: [0, 0, 1, 1, 2], weight: 1 }, // block-and-tail
  { x: [0, 0, 1, 1, 2], y: [0, 1, 1, 2, 2], weight: 1 }, // stair
];

const STACKER_TOTAL_WEIGHT = STACKER_PIECES.reduce((a, p) => a + p.weight, 0);

function stackerPickKind(rng) {
  let roll = rng.below(STACKER_TOTAL_WEIGHT);
  for (let i = 0; i < STACKER_PIECES.length; i += 1) {
    roll -= STACKER_PIECES[i].weight;
    if (roll < 0) return i;
  }
  return 0;
}

/**
 * One rotation, computed rather than tabulated. Forty tabulated shapes would be
 * forty chances to typo a cell into the wrong column and nothing would catch it.
 *
 * `(x,y) -> (-y,x)`, then normalise the bounding box back to the origin.
 * Normalising is the part that is easy to leave out and it is what keeps the
 * piece under the player's hand.
 */
function stackerShape(kind, rot) {
  kind = clamp(kind, 0, STACKER_PIECES.length - 1);
  rot = ((rot % 4) + 4) % 4;

  const base = STACKER_PIECES[kind];
  const count = base.x.length;
  const cx = base.x.slice();
  const cy = base.y.slice();

  for (let r = 0; r < rot; r += 1) {
    for (let i = 0; i < count; i += 1) {
      const x = cx[i];
      cx[i] = -cy[i];
      cy[i] = x;
    }
  }

  let minX = cx[0];
  let minY = cy[0];
  let maxX = minX;
  let maxY = minY;
  for (let i = 1; i < count; i += 1) {
    if (cx[i] < minX) minX = cx[i];
    if (cy[i] < minY) minY = cy[i];
    if (cx[i] > maxX) maxX = cx[i];
    if (cy[i] > maxY) maxY = cy[i];
  }

  for (let i = 0; i < count; i += 1) {
    cx[i] -= minX;
    cy[i] -= minY;
  }

  return { count, x: cx, y: cy, w: maxX - minX + 1, h: maxY - minY + 1 };
}

class Stacker {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    const n = this.w * this.h;
    this.board = new Uint8Array(n);
    this.clearMask = new Uint8Array(n);
    this.scratch = new Uint8Array(n);
    this.scratchMask = new Uint8Array(n);

    // The run that clears is a third of the well, never fewer than four cells
    // and never more than twelve. A fixed number would make the game trivial at
    // 128 cells across and impossible at 12.
    this.runNeeded = clamp(Math.floor(this.wellW() / 3), 4, 12);

    // Difficulty is the starting fall interval, in ticks. Level takes it down
    // from there.
    this.baseInterval = Math.max(3, Math.round(15 - 9 * clamp01(cfg.difficulty)));
    this.fallInterval = this.baseInterval;
    this.fallRows = 1;

    this.active = false;
    this.kind = 0;
    this.rot = 0;
    this.x = 0;
    this.y = 0;
    this.fallTimer = 0;
    this.clearTimer = 0;
    this.scoreValue = 0;
    this.runs = 0;
    this.level = 0;
    this.dead = false;
    this.aiPlanned = false;
    this.aiRot = 0;
    this.aiX = 0;

    this.spawnPiece(cfg, rng);
  }

  wellL() { return 1; }
  wellR() { return this.w - 2; }
  wellT() { return 1; }
  wellB() { return this.h - 2; }
  wellW() { return this.wellR() - this.wellL() + 1; }
  wellH() { return this.wellB() - this.wellT() + 1; }

  index(x, y) { return y * this.w + x; }

  /**
   * The tick is the input rate, not the fall rate — gravity is a countdown in
   * ticks. Fast enough that a rotation feels immediate, slow enough that the
   * autopilot's one-step-per-tick movement is legible.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 8 + 28 * t * t;
  }

  occupied(board, x, y) {
    if (x < this.wellL() || x > this.wellR() || y < this.wellT() || y > this.wellB()) {
      return true;
    }
    return board[this.index(x, y)] !== 0;
  }

  fits(board, s, x, y) {
    for (let i = 0; i < s.count; i += 1) {
      if (this.occupied(board, x + s.x[i], y + s.y[i])) return false;
    }
    return true;
  }

  restingY(board, s, x) {
    let y = this.wellT();
    if (!this.fits(board, s, x, y)) return -1;
    while (this.fits(board, s, x, y + 1)) y += 1;
    return y;
  }

  /**
   * Every maximal run of `runNeeded` or more, written into `mask`. Returns the
   * cells marked and how many separate runs they came from — the score wants the
   * cells and the level wants the runs.
   */
  findRuns(board, mask) {
    mask.fill(0);

    let runs = 0;
    let cells = 0;

    for (let y = this.wellT(); y <= this.wellB(); y += 1) {
      let run = 0;
      // One past the right edge, so a run that ends against the wall is closed
      // by the same code as one that ends against a gap. Special-casing the last
      // column is how a full row comes to be the one thing that does not clear.
      for (let x = this.wellL(); x <= this.wellR() + 1; x += 1) {
        const filled = x <= this.wellR() && board[this.index(x, y)] !== 0;
        if (filled) {
          run += 1;
          continue;
        }

        if (run >= this.runNeeded) {
          runs += 1;
          cells += run;
          for (let k = x - run; k < x; k += 1) mask[this.index(k, y)] = 1;
        }
        run = 0;
      }
    }

    return { cells, runs };
  }

  /**
   * Remove everything `mask` marks and let each affected column fall by the
   * number of its own cells that went. Holes elsewhere in the column survive,
   * which is the whole tension of the game.
   */
  collapse(board, mask) {
    for (let x = this.wellL(); x <= this.wellR(); x += 1) {
      let drop = 0;
      for (let y = this.wellB(); y >= this.wellT(); y -= 1) {
        const idx = this.index(x, y);
        if (mask[idx]) {
          board[idx] = 0;
          mask[idx] = 0;
          drop += 1;
        } else if (drop > 0 && board[idx] !== 0) {
          board[this.index(x, y + drop)] = board[idx];
          board[idx] = 0;
        }
      }
    }
  }

  spawnPiece(cfg, rng) {
    this.kind = stackerPickKind(rng);
    this.rot = 0;

    const s = stackerShape(this.kind, this.rot);

    this.x = this.wellL() + Math.floor((this.wellW() - s.w) / 2);
    this.y = this.wellT();

    this.fallTimer = 0;
    this.aiPlanned = false;

    // Topped out. The only way this game ends — there is no timer and no life
    // count, so a stack that reaches the spawn row is what restarts the layer.
    if (!this.fits(this.board, s, this.x, this.y)) {
      this.dead = true;
      this.active = false;
      return;
    }

    this.active = true;
  }

  tryRotate(delta) {
    const want = (((this.rot + delta) % 4) + 4) % 4;
    const s = stackerShape(this.kind, want);

    // Wall kicks, nearest first. Without them a piece against the right wall
    // simply refuses to turn, which reads as an unresponsive control rather than
    // as a rule.
    const kicks = [0, -1, 1, -2, 2];
    for (let i = 0; i < kicks.length; i += 1) {
      const k = kicks[i];
      if (this.fits(this.board, s, this.x + k, this.y)) {
        this.rot = want;
        this.x += k;
        return true;
      }
    }

    return false;
  }

  lock() {
    const s = stackerShape(this.kind, this.rot);

    // Tint runs 0..5 because the shader divides the tint byte by five. Keying it
    // off the piece kind rather than off a colour table is what keeps the look
    // entirely in the palette's hands.
    const tint = this.kind % 6;
    for (let i = 0; i < s.count; i += 1) {
      const px = this.x + s.x[i];
      const py = this.y + s.y[i];
      if (px >= this.wellL() && px <= this.wellR() && py >= this.wellT() && py <= this.wellB()) {
        this.board[this.index(px, py)] = tint + 1;
      }
    }

    this.active = false;
    this.aiPlanned = false;

    const found = this.findRuns(this.board, this.clearMask);
    if (found.cells > 0) {
      this.scoreValue += found.cells;
      this.runs += found.runs;

      // Driven by runs and not by cells — otherwise one lucky clear on a
      // 128-wide well would jump five levels at once.
      this.level = Math.floor(this.runs / 4);
      this.fallInterval = Math.max(1, this.baseInterval - this.level);

      // And past the point where the interval cannot shorten any further, the
      // piece starts falling more than a row at a time. This is what makes
      // termination structural: an autopilot that moves one column a tick
      // cannot steer a piece falling four.
      const over = this.level - (this.baseInterval - 1);
      this.fallRows = over > 0 ? Math.min(1 + Math.floor(over / 3), 6) : 1;

      // Held for a few ticks before the collapse. At eight cells a second a run
      // that vanishes on the tick it completes is a frame nobody sees.
      this.clearTimer = 3;
    }
  }

  evaluateBoard(board, cleared, landingY) {
    let aggregate = 0;
    let holes = 0;
    let bumpiness = 0;
    let prevH = -1;

    for (let x = this.wellL(); x <= this.wellR(); x += 1) {
      let h = 0;
      let covered = false;

      for (let y = this.wellT(); y <= this.wellB(); y += 1) {
        if (board[this.index(x, y)] !== 0) {
          if (!covered) {
            covered = true;
            h = this.wellB() - y + 1;
          }
        } else if (covered) {
          holes += 1;
        }
      }

      aggregate += h;
      if (prevH >= 0) bumpiness += Math.abs(h - prevH);
      prevH = h;
    }

    // How close the board is to a run, summed over rows. Without this term the
    // evaluator is only asked to keep the stack low and flat, and on a wide well
    // "low and flat" means spreading every piece as far from the last one as
    // possible — the exact opposite of building a run.
    let contiguity = 0;
    for (let y = this.wellT(); y <= this.wellB(); y += 1) {
      let run = 0;
      let best = 0;
      for (let x = this.wellL(); x <= this.wellR(); x += 1) {
        run = board[this.index(x, y)] !== 0 ? run + 1 : 0;
        if (run > best) best = run;
      }
      contiguity += best;
    }

    // Dellacherie's weights in spirit, integers in fact. A hole is worth far
    // more than the height it saves, because a hole is permanent until whatever
    // is on top of it clears and the height is not.
    return cleared * 24 - aggregate * 3 - holes * 16 - bumpiness * 2 + landingY * 2 + contiguity;
  }

  choosePlacement(cfg, rng) {
    let best = null;
    let any = null;
    let alternatives = 0;

    for (let rot = 0; rot < 4; rot += 1) {
      const s = stackerShape(this.kind, rot);
      if (s.w > this.wellW() || s.h > this.wellH()) continue;

      for (let x = this.wellL(); x + s.w - 1 <= this.wellR(); x += 1) {
        const y = this.restingY(this.board, s, x);
        if (y < 0) continue;

        this.scratch.set(this.board);
        for (let i = 0; i < s.count; i += 1) {
          this.scratch[this.index(x + s.x[i], y + s.y[i])] = 1;
        }

        const found = this.findRuns(this.scratch, this.scratchMask);
        if (found.cells > 0) this.collapse(this.scratch, this.scratchMask);

        const p = { rot, x, score: this.evaluateBoard(this.scratch, found.cells, y) };

        if (!best || p.score > best.score) best = p;

        // Reservoir sample of one over every legal placement, so the deliberate
        // mistake below is uniform rather than "always the leftmost thing that
        // fitted".
        alternatives += 1;
        if (rng.below(alternatives) === 0) any = p;
      }
    }

    // Deliberate incompetence, same contract as every other autopilot here.
    // Termination itself is guaranteed by the fall rate, not by this.
    const skill = clamp01(cfg.skill);
    if (any && rng.chance((1 - skill) * 0.55)) return any;

    return best;
  }

  step(cfg, input, rng) {
    if (this.dead) return;

    let move = 0;
    let rotate = 0;
    let softDrop = false;
    let hardDrop = false;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Left) move -= 1;
      else if (b === Button.Right) move += 1;
      else if (b === Button.Up) rotate += 1;
      else if (b === Button.Down) softDrop = true;
      else if (b === Button.Fire) hardDrop = true;
    }

    // The clear flash owns the whole tick. Input is drained above rather than
    // left in the queue, or a player mashing through the flash gets three
    // rotations at once on the tick the next piece appears.
    if (this.clearTimer > 0) {
      this.clearTimer -= 1;
      if (this.clearTimer === 0) this.collapse(this.board, this.clearMask);
      return;
    }

    if (!this.active) {
      this.spawnPiece(cfg, rng);
      if (this.dead) return;
    }

    if (cfg.autopilot) {
      move = 0;
      rotate = 0;
      hardDrop = false;

      if (!this.aiPlanned) {
        const p = this.choosePlacement(cfg, rng);
        this.aiRot = p ? p.rot : this.rot;
        this.aiX = p ? p.x : this.x;
        this.aiPlanned = true;
      }

      // One step a tick, deliberately. Snapping the piece to its column would be
      // a line of code and would look like a rendering fault.
      if (this.rot !== this.aiRot) rotate = 1;
      else if (this.x < this.aiX) move = 1;
      else if (this.x > this.aiX) move = -1;
      else softDrop = true;
    }

    if (rotate !== 0) this.tryRotate(rotate > 0 ? 1 : -1);

    if (move !== 0) {
      const stepX = move > 0 ? 1 : -1;
      const s = stackerShape(this.kind, this.rot);
      if (this.fits(this.board, s, this.x + stepX, this.y)) this.x += stepX;
    }

    if (hardDrop) {
      const s = stackerShape(this.kind, this.rot);
      let y = this.y;
      while (this.fits(this.board, s, this.x, y + 1)) y += 1;
      this.y = y;
      this.lock();
      return;
    }

    this.fallTimer += 1;
    if (this.fallTimer < (softDrop ? 1 : this.fallInterval)) return;

    this.fallTimer = 0;
    const s = stackerShape(this.kind, this.rot);

    // Locking is decided on the first row that will not take the piece, not
    // after the whole drop — otherwise a multi-row fall passes straight through
    // a one-cell ledge.
    for (let row = 0; row < this.fallRows; row += 1) {
      if (!this.fits(this.board, s, this.x, this.y + 1)) {
        this.lock();
        return;
      }
      this.y += 1;
    }
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    for (let y = this.wellT(); y <= this.wellB(); y += 1) {
      for (let x = this.wellL(); x <= this.wellR(); x += 1) {
        const idx = this.index(x, y);
        if (this.board[idx] === 0) continue;

        // A cell mid-flash draws as Food rather than Brick: it is about to be
        // worth something, and the palette's target colour already means that.
        if (this.clearMask[idx]) grid.set(x, y, Cell.Food, 255);
        else grid.set(x, y, Cell.Brick, 255, this.board[idx] - 1);
      }
    }

    if (this.active) {
      const s = stackerShape(this.kind, this.rot);
      for (let i = 0; i < s.count; i += 1) {
        grid.set(this.x + s.x[i], this.y + s.y[i], Cell.Head, 255, this.kind % 6);
      }
    }
  }

  stackHeight() {
    for (let y = this.wellT(); y <= this.wellB(); y += 1) {
      for (let x = this.wellL(); x <= this.wellR(); x += 1) {
        if (this.board[this.index(x, y)] !== 0) return this.wellB() - y + 1;
      }
    }
    return 0;
  }

  score() { return this.scoreValue; }

  finished() { return this.dead; }

  intensity() {
    const h = this.wellH();
    if (h <= 0) return 0;
    // Climbs through a run and drops on a clear, which is the shape a reactive
    // glow wants.
    return clamp01(this.stackHeight() / h);
  }
}

//===========================================================================
// Port of source/games/Chase.{h,cpp}
//
// The maze is carved at reset on the odd lattice, because a maze typed in as a
// string literal supports exactly one grid size and this plugin's whole reason
// to exist is that the playfield matches whatever the wall is. A perfect maze
// is then the wrong maze — every wrong turn is a dead end — so walls with open
// cells on both sides are knocked through afterwards. Loops are what make a
// chase a chase.
//===========================================================================

const CHASE_PURSUERS = 4;

/// Fraction of interior walls knocked through after the carve.
const CHASE_LOOP_RATE = 0.16;

/// How long a scatter lasts, and how often one comes round. Four pursuers that
/// hunt continuously from the first tick converge within a few seconds and every
/// life ends the same way.
const CHASE_SCATTER_TICKS = 70;
const CHASE_CHASE_PERIOD = 340;

function chaseDelta(d) {
  if (d === Dir.Up) return { x: 0, y: -1 };
  if (d === Dir.Right) return { x: 1, y: 0 };
  if (d === Dir.Down) return { x: 0, y: 1 };
  return { x: -1, y: 0 };
}

function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

class Chase {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    const n = this.w * this.h;
    this.dist = new Int32Array(n);
    this.first = new Int8Array(n);
    this.danger = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.queueLen = 0;

    this.scoreValue = 0;
    this.lives = 3;
    this.level = 0;
    this.ticks = 0;

    // Difficulty is how fast the pursuers move, in sixths of the player's rate.
    this.ghostSpeed = clamp(Math.round(2 + 3 * clamp01(cfg.difficulty)), 2, 6);

    this.buildMaze(rng);
    this.placeActors();
  }

  index(x, y) { return y * this.w + x; }

  open(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.maze[y * this.w + x] === 0;
  }

  openCells() {
    let n = 0;
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) if (this.open(x, y)) n += 1;
    }
    return n;
  }

  buildMaze(rng) {
    const n = this.w * this.h;
    this.maze = new Uint8Array(n).fill(1);
    this.pellet = new Uint8Array(n);
    this.pelletsLeft = 0;

    let maxX = this.w - 2;
    let maxY = this.h - 2;
    if ((maxX & 1) === 0) maxX -= 1;
    if ((maxY & 1) === 0) maxY -= 1;

    if (maxX < 1 || maxY < 1) {
      // Too small for a lattice. Open the interior rather than carve nothing and
      // hand the rest of the game an entirely solid board.
      for (let y = 1; y <= this.h - 2; y += 1) {
        for (let x = 1; x <= this.w - 2; x += 1) this.maze[this.index(x, y)] = 0;
      }
    } else {
      const stack = [];
      this.maze[this.index(1, 1)] = 0;
      stack.push(this.index(1, 1));

      while (stack.length) {
        const idx = stack[stack.length - 1];
        const cx = idx % this.w;
        const cy = Math.floor(idx / this.w);

        const candidate = [];
        for (let d = 0; d < 4; d += 1) {
          const s = chaseDelta(d);
          const nx = cx + s.x * 2;
          const ny = cy + s.y * 2;
          if (nx >= 1 && nx <= maxX && ny >= 1 && ny <= maxY && this.maze[this.index(nx, ny)] === 1) {
            candidate.push(d);
          }
        }

        if (candidate.length === 0) {
          stack.pop();
          continue;
        }

        const d = candidate[rng.below(candidate.length)];
        const s = chaseDelta(d);
        this.maze[this.index(cx + s.x, cy + s.y)] = 0;
        this.maze[this.index(cx + s.x * 2, cy + s.y * 2)] = 0;
        stack.push(this.index(cx + s.x * 2, cy + s.y * 2));
      }

      for (let y = 1; y <= maxY; y += 1) {
        for (let x = 1; x <= maxX; x += 1) {
          if (this.maze[this.index(x, y)] === 0) continue;

          const horiz = this.open(x - 1, y) && this.open(x + 1, y);
          const vert = this.open(x, y - 1) && this.open(x, y + 1);
          if ((horiz || vert) && rng.chance(CHASE_LOOP_RATE)) this.maze[this.index(x, y)] = 0;
        }
      }
    }

    for (let y = 1; y <= this.h - 2; y += 1) {
      for (let x = 1; x <= this.w - 2; x += 1) {
        if (this.open(x, y)) {
          this.pellet[this.index(x, y)] = 1;
          this.pelletsLeft += 1;
        }
      }
    }

    // Four power pellets, one toward each corner. Nearest-open rather than a
    // fixed coordinate because the carve decides which cells exist, and a power
    // pellet inside a wall is one nobody can reach.
    const corners = [
      { x: 1, y: 1 },
      { x: this.w - 2, y: 1 },
      { x: 1, y: this.h - 2 },
      { x: this.w - 2, y: this.h - 2 },
    ];

    for (let c = 0; c < corners.length; c += 1) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let y = 1; y <= this.h - 2; y += 1) {
        for (let x = 1; x <= this.w - 2; x += 1) {
          if (this.pellet[this.index(x, y)] !== 1) continue;
          const d = manhattan(x, y, corners[c].x, corners[c].y);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = this.index(x, y);
          }
        }
      }
      if (bestIdx >= 0) this.pellet[bestIdx] = 2;
    }
  }

  placeActors() {
    // The player starts as far from the middle as the maze allows and the
    // pursuers start in it. Anything else and the first three seconds of every
    // run are a pursuer standing on the player.
    const nearestOpen = (wantX, wantY, taken) => {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let y = 1; y <= this.h - 2; y += 1) {
        for (let x = 1; x <= this.w - 2; x += 1) {
          if (!this.open(x, y)) continue;

          let skip = false;
          for (let i = 0; i < taken.length; i += 1) {
            if (taken[i].x === x && taken[i].y === y) skip = true;
          }
          if (skip) continue;

          const d = manhattan(x, y, wantX, wantY);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = this.index(x, y);
          }
        }
      }

      if (bestIdx < 0) return { x: 1, y: 1 };
      return { x: bestIdx % this.w, y: Math.floor(bestIdx / this.w) };
    };

    this.home = nearestOpen(Math.floor(this.w / 2), this.h - 2, []);
    this.pos = { x: this.home.x, y: this.home.y };
    this.dir = Dir.Left;
    this.turns = [];

    const taken = [];
    const centreX = Math.floor(this.w / 2);
    const centreY = Math.floor(this.h / 2);

    this.ghosts = [];
    for (let i = 0; i < CHASE_PURSUERS; i += 1) {
      const p = nearestOpen(centreX, centreY, taken);
      taken.push(p);
      this.ghosts.push({
        pos: { x: p.x, y: p.y },
        home: { x: p.x, y: p.y },
        dir: i % 4,
        accum: 0,
        revive: 0,
        kind: i,
      });
    }

    this.wander = { x: centreX, y: centreY };
    this.fright = 0;
    this.chain = 0;
    this.sinceP = 0;

    // Every life starts with the pursuers heading away. Without it the player
    // respawns into the same converging blob that just caught them.
    this.scatter = CHASE_SCATTER_TICKS;
  }

  /**
   * One cell a tick for the player, so this is the movement rate directly.
   * Squared for the same reason Snake's is: the slow half is the half worth
   * having resolution in.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 6 + 20 * t * t;
  }

  /**
   * Seeded with the player's neighbours rather than the player, each carrying
   * the direction it was entered from. That is what makes one pass enough: the
   * answer to "which way to the nearest pellet" is read straight off the
   * pellet's cell, with no path to walk back.
   */
  floodFromPlayer() {
    this.dist.fill(-1);
    this.first.fill(-1);
    this.queueLen = 0;

    for (let d = 0; d < 4; d += 1) {
      const s = chaseDelta(d);
      const nx = this.pos.x + s.x;
      const ny = this.pos.y + s.y;
      if (!this.open(nx, ny)) continue;

      const idx = this.index(nx, ny);
      if (this.dist[idx] >= 0) continue;

      this.dist[idx] = 1;
      this.first[idx] = d;
      this.queue[this.queueLen++] = idx;
    }

    for (let head = 0; head < this.queueLen; head += 1) {
      const c = this.queue[head];
      const cx = c % this.w;
      const cy = Math.floor(c / this.w);

      for (let d = 0; d < 4; d += 1) {
        const s = chaseDelta(d);
        const nx = cx + s.x;
        const ny = cy + s.y;
        if (!this.open(nx, ny)) continue;

        const idx = this.index(nx, ny);
        if (this.dist[idx] >= 0) continue;

        this.dist[idx] = this.dist[c] + 1;
        this.first[idx] = this.first[c];
        this.queue[this.queueLen++] = idx;
      }
    }
  }

  floodFromGhosts() {
    this.danger.fill(-1);
    this.queueLen = 0;

    for (let i = 0; i < this.ghosts.length; i += 1) {
      const g = this.ghosts[i];
      if (g.revive > 0 || !this.open(g.pos.x, g.pos.y)) continue;

      const idx = this.index(g.pos.x, g.pos.y);
      if (this.danger[idx] >= 0) continue;

      this.danger[idx] = 0;
      this.queue[this.queueLen++] = idx;
    }

    for (let head = 0; head < this.queueLen; head += 1) {
      const c = this.queue[head];
      const cx = c % this.w;
      const cy = Math.floor(c / this.w);

      for (let d = 0; d < 4; d += 1) {
        const s = chaseDelta(d);
        const nx = cx + s.x;
        const ny = cy + s.y;
        if (!this.open(nx, ny)) continue;

        const idx = this.index(nx, ny);
        if (this.danger[idx] >= 0) continue;

        this.danger[idx] = this.danger[c] + 1;
        this.queue[this.queueLen++] = idx;
      }
    }
  }

  ghostTarget(g) {
    // Scattering, every pursuer heads for its own corner. Four different
    // corners, so they come apart rather than queueing into one.
    if (this.scatter > 0) {
      switch (g.kind % 4) {
        case 0: return { x: 1, y: 1 };
        case 1: return { x: this.w - 2, y: 1 };
        case 2: return { x: 1, y: this.h - 2 };
        default: return { x: this.w - 2, y: this.h - 2 };
      }
    }

    switch (g.kind) {
      case 0:
        return { x: this.pos.x, y: this.pos.y };

      case 1: {
        // Four cells along the player's heading. Clamped rather than wrapped — a
        // target outside the board is a fine direction to head in, but one that
        // has wrapped around points the ambusher backwards.
        const s = chaseDelta(this.dir);
        return {
          x: clamp(this.pos.x + s.x * 4, 0, this.w - 1),
          y: clamp(this.pos.y + s.y * 4, 0, this.h - 1),
        };
      }

      case 2:
        // Far away it patrols a corner, close up it commits. The effect is a
        // pursuer that keeps leaving and coming back, which stops all four
        // arriving as one blob.
        return manhattan(g.pos.x, g.pos.y, this.pos.x, this.pos.y) > 8
          ? { x: 1, y: this.h - 2 }
          : { x: this.pos.x, y: this.pos.y };

      default:
        return { x: this.wander.x, y: this.wander.y };
    }
  }

  stepGhost(g, target, flee) {
    let best = g.dir;
    let bestDist = 0;
    let found = false;
    const back = opposite(g.dir);

    // Reversing is banned. It is the rule that makes a corridor safe to commit
    // to, and without it a pursuer at a junction oscillates in place.
    for (let d = 0; d < 4; d += 1) {
      if (d === back) continue;

      const s = chaseDelta(d);
      const nx = g.pos.x + s.x;
      const ny = g.pos.y + s.y;
      if (!this.open(nx, ny)) continue;

      const dist = manhattan(nx, ny, target.x, target.y);

      if (!found || (flee ? dist > bestDist : dist < bestDist)) {
        bestDist = dist;
        best = d;
        found = true;
      }
    }

    // A dead end. Reversing is the only legal move and refusing it would park
    // the pursuer there for the rest of the level.
    return found ? best : back;
  }

  chooseAutopilot(cfg, rng) {
    const skill = clamp01(cfg.skill);

    let bestIdx = -1;
    let bestDist = Infinity;

    for (let y = 1; y <= this.h - 2; y += 1) {
      for (let x = 1; x <= this.w - 2; x += 1) {
        const idx = this.index(x, y);
        if (this.pellet[idx] === 0 || this.dist[idx] < 0) continue;

        // A power pellet is worth walking a little further for, and the discount
        // is what makes the autopilot occasionally turn the game around instead
        // of grinding the nearest dot forever.
        const weighted = this.dist[idx] - (this.pellet[idx] === 2 ? 6 : 0);
        if (weighted < bestDist) {
          bestDist = weighted;
          bestIdx = idx;
        }
      }
    }

    // While the power pellet is up, the pursuers are the prize.
    if (this.fright > 4) {
      for (let i = 0; i < this.ghosts.length; i += 1) {
        const g = this.ghosts[i];
        if (g.revive > 0) continue;

        const idx = this.index(g.pos.x, g.pos.y);
        if (this.dist[idx] < 0 || this.dist[idx] > this.fright) continue;

        if (this.dist[idx] - 4 < bestDist) {
          bestDist = this.dist[idx] - 4;
          bestIdx = idx;
        }
      }
    }

    let chosen = this.dir;
    let picked = false;
    if (bestIdx >= 0 && this.first[bestIdx] >= 0) {
      chosen = this.first[bestIdx];
      picked = true;
    }

    // The safety check, and the only thing Skill governs. Consulted, it refuses
    // a step that walks inside two cells of a live pursuer whenever anything
    // else is legal. Not consulted, the player beelines for the dot and gets
    // eaten — which is the behaviour the layer needs some of the time.
    let dangerous = false;
    if (this.fright === 0 && picked) {
      const s = chaseDelta(chosen);
      const nx = this.pos.x + s.x;
      const ny = this.pos.y + s.y;
      if (!this.open(nx, ny)) {
        dangerous = true;
      } else {
        const d = this.danger[this.index(nx, ny)];
        dangerous = d >= 0 && d <= 2;
      }
    }

    if ((!picked || dangerous) && rng.chance(picked ? skill : 1)) {
      let bestSafety = -Infinity;
      let found = false;
      for (let d = 0; d < 4; d += 1) {
        const s = chaseDelta(d);
        const nx = this.pos.x + s.x;
        const ny = this.pos.y + s.y;
        if (!this.open(nx, ny)) continue;

        const idx = this.index(nx, ny);
        const danger = this.danger[idx] < 0 ? 999 : this.danger[idx];

        // Distance from the nearest pursuer first, distance to the nearest
        // pellet as the tie-break, so a cornered player still walks toward
        // something rather than into the wall it happened to check first.
        const safety = danger * 64 - (this.dist[idx] < 0 ? 0 : this.dist[idx]);
        if (!found || safety > bestSafety) {
          bestSafety = safety;
          chosen = d;
          found = true;
        }
      }
    }

    return chosen;
  }

  movePlayer(d) {
    const s = chaseDelta(d);
    const nx = this.pos.x + s.x;
    const ny = this.pos.y + s.y;

    if (!this.open(nx, ny)) return;

    this.dir = d;
    this.pos = { x: nx, y: ny };
  }

  loseLife() {
    this.lives -= 1;
    if (this.lives > 0) this.placeActors();
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Up) this.turns.push(Dir.Up);
      else if (b === Button.Down) this.turns.push(Dir.Down);
      else if (b === Button.Left) this.turns.push(Dir.Left);
      else if (b === Button.Right) this.turns.push(Dir.Right);
    }

    if (this.turns.length > 4) this.turns.splice(0, this.turns.length - 4);

    this.ticks += 1;

    if (this.scatter > 0) this.scatter -= 1;
    else if (this.ticks % CHASE_CHASE_PERIOD === 0) this.scatter = CHASE_SCATTER_TICKS;

    if (this.fright > 0) {
      this.fright -= 1;
      if (this.fright === 0) this.chain = 0;
    }

    // The wanderer's target, moved on a slow beat. Re-rolled every tick it is a
    // random walk, which reverses on the spot and reads as a bug.
    if (this.ticks % 24 === 0) {
      const x = 1 + rng.below(Math.max(1, this.w - 2));
      const y = 1 + rng.below(Math.max(1, this.h - 2));
      this.wander = { x: Math.min(x, this.w - 2), y: Math.min(y, this.h - 2) };
    }

    this.floodFromPlayer();
    this.floodFromGhosts();

    let want = this.dir;
    if (cfg.autopilot) {
      this.turns.length = 0;
      want = this.chooseAutopilot(cfg, rng);
    } else if (this.turns.length) {
      const queued = this.turns[0];
      const s = chaseDelta(queued);
      if (this.open(this.pos.x + s.x, this.pos.y + s.y)) {
        want = queued;
        this.turns.shift();
      } else if (this.turns.length > 1) {
        // A turn still illegal by the time the next one arrives is a turn the
        // player has given up on. Holding it forever means the second press
        // never lands.
        this.turns.shift();
      }
    }

    const playerWas = { x: this.pos.x, y: this.pos.y };
    this.movePlayer(want);

    const here = this.index(this.pos.x, this.pos.y);
    if (this.pellet[here] !== 0) {
      if (this.pellet[here] === 2) {
        // Long enough to cross a good part of the board, and it scales with the
        // board so it means the same thing at 12 cells and at 128.
        this.fright = clamp((this.w + this.h) * 2, 30, 220);
        this.chain = 0;
        this.scoreValue += 5;
      } else {
        this.scoreValue += 1;
      }

      this.pellet[here] = 0;
      this.pelletsLeft -= 1;
      this.sinceP = 0;
    } else {
      this.sinceP += 1;
    }

    for (let i = 0; i < this.ghosts.length; i += 1) {
      const g = this.ghosts[i];

      if (g.revive > 0) {
        g.revive -= 1;
        continue;
      }

      const flee = this.fright > 0;
      g.accum += flee ? 3 : this.ghostSpeed;

      while (g.accum >= 6) {
        g.accum -= 6;

        const was = { x: g.pos.x, y: g.pos.y };
        const d = this.stepGhost(g, this.ghostTarget(g), flee);
        const s = chaseDelta(d);
        if (this.open(g.pos.x + s.x, g.pos.y + s.y)) {
          g.dir = d;
          g.pos = { x: g.pos.x + s.x, y: g.pos.y + s.y };
        }

        // Both the landed-on case and the walked-through case. Two actors
        // stepping past each other in a corridor swap cells and never share one,
        // so testing positions alone misses the head-on entirely — and a head-on
        // in a corridor is the commonest way this game ends.
        const touched =
          (g.pos.x === this.pos.x && g.pos.y === this.pos.y) ||
          (g.pos.x === playerWas.x && g.pos.y === playerWas.y &&
            this.pos.x === was.x && this.pos.y === was.y);
        if (!touched) continue;

        if (flee) {
          this.chain = Math.min(this.chain + 1, 4);
          this.scoreValue += 10 * this.chain;
          g.pos = { x: g.home.x, y: g.home.y };
          g.dir = Dir.Up;
          g.revive = 24;
        } else {
          this.loseLife();
          return;
        }
      }
    }

    if (this.pelletsLeft <= 0) {
      this.level += 1;
      this.ghostSpeed = Math.min(6, this.ghostSpeed + 1);
      this.buildMaze(rng);
      this.placeActors();
      return;
    }

    // A run that has stopped eating is one the autopilot has got stuck in.
    // Ending it beats a layer that stopped changing.
    if (this.sinceP > this.w * this.h * 2) this.loseLife();
  }

  draw(cfg, grid) {
    grid.clear();

    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        if (!this.open(x, y)) {
          grid.set(x, y, Cell.Wall);
          continue;
        }

        const p = this.pellet[this.index(x, y)];
        if (p === 1) grid.set(x, y, Cell.Food, 110);
        else if (p === 2) grid.set(x, y, Cell.Food, 255);
      }
    }

    for (let i = 0; i < this.ghosts.length; i += 1) {
      const g = this.ghosts[i];
      // Reviving pursuers are drawn dim rather than hidden. One that vanishes
      // and reappears elsewhere looks like a dropped frame; one that sits
      // faintly at its home reads as what it is.
      const shade = g.revive > 0 ? 60 : (this.fright > 0 ? 110 : 255);
      grid.set(g.pos.x, g.pos.y, Cell.Enemy, shade, g.kind);
    }

    grid.set(this.pos.x, this.pos.y, Cell.Head, 255);
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    // Two things at once: how close a pursuer is, and whether the board has been
    // turned around. Both are moments a reactive glow should follow.
    if (this.fright > 0) return 1;

    let nearest = Infinity;
    for (let i = 0; i < this.ghosts.length; i += 1) {
      const g = this.ghosts[i];
      if (g.revive === 0) {
        nearest = Math.min(nearest, manhattan(g.pos.x, g.pos.y, this.pos.x, this.pos.y));
      }
    }

    if (nearest === Infinity) return 0;

    const reach = Math.max(4, Math.floor((this.w + this.h) / 4));
    return clamp01(1 - nearest / reach);
  }
}

//===========================================================================
// Port of source/games/Girders.{h,cpp}
//
// Rows are numbered from the **bottom**: row 0 is the floor the climber starts
// on and the last row carries the prize, so `rowY` decreases as the index rises.
// That is the one thing to keep straight in here — every sign error in the C++
// came from forgetting it. Gap `g` is the ladder run between row `g` and `g+1`.
//
// The girders are flat and the *direction* alternates instead. At this
// resolution a sloped girder is a staircase, and every step of it is a place
// where "am I standing on the girder" needs a different answer.
//===========================================================================

const GIRDERS_MAX_ROWS = 10;

class Girders {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.scoreValue = 0;
    this.lives = 3;
    this.level = 0;
    this.ticks = 0;

    this.buildLevel(cfg, rng);
    this.placeClimber();
  }

  rowY(r) {
    if (this.rows <= 0) return this.h - 2;
    return this.rowYs[clamp(r, 0, this.rows - 1)];
  }

  standY(r) { return this.rowY(r) - 1; }

  ladderAt(gap, x) {
    if (gap < 0 || gap >= this.ladders.length) return false;
    const cols = this.ladders[gap];
    for (let i = 0; i < cols.length; i += 1) if (cols[i] === x) return true;
    return false;
  }

  ladderUpAt(row, x) { return row + 1 < this.rows && this.ladderAt(row, x); }
  ladderDownAt(row, x) { return row >= 1 && this.ladderAt(row - 1, x); }

  buildLevel(cfg, rng) {
    // Rows from the bottom up. The count is capped rather than derived alone: a
    // 96-cell-tall pixel map would otherwise get twenty-three floors, and a
    // climber that needs twenty-three ladders never reaches the prize.
    this.gap = clamp(Math.floor(this.h / 6), 3, 6);
    this.rows = clamp(Math.floor((this.h - 4) / this.gap), 2, GIRDERS_MAX_ROWS);

    this.rowYs = new Array(GIRDERS_MAX_ROWS).fill(0);
    this.rowDir = new Array(GIRDERS_MAX_ROWS).fill(1);
    for (let r = 0; r < this.rows; r += 1) {
      this.rowYs[r] = this.h - 2 - r * this.gap;
      this.rowDir[r] = r % 2 === 0 ? 1 : -1;
    }

    // Trim any row that ended up in the top wall. Happens on a short grid and
    // silently produced a prize sitting on the border before it was handled.
    while (this.rows > 2 && this.rowYs[this.rows - 1] < 2) this.rows -= 1;

    this.ladders = [];
    for (let i = 0; i < Math.max(0, this.rows - 1); i += 1) this.ladders.push([]);

    const lo = 1;
    const hi = this.w - 2;
    const span = Math.max(1, hi - lo);

    for (let gap = 0; gap < this.rows - 1; gap += 1) {
      // Two ladders per gap, forced apart. One makes the route a single column
      // and the game becomes a queue; two placed without a minimum separation
      // land next to each other about a third of the time and amount to the
      // same thing.
      const a = lo + rng.below(Math.max(1, Math.floor(span / 2)));
      const b = lo + Math.floor(span / 2) + rng.below(Math.max(1, Math.floor(span / 2)));

      this.ladders[gap].push(clamp(a, lo, hi));
      this.ladders[gap].push(clamp(b, lo, hi));
    }

    // The prize sits on the top row, away from the ladder that reaches it, so
    // arriving is not the same instant as winning.
    const topGap = this.rows - 2;
    let prizeX = Math.floor(this.w / 2);
    if (topGap >= 0 && this.ladders[topGap] && this.ladders[topGap].length) {
      const ladderX = this.ladders[topGap][0];
      prizeX = ladderX > Math.floor((lo + hi) / 2) ? lo + 1 : hi - 1;
    }

    this.prize = { x: clamp(prizeX, lo, hi), y: this.standY(this.rows - 1) };

    const diff = clamp01(cfg.difficulty);
    this.spawnInterval = Math.max(8, Math.round(52 - 34 * diff));
    this.barrelSpeed = clamp(Math.round(2 + 3 * diff), 1, 6);
    this.descendOdds = 0.25 + 0.25 * diff;

    this.barrels = [];
    this.spawnTimer = 0;
  }

  placeClimber() {
    this.x = 1;
    this.y = this.standY(0);
    this.row = 0;
    this.climbing = false;
    this.climbGap = 0;
    this.facing = 1;
    this.jump = 0;
    this.jumpCool = 0;
    this.stuck = 0;
    this.progressRow = 0;
  }

  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 6 + 22 * t * t;
  }

  loseLife() {
    this.lives -= 1;
    if (this.lives > 0) {
      this.placeClimber();
      this.barrels = [];
      this.spawnTimer = 0;
    }
  }

  moveBarrel(bar, rng) {
    // Descending means going *down*, which is a lower row index and a larger y.
    if (bar.descending) {
      bar.y += 1;
      if (bar.y >= this.standY(bar.row - 1)) {
        bar.row = Math.max(bar.row - 1, 0);
        bar.y = this.standY(bar.row);
        bar.dir = this.rowDir[bar.row];
        bar.descending = false;
      }
      return;
    }

    const nx = bar.x + bar.dir;
    if (nx < 1 || nx > this.w - 2) {
      // Out of floor. Down a level, or gone if this was the bottom one.
      if (bar.row - 1 >= 0) bar.descending = true;
      else bar.row = -1; // marked for removal
      return;
    }

    bar.x = nx;

    // The one roll of the dice in a barrel's life. Checked after the move so a
    // barrel cannot take the ladder it started the row on and fall through every
    // floor in one straight line.
    if (bar.row - 1 >= 0 && this.ladderAt(bar.row - 1, bar.x) && rng.chance(this.descendOdds)) {
      bar.descending = true;
    }
  }

  chooseAutopilot(cfg, rng) {
    const out = { move: 0, climb: 0, jump: false };

    const skill = clamp01(cfg.skill);

    // Deliberate incompetence, same as everywhere else in this plugin: without
    // it the climber tops out forever and the layer stops changing.
    if (rng.chance((1 - skill) * 0.45)) {
      out.move = rng.chance(0.5) ? -1 : 1;
      return out;
    }

    if (this.climbing) {
      // Committed. Coming back down a ladder to dodge something is a move a good
      // player makes and a two-line autopilot gets wrong far more often than it
      // gets right.
      out.climb = -1;
      return out;
    }

    // Anything rolling toward the climber on this floor, and how far away.
    let threat = Infinity;
    for (let i = 0; i < this.barrels.length; i += 1) {
      const bar = this.barrels[i];
      if (bar.row !== this.row || bar.descending) continue;

      const delta = bar.x - this.x;
      if (delta * bar.dir > 0) continue; // rolling away

      threat = Math.min(threat, Math.abs(delta));
    }

    if (threat <= 2 && this.jump === 0 && this.jumpCool === 0 && rng.chance(skill)) {
      out.jump = true;
      return out;
    }

    if (this.row + 1 >= this.rows) {
      // Top floor: walk at the prize.
      out.move = this.prize.x > this.x ? 1 : (this.prize.x < this.x ? -1 : 0);
      return out;
    }

    // Otherwise head for the nearest ladder up. Ties go to the lower column, so
    // the choice is stable from tick to tick — an autopilot that reconsiders
    // between two equidistant ladders walks on the spot.
    let target = this.x;
    let bestDist = Infinity;
    const cols = this.ladders[this.row];
    for (let i = 0; i < cols.length; i += 1) {
      const d = Math.abs(cols[i] - this.x);
      if (d < bestDist) {
        bestDist = d;
        target = cols[i];
      }
    }

    if (target === this.x) out.climb = -1;
    else out.move = target > this.x ? 1 : -1;

    return out;
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    let intent = { move: 0, climb: 0, jump: false };

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Left) intent.move = -1;
      else if (b === Button.Right) intent.move = 1;
      else if (b === Button.Up) intent.climb = -1;
      else if (b === Button.Down) intent.climb = 1;
      else if (b === Button.Fire) intent.jump = true;
    }

    this.ticks += 1;

    if (cfg.autopilot) intent = this.chooseAutopilot(cfg, rng);

    if (this.jump > 0) {
      this.jump -= 1;
      if (this.jump === 0) this.jumpCool = 4;
    } else if (this.jumpCool > 0) {
      this.jumpCool -= 1;
    } else if (intent.jump && !this.climbing) {
      this.jump = 3;
    }

    if (this.climbing) {
      if (intent.climb !== 0) {
        const upperY = this.standY(this.climbGap + 1);
        const lowerY = this.standY(this.climbGap);
        this.y = clamp(this.y + intent.climb, upperY, lowerY);

        if (this.y === upperY) {
          this.row = this.climbGap + 1;
          this.climbing = false;
        } else if (this.y === lowerY) {
          this.row = this.climbGap;
          this.climbing = false;
        }
      }
    } else {
      if (intent.move !== 0) {
        this.facing = intent.move;
        this.x = clamp(this.x + intent.move, 1, this.w - 2);
      }

      // Rows are numbered from the bottom, so going up is a *higher* row index
      // and a *smaller* y. Both cases name the gap explicitly.
      if (intent.climb < 0 && this.ladderUpAt(this.row, this.x)) {
        this.climbGap = this.row; // the run between row and row + 1
        this.climbing = true;
        this.y -= 1;
      } else if (intent.climb > 0 && this.ladderDownAt(this.row, this.x)) {
        this.climbGap = this.row - 1; // the run between row - 1 and row
        this.climbing = true;
        this.y += 1;
      }
    }

    this.spawnTimer += 1;
    if (this.spawnTimer >= this.spawnInterval && this.rows >= 2) {
      this.spawnTimer = 0;

      const dir = this.rowDir[this.rows - 1];
      this.barrels.push({
        x: dir > 0 ? 1 : this.w - 2,
        y: this.standY(this.rows - 1),
        row: this.rows - 1,
        dir,
        descending: false,
        accum: 0,
      });
    }

    for (let i = 0; i < this.barrels.length; i += 1) {
      const bar = this.barrels[i];
      bar.accum += this.barrelSpeed;
      while (bar.accum >= 6 && bar.row >= 0) {
        bar.accum -= 6;
        this.moveBarrel(bar, rng);
      }
    }

    this.barrels = this.barrels.filter((bar) => bar.row >= 0);

    // The hop's whole purpose: while it is up, the floor is not lethal. A barrel
    // mid-descent is at a different height and still is.
    const airborne = this.jump > 0 && !this.climbing;
    for (let i = 0; i < this.barrels.length; i += 1) {
      const bar = this.barrels[i];
      if (bar.x !== this.x) continue;

      if (bar.y === this.y && !airborne) {
        this.loseLife();
        return;
      }

      if (bar.y === this.y && airborne) {
        // Cleared one. Scored once, on the tick the hop starts, or a three-tick
        // hop over a stationary barrel would pay three times.
        if (this.jump === 3) this.scoreValue += 1;
      }
    }

    if (!this.climbing && this.row === this.rows - 1 &&
        this.x === this.prize.x && this.y === this.prize.y) {
      this.scoreValue += 25;
      this.level += 1;

      // Recomputed from the difficulty each time rather than decremented, or the
      // tightening compounds — three levels took the interval from 35 ticks to
      // its floor and the climber walked into a solid wall of barrels.
      this.buildLevel(cfg, rng);
      this.spawnInterval = Math.max(7, this.spawnInterval - 3 * this.level);
      this.barrelSpeed = Math.min(6, this.barrelSpeed + Math.floor(this.level / 3));
      this.placeClimber();
      return;
    }

    // Changing floor is what counts as progress. Anything finer, like moving at
    // all, never trips; anything coarser kills a climber having a slow level.
    if (this.row !== this.progressRow) {
      this.progressRow = this.row;
      this.stuck = 0;
    }

    this.stuck += 1;
    if (this.stuck > this.w * this.h) this.loseLife();
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    for (let r = 0; r < this.rows; r += 1) {
      for (let x = 1; x <= this.w - 2; x += 1) grid.set(x, this.rowY(r), Cell.Wall, 200);
    }

    // Ladders on top of the girders they pass through, so a rung is visible at
    // the floor it lands on. Drawn as Paddle: structure the player uses rather
    // than structure that stops them, and the palette separates those already.
    for (let gap = 0; gap < this.ladders.length; gap += 1) {
      const cols = this.ladders[gap];
      for (let i = 0; i < cols.length; i += 1) {
        for (let y = this.standY(gap + 1); y <= this.standY(gap); y += 1) {
          grid.set(cols[i], y, Cell.Paddle, 180);
        }
      }
    }

    grid.set(this.prize.x, this.prize.y, Cell.Food, 255);

    for (let i = 0; i < this.barrels.length; i += 1) {
      const bar = this.barrels[i];
      grid.set(bar.x, bar.y, Cell.Enemy, bar.descending ? 150 : 255);
    }

    const drawY = this.jump > 0 && !this.climbing ? this.y - 1 : this.y;
    grid.set(this.x, drawY, Cell.Head, 255);
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    // How far up the stack the climber has got, plus a spike for anything
    // rolling at them on this floor.
    let height = this.rows > 1 ? (this.rows - 1 - this.row) / (this.rows - 1) : 0;

    for (let i = 0; i < this.barrels.length; i += 1) {
      const bar = this.barrels[i];
      if (bar.row === this.row && Math.abs(bar.x - this.x) <= 3) height = Math.max(height, 0.85);
    }

    return clamp01(height);
  }
}

//===========================================================================
// Port of source/games/Trails.{h,cpp}
//
// Deaths are resolved simultaneously and that is not a detail. Move-then-check
// hands the first rider in the array every head-on collision in the game: it
// arrives first, the cell is solid by the time rider 1 is asked, and rider 0
// wins every head-on forever. So a tick computes every rider's next cell first,
// then kills everything that landed somewhere blocked *or* somewhere another
// rider also landed.
//===========================================================================

const TRAILS_MAX_RIDERS = 4;

class Trails {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    const n = this.w * this.h;
    this.board = new Uint8Array(n);
    this.written = new Int32Array(n);
    this.visited = new Uint8Array(n);
    this.stack = [];

    // Difficulty is how many riders are in the match. Two is a duel and reads
    // clearly; four fills the board four times as fast.
    this.riders = clamp(2 + Math.round(clamp01(cfg.difficulty) * 2), 2, TRAILS_MAX_RIDERS);

    this.rider = [];
    for (let i = 0; i < TRAILS_MAX_RIDERS; i += 1) {
      this.rider.push({ pos: { x: 0, y: 0 }, dir: Dir.Right, alive: true, wins: 0 });
    }

    this.round = 0;
    this.scoreValue = 0;
    this.ticks = 0;
    this.done = false;

    // Enough rounds that a match is a run rather than a moment, few enough that
    // the layer does actually restart. Rally's target score does the same job.
    this.target = 5;

    this.startRound();
  }

  index(x, y) { return y * this.w + x; }

  blocked(x, y) {
    if (x < 1 || y < 1 || x > this.w - 2 || y > this.h - 2) return true;
    return this.board[this.index(x, y)] !== 0;
  }

  aliveCount() {
    let n = 0;
    for (let i = 0; i < this.riders; i += 1) if (this.rider[i].alive) n += 1;
    return n;
  }

  trailCells() {
    let n = 0;
    for (let i = 0; i < this.board.length; i += 1) if (this.board[i] !== 0) n += 1;
    return n;
  }

  startRound() {
    this.board.fill(0);
    this.written.fill(0);

    // Spread around the middle, each facing the way it has the most room to go.
    // Starting them all facing the same way makes the first five seconds a
    // parade rather than a fight.
    const start = [
      { x: Math.max(1, Math.floor(this.w / 4)), y: Math.floor(this.h / 2) },
      { x: Math.min(this.w - 2, Math.floor((this.w * 3) / 4)), y: Math.floor(this.h / 2) },
      { x: Math.floor(this.w / 2), y: Math.max(1, Math.floor(this.h / 4)) },
      { x: Math.floor(this.w / 2), y: Math.min(this.h - 2, Math.floor((this.h * 3) / 4)) },
    ];
    const facing = [Dir.Right, Dir.Left, Dir.Down, Dir.Up];

    for (let i = 0; i < this.riders; i += 1) {
      this.rider[i].pos = { x: start[i].x, y: start[i].y };
      this.rider[i].dir = facing[i];
      this.rider[i].alive = true;

      const idx = this.index(start[i].x, start[i].y);
      this.board[idx] = i + 1;
      this.written[idx] = this.ticks;
    }

    this.hold = 0;
  }

  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 8 + 24 * t * t;
  }

  /**
   * Open space reachable from `from`, capped.
   *
   * Past the budget the answer is "plenty" and the decision does not change, so
   * counting further is work spent on nothing — and on an empty board at the
   * start of a round it is the whole grid, four times over, three directions
   * each, on the render thread.
   */
  freeSpace(from, budget) {
    if (this.blocked(from.x, from.y)) return 0;

    this.visited.fill(0);
    this.stack.length = 0;
    this.stack.push({ x: from.x, y: from.y });

    let count = 0;
    while (this.stack.length) {
      const p = this.stack.pop();

      if (this.blocked(p.x, p.y)) continue;

      const idx = this.index(p.x, p.y);
      if (this.visited[idx]) continue;

      this.visited[idx] = 1;
      count += 1;

      if (count >= budget) break;

      for (let d = 0; d < 4; d += 1) this.stack.push(ahead(p, d));
    }

    return count;
  }

  chooseDir(riderIndex, cfg, rng) {
    const r = this.rider[riderIndex];
    const forward = r.dir;
    const options = [forward, turnLeft(forward), turnRight(forward)];

    const skill = clamp01(cfg.skill);

    // Deliberate incompetence. Four riders that all play well spiral into their
    // own quarters and survive until the board fills, which is a long, static
    // picture — exactly what an autopilot must not produce.
    if (rng.chance((1 - skill) * 0.22)) {
      const pick = [];
      for (let i = 0; i < options.length; i += 1) {
        const next = ahead(r.pos, options[i]);
        if (!this.blocked(next.x, next.y)) pick.push(options[i]);
      }

      if (pick.length) return pick[rng.below(pick.length)];
      return forward;
    }

    // A budget in the region of a quarter of the board. Big enough that a
    // genuinely cramped pocket still scores low, small enough that the common
    // case stops early.
    const budget = Math.max(32, Math.floor((this.w * this.h) / 4));

    let best = forward;
    let bestSc = -1;
    let found = false;

    for (let i = 0; i < options.length; i += 1) {
      const d = options[i];
      const next = ahead(r.pos, d);
      if (this.blocked(next.x, next.y)) continue;

      let score = this.freeSpace(next, budget);

      // A small bias to carrying straight on, so a rider in open space does not
      // zigzag between three directions that all score the budget.
      if (d === forward) score += 3;

      // And a nudge away from the other riders' heads. Two riders converging on
      // the same corridor is the commonest double kill, and neither can see it
      // in a flood fill — the cell is still open.
      for (let j = 0; j < this.riders; j += 1) {
        if (j === riderIndex || !this.rider[j].alive) continue;

        const gap = Math.abs(next.x - this.rider[j].pos.x) + Math.abs(next.y - this.rider[j].pos.y);
        if (gap <= 2) score -= 40;
      }

      if (!found || score > bestSc) {
        bestSc = score;
        best = d;
        found = true;
      }
    }

    return best;
  }

  step(cfg, input, rng) {
    if (this.done) return;

    this.ticks += 1;

    // The gap between rounds. Long enough to see who won, and the reason the
    // board is not wiped on the same tick as the last collision.
    if (this.hold > 0) {
      this.hold -= 1;
      if (this.hold === 0) this.startRound();

      // Input is still drained, or a player turning during the pause finds four
      // queued turns waiting when the next round starts.
      for (;;) {
        if (input.pop() === null) break;
      }
      return;
    }

    let playerWant = this.rider[0].dir;
    let playerSet = false;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Up) { playerWant = Dir.Up; playerSet = true; }
      else if (b === Button.Down) { playerWant = Dir.Down; playerSet = true; }
      else if (b === Button.Left) { playerWant = Dir.Left; playerSet = true; }
      else if (b === Button.Right) { playerWant = Dir.Right; playerSet = true; }
      else if (b === Button.Fire) { playerWant = turnRight(playerWant); playerSet = true; }
    }

    // Decide every rider's direction before anything moves.
    for (let i = 0; i < this.riders; i += 1) {
      if (!this.rider[i].alive) continue;

      if (i === 0 && !cfg.autopilot) {
        // Reversing into your own trail is instant death and never what the
        // player meant, so it is refused rather than honoured.
        if (playerSet && playerWant !== opposite(this.rider[0].dir)) {
          this.rider[0].dir = playerWant;
        }
      } else {
        this.rider[i].dir = this.chooseDir(i, cfg, rng);
      }
    }

    const next = new Array(TRAILS_MAX_RIDERS);
    const dies = new Array(TRAILS_MAX_RIDERS).fill(false);

    for (let i = 0; i < this.riders; i += 1) {
      if (!this.rider[i].alive) continue;

      next[i] = ahead(this.rider[i].pos, this.rider[i].dir);
      dies[i] = this.blocked(next[i].x, next[i].y);
    }

    // The simultaneous part. Two riders arriving in the same cell both die — see
    // the note at the top of this section.
    for (let i = 0; i < this.riders; i += 1) {
      if (!this.rider[i].alive) continue;

      for (let j = i + 1; j < this.riders; j += 1) {
        if (!this.rider[j].alive) continue;

        if (next[i].x === next[j].x && next[i].y === next[j].y) {
          dies[i] = true;
          dies[j] = true;
        }
      }
    }

    for (let i = 0; i < this.riders; i += 1) {
      if (!this.rider[i].alive) continue;

      if (dies[i]) {
        this.rider[i].alive = false;
        continue;
      }

      this.rider[i].pos = next[i];

      const idx = this.index(next[i].x, next[i].y);
      this.board[idx] = i + 1;
      this.written[idx] = this.ticks;
    }

    if (this.aliveCount() > 1) return;

    this.round += 1;

    for (let i = 0; i < this.riders; i += 1) {
      if (this.rider[i].alive) {
        this.rider[i].wins += 1;
        this.scoreValue += i === 0 ? 3 : 1;

        if (this.rider[i].wins >= this.target) this.done = true;
      }
    }

    // A round everybody lost still counts. Without this a run of mutual head-on
    // kills would loop forever with nobody's total moving.
    if (!this.done && this.round >= this.target * 4) this.done = true;

    this.hold = 12;
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    for (let y = 1; y <= this.h - 2; y += 1) {
      for (let x = 1; x <= this.w - 2; x += 1) {
        const idx = this.index(x, y);
        const owner = this.board[idx];
        if (owner === 0) continue;

        // Age gradient: the newest stretch of a trail is brightest, so the
        // direction a rider came from is readable at a glance. Floored well
        // above zero — an old trail is still a wall and has to look like one.
        const age = Math.max(0, this.ticks - this.written[idx]);
        const shade = clamp(255 - age * 3, 110, 255);

        // Rider 0 is the player's, in the palette's primary; the rest are
        // hazards. On autopilot rider 0 is played by the machine too, and it
        // still gets the player's colour — the layer needs one thing to follow.
        grid.set(x, y, owner === 1 ? Cell.Body : Cell.Enemy, shade, (owner - 1) % 6);
      }
    }

    for (let i = 0; i < this.riders; i += 1) {
      if (!this.rider[i].alive) continue;

      grid.set(this.rider[i].pos.x, this.rider[i].pos.y,
        i === 0 ? Cell.Head : Cell.Ball, 255, i % 6);
    }
  }

  score() { return this.scoreValue; }

  finished() { return this.done; }

  intensity() {
    const cells = Math.max(1, (this.w - 2) * (this.h - 2));
    return clamp01((this.trailCells() / cells) * 2);
  }
}

//===========================================================================
// Port of source/games/Reflex.{h,cpp}
//
// The laserdisc mechanic without the laserdisc. There is no countdown: a hazard
// travels toward the hero at a known rate, the prompt opens at a fixed distance,
// and the window *is* the travel time. The bar under the arrow is the remaining
// distance drawn out, not a separate clock, so it cannot disagree with the thing
// it is measuring.
//
// The window closes as the run gets longer, until the prompt is open for a
// single tick and the two-tick floor on the autopilot's reaction cannot beat it.
// That is the only reason this game ever ends.
//===========================================================================

/// Five hazards, one per button. The mapping is fixed rather than random per
/// hazard: the game is "read the board, press the thing", and a hazard that
/// meant a different button each time would make the corridor pure decoration.
function reflexButtonFor(kind) {
  switch (kind % 5) {
    case 0: return Button.Up; // a gap in the floor: jump it
    case 1: return Button.Fire; // something in the way: strike it
    case 2: return Button.Down; // something overhead: duck under it
    case 3: return Button.Left; // it lunges from the right: go left
    default: return Button.Right;
  }
}

class Reflex {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.hazards = [];
    this.promptId = -1;
    this.promptButton = Button.Up;
    this.nextId = 1;

    const diff = clamp01(cfg.difficulty);

    // The lead distance is the window, in cells. Difficulty sets how much of it
    // there is to start with; the run itself takes it away.
    this.baseLead = clamp(Math.round(12 - 5 * diff), 4, Math.floor(this.w / 2));
    this.lead = this.baseLead;
    this.baseScroll = clamp(Math.round(2 + 3 * diff), 1, 6);
    this.scroll = this.baseScroll;
    this.scrollAccum = 0;

    // Far enough apart that one prompt is resolved before the next opens. Two
    // prompts at once has no sensible answer with one set of buttons.
    this.spawnGap = Math.max(this.baseLead + 4, Math.floor(this.w / 2));
    this.sinceSpawn = this.spawnGap;

    this.aiDelay = -1;
    this.pose = 0;
    this.poseTimer = 0;

    this.scoreValue = 0;
    this.streak = 0;
    this.ticks = 0;

    // Five and not three. This game punishes a mistake immediately and
    // completely, and at low Skill three lives were gone in a hundred ticks.
    this.lives = 5;
  }

  heroX() { return Math.max(2, Math.floor(this.w / 4)); }
  floorY() { return this.h - 3; }

  /// Top of the corridor. The prompt goes above it and the hazards below, and
  /// having a line at all is what stops the playfield being two thirds empty in
  /// every frame with no prompt open.
  ceilY() { return Math.max(3, this.floorY() - Math.max(4, Math.floor(this.h / 4))); }

  promptOpen() { return this.promptId >= 0; }

  prompted() {
    if (this.promptId < 0) return null;
    for (let i = 0; i < this.hazards.length; i += 1) {
      if (this.hazards[i].id === this.promptId) return this.hazards[i];
    }
    return null;
  }

  /**
   * A reaction game, so the tick rate is the resolution of the player's
   * reaction. Too low and the window cannot be expressed; too high and the
   * corridor scrolls faster than it reads.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 12 + 28 * t * t;
  }

  spawn(rng) {
    this.hazards.push({
      id: this.nextId++,
      x: this.w - 2,
      kind: rng.below(5),
      opened: false,
      answered: false,
    });
  }

  fail() {
    this.lives -= 1;
    this.streak = 0;
    this.pose = 4;
    this.poseTimer = 8;
    this.promptId = -1;
    this.aiDelay = -1;
  }

  answer(b) {
    let target = null;
    for (let i = 0; i < this.hazards.length; i += 1) {
      if (this.hazards[i].id === this.promptId) target = this.hazards[i];
    }

    if (!target) return;

    target.answered = true;
    this.promptId = -1;
    this.aiDelay = -1;

    if (b !== this.promptButton) {
      this.fail();
      return;
    }

    this.scoreValue += 1;
    this.streak += 1;

    // The ramp, and the thing that guarantees the run ends. Keyed off the total
    // rather than off the streak: resetting it on every miss would let a perfect
    // autopilot climb to the same speed three times and never get past it.
    this.lead = clamp(this.baseLead - Math.floor(this.scoreValue / 5), 2, this.baseLead);
    this.scroll = clamp(this.baseScroll + Math.floor(this.scoreValue / 8), 1, 9);

    if (b === Button.Up) this.pose = 1;
    else if (b === Button.Down) this.pose = 2;
    else if (b === Button.Fire) this.pose = 3;
    else this.pose = 0;

    this.poseTimer = 6;
  }

  advance(cfg, rng) {
    this.sinceSpawn += 1;
    if (this.sinceSpawn >= this.spawnGap) {
      this.sinceSpawn = 0;
      this.spawn(rng);
    }

    for (let i = 0; i < this.hazards.length; i += 1) this.hazards[i].x -= 1;

    // Resolve before opening, so a hazard that arrives on the same step it would
    // have opened on is a miss rather than a prompt nobody saw.
    for (let i = 0; i < this.hazards.length; i += 1) {
      const h = this.hazards[i];
      if (h.answered || h.x > this.heroX()) continue;

      h.answered = true;
      if (h.id === this.promptId) this.fail();
    }

    for (let i = 0; i < this.hazards.length; i += 1) {
      const h = this.hazards[i];
      if (h.opened || h.answered || this.promptId >= 0) continue;
      if (h.x > this.heroX() + this.lead) continue;

      h.opened = true;
      this.promptId = h.id;
      this.promptButton = reflexButtonFor(h.kind);

      if (cfg.autopilot) {
        // Two ticks is the floor at any Skill. It is what stops a perfect
        // autopilot from being unbeatable once the window is down to one tick.
        const skill = clamp01(cfg.skill);
        this.aiDelay = 2 + rng.below(1 + Math.trunc((1 - skill) * 10));
      }
    }

    this.hazards = this.hazards.filter((h) => h.x >= 0);
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    this.ticks += 1;
    if (this.poseTimer > 0) {
      this.poseTimer -= 1;
      if (this.poseTimer === 0) this.pose = 0;
    }

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (cfg.autopilot || b === Button.Reset) continue;

      // A press with no prompt open is not punished. Mashing has to be free, or
      // the only viable way to play is to not touch the controller.
      if (this.promptId >= 0) this.answer(b);
    }

    if (cfg.autopilot && this.promptId >= 0 && this.aiDelay >= 0) {
      this.aiDelay -= 1;
      if (this.aiDelay <= 0) {
        const skill = clamp01(cfg.skill);

        // Deliberate incompetence: below full Skill it sometimes presses the
        // wrong one, which is the failure mode a person actually has.
        let press = this.promptButton;
        if (!rng.chance(0.5 + 0.5 * skill)) press = rng.below(Button.Reset);

        this.answer(press);
      }
    }

    this.scrollAccum += this.scroll;
    while (this.scrollAccum >= 6) {
      this.scrollAccum -= 6;
      this.advance(cfg, rng);

      if (this.lives <= 0) return;
    }
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    const floorY = this.floorY();
    const ceilY = this.ceilY();
    const heroX = this.heroX();

    // The corridor floor, with a gap wherever a pit is.
    for (let x = 1; x <= this.w - 2; x += 1) {
      let pit = false;
      for (let i = 0; i < this.hazards.length; i += 1) {
        if (this.hazards[i].x === x && this.hazards[i].kind % 5 === 0) pit = true;
      }
      if (!pit) grid.set(x, floorY, Cell.Wall, 200);
    }

    // A ceiling, and markers along it. Without them this game draws a floor, a
    // two-cell hero and one hazard, and leaves two thirds of the playfield empty
    // in every frame where no prompt happens to be open.
    if (ceilY > 1) {
      for (let x = 1; x <= this.w - 2; x += 1) {
        grid.set(x, ceilY, Cell.Wall,
          (x + Math.floor(this.ticks / 8)) % 4 === 0 ? 220 : 130);
      }
    }

    // Lives, as pips in the top corner. There is nowhere to write a number and
    // this is the one piece of state a viewer cannot infer from the board.
    for (let i = 0; i < this.lives && 1 + i * 2 <= this.w - 2; i += 1) {
      grid.set(1 + i * 2, 1, Cell.Food, 200);
    }

    for (let i = 0; i < this.hazards.length; i += 1) {
      const h = this.hazards[i];
      const shade = h.answered ? 110 : 255;
      switch (h.kind % 5) {
        case 0:
          grid.set(h.x, floorY + 1, Cell.Enemy, shade);
          break;
        case 1:
          grid.set(h.x, floorY - 1, Cell.Enemy, shade);
          break;
        case 2:
          // Hangs *from* the ceiling rather than floating under it, so it is
          // obvious what the hero has to duck below.
          for (let y = ceilY + 1; y <= floorY - 3; y += 1) grid.set(h.x, y, Cell.Enemy, shade);
          break;
        default:
          grid.set(h.x, floorY - 1, Cell.Enemy, shade);
          grid.set(h.x, floorY - 2, Cell.Enemy, shade);
          break;
      }
    }

    // The hero, two cells of it, posed by whatever the last answer was.
    const poseLift = this.pose === 1 ? 2 : 0;
    const crouch = this.pose === 2;
    const bright = this.pose === 4 ? 110 : 255;

    if (crouch) {
      grid.set(heroX, floorY - 1, Cell.Head, bright);
    } else {
      grid.set(heroX, floorY - 2 - poseLift, Cell.Head, bright);
      grid.set(heroX, floorY - 1 - poseLift, Cell.Body, bright);
    }

    if (this.pose === 3) grid.set(heroX + 1, floorY - 1, Cell.Ball, 255);

    //---------------------------------------------------------------------
    // The prompt: a big arrow and the distance left, drawn out.
    //---------------------------------------------------------------------
    const prompt = this.prompted();
    if (!prompt) return;

    const arm = clamp(Math.floor(Math.min(this.w, this.h) / 7), 1, 4);
    const cx = Math.floor(this.w / 2);
    const cy = clamp(Math.floor(ceilY / 2) + 1, arm + 2, Math.max(arm + 2, ceilY - arm - 2));

    const ink = Cell.Food;

    switch (this.promptButton) {
      case Button.Up:
        drawLine(grid, cx, cy + arm, cx, cy - arm, ink);
        drawLine(grid, cx, cy - arm, cx - arm, cy, ink);
        drawLine(grid, cx, cy - arm, cx + arm, cy, ink);
        break;

      case Button.Down:
        drawLine(grid, cx, cy - arm, cx, cy + arm, ink);
        drawLine(grid, cx, cy + arm, cx - arm, cy, ink);
        drawLine(grid, cx, cy + arm, cx + arm, cy, ink);
        break;

      case Button.Left:
        drawLine(grid, cx + arm, cy, cx - arm, cy, ink);
        drawLine(grid, cx - arm, cy, cx, cy - arm, ink);
        drawLine(grid, cx - arm, cy, cx, cy + arm, ink);
        break;

      case Button.Right:
        drawLine(grid, cx - arm, cy, cx + arm, cy, ink);
        drawLine(grid, cx + arm, cy, cx, cy - arm, ink);
        drawLine(grid, cx + arm, cy, cx, cy + arm, ink);
        break;

      default:
        // Fire has no direction, so it is the one glyph that is a shape rather
        // than an arrow.
        drawLine(grid, cx, cy - arm, cx + arm, cy, ink);
        drawLine(grid, cx + arm, cy, cx, cy + arm, ink);
        drawLine(grid, cx, cy + arm, cx - arm, cy, ink);
        drawLine(grid, cx - arm, cy, cx, cy - arm, ink);
        break;
    }

    // The bar is the remaining distance, not a second clock counting the same
    // thing. It cannot disagree with the hazard because it is measured off it.
    const left = clamp(prompt.x - heroX, 0, Math.max(1, this.lead));
    const half = Math.max(1, Math.floor(this.w / 4));
    const span = Math.floor((left * half) / Math.max(1, this.lead));

    for (let i = -span; i <= span; i += 1) grid.set(cx + i, cy + arm + 2, Cell.Paddle, 220);
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    const prompt = this.prompted();
    if (!prompt) return Math.min(0.35, this.scoreValue / 60);

    // Climbs as the hazard closes, which is the one moment in this game that
    // anything is at stake.
    const left = clamp(prompt.x - this.heroX(), 0, Math.max(1, this.lead));
    return clamp01(1 - left / Math.max(1, this.lead));
  }
}

//===========================================================================
// Port of source/games/Swarm.{h,cpp}
//
// Not Marchers with a different name. The formation does not descend; attackers
// peel off it one at a time, fly a curved run at the ship, and rejoin. A diver
// is therefore not on the grid — it is at a float position moving on a curve,
// which puts this game on Drift's side of the line.
//
// The dive is two terms and not a spline: a pull toward wherever the ship is
// *now*, and a sine wobble whose sign is picked per dive. A spline decides the
// path the instant the dive starts, so the ship steps aside and every dive after
// the first looks the same; a pull alone is a homing missile.
//===========================================================================

const SWARM_MAX_COLS = 10;
const SWARM_MAX_ROWS = 4;
const SWARM_MAX_FLYERS = SWARM_MAX_COLS * SWARM_MAX_ROWS;

const SwarmFly = { Formation: 0, Diving: 1, Returning: 2, Dead: 3 };

/// Row the ship sits on, one clear of the bottom wall.
function swarmShipRow(h) { return h - 2; }

class Swarm {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.scoreValue = 0;
    this.lives = 3;
    this.wave = 0;
    this.ticks = 0;
    this.hitFlash = 0;
    this.aiCooldown = 0;
    this.shipX = Math.floor(this.w / 2);

    this.flyer = [];
    for (let i = 0; i < SWARM_MAX_FLYERS; i += 1) {
      this.flyer.push({
        state: SwarmFly.Dead,
        x: 0, y: 0, phase: 0,
        col: 0, row: 0, swing: 1, bombCool: 0,
      });
    }

    this.bullet = { x: 0, y: 0, vy: 0, live: false };
    this.bombs = [];

    this.buildWave(cfg);
  }

  /**
   * Two cells apart, so a formation reads as a formation rather than as a solid
   * bar, and centred on whatever width the grid happens to be.
   */
  slotX(col) {
    const span = (this.cols - 1) * 2;
    const left = Math.floor((this.w - span) / 2);
    return clamp(left + col * 2 + this.drift, 1, this.w - 2);
  }

  slotY(row) { return 2 + row * 2; }

  alive() {
    let n = 0;
    for (let i = 0; i < this.flyer.length; i += 1) {
      if (this.flyer[i].state !== SwarmFly.Dead) n += 1;
    }
    return n;
  }

  diving() {
    let n = 0;
    for (let i = 0; i < this.flyer.length; i += 1) {
      if (this.flyer[i].state === SwarmFly.Diving) n += 1;
    }
    return n;
  }

  buildWave(cfg) {
    this.cols = clamp(Math.floor((this.w - 4) / 2), 3, SWARM_MAX_COLS);
    this.rows = clamp(Math.floor(this.h / 8), 2, SWARM_MAX_ROWS);

    // A formation taller than the space above the ship would start the wave
    // already on top of the player.
    while (this.rows > 1 && this.slotY(this.rows - 1) > swarmShipRow(this.h) - 3) {
      this.rows -= 1;
    }

    // `drift` is read by slotX below, and the C++ sets the slots before it
    // resets the drift — the value in play is the one from the previous wave.
    if (this.drift === undefined) this.drift = 0;

    for (let i = 0; i < SWARM_MAX_FLYERS; i += 1) {
      const f = this.flyer[i];
      f.col = i % SWARM_MAX_COLS;
      f.row = Math.floor(i / SWARM_MAX_COLS);
      f.state = f.col < this.cols && f.row < this.rows ? SwarmFly.Formation : SwarmFly.Dead;
      f.x = this.slotX(f.col);
      f.y = this.slotY(f.row);
      f.phase = 0;
      f.swing = 1;
      f.bombCool = 0;
    }

    const diff = clamp01(cfg.difficulty);

    this.diveEvery = Math.max(8, Math.round(52 - 34 * diff) - this.wave * 3);
    this.maxDivers = clamp(1 + Math.floor(this.wave / 2) + Math.trunc(diff * 2), 1, 5);
    this.diveSpeed = Math.min(0.85, 0.22 + 0.2 * diff + 0.02 * this.wave);

    this.driftAmp = clamp(Math.floor((this.w - (this.cols - 1) * 2) / 2) - 2, 1, 6);
    this.drift = 0;
    this.driftDir = 1;
    this.driftTimer = 0;
    this.diveTimer = 0;

    this.bombs = [];
    this.bullet.live = false;
  }

  /**
   * Faster than Marchers, because the divers move in fractions of a cell and a
   * low tick rate turns a curve into a staircase.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 20 + 40 * t * t;
  }

  launchDive(rng) {
    // Count first, then take the n-th, so the choice is uniform over the
    // survivors. Rejection sampling on a nearly-cleared wave spins.
    let candidates = 0;
    for (let i = 0; i < this.flyer.length; i += 1) {
      if (this.flyer[i].state === SwarmFly.Formation) candidates += 1;
    }

    if (candidates === 0) return;

    let pick = rng.below(candidates);
    for (let i = 0; i < this.flyer.length; i += 1) {
      const f = this.flyer[i];
      if (f.state !== SwarmFly.Formation) continue;

      if (pick-- > 0) continue;

      f.state = SwarmFly.Diving;
      f.x = this.slotX(f.col);
      f.y = this.slotY(f.row);
      f.phase = 0;
      f.swing = rng.chance(0.5) ? 1 : -1;
      return;
    }
  }

  updateFlyer(f, cfg, rng) {
    switch (f.state) {
      case SwarmFly.Formation:
        f.x = this.slotX(f.col);
        f.y = this.slotY(f.row);
        break;

      case SwarmFly.Diving: {
        f.phase += 1;
        f.y += this.diveSpeed;

        // The pull is re-read every tick so the dive tracks the ship; the wobble
        // is what stops it being a homing missile.
        const toward = clamp(this.shipX - f.x, -1, 1);
        f.x += toward * 0.3 + f.swing * Math.sin(f.phase * 0.22) * 0.35;
        f.x = clamp(f.x, 1, this.w - 2);

        if (f.bombCool > 0) {
          f.bombCool -= 1;
        } else if (rng.chance(0.05 + 0.05 * clamp01(cfg.difficulty))) {
          this.bombs.push({
            x: f.x,
            y: f.y + 1,
            vy: 0.3 + 0.2 * clamp01(cfg.difficulty),
            live: true,
          });
          f.bombCool = 20;
        }

        // Off the bottom. Round it comes, in at the top, at its own column.
        if (f.y > this.h) {
          f.state = SwarmFly.Returning;
          f.y = -2;
          f.x = this.slotX(f.col);
        }
        break;
      }

      case SwarmFly.Returning: {
        const sx = this.slotX(f.col);
        const sy = this.slotY(f.row);

        f.y += this.diveSpeed;
        f.x += clamp(sx - f.x, -0.5, 0.5);

        if (f.y >= sy) {
          f.state = SwarmFly.Formation;
          f.x = sx;
          f.y = sy;
        }
        break;
      }

      default:
        break;
    }
  }

  chooseAim(cfg, rng) {
    const skill = clamp01(cfg.skill);

    // Dodge first. A bomb about to land is worth more than any shot, and an
    // autopilot that shoots through its own death is the single thing that makes
    // a shooter look unplayed rather than played badly.
    for (let i = 0; i < this.bombs.length; i += 1) {
      const s = this.bombs[i];
      if (!s.live) continue;
      if (s.y < swarmShipRow(this.h) - 4) continue;
      if (Math.abs(s.x - this.shipX) > 1.5) continue;

      if (rng.chance(skill)) return s.x > this.shipX ? -1 : 1;
    }

    // A diver that has got low is no longer a target, it is an impact. Aiming at
    // it lines the ship up underneath the thing about to land on it, which was
    // measured as three lives lost in under three hundred ticks at every Skill.
    {
      let incoming = null;
      for (let i = 0; i < this.flyer.length; i += 1) {
        const f = this.flyer[i];
        if (f.state !== SwarmFly.Diving) continue;
        if (f.y < swarmShipRow(this.h) - 6) continue;
        if (Math.abs(f.x - this.shipX) > 2.5) continue;
        if (!incoming || f.y > incoming.y) incoming = f;
      }

      if (incoming && rng.chance(skill)) return incoming.x > this.shipX ? -1 : 1;
    }

    // Then the nearest diver, because it is the one that will reach the ship.
    // Formation members are shot at only when nothing is diving.
    let target = null;
    let best = 0;
    for (let i = 0; i < this.flyer.length; i += 1) {
      const f = this.flyer[i];
      if (f.state === SwarmFly.Dead) continue;

      const diving = f.state === SwarmFly.Diving;
      const rank = (diving ? 1000 : 0) + f.y;
      if (!target || rank > best) {
        best = rank;
        target = f;
      }
    }

    if (!target) return 0;

    // Tracking error, the same lever every autopilot in this plugin has. At
    // skill 1.0 it lines up exactly; below that it aims at a cell it has not
    // checked, misses, and eventually gets hit — which is the requirement.
    const slop = (1 - skill) * 3;
    const want = target.x + rng.range(-slop, slop);

    if (want > this.shipX + 0.5) return 1;
    if (want < this.shipX - 0.5) return -1;

    return 0;
  }

  loseLife() {
    this.lives -= 1;
    this.hitFlash = 12;

    // The wave stays; only the ship and everything in flight resets. Wiping the
    // wave would make being hit a reward.
    this.bombs = [];
    this.bullet.live = false;
    this.shipX = Math.floor(this.w / 2);

    for (let i = 0; i < this.flyer.length; i += 1) {
      const f = this.flyer[i];
      if (f.state === SwarmFly.Diving || f.state === SwarmFly.Returning) {
        f.state = SwarmFly.Formation;
        f.x = this.slotX(f.col);
        f.y = this.slotY(f.row);
      }
    }
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    let move = 0;
    let fire = false;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Left) move = -1;
      else if (b === Button.Right) move = 1;
      else if (b === Button.Fire) fire = true;
    }

    this.ticks += 1;
    if (this.hitFlash > 0) this.hitFlash -= 1;

    if (cfg.autopilot) {
      move = this.chooseAim(cfg, rng);

      // Reaction lag. A shot every tick is not a difficulty setting, it is a
      // different game — the wave evaporates before a diver ever reaches the
      // ship and nobody watching sees the thing this game is about.
      if (this.aiCooldown > 0) {
        this.aiCooldown -= 1;
      } else {
        fire = true;
        this.aiCooldown = Math.round(1 + 10 * (1 - clamp01(cfg.skill)));
      }
    }

    this.shipX = clamp(this.shipX + move, 1, this.w - 2);

    if (fire && !this.bullet.live) {
      this.bullet.x = this.shipX;
      this.bullet.y = swarmShipRow(this.h) - 1;
      this.bullet.vy = -0.9;
      this.bullet.live = true;
    }

    // Formation drift. A triangle wave on a timer, so the slots stay on exact
    // cells — a formation whose members land between cells shimmers, and at this
    // resolution shimmer reads as damage.
    this.driftTimer += 1;
    if (this.driftTimer >= 6) {
      this.driftTimer = 0;
      this.drift += this.driftDir;
      if (this.drift >= this.driftAmp || this.drift <= -this.driftAmp) {
        this.driftDir = -this.driftDir;
      }
    }

    this.diveTimer += 1;
    if (this.diveTimer >= this.diveEvery && this.diving() < this.maxDivers) {
      this.diveTimer = 0;
      this.launchDive(rng);
    }

    for (let i = 0; i < this.flyer.length; i += 1) this.updateFlyer(this.flyer[i], cfg, rng);

    if (this.bullet.live) {
      this.bullet.y += this.bullet.vy;
      if (this.bullet.y < 1) this.bullet.live = false;
    }

    if (this.bullet.live) {
      for (let i = 0; i < this.flyer.length; i += 1) {
        const f = this.flyer[i];
        if (f.state === SwarmFly.Dead) continue;

        // A cell either side, because the bullet moves nearly a cell a tick and
        // an exact-cell test lets it pass straight through a flyer on the tick
        // they cross.
        if (Math.abs(f.x - this.bullet.x) > 0.75 || Math.abs(f.y - this.bullet.y) > 0.9) continue;

        // A diving attacker is worth more than one sitting in the formation.
        this.scoreValue += f.state === SwarmFly.Diving ? 3 : 1;
        f.state = SwarmFly.Dead;
        this.bullet.live = false;
        break;
      }
    }

    for (let i = 0; i < this.bombs.length; i += 1) {
      const s = this.bombs[i];
      if (!s.live) continue;

      s.y += s.vy;
      if (s.y > this.h - 1) {
        s.live = false;
        continue;
      }

      if (Math.round(s.y) === swarmShipRow(this.h) && Math.abs(s.x - this.shipX) < 0.9) {
        s.live = false;
        this.loseLife();
        return;
      }
    }

    this.bombs = this.bombs.filter((s) => s.live);

    for (let i = 0; i < this.flyer.length; i += 1) {
      const f = this.flyer[i];
      if (f.state !== SwarmFly.Diving) continue;

      if (Math.abs(f.x - this.shipX) < 0.9 &&
          Math.abs(f.y - swarmShipRow(this.h)) < 0.9) {
        this.loseLife();
        return;
      }
    }

    if (this.alive() === 0) {
      this.wave += 1;
      this.scoreValue += 20;
      this.buildWave(cfg);
    }
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    for (let i = 0; i < this.flyer.length; i += 1) {
      const f = this.flyer[i];
      if (f.state === SwarmFly.Dead) continue;

      // Divers at full brightness and formation members a shade down, which is
      // the only cue the player has for which of them is currently trying to
      // kill them.
      const shade = f.state === SwarmFly.Formation ? 190 : 255;
      grid.set(Math.floor(f.x + 0.5), Math.floor(f.y + 0.5), Cell.Enemy, shade, f.row % 6);
    }

    for (let i = 0; i < this.bombs.length; i += 1) {
      const s = this.bombs[i];
      if (s.live) grid.set(Math.floor(s.x + 0.5), Math.floor(s.y + 0.5), Cell.Enemy, 120);
    }

    if (this.bullet.live) {
      grid.set(Math.floor(this.bullet.x + 0.5), Math.floor(this.bullet.y + 0.5), Cell.Ball, 255);
    }

    // Four cells of ship. The wings go on the ship's own row and the nose above
    // it: hanging them a row below put them on the bottom border, and the ship
    // overdrew the wall it stands on.
    const shipY = swarmShipRow(this.h);
    const bright = this.hitFlash > 0 ? 120 : 255;
    grid.set(this.shipX, shipY - 1, Cell.Paddle, bright);
    grid.set(this.shipX, shipY, Cell.Paddle, bright);
    grid.set(this.shipX - 1, shipY, Cell.Paddle, Math.floor((bright * 3) / 4));
    grid.set(this.shipX + 1, shipY, Cell.Paddle, Math.floor((bright * 3) / 4));
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    // Divers in the air, not attackers alive. A full formation sitting still is
    // the calm part of the wave and should look like it.
    return clamp01(this.diving() / Math.max(1, this.maxDivers));
  }
}

//===========================================================================
// Port of source/games/Rafters.{h,cpp}
//
// Hit the *floor* an enemy is standing on, from below, and it flips onto its
// back: harmless and worth points until it rights itself, faster than before.
// That one rule makes the interesting position the one directly underneath the
// thing that can kill you, and puts a clock on every kill.
//
// The player and the crawlers are a single cell each, and vertical speed is
// clamped so no actor moves more than a cell in a tick. The clamp is not
// optional: every platform here is one cell thick, and an actor falling 1.4
// cells passes through one without ever testing it.
//===========================================================================

const RAFTERS_GRAVITY = 0.09;
const RAFTERS_JUMP = 0.8;
const RAFTERS_WALK = 0.34;
const RAFTERS_MAX_FALL = 0.9;
const RAFTERS_BUMP_TICKS = 5;
const RAFTERS_BUMP_REACH = 1;

/// How long a crawler stays on its back. Longer than it takes to cross a floor,
/// find the gap in the one above and climb through it — ninety was not enough
/// and the flip was a move with no follow-up.
const RAFTERS_FLIP_TICKS = 170;

/// Rows between platforms. Load-bearing rather than a look: a jump reaches
/// `JUMP^2 / (2 * GRAVITY)` cells, a shade over three and a half — enough to
/// strike the underside of the platform three rows up and enough to land on top
/// of it through a gap. At four the bump connects and the climb does not.
const RAFTERS_SPACING = 3;

function raftersRound(v) { return Math.floor(v + 0.5); }

class Rafters {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.buildLevel(cfg, rng);

    this.player = { x: Math.floor(this.w / 2), y: this.h - 3, vy: 0, dir: 1, onGround: true };
    this.aimRow = -1;

    this.scoreValue = 0;
    this.lives = 3;
    this.wave = 0;
    this.ticks = 0;
    this.hurt = 0;
    this.stuck = 0;
  }

  index(x, y) { return y * this.w + x; }

  solid(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return true;
    return this.solidCells[y * this.w + x] !== 0;
  }

  flipped() {
    let n = 0;
    for (let i = 0; i < this.crawlers.length; i += 1) if (this.crawlers[i].flip > 0) n += 1;
    return n;
  }

  buildLevel(cfg, rng) {
    const n = this.w * this.h;
    this.solidCells = new Uint8Array(n);

    for (let x = 0; x < this.w; x += 1) {
      this.solidCells[this.index(x, 0)] = 1;
      this.solidCells[this.index(x, this.h - 1)] = 1;
    }
    for (let y = 0; y < this.h; y += 1) {
      this.solidCells[this.index(0, y)] = 1;
      this.solidCells[this.index(this.w - 1, y)] = 1;
    }

    this.platformY = [];
    for (let y = this.h - 2; y >= 3; y -= RAFTERS_SPACING) this.platformY.push(y);

    // Stored top first, which is the order the autopilot reads them in.
    this.platformY.reverse();

    for (let i = 0; i < this.platformY.length; i += 1) {
      const y = this.platformY[i];
      for (let x = 1; x <= this.w - 2; x += 1) this.solidCells[this.index(x, y)] = 1;

      // The bottom platform is the floor and has no gaps — a hole in it would
      // drop the player into the bottom wall with nothing to stand on.
      if (y === this.h - 2) continue;

      // Gaps are the only route upward, so every platform above the floor gets
      // at least one, kept clear of the side walls so a gap is never a corner
      // the player cannot line up on.
      const lo = 3;
      const hi = Math.max(lo, this.w - 5);
      const gaps = this.w >= 20 ? 2 : 1;

      for (let g = 0; g < gaps; g += 1) {
        const gx = lo + rng.below(Math.max(1, hi - lo + 1));
        for (let k = 0; k < 2; k += 1) {
          if (gx + k <= this.w - 2) this.solidCells[this.index(gx + k, y)] = 0;
        }
      }
    }

    const diff = clamp01(cfg.difficulty);
    this.crawlSpeed = 0.12 + 0.1 * diff;
    this.spawnEvery = Math.max(20, Math.round(110 - 60 * diff));
    this.waveTotal = 3;
    this.released = 0;
    this.spawnTimer = 0;

    this.crawlers = [];
    this.bumpX = -1;
    this.bumpY = -1;
    this.bumpTimer = 0;
  }

  /**
   * Jump arcs live in fractions of a cell, so this needs to be fast enough that
   * an arc is a curve rather than three positions.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 20 + 40 * t * t;
  }

  spawnCrawler(rng) {
    if (!this.platformY.length) return;

    // Weighted toward the top, but not only the top. Crawlers turn at ledges
    // rather than falling, so whichever floor one is released onto is the floor
    // it spends its life on — release them all at the top and every floor below
    // is scenery. They still enter from a side edge, in view.
    const floors = this.platformY.length;
    let pick = rng.below(floors);
    if (rng.chance(0.45)) pick = 0;

    const topY = this.platformY[Math.min(pick, floors - 1)];
    const dir = rng.chance(0.5) ? 1 : -1;

    this.crawlers.push({
      body: { x: dir > 0 ? 1 : this.w - 2, y: topY - 1, vy: 0, dir, onGround: true },
      flip: 0,
      speed: 0,
    });
    this.released += 1;
  }

  moveActor(a, speed, turnAtEdges, isPlayer) {
    const cy = raftersRound(a.y);

    if (a.dir !== 0 && speed > 0) {
      const nx = a.x + a.dir * speed;
      const ncx = raftersRound(nx);

      if (ncx < 1 || ncx > this.w - 2 || this.solid(ncx, cy)) {
        if (turnAtEdges) a.dir = -a.dir;
      } else if (turnAtEdges && a.onGround && !this.solid(ncx, cy + 1)) {
        // A crawler turns at a ledge rather than walking off it. Letting it fall
        // is more realistic and much worse: the platform it lands on is the one
        // the player was working, and a hazard that arrives from above with no
        // warning is not one anybody can play against.
        a.dir = -a.dir;
      } else {
        a.x = nx;
      }
    }

    const cx = raftersRound(a.x);

    if (a.onGround) {
      if (!this.solid(cx, raftersRound(a.y) + 1)) {
        a.onGround = false;
        a.vy = RAFTERS_GRAVITY;
      }
      return;
    }

    // Clamped both ways. Exceed one cell a tick and an actor steps over a
    // one-cell platform without ever testing it.
    a.vy = clamp(a.vy + RAFTERS_GRAVITY, -RAFTERS_MAX_FALL, RAFTERS_MAX_FALL);

    const ny = a.y + a.vy;
    const ncy = raftersRound(ny);

    if (a.vy > 0) {
      if (this.solid(cx, ncy)) {
        a.y = ncy - 1;
        a.vy = 0;
        a.onGround = true;
      } else {
        a.y = ny;
      }
      return;
    }

    if (this.solid(cx, ncy)) {
      a.y = ncy + 1;
      a.vy = 0;

      if (isPlayer) {
        this.bumpX = cx;
        this.bumpY = ncy;
        this.bumpTimer = RAFTERS_BUMP_TICKS;
      }
    } else {
      a.y = ny;
    }
  }

  loseLife() {
    this.lives -= 1;
    this.hurt = 20;

    if (this.lives <= 0) return;

    this.player = { x: Math.floor(this.w / 2), y: this.h - 3, vy: 0, dir: 1, onGround: true };

    // The wave survives; only what is in the air is cleared. Wiping the crawlers
    // would make being caught the fastest way to clear a floor.
    this.bumpTimer = 0;
    this.stuck = 0;
  }

  /**
   * The autopilot, in priority order. Two things in here were measured wrong
   * before they were right.
   *
   * **Rule 3's radius.** At five cells it backed away from anything upright on
   * its floor, never climbed to get above one, and scored worse at Skill 1.0
   * than the random walker at 0.1.
   *
   * **The pogo.** A jump through a gap goes up through the hole and, with
   * nothing steering, comes straight back down through the same hole. So the
   * climb is a commitment: `aimRow` is set on the ground and the only job in the
   * air is to land on it. Before that, the player was off the ground 87% of the
   * time.
   */
  chooseAutopilot(cfg, rng) {
    const out = { move: 0, jump: false };

    const skill = clamp01(cfg.skill);
    const px = raftersRound(this.player.x);
    const py = raftersRound(this.player.y);

    if (this.player.onGround) this.aimRow = -1;

    // Airborne with a floor in mind. Nothing else may be decided until it is
    // stood on.
    if (!this.player.onGround && this.aimRow >= 0) {
      if (py <= this.aimRow - 1 && !this.solid(px, this.aimRow)) {
        let bestX = -1;
        let bestD = Infinity;
        for (let x = 1; x <= this.w - 2; x += 1) {
          if (!this.solid(x, this.aimRow)) continue;

          const d = Math.abs(x - px);
          if (d < bestD) {
            bestD = d;
            bestX = x;
          }
        }

        if (bestX >= 0 && bestD > 0) out.move = bestX > px ? 1 : -1;
      }

      return out;
    }

    // Deliberate incompetence, the same lever every autopilot in this plugin
    // has.
    if (rng.chance((1 - skill) * 0.35)) {
      out.move = rng.chance(0.5) ? -1 : 1;
      out.jump = rng.chance(0.2) && this.player.onGround;
      return out;
    }

    // 1. A crawler on its back on this floor is the whole point. Go and kick it,
    //    before it gets up faster than it was.
    {
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < this.crawlers.length; i += 1) {
        const c = this.crawlers[i];
        if (c.flip <= 0 || raftersRound(c.body.y) !== py) continue;

        const d = Math.abs(raftersRound(c.body.x) - px);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }

      if (best) {
        out.move = raftersRound(best.body.x) > px ? 1 : -1;
        return out;
      }
    }

    // 2. A crawler on the floor above is a bump waiting to happen. Line up
    //    underneath it and hit the ceiling.
    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];
      if (c.flip > 0) continue;

      const cy = raftersRound(c.body.y);
      if (cy >= py || py - cy > RAFTERS_SPACING + 1) continue;

      const dx = raftersRound(c.body.x) - px;
      if (Math.abs(dx) <= RAFTERS_BUMP_REACH) {
        out.jump = this.player.onGround;
        return out;
      }

      out.move = dx > 0 ? 1 : -1;
      return out;
    }

    // 3. An upright crawler sharing this floor is only a threat and there is no
    //    move against it from here. Back off — but only when it is genuinely
    //    close.
    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];
      if (c.flip > 0 || raftersRound(c.body.y) !== py) continue;

      const dx = raftersRound(c.body.x) - px;
      if (Math.abs(dx) > 2) continue;

      out.move = dx > 0 ? -1 : 1;
      if (px <= 2) out.move = 1;
      if (px >= this.w - 3) out.move = -1;

      return out;
    }

    // 4. Travel. A crawler just flipped is on the floor *above*, and heading for
    //    the bumping position below it means never collecting the kick that was
    //    just set up.
    let wantY = -1;
    {
      let target = null;
      let targetDist = Infinity;
      let chasingFlipped = false;

      for (let i = 0; i < this.crawlers.length; i += 1) {
        const c = this.crawlers[i];
        const isFlipped = c.flip > 0;
        if (chasingFlipped && !isFlipped) continue;

        const d = Math.abs(raftersRound(c.body.x) - px) +
                  Math.abs(raftersRound(c.body.y) - py) * 2;

        if (!target || (isFlipped && !chasingFlipped) || d < targetDist) {
          targetDist = d;
          target = c;
          chasingFlipped = isFlipped;
        }
      }

      if (target) {
        wantY = raftersRound(target.body.y) + (chasingFlipped ? 0 : RAFTERS_SPACING);
      }
    }

    // 5. Nothing released yet. Work upward anyway, so the next crawler does not
    //    arrive with the player parked on the bottom floor with five to climb.
    if (wantY < 0 && this.platformY.length) {
      wantY = this.platformY[0] - 1 + RAFTERS_SPACING;
    }

    if (wantY < 0 || wantY === py) return out;

    if (py > wantY) {
      // Up. Gaps are the only route between floors.
      const up = py + 1 - RAFTERS_SPACING;
      let gapX = -1;
      let gapDist = Infinity;

      if (up >= 1) {
        for (let x = 1; x <= this.w - 2; x += 1) {
          if (this.solid(x, up)) continue;

          const d = Math.abs(x - px);
          if (d < gapDist) {
            gapDist = d;
            gapX = x;
          }
        }
      }

      if (gapX < 0) return out;

      if (gapDist > 0) {
        out.move = gapX > px ? 1 : -1;
        return out;
      }

      // Standing on the gap. Commit to the floor above and jump.
      out.jump = this.player.onGround;
      this.aimRow = up;
      return out;
    }

    // Down is free: walk into a hole in this floor and fall through it.
    let holeX = -1;
    let holeDist = Infinity;
    for (let x = 1; x <= this.w - 2; x += 1) {
      if (this.solid(x, py + 1)) continue;

      const d = Math.abs(x - px);
      if (d < holeDist) {
        holeDist = d;
        holeX = x;
      }
    }

    if (holeX >= 0 && holeDist > 0) out.move = holeX > px ? 1 : -1;

    return out;
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    let intent = { move: 0, jump: false };

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Left) intent.move = -1;
      else if (b === Button.Right) intent.move = 1;
      else if (b === Button.Up || b === Button.Fire) intent.jump = true;
    }

    this.ticks += 1;
    if (this.hurt > 0) this.hurt -= 1;

    if (cfg.autopilot) intent = this.chooseAutopilot(cfg, rng);

    if (intent.move !== 0) this.player.dir = intent.move;

    if (intent.jump && this.player.onGround) {
      this.player.onGround = false;
      this.player.vy = -RAFTERS_JUMP;
    }

    this.moveActor(this.player, intent.move !== 0 ? RAFTERS_WALK : 0, false, true);

    // The bump stays live for a few ticks and reaches a cell either side. Both
    // are there to make the move land at all: the player is moving, the crawler
    // is moving, and the tick they share a column is not one anybody can aim for.
    if (this.bumpTimer > 0) {
      for (let i = 0; i < this.crawlers.length; i += 1) {
        const c = this.crawlers[i];
        if (c.flip > 0) continue;
        if (raftersRound(c.body.y) !== this.bumpY - 1) continue;
        if (Math.abs(raftersRound(c.body.x) - this.bumpX) > RAFTERS_BUMP_REACH) continue;

        c.flip = RAFTERS_FLIP_TICKS;
        this.scoreValue += 1;
      }

      this.bumpTimer -= 1;
    }

    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];

      if (c.flip > 0) {
        c.flip -= 1;

        // Back on its feet and quicker for it. The clock on a flipped crawler is
        // the whole tension of the mechanic.
        if (c.flip === 0) c.speed += 1;

        // Still subject to gravity while on its back, or one flipped over a gap
        // would hang in the air.
        this.moveActor(c.body, 0, true, false);
        continue;
      }

      this.moveActor(c.body, this.crawlSpeed + 0.03 * c.speed, true, false);
    }

    const px = raftersRound(this.player.x);
    const py = raftersRound(this.player.y);

    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];
      if (raftersRound(c.body.x) !== px || raftersRound(c.body.y) !== py) continue;

      if (c.flip > 0) {
        this.scoreValue += 5;
        this.crawlers.splice(i, 1);
        this.stuck = 0;
        break;
      }

      this.loseLife();
      return;
    }

    this.spawnTimer += 1;
    if (this.spawnTimer >= this.spawnEvery && this.released < this.waveTotal) {
      this.spawnTimer = 0;
      this.spawnCrawler(rng);
    }

    if (this.released >= this.waveTotal && this.crawlers.length === 0) {
      this.wave += 1;
      this.scoreValue += 15;
      this.waveTotal = 3 + this.wave;
      this.released = 0;
      this.spawnTimer = this.spawnEvery;
      this.crawlSpeed = Math.min(0.45, this.crawlSpeed + 0.03);
      this.spawnEvery = Math.max(14, this.spawnEvery - 8);
    }

    // A player that has stopped clearing crawlers is stuck on a floor it cannot
    // leave. Ending the life beats a layer that stopped moving.
    this.stuck += 1;
    if (this.stuck > this.w * this.h * 2) this.loseLife();
  }

  draw(cfg, grid) {
    grid.clear();

    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        if (this.solid(x, y)) {
          const edge = y === 0 || y === this.h - 1 || x === 0 || x === this.w - 1;
          grid.set(x, y, Cell.Wall, edge ? 255 : 200);
        }
      }
    }

    // The struck cell, lit for exactly as long as the bump is live. It is the
    // only feedback that the move connected.
    if (this.bumpTimer > 0) grid.set(this.bumpX, this.bumpY, Cell.Ball, 255);

    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];
      grid.set(raftersRound(c.body.x), raftersRound(c.body.y), Cell.Enemy,
        c.flip > 0 ? 110 : 255);
    }

    grid.set(raftersRound(this.player.x), raftersRound(this.player.y), Cell.Head,
      this.hurt > 0 ? 120 : 255);
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    if (!this.crawlers.length) return 0;

    // Flipped crawlers are the clock running; upright ones near the player are
    // the threat. Both are worth a reaction.
    const flipFrac = this.flipped() / this.crawlers.length;

    let threat = 0;
    for (let i = 0; i < this.crawlers.length; i += 1) {
      const c = this.crawlers[i];
      if (c.flip === 0 && raftersRound(c.body.y) === raftersRound(this.player.y) &&
          Math.abs(raftersRound(c.body.x) - raftersRound(this.player.x)) <= 4) {
        threat = 0.8;
      }
    }

    return clamp01(Math.max(flipFrac, threat));
  }
}

//===========================================================================
// Port of source/games/Duel.{h,cpp}
//
// A fighting game is a state machine with a clock on it. Everything that makes
// one what it is happens inside about a fifth of a second: a strike has a
// wind-up during which it can be beaten to the punch, an active window in which
// it connects, and a recovery during which its owner cannot act at all. Take
// those three away and you have two sprites touching each other.
//
// Rounds are the reason this game can end. Two fighters at the same skill can
// circle each other indefinitely, so a round that goes past its tick limit is
// awarded on health — without that, `finished` never returns true.
//===========================================================================

const DUEL_MAX_HEALTH = 96;
const DUEL_ROUNDS_TO_WIN = 2;
const DUEL_STRIKE_TICKS = 7;
const DUEL_BLOCK_TICKS = 10;
const DUEL_HURT_TICKS = 9;
const DUEL_ROUND_TICKS = 1600;

/// The middle of a strike, in ticks remaining. Only these connect: before it is
/// the wind-up the other fighter can react to, after it the recovery that makes
/// throwing one a decision.
const DUEL_ACTIVE_HI = 5;
const DUEL_ACTIVE_LO = 3;

const DUEL_HIT_DAMAGE = 9;
const DUEL_CHIP_DAMAGE = 2;
const DUEL_KNOCKBACK = 1.4;

/// Closest two fighters may stand. They are one cell wide and this keeps a cell
/// of air between them, so a strike always has somewhere to land.
const DUEL_MIN_GAP = 2;

const DUEL_JUMP_LIFT = [0, 1, 2, 2, 2, 2, 1, 0];

const DuelAction = { Idle: 0, Strike: 1, Block: 2, Hurt: 3 };

function duelCellOf(v) { return Math.floor(v + 0.5); }

class Duel {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.fighter = [];
    for (let i = 0; i < 2; i += 1) {
      this.fighter.push({
        x: 0, face: 1, health: DUEL_MAX_HEALTH, wins: 0,
        action: DuelAction.Idle, timer: 0, cool: 0, jump: 0,
      });
    }

    this.round = 0;
    this.scoreValue = 0;
    this.done = false;

    // Difficulty is the pace: how fast a fighter closes the gap, which decides
    // whether a round is a brawl or a stand-off.
    this.stepSize = 0.16 + 0.16 * clamp01(cfg.difficulty);

    this.startRound();
  }

  floorY() { return this.h - 2; }

  feetY(i) {
    const f = this.fighter[i];
    const lift = f.jump > 0 ? DUEL_JUMP_LIFT[clamp(8 - f.jump, 0, 7)] : 0;
    return this.floorY() - 1 - lift;
  }

  strikeCell(i) {
    return duelCellOf(this.fighter[i].x) + this.fighter[i].face * 2;
  }

  separation() { return Math.abs(this.fighter[0].x - this.fighter[1].x); }

  startRound() {
    const quarter = this.w / 4;

    this.fighter[0].x = Math.max(2, quarter);
    this.fighter[1].x = Math.min(this.w - 3, this.w - quarter);
    this.fighter[0].face = 1;
    this.fighter[1].face = -1;

    for (let i = 0; i < 2; i += 1) {
      const f = this.fighter[i];
      f.health = DUEL_MAX_HEALTH;
      f.action = DuelAction.Idle;
      f.timer = 0;
      f.cool = 0;
      f.jump = 0;
    }

    this.roundTicks = 0;
    this.hold = 0;
  }

  /**
   * The wind-up and recovery windows are measured in ticks, so this has to be
   * quick enough that seven ticks is a fifth of a second rather than a wait.
   */
  tickHz(cfg) {
    const t = clamp01(cfg.speed);
    return 24 + 36 * t * t;
  }

  applyIntent(i, move, strike, block, jump) {
    const f = this.fighter[i];
    const o = this.fighter[1 - i];

    // Fighters always face each other. A fighting game where you can turn your
    // back on the other one is a game about turning around.
    f.face = o.x >= f.x ? 1 : -1;

    if (f.jump > 0) f.jump -= 1;

    if (f.timer > 0) {
      f.timer -= 1;
      if (f.timer === 0) {
        // Read the action before clearing it. Recovery is longer after a strike
        // than after a block, and that difference is the whole reason a strike
        // is a commitment rather than a free action.
        const was = f.action;
        f.action = DuelAction.Idle;
        f.cool = was === DuelAction.Strike ? 4 : 2;
      }

      // Nothing else may start while an action is running. Being unable to
      // cancel a whiffed strike is the point of throwing one.
      return;
    }

    if (f.cool > 0) {
      f.cool -= 1;
      return;
    }

    if (strike) {
      f.action = DuelAction.Strike;
      f.timer = DUEL_STRIKE_TICKS;
      return;
    }

    if (block) {
      f.action = DuelAction.Block;
      f.timer = DUEL_BLOCK_TICKS;
      return;
    }

    if (jump && f.jump === 0) f.jump = 8;

    if (move !== 0) {
      const want = f.x + move * this.stepSize;
      const gap = Math.abs(want - o.x);

      if (gap >= DUEL_MIN_GAP || Math.abs(want - o.x) > Math.abs(f.x - o.x)) {
        f.x = clamp(want, 1, this.w - 2);
      }
    }
  }

  decideAi(i, cfg, rng) {
    const f = this.fighter[i];
    const o = this.fighter[1 - i];

    if (f.timer > 0 || f.cool > 0) {
      this.applyIntent(i, 0, false, false, false);
      return;
    }

    const skill = clamp01(cfg.skill);
    const gap = Math.abs(f.x - o.x);

    // React to a strike that is still winding up. This is the one read in the
    // game, and Skill is entirely whether it is made — an autopilot that always
    // sees it coming never takes a hit, which is why it must not.
    if (o.action === DuelAction.Strike && o.timer > DUEL_ACTIVE_LO && gap < 3.5) {
      if (rng.chance(skill * 0.85)) {
        this.applyIntent(i, 0, false, true, false);
        return;
      }
    }

    if (gap <= 2.6) {
      // In range. Strike, unless it decides to keep the pressure by backing out
      // — a fighter that only ever attacks at range is trivially counter-hit and
      // the round becomes a metronome.
      if (rng.chance(0.35 + 0.45 * skill)) {
        this.applyIntent(i, 0, true, false, false);
        return;
      }

      this.applyIntent(i, f.x < o.x ? -1 : 1, false, false, false);
      return;
    }

    // Out of range. Close, mostly. The occasional jump stops two autopilots
    // walking into each other in a perfectly straight line every round.
    const hop = rng.chance((1 - skill) * 0.05);
    this.applyIntent(i, f.x < o.x ? 1 : -1, false, false, hop);
  }

  resolve(attacker, defender) {
    const a = this.fighter[attacker];
    const d = this.fighter[defender];

    if (a.action !== DuelAction.Strike) return;
    if (a.timer > DUEL_ACTIVE_HI || a.timer < DUEL_ACTIVE_LO) return;

    // A strike lands on the cell in front of the attacker, and only if the
    // defender is at the same height. Jumping over one is a real answer.
    if (duelCellOf(d.x) !== this.strikeCell(attacker)) return;
    if (this.feetY(defender) !== this.feetY(attacker)) return;

    if (d.action === DuelAction.Block) {
      // Chip damage. Blocking has to cost something or holding it forever is the
      // whole strategy.
      d.health -= DUEL_CHIP_DAMAGE;
      a.timer = Math.min(a.timer, DUEL_ACTIVE_LO);
      return;
    }

    d.health -= DUEL_HIT_DAMAGE;
    d.action = DuelAction.Hurt;
    d.timer = DUEL_HURT_TICKS;
    d.x = clamp(d.x + a.face * DUEL_KNOCKBACK, 1, this.w - 2);

    // The strike is spent on the hit, so one strike cannot damage twice on
    // consecutive active ticks.
    a.timer = Math.min(a.timer, DUEL_ACTIVE_LO);

    if (attacker === 0) this.scoreValue += 1;
  }

  step(cfg, input, rng) {
    if (this.done) return;

    let move = 0;
    let strike = false;
    let block = false;
    let jump = false;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Left) move = -1;
      else if (b === Button.Right) move = 1;
      else if (b === Button.Up) jump = true;
      else if (b === Button.Down) block = true;
      else if (b === Button.Fire) strike = true;
    }

    // The pause between rounds, so the knockout is visible rather than being the
    // last frame before everything moves back to its corner.
    if (this.hold > 0) {
      this.hold -= 1;
      if (this.hold === 0) this.startRound();
      return;
    }

    this.roundTicks += 1;

    if (cfg.autopilot) this.decideAi(0, cfg, rng);
    else this.applyIntent(0, move, strike, block, jump);

    this.decideAi(1, cfg, rng);

    // Both directions, every tick. Resolving only the player's strikes would
    // give whichever fighter is checked first a free trade on every mutual hit.
    this.resolve(0, 1);
    this.resolve(1, 0);

    const down = this.fighter[0].health <= 0 || this.fighter[1].health <= 0;

    // A round that has gone the distance is awarded on health. Without it two
    // cautious autopilots circle forever and the layer shows one match for the
    // rest of the show.
    const expired = this.roundTicks >= DUEL_ROUND_TICKS;

    if (!down && !expired) return;

    let winner = -1;
    if (this.fighter[0].health > this.fighter[1].health) winner = 0;
    else if (this.fighter[1].health > this.fighter[0].health) winner = 1;

    this.round += 1;

    if (winner >= 0) {
      this.fighter[winner].wins += 1;
      if (winner === 0) this.scoreValue += 20;

      if (this.fighter[winner].wins >= DUEL_ROUNDS_TO_WIN) this.done = true;
    }

    // A drawn round still counts toward the match length, so a run of draws
    // cannot stall the match indefinitely.
    if (!this.done && this.round >= DUEL_ROUNDS_TO_WIN * 3) this.done = true;

    this.hold = 20;
  }

  draw(cfg, grid) {
    grid.clear();

    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall);
      grid.set(x, this.h - 1, Cell.Wall);
    }
    for (let y = 0; y < this.h; y += 1) {
      grid.set(0, y, Cell.Wall);
      grid.set(this.w - 1, y, Cell.Wall);
    }

    for (let x = 1; x <= this.w - 2; x += 1) grid.set(x, this.floorY(), Cell.Wall, 200);

    // Corner posts and a top rope. Two one-cell fighters on a floor leave three
    // quarters of the playfield empty, which on a layer whose whole job is what
    // it looks like is a real fault even though every state assertion passes.
    const ropeY = Math.max(3, this.floorY() - Math.max(4, Math.floor(this.h / 4)));
    for (let y = ropeY; y < this.floorY(); y += 1) {
      grid.set(1, y, Cell.Wall, 170);
      grid.set(this.w - 2, y, Cell.Wall, 170);
    }

    for (let x = 1; x <= this.w - 2; x += 1) grid.set(x, ropeY, Cell.Wall, 120);

    //---------------------------------------------------------------------
    // Health, as two bars growing in from the sides. It is the only number in
    // this game the viewer needs and there is no room to write it.
    //---------------------------------------------------------------------
    const barMax = Math.max(1, Math.floor((this.w - 4) / 2));
    for (let i = 0; i < 2; i += 1) {
      const len = clamp(Math.floor((this.fighter[i].health * barMax) / DUEL_MAX_HEALTH), 0, barMax);

      for (let k = 0; k < len; k += 1) {
        const x = i === 0 ? 1 + k : this.w - 2 - k;
        grid.set(x, 1, i === 0 ? Cell.Paddle : Cell.Brick, 255, i === 0 ? 0 : 3);
      }
    }

    // Round wins, as pips under the bars.
    for (let i = 0; i < 2; i += 1) {
      for (let k = 0; k < this.fighter[i].wins; k += 1) {
        const x = i === 0 ? 1 + k * 2 : this.w - 2 - k * 2;
        grid.set(x, 2, Cell.Food, 255);
      }
    }

    for (let i = 0; i < 2; i += 1) {
      const f = this.fighter[i];
      const fx = duelCellOf(f.x);
      const feet = this.feetY(i);

      // Blocking reads as a dimmer, hunched fighter: two cells instead of three.
      // It is the only silhouette change in the game and the one the other
      // player has to be able to see instantly.
      const blocking = f.action === DuelAction.Block;
      const shade = f.action === DuelAction.Hurt ? 110 : (blocking ? 160 : 255);

      const body = i === 0 ? Cell.Body : Cell.Enemy;
      const head = i === 0 ? Cell.Head : Cell.Enemy;
      const tint = i === 0 ? 0 : 2;

      grid.set(fx, feet, body, shade, tint);
      if (!blocking) grid.set(fx, feet - 1, body, shade, tint);

      grid.set(fx, feet - (blocking ? 1 : 2), head, shade, tint);

      // The active window of a strike, and nothing else. Drawing the wind-up
      // would tell the other fighter exactly when to block and remove the read
      // the whole game is built on.
      if (f.action === DuelAction.Strike && f.timer <= DUEL_ACTIVE_HI && f.timer >= DUEL_ACTIVE_LO) {
        grid.set(fx + f.face, feet - 1, Cell.Ball, 255);
        grid.set(this.strikeCell(i), feet - 1, Cell.Ball, 255);
      }
    }
  }

  score() { return this.scoreValue; }

  finished() { return this.done; }

  intensity() {
    // Rises as the fighters close and as the health drains, which between them
    // track everything worth reacting to here.
    const gap = clamp01(this.separation() / Math.max(4, Math.floor(this.w / 2)));
    const lowest = Math.min(this.fighter[0].health, this.fighter[1].health);
    const hurt = 1 - Math.max(0, lowest) / DUEL_MAX_HEALTH;

    return clamp01(Math.max(1 - gap, hurt));
  }
}

//===========================================================================
// Port of source/games/Flapper.{h,cpp}
//
// One button against gravity, through the gaps in a wall that scrolls past.
// The press *sets* the vertical velocity rather than adding to it, so every
// flap is the same arc from wherever it is pressed and the player is timing one
// thing rather than managing a throttle.
//
// Difficulty is a ramp and not a setting, because it has to be: threading gaps
// is an easy enough control problem that a good flier at a fixed difficulty
// never dies, and a layer that never changes is the thing the respawn delay
// exists to prevent. Every column passed narrows the gap, speeds the scroll,
// pulls the columns together and widens how far the next hole may sit from the
// last, until the hole is further away than the flier can travel between two
// columns.
//===========================================================================

// `fr` is Math.fround, and this is the one game on the page that needs it.
//
// The other thirteen ports do their arithmetic in JavaScript doubles against a
// C++ sim that uses `float`, and match anyway. They get away with it because
// they re-quantise constantly: a snake is on integer cells, and even Rafters
// snaps `y` to a whole row every time an actor lands. Any drift is erased
// before it can reach a cell index.
//
// Flapper never re-quantises. The flier's altitude and every column's x are
// continuous for the whole run, so a double and a float diverge monotonically
// until one of them crosses a `round()` boundary the other has not — and then
// the playfields differ by a cell and stay differing. It is not subtle either:
// `0.12f + 0.10f * 0.5f` is 0.169999998 as a float and 0.17 as a double, so the
// scroll speed is wrong on the very first tick.
//
// So every accumulating expression here is rounded to single precision exactly
// where the C++ rounds, which is after each individual operation. The constants
// are pre-rounded for the same reason.
const fr = Math.fround;

const FLAPPER_GRAVITY = fr(0.04);
const FLAPPER_FLAP = fr(0.3);
const FLAPPER_SINK = fr(0.45);
const FLAPPER_DAMP = fr(2);
const FLAPPER_RAMP_SCROLL = fr(0.012);
const FLAPPER_MIN_GAP = 2;
const FLAPPER_MIN_SPACING = 4;
const FLAPPER_MAX_SCROLL = fr(0.85);
const FLAPPER_MAX_FALL = fr(0.9);
const FLAPPER_COL_WIDTH = 2;

function flapperRound(v) { return Math.floor(v + 0.5); }

class Flapper {
  reset(cfg, rng) {
    this.w = cfg.gridW;
    this.h = cfg.gridH;

    this.flierX = Math.max(1, Math.floor(this.w / 4));
    this.y = Math.floor((this.h - 1) / 2);
    this.vy = 0;

    const diff = fr(clamp01(cfg.difficulty));

    const maxGap = this.maxGap();
    const wide = Math.round(fr(fr(this.h) * fr(fr(0.3) - fr(fr(0.1) * diff))));

    // clamp is undefined when lo > hi, and on a six-row playfield it is.
    const lo = Math.min(FLAPPER_MIN_GAP + 1, maxGap);
    this.gapH = clamp(wide, lo, maxGap);

    this.scroll = fr(fr(0.12) + fr(fr(0.1) * diff));
    this.spacing = Math.max(FLAPPER_MIN_SPACING, Math.floor(this.w / 3));
    this.drift = 2;

    this.lastGapY = clamp(Math.floor((this.h - this.gapH) / 2), 1,
      Math.max(1, this.h - 1 - this.gapH));

    this.fillField(rng);

    this.scoreValue = 0;
    this.passed = 0;
    this.lives = 3;
    this.ticks = 0;
    this.hurt = 0;
  }

  maxGap() { return Math.max(FLAPPER_MIN_GAP, this.h - 4); }

  solid(x, y) {
    if (y <= 0 || y >= this.h - 1) return true;

    for (let i = 0; i < this.columns.length; i += 1) {
      const c = this.columns[i];
      const left = flapperRound(c.x);
      if (x < left || x > left + FLAPPER_COL_WIDTH - 1) continue;
      if (y < c.gapY || y >= c.gapY + c.gapH) return true;
    }

    return false;
  }

  // The span the column *crossed* this tick, not the one it landed on — the
  // property that survives someone raising the scroll cap past a cell a tick.
  blocks(c, sweptFrom, y) {
    const left = flapperRound(c.x);
    const right = flapperRound(sweptFrom) + FLAPPER_COL_WIDTH - 1;

    if (this.flierX < left || this.flierX > right) return false;

    return y < c.gapY || y >= c.gapY + c.gapH;
  }

  targetRow() {
    for (let i = 0; i < this.columns.length; i += 1) {
      const c = this.columns[i];
      // Anything already behind the flier is history, and aiming at it drags
      // the flier back down through the hole it just left.
      if (flapperRound(c.x) + FLAPPER_COL_WIDTH - 1 < this.flierX) continue;
      return c.gapY + Math.floor(c.gapH / 2);
    }

    return Math.floor((this.h - 1) / 2);
  }

  // A damped position error, not a forward projection. Projecting free fall
  // forward means flapping as soon as the flier is within a braking distance of
  // the hole, so it settles a braking distance above it: aiming at row 12 it
  // hovered at row 7 and clipped the top of every column. It never scored once.
  chooseFlap() {
    return fr(this.y + fr(FLAPPER_DAMP * this.vy)) > this.targetRow();
  }

  // Fill the playfield as though the run were already under way. Without it the
  // field starts empty and scrolls in from the right over about two seconds,
  // and because losing a life clears the columns it does it again on every
  // death — three times a game. Rendered out and looked at, those two seconds
  // are a black rectangle with one white cell bobbing in it. No state check
  // catches that; an empty playfield is a legal one.
  fillField(rng) {
    this.columns = [];

    const first = fr(this.flierX + Math.max(this.spacing, Math.floor(this.w / 3)));

    for (let x = first; x < fr(this.w + this.spacing); x = fr(x + fr(this.spacing))) {
      this.spawnAt(x, rng);
    }
  }

  spawn(rng) {
    this.spawnAt(this.columns.length === 0
      ? fr(this.w)
      : fr(this.columns[this.columns.length - 1].x + fr(this.spacing)), rng);
  }

  spawnAt(x, rng) {

    // The hole walks from the last one rather than being drawn fresh.
    // Independent holes make an early field already unplayable and a late field
    // no worse, so the ramp would have nothing to ramp.
    const lo = 1;
    const hi = Math.max(lo, this.h - 1 - this.gapH);
    const span = 2 * this.drift + 1;

    let y = this.lastGapY + rng.below(span) - this.drift;
    y = clamp(y, lo, hi);

    this.lastGapY = y;
    this.columns.push({ x, gapY: y, gapH: this.gapH, taken: false });
  }

  ramp() {
    const maxGap = this.maxGap();

    // Three columns a step, not one: narrowing on every column outruns the
    // scroll and the run ends before the field has visibly sped up.
    if (this.passed % 3 === 0 && this.gapH > FLAPPER_MIN_GAP) this.gapH -= 1;

    this.scroll = Math.min(FLAPPER_MAX_SCROLL, fr(this.scroll + FLAPPER_RAMP_SCROLL));

    if (this.passed % 4 === 0 && this.spacing > FLAPPER_MIN_SPACING) this.spacing -= 1;

    // The drift is what finally ends it. Gap and spacing bottom out; this keeps
    // going until the hole can be anywhere on the playfield.
    if (this.passed % 5 === 0) this.drift = Math.min(Math.max(2, maxGap), this.drift + 1);
  }

  loseLife(rng) {
    this.lives -= 1;
    this.hurt = 20;

    if (this.lives <= 0) return;

    this.y = Math.floor((this.h - 1) / 2);
    this.vy = 0;

    // Rebuilt rather than kept: respawning into the column that just killed you
    // is a life lost on the tick it is granted — but rebuilding beats leaving it
    // empty, which is two black seconds on every death. See fillField.
    this.lastGapY = clamp(Math.floor((this.h - this.gapH) / 2), 1,
      Math.max(1, this.h - 1 - this.gapH));
    this.fillField(rng);

    // passed, gapH, scroll, spacing and drift all survive. The ramp is the
    // termination guarantee and a life must not rewind it.
  }

  tickHz(cfg) {
    const t = fr(clamp01(cfg.speed));
    return fr(fr(20) + fr(fr(fr(40) * t) * t));
  }

  step(cfg, input, rng) {
    if (this.lives <= 0) return;

    let flap = false;

    for (;;) {
      const b = input.pop();
      if (b === null) break;
      if (b === Button.Up || b === Button.Fire) flap = true;
    }

    this.ticks += 1;
    if (this.hurt > 0) this.hurt -= 1;

    if (cfg.autopilot) {
      const skill = clamp01(cfg.skill);

      if (rng.chance((1 - skill) * 0.3)) {
        flap = rng.chance(0.5);
      } else {
        flap = this.chooseFlap();
      }
    }

    if (flap) this.vy = -FLAPPER_FLAP;

    this.vy = clamp(fr(this.vy + FLAPPER_GRAVITY), -FLAPPER_MAX_FALL,
      Math.min(FLAPPER_SINK, FLAPPER_MAX_FALL));
    this.y = fr(this.y + this.vy);

    // Ceiling and floor both kill. A ceiling that merely stopped the flier
    // would make holding the button a safe place to wait out the field.
    if (this.y <= 0 || this.y >= this.h - 1) {
      this.y = clamp(this.y, 0, this.h - 1);
      this.loseLife(rng);
      return;
    }

    const fy = flapperRound(this.y);

    for (let i = 0; i < this.columns.length; i += 1) {
      const c = this.columns[i];
      const from = c.x;
      c.x = fr(c.x - this.scroll);

      if (this.blocks(c, from, fy)) {
        this.loseLife(rng);
        return;
      }

      // Scored on the tick the right edge passes the flier, which is the tick
      // it can no longer be hit.
      if (!c.taken && flapperRound(c.x) + FLAPPER_COL_WIDTH - 1 < this.flierX) {
        c.taken = true;
        this.passed += 1;
        this.scoreValue += 1;
        this.ramp();
      }
    }

    while (this.columns.length > 0
      && flapperRound(this.columns[0].x) + FLAPPER_COL_WIDTH - 1 < 0) {
      this.columns.shift();
    }

    if (this.columns.length === 0
      || this.columns[this.columns.length - 1].x <= this.w - this.spacing) {
      this.spawn(rng);
    }
  }

  draw(cfg, grid) {
    grid.clear();

    // Ceiling and floor only. The columns arrive from off-screen right and
    // leave off-screen left, and a wall at either end would read as the field
    // being enclosed when the whole point is that it is not.
    for (let x = 0; x < this.w; x += 1) {
      grid.set(x, 0, Cell.Wall, 255);
      grid.set(x, this.h - 1, Cell.Wall, 255);
    }

    for (let i = 0; i < this.columns.length; i += 1) {
      const c = this.columns[i];
      const left = flapperRound(c.x);
      for (let k = 0; k < FLAPPER_COL_WIDTH; k += 1) {
        const x = left + k;
        if (x < 0 || x >= this.w) continue;

        for (let y = 1; y <= this.h - 2; y += 1) {
          if (y < c.gapY || y >= c.gapY + c.gapH) grid.set(x, y, Cell.Wall, 200);
        }
      }
    }

    grid.set(this.flierX, flapperRound(this.y), Cell.Head, this.hurt > 0 ? 120 : 255);
  }

  score() { return this.scoreValue; }

  finished() { return this.lives <= 0; }

  intensity() {
    const maxGap = this.maxGap();

    const tight = maxGap > FLAPPER_MIN_GAP
      ? 1 - (this.gapH - FLAPPER_MIN_GAP) / (maxGap - FLAPPER_MIN_GAP)
      : 1;

    const fast = this.scroll / FLAPPER_MAX_SCROLL;

    // A column about to arrive is worth a reaction on its own, whatever the
    // ramp has got to.
    let close = 0;
    for (let i = 0; i < this.columns.length; i += 1) {
      const left = flapperRound(this.columns[i].x);
      if (left + FLAPPER_COL_WIDTH - 1 >= this.flierX && left - this.flierX <= 4) close = 0.7;
    }

    return clamp01(Math.max(close, 0.5 * tight + 0.5 * fast));
  }
}

/// Which games this page carries — all fourteen the plugin has, in `GameId`
/// order. The dropdown is built from these keys, and the notice in
/// `differences` prints itself if this map and `GAME_NAMES` ever disagree
/// again.
const GAMES = {
  0: () => new Snake(),
  1: () => new Bricks(),
  2: () => new Marchers(),
  3: () => new Rally(),
  4: () => new Drift(),
  5: () => new Stacker(),
  6: () => new Chase(),
  7: () => new Girders(),
  8: () => new Swarm(),
  9: () => new Trails(),
  10: () => new Reflex(),
  11: () => new Rafters(),
  12: () => new Duel(),
  13: () => new Flapper(),
};

const PORTED_GAME_NAMES = Object.keys(GAMES).map((i) => GAME_NAMES[i]);

//===========================================================================
// Port of source/Sim.cpp — the fixed-timestep driver.
//===========================================================================

const MAX_ELAPSED = 0.25;
const MAX_TICKS_PER_FRAME = 16;

class Sim {
  constructor() {
    this.id = 0;
    this.game = null;
    // GameConfig's own defaults, because `SetGame` restarts before the plugin
    // has pushed a config and the C++ member is default-constructed rather than
    // absent.
    this.cfg = {
      gridW: 32,
      gridH: 24,
      seed: 1n,
      speed: 0.5,
      skill: 0.6,
      autopilot: true,
      difficulty: 0.5,
      respawnTicks: 45,
    };
    this.grid = new Grid();
    this.rng = new Rng(1n);

    this.clock = -1;
    this.accum = 0;
    this.ticks = 0;
    this.lastFrameTicks = 0;
    this.deadTicks = 0;
  }

  setGame(id) {
    if (this.game && id === this.id) return;
    this.id = id;
    this.game = (GAMES[id] ?? GAMES[0])();
    this.restart();
  }

  /**
   * Structural changes restart; everything else is picked up live. The
   * distinction matters in performance: Speed and Skill are the two an operator
   * actually rides during a show, and a reset on every fader move would make
   * them unusable.
   */
  configure(cfg) {
    const structural = !this.cfg
      || cfg.gridW !== this.cfg.gridW
      || cfg.gridH !== this.cfg.gridH
      || cfg.seed !== this.cfg.seed;

    this.cfg = cfg;
    this.grid.resize(cfg.gridW, cfg.gridH);

    if (structural || !this.game) this.restart();
  }

  restart() {
    if (!this.game) this.game = (GAMES[this.id] ?? GAMES[0])();

    this.rng.reseed(this.cfg.seed);
    this.grid.resize(this.cfg.gridW, this.cfg.gridH);
    this.game.reset(this.cfg, this.rng);

    this.deadTicks = 0;
    this.accum = 0;

    // Deliberately not resetting the clock. A restart mid-run must not make the
    // next frame look like the first frame, or the accumulator would treat the
    // gap since the last frame as elapsed time and immediately owe ticks.
  }

  advance(hostSeconds, input) {
    this.lastFrameTicks = 0;
    if (!this.game) this.setGame(this.id);

    // Defence 2: no elapsed time, no tick. The first frame establishes the clock
    // and steps nothing; a repeated frame lands here with hostSeconds unchanged
    // and falls straight through to draw. A clock that went backwards is the
    // host looping or an operator scrubbing — a fresh start, not negative time.
    if (this.clock < 0 || hostSeconds < this.clock) {
      this.clock = hostSeconds;
      this.game.draw(this.cfg, this.grid);
      return;
    }

    let elapsed = hostSeconds - this.clock;
    this.clock = hostSeconds;

    if (elapsed <= 0) {
      this.game.draw(this.cfg, this.grid);
      return;
    }

    // Defence 3: cap the catch-up.
    if (elapsed > MAX_ELAPSED) elapsed = MAX_ELAPSED;

    // Defence 1: ticks come from the clock.
    const hz = this.game.tickHz(this.cfg);
    if (hz <= 0) {
      this.game.draw(this.cfg, this.grid);
      return;
    }

    const stepSeconds = 1 / hz;
    this.accum += elapsed;

    while (this.accum >= stepSeconds && this.lastFrameTicks < MAX_TICKS_PER_FRAME) {
      this.accum -= stepSeconds;

      if (this.game.finished()) {
        // Hold the finished playfield briefly, then start again. A game that
        // stops on game over leaves a static layer in the middle of a show,
        // which is worse than any amount of losing.
        this.deadTicks += 1;
        if (this.deadTicks >= this.cfg.respawnTicks) {
          // Advance the seed rather than reusing it, or every life is a
          // pixel-identical replay of the last one. The run stays reproducible
          // from the Seed parameter because this walk is itself deterministic.
          this.rng.reseed(this.rng.next());
          this.game.reset(this.cfg, this.rng);
          this.deadTicks = 0;
          input.clear();
        }
      } else {
        this.game.step(this.cfg, input, this.rng);
      }

      this.ticks += 1;
      this.lastFrameTicks += 1;
    }

    // Drop any surplus the cap left behind. Keeping it would mean the next frame
    // starts already owing the ticks this one refused, which is the spiral the
    // cap exists to prevent.
    if (this.lastFrameTicks >= MAX_TICKS_PER_FRAME) this.accum = 0;

    this.game.draw(this.cfg, this.grid);
  }
}

//===========================================================================
// The renderer.
//===========================================================================

class CoinopRenderer {
  constructor(gl, quad) {
    this.gl = gl;
    this.quad = quad;

    this.programs = {
      source: new Program(gl, VERTEX_SHADER, CELL_SHADER, 'cell'),
      effect: new Program(gl, VERTEX_SHADER, withDefines(CELL_SHADER, EFFECT_DEFINE), 'cell (effect)'),
    };

    this.sim = new Sim();
    this.input = new Input();

    // The cell texture. RGBA8UI, NEAREST — nothing about it may be filtered.
    this.cellTexture = gl.createTexture();
    this.texW = 0;
    this.texH = 0;

    gl.bindTexture(gl.TEXTURE_2D, this.cellTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Rising-edge latching for the event parameters, mirroring LatchButton: an
    // FF_TYPE_EVENT goes to 1 and back to 0 as the host sees fit, and it is the
    // transition that is the press.
    this.lastEvent = {};

    this.installKeyboard();
  }

  /**
   * The keyboard is this page's stand-in for the MIDI or OSC mapping you would
   * use in Resolume. It pushes the same Button values onto the same queue the
   * event parameters do — it is not a control the plugin has.
   */
  installKeyboard() {
    const map = {
      ArrowLeft: Button.Left,
      ArrowRight: Button.Right,
      ArrowUp: Button.Up,
      ArrowDown: Button.Down,
      Space: Button.Fire,
      KeyA: Button.Left,
      KeyD: Button.Right,
      KeyW: Button.Up,
      KeyS: Button.Down,
    };

    window.addEventListener('keydown', (e) => {
      const b = map[e.code];
      if (b === undefined) return;
      e.preventDefault();
      if (!e.repeat) this.input.press(b);
      this.input.setHeld(b, true);
    });

    window.addEventListener('keyup', (e) => {
      const b = map[e.code];
      if (b === undefined) return;
      this.input.setHeld(b, false);
    });
  }

  latch(params, id, button) {
    const now = params.get(id);
    const before = this.lastEvent[id] ?? 0;
    this.lastEvent[id] = now;
    if (before < 0.5 && now >= 0.5) this.input.press(button);
  }

  render({ input: clip, params, width, height, time, variant }) {
    const gl = this.gl;
    const isEffect = variant === 'effect';
    const program = isEffect ? this.programs.effect : this.programs.source;

    //---------------------------------------------------------------------
    // Config, then the simulation.
    //---------------------------------------------------------------------
    const aspect = params.option('aspect');
    const gw = gridWidth(params.get('grid'));
    const cfg = {
      gridW: gw,
      gridH: gridHeight(gw, aspect),
      seed: seedValue(params.get('seed')),
      speed: clamp01(params.get('speed')),
      skill: clamp01(params.get('skill')),
      difficulty: clamp01(params.get('difficulty')),
      autopilot: params.get('autoplay') > 0.5,
      respawnTicks: 45,
    };

    this.sim.setGame(params.option('game'));
    this.sim.configure(cfg);

    this.latch(params, 'left', Button.Left);
    this.latch(params, 'right', Button.Right);
    this.latch(params, 'up', Button.Up);
    this.latch(params, 'down', Button.Down);
    this.latch(params, 'fire', Button.Fire);

    const restartNow = params.get('restart');
    if ((this.lastEvent.restart ?? 0) < 0.5 && restartNow >= 0.5) this.sim.restart();
    this.lastEvent.restart = restartNow;

    this.input.axis = clamp01(params.get('paddle'));

    this.sim.advance(time, this.input);

    //---------------------------------------------------------------------
    // The playfield, uploaded as a tiny integer texture. 32x24 is 3 KB.
    //---------------------------------------------------------------------
    const grid = this.sim.grid;
    bindTexture(gl, 1, this.cellTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (grid.w !== this.texW || grid.h !== this.texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8UI, grid.w, grid.h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, grid.cells);
      this.texW = grid.w;
      this.texH = grid.h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.w, grid.h, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, grid.cells);
    }

    //---------------------------------------------------------------------
    // Draw.
    //---------------------------------------------------------------------
    gl.disable(gl.BLEND);
    program.use();

    program.setSampler('CellTexture', 1);
    program.set('GridSize', grid.w, grid.h);
    program.set('Resolution', width, height);
    program.setInt('FitMode', params.option('scaling'));

    program.setInt('PaletteMode', params.option('palette'));
    program.set('CellRound', clamp01(params.get('cellShape')));
    program.set('CellGap', clamp01(params.get('cellGap')));
    program.set('Glow', clamp01(params.get('glow')));
    program.set('Scanline', clamp01(params.get('scanlines')));
    program.set('Reactive', clamp01(params.get('reactive')));
    program.set('Intensity', this.sim.game ? this.sim.game.intensity() : 0);

    program.set(
      'BackColor',
      clamp01(params.get('backR')),
      clamp01(params.get('backG')),
      clamp01(params.get('backB')),
      clamp01(params.get('backOpacity')),
    );

    if (isEffect) {
      bindTexture(gl, 0, clip.texture);
      program.setSampler('InputTexture', 0);
      program.set('MaxUV', 1, 1);
      program.set('Mix', clamp01(params.get('mix')));
      program.setInt('ClipBricks', params.get('clipBricks') > 0.5 ? 1 : 0);
    }

    this.quad.draw();
  }
}

//===========================================================================
// Exported for demo/tools/check_sim.mjs, which drives the ported games under
// Node and compares the resulting playfield against `coinoptest --grid`.
// Nothing else imports these.
//===========================================================================

export { Sim, Grid, Cell, Rng, Input, GAMES, GAME_NAMES, PORTED_GAME_NAMES };

//===========================================================================
// The page.
//
// Guarded, because check_sim.mjs imports this module under Node where there is
// no window and nothing to mount.
//===========================================================================

const pct = (v) => `${Math.round(v * 100)}%`;

const DEMO = {
  name: 'Coinop',
  pluginId: 'CO01',
  tagline: 'Arcade games running inside the composition — playable, or left to the autopilot.',
  repo: 'https://github.com/stoatworks-labs/coinop',
  page: 'https://stoatworks-labs.com/software/coinop/',
  video: 'https://www.youtube.com/watch?v=DZyiCXpSt98',
  showBackdrop: true,

  variants: {
    label: 'Plugin',
    default: 'source',
    options: [
      { id: 'source', name: 'Coinop', hint: 'The source: a playfield over its own background.' },
      { id: 'effect', name: 'Coinop Over', hint: 'The effect: a playfield over the clip, with the brick field built out of it.' },
    ],
  },

  sources: ['scene', 'grid', 'bars', 'spot', 'ramp', 'detail', 'alpha'],

  differences: [
    ...(PORTED_GAME_NAMES.length < GAME_NAMES.length
      ? [`INCOMPLETE: the plugin has ${GAME_NAMES.length} games and this page currently carries ${PORTED_GAME_NAMES.length} — ${PORTED_GAME_NAMES.join(', ')}. The rest are not in the dropdown rather than being there and doing nothing.`]
      : []),
    'The shaders are the plugin\'s own text, copied across and checked character for character. All thirteen game simulations are a HAND PORT — a second implementation of the thing this plugin actually is. That port is checked: `coinoptest --grid` runs every game under one fixed configuration and reduces the playfield to a digest, and `demo/tools/check_sim.mjs` drives this JavaScript through the same sequence and diffs it. All thirteen agree byte for byte, including the four that carry float physics. What that does not cover is a sweep over seeds, skills or grid sizes, or the interactive path — it runs on autopilot with no input — and the C++ computes in 32-bit float where JavaScript has only 64-bit doubles, so the two could still drift apart over a longer run than the check exercises.',
    'Step and Restart do not mean what they mean on the other demos. This is the one plugin in the set with real simulation state, so a frame cannot be rendered on its own: Step advances the game by one frame of time and cannot go back, and Restart begins a new game rather than rewinding this one.',
    'The arrow keys and WASD are this page\'s stand-in for the MIDI or OSC mapping you would use in Resolume. They push the same values onto the same input queue the Left/Right/Up/Down/Fire parameters do — the plugin itself has no keyboard, because FFGL has none.',
    'Those five parameters are FF_TYPE_EVENT in the plugin — a momentary press. Here they are toggles, and it is the 0 to 1 transition that is latched as the press, which is exactly what LatchButton does with the host\'s value changes.',
    'A browser tab that loses focus is throttled, and the accumulator caps catch-up at a quarter of a second. Coming back to the tab, the game has skipped ahead rather than replayed — which is the plugin\'s own behaviour when a layer stops being rendered, and the correct answer: nobody was watching.',
  ],

  params: [
    //---- Game -------------------------------------------------------------
    {
      id: 'game', name: 'Game', type: 'option', default: 0, group: 'Game',
      elements: PORTED_GAME_NAMES,
      hint: 'A dropdown rather than thirteen plugins: the games do not need twenty-six entries in the effect list, and a fourteenth will not need two more.',
    },
    {
      id: 'speed', name: 'Speed', type: 'standard', default: 0.45, group: 'Game',
      display: (v) => `${(4 + 18 * clamp01(v) * clamp01(v)).toFixed(1)} Hz`,
      hint: 'Every game owns its own tick rate and the accumulator honours it. Snake wants four to twenty-two cells a second; a ball wants sixty or it visibly stutters.',
    },
    { id: 'difficulty', name: 'Difficulty', type: 'standard', default: 0.5, group: 'Game', display: pct },
    {
      id: 'skill', name: 'Skill', type: 'standard', default: 0.65, group: 'Game',
      display: pct,
      hint: 'Deliberate incompetence. A perfect Snake AI never dies, never resets, and leaves the layer showing the same slowly-lengthening snake all night — so Skill governs how often the autopilot bothers to consult its own survivability analysis.',
    },
    {
      id: 'autoplay', name: 'Autoplay', type: 'boolean', default: 1, group: 'Game',
      hint: 'The default and the mode that matters, because nobody hand-plays Snake for the length of a show.',
    },
    {
      id: 'seed', name: 'Seed', type: 'standard', default: 0.25, group: 'Game',
      display: (v) => `${Math.round(clamp01(v) * 4095)}`,
      hint: 'Same seed, same game. The 4096 steps are spread across the 64-bit space rather than used raw, because adjacent seeds fed straight into xorshift put the first apple in nearly the same place.',
    },
    { id: 'restart', name: 'Restart', type: 'boolean', default: 0, group: 'Game' },

    //---- Playfield --------------------------------------------------------
    {
      id: 'grid', name: 'Grid', type: 'standard', default: Math.sqrt((32 - 12) / 116), group: 'Playfield',
      display: (v) => `${gridWidth(v)} cells`,
      hint: 'Squared, because a pixel map is usually at the coarse end and that is where the slider needs its resolution. 32 across is where everything here was designed and measured.',
    },
    { id: 'aspect', name: 'Aspect', type: 'option', default: 0, group: 'Playfield', elements: ASPECT_NAMES },
    { id: 'scaling', name: 'Scaling', type: 'option', default: 0, group: 'Playfield', elements: FIT_NAMES },

    //---- Controls ---------------------------------------------------------
    {
      id: 'paddle', name: 'Paddle', type: 'standard', default: 0.5, group: 'Controls',
      display: pct,
      hint: 'The continuous control: paddle position across the playfield. A fader or an OSC float maps to this directly, and it is by some way the nicest way to play Bricks or Rally.',
    },
    { id: 'left', name: 'Left', type: 'boolean', default: 0, group: 'Controls' },
    { id: 'right', name: 'Right', type: 'boolean', default: 0, group: 'Controls' },
    { id: 'up', name: 'Up / Thrust', type: 'boolean', default: 0, group: 'Controls' },
    { id: 'down', name: 'Down', type: 'boolean', default: 0, group: 'Controls' },
    { id: 'fire', name: 'Fire', type: 'boolean', default: 0, group: 'Controls' },

    //---- Look -------------------------------------------------------------
    {
      id: 'palette', name: 'Palette', type: 'option', default: 0, group: 'Look',
      elements: PALETTE_NAMES,
      hint: 'Indexed by role rather than by cell type, so a palette does not have to know what a Marcher is.',
    },
    { id: 'cellShape', name: 'Cell Shape', type: 'standard', default: 0.25, group: 'Look', display: pct },
    { id: 'cellGap', name: 'Cell Gap', type: 'standard', default: 0.18, group: 'Look', display: pct },
    {
      id: 'glow', name: 'Glow', type: 'standard', default: 0.45, group: 'Look',
      display: pct,
      hint: 'Nine texelFetches of the neighbourhood, weighted by distance. It is what stops a 32×24 playfield from looking like a spreadsheet.',
    },
    {
      id: 'scanlines', name: 'Scanlines', type: 'standard', default: 0.0, group: 'Look',
      display: pct,
      hint: 'In output space rather than cell space — they are a property of the imagined display, not of the playfield, so they must not scale with the grid.',
    },
    { id: 'reactive', name: 'Reactive', type: 'standard', default: 0.35, group: 'Look', display: pct },

    //---- Background -------------------------------------------------------
    { id: 'backR', name: 'Background Red', type: 'colour', default: 0.02, group: 'Background' },
    { id: 'backG', name: 'Background Green', type: 'colour', default: 0.02, group: 'Background' },
    { id: 'backB', name: 'Background Blue', type: 'colour', default: 0.03, group: 'Background' },
    { id: 'backOpacity', name: 'Background Alpha', type: 'standard', default: 1.0, group: 'Background', display: pct },

    //---- Output -----------------------------------------------------------
    {
      id: 'clipBricks', name: 'Bricks From Clip', type: 'boolean', default: 0, group: 'Output',
      hint: 'The reason the effect variant exists: the brick field is the incoming video, so breaking a brick punches a hole through to the layer below.',
    },
    { id: 'mix', name: 'Mix', type: 'standard', default: 1.0, group: 'Output', display: pct },
  ],

  createRenderer: (gl, quad) => new CoinopRenderer(gl, quad),
};

if (typeof window !== 'undefined') mountDemo(DEMO);
