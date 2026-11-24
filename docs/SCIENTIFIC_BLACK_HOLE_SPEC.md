# Техническое задание: научно правдоподобная чёрная дыра

## Цель

Сделать Obsidian-view, который визуально и математически правдоподобно показывает
чёрную дыру Шварцшильда, аккреционный диск и иерархический граф заметок.
Приоритет: корректная геометрия света, читаемая плазма, чёрный фон и стабильное
изображение без дрожания.

---

## 1. Физическая модель

Использовать геометрические единицы `G = c = 1`, Schwarzschild radius `r_s = 1`,
масса `M = 0.5`.

Обязательные радиусы:

- event horizon: `r_h = 1`
- photon sphere: `r_ph = 1.5`
- apparent shadow radius: `b_shadow = 3√3 M = 2.598`
- ISCO for a non-rotating black hole: `r_ISCO = 6M = 3`
- disk outer radius: 9–11, adjustable only inside source constants

Ray tracing:

```
u = 1/r
u'' + u = 3 M u²
```

Use RK4 with adaptive `dphi`. Never replace the geodesic with a hand-drawn circle.
A ray must terminate as one of:

1. captured by horizon;
2. intersects/emits through the disk;
3. escapes to the background.

The apparent black shadow must be measured against `2.598` and remain within ±3%
in cinematic mode.

---

## 2. Accretion disk and plasma

The disk is not a uniformly glowing thick cylinder.

Use a stratified emissive slab:

```
h(r) = thickness * (0.012 + 0.030r)
verticalDensity = exp(-(y/h)^2)
radialDensity = smooth inner edge * smooth outer edge
```

Required visual properties:

- face-on: a thin, bright, structured disk;
- edge-on: a narrow luminous band with a soft corona, never a giant horizontal white bar;
- the side view must retain visible plasma filaments, not disappear entirely;
- brightness is energy-conserving: increasing thickness must not linearly multiply total brightness;
- cap optical depth per ray to prevent overexposure;
- Doppler beaming is strongest near ISCO only and fades rapidly outward;
- use `T(r) ∝ r^-0.75`, gravitational redshift `sqrt(1 - 1/r)`, Keplerian shear
  `Omega ∝ r^-1.5`;
- show plasma through animated fBm/value noise, radial filaments, differential rotation
  and 2–3 compact hotspots orbiting with different angular velocities;
- use warm red/orange outer plasma and white/blue inner plasma through a blackbody LUT;
- bloom is subtle and never allowed to erase ring structure;
- default thickness should be 0.6–0.8, default camera elevation 25–30 degrees.

Do not add jets, explosions or rare events yet.

---

## 3. Black hole visibility and occlusion

Planets and their moons must never cover the black hole disk in system view.

Required draw/occlusion order:

1. WebGL black-hole scene;
2. distant background stars/galaxies;
3. planet orbit tracks and inter-planet beams;
4. planets and moons, but hide or fade any planet/moon whose projected geometry
   overlaps the shadow/disk area while it is behind the black hole;
5. labels.

In system view, planets must be arranged on orbits/planes that do not place their
projected centers over the disk by default. If a physical orbit passes behind the
black hole, apply depth-correct occlusion rather than painting the planet over the disk.

---

## 4. Planets, folders and notes

- Folder = planet.
- Note = moon orbiting its folder planet.
- System view: show planet sphere + folder label; notes are small dots only.
- Focus view: clicking a planet smoothly moves camera to it; only then show note cards.
- Planet label is the folder name; note labels are hidden outside focus.
- Focus animation must be smooth and deterministic.
- Use planet extent for camera framing; do not let the system collapse into a narrow strip.
- Cards use pixel snapping and stable layout. No subpixel text jitter at low orbital speed.
- Planet/moon draw order is depth-correct.

---

## 5. Connections

Connections must be neutral, restrained and readable:

- cool grey, not orange;
- dashed beams: `[3, 6]`, 1 px, low alpha;
- links inside one planet are local curved arcs and shown only in focus view;
- links between planets are aggregated to one beam per planet pair;
- no dozens of long straight lines crossing the black hole;
- hovered planet/note may brighten only related beams.

---

## 6. Background and image quality

Background is **pure black**. No nebula gradient, Milky Way texture or coloured fog.

Use two independent layers:

1. full-resolution crisp stars and optional tiny ASCII galaxies in 2D;
2. sparse procedural stars near the black hole only, where gravitational lensing is
   visually useful.

Do not blur the entire background. Do not render the background through the quarter-
resolution bloom chain. If a static image is proposed, it must be optional: it may
serve as a high-resolution star atlas, but must not replace the ray-traced shadow
or create a flat texture pasted behind the hole.

Quality requirements:

- render scale 1.0 default, optional 1.25/1.5 supersampling;
- FXAA or equivalent final pass;
- no accidental bilinear upscaling at renderScale 1;
- transparent/black pixels must remain black after tone mapping;
- target 60 FPS on a desktop GPU, 30 FPS fallback;
- no shader compile errors and no per-frame object churn in hot loops.

---

## 7. Acceptance tests

1. `npm run build` passes with zero TypeScript errors.
2. WebGL shader console is clean in the browser preview.
3. Shadow radius in cinematic mode is within ±3% of 2.598 in world projection.
4. With `diskThickness = 0.6`, side view has a narrow plasma band, not a white bar.
5. With `diskThickness = 1.5`, disk is visibly volumetric but remains bounded.
6. Planets do not paint over the shadow/disk when behind it.
7. System view shows folder labels only; note titles appear after clicking a planet.
8. Connections are grey dashed beams and are aggregated between planets.
9. 60 seconds of animation shows no label jitter or exploding positions.
10. `renderScale = 1` produces no extra low-resolution background blur.

## Files/ownership

- `src/render/**`: physical renderer, disk, stars, FXAA.
- `src/scene/OrbitLayout.ts`: planets/moons and deterministic positions.
- `src/scene/NoteLayer.ts`: occlusion, LOD, labels and connections.
- `src/view/BlackHoleView.ts`: focus/camera integration only.
