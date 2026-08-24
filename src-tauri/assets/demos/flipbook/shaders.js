/*
    The Flipbook passes, ported to WebGL2 (GLSL ES 3.00).

    This is a PORT, not a mirror the tests rely on: the plugin's GLSL 4.10 in
    source/Shaders.cpp stays the single home of the algorithm, and this file
    follows it. The differences are mechanical — the ES version and precision
    header, and `Rotation` arriving per draw rather than as a uniform the C++
    happens to set last.

    Everything that matters is the same, and two things in particular are
    deliberately NOT simplified for the browser:

    - **The half-texel inset.** Drop it and every sprite carries a one-pixel
      seam of its neighbour, exactly as in the plugin. It is the single most
      visible thing this shader does.
    - **Straight alpha until the final line.** The key is asked before the
      picture is multiplied by anything, because a colour key against
      premultiplied pixels compares the swatch with rgb * a.

    Keep the maths in step with source/Shaders.cpp when it changes.
*/

export const BACKGROUND_VERT = `#version 300 es
out vec2 vUV;
void main()
{
	// Attributeless. A triangle strip of four gives the corners in the order
	// (-1,-1) (1,-1) (-1,1) (1,1), which is what the bit tests below produce.
	vec2 c = vec2( ( gl_VertexID & 1 ) == 0 ? -1.0 : 1.0,
	               ( gl_VertexID & 2 ) == 0 ? -1.0 : 1.0 );
	vUV = c * 0.5 + 0.5;
	gl_Position = vec4( c, 0.0, 1.0 );
}`;

export const BACKGROUND_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec4 BackColour;
out vec4 fragColor;
void main()
{
	fragColor = vec4( BackColour.rgb * BackColour.a, BackColour.a );
}`;

export const SPRITE_VERT = `#version 300 es
uniform vec4 Xform[ 64 ];   // centre.xy in frame space (y down), half extents.xy
uniform vec4 Cell[ 64 ];    // the cell rect in sheet UV: u0, v0, u1, v1
uniform float Rotation;     // radians, shared by every copy

out vec2 vCellUV;
out vec4 vCell;

void main()
{
	vec2 c = vec2( ( gl_VertexID & 1 ) == 0 ? -1.0 : 1.0,
	               ( gl_VertexID & 2 ) == 0 ? -1.0 : 1.0 );

	vec4 xf = Xform[ gl_InstanceID ];
	vCell   = Cell[ gl_InstanceID ];

	// The half extents already carry the cell's aspect, the fit, the scale and
	// the short-edge correction — and their SIGN carries the flips.
	vec2 local = c * xf.zw;

	float ca = cos( Rotation );
	float sa = sin( Rotation );
	vec2 rotated = vec2( local.x * ca - local.y * sa,
	                     local.x * sa + local.y * ca );

	vec2 framePos = xf.xy + rotated;

	// Taken from c rather than from the rotated position, because it has to be
	// the sprite's own coordinate: rotating the quad must rotate the picture
	// with it, not slide the sprite across a fixed window.
	vCellUV = c * 0.5 + 0.5;

	gl_Position = vec4( framePos.x * 2.0 - 1.0, 1.0 - framePos.y * 2.0, 0.0, 1.0 );
}`;

export const SPRITE_FRAG = `#version 300 es
precision highp float;

in vec2 vCellUV;
in vec4 vCell;

uniform sampler2D Sheet;

// Half a texel of the sheet, on each axis. The sample is clamped into the cell
// by this much, so linear filtering at a cell boundary repeats the cell's own
// outer texel instead of blending in the first texel of the neighbouring
// sprite. Without it every sprite carries a one-pixel seam of the one beside
// it, which reads as a decode fault rather than as a filtering choice.
uniform vec2 Inset;

uniform int KeyMode;        // 0 alpha, 1 luma, 2 colour, 3 none
uniform vec3 KeyColour;
uniform float KeyTolerance;
uniform float KeySoftness;

uniform vec3 Tint;
uniform float Opacity;

out vec4 fragColor;

void main()
{
	vec2 uv = mix( vCell.xy, vCell.zw, vCellUV );
	uv = clamp( uv, vCell.xy + Inset, vCell.zw - Inset );

	// Straight alpha, on purpose, until the last line of this function.
	vec4 texel = texture( Sheet, uv );

	float alpha = texel.a;

	if( KeyMode == 1 )
	{
		// Luma: distance in brightness only, so a background that is flat in
		// tone but noisy in hue comes out cleanly. Rec. 709 weights.
		float luma    = dot( texel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		float keyLuma = dot( KeyColour, vec3( 0.2126, 0.7152, 0.0722 ) );
		alpha *= smoothstep( KeyTolerance, KeyTolerance + KeySoftness + 0.0001, abs( luma - keyLuma ) );
	}
	else if( KeyMode == 2 )
	{
		// Colour: straight RGB distance. Not a chroma key — a sprite sheet's
		// background is a flat exported colour, not a lit cyclorama.
		float d = length( texel.rgb - KeyColour );
		alpha *= smoothstep( KeyTolerance, KeyTolerance + KeySoftness + 0.0001, d );
	}
	else if( KeyMode == 3 )
	{
		alpha = 1.0;
	}

	alpha *= Opacity;

	// Premultiply, once, here.
	fragColor = vec4( texel.rgb * Tint * alpha, alpha );
}`;
