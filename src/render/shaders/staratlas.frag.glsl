#version 300 es
/*
 * staratlas.frag.glsl
 *
 * First pass of the procedural star atlas: a cheap, seamless 3D-noise field
 * painted into an equirectangular RGBA8 texture. The RGB carries the cloud
 * temperature (blue/cyan hot zone -> white middle -> orange/red cool zone);
 * the alpha is exactly zero over empty space and soft (<= 0.11) only inside
 * the cloud cores. Stars are composited on top by StarAtlas.ts.
 *
 * The direction is reconstructed from uv so longitude wraps perfectly at
 * u = 0/1. The temperature field intentionally combines a tilted plane with
 * two fBm octaves instead of a radial distance, so it does not read as a flat
 * radial gradient.
 */
precision highp float;
precision highp int;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform float uSeed;

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float x00 = mix(n000, n100, f.x);
  float x10 = mix(n010, n110, f.x);
  float x01 = mix(n001, n101, f.x);
  float x11 = mix(n011, n111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * valueNoise3(p);
    norm += amp;
    p = p * 2.07 + vec3(9.7, 3.1, 13.9);
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

/* Same Planckian fit as the black hole shader, normalised to white at 6500 K. */
vec3 blackbodyRGB(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
  float r;
  float g;
  float b;

  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
    b = (t <= 19.0) ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
    b = 255.0;
  }

  vec3 c = clamp(vec3(r, g, b) / 255.0, vec3(0.0), vec3(1.0));
  vec3 ref6500 = vec3(1.0, 0.99648, 1.0);
  return clamp(c / max(ref6500, vec3(1e-3)), vec3(0.0), vec3(1.0));
}

vec3 directionFromUv(vec2 uv) {
  float lon = (uv.x - 0.5) * TAU;
  float lat = (uv.y - 0.5) * PI;
  float cl = cos(lat);
  return vec3(cos(lon) * cl, sin(lat), sin(lon) * cl);
}

void main() {
  vec3 dir = directionFromUv(vUv);

  /* Large-scale temperature field. The tilted plane gives broad zones; the
   * two noise fields break them into islands, filaments and voids. */
  float tilt = dot(dir, normalize(vec3(0.62, 0.21, -0.76)));
  float n1 = fbm3(dir * 2.15 + vec3(uSeed * 7.1, uSeed * 3.7, uSeed * 5.3));
  float n2 = fbm3(dir * 5.30 + vec3(21.7, uSeed * 9.2, 8.1));
  float n3 = valueNoise3(dir * 13.0 + vec3(4.3, uSeed * 11.0, 17.0));

  float zone = clamp(
    0.5 + 0.40 * tilt + 0.46 * (n1 - 0.5) + 0.16 * (n2 - 0.5),
    0.0,
    1.0
  );

  /* Hot inner (blue/cyan), middle (white), outer (orange/red). The white
   * middle is a fairly narrow band so most clouds carry a visible chroma. */
  vec3 hot = blackbodyRGB(21000.0);
  vec3 mid = blackbodyRGB(7000.0);
  vec3 cool = blackbodyRGB(2800.0);
  vec3 col = mix(cool, mid, smoothstep(0.10, 0.44, zone));
  col = mix(col, hot, smoothstep(0.60, 0.90, zone));
  // Obsidian-style neutral sky: retain temperature information only as a
  // barely perceptible cool/warm tint, never as a saturated nebula.
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(grey), col, 0.12);

  /* Soft cloud density: alpha stays exactly zero outside the denser cores.
   * The density uses different noise combinations than `zone`, so clouds are
   * not biased towards the hot (high-zone) half of the sky. */
  float veil = smoothstep(0.42, 0.78, n2 * 0.55 + n3 * 0.45);
  float filament = smoothstep(0.52, 0.88, n1 * 0.55 + n3 * 0.45);
  float density = veil * (0.36 + 0.64 * filament);
  float alpha = smoothstep(0.58, 0.88, density) * 0.026;

  /* A hint of neutral dust inside the densest filaments. */
  vec3 tint = mix(col, vec3(0.92), 0.04 * filament);
  fragColor = vec4(tint, alpha);
}
