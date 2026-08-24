/**
 * Tilter — browser demo.
 *
 * The eight shader constants below are `kVertex`, `kDownsampleFragment`,
 * `kDepthFragment`, `kSmoothFragment`, `kCoCFragment`, `kGaussianFragment`,
 * `kBokehFragment` and `kCompositeFragment` from `source/shaders/`, copied
 * across unedited. `demo/tools/check_shaders.py` compares them character for
 * character against the C++ and is called from `tools/verify.sh`, because two
 * copies of a shader is exactly the arrangement that drifts.
 *
 * The conversions further down are a port of `source/Controls.cpp` — the one
 * place a slider position becomes a physical quantity. Ported rather than
 * re-derived: that file exists precisely so the FFGL and OpenFX builds cannot
 * disagree about what a parameter means, and a third invented copy here would
 * have nothing checking it.
 *
 * What this page is NOT: it is the plugin's shaders, not the plugin. No
 * Resolume, no FFGL, no C++ — and GLSL ES 3.00 rather than desktop GL 4.1
 * core, which the kit's `port()` handles.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, Quad, PassBuffer, bindTexture } from './vendor/gl.js';

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

const DOWNSAMPLE = `#version 410 core
uniform sampler2D InputTexture;
uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;
uniform vec2 SourceTexel;//one full-resolution texel, in picture space
uniform int Scale;       //block edge, in full-resolution texels

in vec2 uv;
out vec4 fragColor;

vec4 fetch( vec2 p )
{
	vec2 t = p * SourceMaxUV;
	return texture( InputTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}

void main()
{
	if( Scale <= 1 )
	{
		fragColor = fetch( uv );
		return;
	}

	//Every texel of the block, weighted equally. The block's top-left corner in
	//picture space is the output texel's centre minus half a block.
	vec2 origin = uv - SourceTexel * ( float( Scale ) * 0.5 - 0.5 );

	vec4 sum = vec4( 0.0 );
	for( int y = 0; y < Scale; ++y )
	{
		for( int x = 0; x < Scale; ++x )
		{
			sum += fetch( origin + SourceTexel * vec2( float( x ), float( y ) ) );
		}
	}

	fragColor = sum / float( Scale * Scale );
}
`;

const DEPTH = `#version 410 core
uniform sampler2D InputTexture;
uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;
uniform vec2 RingStep;

in vec2 uv;
out vec4 fragColor;

//The input can be bigger than the picture -- MaxUV is the fraction of it that
//was really drawn. Geometry is done in picture space and the scaling happens
//here, at the fetch, and the clamp stays half a texel inside because GL_LINEAR
//at the very edge takes half its weight from undrawn padding.
vec4 fetch( vec2 p )
{
	vec2 t = p * SourceMaxUV;
	return texture( InputTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}

float lumaAt( vec2 p )
{
	vec4 c = fetch( p );
	//The host hands over premultiplied alpha. Undo it before measuring
	//brightness, or every semi-transparent region reads as dark and therefore
	//as near.
	vec3 straight = c.a > 0.001 ? c.rgb / c.a : c.rgb;
	return dot( straight, vec3( 0.2126, 0.7152, 0.0722 ) );
}

void main()
{
	float centre = lumaAt( uv );

	//Local contrast as the range over a ring, not an edge detector. "Is there a
	//line here" is a different question: a hazy distant hillside has a smooth
	//gradient with no edges in it and plenty of range, and it is the range that
	//carries the distance.
	float lo = centre;
	float hi = centre;

	for( int i = 0; i < 8; ++i )
	{
		float a = float( i ) * 0.7853981634;//2*pi/8
		vec2 offset = vec2( cos( a ), sin( a ) ) * RingStep;
		float l = lumaAt( uv + offset );
		lo = min( lo, l );
		hi = max( hi, l );
	}

	//Scaled so a quarter of full swing already counts as fully detailed. Real
	//footage almost never puts a 0..1 range inside one small neighbourhood, and
	//unscaled the detail cue sits near zero everywhere and stops contributing.
	float detail = clamp( ( hi - lo ) * 4.0, 0.0, 1.0 );

	fragColor = vec4( centre, detail, 0.0, 1.0 );
}
`;

const SMOOTH = `#version 410 core
uniform sampler2D SourceTexture;
uniform vec2 Direction;

in vec2 uv;
out vec4 fragColor;

void main()
{
	//Nine taps, sigma about two of them. Wide enough to kill grain, narrow
	//enough that a real depth boundary -- a rooftop against sky -- does not
	//migrate far enough to put the blur on the wrong side of it.
	//
	//The source is one of our own buffers, so there is no MaxUV padding to
	//scale by and the clamp is the plain 0..1 edge.
	float weights[ 5 ] = float[ 5 ]( 0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162 );

	vec4 sum = texture( SourceTexture, uv ) * weights[ 0 ];

	for( int i = 1; i < 5; ++i )
	{
		vec2 offset = Direction * float( i );
		sum += texture( SourceTexture, clamp( uv + offset, vec2( 0.0 ), vec2( 1.0 ) ) ) * weights[ i ];
		sum += texture( SourceTexture, clamp( uv - offset, vec2( 0.0 ), vec2( 1.0 ) ) ) * weights[ i ];
	}

	fragColor = sum;
}
`;

const COC = `#version 410 core
uniform sampler2D DepthTexture;

uniform int Geometry;
uniform vec2 Centre;
uniform float Angle;
uniform float Width;
uniform float Feather;
uniform float EllipseAspect;
uniform float Horizon;
uniform float Tilt;
uniform float Rate;
uniform float DepthBias;
uniform float DepthContrast;
uniform float Invert;
uniform float FrameAspect;

in vec2 uv;
out vec4 fragColor;

//= mirrored: Focus.cpp bandCoords()
//'along' runs parallel to the band, 'across' along its normal, both in units of
//FRAME HEIGHT. The aspect correction is on the u axis only, which is what keeps
//a circle circular and a band the same thickness when the composition changes
//shape.
void bandCoords( vec2 p, out float along, out float across )
{
	float px = ( p.x - Centre.x ) * FrameAspect;
	float py = ( p.y - Centre.y );

	float c = cos( Angle );
	float s = sin( Angle );

	along  =  px * c + py * s;
	across = -px * s + py * c;
}

//= mirrored: Focus.cpp shape()
float shape( float raw )
{
	float feather = max( Feather, 1e-4 );

	float magnitude = smoothstep( 0.0, 1.0, ( abs( raw ) - Width ) / feather );

	if( Invert > 0.5 )
		magnitude = 1.0 - magnitude;

	//The sign is which side of focus, and it survives inversion.
	return raw < 0.0 ? -magnitude : magnitude;
}

//= mirrored: Focus.cpp guessedDepth()
float guessedDepth( float luma, float detail )
{
	float far = 0.5 * clamp( luma, 0.0, 1.0 ) + 0.5 * ( 1.0 - clamp( detail, 0.0, 1.0 ) );
	return clamp( 0.5 + ( far - 0.5 ) * max( DepthContrast, 0.0 ), 0.0, 1.0 );
}

void main()
{
	//GL's v runs up, Focus.cpp's runs down. Once, here.
	vec2 p = vec2( uv.x, 1.0 - uv.y );

	float along;
	float across;
	bandCoords( p, along, across );

	//The depth guess is reported even when it is not driving anything, so the
	//focus overlay can show what the mode would do before it is switched on.
	vec2 cues = texture( DepthTexture, uv ).rg;
	float depth = guessedDepth( cues.r, cues.g );

	float signedDefocus;

	//= mirrored: Focus.cpp defocus()
	if( Geometry == 1 )
	{
		//Radial. Measured in the band-aligned frame, so Angle rotates the
		//ellipse and Aspect stretches it along its own axes.
		float a  = max( EllipseAspect, 1e-3 );
		float ry = across / a;
		//Always positive: outside an ellipse there is no near and far to sign.
		signedDefocus = shape( sqrt( along * along + ry * ry ) );
	}
	else if( Geometry == 2 )
	{
		//Tilted plane. Inverse depth of a plane under perspective is affine in
		//image position and has a FLOOR -- nothing is further than infinity --
		//and that floor is the whole point of this mode. Past the horizon every
		//pixel shares one blur; on the near side there is no limit.
		float sceneW = max( 0.0, across - Horizon );
		float focusW = max( 0.0, -Horizon );

		//Tilt swings the focal plane about the viewing axis, so the focused
		//depth varies ALONG the band too and the sharp zone converges.
		float lensW = focusW + Tilt * along;

		signedDefocus = shape( Rate * ( sceneW - lensW ) );
	}
	else if( Geometry == 3 )
	{
		//Image depth. Width and Feather are in units of guessed depth here, not
		//frame height -- the axis being measured is not a distance in the
		//picture.
		signedDefocus = shape( depth - DepthBias );
	}
	else
	{
		signedDefocus = shape( across );
	}

	fragColor = vec4( signedDefocus, depth, 0.0, 1.0 );
}
`;

const GAUSSIAN = `#version 410 core
uniform sampler2D SourceTexture;
uniform sampler2D CoCTexture;

uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;

uniform vec2 Direction;  //unit vector: (1,0) horizontal pass, (0,1) vertical
uniform vec2 FrameSize;  //pixels, for converting a radius into picture space
uniform float MaxRadius; //pixels at full defocus
uniform int Taps;        //per side

in vec2 uv;
out vec4 fragColor;


//Reflect a picture-space coordinate back inside the frame, rather than clamp.
//
//Under a clamp every tap falling off the edge returns the edge texel, so the
//outermost row is averaged largely with copies of itself and comes out less
//blurred than the middle of the frame. Mirroring gives it real picture to
//average with instead, so the blur has the same strength everywhere.
//
//Worth being straight about the evidence: this was changed while chasing a
//measured non-monotonicity in tiltest --blur, on the theory that a sharp
//edge rim growing with the radius was the cause. It was NOT -- swapping clamp
//for mirror moved whole-frame detail from 3.24/4.26 to 3.24/4.26, which is to
//say not at all. The real cause was the tap sum aliasing, fixed by the box
//prefilter in Downsample.cpp.
//
//Mirroring is kept because it is the better edge rule on its own merits, not
//because it fixed anything measured here.
float mirror1( float x )
{
	x = abs( x );
	x = mod( x, 2.0 );
	return x > 1.0 ? 2.0 - x : x;
}

vec2 mirrorUV( vec2 p )
{
	return vec2( mirror1( p.x ), mirror1( p.y ) );
}

vec4 fetch( vec2 p )
{
	vec2 t = mirrorUV( p ) * SourceMaxUV;
	return texture( SourceTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}

/// Radius in pixels at a point. The CoC buffer is ours, so it has no padding.
float radiusAt( vec2 p )
{
	//Mirrored to match fetch(): the radius used at a tap must come from the
	//same place the colour did, or the reach test is comparing a tap against
	//somebody else's circle of confusion.
	return abs( texture( CoCTexture, mirrorUV( p ) ).r ) * MaxRadius;
}

void main()
{
	vec2 pixelToUV = 1.0 / FrameSize;

	//The gather radius is the largest CoC anywhere a blurred neighbour could be
	//reaching us from, not the centre's own. See the header.
	float radius = radiusAt( uv );
	for( int i = 1; i <= 2; ++i )
	{
		vec2 probe = Direction * ( MaxRadius * float( i ) * 0.5 ) * pixelToUV;
		radius = max( radius, radiusAt( uv + probe ) );
		radius = max( radius, radiusAt( uv - probe ) );
	}

	//Below half a pixel there is nothing a blur could do that the source has
	//not already done, and the whole sharp region takes this branch.
	if( radius < 0.5 )
	{
		fragColor = fetch( uv );
		return;
	}

	//The centre tap is unconditional: its own distance is zero, so it always
	//reaches itself, and it guarantees the weight sum can never be zero.
	vec4 sum = fetch( uv );
	float weightSum = 1.0;

	float step = radius / float( Taps );

	for( int i = 1; i <= Taps; ++i )
	{
		float distance = step * float( i );
		vec2 offset = Direction * distance * pixelToUV;

		//Three sigma at the far tap, so the kernel has actually decayed by the
		//time it is truncated rather than being chopped off mid-slope.
		float t = float( i ) / float( Taps );
		float gaussian = exp( -0.5 * ( t * 3.0 ) * ( t * 3.0 ) );

		//Two taps, one either side, each tested against its own CoC.
		for( int side = 0; side < 2; ++side )
		{
			vec2 at = side == 0 ? uv + offset : uv - offset;

			//Does this tap's circle of confusion actually reach us? The half
			//pixel of softness stops the test itself becoming a visible edge.
			float reach = clamp( ( radiusAt( at ) - distance ) * 0.5 + 0.5, 0.0, 1.0 );
			float w = gaussian * reach;

			sum += fetch( at ) * w;
			weightSum += w;
		}
	}

	fragColor = sum / weightSum;
}
`;

const BOKEH = `#version 410 core
uniform sampler2D SourceTexture;
uniform sampler2D CoCTexture;

uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;

uniform vec2 FrameSize;
uniform float MaxRadius;
uniform int Samples;
uniform int Blades;         //0 = circular aperture, otherwise 3..9
uniform float BladeRotation;//radians
uniform float Highlight;

in vec2 uv;
out vec4 fragColor;


//Reflect a picture-space coordinate back inside the frame, rather than clamp.
//
//Under a clamp every tap falling off the edge returns the edge texel, so the
//outermost row is averaged largely with copies of itself and comes out less
//blurred than the middle of the frame. Mirroring gives it real picture to
//average with instead, so the blur has the same strength everywhere.
//
//Worth being straight about the evidence: this was changed while chasing a
//measured non-monotonicity in tiltest --blur, on the theory that a sharp
//edge rim growing with the radius was the cause. It was NOT -- swapping clamp
//for mirror moved whole-frame detail from 3.24/4.26 to 3.24/4.26, which is to
//say not at all. The real cause was the tap sum aliasing, fixed by the box
//prefilter in Downsample.cpp.
//
//Mirroring is kept because it is the better edge rule on its own merits, not
//because it fixed anything measured here.
float mirror1( float x )
{
	x = abs( x );
	x = mod( x, 2.0 );
	return x > 1.0 ? 2.0 - x : x;
}

vec2 mirrorUV( vec2 p )
{
	return vec2( mirror1( p.x ), mirror1( p.y ) );
}

vec4 fetch( vec2 p )
{
	vec2 t = mirrorUV( p ) * SourceMaxUV;
	return texture( SourceTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}

float radiusAt( vec2 p )
{
	//Mirrored to match fetch(): the radius used at a tap must come from the
	//same place the colour did, or the reach test is comparing a tap against
	//somebody else's circle of confusion.
	return abs( texture( CoCTexture, mirrorUV( p ) ).r ) * MaxRadius;
}

/// How far the aperture opening extends at this angle, as a fraction of the
/// circumscribed circle. 1.0 everywhere for a circular aperture.
float apertureEdge( float theta )
{
	if( Blades < 3 )
		return 1.0;

	float segment = 6.2831853072 / float( Blades );
	float halfSegment = segment * 0.5;
	//Distance from the centre of the nearest blade facet, folded into
	//-half..+half, then the flat side of the polygon at that angle.
	float a = mod( theta + BladeRotation, segment ) - halfSegment;
	return cos( halfSegment ) / cos( a );
}

void main()
{
	vec2 pixelToUV = 1.0 / FrameSize;

	//Same dilation as the Gaussian path, but probed on a ring rather than along
	//an axis, because this pass has no axis.
	float radius = radiusAt( uv );
	for( int i = 0; i < 4; ++i )
	{
		float a = float( i ) * 1.5707963268;
		vec2 probe = vec2( cos( a ), sin( a ) ) * ( MaxRadius * 0.6 ) * pixelToUV;
		radius = max( radius, radiusAt( uv + probe ) );
	}

	if( radius < 0.5 )
	{
		fragColor = fetch( uv );
		return;
	}

	vec4 sum = vec4( 0.0 );
	float weightSum = 0.0;

	for( int i = 0; i < Samples; ++i )
	{
		float fi = ( float( i ) + 0.5 ) / float( Samples );
		//sqrt for uniform area density: without it every tap crowds the centre
		//and the disc has a hot core.
		float rho = sqrt( fi );
		float theta = float( i ) * 2.3999632297;

		rho *= apertureEdge( theta );

		float distance = rho * radius;
		vec2 at = uv + vec2( cos( theta ), sin( theta ) ) * distance * pixelToUV;

		float reach = clamp( ( radiusAt( at ) - distance ) * 0.5 + 0.5, 0.0, 1.0 );
		if( reach <= 0.0 )
			continue;

		vec4 c = fetch( at );

		//Premultiplied in, so undo it before judging brightness or every
		//semi-transparent highlight is weighted as though it were dim.
		vec3 straight = c.a > 0.001 ? c.rgb / c.a : c.rgb;
		float luma = dot( straight, vec3( 0.2126, 0.7152, 0.0722 ) );

		//Fourth power: gentle enough that mid-tones are barely reweighted,
		//steep enough that a clipped highlight is worth an order of magnitude
		//more than its neighbours and therefore paints a whole disc.
		float w = reach * ( 1.0 + Highlight * luma * luma * luma * luma );

		sum += c * w;
		weightSum += w;
	}

	//Every tap can fail the reach test on a lone sharp pixel inside a blurred
	//neighbourhood. Falling back to the centre is right and, more to the point,
	//is not a divide by zero in somebody's programme output.
	fragColor = weightSum > 0.0 ? sum / weightSum : fetch( uv );
}
`;

const COMPOSITE = `#version 410 core
uniform sampler2D BlurredTexture;
uniform sampler2D InputTexture;
uniform sampler2D CoCTexture;

uniform vec2 SourceMaxUV;
uniform vec2 SourceHalfTexel;

uniform float Saturation;
uniform float Contrast;
uniform float Vignette;
uniform float Aberration;
uniform float Mix;
uniform float ShowFocus;
uniform float FrameAspect;
uniform float MaxRadius;//composition pixels at full defocus

in vec2 uv;
out vec4 fragColor;

vec4 fetchInput( vec2 p )
{
	vec2 t = p * SourceMaxUV;
	return texture( InputTexture, clamp( t, SourceHalfTexel, SourceMaxUV - SourceHalfTexel ) );
}

vec4 fetchBlurred( vec2 p )
{
	return texture( BlurredTexture, clamp( p, vec2( 0.0 ), vec2( 1.0 ) ) );
}

void main()
{
	float signedDefocus = texture( CoCTexture, uv ).r;
	float defocus = abs( signedDefocus );

	//Distance from the frame centre, aspect corrected, for both the aberration
	//direction and the vignette.
	vec2 fromCentre = vec2( ( uv.x - 0.5 ) * FrameAspect, uv.y - 0.5 );
	float radial = length( fromCentre );

	vec4 colour;

	if( Aberration > 0.0001 && defocus > 0.0001 )
	{
		//Lateral aberration: the three channels are magnified slightly
		//differently, so they are fetched at slightly different distances from
		//the frame centre. Signed, so the fringe swaps sides across focus.
		vec2 direction = radial > 0.0001 ? fromCentre / radial : vec2( 0.0 );
		vec2 shift = direction * ( Aberration * signedDefocus * 0.01 );

		vec4 mid = fetchBlurred( uv );
		colour.r = fetchBlurred( uv + shift ).r;
		colour.g = mid.g;
		colour.b = fetchBlurred( uv - shift ).b;
		colour.a = mid.a;
	}
	else
	{
		colour = fetchBlurred( uv );
	}

	/*
	    Bring the sharp picture back where the lens is sharp.

	    The blurred texture is a LOWER RESOLUTION buffer (Downsample.cpp), so
	    taking it everywhere would cost the in-focus band the very sharpness the
	    plugin exists to preserve. Instead the two are blended by how big the
	    circle of confusion actually is: under about a pixel there is nothing for
	    a blur to do and the untouched full-resolution input is exactly right,
	    and by two pixels the blurred copy has taken over completely.

	    The threshold is in pixels rather than in normalised defocus on purpose.
	    "The blur is smaller than a pixel" is the honest test for whether a blur
	    is visible at all, and it holds at any resolution and any Blur setting,
	    where a fixed defocus threshold would not.
	*/
	float radiusPixels = defocus * MaxRadius;
	colour = mix( fetchInput( uv ), colour, smoothstep( 0.5, 2.0, radiusPixels ) );

	//Grade in straight alpha. Contrast on a premultiplied pixel pushes the
	//colour and the coverage in the same direction and turns every soft edge
	//into a hard one.
	float alpha = colour.a;
	vec3 straight = alpha > 0.001 ? colour.rgb / alpha : colour.rgb;

	float luma = dot( straight, vec3( 0.2126, 0.7152, 0.0722 ) );
	straight = mix( vec3( luma ), straight, Saturation );
	straight = ( straight - 0.5 ) * Contrast + 0.5;

	if( Vignette > 0.0001 )
	{
		//Falls off from about the middle of the frame outward. The 0.7 is
		//roughly the radius of a 16:9 frame's corner, so a Vignette of 1 puts
		//the corner at zero and the centre untouched.
		float v = smoothstep( 0.7, 0.25, radial );
		straight *= mix( 1.0, v, Vignette );
	}

	straight = max( straight, vec3( 0.0 ) );
	colour = vec4( straight * alpha, alpha );

	if( ShowFocus > 0.5 )
	{
		//Sharp keeps its colour; blurred goes grey and takes a tint that says
		//which side of focus it fell on. Warm for the near side, cold for the
		//far side -- the same way a photographer would think about it.
		//
		//POSITIVE is the near side, and the sign is not arbitrary. In Tilted
		//Plane the raw quantity is scene inverse depth minus lens inverse
		//depth, and inverse depth grows as things get closer -- so positive
		//means the scene is nearer than the plane of focus. Linear Band agrees
		//by construction: positive is below the band, which is the near end of
		//a frame shot looking down. Radial has no near and far at all and is
		//always positive, so its single tint carries no meaning; that is fine,
		//it only has to be uniform.
		//
		//This was the wrong way round until the contact sheet showed the top of
		//a downward-looking frame -- the horizon, the furthest thing in shot --
		//painted with the near-side colour. Every automated check passed with
		//it inverted, because the field itself was correct and only the label
		//on it was not.
		vec3 tint = signedDefocus > 0.0 ? vec3( 1.0, 0.35, 0.15 ) : vec3( 0.15, 0.5, 1.0 );
		float grey = dot( straight, vec3( 0.2126, 0.7152, 0.0722 ) );
		vec3 marked = mix( straight, mix( vec3( grey ), tint, 0.6 ), defocus );
		colour = vec4( marked * alpha, alpha );
	}

	//Wet/dry against the untouched input. Last, so it undoes everything above
	//it rather than some of it.
	fragColor = mix( fetchInput( uv ), colour, Mix );
}
`;

//---------------------------------------------------------------------------
// Port of source/Controls.cpp
//
// Every curve here has a twin in that file. The rule it encodes: anything that
// is a ratio converts exponentially so half a slider is unity, anything that is
// a position or an amount converts linearly, and anything centred on "no
// change" puts that at 0.5.
//---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;

/// A ratio control: 0.5 is unity, equal distances either side are reciprocal.
const ratio = (x, span) => Math.exp((x - 0.5) * 2 * Math.log(span));

/// Option parameters hold the element value, not a 0..1 fraction.
const option = (v, count) => Math.min(Math.max(Math.round(v), 0), count - 1);

/// Quality is a tap budget and nothing else — it never changes the blur's size.
const QUALITY = [
  { taps: 4, samples: 24 },
  { taps: 8, samples: 48 },
  { taps: 16, samples: 96 },
];

/// Real aperture blade counts; 0 is a wide-open lens, which has no polygon.
const BLADES = [0, 5, 6, 7, 8, 9];

function fieldFrom(params, aspectRatio) {
  return {
    geometry: option(params.get('focusShape'), 4),
    centreU: params.get('focusX'),
    centreV: params.get('focusY'),
    // Plus or minus a quarter turn: a band is its own mirror image at 180.
    angle: (params.get('angle') - 0.5) * Math.PI,
    width: params.get('focusWidth') * 0.5,
    feather: lerp(0.001, 0.6, params.get('feather')),
    aspect: ratio(params.get('irisAspect'), 4),
    // Negative is above the sharp zone, where a horizon usually is.
    horizon: lerp(-0.6, 0.6, params.get('horizon')),
    tilt: (params.get('tilt') - 0.5) * 2,
    rate: ratio(params.get('falloffRate'), 4),
    depthBias: params.get('depthFocus'),
    depthContrast: params.get('depthContrast') * 3,
    invert: params.get('invertFocus') >= 0.5,
    aspectRatio,
  };
}

function lensFrom(params, frameHeight) {
  // A fraction of the frame height, not pixels, so the same slider looks the
  // same at any resolution.
  const maxRadius = params.get('blurAmount') * 0.08 * Math.max(frameHeight, 1);

  const quality = QUALITY[option(params.get('quality'), 3)];

  // The blur runs on a box-downsampled copy at a scale chosen from the radius.
  // Not an optimisation: a sparse gather aliases its own source, and it gets
  // worse as the radius grows. See source/shaders/Downsample.cpp.
  const blurScale = Math.min(8, Math.max(1, Math.round(maxRadius / 12)));
  const blurRadius = maxRadius / blurScale;

  return {
    model: option(params.get('blur'), 2),
    maxRadius,
    blurScale,
    blurRadius,
    gaussianTaps: Math.min(quality.taps * 3, Math.max(quality.taps, Math.ceil(blurRadius))),
    bokehSamples: Math.min(
      quality.samples * 2,
      Math.max(quality.samples, Math.ceil((Math.PI * blurRadius * blurRadius) / 4)),
    ),
    blades: BLADES[option(params.get('aperture'), 6)],
    bladeRotation: params.get('apertureAngle') * 1.5707963,
    highlight: params.get('highlights') * 8,
    saturation: params.get('saturation') * 2,
    contrast: params.get('contrast') * 2,
    vignette: params.get('vignette'),
    aberration: params.get('aberration'),
    showFocus: params.get('showFocus') >= 0.5,
    mix: params.get('mix'),
  };
}

//---------------------------------------------------------------------------
// The renderer: the same chain, in the same order, as ProcessOpenGL.
//---------------------------------------------------------------------------

function createRenderer(gl, quad) {
  const downsampleShader = new Program(gl, VERTEX, DOWNSAMPLE, 'downsample');
  const depthShader = new Program(gl, VERTEX, DEPTH, 'depth');
  const smoothShader = new Program(gl, VERTEX, SMOOTH, 'smooth');
  const cocShader = new Program(gl, VERTEX, COC, 'coc');
  const gaussianShader = new Program(gl, VERTEX, GAUSSIAN, 'gaussian');
  const bokehShader = new Program(gl, VERTEX, BOKEH, 'bokeh');
  const compositeShader = new Program(gl, VERTEX, COMPOSITE, 'composite');

  const depthBuffer = [new PassBuffer(gl), new PassBuffer(gl)];
  const cocBuffer = new PassBuffer(gl);
  const sourceBuffer = new PassBuffer(gl);
  const blurBuffer = [new PassBuffer(gl), new PassBuffer(gl)];

  return {
    render({ input, params, width, height }) {
      const RGBA16F = gl.RGBA16F;

      const aspectRatio = width / height;
      const field = fieldFrom(params, aspectRatio);
      const lens = lensFrom(params, height);

      const needsDepth = field.geometry === 3;

      const depthW = Math.max(1, Math.floor(width / 4));
      const depthH = Math.max(1, Math.floor(height / 4));
      const blurW = Math.max(1, Math.floor(width / lens.blurScale));
      const blurH = Math.max(1, Math.floor(height / lens.blurScale));

      // Every allocation first, before anything is bound.
      cocBuffer.ensure(width, height, RGBA16F);
      sourceBuffer.ensure(blurW, blurH, RGBA16F);
      blurBuffer[0].ensure(blurW, blurH, RGBA16F);
      blurBuffer[1].ensure(blurW, blurH, RGBA16F);
      if (needsDepth) {
        depthBuffer[0].ensure(depthW, depthH, RGBA16F);
        depthBuffer[1].ensure(depthW, depthH, RGBA16F);
      }

      // The demo's clip is a clean texture, so there is no padding to scale by.
      const maxU = 1;
      const maxV = 1;
      const halfTexelU = 0.5 / input.width;
      const halfTexelV = 0.5 / input.height;

      gl.disable(gl.BLEND);

      //------------------------------------------------------------------
      // 1. Depth cues, then smooth them. Image Depth only.
      //------------------------------------------------------------------
      if (needsDepth) {
        depthBuffer[0].bind();
        depthShader.use();
        bindTexture(gl, 0, input.texture);
        depthShader.setSampler('InputTexture', 0);
        depthShader.set('MaxUV', 1, 1);
        depthShader.set('SourceMaxUV', maxU, maxV);
        depthShader.set('SourceHalfTexel', halfTexelU, halfTexelV);
        depthShader.set('RingStep', 1.5 / depthW, 1.5 / depthH);
        quad.draw();

        const smooths = [
          { from: 0, to: 1, dx: 1 / depthW, dy: 0 },
          { from: 1, to: 0, dx: 0, dy: 1 / depthH },
        ];
        for (const pass of smooths) {
          depthBuffer[pass.to].bind();
          smoothShader.use();
          bindTexture(gl, 0, depthBuffer[pass.from].texture);
          smoothShader.setSampler('SourceTexture', 0);
          smoothShader.set('MaxUV', 1, 1);
          smoothShader.set('Direction', pass.dx, pass.dy);
          quad.draw();
        }
      }

      //------------------------------------------------------------------
      // 2. The circle of confusion field.
      //------------------------------------------------------------------
      cocBuffer.bind();
      cocShader.use();
      // Bound even when the geometry does not read it: a sampler pointing at
      // nothing is undefined behaviour, not a harmless no-op.
      bindTexture(gl, 0, needsDepth ? depthBuffer[0].texture : input.texture);
      cocShader.setSampler('DepthTexture', 0);
      cocShader.set('MaxUV', 1, 1);
      // Geometry is an int uniform: setInt, never set(). A float write to an
      // int uniform is a GL_INVALID_OPERATION that leaves it at zero, silently.
      cocShader.setInt('Geometry', field.geometry);
      cocShader.set('Centre', field.centreU, field.centreV);
      cocShader.set('Angle', field.angle);
      cocShader.set('Width', field.width);
      cocShader.set('Feather', field.feather);
      cocShader.set('EllipseAspect', field.aspect);
      cocShader.set('Horizon', field.horizon);
      cocShader.set('Tilt', field.tilt);
      cocShader.set('Rate', field.rate);
      cocShader.set('DepthBias', field.depthBias);
      cocShader.set('DepthContrast', field.depthContrast);
      cocShader.set('Invert', field.invert ? 1 : 0);
      cocShader.set('FrameAspect', field.aspectRatio);
      quad.draw();

      //------------------------------------------------------------------
      // 3. The picture the blur works on, box filtered down.
      //------------------------------------------------------------------
      sourceBuffer.bind();
      downsampleShader.use();
      bindTexture(gl, 0, input.texture);
      downsampleShader.setSampler('InputTexture', 0);
      downsampleShader.set('MaxUV', 1, 1);
      downsampleShader.set('SourceMaxUV', maxU, maxV);
      downsampleShader.set('SourceHalfTexel', halfTexelU, halfTexelV);
      downsampleShader.set('SourceTexel', 1 / width, 1 / height);
      downsampleShader.setInt('Scale', lens.blurScale);
      quad.draw();

      //------------------------------------------------------------------
      // 4. The blur. One model or the other, never both.
      //------------------------------------------------------------------
      const blurHalfTexelU = 0.5 / blurW;
      const blurHalfTexelV = 0.5 / blurH;
      let blurredTexture;

      if (lens.model === 1) {
        blurBuffer[0].bind();
        bokehShader.use();
        bindTexture(gl, 0, sourceBuffer.texture);
        bindTexture(gl, 1, cocBuffer.texture);
        bokehShader.setSampler('SourceTexture', 0);
        bokehShader.setSampler('CoCTexture', 1);
        bokehShader.set('MaxUV', 1, 1);
        bokehShader.set('SourceMaxUV', 1, 1);
        bokehShader.set('SourceHalfTexel', blurHalfTexelU, blurHalfTexelV);
        bokehShader.set('FrameSize', blurW, blurH);
        bokehShader.set('MaxRadius', lens.blurRadius);
        bokehShader.setInt('Samples', lens.bokehSamples);
        bokehShader.setInt('Blades', lens.blades);
        bokehShader.set('BladeRotation', lens.bladeRotation);
        bokehShader.set('Highlight', lens.highlight);
        quad.draw();

        blurredTexture = blurBuffer[0].texture;
      } else {
        const passes = [
          { to: 0, dx: 1, dy: 0, fromSource: true },
          { to: 1, dx: 0, dy: 1, fromSource: false },
        ];
        for (const pass of passes) {
          blurBuffer[pass.to].bind();
          gaussianShader.use();
          bindTexture(gl, 0, pass.fromSource ? sourceBuffer.texture : blurBuffer[0].texture);
          bindTexture(gl, 1, cocBuffer.texture);
          gaussianShader.setSampler('SourceTexture', 0);
          gaussianShader.setSampler('CoCTexture', 1);
          gaussianShader.set('MaxUV', 1, 1);
          gaussianShader.set('SourceMaxUV', 1, 1);
          gaussianShader.set('SourceHalfTexel', blurHalfTexelU, blurHalfTexelV);
          gaussianShader.set('Direction', pass.dx, pass.dy);
          gaussianShader.set('FrameSize', blurW, blurH);
          gaussianShader.set('MaxRadius', lens.blurRadius);
          gaussianShader.setInt('Taps', lens.gaussianTaps);
          quad.draw();
        }

        blurredTexture = blurBuffer[1].texture;
      }

      //------------------------------------------------------------------
      // 5. The photograph, straight to the canvas.
      //------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);

      compositeShader.use();
      bindTexture(gl, 0, blurredTexture);
      bindTexture(gl, 1, input.texture);
      bindTexture(gl, 2, cocBuffer.texture);
      compositeShader.setSampler('BlurredTexture', 0);
      compositeShader.setSampler('InputTexture', 1);
      compositeShader.setSampler('CoCTexture', 2);
      compositeShader.set('MaxUV', 1, 1);
      compositeShader.set('SourceMaxUV', maxU, maxV);
      compositeShader.set('SourceHalfTexel', halfTexelU, halfTexelV);
      compositeShader.set('Saturation', lens.saturation);
      compositeShader.set('Contrast', lens.contrast);
      compositeShader.set('Vignette', lens.vignette);
      compositeShader.set('Aberration', lens.aberration);
      compositeShader.set('Mix', lens.mix);
      compositeShader.set('ShowFocus', lens.showFocus ? 1 : 0);
      compositeShader.set('FrameAspect', aspectRatio);
      compositeShader.set('MaxRadius', lens.maxRadius);
      quad.draw();
    },
  };
}

//---------------------------------------------------------------------------

const degrees = (v) => `${(((v - 0.5) * 180).toFixed(0))}°`;

mountDemo({
  name: 'Tilter',
  pluginId: 'TL01',
  tagline:
    'A tilt-shift lens: a shallow plane of focus with a real aperture behind it. The plugin works out how far each pixel is from focus, and a blur consumes that — so the shape of the focus and the character of the blur are chosen separately.',
  repo: 'https://github.com/stoatworks-labs/tilter',

  showBackdrop: true,

  // The chain runs through RGBA16F buffers, and a float render target is an
  // opt-in in WebGL2 (EXT_color_buffer_float) where desktop GL just has it.
  // Without this every pass buffer comes back GL_FRAMEBUFFER_INCOMPLETE_
  // ATTACHMENT, which the page reports as "pass buffer incomplete (0x8cd6)".
  //
  // Not a nicety: the circle-of-confusion field is SIGNED, and eight bits with
  // no sign would clamp the entire near side of focus to zero. The picture
  // would still render, and would simply be wrong on one side.
  needFloat: true,

  params: [
    {
      id: 'focusShape', name: 'Focus Shape', type: 'option', default: 0, group: 'Focus',
      elements: ['Linear Band', 'Radial', 'Tilted Plane', 'Image Depth (guess)'],
      hint: 'Tilted Plane is the one with a real lens’s falloff: past the horizon the blur stops growing. Image Depth guesses distance from haze in the picture and is labelled a guess because it is one.',
    },
    { id: 'focusX', name: 'Focus X', type: 'standard', default: 0.5, group: 'Focus',
      hint: 'Does nothing to a perfectly horizontal band — the band is infinite along its own axis. Turn Angle or Tilt off neutral first.' },
    { id: 'focusY', name: 'Focus Y', type: 'standard', default: 0.55, group: 'Focus',
      hint: '0 is the top of the frame.' },
    { id: 'angle', name: 'Angle', type: 'standard', default: 0.5, group: 'Focus',
      display: degrees,
      hint: 'Plus or minus 90 degrees. A band is its own mirror image at 180, so a full turn would show every angle twice.' },
    { id: 'focusWidth', name: 'Focus Width', type: 'standard', default: 0.25, group: 'Focus',
      display: (v) => `${(v * 0.5).toFixed(3)} frame heights` },
    { id: 'feather', name: 'Feather', type: 'standard', default: 0.4, group: 'Focus' },
    { id: 'irisAspect', name: 'Iris Aspect', type: 'standard', default: 0.5, group: 'Focus',
      display: (v) => `${ratio(v, 4).toFixed(2)}×`,
      hint: 'Radial only.' },
    { id: 'horizon', name: 'Horizon', type: 'standard', default: 0.35, group: 'Focus',
      hint: 'Tilted Plane only: where infinity sits. Past it every pixel shares one blur, which is the thing a plain band cannot do.' },
    { id: 'tilt', name: 'Tilt', type: 'standard', default: 0.5, group: 'Focus',
      display: (v) => ((v - 0.5) * 2).toFixed(2),
      hint: 'Tilted Plane only: swings the focal plane so the sharp zone converges.' },
    { id: 'falloffRate', name: 'Falloff Rate', type: 'standard', default: 0.5, group: 'Focus',
      display: (v) => `${ratio(v, 4).toFixed(2)}×`,
      hint: 'Tilted Plane only. The aperture, in effect.' },
    { id: 'depthFocus', name: 'Depth Focus', type: 'standard', default: 0.7, group: 'Focus',
      hint: 'Image Depth only.' },
    { id: 'depthContrast', name: 'Depth Contrast', type: 'standard', default: 0.45, group: 'Focus',
      hint: 'Image Depth only.' },
    { id: 'invertFocus', name: 'Invert Focus', type: 'boolean', default: 0, group: 'Focus' },

    {
      id: 'blur', name: 'Blur', type: 'option', default: 0, group: 'Lens',
      elements: ['Gaussian', 'Bokeh Disc'],
      hint: 'Bokeh gathers over a real aperture and makes highlights bloom into its shape. Gaussian is cheaper and smears them.',
    },
    { id: 'blurAmount', name: 'Blur Amount', type: 'standard', default: 0.4, group: 'Lens',
      display: (v) => `${(v * 0.08 * 100).toFixed(1)}% of height` },
    { id: 'quality', name: 'Quality', type: 'option', default: 1, group: 'Lens',
      elements: ['Draft', 'Good', 'Best'],
      hint: 'A tap budget, never the size of the blur.' },
    { id: 'aperture', name: 'Aperture', type: 'option', default: 0, group: 'Lens',
      elements: ['Circular', '5 Blades', '6 Blades', '7 Blades', '8 Blades', '9 Blades'],
      hint: 'The shape of the hole the light comes through, and therefore of every out-of-focus highlight. Bokeh only.' },
    { id: 'apertureAngle', name: 'Aperture Angle', type: 'standard', default: 0, group: 'Lens' },
    { id: 'highlights', name: 'Highlights', type: 'standard', default: 0.35, group: 'Lens',
      hint: 'How strongly bright points dominate the blur. This is what turns them into discs rather than smears. Bokeh only.' },

    { id: 'saturation', name: 'Saturation', type: 'standard', default: 0.5, group: 'Photograph',
      display: (v) => `${(v * 2).toFixed(2)}×` },
    { id: 'contrast', name: 'Contrast', type: 'standard', default: 0.5, group: 'Photograph',
      display: (v) => `${(v * 2).toFixed(2)}×` },
    { id: 'vignette', name: 'Vignette', type: 'standard', default: 0.2, group: 'Photograph' },
    { id: 'aberration', name: 'Aberration', type: 'standard', default: 0.15, group: 'Photograph',
      hint: 'Grows with defocus and reverses across the plane of focus, the way real glass does.' },

    { id: 'showFocus', name: 'Show Focus', type: 'boolean', default: 0, group: 'Output',
      hint: 'Paints the field over the picture: warm is the near side of focus, cold is the far side.' },
    { id: 'mix', name: 'Mix', type: 'standard', default: 1, group: 'Output' },
  ],

  sources: ['scene', 'grid', 'detail', 'spot', 'bars', 'alpha'],

  presets: {
    'Model Village': {
      focusShape: 0, focusWidth: 0.18, feather: 0.35, blur: 1, blurAmount: 0.55,
      aperture: 2, highlights: 0.4, saturation: 0.66, contrast: 0.6, vignette: 0.3, aberration: 0.15,
    },
    'Toy Traffic': {
      focusShape: 0, focusWidth: 0.1, feather: 0.22, blur: 1, blurAmount: 0.75,
      aperture: 1, apertureAngle: 0.2, highlights: 0.6, saturation: 0.72, contrast: 0.62,
      vignette: 0.35, aberration: 0.2,
    },
    'Street Level': {
      focusShape: 2, focusWidth: 0.12, feather: 0.3, horizon: 0.3, tilt: 0.68, falloffRate: 0.55,
      blur: 1, blurAmount: 0.5, aperture: 2, highlights: 0.35, saturation: 0.6, contrast: 0.56,
      vignette: 0.25, aberration: 0.12,
    },
    'Portrait Iris': {
      focusShape: 1, focusWidth: 0.2, feather: 0.32, irisAspect: 0.55, blur: 1, blurAmount: 0.6,
      aperture: 0, highlights: 0.7, saturation: 0.54, contrast: 0.52, vignette: 0.3, aberration: 0.1,
    },
    'Anamorphic Dream': {
      focusShape: 1, focusWidth: 0.16, feather: 0.34, irisAspect: 0.78, blur: 1, blurAmount: 0.62,
      aperture: 0, highlights: 0.8, saturation: 0.58, contrast: 0.5, vignette: 0.45, aberration: 0.5,
    },
    'Show me the field': {
      focusShape: 2, tilt: 0.68, horizon: 0.3, blurAmount: 0.55, showFocus: 1,
    },
  },

  differences: [
    'The plugin’s central claim is checkable here rather than taken on trust: turn Show Focus on and the field you see is the same buffer the blur reads, not a second drawing of it.',
    'Tilted Plane against Linear Band is the comparison worth making. On a flat subject a real tilted lens gives exactly a straight band, so the shapes agree — what differs is that Tilted Plane stops blurring past the horizon and a band never does.',
    'The blur runs on a box-downsampled copy, at the same scale the plugin picks. An isolated highlight of two or three pixels will not form a clean bokeh disc in either — that is a property of gather-based defocus, not of this page.',
    'The plugin’s numerical proof — its GLSL measured against an independent C++ implementation of the focus field, agreeing to the last bit 16-bit float can hold — is an offline harness in the repository. Nothing on this page measures anything.',
  ],

  createRenderer,
});
