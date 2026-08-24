/**
 * Abomerration — browser demo.
 *
 * The six shader constants below are `kVertex`, `kCopyFragment`, `kEdgeFragment`,
 * `kFieldFunctions`, `kDisperseCommon` and `kDisperseMain` from
 * `source/shaders/`, copied across unedited. `demo/tools/check_shaders.py`
 * compares them character for character against the C++ and is called from
 * `tools/verify.sh`, because two copies of a shader is exactly the arrangement
 * that drifts.
 *
 * The conversions further down are ports of `source/Dispersion.cpp` (the spectral
 * weight table), `source/Drive.cpp` (what the music does) and
 * `source/Controls.cpp` (the one place a slider becomes a physical quantity).
 * Ported rather than re-derived: those files exist precisely so the FFGL and
 * OpenFX builds cannot disagree about what a parameter means, and a third
 * invented copy here would have nothing checking it.
 *
 * The audio is synthesised on this page — see the Rhythm class for why a bundled
 * track, a microphone and an <audio> element were each the wrong answer.
 *
 * What this page is NOT: it is the plugin's shaders, not the plugin. No Resolume,
 * no FFGL, no C++ — and GLSL ES 3.00 rather than desktop GL 4.1 core, which the
 * kit's `port()` handles.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture } from './vendor/gl.js';

//---------------------------------------------------------------------------
// Shaders — verbatim from source/shaders/. Do not edit here.
//---------------------------------------------------------------------------

const VERTEX = `#version 410 core
uniform vec2 MaxUV;

layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;

out vec2 uv;

void main()
{
	gl_Position = vPosition;
	uv = vUV * MaxUV;
}
`;

const COPY = `#version 410 core
uniform sampler2D InputTexture;
uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;

in vec2 uv;
out vec4 fragColor;

void main()
{
	vec2 t = uv * SourceMaxUV;
	fragColor = texture( InputTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}
`;

const EDGE = `#version 410 core
uniform sampler2D InputTexture;
uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;
uniform vec2 SourceTexel;//one input texel, in picture-space units

in vec2 uv;
out vec4 fragColor;

float luma( vec2 p )
{
	vec2 t = p * SourceMaxUV;
	vec3 c = texture( InputTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) ).rgb;
	//Rec.709. The green weight is most of it, which is the point: a gradient
	//taken on an unweighted mean treats a red-to-blue edge as flat, and those
	//are the edges an operator is most likely to be pointing this at.
	return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}

void main()
{
	vec2 d = SourceTexel;

	float tl = luma( uv + vec2( -d.x, -d.y ) );
	float tc = luma( uv + vec2( 0.0, -d.y ) );
	float tr = luma( uv + vec2( d.x, -d.y ) );
	float ml = luma( uv + vec2( -d.x, 0.0 ) );
	float mr = luma( uv + vec2( d.x, 0.0 ) );
	float bl = luma( uv + vec2( -d.x, d.y ) );
	float bc = luma( uv + vec2( 0.0, d.y ) );
	float br = luma( uv + vec2( d.x, d.y ) );

	float gx = ( tr + 2.0 * mr + br ) - ( tl + 2.0 * ml + bl );
	float gy = ( bl + 2.0 * bc + br ) - ( tl + 2.0 * tc + tr );

	float mag = clamp( sqrt( gx * gx + gy * gy ) * 0.25, 0.0, 1.0 );

	fragColor = vec4( mag, mag, mag, 1.0 );
}
`;

const FIELD_FUNCTIONS = `
uniform int Geometry;
uniform vec2 Centre;
uniform float Angle;
uniform float Amount;
uniform float Falloff;
uniform float Turbulence;
uniform float Drift;
uniform float FrameAspect;

const float kPi = 3.14159265358979;

//= mirrored: Dispersion.cpp hash()
uint hash( uint x )
{
	x ^= x >> 16;
	x *= 0x7feb352du;
	x ^= x >> 15;
	x *= 0x846ca68bu;
	x ^= x >> 16;
	return x;
}

//= mirrored: Dispersion.cpp hash2()
float hash2( int ix, int iy )
{
	uint h = hash( uint( ix ) * 0x27d4eb2du ^ hash( uint( iy ) ) );
	return float( h ) * ( 1.0 / 4294967296.0 );
}

//= mirrored: Dispersion.cpp noise2D()
float noise2D( float x, float y )
{
	//floor and not a cast: a cast truncates toward zero, so every cell on the
	//negative side of the origin would be twice as wide as the others and the
	//noise would have a seam through the middle of the frame -- which is exactly
	//where the optical centre usually sits, and so exactly where it would be
	//looked at.
	float fx = floor( x );
	float fy = floor( y );

	int ix = int( fx );
	int iy = int( fy );

	float tx = x - fx;
	float ty = y - fy;
	tx = tx * tx * ( 3.0 - 2.0 * tx );
	ty = ty * ty * ( 3.0 - 2.0 * ty );

	float a = hash2( ix, iy );
	float b = hash2( ix + 1, iy );
	float c = hash2( ix, iy + 1 );
	float d = hash2( ix + 1, iy + 1 );

	float top = a + ( b - a ) * tx;
	float bottom = c + ( d - c ) * tx;

	return top + ( bottom - top ) * ty;
}

//= mirrored: Dispersion.cpp offsetAt()
//Takes a point in PICTURE space (v down) and returns the displacement of the far
//end of the spectrum, also in picture space. The near end is its negative.
vec2 offsetAt( vec2 p )
{
	float aspect = FrameAspect > 0.0 ? FrameAspect : 1.0;

	//Frame-height units: x stretched by the aspect ratio here and squashed back
	//at the end, which is what makes an Amount displace by the same visible
	//distance whatever shape the composition is.
	float x = ( p.x - Centre.x ) * aspect;
	float y = ( p.y - Centre.y );

	float r = sqrt( x * x + y * y );

	vec2 dir = vec2( 0.0 );
	float mag = 0.0;

	if( Geometry == 1 )
	{
		//Linear. No r term, and no optical centre at all -- Centre X and Centre
		//Y genuinely do nothing here, which is why the sweep is told so instead
		//of reporting two dead controls.
		dir = vec2( cos( Angle ), sin( Angle ) );
		mag = 1.0;
	}
	else if( Geometry == 2 )
	{
		//Tangential. The guard matters more than in the radial case: a tangent
		//has no limit at r = 0, so an unguarded normalise leaves one pixel of
		//garbage exactly at the optical centre, and that pixel then survives
		//every average anybody takes of the frame.
		if( r > 1e-6 )
			dir = vec2( -y / r, x / r );
		mag = pow( r, Falloff );
	}
	else if( Geometry == 3 )
	{
		//Turbulent. Direction from noise, magnitude constant. Varying both was
		//the obvious thing and it looks worse: magnitude noise leaves flat
		//patches where the effect simply stops, and those read as the plugin
		//failing rather than as texture.
		float n = noise2D( x * Turbulence + Drift, y * Turbulence - Drift * 0.7 );

		float a = n * 2.0 * kPi + Angle;
		dir = vec2( cos( a ), sin( a ) );
		mag = 1.0;
	}
	else
	{
		//Radial.
		if( r > 1e-6 )
			dir = vec2( x / r, y / r );
		mag = pow( r, Falloff );
	}

	float scale = Amount * mag;

	return vec2( dir.x * scale / aspect, dir.y * scale );
}
//= end mirrored
`;

const DISPERSE_COMMON = `
uniform sampler2D InputTexture;
uniform sampler2D EdgeTexture;

uniform vec2 SourceHalfTexel;

uniform float EdgeWeight;

/// Frame height in pixels, and whether to prefilter. Together they turn a
/// displacement in frame-height units into a sample spacing in pixels, which is
/// what decides the mip level -- see fetchInput.
uniform float FrameHeightPx;
uniform bool Prefilter;

in vec2 uv;
out vec4 fragColor;

/// Fetch in PICTURE space (v down), at a mip level covering spacingPx pixels.
///
/// Two things happen here and both are bugs somebody has already shipped:
///
///   - the v flip, because the field works in picture space and a texture
///     coordinate does not;
///   - the half-texel inset, because GL_LINEAR at the very edge of the picture
///     takes half its weight from outside it.
///
/// There is no MaxUV. This reads our own copy of the picture, which the copy pass
/// already resolved -- and that is what makes the mip chain trustworthy, because
/// mip levels of a padded texture average the picture together with undrawn
/// padding. See Copy.cpp.
vec4 fetchInput( vec2 p, float spacingPx )
{
	vec2 g = vec2( p.x, 1.0 - p.y );
	vec2 t = clamp( g, SourceHalfTexel, vec2( 1.0 ) - SourceHalfTexel );

	//TWICE the gap between neighbouring samples, not the gap itself.
	//
	//Sampling theory, and the factor of two is not a fudge. Samples spaced d apart
	//can only carry frequencies below the Nyquist limit 1/(2d), so the prefilter
	//has to reach that far. A box filter of width d has its first zero at 1/d --
	//an octave too high, so it passes everything between 1/(2d) and 1/d straight
	//into the sum, where it folds down as ripple. A box of width 2d puts its first
	//zero exactly on Nyquist.
	//
	//The first version of this used the gap itself and measurably under-filtered.
	//abomtest --quadrature on a hard step edge, worst ripple of 255 for Prism
	//8 / 16 / 32:
	//
	//    width d   16.6   8.7   1.7
	//    width 2d   4.8   2.0   1.2
	//
	//The cost is one extra octave of softening at a given sample count, which is
	//exactly the trade the Spectrum control exists to let somebody make.
	//
	//log2 because that is what a mip level is: level 0 covers one pixel, level 1
	//covers two. The max() keeps it off negative levels, which would be a request
	//to magnify.
	float lod = Prefilter ? log2( max( spacingPx * 2.0, 1.0 ) ) : 0.0;

	return textureLod( InputTexture, t, lod );
}

/// The dispersion at this pixel, after the edge weighting. Both mains want the
/// same answer, and --field would be checking the wrong number if the probe
/// skipped the weighting the picture gets.
vec2 dispersionAt( vec2 pic )
{
	vec2 offset = offsetAt( pic );

	if( EdgeWeight > 0.0 )
	{
		//Our own buffer: no padding, and v is GL's here because nothing wrote it
		//in picture space.
		float e = texture( EdgeTexture, uv ).r;
		offset *= mix( 1.0, e, EdgeWeight );
	}

	return offset;
}
`;

const DISPERSE_MAIN = `
uniform int SampleCount;
uniform vec4 Samples[ MAX_SAMPLES ];//s, then the r/g/b weights
uniform vec3 Push;
uniform bool UniformPush;
uniform float Fringe;
uniform float MixAmount;
uniform bool ShowField;

//Show Field only.
uniform float AmountRef;
uniform vec4 Meters;//bass, mid, high, beat

void main()
{
	vec2 pic = vec2( uv.x, 1.0 - uv.y );

	vec2 offset = dispersionAt( pic );

	//Spacing between neighbouring wavelength samples, in pixels, at THIS pixel.
	//Per pixel and not per frame on purpose: a radial field is nearly still in
	//the middle of the frame and largest in the corners, so a single spacing for
	//the whole draw would prefilter the middle for a displacement it does not
	//have and soften a picture that should be sharp there.
	//
	//length(offset) is in picture units, where v spans the frame height -- so
	//multiplying by the frame height in pixels gives the path length in pixels
	//regardless of the composition's shape.
	float spacingPx = SampleCount > 1
	                  ? length( offset ) * FrameHeightPx / float( SampleCount - 1 )
	                  : 0.0;

	//Level 0, always. The undispersed picture is what Mix blends back to and what
	//the fringe boost measures against; prefiltering it would soften the dry
	//signal and make Mix at 0 differ from bypass.
	vec4 original = fetchInput( pic, 0.0 );

	vec3 colour = vec3( 0.0 );
	float alpha = 0.0;

	if( UniformPush )
	{
		//One fetch per sample, all three channels taken from it. This is the
		//common case -- the channel trims default to centred and the bands
		//default to off -- and it is three times cheaper than the branch below.
		//UniformPush is a uniform, so the branch is coherent across the whole
		//draw and costs nothing in divergence.
		float p = Push.r;

		for( int i = 0; i < SampleCount; ++i )
		{
			vec4 s = Samples[ i ];
			vec4 c = fetchInput( pic + offset * ( s.x + p ) * 0.5, spacingPx );

			colour += c.rgb * s.yzw;
			//Alpha is achromatic, so it takes the achromatic response: the mean
			//of the three weights. That mean sums to exactly 1 over the table,
			//because each channel's weights do, so a fully opaque picture stays
			//fully opaque however the spectrum is set.
			alpha += c.a * ( s.y + s.z + s.w ) * ( 1.0 / 3.0 );
		}
	}
	else
	{
		for( int i = 0; i < SampleCount; ++i )
		{
			vec4 s = Samples[ i ];

			vec4 cr = fetchInput( pic + offset * ( s.x + Push.r ) * 0.5, spacingPx );
			vec4 cg = fetchInput( pic + offset * ( s.x + Push.g ) * 0.5, spacingPx );
			vec4 cb = fetchInput( pic + offset * ( s.x + Push.b ) * 0.5, spacingPx );

			colour += vec3( cr.r * s.y, cg.g * s.z, cb.b * s.w );
			alpha += ( cr.a * s.y + cg.a * s.z + cb.a * s.w ) * ( 1.0 / 3.0 );
		}
	}

	//The fringe boost pushes what the dispersion already separated further apart
	//without moving anything: it is the difference from the undispersed picture,
	//amplified. So it cannot invent a fringe where there is no dispersion, which
	//is the property that makes it safe to leave up while Amount is automated.
	if( Fringe > 0.0 )
		colour += ( colour - original.rgb ) * Fringe;

	vec4 result = vec4( colour, alpha );

	if( ShowField )
	{
		//A dim monochrome picture with the dispersion magnitude painted over it.
		//Deliberately does NOT show direction: direction is legible from the
		//effect itself, magnitude is the thing an operator cannot see -- because
		//a flat region with an enormous displacement looks exactly like a flat
		//region with none, which is the whole reason Edges exists and the single
		//most confusing thing about setting this plugin up.
		float grey = dot( original.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.25;

		float norm = clamp( length( offset ) / max( AmountRef, 1e-6 ), 0.0, 1.0 );

		//Blue - cyan - yellow - red. Monotonic in brightness as well as hue, so
		//it survives being looked at on a badly set up monitor.
		vec3 ramp = clamp( vec3( norm * 2.0 - 0.6, 1.0 - abs( norm - 0.5 ) * 2.2, 1.0 - norm * 2.2 ),
		                   vec3( 0.0 ), vec3( 1.0 ) );

		result = vec4( vec3( grey ) + ramp * 0.85, 1.0 );

		//Four meters along the bottom: bass, mid, treble, beat. This is the only
		//place in Resolume an operator can find out whether the plugin is
		//hearing anything at all -- with no audio routed the picture simply does
		//not move, which is indistinguishable from a depth set to zero, a route
		//pointing at a silent band, or a host that never sent a buffer.
		if( pic.y > 0.90 && pic.x > 0.02 && pic.x < 0.42 )
		{
			float slot = ( pic.x - 0.02 ) / 0.10;
			int which = int( slot );

			//A gap between the bars so four meters read as four and not as one
			//wide graph with steps in it.
			if( fract( slot ) < 0.8 && which >= 0 && which < 4 )
			{
				float value = which == 0 ? Meters.x : ( which == 1 ? Meters.y : ( which == 2 ? Meters.z : Meters.w ) );
				float fill = ( 0.98 - pic.y ) / 0.08;

				vec3 bar = which == 3 ? vec3( 1.0, 1.0, 1.0 ) : vec3( 0.2, 1.0, 0.4 );
				result = vec4( fill < clamp( value, 0.0, 1.0 ) ? bar : vec3( 0.10 ), 1.0 );
			}
		}
	}
	else
	{
		result = mix( original, result, MixAmount );
	}

	fragColor = result;
}
`;


//---------------------------------------------------------------------------
// The disperse pass, assembled exactly as source/shaders/Disperse.cpp does it.
//
// Three strings, in this order, behind a header that carries MAX_SAMPLES. The
// plugin's DisperseFragment() and FieldProbeFragment() both concatenate the same
// pieces, which is why `abomtest --field` checks the real shader rather than a
// lookalike — and why this page can too.
//---------------------------------------------------------------------------

const MAX_SAMPLES = 32;

const DISPERSE = `#version 410 core\n#define MAX_SAMPLES ${MAX_SAMPLES}\n`
  + FIELD_FUNCTIONS + DISPERSE_COMMON + DISPERSE_MAIN;

//---------------------------------------------------------------------------
// A port of source/Dispersion.cpp — the spectral weight table.
//
// Ported rather than re-derived. The normalisation at the end is the whole
// reason Spectrum is a quality control and not a tint control: leave the weights
// raw and moving from 8 samples to 32 changes how much energy each channel
// collects, so the picture's colour balance shifts and the knob reads as a
// colour effect. `abomtest --spectrum` renders a flat field at every setting and
// demands it come back flat.
//---------------------------------------------------------------------------

const RESPONSE = [
  { centre: 611, width: 55 }, // red
  { centre: 549, width: 50 }, // green
  { centre: 464, width: 45 }, // blue
];

function weights(count) {
  const n = Math.min(MAX_SAMPLES, Math.max(1, count));

  // One sample is the undisplaced picture, and has to be exactly that.
  if (n === 1) return [{ s: 0, r: 1, g: 1, b: 1 }];

  // The exact hard split. This setting exists to reproduce something specific
  // and well known, so it returns that rather than an approximation of it.
  if (n === 3) {
    return [
      { s: +1, r: 1, g: 0, b: 0 },
      { s: 0, r: 0, g: 1, b: 0 },
      { s: -1, r: 0, g: 0, b: 1 },
    ];
  }

  const out = [];
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const lambda = 380 + (700 - 380) * t;

    const rgb = RESPONSE.map(({ centre, width }) => {
      const d = (lambda - centre) / width;
      return Math.exp(-0.5 * d * d);
    });

    // t runs 0..1 with the short wavelengths first, so s runs -1..+1 with the
    // long ones at +1 — blue is refracted more, so it lands further out.
    out.push({ s: t * 2 - 1, r: rgb[0], g: rgb[1], b: rgb[2] });
    sumR += rgb[0];
    sumG += rgb[1];
    sumB += rgb[2];
  }

  for (const sample of out) {
    sample.r /= sumR;
    sample.g /= sumG;
    sample.b /= sumB;
  }

  return out;
}

//---------------------------------------------------------------------------
// A port of source/Drive.cpp — what the music does to the lens.
//---------------------------------------------------------------------------

const AUDIO_BINS = 64;

const SYNC_FREE = 0;
const ROUTE_NATURAL = 0;
const ROUTE_INVERTED = 1;
const ROUTE_BASS = 2;
const ROUTE_TREBLE = 3;

// Logarithmic in bin index, not equal thirds. With 64 linear bins one bin is
// several hundred hertz, so a "bass third" reaches past 7 kHz: everything
// anybody would call music lands in it and the other two bands sit at nearly
// zero all night. The effect then looks like it is only hearing the kick drum.
const BASS_END = 1 / 16;
const MID_END = 1 / 4;

function meanOver(bins, from, to) {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += Math.max(0, bins[i]);
  return sum / (to - from);
}

function bands(bins) {
  if (!bins || bins.length === 0) return { bass: 0, mid: 0, high: 0 };

  const n = bins.length;
  const bassEnd = Math.min(n, Math.max(1, Math.round(n * BASS_END)));
  const midEnd = Math.min(n, Math.max(bassEnd + 1, Math.round(n * MID_END)));

  return {
    bass: meanOver(bins, 0, bassEnd),
    mid: meanOver(bins, bassEnd, midEnd),
    high: meanOver(bins, midEnd, n),
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function computeDrive(settings, input) {
  const { bass, mid, high } = bands(input.bins);

  // The mean of every bin, not of the three bands: the bands cover wildly
  // different numbers of bins, so averaging them would weight four bass bins the
  // same as forty-eight treble ones and "level" would follow the kick.
  const level = input.bins && input.bins.length ? meanOver(input.bins, 0, input.bins.length) : 0;

  let beat = 0;

  if (settings.sync !== SYNC_FREE) {
    // The host gives a tempo and a position within the current bar, never which
    // bar it is. Recover a continuous count without keeping state: the clock
    // estimates how many bars have passed, barPhase is the exact position inside
    // this one, and the whole number reconciling them is round(estimate - phase).
    const tempo = input.bpm > 1 ? input.bpm : 120;
    const barSeconds = 240 / tempo;
    const estimate = input.seconds / barSeconds;
    const within = clamp01(input.barPhase);

    const bars = within + Math.round(estimate - within);
    const beats = bars * 4;

    const division = Math.max(0.125, settings.beatDivision);
    const position = beats / division;

    // Math.floor, not a truncating cast: a scrub backwards gives a negative
    // position, and truncation would ramp the wrong way there.
    const frac = position - Math.floor(position);

    beat = Math.pow(1 - frac, Math.min(16, Math.max(1, settings.beatDecay)));
  }

  // The reactive part is carved OUT of the amount, not added on top: whatever
  // depth is handed to the music is taken away from the always-on part. So full
  // beat depth means silence renders clean and the beat renders the whole
  // effect. Clamped as a SUM, because two sources at 0.8 would otherwise leave
  // the always-on part at -0.6, and a negative scale flips the dispersion
  // instead of saturating it.
  const beatDepth = clamp01(settings.beatDepth);
  const levelDepth = clamp01(settings.levelDepth);
  const handedOver = Math.min(1, beatDepth + levelDepth);

  const scale = (1 - handedOver) + beatDepth * beat + levelDepth * clamp01(level);

  const push = [0, 0, 0];
  const bandDepth = clamp01(settings.bandDepth);

  if (bandDepth > 0) {
    const b = clamp01(bass);
    const m = clamp01(mid);
    const h = clamp01(high);

    switch (settings.route) {
      case ROUTE_INVERTED:
        push[0] = -b; push[1] = -m * 0.25; push[2] = +h;
        break;
      case ROUTE_BASS:
        push[0] = b; push[1] = b; push[2] = b;
        break;
      case ROUTE_TREBLE:
        push[0] = h; push[1] = h; push[2] = h;
        break;
      default:
        // Mid gets a quarter of the swing. Not a fudge: red and blue are the
        // ends of the path and green sits at the middle of it, so pushing green
        // as hard moves the whole picture rather than spreading it, and reads as
        // a wobble instead of an aberration.
        push[0] = +b; push[1] = +m * 0.25; push[2] = -h;
        break;
    }

    for (let i = 0; i < 3; i += 1) push[i] *= bandDepth;
  }

  return { scale, push, bass, mid, high, level, beat };
}

//---------------------------------------------------------------------------
// A port of source/Controls.cpp — the one place a slider becomes a physical
// quantity. Ported rather than re-derived: that file exists precisely so the
// FFGL and OpenFX builds cannot disagree about what a parameter means, and a
// third invented copy here would have nothing checking it.
//---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

// A ratio control: 0.5 is unity, equal distances either side are reciprocal.
const ratio = (x, span) => Math.exp((x - 0.5) * 2 * Math.log(span));

const SPECTRUM_SAMPLES = [3, 8, 16, 32];
const DIVISIONS = [0.25, 0.5, 1, 2, 4, 8];

function driveSettings(p) {
  return {
    sync: Math.round(p.sync),
    route: Math.round(p.bandRoute),
    beatDepth: p.beatDepth,
    levelDepth: p.levelDepth,
    bandDepth: p.bandDepth,
    // Linear in the exponent rather than a ratio curve: the visible difference
    // between 1 and 2 is enormous and between 12 and 16 nearly nothing.
    beatDecay: lerp(1, 16, clamp01(p.beatDecay)),
    beatDivision: DIVISIONS[Math.min(DIVISIONS.length - 1, Math.max(0, Math.round(p.division)))],
  };
}

function field(p, aspectRatio, driveScale, driftPhase) {
  return {
    geometry: Math.round(p.geometry),
    centreU: p.centreX,
    centreV: p.centreY,
    // A full turn, unlike a symmetric band's half turn: the two ends of a
    // dispersion are different colours, so reversing it is a different picture
    // and all 360 degrees are distinct.
    angle: (p.angle - 0.5) * 2 * Math.PI,
    // Fifteen per cent of the frame height between the ends of the spectrum is
    // far past anything optical. The bottom is zero, not a small number, so
    // Amount at 0 is genuinely bypassed.
    amount: p.amount * 0.15 * driveScale,
    falloff: ratio(p.falloff, 4),
    turbulence: lerp(1, 20, clamp01(p.turbulence)),
    drift: driftPhase,
    aspectRatio,
  };
}

function look(p, drivePush) {
  const mode = Math.round(p.spectrum);
  const samples = weights(SPECTRUM_SAMPLES[Math.min(3, Math.max(0, mode))]);

  // The manual trims are centred: 0.5 is no extra push. They reach half the
  // spectral path either way, because the point of having them is to break the
  // physical relationship rather than fine-tune it.
  const manual = [(p.redPush - 0.5) * 2, (p.greenPush - 0.5) * 2, (p.bluePush - 0.5) * 2];
  const push = manual.map((v, i) => v + (drivePush ? drivePush[i] : 0));

  return {
    samples,
    sampleCount: samples.length,
    push,
    // Exact comparison, deliberately: both shader paths compute the same thing,
    // so being wrong by an epsilon costs one wasted fetch per sample, while a
    // tolerance would need a justification for its size.
    uniformPush: push[0] === push[1] && push[1] === push[2],
    // RGB Split is three hard copies by design and never prefilters.
    prefilter: mode !== 0,
    edges: clamp01(p.edges),
    fringe: clamp01(p.fringe) * 3,
    showField: p.showField >= 0.5,
    mix: clamp01(p.mix),
  };
}

// Noise units per second. Zero freezes the field, which is worth having: a
// static turbulent field is a fixed lens fault.
const driftRate = (p) => clamp01(p.drift) * 2;

//---------------------------------------------------------------------------
// The audio the plugin would otherwise be given.
//
// **Synthesised here rather than loaded.** Three reasons, and each one rules out
// the obvious alternative. A bundled music file is a licensing question this
// page does not need to have. Microphone input needs a permission prompt for a
// page whose whole job is to be glanced at. And an <audio> element needs a user
// gesture before it will play at all, which is the same constraint as this but
// with a download attached.
//
// So: a kick and a hat pattern at 120 bpm from oscillators and shaped noise,
// through the same AnalyserNode a host's FFT would feed. Deterministic, silent
// until asked for, and it demonstrates exactly the thing the plugin is for.
//
// It is off by default and starts on a click, which is not only the autoplay
// rule — it also mirrors the plugin honestly. In Resolume the Audio parameter is
// a source picker, and with nothing routed the effect does nothing reactive. The
// toggle here is that picker.
//---------------------------------------------------------------------------

const BPM = 120;

class Rhythm {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.spectrum = null;
    this.bins = new Float32Array(AUDIO_BINS);
    this.smoothed = new Float32Array(AUDIO_BINS);
    this.lastTime = -1;
    this.nextStep = 0;
    this.step = 0;
    this.startedAt = 0;
    this.failed = false;
    this.starting = false;
  }

  /**
   * Called from a click handler, which is what makes it allowed to start.
   *
   * **Nothing is published to `this` until the graph is complete.** The obvious
   * version assigned `this.ctx` first and then awaited `resume()` — and because
   * `start()` is not awaited by the render loop, the very next frame saw a live
   * context whose gain node did not exist yet and threw "Overload resolution
   * failed" out of `connect()`, which took the whole demo down with it. An await
   * in the middle of a constructor-like method is a window, and this one is
   * exactly one frame wide.
   */
  async start() {
    if (this.ctx || this.starting || this.failed) return;
    this.starting = true;
    try {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctx) { this.failed = true; this.starting = false; return; }

      const ctx = new Ctx();
      await ctx.resume();

      const analyser = ctx.createAnalyser();
      // 128 bins from a 256-point FFT, of which the low 64 are taken — the top
      // half of a 48 kHz spectrum is above 12 kHz and holds nothing a kick or a
      // hat puts there, so including it would halve the resolution of the part
      // that matters for no gain.
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;

      const gain = ctx.createGain();
      gain.gain.value = 0.35;
      gain.connect(analyser);
      gain.connect(ctx.destination);

      // Only now, all at once.
      this.analyser = analyser;
      this.gain = gain;
      this.spectrum = new Float32Array(analyser.frequencyBinCount);
      this.startedAt = ctx.currentTime;
      this.nextStep = this.startedAt + 0.05;
      this.step = 0;
      this.lastTime = -1;
      this.ctx = ctx;
    } catch {
      // A page that cannot make sound is not a broken page. The reactive
      // controls simply do nothing, exactly as they would in a host with no
      // audio routed.
      this.failed = true;
      this.ctx = null;
    }
    this.starting = false;
  }

  stop() {
    if (!this.ctx) return;
    this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.smoothed.fill(0);
  }

  get running() {
    return this.ctx !== null;
  }

  /** A kick on every beat and hats on the eighths, scheduled ahead of the clock. */
  schedule() {
    if (!this.ctx) return;

    const stepSeconds = 60 / BPM / 2; // one eighth note

    while (this.nextStep < this.ctx.currentTime + 0.2) {
      const at = this.nextStep;
      const onBeat = this.step % 2 === 0;

      if (onBeat) this.kick(at, this.step % 8 === 0 ? 1 : 0.75);
      this.hat(at, onBeat ? 0.25 : 0.5);

      // A bass note on the bar, so the band split has something in the low mids
      // rather than only a transient.
      if (this.step % 8 === 0) this.bass(at);

      this.nextStep += stepSeconds;
      this.step += 1;
    }
  }

  kick(at, level) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.setValueAtTime(140, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    env.gain.setValueAtTime(level, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
    osc.connect(env).connect(this.gain);
    osc.start(at);
    osc.stop(at + 0.3);
  }

  bass(at) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 110;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    osc.connect(env).connect(this.gain);
    osc.start(at);
    osc.stop(at + 1.0);
  }

  hat(at, level) {
    // Shaped white noise rather than a high oscillator: a sine at 8 kHz puts all
    // its energy in one bin, and the treble band would then respond to a single
    // bin's worth of the spectrum instead of to a hi-hat.
    const length = Math.floor(this.ctx.sampleRate * 0.05);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;

    const env = this.ctx.createGain();
    env.gain.value = level * 0.5;

    src.connect(filter).connect(env).connect(this.gain);
    src.start(at);
  }

  /**
   * The spectrum as the plugin's own smoothing would leave it: sqrt of the
   * magnitude, instant attack, ~150 ms exponential release.
   *
   * A port of Abomerration::updateAudio(). Fast up and slow down is the same
   * asymmetry, for the same reason — a flash a frame late reads as broken, one
   * that takes 150 ms to die reads as intended.
   */
  read(seconds) {
    if (!this.ctx) return { bins: null, barPhase: 0 };

    this.schedule();

    this.analyser.getFloatFrequencyData(this.spectrum);

    const dt = this.lastTime >= 0 && seconds > this.lastTime ? seconds - this.lastTime : 0;
    this.lastTime = seconds;
    const release = dt > 0 ? 1 - Math.exp(-dt / 0.15) : 1;

    for (let i = 0; i < AUDIO_BINS; i += 1) {
      // getFloatFrequencyData is in dBFS. Map -90..0 dB onto 0..1 and then take
      // the sqrt the plugin takes, so the same curve reaches the same drive.
      const db = this.spectrum[i];
      const linear = clamp01((db + 90) / 90);
      const raw = Math.sqrt(linear);

      if (raw >= this.smoothed[i]) this.smoothed[i] = raw;
      else this.smoothed[i] += (raw - this.smoothed[i]) * release;

      this.bins[i] = this.smoothed[i];
    }

    // The transport a host would report. Measured from the audio clock rather
    // than the render clock, so the pulse and the sound cannot drift apart.
    const elapsed = this.ctx.currentTime - this.startedAt;
    const bars = elapsed / (240 / BPM);

    return { bins: this.bins, barPhase: bars - Math.floor(bars) };
  }
}

//---------------------------------------------------------------------------
// The renderer. Three passes, the same three the plugin runs.
//---------------------------------------------------------------------------

// Every parameter this page declares, in declaration order. The kit's Params
// holds one value per id and is read with get(); there is no bulk accessor, and
// reaching for one silently returned undefined for the whole set.
const PARAM_IDS = [
  'geometry', 'amount', 'centreX', 'centreY', 'angle', 'falloff', 'spectrum',
  'turbulence', 'drift',
  'redPush', 'greenPush', 'bluePush',
  'audio', 'sync', 'beatDepth', 'beatDecay', 'division', 'levelDepth',
  'bandDepth', 'bandRoute',
  'edges', 'fringe',
  'showField', 'mix',
];

function readParams(params) {
  const out = {};
  for (const id of PARAM_IDS) out[id] = params.get(id);
  return out;
}

function createRenderer(gl, quad) {
  const copy = new Program(gl, VERTEX, COPY, 'copy');
  const edge = new Program(gl, VERTEX, EDGE, 'edge');
  const disperse = new Program(gl, VERTEX, DISPERSE, 'disperse');

  // mip: true is the whole reason this buffer exists. Each wavelength sample
  // reads from the level covering twice the gap to its neighbour, which is what
  // stops a sparse quadrature aliasing the picture — see source/shaders/Copy.cpp
  // for the measurements, and the factor of two.
  const copyBuffer = new PassBuffer(gl, { mip: true });
  const edgeBuffer = new PassBuffer(gl);

  const rhythm = new Rhythm();

  // Integrated, never `time * rate`. Rescaling the clock rewrites the whole
  // history, so the noise field jumps the instant the control is touched — which
  // is exactly when somebody is dragging it and watching.
  let driftPhase = 0;
  let lastTime = -1;
  let audioWanted = false;

  const flat = new Float32Array(MAX_SAMPLES * 4);

  return {
    render({ input, params, width, height, time }) {
      const p = readParams(params);

      // The audio toggle is this page's stand-in for Resolume's audio-source
      // picker. Flipping it is the user gesture an AudioContext needs.
      const wants = p.audio >= 0.5;
      if (wants !== audioWanted) {
        audioWanted = wants;
        if (wants) rhythm.start();
        else rhythm.stop();
      }

      const { bins, barPhase } = rhythm.read(time);

      const delta = lastTime >= 0 ? Math.min(0.1, Math.max(0, time - lastTime)) : 0;
      driftPhase += delta * driftRate(p);
      lastTime = time;

      const driven = computeDrive(driveSettings(p), {
        bins,
        bpm: BPM,
        barPhase,
        seconds: time,
      });

      const f = field(p, width / height, driven.scale, driftPhase);
      const l = look(p, driven.push);

      // Two different half texels, exactly as the plugin has two. The copy pass
      // reads the HOST's texture, which can be a different size from the frame
      // being rendered; everything after it reads our own copy, which is the
      // frame's size and carries no padding.
      const inputHalfTexelU = 0.5 / input.width;
      const inputHalfTexelV = 0.5 / input.height;
      const ownHalfTexelU = 0.5 / width;
      const ownHalfTexelV = 0.5 / height;

      // 1. The picture, as ours, mipmapped. Resolving MaxUV here is what makes
      //    the mip chain trustworthy: levels of a padded texture average the
      //    picture together with undrawn padding.
      copyBuffer.ensure(width, height, gl.RGBA16F).bind();
      copy.use();
      copy.set('MaxUV', 1, 1);
      copy.setSampler('InputTexture', 0);
      copy.set('SourceMaxUV', 1, 1);
      copy.set('SourceHalfTexel', inputHalfTexelU, inputHalfTexelV);
      bindTexture(gl, 0, input.texture);
      quad.draw();
      copyBuffer.generateMipmap();

      // 2. The edge weight, only when it is asked for.
      const needsEdges = l.edges > 0;
      if (needsEdges) {
        edgeBuffer.ensure(width, height, gl.RGBA16F).bind();
        edge.use();
        edge.set('MaxUV', 1, 1);
        edge.setSampler('InputTexture', 0);
        edge.set('SourceMaxUV', 1, 1);
        edge.set('SourceHalfTexel', ownHalfTexelU, ownHalfTexelV);
        edge.set('SourceTexel', 1 / width, 1 / height);
        bindTexture(gl, 0, copyBuffer.texture);
        quad.draw();
      }

      // 3. The dispersion, straight to the canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);

      disperse.use();
      disperse.set('MaxUV', 1, 1);
      disperse.setSampler('InputTexture', 0);
      disperse.setSampler('EdgeTexture', 1);
      disperse.set('SourceHalfTexel', ownHalfTexelU, ownHalfTexelV);

      disperse.setInt('Geometry', f.geometry);
      disperse.set('Centre', f.centreU, f.centreV);
      disperse.set('Angle', f.angle);
      disperse.set('Amount', f.amount);
      disperse.set('Falloff', f.falloff);
      disperse.set('Turbulence', f.turbulence);
      disperse.set('Drift', f.drift);
      disperse.set('FrameAspect', f.aspectRatio);
      disperse.set('FrameHeightPx', height);

      disperse.set('EdgeWeight', l.edges);
      disperse.setInt('SampleCount', l.sampleCount);
      disperse.set('Push', l.push[0], l.push[1], l.push[2]);
      disperse.set('Fringe', l.fringe);
      disperse.set('MixAmount', l.mix);

      // setInt for the bools, not set(): a bool uniform written through the
      // float path is a GL_INVALID_OPERATION that leaves it at zero with nothing
      // anywhere to see.
      disperse.setInt('UniformPush', l.uniformPush ? 1 : 0);
      disperse.setInt('ShowField', l.showField ? 1 : 0);
      disperse.setInt('Prefilter', l.prefilter ? 1 : 0);

      flat.fill(0);
      for (let i = 0; i < l.sampleCount; i += 1) {
        const s = l.samples[i];
        flat[i * 4 + 0] = s.s;
        flat[i * 4 + 1] = s.r;
        flat[i * 4 + 2] = s.g;
        flat[i * 4 + 3] = s.b;
      }
      // components: 4, and it has to be right — glUniform1fv on a vec4 array is
      // rejected as a size mismatch and the uniform keeps whatever it held.
      disperse.setArray('Samples', flat.subarray(0, l.sampleCount * 4), 4);

      disperse.set('AmountRef', Math.abs(f.amount));
      disperse.set('Meters', driven.bass, driven.mid, driven.high, driven.beat);

      bindTexture(gl, 0, copyBuffer.texture);
      bindTexture(gl, 1, needsEdges ? edgeBuffer.texture : copyBuffer.texture);

      quad.draw();
    },
  };
}

//---------------------------------------------------------------------------
// The page.
//---------------------------------------------------------------------------

const percent = (v) => `${Math.round(v * 100)}%`;
const degrees = (v) => `${Math.round((v - 0.5) * 360)}°`;

mountDemo({
  name: 'Abomerration',
  pluginId: 'AB01',
  tagline: 'Sound-reactive chromatic aberration — the whole spectrum smeared along a path, not three channels offset.',
  repo: 'https://github.com/stoatworks-labs/abomerration',
  page: 'https://stoatworks-labs.com/software/abomerration/',
  needFloat: true,

  differences: [
    'The beat and the spectrum come from a kick-and-hats pattern synthesised on this page, because a browser has no Resolume to route audio from. In the plugin the Audio parameter is a source picker — Local, Composition or External — and the transport is the host’s own.',
    'Show Field’s meters read that synthesised audio, so they show the page working rather than your mix.',
    'The plugin runs desktop GL 4.1; this is WebGL2 and GLSL ES 3.00. The shader text is identical and the kit rewrites only the version and precision lines.',
    'No presets dropdown behaviour beyond setting the sliders — the plugin also raises value events so the host re-reads them.',
  ],

  sources: ['bars', 'city', 'grid'],

  params: [
    {
      id: 'geometry', name: 'Geometry', type: 'option', default: 0, group: 'Aberration',
      elements: ['Radial', 'Linear', 'Tangential', 'Turbulent'],
      hint: 'Radial is what a real uncorrected lens does — nothing on the axis, worst in the corners. Linear is a prism, with no optical centre at all. Tangential rotates each wavelength about the centre, which no lens does. Turbulent takes its direction from a drifting noise field.',
    },
    { id: 'amount', name: 'Amount', type: 'standard', default: 0.28, group: 'Aberration',
      display: (v) => `${(v * 15).toFixed(1)}% of frame height`,
      hint: 'How far apart the two ends of the spectrum land. A real lens is a fraction of a per cent; the top of this range is fifteen.' },
    { id: 'centreX', name: 'Centre X', type: 'standard', default: 0.5, group: 'Aberration',
      hint: 'Does nothing in Linear, which has no optical centre.' },
    { id: 'centreY', name: 'Centre Y', type: 'standard', default: 0.5, group: 'Aberration',
      hint: '0 is the top of the frame. Does nothing in Linear.' },
    { id: 'angle', name: 'Angle', type: 'standard', default: 0.5, group: 'Aberration',
      display: degrees,
      hint: 'Linear’s direction, and a rotation of Turbulent’s noise. A full turn, because the two ends of a dispersion are different colours — reversing it is a different picture, not a mirror image.' },
    { id: 'falloff', name: 'Falloff', type: 'standard', default: 0.5, group: 'Aberration',
      display: (v) => `×${Math.exp((v - 0.5) * 2 * Math.log(4)).toFixed(2)} exponent`,
      hint: 'Radial and Tangential only. 0.5 is linear in radius; higher concentrates it in the corners like a bad lens; lower spreads it into the middle, like no lens at all.' },
    {
      id: 'spectrum', name: 'Spectrum', type: 'option', default: 1, group: 'Aberration',
      elements: ['RGB Split', 'Prism 8', 'Prism 16', 'Prism 32'],
      hint: 'How many wavelengths are sampled. RGB Split is three and is the hard channel offset — a different look, not a low-quality one, and the only setting that does not prefilter. The Prism settings trade cost for sharpness: each sample is prefiltered over twice the gap to the next, so more samples means a sharper picture at the same smoothness.',
    },
    { id: 'turbulence', name: 'Turbulence', type: 'standard', default: 0.35, group: 'Aberration',
      display: (v) => `${lerp(1, 20, v).toFixed(1)} cycles`,
      hint: 'Turbulent only: the noise frequency across the frame height.' },
    { id: 'drift', name: 'Drift', type: 'standard', default: 0.4, group: 'Aberration',
      hint: 'Turbulent only: how fast the field moves. Zero freezes it, which is a fixed lens fault and worth having.' },

    { id: 'redPush', name: 'Red Push', type: 'standard', default: 0.5, group: 'Channels',
      hint: '0.5 is no extra push. These exist to break the physical relationship, not to fine-tune it.' },
    { id: 'greenPush', name: 'Green Push', type: 'standard', default: 0.5, group: 'Channels' },
    { id: 'bluePush', name: 'Blue Push', type: 'standard', default: 0.5, group: 'Channels' },

    { id: 'audio', name: 'Audio', type: 'boolean', default: 0, group: 'Reaction',
      hint: 'This page’s stand-in for Resolume’s audio-source picker: it starts a kick-and-hats pattern at 120 bpm and feeds its spectrum to the controls below. Off, every reactive control does nothing — exactly as it would in a host with nothing routed.' },
    {
      id: 'sync', name: 'Sync', type: 'option', default: 0, group: 'Reaction',
      elements: ['Free', 'Locked'],
      hint: 'Free has no grid, so the beat envelope is flat zero and Beat Depth does nothing. Which division it fires on is Division’s job, not this one’s.',
    },
    { id: 'beatDepth', name: 'Beat Depth', type: 'standard', default: 0, group: 'Reaction',
      hint: 'Carved out of Amount rather than added to it, so at 1 the silence between beats renders a clean picture and the beat renders the whole effect. Needs Sync on Locked.' },
    { id: 'beatDecay', name: 'Beat Decay', type: 'standard', default: 0.45, group: 'Reaction',
      display: (v) => `^${lerp(1, 16, v).toFixed(1)}`,
      hint: '1 is a linear ramp across the division; 16 is a click.' },
    {
      id: 'division', name: 'Division', type: 'option', default: 2, group: 'Reaction',
      elements: ['1/4 Beat', '1/2 Beat', 'Beat', '2 Beats', 'Bar', '2 Bars'],
    },
    { id: 'levelDepth', name: 'Level Depth', type: 'standard', default: 0, group: 'Reaction',
      hint: 'The mean of every bin, not of the three bands — the bands cover very different numbers of bins, so averaging those would just follow the kick.' },
    { id: 'bandDepth', name: 'Band Depth', type: 'standard', default: 0, group: 'Reaction',
      hint: 'Sends bass, mid and treble each to their own channel, so the picture comes apart along with the mix rather than merely pumping.' },
    {
      id: 'bandRoute', name: 'Band Route', type: 'option', default: 0, group: 'Reaction',
      elements: ['Natural', 'Inverted', 'Bass Only', 'Treble Only'],
      hint: 'Natural spreads the channels the way a lens does. Bass Only pumps the whole dispersion with no colour routing, which is the one that stays legible on a dense mix.',
    },

    { id: 'edges', name: 'Edges', type: 'standard', default: 0, group: 'Look',
      hint: 'Weights the dispersion by local contrast. Real lateral aberration is invisible in a flat area, because displacing a region of constant colour returns the same region. At 0 the whole picture is displaced — the misregistered-camera look.' },
    { id: 'fringe', name: 'Fringe', type: 'standard', default: 0, group: 'Look',
      hint: 'Amplifies the difference from the undispersed picture, so the fringe reads harder without anything moving further. It cannot invent a fringe where there is no dispersion.' },

    { id: 'showField', name: 'Show Field', type: 'boolean', default: 0, group: 'Output',
      hint: 'The dispersion magnitude over a dim picture, with meters for bass, mid, treble and beat. It exists because a flat region with an enormous displacement looks exactly like one with none.' },
    { id: 'mix', name: 'Mix', type: 'standard', default: 1, group: 'Output', display: percent },
  ],

  // The same eight as source/Presets.h, in the same 0..1 space. The reactive
  // half of the audio-driven ones needs the Audio toggle and Sync = Locked, for
  // the same reason the plugin's presets leave Sync alone: it is not the
  // preset's business to switch somebody's transport mode underneath them.
  presets: {
    'Uncorrected Lens': { geometry: 0, amount: 0.12, angle: 0.5, falloff: 0.68, spectrum: 2, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0, beatDecay: 0.45, division: 2, levelDepth: 0, bandDepth: 0, bandRoute: 0, edges: 0.85, fringe: 0.2 },
    Misregistered: { geometry: 1, amount: 0.2, angle: 0.5, falloff: 0.5, spectrum: 0, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0, beatDecay: 0.45, division: 2, levelDepth: 0, bandDepth: 0, bandRoute: 0, edges: 0, fringe: 0 },
    Prism: { geometry: 1, amount: 0.34, angle: 0.3, falloff: 0.5, spectrum: 3, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0, beatDecay: 0.45, division: 2, levelDepth: 0, bandDepth: 0, bandRoute: 0, edges: 0.55, fringe: 0.45 },
    'Kick Punch': { geometry: 0, amount: 0.55, angle: 0.5, falloff: 0.55, spectrum: 1, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 1, beatDecay: 0.72, division: 2, levelDepth: 0, bandDepth: 0, bandRoute: 0, edges: 0.3, fringe: 0.25, audio: 1, sync: 1 },
    'Bass Bloom': { geometry: 0, amount: 0.45, angle: 0.5, falloff: 0.5, spectrum: 2, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0, beatDecay: 0.45, division: 2, levelDepth: 0.35, bandDepth: 0.75, bandRoute: 2, edges: 0.4, fringe: 0.3, audio: 1, sync: 1 },
    'Cymbal Sizzle': { geometry: 0, amount: 0.3, angle: 0.5, falloff: 0.34, spectrum: 1, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0, beatDecay: 0.45, division: 0, levelDepth: 0, bandDepth: 0.9, bandRoute: 3, edges: 0.7, fringe: 0.55, audio: 1, sync: 1 },
    'Wrung Out': { geometry: 2, amount: 0.42, angle: 0.5, falloff: 0.6, spectrum: 2, turbulence: 0.35, drift: 0, redPush: 0.5, greenPush: 0.5, bluePush: 0.5, beatDepth: 0.3, beatDecay: 0.55, division: 4, levelDepth: 0, bandDepth: 0, bandRoute: 0, edges: 0.25, fringe: 0.3, audio: 1, sync: 1 },
    Abomination: { geometry: 3, amount: 0.8, angle: 0.5, falloff: 0.5, spectrum: 2, turbulence: 0.55, drift: 0.45, redPush: 0.68, greenPush: 0.5, bluePush: 0.32, beatDepth: 0.55, beatDecay: 0.6, division: 2, levelDepth: 0.45, bandDepth: 0.85, bandRoute: 0, edges: 0, fringe: 0.7, audio: 1, sync: 1 },
  },

  createRenderer,
});
