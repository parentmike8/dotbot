import { useEffect, useMemo, useRef, useState } from "react";
import { Application, Container, Graphics } from "pixi.js";
import { defaultGameConfig } from "../game/config";
import { downtownMap } from "../game/content/downtown";
import { floorHeight, isGroundFloor, isSolidObject, rectContains } from "../game/mapModel";
import { buildMapArt, fitCamera, type MapArt } from "../game/renderer/mapArt";
import type { Building, FloorPlan, MapDocument, Rect, Vec2 } from "../game/types";

/**
 * Map Studio: the development-only authoring and review environment.
 *
 * Renders the production map art (mapArt.ts — the exact drawing the game
 * uses) on a clean canvas with no HUD, players, simulation, or fog. Supports
 * pan/zoom, building/floor selection, and inspection layers so the map can
 * be designed and critiqued as a drawing before gameplay ever touches it.
 *
 * Reach it at /?studio during development.
 */

type Selection =
  | { kind: "exterior" }
  | { kind: "floor"; buildingId: string; floorId: string };

type LayerToggles = {
  architecture: boolean;
  furniture: boolean;
  annotations: boolean;
  labels: boolean;
  collision: boolean;
  clearance: boolean;
  grid: boolean;
  dimOthers: boolean;
};

const defaultToggles: LayerToggles = {
  architecture: true,
  furniture: true,
  annotations: true,
  labels: true,
  collision: false,
  clearance: false,
  grid: false,
  dimOthers: true,
};

type StudioState = {
  selection: Selection;
  toggles: LayerToggles;
};

class StudioController {
  private app: Application;
  private world = new Container();
  private art: MapArt;
  private overlay = new Graphics();
  private gridGfx = new Graphics();
  private map: MapDocument;
  private scale = 1;
  private minScale = 0.05;
  private destroyed = false;
  private dragging: { pointerId: number; startX: number; startY: number; worldX: number; worldY: number } | null = null;
  /** Click-to-select: fired with world coordinates when the canvas is
   * clicked without dragging. Spatial selection is the only building picker
   * that stays usable once maps grow to dozens or hundreds of buildings. */
  private pickHandler: ((point: Vec2) => void) | null = null;

  private constructor(app: Application, map: MapDocument, private host: HTMLElement, private coordsEl: HTMLElement | null) {
    this.app = app;
    this.map = map;
    this.art = buildMapArt(map);
    this.world.addChild(this.gridGfx, this.art.root, this.overlay);
    this.app.stage.addChild(this.world);
    this.bindInput();
    this.fit();
    // Studio is development-only; a global handle makes console inspection easy.
    (window as unknown as { __studio?: StudioController }).__studio = this;
  }

  static async create(host: HTMLElement, map: MapDocument, coordsEl: HTMLElement | null): Promise<StudioController> {
    const app = new Application();

    await app.init({
      antialias: true,
      autoDensity: true,
      background: "#ffffff",
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });

    host.appendChild(app.canvas);
    return new StudioController(app, map, host, coordsEl);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    try {
      this.app.destroy({ removeView: true }, { children: true });
    } catch {
      try {
        this.app.canvas?.remove();
      } catch {
        // Already torn down.
      }
    }
  }

  fit(): void {
    // The host can measure zero for a frame during initial layout; keep
    // retrying until it has a real size so the first view is always framed.
    if (this.host.clientWidth < 50 || this.host.clientHeight < 50) {
      if (!this.destroyed) {
        requestAnimationFrame(() => this.fit());
      }
      return;
    }

    const camera = fitCamera(this.map, { width: this.host.clientWidth, height: this.host.clientHeight });
    this.scale = camera.scale;
    this.minScale = camera.scale * 0.4;
    this.world.scale.set(camera.scale);
    this.world.position.set(camera.x, camera.y);
  }

  /** 1:1 world units to CSS pixels, centered on the current view center. */
  actualSize(): void {
    const cx = (this.host.clientWidth / 2 - this.world.position.x) / this.scale;
    const cy = (this.host.clientHeight / 2 - this.world.position.y) / this.scale;
    this.scale = 1;
    this.world.scale.set(1);
    this.world.position.set(this.host.clientWidth / 2 - cx, this.host.clientHeight / 2 - cy);
  }

  setPickHandler(handler: ((point: Vec2) => void) | null): void {
    this.pickHandler = handler;
  }

  focusRect(rect: Rect, margin = 80): void {
    const scale = Math.min(
      (this.host.clientWidth - margin * 2) / rect.w,
      (this.host.clientHeight - margin * 2) / rect.h,
      6,
    );
    this.scale = scale;
    this.world.scale.set(scale);
    this.world.position.set(
      this.host.clientWidth / 2 - (rect.x + rect.w / 2) * scale,
      this.host.clientHeight / 2 - (rect.y + rect.h / 2) * scale,
    );
  }

  apply(state: StudioState): void {
    const { selection, toggles } = state;
    const dimAlpha = toggles.dimOthers ? 0.22 : 1;
    const interior = selection.kind === "floor";

    this.art.ground.alpha = interior ? dimAlpha : 1;
    this.art.outdoorDetail.visible = toggles.furniture;
    this.art.outdoorObjects.visible = toggles.furniture;
    this.art.outdoorDetail.alpha = interior ? dimAlpha : 1;
    this.art.outdoorObjects.alpha = interior ? dimAlpha : 1;
    this.art.labels.visible = toggles.labels;
    this.art.labels.alpha = interior ? dimAlpha : 1;

    for (const view of this.art.buildings) {
      const isSelected = interior && view.building.id === selection.buildingId;
      const hasRoofPlan = view.building.floors.some((floor) => floor.label === "ROOF");

      for (const floorArt of view.floors) {
        const isActiveFloor = isSelected && floorArt.floor.id === selection.floorId;
        const isRoofPlan = floorArt.floor.label === "ROOF";
        floorArt.view.visible = isActiveFloor || (isRoofPlan && !isSelected);
        floorArt.view.alpha = isActiveFloor ? 1 : interior ? dimAlpha : 1;
        floorArt.architecture.visible = toggles.architecture;
        floorArt.furniture.visible = toggles.furniture;
        floorArt.annotation.visible = toggles.annotations;
      }

      view.roof.visible = !isSelected && !hasRoofPlan;
      view.roof.alpha = interior && !isSelected ? dimAlpha : 1;
      view.entranceMarks.visible = !isSelected;
      view.entranceMarks.alpha = interior && !isSelected ? dimAlpha : 1;
      view.label.visible = toggles.labels && !isSelected;
      view.label.alpha = interior ? dimAlpha : 1;
    }

    this.drawGrid(toggles.grid);
    this.drawOverlays(state);
  }

  private drawGrid(visible: boolean): void {
    this.gridGfx.clear();

    if (!visible) {
      return;
    }

    const step = 100;
    for (let x = 0; x <= this.map.width; x += step) {
      this.gridGfx.moveTo(x, 0).lineTo(x, this.map.height).stroke({ color: 0x9db4c8, width: x % 500 === 0 ? 0.8 : 0.4, alpha: 0.5 });
    }
    for (let y = 0; y <= this.map.height; y += step) {
      this.gridGfx.moveTo(0, y).lineTo(this.map.width, y).stroke({ color: 0x9db4c8, width: y % 500 === 0 ? 0.8 : 0.4, alpha: 0.5 });
    }
  }

  /** Collision and clearance overlays for the selected physics context. */
  private drawOverlays(state: StudioState): void {
    this.overlay.clear();
    const { toggles } = state;

    if (!toggles.collision && !toggles.clearance) {
      return;
    }

    const rects = this.collisionRects(state.selection);
    const radius = defaultGameConfig.botRadius;

    if (toggles.clearance) {
      for (const rect of rects) {
        this.overlay
          .rect(rect.x - radius, rect.y - radius, rect.w + radius * 2, rect.h + radius * 2)
          .fill({ color: 0xf2994a, alpha: 0.14 });
      }
    }

    if (toggles.collision) {
      for (const rect of rects) {
        this.overlay.rect(rect.x, rect.y, rect.w, rect.h).fill({ color: 0xeb5757, alpha: 0.12 });
        this.overlay.rect(rect.x, rect.y, rect.w, rect.h).stroke({ color: 0xeb5757, width: 1.2, alpha: 0.8 });
      }

      // Stair runs: walkable connectors, outlined for contrast.
      for (const stair of this.selectionStairs(state.selection)) {
        this.overlay.rect(stair.x, stair.y, stair.w, stair.h).stroke({ color: 0x27ae60, width: 1.5, alpha: 0.9 });
      }
    }
  }

  private selectionPlans(selection: Selection): FloorPlan[] {
    if (selection.kind === "floor") {
      const building = this.map.buildings.find((candidate) => candidate.id === selection.buildingId);
      const plan = building?.floors.find((floor) => floor.id === selection.floorId);
      // GROUND floors share the outdoor physics plane.
      if (plan && isGroundFloor(plan)) {
        return this.outdoorPlans();
      }
      return plan ? [plan] : [];
    }

    return this.outdoorPlans();
  }

  private outdoorPlans(): FloorPlan[] {
    return this.map.buildings.map((building) => building.floors.find(isGroundFloor)).filter((plan): plan is FloorPlan => Boolean(plan));
  }

  private collisionRects(selection: Selection): Rect[] {
    const rects: Rect[] = [];
    const outdoorContext = selection.kind === "exterior" || this.selectionPlans(selection).some(isGroundFloor);

    if (outdoorContext) {
      rects.push(...this.map.outdoor.walls);
      for (const object of this.map.outdoor.objects) {
        if (isSolidObject(object)) {
          rects.push(object);
        }
      }
    }

    for (const plan of this.selectionPlans(selection)) {
      rects.push(...plan.walls);
      for (const object of plan.objects) {
        if (isSolidObject(object)) {
          rects.push(object);
        }
      }
    }

    return rects;
  }

  private selectionStairs(selection: Selection): Rect[] {
    return this.selectionPlans(selection).flatMap((plan) => plan.stairs.map((stair) => stair.rect));
  }

  // --- Input -----------------------------------------------------------------

  private bindInput(): void {
    const canvas = this.app.canvas;

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.dragging = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        worldX: this.world.position.x,
        worldY: this.world.position.y,
      };
    });

    canvas.addEventListener("pointermove", (event) => {
      if (this.dragging && event.pointerId === this.dragging.pointerId) {
        this.world.position.set(
          this.dragging.worldX + (event.clientX - this.dragging.startX),
          this.dragging.worldY + (event.clientY - this.dragging.startY),
        );
      }

      if (this.coordsEl) {
        const rect = canvas.getBoundingClientRect();
        const wx = (event.clientX - rect.left - this.world.position.x) / this.scale;
        const wy = (event.clientY - rect.top - this.world.position.y) / this.scale;
        this.coordsEl.textContent = `${Math.round(wx)}, ${Math.round(wy)} · ${this.scale.toFixed(2)}x`;
      }
    });

    canvas.addEventListener("pointerup", (event) => {
      if (!this.dragging || event.pointerId !== this.dragging.pointerId) {
        return;
      }

      const moved = Math.hypot(event.clientX - this.dragging.startX, event.clientY - this.dragging.startY);
      this.dragging = null;

      if (moved < 6 && this.pickHandler) {
        const rect = canvas.getBoundingClientRect();
        this.pickHandler({
          x: (event.clientX - rect.left - this.world.position.x) / this.scale,
          y: (event.clientY - rect.top - this.world.position.y) / this.scale,
        });
      }
    });
    canvas.addEventListener("pointercancel", (event) => {
      if (this.dragging && event.pointerId === this.dragging.pointerId) {
        this.dragging = null;
      }
    });

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const worldX = (px - this.world.position.x) / this.scale;
        const worldY = (py - this.world.position.y) / this.scale;
        const next = Math.min(8, Math.max(this.minScale, this.scale * Math.exp(-event.deltaY * 0.0014)));
        this.scale = next;
        this.world.scale.set(next);
        this.world.position.set(px - worldX * next, py - worldY * next);
      },
      { passive: false },
    );
  }
}

// ---------------------------------------------------------------------------
// React shell
// ---------------------------------------------------------------------------

export function MapStudio() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const coordsRef = useRef<HTMLSpanElement | null>(null);
  const controllerRef = useRef<StudioController | null>(null);
  const [ready, setReady] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<StudioState>({ selection: { kind: "exterior" }, toggles: defaultToggles });

  const map = downtownMap;

  useEffect(() => {
    let disposed = false;

    async function start() {
      if (!hostRef.current) {
        return;
      }

      const controller = await StudioController.create(hostRef.current, map, coordsRef.current);

      if (disposed) {
        controller.destroy();
        return;
      }

      controllerRef.current = controller;
      setReady(true);
    }

    void start();

    return () => {
      disposed = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (ready) {
      controllerRef.current?.apply(state);
    }
  }, [ready, state]);

  // Click a footprint on the canvas to select that building (its GROUND
  // floor); click open street to return to the site plan.
  useEffect(() => {
    if (!ready) {
      return;
    }

    controllerRef.current?.setPickHandler((point) => {
      const building = map.buildings.find((candidate) => rectContains(candidate.footprint, point, 0));

      setState((prev) => {
        if (!building) {
          return prev.selection.kind === "exterior" ? prev : { ...prev, selection: { kind: "exterior" } };
        }

        if (prev.selection.kind === "floor" && prev.selection.buildingId === building.id) {
          return prev;
        }

        const ground = building.floors.find(isGroundFloor) ?? building.floors[0];
        return { ...prev, selection: { kind: "floor", buildingId: building.id, floorId: ground.id } };
      });
    });

    return () => controllerRef.current?.setPickHandler(null);
  }, [ready, map]);

  const buildings = useMemo(
    () =>
      map.buildings.map((building: Building) => ({
        building,
        floors: [...building.floors].sort((a, b) => floorHeight(b.label) - floorHeight(a.label)),
      })),
    [map],
  );

  const select = (selection: Selection, focus?: Rect) => {
    setState((prev) => ({ ...prev, selection }));
    if (focus) {
      controllerRef.current?.focusRect(focus);
    }
  };

  const toggle = (key: keyof LayerToggles) => {
    setState((prev) => ({ ...prev, toggles: { ...prev.toggles, [key]: !prev.toggles[key] } }));
  };

  const toggleDefs: Array<{ key: keyof LayerToggles; label: string }> = [
    { key: "architecture", label: "Architecture" },
    { key: "furniture", label: "Furniture" },
    { key: "annotations", label: "Annotations" },
    { key: "labels", label: "Labels" },
    { key: "collision", label: "Collision" },
    { key: "clearance", label: "Nav clearance" },
    { key: "grid", label: "Grid" },
    { key: "dimOthers", label: "Dim inactive" },
  ];

  return (
    <main className="studio-shell" aria-label="Map Studio">
      <div ref={hostRef} className="studio-canvas" />

      <button
        type="button"
        className="studio-panel-toggle"
        onClick={() => setPanelOpen((open) => !open)}
        aria-label={panelOpen ? "Hide controls" : "Show controls"}
      >
        {panelOpen ? "◀" : "▶"}
      </button>

      <aside className="studio-panel" aria-label="Studio controls" hidden={!panelOpen}>
        <header className="studio-header">
          <h1>Map Studio</h1>
          <span className="studio-map-name">{map.name}</span>
        </header>

        <section className="studio-section" aria-label="View">
          <div className="studio-row">
            <button type="button" onClick={() => controllerRef.current?.fit()}>
              Fit map
            </button>
            <button type="button" onClick={() => controllerRef.current?.actualSize()}>
              1:1
            </button>
          </div>
        </section>

        <section className="studio-section" aria-label="Selection">
          <button
            type="button"
            className={state.selection.kind === "exterior" ? "active" : ""}
            onClick={() => select({ kind: "exterior" })}
          >
            Exterior / site plan
          </button>

          <input
            type="search"
            className="studio-filter"
            placeholder="Filter buildings…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter buildings"
          />

          <div className="studio-building-list">
            {buildings
              .filter(({ building }) => building.name.toLowerCase().includes(filter.trim().toLowerCase()))
              .map(({ building, floors }) => {
                const isSelected = state.selection.kind === "floor" && state.selection.buildingId === building.id;
                const ground = floors.find((floor) => floor.label === "GROUND") ?? floors[floors.length - 1];
                return (
                  <div key={building.id} className="studio-building">
                    <button
                      type="button"
                      className={`studio-building-row ${isSelected ? "active" : ""}`}
                      onClick={() =>
                        select({ kind: "floor", buildingId: building.id, floorId: ground.id }, building.footprint)
                      }
                    >
                      <span>{building.name}</span>
                      <span className="studio-floor-count">{floors.length}</span>
                    </button>
                    {isSelected ? (
                      <div className="studio-floors">
                        {floors.map((floor) => {
                          const active = state.selection.kind === "floor" && state.selection.floorId === floor.id;
                          return (
                            <button
                              key={floor.id}
                              type="button"
                              className={active ? "active" : ""}
                              onClick={() => select({ kind: "floor", buildingId: building.id, floorId: floor.id })}
                            >
                              {floor.label}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
        </section>

        <section className="studio-section" aria-label="Layers">
          {toggleDefs.map(({ key, label }) => (
            <label key={key} className="studio-toggle">
              <input type="checkbox" checked={state.toggles[key]} onChange={() => toggle(key)} />
              <span>{label}</span>
            </label>
          ))}
        </section>

        <footer className="studio-footer">
          <span ref={coordsRef} className="studio-coords">
            —
          </span>
        </footer>
      </aside>
    </main>
  );
}
