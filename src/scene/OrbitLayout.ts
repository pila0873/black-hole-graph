import type {
  GraphData,
  GraphNode,
  NoteState,
  OrbitParams,
  PlanetState,
  PluginSettings,
} from '../types';
import {
  clamp,
  degToRad,
  DISK_OUTER,
  hashString,
  lerp,
  mod,
  TAU,
} from '../util/math';

/* ------------------------------------------------------------------ */
/* Tuning constants (all lengths in r_s)                               */
/* ------------------------------------------------------------------ */

/**
 * Gap between the disk rim and the innermost planetary orbit. It has to cover
 * the whole moon system of the largest planet (radius 1.7 * MOON_RADIUS_MAX
 * 2.45 = 4.17) plus perspective shrink of the far side of the orbit, so that
 * neither planets nor moons project onto the disk silhouette from any camera
 * azimuth/elevation around the default view.
 */
const DISK_CLEARANCE = 12;
/** Inner edge of the planetary orbits around the black hole. */
const ORBIT_INNER = DISK_OUTER + DISK_CLEARANCE;
/**
 * Outer edge of the planetary orbits. The 11 r_s wide annulus guarantees that
 * many folders spread over a filled band instead of collapsing onto one ring
 * (a narrow strip on screen) and gives the camera a real 3D extent to frame.
 */
const ORBIT_OUTER = ORBIT_INNER + 11;
/** Orbit radius when there is a single planet. */
const ORBIT_SINGLE = ORBIT_INNER + 3;
/** Deterministic radial jitter of a planet orbit, ± this value. */
const ORBIT_JITTER = 1;
/** Deterministic phase jitter of a planet, ± this value (radians). */
const ORBIT_PHASE_JITTER = 0.9;
/** Keplerian constant for planets: omega = K / r^1.5 (rad/s). */
const ORBIT_SPEED_K = 1.3;

/**
 * Fixed orbital plane tilt of a planet, ± this many degrees around X.
 *
 * Kept shallow (4°) on purpose: a larger tilt makes the projected orbit ellipses
 * rotate out of the disk's projected ellipse as the camera azimuth changes, and
 * a planet can then cross the disk silhouette. 4° still gives every planet a
 * real vertical component (3D depth) and stays inside the `flatR * 0.2`
 * vertical budget the view already reserves for camera framing.
 */
const PLANET_TILT_DEG = 4;
/** Planet body radius for a folder with no notes. */
const PLANET_RADIUS_BASE = 0.7;
/** Additional radius for the biggest folder. */
const PLANET_RADIUS_GAIN = 1.0;
const PLANET_RADIUS_MIN = 0.7;
const PLANET_RADIUS_MAX = 1.7;
/** Folders with at least this many notes get a ring. */
const RING_MIN_NOTES = 12;

/** Moon orbit radius around a planet, as a multiple of the planet radius. */
const MOON_RADIUS_MIN = 1.55;
const MOON_RADIUS_MAX = 2.45;
/** Moon orbit plane inclination range, degrees (both signs). */
const MOON_INCLINATION_DEG = 35;
/** Keplerian constant for moons: omega = K / r^1.5 (rad/s). */
const MOON_SPEED_K = 0.55;
/** Vertical bobbing amplitude as a fraction of a world unit. */
const MOON_BOB_AMP = 0.12;
/** Bob angular frequency (rad/s). */
const BOB_SPEED = 0.31;
/** Deterministic phase jitter of a moon, ± this value (radians). */
const MOON_PHASE_JITTER = 0.35;
/**
 * How far a planet's moon system reaches, as a multiple of the planet body
 * radius. Used for camera framing and available to the note layer through
 * `moonExtent()`.
 */
export const MOON_EXTENT = 2.7;

/** Golden angle, used to spread planets and moons deterministically. */
const GOLDEN_ANGLE = 2.399963229728653;

/** Fade-in duration for notes that appear after the first build. */
const FADE_IN_SECONDS = 1.2;

/** Lowest value ever returned by `systemRadius`. */
const SYSTEM_RADIUS_MIN = 16;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function byPath(a: GraphNode, b: GraphNode): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Bit-rotated 32-bit hash value in [0, 1). Rotating (instead of shifting and
 * masking) keeps all four derived randoms full precision and decorrelated.
 */
function unitFromHash(hash: number, shift: number): number {
  const h = hash >>> 0;
  const s = shift & 31;
  const rotated = s === 0 ? h : ((h >>> s) | (h << (32 - s))) >>> 0;
  return rotated / 4294967296;
}

/**
 * Reduces any finite angle to [0, TAU).
 *
 * Bounding the argument of sin/cos keeps full precision for very long
 * animation times, and mapping non-finite input to 0 stops values such as
 * Infinity or NaN from ever reaching a position vector.
 */
function wrapAngle(angle: number): number {
  return Number.isFinite(angle) ? mod(angle, TAU) : 0;
}

/** Display name of a cluster key: its last path segment, 'Vault' for root. */
function planetName(key: string): string {
  if (key === '') return 'Vault';
  let end = key.length;
  while (end > 0) {
    const code = key.charCodeAt(end - 1);
    if (code !== 47 /* '/' */ && code !== 92 /* '\\' */) break;
    end--;
  }
  if (end === 0) return 'Vault';
  let cut = -1;
  for (let i = end - 1; i >= 0; i--) {
    const code = key.charCodeAt(i);
    if (code === 47 || code === 92) {
      cut = i;
      break;
    }
  }
  const name = key.slice(cut + 1, end);
  return name === '' ? 'Vault' : name;
}

/* ------------------------------------------------------------------ */

/**
 * Turns the vault graph into a two-level orbital system.
 *
 *   black hole  <-  planets (folders)
 *   planet      <-  moons (notes)
 *
 * Public contract used by the view:
 *   planets                 // stable array, mutated in place by setGraph()
 *   notes                   // stable array, mutated in place by setGraph()
 *   setGraph(data, settings)
 *   update(timeSeconds)     // mutates positions / alpha in place
 *   getPlanet(id)
 *   systemRadius            // world-space radius for camera framing
 *
 * Purely parametric: no n-body physics, no randomness at runtime, so the same
 * vault always produces the same layout. Rebuilds reuse the previous state
 * object per path, so a metadata refresh neither teleports cards nor restarts
 * their fade-in. Orbit slots are keyed by folder id (not note count) so editing
 * a note does not reshuffle every planet.
 *
 * Every planet keeps a shallow orbital-plane tilt (3D depth) while the orbit
 * annulus starts beyond the disk rim plus the largest moon system, so planets
 * and moons do not project over the disk silhouette in the default view.
 *
 * World space: origin is the black hole, +Y is up, the disk lies in XZ.
 */
export class OrbitLayout {
  /** One entry per folder (plus the implicit vault-root planet). */
  readonly planets: PlanetState[] = [];
  /** One entry per visible note. */
  readonly notes: NoteState[] = [];

  /** path -> state of the previous build, for continuity. */
  private previousNotes = new Map<string, NoteState>();
  /** cluster key -> state of the previous build, for continuity. */
  private previousPlanets = new Map<string, PlanetState>();
  /** planet id -> state, for getPlanet(). */
  private planetsById = new Map<string, PlanetState>();
  /** path -> wall-clock seconds at which the note first appeared. */
  private births = new Map<string, number>();
  /** Parallel to `notes`: index of the owning planet in `planets`. */
  private notePlanetSlot: number[] = [];
  /** Parallel to `planets`: orbital plane tilt around X (radians). */
  private planetTilt: number[] = [];
  /** Cached `get systemRadius()` value, recomputed on every build. */
  private radiusValue = SYSTEM_RADIUS_MIN;
  /** Last animation time seen, used to seed positions on rebuild. */
  private timeSec = 0;
  private currentSettings: PluginSettings | null = null;

  /** Settings from the most recent setGraph() call (read-only accessor). */
  get lastSettings(): PluginSettings | null {
    return this.currentSettings;
  }

  /** World-space bounding radius of the whole system, for camera framing. */
  get systemRadius(): number {
    return this.radiusValue;
  }

  getPlanet(id: string): PlanetState | undefined {
    return this.planetsById.get(id);
  }

  /** World-space radius of a planet's whole moon system (body + orbits). */
  moonExtent(planet: PlanetState): number {
    return planet.radius * MOON_EXTENT;
  }

  /* ---------------------------------------------------------------- */

  setGraph(data: GraphData, settings: PluginSettings): void {
    this.currentSettings = settings;

    const nowSec = OrbitLayout.nowSec();

    /* -- 1. group notes by cluster, deduplicated by path ------------ */

    const groups = new Map<string, GraphNode[]>();
    const seenPaths = new Set<string>();
    const nodes = data.nodes;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (seenPaths.has(node.path)) continue;
      seenPaths.add(node.path);

      const key = node.clusterKey;
      let list = groups.get(key);
      if (!list) {
        list = [];
        groups.set(key, list);
      }
      list.push(node);
    }

    // Stable order inside every group, so reloads look identical.
    for (const list of groups.values()) list.sort(byPath);

    /* -- 2. decide which planets exist ------------------------------ */

    // Index of a key in data.clusters; extra planets (the implicit root, or
    // stray cluster keys) are numbered from the end of that list.
    const clusterIndex = new Map<string, number>();
    for (let i = 0; i < data.clusters.length; i++) {
      const key = data.clusters[i];
      if (!clusterIndex.has(key)) clusterIndex.set(key, i);
    }

    const keys: string[] = [];
    const added = new Set<string>();

    for (let i = 0; i < data.clusters.length; i++) {
      const key = data.clusters[i];
      if (added.has(key)) continue;
      added.add(key);
      keys.push(key);
    }

    // Vault-root notes form their own planet, but only if the graph did not
    // already report '' as a cluster.
    if (groups.has('') && !added.has('')) {
      added.add('');
      keys.push('');
    }

    // Safety net: a cluster key present on nodes but missing from
    // data.clusters must still get a home, otherwise its notes would vanish.
    const orphans: string[] = [];
    for (const key of groups.keys()) {
      if (!added.has(key)) orphans.push(key);
    }
    orphans.sort();
    for (let i = 0; i < orphans.length; i++) {
      added.add(orphans[i]);
      keys.push(orphans[i]);
    }

    const countOf = (key: string): number => {
      const list = groups.get(key);
      return list ? list.length : 0;
    };

    // Orbit slots follow the folder key, not the note count: editing a note
    // must not reshuffle every planet's radius on the next rebuild. The count
    // still drives planet size and rings below.
    const sortedKeys = keys.slice();
    sortedKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let maxNoteCount = 0;
    for (let i = 0; i < sortedKeys.length; i++) {
      const count = countOf(sortedKeys[i]);
      if (count > maxNoteCount) maxNoteCount = count;
    }

    /* -- 3. build the planets --------------------------------------- */

    const planets = this.planets;
    const previousPlanets = this.previousPlanets;
    planets.length = 0;

    const nextPlanets = new Map<string, PlanetState>();
    const tilt: number[] = [];
    const n = sortedKeys.length;
    let extraIndex = data.clusters.length;

    for (let rank = 0; rank < n; rank++) {
      const key = sortedKeys[rank];
      const noteCount = countOf(key);
      const hash = hashString(key);
      const seed = hash / 4294967296;

      const radialJitter =
        (unitFromHash(hash, 0) - 0.5) * 2 * ORBIT_JITTER;
      const baseRadius =
        n === 1 ? ORBIT_SINGLE : lerp(ORBIT_INNER, ORBIT_OUTER, rank / (n - 1));
      // Clamp instead of letting the jitter push the innermost orbit back into
      // the disk rim.
      const orbitRadius = clamp(
        baseRadius + radialJitter,
        ORBIT_INNER,
        ORBIT_OUTER,
      );

      const phaseJitter =
        (unitFromHash(hash, 12) - 0.5) * 2 * ORBIT_PHASE_JITTER;
      const orbitPhase = rank * GOLDEN_ANGLE + phaseJitter;

      // Alternating sign so the system does not rotate like a rigid wheel.
      const direction = rank % 2 === 0 ? 1 : -1;
      const orbitSpeed =
        (direction * ORBIT_SPEED_K) / Math.pow(orbitRadius, 1.5);

      const sizeRatio = maxNoteCount > 0 ? noteCount / maxNoteCount : 0;
      const radius = clamp(
        PLANET_RADIUS_BASE + PLANET_RADIUS_GAIN * Math.sqrt(sizeRatio),
        PLANET_RADIUS_MIN,
        PLANET_RADIUS_MAX,
      );

      let index = clusterIndex.get(key);
      if (index === undefined) {
        index = extraIndex;
        extraIndex++;
      }

      const hasRing = noteCount >= RING_MIN_NOTES;

      const previous = previousPlanets.get(key);
      let planet: PlanetState;
      if (previous) {
        // Keep the object (and its orbitPhase) so the planet does not jump.
        previous.id = key;
        previous.name = planetName(key);
        previous.index = index;
        previous.radius = radius;
        previous.orbitRadius = orbitRadius;
        previous.orbitSpeed = orbitSpeed;
        previous.noteCount = noteCount;
        previous.hasRing = hasRing;
        previous.seed = seed;
        planet = previous;
      } else {
        planet = {
          id: key,
          name: planetName(key),
          index,
          position: { x: 0, y: 0, z: 0 },
          radius,
          orbitRadius,
          orbitPhase,
          orbitSpeed,
          noteCount,
          hasRing,
          seed,
        };
      }

      planets.push(planet);
      nextPlanets.set(key, planet);
      tilt.push(
        degToRad(lerp(-PLANET_TILT_DEG, PLANET_TILT_DEG, unitFromHash(hash, 24))),
      );
    }

    /* -- 4. build the moons (notes) --------------------------------- */

    const notes = this.notes;
    const previousNotes = this.previousNotes;
    const oldBirths = this.births;
    const births = new Map<string, number>();
    const slots: number[] = [];
    notes.length = 0;

    const nextNotes = new Map<string, NoteState>();

    for (let slot = 0; slot < planets.length; slot++) {
      const planet = planets[slot];
      const list = groups.get(planet.id);
      if (!list) continue;

      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        const hash = hashString(node.path);

        // 1.55 .. 2.45 planet radii: moons never cut through the planet body.
        const localRadius =
          planet.radius *
          lerp(MOON_RADIUS_MIN, MOON_RADIUS_MAX, unitFromHash(hash, 0));
        const angularSpeed =
          MOON_SPEED_K / Math.pow(localRadius, 1.5);

        const birth = oldBirths.get(node.path);
        births.set(node.path, birth === undefined ? nowSec : birth);

        const previous = previousNotes.get(node.path);
        let state: NoteState;
        if (previous) {
          // phase / inclination / bobAmp / bobPhase survive a rebuild.
          previous.node = node;
          previous.planetId = planet.id;
          previous.orbit.radius = localRadius;
          previous.orbit.angularSpeed = angularSpeed;
          state = previous;
        } else {
          const inclination = degToRad(
            lerp(
              -MOON_INCLINATION_DEG,
              MOON_INCLINATION_DEG,
              unitFromHash(hash, 8),
            ),
          );
          const phaseJitter =
            (unitFromHash(hash, 16) - 0.5) * 2 * MOON_PHASE_JITTER;
          const phase = mod(
            (i + 1) * GOLDEN_ANGLE + phaseJitter,
            TAU,
          );
          const orbit: OrbitParams = {
            radius: localRadius,
            inclination,
            phase,
            angularSpeed,
            bobAmp: MOON_BOB_AMP * unitFromHash(hash, 20),
            bobPhase: TAU * unitFromHash(hash, 28),
          };
          state = {
            node,
            orbit,
            planetId: planet.id,
            position: { x: 0, y: 0, z: 0 },
            alpha: 0,
          };
        }

        nextNotes.set(node.path, state);
        notes.push(state);
        slots.push(slot);
      }
    }

    /* -- 5. commit -------------------------------------------------- */

    this.previousNotes = nextNotes;
    this.previousPlanets = nextPlanets;
    this.planetsById = nextPlanets;
    this.births = births;
    this.notePlanetSlot = slots;
    this.planetTilt = tilt;

    let extent = SYSTEM_RADIUS_MIN;
    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      const e = p.orbitRadius + p.radius * MOON_EXTENT;
      if (e > extent) extent = e;
    }
    this.radiusValue = extent;

    // Seed positions immediately so nothing renders at the origin, then let
    // the fade-in start from this frame.
    for (let i = 0; i < planets.length; i++) {
      this.placePlanet(planets[i], tilt[i], this.timeSec);
    }
    for (let i = 0; i < notes.length; i++) {
      this.placeNote(notes[i], slots[i], this.timeSec, nowSec);
    }
  }

  update(timeSec: number): void {
    const t = Number.isFinite(timeSec) ? timeSec : 0;
    this.timeSec = t;

    const planets = this.planets;
    const tilt = this.planetTilt;
    for (let i = 0; i < planets.length; i++) {
      this.placePlanet(planets[i], tilt[i], t);
    }

    const notes = this.notes;
    const slots = this.notePlanetSlot;
    const nowSec = OrbitLayout.nowSec();
    for (let i = 0; i < notes.length; i++) {
      this.placeNote(notes[i], slots[i], t, nowSec);
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * Writes the world position of one planet. Allocation free: scalar math and
   * in-place field assignment only.
   */
  private placePlanet(planet: PlanetState, tilt: number, timeSec: number): void {
    const theta = wrapAngle(planet.orbitPhase + planet.orbitSpeed * timeSec);
    const orbitRadius = planet.orbitRadius;
    const planarZ = orbitRadius * Math.sin(theta);
    const sinI = Math.sin(tilt);
    const cosI = Math.cos(tilt);

    planet.position.x = orbitRadius * Math.cos(theta);
    planet.position.y = -planarZ * sinI;
    planet.position.z = planarZ * cosI;
  }

  /**
   * Writes position and alpha for one moon. Allocation free.
   *
   * Local orbit, before adding the planet position:
   *   x = r cos(phi)
   *   y = -r sin(phi) sin(inclination) + bob
   *   z =  r sin(phi) cos(inclination)
   */
  private placeNote(
    note: NoteState,
    planetSlot: number,
    timeSec: number,
    nowSec: number,
  ): void {
    const orbit = note.orbit;
    const phi = wrapAngle(orbit.phase + orbit.angularSpeed * timeSec);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const r = orbit.radius;

    const bob =
      orbit.bobAmp * Math.sin(wrapAngle(timeSec * BOB_SPEED + orbit.bobPhase));

    const localX = r * cosPhi;
    const localY = -r * sinPhi * Math.sin(orbit.inclination) + bob;
    const localZ = r * sinPhi * Math.cos(orbit.inclination);

    const planets = this.planets;
    const planet =
      planetSlot >= 0 && planetSlot < planets.length
        ? planets[planetSlot]
        : null;
    const baseX = planet ? planet.position.x : 0;
    const baseY = planet ? planet.position.y : 0;
    const baseZ = planet ? planet.position.z : 0;

    note.position.x = baseX + localX;
    note.position.y = baseY + localY;
    note.position.z = baseZ + localZ;

    note.alpha = this.alphaFor(note.node.path, nowSec);
  }

  /** Smooth 0 -> 1 fade for notes created after their first appearance. */
  private alphaFor(path: string, nowSec: number): number {
    const birth = this.births.get(path);
    if (birth === undefined) return 1;
    const t = clamp((nowSec - birth) / FADE_IN_SECONDS, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Wall clock in seconds, independent of the animation time (orbitSpeed). */
  private static nowSec(): number {
    return (
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) /
      1000
    );
  }
}
