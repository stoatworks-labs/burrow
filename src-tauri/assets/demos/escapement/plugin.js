/**
 * Escapement — browser demo.
 *
 * The four shaders below are copied unedited from `source/Shaders.cpp`,
 * including the `#ifdef ESCAPEMENT_EFFECT` branches — the two bundles really are
 * one set of shaders compiled twice, and the picker in the transport bar
 * compiles them both ways here for the same reason. `withDefines()` inserts the
 * define after the `#version` line exactly as `Escapement.cpp` does, and
 * `demo/tools/check_shaders.py` compares the literals against the C++ character
 * for character.
 *
 * `Taps.cpp`, `Loop.cpp` and `Controls.cpp` are ported below. That port is the
 * interesting part of this page, because it is the plugin's whole design:
 *
 * **The fractals are the loop's attractor, not a formula.** A tap is one path
 * from the screen back into the camera; a set of taps is an iterated function
 * system; the fractal is what the loop settles into. `taps()` returns three
 * affine maps and the Sierpinski gasket arrives on its own. There is no
 * gasket-drawing code here, exactly as there is none in the plugin.
 *
 * ## This page is stateful, and no other demo in the fleet is
 *
 * Every other page in this kit renders a frame that is a pure function of
 * (parameters, time), so Step is exact and any frame can be drawn on its own. A
 * feedback rig cannot work that way — the picture is the whole history of the
 * loop, and the frame store is the instrument's memory.
 *
 * Two consequences, both deliberate:
 *
 *   - **The loop only advances on elapsed time.** A redraw caused by moving a
 *     slider while paused re-runs the *display* pass and no fields at all, so
 *     tweaking Palette or Opacity is instant and tweaking Gain does nothing
 *     until you press play. That is what the plugin does too: fields come from
 *     the host's clock delta, not from the frame having been drawn.
 *   - **Restart clears the store**, because restarting a rig means switching it
 *     on again. Scrubbing backwards does the same.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture, mipLevels } from './vendor/gl.js';

//===========================================================================
// The shaders. Copied from source/Shaders.cpp — see check_shaders.py.
//===========================================================================

const FULLSCREEN_VERTEX_SHADER = `#version 410 core

out vec2 vUV;

void main()
{
	// Attributeless. A triangle strip of four gives the corners in the order
	// (-1,-1) (1,-1) (-1,1) (1,1), which is what the bit tests below produce.
	vec2 c = vec2( ( gl_VertexID & 1 ) == 0 ? -1.0 : 1.0,
	               ( gl_VertexID & 2 ) == 0 ? -1.0 : 1.0 );

	vUV         = c * 0.5 + 0.5;
	gl_Position = vec4( c, 0.0, 1.0 );
}
`;

const ITERATOR_FRAGMENT_SHADER = `#version 410 core

in vec2 vUV;

uniform vec2 Resolution;
uniform float Aspect;

uniform int Iterations;
uniform int Mode;          // 0 Julia, 1 Mandelbrot
uniform vec2 JuliaC;

// The view, split high/low so that the same uniforms serve both precisions.
// In Single the .y halves are simply zero.
uniform vec2 CentreX;
uniform vec2 CentreY;
uniform vec2 Scale;
uniform bool Extended;

out vec4 fragColor;

//-------------------------------------------------------------------------
// Double-float arithmetic.
//
// Two floats carrying a high and a low part give about 48 bits of mantissa
// where one gives 24, which moves the point where a zoom turns to mush from
// around 1e5 out to around 1e13.
//
// Every intermediate is \`precise\`, and that keyword is the whole reason this
// works. \`cona - ( cona - a.x )\` is not a no-op: it is Dekker's split, and it is
// where the high half of the product comes from. Written as plain floats the
// compiler is entitled to reassociate it to zero, and Apple's does -- leaving
// arithmetic that still runs, still type-checks, still differs from the single
// path, and silently has 24 bits again.
//
// It was caught by the picture rather than by a test: a 1e6 zoom came out in
// rectangular blocks about eight pixels across, which is exactly the width at
// which 24-bit mantissas stop being able to tell two adjacent pixels apart at
// that magnification. Comparing single against extended does NOT catch it --
// the two paths round differently and their outputs differ either way.
//
// Do not remove \`precise\` to tidy these up. Nothing will fail to compile.
//-------------------------------------------------------------------------
vec2 dfAdd( vec2 a, vec2 b )
{
	precise float t1 = a.x + b.x;
	precise float e  = t1 - a.x;
	precise float t2 = ( ( b.x - e ) + ( a.x - ( t1 - e ) ) ) + a.y + b.y;
	precise float hi = t1 + t2;
	precise float lo = t2 - ( hi - t1 );
	return vec2( hi, lo );
}

vec2 dfMul( vec2 a, vec2 b )
{
	const float split = 8193.0;

	precise float cona = a.x * split;
	precise float conb = b.x * split;
	precise float a1   = cona - ( cona - a.x );
	precise float b1   = conb - ( conb - b.x );
	precise float a2   = a.x - a1;
	precise float b2   = b.x - b1;

	precise float c11 = a.x * b.x;
	precise float c21 = a2 * b2 + ( a2 * b1 + ( a1 * b2 + ( a1 * b1 - c11 ) ) );
	precise float c2  = a.x * b.y + a.y * b.x;

	precise float t1 = c11 + c2;
	precise float e  = t1 - c11;
	precise float t2 = a.y * b.y + ( ( c2 - e ) + ( c11 - ( t1 - e ) ) ) + c21;

	precise float hi = t1 + t2;
	precise float lo = t2 - ( hi - t1 );
	return vec2( hi, lo );
}

vec2 dfSet( float a )
{
	return vec2( a, 0.0 );
}

void main()
{
	// Frame coordinates: -1..1 across the SHORT edge, y up.
	vec2 p = vec2( ( vUV.x * 2.0 - 1.0 ) * Aspect, vUV.y * 2.0 - 1.0 );

	float smoothIter = 0.0;
	float escaped    = 0.0;
	float trap       = 1e9;

	if( Extended )
	{
		vec2 cx = dfAdd( CentreX, dfMul( Scale, dfSet( p.x ) ) );
		vec2 cy = dfAdd( CentreY, dfMul( Scale, dfSet( p.y ) ) );

		vec2 zx = ( Mode == 1 ) ? dfSet( 0.0 ) : cx;
		vec2 zy = ( Mode == 1 ) ? dfSet( 0.0 ) : cy;

		vec2 ax = ( Mode == 1 ) ? cx : dfSet( JuliaC.x );
		vec2 ay = ( Mode == 1 ) ? cy : dfSet( JuliaC.y );

		for( int i = 0; i < Iterations; ++i )
		{
			vec2 xx = dfMul( zx, zx );
			vec2 yy = dfMul( zy, zy );

			float r2 = xx.x + yy.x;
			if( r2 > 65536.0 )
			{
				// Smooth iteration count. The +1 - log2(log2 r) term removes the
				// banding that a bare integer count gives, and it is exact
				// enough in single precision even when the orbit was not: by the
				// time a point has escaped past 256 its low bits no longer
				// affect where the band edge falls.
				smoothIter = float( i ) + 1.0 - log2( log2( sqrt( r2 ) ) );
				escaped    = 1.0;
				break;
			}

			trap = min( trap, r2 );

			vec2 nx = dfAdd( dfAdd( xx, -yy ), ax );
			vec2 ny = dfAdd( dfMul( dfMul( zx, zy ), dfSet( 2.0 ) ), ay );
			zx      = nx;
			zy      = ny;
		}
	}
	else
	{
		vec2 c = vec2( CentreX.x, CentreY.x ) + Scale.x * p;
		vec2 z = ( Mode == 1 ) ? vec2( 0.0 ) : c;
		vec2 a = ( Mode == 1 ) ? c : JuliaC;

		for( int i = 0; i < Iterations; ++i )
		{
			float xx = z.x * z.x;
			float yy = z.y * z.y;
			float r2 = xx + yy;

			if( r2 > 65536.0 )
			{
				smoothIter = float( i ) + 1.0 - log2( log2( sqrt( r2 ) ) );
				escaped    = 1.0;
				break;
			}

			trap = min( trap, r2 );

			z = vec2( xx - yy, 2.0 * z.x * z.y ) + a;
		}
	}

	// The bank puts out a SIGNAL, not a picture: a scalar that the proc amp and
	// the palette downstream are free to do what they like with. Interior points
	// carry the orbit trap instead of zero, so the inside of the set has
	// structure to light rather than being a hole.
	// LOG spacing, not linear and not a root.
	//
	// Escape counts are distributed logarithmically: most of the plane leaves in
	// a handful of iterations and the interesting part takes hundreds. \`fract( n
	// * k )\` therefore puts every band edge out in the boring part and paints
	// all the structure in one flat colour -- a deep zoom came out as a uniform
	// orange rectangle. A square root fixes the deep end and breaks the shallow
	// one instead: it spreads the first ten iterations over half a cycle, which
	// wraps a Julia set in a bright halo that is not in the data.
	//
	// log2 matches how the counts actually fall, so one coefficient works at 1:1
	// and at 1e12 both.
	float v = escaped > 0.5
	              ? fract( log2( smoothIter + 1.0 ) * 0.5 )
	              : 0.35 * exp( -6.0 * sqrt( max( trap, 0.0 ) ) );

	fragColor = vec4( vec3( v ), 1.0 );
}
`;

const LOOP_FRAGMENT_SHADER = `#version 410 core

in vec2 vUV;

uniform sampler2D Prev;
uniform sampler2D Bank;

#ifdef ESCAPEMENT_EFFECT
uniform sampler2D ClipTexture;
uniform vec2 MaxUV;
#endif

uniform vec2 Resolution;
uniform float Aspect;

// The taps, already composed with the camera and already inverted.
uniform vec4 TapM[ 8 ];   // m00 m01 m10 m11
uniform vec4 TapT[ 8 ];   // tx ty weight hue
uniform int TapCount;
uniform float WeightSum;

uniform int Symmetry;
uniform bool FoldMirror;

uniform float Focus;
uniform float Lens;
uniform float Vignette;

uniform float Gain;
uniform float Pedestal;
uniform float Gamma;
uniform float HueRot;
uniform float Saturation;
uniform float ClipLevel;
uniform float Noise;
uniform float Decay;

uniform int InjectMode;
uniform float InjectLevel;
uniform float InjectSize;
uniform vec2 InjectPos;

uniform int FieldIndex;

out vec4 fragColor;

const float kPi = 3.14159265358979;

//-------------------------------------------------------------------------
// An exact integer hash, matching Hash.h on the CPU. Not fract(sin(x)*k):
// that is transcendental and its result differs between drivers, so the grain
// would differ between the machine a look was built on and the one it is run
// on.
//-------------------------------------------------------------------------
uint Hash32( uint x )
{
	x ^= x >> 16;
	x *= 0x7feb352du;
	x ^= x >> 15;
	x *= 0x846ca68bu;
	x ^= x >> 16;
	return x;
}

float Unit( uint h )
{
	return float( h >> 8 ) * ( 1.0 / 16777216.0 );
}

//-------------------------------------------------------------------------
// Hue rotation about the luma axis, written out component by component.
//
// The usual way to write this is three mat3s added together, which is a trap in
// GLSL: mat3 constructors take COLUMNS, the published coefficient tables are
// written in ROWS, and the result of getting it wrong is a rotation that still
// looks like a hue rotation and is wrong by a transpose. Explicit dot products
// cannot be silently transposed.
//-------------------------------------------------------------------------
vec3 HueRotate( vec3 c, float turns )
{
	if( turns == 0.0 )
		return c;

	float a  = turns * 2.0 * kPi;
	float s  = sin( a );
	float co = cos( a );

	float m00 = 0.299 + 0.701 * co + 0.168 * s;
	float m01 = 0.587 - 0.587 * co + 0.330 * s;
	float m02 = 0.114 - 0.114 * co - 0.497 * s;

	float m10 = 0.299 - 0.299 * co - 0.328 * s;
	float m11 = 0.587 + 0.413 * co + 0.035 * s;
	float m12 = 0.114 - 0.114 * co + 0.292 * s;

	float m20 = 0.299 - 0.300 * co + 1.250 * s;
	float m21 = 0.587 - 0.588 * co - 1.050 * s;
	float m22 = 0.114 + 0.886 * co - 0.203 * s;

	return vec3( m00 * c.r + m01 * c.g + m02 * c.b,
	             m10 * c.r + m11 * c.g + m12 * c.b,
	             m20 * c.r + m21 * c.g + m22 * c.b );
}

//-------------------------------------------------------------------------
// The amplifier running out of rail.
//
// Linear to ClipLevel, then an exponential approach to 1. Not a clamp: a hard
// clamp has a corner in it, and a corner inside a feedback loop quantises the
// picture into flat plateaus with hard edges. The soft knee is why a hot rig
// blooms rather than posterising.
//-------------------------------------------------------------------------
float SoftClip( float v, float t )
{
	float a = abs( v );
	if( a <= t )
		return v;

	float k = max( 1.0 - t, 1e-4 );
	float y = t + k * ( 1.0 - exp( -( a - t ) / k ) );
	return v < 0.0 ? -y : y;
}

vec2 FrameToUV( vec2 p )
{
	return vec2( p.x / Aspect, p.y ) * 0.5 + 0.5;
}

//-------------------------------------------------------------------------
// The mirror wedge.
//
// A rotational fold of order N: everything the camera sees is one wedge,
// repeated. This is how the Koch snowflake is built -- a four-tap Koch CURVE
// plus a three-fold fold -- for the cost of one coordinate wrap instead of the
// eight extra taps the twelve-map snowflake system would need. See Taps.cpp.
//-------------------------------------------------------------------------
vec2 Fold( vec2 p )
{
	if( Symmetry <= 1 )
		return p;

	float seg   = 2.0 * kPi / float( Symmetry );
	float r     = length( p );
	float theta = atan( p.y, p.x );

	//---------------------------------------------------------------------
	// The wedge is centred on STRAIGHT DOWN, and that is not cosmetic.
	//
	// A fold reads its source from one canonical wedge and repeats it. The
	// obvious \`mod( theta, seg )\` makes that wedge start at zero -- pointing
	// right -- and the Koch rig then reads from a part of the frame its curve
	// is nowhere near, because the curve is built lying along the BOTTOM of
	// the triangle it belongs to. The result is a black frame, from a rig
	// whose taps are all correct and whose gain is fine, which is a
	// particularly expensive way to spend an evening.
	//
	// Centring the wedge on -90 degrees puts it at [-150, -30) for a
	// three-fold, which is exactly the arc the Koch curve occupies. Down is
	// also the right default for everything else: it is where a rig's content
	// sits when it has a horizon, and no rig here is built along the +x axis.
	//---------------------------------------------------------------------
	float phase = theta + kPi * 0.5 + seg * 0.5;
	float a     = mod( phase, seg );

	// A real wedge is made of mirrors, so alternate sectors arrive reversed.
	// Rotational-only is the setting that builds the snowflake; mirrored is the
	// one that looks like a kaleidoscope.
	if( FoldMirror )
		a = abs( a - seg * 0.5 ) + seg * 0.5;

	theta = a - kPi * 0.5 - seg * 0.5;

	return r * vec2( cos( theta ), sin( theta ) );
}

//-------------------------------------------------------------------------
// The lens.
//
// Applied to the coordinate the tap fetch is about to use, so it is INSIDE the
// loop and compounds: a barrel distortion of a barrel distortion of a barrel
// distortion is most of why a real rig's spirals curl the way they do. A lens
// correction applied once on the way out would look like a warped picture
// instead.
//-------------------------------------------------------------------------
vec2 LensWarp( vec2 p )
{
	if( Lens == 0.0 )
		return p;

	float r2 = dot( p, p );
	return p * ( 1.0 + Lens * 0.25 * r2 );
}

vec3 Inject( vec2 p )
{
	if( InjectMode == 0 || InjectLevel <= 0.0 )
		return vec3( 0.0 );

	vec2 q = ( p - InjectPos ) / max( InjectSize, 1e-4 );
	vec3 c = vec3( 0.0 );

	if( InjectMode == 1 )
	{
		// Dot. Gaussian rather than a disc: a hard-edged spot injects a step,
		// and a step going round a loop with gain comes back as a ring.
		c = vec3( exp( -dot( q, q ) * 2.0 ) );
	}
	else if( InjectMode == 2 )
	{
		// Colour bars.
		float b = floor( fract( q.x * 0.125 + 0.5 ) * 7.0 );
		vec3 bars[ 7 ] = vec3[ 7 ](
			vec3( 1.0, 1.0, 1.0 ), vec3( 1.0, 1.0, 0.0 ), vec3( 0.0, 1.0, 1.0 ),
			vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ),
			vec3( 0.0, 0.0, 1.0 ) );
		c = bars[ int( clamp( b, 0.0, 6.0 ) ) ] * step( abs( q.y ), 1.0 ) * step( abs( q.x ), 4.0 );
	}
	else if( InjectMode == 3 )
	{
		// Grid. Shows what the taps are doing more plainly than anything else,
		// which is what it is for.
		vec2 g = abs( fract( q * 0.5 ) - 0.5 );
		float line = 1.0 - smoothstep( 0.0, 0.06, min( g.x, g.y ) );
		c = vec3( line ) * step( length( q ), 8.0 );
	}
	else if( InjectMode == 4 )
	{
		uint h = Hash32( uint( gl_FragCoord.x ) * 1973u + uint( gl_FragCoord.y ) * 9277u + uint( FieldIndex ) * 26699u );
		c      = vec3( Unit( h ), Unit( Hash32( h ) ), Unit( Hash32( Hash32( h ) ) ) );
	}
	else if( InjectMode == 5 )
	{
		c = texture( Bank, FrameToUV( q * InjectSize + InjectPos ) ).rgb;
	}
	else if( InjectMode == 6 )
	{
#ifdef ESCAPEMENT_EFFECT
		vec2 uv = FrameToUV( q * InjectSize + InjectPos );
		if( uv == clamp( uv, 0.0, 1.0 ) )
			c = texture( ClipTexture, uv * MaxUV ).rgb;
#endif
	}

	return c * InjectLevel;
}

void main()
{
	vec2 p = vec2( ( vUV.x * 2.0 - 1.0 ) * Aspect, vUV.y * 2.0 - 1.0 );

	vec2 folded = Fold( p );

	//---------------------------------------------------------------------
	// The taps.
	//
	// Each is an inverse map, so this asks "where in the previous field did
	// what belongs at this pixel come from". Fetches outside the frame return
	// nothing rather than the clamped edge texel: a real camera pointed
	// slightly off its screen sees the dark room, not an infinitely smeared
	// copy of the edge pixel, and clamping here is the single most recognisable
	// way to make a feedback plugin look like a shader instead of a rig.
	//---------------------------------------------------------------------
	vec3 acc = vec3( 0.0 );

	for( int i = 0; i < TapCount; ++i )
	{
		vec2 q = vec2( TapM[ i ].x * folded.x + TapM[ i ].y * folded.y + TapT[ i ].x,
		               TapM[ i ].z * folded.x + TapM[ i ].w * folded.y + TapT[ i ].y );

		q = LensWarp( q );

		vec2 uv = FrameToUV( q );
		if( uv != clamp( uv, 0.0, 1.0 ) )
			continue;

		vec3 s = textureLod( Prev, uv, Focus ).rgb;

		if( TapT[ i ].w != 0.0 )
			s = HueRotate( s, TapT[ i ].w );

		// The lens is dark at the edges, and being dark at the edges INSIDE a
		// loop is what stops the picture filling the frame edge to edge and
		// going flat. It is a stabiliser, not a look.
		if( Vignette > 0.0 )
		{
			float r = length( q );
			s *= 1.0 - Vignette * clamp( r * 0.7, 0.0, 1.0 );
		}

		acc += s * TapT[ i ].z;
	}

	//---------------------------------------------------------------------
	// The taps SUM. They are not averaged, and that is the difference between
	// this working and not.
	//
	// Averaging is the tempting normalisation -- three taps, divide by three,
	// the brightness stays put. It also destroys the attractor. A point on the
	// gasket is reached by exactly ONE of the three maps, so averaging hands it
	// a third of the light it had, every field: a loop gain of 0.33 dressed up
	// as a normalisation, and the picture goes black no matter what the proc amp
	// is set to. That is what the first contact sheet showed -- five rigs black
	// and nobody able to say why, because the gain control said 1.12.
	//
	// Summing is also what the glass does. A half-mirror splits a beam and the
	// two paths ADD where they land on the sensor; nothing in an optical path
	// divides by the number of paths. Overlaps therefore brighten, and the soft
	// clip is what stops them -- which is the correct place for it, because that
	// is where a real amplifier stops them too.
	//
	// \`WeightSum\` is still uploaded, and is still what a per-tap weight has to
	// be read against, but it is a diagnostic rather than a divisor: Kaleido
	// carries 1/N weights of its own because a mirror wedge really does split
	// the light N ways.
	//---------------------------------------------------------------------

	//---------------------------------------------------------------------
	// Persistence.
	//
	// What stays where it is, as distinct from what goes round the geometric
	// path. Phosphor decay and the camera's integration time do the same thing
	// and are the same term. Gain moves without smearing; Decay smears without
	// moving.
	//---------------------------------------------------------------------
	vec3 held = textureLod( Prev, vUV, 0.0 ).rgb * Decay;

	vec3 c = acc * Gain + held;

	c += vec3( Pedestal );

	c = HueRotate( c, HueRot );

	float luma = dot( c, vec3( 0.299, 0.587, 0.114 ) );
	c          = mix( vec3( luma ), c, Saturation );

	// Gamma on the magnitude, sign preserved. The signal can be negative here --
	// a negative pedestal puts it there deliberately -- and pow() of a negative
	// is undefined, which is one of the two ways this buffer gets its first NaN.
	c = sign( c ) * pow( abs( c ), vec3( Gamma ) );

	c += Inject( p );

	if( Noise > 0.0 )
	{
		uint h = Hash32( uint( gl_FragCoord.x ) * 6151u + uint( gl_FragCoord.y ) * 1543u + uint( FieldIndex ) * 3079u );
		c += ( vec3( Unit( h ), Unit( Hash32( h ) ), Unit( Hash32( Hash32( h ) ) ) ) - 0.5 ) * Noise;
	}

	c = vec3( SoftClip( c.r, ClipLevel ), SoftClip( c.g, ClipLevel ), SoftClip( c.b, ClipLevel ) );

	//---------------------------------------------------------------------
	// The NaN guard, and why it is not optional.
	//
	// This buffer feeds itself. NaN times anything is NaN, so a single NaN
	// anywhere survives every subsequent field for the life of the instance --
	// it does not decay, it cannot be cleared by turning the gain down, and it
	// spreads through the taps into its neighbours. One bad frame becomes a
	// plugin that is permanently broken until the host reloads it.
	//
	// The clamp is the same guard for the other direction: a rig held above
	// unity gain with the clip wide open can reach infinity in a few dozen
	// fields, and inf - inf is NaN.
	//---------------------------------------------------------------------
	if( any( isnan( c ) ) || any( isinf( c ) ) )
		c = vec3( 0.0 );

	fragColor = vec4( clamp( c, -8.0, 8.0 ), 1.0 );
}
`;

const DISPLAY_FRAGMENT_SHADER = `#version 410 core

in vec2 vUV;

uniform sampler2D Store;

#ifdef ESCAPEMENT_EFFECT
uniform sampler2D ClipTexture;
uniform vec2 MaxUV;
uniform int MaskMode;
uniform float Blend;
#endif

uniform vec2 Resolution;
uniform float Aspect;

uniform int PaletteMode;
uniform float PaletteShift;
uniform float Opacity;
uniform float Bloom;

// Rescan -- the Globe rig.
uniform float Sphere;
uniform float Tilt;
uniform float SpinPhase;
uniform float Light;

out vec4 fragColor;

const float kPi = 3.14159265358979;

vec3 Palette( float v )
{
	v = fract( v + PaletteShift );

	if( PaletteMode == 1 )
	{
		// P3 amber. The green channel of a real amber phosphor does not track
		// the red linearly, which is why this is a curve and not a tint.
		return vec3( pow( v, 0.7 ), pow( v, 1.5 ) * 0.75, pow( v, 3.0 ) * 0.18 );
	}
	if( PaletteMode == 2 )
	{
		return vec3( pow( v, 1.6 ) * 0.55, pow( v, 1.1 ) * 0.85, pow( v, 0.6 ) );
	}
	if( PaletteMode == 3 )
	{
		// Black - red - orange - white.
		return clamp( vec3( v * 3.0, v * 3.0 - 1.0, v * 3.0 - 2.0 ), 0.0, 1.0 );
	}
	if( PaletteMode == 4 )
	{
		vec3 h = clamp( abs( mod( v * 6.0 + vec3( 0.0, 4.0, 2.0 ), 6.0 ) - 3.0 ) - 1.0, 0.0, 1.0 );

		// Faded to black at the bottom, and without this the palette has no
		// black point at all: hue at v = 0 is full-brightness RED, so every
		// unlit pixel of a generator whose background is black comes out
		// orange. The picture then reads as a wash with a fractal somewhere in
		// it -- which is exactly what the Seeded Rig preset looked like, and it
		// was the palette rather than the rig the whole time.
		//
		// smoothstep rather than a multiply by v: multiplying dims the
		// mid-tones too and turns a hue sweep into a hue-and-brightness sweep.
		// This only touches the bottom sixth.
		return h * smoothstep( 0.0, 0.15, v );
	}

	return vec3( v );
}

vec3 Shade( vec2 uv, out float coverage )
{
	coverage = 1.0;

	vec3 signalColour;

	if( Sphere <= 0.0 )
	{
		vec3 s = texture( Store, uv ).rgb;

		// Bloom: the high mip levels ARE a blurred copy of the picture, already
		// paid for because the loop needs the mip chain for Focus. Halation on a
		// screen and flare in a lens are both a wide, dim copy of the bright
		// parts, which is what this adds.
		if( Bloom > 0.0 )
		{
			vec3 wide = textureLod( Store, uv, 4.0 ).rgb + textureLod( Store, uv, 6.0 ).rgb;
			s += wide * Bloom * 0.5;
		}

		signalColour = s;
	}
	else
	{
		//-----------------------------------------------------------------
		// The rescan.
		//
		// The rig's screen is a sphere and the camera is looking at it. The
		// intersection is analytic rather than ray marched -- it is one sphere,
		// and marching it would be a lot of work to arrive at the same quadratic.
		//-----------------------------------------------------------------
		vec2 p = vec2( ( uv.x * 2.0 - 1.0 ) * Aspect, uv.y * 2.0 - 1.0 );

		float r2 = dot( p, p );
		float radius = 0.92;

		if( r2 > radius * radius )
		{
			coverage = 0.0;
			return vec3( 0.0 );
		}

		float z = sqrt( max( radius * radius - r2, 0.0 ) );
		vec3 n  = vec3( p, z ) / radius;

		// Tilt, then spin. Spin second so the globe turns about its own axis
		// rather than about the camera's.
		float ct = cos( Tilt ), st = sin( Tilt );
		vec3 m   = vec3( n.x, ct * n.y - st * n.z, st * n.y + ct * n.z );

		float lon = atan( m.x, m.z ) / ( 2.0 * kPi ) + 0.5 + SpinPhase;
		float lat = asin( clamp( m.y, -1.0, 1.0 ) ) / kPi + 0.5;

		vec3 s = texture( Store, vec2( fract( lon ), clamp( lat, 0.0, 1.0 ) ) ).rgb;

		// Wrap the mapping back towards the flat picture as Sphere comes down,
		// so the control is a continuous move between the two rather than a
		// switch with nothing in between.
		s = mix( texture( Store, uv ).rgb, s, Sphere );

		// Lambert against a light over the camera's shoulder, plus a rim. A
		// self-lit screen is not a lit object, so the shading is deliberately
		// gentle: too much and it stops looking like a screen wrapped on a ball
		// and starts looking like a painted prop.
		vec3 lightDir = normalize( vec3( -0.4, 0.5, 0.75 ) );
		float lambert = max( dot( n, lightDir ), 0.0 );
		float rim     = pow( 1.0 - abs( n.z ), 3.0 );

		s *= mix( 1.0, 0.35 + 0.9 * lambert, Light * Sphere );
		s += vec3( rim ) * 0.12 * Light * Sphere;

		// The limb, so the ball has an edge rather than a staircase.
		float edge = smoothstep( radius, radius - 0.004, sqrt( r2 ) );
		coverage   = mix( 1.0, edge, Sphere );

		signalColour = s;
	}

	if( PaletteMode == 0 )
		return signalColour;

	// A palette is a lookup on ONE number, so the signal has to become one.
	// Luma rather than the maximum channel: the loop's hue rotation means the
	// channels take turns being the bright one, and a max would make the
	// palette flicker between them field to field.
	float v = dot( clamp( signalColour, 0.0, 4.0 ), vec3( 0.299, 0.587, 0.114 ) );
	return Palette( v );
}

void main()
{
	float coverage;
	vec3 c = Shade( vUV, coverage );

	c = clamp( c, 0.0, 4.0 );

	float a = Opacity * coverage;

#ifdef ESCAPEMENT_EFFECT
	vec4 clipColour = texture( ClipTexture, vUV * MaxUV );

	// The clip arrives premultiplied and leaves the same way.
	float loopLuma = clamp( dot( c, vec3( 0.299, 0.587, 0.114 ) ), 0.0, 1.0 );

	vec4 result;

	if( MaskMode == 0 )
	{
		vec4 over = vec4( c * a, a );
		result    = over + clipColour * ( 1.0 - over.a );
	}
	else if( MaskMode == 1 )
	{
		result = clipColour * loopLuma * a;
	}
	else if( MaskMode == 2 )
	{
		result = clipColour * ( 1.0 - loopLuma * a );
	}
	else
	{
		result = vec4( clipColour.rgb * c, clipColour.a );
	}

	fragColor = mix( clipColour, result, Blend );
#else
	fragColor = vec4( c * a, a );
#endif
}
`;

//===========================================================================
// Controls.cpp — the 0..1 conversions.
//
// Every numeric parameter the plugin declares is a plain 0..1 float, because
// `SetParamInfo` clamps a STANDARD default into 0..1 before `SetParamRange` can
// widen it. The range lives in these functions, and so it lives here too.
//===========================================================================

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const exponential = (v, lo, hi) => lo * Math.pow(hi / lo, clamp01(v));

/**
 * A slider whose centre is exactly zero, curved either side.
 *
 * Exact zero at exactly 0.5 is load-bearing rather than tidy: it is the
 * difference between a rig you can park and one that drifts imperceptibly for
 * the whole set. `2 * 0.5 - 1` is exactly 0 in binary floating point, and
 * `Math.pow(0, shape)` is exactly 0, so the detent is an identity.
 */
function signedFromParam(value, range, shape) {
  const t = clamp01(value) * 2 - 1;
  const mag = Math.pow(Math.abs(t), shape);
  return (t < 0 ? -mag : mag) * range;
}

const tapsFromParam = (v) => Math.min(8, 2 + Math.floor(clamp01(v) * 6.999));
const seedFromParam = (v) => 1 + Math.floor(clamp01(v) * 9998.999);
const symmetryFromParam = (v) => Math.min(12, 1 + Math.floor(clamp01(v) * 11.999));
const fieldRateFromParam = (v) => exponential(v, 5, 120);
const zoomFromParam = (v) => 1 + signedFromParam(v, 0.1, 3);
const rotateFromParam = (v) => signedFromParam(v, 0.1, 2.5);
const panFromParam = (v) => signedFromParam(v, 0.05, 2.5);
const speedFromParam = (v) => (v < 0.02 ? 0 : Math.pow(4, clamp01(v) * 2 - 1));
const driftFromParam = (v) => clamp01(v);
const driftRateFromParam = (v) => exponential(v, 0.005, 1);
/**
 * Defocus, as a fraction of the SHORT EDGE — not a mip level.
 *
 * It reaches the shader as a textureLod bias, and a lod is a number of TEXELS,
 * so the same lod blurs a quarter as much of the picture at 1280x720 as at
 * 320x180. For a reaction-diffusion rig the blur IS the diffusion length and
 * therefore sets the size of everything the loop grows: Cell Structures rendered
 * 8 domains across the frame at 320x180 and 36 at 1280x720 from one preset.
 */
const focusFromParam = (v) => clamp01(v) * 0.05;

/// The lod that blurs `fraction` of the short edge at this raster. Zero stays
/// exactly zero: a lens cannot be sharper than one texel.
function focusLod(fraction, width, height) {
  const shortEdge = Math.min(width, height);
  if (shortEdge <= 0 || fraction <= 0) return 0;
  const texels = fraction * shortEdge;
  return texels <= 1 ? 0 : Math.log2(texels);
}
const lensFromParam = (v) => signedFromParam(v, 1, 1.6);
const gainFromParam = (v) => clamp01(v) * 1.6;
const pedestalFromParam = (v) => signedFromParam(v, 0.1, 2);
const gammaFromParam = (v) => exponential(v, 0.4, 2.5);
const hueRotateFromParam = (v) => signedFromParam(v, 0.02, 2);
const saturationFromParam = (v) => clamp01(v) * 2;
const clipFromParam = (v) => 0.3 + clamp01(v) * 0.7;
const noiseFromParam = (v) => clamp01(v) * clamp01(v) * 0.08;
const decayFromParam = (v) => clamp01(v) * 0.98;
const injectLevelFromParam = (v) => (v < 0.005 ? 0 : exponential(v, 0.01, 2));
const injectSizeFromParam = (v) => exponential(v, 0.01, 1.5);
const injectPosFromParam = (v) => signedFromParam(v, 1.5, 1);
const iterationsFromParam = (v) => Math.round(exponential(v, 16, 2048));
const juliaFromParam = (v) => signedFromParam(v, 2, 1.6);
const escapeZoomFromParam = (v) => Math.pow(10, clamp01(v) * 13);
const escapeCentreFromParam = (v) => signedFromParam(v, 2, 1);
const sphereFromParam = (v) => clamp01(v);
const tiltFromParam = (v) => signedFromParam(v, 1.57079633, 1);
const spinFromParam = (v) => signedFromParam(v, 1, 2);
const paletteShiftFromParam = (v) => clamp01(v);

//===========================================================================
// Hash.h — Chris Wellons' lowbias32.
//
// An integer hash rather than `fract( sin( x ) * k )` because the usual one is
// transcendental and differs between machines. Seed 4021 has to be the same rig
// on this page as it is in Resolume, which is exactly the property a sine does
// not have.
//===========================================================================

function hash32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

const hash2 = (a, b) => hash32((a ^ hash32((b + 0x9e3779b9) >>> 0)) >>> 0);
const unit = (h) => (h >>> 8) * (1 / 16777216);
const signedHash = (h) => unit(h) * 2 - 1;

//===========================================================================
// Taps.cpp — the glass.
//
// A tap is one path from the screen back into the camera. A set of taps is an
// iterated function system and the fractal is its attractor: three half-scale
// taps on the vertices of a triangle have the Sierpinski gasket, and a loop
// carrying them converges on it from any starting image at all, including
// noise.
//
// Every map here is the forward contraction `w`, written the way the
// mathematics writes it, so it can be checked against a textbook line by line.
// The shader is handed `w^-1`, because a fragment shader pulls.
//===========================================================================

const MAX_TAPS = 8;
const PI = 3.14159265358979323846;

const RIG = {
  Mirror: 0, Sierpinski: 1, Koch: 2, Dragon: 3, Fern: 4,
  Kaleido: 5, Seeded: 6, Julia: 7, Mandelbrot: 8, Globe: 9,
};

const RIG_NAMES = [
  'Mirror', 'Sierpinski', 'Koch', 'Dragon', 'Fern',
  'Kaleidoscope', 'Seeded', 'Julia', 'Mandelbrot', 'Globe',
];

const INJECT_NAMES = ['None', 'Dot', 'Bars', 'Grid', 'Noise', 'Iterator', 'Clip'];
const PALETTE_NAMES = ['Signal', 'Phosphor', 'Ice', 'Ember', 'Spectrum'];
const SYNC_NAMES = ['Free', 'Beat', 'Bar', 'Manual'];
const PRECISION_NAMES = ['Single', 'Extended'];
const MASK_NAMES = ['Over', 'Reveal', 'Hide', 'Colourise'];

const rigUsesTaps = (rig) => rig !== RIG.Julia && rig !== RIG.Mandelbrot;

const makeTap = () => ({ m: [1, 0, 0, 1], tx: 0, ty: 0, weight: 1, hue: 0 });

/** A similarity: scale, then rotate, then translate. */
function similarity(scale, radians, tx, ty) {
  const c = Math.cos(radians) * scale;
  const s = Math.sin(radians) * scale;
  return { m: [c, -s, s, c], tx, ty, weight: 1, hue: 0 };
}

/**
 * Rewrite a map published in another coordinate system.
 *
 * A change of basis has to be a CONJUGATION — `S w S^-1` — because the maps
 * compose with each other field after field, so a coordinate change applied
 * once at the end is applied once while the maps go on iterating in the old
 * system for ever.
 */
function conjugate(w, k, ox, oy) {
  return {
    m: w.m.slice(),
    tx: k * w.tx + ox - (w.m[0] * ox + w.m[1] * oy),
    ty: k * w.ty + oy - (w.m[2] * ox + w.m[3] * oy),
    weight: w.weight,
    hue: w.hue,
  };
}

/** a after b: p -> a( b( p ) ) */
function compose(a, b) {
  return {
    m: [
      a.m[0] * b.m[0] + a.m[1] * b.m[2],
      a.m[0] * b.m[1] + a.m[1] * b.m[3],
      a.m[2] * b.m[0] + a.m[3] * b.m[2],
      a.m[2] * b.m[1] + a.m[3] * b.m[3],
    ],
    tx: a.m[0] * b.tx + a.m[1] * b.ty + a.tx,
    ty: a.m[2] * b.tx + a.m[3] * b.ty + a.ty,
    weight: a.weight * b.weight,
    hue: a.hue + b.hue,
  };
}

/**
 * Rescale and recentre a tap set so its attractor fills `extent`.
 *
 * The named rigs do not need this. A SEEDED rig does, because its attractor is
 * not knowable before the seed is: four maps from seed 4021 settle inside 1.45
 * frame units and the same four from seed 7 spread across 2.68.
 *
 * The bounds are measured by playing the chaos game, which is a Monte Carlo
 * estimate and deliberately not a bound — an arbitrary IFS has no analytic
 * bounding box. Deterministic despite the name: the orbit is driven by hash32,
 * so this page frames seed 4021 exactly as Resolume does.
 */
function fitToFrame(set, extent) {
  if (set.count < 1) return set;

  let x = 0, y = 0;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  let s = 0x9e3779b9;

  for (let i = 0; i < 20000; i += 1) {
    s = hash32(s);
    const t = set.taps[s % set.count];
    const nx = t.m[0] * x + t.m[1] * y + t.tx;
    const ny = t.m[2] * x + t.m[3] * y + t.ty;
    x = nx; y = ny;
    if (i < 200) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }

  const w = x1 - x0;
  const h = y1 - y0;
  const m = w > h ? w : h;
  if (!(m > 1e-4)) return set;

  const k = extent / m;
  const ox = -k * (x0 + x1) * 0.5;
  const oy = -k * (y0 + y1) * 0.5;

  return { count: set.count, taps: set.taps.map((t) => conjugate(t, k, ox, oy)) };
}

function taps(rig, count, seed) {
  const set = { taps: [], count: 1 };

  if (rig === RIG.Sierpinski) {
    // Three half-scale maps whose fixed points are the vertices of an
    // equilateral triangle: w_i( x ) = ( x + v_i ) / 2, so w_i( v_i ) = v_i.
    // The gasket is the attractor, and it is a gasket rather than a filled
    // triangle because the three half-scale copies cover it everywhere except
    // the middle third — at every scale.
    const r = 0.92;
    const cy = -r * 0.25;
    const v = [
      [0, r + cy],
      [-r * 0.8660254, -r * 0.5 + cy],
      [r * 0.8660254, -r * 0.5 + cy],
    ];
    for (let i = 0; i < 3; i += 1) {
      const t = makeTap();
      t.m = [0.5, 0, 0, 0.5];
      t.tx = 0.5 * v[i][0];
      t.ty = 0.5 * v[i][1];
      set.taps[i] = t;
    }
    set.count = 3;
  } else if (rig === RIG.Koch) {
    // The Koch CURVE, four third-scale maps. The bump points DOWN — the
    // rotations are negated against the usual textbook pair — and that sign is
    // the difference between a snowflake and a hexagram, because the fold puts
    // this curve on the three sides of a triangle centred on the origin.
    const third = 1 / 3;
    const w = [
      similarity(third, 0, 0, 0),
      similarity(third, -PI / 3, third, 0),
      similarity(third, PI / 3, 0.5, -0.28867513),
      similarity(third, 0, 2 * third, 0),
    ];
    for (let i = 0; i < 4; i += 1) set.taps[i] = conjugate(w[i], 1.6, -0.8, -0.46188022);
    set.count = 4;
  } else if (rig === RIG.Dragon) {
    const s = 0.70710678;
    const w = [similarity(s, PI * 0.25, 0, 0), similarity(s, PI * 0.75, 1, 0)];
    for (let i = 0; i < 2; i += 1) set.taps[i] = conjugate(w[i], 1.0337, -0.4307, -0.1723);
    set.count = 2;
  } else if (rig === RIG.Fern) {
    // Barnsley's fern, exactly as published. The first map has determinant zero
    // — it collapses the plane onto the stem — so it cannot be pulled through
    // and the loop drops it. The stem is then missing, which is the honest
    // outcome of a rig that can only pull.
    const f = [
      [0.0, 0.0, 0.0, 0.16, 0.0, 0.0],
      [0.85, 0.04, -0.04, 0.85, 0.0, 1.6],
      [0.2, -0.26, 0.23, 0.22, 0.0, 1.6],
      [-0.15, 0.28, 0.26, 0.24, 0.0, 0.44],
    ];
    for (let i = 0; i < 4; i += 1) {
      const w = { m: [f[i][0], f[i][1], f[i][2], f[i][3]], tx: f[i][4], ty: f[i][5], weight: 1, hue: 0 };
      set.taps[i] = conjugate(w, 0.1852, -0.0239, -0.775);
    }
    set.count = 4;
  } else if (rig === RIG.Kaleido) {
    // A mirror wedge: N unit-scale rotations, because a mirror does not shrink
    // what it reflects. That makes the set exactly non-contractive on its own,
    // and it is meant to — the camera's zoom is the only contraction in a
    // kaleidoscope rig.
    const n = Math.min(MAX_TAPS, Math.max(2, count));
    for (let i = 0; i < n; i += 1) {
      const t = similarity(1, (2 * PI * i) / n, 0, 0);
      t.weight = 1 / n;
      t.hue = 0.012 * i;
      set.taps[i] = t;
    }
    set.count = n;
  } else if (rig === RIG.Seeded) {
    const n = Math.min(MAX_TAPS, Math.max(2, count));
    for (let i = 0; i < n; i += 1) {
      const h0 = hash2(i * 4 + 0, seed);
      const h1 = hash2(i * 4 + 1, seed);
      const h2 = hash2(i * 4 + 2, seed);
      const h3 = hash2(i * 4 + 3, seed);

      const scale = 0.34 + 0.32 * unit(h0);
      const angle = 2 * PI * unit(h1);

      // Fixed points on a disc, not over the square: a map whose fixed point is
      // in a corner pulls the whole attractor into that corner and off frame.
      const rad = 0.75 * Math.sqrt(unit(h2));
      const arg = 2 * PI * unit(h3);
      const fx = rad * Math.cos(arg);
      const fy = rad * Math.sin(arg);

      const t = similarity(scale, angle, 0, 0);
      // t = f - M f, so the map's fixed point lands on (fx,fy). The attractor
      // always lies in the convex hull of the fixed points, which is what keeps
      // a seeded rig on screen.
      t.tx = fx - (t.m[0] * fx + t.m[1] * fy);
      t.ty = fy - (t.m[2] * fx + t.m[3] * fy);
      t.weight = 1;
      t.hue = 0.5 * signedHash(hash2(i + 977, seed)) * 0.08;
      set.taps[i] = t;
    }
    set.count = n;
    return fitToFrame(set, 1.55);
  } else {
    // Mirror, Julia, Mandelbrot, Globe: one identity tap. The camera supplies
    // everything. The escape rigs never sample it, but are handed a valid
    // one-tap set so everything downstream can assume count >= 1.
    set.taps[0] = makeTap();
    set.count = 1;
  }

  for (let i = set.count; i < MAX_TAPS; i += 1) set.taps[i] = makeTap();
  return set;
}

/**
 * Invert an affine tap. Returns null when the map is singular — which the fern
 * really is, its first map having determinant zero because the stem of a fern
 * is a line and not an area.
 *
 * Not `det === 0`: a determinant of 1e-9 inverts to entries around 1e9, the
 * sample coordinate leaves the frame by nine orders of magnitude, and what comes
 * back is the edge texel smeared across the picture.
 */
function inverse(tap) {
  const det = tap.m[0] * tap.m[3] - tap.m[1] * tap.m[2];
  if (Math.abs(det) < 1e-6) return null;

  const inv = 1 / det;
  const m = [tap.m[3] * inv, -tap.m[1] * inv, -tap.m[2] * inv, tap.m[0] * inv];
  return {
    m,
    tx: -(m[0] * tap.tx + m[1] * tap.ty),
    ty: -(m[2] * tap.tx + m[3] * tap.ty),
    weight: tap.weight,
    hue: tap.hue,
  };
}

/**
 * The largest singular value across the set, in closed form.
 *
 * Not the determinant: that is the area factor, and a map can preserve area
 * while stretching one axis by ten, which is an expansion the loop will find
 * even though the determinant calls it neutral.
 */
function contractivity(set) {
  let worst = 0;
  for (let i = 0; i < set.count; i += 1) {
    const [a, b, c, d] = set.taps[i].m;
    const e = (a * a + b * b + c * c + d * d) * 0.5;
    const f = (a * a + b * b - c * c - d * d) * 0.5;
    const g = a * c + b * d;
    const s = Math.sqrt(e + Math.sqrt(f * f + g * g));
    if (s > worst) worst = s;
  }
  return worst;
}

/**
 * Fold the camera in, BEFORE the taps — `tap after camera` — because it is a
 * move of the lens and the glass is downstream of the lens. Composing the other
 * way round is a move of the screen, which looks it.
 */
function withCamera(set, zoom, rotate, panX, panY) {
  const camera = similarity(zoom, rotate, panX, panY);
  const out = { count: set.count, taps: set.taps.slice() };
  for (let i = 0; i < set.count; i += 1) out.taps[i] = compose(set.taps[i], camera);
  return out;
}

//===========================================================================
// Loop.cpp — the rig's clock and its stability arithmetic.
//===========================================================================

/**
 * Move the operator's hands, at `phase` turns of the drift clock.
 *
 * **This is what stops a rig going still.** A loop whose parameters are constant
 * is a contraction mapping with constant coefficients, and Banach's theorem then
 * says there is exactly one attracting fixed point: the picture converges on the
 * attractor, the attractor maps to itself, and nothing moves again. Endless zoom
 * does not rescue it either — a self-similar attractor magnified by its own
 * ratio is the same attractor.
 *
 * The camera depths are scaled by the rig's COMPLIANCE, `1 - c`. A camera nudge
 * `t` displaces an attractor by about `t / ( 1 - c )`, and that factor spans two
 * orders of magnitude here: Sierpinski contracts by 2 and shrugs off anything
 * small, while a mirror rig at 0.98 would be thrown off the screen by the same
 * shove. The injection, the Julia constant and the escape centre are not scaled,
 * because none of them is inside the geometric loop.
 *
 * The rates are mutually irrational, so the combination has no period.
 */
function applyDrift(p, phase, contractivity) {
  if (p.drift <= 0) return;

  const tau = 6.283185307179586;
  const d = p.drift;

  const loop = contractivity * Math.abs(p.zoom);
  const compliance = 1 - (loop > 0.98 ? 0.98 : loop);

  p.zoom += d * compliance * 0.100 * Math.sin(tau * phase);
  p.rotate += d * compliance * 0.800 * Math.sin(tau * phase * 0.732);
  p.panX += d * compliance * 0.300 * Math.sin(tau * phase * 0.517);
  p.panY += d * compliance * 0.300 * Math.sin(tau * phase * 0.313 + tau * 0.25);

  p.hueRotate += d * 0.0015 * Math.sin(tau * phase * 0.211);

  p.injectX += d * 0.45 * Math.sin(tau * phase * 0.421);
  p.injectY += d * 0.45 * Math.sin(tau * phase * 0.277 + tau * 0.25);

  p.juliaX += d * 0.12 * Math.sin(tau * phase * 0.611);
  p.juliaY += d * 0.12 * Math.sin(tau * phase * 0.389 + tau * 0.25);

  p.escapeX += d * 0.25 * Math.sin(tau * phase * 0.157);
  p.escapeY += d * 0.25 * Math.sin(tau * phase * 0.113 + tau * 0.25);
}

/**
 * Worst-case AMPLITUDE gain: `gain x sum of tap weights`, plus persistence.
 *
 * Deliberately not the same question as contractivity(), which asks whether the
 * picture converges on a SHAPE. This asks whether it survives. The taps sum, so
 * the worst case is a pixel where every tap lands on lit content at once; decay
 * adds because persistence is a parallel route into the same summing node. The
 * camera's zoom does not appear — it moves light around, it does not amplify it.
 */
function loopGain(set, gain, decay) {
  let weightSum = 0;
  for (let i = 0; i < set.count; i += 1) weightSum += set.taps[i].weight;
  return gain * weightSum + decay;
}

/// The glass alone. Expensive for seeded rigs, and drift never changes it.
function glassFor(p) {
  return taps(p.rig, p.tapCount, p.seed);
}

/**
 * One FIELD's loop state. Called once per field, not once per frame: drift makes
 * the hands a function of time, so hoisting it would make the picture depend on
 * the host's frame rate — the one thing this plugin promises it does not.
 */
function resolve(glass, p, driftPhase) {
  const c = contractivity(glass);
  applyDrift(p, driftPhase, c);

  const gain = loopGain(glass, p.gain, p.decay);
  const withCam = withCamera(glass, p.zoom, p.rotate, p.panX, p.panY);

  // Inverted here, once per frame, rather than in the shader once per pixel. A
  // tap that cannot be inverted is DROPPED rather than divided by: a NaN in a
  // buffer that feeds itself is permanent.
  const inverseTaps = [];
  let weightSum = 0;
  let dropped = 0;

  for (let i = 0; i < withCam.count; i += 1) {
    const inv = inverse(withCam.taps[i]);
    if (inv === null) { dropped += 1; continue; }
    inverseTaps.push(inv);
    weightSum += withCam.taps[i].weight;
  }

  return {
    inverseTaps,
    dropped,
    loopGain: gain,
    weightSum: weightSum > 0 ? weightSum : 1,
    contractivity: c,
  };
}

/**
 * The rig's clock. Holds the fractional field left over between frames, so a
 * 60 Hz rig drawn at 50 fps runs 1,1,2,1,1,2 rather than dropping the remainder
 * and running slow.
 */
class Clock {
  constructor() { this.carry = 0; }

  advance(seconds, fieldRate) {
    if (!(seconds > 0) || !(fieldRate > 0)) return 0;

    this.carry += seconds * fieldRate;
    if (this.carry < 0) this.carry = 0;

    let fields = Math.floor(this.carry);
    this.carry -= fields;

    if (fields > MAX_FIELDS_PER_FRAME) {
      fields = MAX_FIELDS_PER_FRAME;
      // Drop the backlog rather than paying it off over the following frames:
      // paying it off is how one stall becomes a stutter.
      this.carry = 0;
    }
    return fields;
  }

  reset() { this.carry = 0; }
}

const MAX_FIELDS_PER_FRAME = 8;

//===========================================================================
// Presets — from source/Presets.h.
//===========================================================================

const PRESETS = {
  'Mirror Tunnel': { rig: 0, symmetry: 0, foldMirror: 0, zoom: 0.208, rotate: 0.699, panX: 0.5, panY: 0.5, focus: 0.085, lens: 0.5, vignette: 0.08, gain: 0.6, pedestal: 0.5, gamma: 0.5, hueRotate: 0.658, saturation: 0.55, clip: 0.786, noise: 0, decay: 0.05, inject: 3, injectLevel: 0.55, injectSize: 0.72, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.5, driftRate: 0.523 },
  'Sierpinski': { rig: 1, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0.088, lens: 0.5, vignette: 0.1, gain: 0.7, pedestal: 0.5, gamma: 0.5, hueRotate: 0.64, saturation: 0.5, clip: 0.857, noise: 0.1, decay: 0, inject: 4, injectLevel: 0.26, injectSize: 1, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.5, driftRate: 0.435 },
  'Koch Snowflake': { rig: 2, symmetry: 0.18, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0.085, lens: 0.5, vignette: 0.08, gain: 0.812, pedestal: 0.5, gamma: 0.5, hueRotate: 0.6, saturation: 0.5, clip: 0.857, noise: 0.1, decay: 0.153, inject: 4, injectLevel: 0.14, injectSize: 1, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.5, driftRate: 0.435 },
  'Dragon': { rig: 3, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.699, panX: 0.5, panY: 0.5, focus: 0.091, lens: 0.5, vignette: 0.12, gain: 0.68, pedestal: 0.5, gamma: 0.5, hueRotate: 0.64, saturation: 0.5, clip: 0.857, noise: 0.1, decay: 0, inject: 4, injectLevel: 0.26, injectSize: 1, palette: 2, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.95, driftRate: 0.435 },
  'Barnsley Fern': { rig: 4, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0.085, lens: 0.5, vignette: 0, gain: 0.56, pedestal: 0.5, gamma: 0.5, hueRotate: 0.56, saturation: 0.45, clip: 0.5, noise: 0.12, decay: 0, inject: 4, injectLevel: 0.2, injectSize: 1, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 1, driftRate: 0.52 },
  'Kaleidoscope': { rig: 5, taps: 0.6, symmetry: 0, foldMirror: 0, zoom: 0.329, rotate: 0.64, panX: 0.5, panY: 0.5, focus: 0.148, lens: 0.5, vignette: 0.3, gain: 0.625, pedestal: 0.5, gamma: 0.5, hueRotate: 0.68, saturation: 0.6, clip: 0.786, noise: 0.02, decay: 0.153, inject: 1, injectLevel: 0.78, injectSize: 0.42, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.45, driftRate: 0.523 },
  'Seeded Rig': { rig: 6, taps: 0.3, seed: 0.402, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0.091, lens: 0.5, vignette: 0.2, gain: 0.594, pedestal: 0.5, gamma: 0.5, hueRotate: 0.62, saturation: 0.5, clip: 0.857, noise: 0.1, decay: 0, inject: 4, injectLevel: 0.14, injectSize: 1, palette: 4, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.55, driftRate: 0.435 },
  'Julia Drift': { rig: 7, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0, lens: 0.5, vignette: 0.1, gain: 0, pedestal: 0.5, gamma: 0.5, hueRotate: 0.62, saturation: 0.5, clip: 1, noise: 0, decay: 0.55, inject: 5, injectLevel: 0.869, injectSize: 1, palette: 3, sphere: 0, tilt: 0.5, spin: 0.5, iterations: 0.571, escapeZoom: 0, precision: 0, drift: 0.6, driftRate: 0.523 },
  'Mandelbrot Dive': { rig: 8, symmetry: 0, foldMirror: 0, zoom: 0.5, rotate: 0.5, panX: 0.5, panY: 0.5, focus: 0, lens: 0.5, vignette: 0.1, gain: 0, pedestal: 0.5, gamma: 0.5, hueRotate: 0.56, saturation: 0.5, clip: 1, noise: 0, decay: 0.2, inject: 5, injectLevel: 0.869, injectSize: 1, palette: 2, sphere: 0, tilt: 0.5, spin: 0.5, iterations: 0.85, escapeZoom: 0.462, precision: 1, drift: 1, driftRate: 0.52 },
  'Globe': { rig: 9, symmetry: 0, foldMirror: 0, zoom: 0.208, rotate: 0.699, panX: 0.5, panY: 0.5, focus: 0.085, lens: 0.5, vignette: 0.2, gain: 0.6, pedestal: 0.5, gamma: 0.5, hueRotate: 0.658, saturation: 0.55, clip: 0.786, noise: 0, decay: 0.05, inject: 3, injectLevel: 0.55, injectSize: 0.72, palette: 1, sphere: 1, tilt: 0.611, spin: 0.612, drift: 0.4, driftRate: 0.435 },
  'Cell Structures': { rig: 0, symmetry: 0, foldMirror: 0, zoom: 0.3, rotate: 0.699, panX: 0.5, panY: 0.5, focus: 0.148, lens: 0.5, vignette: 0.1, gain: 0.66, pedestal: 0.5, gamma: 0.5, hueRotate: 0.7, saturation: 0.7, clip: 0.5, noise: 0.25, decay: 0, inject: 0, injectLevel: 0, palette: 0, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.2, driftRate: 0.52 },
  'Galaxy': { rig: 0, symmetry: 0, foldMirror: 0, zoom: 0.24, rotate: 0.76, panX: 0.5, panY: 0.5, focus: 0.112, lens: 0.46, vignette: 0.18, gain: 0.62, pedestal: 0.5, gamma: 0.5, hueRotate: 0.69, saturation: 0.62, clip: 0.786, noise: 0.03, decay: 0.1, inject: 1, injectLevel: 0.608, injectSize: 0.3, palette: 2, sphere: 0, tilt: 0.5, spin: 0.5, drift: 0.5, driftRate: 0.523 },
};

//===========================================================================
// The renderer.
//
// Three passes and a frame store, exactly as Escapement.cpp runs them:
//
//   1 iterator bank   only when something is going to read it
//   2 loop            once per FIELD, not once per rendered frame
//   3 display         the store to the canvas
//===========================================================================

const EFFECT_DEFINE = '#define ESCAPEMENT_EFFECT 1\n';

/** Insert defines after the `#version` line, exactly as Escapement.cpp does. */
function withDefines(source, defines) {
  if (!defines) return source;
  const nl = source.indexOf('\n');
  return nl < 0 ? source : source.slice(0, nl + 1) + defines + source.slice(nl + 1);
}

class EscapementRenderer {
  constructor(gl) {
    this.gl = gl;

    this.programs = {
      iterator: new Program(gl, FULLSCREEN_VERTEX_SHADER, ITERATOR_FRAGMENT_SHADER, 'iterator'),
      source: {
        loop: new Program(gl, FULLSCREEN_VERTEX_SHADER, LOOP_FRAGMENT_SHADER, 'loop'),
        display: new Program(gl, FULLSCREEN_VERTEX_SHADER, DISPLAY_FRAGMENT_SHADER, 'display'),
      },
      effect: {
        loop: new Program(gl, FULLSCREEN_VERTEX_SHADER, withDefines(LOOP_FRAGMENT_SHADER, EFFECT_DEFINE), 'loop/effect'),
        display: new Program(gl, FULLSCREEN_VERTEX_SHADER, withDefines(DISPLAY_FRAGMENT_SHADER, EFFECT_DEFINE), 'display/effect'),
      },
    };

    // The plugins' vertex shader is attributeless and builds its quad from
    // gl_VertexID, but a core profile still refuses to draw with no vertex
    // array bound. This is that array: created empty, bound to draw, never
    // filled.
    this.emptyVAO = gl.createVertexArray();

    // The frame store: a ping-pong pair, RGBA16F, mipmapped.
    //
    // Float because the signal in the loop is a SIGNAL and not a colour — the
    // proc amp puts it above 1 and a negative pedestal puts it below 0, and
    // eight-bit fixed point would clip at both ends every field, which is a
    // hard knee applied in the wrong place with no control over it.
    //
    // Mipmapped because Focus is a textureLod bias on the tap fetches: a soft
    // lens INSIDE the loop, which is what stops a hot rig collapsing into
    // single-pixel noise.
    this.store = [
      new PassBuffer(gl, { filter: 'linear', mip: true }),
      new PassBuffer(gl, { filter: 'linear', mip: true }),
    ];
    this.front = 0;
    this.bank = new PassBuffer(gl, { filter: 'linear' });

    this.clock = new Clock();
    this.lastTime = null;
    this.fieldCounter = 0;
    this.spinPhase = 0;
    this.driftPhase = 0;
    this.lastVariant = null;
  }

  /** Clear both halves of the store. A resize, a restart, or a fresh rig. */
  clearStore() {
    for (const buffer of this.store) buffer.clearTo(0, 0, 0, 1);
    this.clock.reset();
    this.fieldCounter = 0;
    this.generateMips();
  }

  generateMips() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.store[this.front].texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The host's 0..1 parameters to engineering units — Escapement::CurrentLoop. */
  loopFrom(params, isEffect) {
    const rig = params.option('rig');
    const sync = params.option('sync');

    let speed = speedFromParam(params.get('speed'));
    // No host tempo in a browser page, so the transport's own 120 BPM stands in
    // — which is the tempo the plugin falls back to when a host reports none.
    const bpm = 120;
    if (sync === 3) speed = 0;
    else if (sync === 1) speed *= Math.max(0.1, bpm / 120);
    else if (sync === 2) speed *= Math.max(0.1, bpm / 480);

    let inject = params.option('inject');
    // The source has no clip, so Inject::Clip would be an empty texture. Fall
    // back rather than showing black.
    if (!isEffect && inject === 6) inject = 1;

    let sphere = sphereFromParam(params.get('sphere'));
    // The Globe rig IS the rescan, so picking it turns the sphere on rather
    // than leaving the operator to find a second control the rig's name already
    // promised.
    if (rig === RIG.Globe && sphere <= 0) sphere = 1;

    return {
      rig,
      tapCount: tapsFromParam(params.get('taps')),
      seed: seedFromParam(params.get('seed')),
      symmetry: symmetryFromParam(params.get('symmetry')),
      foldMirror: params.get('foldMirror') >= 0.5,
      fieldRate: fieldRateFromParam(params.get('fieldRate')),

      // Zoom is a MULTIPLIER, so Speed scales its distance from 1 rather than
      // the number itself: doubling the speed of a zoom of 1.02 is 1.04.
      zoom: 1 + (zoomFromParam(params.get('zoom')) - 1) * speed,
      rotate: rotateFromParam(params.get('rotate')) * speed,
      panX: panFromParam(params.get('panX')) * speed,
      panY: panFromParam(params.get('panY')) * speed,

      drift: driftFromParam(params.get('drift')),
      driftRate: driftRateFromParam(params.get('driftRate')),

      focus: focusFromParam(params.get('focus')),
      lens: lensFromParam(params.get('lens')),
      vignette: clamp01(params.get('vignette')),

      gain: gainFromParam(params.get('gain')),
      pedestal: pedestalFromParam(params.get('pedestal')),
      gamma: gammaFromParam(params.get('gamma')),
      hueRotate: hueRotateFromParam(params.get('hueRotate')),
      saturation: saturationFromParam(params.get('saturation')),
      clip: clipFromParam(params.get('clip')),
      noise: noiseFromParam(params.get('noise')),
      decay: decayFromParam(params.get('decay')),

      inject,
      injectLevel: injectLevelFromParam(params.get('injectLevel')),
      injectSize: injectSizeFromParam(params.get('injectSize')),
      injectX: injectPosFromParam(params.get('injectX')),
      injectY: injectPosFromParam(params.get('injectY')),

      iterations: iterationsFromParam(params.get('iterations')),
      juliaX: juliaFromParam(params.get('juliaX')),
      juliaY: juliaFromParam(params.get('juliaY')),
      escapeZoom: escapeZoomFromParam(params.get('escapeZoom')),
      escapeX: escapeCentreFromParam(params.get('escapeX')),
      escapeY: escapeCentreFromParam(params.get('escapeY')),
      precision: params.option('precision'),

      sphere,
      tilt: tiltFromParam(params.get('tilt')),
      spin: spinFromParam(params.get('spin')),
      light: clamp01(params.get('light')),

      palette: params.option('palette'),
      paletteShift: paletteShiftFromParam(params.get('paletteShift')),
      opacity: clamp01(params.get('opacity')),
      maskMode: params.option('maskMode'),
      mix: clamp01(params.get('mix')),
    };
  }

  runIterator(p, width, height) {
    const gl = this.gl;
    this.bank.ensure(width, height, gl.RGBA16F).bind();

    const program = this.programs.iterator.use();
    const aspect = height > 0 ? width / height : 1;

    program.set('Resolution', width, height);
    program.set('Aspect', aspect);
    program.setInt('Iterations', p.iterations);
    program.setInt('Mode', p.rig === RIG.Mandelbrot ? 1 : 0);
    program.set('JuliaC', p.juliaX, p.juliaY);

    // A deep zoom has to land somewhere worth looking at. At 1:1 the base makes
    // no difference — the whole set is on screen either way — and at 1e6 it is
    // the difference between structure and a flat field.
    const DEEP_X = -0.743643887037151;
    const DEEP_Y = 0.131825904205330;

    const scale = 1.4 / p.escapeZoom;
    const centreX = (p.rig === RIG.Mandelbrot ? DEEP_X : 0) + p.escapeX * scale;
    const centreY = (p.rig === RIG.Mandelbrot ? DEEP_Y : 0) + p.escapeY * scale;

    // Split high/low so one pair of uniforms serves both precisions. JS numbers
    // are doubles, and Math.fround is the exact float32 rounding the C++ gets
    // from its float cast — without it the "low" half would carry the error of
    // a rounding that never happened.
    const cxHi = Math.fround(centreX);
    const cyHi = Math.fround(centreY);
    const sHi = Math.fround(scale);

    program.set('CentreX', cxHi, centreX - cxHi);
    program.set('CentreY', cyHi, centreY - cyHi);
    program.set('Scale', sHi, scale - sHi);
    program.setInt('Extended', p.precision === 1 ? 1 : 0);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  runField(p, state, fieldIndex, isEffect, input) {
    const gl = this.gl;
    const back = this.store[1 - this.front];
    const prev = this.store[this.front];

    back.bind();

    const program = (isEffect ? this.programs.effect : this.programs.source).loop.use();
    const aspect = back.height > 0 ? back.width / back.height : 1;

    bindTexture(gl, 0, prev.texture);
    program.setSampler('Prev', 0);

    if (this.bank.texture) {
      bindTexture(gl, 1, this.bank.texture);
      program.setSampler('Bank', 1);
    }

    if (isEffect) {
      bindTexture(gl, 2, input.texture);
      program.setSampler('ClipTexture', 2);
      // The kit hands over a texture the picture exactly fills, so MaxUV is the
      // whole of it. In Resolume it is whatever GetMaxGLTexCoords reports.
      program.set('MaxUV', 1, 1);
    }

    program.set('Resolution', back.width, back.height);
    program.set('Aspect', aspect);

    // Two flat vec4 arrays rather than an array of structs: std140's rules for
    // arrays of structs are a trap nobody needs, and two flat arrays cannot be
    // laid out wrongly.
    const tapM = new Float32Array(MAX_TAPS * 4);
    const tapT = new Float32Array(MAX_TAPS * 4);
    const count = Math.min(state.inverseTaps.length, MAX_TAPS);

    for (let i = 0; i < count; i += 1) {
      const t = state.inverseTaps[i];
      tapM.set(t.m, i * 4);
      tapT[i * 4 + 0] = t.tx;
      tapT[i * 4 + 1] = t.ty;
      tapT[i * 4 + 2] = t.weight;
      tapT[i * 4 + 3] = t.hue;
    }

    // components: 4. glUniform1fv on a vec4 array is rejected as a size
    // mismatch and the uniform keeps whatever it held before — which here is
    // every tap at identity, i.e. a rig that looks like its gain is too low.
    program.setArray('TapM', tapM, 4);
    program.setArray('TapT', tapT, 4);

    program.setInt('TapCount', count);
    program.set('WeightSum', state.weightSum);

    program.setInt('Symmetry', p.symmetry);
    program.setInt('FoldMirror', p.foldMirror ? 1 : 0);

    // Frame-relative to texels, here, where the raster size is known.
    program.set('Focus', focusLod(p.focus, back.width, back.height));
    program.set('Lens', p.lens);
    program.set('Vignette', p.vignette);

    program.set('Gain', p.gain);
    program.set('Pedestal', p.pedestal);
    program.set('Gamma', p.gamma);
    program.set('HueRot', p.hueRotate);
    program.set('Saturation', p.saturation);
    program.set('ClipLevel', p.clip);
    program.set('Noise', p.noise);
    program.set('Decay', p.decay);

    program.setInt('InjectMode', p.inject);
    program.set('InjectLevel', p.injectLevel);
    program.set('InjectSize', p.injectSize);
    program.set('InjectPos', p.injectX, p.injectY);

    program.setInt('FieldIndex', fieldIndex);

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.front = 1 - this.front;
    this.generateMips();
  }

  render({ input, params, width, height, time, variant }) {
    const gl = this.gl;
    const isEffect = variant === 'effect';
    const p = this.loopFrom(params, isEffect);

    gl.bindVertexArray(this.emptyVAO);

    //---------------------------------------------------------------------
    // The store. A resize clears it; nothing reachable from a knob does.
    //---------------------------------------------------------------------
    const resized = this.store[0].width !== width || this.store[0].height !== height;
    for (const buffer of this.store) buffer.ensure(width, height, gl.RGBA16F);

    // Switching bundle rebuilds the rig from scratch, because the effect's loop
    // can carry the clip and the source's cannot — keeping the store across the
    // switch would leave the other bundle's picture sitting in it.
    const switched = variant !== this.lastVariant;
    this.lastVariant = variant;

    //---------------------------------------------------------------------
    // How many trips round the loop this frame is worth.
    //
    // From ELAPSED time, not from the frame having been drawn. A redraw caused
    // by moving a slider while paused therefore runs no fields at all and the
    // picture holds still — which is what the plugin does, and it is the only
    // way a stateful demo can have a working pause.
    //---------------------------------------------------------------------
    let elapsed = this.lastTime === null ? 0 : time - this.lastTime;

    // Time going backwards is Restart, or a scrub. A rig cannot be rewound, so
    // it is switched off and on again.
    const rewound = elapsed < 0;
    this.lastTime = time;

    if (resized || switched || rewound) {
      this.clearStore();
      elapsed = 0;
    }

    let fields = this.clock.advance(elapsed, p.fieldRate);

    // The first frame after a clear has no elapsed time behind it and would run
    // no fields at all, leaving one black frame on screen. A rig that has been
    // switched on has still had one field through it.
    if (fields === 0 && (resized || switched || rewound)) fields = 1;

    // The glass, once. Drift never changes which rig this is.
    const glass = glassFor(p);

    // Seconds of RIG time per field. Everything animated runs on this rather
    // than on the host's clock, so a rendered frame stays a pure function of
    // how many times the loop has been round.
    const perField = p.fieldRate > 0 ? 1 / p.fieldRate : 0;

    this.spinPhase += p.spin * perField * fields;
    this.spinPhase -= Math.floor(this.spinPhase);

    const needsBank = !rigUsesTaps(p.rig) || p.inject === 5;

    //---------------------------------------------------------------------
    // The loop, one field at a time, with the hands moving between them.
    //---------------------------------------------------------------------
    let state = null;
    for (let i = 0; i < fields; i += 1) {
      const field = { ...p };

      let phase = this.driftPhase + p.driftRate * perField * (i + 1);
      phase -= Math.floor(phase);

      state = resolve(glass, field, phase);

      // The bank is inside the loop too: its picture is a function of the
      // drifted Julia constant.
      if (needsBank) this.runIterator(field, width, height);

      this.runField(field, state, this.fieldCounter + i, isEffect, input);
    }
    this.fieldCounter += fields;

    this.driftPhase += p.driftRate * perField * fields;
    this.driftPhase -= Math.floor(this.driftPhase);

    //---------------------------------------------------------------------
    // Display. Back to the canvas and the canvas's viewport, by hand: the
    // store's passes set their own and nothing restores them.
    //---------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    const program = (isEffect ? this.programs.effect : this.programs.source).display.use();
    const aspect = height > 0 ? width / height : 1;

    bindTexture(gl, 0, this.store[this.front].texture);
    program.setSampler('Store', 0);

    if (isEffect) {
      bindTexture(gl, 1, input.texture);
      program.setSampler('ClipTexture', 1);
      program.set('MaxUV', 1, 1);
      program.setInt('MaskMode', p.maskMode);
      program.set('Blend', p.mix);
    }

    program.set('Resolution', width, height);
    program.set('Aspect', aspect);
    program.setInt('PaletteMode', p.palette);
    program.set('PaletteShift', p.paletteShift);
    program.set('Opacity', p.opacity);

    // Bloom rides on the vignette control rather than having one of its own:
    // halation is a property of the screen and the lens, and an operator who
    // has already said how much its lens flares should not be asked twice.
    program.set('Bloom', p.vignette * 0.5);

    program.set('Sphere', p.sphere);
    program.set('Tilt', p.tilt);
    program.set('SpinPhase', this.spinPhase);
    program.set('Light', p.light);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
  }
}

//===========================================================================
// The page.
//===========================================================================

const pct = (v) => `${Math.round(clamp01(v) * 100)}%`;

mountDemo({
  name: 'Escapement',
  pluginId: 'ES01',
  tagline: 'A video feedback rig — and the fractals it settles into.',
  repo: 'https://github.com/stoatworks-labs/escapement',
  page: 'https://stoatworks-labs.com/software/escapement/',
  needFloat: true,
  showBackdrop: true,
  presets: PRESETS,

  variants: {
    label: 'Plugin',
    default: 'source',
    options: [
      { id: 'source', name: 'Escapement', hint: 'The source: a rig with nothing in front of the lens but what it makes itself.' },
      { id: 'effect', name: 'Escapement Feed', hint: 'The effect: the clip in front of the lens, injected INTO the loop, so the fractal is built out of the footage.' },
    ],
  },

  sources: ['scene', 'grid', 'bars', 'ramp', 'spot', 'detail'],

  differences: [
    'This page is STATEFUL and no other demo in this kit is. The picture is the whole history of the loop, so a frame cannot be rendered on its own: the loop advances on elapsed time, which means Step advances the rig by one field rather than drawing "the frame at time t", and moving a slider while paused re-runs only the display pass. Restart switches the rig off and on again, because a feedback loop cannot be rewound.',
    'The frame store is RGBA16F here and in the plugin, but the browser reaches it through EXT_color_buffer_float rather than desktop GL. A machine without that extension gets an error rather than a quietly quantised picture — 8 bits mid-loop would clip the signal at both ends every field, which is a hard knee in the wrong place.',
    'Beat and Bar lock to a 120 BPM transport generated in this page, which is the tempo the plugin falls back to when a host reports none. Resolume would supply its own. Manual stops the camera entirely, exactly as in the host.',
    'The clip picker only does anything in Escapement Feed, and only when Inject is set to Clip — the source has no input at all (SetMinInputs is 0), and in the effect the clip is an injection INTO the loop rather than a backdrop behind it.',
    'Preset is an option parameter in the plugin, with Custom as element 0 and a slider edit dropping back to it. Here the same twelve presets are in the panel header instead, from the plugin\'s own table.',
    'Deep zoom may be COARSER here than in the plugin, and there is no way to ask a browser not to. The Extended precision setting gets its extra bits from Dekker\'s split, which is only a no-op if the compiler is forbidden to reassociate it — the plugin forbids it with GLSL\'s `precise` keyword, and GLSL ES 3.00 does not have that keyword at all, so the port strips it. A browser that reassociates will render a deep zoom in visible blocks where the plugin renders detail. Everything at ordinary magnifications is unaffected.',
  ],

  params: [
    //---- Rig --------------------------------------------------------------
    {
      id: 'rig', name: 'Rig', type: 'option', default: 0, group: 'Rig',
      elements: RIG_NAMES,
      hint: 'What the light path is made of. The first seven are tap sets, and their fractal is the attractor of those taps — nothing evaluates it. Julia and Mandelbrot run the iterator bank instead.',
    },
    {
      id: 'taps', name: 'Taps', type: 'standard', default: 0.30, group: 'Rig',
      display: (v) => `${tapsFromParam(v)}`,
      hint: 'How many paths from the screen back into the camera. Only the rigs with a choosable number honour it: Sierpinski has three maps whatever this says.',
    },
    {
      id: 'seed', name: 'Seed', type: 'standard', default: 0.402, group: 'Rig',
      display: (v) => `${seedFromParam(v)}`,
      hint: 'A rig built from a number. Every seed is framed, because a seeded attractor\'s bounds are measured by playing the chaos game rather than assumed — seed 4021 settles inside 1.45 frame units and seed 7 spreads across 2.68.',
    },
    {
      id: 'symmetry', name: 'Symmetry', type: 'standard', default: 0.0, group: 'Rig',
      display: (v) => `${symmetryFromParam(v)}-fold`,
      hint: 'A mirror wedge in front of the lens. This is how the Koch snowflake is made: four taps give the Koch CURVE, and a three-fold fold puts it on all three sides of a triangle — for one coordinate wrap instead of the eight extra taps the twelve-map snowflake system would need.',
    },
    {
      id: 'foldMirror', name: 'Mirror Wedge', type: 'boolean', default: 0, group: 'Rig',
      hint: 'A real wedge is made of mirrors, so alternate sectors arrive reversed. Rotational-only is what builds the snowflake; mirrored is what looks like a kaleidoscope.',
    },
    {
      id: 'fieldRate', name: 'Field Rate', type: 'standard', default: 0.782, group: 'Rig',
      display: (v) => `${fieldRateFromParam(v).toFixed(0)} Hz`,
      hint: 'The rig\'s own clock, not the host\'s frame rate. A real rig goes round the loop at its screen\'s field rate whatever is filming it, and the number of trips IS the number of times the taps have been applied.',
    },

    //---- Camera -----------------------------------------------------------
    {
      id: 'zoom', name: 'Zoom', type: 'standard', default: 0.208, group: 'Camera',
      display: (v) => `${zoomFromParam(v).toFixed(4)}×`,
      hint: 'Per field, and this is the endless zoom: a multiplier applied to the picture, never a coordinate anyone stores, so there is nothing to overflow. BELOW 1 gives you the tunnel — a tunnel is made of the screen\'s own edge re-photographed, so the camera has to be able to see past the frame.',
    },
    {
      id: 'rotate', name: 'Rotate', type: 'standard', default: 0.699, group: 'Camera',
      display: (v) => `${(rotateFromParam(v) * 57.2958).toFixed(2)}°/field`,
      hint: 'Zoom and rotation together are what turn a tunnel into a spiral.',
    },
    { id: 'panX', name: 'Pan X', type: 'standard', default: 0.5, group: 'Camera', display: (v) => panFromParam(v).toFixed(4) },
    { id: 'panY', name: 'Pan Y', type: 'standard', default: 0.5, group: 'Camera', display: (v) => panFromParam(v).toFixed(4) },
    {
      id: 'sync', name: 'Sync', type: 'option', default: 0, group: 'Camera',
      elements: SYNC_NAMES,
      hint: 'Where the camera\'s motion rate comes from. Manual parks the camera entirely.',
    },
    {
      id: 'speed', name: 'Speed', type: 'standard', default: 0.5, group: 'Camera',
      display: (v) => `${speedFromParam(v).toFixed(2)}×`,
      hint: 'Multiplies the camera\'s moves and nothing else — the operator walking faster, not the rig running at a different field rate. On Zoom it scales the distance from 1, so twice the speed of 1.02 is 1.04.',
    },
    {
      id: 'focus', name: 'Focus', type: 'standard', default: 0.085, group: 'Camera',
      display: (v) => `${(focusFromParam(v) * 100).toFixed(2)}% of frame`,
      hint: 'A fraction of the FRAME, not a number of texels, so the same preset is the same instrument at 720p and at 4K. A lens that is slightly soft, and it is INSIDE the loop — a low-pass filter inside a feedback loop is what stops a hot rig collapsing into single-pixel noise. Sharp and hot is static; soft and hot is what everyone recognises as video feedback.',
    },
    {
      id: 'lens', name: 'Lens', type: 'standard', default: 0.5, group: 'Camera',
      display: (v) => lensFromParam(v).toFixed(2),
      hint: 'Barrel below the centre, pincushion above. Applied inside the loop, so it compounds: a barrel distortion of a barrel distortion is most of why a real rig\'s spirals curl the way they do.',
    },
    {
      id: 'vignette', name: 'Vignette', type: 'standard', default: 0.08, group: 'Camera',
      display: pct,
      hint: 'The lens being dark at the edges, inside the loop — a stabiliser, not a look. It is what stops the picture filling the frame edge to edge and going flat. It also drives the display\'s bloom.',
    },

    {
      id: 'drift', name: 'Drift', type: 'standard', default: 0.45, group: 'Camera',
      display: pct,
      hint: 'The operator\'s hands, and the reason the rig does not go still. A loop with constant parameters is a contraction mapping, so it converges on its attractor and then stops for ever — endless zoom included, because a self-similar attractor magnified is the same attractor. Drift makes the operator a function of time. Scaled by how stiff the rig is: a camera nudge moves an attractor by about t/(1-c), which spans two orders of magnitude between Sierpinski and a mirror rig at 0.98.',
    },
    {
      id: 'driftRate', name: 'Drift Rate', type: 'standard', default: 0.52, group: 'Camera',
      display: (v) => `${driftRateFromParam(v).toFixed(3)} Hz`,
      hint: 'Slow. At the default the rig takes most of a minute to come back to where it was; the five modulations run at mutually irrational multiples of it, so the combination has no period at all and never repeats.',
    },

    //---- Loop -------------------------------------------------------------
    {
      id: 'gain', name: 'Gain', type: 'standard', default: 0.6, group: 'Loop',
      display: (v) => gainFromParam(v).toFixed(3),
      hint: 'The control the whole plugin is about. Below unity every trip round the loop is dimmer than the last and the picture decays into whatever is being injected; above it, the picture grows until the clip stage stops it, and the shape it grows into is the attractor. Unity is at exactly 0.625 of the travel.',
    },
    { id: 'pedestal', name: 'Pedestal', type: 'standard', default: 0.5, group: 'Loop', display: (v) => pedestalFromParam(v).toFixed(3) },
    { id: 'gamma', name: 'Gamma', type: 'standard', default: 0.5, group: 'Loop', display: (v) => gammaFromParam(v).toFixed(2) },
    {
      id: 'hueRotate', name: 'Hue Rotate', type: 'standard', default: 0.658, group: 'Loop',
      display: (v) => `${(hueRotateFromParam(v) * 360).toFixed(2)}°/field`,
      hint: 'Small, and the difference between a still picture and one that never repeats. A loop with no hue rotation converges to a fixed point and stops; one with a little cannot, because a fixed point would have to be a colour that is its own rotation.',
    },
    { id: 'saturation', name: 'Saturation', type: 'standard', default: 0.55, group: 'Loop', display: (v) => `${saturationFromParam(v).toFixed(2)}×` },
    {
      id: 'clip', name: 'Clip', type: 'standard', default: 0.786, group: 'Loop',
      display: (v) => clipFromParam(v).toFixed(2),
      hint: 'Where the amplifier stops being linear. A soft knee and not a clamp: a corner inside a feedback loop quantises the picture into flat plateaus with hard edges, and the soft knee is why a hot rig blooms rather than posterising.',
    },
    { id: 'noise', name: 'Noise', type: 'standard', default: 0.0, group: 'Loop', display: (v) => noiseFromParam(v).toFixed(4) },
    {
      id: 'decay', name: 'Decay', type: 'standard', default: 0.05, group: 'Loop',
      display: (v) => decayFromParam(v).toFixed(3),
      hint: 'Phosphor persistence and camera integration time, together. Distinct from Gain: gain is what goes round the geometric path and decay is what stays put, so decay smears in time without moving and gain moves without smearing. It ADDS to the loop gain.',
    },

    //---- Inject -----------------------------------------------------------
    {
      id: 'inject', name: 'Inject', type: 'option', default: 3, group: 'Inject',
      elements: INJECT_NAMES,
      hint: 'What is put in front of the lens. None is not black — it is whatever the sensor makes, amplified by the loop until it is the picture, which is a real mode of a real rig. Iterator feeds one fractal into another\'s loop.',
    },
    { id: 'injectLevel', name: 'Inject Level', type: 'standard', default: 0.55, group: 'Inject', display: (v) => injectLevelFromParam(v).toFixed(3) },
    { id: 'injectSize', name: 'Inject Size', type: 'standard', default: 0.72, group: 'Inject', display: (v) => injectSizeFromParam(v).toFixed(3) },
    { id: 'injectX', name: 'Inject X', type: 'standard', default: 0.5, group: 'Inject', display: (v) => injectPosFromParam(v).toFixed(2) },
    { id: 'injectY', name: 'Inject Y', type: 'standard', default: 0.5, group: 'Inject', display: (v) => injectPosFromParam(v).toFixed(2) },

    //---- Iterator ---------------------------------------------------------
    {
      id: 'iterations', name: 'Iterations', type: 'standard', default: 0.571, group: 'Iterator',
      display: (v) => `${iterationsFromParam(v)}`,
      hint: 'A starved iterator looks exactly like a precision failure — both render a flat field. When a deep zoom looks broken, raise this before suspecting the arithmetic.',
    },
    { id: 'juliaX', name: 'Julia X', type: 'standard', default: 0.36, group: 'Iterator', display: (v) => juliaFromParam(v).toFixed(3) },
    { id: 'juliaY', name: 'Julia Y', type: 'standard', default: 0.64, group: 'Iterator', display: (v) => juliaFromParam(v).toFixed(3) },
    {
      id: 'escapeZoom', name: 'Escape Zoom', type: 'standard', default: 0.0, group: 'Iterator',
      display: (v) => `${escapeZoomFromParam(v).toExponential(1)}×`,
      hint: 'The one place in the plugin with a precision limit, because it is the one place that holds a coordinate. Single runs out around 1e5; Extended uses double-float arithmetic to reach about 1e13 for roughly three times the cost.',
    },
    { id: 'escapeX', name: 'Escape X', type: 'standard', default: 0.5, group: 'Iterator', display: (v) => escapeCentreFromParam(v).toFixed(3) },
    { id: 'escapeY', name: 'Escape Y', type: 'standard', default: 0.5, group: 'Iterator', display: (v) => escapeCentreFromParam(v).toFixed(3) },
    {
      id: 'precision', name: 'Precision', type: 'option', default: 0, group: 'Iterator',
      elements: PRECISION_NAMES,
      hint: 'Two floats per component gives about 48 bits of mantissa where one gives 24. Every intermediate is marked `precise`, because Dekker\'s split is only a no-op if the compiler is allowed to reassociate it — and one that does leaves arithmetic which still runs, still differs from the single path, and silently has 24 bits.',
    },

    //---- Rescan -----------------------------------------------------------
    {
      id: 'sphere', name: 'Sphere', type: 'standard', default: 0.0, group: 'Rescan',
      display: pct,
      hint: 'The rescan: the rig\'s screen is a sphere and the camera is looking at it. The loop underneath keeps running, so the texture on the globe is alive rather than a still that spins. The Globe rig turns this on by itself.',
    },
    { id: 'tilt', name: 'Tilt', type: 'standard', default: 0.611, group: 'Rescan', display: (v) => `${(tiltFromParam(v) * 57.2958).toFixed(0)}°` },
    { id: 'spin', name: 'Spin', type: 'standard', default: 0.612, group: 'Rescan', display: (v) => `${spinFromParam(v).toFixed(3)} turns/s` },
    { id: 'light', name: 'Light', type: 'standard', default: 0.5, group: 'Rescan', display: pct },

    //---- Output -----------------------------------------------------------
    {
      id: 'palette', name: 'Palette', type: 'option', default: 0, group: 'Output',
      elements: PALETTE_NAMES,
      hint: 'Signal is the loop\'s own RGB, untouched — what the rig actually carries. The rest are lookups on the luma, taken rather than the maximum channel because the hue rotation means the channels take turns being the bright one.',
    },
    { id: 'paletteShift', name: 'Palette Shift', type: 'standard', default: 0.0, group: 'Output', display: pct },
    { id: 'opacity', name: 'Opacity', type: 'standard', default: 1.0, group: 'Output', display: pct },
    {
      id: 'maskMode', name: 'Mask Mode', type: 'option', default: 0, group: 'Output',
      elements: MASK_NAMES,
      hint: 'How the loop\'s picture meets the clip. Escapement Feed only — the source declares it too, so a composition moved between the two does not find its parameter list has shifted.',
    },
    { id: 'mix', name: 'Mix', type: 'standard', default: 1.0, group: 'Output', display: pct },
  ],

  createRenderer: (gl) => new EscapementRenderer(gl),
});
