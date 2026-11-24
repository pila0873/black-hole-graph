import type { CameraLike, ScreenPoint, SphereProjection, Vec3 } from '../types';
import {
  clamp,
  degToRad,
  mat4,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  vlen,
} from '../util/math';

const NEAR = 0.5;
const FAR = 600;

/**
 * Orbit camera looking at the black hole at the origin.
 * Position is driven by spherical coordinates (azimuth / elevation / distance),
 * which keeps the black hole centered and the disk orientation stable.
 */
export class Camera implements CameraLike {
  readonly target: Vec3 = { x: 0, y: 0, z: 0 };
  readonly position: Vec3 = { x: 0, y: 8, z: 22 };
  up: Vec3 = { x: 0, y: 1, z: 0 };
  fovDeg = 38;
  aspect = 1;
  readonly near = NEAR;
  readonly far = FAR;

  azimuth = 0.45;
  elevation = degToRad(14);
  distance = 22;

  readonly viewProjection: Float32Array = mat4();
  readonly inverseViewProjection: Float32Array = mat4();
  readonly view: Float32Array = mat4();

  private proj: Float32Array = mat4();
  private readonly VP: Float32Array = mat4();
  private width = 1;
  private height = 1;
  private focalPx = 1;
  private refDistance = 22;
  private dirty = true;

  /** Reset to the cinematic default framing. */
  reset(settingsDistance?: number, inclinationDeg?: number): void {
    this.azimuth = 0.45;
    this.elevation = degToRad(inclinationDeg ?? 14);
    this.distance = clamp(settingsDistance ?? 22, 8, 60);
    this.dirty = true;
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.aspect = this.width / this.height;
    this.dirty = true;
  }

  /** Mouse drag, pixels. */
  orbitBy(dxPx: number, dyPx: number): void {
    this.azimuth -= dxPx * 0.006;
    this.elevation = clamp(this.elevation + dyPx * 0.006, degToRad(-75), degToRad(75));
    this.dirty = true;
  }

  /** Multiplicative zoom, e.g. 1.1 = closer. */
  dolly(factor: number): void {
    this.distance = clamp(this.distance * factor, 9, 60);
    this.dirty = true;
  }

  /** Absolute distance, used by focus transitions. */
  setDistance(distance: number): void {
    const next = clamp(distance, 6, 160);
    if (Math.abs(next - this.distance) < 1e-4) return;
    this.distance = next;
    this.dirty = true;
  }

  /** Moves the orbit centre (the camera always looks at this point). */
  setTarget(x: number, y: number, z: number): void {
    if (
      Math.abs(this.target.x - x) < 1e-4 &&
      Math.abs(this.target.y - y) < 1e-4 &&
      Math.abs(this.target.z - z) < 1e-4
    ) {
      return;
    }
    this.target.x = x;
    this.target.y = y;
    this.target.z = z;
    this.dirty = true;
  }

  setInclination(deg: number): void {
    this.elevation = degToRad(clamp(deg, -75, 75));
    this.dirty = true;
  }

  update(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;

    const ce = Math.cos(this.elevation);
    this.position.x = this.target.x + this.distance * ce * Math.sin(this.azimuth);
    this.position.y = this.target.y + this.distance * Math.sin(this.elevation);
    this.position.z = this.target.z + this.distance * ce * Math.cos(this.azimuth);

    mat4Perspective(this.proj, degToRad(this.fovDeg), this.aspect, NEAR, FAR);
    mat4LookAt(this.view, this.position, this.target, this.up);
    mat4Multiply(this.VP, this.proj, this.view);
    (this.viewProjection as Float32Array).set(this.VP);
    mat4Invert(this.inverseViewProjection as Float32Array, this.VP);

    this.focalPx = this.height / 2 / Math.tan(degToRad(this.fovDeg) / 2);
    this.refDistance = vlen({
      x: this.position.x - this.target.x,
      y: this.position.y - this.target.y,
      z: this.position.z - this.target.z,
    });
  }

  project(p: Vec3): ScreenPoint {
    return this.projectXYZ(p.x, p.y, p.z, { x: 0, y: 0, scale: 0, depth: 0, onScreen: false });
  }

  projectXYZ(x: number, y: number, z: number, out: ScreenPoint): ScreenPoint {
    this.update();
    const vp = this.VP;
    const v = this.view;

    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];

    const viewZ = v[2] * x + v[6] * y + v[10] * z + v[14];
    const depth = -viewZ;
    const inFront = depth > NEAR;
    const w = cw === 0 ? 1e-6 : cw;
    const ndcX = cx / w;
    const ndcY = cy / w;

    out.x = (ndcX * 0.5 + 0.5) * this.width;
    out.y = (1 - (ndcY * 0.5 + 0.5)) * this.height;
    out.scale = inFront ? this.refDistance / depth : 0;
    out.depth = depth;
    out.onScreen =
      inFront && ndcX > -1.6 && ndcX < 1.6 && ndcY > -1.6 && ndcY < 1.6;
    return out;
  }

  projectSphere(center: Vec3, radius: number): SphereProjection {
    const c = this.project(center);
    if (!c.onScreen && c.depth <= NEAR) {
      return { x: c.x, y: c.y, radius: 0, onScreen: false };
    }
    return {
      x: c.x,
      y: c.y,
      radius: (radius * this.focalPx) / Math.max(c.depth, NEAR),
      onScreen: c.onScreen,
    };
  }
}
