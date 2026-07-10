import { Application, Container, Graphics, Text } from "pixi.js";
import { clamp, clamp01, colorToNumber } from "../math";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  floorPlanById,
  isGroundFloor,
  resolvePlan,
  stairHalves,
} from "../mapModel";
import { hasLineOfSight, visibilityPolygon, visionContext } from "../visibility";
import { OUTDOOR_FLOOR_ID } from "../types";
import type {
  Building,
  Doorway,
  DotBotEntity,
  FloorPlan,
  GameSnapshot,
  MapDocument,
  Rect,
  StairLink,
  Vec2,
  WallSegment,
} from "../types";
import { drawObject, INK } from "./glyphs";

const COLOR = {
  paper: 0xffffff,
  border: 0xe9ebee,

  asphalt: 0xf0f1f4,
  curb: 0xb9bfc7,
  laneDash: 0xd3d7dc,
  crosswalk: 0xd9dde2,
  stopLine: 0xc3c8cf,

  sidewalk: 0xf7f8f9,
  sidewalkJoint: 0xe4e7ea,

  parkGround: 0xf4f5f4,
  parkEdge: 0xc9cfc9,
  parkPath: 0xebedee,

  floorPlate: 0xffffff,
  floorSeam: 0xf0f2f4,
  basementPlate: 0xeceef1,

  roofPlate: 0xf3f4f6,
  roofSeam: 0xe2e5e9,

  wall: 0x1c1f24,
  glass: 0xdfe4ea,

  label: 0x9aa1a8,
  streetName: 0xd0d4da,

  extract: 0x2b3036,
} as const;

const SIDEWALK = 20;
const EXTERIOR_WALL = 12;

type FloorView = {
  floor: FloorPlan;
  view: Container;
};

type BuildingView = {
  building: Building;
  roof: Container;
  floors: FloorView[];
  label: Text;
};

export class GameRenderer {
  private readonly app: Application;
  private readonly worldLayer = new Container();
  private readonly groundGfx = new Graphics();
  private readonly outdoorObjectsGfx = new Graphics();
  private readonly buildingsLayer = new Container();
  /** Entrance marks drawn above roofs so doors stay visible from the street. */
  private readonly entrancesGfx = new Graphics();
  /** Faint wash over everything outside the player's line of sight. */
  private readonly fogGfx = new Graphics();
  private readonly labelsLayer = new Container();
  /** Entities subject to line-of-sight: enemies, dots, their rings. */
  private readonly maskedLayer = new Container();
  private readonly maskedGfx = new Graphics();
  private readonly visionMaskGfx = new Graphics();
  /** Always-visible layer: player, squad, noise rings, extraction pulse. */
  private readonly dynamicGfx = new Graphics();
  /** Far half of each stair run on the active floor, drawn over the bots so
   * they slide under the break line while changing floors. */
  private readonly stairOverlayGfx = new Graphics();

  private buildingViews: BuildingView[] = [];
  private map: MapDocument;
  private viewport = { width: 1, height: 1 };

  private constructor(app: Application, map: MapDocument) {
    this.app = app;
    this.map = map;
    this.app.stage.addChild(this.worldLayer);
    this.maskedLayer.addChild(this.maskedGfx, this.visionMaskGfx);
    this.maskedLayer.mask = this.visionMaskGfx;
    this.worldLayer.addChild(
      this.groundGfx,
      this.outdoorObjectsGfx,
      this.buildingsLayer,
      this.entrancesGfx,
      this.fogGfx,
      this.labelsLayer,
      this.maskedLayer,
      this.dynamicGfx,
      this.stairOverlayGfx,
    );
  }

  static async create(host: HTMLElement, map: MapDocument): Promise<GameRenderer> {
    const app = new Application();

    await app.init({
      antialias: true,
      autoDensity: true,
      background: "#ffffff",
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });

    host.appendChild(app.canvas);
    const renderer = new GameRenderer(app, map);
    renderer.resize(host.clientWidth, host.clientHeight);
    renderer.buildStaticLayers();

    return renderer;
  }

  resize(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
  }

  destroy(): void {
    this.app.destroy(true);
  }

  render(snapshot: GameSnapshot): void {
    const player = snapshot.bots.find((bot) => bot.id === snapshot.playerId) ?? snapshot.bots[0];
    const center = player?.position ?? { x: this.map.width / 2, y: this.map.height / 2 };
    const camera = this.getCamera(center);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);

    const playerContext = player ? this.contextKey(player.floorId, player.position) : "outdoor:street";
    this.updateVisibility(player ?? null, playerContext);
    this.updateLineOfSight(player ?? null, playerContext);

    this.maskedGfx.clear();
    this.dynamicGfx.clear();
    this.drawExtractionPulse(snapshot);
    this.drawDots(snapshot, playerContext);
    this.drawBots(snapshot, playerContext);

    if (player) {
      this.drawNoises(snapshot, player);
    }

    this.drawStairOverlay(player ?? null);
  }

  /** Redraw the far half of the active floor's stairs above the bot layer. */
  private drawStairOverlay(player: DotBotEntity | null): void {
    this.stairOverlayGfx.clear();

    if (!player) {
      return;
    }

    const planRef = resolvePlan(this.map, player.floorId, player.position);
    const plan = planRef ? floorPlanById(this.map, planRef.planId) : null;

    for (const stair of plan?.stairs ?? []) {
      this.drawStairExitHalf(this.stairOverlayGfx, stair);
    }
  }

  /** Rebuild the visibility polygon: vision mask + fog wash outside it. */
  private updateLineOfSight(player: DotBotEntity | null, playerContext: string): void {
    this.visionMaskGfx.clear();
    this.fogGfx.clear();

    if (!player || player.state === "consumed") {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    const vision = visionContext(this.map, playerContext);
    const polygon = visibilityPolygon(player.position, vision);

    if (polygon.length < 3) {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    const flat = polygon.flatMap((point) => [point.x, point.y]);
    this.visionMaskGfx.poly(flat).fill({ color: 0xffffff });

    const bounds = vision.boundsRect;
    this.fogGfx.rect(bounds.x, bounds.y, bounds.w, bounds.h).fill({ color: 0x2f353b, alpha: 0.07 });
    this.fogGfx.poly(flat).cut();
    this.fogGfx.poly(flat).stroke({ color: 0xb9c0c8, width: 1.25, alpha: 0.5 });
  }

  private getCamera(target: Vec2): { x: number; y: number; scale: number } {
    const shortSide = Math.min(this.viewport.width, this.viewport.height);
    const scale = clamp(shortSide / 620, 0.55, 1.0);
    const visibleWidth = this.viewport.width / scale;
    const visibleHeight = this.viewport.height / scale;
    const centerX = clamp(target.x, visibleWidth / 2, this.map.width - visibleWidth / 2);
    const centerY = clamp(target.y, visibleHeight / 2, this.map.height - visibleHeight / 2);

    return {
      x: this.viewport.width / 2 - centerX * scale,
      y: this.viewport.height / 2 - centerY * scale,
      scale,
    };
  }

  private contextKey(floorId: string, position: Vec2): string {
    return contextKey(this.map, floorId, position);
  }

  private updateVisibility(player: DotBotEntity | null, playerContext: string): void {
    const indoors = playerContext !== "outdoor:street";
    this.groundGfx.alpha = indoors ? 0.4 : 1;
    this.outdoorObjectsGfx.alpha = indoors ? 0.35 : 1;
    this.entrancesGfx.alpha = indoors ? 0.35 : 1;
    this.labelsLayer.alpha = indoors ? 0.45 : 1;

    const activeBuilding =
      player === null
        ? null
        : player.floorId !== OUTDOOR_FLOOR_ID
          ? this.buildingViews.find((view) => view.floors.some((floor) => floor.floor.id === player.floorId))?.building ?? null
          : buildingContaining(this.map, player.position);

    for (const view of this.buildingViews) {
      const isActive = activeBuilding?.id === view.building.id;
      const activeFloorId =
        isActive && player
          ? player.floorId !== OUTDOOR_FLOOR_ID
            ? player.floorId
            : view.building.floors.find(isGroundFloor)?.id
          : undefined;

      for (const floorView of view.floors) {
        const isRoofPlan = floorView.floor.label === "ROOF";
        // A real ROOF plan doubles as the building's roof seen from outside.
        floorView.view.visible = floorView.floor.id === activeFloorId || (isRoofPlan && !isActive);
        floorView.view.alpha = floorView.floor.id === activeFloorId ? 1 : indoors ? 0.35 : 1;
      }

      const hasRoofPlan = view.building.floors.some((floor) => floor.label === "ROOF");
      view.roof.visible = !isActive && !hasRoofPlan;
      view.roof.alpha = indoors ? 0.35 : 1;
      view.label.alpha = isActive ? 0 : 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Static construction
  // ---------------------------------------------------------------------------

  private buildStaticLayers(): void {
    this.drawGround();
    this.drawOutdoorObjects();

    for (const building of this.map.buildings) {
      this.buildBuilding(building);
    }

    this.drawEntranceMarks();
    this.drawStreetNames();
    this.drawExtractionLabels();
  }

  // --- Building entrances -----------------------------------------------------

  /**
   * Street-level entrances, derived from GROUND-floor doorways sitting on the
   * building perimeter. Everything else about the ground floor hides under the
   * roof when viewed from outside — entrances must stay readable.
   */
  private groundEntrances(): Array<{ cx: number; cy: number; width: number; side: "N" | "S" | "E" | "W"; open: boolean }> {
    const entrances: Array<{ cx: number; cy: number; width: number; side: "N" | "S" | "E" | "W"; open: boolean }> = [];
    const tol = 8;

    for (const building of this.map.buildings) {
      const fp = building.footprint;
      const ground = building.floors.find(isGroundFloor);

      if (!ground) {
        continue;
      }

      for (const doorway of ground.doorways) {
        const open = doorway.open ?? false;

        if (doorway.dir === "h") {
          if (Math.abs(doorway.y - (fp.y + EXTERIOR_WALL / 2)) <= tol) {
            entrances.push({ cx: doorway.x, cy: fp.y, width: doorway.width, side: "N", open });
          } else if (Math.abs(doorway.y - (fp.y + fp.h - EXTERIOR_WALL / 2)) <= tol) {
            entrances.push({ cx: doorway.x, cy: fp.y + fp.h, width: doorway.width, side: "S", open });
          }
        } else {
          if (Math.abs(doorway.x - (fp.x + EXTERIOR_WALL / 2)) <= tol) {
            entrances.push({ cx: fp.x, cy: doorway.y, width: doorway.width, side: "W", open });
          } else if (Math.abs(doorway.x - (fp.x + fp.w - EXTERIOR_WALL / 2)) <= tol) {
            entrances.push({ cx: fp.x + fp.w, cy: doorway.y, width: doorway.width, side: "E", open });
          }
        }
      }
    }

    return entrances;
  }

  /** Walkway strips on the apron leading to each entrance (under the roofs). */
  private drawEntranceWalkways(): void {
    const g = this.groundGfx;

    for (const entrance of this.groundEntrances()) {
      const depth = entrance.open ? 38 : 30;
      const half = entrance.width / 2 + (entrance.open ? 2 : 4);
      const rect = this.entranceRect(entrance, depth, half);

      g.rect(rect.x, rect.y, rect.w, rect.h).fill({ color: COLOR.paper });
      g.rect(rect.x, rect.y, rect.w, rect.h).stroke({ color: COLOR.sidewalkJoint, width: 1.5 });

      // Roll-up ramps get hatch lines across the drive.
      if (entrance.open) {
        const horizontal = entrance.side === "N" || entrance.side === "S";
        for (let i = 1; i <= 3; i += 1) {
          if (horizontal) {
            const y = rect.y + (i * rect.h) / 4;
            g.moveTo(rect.x + 4, y).lineTo(rect.x + rect.w - 4, y).stroke({ color: COLOR.crosswalk, width: 2 });
          } else {
            const x = rect.x + (i * rect.w) / 4;
            g.moveTo(x, rect.y + 4).lineTo(x, rect.y + rect.h - 4).stroke({ color: COLOR.crosswalk, width: 2 });
          }
        }
      }
    }
  }

  /** Rect projecting outward from the facade at an entrance. */
  private entranceRect(
    entrance: { cx: number; cy: number; side: "N" | "S" | "E" | "W" },
    depth: number,
    half: number,
  ): Rect {
    switch (entrance.side) {
      case "N":
        return { x: entrance.cx - half, y: entrance.cy - depth, w: half * 2, h: depth };
      case "S":
        return { x: entrance.cx - half, y: entrance.cy, w: half * 2, h: depth };
      case "W":
        return { x: entrance.cx - depth, y: entrance.cy - half, w: depth, h: half * 2 };
      default:
        return { x: entrance.cx, y: entrance.cy - half, w: depth, h: half * 2 };
    }
  }

  /** Facade notch, door jambs, and dashed canopy — drawn above the roofs. */
  private drawEntranceMarks(): void {
    const g = this.entrancesGfx;

    for (const entrance of this.groundEntrances()) {
      const horizontal = entrance.side === "N" || entrance.side === "S";
      const half = entrance.width / 2;

      // Notch: erase the facade line across the gap so the opening reads from outside.
      const notch =
        entrance.side === "N"
          ? { x: entrance.cx - half, y: entrance.cy - 2, w: entrance.width, h: EXTERIOR_WALL + 4 }
          : entrance.side === "S"
            ? { x: entrance.cx - half, y: entrance.cy - EXTERIOR_WALL - 2, w: entrance.width, h: EXTERIOR_WALL + 4 }
            : entrance.side === "W"
              ? { x: entrance.cx - 2, y: entrance.cy - half, w: EXTERIOR_WALL + 4, h: entrance.width }
              : { x: entrance.cx - EXTERIOR_WALL - 2, y: entrance.cy - half, w: EXTERIOR_WALL + 4, h: entrance.width };
      g.rect(notch.x, notch.y, notch.w, notch.h).fill({ color: COLOR.paper });

      // Door jambs at both ends of the opening.
      if (horizontal) {
        for (const jx of [entrance.cx - half, entrance.cx + half]) {
          g.moveTo(jx, notch.y).lineTo(jx, notch.y + notch.h).stroke({ color: COLOR.wall, width: 2.5 });
        }
      } else {
        for (const jy of [entrance.cy - half, entrance.cy + half]) {
          g.moveTo(notch.x, jy).lineTo(notch.x + notch.w, jy).stroke({ color: COLOR.wall, width: 2.5 });
        }
      }

      if (entrance.open) {
        // Roll-up: dashed track across the opening.
        if (horizontal) {
          for (let x = entrance.cx - half + 3; x < entrance.cx + half - 3; x += 12) {
            g.rect(x, entrance.cy + (entrance.side === "N" ? 4 : -7), 7, 3).fill({ color: INK.soft });
          }
        } else {
          for (let y = entrance.cy - half + 3; y < entrance.cy + half - 3; y += 12) {
            g.rect(entrance.cx + (entrance.side === "W" ? 4 : -7), y, 3, 7).fill({ color: INK.soft });
          }
        }
        continue;
      }

      // Canopy: dashed three-sided outline projecting over the walkway.
      const canopy = this.entranceRect(entrance, 24, half + 6);
      const corners: Array<[number, number, number, number]> =
        entrance.side === "N"
          ? [
              [canopy.x, canopy.y + canopy.h, canopy.x, canopy.y],
              [canopy.x, canopy.y, canopy.x + canopy.w, canopy.y],
              [canopy.x + canopy.w, canopy.y, canopy.x + canopy.w, canopy.y + canopy.h],
            ]
          : entrance.side === "S"
            ? [
                [canopy.x, canopy.y, canopy.x, canopy.y + canopy.h],
                [canopy.x, canopy.y + canopy.h, canopy.x + canopy.w, canopy.y + canopy.h],
                [canopy.x + canopy.w, canopy.y + canopy.h, canopy.x + canopy.w, canopy.y],
              ]
            : entrance.side === "W"
              ? [
                  [canopy.x + canopy.w, canopy.y, canopy.x, canopy.y],
                  [canopy.x, canopy.y, canopy.x, canopy.y + canopy.h],
                  [canopy.x, canopy.y + canopy.h, canopy.x + canopy.w, canopy.y + canopy.h],
                ]
              : [
                  [canopy.x, canopy.y, canopy.x + canopy.w, canopy.y],
                  [canopy.x + canopy.w, canopy.y, canopy.x + canopy.w, canopy.y + canopy.h],
                  [canopy.x + canopy.w, canopy.y + canopy.h, canopy.x, canopy.y + canopy.h],
                ];

      for (const [x1, y1, x2, y2] of corners) {
        this.dashedSegment(g, x1, y1, x2, y2);
      }
    }
  }

  private dashedSegment(
    g: Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number = INK.soft,
    width = 1.5,
  ): void {
    const dash = 6;
    const gap = 4;
    const total = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / total;
    const uy = (y2 - y1) / total;

    for (let d = 0; d < total; d += dash + gap) {
      const end = Math.min(d + dash, total);
      g.moveTo(x1 + ux * d, y1 + uy * d)
        .lineTo(x1 + ux * end, y1 + uy * end)
        .stroke({ color, width });
    }
  }

  // --- Ground plane ---------------------------------------------------------

  private drawGround(): void {
    const g = this.groundGfx;
    g.rect(0, 0, this.map.width, this.map.height).fill({ color: COLOR.paper });

    this.drawSidewalks();
    this.drawBuildingAprons();
    this.drawParks();
    this.drawRoads();
    this.drawExtractionPads();
    this.drawEntranceWalkways();

    for (const wall of this.map.outdoor.walls) {
      g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: COLOR.border });
    }
  }

  private drawSidewalks(): void {
    const g = this.groundGfx;

    for (const road of this.map.outdoor.roads) {
      const horizontal = road.w >= road.h;

      if (horizontal) {
        g.rect(road.x, road.y - SIDEWALK, road.w, SIDEWALK).fill({ color: COLOR.sidewalk });
        g.rect(road.x, road.y + road.h, road.w, SIDEWALK).fill({ color: COLOR.sidewalk });
        for (let x = road.x + 40; x < road.x + road.w; x += 64) {
          g.rect(x, road.y - SIDEWALK, 1.5, SIDEWALK).fill({ color: COLOR.sidewalkJoint });
          g.rect(x, road.y + road.h, 1.5, SIDEWALK).fill({ color: COLOR.sidewalkJoint });
        }
      } else {
        g.rect(road.x - SIDEWALK, road.y, SIDEWALK, road.h).fill({ color: COLOR.sidewalk });
        g.rect(road.x + road.w, road.y, SIDEWALK, road.h).fill({ color: COLOR.sidewalk });
        for (let y = road.y + 40; y < road.y + road.h; y += 64) {
          g.rect(road.x - SIDEWALK, y, SIDEWALK, 1.5).fill({ color: COLOR.sidewalkJoint });
          g.rect(road.x + road.w, y, SIDEWALK, 1.5).fill({ color: COLOR.sidewalkJoint });
        }
      }
    }
  }

  private drawBuildingAprons(): void {
    const g = this.groundGfx;
    const pad = 16;

    for (const building of this.map.buildings) {
      const fp = building.footprint;
      g.roundRect(fp.x - pad, fp.y - pad, fp.w + pad * 2, fp.h + pad * 2, 6).fill({ color: COLOR.sidewalk });
      g.roundRect(fp.x - pad, fp.y - pad, fp.w + pad * 2, fp.h + pad * 2, 6).stroke({ color: COLOR.sidewalkJoint, width: 1.5 });
    }
  }

  private drawParks(): void {
    const g = this.groundGfx;

    for (const park of this.map.outdoor.parks) {
      g.roundRect(park.x, park.y, park.w, park.h, 12).fill({ color: COLOR.parkGround });
      g.roundRect(park.x, park.y, park.w, park.h, 12).stroke({ color: COLOR.parkEdge, width: 2 });

      // Two crossing walking paths.
      g.moveTo(park.x + 20, park.y + park.h * 0.72)
        .quadraticCurveTo(park.x + park.w * 0.5, park.y + park.h * 0.5, park.x + park.w - 20, park.y + park.h * 0.22)
        .stroke({ color: COLOR.parkPath, width: 15, cap: "round" });
      g.moveTo(park.x + park.w * 0.32, park.y + 20)
        .quadraticCurveTo(park.x + park.w * 0.42, park.y + park.h * 0.6, park.x + park.w * 0.72, park.y + park.h - 20)
        .stroke({ color: COLOR.parkPath, width: 15, cap: "round" });
    }
  }

  private roadIntersections(): Rect[] {
    const horizontal = this.map.outdoor.roads.filter((road) => road.w >= road.h);
    const vertical = this.map.outdoor.roads.filter((road) => road.h > road.w);
    const intersections: Rect[] = [];

    for (const h of horizontal) {
      for (const v of vertical) {
        const x = Math.max(h.x, v.x);
        const y = Math.max(h.y, v.y);
        const right = Math.min(h.x + h.w, v.x + v.w);
        const bottom = Math.min(h.y + h.h, v.y + v.h);

        if (right > x && bottom > y) {
          intersections.push({ x, y, w: right - x, h: bottom - y });
        }
      }
    }

    return intersections;
  }

  private drawRoads(): void {
    const g = this.groundGfx;
    const intersections = this.roadIntersections();

    for (const road of this.map.outdoor.roads) {
      g.rect(road.x, road.y, road.w, road.h).fill({ color: COLOR.asphalt });
    }

    for (const road of this.map.outdoor.roads) {
      const horizontal = road.w >= road.h;
      const gaps = intersections.map((inter) =>
        horizontal ? { start: inter.x, end: inter.x + inter.w } : { start: inter.y, end: inter.y + inter.h },
      );

      if (horizontal) {
        for (const [start, end] of this.spans(road.x, road.x + road.w, gaps)) {
          g.rect(start, road.y - 1, end - start, 2.5).fill({ color: COLOR.curb });
          g.rect(start, road.y + road.h - 1.5, end - start, 2.5).fill({ color: COLOR.curb });
        }
        this.dashLine(road.x + 16, road.x + road.w - 16, road.y + road.h / 2, gaps, true);
      } else {
        for (const [start, end] of this.spans(road.y, road.y + road.h, gaps)) {
          g.rect(road.x - 1, start, 2.5, end - start).fill({ color: COLOR.curb });
          g.rect(road.x + road.w - 1.5, start, 2.5, end - start).fill({ color: COLOR.curb });
        }
        this.dashLine(road.y + 16, road.y + road.h - 16, road.x + road.w / 2, gaps, false);
      }
    }

    for (const inter of intersections) {
      this.drawCrosswalks(inter);
    }
  }

  private spans(start: number, end: number, gaps: Array<{ start: number; end: number }>): Array<[number, number]> {
    const sorted = gaps
      .map((gap) => ({ start: Math.max(start, gap.start), end: Math.min(end, gap.end) }))
      .filter((gap) => gap.end > gap.start)
      .sort((a, b) => a.start - b.start);
    const result: Array<[number, number]> = [];
    let cursor = start;

    for (const gap of sorted) {
      if (gap.start > cursor) {
        result.push([cursor, gap.start]);
      }
      cursor = Math.max(cursor, gap.end);
    }

    if (cursor < end) {
      result.push([cursor, end]);
    }

    return result;
  }

  private dashLine(start: number, end: number, cross: number, gaps: Array<{ start: number; end: number }>, horizontal: boolean): void {
    const g = this.groundGfx;
    const dash = 26;
    const gapLen = 22;

    for (let pos = start; pos < end; pos += dash + gapLen) {
      const segEnd = Math.min(pos + dash, end);

      if (gaps.some((gap) => segEnd > gap.start - 30 && pos < gap.end + 30)) {
        continue;
      }

      if (horizontal) {
        g.rect(pos, cross - 2, segEnd - pos, 4).fill({ color: COLOR.laneDash });
      } else {
        g.rect(cross - 2, pos, 4, segEnd - pos).fill({ color: COLOR.laneDash });
      }
    }
  }

  private drawCrosswalks(inter: Rect): void {
    const g = this.groundGfx;
    const stripe = 7;
    const gap = 8;
    const depth = 24;

    for (const edgeX of [inter.x - depth, inter.x + inter.w + depth - stripe]) {
      for (let i = 0; i < 3; i += 1) {
        const sx = edgeX + (edgeX < inter.x ? i : -i) * (stripe + gap);
        g.rect(sx, inter.y + 6, stripe, inter.h - 12).fill({ color: COLOR.crosswalk });
      }
    }

    for (const edgeY of [inter.y - depth, inter.y + inter.h + depth - stripe]) {
      for (let i = 0; i < 3; i += 1) {
        const sy = edgeY + (edgeY < inter.y ? i : -i) * (stripe + gap);
        g.rect(inter.x + 6, sy, inter.w - 12, stripe).fill({ color: COLOR.crosswalk });
      }
    }

    // Stop lines just outside the crosswalks.
    g.rect(inter.x - depth - 14, inter.y + inter.h / 2, 5, inter.h / 2 - 6).fill({ color: COLOR.stopLine });
    g.rect(inter.x + inter.w + depth + 9, inter.y + 6, 5, inter.h / 2 - 6).fill({ color: COLOR.stopLine });
    g.rect(inter.x + 6, inter.y - depth - 14, inter.w / 2 - 6, 5).fill({ color: COLOR.stopLine });
    g.rect(inter.x + inter.w / 2, inter.y + inter.h + depth + 9, inter.w / 2 - 6, 5).fill({ color: COLOR.stopLine });
  }

  private drawExtractionPads(): void {
    const g = this.groundGfx;

    for (const point of this.map.extractionPoints) {
      const { x, y, w, h } = point.rect;

      g.roundRect(x, y, w, h, 8).fill({ color: COLOR.paper });
      g.roundRect(x, y, w, h, 8).stroke({ color: COLOR.extract, width: 2.5 });

      // Diagonal hatch.
      for (let offset = 18; offset < w + h - 18; offset += 16) {
        const x1 = Math.max(x + 4, x + offset - h + 4);
        const y1 = Math.min(y + h - 4, y + offset - 4);
        const x2 = Math.min(x + w - 4, x + offset - 4);
        const y2 = Math.max(y + 4, y + offset - w + 4);
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: COLOR.sidewalkJoint, width: 1.5 });
      }

      // Corner brackets.
      const b = 16;
      for (const [cx, cy, dx, dy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ] as Array<[number, number, number, number]>) {
        g.moveTo(cx + dx * 4, cy + dy * (4 + b))
          .lineTo(cx + dx * 4, cy + dy * 4)
          .lineTo(cx + dx * (4 + b), cy + dy * 4)
          .stroke({ color: COLOR.extract, width: 3 });
      }

      // Center beacon glyph.
      const cx = x + w / 2;
      const cy = y + h / 2;
      g.circle(cx, cy, 13).stroke({ color: COLOR.extract, width: 2 });
      g.moveTo(cx, cy + 7).lineTo(cx, cy - 7).stroke({ color: COLOR.extract, width: 2 });
      g.moveTo(cx - 5, cy - 2).lineTo(cx, cy - 8).lineTo(cx + 5, cy - 2).stroke({ color: COLOR.extract, width: 2 });
    }
  }

  private drawOutdoorObjects(): void {
    const sorted = [...this.map.outdoor.objects].sort((a, b) => (a.kind === "tree" ? 1 : 0) - (b.kind === "tree" ? 1 : 0));

    for (const object of sorted) {
      drawObject(this.outdoorObjectsGfx, object);
    }
  }

  private drawStreetNames(): void {
    for (const road of this.map.outdoor.roads) {
      const horizontal = road.w >= road.h;
      const name = road.id.replace(/-/g, " ").toUpperCase();
      const positions = horizontal
        ? [
            { x: road.x + road.w * 0.18, y: road.y + road.h / 2 },
            { x: road.x + road.w * 0.8, y: road.y + road.h / 2 },
          ]
        : [
            { x: road.x + road.w / 2, y: road.y + road.h * 0.22 },
            { x: road.x + road.w / 2, y: road.y + road.h * 0.82 },
          ];

      for (const pos of positions) {
        const label = new Text({
          text: name,
          style: {
            fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
            fontSize: 19,
            fontWeight: "600",
            letterSpacing: 7,
            fill: COLOR.streetName,
          },
        });
        label.resolution = 2;
        label.anchor.set(0.5);
        label.position.set(pos.x, pos.y);
        if (!horizontal) {
          label.rotation = -Math.PI / 2;
        }
        this.labelsLayer.addChild(label);
      }
    }
  }

  private drawExtractionLabels(): void {
    for (const point of this.map.extractionPoints) {
      const label = new Text({
        text: point.name,
        style: {
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          fontSize: 12,
          fontWeight: "700",
          letterSpacing: 3,
          fill: COLOR.extract,
        },
      });
      label.resolution = 2;
      label.anchor.set(0.5, 0);
      label.position.set(point.rect.x + point.rect.w / 2, point.rect.y + point.rect.h + 8);
      this.labelsLayer.addChild(label);
    }
  }

  // --- Buildings --------------------------------------------------------------

  private buildBuilding(building: Building): void {
    const floors: FloorView[] = [];

    for (const floor of building.floors) {
      const view = this.buildFloorView(building, floor);
      view.visible = false;
      this.buildingsLayer.addChild(view);
      floors.push({ floor, view });
    }

    const roof = this.buildGenericRoof(building);
    this.buildingsLayer.addChild(roof);

    const label = new Text({
      text: building.name,
      style: {
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        fontSize: 16,
        fontWeight: "700",
        letterSpacing: 4,
        fill: COLOR.label,
      },
    });
    label.resolution = 2;
    label.anchor.set(0.5, 0.5);
    label.position.set(building.footprint.x + building.footprint.w / 2, building.footprint.y + building.footprint.h / 2);
    this.labelsLayer.addChild(label);

    this.buildingViews.push({ building, roof, floors, label });
  }

  private buildGenericRoof(building: Building): Container {
    const container = new Container();
    const g = new Graphics();
    const fp = building.footprint;

    g.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: COLOR.roofPlate });
    g.rect(fp.x, fp.y, fp.w, fp.h).stroke({ color: COLOR.wall, width: 2.5 });
    // Parapet inset.
    g.roundRect(fp.x + 11, fp.y + 11, fp.w - 22, fp.h - 22, 3).stroke({ color: COLOR.roofSeam, width: 2 });
    // Panel seams.
    for (let x = fp.x + fp.w / 3; x < fp.x + fp.w - 20; x += fp.w / 3) {
      g.moveTo(x, fp.y + 13).lineTo(x, fp.y + fp.h - 13).stroke({ color: COLOR.roofSeam, width: 1.5 });
    }

    drawObject(g, { id: `${building.id}-roof-hvac-1`, kind: "hvac", x: fp.x + fp.w - 96, y: fp.y + 28, w: 58, h: 40 });
    drawObject(g, { id: `${building.id}-roof-hvac-2`, kind: "hvac", x: fp.x + fp.w - 96, y: fp.y + 84, w: 58, h: 40 });
    drawObject(g, { id: `${building.id}-roof-vent`, kind: "vent", x: fp.x + 34, y: fp.y + fp.h - 60, w: 22, h: 22 });

    container.addChild(g);
    return container;
  }

  private buildFloorView(building: Building, floor: FloorPlan): Container {
    const container = new Container();
    const g = new Graphics();
    const fp = building.footprint;
    const isRoof = floor.label === "ROOF";
    const isBasement = floor.label === "B1";

    // Floor plate.
    const plate = isRoof ? COLOR.roofPlate : isBasement ? COLOR.basementPlate : COLOR.floorPlate;
    g.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: plate });

    if (!isRoof) {
      // Fine floor grid, architectural-plan style.
      for (let x = fp.x + 60; x < fp.x + fp.w - 10; x += 60) {
        g.moveTo(x, fp.y + 6).lineTo(x, fp.y + fp.h - 6).stroke({ color: COLOR.floorSeam, width: 1 });
      }
      for (let y = fp.y + 60; y < fp.y + fp.h - 10; y += 60) {
        g.moveTo(fp.x + 6, y).lineTo(fp.x + fp.w - 6, y).stroke({ color: COLOR.floorSeam, width: 1 });
      }
    } else {
      g.roundRect(fp.x + 11, fp.y + 11, fp.w - 22, fp.h - 22, 3).stroke({ color: COLOR.roofSeam, width: 2 });
    }

    // Objects under walls so partitions read crisply on top.
    for (const object of floor.objects) {
      drawObject(g, object);
    }

    // Stairs.
    for (const stair of floor.stairs) {
      this.drawStair(g, stair);
      const tag = new Text({
        text: stair.direction === "up" ? "UP" : "DN",
        style: {
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 2,
          fill: COLOR.label,
        },
      });
      tag.resolution = 2;
      this.placeStairTag(tag, stair);
      container.addChild(tag);
    }

    // Walls (poché) + door swings + windows.
    for (const wall of floor.walls) {
      g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: COLOR.wall });
    }

    for (const doorway of floor.doorways) {
      this.drawDoorway(g, doorway, this.doorwayMode(doorway, floor, fp));
    }

    if (!isRoof && !isBasement) {
      for (const wall of floor.walls) {
        if (Math.min(wall.w, wall.h) === EXTERIOR_WALL) {
          this.drawWindows(g, wall);
        }
      }
    }

    container.addChildAt(g, 0);
    return container;
  }

  /** Which end of the run the bot enters from on this floor. */
  private stairEntryEnd(stair: StairLink): "N" | "S" | "E" | "W" {
    const { entry, vertical } = stairHalves(stair);
    const entryLow = entry.x === stair.rect.x && entry.y === stair.rect.y;
    return vertical ? (entryLow ? "N" : "S") : entryLow ? "W" : "E";
  }

  private placeStairTag(tag: Text, stair: StairLink): void {
    const { x, y, w, h } = stair.rect;
    const end = this.stairEntryEnd(stair);

    if (end === "N") {
      tag.anchor.set(0.5, 1);
      tag.position.set(x + w / 2, y - 4);
    } else if (end === "S") {
      tag.anchor.set(0.5, 0);
      tag.position.set(x + w / 2, y + h + 4);
    } else if (end === "W") {
      tag.anchor.set(1, 0.5);
      tag.position.set(x - 5, y + h / 2);
    } else {
      tag.anchor.set(0, 0.5);
      tag.position.set(x + w + 5, y + h / 2);
    }
  }

  private drawStairTreads(g: Graphics, half: Rect, vertical: boolean, dashed: boolean): void {
    if (vertical) {
      for (let ty = half.y + 12; ty < half.y + half.h - 4; ty += 12) {
        if (dashed) {
          this.dashedSegment(g, half.x + 3, ty, half.x + half.w - 3, ty, INK.faint, 1.25);
        } else {
          g.moveTo(half.x + 2, ty).lineTo(half.x + half.w - 2, ty).stroke({ color: INK.soft, width: 1.25 });
        }
      }
    } else {
      for (let tx = half.x + 12; tx < half.x + half.w - 4; tx += 12) {
        if (dashed) {
          this.dashedSegment(g, tx, half.y + 3, tx, half.y + half.h - 3, INK.faint, 1.25);
        } else {
          g.moveTo(tx, half.y + 2).lineTo(tx, half.y + half.h - 2).stroke({ color: INK.soft, width: 1.25 });
        }
      }
    }
  }

  /**
   * The half of the run beyond the break line: the flight belonging to the
   * other floor. Drawn in the floor plan AND redrawn above the bot layer so
   * bots crossing the break line slide underneath it.
   */
  private drawStairExitHalf(g: Graphics, stair: StairLink): void {
    const { entry, exit, vertical } = stairHalves(stair);

    g.rect(exit.x, exit.y, exit.w, exit.h).fill({ color: INK.fill });
    g.rect(exit.x, exit.y, exit.w, exit.h).stroke({ color: COLOR.wall, width: 1.5 });
    this.drawStairTreads(g, exit, vertical, true);

    // Break line: the plan-convention zigzag at the cut plane.
    if (vertical) {
      const my = exit.y === entry.y + entry.h ? exit.y : exit.y + exit.h;
      const { x, w } = stair.rect;
      g.moveTo(x, my)
        .lineTo(x + w * 0.38, my)
        .lineTo(x + w * 0.48, my - 8)
        .lineTo(x + w * 0.58, my + 8)
        .lineTo(x + w * 0.68, my)
        .lineTo(x + w, my)
        .stroke({ color: COLOR.wall, width: 2 });
    } else {
      const mx = exit.x === entry.x + entry.w ? exit.x : exit.x + exit.w;
      const { y, h } = stair.rect;
      g.moveTo(mx, y)
        .lineTo(mx, y + h * 0.38)
        .lineTo(mx - 8, y + h * 0.48)
        .lineTo(mx + 8, y + h * 0.58)
        .lineTo(mx, y + h * 0.68)
        .lineTo(mx, y + h)
        .stroke({ color: COLOR.wall, width: 2 });
    }
  }

  private drawStair(g: Graphics, stair: StairLink): void {
    const { x, y, w, h } = stair.rect;
    const { entry, vertical } = stairHalves(stair);

    g.rect(x, y, w, h).fill({ color: INK.fill });
    g.rect(x, y, w, h).stroke({ color: COLOR.wall, width: 2 });

    // Solid treads on this floor's side of the break line.
    this.drawStairTreads(g, entry, vertical, false);

    // Travel arrow: from the entry end toward the break line.
    const cx = entry.x + entry.w / 2;
    const cy = entry.y + entry.h / 2;
    const end = this.stairEntryEnd(stair);

    if (vertical) {
      const from = end === "N" ? entry.y + 10 : entry.y + entry.h - 10;
      const to = end === "N" ? entry.y + entry.h - 8 : entry.y + 8;
      const sign = to > from ? 1 : -1;
      g.moveTo(cx, from).lineTo(cx, to).stroke({ color: COLOR.wall, width: 2 });
      g.moveTo(cx - 6, to - sign * 8).lineTo(cx, to).lineTo(cx + 6, to - sign * 8).stroke({ color: COLOR.wall, width: 2 });
    } else {
      const from = end === "W" ? entry.x + 10 : entry.x + entry.w - 10;
      const to = end === "W" ? entry.x + entry.w - 8 : entry.x + 8;
      const sign = to > from ? 1 : -1;
      g.moveTo(from, cy).lineTo(to, cy).stroke({ color: COLOR.wall, width: 2 });
      g.moveTo(to - sign * 8, cy - 6).lineTo(to, cy).lineTo(to - sign * 8, cy + 6).stroke({ color: COLOR.wall, width: 2 });
    }

    this.drawStairExitHalf(g, stair);
  }

  /** Bounding box the swing arc would sweep on the default or flipped side. */
  private swingBounds(doorway: Doorway, flipped: boolean): Rect {
    const w = doorway.width;

    if (doorway.dir === "h") {
      return { x: doorway.x - w / 2, y: flipped ? doorway.y - w : doorway.y, w, h: w };
    }

    return { x: flipped ? doorway.x - w : doorway.x, y: doorway.y - w / 2, w, h: w };
  }

  /**
   * Doors must not swing over a stair flight (both plan convention and
   * clutter): flip the leaf to the other side of the wall, and if that side
   * is also a stair or outside the building, draw a plain threshold instead.
   */
  private doorwayMode(doorway: Doorway, floor: FloorPlan, footprint: Rect): "swing" | "flipped" | "plain" {
    if (doorway.open) {
      return "swing"; // open doorways never draw a leaf anyway
    }

    const sweepsStairs = (bounds: Rect) =>
      floor.stairs.some(
        (stair) =>
          bounds.x < stair.rect.x + stair.rect.w + 2 &&
          bounds.x + bounds.w > stair.rect.x - 2 &&
          bounds.y < stair.rect.y + stair.rect.h + 2 &&
          bounds.y + bounds.h > stair.rect.y - 2,
      );

    if (!sweepsStairs(this.swingBounds(doorway, false))) {
      return "swing";
    }

    const flipped = this.swingBounds(doorway, true);
    const insideBuilding =
      flipped.x >= footprint.x &&
      flipped.y >= footprint.y &&
      flipped.x + flipped.w <= footprint.x + footprint.w &&
      flipped.y + flipped.h <= footprint.y + footprint.h;

    return insideBuilding && !sweepsStairs(flipped) ? "flipped" : "plain";
  }

  private drawDoorway(g: Graphics, doorway: Doorway, mode: "swing" | "flipped" | "plain" = "swing"): void {
    const w = doorway.width;

    if (doorway.open) {
      // Roll-up / open archway: dashed track across the gap.
      if (doorway.dir === "h") {
        for (let x = doorway.x - w / 2 + 3; x < doorway.x + w / 2 - 3; x += 12) {
          g.rect(x, doorway.y - 1.5, 7, 3).fill({ color: INK.soft });
        }
      } else {
        for (let y = doorway.y - w / 2 + 3; y < doorway.y + w / 2 - 3; y += 12) {
          g.rect(doorway.x - 1.5, y, 3, 7).fill({ color: INK.soft });
        }
      }
      return;
    }

    if (mode === "plain") {
      // Threshold only: keeps the opening readable without an arc.
      if (doorway.dir === "h") {
        g.moveTo(doorway.x - w / 2 + 2, doorway.y).lineTo(doorway.x + w / 2 - 2, doorway.y).stroke({ color: INK.faint, width: 1.5 });
      } else {
        g.moveTo(doorway.x, doorway.y - w / 2 + 2).lineTo(doorway.x, doorway.y + w / 2 - 2).stroke({ color: INK.faint, width: 1.5 });
      }
      return;
    }

    // Architectural door swing: leaf + quarter arc from the hinge.
    const sign = mode === "flipped" ? -1 : 1;

    if (doorway.dir === "h") {
      const hx = doorway.x - w / 2;
      const hy = doorway.y;
      g.moveTo(hx, hy).lineTo(hx, hy + sign * w).stroke({ color: INK.soft, width: 1.5 });
      g.moveTo(hx, hy + sign * w)
        .arc(hx, hy, w, sign * (Math.PI / 2), 0, sign > 0)
        .stroke({ color: INK.faint, width: 1.25 });
    } else {
      const hx = doorway.x;
      const hy = doorway.y - w / 2;
      g.moveTo(hx, hy).lineTo(hx + sign * w, hy).stroke({ color: INK.soft, width: 1.5 });
      g.moveTo(hx + sign * w, hy)
        .arc(hx, hy, w, sign > 0 ? 0 : Math.PI, Math.PI / 2, sign < 0)
        .stroke({ color: INK.faint, width: 1.25 });
    }
  }

  private drawWindows(g: Graphics, wall: WallSegment): void {
    const horizontal = wall.w >= wall.h;
    const span = horizontal ? wall.w : wall.h;
    const winLen = 30;
    const minGap = 30;
    const margin = 16;
    const usable = span - margin * 2;

    if (usable < winLen) {
      return;
    }

    const count = Math.max(1, Math.floor((usable + minGap) / (winLen + minGap)));
    const total = count * winLen + (count - 1) * minGap;
    const start = (span - total) / 2;

    for (let i = 0; i < count; i += 1) {
      const offset = start + i * (winLen + minGap);

      if (horizontal) {
        const wx = wall.x + offset;
        g.rect(wx, wall.y + 2, winLen, wall.h - 4).fill({ color: COLOR.glass });
        g.moveTo(wx, wall.y + wall.h / 2).lineTo(wx + winLen, wall.y + wall.h / 2).stroke({ color: COLOR.wall, width: 1.25 });
        g.moveTo(wx + winLen / 2, wall.y + 2).lineTo(wx + winLen / 2, wall.y + wall.h - 2).stroke({ color: COLOR.wall, width: 1.25 });
      } else {
        const wy = wall.y + offset;
        g.rect(wall.x + 2, wy, wall.w - 4, winLen).fill({ color: COLOR.glass });
        g.moveTo(wall.x + wall.w / 2, wy).lineTo(wall.x + wall.w / 2, wy + winLen).stroke({ color: COLOR.wall, width: 1.25 });
        g.moveTo(wall.x + 2, wy + winLen / 2).lineTo(wall.x + wall.w - 2, wy + winLen / 2).stroke({ color: COLOR.wall, width: 1.25 });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic entities
  // ---------------------------------------------------------------------------

  private drawExtractionPulse(snapshot: GameSnapshot): void {
    const extract = snapshot.coverages.find((coverage) => coverage.kind === "extract");

    if (!extract) {
      return;
    }

    const point = this.map.extractionPoints.find((item) => item.id === extract.targetId);

    if (!point) {
      return;
    }

    const cx = point.rect.x + point.rect.w / 2;
    const cy = point.rect.y + point.rect.h / 2;
    const progress = clamp01(extract.progressMs / extract.durationMs);
    const pulse = 1 + 0.06 * Math.sin(snapshot.timeMs / 120);

    this.dynamicGfx.circle(cx, cy, (point.rect.w / 2 + 10) * pulse).stroke({ color: COLOR.extract, width: 2, alpha: 0.35 });
    this.drawProgressRing(this.dynamicGfx, { x: cx, y: cy }, point.rect.w / 2 + 4, progress, COLOR.extract, 4);
  }

  private drawDots(snapshot: GameSnapshot, playerContext: string): void {
    for (const dot of snapshot.dots) {
      if (!dot.active || this.contextKey(dot.floorId, dot.position) !== playerContext) {
        continue;
      }

      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).fill({ color: colorToNumber(dot.color) });
      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).stroke({ color: 0x111111, width: 2 });

      const coverage = snapshot.coverages.find((item) => item.kind === "capture" && item.targetId === dot.id);
      if (coverage) {
        this.drawProgressRing(this.maskedGfx, dot.position, dot.radius + 8, coverage.progressMs / coverage.durationMs, 0x111111, 3);
      }
    }
  }

  private drawBots(snapshot: GameSnapshot, playerContext: string): void {
    const sorted = [...snapshot.bots].sort((a, b) => a.position.y - b.position.y);
    const player = snapshot.bots.find((bot) => bot.id === snapshot.playerId);

    for (const bot of sorted) {
      if (bot.state === "consumed") {
        continue;
      }

      const squad = bot.team === "player" || bot.team === "ally";
      const sameArena = this.contextKey(bot.floorId, bot.position) === playerContext;

      if (squad) {
        // Squad members render through walls and across floors, but only at
        // full strength when actually seen — otherwise as a faded ghost, so
        // "I see them" and "I know where they are" read differently.
        const seen =
          bot.id === snapshot.playerId ||
          (sameArena && (!player || hasLineOfSight(this.map, playerContext, player.position, bot.position)));
        this.drawBotBody(this.dynamicGfx, bot, snapshot, seen ? 1 : 0.35);
      } else if (sameArena) {
        // Enemies render into the masked layer: hidden outside line of sight.
        this.drawBotBody(this.maskedGfx, bot, snapshot, 1);
      }
    }
  }

  private drawBotBody(g: Graphics, bot: DotBotEntity, snapshot: GameSnapshot, fade: number): void {
    const color = colorToNumber(bot.color);
    const coreRadius = bot.state === "downed" ? bot.radius * 0.34 : bot.radius * 0.4;
    const alpha = (bot.state === "downed" ? 0.72 : 1) * fade;

    this.drawShieldSegments(g, bot, bot.state === "alive" ? color : 0x111111, fade);

    g.circle(bot.position.x, bot.position.y, coreRadius).fill({ color, alpha: (bot.state === "downed" ? 0.28 : 0.95) * fade });
    g.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color: 0x111111, width: 2, alpha });

    if (bot.dashActiveMs > 0) {
      g.circle(bot.position.x, bot.position.y, bot.radius - 1).stroke({ color, width: 3, alpha: 0.45 * fade });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      g.circle(bot.position.x, bot.position.y, bot.radius - 3).stroke({ color: 0x111111, width: 2, alpha: 0.18 * fade });
    }

    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      this.drawProgressRing(
        g,
        bot.position,
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        coverage.kind === "revive" ? 0x2f80ed : 0xeb5757,
        4,
      );
    }
  }

  private drawShieldSegments(g: Graphics, bot: DotBotEntity, color: number, fade: number): void {
    const start = -Math.PI / 2;
    const gap = 0.24;
    const segment = (Math.PI * 2 - gap * 3) / 3;
    const shieldRadius = bot.radius * 0.78;
    const filledWidth = bot.state === "downed" ? 2 : 5;

    for (let index = 0; index < bot.maxShields; index += 1) {
      const angleStart = start + index * (segment + gap);
      const filled = index < bot.shields;
      this.drawArcStroke(g, bot.position, shieldRadius, angleStart, angleStart + segment, {
        color: filled ? color : 0x111111,
        width: filled ? filledWidth : 2,
        alpha: (filled ? 1 : 0.3) * fade,
      });
    }
  }

  // --- Noise rings -----------------------------------------------------------

  private drawNoises(snapshot: GameSnapshot, player: DotBotEntity): void {
    const g = this.dynamicGfx;

    for (const noise of snapshot.noises) {
      const heard = classifyNoise(this.map, player.floorId, player.position, noise.floorId, noise.position, noise.loudness);

      if (!heard) {
        continue;
      }

      const progress = clamp01(noise.ageMs / noise.ttlMs);
      const radius = 16 + progress * (46 + noise.loudness * 84);
      const alpha = (1 - progress) * 0.55;

      if (heard.muffled) {
        this.dashedCircle(g, noise.position, radius, alpha);
      } else {
        g.circle(noise.position.x, noise.position.y, radius).stroke({ color: INK.soft, width: 2, alpha });
      }

      if (heard.vertical !== 0) {
        this.drawChevron(g, noise.position, heard.vertical, alpha);
      }
    }
  }

  private dashedCircle(g: Graphics, center: Vec2, radius: number, alpha: number): void {
    const dashes = 12;

    for (let i = 0; i < dashes; i += 1) {
      const start = (Math.PI * 2 * i) / dashes;
      const end = start + (Math.PI * 2 * 0.55) / dashes;
      this.drawArcStroke(g, center, radius, start, end, { color: INK.soft, width: 2, alpha });
    }
  }

  /** Small ^ (above) or v (below) at the ring center. */
  private drawChevron(g: Graphics, center: Vec2, vertical: -1 | 1, alpha: number): void {
    const sign = vertical === 1 ? -1 : 1;
    g.moveTo(center.x - 7, center.y + sign * -4)
      .lineTo(center.x, center.y + sign * 4)
      .lineTo(center.x + 7, center.y + sign * -4)
      .stroke({ color: INK.soft, width: 2.5, alpha });
  }

  private drawProgressRing(g: Graphics, center: Vec2, radius: number, progress: number, color: number, width: number): void {
    const clamped = clamp01(progress);
    this.drawArcStroke(g, center, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2, { color, width, alpha: 0.95 });
  }

  private drawArcStroke(
    g: Graphics,
    center: Vec2,
    radius: number,
    startAngle: number,
    endAngle: number,
    strokeStyle: { color: number; width: number; alpha: number },
  ): void {
    g.beginPath()
      .moveTo(center.x + Math.cos(startAngle) * radius, center.y + Math.sin(startAngle) * radius)
      .arc(center.x, center.y, radius, startAngle, endAngle)
      .stroke(strokeStyle);
  }
}
