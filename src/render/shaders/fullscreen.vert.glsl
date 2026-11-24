#version 300 es
/*
 * fullscreen.vert.glsl
 *
 * Generates a single oversized triangle from gl_VertexID; no vertex buffers or
 * attributes are required. The interpolated vUv covers [0,1] over the visible
 * part of the triangle, so every fragment shader gets a clean 0..1 screen uv.
 */
precision highp float;

out vec2 vUv;

void main() {
  // (0,0) (2,0) (0,2) -> clip (-1,-1) (3,-1) (-1,3)
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
