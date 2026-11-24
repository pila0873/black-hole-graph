import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type BlackHoleGraphPlugin from '../main';
import { Camera } from '../scene/Camera';
import { OrbitLayout } from '../scene/OrbitLayout';
import { NoteLayer } from '../scene/NoteLayer';
import { BlackHoleRenderer } from '../render/BlackHoleRenderer';
import { VaultGraph } from '../graph/VaultGraph';
import { emptyGraph, FrameState, GraphData } from '../types';
import { clamp, SHADOW_B } from '../util/math';

export const VIEW_TYPE_BLACK_HOLE = 'black-hole-graph-view';

/** Camera framing for the different focus modes. */
type Focus = { kind: 'system' } | { kind: 'blackhole' } | { kind: 'planet'; id: string };

/** How far a planet fills the frame when it is opened. */
const PLANET_ZOOM = 13;
/** Close-up distance for the black hole itself. */
const BLACKHOLE_ZOOM = 11;
/** Smoothing rate of the focus transition (1/s). */
const FOCUS_EASE = 4.6;

export class BlackHoleView extends ItemView {
  private root!: HTMLElement;
  private glCanvas!: HTMLCanvasElement;
  private noteCanvas!: HTMLCanvasElement;

  private renderer!: BlackHoleRenderer;
  private noteLayer!: NoteLayer;
  private camera = new Camera();
  private layout = new OrbitLayout();
  private graphEngine!: VaultGraph;
  private graph: GraphData = emptyGraph();

  private unsubscribe: (() => void) | null = null;
  private raf = 0;
  private lastDraw = 0;
  private elapsed = 0;
  private visible = true;
  private hovered: string | null = null;

  private focus: Focus = { kind: 'system' };
  private desiredTarget = { x: 0, y: 0, z: 0 };
  private desiredDistance = 40;

  private dragging = false;
  private dragDistance = 0;
  private pointer = { x: 0, y: 0 };
  private lastInteraction = 0;

  private width = 1;
  private height = 1;
  private dpr = 1;

  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private rebuildTimer: number | null = null;
  private frameState: FrameState | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: BlackHoleGraphPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BLACK_HOLE;
  }

  getDisplayText(): string {
    return 'Black hole';
  }

  getIcon(): string {
    return 'orbit';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('black-hole-view');

    this.glCanvas = root.createEl('canvas', { cls: 'bh-canvas bh-gl' });
    this.noteCanvas = root.createEl('canvas', { cls: 'bh-canvas bh-notes' });
    this.root = root;

    this.renderer = new BlackHoleRenderer(this.glCanvas);
    this.noteLayer = new NoteLayer(this.noteCanvas);

    this.graphEngine = new VaultGraph(this.app);
    this.unsubscribe = this.graphEngine.onChange(() => this.scheduleRebuild());

    this.registerDomEvent(this.root, 'pointerdown', this.onPointerDown);
    this.registerDomEvent(this.root, 'pointermove', this.onPointerMove);
    this.registerDomEvent(this.root, 'pointerup', this.onPointerUp);
    this.registerDomEvent(this.root, 'pointercancel', this.onPointerUp);
    this.registerDomEvent(this.root, 'pointerleave', this.onPointerLeave);
    this.registerDomEvent(this.root, 'wheel', this.onWheel, { passive: false });
    this.registerDomEvent(this.root, 'contextmenu', (evt) => {
      if (this.dragging || this.dragDistance > 0) evt.preventDefault();
    });
    this.registerDomEvent(window, 'keydown', this.onKeyDown);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);

    this.registerDomEvent(window, 'blur', () => this.root.addClass('is-blurred'));
    this.registerDomEvent(window, 'focus', () => this.root.removeClass('is-blurred'));

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0 },
    );
    this.intersectionObserver.observe(this.root);

    this.applySettings();
    this.rebuild();
    this.resize();

    this.camera.setDistance(this.desiredDistance);
    this.camera.setTarget(0, 0, 0);
    this.camera.setInclination(this.plugin.settings.cameraInclination);

    this.raf = window.requestAnimationFrame(this.loop);
  }

  async onClose(): Promise<void> {
    window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.graphEngine?.dispose();
    this.renderer?.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Public API used by the plugin                                      */
  /* ---------------------------------------------------------------- */

  applySettings(): void {
    const s = this.plugin.settings;
    this.renderer?.applySettings(s);
    this.noteLayer?.applySettings(s);
    this.camera.setInclination(s.cameraInclination);
    if (this.root) {
      this.root.toggleClass('bh-dim-on-blur', s.dimOnBlur);
      this.resize();
      this.scheduleRebuild();
      this.updateDesiredFraming(false);
    }
  }

  resetCamera(): void {
    this.setFocusSystem();
  }

  /* ---------------------------------------------------------------- */
  /* Scene                                                             */
  /* ---------------------------------------------------------------- */

  private resize(): void {
    if (!this.root) return;
    const w = Math.max(1, Math.round(this.root.clientWidth));
    const h = Math.max(1, Math.round(this.root.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.camera.setViewport(w, h);
    this.renderer?.resize(w, h, dpr);
    this.noteLayer?.resize(w, h, dpr);
    this.updateDesiredFraming(false);
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 400);
  }

  private rebuild(): void {
    if (!this.graphEngine) return;
    const s = this.plugin.settings;
    this.graph = this.graphEngine.build(s);
    this.layout.setGraph(this.graph, s);

    // Restore a stable scene, then drop a focus that no longer exists.
    this.layout.update(this.elapsed * s.orbitSpeed);
    this.noteLayer.setScene(
      this.layout.notes,
      this.layout.planets,
      this.graph.edges,
      this.graph.adjacency,
    );

    if (this.focus.kind === 'planet' && !this.layout.getPlanet(this.focus.id)) {
      this.focus = { kind: 'system' };
      this.noteLayer.setFocus(null);
    }
    this.updateDesiredFraming(false);
  }

  private updateDesiredFraming(snap: boolean): void {
    const vHalf = (this.camera.fovDeg * Math.PI) / 360;

    if (this.focus.kind === 'planet') {
      const planet = this.layout.getPlanet(this.focus.id);
      if (planet) {
        this.desiredTarget = { x: planet.position.x, y: planet.position.y, z: planet.position.z };
        this.desiredDistance = Math.max(3.5, planet.radius * PLANET_ZOOM);
      }
    } else if (this.focus.kind === 'blackhole') {
      this.desiredTarget = { x: 0, y: 0, z: 0 };
      this.desiredDistance = BLACKHOLE_ZOOM;
    } else {
      // The system is a flat disk, so the horizontal extent binds first; the
      // vertical term only matters when the camera looks almost edge-on.
      const flatR = Math.max(14, this.layout.systemRadius);
      const hHalf = Math.atan(Math.tan(vHalf) * Math.max(this.camera.aspect, 0.4));
      const elev = Math.abs(this.camera.elevation);
      const vertical = flatR * Math.sin(elev) + flatR * 0.2;
      const dH = flatR / Math.tan(hHalf);
      const dV = vertical / Math.tan(vHalf);
      this.desiredTarget = { x: 0, y: 0, z: 0 };
      this.desiredDistance = clamp(Math.max(dH, dV) * 0.95, 24, 100);
    }

    if (snap) {
      this.camera.setDistance(this.desiredDistance);
      this.camera.setTarget(this.desiredTarget.x, this.desiredTarget.y, this.desiredTarget.z);
    }
  }

  private setFocusSystem(): void {
    this.focus = { kind: 'system' };
    this.noteLayer.setFocus(null);
    this.lastInteraction = this.elapsed;
    this.updateDesiredFraming(false);
  }

  private setFocusBlackHole(): void {
    this.focus = { kind: 'blackhole' };
    this.noteLayer.setFocus(null);
    this.lastInteraction = this.elapsed;
    this.updateDesiredFraming(false);
  }

  private setFocusPlanet(id: string): void {
    const planet = this.layout.getPlanet(id);
    if (!planet) return;
    this.focus = { kind: 'planet', id };
    this.noteLayer.setFocus(id);
    this.lastInteraction = this.elapsed;
    this.updateDesiredFraming(false);
  }

  /* ---------------------------------------------------------------- */
  /* Frame loop                                                        */
  /* ---------------------------------------------------------------- */

  private loop = (now: number): void => {
    this.raf = window.requestAnimationFrame(this.loop);

    if (!this.visible || document.hidden) {
      this.lastDraw = now;
      return;
    }

    const s = this.plugin.settings;
    const minDelta = 1000 / Math.max(15, s.maxFps);
    if (now - this.lastDraw < minDelta - 0.5) return;

    const rawDt = this.lastDraw === 0 ? 1 / 60 : (now - this.lastDraw) / 1000;
    this.lastDraw = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);

    this.elapsed += dt;

    // Follow a moving planet, otherwise drift slowly for parallax.
    if (this.focus.kind === 'planet') {
      const planet = this.layout.getPlanet(this.focus.id);
      if (planet) {
        this.desiredTarget = { x: planet.position.x, y: planet.position.y, z: planet.position.z };
      }
    }
    if (!this.dragging && this.elapsed - this.lastInteraction > 4) {
      this.camera.orbitBy(-6.5 * dt, 0);
    }

    this.applyFocusEase(dt);

    this.camera.update();
    this.layout.update(this.elapsed * s.orbitSpeed);

    const sphere = this.camera.projectSphere({ x: 0, y: 0, z: 0 }, SHADOW_B);
    const frame: FrameState = {
      time: this.elapsed,
      dt,
      width: this.width,
      height: this.height,
      devicePixelRatio: this.dpr,
      camera: this.camera,
      shadowCenter: { x: sphere.x, y: sphere.y },
      shadowRadius: sphere.radius,
      focusPlanetId: this.focus.kind === 'planet' ? this.focus.id : null,
    };
    this.frameState = frame;

    this.renderer.render(frame);
    this.noteLayer.render(frame);
  };

  private applyFocusEase(dt: number): void {
    const k = 1 - Math.exp(-dt * FOCUS_EASE);
    const d = this.camera.distance;
    if (Math.abs(this.desiredDistance - d) > 0.01) {
      this.camera.setDistance(d + (this.desiredDistance - d) * k);
    }
    const t = this.camera.target;
    const dx = this.desiredTarget.x - t.x;
    const dy = this.desiredTarget.y - t.y;
    const dz = this.desiredTarget.z - t.z;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0.01) {
      this.camera.setTarget(t.x + dx * k, t.y + dy * k, t.z + dz * k);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  private localPos(evt: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  private onPointerDown = (evt: PointerEvent): void => {
    if (evt.button !== 0) return;
    this.dragging = true;
    this.dragDistance = 0;
    this.pointer = this.localPos(evt);
    this.lastInteraction = this.elapsed;
    this.root.setPointerCapture(evt.pointerId);
    this.root.addClass('is-dragging');
  };

  private onPointerMove = (evt: PointerEvent): void => {
    const pos = this.localPos(evt);

    if (this.dragging) {
      const dx = pos.x - this.pointer.x;
      const dy = pos.y - this.pointer.y;
      this.pointer = pos;
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
      if (this.dragDistance > 3) {
        this.camera.orbitBy(dx, dy);
        if (this.hovered) {
          this.hovered = null;
          this.noteLayer.setHovered(null);
        }
      }
      return;
    }

    this.pointer = pos;
    const hit = this.noteLayer.hitTest(pos.x, pos.y);
    const next = hit ? hit.id : null;
    if (next !== this.hovered) {
      this.hovered = next;
      this.noteLayer.setHovered(next);
      this.root.toggleClass('is-hovering-note', next !== null);
    }
  };

  private onPointerUp = (evt: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.root.removeClass('is-dragging');
    if (this.root.hasPointerCapture(evt.pointerId)) {
      this.root.releasePointerCapture(evt.pointerId);
    }

    if (this.dragDistance > 3) return;

    const pos = this.localPos(evt);
    const hit = this.noteLayer.hitTest(pos.x, pos.y);

    if (hit) {
      if (hit.kind === 'planet') {
        this.setFocusPlanet(hit.id);
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(hit.id);
      if (file instanceof TFile) {
        const newLeaf = evt.metaKey || evt.ctrlKey || evt.button === 1;
        void this.app.workspace.getLeaf(newLeaf ? 'tab' : false).openFile(file);
      }
      return;
    }

    // Empty space: clicking the shadow dives into the black hole, anything
    // else walks back to the system view.
    const sphere = this.camera.projectSphere({ x: 0, y: 0, z: 0 }, SHADOW_B);
    const d = Math.hypot(pos.x - sphere.x, pos.y - sphere.y);
    if (d < sphere.radius * 1.25) {
      this.setFocusBlackHole();
    } else {
      this.setFocusSystem();
    }
  };

  private onPointerLeave = (): void => {
    if (this.hovered) {
      this.hovered = null;
      this.noteLayer.setHovered(null);
      this.root.removeClass('is-hovering-note');
    }
  };

  private onWheel = (evt: WheelEvent): void => {
    evt.preventDefault();
    evt.stopPropagation();
    this.lastInteraction = this.elapsed;
    this.camera.dolly(Math.exp(evt.deltaY * 0.0012));
    this.desiredDistance = this.camera.distance;
  };

  private onKeyDown = (evt: KeyboardEvent): void => {
    if (evt.key === 'Escape') {
      this.setFocusSystem();
    }
  };
}
