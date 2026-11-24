/**
 * 2D canvas overlay for the small-scale side of the scene.
 *
 * OWNER: agent "notes". Contract used by BlackHoleView must stay.
 *
 * Model (v2):
 *  - folders are PLANETS (shaded spheres, one label each);
 *  - notes are MOONS orbiting their planet: small dots in the system view,
 *    readable title cards once the camera is close enough;
 *  - links are thin cool-grey dashed guides; a small red-orange comet rides
 *    each guide, never a solid warm line.
 *
 * Planet materials (docs/STAR_ATLAS_PLANETS_COMETS_SPEC.md, section D):
 *  - a deterministic fBm height/albedo map is baked once per planet seed into
 *    a small equirectangular texture (no external image assets);
 *  - the tangent-space normal map comes from the height gradient:
 *    n = normalize(vec3(-dH/du * strength, -dH/dv * strength, 1));
 *  - per-pixel diffuse light comes from the black hole / accretion disk, with
 *    an almost-black ambient term, a thin Fresnel rim and a seed-tinted halo.
 *
 * Orbit tracks (section E):
 *  - planetary orbits are thin cold curves derived from `orbitRadius` and the
 *    tilt reconstructed from the planet's own position, so no layout data is
 *    duplicated;
 *  - moon orbits are sampled from `NoteState.orbit` and split into a far half
 *    (painted before the body) and a near half (painted right after it), which
 *    gives correct occlusion behind/in front of the planet;
 *  - both obey the same projected-disk occlusion as dots and cards.
 *
 * View rules (see docs/SCIENTIFIC_BLACK_HOLE_SPEC.md):
 *  - SYSTEM view (no focus): planet sphere + folder label, note dots only.
 *  - FOCUS view: the focused planet's notes become cards; other planets stay
 *    as dimmed dots so the focused system reads as the subject.
 *  - Aggregated inter-planet beams exist only in the system view. They are
 *    gently curved around the shadow and capped in number. Intra-planet arcs
 *    exist only in the focus view.
 *
 * Depth occlusion:
 *  - Anything farther than the black-hole centre along the view axis is
 *    "behind" it. Its projected footprint is tested against the projected
 *    accretion disk (an ellipse built from DISK_OUTER and disk thickness).
 *  - Fully inside  -> not drawn (and no hit target).
 *  - Partially over -> clipped to the outside of the ellipse; the covered
 *    part of the hit rectangle is ignored by hitTest().
 *
 * Everything here is in CSS pixels; the canvas carries the devicePixelRatio
 * transform, applied in resize() and re-applied defensively in render().
 */

import { DEFAULT_SETTINGS } from '../types';
import type {
  BaseNoteLayer,
  CameraLike,
  FrameState,
  GraphEdge,
  HitKind,
  HitRegion,
  NoteState,
  PlanetState,
  PluginSettings,
  ScreenPoint,
  Vec3,
} from '../types';
import { clamp, DISK_OUTER, hashString, lerp, smoothstep, TAU } from '../util/math';

/* ------------------------------------------------------------------ */
/* Card metrics                                                        */
/* ------------------------------------------------------------------ */

const CARD_H = 26;
const CARD_PAD = 20;
const CARD_RADIUS = 7;
const MIN_W = 70;
const MAX_W = 230;
const MAX_TEXT_W = MAX_W - CARD_PAD;

const SCALE_MIN = 0.55;
const SCALE_MAX = 1.25;
const HOVER_SCALE = 1.1;
const SELECT_SCALE = 1.04;
/** Card scale is quantised to this many steps, killing sub-pixel shimmer. */
const SCALE_STEPS = 24;

/* ------------------------------------------------------------------ */
/* LOD thresholds (projected planet radius, CSS px)                    */
/* ------------------------------------------------------------------ */

/** Below this a planet is a single crisp dot instead of a sphere. */
const TINY_PLANET = 1.2;
/** Dots are capped per planet while it is not open (card mode). */
const DOT_CAP = 120;
/** Planet labels are skipped below this projected radius. */
const LABEL_MIN_RADIUS = 5;
const LABEL_GAP = 4;
const LABEL_HEIGHT = 16;

/**
 * Cards ramp in only while the focused planet grows from 18 to 34 px of
 * projected radius. In the system view this weight is forced to zero, so a
 * large folder still shows dots, never cards.
 */
const CARD_LOD_MIN = 18;
const CARD_LOD_MAX = 34;
/** Non-focused planets larger than this fraction of the viewport are culled. */
const FOCUS_NEIGHBOR_CULL = 0.09;
/** Dim factor of the rest of the system while one planet is open. */
const FOCUS_NEIGHBOR_DIM = 0.45;

/* ------------------------------------------------------------------ */
/* Occlusion constants                                                 */
/* ------------------------------------------------------------------ */

/** Extra margin around the projected disk, hiding its soft outer edge too. */
const OCC_MARGIN_X = 1.08;
const OCC_MARGIN_Y = 1.12;
/** Projected half-height added by the disk slab, in units of diskThickness. */
const OCC_DISK_HALF_THICKNESS = 0.4;
/** Depth epsilon: equal depth is not "behind". */
const OCC_EPS = 1e-3;
/** Moon dots fade out across this normalised band at the disk edge. */
const OCC_DOT_FADE = 0.28;
/** Never build a clip ellipse larger than this multiple of the viewport. */
const OCC_MAX_FACTOR = 6;

const OCC_NONE = 0;
const OCC_PARTIAL = 1;
const OCC_FULL = 2;

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

const FONT_CARD = '600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_PLANET = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const CARD_BG = 'rgba(12,16,26,0.62)';
const CARD_BG_NEIGHBOR = 'rgba(18,25,38,0.72)';
const CARD_BG_SELECTED = 'rgba(20,28,42,0.78)';
const CARD_BG_HOVER = 'rgba(26,34,48,0.82)';
const BORDER = 'rgba(255,255,255,0.10)';
const BORDER_NEIGHBOR = 'rgba(190,210,235,0.22)';
const BORDER_SELECTED = 'rgba(170,205,250,0.60)';
const BORDER_HOVER = 'rgba(205,228,255,0.85)';
const TEXT_COLOR = '#e6eefc';
const TEXT_HOVER = '#f4f9ff';

/** Neutral cool grey; the spec forbids warm/orange link colours. */
const BEAM_COLOR = 'rgba(166,174,188,1)';
const BEAM_DASH: number[] = [3, 6];
const BEAM_DRIFT = 14;
const BEAM_MIN_PAIR_DIST = 40;
/** At most this many aggregated pair beams are painted in the system view. */
const MAX_VISIBLE_INTER_BEAMS = 32;
const BEAM_ALPHA_MIN = 0.12;
const BEAM_ALPHA_MAX = 0.34;
const BEAM_HOVER_BOOST = 0.14;
/** Clearance kept between a curved pair beam and the shadow. */
const BEAM_HOLE_CLEARANCE = 14;
/** Every pair beam gets a small bow so it never reads as a ruler line. */
const BEAM_BOW_MIN = 6;
const BEAM_INTRA_ALPHA = 0.45;
const BEAM_INTRA_BOW = 0.35;

/* ------------------------------------------------------------------ */
/* Red comets riding the guides (spec F)                               */
/* ------------------------------------------------------------------ */

/** Hard caps on simultaneously painted comet instances. */
const COMET_MAX_SYSTEM = 96;
const COMET_MAX_FOCUS = 160;
/** Path fraction per second, deterministic per (source, target) pair. */
const COMET_SPEED_MIN = 0.12;
const COMET_SPEED_MAX = 0.3;
/** Head radius in CSS px (the spec asks for a 2..4 px head). */
const COMET_HEAD_MIN = 1;
const COMET_HEAD_MAX = 1.6;
const COMET_HOVER_SCALE = 1.45;
/** Tail length in CSS px. */
const COMET_TAIL_MIN = 8;
const COMET_TAIL_MAX = 24;
/** Tapered quads used for the alpha-faded tail. */
const COMET_TAIL_SEGS = 5;
/** Pre-built colours: per-frame alpha changes only, never new strings. */
const COMET_TAIL_COLOR = 'rgb(255,88,44)';
const COMET_HEAD_COLOR = 'rgb(255,138,70)';
const COMET_CORE_COLOR = 'rgb(255,238,218)';
const NO_DASH: number[] = [];

/**
 * Decorrelate one 32-bit hash into another uniform 0..1 stream. Used to get a
 * stable phase and speed from the same source+target hash without allocation.
 */
function hashUnit(h: number, salt: number): number {
  let x = (h ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const LABEL_PILL = 'rgba(6,9,16,0.55)';
const LABEL_TEXT = 'rgba(215,225,240,0.85)';
const LABEL_TEXT_HOVER = 'rgba(236,244,255,0.95)';

/* ------------------------------------------------------------------ */
/* Planet palette (low saturation, cool)                               */
/* ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number];

interface PlanetSwatch {
  /** Raw palette colour, used as the albedo base of the baked material. */
  base: Rgb;
  /** Mid tone used by the sphere gradient. */
  mid: string;
  /** Highlight toward the black hole. */
  lit: string;
  /** Near-black limb. */
  limb: string;
  /** Lightened tone for moon dots. */
  dot: string;
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function cssRgb(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

const WHITE_TINT: Rgb = [226, 238, 252];
const BLACK_TINT: Rgb = [4, 6, 11];

function makeSwatch(hex: string): PlanetSwatch {
  const base = hexToRgb(hex);
  return {
    base,
    mid: cssRgb(mixRgb(base, WHITE_TINT, 0.1)),
    lit: cssRgb(mixRgb(base, WHITE_TINT, 0.46)),
    limb: cssRgb(mixRgb(base, BLACK_TINT, 0.82)),
    dot: cssRgb(mixRgb(base, WHITE_TINT, 0.34)),
  };
}

const PLANET_HEX: readonly string[] = [
  '#5b7fa6', // steel blue
  '#71808f', // slate
  '#4f8f89', // teal
  '#a08d6e', // sand
  '#8a6f95', // mauve
  '#86a3b8', // ice
  '#6f8a6a', // muted moss
  '#6d7fa8', // periwinkle
];

const PLANET_PALETTE: readonly PlanetSwatch[] = PLANET_HEX.map(makeSwatch);

/* ------------------------------------------------------------------ */
/* Procedural planet surface (spec D)                                  */
/* ------------------------------------------------------------------ */

/** Baked material resolution (equirectangular, RGBA-free float/byte maps). */
const MAT_W = 192;
const MAT_H = 96;
/** Live material cache: one bake per planet seed, oldest evicted past this. */
const MAT_CACHE_MAX = 24;
/**
 * Height-gradient strength for the baked tangent-space normal map. The map
 * stores `normalize(vec3(-dHdu * strength, -dHdv * strength, 1))`, so this is
 * the single knob between "smooth marble" and "cratered rock".
 */
const NORMAL_STRENGTH = 9.5;
/** Ambient floor: the unlit limb is almost black, per the spec. */
const SHADE_AMBIENT = 0.045;
/** Diffuse gain of the black-hole / accretion-disk key light. */
const SHADE_DIFFUSE = 1.06;
/** Small wrap term so the terminator is not a razor cut. */
const SHADE_WRAP = 0.12;
/** Disk light is warm-neutral; it reads as accretion glow on cool surfaces. */
const LIGHT_RGB: Rgb = [255, 233, 206];
const LIGHT_R = LIGHT_RGB[0] / 255;
const LIGHT_G = LIGHT_RGB[1] / 255;
const LIGHT_B = LIGHT_RGB[2] / 255;
/** Fresnel rim: pow(1 - dot(n, view), 3..5), strength and dark-side floor. */
const RIM_STRENGTH = 0.85;
const RIM_DARK_SIDE = 0.34;
const RIM_POW_MIN = 3;
const RIM_POW_MAX = 5;
/** Thin atmospheric halo just outside the limb. */
const HALO_MIN_RADIUS = 3.5;
const HALO_INNER = 0.985;
const HALO_OUTER = 1.18;
const HALO_ALPHA = 0.16;
/** Halo tints picked from the seed: cyan, blue, violet, amber. */
const HALO_TINTS: readonly Rgb[] = [
  [143, 220, 255],
  [133, 176, 255],
  [183, 160, 255],
  [255, 201, 142],
];
/** Slow deterministic spin so relief parallaxes while the camera orbits. */
// Slow material rotation avoids temporal shimmer while the camera is dragged.
// The moons/orbits still provide the visible motion of the scene.
const PLANET_SPIN_BASE = 0.004;
const PLANET_SPIN_VAR = 0.008;
/** Maximum axial tilt, radians (both signs). */
const PLANET_AXIAL_TILT = 0.32;
/**
 * The per-pixel shading pass is capped in device pixels: a focused planet can
 * exceed 200 device px of radius, and baking that every frame is wasteful.
 * 2 * 120 = 240 is also the reusable ImageData width.
 */
const SHADE_MAX_RADIUS_DEV = 120;
const SHADE_BUF_PX = 240;

/* ------------------------------------------------------------------ */
/* Orbit tracks (spec E)                                               */
/* ------------------------------------------------------------------ */

/** Thin cold line, well below the link beams in weight. */
const ORBIT_COLOR: Rgb = [150, 188, 228];
const MOON_ORBIT_COLOR: Rgb = [128, 158, 194];
const ORBIT_COLOR_CSS = cssRgb(ORBIT_COLOR);
const MOON_ORBIT_COLOR_CSS = cssRgb(MOON_ORBIT_COLOR);
/** Base alpha bands from the spec: planets 0.18..0.35, moons 0.12..0.25. */
const ORBIT_PLANET_ALPHA = 0.26;
const ORBIT_PLANET_ALPHA_SELF = 0.35;
const ORBIT_PLANET_ALPHA_OTHER = 0.18;
const ORBIT_MOON_ALPHA = 0.13;
const ORBIT_MOON_ALPHA_FOCUS = 0.22;
/** The far half of a track is dimmer, never brighter than the near half. */
const ORBIT_DEPTH_DIM = 0.5;
const MOON_ORBIT_DEPTH_DIM = 0.55;
/** Fade band at the projected-disk edge for orbit points behind the hole. */
const ORBIT_OCC_FADE = 0.3;
const ORBIT_SAMPLES = 96;
const MOON_ORBIT_SAMPLES = 48;
const ORBIT_PLANET_WIDTH = 1;
const MOON_ORBIT_WIDTH = 0.8;
/** Moon tracks are clutter below this projected planet radius. */
const MOON_TRACK_MIN_RADIUS = 7;
/** Deterministic sampling cap per planet, system vs focused. */
const MOON_TRACK_SYSTEM_CAP = 4;
const MOON_TRACK_FOCUS_CAP = 20;

/* ------------------------------------------------------------------ */
/* Deterministic fBm material baking                                   */
/* ------------------------------------------------------------------ */

interface PlanetMaterial {
  /** sRGB albedo, 3 bytes per texel (MAT_W * MAT_H texels). */
  albedo: Uint8Array;
  /** Tangent-space normal xy per texel; z = sqrt(1 - x^2 - y^2). */
  normal: Float32Array;
  /** Atmospheric rim/halo tint. */
  halo: Rgb;
  /** Pre-built halo gradient stops (no per-frame string allocation). */
  haloInner: string;
  haloMid: string;
  haloOuter: string;
  /** Fresnel exponent in [3, 5]. */
  rimPow: number;
}

function fract(v: number): number {
  return v - Math.floor(v);
}

/** Integer lattice hash in [0, 1); the only randomness in the material. */
function hashLattice(x: number, y: number, z: number, seed: number): number {
  let h =
    seed ^
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(z | 0, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Smooth trilinear value noise, deterministic for a given seed. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hashLattice(xi, yi, zi, seed);
  const n100 = hashLattice(xi + 1, yi, zi, seed);
  const n010 = hashLattice(xi, yi + 1, zi, seed);
  const n110 = hashLattice(xi + 1, yi + 1, zi, seed);
  const n001 = hashLattice(xi, yi, zi + 1, seed);
  const n101 = hashLattice(xi + 1, yi, zi + 1, seed);
  const n011 = hashLattice(xi, yi + 1, zi + 1, seed);
  const n111 = hashLattice(xi + 1, yi + 1, zi + 1, seed);

  const nx00 = n000 + (n100 - n000) * ux;
  const nx10 = n010 + (n110 - n010) * ux;
  const nx01 = n001 + (n101 - n001) * ux;
  const nx11 = n011 + (n111 - n011) * ux;
  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;
  return nxy0 + (nxy1 - nxy0) * uz;
}

/** Sum of octaves, normalised to [0, 1]. */
function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Bake one planet's diffuse albedo and height-derived normal map. All three
 * layers the spec asks for live here: large continents/spots, fine relief and
 * latitude colour zones. Results are deterministic from `seed` alone.
 */
function buildPlanetMaterial(base: Rgb, seed: number): PlanetMaterial {
  const albedo = new Uint8Array(MAT_W * MAT_H * 3);
  const height = new Float32Array(MAT_W * MAT_H);
  const normal = new Float32Array(MAT_W * MAT_H * 2);

  const seedInt = (seed * 4294967296) | 0;
  const ox = fract(seed * 13.17) * 40 - 20;
  const oy = fract(seed * 57.31) * 40 - 20;
  const oz = fract(seed * 91.77) * 40 - 20;
  const landThreshold = 0.45 + (fract(seed * 7.71) - 0.5) * 0.18;
  const iceStrength = 0.25 + 0.6 * fract(seed * 3.93);

  const b0 = base[0];
  const b1 = base[1];
  const b2 = base[2];
  // Dark, slightly blue-sea floor derived from the palette base.
  const seaR = lerp(b0, 10, 0.78);
  const seaG = lerp(b1, 16, 0.78);
  const seaB = lerp(b2, 28, 0.78);

  for (let y = 0; y < MAT_H; y++) {
    const lat = ((y + 0.5) / MAT_H - 0.5) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const rowBase = y * MAT_W;

    for (let x = 0; x < MAT_W; x++) {
      const lon = ((x + 0.5) / MAT_W) * TAU;
      const px = cl * Math.cos(lon);
      const py = sl;
      const pz = cl * Math.sin(lon);

      // Large continents and spots.
      const cont = fbm3(
        px * 1.35 + ox,
        py * 1.35 + oy,
        pz * 1.35 + oz,
        seedInt,
        3,
      );
      const zones = fbm3(
        px * 0.85 - oy,
        py * 0.85 + ox * 0.5,
        pz * 0.85 + oz,
        seedInt ^ 0x51ed270b,
        2,
      );
      // Fine relief.
      const detail = fbm3(
        px * 4.7 + oz,
        py * 4.7 + ox,
        pz * 4.7 - oy,
        seedInt ^ 0x2545f491,
        2,
      );
      const ridgeRaw = fbm3(
        px * 3.2 - ox,
        py * 3.2 + oz,
        pz * 3.2 + oy,
        seedInt ^ 0x68e31da4,
        2,
      );

      const field = cont * 0.68 + zones * 0.32;
      const land = smoothstep(landThreshold, landThreshold + 0.15, field);
      const ridge = 1 - Math.abs(ridgeRaw * 2 - 1);
      const i = rowBase + x;
      height[i] = clamp(
        land * (0.5 + 0.5 * detail) + land * ridge * 0.22 + detail * 0.08,
        0,
        1,
      );

      // Albedo: sea -> varied land -> polar ice, plus fine brightness grain.
      const landR = b0 + (WHITE_TINT[0] - b0) * (0.1 + 0.2 * detail);
      const landG = b1 + (WHITE_TINT[1] - b1) * (0.1 + 0.2 * detail);
      const landB = b2 + (WHITE_TINT[2] - b2) * (0.1 + 0.2 * detail);
      const zoneT = clamp(zones * 1.15, 0, 1);
      const zoneR = landR + (176 - landR) * 0.42 * zoneT;
      const zoneG = landG + (160 - landG) * 0.42 * zoneT;
      const zoneB = landB + (132 - landB) * 0.42 * zoneT;

      let r = seaR + (zoneR - seaR) * land;
      let g = seaG + (zoneG - seaG) * land;
      let bl = seaB + (zoneB - seaB) * land;

      const ice =
        smoothstep(0.7, 0.94, Math.abs(sl) + (zones - 0.5) * 0.1) *
        iceStrength;
      r = lerp(r, 216, ice);
      g = lerp(g, 230, ice);
      bl = lerp(bl, 246, ice);

      const grain = 0.84 + 0.28 * detail;
      const ao = i * 3;
      albedo[ao] = clamp(r * grain, 0, 255) | 0;
      albedo[ao + 1] = clamp(g * grain, 0, 255) | 0;
      albedo[ao + 2] = clamp(bl * grain, 0, 255) | 0;
    }
  }

  // Central differences of the height field -> tangent-space normal map.
  for (let y = 0; y < MAT_H; y++) {
    const lat = ((y + 0.5) / MAT_H - 0.5) * Math.PI;
    const invCos = 1 / Math.max(0.35, Math.cos(lat));
    const rowBase = y * MAT_W;
    const rowUp = (y < MAT_H - 1 ? y + 1 : MAT_H - 1) * MAT_W;
    const rowDown = (y > 0 ? y - 1 : 0) * MAT_W;

    for (let x = 0; x < MAT_W; x++) {
      const hL = height[rowBase + (x === 0 ? MAT_W - 1 : x - 1)];
      const hR = height[rowBase + (x === MAT_W - 1 ? 0 : x + 1)];
      const hD = height[rowDown + x];
      const hU = height[rowUp + x];
      const du = (hR - hL) * 0.5;
      const dv = (hU - hD) * 0.5;

      const nx = -(du * NORMAL_STRENGTH) * invCos;
      const ny = -(dv * NORMAL_STRENGTH);
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const ni = (rowBase + x) * 2;
      normal[ni] = nx * inv;
      normal[ni + 1] = ny * inv;
    }
  }

  const halo = HALO_TINTS[Math.floor(fract(seed * 4.37) * 4) & 3];
  const haloInner = `rgba(${halo[0]},${halo[1]},${halo[2]},${HALO_ALPHA})`;
  const haloMid = `rgba(${halo[0]},${halo[1]},${halo[2]},${HALO_ALPHA * 0.42})`;
  const haloOuter = `rgba(${halo[0]},${halo[1]},${halo[2]},0)`;
  const rimPow = lerp(RIM_POW_MIN, RIM_POW_MAX, fract(seed * 7.31));
  return { albedo, normal, halo, haloInner, haloMid, haloOuter, rimPow };
}

/* ------------------------------------------------------------------ */
/* Link caches caps                                                    */
/* ------------------------------------------------------------------ */

const MAX_INTRA_PER_PLANET = 260;
const MAX_INTER_PAIRS = 220;

/** Key separator for the per-title metric cache. */
const SEP = '\u0000';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/* ------------------------------------------------------------------ */
/* Internal records (pooled, reused across frames)                     */
/* ------------------------------------------------------------------ */

interface CardMetrics {
  /** Possibly ellipsized title that gets painted. */
  text: string;
  /** Unscaled card width in CSS px, already clamped to [MIN_W, MAX_W]. */
  width: number;
}

interface NoteRec {
  idx: number;
  planetIdx: number;
  path: string;
  title: string;
  baseW: number;
  /** Snapped screen centre. */
  x: number;
  y: number;
  dotR: number;
  /** Snapped card scale. */
  scale: number;
  /** Pixel-snapped card box in CSS px (0 when not in card mode). */
  w: number;
  h: number;
  depth: number;
  alpha: number;
  /** Dot opacity (note fade + depth + screen edge), independent of card alpha. */
  dotA: number;
  /** Card-mode weight of the parent planet, 0 = dots, 1 = cards. */
  fade: number;
  isHovered: boolean;
  isSelected: boolean;
  isNeighbor: boolean;
  /** Card partially overlaps the disk while behind it: clip it. */
  clip: boolean;
  /** Card is entirely behind the disk: do not paint it. */
  cardHidden: boolean;
  /** Note is farther than the black-hole centre along the view axis. */
  behind: boolean;
  visible: boolean;
}

interface PlanetRec {
  id: string;
  name: string;
  index: number;
  x: number;
  y: number;
  radius: number;
  depth: number;
  visible: boolean;
  /** Culled neighbour while another planet is focused (also hides its moons). */
  suppressed: boolean;
  /** Planet partially overlaps the disk while behind it: clip it. */
  clip: boolean;
  /** Planet is farther than the black-hole centre along the view axis. */
  behind: boolean;
  paletteIdx: number;
  seed: number;
  hasRing: boolean;
  noteCount: number;
  /** 0..1 card-mode weight (smoothstep of the projected radius, focused only). */
  fade: number;
  /** True only for the focused planet. */
  cardMode: boolean;
  /** Dim factor while another planet is open. */
  dim: number;
  isHovered: boolean;
  isSelected: boolean;
  /** Normalized 2D light direction (toward the black hole). */
  dirX: number;
  dirY: number;
  /** Planet centre in world space, kept for lighting and orbit tracks. */
  posX: number;
  posY: number;
  posZ: number;
  /** Planet's own orbit radius and reconstructed plane (sin/cos of tilt). */
  orbitR: number;
  orbitSinI: number;
  orbitCosI: number;
  /** Deterministic axial spin and tilt, plus their frame trig. */
  spinSin: number;
  spinCos: number;
  tiltSin: number;
  tiltCos: number;
  /** Seed the cached material was baked from. NaN = not baked yet. */
  matSeed: number;
  /** Palette index the cached material was baked from. */
  matPalette: number;
  mat: PlanetMaterial | null;
}

function makeNoteRec(): NoteRec {
  return {
    idx: -1,
    planetIdx: -1,
    path: '',
    title: '',
    baseW: MIN_W,
    x: 0,
    y: 0,
    dotR: 1,
    scale: 1,
    w: 0,
    h: 0,
    depth: 0,
    alpha: 0,
    dotA: 0,
    fade: 0,
    isHovered: false,
    isSelected: false,
    isNeighbor: false,
    clip: false,
    cardHidden: false,
    behind: false,
    visible: false,
  };
}

function makePlanetRec(): PlanetRec {
  return {
    id: '',
    name: '',
    index: 0,
    x: 0,
    y: 0,
    radius: 0,
    depth: 0,
    visible: false,
    suppressed: false,
    clip: false,
    behind: false,
    paletteIdx: 0,
    seed: 0,
    hasRing: false,
    noteCount: 0,
    fade: 0,
    cardMode: false,
    dim: 1,
    isHovered: false,
    isSelected: false,
    dirX: 0,
    dirY: -1,
    posX: 0,
    posY: 0,
    posZ: 0,
    orbitR: 0,
    orbitSinI: 0,
    orbitCosI: 1,
    spinSin: 0,
    spinCos: 1,
    tiltSin: 0,
    tiltCos: 1,
    matSeed: NaN,
    matPalette: -1,
    mat: null,
  };
}

/** Append a rounded rectangle to the current path (caller does beginPath). */
function addRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w * 0.5, h * 0.5));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  if (r > 0) ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  if (r > 0) ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  if (r > 0) ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  if (r > 0) ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Positive distance along the view axis (matches Camera's convention). */
function viewDepth(cam: CameraLike, p: Vec3): number {
  const v = cam.view;
  return -(v[2] * p.x + v[6] * p.y + v[10] * p.z + v[14]);
}

/** Distance from a point to a segment, used to bow beams around the shadow. */
function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const HIT_NOTE = 0;
const HIT_PLANET = 1;

/* ------------------------------------------------------------------ */
/* Layer                                                               */
/* ------------------------------------------------------------------ */

export class NoteLayer implements BaseNoteLayer {
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private settings: PluginSettings = DEFAULT_SETTINGS;

  private notes: readonly NoteState[] = [];
  private planets: readonly PlanetState[] = [];
  private focusIdx = -1;
  private backdrop: ((ctx: CanvasRenderingContext2D, frame: FrameState) => void) | null = null;
  private adjacency: ReadonlyMap<string, readonly string[]> = new Map();
  private hovered: string | null = null;
  private selected: string | null = null;
  private focusId: string | null = null;
  private planetCount = 0;

  /* Derived scene data, rebuilt only in setScene(). */
  private readonly planetById = new Map<string, number>();
  private readonly noteByPath = new Map<string, number>();
  private notePlanetIdx = new Int32Array(0);
  private intraA: number[] = [];
  private intraB: number[] = [];
  private intraStart: number[] = [];
  private intraEnd: number[] = [];
  private pairA: number[] = [];
  private pairB: number[] = [];
  private pairCount: number[] = [];
  /** Comet parameters, aligned with `intraA` / `pairA`. */
  private intraPhase: number[] = [];
  private intraSpeed: number[] = [];
  private pairPhase: number[] = [];
  private pairSpeed: number[] = [];

  /* Reused per-frame structures. */
  private readonly recs: NoteRec[] = [];
  private readonly planetRecs: PlanetRec[] = [];
  private readonly drawOrder: number[] = [];
  private readonly metricsCache = new Map<string, CardMetrics>();
  /** Metrics cache resolved by note index, so the frame loop allocates no keys. */
  private noteMetrics: (CardMetrics | null)[] = [];
  private readonly labelWidths = new Map<string, number>();
  private readonly hoverNeighbors = new Set<string>();

  /** Screen data for beam endpoints, indexed like `notes`. */
  private noteScreenX = new Float32Array(0);
  private noteScreenY = new Float32Array(0);
  private noteScreenA = new Float32Array(0);
  private noteScreenValid = new Uint8Array(0);
  /** Per-planet dot counter for the stride cap. */
  private dotSeen = new Int32Array(0);

  /* Baked planet materials, one per seed (bounded LRU-ish cache). */
  private readonly materialCache = new Map<number, PlanetMaterial>();
  /** Offscreen target used to honour globalAlpha/clip for the baked pixels. */
  private shadeCanvas: HTMLCanvasElement | null = null;
  private shadeCtx: CanvasRenderingContext2D | null = null;
  private shadeImage: ImageData | null = null;
  /** Camera of the frame being painted (valid only inside render()). */
  private cam: CameraLike | null = null;

  /* Notes bucketed by planet, used by the moon orbit tracks. */
  private planetNoteStart = new Int32Array(1);
  private planetNotes = new Int32Array(0);

  /* Reused orbit-curve projection buffers. */
  private readonly orbitPX = new Float32Array(ORBIT_SAMPLES + 1);
  private readonly orbitPY = new Float32Array(ORBIT_SAMPLES + 1);
  private readonly orbitPD = new Float32Array(ORBIT_SAMPLES + 1);

  /** Hit-test stack in draw order (iterate backwards for topmost). */
  private hitCount = 0;
  private hitKind = new Uint8Array(0);
  private hitIndex = new Int32Array(0);
  private hitX = new Float32Array(0);
  private hitY = new Float32Array(0);
  private hitW = new Float32Array(0);
  private hitH = new Float32Array(0);
  /** Hit was clipped by the black-hole occluder while behind it. */
  private hitOccluded = new Uint8Array(0);

  /* Projected black-hole occluder (shadow + accretion disk footprint). */
  private occActive = false;
  private occX = 0;
  private occY = 0;
  private occRX = 0;
  private occRY = 0;
  private occDepth = 0;

  /* Frame scalars, shared by the paint helpers. */
  private fx = 0;
  private fy = 0;
  private fr = 0;
  private hoverNoteIdx = -1;
  private hoverPlanetIdx = -1;
  private controlX = 0;
  private controlY = 0;

  private readonly point: ScreenPoint = {
    x: 0,
    y: 0,
    scale: 0,
    depth: 0,
    onScreen: false,
  };

  private readonly sortDrawDepth = (a: number, b: number): number => {
    const n = this.planetCount;
    const da = a < n ? this.planetRecs[a].depth : this.recs[a - n].depth;
    const db = b < n ? this.planetRecs[b].depth : this.recs[b - n].depth;
    if (da === db) return a - b;
    return db - da;
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                       */
  /* ---------------------------------------------------------------- */

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr > 0 ? dpr : 1;

    const cw = Math.max(1, Math.round(width * this.dpr));
    const ch = Math.max(1, Math.round(height * this.dpr));
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // Keep the existing context: re-acquiring it would reset its state.
    if (!this.ctx) this.ctx = this.canvas.getContext('2d');
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setScene(
    notes: readonly NoteState[],
    planets: readonly PlanetState[],
    edges: readonly GraphEdge[],
    adjacency: ReadonlyMap<string, readonly string[]>,
  ): void {
    this.notes = notes;
    this.planets = planets;
    this.adjacency = adjacency;
    this.planetCount = planets.length;

    this.planetById.clear();
    for (let i = 0; i < planets.length; i++) this.planetById.set(planets[i].id, i);

    this.noteByPath.clear();
    this.notePlanetIdx = new Int32Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
      const node = notes[i].node;
      this.noteByPath.set(node.path, i);
      this.notePlanetIdx[i] = this.planetById.get(notes[i].planetId) ?? -1;
    }

    this.noteScreenX = new Float32Array(notes.length);
    this.noteScreenY = new Float32Array(notes.length);
    this.noteScreenA = new Float32Array(notes.length);
    this.noteScreenValid = new Uint8Array(notes.length);
    this.dotSeen = new Int32Array(planets.length);

    // Bucket note indices per planet for the moon orbit tracks. Rebuilt only
    // when the scene changes, so the paint loop stays allocation free.
    const starts = new Int32Array(planets.length + 1);
    for (let i = 0; i < notes.length; i++) {
      const pi = this.notePlanetIdx[i];
      if (pi >= 0 && pi < planets.length) starts[pi + 1]++;
    }
    for (let i = 0; i < planets.length; i++) starts[i + 1] += starts[i];
    const bucket = new Int32Array(starts[planets.length]);
    const fill = starts.slice(0, planets.length);
    for (let i = 0; i < notes.length; i++) {
      const pi = this.notePlanetIdx[i];
      if (pi < 0 || pi >= planets.length) continue;
      bucket[fill[pi]++] = i;
    }
    this.planetNoteStart = starts;
    this.planetNotes = bucket;

    // Drop baked materials whose planet disappeared. The cache key packs the
    // palette index (which the albedo base depends on) next to the seed.
    if (this.materialCache.size > 0) {
      const live = new Set<number>();
      for (let i = 0; i < planets.length; i++) {
        const pl = planets[i];
        const pal = (pl.index + Math.floor(pl.seed * 4096)) % PLANET_PALETTE.length;
        live.add(pl.seed * PLANET_PALETTE.length + pal);
      }
      for (const key of this.materialCache.keys()) {
        if (!live.has(key)) this.materialCache.delete(key);
      }
    }

    this.prepareLinks(edges);
    this.rebuildMetrics(notes);
    this.noteMetrics.length = notes.length;
    for (let i = 0; i < notes.length; i++) {
      const node = notes[i].node;
      this.noteMetrics[i] = this.metricsCache.get(node.path + SEP + node.title) ?? null;
    }
    this.rebuildHoverNeighbors();
    this.hitCount = 0;
    this.drawOrder.length = 0;
  }

  /** Focus is read from `frame.focusPlanetId`; the fallback keeps the last value. */
  setFocus(planetId: string | null): void {
    this.focusId = planetId;
  }

  setHovered(id: string | null): void {
    this.hovered = id;
    this.rebuildHoverNeighbors();
  }

  setSelected(id: string | null): void {
    this.selected = id;
  }

  applySettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  /** Snap a CSS-pixel coordinate to the device pixel grid. */
  snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  /**
   * Optional pass drawn on the cleared canvas before anything else (used for
   * the ASCII backdrop, which has to sit behind the planets and cards but in
   * front of the WebGL layer).
   */
  setBackdrop(draw: ((ctx: CanvasRenderingContext2D, frame: FrameState) => void) | null): void {
    this.backdrop = draw;
  }

  render(frame: FrameState): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const dpr = this.dpr;
    const w = frame.width;
    const h = frame.height;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.backdrop !== null) this.backdrop(ctx, frame);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);

    // The frame is authoritative: a null focus means system view even if a
    // previous setFocus() value is still around.
    const focusId = frame.focusPlanetId;
    this.focusId = focusId;
    const focusIdx = focusId !== null ? (this.planetById.get(focusId) ?? -1) : -1;
    this.focusIdx = focusIdx;

    this.fx = frame.shadowCenter.x;
    this.fy = frame.shadowCenter.y;
    this.fr = frame.shadowRadius;
    this.cam = frame.camera;

    const hov = this.hovered;
    this.hoverNoteIdx = hov === null ? -1 : (this.noteByPath.get(hov) ?? -1);
    this.hoverPlanetIdx = hov === null ? -1 : (this.planetById.get(hov) ?? -1);

    this.prepareOccluder(frame);
    this.preparePlanets(ctx, frame, focusIdx);
    this.prepareNotes(frame, w, h);

    // Thin orbit tracks sit below the link guides and every body. The far
    // halves of moon orbits are part of this pass; near halves are painted
    // right after their planet, so the body occludes the correct half.
    this.drawOrbits(ctx, focusIdx, w, h);

    if (this.settings.showEdges && this.settings.edgeOpacity > 0.01) {
      this.drawBeams(ctx, frame);
    }

    /* Planets and moons share one far-to-near list, so a moon of a far planet
       can pass behind a near planet (and vice versa) correctly. */
    this.hitCount = 0;
    this.buildDrawOrder();
    const order = this.drawOrder;
    const n = this.planetCount;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    for (let k = 0; k < order.length; k++) {
      const code = order[k];
      if (code < n) {
        const p = this.planetRecs[code];
        if (p.visible) {
          this.paintPlanet(ctx, p);
          this.paintMoonOrbits(ctx, p, false);
        }
      } else {
        const rec = this.recs[code - n];
        if (rec.visible) this.paintNote(ctx, rec);
      }
    }

    /* Labels are the last layer per the spec: they may sit above bodies and
       beams. Painting them in the same far-to-near order keeps the nearest
       label on top when they overlap. */
    for (let k = 0; k < order.length; k++) {
      const code = order[k];
      if (code >= n) continue;
      const p = this.planetRecs[code];
      if (p.visible) this.paintPlanetLabel(ctx, p, w, h);
    }

    ctx.setLineDash(NO_DASH);
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  hitTest(x: number, y: number): HitRegion | null {
    for (let i = this.hitCount - 1; i >= 0; i--) {
      const left = this.hitX[i];
      const top = this.hitY[i];
      const right = left + this.hitW[i];
      const bottom = top + this.hitH[i];
      if (x < left || x > right || y < top || y > bottom) continue;
      // The clipped-away part of a behind-the-hole object is not clickable.
      if (this.hitOccluded[i] !== 0 && this.insideOccluder(x, y)) continue;

      const planet = this.hitKind[i] === HIT_PLANET;
      const kind: HitKind = planet ? 'planet' : 'note';
      const id = planet
        ? this.planetRecs[this.hitIndex[i]].id
        : this.recs[this.hitIndex[i]].path;
      return {
        kind,
        id,
        x: left,
        y: top,
        width: this.hitW[i],
        height: this.hitH[i],
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Scene preparation                                                */
  /* ---------------------------------------------------------------- */

  private prepareLinks(edges: readonly GraphEdge[]): void {
    this.intraA.length = 0;
    this.intraB.length = 0;
    this.intraStart.length = 0;
    this.intraEnd.length = 0;
    this.pairA.length = 0;
    this.pairB.length = 0;
    this.pairCount.length = 0;
    this.intraPhase.length = 0;
    this.intraSpeed.length = 0;
    this.pairPhase.length = 0;
    this.pairSpeed.length = 0;

    const planetCount = this.planets.length;
    const perPlanet: number[][] = [];
    for (let i = 0; i < planetCount; i++) perPlanet.push([]);

    const pairMap = new Map<number, number>();
    const noteByPath = this.noteByPath;
    const notePlanet = this.notePlanetIdx;

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ia = noteByPath.get(e.source);
      const ib = noteByPath.get(e.target);
      if (ia === undefined || ib === undefined || ia === ib) continue;
      const pa = notePlanet[ia];
      const pb = notePlanet[ib];
      if (pa < 0 || pb < 0) continue;

      if (pa === pb) {
        const list = perPlanet[pa];
        if (list.length < MAX_INTRA_PER_PLANET * 2) list.push(ia, ib);
      } else if (planetCount > 0) {
        const lo = pa < pb ? pa : pb;
        const hi = pa < pb ? pb : pa;
        const key = lo * planetCount + hi;
        pairMap.set(key, (pairMap.get(key) ?? 0) + 1);
      }
    }

    for (let i = 0; i < planetCount; i++) {
      const list = perPlanet[i];
      this.intraStart.push(this.intraA.length);
      for (let k = 0; k < list.length; k += 2) {
        const ia = list[k];
        const ib = list[k + 1];
        this.intraA.push(ia);
        this.intraB.push(ib);
        // Comet phase/speed follow source+target, so they survive rebuilds.
        const h = hashString(this.notes[ia].node.path + SEP + this.notes[ib].node.path);
        this.intraPhase.push(hashUnit(h, 0x51ed));
        this.intraSpeed.push(
          COMET_SPEED_MIN + hashUnit(h, 0x2f1b) * (COMET_SPEED_MAX - COMET_SPEED_MIN),
        );
      }
      this.intraEnd.push(this.intraA.length);
    }

    if (planetCount === 0 || pairMap.size === 0) return;

    const keys: number[] = [];
    for (const key of pairMap.keys()) keys.push(key);
    keys.sort((a, b) => (pairMap.get(b) ?? 0) - (pairMap.get(a) ?? 0));

    const limit = Math.min(keys.length, MAX_INTER_PAIRS);
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      const a = Math.floor(key / planetCount);
      const b = key - a * planetCount;
      this.pairA.push(a);
      this.pairB.push(b);
      this.pairCount.push(pairMap.get(key) ?? 1);
      // Inter-planet comets are keyed by both planet ids, not the frame order.
      const h = hashString(this.planets[a].id + SEP + this.planets[b].id);
      this.pairPhase.push(hashUnit(h, 0x51ed));
      this.pairSpeed.push(
        COMET_SPEED_MIN + hashUnit(h, 0x2f1b) * (COMET_SPEED_MAX - COMET_SPEED_MIN),
      );
    }
  }

  private rebuildHoverNeighbors(): void {
    const set = this.hoverNeighbors;
    set.clear();
    const h = this.hovered;
    if (h === null) return;
    const nb = this.adjacency.get(h);
    if (nb === undefined) return;
    for (let i = 0; i < nb.length; i++) set.add(nb[i]);
  }

  private rebuildMetrics(notes: readonly NoteState[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.font = FONT_CARD;

    const cache = this.metricsCache;
    const live = new Set<string>();
    for (let i = 0; i < notes.length; i++) {
      const node = notes[i].node;
      const key = node.path + SEP + node.title;
      live.add(key);
      if (!cache.has(key)) cache.set(key, this.measureTitle(ctx, node.title));
    }
    // Drop entries for notes that disappeared or were renamed.
    for (const key of cache.keys()) {
      if (!live.has(key)) cache.delete(key);
    }
  }

  /** Measure once per unique (path, title) pair. */
  private metricsFor(node: NoteState['node']): CardMetrics {
    const key = node.path + SEP + node.title;
    const cached = this.metricsCache.get(key);
    if (cached !== undefined) return cached;

    const ctx = this.ctx;
    const metrics: CardMetrics = ctx
      ? this.measureTitle(ctx, node.title)
      : { text: node.title, width: 140 };
    this.metricsCache.set(key, metrics);
    return metrics;
  }

  private measureTitle(ctx: CanvasRenderingContext2D, title: string): CardMetrics {
    ctx.font = FONT_CARD;
    const full = ctx.measureText(title).width;
    if (full <= MAX_TEXT_W) {
      return {
        text: title,
        width: clamp(Math.ceil(full) + CARD_PAD, MIN_W, MAX_W),
      };
    }

    // Binary-search the longest prefix that still fits with an ellipsis.
    let lo = 0;
    let hi = title.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const measured = ctx.measureText(title.slice(0, mid) + '\u2026').width;
      if (measured <= MAX_TEXT_W) lo = mid;
      else hi = mid - 1;
    }
    let text = title.slice(0, lo);
    while (text.length > 0 && text.charCodeAt(text.length - 1) === 32) {
      text = text.slice(0, -1);
    }
    return { text: text + '\u2026', width: MAX_W };
  }

  private recAt(index: number): NoteRec {
    let rec = this.recs[index];
    if (rec === undefined) {
      rec = makeNoteRec();
      this.recs[index] = rec;
    }
    return rec;
  }

  private planetRecAt(index: number): PlanetRec {
    let rec = this.planetRecs[index];
    if (rec === undefined) {
      rec = makePlanetRec();
      this.planetRecs[index] = rec;
    }
    return rec;
  }

  private labelWidth(ctx: CanvasRenderingContext2D, name: string): number {
    const cached = this.labelWidths.get(name);
    if (cached !== undefined) return cached;
    ctx.font = FONT_PLANET;
    const measured = ctx.measureText(name).width;
    this.labelWidths.set(name, measured);
    return measured;
  }

  /* ---------------------------------------------------------------- */
  /* Occlusion                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Build the screen-space occluder: the projected accretion disk around the
   * black hole, whose ellipse also contains the 2.598 r_s apparent shadow.
   */
  private prepareOccluder(frame: FrameState): void {
    this.occActive = false;

    const cam = frame.camera;
    const depth = viewDepth(cam, ORIGIN);
    const sr = frame.shadowRadius;
    if (!(sr > 1) || !(depth > cam.near) || !Number.isFinite(depth)) return;

    const focal =
      frame.height / 2 / Math.tan((cam.fovDeg * Math.PI) / 360);
    const thickness = clamp(this.settings.diskThickness, 0.3, 2.5);

    // Sample the outer rim of the disk in the XZ plane and fit its projected
    // screen-space ellipse. This automatically accounts for the perspective
    // bulge on the near side, which a circle-at-distance estimate under-covers.
    const scx = frame.shadowCenter.x;
    const scy = frame.shadowCenter.y;
    const pt = this.point;
    const samples = 32;
    const step = TAU / samples;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let valid = 0;
    for (let k = 0; k < samples; k++) {
      const a = k * step;
      cam.projectXYZ(
        Math.cos(a) * DISK_OUTER,
        0,
        Math.sin(a) * DISK_OUTER,
        pt,
      );
      if (!(pt.depth > cam.near)) continue;
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
      valid++;
    }
    if (valid === 0) return;

    let ox = (minX + maxX) * 0.5;
    let oy = (minY + maxY) * 0.5;
    let rx = (maxX - minX) * 0.5;
    let ry = (maxY - minY) * 0.5;

    // The occluder must also contain the apparent shadow, even when the disk is
    // projected razor-thin.
    const needRX = Math.abs(scx - ox) + sr;
    const needRY = Math.abs(scy - oy) + sr;
    if (needRX > rx) rx = needRX;
    if (needRY > ry) ry = needRY;

    // The slab adds a little vertical projected half-height.
    const thicknessPx =
      (focal * thickness * OCC_DISK_HALF_THICKNESS) / depth;
    ry += thicknessPx;

    rx *= OCC_MARGIN_X;
    ry *= OCC_MARGIN_Y;
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return;

    const cap = Math.max(frame.width, frame.height) * OCC_MAX_FACTOR;
    rx = Math.min(rx, cap);
    ry = Math.min(ry, cap);
    if (rx < 1 || ry < 1) return;

    this.occActive = true;
    this.occX = ox;
    this.occY = oy;
    this.occRX = rx;
    this.occRY = ry;
    this.occDepth = depth;
  }

  /**
   * OCC_FULL: the whole footprint is inside the occluder.
   * OCC_PARTIAL: the footprint overlaps the occluder edge.
   * OCC_NONE: entirely outside.
   */
  private occlusionType(x: number, y: number, radius: number): number {
    if (!this.occActive) return OCC_NONE;
    const nx = (x - this.occX) / this.occRX;
    const ny = (y - this.occY) / this.occRY;
    const e = Math.sqrt(nx * nx + ny * ny);
    const rn = radius / Math.min(this.occRX, this.occRY);
    if (e + rn <= 1) return OCC_FULL;
    if (e - rn < 1) return OCC_PARTIAL;
    return OCC_NONE;
  }

  private insideOccluder(x: number, y: number): boolean {
    if (!this.occActive) return false;
    const nx = (x - this.occX) / this.occRX;
    const ny = (y - this.occY) / this.occRY;
    return nx * nx + ny * ny <= 1;
  }

  /** Build the "everything except the black-hole disk" clip path. */
  private clipOutsideOccluder(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.rect(-1e5, -1e5, 2e5, 2e5);
    ctx.moveTo(this.occX + this.occRX, this.occY);
    ctx.ellipse(this.occX, this.occY, this.occRX, this.occRY, 0, 0, TAU);
    ctx.clip('evenodd');
  }

  /* ---------------------------------------------------------------- */
  /* Planets                                                          */
  /* ---------------------------------------------------------------- */

  private preparePlanets(
    ctx: CanvasRenderingContext2D,
    frame: FrameState,
    focusIdx: number,
  ): void {
    const cam = frame.camera;
    const planets = this.planets;
    const hover = this.hovered;
    const sel = this.selected;
    const scx = this.fx;
    const scy = this.fy;

    ctx.font = FONT_PLANET;

    for (let i = 0; i < planets.length; i++) {
      const planet = planets[i];
      const rec = this.planetRecAt(i);

      rec.id = planet.id;
      rec.name = planet.name;
      rec.index = i;
      rec.seed = planet.seed;
      rec.hasRing = planet.hasRing;
      rec.noteCount = planet.noteCount;
      rec.paletteIdx =
        (planet.index + Math.floor(planet.seed * 4096)) % PLANET_PALETTE.length;
      rec.suppressed = false;
      rec.clip = false;
      rec.behind = false;
      rec.fade = 0;
      rec.cardMode = false;
      rec.dim = focusIdx >= 0 && focusIdx !== i ? FOCUS_NEIGHBOR_DIM : 1;
      rec.isHovered = hover !== null && hover === planet.id;
      rec.isSelected = sel !== null && sel === planet.id;
      rec.posX = planet.position.x;
      rec.posY = planet.position.y;
      rec.posZ = planet.position.z;
      rec.orbitR = planet.orbitRadius;

      // Reconstruct the orbital plane from the planet's own position: both the
      // y and z offsets scale with sin(theta), so their ratio is the fixed
      // plane tilt and needs no private layout data. At the nodes the previous
      // plane is kept (the tilt only spans +-4 degrees, so nothing pops).
      const planar = Math.hypot(planet.position.y, planet.position.z);
      if (planar > 1e-4) {
        const invPlanar = 1 / planar;
        rec.orbitSinI = -planet.position.y * invPlanar;
        rec.orbitCosI = planet.position.z * invPlanar;
      }

      const sp = cam.projectSphere(planet.position, planet.radius);
      const depth = viewDepth(cam, planet.position);
      rec.x = this.snap(sp.x);
      rec.y = this.snap(sp.y);
      rec.radius = Math.max(0, sp.radius);
      rec.depth = depth;
      rec.visible =
        sp.onScreen &&
        Number.isFinite(rec.x) &&
        Number.isFinite(rec.y) &&
        Number.isFinite(rec.radius);

      if (!rec.visible) continue;

      // While zoomed into one planet, neighbours can end up filling half the
      // viewport. Drop those instead of letting them swallow the scene.
      if (focusIdx >= 0 && focusIdx !== i && rec.radius > frame.height * FOCUS_NEIGHBOR_CULL) {
        rec.suppressed = true;
        rec.visible = false;
        continue;
      }

      // Physical depth occlusion: only objects farther than the hole centre
      // can be covered by its disk. In front of the hole they correctly pass
      // over it.
      if (this.occActive && depth > this.occDepth + OCC_EPS) {
        rec.behind = true;
        const occ = this.occlusionType(rec.x, rec.y, rec.radius);
        if (occ === OCC_FULL) {
          rec.visible = false;
          continue;
        }
        if (occ === OCC_PARTIAL) {
          // A one-pixel planet cannot be clipped meaningfully; hide it.
          if (rec.radius < TINY_PLANET) {
            rec.visible = false;
            continue;
          }
          rec.clip = true;
        }
      }

      // Cards belong to the focused planet only, and ramp in as it grows.
      rec.cardMode = focusIdx === i;
      rec.fade = rec.cardMode ? smoothstep(CARD_LOD_MIN, CARD_LOD_MAX, rec.radius) : 0;

      // Deterministic axial tilt and slow spin; the baked material is sampled
      // in planet-local space, so this is what makes relief parallax.
      const tilt = (planet.seed - 0.5) * 2 * PLANET_AXIAL_TILT;
      const spinSpeed =
        (PLANET_SPIN_BASE + planet.seed * PLANET_SPIN_VAR) *
        (planet.seed >= 0.5 ? 1 : -1);
      const spin = planet.seed * TAU + frame.time * spinSpeed;
      rec.tiltSin = Math.sin(tilt);
      rec.tiltCos = Math.cos(tilt);
      rec.spinSin = Math.sin(spin);
      rec.spinCos = Math.cos(spin);

      // Light comes from the black hole.
      let lx = scx - rec.x;
      let ly = scy - rec.y;
      const ll = Math.hypot(lx, ly);
      if (ll < 1e-3) {
        lx = 0;
        ly = -1;
      } else {
        lx /= ll;
        ly /= ll;
      }
      rec.dirX = lx;
      rec.dirY = ly;
    }
  }

  private paintPlanet(ctx: CanvasRenderingContext2D, p: PlanetRec): void {
    const dpr = this.dpr;
    const sw = PLANET_PALETTE[p.paletteIdx];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = p.dim;

    if (p.radius < TINY_PLANET) {
      // Too small for a sphere: a single device-pixel dot.
      ctx.fillStyle = sw.lit;
      const px = 1 / dpr;
      const x = this.snap(p.x);
      const y = this.snap(p.y);
      ctx.fillRect(x - px * 0.5, y - px * 0.5, px, px);
      this.pushHit(HIT_PLANET, p.index, p.x - 4, p.y - 4, 8, 8, p.clip && p.behind);
      ctx.globalAlpha = 1;
      return;
    }

    const r = p.radius;
    if (p.clip) {
      ctx.save();
      this.clipOutsideOccluder(ctx);
    }

    const mat = this.materialFor(p);

    if (p.hasRing && r >= 4) this.strokeRing(ctx, p, true);

    if (mat !== null) {
      this.shadePlanet(ctx, p, mat);
      this.paintPlanetHalo(ctx, p, mat);
    } else {
      // Material baking failed (no DOM image support): a flat lit disc is a
      // safer fallback than dropping the planet.
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fillStyle = sw.mid;
      ctx.fill();
    }

    if (p.isHovered || p.isSelected) {
      ctx.strokeStyle = p.isSelected
        ? 'rgba(176,208,248,0.75)'
        : 'rgba(206,228,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 1.5, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    if (p.hasRing && r >= 4) this.strokeRing(ctx, p, false);

    if (p.clip) ctx.restore();

    ctx.globalAlpha = 1;
    this.pushHit(HIT_PLANET, p.index, p.x - r, p.y - r, r * 2, r * 2, p.clip && p.behind);
  }

  /** Baked material for a planet, generated once per seed/palette pair. */
  private materialFor(p: PlanetRec): PlanetMaterial | null {
    if (
      p.mat !== null &&
      p.matSeed === p.seed &&
      p.matPalette === p.paletteIdx
    ) {
      return p.mat;
    }

    const key = p.seed * PLANET_PALETTE.length + p.paletteIdx;
    let mat = this.materialCache.get(key);
    if (mat === undefined) {
      mat = buildPlanetMaterial(PLANET_PALETTE[p.paletteIdx].base, p.seed);
      if (this.materialCache.size >= MAT_CACHE_MAX) {
        const oldest = this.materialCache.keys().next();
        if (!oldest.done) this.materialCache.delete(oldest.value);
      }
      this.materialCache.set(key, mat);
    }
    p.matSeed = p.seed;
    p.matPalette = p.paletteIdx;
    p.mat = mat;
    return mat;
  }

  /**
   * Per-pixel planet body: procedural albedo, height-derived normal map,
   * directional disk light, near-black ambient and a Fresnel rim. The sphere
   * is rasterised in device pixels (capped) and composited through an
   * offscreen canvas so globalAlpha and the disk clip still apply.
   */
  private shadePlanet(
    ctx: CanvasRenderingContext2D,
    p: PlanetRec,
    mat: PlanetMaterial,
  ): void {
    const cam = this.cam;
    if (!cam) return;

    const rd = p.radius * this.dpr;
    if (!(rd >= 1)) return;

    // Internal raster size: never larger than 2 * SHADE_MAX_RADIUS_DEV, so a
    // focused planet does not cost quadratic time at high devicePixelRatio.
    let iw = Math.round(rd * 2);
    if (iw < 2) iw = 2;
    if (iw > SHADE_MAX_RADIUS_DEV * 2) iw = SHADE_MAX_RADIUS_DEV * 2;
    const ih = iw;
    const bufW = SHADE_BUF_PX;

    const img = this.ensureShadeTarget();
    if (img === null) return;
    const data = img.data;

    // Clear only the rows/columns that get written this frame. Pixels outside
    // the disc must be transparent so drawImage leaves the backdrop intact.
    for (let j = 0; j < ih; j++) {
      data.fill(0, j * bufW * 4, (j * bufW + iw) * 4);
    }

    // View basis (rows of the view matrix) and the disk light in view space.
    const v = cam.view;
    const rX = v[0];
    const rY = v[4];
    const rZ = v[8];
    const uX = v[1];
    const uY = v[5];
    const uZ = v[9];
    const bX = v[2];
    const bY = v[6];
    const bZ = v[10];

    let lwx = 0;
    let lwy = 1;
    let lwz = 0;
    const plen = Math.hypot(p.posX, p.posY, p.posZ);
    if (plen > 1e-5) {
      lwx = -p.posX / plen;
      lwy = -p.posY / plen;
      lwz = -p.posZ / plen;
    }
    const Lr = lwx * rX + lwy * rY + lwz * rZ;
    const Lu = lwx * uX + lwy * uY + lwz * uZ;
    const Lb = lwx * bX + lwy * bY + lwz * bZ;

    const cs = p.spinCos;
    const ss = p.spinSin;
    const ct = p.tiltCos;
    const st = p.tiltSin;

    const albedo = mat.albedo;
    const normalMap = mat.normal;
    const hR = mat.halo[0] / 255;
    const hG = mat.halo[1] / 255;
    const hB = mat.halo[2] / 255;
    const rimPow = mat.rimPow;

    const half = iw * 0.5;
    const invHalf = 1 / half;
    const invTau = 1 / TAU;
    const invPi = 1 / Math.PI;
    const invDiff = 1 / (1 + SHADE_WRAP);
    const matW = MAT_W;
    const matH = MAT_H;

    for (let j = 0; j < ih; j++) {
      const sy = (j + 0.5) * invHalf - 1;
      const bComp = -sy;
      const rowBase = j * bufW;

      for (let i = 0; i < iw; i++) {
        const sx = (i + 0.5) * invHalf - 1;
        const rr = sx * sx + sy * sy;
        if (rr > 1.04) continue;

        const dist = Math.sqrt(rr);
        let cover = (1 - dist) * rd + 0.5;
        if (cover <= 0.004) continue;
        if (cover > 1) cover = 1;

        // Sphere normal in view space: right = sx, up = -sy, back = +z.
        const a = sx;
        const c = Math.sqrt(Math.max(0, 1 - rr));
        const nwx = rX * a + uX * bComp + bX * c;
        const nwy = rY * a + uY * bComp + bY * c;
        const nwz = rZ * a + uZ * bComp + bZ * c;

        // World -> planet-local (inverse spin then inverse axial tilt).
        const x1 = cs * nwx - ss * nwz;
        const y1 = nwy;
        const z1 = ss * nwx + cs * nwz;
        const lx = x1;
        const lyRaw = ct * y1 + st * z1;
        const lz = -st * y1 + ct * z1;
        const ly = lyRaw > 1 ? 1 : lyRaw < -1 ? -1 : lyRaw;

        const lat = Math.asin(ly);
        const lon = Math.atan2(lz, lx);
        let u = lon * invTau;
        if (u < 0) u += 1;

        // Bilinear albedo / normal fetch. Longitude wraps, latitude clamps.
        const tx = u * matW - 0.5;
        const xi = Math.floor(tx);
        const fx = tx - xi;
        let x0 = xi % matW;
        if (x0 < 0) x0 += matW;
        let x1i = (xi + 1) % matW;
        if (x1i < 0) x1i += matW;

        const ty = (lat * invPi + 0.5) * matH - 0.5;
        const yi = Math.floor(ty);
        const fy = ty - yi;
        let y0 = yi;
        let y1i = yi + 1;
        if (y0 < 0) y0 = 0;
        else if (y0 > matH - 1) y0 = matH - 1;
        if (y1i < 0) y1i = 0;
        else if (y1i > matH - 1) y1i = matH - 1;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const r0 = y0 * matW;
        const r1 = y1i * matW;
        const a00 = r0 + x0;
        const a10 = r0 + x1i;
        const a01 = r1 + x0;
        const a11 = r1 + x1i;

        const albR =
          (albedo[a00 * 3] * w00 +
            albedo[a10 * 3] * w10 +
            albedo[a01 * 3] * w01 +
            albedo[a11 * 3] * w11) /
          255;
        const albG =
          (albedo[a00 * 3 + 1] * w00 +
            albedo[a10 * 3 + 1] * w10 +
            albedo[a01 * 3 + 1] * w01 +
            albedo[a11 * 3 + 1] * w11) /
          255;
        const albB =
          (albedo[a00 * 3 + 2] * w00 +
            albedo[a10 * 3 + 2] * w10 +
            albedo[a01 * 3 + 2] * w01 +
            albedo[a11 * 3 + 2] * w11) /
          255;

        const snx =
          normalMap[a00 * 2] * w00 +
          normalMap[a10 * 2] * w10 +
          normalMap[a01 * 2] * w01 +
          normalMap[a11 * 2] * w11;
        const sny =
          normalMap[a00 * 2 + 1] * w00 +
          normalMap[a10 * 2 + 1] * w10 +
          normalMap[a01 * 2 + 1] * w01 +
          normalMap[a11 * 2 + 1] * w11;

        // Local tangent frame at (lat, lon).
        const cl = Math.sqrt(Math.max(0, 1 - ly * ly));
        let Tx: number;
        let Tz: number;
        let Bx: number;
        let By: number;
        let Bz: number;
        if (cl > 1e-3) {
          const invCl = 1 / cl;
          Tx = -lz * invCl;
          Tz = lx * invCl;
          Bx = -ly * lx * invCl;
          By = cl;
          Bz = -ly * lz * invCl;
        } else {
          Tx = 1;
          Tz = 0;
          Bx = 0;
          By = 0;
          Bz = -1;
        }

        // n = normalize(vec3(-dHdu * s, -dHdv * s, 1)) is baked as (snx, sny).
        const snz2 = 1 - snx * snx - sny * sny;
        const snz = snz2 > 0 ? Math.sqrt(snz2) : 0;
        const plx = lx * snz + Tx * snx + Bx * sny;
        const ply = ly * snz + By * sny;
        const plz = lz * snz + Tz * snx + Bz * sny;

        // Planet-local -> world (forward tilt then spin).
        const ry0 = ct * ply - st * plz;
        const rz0 = st * ply + ct * plz;
        const wx = cs * plx + ss * rz0;
        const wy = ry0;
        const wz = -ss * plx + cs * rz0;

        const vx = wx * rX + wy * rY + wz * rZ;
        const vy = wx * uX + wy * uY + wz * uZ;
        const vz = wx * bX + wy * bY + wz * bZ;

        const ndl = vx * Lr + vy * Lu + vz * Lb;
        const diff = Math.max(0, (ndl + SHADE_WRAP) * invDiff);
        const shade = SHADE_AMBIENT + diff * SHADE_DIFFUSE;

        // Fresnel on the geometric sphere normal keeps the atmosphere a clean
        // silhouette ring instead of speckling along normal-map ridges.
        const fres = 1 - c;
        let rim = 0;
        if (fres > 0.02) {
          rim =
            Math.pow(fres, rimPow) *
            RIM_STRENGTH *
            (RIM_DARK_SIDE + (1 - RIM_DARK_SIDE) * diff);
        }

        const o = (rowBase + i) * 4;
        let cr = albR * shade * LIGHT_R + hR * rim;
        let cg = albG * shade * LIGHT_G + hG * rim;
        let cb = albB * shade * LIGHT_B + hB * rim;
        if (cr > 1) cr = 1;
        if (cg > 1) cg = 1;
        if (cb > 1) cb = 1;
        data[o] = (cr * 255) | 0;
        data[o + 1] = (cg * 255) | 0;
        data[o + 2] = (cb * 255) | 0;
        data[o + 3] = (cover * 255) | 0;
      }
    }

    const canvas = this.shadeCanvas;
    const sctx = this.shadeCtx;
    if (canvas === null || sctx === null) return;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.putImageData(img, 0, 0, 0, 0, iw, ih);
    const d = p.radius * 2;
    ctx.drawImage(canvas, 0, 0, iw, ih, p.x - p.radius, p.y - p.radius, d, d);
  }

  /** Lazily create the reusable offscreen raster target. */
  private ensureShadeTarget(): ImageData | null {
    if (this.shadeImage !== null && this.shadeCtx !== null) return this.shadeImage;
    const doc = this.canvas.ownerDocument;
    if (!doc) return null;
    const canvas = doc.createElement('canvas');
    canvas.width = SHADE_BUF_PX;
    canvas.height = SHADE_BUF_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    this.shadeCanvas = canvas;
    this.shadeCtx = ctx;
    this.shadeImage = ctx.createImageData(SHADE_BUF_PX, SHADE_BUF_PX);
    return this.shadeImage;
  }

  /** Soft seed-tinted atmosphere halo, drawn only as a thin outer annulus. */
  private paintPlanetHalo(
    ctx: CanvasRenderingContext2D,
    p: PlanetRec,
    mat: PlanetMaterial,
  ): void {
    const r = p.radius;
    if (r < HALO_MIN_RADIUS) return;

    const g = ctx.createRadialGradient(
      p.x,
      p.y,
      r * HALO_INNER,
      p.x,
      p.y,
      r * HALO_OUTER,
    );
    g.addColorStop(0, mat.haloInner);
    g.addColorStop(0.55, mat.haloMid);
    g.addColorStop(1, mat.haloOuter);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = p.dim;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * HALO_OUTER, 0, TAU);
    ctx.arc(p.x, p.y, r * HALO_INNER, 0, TAU, true);
    ctx.fill('evenodd');
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Orbit tracks (spec E)                                            */
  /* ---------------------------------------------------------------- */

  private drawOrbits(
    ctx: CanvasRenderingContext2D,
    focusIdx: number,
    w: number,
    h: number,
  ): void {
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.setLineDash(NO_DASH);

    const recs = this.planetRecs;
    const n = this.planetCount;

    // Planetary orbits: thin cold rings, always on in the system view.
    for (let i = 0; i < n; i++) {
      const p = recs[i];
      if (p === undefined || p.suppressed) continue;
      this.paintPlanetOrbit(ctx, p, focusIdx, w, h);
    }

    // Far halves of moon orbits, below every body.
    for (let i = 0; i < n; i++) {
      const p = recs[i];
      if (p === undefined || p.suppressed) continue;
      this.paintMoonOrbits(ctx, p, true);
    }

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
  }

  private paintPlanetOrbit(
    ctx: CanvasRenderingContext2D,
    p: PlanetRec,
    focusIdx: number,
    w: number,
    h: number,
  ): void {
    const cam = this.cam;
    const r = p.orbitR;
    if (!cam || !(r > 0)) return;

    const count = ORBIT_SAMPLES;
    const px = this.orbitPX;
    const py = this.orbitPY;
    const pd = this.orbitPD;
    const pt = this.point;
    const sinI = p.orbitSinI;
    const cosI = p.orbitCosI;

    for (let k = 0; k <= count; k++) {
      const ang = (k / count) * TAU;
      const planarZ = r * Math.sin(ang);
      cam.projectXYZ(
        r * Math.cos(ang),
        -planarZ * sinI,
        planarZ * cosI,
        pt,
      );
      px[k] = pt.x;
      py[k] = pt.y;
      pd[k] = pt.depth;
    }

    let base: number;
    if (focusIdx >= 0) {
      base = focusIdx === p.index ? ORBIT_PLANET_ALPHA_SELF : ORBIT_PLANET_ALPHA_OTHER;
    } else {
      base = ORBIT_PLANET_ALPHA;
    }
    if (p.isHovered || p.isSelected) {
      base = Math.max(base, ORBIT_PLANET_ALPHA_SELF);
    }
    if (base <= 0.01) return;

    const centerDepth = this.occActive ? this.occDepth : viewDepth(cam, ORIGIN);
    const span = r * 0.85;
    const shadowR = this.fr * 0.98;
    const shadowR2 = shadowR * shadowR;

    ctx.strokeStyle = ORBIT_COLOR_CSS;
    ctx.lineWidth = ORBIT_PLANET_WIDTH;

    for (let k = 0; k < count; k++) {
      const x0 = px[k];
      const y0 = py[k];
      const x1 = px[k + 1];
      const y1 = py[k + 1];
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
      if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      if (pd[k] <= cam.near || pd[k + 1] <= cam.near) continue;
      if (x0 < -32 && x1 < -32) continue;
      if (x0 > w + 32 && x1 > w + 32) continue;
      if (y0 < -32 && y1 < -32) continue;
      if (y0 > h + 32 && y1 > h + 32) continue;

      const midDepth = (pd[k] + pd[k + 1]) * 0.5;
      const farT = smoothstep(centerDepth - span, centerDepth + span, midDepth);
      let alpha = base * lerp(1, ORBIT_DEPTH_DIM, farT);

      const mx = (x0 + x1) * 0.5;
      const my = (y0 + y1) * 0.5;

      // Acceptance: tracks must never paint across the black-hole shadow.
      if (shadowR > 1) {
        const dsx = mx - this.fx;
        const dsy = my - this.fy;
        if (dsx * dsx + dsy * dsy < shadowR2) continue;
      }

      if (this.occActive && midDepth > this.occDepth + OCC_EPS) {
        const nx = (mx - this.occX) / this.occRX;
        const ny = (my - this.occY) / this.occRY;
        const e = Math.sqrt(nx * nx + ny * ny);
        if (e <= 1) continue;
        if (e < 1 + ORBIT_OCC_FADE) {
          alpha *= smoothstep(1, 1 + ORBIT_OCC_FADE, e);
        }
      }
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = Math.min(1, alpha);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  /**
   * One planet's moon orbit tracks. `far` selects the half behind the planet
   * centre (painted before the body); the near half is painted right after the
   * body, so occlusion reads both in front of and behind the planet.
   */
  private paintMoonOrbits(
    ctx: CanvasRenderingContext2D,
    p: PlanetRec,
    far: boolean,
  ): void {
    const cam = this.cam;
    if (!cam || p.suppressed) return;

    const focusIdx = this.focusIdx;
    let base: number;
    let cap: number;
    if (focusIdx >= 0) {
      // Spec E: only the focused planet's moons are emphasised; neighbours are
      // already dimmed in focus view, so their tracks stay off.
      if (focusIdx !== p.index) return;
      base = ORBIT_MOON_ALPHA_FOCUS;
      cap = MOON_TRACK_FOCUS_CAP;
    } else {
      if (p.radius < MOON_TRACK_MIN_RADIUS) return;
      base = ORBIT_MOON_ALPHA;
      cap = MOON_TRACK_SYSTEM_CAP;
    }
    if (p.isHovered || p.isSelected) base = Math.min(0.25, base + 0.03);

    const start = this.planetNoteStart[p.index];
    const end = this.planetNoteStart[p.index + 1];
    if (start === undefined || end === undefined) return;
    const total = end - start;
    if (total <= 0 || cap <= 0) return;
    const stride = Math.max(1, Math.ceil(total / cap));

    const count = MOON_ORBIT_SAMPLES;
    const px = this.orbitPX;
    const py = this.orbitPY;
    const pd = this.orbitPD;
    const pt = this.point;
    const planetDepth = p.depth;
    const w = this.width;
    const h = this.height;
    const shadowR = this.fr * 0.98;
    const shadowR2 = shadowR * shadowR;

    ctx.strokeStyle = MOON_ORBIT_COLOR_CSS;
    ctx.lineWidth = MOON_ORBIT_WIDTH;

    for (let ni = start; ni < end; ni += stride) {
      const noteIdx = this.planetNotes[ni];
      const note = this.notes[noteIdx];
      if (note === undefined) continue;

      const orb = note.orbit;
      const rr = orb.radius;
      if (!(rr > 0)) continue;
      const sinJ = Math.sin(orb.inclination);
      const cosJ = Math.cos(orb.inclination);
      const bx = p.posX;
      const by = p.posY;
      const bz = p.posZ;

      for (let k = 0; k <= count; k++) {
        const ang = (k / count) * TAU;
        const planarZ = rr * Math.sin(ang);
        cam.projectXYZ(
          bx + rr * Math.cos(ang),
          by - planarZ * sinJ,
          bz + planarZ * cosJ,
          pt,
        );
        px[k] = pt.x;
        py[k] = pt.y;
        pd[k] = pt.depth;
      }

      for (let k = 0; k < count; k++) {
        const x0 = px[k];
        const y0 = py[k];
        const x1 = px[k + 1];
        const y1 = py[k + 1];
        if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
        if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;
        if (pd[k] <= cam.near || pd[k + 1] <= cam.near) continue;
        if (x0 < -32 && x1 < -32) continue;
        if (x0 > w + 32 && x1 > w + 32) continue;
        if (y0 < -32 && y1 < -32) continue;
        if (y0 > h + 32 && y1 > h + 32) continue;

        const midDepth = (pd[k] + pd[k + 1]) * 0.5;
        const isFar = midDepth > planetDepth;
        if (isFar !== far) continue;

        const farT = smoothstep(planetDepth - rr, planetDepth + rr, midDepth);
        let alpha = base * lerp(1, MOON_ORBIT_DEPTH_DIM, farT);

        const mx = (x0 + x1) * 0.5;
        const my = (y0 + y1) * 0.5;
        if (shadowR > 1) {
          const dsx = mx - this.fx;
          const dsy = my - this.fy;
          if (dsx * dsx + dsy * dsy < shadowR2) continue;
        }

        if (this.occActive && midDepth > this.occDepth + OCC_EPS) {
          const nx = (mx - this.occX) / this.occRX;
          const ny = (my - this.occY) / this.occRY;
          const e = Math.sqrt(nx * nx + ny * ny);
          if (e <= 1) continue;
          if (e < 1 + ORBIT_OCC_FADE) {
            alpha *= smoothstep(1, 1 + ORBIT_OCC_FADE, e);
          }
        }
        if (alpha <= 0.008) continue;

        ctx.globalAlpha = Math.min(1, alpha);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }

  private strokeRing(ctx: CanvasRenderingContext2D, p: PlanetRec, far: boolean): void {
    const r = p.radius;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((-18 * Math.PI) / 180);
    ctx.beginPath();
    if (far) ctx.ellipse(0, 0, r * 1.9, r * 0.5, 0, Math.PI, TAU);
    else ctx.ellipse(0, 0, r * 1.9, r * 0.5, 0, 0, Math.PI);
    ctx.strokeStyle = 'rgba(200,205,215,0.28)';
    ctx.lineWidth = clamp(r * 0.04, 0.8, 2);
    ctx.stroke();
    ctx.restore();
  }

  private paintPlanetLabel(
    ctx: CanvasRenderingContext2D,
    p: PlanetRec,
    w: number,
    h: number,
  ): void {
    if (!this.settings.showPlanetLabels) return;
    if (!p.visible) return;
    if (p.radius < LABEL_MIN_RADIUS) return;
    const text = p.name;
    if (text.length === 0) return;

    const tw = this.labelWidth(ctx, text);
    const padX = 6;
    // Snap the pill width to whole device pixels so its edges never shimmer.
    const pw = Math.ceil((tw + padX * 2) * this.dpr) / this.dpr;
    const left = clamp(this.snap(p.x - pw * 0.5), 2, Math.max(2, w - 2 - pw));
    const cy = this.snap(p.y + p.radius + LABEL_GAP + LABEL_HEIGHT * 0.5);
    if (cy + LABEL_HEIGHT * 0.5 > h) return;

    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = p.dim;
    ctx.beginPath();
    addRoundRect(ctx, left, cy - LABEL_HEIGHT * 0.5, pw, LABEL_HEIGHT, 4);
    ctx.fillStyle = LABEL_PILL;
    ctx.fill();

    ctx.font = FONT_PLANET;
    ctx.fillStyle = p.isHovered || p.isSelected ? LABEL_TEXT_HOVER : LABEL_TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.snap(left + padX), cy);

    // The label is part of the planet's click target.
    this.pushHit(
      HIT_PLANET,
      p.index,
      left,
      cy - LABEL_HEIGHT * 0.5,
      pw,
      LABEL_HEIGHT,
      false,
    );
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* Notes                                                            */
  /* ---------------------------------------------------------------- */

  private prepareNotes(frame: FrameState, w: number, h: number): void {
    const cam = frame.camera;
    const notes = this.notes;
    const count = notes.length;
    const hover = this.hovered;
    const sel = this.selected;
    const showCards = this.settings.showTitles;
    // Depth reference for size fading is the camera-target distance.
    const refDist = cam.distance > 0.001 ? cam.distance : Math.max(1, this.occDepth);

    this.noteScreenValid.fill(0, 0, count);
    this.dotSeen.fill(0, 0, this.planetCount);

    const pt = this.point;

    for (let i = 0; i < count; i++) {
      const note = notes[i];
      const rec = this.recAt(i);

      rec.visible = false;
      rec.planetIdx = -1;
      rec.title = '';
      rec.baseW = MIN_W;
      rec.scale = 1;
      rec.w = 0;
      rec.h = 0;
      rec.clip = false;
      rec.cardHidden = false;
      rec.behind = false;
      rec.fade = 0;

      const pi = this.notePlanetIdx[i];
      if (pi < 0 || pi >= this.planetCount) continue;
      const planet = this.planetRecs[pi];
      if (planet.suppressed) continue;

      const noteAlpha = clamp(note.alpha, 0, 1);
      if (noteAlpha <= 0.01) continue;

      cam.projectXYZ(note.position.x, note.position.y, note.position.z, pt);
      if (!pt.onScreen) continue;

      const screenFade = smoothstep(
        0,
        40,
        Math.min(pt.x, pt.y, w - pt.x, h - pt.y),
      );
      if (screenFade <= 0.001) continue;

      const depthFade = lerp(1, 0.35, smoothstep(refDist, refDist * 1.9, pt.depth));
      let alpha = noteAlpha * depthFade * screenFade * planet.dim;
      if (alpha <= 0.012) continue;

      const x = this.snap(pt.x);
      const y = this.snap(pt.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      // Dots read as soft points: 0.35 base + 0.45 per unit of note alpha.
      const dotR = clamp(1.1 * pt.scale, 1, 2.6);

      // Moons behind the hole are swallowed by the shadow/disk. Fully inside
      // -> hide; on the rim -> fade out smoothly.
      let behind = false;
      if (this.occActive && pt.depth > this.occDepth + OCC_EPS) {
        behind = true;
        const occ = this.occlusionType(x, y, dotR);
        if (occ === OCC_FULL) continue;
        if (occ === OCC_PARTIAL) {
          const nx = (x - this.occX) / this.occRX;
          const ny = (y - this.occY) / this.occRY;
          const e = Math.sqrt(nx * nx + ny * ny);
          const edge = smoothstep(1, 1 + OCC_DOT_FADE, e);
          alpha *= edge;
          if (alpha <= 0.012) continue;
        }
      }

      const node = note.node;
      const isHovered = hover !== null && (hover === node.path || hover === node.id);
      const isSelected = sel !== null && (sel === node.path || sel === node.id);

      // While a planet is closed, huge folders only show a strided sample.
      if (!planet.cardMode && !isHovered && !isSelected && planet.noteCount > DOT_CAP) {
        const stride = Math.ceil(planet.noteCount / DOT_CAP);
        const seen = this.dotSeen[pi];
        this.dotSeen[pi] = seen + 1;
        if (seen % stride !== 0) continue;
      }

      const fade = planet.fade;
      let baseW = MIN_W;
      let title = '';
      let scale = 1;
      let cardW = 0;
      let cardH = 0;
      let cardHidden = false;
      let clip = false;

      if (showCards && fade > 0.02) {
        const metrics = this.noteMetrics[i] ?? this.metricsFor(node);
        baseW = metrics.width;
        title = metrics.text;

        scale = clamp(pt.scale, SCALE_MIN, SCALE_MAX);
        if (isHovered) scale *= HOVER_SCALE;
        else if (isSelected) scale *= SELECT_SCALE;
        scale = Math.round(scale * SCALE_STEPS) / SCALE_STEPS;

        // Pixel-snap the whole card box (even device pixels) so its border and
        // text do not shimmer at low orbital speed.
        cardW = this.snapCardSize(baseW * scale);
        cardH = this.snapCardSize(CARD_H * scale);

        if (behind) {
          const halfDiag = Math.sqrt(cardW * cardW + cardH * cardH) * 0.5;
          const occ = this.occlusionType(x, y, halfDiag);
          if (occ === OCC_FULL) cardHidden = true;
          else if (occ === OCC_PARTIAL) clip = true;
        }
      }

      // Coarse viewport cull.
      const halfW = cardW > 0 ? cardW * 0.5 : 4;
      const halfH = cardH > 0 ? cardH * 0.5 : 4;
      if (
        x + halfW < -8 ||
        x - halfW > w + 8 ||
        y + halfH < -8 ||
        y - halfH > h + 8
      ) {
        continue;
      }

      rec.idx = i;
      rec.planetIdx = pi;
      rec.path = node.path;
      rec.title = title;
      rec.baseW = baseW;
      rec.x = x;
      rec.y = y;
      rec.dotR = dotR;
      rec.scale = scale;
      rec.w = cardW;
      rec.h = cardH;
      rec.depth = pt.depth;
      rec.alpha = alpha;
      rec.dotA = (0.35 + 0.45 * noteAlpha) * alpha;
      rec.fade = fade;
      rec.isHovered = isHovered;
      rec.isSelected = isSelected;
      rec.isNeighbor = !isHovered && this.hoverNeighbors.has(node.path);
      rec.clip = clip;
      rec.cardHidden = cardHidden;
      rec.behind = behind;
      rec.visible = true;

      this.noteScreenX[i] = x;
      this.noteScreenY[i] = y;
      this.noteScreenA[i] = alpha;
      this.noteScreenValid[i] = 1;
    }
  }

  private paintNote(ctx: CanvasRenderingContext2D, rec: NoteRec): void {
    if (!rec.visible) return;

    if (this.settings.showTitles) {
      const dotAlpha = rec.dotA * (1 - rec.fade);
      if (dotAlpha > 0.02) this.paintDot(ctx, rec, dotAlpha, rec.dotR);

      if (!rec.cardHidden) {
        const cardAlpha = rec.alpha * rec.fade;
        if (cardAlpha > 0.02) this.paintCard(ctx, rec, cardAlpha);
      }
      return;
    }

    // showTitles === false: dots only, slightly enlarged for the focused
    // planet. Notes never show text outside/without card mode.
    const radius = lerp(rec.dotR, 3.4, rec.fade);
    const dotAlpha = rec.dotA * (1 - 0.25 * rec.fade);
    if (dotAlpha > 0.02) this.paintDot(ctx, rec, dotAlpha, radius);
  }

  private paintDot(
    ctx: CanvasRenderingContext2D,
    rec: NoteRec,
    alpha: number,
    radius: number,
  ): void {
    const dpr = this.dpr;
    const planet = this.planetRecs[rec.planetIdx];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.fillStyle = PLANET_PALETTE[planet.paletteIdx].dot;
    ctx.beginPath();
    ctx.arc(rec.x, rec.y, radius, 0, TAU);
    ctx.fill();

    if (rec.isHovered || rec.isSelected) {
      ctx.strokeStyle = rec.isSelected
        ? 'rgba(170,205,250,0.85)'
        : 'rgba(215,235,255,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(rec.x, rec.y, radius + 1.5, 0, TAU);
      ctx.stroke();
    }

    if (alpha > 0.15) {
      const half = Math.max(4, radius + 2.5);
      this.pushHit(HIT_NOTE, rec.idx, rec.x - half, rec.y - half, half * 2, half * 2, false);
    }
    ctx.globalAlpha = 1;
  }

  private paintCard(
    ctx: CanvasRenderingContext2D,
    rec: NoteRec,
    alpha: number,
  ): void {
    const dpr = this.dpr;
    const s = rec.scale;
    const scaleDev = dpr * s;
    ctx.setTransform(scaleDev, 0, 0, scaleDev, dpr * rec.x, dpr * rec.y);
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // rec.w / rec.h are already snapped to even device pixels; converting to
    // local units keeps the whole card on the device grid while the content
    // scales with `s`.
    const bw = rec.w / s;
    const bh = rec.h / s;
    const left = -bw * 0.5;
    const top = -bh * 0.5;

    let clipped = false;
    if (rec.clip && this.occActive) {
      ctx.save();
      const lx = (this.occX - rec.x) / s;
      const ly = (this.occY - rec.y) / s;
      const lrx = this.occRX / s;
      const lry = this.occRY / s;
      ctx.beginPath();
      addRoundRect(ctx, left, top, bw, bh, CARD_RADIUS);
      ctx.moveTo(lx + lrx, ly);
      ctx.ellipse(lx, ly, lrx, lry, 0, 0, TAU);
      ctx.clip('evenodd');
      clipped = true;
    }

    ctx.beginPath();
    addRoundRect(ctx, left, top, bw, bh, CARD_RADIUS);
    ctx.fillStyle = rec.isHovered
      ? CARD_BG_HOVER
      : rec.isSelected
        ? CARD_BG_SELECTED
        : rec.isNeighbor
          ? CARD_BG_NEIGHBOR
          : CARD_BG;
    ctx.fill();

    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = rec.isHovered
      ? BORDER_HOVER
      : rec.isSelected
        ? BORDER_SELECTED
        : rec.isNeighbor
          ? BORDER_NEIGHBOR
          : BORDER;
    ctx.stroke();

    if (rec.title.length > 0) {
      ctx.font = FONT_CARD;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rec.isHovered ? TEXT_HOVER : TEXT_COLOR;
      // Snap the text origin to the device grid in local coordinates.
      const textX = Math.round((left + CARD_PAD * 0.5) * scaleDev) / scaleDev;
      const textY = Math.round(0.5 * scaleDev) / scaleDev;
      ctx.fillText(rec.title, textX, textY);
    }

    if (clipped) ctx.restore();

    this.pushHit(
      HIT_NOTE,
      rec.idx,
      rec.x - rec.w * 0.5,
      rec.y - rec.h * 0.5,
      rec.w,
      rec.h,
      rec.clip && rec.behind,
    );
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* Links: grey dashed beams                                         */
  /* ---------------------------------------------------------------- */

  private drawBeams(ctx: CanvasRenderingContext2D, frame: FrameState): void {
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = BEAM_COLOR;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.setLineDash(BEAM_DASH);
    ctx.lineDashOffset = this.snap(frame.time * BEAM_DRIFT);

    const opacity = clamp(this.settings.edgeOpacity, 0, 1);

    if (this.focusIdx < 0) {
      this.drawInterBeams(ctx, frame, opacity);
    } else {
      this.drawIntraBeams(ctx, opacity);
    }

    // The red comet riders are painted after the guides, using solid fills so
    // the dash pattern never has to be toggled per instance.
    ctx.setLineDash(NO_DASH);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    if (this.focusIdx < 0) {
      this.drawInterComets(ctx, frame, opacity);
    } else {
      this.drawIntraComets(ctx, frame, opacity);
    }

    ctx.setLineDash(NO_DASH);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1;
  }

  private drawInterBeams(
    ctx: CanvasRenderingContext2D,
    frame: FrameState,
    opacity: number,
  ): void {
    const recs = this.planetRecs;
    const hoverPlanet = this.hoverPlanetIdx;
    const hoverViaNote =
      this.hoverNoteIdx >= 0 ? this.recs[this.hoverNoteIdx].planetIdx : -1;
    const limit = Math.min(this.pairA.length, MAX_VISIBLE_INTER_BEAMS);

    for (let i = 0; i < limit; i++) {
      const a = recs[this.pairA[i]];
      const b = recs[this.pairB[i]];
      if (!a.visible || !b.visible) continue;
      // Do not attach a beam to a planet whose centre is hidden by the disk.
      if (a.behind && a.clip) continue;
      if (b.behind && b.clip) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < BEAM_MIN_PAIR_DIST) continue;

      const strength = clamp(Math.sqrt(this.pairCount[i]) / 3, 0, 1);
      let beamAlpha = opacity * (BEAM_ALPHA_MIN + (BEAM_ALPHA_MAX - BEAM_ALPHA_MIN) * strength);
      if (
        hoverPlanet === a.index ||
        hoverPlanet === b.index ||
        hoverViaNote === a.index ||
        hoverViaNote === b.index
      ) {
        beamAlpha += opacity * BEAM_HOVER_BOOST;
      }
      if (beamAlpha <= 0.012) continue;

      this.computeBeamControl(a.x, a.y, b.x, b.y, frame);
      ctx.globalAlpha = Math.min(1, beamAlpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(this.controlX, this.controlY, b.x, b.y);
      ctx.stroke();
    }
  }

  private drawInterComets(
    ctx: CanvasRenderingContext2D,
    frame: FrameState,
    opacity: number,
  ): void {
    const recs = this.planetRecs;
    const hoverPlanet = this.hoverPlanetIdx;
    const hoverViaNote =
      this.hoverNoteIdx >= 0 ? this.recs[this.hoverNoteIdx].planetIdx : -1;
    const limit = Math.min(this.pairA.length, MAX_VISIBLE_INTER_BEAMS, COMET_MAX_SYSTEM);

    for (let i = 0; i < limit; i++) {
      const a = recs[this.pairA[i]];
      const b = recs[this.pairB[i]];
      if (!a.visible || !b.visible) continue;
      if (a.behind && a.clip) continue;
      if (b.behind && b.clip) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.hypot(dx, dy) < BEAM_MIN_PAIR_DIST) continue;

      this.computeBeamControl(a.x, a.y, b.x, b.y, frame);
      const strength = clamp(Math.sqrt(this.pairCount[i]) / 3, 0, 1);
      const hot =
        hoverPlanet === a.index ||
        hoverPlanet === b.index ||
        hoverViaNote === a.index ||
        hoverViaNote === b.index;

      const phase = this.pairPhase[i];
      const speed = this.pairSpeed[i];
      if (phase === undefined || speed === undefined) continue;

      let alpha = clamp(opacity * (0.9 + 0.5 * strength), 0, 1);
      if (hot) alpha = Math.min(1, alpha * 1.4 + 0.12);

      this.drawComet(
        ctx,
        frame.time,
        a.x,
        a.y,
        this.controlX,
        this.controlY,
        b.x,
        b.y,
        phase,
        speed,
        alpha,
        hot,
      );
    }
  }

  /**
   * Bow a pair beam around the black hole. The quadratic apex sits halfway
   * between the chord midpoint and the control point, so a deficit `d` needs
   * a control offset of 2d.
   */
  private computeBeamControl(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    frame: FrameState,
  ): void {
    const mx = (ax + bx) * 0.5;
    const my = (ay + by) * 0.5;

    let nx: number;
    let ny: number;
    if (this.occActive) {
      nx = mx - this.occX;
      ny = my - this.occY;
      let nl = Math.hypot(nx, ny);
      if (nl < 1e-3) {
        const dx = bx - ax;
        const dy = by - ay;
        const dl = Math.hypot(dx, dy) || 1;
        nx = -dy / dl;
        ny = dx / dl;
      } else {
        nx /= nl;
        ny /= nl;
      }
    } else {
      const dx = bx - ax;
      const dy = by - ay;
      const dl = Math.hypot(dx, dy) || 1;
      nx = -dy / dl;
      ny = dx / dl;
    }

    const d = pointSegmentDistance(this.occX, this.occY, ax, ay, bx, by);
    const need = this.occActive
      ? Math.max(0, this.fr * 1.05 + BEAM_HOLE_CLEARANCE - d)
      : 0;
    // Long chords always get a visible bow, so a pair link never reads as a
    // ruler line across the frame.
    const chord = Math.hypot(bx - ax, by - ay);
    let bow = need * 2 + Math.max(BEAM_BOW_MIN, chord * 0.05);
    const maxBow = Math.max(frame.width, frame.height) * 0.6;
    if (bow > maxBow) bow = maxBow;

    this.controlX = mx + nx * bow;
    this.controlY = my + ny * bow;
  }

  private drawIntraBeams(ctx: CanvasRenderingContext2D, opacity: number): void {
    const pi = this.focusIdx;
    if (pi < 0 || pi >= this.planetCount) return;
    const p = this.planetRecs[pi];
    if (!p.visible) return;

    const noteX = this.noteScreenX;
    const noteY = this.noteScreenY;
    const noteA = this.noteScreenA;
    const valid = this.noteScreenValid;
    const intraA = this.intraA;
    const intraB = this.intraB;
    const hoverNote = this.hoverNoteIdx;
    const hoverPlanet = this.hoverPlanetIdx;

    const from = this.intraStart[pi];
    const to = this.intraEnd[pi];
    if (from === undefined || to === undefined) return;
    const planetHover = hoverPlanet === pi;

    for (let k = from; k < to; k++) {
      const ia = intraA[k];
      const ib = intraB[k];
      if (valid[ia] === 0 || valid[ib] === 0) continue;

      const ax = noteX[ia];
      const ay = noteY[ia];
      const bx = noteX[ib];
      const by = noteY[ib];
      if (Math.hypot(bx - ax, by - ay) < 6) continue;

      let beamAlpha = opacity * BEAM_INTRA_ALPHA * Math.min(noteA[ia], noteA[ib]);
      if (hoverNote === ia || hoverNote === ib) {
        beamAlpha += opacity * 0.16;
      } else if (planetHover) {
        beamAlpha += opacity * 0.08;
      }
      if (beamAlpha <= 0.012) continue;

      // Bow toward the planet centre: this is a local system now.
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const qx = mx + (p.x - mx) * BEAM_INTRA_BOW;
      const qy = my + (p.y - my) * BEAM_INTRA_BOW;

      ctx.globalAlpha = Math.min(1, beamAlpha);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(qx, qy, bx, by);
      ctx.stroke();
    }
  }

  private drawIntraComets(
    ctx: CanvasRenderingContext2D,
    frame: FrameState,
    opacity: number,
  ): void {
    const pi = this.focusIdx;
    if (pi < 0 || pi >= this.planetCount) return;
    const p = this.planetRecs[pi];
    if (!p.visible) return;

    const noteX = this.noteScreenX;
    const noteY = this.noteScreenY;
    const noteA = this.noteScreenA;
    const valid = this.noteScreenValid;
    const intraA = this.intraA;
    const intraB = this.intraB;
    const hoverNote = this.hoverNoteIdx;
    const hoverPlanet = this.hoverPlanetIdx;

    const from = this.intraStart[pi];
    const to = this.intraEnd[pi];
    if (from === undefined || to === undefined) return;
    const planetHover = hoverPlanet === pi;

    let drawn = 0;
    for (let k = from; k < to && drawn < COMET_MAX_FOCUS; k++) {
      const ia = intraA[k];
      const ib = intraB[k];
      if (valid[ia] === 0 || valid[ib] === 0) continue;

      const ax = noteX[ia];
      const ay = noteY[ia];
      const bx = noteX[ib];
      const by = noteY[ib];
      if (Math.hypot(bx - ax, by - ay) < 6) continue;

      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const qx = mx + (p.x - mx) * BEAM_INTRA_BOW;
      const qy = my + (p.y - my) * BEAM_INTRA_BOW;

      const phase = this.intraPhase[k];
      const speed = this.intraSpeed[k];
      if (phase === undefined || speed === undefined) continue;

      const hot = hoverNote === ia || hoverNote === ib || planetHover;
      let alpha = clamp(Math.min(noteA[ia], noteA[ib]) * (0.55 + 0.45 * opacity), 0, 0.95);
      if (hot) alpha = Math.min(1, alpha * 1.45 + 0.12);

      this.drawComet(
        ctx,
        frame.time,
        ax,
        ay,
        qx,
        qy,
        bx,
        by,
        phase,
        speed,
        alpha,
        hot,
      );
      drawn++;
    }
  }

  /**
   * Paint one comet head and its tapered tail on the quadratic guide. Only
   * scalars are used, so a frame with 160 comets allocates nothing.
   */
  private drawComet(
    ctx: CanvasRenderingContext2D,
    time: number,
    ax: number,
    ay: number,
    qx: number,
    qy: number,
    bx: number,
    by: number,
    phase: number,
    speed: number,
    alpha: number,
    hot: boolean,
  ): void {
    let t = (phase + time * speed) % 1;
    if (t < 0) t += 1;

    // Fade in/out at the endpoints instead of popping between loops.
    const envelope = smoothstep(0, 0.07, t) * smoothstep(0, 0.07, 1 - t);
    if (envelope <= 0.01 || alpha <= 0.01) return;

    const u = 1 - t;
    const hx = u * u * ax + 2 * u * t * qx + t * t * bx;
    const hy = u * u * ay + 2 * u * t * qy + t * t * by;
    const dx = 2 * u * (qx - ax) + 2 * t * (bx - qx);
    const dy = 2 * u * (qy - ay) + 2 * t * (by - qy);
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-3) return;

    const frac = clamp(
      (speed - COMET_SPEED_MIN) / (COMET_SPEED_MAX - COMET_SPEED_MIN),
      0,
      1,
    );
    const headR = lerp(COMET_HEAD_MIN, COMET_HEAD_MAX, frac) * (hot ? COMET_HOVER_SCALE : 1);
    let tailPx = lerp(COMET_TAIL_MIN, COMET_TAIL_MAX, frac);
    if (hot) tailPx = Math.min(COMET_TAIL_MAX, tailPx * 1.2);
    // Locally treat the curve as linear to convert px into parameter units.
    const dt = Math.min(t, tailPx / dl);
    const a0 = alpha * envelope;
    const halfW = headR * 0.85;

    ctx.fillStyle = COMET_TAIL_COLOR;
    for (let s = 0; s < COMET_TAIL_SEGS; s++) {
      const f0 = s / COMET_TAIL_SEGS;
      const f1 = (s + 1) / COMET_TAIL_SEGS;
      const t0 = t - dt * f0;
      const t1 = t - dt * f1;
      const w0 = halfW * (1 - f0);
      const w1 = halfW * (1 - f1);
      const u0 = 1 - t0;
      const u1 = 1 - t1;

      const x0 = u0 * u0 * ax + 2 * u0 * t0 * qx + t0 * t0 * bx;
      const y0 = u0 * u0 * ay + 2 * u0 * t0 * qy + t0 * t0 * by;
      const x1 = u1 * u1 * ax + 2 * u1 * t1 * qx + t1 * t1 * bx;
      const y1 = u1 * u1 * ay + 2 * u1 * t1 * qy + t1 * t1 * by;

      const d0x = 2 * u0 * (qx - ax) + 2 * t0 * (bx - qx);
      const d0y = 2 * u0 * (qy - ay) + 2 * t0 * (by - qy);
      const d1x = 2 * u1 * (qx - ax) + 2 * t1 * (bx - qx);
      const d1y = 2 * u1 * (qy - ay) + 2 * t1 * (by - qy);
      const l0 = Math.hypot(d0x, d0y) || 1;
      const l1 = Math.hypot(d1x, d1y) || 1;
      const n0x = -d0y / l0;
      const n0y = d0x / l0;
      const n1x = -d1y / l1;
      const n1y = d1x / l1;

      ctx.globalAlpha = clamp(a0 * (1 - f1) * 0.8, 0, 1);
      ctx.beginPath();
      ctx.moveTo(x0 + n0x * w0, y0 + n0y * w0);
      ctx.lineTo(x1 + n1x * w1, y1 + n1y * w1);
      ctx.lineTo(x1 - n1x * w1, y1 - n1y * w1);
      ctx.lineTo(x0 - n0x * w0, y0 - n0y * w0);
      ctx.closePath();
      ctx.fill();
    }

    // Soft halo, bright head, and a hot core.
    ctx.fillStyle = COMET_HEAD_COLOR;
    ctx.globalAlpha = clamp(a0 * 0.5, 0, 1);
    ctx.beginPath();
    ctx.arc(hx, hy, headR * 2.1, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = clamp(a0, 0, 1);
    ctx.beginPath();
    ctx.arc(hx, hy, headR, 0, TAU);
    ctx.fill();

    ctx.fillStyle = COMET_CORE_COLOR;
    ctx.globalAlpha = clamp(a0 * 0.95, 0, 1);
    ctx.beginPath();
    ctx.arc(hx, hy, Math.max(0.5, headR * 0.45), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* Draw order                                                       */
  /* ---------------------------------------------------------------- */

  private buildDrawOrder(): void {
    const order = this.drawOrder;
    const n = this.planetCount;
    order.length = 0;

    for (let i = 0; i < n; i++) {
      if (this.planetRecs[i].visible) order.push(i);
    }
    for (let i = 0; i < this.notes.length; i++) {
      if (this.recs[i].visible) order.push(n + i);
    }
    order.sort(this.sortDrawDepth);
  }

  /** Snap a card dimension to an even number of device pixels. */
  private snapCardSize(size: number): number {
    const dev = Math.max(2, Math.round(size * this.dpr));
    const even = dev + (dev & 1);
    return even / this.dpr;
  }

  /* ---------------------------------------------------------------- */
  /* Hit stack                                                        */
  /* ---------------------------------------------------------------- */

  private pushHit(
    kind: number,
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    occluded: boolean,
  ): void {
    const n = this.hitCount;
    if (n >= this.hitKind.length) this.growHits(n * 2 + 16);
    this.hitKind[n] = kind;
    this.hitIndex[n] = index;
    this.hitX[n] = x;
    this.hitY[n] = y;
    this.hitW[n] = w;
    this.hitH[n] = h;
    this.hitOccluded[n] = occluded ? 1 : 0;
    this.hitCount = n + 1;
  }

  private growHits(size: number): void {
    const cap = Math.max(16, size);
    const kind = new Uint8Array(cap);
    kind.set(this.hitKind);
    const index = new Int32Array(cap);
    index.set(this.hitIndex);
    const x = new Float32Array(cap);
    x.set(this.hitX);
    const y = new Float32Array(cap);
    y.set(this.hitY);
    const w = new Float32Array(cap);
    w.set(this.hitW);
    const h = new Float32Array(cap);
    h.set(this.hitH);
    const occluded = new Uint8Array(cap);
    occluded.set(this.hitOccluded);
    this.hitKind = kind;
    this.hitIndex = index;
    this.hitX = x;
    this.hitY = y;
    this.hitW = w;
    this.hitH = h;
    this.hitOccluded = occluded;
  }
}
