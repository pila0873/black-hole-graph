/**
 * Shared contracts between the plugin layers.
 *
 * World space conventions (IMPORTANT, do not change without updating all modules):
 *  - Units: Schwarzschild radius r_s = 1. Camera distance is expressed in r_s.
 *  - Origin is the black hole center.
 *  - The accretion disk lies in the XZ plane (normal = +Y).
 *  - Camera up vector is +Y.
 *
 * Scene structure (v2):
 *  - Folders become PLANETS orbiting the black hole.
 *  - Notes become MOONS orbiting their own planet.
 *  - The camera focuses either on the black hole (system view) or on one planet.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Quality = 'cinematic' | 'fast';

export interface PluginSettings {
  /** 'cinematic' = full geodesic ray tracing, 'fast' = cheaper approximation. */
  quality: Quality;
  /** WebGL render target scale relative to CSS pixels (0.5 .. 1.5). */
  renderScale: number;
  /** Frame cap: 30 or 60. */
  maxFps: number;
  /** FXAA on the final composite. */
  antiAliasing: boolean;
  /** Enable gravitational lensing of the background. */
  lensing: boolean;
  /** Peak disk temperature in Kelvin at the inner edge. */
  diskTemperature: number;
  /** Disk emission multiplier (0 .. 2). */
  diskBrightness: number;
  /** Vertical thickness of the disk, 0.3 (razor thin) .. 2.5 (puffy). */
  diskThickness: number;
  /** Bloom strength (0 .. 1.5). */
  bloom: number;
  /** Render the procedural star field. */
  showStars: boolean;
  /** ASCII galaxies scattered on the black backdrop. */
  showGalaxies: boolean;
  /** Folder names above the planets. */
  showPlanetLabels: boolean;
  /** Camera elevation above the disk plane, degrees. */
  cameraInclination: number;
  /** Orbital animation speed multiplier. */
  orbitSpeed: number;
  /** Draw link lines between notes/planets. */
  showEdges: boolean;
  /** Link line opacity (0 .. 1). */
  edgeOpacity: number;
  /** Maximum number of notes in the scene. */
  maxNotes: number;
  /** Only notes that have at least one link. */
  onlyLinked: boolean;
  /** Folder prefixes to exclude. */
  excludedFolders: string[];
  /** Draw note titles (only when a planet is in focus). */
  showTitles: boolean;
  /** Dim the whole scene when the window is not focused. */
  dimOnBlur: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  quality: 'cinematic',
  renderScale: 1,
  maxFps: 60,
  antiAliasing: true,
  lensing: true,
  diskTemperature: 8500,
  diskBrightness: 1,
  diskThickness: 0.72,
  bloom: 0.32,
  showStars: true,
  showGalaxies: true,
  showPlanetLabels: true,
  cameraInclination: 28,
  orbitSpeed: 1,
  showEdges: true,
  edgeOpacity: 0.55,
  maxNotes: 180,
  onlyLinked: false,
  excludedFolders: [],
  showTitles: true,
  dimOnBlur: true,
};

/* ------------------------------------------------------------------ */
/* Graph data                                                          */
/* ------------------------------------------------------------------ */

export interface GraphNode {
  /** Unique id, equals the vault path. */
  id: string;
  path: string;
  title: string;
  /** in + out degree. */
  degree: number;
  /** Folder key used for visual clustering, '' for vault root. */
  clusterKey: string;
  /** Index into GraphData.clusters. -1 if unclustered. */
  clusterIndex: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** node id -> neighbour ids (undirected, deduplicated). */
  adjacency: Map<string, string[]>;
  /** Ordered cluster keys, e.g. folder paths. */
  clusters: string[];
  /** Total number of markdown files in the vault before filtering. */
  totalFiles: number;
}

export function emptyGraph(): GraphData {
  return {
    nodes: [],
    edges: [],
    adjacency: new Map(),
    clusters: [],
    totalFiles: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

/** A folder rendered as a planet. */
export interface PlanetState {
  /** Equals the cluster key (folder path), '' for the vault root. */
  id: string;
  /** Display label: the folder name, or 'Vault' for the root. */
  name: string;
  /** Stable 0-based index, drives the palette and label placement. */
  index: number;
  /** World position, MUTATED IN PLACE by OrbitLayout.update(). */
  position: Vec3;
  /** Visual radius in r_s (planet body, not the moon system). */
  radius: number;
  /** Distance of the planet's own orbit from the black hole. */
  orbitRadius: number;
  orbitPhase: number;
  /** rad/s around the black hole. */
  orbitSpeed: number;
  noteCount: number;
  /** Big folders get a thin ring. */
  hasRing: boolean;
  /** Deterministic 0..1 hash, for shading variance. */
  seed: number;
}

/** Local orbit of a note around its planet. */
export interface OrbitParams {
  /** Orbit radius around the planet, in r_s. */
  radius: number;
  /** Orbit plane tilt in radians. */
  inclination: number;
  /** Initial phase in radians. */
  phase: number;
  /** Angular speed in rad/s. */
  angularSpeed: number;
  bobAmp: number;
  bobPhase: number;
}

export interface NoteState {
  node: GraphNode;
  orbit: OrbitParams;
  /** Folder/planet this note belongs to (PlanetState.id). */
  planetId: string;
  /** Current world position, MUTATED IN PLACE by OrbitLayout.update(). */
  position: Vec3;
  /** Current opacity multiplier 0..1. */
  alpha: number;
}

export interface ScreenPoint {
  /** Screen position in CSS pixels. */
  x: number;
  y: number;
  /** Relative size multiplier: 1 at the orbit reference distance. */
  scale: number;
  /** Positive distance from the camera along the view axis. */
  depth: number;
  /** False when the point is behind the camera or outside the frustum. */
  onScreen: boolean;
}

export interface SphereProjection {
  x: number;
  y: number;
  /** Apparent radius in CSS pixels. */
  radius: number;
  onScreen: boolean;
}

export interface CameraLike {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fovDeg: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  /** Column-major 4x4. */
  readonly viewProjection: Float32Array;
  /** Column-major 4x4. */
  readonly inverseViewProjection: Float32Array;
  /** Column-major 4x4 view matrix. */
  readonly view: Float32Array;
  /** Distance from the camera to its target. */
  readonly distance: number;
  project(p: Vec3): ScreenPoint;
  /** Allocation-free project for hot loops; writes into `out` and returns it. */
  projectXYZ(x: number, y: number, z: number, out: ScreenPoint): ScreenPoint;
  projectSphere(center: Vec3, radius: number): SphereProjection;
}

export interface FrameState {
  /** Seconds since view creation. */
  time: number;
  /** Clamped delta seconds since the previous frame. */
  dt: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  devicePixelRatio: number;
  camera: CameraLike;
  /** Projected center of the black hole shadow, CSS px. */
  shadowCenter: Vec2;
  /** Projected apparent radius of the shadow (b = 2.598 r_s), CSS px. */
  shadowRadius: number;
  /** Planet the camera is currently zoomed into, or null for the system view. */
  focusPlanetId: string | null;
}

/* ------------------------------------------------------------------ */
/* Renderer + note layer contracts                                     */
/* ------------------------------------------------------------------ */

export interface BaseRenderer {
  /** False when WebGL2 is unavailable and the renderer fell back to 2D. */
  readonly supported: boolean;
  resize(width: number, height: number, dpr: number): void;
  applySettings(settings: PluginSettings): void;
  render(frame: FrameState): void;
  dispose(): void;
}

export type HitKind = 'note' | 'planet';

export interface HitRegion {
  kind: HitKind;
  /** Note path for 'note', planet id (cluster key) for 'planet'. */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BaseNoteLayer {
  resize(width: number, height: number, dpr: number): void;
  /** Called when the graph or layout changes, not every frame. */
  setScene(
    notes: readonly NoteState[],
    planets: readonly PlanetState[],
    edges: readonly GraphEdge[],
    adjacency: ReadonlyMap<string, readonly string[]>,
  ): void;
  /** Planet the camera is zoomed into (null = system view). */
  setFocus(planetId: string | null): void;
  /**
   * Optional pass drawn on the cleared canvas before the planets and cards.
   * Used for the ASCII backdrop: it must sit behind the scene but in front of
   * the WebGL layer.
   */
  setBackdrop(draw: ((ctx: CanvasRenderingContext2D, frame: FrameState) => void) | null): void;
  setHovered(id: string | null): void;
  setSelected(id: string | null): void;
  applySettings(settings: PluginSettings): void;
  render(frame: FrameState): void;
  /** Hit test in CSS pixels, returns the topmost object under the pointer. */
  hitTest(x: number, y: number): HitRegion | null;
}
