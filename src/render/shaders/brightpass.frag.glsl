#version 300 es
/*
 * brightpass.frag.glsl
 *
 * Threshold + 4x downsample of the HDR scene into the first bloom mip.
 * Four bilinear taps at +-2 source texels approximate a 4x4 box filter.
 */
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2  uTexel;      // 1 / source resolution
uniform float uThreshold;  // bright pass threshold (in linear HDR units)

vec3 prefilter(vec3 c) {
  float brightness = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.6 + 1e-4;
  float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 1e-4);
  return c * contribution;
}

void main() {
  vec2 o = uTexel * 2.0;
  vec3 c = prefilter(texture(uSource, vUv + vec2(-o.x, -o.y)).rgb)
         + prefilter(texture(uSource, vUv + vec2( o.x, -o.y)).rgb)
         + prefilter(texture(uSource, vUv + vec2(-o.x,  o.y)).rgb)
         + prefilter(texture(uSource, vUv + vec2( o.x,  o.y)).rgb);
  fragColor = vec4(c * 0.25, 1.0);
}
