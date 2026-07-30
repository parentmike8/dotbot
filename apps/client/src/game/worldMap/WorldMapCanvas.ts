import { Application, Container, Graphics } from "pixi.js";
import { type GameSnapshot, type MapDocument, type Vec2 } from "@dotbot/game/types";
import { buildMapArt, type MapArt } from "../renderer/mapArt";
import { markAge, type LiveMark } from "../pings";
import { screenToWorld } from "../../studio/viewport";
import {
  clampWorldMapCentre,
  exteriorMapPresentation,
  fitWorldMapScale,
  mapMarkers,
  worldMapBounds,
} from "./worldMap";

type MapCallbacks = {
  onPing: (position: Vec2) => void;
  onChoosePing: (position: Vec2, screen: Vec2) => void;
};

const MAP_MARGIN = 28;
const MAX_ZOOM_MULTIPLIER = 12;
const TAP_TRAVEL_PX = 7;
const LONG_PRESS_MS = 420;

/**
 * A camera over production map art.
 *
 * This owns transforms and pointer gestures only. Static marks come verbatim
 * from `buildMapArt`; dynamic marks come from the narrow allow-list in
 * `mapMarkers`.
 */
export class WorldMapCanvas {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly markers = new Graphics();
  private readonly pointers = new Map<number, Vec2>();
  private art: MapArt | null = null;
  private observer: ResizeObserver | null = null;
  private callbacks: MapCallbacks | null = null;
  private map: MapDocument | null = null;
  private scale = 1;
  private fitScale = 1;
  private centre: Vec2 = { x: 0, y: 0 };
  private drag: { pointerId: number; from: Vec2; origin: Vec2; moved: boolean } | null = null;
  private pinch: { distance: number; scale: number; anchor: Vec2 } | null = null;
  private longPressTimer: number | null = null;
  private longPressed = false;
  private lastFrame: { snapshot: GameSnapshot; viewerId: string; marks: readonly LiveMark[]; nowMs: number } | null = null;
  private disposed = false;
  private ready = false;

  async mount(host: HTMLDivElement, map: MapDocument, callbacks: MapCallbacks): Promise<void> {
    this.map = map;
    this.callbacks = callbacks;
    await this.app.init({
      background: 0xe7e9eb,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      resizeTo: host,
      autoStart: false,
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

    this.art = buildMapArt(map);
    this.applyExteriorPresentation(this.art, map);
    // Overhead is production exterior art too (tree canopies, trunks). Markers
    // sit above it so a squadmate cannot disappear under a tree on the chart.
    this.world.addChild(this.art.root, this.art.overhead, this.markers);
    this.app.stage.addChild(this.world);
    this.bind(canvas);
    this.ready = true;
    this.fit();
    this.observer = new ResizeObserver(() => {
      this.app.renderer.resize(
        Math.max(1, host.clientWidth),
        Math.max(1, host.clientHeight),
      );
      this.recalculateFit(false);
      this.renderNow();
    });
    this.observer.observe(host);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelLongPress();
    this.observer?.disconnect();
    this.observer = null;
    try {
      this.app.destroy(true);
    } catch {
      // React Fast Refresh can race Pixi teardown; cleanup stays idempotent.
    }
  }

  update(snapshot: GameSnapshot, viewerId: string, marks: readonly LiveMark[], nowMs = performance.now()): void {
    this.lastFrame = { snapshot, viewerId, marks, nowMs };
    this.paintMarkers();
    this.renderNow();
  }

  fit(): void {
    if (!this.ready) return;
    this.recalculateFit(true);
    this.paintMarkers();
    this.renderNow();
  }

  zoomBy(factor: number): void {
    if (!this.map || !this.ready) return;
    this.scale = Math.max(this.fitScale, Math.min(this.fitScale * MAX_ZOOM_MULTIPLIER, this.scale * factor));
    this.centre = clampWorldMapCentre(this.centre, worldMapBounds(this.map), this.viewport(), this.scale);
    this.applyCamera();
    this.paintMarkers();
    this.renderNow();
  }

  private applyExteriorPresentation(art: MapArt, map: MapDocument): void {
    const presentation = new Map(
      exteriorMapPresentation(map).buildings.map((building) => [building.buildingId, building]),
    );
    for (const building of art.buildings) {
      const visible = presentation.get(building.building.id)!;
      building.roof.visible = visible.generatedRoofVisible;
      building.entranceMarks.visible = true;
      for (const floor of building.floors) {
        floor.view.visible = visible.visibleFloorIds.includes(floor.floor.id);
        floor.foreground.visible = false;
        if (floor.stairHousing && floor.stairWell) {
          floor.stairHousing.visible = true;
          floor.stairWell.visible = false;
        }
      }
    }
  }

  private recalculateFit(reset: boolean): void {
    if (!this.map) return;
    const bounds = worldMapBounds(this.map);
    this.fitScale = fitWorldMapScale(bounds, this.viewport(), MAP_MARGIN);
    if (reset) {
      this.scale = this.fitScale;
      this.centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    } else {
      this.scale = Math.max(this.fitScale, Math.min(this.fitScale * MAX_ZOOM_MULTIPLIER, this.scale));
      this.centre = clampWorldMapCentre(this.centre, bounds, this.viewport(), this.scale);
    }
    this.applyCamera();
  }

  private viewport(): { width: number; height: number } {
    return { width: Math.max(1, this.app.screen.width), height: Math.max(1, this.app.screen.height) };
  }

  private applyCamera(): void {
    const { width, height } = this.viewport();
    this.world.scale.set(this.scale);
    this.world.position.set(width / 2 - this.centre.x * this.scale, height / 2 - this.centre.y * this.scale);
  }

  private pointAt(clientX: number, clientY: number): Vec2 {
    return screenToWorld(
      clientX,
      clientY,
      this.app.canvas.getBoundingClientRect(),
      this.centre,
      this.scale,
    );
  }

  private bind(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const before = this.pointAt(event.clientX, event.clientY);
      this.scale = Math.max(
        this.fitScale,
        Math.min(this.fitScale * MAX_ZOOM_MULTIPLIER, this.scale * Math.exp(-event.deltaY * 0.0016)),
      );
      this.applyCamera();
      const after = this.pointAt(event.clientX, event.clientY);
      this.centre = this.clampCentre({
        x: this.centre.x + before.x - after.x,
        y: this.centre.y + before.y - after.y,
      });
      this.applyCamera();
      this.paintMarkers();
      this.renderNow();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const point = { x: event.clientX, y: event.clientY };
      this.pointers.set(event.pointerId, point);
      this.longPressed = false;
      if (this.pointers.size === 2) {
        this.cancelLongPress();
        const [a, b] = [...this.pointers.values()];
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.pinch = {
          distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          scale: this.scale,
          anchor: this.pointAt(midpoint.x, midpoint.y),
        };
        this.drag = null;
        return;
      }
      if (event.button !== 0) return;
      this.drag = { pointerId: event.pointerId, from: point, origin: this.centre, moved: false };
      if (event.pointerType === "touch") {
        this.longPressTimer = window.setTimeout(() => {
          if (!this.drag || this.drag.moved || this.pointers.size !== 1) return;
          this.longPressed = true;
          this.callbacks?.onChoosePing(this.pointAt(point.x, point.y), point);
        }, LONG_PRESS_MS);
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!this.pointers.has(event.pointerId)) return;
      event.preventDefault();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        this.scale = Math.max(
          this.fitScale,
          Math.min(this.fitScale * MAX_ZOOM_MULTIPLIER, this.pinch.scale * distance / this.pinch.distance),
        );
        this.applyCamera();
        const underMidpoint = this.pointAt(midpoint.x, midpoint.y);
        this.centre = this.clampCentre({
          x: this.centre.x + this.pinch.anchor.x - underMidpoint.x,
          y: this.centre.y + this.pinch.anchor.y - underMidpoint.y,
        });
        this.applyCamera();
        this.paintMarkers();
        this.renderNow();
        return;
      }
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - this.drag.from.x;
      const dy = event.clientY - this.drag.from.y;
      if (Math.hypot(dx, dy) > TAP_TRAVEL_PX) {
        this.drag.moved = true;
        this.cancelLongPress();
      }
      this.centre = this.clampCentre({
        x: this.drag.origin.x - dx / this.scale,
        y: this.drag.origin.y - dy / this.scale,
      });
      this.applyCamera();
      this.renderNow();
    });

    const finish = (event: PointerEvent): void => {
      if (!this.pointers.has(event.pointerId)) return;
      event.preventDefault();
      const wasDrag = this.drag?.pointerId === event.pointerId ? this.drag : null;
      const wasPinching = this.pointers.size > 1 || this.pinch !== null;
      this.pointers.delete(event.pointerId);
      this.cancelLongPress();
      if (!wasPinching && wasDrag && !wasDrag.moved && !this.longPressed && event.button === 0) {
        this.callbacks?.onPing(this.pointAt(event.clientX, event.clientY));
      }
      this.longPressed = false;
      this.drag = null;
      this.pinch = null;
      const remaining = [...this.pointers.entries()][0];
      if (remaining) {
        this.drag = {
          pointerId: remaining[0],
          from: remaining[1],
          origin: this.centre,
          moved: true,
        };
      }
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.callbacks?.onChoosePing(
        this.pointAt(event.clientX, event.clientY),
        { x: event.clientX, y: event.clientY },
      );
    });
  }

  private clampCentre(centre: Vec2): Vec2 {
    if (!this.map) return centre;
    return clampWorldMapCentre(centre, worldMapBounds(this.map), this.viewport(), this.scale);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer === null) return;
    window.clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  private paintMarkers(): void {
    this.markers.clear();
    if (!this.map || !this.lastFrame) return;
    const { snapshot, viewerId, marks, nowMs } = this.lastFrame;
    const visible = mapMarkers(this.map, snapshot, viewerId, marks);
    const unit = 1 / Math.max(this.scale, 0.0001);

    for (const bot of visible.squad) {
      const radius = (bot.isViewer ? 7 : 6) * unit;
      const stroke = { color: 0x0e1013, width: 1.5 * unit, alpha: 0.9 };
      if (bot.state === "downed") {
        this.markers.circle(bot.position.x, bot.position.y, radius).stroke(stroke);
        this.markers
          .moveTo(bot.position.x - radius * 0.55, bot.position.y - radius * 0.55)
          .lineTo(bot.position.x + radius * 0.55, bot.position.y + radius * 0.55)
          .moveTo(bot.position.x + radius * 0.55, bot.position.y - radius * 0.55)
          .lineTo(bot.position.x - radius * 0.55, bot.position.y + radius * 0.55)
          .stroke(stroke);
      } else {
        this.markers.circle(bot.position.x, bot.position.y, radius)
          .fill({ color: bot.isViewer ? 0xffffff : 0x38d7f2, alpha: 0.98 })
          .stroke(stroke);
      }
    }

    for (const mark of visible.pings) {
      const fade = 1 - markAge(mark, nowMs);
      if (fade <= 0) continue;
      const r = 7 * unit;
      this.markers
        .moveTo(mark.position.x, mark.position.y - r)
        .lineTo(mark.position.x + r, mark.position.y)
        .lineTo(mark.position.x, mark.position.y + r)
        .lineTo(mark.position.x - r, mark.position.y)
        .closePath()
        .fill({ color: 0x0e1013, alpha: 0.72 * fade })
        .stroke({ color: 0x38d7f2, width: 2 * unit, alpha: fade });
    }
  }

  private renderNow(): void {
    if (!this.disposed && this.ready) this.app.render();
  }
}
