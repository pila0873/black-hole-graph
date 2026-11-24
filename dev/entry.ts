/**
 * Standalone preview harness: renders the whole scene outside Obsidian so the
 * black hole, planets, moons and cards can be iterated on in a browser.
 *
 * Build: npm run preview:build   (writes dev/preview.js)
 * Serve: npm run preview:serve   (http://localhost:8765/preview.html)
 *
 * Query params (handy for screenshots):
 *   size=1400x820  fixed stage size
 *   freeze=1&t=40  freeze animation time
 *   dist= / el= / az=   camera overrides
 *   stars=0 / bloom=0.5 / bright=1 / temp=8500 / scale=1 / quality=fast
 */
import { Camera } from '../src/scene/Camera';
import { OrbitLayout } from '../src/scene/OrbitLayout';
import { NoteLayer } from '../src/scene/NoteLayer';
import { BlackHoleRenderer } from '../src/render/BlackHoleRenderer';
import {
  DEFAULT_SETTINGS,
  FrameState,
  GraphData,
  GraphEdge,
  GraphNode,
  PluginSettings,
} from '../src/types';
import { clamp, SHADOW_B } from '../src/util/math';

const stage = document.getElementById('stage') as HTMLElement;
const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const noteCanvas = document.getElementById('notes') as HTMLCanvasElement;

const settings: PluginSettings = { ...DEFAULT_SETTINGS };

const params = new URLSearchParams(location.search);
const frozen = params.get('freeze') === '1';
const fixedTime = Number(params.get('t') ?? '0');
const num = (key: string, fallback: number): number => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};
if (params.has('stars')) settings.showStars = params.get('stars') !== '0';
if (params.has('bloom')) settings.bloom = num('bloom', settings.bloom);
if (params.has('bright')) settings.diskBrightness = num('bright', settings.diskBrightness);
if (params.has('temp')) settings.diskTemperature = num('temp', settings.diskTemperature);
if (params.has('scale')) settings.renderScale = num('scale', settings.renderScale);
if (params.has('thick')) settings.diskThickness = num('thick', settings.diskThickness);
if (params.get('quality') === 'fast') settings.quality = 'fast';

const FOLDERS = ['Projects', 'Journal', 'Research', 'Inbox', 'Archive'];
const TITLES = [
  'Black hole',
  'Event horizon',
  'Photon sphere',
  'Accretion disk',
  'Gravitational lensing',
  'Doppler beaming',
  'Schwarzschild metric',
  'Ray tracing',
  'Orbital mechanics',
  'ISCO',
  'Interstellar',
  'Gargantua',
  'Hawking radiation',
  'Singularity',
  'Milky Way',
  'Bloom',
  'Tone mapping',
  'Render target',
  'Graph view',
  'Backlinks',
];

function makeNode(i: number): GraphNode {
  const folder = FOLDERS[i % FOLDERS.length];
  const title = `${TITLES[i % TITLES.length]} ${Math.floor(i / TITLES.length) + 1}`;
  const path = `${folder}/${title}.md`;
  return {
    id: path,
    path,
    title,
    degree: 0,
    clusterKey: folder,
    clusterIndex: FOLDERS.indexOf(folder),
  };
}

function fakeGraph(count = 55): GraphData {
  const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => makeNode(i));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string) => {
    if (a === b) return;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: a, target: b });
  };

  for (let f = 0; f < FOLDERS.length; f++) {
    const members = nodes.filter((n) => n.clusterKey === FOLDERS[f]);
    for (let i = 0; i < members.length; i++) {
      push(members[i].id, members[(i + 1) % members.length].id);
      if (members.length > 3) push(members[i].id, members[(i + 3) % members.length].id);
    }
  }

  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.35) push(nodes[i].id, nodes[Math.floor(rnd() * count)].id);
  }

  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }
  for (const n of nodes) n.degree = adjacency.get(n.id)!.length;

  const clusters = [...new Set(nodes.map((n) => n.clusterKey))];
  return { nodes, edges, adjacency, clusters, totalFiles: count };
}

let graph = fakeGraph();
const camera = new Camera();
const layout = new OrbitLayout();
const renderer = new BlackHoleRenderer(glCanvas);
const noteLayer = new NoteLayer(noteCanvas);

renderer.applySettings(settings);
noteLayer.applySettings(settings);
layout.setGraph(graph, settings);
layout.update(0);
noteLayer.setScene(layout.notes, layout.planets, graph.edges, graph.adjacency);
noteLayer.setFocus(null);
noteLayer.setBackdrop(null);

  camera.setInclination(settings.cameraInclination);

const qDist = Number(params.get('dist') ?? '');
const qEl = Number(params.get('el') ?? '');
const qAz = Number(params.get('az') ?? '');
if (Number.isFinite(qDist) && qDist > 0) camera.setDistance(qDist);
if (Number.isFinite(qEl)) camera.elevation = (qEl * Math.PI) / 180;
if (Number.isFinite(qAz)) camera.azimuth = qAz;

console.info('[preview] renderer supported:', renderer.supported);

let width = 1;
let height = 1;
let dpr = 1;

let focusId: string | null = null;
let desiredDistance = camera.distance;
let desiredTarget = { x: 0, y: 0, z: 0 };

function systemFraming(): number {
  const vHalf = (camera.fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(camera.aspect, 0.4));
  const flatR = Math.max(14, layout.systemRadius);
  const elev = Math.abs(camera.elevation);
  const vertical = flatR * Math.sin(elev) + flatR * 0.2;
  const dH = flatR / Math.tan(hHalf);
  const dV = vertical / Math.tan(vHalf);
  return clamp(Math.max(dH, dV) * 0.95, 24, 100);
}

function resize(): void {
  width = Math.max(1, stage.clientWidth);
  height = Math.max(1, stage.clientHeight);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  camera.setViewport(width, height);
  renderer.resize(width, height, dpr);
  noteLayer.resize(width, height, dpr);
  if (focusId === null) desiredDistance = systemFraming();
}

new ResizeObserver(resize).observe(stage);
resize();
desiredDistance = systemFraming();
camera.setDistance(desiredDistance);

let hovered: string | null = null;
let dragging = false;
let dragDistance = 0;
let pointer = { x: 0, y: 0 };

function localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = stage.getBoundingClientRect();
  const sx = rect.width > 0 ? stage.clientWidth / rect.width : 1;
  const sy = rect.height > 0 ? stage.clientHeight / rect.height : 1;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function focusPlanet(id: string | null): void {
  focusId = id;
  noteLayer.setFocus(id);
  if (id === null) {
    desiredTarget = { x: 0, y: 0, z: 0 };
    desiredDistance = systemFraming();
    return;
  }
  const planet = layout.getPlanet(id);
  if (!planet) return;
  desiredTarget = { x: planet.position.x, y: planet.position.y, z: planet.position.z };
  desiredDistance = Math.max(3.5, planet.radius * 13);
}

stage.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragDistance = 0;
  pointer = localPoint(e);
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  const pos = localPoint(e);
  if (dragging) {
    const dx = pos.x - pointer.x;
    const dy = pos.y - pointer.y;
    pointer = pos;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    if (dragDistance > 3) camera.orbitBy(dx, dy);
    return;
  }
  pointer = pos;
  const hit = noteLayer.hitTest(pos.x, pos.y);
  const next = hit ? hit.id : null;
  if (next !== hovered) {
    hovered = next;
    noteLayer.setHovered(next);
    document.body.style.cursor = next ? 'pointer' : 'default';
  }
});

stage.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (dragDistance > 3) return;
  const pos = localPoint(e);
  const hit = noteLayer.hitTest(pos.x, pos.y);
  if (!hit) {
    focusPlanet(null);
    return;
  }
  if (hit.kind === 'planet') {
    focusPlanet(hit.id);
  } else {
    console.info('[preview] open note:', hit.id);
  }
});

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.dolly(Math.exp(e.deltaY * 0.0012));
    desiredDistance = camera.distance;
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    focusPlanet(null);
    camera.reset(22, settings.cameraInclination);
    desiredDistance = systemFraming();
  }
  if (e.key === 'f' || e.key === 'F') {
    settings.quality = settings.quality === 'fast' ? 'cinematic' : 'fast';
    renderer.applySettings(settings);
  }
  if (e.key === 'n' || e.key === 'N') {
    graph = fakeGraph(30 + Math.floor(Math.random() * 70));
    layout.setGraph(graph, settings);
    layout.update(0);
    noteLayer.setScene(layout.notes, layout.planets, graph.edges, graph.adjacency);
    focusPlanet(null);
  }
  if (e.key === 'Escape') focusPlanet(null);
});

let last = 0;
let elapsed = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const rawDt = last === 0 ? 1 / 60 : (now - last) / 1000;
  last = now;
  const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
  if (!frozen) {
    elapsed += dt;
  } else {
    elapsed = fixedTime;
  }

  if (focusId !== null) {
    const planet = layout.getPlanet(focusId);
    if (planet) {
      desiredTarget = {
        x: planet.position.x,
        y: planet.position.y,
        z: planet.position.z,
      };
    }
  }

  const k = 1 - Math.exp(-dt * 4.6);
  camera.setDistance(camera.distance + (desiredDistance - camera.distance) * k);
  const t = camera.target;
  camera.setTarget(
    t.x + (desiredTarget.x - t.x) * k,
    t.y + (desiredTarget.y - t.y) * k,
    t.z + (desiredTarget.z - t.z) * k,
  );

  camera.update();
  layout.update(elapsed * settings.orbitSpeed);

  const sphere = camera.projectSphere({ x: 0, y: 0, z: 0 }, SHADOW_B);
  const state: FrameState = {
    time: elapsed,
    dt,
    width,
    height,
    devicePixelRatio: dpr,
    camera,
    shadowCenter: { x: sphere.x, y: sphere.y },
    shadowRadius: sphere.radius,
    focusPlanetId: focusId,
  };

  renderer.render(state);
  noteLayer.render(state);
}

requestAnimationFrame(frame);

/* Dev-only debug hooks used by the browser harness/QA scripts. */
(window as unknown as { __bh: Record<string, unknown> }).__bh = {
  hitTest: (x: number, y: number) => noteLayer.hitTest(x, y),
  focusPlanet,
  camera,
  layout,
  settings,
};
