/**
 * Vectrix — browser demo.
 *
 * An oscillator and a pedalboard driving the X/Y deflection of a CRT, in a
 * browser. The one idea, from `AGENTS.md`: **this models a route, not a look.**
 * Everything on the tube face is where a single beam was and how long it
 * lingered there, so a fast segment is dim and a turnaround blooms — and the
 * renderer gets that by depositing a fixed quantum of energy per sample interval
 * and spreading it over the distance the beam covered, never by computing 1/v.
 *
 * Two halves, and they are not equally faithful:
 *
 *   The renderer is the plugin's. The nine shader constants below are
 *   `kConstants`, `kFragmentHelpers`, `kScreenVertexBody`, `kTraceVertexBody`,
 *   `kTraceFragmentBody`, `kDecayFragmentBody`, `kBrightFragmentBody`,
 *   `kBlurFragmentBody` and `kGlassFragmentBody` from
 *   `source/render/shaders/`, copied across unedited, assembled the way
 *   `Prelude.cpp` assembles them, and run in the same six passes in the same
 *   order as `BeamGeometry::Render`. `demo/tools/check_shaders.py` compares them
 *   to the C++ character for character and `tools/verify.sh` runs it, because
 *   two copies of a shader is exactly the arrangement that drifts.
 *
 *   The signal chain is a port, and a partial one. The plugin has five sources
 *   and fourteen effects at audio rate in C++; this page carries the oscillator,
 *   the shapes, and the seven effects that visibly change the *figure* rather
 *   than its dynamics. What is missing is listed on the page and in
 *   `demo/README.md` rather than quietly approximated — a second implementation
 *   of a compressor that nobody checks would be worth less than an honest gap.
 *
 * The rule the port does keep, exactly: **phase is integrated, never computed
 * as `t * frequency`.** Get that wrong and the figure jumps to a different point
 * in its cycle every time the Frequency slider moves, here as in the plugin.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture } from './vendor/gl.js';

//---------------------------------------------------------------------------
// Shaders — verbatim from source/render/shaders/. Do not edit here.
//
// The backticks inside the comments are escaped, because a template literal has
// nowhere else to go; check_shaders.py decodes that one escape before comparing
// and rejects any other backslash, so the escape cannot hide a difference.
//---------------------------------------------------------------------------

const CONSTANTS = `#version 410 core

const float Extent      = 4.5;
const float Sqrt2Pi     = 2.50662827463100050;
const float InvSqrt2Pi  = 0.39894228040143268;
`;

const FRAGMENT_HELPERS = `
// The two-layer phosphor, as a table entry from Phosphor.cpp.
uniform vec3  FastColour;
uniform vec3  SlowColour;
uniform float PhosphorEfficiency;
uniform float PhosphorSaturation;

// The graticule. \`GraticuleLevel\` already carries both the operator's strength
// and the resolution fade -- see graticuleAt().
uniform float GraticuleLevel;
uniform float GraticuleDiv;   //beam units per division
uniform vec3  GraticuleColour;

//---------------------------------------------------------------------------
// The standard normal CDF.
//
// GLSL has no erf, so this is the usual tanh approximation, good to about 3e-4.
// The clamp is not tidiness. A driver computing tanh as (e^2x - 1)/(e^2x + 1)
// overflows to inf around x = 44 and then produces inf/inf = NaN -- long after
// the value has stopped changing, and for arguments a beam sitting still
// produces constantly. One NaN deposited into the phosphor buffer survives every
// ping-pong for the life of the plugin, because NaN * decay is NaN.
//---------------------------------------------------------------------------
float ncdf( float x )
{
	float t = clamp( 0.7978845608 * ( x + 0.044715 * x * x * x ), -8.0, 8.0 );
	return 0.5 * ( 1.0 + tanh( t ) );
}

//---------------------------------------------------------------------------
// Excitation -> light.
//
// A phosphor has a finite number of luminescent centres, so pumping it harder
// stops buying proportionally more light. l = e / (1 + e/S) is the simplest
// curve with that shape: at low e it is e to within e^2/S, so the dwell law
// stays exact everywhere it is visible, and it approaches S asymptotically
// rather than clipping.
//
// This is the *only* thing that bounds a stationary beam, and it is deliberately
// the tube that does it rather than a clamp. A clamp would put a hard edge on
// the spot at whatever level it was set to; a real over-driven spot blooms,
// because the centres near the middle saturate first and the ones further out
// are still climbing.
//---------------------------------------------------------------------------
float phosphorSaturate( float e )
{
	return e / ( 1.0 + e / max( PhosphorSaturation, 1e-6 ) );
}

vec3 phosphorEmission( vec2 excitation )
{
	vec2 e = max( excitation, vec2( 0.0 ) );
	return ( phosphorSaturate( e.x ) * FastColour
	       + phosphorSaturate( e.y ) * SlowColour ) * PhosphorEfficiency;
}

//---------------------------------------------------------------------------
// The graticule, as a signed-distance evaluation rather than geometry.
//
// 8 divisions by 10, minor ticks every 0.2 of a division on the two centre axes
// only -- which is where a real scope puts them, because they are for reading a
// timebase off the horizontal and an amplitude off the vertical, not for
// subdividing the whole face.
//
// \`face\` is in beam units and \`GraticuleDiv\` converts to divisions, so this
// function knows nothing about the output resolution and does not need to: the
// anti-aliasing comes from the local derivative, which is correct in whichever
// buffer the caller happens to be filling.
//
// The visibility fade is the exception and it arrives as a uniform. Once a
// division is worth fewer than about three output pixels the graticule stops
// being a graticule and becomes a moire generator, so it fades out -- but the
// bright pass runs at quarter resolution, and a fade computed from the local
// derivative would therefore fade the halo out two rungs before the sharp copy
// and leave a graticule casting no light. One number, computed once from the
// output size, keeps them agreeing.
//---------------------------------------------------------------------------
float graticuleAt( vec2 face )
{
	if( GraticuleLevel <= 0.0 )
		return 0.0;

	vec2 g = face / max( GraticuleDiv, 1e-6 );
	const vec2 halfSpan = vec2( 5.0, 4.0 );//10 wide by 8 tall

	//Per-axis, not the length of the pair: the two are independent here and
	//combining them would overstate the rate by root two on every diagonal.
	vec2 rate = max( fwidth( g ), vec2( 1e-6 ) );

	const float lineHalf = 0.015;//1.5% of a division
	const float tickHalf = 0.09; //how far a minor tick reaches off its axis

	vec2 toLine = abs( g - round( g ) );
	float major = max( 1.0 - smoothstep( lineHalf - rate.x, lineHalf + rate.x, toLine.x ),
	                   1.0 - smoothstep( lineHalf - rate.y, lineHalf + rate.y, toLine.y ) );

	vec2 toTick = abs( g - 0.2 * round( g * 5.0 ) );
	float tickX = ( 1.0 - smoothstep( lineHalf - rate.x, lineHalf + rate.x, toTick.x ) )
	            * ( 1.0 - smoothstep( tickHalf, tickHalf + rate.y, abs( g.y ) ) );
	float tickY = ( 1.0 - smoothstep( lineHalf - rate.y, lineHalf + rate.y, toTick.y ) )
	            * ( 1.0 - smoothstep( tickHalf, tickHalf + rate.x, abs( g.x ) ) );

	float ink = max( major, max( tickX, tickY ) );

	//Nothing outside the rectangle. The border lines themselves are at +-5 and
	//+-4, which round() already treats as division lines, so this only has to
	//cut off what lies beyond them.
	vec2 beyond = smoothstep( halfSpan + lineHalf - rate, halfSpan + lineHalf + rate, abs( g ) );
	ink *= ( 1.0 - beyond.x ) * ( 1.0 - beyond.y );

	return ink * GraticuleLevel;
}
`;

const SCREEN_VERTEX_BODY = `
layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;

out vec2 uv;

void main()
{
	gl_Position = vPosition;
	uv = vUV;
}
`;

const TRACE_VERTEX_BODY = `
layout( location = 0 ) in vec4 sampleA;//x, y volts; z grid; w dt seconds
layout( location = 1 ) in vec4 sampleB;

uniform float BeamPower;
uniform float SpotSigma;      //beam units; 1 unit = half the face height
uniform float SpotDefocus;    //how much a full-current beam swells
uniform float BlankFloor;     //what a fully cut-off beam still puts on the glass
uniform float DensityFloor;   //peak areal density below which a segment is not drawn
uniform float DeflectionGain; //beam units per volt: underscan or overscan
uniform float FaceAspect;     //face width / face height

flat out float segLength;
flat out float segSigma;
flat out float segEnergy;
out vec2 segUV;               //x along the segment from its centre, y across

//---------------------------------------------------------------------------
// Not isnan()/isinf().
//
// Those are the right functions and they are also the first thing a shader
// compiler running with fast-math assumptions folds to constant false, on the
// grounds that the value cannot happen. The value is exactly what we are here
// about: one NaN sample -- an oscillator that divided by a zero frequency, an
// audio file with a denormal run, a filter that went unstable for one block --
// deposits a NaN into the phosphor buffer, and NaN * decay is NaN for the rest
// of the session. A comparison chain has no intrinsic to fold.
//---------------------------------------------------------------------------
bool usable( float v )
{
	return v > -1e30 && v < 1e30;
}

bool usable2( vec2 v )
{
	return usable( v.x ) && usable( v.y );
}

void main()
{
	vec2 a = sampleA.xy * DeflectionGain;
	vec2 b = sampleB.xy * DeflectionGain;

	//The grid voltage over the interval, averaged across its two ends. The floor
	//is what a cut-off beam still manages: a real gun does not reach zero
	//emission, and a retrace that leaves absolutely nothing behind looks wrong in
	//a way people describe as "too clean".
	float zBar = mix( BlankFloor, 1.0, clamp( 0.5 * ( sampleA.z + sampleB.z ), 0.0, 1.0 ) );

	//The whole brightness model, in one line. Energy per interval, not intensity
	//per pixel: the fragment stage spreads this over however far the beam went,
	//so nothing anywhere divides by a speed. \`dt\` is per-sample precisely so this
	//is independent of how many samples the engine chose to emit -- see
	//signal/Signal.h.
	float energy = BeamPower * max( sampleA.w, 0.0 ) * zBar;

	//More current is a fatter spot. Same reason a CRT's highlights swell.
	float sigma = SpotSigma * ( 1.0 + SpotDefocus * zBar );

	vec2 delta = b - a;
	float span = length( delta );
	vec2 dir   = span > 1e-9 ? delta / span : vec2( 1.0, 0.0 );

	//A floor of a twentieth of a spot, so the box is never zero-area and the
	//fragment stage's short branch has a length to divide by if it ever wanted
	//one. It does not: below a quarter of a sigma it uses the point limit, where
	//the length cancels.
	float len = max( span, 0.05 * sigma );

	//Peak areal density of the finished segment: the value at the middle of a
	//long one, E / (L * sigma * sqrt(2pi)). Culling on this rather than on energy
	//is what makes the cull mean something -- a fast sweep and a slow one can
	//carry the same energy and only one of them is visible.
	float density = energy / max( len * sigma * Sqrt2Pi, 1e-30 );

	bool ok = usable2( a ) && usable2( b )
	       && usable( energy ) && usable( sigma )
	       && energy > 0.0 && sigma > 0.0
	       && density >= DensityFloor;

	if( !ok )
	{
		//A degenerate quad: the same clip position for all four corners, so it
		//has no area and rasterises nothing whatever the driver does with it,
		//and outside the frustum as well. Returning without writing gl_Position
		//would be undefined; discarding in the fragment stage would be too late,
		//because a NaN position can already have taken the primitive somewhere
		//enormous.
		segLength   = 0.0;
		segSigma    = 1.0;
		segEnergy   = 0.0;
		segUV       = vec2( 0.0 );
		gl_Position = vec4( 2.0, 2.0, 0.0, 1.0 );
		return;
	}

	//An oriented box around the capsule, padded by Extent sigma on all sides.
	float halfAlong  = 0.5 * len + Extent * sigma;
	float halfAcross = Extent * sigma;

	//Corners from the vertex index, as a triangle strip: 0 -> (-,-), 1 -> (+,-),
	//2 -> (-,+), 3 -> (+,+). No vertex buffer for four signs.
	float sx = ( ( gl_VertexID & 1 ) == 0 ) ? -1.0 : 1.0;
	float sy = ( ( gl_VertexID & 2 ) == 0 ) ? -1.0 : 1.0;

	vec2 centre = a + dir * ( 0.5 * len );
	vec2 perp   = vec2( -dir.y, dir.x );
	vec2 pos    = centre + dir * ( sx * halfAlong ) + perp * ( sy * halfAcross );

	segLength = len;
	segSigma  = sigma;
	segEnergy = energy;
	segUV     = vec2( sx * halfAlong, sy * halfAcross );

	//Beam units are isotropic -- one unit is half the face height in both axes --
	//so the spot is round and stays round on a 4:3 face. The divide is the only
	//place the face's shape enters the trace at all.
	gl_Position = vec4( pos.x / FaceAspect, pos.y, 0.0, 1.0 );
}
`;

const TRACE_FRAGMENT_BODY = `
flat in float segLength;
flat in float segSigma;
flat in float segEnergy;
in vec2 segUV;

out vec4 fragColor;

void main()
{
	float inv = 1.0 / segSigma;
	float u   = segUV.x;
	float v   = segUV.y;

	//Across the segment: a normalised Gaussian, minus the value it has at the
	//quad's own boundary.
	//
	//Without the subtraction the profile is cut off at 4.5 sigma with a step of
	//about 1.5e-5 of the peak. For one segment that is invisible. At a turnaround
	//where a thousand segments overlap it is a thousand times 1.5e-5 along a line
	//that is exactly where those thousand boxes end -- a visible polygon edge in
	//the middle of the brightest part of the picture, which is precisely the part
	//the plugin exists to render.
	float across   = InvSqrt2Pi * inv * exp( -0.5 * v * v * inv * inv );
	float pedestal = InvSqrt2Pi * inv * exp( -0.5 * Extent * Extent );
	across = max( across - pedestal, 0.0 );

	float along;
	if( segLength < 0.25 * segSigma )
	{
		//The point limit, taken explicitly rather than left to the CDF.
		//
		//A difference of two nearly equal numbers, each carrying the tanh
		//approximation's ~3e-4 of error, is a difference whose own error is
		//several percent by the time L is a quarter of a sigma. And it is a
		//short segment precisely at the turnarounds and the stationary dots --
		//the features this plugin is about. The limit costs one exp and is exact.
		//
		//\`segLength\` is flat, so this branch is dynamically uniform across the
		//primitive and the derivatives in neighbouring passes stay defined.
		along = InvSqrt2Pi * inv * exp( -0.5 * u * u * inv * inv );
	}
	else
	{
		float halfLen = 0.5 * segLength;//\`half\` is a GLSL reserved word
		along = ( ncdf( ( u + halfLen ) * inv ) - ncdf( ( u - halfLen ) * inv ) ) / segLength;
	}

	//R is the fast layer's excitation. The slow layer is not deposited into: it
	//is pumped only by what the fast layer sheds, in the decay pass.
	float deposit = segEnergy * across * along;
	fragColor = vec4( deposit, 0.0, 0.0, 0.0 );
}
`;

const DECAY_FRAGMENT_BODY = `
uniform sampler2D HistoryTexture;
uniform float DecayFast;
uniform float DecaySlow;
uniform float Transfer;
uniform float Ceiling;

in vec2 uv;

out vec4 fragColor;

void main()
{
	vec2 h = texture( HistoryTexture, uv ).rg;

	//The backstop. Every other guard in the renderer is in front of this buffer;
	//this one is behind it, because a ping-ponged accumulator is the one place
	//where a single bad value is permanent. NaN * DecayFast is NaN, forever, and
	//the operator's only remedy would be to delete the effect and add it again.
	//
	//Comparisons rather than isnan/isinf, for the reason given in Trace.cpp.
	if( !( h.x > -1e30 && h.x < 1e30 ) )
		h.x = 0.0;
	if( !( h.y > -1e30 && h.y < 1e30 ) )
		h.y = 0.0;

	float fast = h.r * DecayFast;
	float slow = h.g * DecaySlow + h.r * ( 1.0 - DecayFast ) * Transfer;

	//The ceiling is not the saturation curve -- that is applied at readout, in
	//the prelude, and it is what actually shapes a bright trace. This is only
	//here so that a runaway cannot climb until it reaches the top of a 32-bit
	//float and becomes an inf that the check above would then have to catch every
	//frame for the rest of the session.
	fragColor = vec4( min( fast, Ceiling ), min( slow, Ceiling ), 0.0, 0.0 );
}
`;

const BRIGHT_FRAGMENT_BODY = `
uniform sampler2D PhosphorTexture;
uniform vec2 SourceSize;
uniform vec2 FaceHalf;      //face half-extents in beam units
uniform float Threshold;

in vec2 uv;

out vec4 fragColor;

void main()
{
	//Four bilinear taps at the corners of the destination footprint: a box
	//downsample that does not leave stair-stepping in the halo.
	vec2 texel = 1.0 / max( SourceSize, vec2( 1.0 ) );
	vec3 sum = phosphorEmission( texture( PhosphorTexture, uv + vec2( -1.0, -1.0 ) * texel ).rg )
	         + phosphorEmission( texture( PhosphorTexture, uv + vec2(  1.0, -1.0 ) * texel ).rg )
	         + phosphorEmission( texture( PhosphorTexture, uv + vec2( -1.0,  1.0 ) * texel ).rg )
	         + phosphorEmission( texture( PhosphorTexture, uv + vec2(  1.0,  1.0 ) * texel ).rg );
	vec3 colour = sum * 0.25;

	colour += GraticuleColour * graticuleAt( ( uv * 2.0 - 1.0 ) * FaceHalf );

	float luma = dot( colour, vec3( 0.299, 0.587, 0.114 ) );
	colour *= smoothstep( Threshold, Threshold + 0.35, luma );

	fragColor = vec4( max( colour, vec3( 0.0 ) ), 1.0 );
}
`;

const BLUR_FRAGMENT_BODY = `
uniform sampler2D SourceTexture;
uniform vec2 Direction;//one texel along the axis being blurred

in vec2 uv;

out vec4 fragColor;

void main()
{
	const float offsets[ 3 ] = float[]( 0.0, 1.3846153846, 3.2307692308 );
	const float weights[ 3 ] = float[]( 0.2270270270, 0.3162162162, 0.0702702703 );

	vec3 sum = texture( SourceTexture, uv ).rgb * weights[ 0 ];
	for( int i = 1; i < 3; ++i )
	{
		sum += texture( SourceTexture, uv + Direction * offsets[ i ] ).rgb * weights[ i ];
		sum += texture( SourceTexture, uv - Direction * offsets[ i ] ).rgb * weights[ i ];
	}

	fragColor = vec4( sum, 1.0 );
}
`;

const GLASS_FRAGMENT_BODY = `
uniform sampler2D PhosphorTexture;
uniform sampler2D BloomTexture;
uniform sampler2D ClipTexture;

uniform vec2  OutputSize;
uniform vec2  FaceHalf;      //face half-extents in beam units: (aspect, 1)
uniform float FaceFit;       //beam units -> square output units
uniform float CornerRadius;  //0..1 of the shorter half-extent; 1 on a square face is a circle
uniform float Curvature;
uniform float Vignette;
uniform float Halation;
uniform float PerspectiveX;
uniform float PerspectiveY;

uniform vec3  FilterTransmission;//what the contrast filter passes, per channel
uniform float FaceBlack;         //how much of the faceplate is actually in front
uniform float Opacity;

uniform float HasClip;  //0 for the source build, which has no input at all
uniform vec2  ClipMaxUV;//the host's padding, applied only where the clip is read

in vec2 uv;

out vec4 fragColor;

const float FOCAL = 2.4;

mat3 rotationX( float a )
{
	float s = sin( a ), c = cos( a );
	return mat3( 1.0, 0.0, 0.0,
	             0.0, c, s,
	             0.0, -s, c );
}

mat3 rotationY( float a )
{
	float s = sin( a ), c = cos( a );
	return mat3( c, 0.0, -s,
	             0.0, 1.0, 0.0,
	             s, 0.0, c );
}

void main()
{
	float aspect = OutputSize.x / max( OutputSize.y, 1.0 );

	//----------------------------------------------------------------------
	// 1. Undo the view.
	//----------------------------------------------------------------------
	vec2 p = uv * 2.0 - 1.0;
	p.x *= aspect;//square units, so a rotation is a rotation

	mat3 orientation = rotationY( PerspectiveX ) * rotationX( PerspectiveY );
	vec3 dir    = vec3( p, FOCAL );
	vec3 normal = orientation * vec3( 0.0, 0.0, 1.0 );
	vec3 centre = vec3( 0.0, 0.0, FOCAL );

	//Guarded rather than branched: an early return here would leave the
	//derivatives below undefined for the whole quad, and both the face edge and
	//the graticule are anti-aliased on them.
	float denom = dot( normal, dir );
	denom = denom >= 0.0 ? max( denom, 1e-4 ) : min( denom, -1e-4 );
	float t = dot( normal, centre ) / denom;

	vec3 local    = transpose( orientation ) * ( t * dir - centre );
	float inFront = step( 1e-4, t );//the face is behind the eye at absurd angles

	//At zero perspective this is exact: the rotations are identity, t is exactly
	//one, and local.xy comes back as p unchanged.
	vec2 viewed = local.xy / max( FaceFit, 1e-6 );

	//----------------------------------------------------------------------
	// 2. Undo the curvature. The face bulges, so the sampling pinches.
	//----------------------------------------------------------------------
	//
	// Divided through by the expansion at the corner, which is overscan: a set
	// deliberately scans a raster larger than its own face so the picture reaches
	// the bezel on all four sides. Without it the distortion pulls the corners
	// inside the glass and shows black beyond them, and the shape you see at the
	// edge becomes an artefact of the curvature rather than the shape of the
	// tube -- which leaves Corner Radius doing nothing at any useful curvature.
	//
	// The coupling to Curvature is real: more distortion needs more overscan to
	// cover the same face. Kept exactly as \`old-cathode\` has it, so the two
	// plugins' tubes are the same tube.
	vec2 n = viewed / FaceHalf;//+-1 at the face edges, so 0.5*dot at the corner is 1
	float bulge = ( 1.0 + Curvature * 0.5 * dot( n, n ) ) / ( 1.0 + Curvature );
	vec2 face = viewed * bulge;

	vec2 faceUV = face / ( 2.0 * FaceHalf ) + 0.5;

	//----------------------------------------------------------------------
	// 3. The glass itself.
	//----------------------------------------------------------------------
	//
	// A rounded rectangle in the tube's own coordinates, so the bezel keeps its
	// shape when the set is turned away from you. Radius 1 on a square face
	// reduces this exactly to length(face) - 1, which is a circle -- which is why
	// a lab scope and a television are the same geometry with different numbers
	// rather than two code paths.
	float radius = clamp( CornerRadius, 0.0, 1.0 ) * min( FaceHalf.x, FaceHalf.y );
	vec2 q   = abs( face ) - ( FaceHalf - radius );
	float sd = length( max( q, vec2( 0.0 ) ) ) + min( max( q.x, q.y ), 0.0 ) - radius;
	float aa = max( fwidth( sd ), 1e-5 );
	float faceMask = ( 1.0 - smoothstep( -aa, aa, sd ) ) * inFront;

	//Curvature can push the sample outside the face buffer before the mask cuts
	//it off, and a clamped texture edge out there would smear the last row of
	//phosphor across the bezel.
	vec2 beyond = step( vec2( 0.0 ), -faceUV ) + step( vec2( 1.0 ), faceUV );
	faceMask *= 1.0 - clamp( beyond.x + beyond.y, 0.0, 1.0 );

	//1.0 - 0.0 * anything is exactly 1.0.
	float vig = 1.0 - Vignette * smoothstep( 0.25, 1.5, length( n * vec2( 0.92, 1.0 ) ) );

	vec3 emission = phosphorEmission( texture( PhosphorTexture, faceUV ).rg ) * vig;
	emission += GraticuleColour * graticuleAt( face );
	emission *= faceMask;

	vec3 halo = texture( BloomTexture, faceUV ).rgb * faceMask;

	//----------------------------------------------------------------------
	// 4. What is behind the glass.
	//----------------------------------------------------------------------
	vec4 clipTexel = vec4( 0.0 );
	if( HasClip > 0.5 )
	{
		//The warp, undone back into output coordinates. At zero curvature and
		//zero perspective the round trip through \`aspect\` is a multiply and a
		//divide that are not required to cancel in floating point, so that case
		//takes the coordinate it already has instead of one that is nearly it.
		vec2 clipUV;
		if( Curvature != 0.0 || PerspectiveX != 0.0 || PerspectiveY != 0.0 )
		{
			vec2 warped = local.xy * bulge;
			clipUV = vec2( warped.x / aspect, warped.y ) * 0.5 + 0.5;
		}
		else
		{
			clipUV = uv;
		}
		clipTexel = texture( ClipTexture, clipUV * ClipMaxUV );
	}

	//The filter carries its tint into the colour and only the mask into the
	//alpha: a green contrast filter darkens what is behind it without making it
	//any less opaque. Both are literal ones when the faceplate is not there.
	vec3 faceplate   = vec3( 1.0 );
	float faceplateA = 1.0;
	if( FaceBlack > 0.0 )
	{
		faceplate  = mix( vec3( 1.0 ), FilterTransmission * faceMask, FaceBlack );
		faceplateA = mix( 1.0, faceMask, FaceBlack );
	}

	vec3 through   = clipTexel.rgb * faceplate;
	float throughA = clipTexel.a * faceplateA;

	vec3 emitted = emission + halo * Halation;
	vec3 colour  = through + emitted;

	//----------------------------------------------------------------------
	// Alpha, premultiplied, which is what Resolume composites in.
	//----------------------------------------------------------------------
	//
	// The tube's own light is opaque -- glass that is emitting is not something
	// you see through. Beyond that:
	//
	//   source build: the face is the object, so alpha is the face mask and the
	//                 layer below shows around it.
	//   effect build: the clip keeps its own alpha, and the faceplate is only as
	//                 opaque as FaceBlack says it is. At FaceBlack 0 that is
	//                 zero, which is what makes the passthrough exact for a
	//                 semi-transparent clip as well as for an opaque one.
	float emissive = clamp( max( emitted.r, max( emitted.g, emitted.b ) ), 0.0, 1.0 );
	float coverage = HasClip > 0.5 ? max( FaceBlack * faceMask, emissive ) : faceMask;

	float alpha = clamp( max( throughA, coverage ), 0.0, 1.0 ) * Opacity;

	//Only the floor is clamped. Nothing here can produce negative light, so a
	//negative value means the clip arrived with one; clamping the ceiling as well
	//would quietly change a passthrough of any clip that carries values above 1,
	//which some do.
	fragColor = vec4( max( colour, vec3( 0.0 ) ), alpha );
}
`;

//---------------------------------------------------------------------------
// Assembly, exactly as Prelude.cpp does it.
//
// Two preludes and not one, for the reason that file gives: `fwidth` appears in
// the graticule, and a vertex stage compiles the whole body whether or not it
// calls the function — so the numeric constants are shared by both stages and
// the helpers only by the fragment stages.
//---------------------------------------------------------------------------

const vertexSource = (body) => CONSTANTS + body;
const fragmentSource = (body) => CONSTANTS + FRAGMENT_HELPERS + body;
const SCREEN_VERTEX = vertexSource(SCREEN_VERTEX_BODY);

//===========================================================================
// The signal chain — a port of source/signal/, and a partial one.
//
// What is here: the oscillator, the shapes, and the seven effects that change
// the *figure* rather than its dynamics, plus the deflection amplifier because
// its slew limit and its bandwidth are where the corner rounding comes from.
// What is not: the gate, the compressor, the flanger, the chorus, the reverb,
// the VCA, the wireframe / audio-file / trace sources, and the modulation
// matrix. Those are named on the page rather than approximated.
//
// The discipline that survives the port intact is the one AGENTS.md insists on:
// **phase is integrated**, never `t * frequency`. JavaScript numbers are IEEE
// doubles, so the plugin's "double, not float" rule is free here — but the
// integration is not, and computing the phase from the clock would show the same
// jump-on-knob-turn bug the plugin's comment describes.
//===========================================================================

const TWO_PI = 6.283185307179586476925286766559;

/// The largest block the engine will synthesise in one frame — kMaxBlock.
const MAX_BLOCK = 16384;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/// Denormals do not cost anything in JavaScript the way they do on x86, but the
/// flush is kept because it is in every feedback path in the C++ and removing it
/// would make the two chains differ by a hair at the very bottom of a tail.
const flush = (x) => (Math.abs(x) < 1e-25 ? 0 : x);

function smoothstep01(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A seeded generator for the Noise and Sample & Hold waveforms.
 *
 * **Not** the plugin's xorshift128+. That carries 64-bit state, which in
 * JavaScript means BigInt, and BigInt arithmetic ninety-six thousand times a
 * second is far too slow to fit in a frame. mulberry32 does the same job —
 * reproducible from a seed, uniform, no visible structure — with different
 * numbers. Nothing on this page claims the noise matches the plugin's sample for
 * sample, and no invariant would be checking it if it did.
 */
class Rng {
  constructor(seed = 1) {
    this.seed(seed);
  }

  seed(s) {
    this.state = (s >>> 0) || 1;
  }

  unit() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /// Uniform in [-1, 1], and deliberately not Gaussian: uniform noise on both
  /// axes fills a square, which is what noise on a scope looks like.
  bipolar() {
    return this.unit() * 2 - 1;
  }
}

//---------------------------------------------------------------------------
// Filters — signal/fx/Filters.h. Every coefficient formula in the plugin lives
// in that one file, and every one of them is here once for the same reason.
//---------------------------------------------------------------------------

class OnePole {
  constructor() {
    this.fs = 96000;
    this.coeff = 1;
    this.state = 0;
  }

  prepare(fs) {
    this.fs = fs;
    this.reset();
  }

  reset() {
    this.state = 0;
  }

  setCutoff(hz) {
    const clamped = clamp(hz, 1, this.fs * 0.49);
    this.coeff = 1 - Math.exp((-TWO_PI * clamped) / this.fs);
  }

  low(x) {
    this.state = flush(this.state + (x - this.state) * this.coeff);
    return this.state;
  }

  high(x) {
    return x - this.low(x);
  }
}

/// Zavalishin's topology-preserving-transform state variable filter. TPT and not
/// the Chamberlin form because the Chamberlin one goes unstable as the cutoff
/// approaches a quarter of the sample rate, and the deflection amplifier's
/// bandwidth control wants to run right up there.
class Svf {
  constructor() {
    this.fs = 96000;
    this.g = 0;
    this.k = 1;
    this.a1 = 1;
    this.ic1 = 0;
    this.ic2 = 0;
  }

  prepare(fs) {
    this.fs = fs;
    this.reset();
  }

  reset() {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  set(cutoffHz, q) {
    const clamped = clamp(cutoffHz, 1, this.fs * 0.49);
    this.g = Math.tan((Math.PI * clamped) / this.fs);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
  }

  low(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * (this.ic1 + this.g * v3);
    const v2 = this.ic2 + this.g * v1;
    this.ic1 = flush(2 * v1 - this.ic1);
    this.ic2 = flush(2 * v2 - this.ic2);
    return v2;
  }
}

/// A first-order allpass, the phaser's building block. Unity magnitude at every
/// frequency; all it does is delay phase — which on a deflection axis is a
/// rotation of the figure rather than a colour of the sound.
class Allpass1 {
  constructor() {
    this.x1 = 0;
    this.y1 = 0;
  }

  reset() {
    this.x1 = 0;
    this.y1 = 0;
  }

  process(x, a) {
    const y = a * x + this.x1 - a * this.y1;
    this.x1 = x;
    this.y1 = flush(y);
    return this.y1;
  }
}

const allpassCoeff = (hz, fs) => {
  const t = Math.tan((Math.PI * clamp(hz, 1, fs * 0.49)) / fs);
  return (1 - t) / (1 + t);
};

/**
 * A power-of-two delay line with a fractional cubic read.
 *
 * Cubic Hermite and not linear on purpose: linear interpolation of a fractional
 * delay is a low pass whose cutoff depends on the fractional part, so a
 * modulated delay gets a brightness that wobbles in step with the modulation. On
 * a picture that is a figure whose sharpness breathes, which reads as a fault in
 * the focus.
 */
class DelayLine {
  constructor() {
    this.buffer = new Float32Array(2);
    this.mask = 1;
    this.write = 0;
  }

  prepare(powerOfTwoLength) {
    let size = 2;
    while (size < powerOfTwoLength) size <<= 1;
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
    this.write = 0;
  }

  reset() {
    this.buffer.fill(0);
  }

  writeSample(x) {
    this.buffer[this.write] = flush(x);
    this.write = (this.write + 1) & this.mask;
  }

  read(delay) {
    const clamped = clamp(delay, 1, this.mask - 2);
    const pos = this.write - clamped;
    const i = (Math.floor(pos) + this.buffer.length * 4) & this.mask;
    const frac = pos - Math.floor(pos);

    const b = this.buffer;
    const m = this.mask;
    const xm1 = b[(i - 1) & m];
    const x0 = b[i];
    const x1 = b[(i + 1) & m];
    const x2 = b[(i + 2) & m];

    const c0 = x0;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);

    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
}

/// A blocking DC remover, genuinely last in the chain: the rectifier and the
/// wavefolder both manufacture DC, and DC on a deflection axis is not a tone —
/// it is the whole figure sitting permanently off the centre of the screen.
class DcBlock {
  constructor() {
    this.coeff = 0.999;
    this.x1 = 0;
    this.y1 = 0;
  }

  prepare(fs) {
    // A 5 Hz corner: low enough not to touch the slowest figure anyone will
    // draw, high enough to settle within a second of a fold being engaged.
    this.coeff = 1 - (TWO_PI * 5) / fs;
    this.reset();
  }

  reset() {
    this.x1 = 0;
    this.y1 = 0;
  }

  process(x) {
    const y = x - this.x1 + this.coeff * this.y1;
    this.x1 = x;
    this.y1 = flush(y);
    return this.y1;
  }
}

/// A 2x half-band FIR, used in cascade for the wavefolder's 4x oversampling.
/// **Linear phase**, and that choice is specific to this plugin: a polyphase IIR
/// half-band is cheaper and steeper, and its non-flat phase response would be a
/// frequency-dependent delay between the two deflection axes — which is a skew
/// of the figure, i.e. a phaser nobody asked for.
const HALF_BAND_TAPS = 15;
const HALF_BAND_COEFF = [
  -0.006, 0.0, 0.0293, 0.0, -0.103, 0.0, 0.3172, 0.5,
  0.3172, 0.0, -0.103, 0.0, 0.0293, 0.0, -0.006,
];

class HalfBand {
  constructor() {
    this.history = new Float32Array(HALF_BAND_TAPS);
    this.index = 0;
  }

  reset() {
    this.history.fill(0);
    this.index = 0;
  }

  process(x) {
    this.history[this.index] = x;
    let sum = 0;
    for (let t = 0; t < HALF_BAND_TAPS; t += 1) {
      const c = HALF_BAND_COEFF[t];
      if (c === 0) continue;
      const h = (this.index - t + HALF_BAND_TAPS * 2) % HALF_BAND_TAPS;
      sum += c * this.history[h];
    }
    this.index = (this.index + 1) % HALF_BAND_TAPS;
    return sum;
  }
}

//---------------------------------------------------------------------------
// Smoothing — signal/Smooth.h.
//---------------------------------------------------------------------------

/// FFGL delivers one parameter value per video frame, and a step change in a
/// deflection voltage is a discontinuity the delay will faithfully remember and
/// hand back later. The browser delivers one per frame too, so this is needed
/// here for exactly the same reason.
class Smooth {
  constructor() {
    this.coeff = 1;
    this.current = 0;
    this.target = 0;
  }

  prepare(fs, tau = 0.005) {
    this.coeff = fs > 0 && tau > 0 ? 1 - Math.exp(-1 / (fs * tau)) : 1;
  }

  snap(value) {
    this.current = value;
  }

  setTarget(value) {
    this.target = value;
  }

  next() {
    this.current += (this.target - this.current) * this.coeff;
    return this.current;
  }
}

/// Bypass crossfades over 20 ms rather than switching, and does **not** clear
/// state on the way: a delay that forgot its buffer on bypass would drop its
/// tail on the floor, where a true-bypass footswitch does not empty the tank.
class Crossfade {
  constructor() {
    this.step = 1;
    this.current = 0;
    this.target = 0;
  }

  prepare(fs, seconds = 0.02) {
    this.step = fs > 0 && seconds > 0 ? 1 / (fs * seconds) : 1;
  }

  setEngaged(on) {
    this.target = on ? 1 : 0;
  }

  next() {
    if (this.current < this.target) {
      this.current = this.current + this.step > this.target ? this.target : this.current + this.step;
    } else if (this.current > this.target) {
      this.current = this.current - this.step < this.target ? this.target : this.current - this.step;
    }
    return this.current;
  }

  idle() {
    return this.current <= 0 && this.target <= 0;
  }
}

//---------------------------------------------------------------------------
// Routing — signal/fx/Fx.h.
//
// This is the control that makes the pictures. X Only and Y Only are where most
// of them come from: an effect applied to one deflection axis and not the other
// is not a filter, it is a geometric transform of the figure.
//---------------------------------------------------------------------------

const Routing = {
  Stereo: 0,
  XOnly: 1,
  YOnly: 2,
  MidSide: 3,
  Mono: 4,
  Cross: 5,
  PingPong: 6,
};

// Scratch for the split and for every block's output. Module scope and reused
// rather than returned in a fresh object: this runs once per sample per block,
// something like fourteen thousand times a frame at 96 kHz, and an allocation
// there is a collector pause you can see in the trace.
let splitA = 0;
let splitB = 0;
let outX = 0;
let outY = 0;

function splitIn(mode, x, y) {
  if (mode === Routing.MidSide) {
    splitA = 0.5 * (x + y);
    splitB = 0.5 * (x - y);
  } else if (mode === Routing.Mono) {
    splitA = 0.5 * (x + y);
    splitB = splitA;
  } else {
    splitA = x;
    splitB = y;
  }
}

function splitOut(mode, aIn, bIn, a, b) {
  switch (mode) {
    case Routing.MidSide:
      outX = a + b;
      outY = a - b;
      break;
    case Routing.Mono:
      outX = a;
      outY = a;
      break;
    case Routing.XOnly:
      outX = a;
      outY = bIn;
      break;
    case Routing.YOnly:
      outX = aIn;
      outY = b;
      break;
    default:
      outX = a;
      outY = b;
      break;
  }
}

/// X Only and Y Only do not need the second channel processed at all, and
/// skipping it saves half the work in the common case.
const needsBoth = (mode) => mode !== Routing.XOnly && mode !== Routing.YOnly;

/// One pedal. `process` works in place on the interleaved sample block and must
/// not touch `dt`.
class FxBlock {
  constructor() {
    this.bypass = new Crossfade();
    this.fs = 96000;
  }

  setEnabled(on) {
    this.bypass.setEngaged(on);
  }

  idle() {
    return this.bypass.idle();
  }

  /// Apply the bypass crossfade for one sample, into outX/outY.
  blend(dryX, dryY, x, y) {
    const w = this.bypass.next();
    outX = dryX + (x - dryX) * w;
    outY = dryY + (y - dryY) * w;
  }
}

//---------------------------------------------------------------------------
// Sources — signal/sources/Oscillator.cpp and Shapes.cpp.
//---------------------------------------------------------------------------

const Wave = {
  Sine: 0,
  Triangle: 1,
  Saw: 2,
  Ramp: 3,
  Pulse: 4,
  Noise: 5,
  SampleHold: 6,
};

/// The frequency ratio between the two axes, as a small rational. A *slider*
/// here would be a bug that looks like a feature: landing on 2.001:1 instead of
/// 2:1 makes the figure rotate slowly and forever, and every value near the one
/// the operator wants is also wrong. Detune is the separate control for the
/// drift they might actually want.
const RATIOS = [
  [1, 1], [2, 1], [1, 2], [3, 2], [2, 3], [4, 3], [3, 4],
  [5, 4], [4, 5], [5, 3], [3, 5], [3, 1], [1, 3], [5, 2],
  [2, 5], [7, 4], [4, 7], [8, 5], [5, 8], [9, 8], [8, 9],
];

const RATIO_NAMES = [
  '1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4',
  '5:4', '4:5', '5:3', '3:5', '3:1', '1:3', '5:2',
  '2:5', '7:4', '4:7', '8:5', '5:8', '9:8', '8:9',
];

/**
 * The polyBLEP correction, subtracted at each discontinuity.
 *
 * Worth its handful of flops for two reasons that are both about the picture. An
 * aliased saw at 300 Hz puts energy at frequencies that are not harmonically
 * related to anything, so the figure develops a slow crawl that no control
 * explains. And the wavefolder downstream multiplies those aliases by its own
 * harmonics, so a faint shimmer becomes structure.
 */
function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Set by Oscillator.step, read straight after it. Same reasoning as splitA/B.
let stepBlank = false;

/**
 * Two independent oscillators driving X and Y.
 *
 * The phases are **integrated**, never computed as `time * frequency`. The
 * obvious form rescales the whole history the instant the Frequency control
 * moves, so the figure jumps to a different point in its cycle on every knob
 * touch — which for a model of a signal path is not merely ugly, it is wrong: a
 * real VCO's phase is continuous through a frequency change.
 *
 * The honest consequence, stated because it is not guessable: changing the ratio
 * leaves a permanent phase offset between the two axes, so the figure comes back
 * in a different orientation than it left in. That is what Phase Y is for.
 */
class Oscillator {
  constructor() {
    this.fs = 96000;
    this.rng = new Rng(1);
    this.axisX = { phase: 0, inc: 0, holdValue: 0, wrapped: false };
    this.axisY = { phase: 0, inc: 0, holdValue: 0, wrapped: false };
    this.params = {
      waveX: Wave.Sine,
      waveY: Wave.Sine,
      freqX: 30,
      ratioIndex: 0,
      freeY: false,
      freqY: 30,
      phaseY: 0.25,
      pwmX: 0.5,
      pwmY: 0.5,
      detune: 0,
      hardSync: false,
      blankRetrace: false,
    };
  }

  prepare(fs) {
    this.fs = fs > 0 ? fs : 96000;
    this.reset();
  }

  reset() {
    this.axisX = { phase: 0, inc: 0, holdValue: 0, wrapped: false };
    this.axisY = { phase: 0, inc: 0, holdValue: 0, wrapped: false };
  }

  setParams(p) {
    this.params = p;
  }

  setSeed(seed) {
    this.rng.seed(seed);
  }

  /// Advance one axis and return its value. The waveform is read at
  /// `phase + offset` while the accumulator advances from `phase`, which is what
  /// keeps Phase Y a standing offset rather than a one-shot nudge.
  step(axis, wave, width, offset) {
    let read = axis.phase + offset;
    read -= Math.floor(read);

    const p = read;
    const dt = axis.inc;

    stepBlank = false;
    axis.wrapped = false;

    let value = 0;

    switch (wave) {
      case Wave.Sine:
        // Math.sin directly, not a lookup table. A table's interpolation error
        // shows up as a subtly non-circular circle, which is precisely the
        // artefact this plugin refuses to draw.
        value = Math.sin(TWO_PI * read);
        break;

      case Wave.Triangle:
        // Aliasing here is 12 dB/octave down and genuinely invisible on a
        // deflection signal. Accepted rather than corrected.
        value = 1 - 4 * Math.abs(p - 0.5);
        break;

      case Wave.Saw:
        value = 2 * p - 1;
        value -= polyBlep(p, dt);
        stepBlank = p < dt || p > 1 - dt;
        break;

      case Wave.Ramp:
        value = 1 - 2 * p;
        value += polyBlep(p, dt);
        stepBlank = p < dt || p > 1 - dt;
        break;

      case Wave.Pulse: {
        const w = clamp(width, 0.02, 0.98);
        value = p < w ? 1 : -1;
        value -= polyBlep(p, dt);
        // The falling edge is the rising edge of a phase shifted by the duty
        // cycle, which is why the same function serves both.
        let shifted = p - w;
        if (shifted < 0) shifted += 1;
        value += polyBlep(shifted, dt);
        stepBlank = p < dt || p > 1 - dt || shifted < dt || shifted > 1 - dt;
        break;
      }

      case Wave.Noise:
        value = this.rng.bipolar();
        break;

      case Wave.SampleHold:
        value = axis.holdValue;
        break;

      default:
        value = 0;
        break;
    }

    axis.phase += axis.inc;
    if (axis.phase >= 1) {
      axis.phase -= Math.floor(axis.phase);
      axis.wrapped = true;
      if (wave === Wave.SampleHold) axis.holdValue = this.rng.bipolar();
    }

    return value;
  }

  render(out, n, dtPerSample) {
    const p = this.params;
    const r = RATIOS[clamp(p.ratioIndex, 0, RATIOS.length - 1)];

    const detune = 1 + clamp(p.detune, -0.02, 0.02);
    const fx = clamp(p.freqX, 0.01, 2000);
    const fy = p.freeY ? clamp(p.freqY, 0.01, 2000) : fx * (r[0] / r[1]);

    this.axisX.inc = fx / this.fs;
    this.axisY.inc = (fy * detune) / this.fs;

    const phaseOffset = p.phaseY;

    for (let i = 0; i < n; i += 1) {
      const x = this.step(this.axisX, p.waveX, p.pwmX, 0);
      const blankX = stepBlank;

      // Hard sync: Y restarts whenever X wraps. Three lines, a real eurorack
      // idiom, and it aliases badly by design — that is what it looks like on
      // the hardware too.
      if (p.hardSync && this.axisX.wrapped) {
        this.axisY.phase = 0;
        if (p.waveY === Wave.SampleHold) this.axisY.holdValue = this.rng.bipolar();
      }

      const y = this.step(this.axisY, p.waveY, p.pwmY, phaseOffset);
      const blankY = stepBlank;

      // Blank on Retrace cuts the gun across the discontinuity rather than
      // having the renderer special-case a fast segment. This is the cheapest
      // demonstration in the plugin that the house rule is being obeyed: saw-X
      // against saw-Y becomes a clean raster because the beam is *off* during
      // flyback, not because anything decided not to draw the flyback line.
      const blanked = p.blankRetrace && (blankX || blankY);

      const s = i * 4;
      out[s] = x;
      out[s + 1] = y;
      out[s + 2] = blanked ? 0 : 1;
      out[s + 3] = dtPerSample;
    }
  }
}

const ShapeKind = {
  Circle: 0,
  Square: 1,
  Diamond: 2,
  Polygon: 3,
  Star: 4,
  Rose: 5,
  Epitrochoid: 6,
};

function gcd(a, b) {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

// polygonAt writes here rather than into a fresh pair, for the reason splitA/B
// exist.
let shapeX = 0;
let shapeY = 0;

/// Walk the perimeter of a regular N-gon at constant speed. `t` is [0,1) around
/// the whole figure. Radii alternate when `star` is set.
function polygonAt(t, sides, innerFraction, star) {
  const vertices = star ? sides * 2 : sides;
  const scaled = t * vertices;
  const edge = Math.floor(scaled) % vertices;
  const frac = scaled - Math.floor(scaled);

  // Start at the top, as a compass does. Written out twice rather than through
  // a helper returning a pair, because this runs once per sample and a
  // two-element array per call is ninety-six thousand allocations a second.
  const next = (edge + 1) % vertices;

  const angleA = (TWO_PI * edge) / vertices + TWO_PI * 0.25;
  const radiusA = star && edge & 1 ? innerFraction : 1;
  const ax = radiusA * Math.cos(angleA);
  const ay = radiusA * Math.sin(angleA);

  const angleB = (TWO_PI * next) / vertices + TWO_PI * 0.25;
  const radiusB = star && next & 1 ? innerFraction : 1;
  const bx = radiusB * Math.cos(angleB);
  const by = radiusB * Math.sin(angleB);

  // Linear along the edge, so the beam is at constant speed along a side and
  // pivots at the vertex. The vertex brightening that falls out of that is the
  // point; do not smooth it.
  shapeX = ax + (bx - ax) * frac;
  shapeY = ay + (by - ay) * frac;
}

/**
 * Parametric closed paths.
 *
 * One phase, integrated at `rate`. Two disciplines make the difference between a
 * figure that stands still and one that slowly precesses for reasons nobody can
 * find:
 *
 * **The closure period is computed when a parameter changes, never per sample.**
 * A rose with k = n/d closes after d turns if n*d is odd and 2d turns otherwise;
 * an epitrochoid closes after r/gcd(R,r) turns. Wrap the phase at 1 regardless
 * and the figure drifts by whatever the remainder is, every cycle.
 *
 * **The square is not arc-length parameterised.** It is triangle-X against
 * triangle-Y in quadrature, so the beam genuinely slows into each corner and the
 * corner genuinely brightens. Re-parameterising to constant speed would be
 * tidier and would *remove* the artefact, which is the whole thing we are here
 * to produce.
 */
class Shapes {
  constructor() {
    this.fs = 96000;
    this.phase = 0;
    this.turns = 1;
    this.normalise = 1;
    this.params = {
      kind: ShapeKind.Circle,
      rate: 30,
      sides: 5,
      inner: 0.382,
      petalN: 3,
      petalD: 1,
      trochoid: 0.6,
    };
  }

  prepare(fs) {
    this.fs = fs > 0 ? fs : 96000;
    this.recompute();
    this.reset();
  }

  reset() {
    this.phase = 0;
  }

  setParams(p) {
    const old = this.params;
    const structural =
      p.kind !== old.kind || p.sides !== old.sides || p.inner !== old.inner
      || p.petalN !== old.petalN || p.petalD !== old.petalD || p.trochoid !== old.trochoid;
    this.params = p;
    if (structural) this.recompute();
  }

  recompute() {
    const n = clamp(this.params.petalN, 1, 12);
    const d = clamp(this.params.petalD, 1, 12);

    switch (this.params.kind) {
      case ShapeKind.Rose:
        // r = cos(k*theta) with k = n/d closes after d turns when n*d is odd,
        // and after 2d turns otherwise. Wrapping at 1 turn regardless leaves a
        // remainder that precesses the figure a little further every cycle —
        // slowly enough to look like an intentional drift and to survive review.
        this.turns = (n * d) % 2 === 1 ? d : 2 * d;
        this.normalise = 1;
        break;

      case ShapeKind.Epitrochoid: {
        // R and r come from the same two integer knobs, so the closure is
        // r / gcd(R, r) turns of the driving angle.
        const bigR = n + d;
        const littleR = d;
        const g = gcd(bigR, littleR);
        this.turns = littleR / Math.max(1, g);
        // The extreme radius is (R-r)+pen, a constant for the whole figure.
        this.normalise = 1 / Math.max(1e-4, bigR - littleR + Math.abs(this.params.trochoid));
        break;
      }

      default:
        this.turns = 1;
        this.normalise = 1;
        break;
    }
  }

  evaluate(t) {
    const sides = clamp(this.params.sides, 3, 24);

    switch (this.params.kind) {
      case ShapeKind.Circle:
        shapeX = Math.cos(TWO_PI * t);
        shapeY = Math.sin(TWO_PI * t);
        break;

      case ShapeKind.Square: {
        // Triangle against triangle in quadrature. Deliberately NOT an
        // arc-length walk: this makes the beam slow into each corner, and the
        // bright corners of a square on a scope are a dwell artefact, not a
        // drawn decoration.
        const tri = (p) => {
          p -= Math.floor(p);
          return 1 - 4 * Math.abs(p - 0.5);
        };
        shapeX = clamp(tri(t) * 2, -1, 1);
        shapeY = clamp(tri(t + 0.25) * 2, -1, 1);
        break;
      }

      case ShapeKind.Diamond:
        // A square rotated 45 degrees is a 4-gon walked at constant speed. It
        // gets its own entry because operators look for the word.
        polygonAt(t, 4, 1, false);
        break;

      case ShapeKind.Polygon:
        polygonAt(t, sides, 1, false);
        break;

      case ShapeKind.Star:
        polygonAt(t, sides, clamp(this.params.inner, 0.05, 0.95), true);
        break;

      case ShapeKind.Rose: {
        const n = clamp(this.params.petalN, 1, 12);
        const d = clamp(this.params.petalD, 1, 12);
        const theta = TWO_PI * t * this.turns;
        const r = Math.cos((n / d) * theta);
        shapeX = r * Math.cos(theta);
        shapeY = r * Math.sin(theta);
        break;
      }

      case ShapeKind.Epitrochoid: {
        const n = clamp(this.params.petalN, 1, 12);
        const d = clamp(this.params.petalD, 1, 12);
        const bigR = n + d;
        const lilR = d;
        const pen = this.params.trochoid;
        const theta = TWO_PI * t * this.turns;
        const diff = bigR - lilR;
        const inner = (diff * theta) / Math.max(1e-6, lilR);

        shapeX = (diff * Math.cos(theta) + pen * Math.cos(inner)) * this.normalise;
        shapeY = (diff * Math.sin(theta) - pen * Math.sin(inner)) * this.normalise;
        break;
      }

      default:
        shapeX = 0;
        shapeY = 0;
        break;
    }
  }

  render(out, n, dtPerSample) {
    const rate = clamp(this.params.rate, 0.01, 200);
    const inc = rate / this.fs;

    for (let i = 0; i < n; i += 1) {
      this.evaluate(this.phase);

      const s = i * 4;
      out[s] = shapeX;
      out[s + 1] = shapeY;
      out[s + 2] = 1; // a closed path needs no blanking
      out[s + 3] = dtPerSample;

      this.phase += inc;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    }
  }
}

//---------------------------------------------------------------------------
// Effects — signal/fx/Shaper.cpp, Modulation.cpp and Delay.cpp.
//---------------------------------------------------------------------------

/**
 * A normalised soft clip.
 *
 * The Pade rational `x(27+x^2)/(27+9x^2)` approximates tanh to about 2% at the
 * knee for a fifth of the cost — but it is **non-monotonic beyond about 5.2**,
 * and a non-monotonic saturator folds. Since there is a real wavefolder a few
 * lines below, an accidental one here would be indistinguishable from it and
 * impossible to turn off. Hence the clamp first.
 */
function softClip(x) {
  x = clamp(x, -3, 3);
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/// The Serge reflecting wavefolder. Everything above 1 is reflected back down,
/// repeatedly — which is what turns a circle into a rosette.
function wavefold(x, folds) {
  let y = x * folds;
  y -= 4 * Math.round(y * 0.25); // wrap into [-2, 2]
  if (y > 1) y = 2 - y;
  else if (y < -1) y = -2 - y;
  return y;
}

class Rectifier extends FxBlock {
  constructor() {
    super();
    this.params = { enabled: false, fullWave: false, bias: 0, routing: Routing.XOnly };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
  }

  reset() {}

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);
  }

  process(buf, n) {
    if (this.idle()) return;

    const mode = this.params.routing;
    const bias = this.params.bias;
    const full = this.params.fullWave;

    // Bias in, bias out: a movable fold point rather than a fixed one at zero.
    // Half-wave on X with the default bias folds the left half of the figure
    // onto x=0 and the beam then *sits* there for half of every cycle, so a
    // bright vertical bar appears. That bar is dwell, not a drawn line.
    const rect = (v) => {
      const shifted = v + bias;
      const folded = full ? Math.abs(shifted) : Math.max(shifted, 0);
      return folded - bias;
    };

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      splitIn(mode, dryX, dryY);
      const a = splitA;
      const b = splitB;

      const oa = rect(a);
      const ob = needsBoth(mode) ? rect(b) : b;

      splitOut(mode, a, b, oa, ob);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;
    }
  }
}

class Slew extends FxBlock {
  constructor() {
    super();
    this.currentA = 0;
    this.currentB = 0;
    this.params = { enabled: false, rise: 5000, fall: 5000, link: true, routing: Routing.Stereo };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
    this.reset();
  }

  reset() {
    this.currentA = 0;
    this.currentB = 0;
  }

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);
  }

  process(buf, n) {
    if (this.idle()) return;

    const mode = this.params.routing;
    const rise = Math.max(this.params.rise, 0.5) / this.fs;
    const fall = this.params.link ? rise : Math.max(this.params.fall, 0.5) / this.fs;

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      splitIn(mode, dryX, dryY);
      const a = splitA;
      const b = splitB;

      let d = a - this.currentA;
      let step = d > 0 ? rise : fall;
      this.currentA += clamp(d, -step, step);
      const oa = this.currentA;

      let ob = b;
      if (needsBoth(mode)) {
        d = b - this.currentB;
        step = d > 0 ? rise : fall;
        this.currentB += clamp(d, -step, step);
        ob = this.currentB;
      }

      splitOut(mode, a, b, oa, ob);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;
    }
  }
}

class Drive extends FxBlock {
  constructor() {
    super();
    this.driveGain = new Smooth();
    this.upA = [new HalfBand(), new HalfBand()];
    this.upB = [new HalfBand(), new HalfBand()];
    this.downA = [new HalfBand(), new HalfBand()];
    this.downB = [new HalfBand(), new HalfBand()];
    // Scratch for the oversampler, allocated once. A fresh array per sample here
    // is four hundred thousand allocations a second.
    this.stage1 = new Float64Array(2);
    this.shaped = new Float64Array(4);
    this.stage2 = new Float64Array(2);
    this.params = { enabled: false, driveDb: 0, fold: 0, folds: 2, oversample: true, routing: Routing.Stereo };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
    this.driveGain.prepare(fs);
    this.driveGain.snap(1);
    this.reset();
  }

  reset() {
    for (let i = 0; i < 2; i += 1) {
      this.upA[i].reset();
      this.upB[i].reset();
      this.downA[i].reset();
      this.downB[i].reset();
    }
  }

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);
    this.driveGain.setTarget(Math.pow(10, clamp(p.driveDb, 0, 40) * 0.05));
  }

  shape(x) {
    const clipped = softClip(x);
    if (this.params.fold <= 0) return clipped;
    const folded = wavefold(clipped, clamp(this.params.folds, 1, 8));
    return clipped + (folded - clipped) * clamp(this.params.fold, 0, 1);
  }

  /// 4x, as two cascaded 2x half-band stages.
  ///
  /// Each 2x step zero-stuffs — one real sample then one zero — which halves the
  /// average level, so the real sample is doubled going in to put it back.
  /// Decimation on the way down keeps the first of each pair, but both must
  /// still be *pushed through* the filter or its delay line desynchronises from
  /// the input and the whole thing turns into a comb.
  runOversampled(input, up, down) {
    const stage1 = this.stage1;
    const shaped = this.shaped;
    const stage2 = this.stage2;

    stage1[0] = up[0].process(input * 2);
    stage1[1] = up[0].process(0);

    for (let j = 0; j < 2; j += 1) {
      shaped[j * 2] = this.shape(up[1].process(stage1[j] * 2));
      shaped[j * 2 + 1] = this.shape(up[1].process(0));
    }

    for (let j = 0; j < 2; j += 1) {
      stage2[j] = down[1].process(shaped[j * 2]);
      down[1].process(shaped[j * 2 + 1]);
    }

    const out = down[0].process(stage2[0]);
    down[0].process(stage2[1]);
    return out;
  }

  process(buf, n) {
    if (this.idle()) return;

    const mode = this.params.routing;

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];
      const g = this.driveGain.next();

      splitIn(mode, dryX, dryY);
      const a = splitA * g;
      const b = splitB * g;

      let oa;
      let ob;

      if (this.params.oversample) {
        oa = this.runOversampled(a, this.upA, this.downA);
        ob = needsBoth(mode) ? this.runOversampled(b, this.upB, this.downB) : b;
      } else {
        oa = this.shape(a);
        ob = needsBoth(mode) ? this.shape(b) : b;
      }

      splitOut(mode, a, b, oa, ob);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;
    }
  }
}

class RingMod extends FxBlock {
  constructor() {
    super();
    this.phase = 0;
    this.inc = 0;
    this.params = { enabled: false, freq: 60, wave: 0, depth: 0, ratioLock: false, routing: Routing.Cross };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
    this.reset();
  }

  reset() {
    this.phase = 0;
  }

  setParams(p, sourceFreq) {
    this.params = p;
    this.setEnabled(p.enabled);

    // Ratio Lock ties the carrier to the source's own frequency, so the
    // modulation stands still relative to the figure instead of crawling through
    // it. Unlocked, the beat between the two is the interesting part.
    const carrier = p.ratioLock
      ? sourceFreq * Math.max(1, Math.round(p.freq / Math.max(sourceFreq, 0.01)))
      : p.freq;
    this.inc = clamp(carrier, 0.1, 2000) / this.fs;
  }

  process(buf, n) {
    if (this.idle()) return;

    const depth = clamp(this.params.depth, 0, 1);
    const mode = this.params.routing;

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      let carrier;
      switch (this.params.wave) {
        case 1: carrier = 1 - 4 * Math.abs(this.phase - 0.5); break;
        case 2: carrier = this.phase < 0.5 ? 1 : -1; break;
        default: carrier = Math.sin(TWO_PI * this.phase); break;
      }

      let x = dryX;
      let y = dryY;

      if (mode === Routing.Cross) {
        // Each axis modulated by the *other*, normalised. Free, and the best of
        // the routings: it produces a genuine warp of the figure that no affine
        // transform reaches.
        //
        // Note the normalisation. The naive x' = x*y, y' = y*x is the same
        // product on both axes, which collapses the whole figure onto the
        // diagonal — correct arithmetic, useless picture.
        const nx = clamp(dryX, -1, 1);
        const ny = clamp(dryY, -1, 1);
        x = dryX * (1 - depth + depth * ny);
        y = dryY * (1 - depth + depth * nx);
      } else {
        splitIn(mode, dryX, dryY);
        const a = splitA;
        const b = splitB;
        const m = 1 - depth + depth * carrier;
        splitOut(mode, a, b, a * m, needsBoth(mode) ? b * m : b);
        x = outX;
        y = outY;
      }

      this.blend(dryX, dryY, x, y);
      buf[s] = outX;
      buf[s + 1] = outY;

      this.phase += this.inc;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    }
  }
}

class Bitcrush extends FxBlock {
  constructor() {
    super();
    this.holdPhase = 1;
    this.heldA = 0;
    this.heldB = 0;
    this.params = { enabled: false, bits: 16, rateHz: 0, routing: Routing.Stereo };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
    this.reset();
  }

  reset() {
    this.holdPhase = 1;
    this.heldA = 0;
    this.heldB = 0;
  }

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);
  }

  process(buf, n) {
    if (this.idle()) return;

    const mode = this.params.routing;
    const bits = clamp(this.params.bits, 1, 16);
    const steps = 1 << (bits - 1);
    // Fractional, so the hold period is not forced to a whole number of samples
    // — otherwise the reduction ratio jumps in visible steps as the knob moves.
    const holdInc = this.params.rateHz > 0 ? clamp(this.params.rateHz, 100, this.fs) / this.fs : 1;

    // Quantising the beam's *position* onto a grid, which turns a circle into a
    // staircase of exactly 2^bits steps per axis. The connecting lines between
    // held points come from the slew limiter and the amplifier bandwidth, not
    // from here — which is why the "digital scope" look is a consequence of two
    // blocks rather than a mode of one.
    const quantise = (v) => (bits >= 16 ? v : Math.round(v * steps) / steps);

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      splitIn(mode, dryX, dryY);
      const a = splitA;
      const b = splitB;

      this.holdPhase += holdInc;
      if (this.holdPhase >= 1) {
        this.holdPhase -= Math.floor(this.holdPhase);
        this.heldA = a;
        this.heldB = b;
      }

      splitOut(mode, a, b, quantise(this.heldA), needsBoth(mode) ? quantise(this.heldB) : b);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;
    }
  }
}

/// Y's modulation runs a quarter cycle behind X's. This one constant is the
/// difference between "a soft double image" and "a smeared diagonal streak":
/// with both axes modulated in phase every delayed copy is displaced along the
/// 45-degree diagonal and the copies pile up into one blur.
const AXIS_PHASE_OFFSET = 0.25;

const PHASER_MAX_STAGES = 12;

class Phaser extends FxBlock {
  constructor() {
    super();
    this.stagesA = [];
    this.stagesB = [];
    for (let i = 0; i < PHASER_MAX_STAGES; i += 1) {
      this.stagesA.push(new Allpass1());
      this.stagesB.push(new Allpass1());
    }
    this.feedbackA = 0;
    this.feedbackB = 0;
    this.lfoPhase = 0;
    this.params = {
      enabled: false, stages: 4, rate: 0.3, depth: 0.7,
      centre: 800, feedback: 0.5, mix: 0.5, routing: Routing.XOnly,
    };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);
    this.reset();
  }

  reset() {
    for (let i = 0; i < PHASER_MAX_STAGES; i += 1) {
      this.stagesA[i].reset();
      this.stagesB[i].reset();
    }
    this.feedbackA = 0;
    this.feedbackB = 0;
    this.lfoPhase = 0;
  }

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);
  }

  process(buf, n) {
    if (this.idle()) return;

    const mode = this.params.routing;
    const stages = clamp(this.params.stages, 1, PHASER_MAX_STAGES);
    const depth = clamp(this.params.depth, 0, 1);
    const fb = clamp(this.params.feedback, 0, 0.95);
    const mix = clamp(this.params.mix, 0, 1);
    const inc = clamp(this.params.rate, 0.01, 10) / this.fs;
    const centre = clamp(this.params.centre, 100, 8000);

    // The sweep is exponential in frequency, because that is how the ear and the
    // eye both read it: a linear sweep spends most of its time at the top and
    // lurches through the bottom.
    const sweepAt = (phase) => centre * Math.pow(4, Math.sin(TWO_PI * phase) * depth);

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      splitIn(mode, dryX, dryY);
      const a = splitA;
      const b = splitB;

      const coeffA = allpassCoeff(sweepAt(this.lfoPhase), this.fs);
      const coeffB = allpassCoeff(sweepAt(this.lfoPhase + AXIS_PHASE_OFFSET), this.fs);

      let wetA = a + this.feedbackA * fb;
      for (let st = 0; st < stages; st += 1) wetA = this.stagesA[st].process(wetA, coeffA);
      this.feedbackA = wetA;

      let wetB = b;
      if (needsBoth(mode)) {
        wetB = b + this.feedbackB * fb;
        for (let st = 0; st < stages; st += 1) wetB = this.stagesB[st].process(wetB, coeffB);
        this.feedbackB = wetB;
      }

      // At Mix 1.0 there is no dry path, so there are no notches at all — only
      // pure phase shift, which between X and Y is exactly the rotation of a
      // Lissajous ellipse. That is a genuinely different instrument from Mix 0.5.
      const oa = a + (wetA - a) * mix;
      const ob = needsBoth(mode) ? b + (wetB - b) * mix : b;

      splitOut(mode, a, b, oa, ob);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;

      this.lfoPhase += inc;
      if (this.lfoPhase >= 1) this.lfoPhase -= Math.floor(this.lfoPhase);
    }
  }
}

const DelayTimeMode = { Repitch: 0, Crossfade: 1 };

/// 2^19 samples is 2.73 s at 192 kHz; the Time parameter tops out at 2.5 s so a
/// read can never wrap round into data the write pointer has not reached.
const DELAY_LENGTH = 1 << 19;

/**
 * The ghost repeats.
 *
 * **The feedback path is filtered**, one pole down at the top and one at the
 * bottom. That is what makes each repeat progressively smoother and
 * rounder-cornered than the last — a ghost is not a faded copy of the figure, it
 * is a *low-passed* copy, and a low-passed deflection signal has softer corners.
 * Nothing in the renderer has to know about it.
 *
 * **Feedback is allowed past 1.0**, with a `tanh` saturator in the loop, which
 * is exactly why a real analogue delay runs away into a howl and then sits there
 * rather than reaching infinity.
 */
class Delay extends FxBlock {
  constructor() {
    super();
    this.lineA = new DelayLine();
    this.lineB = new DelayLine();
    this.dampLowA = new OnePole();
    this.dampLowB = new OnePole();
    this.dampHighA = new OnePole();
    this.dampHighB = new OnePole();
    this.currentDelay = 0;
    this.targetDelay = 0;
    this.previousDelay = 0;
    this.fadePosition = 1;
    this.params = {
      enabled: false, timeMs: 250, feedback: 0.45, dampLowHz: 4000,
      dampHighHz: 100, mix: 0.4, routing: Routing.Stereo, timeMode: DelayTimeMode.Repitch,
    };
  }

  prepare(fs) {
    this.fs = fs;
    this.bypass.prepare(fs);

    this.lineA.prepare(DELAY_LENGTH);
    this.lineB.prepare(DELAY_LENGTH);
    this.dampLowA.prepare(fs);
    this.dampLowB.prepare(fs);
    this.dampHighA.prepare(fs);
    this.dampHighB.prepare(fs);

    this.currentDelay = 0.001 * 250 * fs;
    this.targetDelay = this.currentDelay;
    this.previousDelay = this.currentDelay;
    this.reset();
  }

  reset() {
    this.lineA.reset();
    this.lineB.reset();
    this.dampLowA.reset();
    this.dampLowB.reset();
    this.dampHighA.reset();
    this.dampHighB.reset();
    this.fadePosition = 1;
  }

  setParams(p) {
    this.params = p;
    this.setEnabled(p.enabled);

    this.dampLowA.setCutoff(p.dampLowHz);
    this.dampLowB.setCutoff(p.dampLowHz);
    this.dampHighA.setCutoff(p.dampHighHz);
    this.dampHighB.setCutoff(p.dampHighHz);

    const wanted = clamp(p.timeMs, 1, 2500) * 0.001 * this.fs;

    if (Math.abs(wanted - this.targetDelay) > 0.5) {
      if (p.timeMode === DelayTimeMode.Crossfade) {
        // Start a new fade from wherever the old pointer is now, so a second
        // change part-way through the first does not click.
        this.previousDelay = this.currentDelay;
        this.fadePosition = 0;
        this.currentDelay = wanted;
      }
      this.targetDelay = wanted;
    }

    // NOTE: no reset() here, and that is deliberate. Changing the time must not
    // drop the tail on the floor — a real pedal's bucket brigade keeps whatever
    // is in it. The fleet's GPU habit of rebuilding on a parameter change is the
    // opposite of what is correct on this side of the plugin.
  }

  process(buf, n) {
    if (this.idle()) return;

    const feedback = clamp(this.params.feedback, 0, 1.05);
    const mix = clamp(this.params.mix, 0, 1);

    // Repitch ramps the read pointer's rate over roughly 50 ms. The ghosts sweep
    // to their new position, resampling what is already in the line — which is
    // BBD behaviour, and the sweep is the point rather than an artefact to hide.
    const rampRate = 1 / (0.05 * this.fs);
    const fadeRate = 1 / (0.02 * this.fs);

    const pingPong = this.params.routing === Routing.PingPong;
    const mode = pingPong ? Routing.Stereo : this.params.routing;

    const read = (line) => {
      if (this.params.timeMode === DelayTimeMode.Crossfade && this.fadePosition < 1) {
        // Equal power, so the sum of the two tap levels stays constant through
        // the swap rather than dipping in the middle.
        const gOld = Math.cos(this.fadePosition * 1.5707963267948966);
        const gNew = Math.sin(this.fadePosition * 1.5707963267948966);
        return line.read(this.previousDelay) * gOld + line.read(this.currentDelay) * gNew;
      }
      return line.read(this.currentDelay);
    };

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      const dryX = buf[s];
      const dryY = buf[s + 1];

      splitIn(mode, dryX, dryY);
      const a = splitA;
      const b = splitB;

      if (this.params.timeMode === DelayTimeMode.Repitch) {
        const d = this.targetDelay - this.currentDelay;
        const step = Math.max(Math.abs(this.targetDelay), 1) * rampRate;
        this.currentDelay += clamp(d, -step, step);
      } else if (this.fadePosition < 1) {
        this.fadePosition = Math.min(1, this.fadePosition + fadeRate);
      }

      const wetA = read(this.lineA);
      const wetB = read(this.lineB);

      // Filter in the feedback path, not on the output: filtering the output
      // would dull every repeat equally, and what a real delay does is dull each
      // one a little more than the last, because the signal goes round again.
      let fbA = this.dampHighA.high(this.dampLowA.low(wetA));
      let fbB = this.dampHighB.high(this.dampLowB.low(wetB));

      // The saturator is what stops feedback above unity reaching infinity. It
      // is not a limiter bolted on — it is the same thing the electronics do.
      fbA = Math.tanh(fbA * feedback);
      fbB = Math.tanh(fbB * feedback);

      if (pingPong) {
        // Each axis's output feeds the other's input, so the ghost walks
        // diagonally across the screen, alternating sides.
        this.lineA.writeSample(a + fbB);
        this.lineB.writeSample(b + fbA);
      } else {
        this.lineA.writeSample(a + fbA);
        this.lineB.writeSample(b + fbB);
      }

      const oa = a + (wetA - a) * mix;
      const ob = needsBoth(mode) ? b + (wetB - b) * mix : b;

      splitOut(mode, a, b, oa, ob);
      this.blend(dryX, dryY, outX, outY);
      buf[s] = outX;
      buf[s + 1] = outY;
    }
  }
}

/**
 * The deflection amplifier. Not bypassable — there is always an amplifier.
 *
 * Its DC block is genuinely last, because the rectifier and the wavefolder both
 * manufacture DC and DC here is a permanent screen offset rather than a tonal
 * problem. Its slew limit and its bandwidth are what give the trace its corner
 * rounding at the very end, which is where a real machine puts them.
 */
class Output {
  constructor() {
    this.fs = 96000;
    this.dcX = new DcBlock();
    this.dcY = new DcBlock();
    this.bandX = new Svf();
    this.bandY = new Svf();
    this.slewX = 0;
    this.slewY = 0;
    this.gain = new Smooth();
    this.offsetX = new Smooth();
    this.offsetY = new Smooth();
    this.params = {
      gain: 1, offsetX: 0, offsetY: 0, rotation: 0, skew: 0,
      dcBlock: true, ampSlew: 20000, bandwidthX: 40000, bandwidthY: 10000, resonance: 0.707,
    };
  }

  prepare(fs) {
    this.fs = fs;
    this.dcX.prepare(fs);
    this.dcY.prepare(fs);
    this.bandX.prepare(fs);
    this.bandY.prepare(fs);
    this.gain.prepare(fs);
    this.offsetX.prepare(fs);
    this.offsetY.prepare(fs);
    this.gain.snap(1);
    this.offsetX.snap(0);
    this.offsetY.snap(0);
    this.reset();
    this.setParams(this.params);
  }

  reset() {
    this.dcX.reset();
    this.dcY.reset();
    this.bandX.reset();
    this.bandY.reset();
    this.slewX = 0;
    this.slewY = 0;
  }

  setParams(p) {
    this.params = p;
    this.gain.setTarget(p.gain);
    this.offsetX.setTarget(p.offsetX);
    this.offsetY.setTarget(p.offsetY);

    // The X amplifier in a real scope is faster than the Y one — the horizontal
    // channel drives the sweep and is built for it. Defaulting them differently
    // is not a preference, it is what the hardware is like, and it is why a fast
    // figure leans slightly.
    this.bandX.set(clamp(p.bandwidthX, 1000, this.fs * 0.49), p.resonance);
    this.bandY.set(clamp(p.bandwidthY, 1000, this.fs * 0.49), p.resonance);
  }

  process(buf, n) {
    const slewStep = Math.max(this.params.ampSlew, 1) / this.fs;

    const rot = this.params.rotation * TWO_PI;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const skew = this.params.skew;

    for (let i = 0; i < n; i += 1) {
      const s = i * 4;
      let x = buf[s];
      let y = buf[s + 1];

      if (this.params.dcBlock) {
        x = this.dcX.process(x);
        y = this.dcY.process(y);
      }

      // Geometry: skew then rotate. Both are properties of how the yoke is
      // mounted and wound, which is why they live in the amplifier.
      x += y * skew;
      const rx = x * cosR - y * sinR;
      const ry = x * sinR + y * cosR;
      x = rx;
      y = ry;

      const g = this.gain.next();
      x = x * g + this.offsetX.next();
      y = y * g + this.offsetY.next();

      // The amplifier cannot move the beam infinitely fast. This is what rounds
      // the corner of a square at the very last moment, and it is also the
      // plugin's backstop against a pathological segment.
      x = this.slewX + clamp(x - this.slewX, -slewStep, slewStep);
      y = this.slewY + clamp(y - this.slewY, -slewStep, slewStep);
      this.slewX = x;
      this.slewY = y;

      // And it has finite bandwidth, which softens what the slew limit left.
      buf[s] = this.bandX.low(x);
      buf[s + 1] = this.bandY.low(y);
    }
  }
}

//---------------------------------------------------------------------------
// The engine — signal/Engine.cpp, with the pedalboard's fixed order.
//---------------------------------------------------------------------------

const SourceKind = { Oscillator: 0, Shape: 1 };

const DETAIL_RATES = [48000, 96000, 192000];

class Engine {
  constructor() {
    this.fs = 96000;
    this.detail = 1;
    this.kind = SourceKind.Oscillator;
    this.block = new Float32Array(MAX_BLOCK * 4);

    this.oscillator = new Oscillator();
    this.shapes = new Shapes();

    // The pedalboard, in the plugin's order. Not user-reorderable: fourteen
    // blocks is fourteen factorial orderings and "what order are my pedals in"
    // is the first thing anyone gets wrong.
    this.rectifier = new Rectifier();
    this.slew = new Slew();
    this.drive = new Drive();
    this.ringMod = new RingMod();
    this.bitcrush = new Bitcrush();
    this.phaser = new Phaser();
    this.delay = new Delay();
    this.output = new Output();

    this.pedals = [
      this.rectifier, this.slew, this.drive, this.ringMod,
      this.bitcrush, this.phaser, this.delay, this.output,
    ];

    this.prepare(1);
  }

  prepare(detail) {
    this.detail = detail;
    this.fs = DETAIL_RATES[clamp(detail, 0, 2)];

    this.oscillator.prepare(this.fs);
    this.shapes.prepare(this.fs);
    for (const block of this.pedals) block.prepare(this.fs);
  }

  reset() {
    this.oscillator.reset();
    this.shapes.reset();
    for (const block of this.pedals) block.reset();
  }

  setParams(r) {
    // A change of sample rate rebuilds every buffer, so it is the one parameter
    // that genuinely cannot be applied mid-block. Detail is a dropdown partly
    // for this reason.
    if (r.detail !== this.detail) this.prepare(r.detail);

    this.kind = r.source;

    this.oscillator.setParams(r.oscillator);
    this.oscillator.setSeed(r.seed);
    this.shapes.setParams(r.shape);

    this.rectifier.setParams(r.chain.rectifier);
    this.slew.setParams(r.chain.slew);
    this.drive.setParams(r.chain.drive);
    this.ringMod.setParams(r.chain.ringMod, r.chain.sourceFreq);
    this.bitcrush.setParams(r.chain.bitcrush);
    this.phaser.setParams(r.chain.phaser);
    this.delay.setParams(r.chain.delay);
    this.output.setParams(r.chain.output);
  }

  render(n, frameSeconds) {
    n = clamp(n, 2, MAX_BLOCK);

    // dt per sample comes from the frame's real duration divided by the samples
    // being made for it, NOT from 1/fs. The two differ whenever the frame rate
    // and the sample count disagree — a dropped frame, a scrub, a browser
    // throttling a background tab — and it is this value, carried in every
    // sample, that keeps the trace's brightness independent of all of that.
    const dt = frameSeconds / (n - 1);

    if (this.kind === SourceKind.Shape) this.shapes.render(this.block, n, dt);
    else this.oscillator.render(this.block, n, dt);

    for (const block of this.pedals) block.process(this.block, n);

    return this.block;
  }
}

//===========================================================================
// Phosphor — a port of render/Phosphor.cpp.
//
// A measured table, not a set of tints. Two consequences read as bugs to anyone
// who has not read that file: **P31 at persistence x1 shows no trail at 60 fps**,
// because its decay constant is sixteen microseconds and a frame is sixteen
// milliseconds; and **changing phosphor changes the brightness by up to three
// times**, because P11's luminous efficiency really is about a third of P31's.
//===========================================================================

const PHOSPHORS = [
  // P31 — ZnS:Cu. The standard oscilloscope phosphor and the reference for
  // everything else. 520 nm, very efficient, and fast: 38 us to 10%.
  { name: 'P31', tauFast: 16.0e-6, fast: [0.18, 1.0, 0.38], tauSlow: 400.0e-6, slow: [0.22, 1.0, 0.42], transfer: 0.02, efficiency: 1.0, saturation: 12.0 },
  // P1 — willemite. The pre-war medium-persistence green, 24 ms to 10%, single
  // layer: what you see is one exponential and nothing else.
  { name: 'P1', tauFast: 10.4e-3, fast: [0.22, 1.0, 0.34], tauSlow: 0, slow: [0, 0, 0], transfer: 0, efficiency: 0.55, saturation: 6.0 },
  // P2 — a fast blue-green component with a slower yellow-green one behind it
  // and a heavy transfer between them.
  { name: 'P2', tauFast: 15.0e-3, fast: [0.30, 1.0, 0.40], tauSlow: 52.0e-3, slow: [0.55, 1.0, 0.22], transfer: 0.35, efficiency: 0.62, saturation: 6.0 },
  // P7 — the long-persistence cascade screen, and the reason this renderer has
  // two layers at all. A blue 440 nm flash sitting on a yellow-green 558 nm
  // layer it pumps optically: the strike is blue, the trail is yellow-green, and
  // no amount of tinting one decay gets you that.
  { name: 'P7', tauFast: 39.0e-6, fast: [0.28, 0.38, 1.0], tauSlow: 174.0e-3, slow: [0.72, 1.0, 0.20], transfer: 0.75, efficiency: 0.48, saturation: 4.0 },
  // P11 — ZnS:Ag, the photographic blue: made to expose film, not to be looked
  // at, which is why its luminous efficiency is a third of P31's.
  { name: 'P11', tauFast: 22.0e-6, fast: [0.22, 0.42, 1.0], tauSlow: 0, slow: [0, 0, 0], transfer: 0, efficiency: 0.35, saturation: 8.0 },
  // P39 — long-persistence green, 150 ms to 10%. The storage-scope and radar
  // phosphor. Saturates early and burns, which is the same property twice.
  { name: 'P39', tauFast: 65.0e-3, fast: [0.24, 1.0, 0.32], tauSlow: 0, slow: [0, 0, 0], transfer: 0, efficiency: 0.85, saturation: 3.0 },
];

const PHOSPHOR_NAMES = [
  'P31 Green', 'P1 Green', 'P2 Long Green', 'P7 Blue/Amber', 'P11 Blue', 'P39 Very Long',
];

/// A decay factor of exactly 1 is a buffer that never empties, and the operator
/// has no way back from it short of deleting the effect.
const MAX_DECAY = 0.9995;

function decayFactor(tau, frameSeconds) {
  if (!(tau > 0) || !(frameSeconds > 0)) return 0;
  // No guard on the exponent's magnitude: exp() of a large negative number
  // underflows to zero, which is the correct answer — a phosphor whose tau is a
  // thousandth of a frame really has gone out.
  return clamp(Math.exp(-frameSeconds / tau), 0, MAX_DECAY);
}

function decayFor(spec, persistence, frameSeconds) {
  const mult = Math.max(persistence, 1e-4);
  const fast = decayFactor(spec.tauFast * mult, frameSeconds);

  // A phosphor with no second layer gets a zero decay and a zero transfer, not a
  // tiny one. Otherwise the slow channel accumulates a hundredth of the trace
  // every frame and never quite lets go of it.
  if (spec.tauSlow > 0 && spec.transfer > 0) {
    return { fast, slow: decayFactor(spec.tauSlow * mult, frameSeconds), transfer: clamp(spec.transfer, 0, 1) };
  }
  return { fast, slow: 0, transfer: 0 };
}

/// x0.1 to x1000: four decades, with x1 a quarter of the way up. Interpolated in
/// the log, so the control's feel is the same everywhere along it.
const persistenceMultiplier = (normalised) => Math.pow(10, -1 + 4 * clamp(normalised, 0, 1));

//===========================================================================
// The face — a port of render/Tube.cpp.
//===========================================================================

/// The rungs the face buffer is allowed to sit on. Reallocating it throws away
/// the phosphor history — the trail vanishes and the picture flashes — so an
/// operator dragging Focus would otherwise cross a boundary on almost every
/// mouse move. On the ladder they cross four in the whole travel.
const FACE_LADDER = [512, 768, 1024, 1440, 2160];

/// Texels per sigma below which the spot is visibly a polygon.
const TEXELS_PER_SIGMA = 3;

/// The same rounded-rectangle signed distance the glass shader evaluates, on the
/// CPU, so the graticule is solved against the shape that is actually drawn.
function faceDistance(px, py, halfX, halfY, radius) {
  const qx = Math.abs(px) - (halfX - radius);
  const qy = Math.abs(py) - (halfY - radius);
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  return Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - radius;
}

function faceSizeFor(spotFraction, outputHeight) {
  const fraction = Math.max(spotFraction, 1e-4);
  const wanted = Math.ceil(TEXELS_PER_SIGMA / fraction);

  // Up to the first rung that is big enough; the top rung if nothing is.
  let chosen = FACE_LADDER[FACE_LADDER.length - 1];
  for (const rung of FACE_LADDER) {
    if (rung >= wanted) {
      chosen = rung;
      break;
    }
  }

  // And down to the largest rung the output can actually show. Capping to the
  // output height itself would take the result off the ladder, and every Focus
  // change near that boundary would then flash.
  let cap = FACE_LADDER[0];
  for (const rung of FACE_LADDER) {
    if (rung <= outputHeight) cap = rung;
  }

  return Math.min(chosen, cap);
}

const faceWidthFor = (faceHeight, faceAspect) =>
  Math.max(1, Math.round(faceHeight * clamp(faceAspect, 0.05, 20)));

/// Beam units to square output units: whichever constraint binds — width on a
/// wide face in a narrow frame, height otherwise.
const faceFitScale = (outputAspect, faceAspect) =>
  Math.min(Math.max(outputAspect, 1e-4) / Math.max(faceAspect, 1e-4), 1);

/**
 * The size of one graticule division in beam units, for a 10 by 8 graticule
 * inscribed in this face.
 *
 * Bisected rather than solved. The distance field is piecewise — flat side,
 * corner arc, interior — so a closed form needs three cases and a test for which
 * one the corner lands in, and getting that test wrong on one face shape would
 * put the graticule slightly off the glass in a way that looks like a rounding
 * error rather than like a bug.
 */
function graticuleDivision(tube) {
  const halfX = Math.max(tube.faceAspect, 1e-4);
  const halfY = 1;
  const radius = clamp(tube.cornerRadius, 0, 1) * Math.min(halfX, halfY);

  let lo = 0;
  let hi = 2 * Math.max(halfX, halfY);
  for (let i = 0; i < 30; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (faceDistance(5 * mid, 4 * mid, halfX, halfY, radius) < 0) lo = mid;
    else hi = mid;
  }

  // On a square face at radius 1 the field is length(p) - 1, so this converges
  // on 1/sqrt(41) and the graticule's half-width is 10/sqrt(164) — the inscribed
  // rectangle every scope face has ever used.
  return 0.5 * (lo + hi);
}

//===========================================================================
// Controls — a port of source/Controls.cpp.
//
// Every continuous host parameter is 0..1 and mapped here, and that is not a
// stylistic choice: `SetParamInfo` clamps a STANDARD default into 0..1 *before*
// `SetParamRange` can widen it, so a parameter declared in hertz cannot declare
// a default in hertz.
//===========================================================================

/// An option parameter holds its element *value*, not a 0..1 fraction, so it is
/// rounded rather than scaled. Getting this backwards gives a dropdown
/// permanently stuck on its first entry.
const option = (value, count) => clamp(Math.round(value), 0, count - 1);

/// Exponential, for anything measured in hertz or seconds where the useful range
/// spans decades and a linear slider would spend nine tenths of its travel in
/// the top octave.
const expo = (value, low, high) => low * Math.pow(high / low, clamp(value, 0, 1));

const linear = (value, low, high) => low + (high - low) * clamp(value, 0, 1);

const boolean = (v) => v > 0.5;

/// The bottom of the Beam control's travel, over which the exponential is faded
/// linearly to a true zero. Short enough that it costs no useful resolution and
/// long enough that the gun goes out smoothly rather than snapping off.
const BEAM_OFF_RAMP = 0.02;

const ROUTING_NAMES = ['Stereo', 'X Only', 'Y Only', 'Mid/Side', 'Mono', 'Cross', 'Ping-Pong'];
const WAVE_NAMES = ['Sine', 'Triangle', 'Saw', 'Ramp', 'Pulse', 'Noise', 'Sample & Hold'];
const SHAPE_NAMES = ['Circle', 'Square', 'Diamond', 'Polygon', 'Star', 'Rose', 'Spirograph'];
const DETAIL_NAMES = ['Draft', 'Normal', 'Fine'];

/// The integer-typed parameters. FF_TYPE_INTEGER is exempt from the 0..1 clamp,
/// so the plugin stores these as the integer itself — and the demo kit has no
/// integer control, so they are dropdowns of their own values here. The index
/// into the dropdown is not the plugin's value; `integers()` converts.
const INTEGER_RANGES = {
  sides: [3, 24],
  petalN: [1, 12],
  petalD: [1, 12],
  driveFolds: [1, 8],
  crushBits: [1, 16],
  phaseStages: [1, 12],
};

const INTEGER_ELEMENTS = {};
for (const [id, [low, high]] of Object.entries(INTEGER_RANGES)) {
  INTEGER_ELEMENTS[id] = [];
  for (let v = low; v <= high; v += 1) INTEGER_ELEMENTS[id].push(String(v));
}

const integerElements = (id) => INTEGER_ELEMENTS[id];

/// A dropdown index back to the plugin's own integer, and the reverse.
const integerValue = (id, index) => INTEGER_RANGES[id][0] + option(index, INTEGER_ELEMENTS[id].length);
const integerDefault = (id, value) => value - INTEGER_RANGES[id][0];

function resolve(params, variant) {
  const p = (id) => params.get(id);
  const int = (id) => integerValue(id, p(id));
  const routing = (id) => option(p(id), ROUTING_NAMES.length);

  const r = {
    detail: option(p('detail'), 3),
    source: option(p('source'), 2),
    seed: 1 + Math.round(clamp(p('seed'), 0, 1) * 9998),
    oscillator: {
      waveX: option(p('waveX'), 7),
      waveY: option(p('waveY'), 7),
      freqX: expo(p('freqX'), 0.01, 2000),
      ratioIndex: option(p('ratio'), RATIOS.length),
      freeY: boolean(p('freeY')),
      freqY: expo(p('freqY'), 0.01, 2000),
      phaseY: clamp(p('phaseY'), 0, 1),
      pwmX: linear(p('pwmX'), 0.02, 0.98),
      pwmY: linear(p('pwmY'), 0.02, 0.98),
      detune: linear(p('detune'), -0.02, 0.02),
      hardSync: boolean(p('hardSync')),
      blankRetrace: boolean(p('blankRetrace')),
    },
    shape: {
      kind: option(p('shape'), 7),
      rate: expo(p('shapeRate'), 0.01, 200),
      sides: int('sides'),
      inner: clamp(p('inner'), 0.05, 0.95),
      petalN: int('petalN'),
      petalD: int('petalD'),
      trochoid: linear(p('trochoid'), 0, 1.5),
    },
    chain: {
      rectifier: {
        enabled: boolean(p('rectOn')),
        fullWave: boolean(p('rectMode')),
        bias: linear(p('rectBias'), -1, 1),
        routing: routing('rectRouting'),
      },
      slew: {
        enabled: boolean(p('slewOn')),
        rise: expo(p('slewRise'), 0.5, 5000),
        fall: expo(p('slewFall'), 0.5, 5000),
        link: boolean(p('slewLink')),
        routing: routing('slewRouting'),
      },
      drive: {
        enabled: boolean(p('driveOn')),
        driveDb: linear(p('driveAmount'), 0, 40),
        fold: clamp(p('driveFold'), 0, 1),
        folds: int('driveFolds'),
        oversample: boolean(p('driveOversample')),
        routing: routing('driveRouting'),
      },
      ringMod: {
        enabled: boolean(p('ringOn')),
        freq: expo(p('ringFreq'), 0.1, 2000),
        wave: option(p('ringWave'), 3),
        depth: clamp(p('ringDepth'), 0, 1),
        ratioLock: boolean(p('ringLock')),
        routing: routing('ringRouting'),
      },
      bitcrush: {
        enabled: boolean(p('crushOn')),
        bits: int('crushBits'),
        // At the top of its travel the rate reducer is off, not merely fast: an
        // "almost off" sample-and-hold still beats against the source and crawls.
        rateHz: p('crushRate') >= 0.999 ? 0 : expo(p('crushRate'), 100, 48000),
        routing: routing('crushRouting'),
      },
      phaser: {
        enabled: boolean(p('phaseOn')),
        stages: int('phaseStages'),
        rate: expo(p('phaseRate'), 0.01, 10),
        depth: clamp(p('phaseDepth'), 0, 1),
        centre: expo(p('phaseCentre'), 100, 8000),
        feedback: linear(p('phaseFeedback'), 0, 0.95),
        mix: clamp(p('phaseMix'), 0, 1),
        routing: routing('phaseRouting'),
      },
      delay: {
        enabled: boolean(p('delayOn')),
        timeMs: expo(p('delayTime'), 1, 2500),
        feedback: linear(p('delayFeedback'), 0, 1.05),
        dampLowHz: expo(p('delayDampLow'), 200, 20000),
        dampHighHz: expo(p('delayDampHigh'), 20, 1000),
        mix: clamp(p('delayMix'), 0, 1),
        routing: routing('delayRouting'),
        timeMode: boolean(p('delayTimeMode')) ? DelayTimeMode.Crossfade : DelayTimeMode.Repitch,
      },
      output: {
        gain: linear(p('outGain'), 0, 2),
        offsetX: linear(p('outOffsetX'), -1, 1),
        offsetY: linear(p('outOffsetY'), -1, 1),
        rotation: linear(p('outRotation'), -0.5, 0.5),
        skew: linear(p('outSkew'), -1, 1),
        dcBlock: boolean(p('outDc')),
        ampSlew: expo(p('outSlew'), 100, 200000),
        bandwidthX: expo(p('outBandwidthX'), 1000, 80000),
        bandwidthY: expo(p('outBandwidthY'), 1000, 80000),
        resonance: linear(p('outResonance'), 0.5, 4),
      },
      sourceFreq: 0,
    },
    mix: clamp(p('mix'), 0, 1),
  };

  // The ring modulator's Ratio Lock needs to know what the source is doing.
  r.chain.sourceFreq = r.source === SourceKind.Shape ? r.shape.rate : r.oscillator.freqX;

  // The renderer's half, in the same physical units BeamGeometry::RenderParams
  // uses. Exponential around a calibrated 1.0 for the beam, because the useful
  // range is wide — with the linear fade over the bottom of the travel that
  // gives it a genuine off position. That fade is not cosmetic: an exponential
  // alone bottoms out at a tenth of nominal and never reaches zero, so "Beam 0"
  // would leave the gun on and the effect build's exact passthrough would be
  // unreachable through the parameter list.
  const beam = clamp(p('beamPower'), 0, 1);
  r.render = {
    beamPower: Math.pow(10, -1 + 2 * beam) * Math.min(1, beam / BEAM_OFF_RAMP),
    spotSigma: expo(p('beamFocus'), 0.0012, 0.02),
    spotDefocus: linear(p('beamDefocus'), 0, 2),
    blankFloor: linear(p('blankFloor'), 0, 0.1),
    densityFloor: 1.0e-4,
    phosphor: option(p('phosphor'), PHOSPHORS.length),
    // Through the persistence curve rather than a second copy of it: a duplicate
    // mapping is how the control and the table drift apart.
    persistence: persistenceMultiplier(clamp(p('persistence'), 0, 1)),
    // Halation runs to 4x, not to 1, and the bright pass's knee is at 0.04 and
    // not at the header's 0.5. Both are calibration rather than taste: at the
    // old pair the threshold sat above anything an ordinary picture puts on the
    // glass, so the pass found nothing, and both halation controls were
    // measurably dead — a sweep moved 124 subpixels of a two-megapixel frame by
    // one part in 255. They move 14056 now.
    halation: linear(p('halation'), 0, 4),
    halationRadius: clamp(p('halationRadius'), 0, 1),
    halationThreshold: 0.04,
    tube: {
      faceAspect: expo(p('faceAspect'), 1, 2),
      cornerRadius: clamp(p('cornerRadius'), 0, 1),
      deflectionGain: linear(p('deflectionGain'), 0.4, 1.4),
      curvature: linear(p('curvature'), 0, 0.6),
      vignette: clamp(p('vignette'), 0, 1),
    },
    graticule: clamp(p('graticule'), 0, 1),
    graticuleColour: [0.30, 0.42, 0.38],
    filterTransmission: [0.10, 0.16, 0.11],
    faceBlack: clamp(p('faceBlack'), 0, 1),
    opacity: r.mix,
    hasClip: variant === 'effect',
  };

  // The contrast filter, interpolated between clear glass and a filter the
  // colour of the phosphor — which is how a real scope's filter kills ambient
  // light without killing the trace.
  const tint = clamp(p('filterTint'), 0, 1);
  for (let c = 0; c < 3; c += 1) {
    r.render.filterTransmission[c] = 1 - tint * (1 - r.render.filterTransmission[c]);
  }

  return r;
}

//===========================================================================
// The renderer: the same six passes, in the same order, as
// BeamGeometry::Render.
//
//   1. Decay      the phosphor buffer into the other one, two layers with a
//                 cascade between them.
//   2. Trace      one instanced quad per interval, additive, into the target the
//                 decay just wrote — so there is no third buffer and no combine.
//   3. Bright     emission plus graticule, thresholded, at quarter size.
//   4/5. Blur     separable Gaussian, ping-ponged, one to three times.
//   6. Glass      the faceplate, the clip behind it, onto the canvas.
//===========================================================================

/// A runaway cannot be allowed to climb until it reaches the top of a 32-bit
/// float and turns into an inf. Well below that, and far above anything the
/// saturation curve will let through, so it never shapes a picture.
const EXCITATION_CEILING = 1.0e6;

function createRenderer(gl, quad) {
  const traceShader = new Program(
    gl,
    vertexSource(TRACE_VERTEX_BODY),
    fragmentSource(TRACE_FRAGMENT_BODY),
    'trace',
    // The trace sources its own geometry: two vec4 instance attributes, not the
    // screen quad's position and uv.
    { attribs: { sampleA: 0, sampleB: 1 } },
  );
  const decayShader = new Program(gl, SCREEN_VERTEX, fragmentSource(DECAY_FRAGMENT_BODY), 'decay');
  const brightShader = new Program(gl, SCREEN_VERTEX, fragmentSource(BRIGHT_FRAGMENT_BODY), 'halation bright pass');
  const blurShader = new Program(gl, SCREEN_VERTEX, fragmentSource(BLUR_FRAGMENT_BODY), 'halation blur');
  const glassShader = new Program(gl, SCREEN_VERTEX, fragmentSource(GLASS_FRAGMENT_BODY), 'glass');

  const phosphorBuffer = [new PassBuffer(gl), new PassBuffer(gl)];
  const bloomBuffer = [new PassBuffer(gl), new PassBuffer(gl)];

  //-----------------------------------------------------------------------
  // One buffer of samples, read twice.
  //
  // Attribute 0 starts at the beginning and attribute 1 one element in, so
  // instance i sees sample i and sample i+1 with nothing duplicated and half the
  // bandwidth of an expanded segment list. It costs one thing: the draw must ask
  // for n-1 instances, because n instances would read one sample past the end.
  //
  // vertexAttribDivisor is VAO state, not global state, so it has to be set with
  // this VAO bound. Set it with the wrong one bound and the attributes silently
  // become per-vertex, which looks like corrupt geometry.
  //-----------------------------------------------------------------------
  const traceVAO = gl.createVertexArray();
  const traceVBO = gl.createBuffer();

  gl.bindVertexArray(traceVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, traceVBO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 16);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const engine = new Engine();

  let phosphorIndex = 0;
  let lastTime = null;
  let lastReset = 0;

  /// Uniforms declared by the shared fragment prelude, and therefore needed by
  /// every pass that turns excitation into light.
  function setPreludeUniforms(shader, rp, graticuleLevel, graticuleDiv) {
    const spec = PHOSPHORS[clamp(rp.phosphor, 0, PHOSPHORS.length - 1)];
    shader.set('FastColour', spec.fast);
    shader.set('SlowColour', spec.slow);
    shader.set('PhosphorEfficiency', spec.efficiency);
    shader.set('PhosphorSaturation', Math.max(spec.saturation, 1e-4));
    shader.set('GraticuleLevel', graticuleLevel);
    shader.set('GraticuleDiv', graticuleDiv);
    shader.set('GraticuleColour', rp.graticuleColour);
  }

  return {
    render({ input, params, width, height, time, variant }) {
      //------------------------------------------------------------------
      // The clock. Clock.cpp's job, and its clamp is not optional: an
      // unclamped delta after a stalled tab asks the engine for half a second
      // of audio in one block, which is a thirty times energy deposit and a
      // white flash.
      //------------------------------------------------------------------
      const raw = lastTime === null ? 1 / 60 : time - lastTime;
      lastTime = time;
      const frameSeconds = clamp(raw, 1 / 240, 1 / 24);

      const resolved = resolve(params, variant);
      const rp = resolved.render;

      // Reset is FF_TYPE_EVENT in the plugin and the kit has no event control,
      // so it is a toggle here and every change of it is a press.
      const resetNow = params.get('reset');
      let clearHistory = resetNow !== lastReset;
      lastReset = resetNow;
      if (clearHistory) engine.reset();

      engine.setParams(resolved);

      const n = clamp(Math.round(frameSeconds * engine.fs), 2, MAX_BLOCK);
      const samples = engine.render(n, frameSeconds);
      const segmentCount = Math.max(0, n - 1);

      //------------------------------------------------------------------
      // Buffers. Sized by the spot, not by the composition — see Tube.h.
      //------------------------------------------------------------------
      const spotSigma = Math.max(rp.spotSigma, 1e-5);
      // Beam units run to 1 at half the face height, so a sigma expressed in
      // them is twice its fraction of the full height. The *undefocused* sigma
      // sets the resolution, because it is the smallest.
      const spotFraction = spotSigma * 0.5;

      const faceAspect = Math.max(rp.tube.faceAspect, 0.05);
      const faceH = faceSizeFor(spotFraction, height);
      const faceW = faceWidthFor(faceH, faceAspect);
      const bloomW = Math.max(1, Math.floor(faceW / 4));
      const bloomH = Math.max(1, Math.floor(faceH / 4));

      // RG32F and not RGBA16F. The two channels are excitations that accumulate
      // over hundreds of frames on a long phosphor, and half-float runs out of
      // mantissa exactly where a bright dwell has been building for a while —
      // the accumulator stops climbing and the brightest part of the picture is
      // the part that stops responding.
      const reallocated = phosphorBuffer[0].width !== faceW || phosphorBuffer[0].height !== faceH;
      phosphorBuffer[0].ensure(faceW, faceH, gl.RG32F);
      phosphorBuffer[1].ensure(faceW, faceH, gl.RG32F);
      bloomBuffer[0].ensure(bloomW, bloomH, gl.RGBA16F);
      bloomBuffer[1].ensure(bloomW, bloomH, gl.RGBA16F);

      // A fresh allocation has no history in it, and the plugin's ScopeBuffer
      // clears on the way in for the same reason.
      if (reallocated) clearHistory = true;

      if (clearHistory) {
        phosphorBuffer[0].clearTo(0, 0, 0, 0);
        phosphorBuffer[1].clearTo(0, 0, 0, 0);
      }

      const target = phosphorIndex;
      const history = 1 - phosphorIndex;

      //------------------------------------------------------------------
      // Everything the shape of the face implies, worked out once.
      //------------------------------------------------------------------
      const outputAspect = width / height;
      const faceFit = faceFitScale(outputAspect, faceAspect);
      const division = graticuleDivision(rp.tube);

      // One square output unit is half the output height in pixels, so this is
      // how many output pixels a division is worth. Below about three of them
      // the graticule is a moire generator rather than a graticule, so it fades
      // — and it fades on this one number rather than on each pass's own
      // derivative, because the bright pass runs at quarter size and a local
      // fade would take the halo away two rungs before the sharp copy.
      const pixelsPerDivision = division * faceFit * height * 0.5;
      const graticuleLevel = Math.max(rp.graticule, 0) * smoothstep01(2, 4, pixelsPerDivision);

      const decay = decayFor(PHOSPHORS[clamp(rp.phosphor, 0, PHOSPHORS.length - 1)], rp.persistence, Math.max(frameSeconds, 1.0e-5));

      //------------------------------------------------------------------
      // Upload the block. STREAM_DRAW and a fresh bufferData every frame: the
      // whole point is that the driver orphans the old storage rather than
      // waiting for the previous frame's draw to finish reading it.
      //------------------------------------------------------------------
      gl.bindBuffer(gl.ARRAY_BUFFER, traceVBO);
      gl.bufferData(gl.ARRAY_BUFFER, samples.subarray(0, n * 4), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      //------------------------------------------------------------------
      // 1 and 2. Decay, then deposit, into the same target.
      //------------------------------------------------------------------
      phosphorBuffer[target].bind();

      gl.disable(gl.BLEND);
      decayShader.use();
      bindTexture(gl, 0, phosphorBuffer[history].texture);
      decayShader.setSampler('HistoryTexture', 0);
      decayShader.set('DecayFast', decay.fast);
      decayShader.set('DecaySlow', decay.slow);
      decayShader.set('Transfer', decay.transfer);
      decayShader.set('Ceiling', EXCITATION_CEILING);
      quad.draw();

      if (segmentCount > 0 && rp.beamPower > 0) {
        // Sum, not max(). This input is a *deposit*: the energy one interval of
        // beam put on the glass. Two intervals crossing the same texel really
        // did put twice the energy there, and a max() would silently throw away
        // every crossing in the figure — which is exactly where an oscilloscope
        // trace is brightest.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);

        traceShader.use();
        traceShader.set('BeamPower', rp.beamPower);
        traceShader.set('SpotSigma', spotSigma);
        traceShader.set('SpotDefocus', Math.max(rp.spotDefocus, 0));
        traceShader.set('BlankFloor', clamp(rp.blankFloor, 0, 1));
        traceShader.set('DensityFloor', Math.max(rp.densityFloor, 0));
        traceShader.set('DeflectionGain', rp.tube.deflectionGain);
        traceShader.set('FaceAspect', faceAspect);

        gl.bindVertexArray(traceVAO);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, segmentCount);
        gl.bindVertexArray(null);

        gl.disable(gl.BLEND);
      }

      //------------------------------------------------------------------
      // 3 to 5. Halation, all at quarter size.
      //------------------------------------------------------------------
      const useHalation = rp.halation > 0.001;
      if (useHalation) {
        bloomBuffer[0].bind();
        gl.disable(gl.BLEND);
        brightShader.use();
        bindTexture(gl, 0, phosphorBuffer[target].texture);
        setPreludeUniforms(brightShader, rp, graticuleLevel, division);
        brightShader.setSampler('PhosphorTexture', 0);
        brightShader.set('SourceSize', faceW, faceH);
        brightShader.set('FaceHalf', faceAspect, 1);
        brightShader.set('Threshold', rp.halationThreshold);
        quad.draw();

        // One iteration is a tight halo, three is a wide soft one, and three is
        // also the ceiling: past three the halo is wider than the face and stops
        // being scattering in glass at all.
        const iterations = clamp(1 + Math.round(2 * clamp(rp.halationRadius, 0, 1)), 1, 3);

        for (let i = 0; i < iterations; i += 1) {
          // Across then down, so every iteration ends back in bloomBuffer[0] and
          // the glass pass never has to ask which one it landed in.
          const blurs = [
            { from: 0, to: 1, dx: 1 / bloomW, dy: 0 },
            { from: 1, to: 0, dx: 0, dy: 1 / bloomH },
          ];
          for (const pass of blurs) {
            bloomBuffer[pass.to].bind();
            gl.disable(gl.BLEND);
            blurShader.use();
            bindTexture(gl, 0, bloomBuffer[pass.from].texture);
            blurShader.setSampler('SourceTexture', 0);
            blurShader.set('Direction', pass.dx, pass.dy);
            quad.draw();
          }
        }
      }

      //------------------------------------------------------------------
      // 6. The glass, straight onto the canvas.
      //------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);

      // Blending off. This pass writes the layer's whole content, premultiplied
      // and with its own alpha; compositing that is the host's job.
      gl.disable(gl.BLEND);

      glassShader.use();
      bindTexture(gl, 0, phosphorBuffer[target].texture);
      bindTexture(gl, 1, bloomBuffer[0].texture);
      // The source build never samples ClipTexture, but the sampler is still
      // declared and still bound to a unit, and pointing an unused unit at a
      // texture that does exist costs nothing and says nothing.
      bindTexture(gl, 2, rp.hasClip ? input.texture : phosphorBuffer[target].texture);

      setPreludeUniforms(glassShader, rp, graticuleLevel, division);
      glassShader.setSampler('PhosphorTexture', 0);
      glassShader.setSampler('BloomTexture', 1);
      glassShader.setSampler('ClipTexture', 2);

      glassShader.set('OutputSize', width, height);
      glassShader.set('FaceHalf', faceAspect, 1);
      glassShader.set('FaceFit', faceFit);
      glassShader.set('CornerRadius', clamp(rp.tube.cornerRadius, 0, 1));
      glassShader.set('Curvature', Math.max(rp.tube.curvature, 0));
      glassShader.set('Vignette', clamp(rp.tube.vignette, 0, 1));
      glassShader.set('Halation', useHalation ? rp.halation : 0);

      // No perspective control is exposed yet, and these are set explicitly to
      // zero rather than left unset: an unset uniform is zero on every driver
      // anybody has, and is guaranteed by nobody.
      glassShader.set('PerspectiveX', 0);
      glassShader.set('PerspectiveY', 0);

      glassShader.set('FilterTransmission', rp.filterTransmission);
      glassShader.set('FaceBlack', clamp(rp.faceBlack, 0, 1));
      glassShader.set('Opacity', clamp(rp.opacity, 0, 1));

      glassShader.set('HasClip', rp.hasClip ? 1 : 0);
      // The demo's clip is a clean texture, so there is no padding to scale by.
      glassShader.set('ClipMaxUV', 1, 1);

      quad.draw();

      phosphorIndex = history;
    },
  };
}

//---------------------------------------------------------------------------
// The page.
//---------------------------------------------------------------------------

const hz = (v, low, high) => {
  const f = expo(v, low, high);
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(2)} Hz`;
};

const opt = (id, name, elements, def, group, hint) =>
  ({ id, name, type: 'option', elements, default: def, group, hint });

const integer = (id, name, value, group, hint) =>
  ({ id, name, type: 'option', elements: integerElements(id), default: integerDefault(id, value), group, hint });

/// `extra` is either a hint on its own or `{ display, hint }`. Spreading a bare
/// string would give the descriptor a property per character, which the panel
/// then renders as nothing at all — silently, which is the failure worth
/// spending three lines to make impossible.
const std = (id, name, def, group, extra = {}) =>
  ({ id, name, type: 'standard', default: def, group, ...(typeof extra === 'string' ? { hint: extra } : extra) });

const bool = (id, name, def, group, hint) =>
  ({ id, name, type: 'boolean', default: def, group, hint });

mountDemo({
  name: 'Vectrix',
  pluginId: 'VX01',
  tagline:
    'An oscillator and a pedalboard driving the X/Y deflection of a cathode ray tube. It models a route, not a look: brightness follows dwell time because the beam deposits energy at a constant rate and spreads it over the distance it covers, so a fast segment is dim and a turnaround blooms. The tube here is the plugin’s own shaders; the signal chain is a partial port — the oscillator, the shapes and seven of the fourteen effects. The gate, compressor, flanger, chorus and reverb are not on this page, and neither are the wireframe, audio-file and trace sources.',
  repo: 'https://github.com/stoatworks-labs/vectrix',

  // The face is the object and the output carries its alpha, so what sits behind
  // it is a real question.
  showBackdrop: true,

  // The phosphor buffer is RG32F and the trace pass accumulates into it by
  // additive blending. Both extensions are load-bearing and neither is optional:
  //
  //   EXT_color_buffer_float  — without it every phosphor buffer comes back
  //   GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT. Eight bits mid-chain would quantise
  //   the excitation and the dwell law, which is the whole claim, would be
  //   measuring the quantiser instead.
  //
  //   EXT_float_blend — blending into a 32-bit float target is core on desktop
  //   GL and an extension here. Without it the trace draw is an
  //   INVALID_OPERATION and nothing is deposited at all.
  needFloat: true,
  needFloatBlend: true,

  variants: {
    label: 'Bundle',
    default: 'source',
    options: [
      { id: 'source', name: 'Vectrix', hint: 'The source build: its own signal over its own tube, no input at all.' },
      { id: 'effect', name: 'Vectrix Trace', hint: 'The effect build: the clip is painted ON the tube face, so it curves with the glass, sits behind the graticule and shares the halation. Taking the clip as the signal is the part not ported here.' },
    ],
  },

  params: [
    opt('detail', 'Detail', DETAIL_NAMES, 1, 'Clock',
      'The internal sample rate: 48, 96 or 192 kHz. A cost dial with a visible symptom — at Draft, figures above a few hundred hertz visibly polygonalise.'),
    bool('reset', 'Reset', 0, 'Clock',
      'Clears the phosphor and every delay line. An event parameter in the plugin; the kit has no event control, so here every change of this toggle is a press.'),
    std('seed', 'Seed', 0, 'Clock', {
      display: (v) => String(1 + Math.round(v * 9998)),
      hint: 'Noise and Sample & Hold only. An integer 1..9999 in the plugin.',
    }),

    opt('source', 'Source', ['Oscillator', 'Shape'], 0, 'Source',
      'The plugin has five: Wireframe, Audio File and Trace Input are not on this page.'),

    opt('waveX', 'Wave X', WAVE_NAMES, 0, 'Oscillator'),
    opt('waveY', 'Wave Y', WAVE_NAMES, 0, 'Oscillator'),
    std('freqX', 'Frequency X', 0.77, 'Oscillator', {
      display: (v) => hz(v, 0.01, 2000),
      hint: 'The default is about 120 Hz, so a 3:2 figure closes twice inside one frame at 60 fps and stands still. Below the frame rate the beam cannot get round the figure in time and what you see is a comet — which is what an oscilloscope does, not a fault.',
    }),
    opt('ratio', 'Ratio', RATIO_NAMES, 3, 'Oscillator',
      'Exact rationals, not a slider. A slider lands on 2.001:1 and the figure rotates slowly and forever, with no way to stop it — every value near the one you want is also wrong. Detune is the control for the drift you might actually want.'),
    bool('freeY', 'Free Y', 0, 'Oscillator', 'Ignore the ratio and set Y directly.'),
    std('freqY', 'Frequency Y', 0.77, 'Oscillator', { display: (v) => hz(v, 0.01, 2000), hint: 'Free Y only.' }),
    std('phaseY', 'Phase Y', 0.25, 'Oscillator', {
      display: (v) => `${(v * 360).toFixed(0)}°`,
      hint: '90 degrees against a matching sine is a circle. Also how you put a figure back where it was after changing the Ratio, which leaves a permanent offset.',
    }),
    std('pwmX', 'Width X', 0.5, 'Oscillator', { display: (v) => linear(v, 0.02, 0.98).toFixed(2), hint: 'Pulse only.' }),
    std('pwmY', 'Width Y', 0.5, 'Oscillator', { display: (v) => linear(v, 0.02, 0.98).toFixed(2), hint: 'Pulse only.' }),
    std('detune', 'Detune', 0.5, 'Oscillator', { display: (v) => `${(linear(v, -0.02, 0.02) * 100).toFixed(2)}%` }),
    bool('hardSync', 'Hard Sync', 0, 'Oscillator', 'Y restarts whenever X wraps. It aliases badly by design — that is what it looks like on the hardware too.'),
    bool('blankRetrace', 'Blank on Retrace', 0, 'Oscillator',
      'Cuts the gun across the discontinuity. Saw against saw with this on is a clean raster, because the beam is genuinely off during flyback — not because anything declined to draw the flyback line.'),

    opt('shape', 'Shape', SHAPE_NAMES, 0, 'Shape'),
    std('shapeRate', 'Shape Rate', 0.88, 'Shape', {
      display: (v) => hz(v, 0.01, 200),
      hint: 'How many times a second the figure is drawn. The default is about 60 Hz — one closed loop per frame.',
    }),
    integer('sides', 'Sides', 5, 'Shape', 'Polygon and Star.'),
    std('inner', 'Inner Radius', 0.382, 'Shape', { hint: 'Star only. The default is 1/phi², the pentagram’s own.' }),
    integer('petalN', 'Petals', 3, 'Shape', 'Rose and Spirograph.'),
    integer('petalD', 'Petal Divisor', 1, 'Shape', 'Rose and Spirograph. The closure period is recomputed when this changes, which is what stops the figure precessing.'),
    std('trochoid', 'Pen Offset', 0.4, 'Shape', { display: (v) => linear(v, 0, 1.5).toFixed(2), hint: 'Spirograph only.' }),

    bool('rectOn', 'Rectifier', 0, 'Rectifier'),
    bool('rectMode', 'Full Wave', 0, 'Rectifier'),
    std('rectBias', 'Fold Point', 0.5, 'Rectifier', {
      display: (v) => linear(v, -1, 1).toFixed(2),
      hint: 'Half-wave on X folds the left half of the figure onto one line, and the beam then sits there for half of every cycle. The bright bar that appears is dwell, not a drawn line.',
    }),
    opt('rectRouting', 'Rectify Routing', ROUTING_NAMES, 1, 'Rectifier'),

    bool('slewOn', 'Slew Limiter', 0, 'Slew'),
    std('slewRise', 'Rise', 1, 'Slew', { display: (v) => `${expo(v, 0.5, 5000).toFixed(0)} V/s` }),
    std('slewFall', 'Fall', 1, 'Slew', { display: (v) => `${expo(v, 0.5, 5000).toFixed(0)} V/s` }),
    bool('slewLink', 'Link Rise/Fall', 1, 'Slew'),
    opt('slewRouting', 'Slew Routing', ROUTING_NAMES, 0, 'Slew',
      'Turns Sample & Hold from a constellation into a constellation with strings — the lines between the steps are the beam travelling, not a source drawing them.'),

    bool('driveOn', 'Drive', 0, 'Drive'),
    std('driveAmount', 'Gain', 0, 'Drive', { display: (v) => `${linear(v, 0, 40).toFixed(1)} dB` }),
    std('driveFold', 'Fold', 0, 'Drive', 'The Serge reflecting wavefolder: everything above 1 is reflected back down, repeatedly, which is what turns a circle into a rosette.'),
    integer('driveFolds', 'Folds', 2, 'Drive'),
    bool('driveOversample', 'Oversample', 1, 'Drive', '4x, through a linear-phase FIR. An IIR half-band would be cheaper and its non-flat phase would skew the figure.'),
    opt('driveRouting', 'Drive Routing', ROUTING_NAMES, 0, 'Drive'),

    bool('ringOn', 'Ring Mod', 0, 'Ring Modulator'),
    std('ringFreq', 'Carrier', 0.65, 'Ring Modulator', { display: (v) => hz(v, 0.1, 2000) }),
    opt('ringWave', 'Carrier Wave', ['Sine', 'Triangle', 'Square'], 0, 'Ring Modulator'),
    std('ringDepth', 'Ring Depth', 0, 'Ring Modulator'),
    bool('ringLock', 'Ratio Lock', 0, 'Ring Modulator', 'Ties the carrier to the source’s own frequency, so the modulation stands still relative to the figure instead of crawling through it.'),
    opt('ringRouting', 'Ring Routing', ROUTING_NAMES, 5, 'Ring Modulator',
      'Cross is the one worth trying: each axis modulated by the other, which is a genuine warp of the figure that no affine transform reaches.'),

    bool('crushOn', 'Bitcrush', 0, 'Bitcrush'),
    integer('crushBits', 'Bits', 16, 'Bitcrush', 'Quantises the beam’s position, not its brightness: a circle becomes a staircase of exactly 2^bits steps per axis.'),
    std('crushRate', 'Sample Rate', 1, 'Bitcrush', {
      display: (v) => (v >= 0.999 ? 'off' : hz(v, 100, 48000)),
      hint: 'At the top of its travel this is off, not merely fast — an almost-off sample-and-hold still beats against the source and crawls.',
    }),
    opt('crushRouting', 'Crush Routing', ROUTING_NAMES, 0, 'Bitcrush'),

    bool('phaseOn', 'Phaser', 0, 'Phaser'),
    integer('phaseStages', 'Stages', 4, 'Phaser'),
    std('phaseRate', 'Phaser Rate', 0.5, 'Phaser', { display: (v) => hz(v, 0.01, 10) }),
    std('phaseDepth', 'Phaser Depth', 0.7, 'Phaser'),
    std('phaseCentre', 'Centre', 0.47, 'Phaser', { display: (v) => hz(v, 100, 8000) }),
    std('phaseFeedback', 'Phaser Feedback', 0.53, 'Phaser', { display: (v) => linear(v, 0, 0.95).toFixed(2) }),
    std('phaseMix', 'Phaser Mix', 0.5, 'Phaser',
      'At 1.0 there is no dry path, so there are no notches at all — only pure phase shift, which between X and Y is exactly the rotation of a Lissajous ellipse.'),
    opt('phaseRouting', 'Phaser Routing', ROUTING_NAMES, 1, 'Phaser',
      'On X only it shifts each frequency component of the horizontal deflection by a different amount, so a sine figure rotates and a complex one shears. That is not an affine transform, so no shader can produce it.'),

    bool('delayOn', 'Delay', 0, 'Delay'),
    std('delayTime', 'Delay Time', 0.7, 'Delay', { display: (v) => `${expo(v, 1, 2500).toFixed(0)} ms` }),
    std('delayFeedback', 'Delay Feedback', 0.43, 'Delay', {
      display: (v) => linear(v, 0, 1.05).toFixed(2),
      hint: 'Allowed past 1.0, with a tanh saturator in the loop — which is exactly why a real analogue delay runs away into a howl and then sits there.',
    }),
    std('delayDampLow', 'Delay Tone', 0.65, 'Delay', {
      display: (v) => hz(v, 200, 20000),
      hint: 'In the feedback path, not on the output: each repeat is dulled a little more than the last, so each ghost has rounder corners than the one before it.',
    }),
    std('delayDampHigh', 'Delay Bass Cut', 0.41, 'Delay', { display: (v) => hz(v, 20, 1000) }),
    std('delayMix', 'Delay Mix', 0.4, 'Delay'),
    opt('delayRouting', 'Delay Routing', ROUTING_NAMES, 0, 'Delay',
      'Ping-Pong feeds each axis’s output into the other’s input, so the ghost walks diagonally across the screen.'),
    bool('delayTimeMode', 'Crossfade Time', 0, 'Delay',
      'Off is Repitch: the read pointer’s rate ramps and the ghosts audibly swoop, which is bucket-brigade behaviour.'),

    std('outGain', 'Deflection', 0.5, 'Deflection Amplifier', { display: (v) => `${linear(v, 0, 2).toFixed(2)}×` }),
    std('outOffsetX', 'Offset X', 0.5, 'Deflection Amplifier', { display: (v) => linear(v, -1, 1).toFixed(2) }),
    std('outOffsetY', 'Offset Y', 0.5, 'Deflection Amplifier', { display: (v) => linear(v, -1, 1).toFixed(2) }),
    std('outRotation', 'Rotation', 0.5, 'Deflection Amplifier', { display: (v) => `${(linear(v, -0.5, 0.5) * 360).toFixed(0)}°` }),
    std('outSkew', 'Skew', 0.5, 'Deflection Amplifier', { display: (v) => linear(v, -1, 1).toFixed(2) }),
    bool('outDc', 'DC Block', 1, 'Deflection Amplifier',
      'The rectifier and the wavefolder both manufacture DC, and DC on a deflection axis is the whole figure sitting permanently off centre.'),
    std('outSlew', 'Amp Slew', 0.7, 'Deflection Amplifier', {
      display: (v) => `${expo(v, 100, 200000).toFixed(0)} V/s`,
      hint: 'The amplifier cannot move the beam infinitely fast. This is what rounds the corner of a square at the very last moment.',
    }),
    std('outBandwidthX', 'Bandwidth X', 0.84, 'Deflection Amplifier', { display: (v) => hz(v, 1000, 80000) }),
    std('outBandwidthY', 'Bandwidth Y', 0.66, 'Deflection Amplifier', {
      display: (v) => hz(v, 1000, 80000),
      hint: 'Lower than X by default, because the horizontal channel of a real scope drives the sweep and is built for it. That is why a fast figure leans slightly.',
    }),
    std('outResonance', 'Damping Factor', 0.06, 'Deflection Amplifier', { display: (v) => linear(v, 0.5, 4).toFixed(2) }),

    std('beamPower', 'Beam', 0.45, 'Beam', {
      display: (v) => `${(Math.pow(10, -1 + 2 * v) * Math.min(1, v / BEAM_OFF_RAMP)).toFixed(2)}×`,
      hint: 'Energy per second of beam-on time. The bottom two per cent of the travel fades to a true zero, because the exponential on its own bottoms out at a tenth of nominal and would leave the gun on at "0".',
    }),
    std('beamFocus', 'Focus', 0.3, 'Beam', {
      display: (v) => `σ ${expo(v, 0.0012, 0.02).toFixed(4)}`,
      hint: 'Beam units, one of which is half the face height. The face buffer is sized by this rather than by the composition, so a sharper tube genuinely costs more.',
    }),
    std('beamDefocus', 'Blooming', 0.35, 'Beam', { display: (v) => linear(v, 0, 2).toFixed(2), hint: 'How much a full-current beam swells. Same reason a CRT’s highlights do.' }),
    std('blankFloor', 'Blanking Leak', 0, 'Beam', {
      display: (v) => linear(v, 0, 0.1).toFixed(3),
      hint: 'What a fully cut-off beam still puts on the glass. A real gun does not reach zero emission, and a retrace that leaves absolutely nothing behind looks wrong in a way people describe as "too clean".',
    }),

    opt('phosphor', 'Phosphor', PHOSPHOR_NAMES, 0, 'Tube',
      'A measured table, not a tint. P31 at true persistence shows no trail at all at 60 fps, because that is what a P31 is. P7 is the two-layer cascade: a blue flash pumping a yellow-green layer underneath, so the trail is a different colour from the strike. Switching changes the brightness by up to three times, because the efficiencies are real.'),
    std('persistence', 'Persistence', 0.25, 'Tube', {
      display: (v) => `×${persistenceMultiplier(v).toFixed(persistenceMultiplier(v) < 10 ? 2 : 0)}`,
      hint: 'A multiplier on the phosphor’s own time constant, not a per-frame decay: a decay factor would mean something different at every frame rate. The default is ×1 — the real phosphor.',
    }),
    std('halation', 'Halation', 0.35, 'Tube', {
      display: (v) => `${linear(v, 0, 4).toFixed(2)}×`,
      hint: 'Light scattering sideways inside a thick faceplate. It is why a stationary dot has a halo and why the black next to it is never quite black. The range runs to 4× rather than 1×, and the bright pass’s knee sits at 0.04 — at a knee of 0.5 the pass found nothing on an ordinary picture and this control did nothing at all.',
    }),
    std('halationRadius', 'Halation Radius', 0.5, 'Tube', { display: (v) => `${clamp(1 + Math.round(2 * v), 1, 3)} pass${clamp(1 + Math.round(2 * v), 1, 3) > 1 ? 'es' : ''}` }),
    std('faceAspect', 'Face Aspect', 0, 'Tube', {
      display: (v) => `${expo(v, 1, 2).toFixed(2)}:1`,
      hint: '1:1 is a round lab scope, 4:3 a television. The only thing that knows the face is not square, and it enters the trace shader as a single divide — so the spot stays round rather than turning into an ellipse.',
    }),
    std('cornerRadius', 'Corner Radius', 1, 'Tube',
      'Radius 1 on a square face already is a circle in the rounded-rectangle distance field. There is no special case for a round tube because a round tube is not a special case.'),
    std('deflectionGain', 'Screen Size', 0.39, 'Tube', {
      display: (v) => `${linear(v, 0.4, 1.4).toFixed(2)} units/V`,
      hint: 'Beam units per volt. Under 1 underscans, which is how a scope is set up so an overdriven signal is visibly overdriven; over 1 overscans, which is how a television keeps its blanking edges behind the bezel.',
    }),
    std('curvature', 'Curvature', 0, 'Tube', { display: (v) => linear(v, 0, 0.6).toFixed(2) }),
    std('vignette', 'Vignette', 0.2, 'Tube'),
    std('faceBlack', 'Face Black', 0.85, 'Tube',
      'How much of the faceplate is actually in front of what is behind it. At 0 the effect build is an exact passthrough, by construction rather than by tuning.'),
    std('filterTint', 'Contrast Filter', 0.5, 'Tube',
      'A real scope’s filter is the colour of its phosphor, which is how it kills ambient light without killing the trace.'),
    std('graticule', 'Graticule', 0.25, 'Tube',
      '10 by 8 divisions inscribed in the face, solved against the same distance field the faceplate uses. It fades out once a division is worth fewer than about three output pixels, because below that it is a moire generator.'),

    std('mix', 'Mix', 1, 'Output'),
  ],

  sources: ['grid', 'scene', 'detail', 'spot', 'bars', 'alpha'],

  // The factory presets from source/Presets.h, for the ten whose character comes
  // from blocks this page actually has, mirrored column for column.
  //
  // Every value the table carries for a ported parameter is repeated here, not
  // just the ones that differ from the defaults, because `Params.apply` puts
  // everything a preset does not name back to its default — so an omission is a
  // silent disagreement with the plugin rather than a shorter list.
  //
  // `sides`, `driveFolds` and `crushBits` are FF_TYPE_INTEGER in the plugin and
  // hold the integer itself; the demo kit has no integer control, so they are
  // dropdowns and `integerDefault` converts the plugin's number into an index.
  // Write the plugin's number here, never the index.
  //
  // Anything a preset turns on that is not ported — the compressor in Rosette
  // Fold, Tape Ghosts and Fuzz Box, the flanger in Fuzz Box, the reverb in Ring
  // Warp — is simply absent, so those will not pump or bloom the way the
  // plugin's do.
  presets: {
    Lissajous: {
      source: 0, waveX: 0, waveY: 0, freqX: 0.77, ratio: 3, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.45, beamFocus: 0.3, phosphor: 0, persistence: 0.35,
      halation: 0.25, faceBlack: 0.85, graticule: 0.3,
    },
    'Rosette Fold': {
      source: 0, waveX: 0, waveY: 0, freqX: 0.77, ratio: 0, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 1, driveAmount: 0.35, driveFold: 0.75, driveFolds: integerDefault('driveFolds', 3),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.5, beamFocus: 0.28, phosphor: 0, persistence: 0.3,
      halation: 0.3, faceBlack: 0.85, graticule: 0.25,
    },
    Raster: {
      source: 0, waveX: 2, waveY: 2, freqX: 0.79, ratio: 1, phaseY: 0, blankRetrace: 1,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.4, beamFocus: 0.28, phosphor: 0, persistence: 0.3,
      halation: 0.2, faceBlack: 0.9, graticule: 0.1,
    },
    'The Rotator': {
      source: 0, waveX: 0, waveY: 0, freqX: 0.77, ratio: 3, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 1, phaseRate: 0.25, phaseMix: 1, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.45, beamFocus: 0.3, phosphor: 0, persistence: 0.35,
      halation: 0.28, faceBlack: 0.85, graticule: 0.3,
    },
    // Deliberately slower than the rest: a constellation wants visibly discrete
    // jumps, so its figure is not asked to close inside one frame.
    Constellation: {
      source: 0, waveX: 6, waveY: 6, freqX: 0.62, ratio: 0, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 1, slewRise: 0.45,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.48, beamFocus: 0.3, phosphor: 3, persistence: 0.5,
      halation: 0.3, faceBlack: 0.85, graticule: 0.25,
    },
    Star: {
      source: 1, waveX: 0, waveY: 0, freqX: 0.77, ratio: 0, phaseY: 0.25, blankRetrace: 0,
      shape: 4, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 1, slewRise: 0.75,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.46, beamFocus: 0.3, phosphor: 1, persistence: 0.4,
      halation: 0.28, faceBlack: 0.85, graticule: 0.25,
    },
    'Tape Ghosts': {
      source: 0, waveX: 0, waveY: 0, freqX: 0.77, ratio: 3, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 1, delayTime: 0.55, delayFeedback: 0.62, delayMix: 0.55, delayRouting: 6,
      beamPower: 0.42, beamFocus: 0.3, phosphor: 2, persistence: 0.45,
      halation: 0.35, faceBlack: 0.85, graticule: 0.25,
    },
    'Ring Warp': {
      source: 1, waveX: 0, waveY: 0, freqX: 0.77, ratio: 0, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 1, ringFreq: 0.45, ringDepth: 0.65, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.46, beamFocus: 0.3, phosphor: 0, persistence: 0.35,
      halation: 0.3, faceBlack: 0.85, graticule: 0.25,
    },
    'Fuzz Box': {
      source: 0, waveX: 0, waveY: 0, freqX: 0.77, ratio: 5, phaseY: 0.25, blankRetrace: 0,
      shape: 0, shapeRate: 0.88, sides: integerDefault('sides', 5),
      rectOn: 0, rectRouting: 1, slewOn: 0, slewRise: 1,
      driveOn: 1, driveAmount: 0.8, driveFold: 0.35, driveFolds: integerDefault('driveFolds', 4),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 0, crushBits: integerDefault('crushBits', 16),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.42, beamFocus: 0.32, phosphor: 0, persistence: 0.35,
      halation: 0.4, faceBlack: 0.85, graticule: 0.2,
    },
    Vectrex: {
      source: 1, waveX: 0, waveY: 0, freqX: 0.77, ratio: 0, phaseY: 0.25, blankRetrace: 0,
      shape: 3, shapeRate: 0.88, sides: integerDefault('sides', 6),
      rectOn: 0, rectRouting: 1, slewOn: 1, slewRise: 0.85,
      driveOn: 0, driveAmount: 0, driveFold: 0, driveFolds: integerDefault('driveFolds', 2),
      ringOn: 0, ringFreq: 0.3, ringDepth: 0, ringRouting: 5,
      crushOn: 1, crushBits: integerDefault('crushBits', 5),
      phaseOn: 0, phaseRate: 0.2, phaseMix: 0.5, phaseRouting: 1,
      delayOn: 0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.3, delayRouting: 0,
      beamPower: 0.55, beamFocus: 0.22, phosphor: 0, persistence: 0.3,
      halation: 0.45, faceBlack: 0.95, graticule: 0,
    },
  },

  differences: [
    'The signal chain is a partial port and the panel is a subset. Here: the oscillator, the shapes, and the rectifier, slew limiter, drive/wavefolder, ring modulator, bitcrush, phaser and delay, plus the deflection amplifier. Not here: the gate, the compressor, the flanger, the chorus, the reverb, the VCA, the wireframe, audio-file and trace sources, tempo sync, and the whole modulation matrix. The plugin has about a hundred and fifty controls; this page has ninety-one.',
    'The renderer is not a subset. All six passes are the plugin’s own GLSL in the plugin’s own order, and demo/tools/check_shaders.py fails the repository’s verify script if a character of it drifts from source/render/shaders/.',
    'The presets are the factory table from source/Presets.h, mirrored column for column. Whether a figure stands still is a race between its rate and the frame rate: the defaults put the oscillator at about 120 Hz and the shapes at 60, so a figure closes at least once inside a frame and holds. Take Frequency X well below 60 and it becomes a comet instead — one frame of route, no trail — because a P31 at persistence ×1 keeps nothing between frames. That is not a fault, it is what a sixteen-microsecond phosphor does. Raise Persistence or choose P7 for a tube that remembers.',
    'The clock is the browser’s. Frame durations are clamped to the same 1/240..1/24 window the plugin clamps its host’s to, so a stalled tab cannot deposit half a second of beam in one frame — but a browser’s timing is not a host’s, and brightness is only independent of it because dt is carried per sample.',
    'The noise generator is not the plugin’s. That one is a 64-bit xorshift128+, which in JavaScript means BigInt and is far too slow at 96 kHz; this is a 32-bit generator instead. Same job, different numbers, and nothing is checking it.',
    'The plugin’s numerical proof — one sweep at ten speeds spanning a hundred to one depositing the same total light to within half a percent, and the measured line density regressed against 1/v — is an offline harness in the repository. Nothing on this page measures anything.',
  ],

  createRenderer,
});
