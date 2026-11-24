import { Program } from './gl/Program';

import fullscreenVertexSource from './shaders/fullscreen.vert.glsl';
import starAtlasCloudFragmentSource from './shaders/staratlas.frag.glsl';
import starQuadVertexSource from './shaders/starquad.vert.glsl';
import starQuadFragmentSource from './shaders/starquad.frag.glsl';

/**
 * Resolution tiers of the equirectangular sky.
 *
 * `cinematic` uses `ultra`. `high` is the first memory fallback (it is also
 * the natural tier for GPUs whose MAX_TEXTURE_SIZE is below 8192), and
 * `fast` is used both by the fast quality level and as the final fallback.
 * The texture is generated once per tier and then only sampled, never
 * re-rendered per frame.
 */
export type AtlasTier = 'ultra' | 'high' | 'fast';

interface AtlasSize {
  width: number;
  height: number;
}

const TIER_SIZES: Record<AtlasTier, AtlasSize> = {
  ultra: { width: 8192, height: 4096 },
  high: { width: 4096, height: 2048 },
  fast: { width: 2048, height: 1024 },
};

/** Candidates in decreasing resolution, used for the allocation fallback. */
const TIER_ORDER: readonly AtlasTier[] = ['ultra', 'high', 'fast'];

/** One star candidate per cell of this many texture pixels. */
const STAR_CELL_PX = 10;
/** Fraction of equatorial cells that contain a star; scaled by cos(lat). */
const STAR_COVERAGE = 0.16;
/** Hard cap so a pathological device size cannot allocate a huge star buffer. */
const MAX_STAR_INSTANCES = 90_000;
/** Brightest stars are bigger than this many texels only very rarely. */
const STAR_SIZE_MAX = 5;
/** Fixed seed for the CPU star distribution. */
const STAR_SEED = 0x5a17c0de;
/** Seed passed to the cloud shader (its direction noise stays seamless). */
const CLOUD_SEED = 0.371;

/**
 * Hash a 2D integer cell + seed to a deterministic value in [0, 1).
 *
 * The star layout must be stable across reloads and independent of the frame
 * rate. Math.imul keeps the mixing in 32-bit integer space, so the result is
 * identical on every JS engine.
 */
function hash2(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Planckian locus -> RGB (Tanner Helland / Neil Bartlett fit), normalised so
 * 6500 K renders as white. This is the same fit the black hole shader uses,
 * so the atlas stars keep the colours of the rest of the scene.
 */
function blackbodyRgb(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  return [
    Math.min(Math.max(r, 0), 255) / 255,
    Math.min(Math.max(g, 0), 255) / 255 / 0.99648,
    Math.min(Math.max(b, 0), 255) / 255,
  ];
}

/** Deterministic spectral class distribution (O/B .. M). */
function starTemperature(sample: number, jitter: number): number {
  if (sample < 0.015) return 18000 + jitter * 15000;      // O/B: rare blue
  if (sample < 0.060) return 9800 + jitter * 5200;        // A: blue-white
  if (sample < 0.160) return 6800 + jitter * 2500;        // F: white
  if (sample < 0.380) return 5300 + jitter * 1200;        // G: yellow-white
  if (sample < 0.720) return 3900 + jitter * 1200;        // K: orange
  return 2600 + jitter * 1300;                            // M: red
}

/**
 * Procedural equirectangular RGBA star atlas.
 *
 * Generation is a one-time GPU pass:
 *   1. a cheap 3D-noise fBm paints the temperature clouds (straight alpha,
 *      exactly 0 in empty space);
 *   2. a deterministic CPU star catalogue is uploaded as instanced quads and
 *      composited over the clouds with soft, premultiplied-by-blend alpha.
 *
 * The texture is RGBA8, has no mipmaps (so a star does not turn into a soft
 * blob at renderScale = 1) and is sampled by the final bent geodesic direction
 * in blackhole.frag.glsl. Longitude wraps with REPEAT; latitude clamps.
 *
 * If the requested tier cannot be allocated (OUT_OF_MEMORY, a MAX_TEXTURE_SIZE
 * limit or an incomplete framebuffer) the next smaller tier is tried. A 1x1
 * transparent texture is always kept as the safe fallback so the scene shader
 * never samples an incomplete texture.
 */
export class StarAtlas {
  private readonly gl: WebGL2RenderingContext;

  private cloudProgram: Program | null = null;
  private starProgram: Program | null = null;

  private framebuffer: WebGLFramebuffer | null = null;
  private atlasTexture: WebGLTexture | null = null;

  private starVao: WebGLVertexArrayObject | null = null;
  private starBuffer: WebGLBuffer | null = null;
  private quadBuffer: WebGLBuffer | null = null;

  private requestedTier: AtlasTier | null = null;
  private generatedTier: AtlasTier | null = null;

  private atlasWidth = 1;
  private atlasHeight = 1;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    this.cloudProgram = Program.create(
      gl,
      fullscreenVertexSource,
      starAtlasCloudFragmentSource,
      'star-atlas-clouds',
    );
    this.starProgram = Program.create(
      gl,
      starQuadVertexSource,
      starQuadFragmentSource,
      'star-atlas-stars',
    );

    this.framebuffer = gl.createFramebuffer();
    this.starVao = gl.createVertexArray();
    this.starBuffer = gl.createBuffer();
    this.quadBuffer = gl.createBuffer();
    this.atlasTexture = this.createPlaceholder();

    this.setupQuadBuffer();
  }

  /** True when a real (non-placeholder) atlas is resident. */
  get ready(): boolean {
    return this.generatedTier !== null;
  }

  get texture(): WebGLTexture | null {
    return this.atlasTexture;
  }

  get width(): number {
    return this.atlasWidth;
  }

  get height(): number {
    return this.atlasHeight;
  }

  /**
   * Ensure the atlas for `tier` exists. No-op when that tier was already
   * requested (even if it fell back to a smaller tier), so this can be called
   * from settings updates without regenerating every frame.
   */
  ensure(tier: AtlasTier): void {
    if (this.requestedTier === tier) return;
    this.requestedTier = tier;

    const previousTier = this.generatedTier;
    const start = TIER_ORDER.indexOf(tier);
    for (let i = start; i < TIER_ORDER.length; i++) {
      if (this.generate(TIER_ORDER[i])) {
        this.generatedTier = TIER_ORDER[i];
        return;
      }
    }

    /* Keep an already resident atlas alive if every new candidate failed. */
    this.generatedTier = previousTier;
    console.warn(
      '[black-hole-graph] the procedural star atlas could not be allocated; the sky will stay black.',
    );
  }

  dispose(): void {
    const gl = this.gl;

    if (this.atlasTexture !== null) gl.deleteTexture(this.atlasTexture);
    if (this.framebuffer !== null) gl.deleteFramebuffer(this.framebuffer);
    if (this.starVao !== null) gl.deleteVertexArray(this.starVao);
    if (this.starBuffer !== null) gl.deleteBuffer(this.starBuffer);
    if (this.quadBuffer !== null) gl.deleteBuffer(this.quadBuffer);

    this.cloudProgram?.dispose();
    this.starProgram?.dispose();

    this.atlasTexture = null;
    this.framebuffer = null;
    this.starVao = null;
    this.starBuffer = null;
    this.quadBuffer = null;
    this.cloudProgram = null;
    this.starProgram = null;
    this.requestedTier = null;
    this.generatedTier = null;
    this.atlasWidth = 1;
    this.atlasHeight = 1;
  }

  /* ------------------------------------------------------------------ */
  /* Generation                                                          */
  /* ------------------------------------------------------------------ */

  private generate(tier: AtlasTier): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;

    const size = TIER_SIZES[tier];
    const cloudProgram = this.cloudProgram;
    const starProgram = this.starProgram;

    if (
      cloudProgram === null ||
      starProgram === null ||
      this.framebuffer === null ||
      this.starVao === null ||
      this.starBuffer === null ||
      this.quadBuffer === null
    ) {
      return false;
    }

    /* Reject tiers the device cannot even texture or viewport. A null result
     * also means the context is already lost, in which case there is nothing
     * to generate. */
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null;
    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    if (
      maxTexture === null ||
      maxViewport === null ||
      size.width > maxTexture ||
      size.height > maxTexture ||
      size.width > maxViewport[0] ||
      size.height > maxViewport[1]
    ) {
      return false;
    }

    /* Save the state this pass touches. The texture binding is intentionally
     * not restored: the previous binding may be the atlas we are replacing. */
    const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array | null;
    const prevClear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array | null;
    if (prevViewport === null || prevClear === null) return false;

    /* Clear any previous GL error so the allocation check is meaningful. */
    this.drainErrors();

    const texture = gl.createTexture();
    if (texture === null) return false;

    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      size.width,
      size.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    let allocationOk = gl.getError() === gl.NO_ERROR;
    if (allocationOk) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      /* No mipmap chain: the atlas must stay crisp at native render scale. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      allocationOk =
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
        gl.getError() === gl.NO_ERROR;
    }

    if (!allocationOk) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(texture);
      this.restoreState(prevBlend, prevDepth, prevCull, prevScissor, prevClear);
      gl.activeTexture(gl.TEXTURE0);
      return false;
    }

    gl.viewport(0, 0, size.width, size.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    /* ---- 1. temperature clouds --------------------------------------- */
    cloudProgram.use();
    cloudProgram.float('uSeed', CLOUD_SEED);
    gl.bindVertexArray(null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---- 2. deterministic star catalogue ----------------------------- */
    const stars = this.buildStars(size.width, size.height);
    if (stars.count > 0) {
      starProgram.use();
      starProgram.vec2('uAtlasSize', size.width, size.height);
      gl.bindVertexArray(this.starVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, stars.data, gl.STATIC_DRAW);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      );
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stars.count);
      gl.disable(gl.BLEND);
    }

    const renderOk =
      gl.getError() === gl.NO_ERROR &&
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    this.restoreState(prevBlend, prevDepth, prevCull, prevScissor, prevClear);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!renderOk) {
      gl.deleteTexture(texture);
      return false;
    }

    /* Swap in the new atlas only after it rendered successfully. */
    const old = this.atlasTexture;
    this.atlasTexture = texture;
    this.atlasWidth = size.width;
    this.atlasHeight = size.height;
    if (old !== null) gl.deleteTexture(old);
    return true;
  }

  private restoreState(
    blend: boolean,
    depth: boolean,
    cull: boolean,
    scissor: boolean,
    clear: Float32Array,
  ): void {
    const gl = this.gl;
    if (blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (cull) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
  }

  private drainErrors(): void {
    const gl = this.gl;
    for (let i = 0; i < 16; i++) {
      if (gl.getError() === gl.NO_ERROR) return;
    }
  }

  private setupQuadBuffer(): void {
    const gl = this.gl;
    const vao = this.starVao;
    const quad = this.quadBuffer;
    const stars = this.starBuffer;
    if (vao === null || quad === null || stars === null) return;

    gl.bindVertexArray(vao);

    /* Per-vertex corner of the unit quad (-1..1). */
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);

    /* Per-instance: centre uv, size in texels, spectral colour, alpha. */
    gl.bindBuffer(gl.ARRAY_BUFFER, stars);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  private createPlaceholder(): WebGLTexture | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (texture === null) return null;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  /**
   * Build the instanced star catalogue for one atlas resolution.
   *
   * The grid is measured in texture pixels, so every tier gets crisp ~1 px
   * stars; the angular density grows only with the tier resolution. Sampling
   * cells by cos(latitude) keeps the sky distribution uniform instead of
   * piling stars up at the equirect poles.
   */
  private buildStars(width: number, height: number): {
    data: Float32Array;
    count: number;
  } {
    const cols = Math.max(1, Math.ceil(width / STAR_CELL_PX));
    const rows = Math.max(1, Math.ceil(height / STAR_CELL_PX));
    const capacity = Math.min(
      MAX_STAR_INSTANCES,
      Math.max(16, Math.ceil(cols * rows * 0.75) + 256),
    );
    const data = new Float32Array(capacity * 7);
    let count = 0;

    const seed = STAR_SEED ^ (width * 73856093) ^ (height * 19349663);

    const push = (
      x: number,
      y: number,
      size: number,
      r: number,
      g: number,
      b: number,
      a: number,
    ): void => {
      if (count >= capacity) return;
      const o = count * 7;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = size;
      data[o + 3] = r;
      data[o + 4] = g;
      data[o + 5] = b;
      data[o + 6] = a;
      count++;
    };

    for (let row = 0; row < rows; row++) {
      const v = (row + 0.5) / rows;
      const lat = (v - 0.5) * Math.PI;
      const cosLat = Math.cos(lat);
      const probability = STAR_COVERAGE * Math.max(0, cosLat);

      for (let col = 0; col < cols; col++) {
        if (hash2(col, row, seed) > probability) continue;

        let x = ((col + hash2(col, row, seed + 11)) * STAR_CELL_PX) / width;
        let y = ((row + hash2(col, row, seed + 17)) * STAR_CELL_PX) / height;
        if (x < 0 || x >= 1 || y <= 0 || y >= 1) continue;

        /* Rare large stars; the overwhelming majority stay at one texel. */
        const u = hash2(col, row, seed + 23);
        const mag = Math.pow(u, 6.0);
        const size =
          mag > 0.55
            ? Math.min(
                STAR_SIZE_MAX,
                1 + Math.round(((mag - 0.55) / 0.45) * (STAR_SIZE_MAX - 1)),
              )
            : 1;

        const spectral = hash2(col, row, seed + 29);
        const jitter = hash2(col, row, seed + 31);
        const [r, g, b] = blackbodyRgb(starTemperature(spectral, jitter));

        /* Bright stars carry a soft radial alpha; the 1 px majority is a
         * hard point and remains crisp at native render scale. */
        const alpha = Math.min(1, 0.18 + 0.82 * Math.pow(u, 1.8));
        /* Slightly desaturate the brightest stars so they read as white-hot
         * rather than as pure saturated primary colours. */
        const whiteMix = 0.18 * mag;
        const cr = r + (1 - r) * whiteMix;
        const cg = g + (1 - g) * whiteMix;
        const cb = b + (1 - b) * whiteMix;

        /* Snap the 1 px majority to a texel centre: the quad then covers
         * exactly one texel and the flat core reads as a crisp point. */
        if (size === 1) {
          x = (Math.floor(x * width) + 0.5) / width;
          y = (Math.floor(y * height) + 0.5) / height;
        }

        push(x, y, size, cr, cg, cb, alpha);

        /* Longitude is periodic: duplicate a seam star just outside the
         * opposite edge. Quads (not point sprites) are clipped correctly, so
         * the two halves join across the REPEAT seam. */
        const halfU = (size * 0.5) / width;
        if (x < halfU) {
          push(x + 1, y, size, cr, cg, cb, alpha);
        } else if (x > 1 - halfU) {
          push(x - 1, y, size, cr, cg, cb, alpha);
        }
      }
    }

    return { data: data.subarray(0, count * 7), count };
  }
}
