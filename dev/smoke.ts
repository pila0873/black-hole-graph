/**
 * Headless sanity checks for the camera/projection math (no DOM needed).
 * Build + run: npm run smoke
 */
import { Camera } from '../src/scene/Camera';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? '');
  }
}

const W = 1600;
const H = 800;
const cam = new Camera();
cam.setViewport(W, H);
cam.reset(22, 14);
cam.update();

const origin = cam.project({ x: 0, y: 0, z: 0 });
check(
  'origin projects to viewport center',
  Math.abs(origin.x - W / 2) < 0.5 && Math.abs(origin.y - H / 2) < 0.5,
  origin,
);

const sphere = cam.projectSphere({ x: 0, y: 0, z: 0 }, 2.598);
const focal = H / 2 / Math.tan((38 * Math.PI) / 180 / 2);
check('shadow radius matches pinhole math', Math.abs(sphere.radius - (focal * 2.598) / 22) < 1, sphere);
check('shadow is a plausible size', sphere.radius > 80 && sphere.radius < 220, sphere.radius);

const right = cam.project({ x: 5, y: 0, z: 0 });
const left = cam.project({ x: -5, y: 0, z: 0 });
check('+x is right of center', right.x > origin.x, right);
check('-x is left of center', left.x < origin.x, left);

const up = cam.project({ x: 0, y: 5, z: 0 });
check('+y is above center on screen', up.y < origin.y, up);

const nearPoint = cam.project({ x: 0, y: 0, z: 8 });
const farPoint = cam.project({ x: 0, y: 0, z: -8 });
check('nearer point has larger scale', nearPoint.scale > farPoint.scale, [nearPoint, farPoint]);

const behind = cam.project({ x: 0, y: 0, z: 40 });
check('point behind camera is not on screen', !behind.onScreen, behind);

const vp = cam.viewProjection;
const inv = cam.inverseViewProjection;
let identityOk = true;
for (let i = 0; i < 4; i++) {
  for (let j = 0; j < 4; j++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += vp[k * 4 + j] * inv[i * 4 + k];
    const expected = i === j ? 1 : 0;
    if (Math.abs(sum - expected) > 1e-3) identityOk = false;
  }
}
check('viewProjection * inverse ≈ identity', identityOk);

// Orbiting must keep the target centered and the distance constant.
const before = cam.project({ x: 0, y: 0, z: 0 });
cam.orbitBy(120, 40);
cam.update();
const after = cam.project({ x: 0, y: 0, z: 0 });
check(
  'orbit keeps the black hole centered',
  Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5,
  [before, after],
);
check('orbit changes azimuth', Math.abs(cam.azimuth - 0.45) > 0.1, cam.azimuth);

console.log(failures === 0 ? '\nall camera checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
