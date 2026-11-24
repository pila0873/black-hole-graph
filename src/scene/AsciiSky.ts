import type { FrameState, Vec3 } from '../types';
import { mulberry32, TAU } from '../util/math';

/**
 * ASCII backdrops: instead of a nebula texture, the far sky is scattered with
 * a handful of tiny glyph galaxies. They are drawn in 2D so the characters
 * stay crisp at any render scale, and their screen positions are displaced by
 * the same weak-field deflection the black hole produces, so they slide around
 * the shadow instead of crossing it.
 */

interface Glyph {
  /** Offset from the cluster centre, in px at size 1. */
  dx: number;
  dy: number;
  ch: string;
  alpha: number;
}

interface Galaxy {
  /** Unit direction in world space. */
  dir: Vec3;
  /** Twinkle phase. */
  phase: number;
  /** Base size in px. */
  size: number;
  /** Slow rotation, rad/s. */
  spin: number;
  glyphs: Glyph[];
}

const CHARS = ['·', '+', '·', '×', '·', '*', '·', '+', '°', '·', ':', '·'];

/** Impact parameter of a point relative to the black hole, along the view ray. */
function impactParameter(point: Vec3, camera: Vec3): number {
  const dx = point.x - camera.x;
  const dy = point.y - camera.y;
  const dz = point.z - camera.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;

  // Distance from the origin to the line through `camera` in direction u.
  const cx = camera.x;
  const cy = camera.y;
  const cz = camera.z;
  const t = -(cx * ux + cy * uy + cz * uz);
  const px = cx + ux * t;
  const py = cy + uy * t;
  const pz = cz + uz * t;
  return Math.hypot(px, py, pz);
}

export class AsciiSky {
  private galaxies: Galaxy[] = [];
  private stars: Vec3[] = [];
  private built = false;

  /** Regenerates the field; deterministic for a given seed. */
  build(seed = 20261124, count = 9): void {
    const rand = mulberry32(seed);
    const galaxies: Galaxy[] = [];
    const stars: Vec3[] = [];

    // Full-resolution foreground star layer. Unlike stars sampled inside the
    // ray-traced background, these never pass through a low-resolution bloom
    // buffer and therefore stay crisp. The black-hole shader still supplies
    // the sparse lensed stars around the shadow.
    for (let i = 0; i < 260; i++) {
      const az = rand() * TAU;
      const el = (rand() - 0.5) * Math.PI * 0.92;
      const ce = Math.cos(el);
      stars.push({
        x: Math.cos(az) * ce,
        y: Math.sin(el),
        z: Math.sin(az) * ce,
      });
    }

    for (let i = 0; i < count; i++) {
      // Uniform-ish directions, avoiding the exact poles and the disk plane.
      const az = rand() * TAU;
      const el = (rand() - 0.5) * 2.2 * 0.85;
      const ce = Math.cos(el);
      const dir: Vec3 = {
        x: Math.cos(az) * ce,
        y: Math.sin(el),
        z: Math.sin(az) * ce,
      };

      const glyphCount = 5 + Math.floor(rand() * 9);
      const glyphs: Glyph[] = [];
      const spread = 0.6 + rand() * 1.5;
      for (let g = 0; g < glyphCount; g++) {
        // Elliptical, slightly curved cluster: looks like a spiral seen at an
        // angle rather than a random blob.
        const a = rand() * TAU;
        const r = Math.pow(rand(), 0.65) * spread;
        glyphs.push({
          dx: Math.cos(a) * r * 2.6,
          dy: Math.sin(a) * r * 0.9,
          ch: CHARS[Math.floor(rand() * CHARS.length)],
          alpha: 0.30 + rand() * 0.60,
        });
      }

      galaxies.push({
        dir,
        phase: rand() * TAU,
        size: 0.75 + rand() * 0.7,
        spin: (rand() - 0.5) * 0.06,
        glyphs,
      });
    }

    this.galaxies = galaxies;
    this.stars = stars;
    this.built = true;
  }

  /**
   * Draws the field. Must be called on a cleared canvas, before the note layer
   * draws its own content.
   */
  render(ctx: CanvasRenderingContext2D, frame: FrameState): void {
    if (!this.built) this.build();

    const cam = frame.camera;
    const camPos = cam.position;
    const focal = frame.height / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
    const shadowDepth = Math.hypot(camPos.x, camPos.y, camPos.z);
    const shadow = frame.shadowRadius;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Crisp high-resolution stars. Their tiny glyphs intentionally do not
    // receive the volumetric disk's blur or the WebGL bloom pass.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      const p: Vec3 = {
        x: star.x * 900,
        y: star.y * 900,
        z: star.z * 900,
      };
      const screen = cam.project(p);
      if (!screen.onScreen || screen.depth <= cam.near) continue;
      const twinkle = 0.48 + 0.40 * Math.sin(frame.time * 0.7 + i * 12.37);
      const glyph = i % 17 === 0 ? '·' : i % 43 === 0 ? '+' : '·';
      ctx.fillStyle = `rgba(218, 228, 245, ${twinkle.toFixed(3)})`;
      ctx.fillText(glyph, Math.round(screen.x), Math.round(screen.y));
    }

    for (const galaxy of this.galaxies) {
      // Park the cluster far away so it barely parallaxes with the camera.
      const far = 900;
      const p: Vec3 = {
        x: galaxy.dir.x * far,
        y: galaxy.dir.y * far,
        z: galaxy.dir.z * far,
      };

      const screen = cam.project(p);
      if (!screen.onScreen || screen.depth <= cam.near) continue;

      // Weak-field lensing: displace the image away from the black hole.
      const b = impactParameter(p, camPos);
      if (b < 2.598) continue; // behind the shadow

      const screenR = Math.hypot(screen.x - frame.shadowCenter.x, screen.y - frame.shadowCenter.y);
      const deflection = 2.0 / Math.max(b, 2.2); // ~4M/b with M = 0.5
      const shift = deflection * focal * 0.5;
      const inv = screenR > 1 ? 1 / screenR : 0;
      const nx = (screen.x - frame.shadowCenter.x) * inv;
      const ny = (screen.y - frame.shadowCenter.y) * inv;
      const x = screen.x + nx * shift;
      const y = screen.y + ny * shift;

      // Fade near the shadow and outside the frame.
      const proximity = Math.min(1, Math.max(0, (screenR - shadow * 1.35) / (shadow * 2.2)));
      const edge =
        Math.min(x - 20, y - 20, frame.width - x - 20, frame.height - y - 20) / 90;
      const fade = proximity * Math.min(1, Math.max(0, edge));
      if (fade <= 0.01) continue;

      // Hide clusters that sit behind the hole but inside the shadow disc.
      if (screen.depth > shadowDepth && screenR < shadow * 1.05) continue;

      const rot = frame.time * galaxy.spin + galaxy.phase;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const size = galaxy.size * (focal / 900) * 0.9;
      const px = Math.max(10, Math.min(17, size * 9));

      ctx.font = `${Math.round(px)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      for (const g of galaxy.glyphs) {
        const gx = g.dx * cos - g.dy * sin;
        const gy = g.dx * sin + g.dy * cos;
        const alpha = g.alpha * fade * (0.55 + 0.45 * Math.sin(frame.time * 0.9 + galaxy.phase));
        if (alpha <= 0.01) continue;
        ctx.fillStyle = `rgba(196, 210, 235, ${alpha.toFixed(3)})`;
        ctx.fillText(g.ch, x + gx * galaxy.size * 3.2, y + gy * galaxy.size * 3.2);
      }
    }

    ctx.restore();
  }
}
