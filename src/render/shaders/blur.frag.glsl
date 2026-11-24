#version 300 es
/*
 * blur.frag.glsl
 *
 * One direction of a separable 9-tap gaussian (weights normalised, sum = 1).
 * uDirection is the uv step of one texel along the blur axis, so the caller
 * ping-pongs between two targets: horizontal then vertical.
 */
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDirection;

const float W0 = 0.2270270270;
const float W1 = 0.1945945946;
const float W2 = 0.1216216216;
const float W3 = 0.0540540541;
const float W4 = 0.0162162162;

void main() {
  vec2 d = uDirection;
  vec3 c = texture(uSource, vUv).rgb * W0;
  c += (texture(uSource, vUv + d * 1.0).rgb + texture(uSource, vUv - d * 1.0).rgb) * W1;
  c += (texture(uSource, vUv + d * 2.0).rgb + texture(uSource, vUv - d * 2.0).rgb) * W2;
  c += (texture(uSource, vUv + d * 3.0).rgb + texture(uSource, vUv - d * 3.0).rgb) * W3;
  c += (texture(uSource, vUv + d * 4.0).rgb + texture(uSource, vUv - d * 4.0).rgb) * W4;
  fragColor = vec4(c, 1.0);
}
