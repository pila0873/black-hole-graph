/**
 * Thin WebGL2 shader program wrapper.
 *
 * - compiles + links once, reporting errors through console.error and a `null`
 *   return value (never throws),
 * - caches uniform locations in a Map so no family of lookups happens per frame.
 */
export class Program {
  private readonly gl: WebGL2RenderingContext;
  private readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  private constructor(gl: WebGL2RenderingContext, handle: WebGLProgram) {
    this.gl = gl;
    this.handle = handle;
  }

  static create(
    gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    label: string,
  ): Program | null {
    const vertex = Program.compile(gl, gl.VERTEX_SHADER, vertexSource, label, 'vertex');
    if (!vertex) return null;

    const fragment = Program.compile(gl, gl.FRAGMENT_SHADER, fragmentSource, label, 'fragment');
    if (!fragment) {
      gl.deleteShader(vertex);
      return null;
    }

    const handle = gl.createProgram();
    if (!handle) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      console.error(`[black-hole-graph] could not create the GL program "${label}".`);
      return null;
    }

    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);

    // Shaders can be detached/deleted once linked; the program keeps them alive.
    gl.detachShader(handle, vertex);
    gl.detachShader(handle, fragment);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    const linked = gl.getProgramParameter(handle, gl.LINK_STATUS) as boolean;
    if (!linked) {
      console.error(
        `[black-hole-graph] linking failed for "${label}":\n${gl.getProgramInfoLog(handle) ?? '(no log)'}`,
      );
      gl.deleteProgram(handle);
      return null;
    }

    return new Program(gl, handle);
  }

  private static compile(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
    label: string,
    stage: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) {
      console.error(`[black-hole-graph] could not create the ${stage} shader of "${label}".`);
      return null;
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
    if (!compiled) {
      console.error(
        `[black-hole-graph] ${stage} shader of "${label}" failed to compile:\n` +
          `${gl.getShaderInfoLog(shader) ?? '(no log)'}`,
      );
      gl.deleteShader(shader);
      return null;
    }

    return shader;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  /** Uniform location lookup, cached (including negative results). */
  location(name: string): WebGLUniformLocation | null {
    const cached = this.uniforms.get(name);
    if (cached !== undefined) return cached;
    const location = this.gl.getUniformLocation(this.handle, name);
    this.uniforms.set(name, location);
    return location;
  }

  float(name: string, value: number): void {
    const location = this.location(name);
    if (location !== null) this.gl.uniform1f(location, value);
  }

  int(name: string, value: number): void {
    const location = this.location(name);
    if (location !== null) this.gl.uniform1i(location, value);
  }

  vec2(name: string, x: number, y: number): void {
    const location = this.location(name);
    if (location !== null) this.gl.uniform2f(location, x, y);
  }

  vec3(name: string, x: number, y: number, z: number): void {
    const location = this.location(name);
    if (location !== null) this.gl.uniform3f(location, x, y, z);
  }

  matrix4(name: string, value: Float32Array): void {
    const location = this.location(name);
    if (location !== null) this.gl.uniformMatrix4fv(location, false, value);
  }

  dispose(): void {
    this.uniforms.clear();
    this.gl.deleteProgram(this.handle);
  }
}
