#version 300 es
/*
 * starquad.vert.glsl
 *
 * Instanced quad expansion for the star atlas. Each instance is one star
 * centre in equirectangular uv, a diameter in atlas texels, a blackbody colour
 * and an alpha. Corners come from a shared four-vertex strip. Quads are used
 * instead of point sprites because geometry clipping lets a seam star wrap
 * across the REPEAT edge correctly.
 */
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aCenter;
layout(location = 2) in float aSize;
layout(location = 3) in vec3 aColor;
layout(location = 4) in float aAlpha;

uniform vec2 uAtlasSize;

out vec2 vLocal;
out vec3 vColor;
out float vAlpha;
out float vSoft;

void main() {
  vec2 halfTexel = vec2(max(0.5, aSize * 0.5));
  vec2 uv = aCenter + aCorner * halfTexel / uAtlasSize;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);

  vLocal = aCorner;
  vColor = aColor;
  vAlpha = aAlpha;
  vSoft = clamp((aSize - 1.0) / 6.0, 0.0, 1.0);
}
