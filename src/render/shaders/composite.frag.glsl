#version 300 es
/*
 * composite.frag.glsl
 *
 * Final shading pass: scene + bloom, exposure, ACES tonemap, gamma 2.2.
 * Runs at the offscreen resolution (which is also the canvas backing store and
 * the FXAA input), so the blit is always 1:1 pixels.
 */
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloomTex;
uniform float uBloom;      // bloom strength (0 disables)
uniform float uExposure;
uniform vec2  uResolution; // canvas backing size, for the aspect-correct vignette

/* Narkowicz 2015 ACES filmic fit. */
vec3 acesToneMap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloomTex, vUv).rgb;

  vec3 c = scene + bloom * uBloom;
  c *= uExposure;

  c = acesToneMap(c);

  /* No shadow lift: the background must be a true black so the stars and the
   * lensed shadow read cleanly (and so the 2D galaxy layer sits on black). */

  /* Gentle vignette, kept circular on non-square canvases. Multiplicative, so
   * pure black stays pure black. */
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
  c *= 1.0 - 0.10 * dot(q, q);

  /* Linear -> sRGB. */
  c = pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));

  /* 8-bit dither: kills banding in the dark gradients. It is gated by the
   * pixel's own luma so the true-black background stays exactly 0 after the
   * 8-bit store (no grey noise floor around the shadow). Fixed per pixel, so
   * it never shimmers. */
  float luma = max(c.r, max(c.g, c.b));
  float dither = (hash12(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  c += dither * smoothstep(1.0 / 255.0, 4.0 / 255.0, luma);
  c = max(c, vec3(0.0));

  fragColor = vec4(c, 1.0);
}
