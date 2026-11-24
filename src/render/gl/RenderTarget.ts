/**
 * Offscreen colour render target (texture + framebuffer).
 *
 * Uses RGBA16F when EXT_color_buffer_float is available (needed for a sane HDR
 * pipeline: the disk and stars exceed 1.0 before tonemapping), otherwise falls
 * back to RGBA8. Linear filtering is enough for the bloom chain.
 */
export class RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  width = 0;
  height = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly internalFormat: number;
  private readonly format: number;
  private readonly type: number;

  private constructor(
    gl: WebGL2RenderingContext,
    hdr: boolean,
    texture: WebGLTexture,
    framebuffer: WebGLFramebuffer,
  ) {
    this.gl = gl;
    this.texture = texture;
    this.framebuffer = framebuffer;
    this.internalFormat = hdr ? gl.RGBA16F : gl.RGBA8;
    this.format = gl.RGBA;
    this.type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  }

  static create(gl: WebGL2RenderingContext, hdr: boolean): RenderTarget | null {
    const texture = gl.createTexture();
    if (!texture) {
      console.error('[black-hole-graph] could not allocate a texture for a render target.');
      return null;
    }

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      console.error('[black-hole-graph] could not allocate a framebuffer.');
      return null;
    }

    return new RenderTarget(gl, hdr, texture, framebuffer);
  }

  /** (Re)allocates the texture storage; no-op when the size is unchanged. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    const gl = this.gl;
    this.width = w;
    this.height = h;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.internalFormat,
      w,
      h,
      0,
      this.format,
      this.type,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error(`[black-hole-graph] incomplete framebuffer (0x${status.toString(16)}).`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
    this.width = 0;
    this.height = 0;
  }
}
