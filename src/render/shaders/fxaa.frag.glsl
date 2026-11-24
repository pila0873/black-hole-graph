#version 300 es
/*
 * fxaa.frag.glsl
 *
 * FXAA 3.11 (Timothy Lottes) edge-directed antialiasing, "console" 12-tap
 * variant. Runs as the last stage on the tonemapped, gamma-encoded composite,
 * at exactly one output pixel per input pixel, and writes to the canvas.
 *
 *  - 3x3 luma neighbourhood, early out on low contrast (relative threshold),
 *  - edge direction from the luma gradient,
 *  - 4-tap span blend along that direction plus a bounded search for the edge
 *    end; if the search leaves the local luma range the closer average wins.
 *
 * The renderer only runs this pass when settings.antiAliasing is on; otherwise
 * the composite shader writes to the canvas directly (one less fullscreen
 * draw), which is why there is no enable uniform here.
 */
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uTexel;      // 1 / source resolution (both are the canvas size)

const float EDGE_THRESHOLD_MIN = 0.0312;
const float EDGE_THRESHOLD = 0.125;
const float REDUCE_MIN = 1.0 / 128.0;
const float REDUCE_MUL = 1.0 / 8.0;
const float SPAN_MAX = 8.0;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec3 rgbM = texture(uSource, vUv).rgb;

  vec3 rgbNW = texture(uSource, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture(uSource, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture(uSource, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture(uSource, vUv + vec2( 1.0,  1.0) * uTexel).rgb;

  float lumaM = luma(rgbM);
  float lumaNW = luma(rgbNW);
  float lumaNE = luma(rgbNE);
  float lumaSW = luma(rgbSW);
  float lumaSE = luma(rgbSE);

  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

  /* Low contrast: not an edge we should touch. Keeps the flat black background
   * and the disk interior perfectly crisp while still smoothing silhouettes. */
  if (lumaMax - lumaMin < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD)) {
    fragColor = vec4(rgbM, 1.0);
    return;
  }

  /* Edge direction: gradient across the 3x3 luma neighbourhood. */
  vec2 dir;
  dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));

  float dirReduce = max(
    (lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * REDUCE_MUL),
    REDUCE_MIN
  );
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

  /* Central 4 taps along the edge. */
  vec3 rgbA = 0.5 * (
    texture(uSource, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture(uSource, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
  );

  /* Wider span, half weight on the 4-tap result. */
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(uSource, vUv + dir * -0.5).rgb +
    texture(uSource, vUv + dir *  0.5).rgb
  );

  /* If the wide span leaves the local luma range it has crossed another edge:
   * fall back to the tighter average. */
  float lumaB = luma(rgbB);
  vec3 result = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;

  fragColor = vec4(result, 1.0);
}
