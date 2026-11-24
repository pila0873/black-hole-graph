import type { BaseRenderer, FrameState, PluginSettings, Quality } from '../types';
import { Program } from './gl/Program';
import { RenderTarget } from './gl/RenderTarget';
import { StarAtlas } from './StarAtlas';
import { Fallback2D } from './Fallback2D';

import fullscreenVertexSource from './shaders/fullscreen.vert.glsl';
import blackHoleFragmentSource from './shaders/blackhole.frag.glsl';
import brightPassFragmentSource from './shaders/brightpass.frag.glsl';
import blurFragmentSource from './shaders/blur.frag.glsl';
import compositeFragmentSource from './shaders/composite.frag.glsl';
import fxaaFragmentSource from './shaders/fxaa.frag.glsl';

/** Supersampling budget (device pixels). The backing store is never allowed
 * below css * dpr, so at renderScale = 1 there is no browser-side bilinear
 * upscale (and therefore no low-resolution background). This cap only limits
 * how far the optional 1.25/1.5 supersampling may exceed native resolution. */
const MAX_RENDER_PIXELS = 3_500_000;
/** Geodesic step budget per quality level.
 *
 * Higher budgets shrink the apparent shadow towards the theoretical b = 2.598:
 * rays just outside the photon sphere wind for many orbits, and with a finite
 * budget they run out of steps and read as black. Measured (r = 22, bisection
 * on the capture impact parameter against 3*sqrt(3)*M):
 *   70 steps  -> shadow ~32% too large   200 -> +0.44%
 *   120 steps -> +5.1%                   300 -> +0.02%
 * "fast" therefore uses 120 (it wins its budget back by skipping the bloom
 * chain, not by shrinking the shadow). */
const STEPS_CINEMATIC = 200;
const STEPS_FAST = 120;
/** Bloom mips are 1/4 of the scene resolution. */
const BLOOM_DIVISOR = 4;
const BLOOM_THRESHOLD = 1.4;
const BLOOM_ITERATIONS = 3;
const EXPOSURE = 1.0;
/** Slider range of PluginSettings.renderScale. */
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 1.5;
/** Slider range of PluginSettings.diskThickness. */
const MIN_DISK_THICKNESS = 0.3;
const MAX_DISK_THICKNESS = 2.5;
/** HDR gain of the star atlas after `rgb * alpha` compositing. */
const STAR_ATLAS_GAIN = 1.15;

/**
 * Renders the black hole with a WebGL2 fragment shader: a real null-geodesic
 * integration of the Schwarzschild metric (see shaders/blackhole.frag.glsl),
 * a volumetric accretion disk slab with Doppler beaming and gravitational
 * redshift, a procedurally generated equirectangular star atlas (the only sky
 * source) and a separable gaussian bloom.
 *
 * Pipeline
 *   scene (RGBA16F, dpr * renderScale) -> bloom bright pass (1/4 res)
 *   -> 2x [horizontal + vertical gaussian] -> composite (ACES + gamma)
 *   -> FXAA (optional) -> canvas.
 *
 * The canvas backing store is itself sized to dpr * renderScale, so the final
 * composite/FXAA blit is always 1:1 device pixels (no bilinear upscale); when
 * renderScale > 1 the browser downsamples once as supersampling.
 *
 * If WebGL2 cannot be created, or a shader fails to compile/link, the renderer
 * silently downgrades to a Canvas2D rendition and reports `supported = false`.
 * It never throws.
 */
export class BlackHoleRenderer implements BaseRenderer {
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;

  /** True when the WebGL path is usable (context + shaders + targets). */
  private glReady = false;
  private contextLost = false;
  private hdr = false;

  private sceneProgram: Program | null = null;
  private brightProgram: Program | null = null;
  private blurProgram: Program | null = null;
  private compositeProgram: Program | null = null;
  private fxaaProgram: Program | null = null;
  /** Single equirectangular sky, regenerated only on quality changes. */
  private starAtlas: StarAtlas | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  private sceneTarget: RenderTarget | null = null;
  private bloomTargetA: RenderTarget | null = null;
  private bloomTargetB: RenderTarget | null = null;
  /** LDR tonemapped frame, only needed when FXAA is on. */
  private compositeTarget: RenderTarget | null = null;

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;

  // Offscreen sizing (recomputed on resize / settings change only).
  private bloomWidth = 1;
  private bloomHeight = 1;

  // Settings snapshot (plain numbers, never the plugin's mutable object).
  private quality: Quality = 'cinematic';
  private renderScale = 1;
  private diskTemperature = 11000;
  private diskBrightness = 1;
  private diskThickness = 1;
  private bloomStrength = 0.8;
  private showStars = true;
  private lensing = true;
  private antiAliasing = true;

  private fallback: Fallback2D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      console.warn('[black-hole-graph] WebGL2 unavailable; using the 2D fallback renderer.');
      this.initFallback();
      return;
    }

    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.initGL();
  }

  /** False when the renderer had to fall back to Canvas2D / a blank canvas. */
  get supported(): boolean {
    return this.glReady;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  resize(width: number, height: number, dpr: number): void {
    const cssW = Math.max(1, Math.round(width));
    const cssH = Math.max(1, Math.round(height));
    const scale = Math.min(Math.max(dpr || 1, 0.5), 3);

    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.dpr = scale;

    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    if (this.glReady) {
      /* The GL backing store is dpr * renderScale; updateRenderTargets owns the
       * canvas size so the scene, the composite target and the canvas agree. */
      this.updateRenderTargets();
    } else {
      /* Canvas2D fallback: no supersampling, backing store = css * dpr. */
      const backingW = Math.max(1, Math.round(cssW * scale));
      const backingH = Math.max(1, Math.round(cssH * scale));
      if (this.canvas.width !== backingW) this.canvas.width = backingW;
      if (this.canvas.height !== backingH) this.canvas.height = backingH;
    }

    this.fallback?.resize(cssW, cssH, scale);
  }

  applySettings(settings: PluginSettings): void {
    const nextScale = Math.min(
      Math.max(settings.renderScale, MIN_RENDER_SCALE),
      MAX_RENDER_SCALE,
    );
    const scaleChanged = Math.abs(nextScale - this.renderScale) > 1e-4;
    const qualityChanged = settings.quality !== this.quality;

    this.quality = settings.quality;
    this.renderScale = nextScale;
    this.diskTemperature = Math.max(1000, settings.diskTemperature);
    this.diskBrightness = Math.max(0, settings.diskBrightness);
    this.diskThickness = Math.min(
      Math.max(settings.diskThickness, MIN_DISK_THICKNESS),
      MAX_DISK_THICKNESS,
    );
    this.bloomStrength = Math.max(0, settings.bloom);
    this.showStars = settings.showStars;
    this.lensing = settings.lensing;
    this.antiAliasing = settings.antiAliasing;

    if (qualityChanged) this.ensureStarAtlas();
    if (scaleChanged) this.updateRenderTargets();
    this.fallback?.applySettings(settings);
  }

  render(frame: FrameState): void {
    if (this.contextLost) return;

    // Safety net: the view resizes us explicitly, but a frame can arrive with a
    // different size first (e.g. right after the view is attached).
    if (frame.width !== this.cssWidth || frame.height !== this.cssHeight) {
      this.resize(frame.width, frame.height, frame.devicePixelRatio);
    }

    const gl = this.gl;
    if (!this.glReady || gl === null) {
      this.render2D(frame);
      return;
    }

    const scene = this.sceneTarget;
    const bloomA = this.bloomTargetA;
    const bloomB = this.bloomTargetB;
    const sceneProgram = this.sceneProgram;
    const brightProgram = this.brightProgram;
    const blurProgram = this.blurProgram;
    const compositeProgram = this.compositeProgram;

    if (
      scene === null ||
      bloomA === null ||
      bloomB === null ||
      sceneProgram === null ||
      brightProgram === null ||
      blurProgram === null ||
      compositeProgram === null
    ) {
      this.render2D(frame);
      return;
    }

    const camera = frame.camera;
    const fast = this.quality === 'fast';

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    /* ---- 1. scene: geodesic ray tracing into an HDR offscreen target ----- */
    scene.bind();
    sceneProgram.use();
    sceneProgram.float('uTime', frame.time);
    sceneProgram.vec3('uCamPos', camera.position.x, camera.position.y, camera.position.z);
    sceneProgram.matrix4('uInvViewProj', camera.inverseViewProjection);
    sceneProgram.float('uDiskTemperature', this.diskTemperature);
    sceneProgram.float('uDiskBrightness', this.diskBrightness);
    sceneProgram.float('uDiskThickness', this.diskThickness);
    sceneProgram.float('uShowStars', this.showStars ? 1 : 0);
    sceneProgram.float('uLensing', this.lensing ? 1 : 0);
    sceneProgram.float('uStepBudget', fast ? STEPS_FAST : STEPS_CINEMATIC);
    sceneProgram.float('uQuality', fast ? 0 : 1);
    sceneProgram.int('uStarAtlas', 2);
    sceneProgram.float('uStarAtlasGain', STAR_ATLAS_GAIN);

    /* The atlas lives on texture unit 2 for the whole scene pass. StarAtlas
     * always exposes at least a 1x1 transparent texture, so this binding is
     * complete even if a real tier could not be allocated. */
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.starAtlas?.texture ?? null);
    gl.activeTexture(gl.TEXTURE0);

    this.drawFullscreenTriangle();

    /* ---- 2. bloom: bright pass + separable gaussian ping-pong ------------ */
    const useBloom =
      !fast && this.bloomStrength > 0.001 && bloomA.width > 8 && bloomA.height > 8;

    if (useBloom) {
      bloomA.bind();
      brightProgram.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.texture);
      brightProgram.int('uSource', 0);
      brightProgram.vec2('uTexel', 1 / scene.width, 1 / scene.height);
      brightProgram.float('uThreshold', BLOOM_THRESHOLD);
      this.drawFullscreenTriangle();

      blurProgram.use();
      blurProgram.int('uSource', 0);
      for (let i = 0; i < BLOOM_ITERATIONS; i++) {
        // horizontal: A -> B
        bloomB.bind();
        gl.bindTexture(gl.TEXTURE_2D, bloomA.texture);
        blurProgram.vec2('uDirection', 1 / bloomA.width, 0);
        this.drawFullscreenTriangle();

        // vertical: B -> A
        bloomA.bind();
        gl.bindTexture(gl.TEXTURE_2D, bloomB.texture);
        blurProgram.vec2('uDirection', 0, 1 / bloomB.height);
        this.drawFullscreenTriangle();
      }
    }

    /* ---- 3. composite (+ optional FXAA) --------------------------------- */
    const fxaaProgram = this.fxaaProgram;
    const postTarget = this.compositeTarget;
    const useAA = this.antiAliasing && fxaaProgram !== null && postTarget !== null;

    if (useAA && postTarget !== null) {
      // Tonemap into an LDR texture so FXAA can read its neighbours, then the
      // FXAA pass does the only write to the canvas.
      postTarget.bind();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }

    compositeProgram.use();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, useBloom ? bloomA.texture : scene.texture);
    gl.activeTexture(gl.TEXTURE0);

    compositeProgram.int('uScene', 0);
    compositeProgram.int('uBloomTex', 1);
    compositeProgram.float('uBloom', useBloom ? this.bloomStrength : 0);
    compositeProgram.float('uExposure', EXPOSURE);
    compositeProgram.vec2('uResolution', scene.width, scene.height);
    this.drawFullscreenTriangle();

    if (useAA && postTarget !== null && fxaaProgram !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

      fxaaProgram.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, postTarget.texture);
      fxaaProgram.int('uSource', 0);
      fxaaProgram.vec2('uTexel', 1 / postTarget.width, 1 / postTarget.height);
      this.drawFullscreenTriangle();
    }

    // Leave no texture bound that a later pass might sample for feedback.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);

    this.disposeGL();
    this.fallback?.dispose();
    this.fallback = null;

    const gl = this.gl;
    if (gl) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this.gl = null;
    this.glReady = false;
  }

  /* ------------------------------------------------------------------ */
  /* WebGL setup / teardown                                              */
  /* ------------------------------------------------------------------ */

  private initGL(): boolean {
    const gl = this.gl;
    if (!gl) return false;

    this.hdr = gl.getExtension('EXT_color_buffer_float') !== null;
    if (!this.hdr) {
      console.warn(
        '[black-hole-graph] EXT_color_buffer_float unavailable; bloom uses an 8-bit target.',
      );
    }

    this.sceneProgram = Program.create(
      gl,
      fullscreenVertexSource,
      blackHoleFragmentSource,
      'blackhole',
    );
    this.brightProgram = Program.create(
      gl,
      fullscreenVertexSource,
      brightPassFragmentSource,
      'bloom-brightpass',
    );
    this.blurProgram = Program.create(
      gl,
      fullscreenVertexSource,
      blurFragmentSource,
      'bloom-blur',
    );
    this.compositeProgram = Program.create(
      gl,
      fullscreenVertexSource,
      compositeFragmentSource,
      'composite',
    );
    this.fxaaProgram = Program.create(
      gl,
      fullscreenVertexSource,
      fxaaFragmentSource,
      'fxaa',
    );

    this.vao = gl.createVertexArray();
    this.sceneTarget = RenderTarget.create(gl, this.hdr);
    this.bloomTargetA = RenderTarget.create(gl, this.hdr);
    this.bloomTargetB = RenderTarget.create(gl, this.hdr);
    this.compositeTarget = RenderTarget.create(gl, false);
    this.starAtlas = new StarAtlas(gl);

    const ok =
      this.sceneProgram !== null &&
      this.brightProgram !== null &&
      this.blurProgram !== null &&
      this.compositeProgram !== null &&
      this.vao !== null &&
      this.sceneTarget !== null &&
      this.bloomTargetA !== null &&
      this.bloomTargetB !== null &&
      this.compositeTarget !== null;

    if (!ok) {
      console.error(
        '[black-hole-graph] the WebGL renderer could not be initialised; falling back to 2D.',
      );
      this.disposeGL();
      this.initFallback();
      return false;
    }

    /* FXAA is optional: if only that shader failed, keep the WebGL path and
     * render without AA (the composite writes straight to the canvas). */
    if (this.fxaaProgram === null) {
      console.warn('[black-hole-graph] FXAA shader unavailable; antialiasing is disabled.');
    }

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    this.glReady = true;
    this.updateRenderTargets();
    this.ensureStarAtlas();
    return true;
  }

  /**
   * Build (or rebuild) the procedural star atlas for the current quality.
   * `StarAtlas.ensure` is a no-op when the same tier was already requested,
   * so this is safe to call from a settings update; generation happens only
   * once per quality level (plus the one-time memory fallback).
   */
  private ensureStarAtlas(): void {
    if (!this.glReady || this.starAtlas === null) return;
    this.starAtlas.ensure(this.quality === 'fast' ? 'fast' : 'ultra');
  }

  private disposeGL(): void {
    this.sceneProgram?.dispose();
    this.brightProgram?.dispose();
    this.blurProgram?.dispose();
    this.compositeProgram?.dispose();
    this.fxaaProgram?.dispose();
    this.sceneProgram = null;
    this.brightProgram = null;
    this.blurProgram = null;
    this.compositeProgram = null;
    this.fxaaProgram = null;

    this.sceneTarget?.dispose();
    this.bloomTargetA?.dispose();
    this.bloomTargetB?.dispose();
    this.compositeTarget?.dispose();
    this.starAtlas?.dispose();
    this.sceneTarget = null;
    this.bloomTargetA = null;
    this.bloomTargetB = null;
    this.compositeTarget = null;
    this.starAtlas = null;

    if (this.vao !== null && this.gl !== null) this.gl.deleteVertexArray(this.vao);
    this.vao = null;

    this.glReady = false;
    this.bloomWidth = 1;
    this.bloomHeight = 1;
  }

  private initFallback(): void {
    if (this.fallback !== null) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      console.error(
        '[black-hole-graph] no 2D context available on the render canvas; the background will be blank.',
      );
      return;
    }
    this.fallback = new Fallback2D(ctx, this.canvas);
    this.fallback.resize(this.cssWidth, this.cssHeight, this.dpr);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.glReady = false;

    // All GL objects died with the context: forget the handles instead of
    // trying to delete them. They are rebuilt from scratch on restore.
    this.sceneProgram = null;
    this.brightProgram = null;
    this.blurProgram = null;
    this.compositeProgram = null;
    this.fxaaProgram = null;
    this.sceneTarget = null;
    this.bloomTargetA = null;
    this.bloomTargetB = null;
    this.compositeTarget = null;
    this.starAtlas = null;
    this.vao = null;
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
    this.initGL();
  };

  /* ------------------------------------------------------------------ */
  /* Sizing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Scene + composite target and canvas backing store:
   * round(css * dpr * renderScale), never below css * dpr. The pixel budget
   * only trims supersampling above native resolution, so renderScale = 1 is
   * always a 1:1 device-pixel path. Bloom targets: scene / 4 (at least 1).
   *
   * Everything downstream of the scene (composite, FXAA, canvas) shares this
   * size, so there is no resampling in the post chain; renderScale > 1 is pure
   * supersampling that the browser downsamples to the CSS size.
   */
  private updateRenderTargets(): void {
    if (!this.glReady) return;

    const scale = Math.min(Math.max(this.renderScale, MIN_RENDER_SCALE), MAX_RENDER_SCALE);

    const nativeW = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const nativeH = Math.max(1, Math.round(this.cssHeight * this.dpr));

    let w = Math.max(1, Math.round(nativeW * scale));
    let h = Math.max(1, Math.round(nativeH * scale));

    /* Never squeeze below the native backing store: that would make the
     * browser bilinearly upscale the whole frame, including the background,
     * even at renderScale = 1. The budget applies only to supersampling. */
    const pixelBudget = Math.max(MAX_RENDER_PIXELS, nativeW * nativeH);
    const pixels = w * h;
    if (pixels > pixelBudget) {
      const squeeze = Math.sqrt(pixelBudget / pixels);
      w = Math.max(1, Math.floor(w * squeeze));
      h = Math.max(1, Math.floor(h * squeeze));
    }

    this.bloomWidth = Math.max(1, Math.round(w / BLOOM_DIVISOR));
    this.bloomHeight = Math.max(1, Math.round(h / BLOOM_DIVISOR));

    this.sceneTarget?.resize(w, h);
    this.bloomTargetA?.resize(this.bloomWidth, this.bloomHeight);
    this.bloomTargetB?.resize(this.bloomWidth, this.bloomHeight);
    this.compositeTarget?.resize(w, h);

    // Assigning width/height clears the canvas; only do it when it changed.
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /* ------------------------------------------------------------------ */
  /* Drawing helpers                                                     */
  /* ------------------------------------------------------------------ */

  private drawFullscreenTriangle(): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private render2D(frame: FrameState): void {
    const fallback = this.fallback;
    if (fallback !== null) {
      fallback.render(frame);
      return;
    }

    // Last resort: no 2D context (a WebGL context owns the canvas) and the
    // shaders did not build. Keep the canvas clean instead of freezing garbage.
    const gl = this.gl;
    if (gl === null || this.contextLost) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
