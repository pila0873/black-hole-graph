#version 300 es
/*
 * starquad.frag.glsl
 *
 * Soft radial profile for the star atlas. A 1 px star has a flat core (it was
 * snapped to a texel centre by StarAtlas.ts); larger, brighter stars get a
 * progressively softer profile and a faint halo. The atlas stores straight
 * alpha, so the compositor multiplies by alpha when sampling.
 */
precision highp float;

in vec2 vLocal;
in vec3 vColor;
in float vAlpha;
in float vSoft;
layout(location = 0) out vec4 fragColor;

void main() {
  float d2 = dot(vLocal, vLocal);
  if (d2 > 1.0) discard;

  float d = sqrt(d2);
  float coreRadius = mix(0.55, 0.74, vSoft);
  float core = 1.0 - smoothstep(0.0, coreRadius, d);
  core *= core;
  float halo = (1.0 - smoothstep(0.24, 1.0, d)) * mix(0.0, 0.28, vSoft);

  float alpha = clamp(vAlpha * (core + halo), 0.0, 1.0);
  fragColor = vec4(vColor, alpha);
}
