import type { FrameState, PluginSettings } from '../types';
import { DISK_INNER, DISK_OUTER, SHADOW_B, TAU, clamp, mulberry32 } from '../util/math';

/* Tanner Helland / Neil Bartlett blackbody fit, same one the GLSL uses, so the
 * fallback keeps the colours of the WebGL path. Normalised so 6500 K is white. */
function blackbodyRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, 1000, 40000) / 100;
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
    clamp(clamp(r, 0, 255) / 255 / 1.0, 0, 1),
    clamp(clamp(g, 0, 255) / 255 / 0.99648, 0, 1),
    clamp(clamp(b, 0, 255) / 255 / 1.0, 0, 1),
  ];
}

function rgba(color: [number, number, number], alpha: number): string {
  const a = clamp(alpha, 0, 1);
  return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(
    color[2] * 255,
  )},${a.toFixed(3)})`;
}

/**
 * Canvas2D rendition used when WebGL2 is unavailable (or the shaders fail).
 *
 * It is deliberately simple but reads as a black hole: a plain black backdrop
 * with stars, an elliptical accretion disk (thickened by diskThickness) whose
 * inner edge is bright and hot, a black shadow disc and a warm photon-ring
 * halo. The disk is drawn in two halves so the near side passes in front of the
 * shadow.
 */
export class Fallback2D {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;

  private width = 1;
  private height = 1;
  private dpr = 1;

  private background: HTMLCanvasElement | null = null;

  private showStars = true;
  private diskTemperature = 11000;
  private diskBrightness = 1;
  private diskThickness = 1;
  private bloom = 0.8;

  constructor(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    this.ctx = ctx;
    this.canvas = canvas;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.max(0.5, dpr);
    this.buildBackground();
  }

  applySettings(settings: PluginSettings): void {
    const starsChanged = settings.showStars !== this.showStars;
    this.showStars = settings.showStars;
    this.diskTemperature = settings.diskTemperature;
    this.diskBrightness = settings.diskBrightness;
    this.diskThickness = settings.diskThickness;
    this.bloom = settings.bloom;
    if (starsChanged) this.buildBackground();
  }

  render(frame: FrameState): void {
    const ctx = this.ctx;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.background) {
      ctx.drawImage(this.background, 0, 0);
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = frame.shadowCenter.x;
    const cy = frame.shadowCenter.y;
    const shadowR = Math.max(4, frame.shadowRadius);
    const pxPerRs = shadowR / SHADOW_B; // projected pixels per r_s

    const rIn = DISK_INNER * pxPerRs;
    const rOut = DISK_OUTER * pxPerRs;

    // Disk seen at the camera elevation: a circle in XZ projects to an ellipse
    // with the minor axis scaled by sin(elevation).
    const pos = frame.camera.position;
    const dist = Math.hypot(pos.x, pos.y, pos.z) || 1;
    const sinEl = clamp(pos.y / dist, -1, 1);
    // The GLSL slab has scale height h(r) = thickness * (0.012 + 0.030 r),
    // i.e. ~0.030 r * thickness in projection: fold that into the minor axis
    // so the fallback disk also stays narrow edge-on.
    const thickness = clamp(this.diskThickness, 0.3, 2.5);
    const squash = Math.max(0.035, Math.abs(sinEl) + 0.030 * thickness);
    const frontBelow = sinEl >= 0;

    const glow = clamp(this.bloom, 0, 1.5) * clamp(this.diskBrightness, 0.1, 2);

    this.drawAmbient(ctx, cx, cy, rOut, glow);

    // Far half of the disk, then the shadow, then the near half.
    this.drawDiskHalf(ctx, cx, cy, rIn, rOut, squash, !frontBelow, 0.78);
    this.drawShadow(ctx, cx, cy, shadowR);
    this.drawDiskHalf(ctx, cx, cy, rIn, rOut, squash, frontBelow, 1.12);
    this.drawPhotonRing(ctx, cx, cy, shadowR, glow);
  }

  dispose(): void {
    this.background = null;
  }

  /* ------------------------------------------------------------------ */

  private drawAmbient(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    rOut: number,
    glow: number,
  ): void {
    if (rOut < 2) return;
    const g = ctx.createRadialGradient(cx, cy, rOut * 0.15, cx, cy, rOut * 2.6);
    const warm = blackbodyRgb(this.diskTemperature * 0.55);
    g.addColorStop(0, rgba(warm, 0.16 * glow));
    g.addColorStop(0.35, rgba(warm, 0.07 * glow));
    g.addColorStop(1, rgba(warm, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rOut * 2.6, 0, TAU);
    ctx.fill();
  }

  private drawDiskHalf(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    rIn: number,
    rOut: number,
    squash: number,
    below: boolean,
    gain: number,
  ): void {
    if (rOut < 3 || rIn < 1) return;

    ctx.save();
    ctx.beginPath();
    if (below) {
      ctx.rect(cx - rOut * 2, cy, rOut * 4, rOut * 2);
    } else {
      ctx.rect(cx - rOut * 2, cy - rOut * 2, rOut * 4, rOut * 2);
    }
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(1, squash);

    const g = ctx.createRadialGradient(0, 0, rIn * 0.86, 0, 0, rOut);
    const radii = [DISK_INNER * 1.0, 4.2, 6.0, 8.5, DISK_OUTER];
    const alphas = [1.0, 0.92, 0.68, 0.34, 0.0];
    for (let i = 0; i < radii.length; i++) {
      const r = radii[i];
      const t = this.diskTemperature * Math.pow(DISK_INNER / r, 0.75);
      g.addColorStop(
        clamp((r - rIn * 0.86) / (rOut - rIn * 0.86), 0, 1),
        rgba(blackbodyRgb(t), alphas[i] * gain * clamp(this.diskBrightness, 0.15, 1.6)),
      );
    }

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.arc(0, 0, rIn * 0.9, 0, TAU, true);
    ctx.fill();

    // Thin, very bright inner lip (hottest material at the ISCO).
    ctx.lineWidth = Math.max(1, rIn * 0.035);
    ctx.strokeStyle = rgba(blackbodyRgb(this.diskTemperature * 1.02), 0.85 * gain);
    ctx.beginPath();
    ctx.arc(0, 0, rIn * 0.95, 0, TAU);
    ctx.stroke();

    ctx.restore();
  }

  private drawShadow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
  ): void {
    const g = ctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r * 1.02);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.92, '#000000');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
  }

  private drawPhotonRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    glow: number,
  ): void {
    const g = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.30);
    const hot = blackbodyRgb(this.diskTemperature * 0.92);
    g.addColorStop(0, rgba(hot, 0.55 * glow));
    g.addColorStop(0.18, rgba(hot, 0.28 * glow));
    g.addColorStop(0.55, rgba(hot, 0.08 * glow));
    g.addColorStop(1, rgba(hot, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.30, 0, TAU);
    ctx.fill();
  }

  /* ------------------------------------------------------------------ */

  private buildBackground(): void {
    const dpr = this.dpr;
    const pw = Math.max(1, Math.round(this.width * dpr));
    const ph = Math.max(1, Math.round(this.height * dpr));

    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.background = null;
      return;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, pw, ph);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.width;
    const h = this.height;

    // Plain black backdrop: distant galaxies are drawn by the 2D layer, and any
    // gradient here would fight the lensed star field.
    if (this.showStars) this.paintStars(ctx, w, h);

    this.background = canvas;
  }

  private paintStars(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const rnd = mulberry32(0x5eed1234);
    const count = Math.round(clamp((w * h) / 2600, 120, 2400));

    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      // avoid the middle where the hole lives
      const dx = (x - w * 0.5) / (w * 0.5);
      const dy = (y - h * 0.5) / (h * 0.5);
      if (dx * dx + dy * dy < 0.06 && rnd() < 0.85) continue;

      const mag = Math.pow(rnd(), 4.5);
      const radius = 0.4 + mag * 1.9;
      const alpha = 0.10 + mag * 0.85;
      const tint = blackbodyRgb(3600 + rnd() * 12000);
      ctx.fillStyle = rgba(tint, alpha);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();

      if (mag > 0.7) {
        const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 6);
        halo.addColorStop(0, rgba(tint, 0.35));
        halo.addColorStop(1, rgba(tint, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, radius * 6, 0, TAU);
        ctx.fill();
      }
    }
  }
}
