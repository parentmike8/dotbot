import { Application, Container, Graphics } from "pixi.js";
import { defaultGameConfig } from "@dotbot/game/config";
import type { SourceBuilding, SourceWall } from "@dotbot/game/mapSource";
import type { MapDocument, Rect, Solid, Vec2 } from "@dotbot/game/types";
import { buildMapArt, type MapArt } from "../game/renderer/mapArt";
import { parseObjectParallaxStrength } from "../game/renderer/model/modelParallax";
import { handlesFor, outdoorHandles, pick, type Handle } from "./editing";
import { StudioParallax } from "./parallax";
import {
  destroyStudioMapArt,
  replaceStudioMapArt,
  studioOverlaySolids,
} from "./presentation";
import { screenToWorld, snapToGrid, wallNear } from "./viewport";

/**
 * The Studio canvas.
 *
 * It renders through the *production* map art, not a schematic of its own. That
 * is the point: an author is composing what a player will see, so the editor has
 * to show the same lit model, at the same values, with only a thin overlay for
 * selection and snapping on top.
 *
 * The old editor built its own drawing of walls and objects, which meant every
 * judgement made in it — does this bench read as furniture, is that aisle wide
 * enough — was made against a picture the game never draws.
 */

export type CanvasCallbacks = {
  onPick: (handle: Handle | null) => void;
  onDragEnd: (handle: Handle, position: Vec2) => void;
  onPlace: (point: Vec2) => void;
  onWallPoint: (point: Vec2) => void;
  onOpeningPoint: (wall: SourceWall, along: Vec2) => void;
  onHover: (point: Vec2) => void;
};

export type CanvasView = {
  map: MapDocument;
  building: string | null;
  floor: string | null;
  area: Rect | null;
  /** GRID units; 0 turns snapping off. */
  grid: number;
  tool: "select" | "object" | "dot" | "wall" | "opening";
  selection: Handle | null;
  /** Points clicked so far while drawing a wall. */
  draft: Vec2[];
  source: SourceBuilding | null;
  showCollision?: boolean;
  showClearance?: boolean;
};

const MIN_SCALE = 0.08;
const MAX_SCALE = 4;

export class StudioCanvas {
  private app = new Application();
  private world = new Container();
  private overlay = new Graphics();
  private art: MapArt | null = null;
  private view: CanvasView | null = null;
  private handles: Handle[] = [];
  private scale = 1;
  private centre: Vec2 = { x: 0, y: 0 };
  private readonly parallax = new StudioParallax();
  private readonly parallaxStrength = typeof window === "undefined"
    ? 1
    : parseObjectParallaxStrength(window.location.search);
  /**
   * `from` is in **screen** space, not world.
   *
   * Panning by a world-space delta feeds back on itself: the cursor's world
   * position is derived from the camera, so moving the camera moves the reading
   * that is moving the camera, and the plan visibly shivers under the pointer.
   * A screen delta divided by the scale is the same maths without the loop.
   */
  private drag: { pointerId: number; kind: "pan" | "move"; from: Vec2; handle: Handle | null; origin: Vec2 } | null = null;
  private ghost: Vec2 | null = null;
  private disposed = false;
  /**
   * Pixi's `init` is async, but React commits effects synchronously, so the first
   * `apply` and `fit` arrive before there is a renderer to ask about its size.
   * Both stash their request and replay once the application is up.
   */
  private ready = false;
  private queued: { view: CanvasView | null; fit: Rect | null } = { view: null, fit: null };
  private observer: ResizeObserver | null = null;

  async mount(host: HTMLDivElement, callbacks: CanvasCallbacks): Promise<void> {
    await this.app.init({
      background: 0x1a1d20,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      resizeTo: host,
    });
    if (this.disposed) {
      this.app.destroy(true);
      return;
    }
    const canvas = this.app.canvas;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);
    this.app.stage.addChild(this.world);
    this.world.addChild(this.overlay);
    this.bind(canvas, callbacks);
    this.ready = true;
    /**
     * Pixi resizes the renderer to the host, but the world transform is derived
     * from the screen size, so it has to be recomputed or the plan drifts off
     * centre whenever the window changes.
     */
    this.observer = new ResizeObserver(() => {
      this.applyCamera();
      this.parallax.invalidate();
      this.updateParallax();
      this.paintOverlay();
      this.app.render();
    });
    this.observer.observe(host);
    if (this.queued.fit) this.fit(this.queued.fit);
    if (this.queued.view) this.apply(this.queued.view);
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.art) {
      destroyStudioMapArt(this.world, this.art);
      this.art = null;
    }
    try {
      this.app.destroy(true);
    } catch {
      // Fast Refresh can tear down a destroyed application; stay idempotent.
    }
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------

  private screenToWorld(clientX: number, clientY: number): Vec2 {
    return screenToWorld(clientX, clientY, this.app.canvas.getBoundingClientRect(), this.centre, this.scale);
  }

  private applyCamera(): void {
    const { width, height } = this.app.screen;
    this.world.scale.set(this.scale);
    this.world.position.set(width / 2 - this.centre.x * this.scale, height / 2 - this.centre.y * this.scale);
  }

  private visibleBounds(): Rect {
    const { width, height } = this.app.screen;
    return {
      x: this.centre.x - width / 2 / this.scale,
      y: this.centre.y - height / 2 / this.scale,
      w: width / this.scale,
      h: height / this.scale,
    };
  }

  private updateParallax(): void {
    if (!this.art) return;
    this.parallax.update(
      this.art,
      this.centre,
      this.visibleBounds(),
      this.parallaxStrength,
    );
  }

  fit(bounds: Rect): void {
    if (!this.ready) {
      this.queued.fit = bounds;
      return;
    }
    const { width, height } = this.app.screen;
    const margin = 48;
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
      Math.min((width - margin * 2) / bounds.w, (height - margin * 2) / bounds.h)));
    this.centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    this.applyCamera();
    this.parallax.invalidate();
    this.updateParallax();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private snap(point: Vec2): Vec2 {
    return snapToGrid(point, this.view?.grid ?? 0);
  }

  private bind(canvas: HTMLCanvasElement, callbacks: CanvasCallbacks): void {
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const before = this.screenToWorld(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * 0.0016);
      this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
      this.applyCamera();
      const after = this.screenToWorld(event.clientX, event.clientY);
      // Keep the world point under the cursor pinned while zooming.
      this.centre = { x: this.centre.x + (before.x - after.x), y: this.centre.y + (before.y - after.y) };
      this.applyCamera();
      this.parallax.invalidate();
      this.updateParallax();
      this.paintOverlay();
      this.app.render();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      const screen = { x: event.clientX, y: event.clientY };
      const world = this.screenToWorld(event.clientX, event.clientY);
      const tool = this.view?.tool ?? "select";

      // Middle button and space-less right drag pan, whatever the tool.
      if (event.button === 1 || event.button === 2) {
        this.drag = { pointerId: event.pointerId, kind: "pan", from: screen, handle: null, origin: this.centre };
        return;
      }

      if (tool === "object" || tool === "dot") {
        callbacks.onPlace(this.snap(world));
        return;
      }
      if (tool === "wall") {
        callbacks.onWallPoint(this.snap(world));
        return;
      }
      if (tool === "opening") {
        const wall = this.wallNear(world);
        if (wall) callbacks.onOpeningPoint(wall.wall, wall.at);
        return;
      }

      const handle = pick(this.handles, world);
      callbacks.onPick(handle);
      this.drag = handle && handle.movable !== false
        ? { pointerId: event.pointerId, kind: "move", from: screen, handle, origin: { x: handle.rect.x, y: handle.rect.y } }
        : null;
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) {
        callbacks.onHover(this.snap(this.screenToWorld(event.clientX, event.clientY)));
        this.ghost = null;
        this.paintOverlay();
        return;
      }
      const moved = {
        x: (event.clientX - this.drag.from.x) / this.scale,
        y: (event.clientY - this.drag.from.y) / this.scale,
      };
      if (this.drag.kind === "pan") {
        this.centre = { x: this.drag.origin.x - moved.x, y: this.drag.origin.y - moved.y };
        this.applyCamera();
        this.updateParallax();
        this.paintOverlay();
        this.app.render();
        return;
      }
      this.ghost = this.snap({ x: this.drag.origin.x + moved.x, y: this.drag.origin.y + moved.y });
      this.paintOverlay();
      this.app.render();
    });

    const finish = (event: PointerEvent): void => {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const { kind, handle } = this.drag;
      const ghost = this.ghost;
      this.drag = null;
      this.ghost = null;
      if (kind === "move" && handle && ghost && (ghost.x !== handle.rect.x || ghost.y !== handle.rect.y)) {
        callbacks.onDragEnd(handle, ghost);
      }
      this.paintOverlay();
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /** The authored wall nearest a point, and the point snapped onto its centreline. */
  private wallNear(point: Vec2): { wall: SourceWall; at: Vec2 } | null {
    return wallNear(this.view?.source ?? null, this.view?.floor ?? "", point);
  }


  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  apply(view: CanvasView): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.queued.view = view;
      return;
    }
    const rebuild = !this.art
      || this.view?.map !== view.map
      || this.view?.floor !== view.floor
      || this.view?.building !== view.building;
    this.view = view;
    this.handles = view.source && view.floor
      ? handlesFor(view.source, view.floor)
      : view.area ? outdoorHandles(view.map, view.area) : [];

    if (rebuild) {
      this.art = replaceStudioMapArt(
        this.world,
        this.overlay,
        this.art,
        buildMapArt(view.map),
      );
      this.showFloor(view);
      this.parallax.invalidate();
      this.updateParallax();
    }
    this.paintOverlay();
    this.app.render();
  }

  /**
   * Only the floor being edited, and only its own building's roof hidden. The
   * neighbours keep their roofs so the author still sees the block they sit in.
   */
  private showFloor(view: CanvasView): void {
    if (!this.art) return;
    for (const building of this.art.buildings) {
      const editing = building.building.id === view.building;
      building.roof.visible = !editing;
      for (const floor of building.floors) {
        floor.view.visible = editing && floor.floor.label === view.floor;
      }
    }
  }

  private paintOverlay(): void {
    const view = this.view;
    const g = this.overlay;
    g.clear();
    if (!view) return;

    if (view.showCollision || view.showClearance) {
      const overlays = studioOverlaySolids(view);
      for (const solid of overlays.clearance) {
        this.drawSolid(g, solid, defaultGameConfig.botRadius, 0xfbbf24, 0.12);
      }
      for (const solid of overlays.collision) {
        this.drawSolid(g, solid, 0, 0xef4444, 0.2);
      }
    }

    if (view.grid > 0 && this.scale > 0.45) {
      const step = view.grid * (this.scale < 0.9 ? 8 : 4);
      const { width, height } = this.app.screen;
      const half = { x: width / 2 / this.scale, y: height / 2 / this.scale };
      const from = { x: Math.floor((this.centre.x - half.x) / step) * step, y: Math.floor((this.centre.y - half.y) / step) * step };
      for (let x = from.x; x < this.centre.x + half.x; x += step) {
        g.moveTo(x, this.centre.y - half.y).lineTo(x, this.centre.y + half.y);
      }
      for (let y = from.y; y < this.centre.y + half.y; y += step) {
        g.moveTo(this.centre.x - half.x, y).lineTo(this.centre.x + half.x, y);
      }
      g.stroke({ color: 0x38bdf8, width: 0.6 / this.scale, alpha: 0.16 });
    }

    // Every handle, faintly, so an author can see what is selectable at all.
    for (const handle of this.handles) {
      g.rect(handle.rect.x, handle.rect.y, handle.rect.w, handle.rect.h)
        .stroke({
          color: handle.movable === false ? 0xf59e0b : 0x38bdf8,
          width: 1 / this.scale,
          alpha: handle.movable === false ? 0.42 : 0.28,
        });
    }

    const selected = view.selection
      ? this.handles.find((handle) => handle.kind === view.selection?.kind && handle.id === view.selection.id)
      : null;
    if (selected) {
      const { x, y, w, h } = selected.rect;
      g.rect(x, y, w, h).stroke({ color: 0x22d3ee, width: 2 / this.scale });
      // Corner ticks, so the exact bounds read even at a distance.
      const tick = Math.min(10, Math.min(w, h) / 3);
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
        g.moveTo(cx, cy).lineTo(cx + dx * tick, cy).moveTo(cx, cy).lineTo(cx, cy + dy * tick);
      }
      g.stroke({ color: 0xffffff, width: 1.6 / this.scale });
    }

    if (this.ghost && selected) {
      g.rect(this.ghost.x, this.ghost.y, selected.rect.w, selected.rect.h)
        .stroke({ color: 0xfbbf24, width: 2 / this.scale });
    }

    if (view.draft.length) {
      g.moveTo(view.draft[0].x, view.draft[0].y);
      for (const point of view.draft.slice(1)) g.lineTo(point.x, point.y);
      g.stroke({ color: 0xfbbf24, width: 3 / this.scale });
      for (const point of view.draft) {
        g.circle(point.x, point.y, 4 / this.scale).fill({ color: 0xfbbf24 });
      }
    }
  }

  private drawSolid(
    g: Graphics,
    solid: Solid,
    clearance: number,
    color: number,
    alpha: number,
  ): void {
    if (solid.kind === "rect") {
      g.rect(
        solid.x - clearance,
        solid.y - clearance,
        solid.w + clearance * 2,
        solid.h + clearance * 2,
      ).fill({ color, alpha });
      return;
    }
    if (solid.kind === "capsule") {
      g.moveTo(solid.ax, solid.ay).lineTo(solid.bx, solid.by)
        .stroke({ color, width: (solid.r + clearance) * 2, alpha });
      return;
    }
    if (!solid.points.length) return;
    g.poly(solid.points.flatMap((point) => [point.x, point.y])).fill({ color, alpha });
    if (clearance) {
      g.poly(solid.points.flatMap((point) => [point.x, point.y]))
        .stroke({ color, width: clearance * 2, alpha: alpha * 0.8 });
    }
  }
}
