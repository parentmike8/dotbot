import { Container, Graphics, Text } from "pixi.js";
import { isGroundFloor, stairGuardRects, stairHalves } from "@dotbot/game/mapModel";
import type {
  Building,
  Doorway,
  FloorPlan,
  InteractionDot,
  MapDocument,
  Rect,
  PlacementSlot,
  StairLink,
  Vec2,
  WallSegment,
  WindowBand,
} from "@dotbot/game/types";
import { drawObject } from "./glyphs";
import { buildFloorModel, drawStairHead } from "./model/modelFloor";
import { buildOutdoorModel } from "./model/modelOutdoor";
import { buildRoofModel } from "./model/modelRoof";
import { SHADOW_ALPHA, type ShadowPad } from "./model/tone";
import { drawDotDisc } from "./dotArt";
import { doorwayStyle, type DoorwayStyle } from "./doorwayStyle";
import { DOT_COLOR, INK, PAPER, strokes, WEIGHT } from "./style";

/**
 * Static map drawing, shared verbatim between the live game and Map Studio.
 *
 * Everything here derives from MapDocument data and the style.ts hierarchy.
 * No gameplay state, no procedural clutter: if a mark isn't explained by the
 * data or by plan-drawing convention, it doesn't belong in this file.
 *
 * Two languages live here for now. `lit-model` draws the game; `plan` is the
 * pen-plotter drawing it replaced, still used by the player base until the
 * remaining base glyphs are ported. The plan path is deliberately reduced to
 * what the base actually needs — a single building on a bare sheet — so the
 * city-scale drafting apparatus (roads, kerbs, crossings, street names) is gone
 * rather than sitting unreachable.
 */

export type FloorArt = {
  floor: FloorPlan;
  /** Parent container; visibility toggled per active floor. */
  view: Container;
  /**
   * Plate, walls, doorway structure, windows, stairs. A Graphics in the line-plan
   * language; a layer group in the lit-model language, which needs several
   * stacked passes for slab, wear, light and shadow.
   */
  architecture: Container;
  /** All furniture and fixtures. */
  furniture: Container;
  /**
   * Marks that render after bots. Empty in both current languages — nothing is
   * drawn in perspective — but it is the fog mask's target, so it always exists.
   */
  foreground: Container;
  /** Individually addressable so fabrication can temporarily replace one glyph. */
  objectViews: Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>;
  /** Addressable stair fixtures reuse the fabrication draw-on hook when an expansion commissions. */
  stairViews: Map<string, { stair: StairLink; view: Container }>;
  /** Door swings, stair tags, and other plan notation. */
  annotation: Container;
  annotationGfx: Graphics;
};

export type BuildingArt = {
  building: Building;
  /** Exterior (roof) view for buildings without an authored ROOF plan. */
  roof: Container;
  /** Street-view entrance marks; visible only when viewed from outside. */
  entranceMarks: Container;
  floors: FloorArt[];
  label: Text;
};

export type MapArt = {
  root: Container;
  ground: Container;
  /** Non-solid outdoor dressing (walk-through). */
  outdoorDetail: Container;
  /** Solid outdoor objects. */
  outdoorObjects: Container;
  /** Marks that must cover a bot passing behind them, and the fog mask's target. */
  foreground: Container;
  outdoorForeground: Container;
  buildingsLayer: Container;
  buildings: BuildingArt[];
  labels: Container;
};

const LABEL_FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildMapArt(map: MapDocument): MapArt {
  const root = new Container();
  const ground = new Container();
  const groundGfx = new Graphics();
  const outdoorDetail = new Container();
  const outdoorDetailGfx = new Graphics();
  const outdoorObjects = new Container();
  const outdoorObjectsGfx = new Graphics();
  const foreground = new Container();
  const outdoorForeground = new Container();
  const buildingsLayer = new Container();
  const labels = new Container();

  ground.addChild(groundGfx);
  outdoorDetail.addChild(outdoorDetailGfx);
  outdoorObjects.addChild(outdoorObjectsGfx);
  foreground.addChild(outdoorForeground);

  if (map.visualTheme === "lit-model") {
    const outdoors = buildOutdoorModel(map);
    ground.addChild(outdoors.ground);
    outdoorDetail.addChild(outdoors.detail);
    outdoorObjects.addChild(outdoors.objects);
  } else {
    drawGround(groundGfx, map);
    drawOutdoorObjects(outdoorDetailGfx, outdoorObjectsGfx, map);
  }

  const buildings = map.buildings.map((building) => buildBuildingArt(
    building, buildingsLayer, labels, map.placementSlots, map.interactionDots, map, foreground,
  ));
  drawExtractionLabels(labels, map);
  root.addChild(ground, outdoorDetail, outdoorObjects, buildingsLayer, labels);

  return {
    root, ground, outdoorDetail, outdoorObjects, foreground, outdoorForeground,
    buildingsLayer, buildings, labels,
  };
}

// ---------------------------------------------------------------------------
// Ground plane (plan language): a bare drawing sheet
// ---------------------------------------------------------------------------

function drawGround(g: Graphics, map: MapDocument): void {
  g.rect(0, 0, map.width, map.height).fill({ color: PAPER });
  drawSheetBorder(g, map);
  drawExtractionPads(g, map);
  drawEntranceWalkways(g, map);
}

/** The map boundary reads as a drawing-sheet border, not a gray wall. */
function drawSheetBorder(g: Graphics, map: MapDocument): void {
  for (const wall of map.outdoor.walls) {
    const isEdge = wall.x <= 0 || wall.y <= 0 || wall.x + wall.w >= map.width || wall.y + wall.h >= map.height;

    if (!isEdge) {
      // Outdoor collision that isn't the map edge (hedges, low walls).
      g.rect(wall.x, wall.y, wall.w, wall.h).stroke(strokes.fixture);
    }
  }

  const inset = Math.min(...map.outdoor.walls.filter((w) => w.x <= 0).map((w) => w.w), 26);
  g.rect(inset, inset, map.width - inset * 2, map.height - inset * 2).stroke({ color: INK.structure, width: 2 });
  g.rect(inset - 6, inset - 6, map.width - (inset - 6) * 2, map.height - (inset - 6) * 2).stroke(strokes.hairline);
}

function drawExtractionPads(g: Graphics, map: MapDocument): void {
  for (const point of map.extractionPoints) {
    const { x, y, w, h } = point.rect;

    g.roundRect(x, y, w, h, 6).fill({ color: PAPER });
    g.roundRect(x, y, w, h, 6).stroke({ color: INK.opening, width: 2 });

    // Diagonal hatch, annotation weight.
    for (let offset = 18; offset < w + h - 18; offset += 16) {
      const x1 = Math.max(x + 4, x + offset - h + 4);
      const y1 = Math.min(y + h - 4, y + offset - 4);
      const x2 = Math.min(x + w - 4, x + offset - 4);
      const y2 = Math.max(y + 4, y + offset - w + 4);
      line(g, x1, y1, x2, y2, strokes.hairline);
    }

    // Corner brackets.
    const b = 14;
    for (const [cx, cy, dx, dy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ] as Array<[number, number, number, number]>) {
      g.moveTo(cx + dx * 4, cy + dy * (4 + b))
        .lineTo(cx + dx * 4, cy + dy * 4)
        .lineTo(cx + dx * (4 + b), cy + dy * 4)
        .stroke({ color: INK.opening, width: 2.5 });
    }

    // Center beacon glyph.
    const cx = x + w / 2;
    const cy = y + h / 2;
    g.circle(cx, cy, 12).stroke({ color: INK.opening, width: 1.8 });
    line(g, cx, cy + 6, cx, cy - 6, { color: INK.opening, width: 1.8 });
    g.moveTo(cx - 4.5, cy - 1.5).lineTo(cx, cy - 7).lineTo(cx + 4.5, cy - 1.5).stroke({ color: INK.opening, width: 1.8 });
  }
}

function drawOutdoorObjects(
  detailG: Graphics,
  objectsG: Graphics,
  map: MapDocument,
): void {
  // Ground markings (parking stalls) first, trees last so canopies overlap.
  const order = (kind: string) => (kind === "parkingStall" ? 0 : kind === "tree" ? 2 : 1);
  const sorted = [...map.outdoor.objects].sort((a, b) => order(a.kind) - order(b.kind));

  for (const object of sorted) {
    const isDetail = object.solid === false && object.kind !== "car";
    drawObject(isDetail ? detailG : objectsG, object);
  }
}

// ---------------------------------------------------------------------------
// Entrances
// ---------------------------------------------------------------------------

type Entrance = { cx: number; cy: number; width: number; side: "N" | "S" | "E" | "W"; open: boolean };

/** Street-level entrances: GROUND doorways sitting on the building perimeter. */
function buildingEntrances(building: Building): Entrance[] {
  const entrances: Entrance[] = [];
  const tol = 10;
  const fp = building.footprint;
  const ground = building.floors.find(isGroundFloor);

  if (!ground) {
    return entrances;
  }

  for (const doorway of ground.doorways) {
    const open = doorway.open === true || doorway.mechanism !== undefined;

    if (doorway.dir === "h") {
      if (Math.abs(doorway.y - fp.y) <= tol) {
        entrances.push({ cx: doorway.x, cy: fp.y, width: doorway.width, side: "N", open });
      } else if (Math.abs(doorway.y - (fp.y + fp.h)) <= tol) {
        entrances.push({ cx: doorway.x, cy: fp.y + fp.h, width: doorway.width, side: "S", open });
      }
    } else {
      if (Math.abs(doorway.x - fp.x) <= tol) {
        entrances.push({ cx: fp.x, cy: doorway.y, width: doorway.width, side: "W", open });
      } else if (Math.abs(doorway.x - (fp.x + fp.w)) <= tol) {
        entrances.push({ cx: fp.x + fp.w, cy: doorway.y, width: doorway.width, side: "E", open });
      }
    }
  }

  return entrances;
}

function entranceRect(entrance: Entrance, depth: number, half: number): Rect {
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

/** Approach markings for each entrance, drawn under the roofs. */
function drawEntranceWalkways(g: Graphics, map: MapDocument): void {
  for (const entrance of map.buildings.flatMap(buildingEntrances)) {
    if (entrance.open) {
      // Vehicle drive: two wheel-track guides running into the door. Lines
      // ACROSS the approach are reserved for stair treads — never reuse
      // that shape here.
      const rect = entranceRect(entrance, 38, entrance.width / 2 - 8);
      if (entrance.side === "N" || entrance.side === "S") {
        line(g, rect.x, rect.y, rect.x, rect.y + rect.h, strokes.hairline);
        line(g, rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h, strokes.hairline);
      } else {
        line(g, rect.x, rect.y, rect.x + rect.w, rect.y, strokes.hairline);
        line(g, rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h, strokes.hairline);
      }
      continue;
    }

    // Pedestrian door: a plain paved walk strip.
    const rect = entranceRect(entrance, 26, entrance.width / 2 + 3);
    g.rect(rect.x, rect.y, rect.w, rect.h).stroke(strokes.hairline);
  }
}

/** Facade notch, jambs, and dashed canopy above the roof layer. */
function drawEntranceMarks(g: Graphics, building: Building): void {
  const wallDepth = exteriorWallDepth(building);

  for (const entrance of buildingEntrances(building)) {
    const horizontal = entrance.side === "N" || entrance.side === "S";
    const half = entrance.width / 2;

    const notch =
      entrance.side === "N"
        ? { x: entrance.cx - half, y: entrance.cy - 1, w: entrance.width, h: wallDepth + 2 }
        : entrance.side === "S"
          ? { x: entrance.cx - half, y: entrance.cy - wallDepth - 1, w: entrance.width, h: wallDepth + 2 }
          : entrance.side === "W"
            ? { x: entrance.cx - 1, y: entrance.cy - half, w: wallDepth + 2, h: entrance.width }
            : { x: entrance.cx - wallDepth - 1, y: entrance.cy - half, w: wallDepth + 2, h: entrance.width };
    g.rect(notch.x, notch.y, notch.w, notch.h).fill({ color: PAPER });

    if (horizontal) {
      for (const jx of [entrance.cx - half, entrance.cx + half]) {
        line(g, jx, notch.y, jx, notch.y + notch.h, { color: INK.structure, width: 2 });
      }
    } else {
      for (const jy of [entrance.cy - half, entrance.cy + half]) {
        line(g, notch.x, jy, notch.x + notch.w, jy, { color: INK.structure, width: 2 });
      }
    }

    if (entrance.open) {
      // Roll-up: dashed track across the opening.
      if (horizontal) {
        for (let x = entrance.cx - half + 3; x < entrance.cx + half - 3; x += 12) {
          g.rect(x, entrance.cy + (entrance.side === "N" ? 3 : -6), 7, 3).fill({ color: INK.opening });
        }
      } else {
        for (let y = entrance.cy - half + 3; y < entrance.cy + half - 3; y += 12) {
          g.rect(entrance.cx + (entrance.side === "W" ? 3 : -6), y, 3, 7).fill({ color: INK.opening });
        }
      }
      continue;
    }

    // Canopy: dashed three-sided outline projecting over the walkway.
    const canopy = entranceRect(entrance, 22, half + 5);
    const edges: Array<[number, number, number, number]> =
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

    for (const [x1, y1, x2, y2] of edges) {
      dashedSegment(g, x1, y1, x2, y2, strokes.hairline);
    }
  }
}

/** Exterior wall thickness inferred from the building's top perimeter run. */
function exteriorWallDepth(building: Building): number {
  const ground = building.floors.find(isGroundFloor);
  const top = ground?.walls.find((wall) => Math.abs(wall.y - building.footprint.y) < 1);
  return top?.h ?? 12;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function makeLabel(text: string, size: number, letterSpacing: number, color: number, weight = "600"): Text {
  const label = new Text({
    text,
    style: {
      fontFamily: LABEL_FONT,
      fontSize: size,
      fontWeight: weight as "600",
      letterSpacing,
      fill: color,
    },
  });
  label.resolution = 2;
  return label;
}

function drawExtractionLabels(layer: Container, map: MapDocument): void {
  for (const point of map.extractionPoints) {
    // Home Base has a dedicated interaction-dot marker and contextual DEPLOY
    // tag. The generic map caption beneath it is redundant and visually clips
    // into the sealed threshold.
    if (point.id === "base-deployment") continue;
    const label = makeLabel(point.name, 11, 3, INK.opening, "700");
    label.anchor.set(0.5, 0);
    label.position.set(point.rect.x + point.rect.w / 2, point.rect.y + point.rect.h + 8);
    layer.addChild(label);
  }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function buildBuildingArt(
  building: Building,
  buildingsLayer: Container,
  labels: Container,
  placementSlots?: PlacementSlot[],
  interactionDots?: InteractionDot[],
  map?: MapDocument,
  foregroundRoot?: Container,
): BuildingArt {
  const floors: FloorArt[] = [];

  for (const floor of building.floors) {
    const art = buildFloorArt(
      building,
      floor,
      placementSlots?.filter((slot) => slot.floor === floor.label),
      interactionDots?.filter((dot) => dot.floorId === floor.id),
      map,
    );
    art.view.visible = false;
    art.foreground.visible = false;
    buildingsLayer.addChild(art.view);
    foregroundRoot?.addChild(art.foreground);
    floors.push(art);
  }

  const roof = new Container();
  const roofG = new Graphics();
  if (map?.visualTheme === "lit-model") roof.addChild(buildRoofModel(building).view);
  else drawGenericRoof(roofG, building);
  roof.addChild(roofG);
  buildingsLayer.addChild(roof);

  // Entrance marks sit above the roof and only make sense from the street;
  // callers hide them while an interior floor of this building is active.
  const entranceMarks = new Container();
  const entranceGfx = new Graphics();
  entranceMarks.addChild(entranceGfx);
  if (map?.visualTheme !== "lit-model") {
    // Drafting notation: a paper-white notch, ink jambs and a dashed canopy. The
    // lit model already builds the opening as geometry — curtain, rails, reveal —
    // so leaving this on paints a flat white bar across a shaded wall.
    drawEntranceMarks(entranceGfx, building);
  }
  buildingsLayer.addChild(entranceMarks);

  const label = makeLabel(building.name, 16, 3.5, INK.fixture, "800");
  label.anchor.set(0.5, 0.5);
  label.position.set(
    building.footprint.x + building.footprint.w / 2,
    building.footprint.y + building.footprint.h / 2,
  );
  labels.addChild(label);

  return { building, roof, entranceMarks, floors, label };
}

/**
 * Roof seen from the street for buildings without an authored ROOF plan:
 * plate, parapet, and a handful of kind-appropriate service equipment so the
 * block reads as a real city from above. Deliberately sparse — buildings
 * with gameplay on the roof author a real ROOF floor instead.
 */
function drawGenericRoof(g: Graphics, building: Building): void {
  const fp = building.footprint;
  drawRoofPlate(g, fp);

  const at = (fx: number, fy: number) => ({ x: fp.x + fp.w * fx, y: fp.y + fp.h * fy });

  if (building.kind === "hospital") {
    // Helipad ring west, air handler and vents on the service edge east.
    const pad = at(0.3, 0.52);
    const r = Math.min(fp.w, fp.h) * 0.19;
    g.circle(pad.x, pad.y, r).stroke({ color: INK.fixture, width: 1.6 });
    g.circle(pad.x, pad.y, r * 0.72).stroke(strokes.hairline);
    line(g, pad.x - r * 0.3, pad.y - r * 0.32, pad.x - r * 0.3, pad.y + r * 0.32, { color: INK.fixture, width: 2 });
    line(g, pad.x + r * 0.3, pad.y - r * 0.32, pad.x + r * 0.3, pad.y + r * 0.32, { color: INK.fixture, width: 2 });
    line(g, pad.x - r * 0.3, pad.y, pad.x + r * 0.3, pad.y, { color: INK.fixture, width: 2 });

    drawObject(g, { id: `${building.id}-roof-ahu`, kind: "hvac", ...at(0.66, 0.18), w: 84, h: 54 });
    drawObject(g, { id: `${building.id}-roof-vent-a`, kind: "vent", ...at(0.85, 0.24), w: 22, h: 22 });
    drawObject(g, { id: `${building.id}-roof-vent-b`, kind: "vent", ...at(0.85, 0.36), w: 22, h: 22 });
    drawObject(g, { id: `${building.id}-roof-sky`, kind: "skylight", ...at(0.62, 0.62), w: 110, h: 58 });
    return;
  }

  if (building.kind === "warehouse") {
    // Ridge skylight strips over the storage bays, exhaust plant one corner.
    for (const fx of [0.28, 0.46, 0.64]) {
      drawObject(g, { id: `${building.id}-roof-strip-${fx}`, kind: "skylight", ...at(fx, 0.18), w: 44, h: fp.h * 0.5 });
    }
    drawObject(g, { id: `${building.id}-roof-exhaust`, kind: "hvac", ...at(0.82, 0.66), w: 88, h: 52 });
    drawObject(g, { id: `${building.id}-roof-vent-a`, kind: "vent", ...at(0.12, 0.72), w: 24, h: 24 });
    drawObject(g, { id: `${building.id}-roof-vent-b`, kind: "vent", ...at(0.12, 0.82), w: 24, h: 24 });
    return;
  }

  // Default: one air handler and a vent, off-center.
  drawObject(g, { id: `${building.id}-roof-hvac`, kind: "hvac", ...at(0.6, 0.3), w: 72, h: 48 });
  drawObject(g, { id: `${building.id}-roof-vent`, kind: "vent", ...at(0.25, 0.65), w: 22, h: 22 });
}

/** Shared roof/deck plate: quiet tint, strong outline, parapet hairline. */
export function drawRoofPlate(g: Graphics, fp: Rect): void {
  g.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: INK.plate });
  g.rect(fp.x, fp.y, fp.w, fp.h).stroke({ color: INK.structure, width: WEIGHT.structure + 0.6 });
  g.rect(fp.x + 8, fp.y + 8, fp.w - 16, fp.h - 16).stroke(strokes.hairline);
}

function buildFloorArt(
  building: Building,
  floor: FloorPlan,
  placementSlots?: PlacementSlot[],
  interactionDots: InteractionDot[] = [],
  map?: MapDocument,
): FloorArt {
  if (map?.visualTheme === "lit-model") {
    return floor.label === "ROOF"
      ? buildLitModelRoofArt(building, floor)
      : buildLitModelFloorArt(building, floor, interactionDots);
  }

  const view = new Container();
  const backdrop = new Container();
  const thresholds = new Container();
  const architecture = new Graphics();
  const furniture = new Container();
  furniture.sortableChildren = true;
  const foreground = new Container();
  foreground.sortableChildren = true;
  const objectViews = new Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>();
  const stairFixtures = new Container();
  const stairViews = new Map<string, { stair: StairLink; view: Container }>();
  const slotMarkers = new Graphics();
  const annotationGfx = new Graphics();
  const interactionDotGfx = new Graphics();
  const interactionLabels = new Container();
  const annotation = new Container();
  annotation.addChild(annotationGfx);

  const fp = building.footprint;
  const isRoof = floor.label === "ROOF";

  // Plate.
  if (isRoof) drawRoofPlate(architecture, fp);
  else architecture.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: PAPER });

  // Furniture below structure so wall poché always wins overlaps.
  for (const object of floor.objects) {
    const view = new Graphics();
    drawObject(view, object);
    view.zIndex = object.y + object.h;
    furniture.addChild(view);
    objectViews.set(object.id, { object, view });
  }
  const occupiedSlots = new Set(floor.objects.map((object) => object.slotId).filter(Boolean));
  for (const slot of placementSlots ?? []) {
    if (occupiedSlots.has(slot.id)) continue;
    drawPlacementSlot(slotMarkers, slot);
  }
  furniture.addChildAt(slotMarkers, 0);

  // Stairs.
  for (const stair of floor.stairs) {
    const stairView = new Container();
    const stairGfx = new Graphics();
    drawStair(stairGfx, stair);
    stairView.addChild(stairGfx);
    stairFixtures.addChild(stairView);
    stairViews.set(stair.id, { stair, view: stairView });
    const tag = makeLabel(stair.direction === "up" ? "UP" : "DN", 10, 2, INK.fixture, "700");
    placeStairTag(tag, stair);
    annotation.addChild(tag);
  }

  // Walls (poché).
  for (const wall of floor.walls) {
    architecture.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: INK.structure });
  }

  // Windows over walls.
  for (const band of floor.windows ?? []) {
    drawWindow(architecture, band, floor.walls);
  }

  // The floor plan shows the traversable opening and threshold only.
  for (const doorway of floor.doorways) {
    drawDoorway(architecture, annotationGfx, doorway, doorwayStyle(doorway, fp));
  }

  for (const dot of interactionDots) {
    drawInteractionDot(interactionDotGfx, dot);
    const label = interactionLabel(dot, floor);
    if (label) interactionLabels.addChild(makeInteractionLabel(label, dot));
  }

  view.addChild(architecture, stairFixtures, furniture, annotation, interactionDotGfx, interactionLabels);
  return { floor, view, architecture, furniture, foreground, objectViews, stairViews, annotation, annotationGfx };
}

/**
 * The lit-model language backing a FloorArt.
 *
 * Interaction Dots and stair tags are drawn with the shared primitives so the
 * gameplay layer stays identical across themes — only the world underneath it
 * changes. Roofs still fall through to the line-plan path: the exterior has not
 * been ported yet, which is why no shipped map sets this theme by default.
 */
function buildLitModelFloorArt(
  building: Building,
  floor: FloorPlan,
  interactionDots: InteractionDot[],
): FloorArt {
  const model = buildFloorModel(building, floor);
  const interactionDotGfx = new Graphics();
  const interactionLabels = new Container();

  for (const stair of floor.stairs) {
    const tag = makeLabel(stair.direction === "up" ? "UP" : "DN", 10, 2, 0xf2f3f4, "700");
    placeStairTag(tag, stair);
    model.annotation.addChild(tag);
  }

  for (const dot of interactionDots) {
    drawInteractionDot(interactionDotGfx, dot);
    const label = interactionLabel(dot, floor);
    if (label) interactionLabels.addChild(makeInteractionLabel(label, dot));
  }

  model.view.addChild(interactionDotGfx, interactionLabels);

  return {
    floor,
    view: model.view,
    architecture: model.architecture,
    furniture: model.furniture,
    // No perspective pixels in a plan language, so nothing needs a walk-behind
    // pass; the container exists to satisfy the shared fog mask.
    foreground: new Container(),
    objectViews: model.objectViews,
    stairViews: model.stairViews,
    annotation: model.annotation,
    annotationGfx: model.annotationGfx,
  };
}

/**
 * An authored ROOF plan in the lit-model language. It shares the roof model with
 * the generated exterior, so a building looks the same whether you are standing
 * on it or looking at it from the street.
 */
function buildLitModelRoofArt(building: Building, floor: FloorPlan): FloorArt {
  const model = buildRoofModel(building);
  const annotationGfx = new Graphics();
  const annotation = new Container();
  annotation.addChild(annotationGfx);

  const stairViews = new Map<string, { stair: StairLink; view: Container }>();
  const stairs = new Container();
  /**
   * Roofs get a stair *head*, not a flight.
   *
   * This used to call the line-plan `drawStair`, which draws the treads and a DN
   * arrow — correct looking down a stairwell, and wrong looking down at a roof,
   * where the flight is inside a housing you cannot see into. It is the reason
   * Downtown's towers appeared to have staircases lying open on top of them.
   */
  const stairPad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  for (const stair of floor.stairs) {
    const view = new Container();
    const g = new Graphics();
    drawStairHead(g, stairPad, stair);
    view.addChild(g);
    stairs.addChild(view);
    stairViews.set(stair.id, { stair, view });
    const tag = makeLabel(stair.direction === "up" ? "UP" : "DN", 10, 2, 0xf2f3f4, "700");
    placeStairTag(tag, stair);
    annotation.addChild(tag);
  }
  stairs.addChildAt(new Container(), 0);
  for (const layer of stairPad) stairs.addChildAt(layer, 0);
  model.view.addChild(stairs, annotation);

  return {
    floor,
    view: model.view,
    architecture: model.architecture,
    furniture: model.furniture,
    foreground: new Container(),
    objectViews: model.objectViews,
    stairViews,
    annotation,
    annotationGfx,
  };
}

function drawInteractionDot(g: Graphics, dot: InteractionDot): void {
  if (dot.kind === "emptySlot") return;
  const { x, y } = dot.position;
  if (dot.kind === "deployment") {
    g.circle(x, y, dot.radius).fill({ color: PAPER });
    g.circle(x, y, dot.radius).stroke({ color: INK.structure, width: 2 });
    g.circle(x, y, dot.radius - 4).stroke({ color: INK.fixture, width: WEIGHT.hairline });
    g.moveTo(x, y + 5).lineTo(x, y - 5).stroke({ color: INK.structure, width: 1.8 });
    g.moveTo(x - 4, y - 1).lineTo(x, y - 5).lineTo(x + 4, y - 1).stroke({ color: INK.structure, width: 1.8 });
    return;
  }
  // Use the same outer primitive as collectible Dots. Environment interactions
  // stay neutral and carry their meaning in the nearby label; an extra inner
  // ring made them read like generic UI buttons.
  drawDotDisc(g, dot.position, dot.radius, DOT_COLOR.interaction);
}

function interactionLabel(dot: InteractionDot, floor: FloorPlan): string | null {
  if (dot.kind === "deployment") return "DEPLOY";
  if (dot.kind !== "object") return null;
  const kind = floor.objects.find((object) => object.id === dot.targetId)?.kind;
  if (kind === "fabricator") return "FABRICATE";
  if (kind === "locker") return "STASH";
  if (kind === "bayConsole") return "LOADOUT";
  if (kind === "planningTable") return "CONTRACTS";
  if (kind === "draftingTable") return "BASE LAYOUT";
  return null;
}

function makeInteractionLabel(text: string, dot: InteractionDot): Container {
  const tag = new Container();
  const label = makeLabel(text, 9, 1.4, INK.structure, "800");
  label.anchor.set(0.5, 0.5);
  const padX = 5;
  const padY = 3;
  const background = new Graphics();
  background.roundRect(-label.width / 2 - padX, -label.height / 2 - padY, label.width + padX * 2, label.height + padY * 2, 2)
    .fill({ color: PAPER, alpha: 0.94 })
    .stroke({ color: INK.hairline, width: WEIGHT.hairline });
  tag.addChild(background, label);
  tag.position.set(dot.position.x, dot.position.y - dot.radius - 12);
  return tag;
}

function drawPlacementSlot(g: Graphics, slot: PlacementSlot): void {
  const { x, y, w, h } = slot.rect;
  const tick = 8;
  const style = { color: INK.hairline, width: WEIGHT.hairline, alpha: 0.72 };
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ] as Array<[number, number, number, number]>) {
    g.moveTo(cx + dx * tick, cy).lineTo(cx, cy).lineTo(cx, cy + dy * tick).stroke(style);
  }
  g.circle(x + w / 2, y + h / 2, 2).stroke(style);
}

// --- Windows ---------------------------------------------------------------

/**
 * Plan-convention window: the wall poché breaks to white and three fine lines
 * run through the opening — two frame faces and a center glass line.
 */
function drawWindow(g: Graphics, band: WindowBand, walls: WallSegment[]): void {
  const host = walls.find((wall) =>
    band.dir === "h"
      ? band.y >= wall.y - 1 && band.y <= wall.y + wall.h + 1 && band.x >= wall.x - 1 && band.x <= wall.x + wall.w + 1
      : band.x >= wall.x - 1 && band.x <= wall.x + wall.w + 1 && band.y >= wall.y - 1 && band.y <= wall.y + wall.h + 1,
  );
  const depth = host ? (band.dir === "h" ? host.h : host.w) : 12;
  const half = band.length / 2;

  if (band.dir === "h") {
    const top = host ? host.y : band.y - depth / 2;
    g.rect(band.x - half, top + 1, band.length, depth - 2).fill({ color: PAPER });
    line(g, band.x - half, top + 1.6, band.x + half, top + 1.6, strokes.opening);
    line(g, band.x - half, top + depth - 1.6, band.x + half, top + depth - 1.6, strokes.opening);
    line(g, band.x - half, top + depth / 2, band.x + half, top + depth / 2, { color: INK.opening, width: 1.1 });
    // Jambs.
    line(g, band.x - half, top, band.x - half, top + depth, strokes.opening);
    line(g, band.x + half, top, band.x + half, top + depth, strokes.opening);
  } else {
    const left = host ? host.x : band.x - depth / 2;
    g.rect(left + 1, band.y - half, depth - 2, band.length).fill({ color: PAPER });
    line(g, left + 1.6, band.y - half, left + 1.6, band.y + half, strokes.opening);
    line(g, left + depth - 1.6, band.y - half, left + depth - 1.6, band.y + half, strokes.opening);
    line(g, left + depth / 2, band.y - half, left + depth / 2, band.y + half, { color: INK.opening, width: 1.1 });
    line(g, left, band.y - half, left + depth, band.y - half, strokes.opening);
    line(g, left, band.y + half, left + depth, band.y + half, strokes.opening);
  }
}

// --- Stairs ------------------------------------------------------------------

function stairEntryEnd(stair: StairLink): "N" | "S" | "E" | "W" {
  const { entry, vertical } = stairHalves(stair);
  const entryLow = entry.x === stair.rect.x && entry.y === stair.rect.y;
  return vertical ? (entryLow ? "N" : "S") : entryLow ? "W" : "E";
}

function placeStairTag(tag: Text, stair: StairLink): void {
  const { x, y, w, h } = stair.rect;
  const end = stairEntryEnd(stair);

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

function drawStairTreads(g: Graphics, half: Rect, vertical: boolean, dashed: boolean): void {
  if (vertical) {
    for (let ty = half.y + 12; ty < half.y + half.h - 4; ty += 12) {
      if (dashed) {
        dashedSegment(g, half.x + 3, ty, half.x + half.w - 3, ty, strokes.hairline);
      } else {
        line(g, half.x + 2, ty, half.x + half.w - 2, ty, { color: INK.opening, width: 1.2 });
      }
    }
  } else {
    for (let tx = half.x + 12; tx < half.x + half.w - 4; tx += 12) {
      if (dashed) {
        dashedSegment(g, tx, half.y + 3, tx, half.y + half.h - 3, strokes.hairline);
      } else {
        line(g, tx, half.y + 2, tx, half.y + half.h - 2, { color: INK.opening, width: 1.2 });
      }
    }
  }
}

/** Faint rails preserve the stair footprint without claiming collision. */
function drawPassableStairGuides(g: Graphics, entry: Rect, vertical: boolean): void {
  const guide = { color: INK.hairline, width: WEIGHT.hairline, alpha: 0.62 };
  if (vertical) {
    line(g, entry.x, entry.y, entry.x, entry.y + entry.h, guide);
    line(g, entry.x + entry.w, entry.y, entry.x + entry.w, entry.y + entry.h, guide);
  } else {
    line(g, entry.x, entry.y, entry.x + entry.w, entry.y, guide);
    line(g, entry.x, entry.y + entry.h, entry.x + entry.w, entry.y + entry.h, guide);
  }
}

/** The flight beyond the break line, belonging to the linked floor. */
export function drawStairExitHalf(g: Graphics, stair: StairLink): void {
  const { entry, exit, vertical } = stairHalves(stair);

  g.rect(exit.x, exit.y, exit.w, exit.h).fill({ color: INK.plate });
  if (stair.access !== "openEnd") {
    g.rect(exit.x, exit.y, exit.w, exit.h).stroke({ color: INK.opening, width: 1.4 });
  }
  drawStairTreads(g, exit, vertical, true);

  // Break line: the plan-convention zigzag at the cut plane.
  const zig = { color: INK.opening, width: 1.8 };
  if (vertical) {
    const my = exit.y === entry.y + entry.h ? exit.y : exit.y + exit.h;
    const { x, w } = stair.rect;
    g.moveTo(x, my)
      .lineTo(x + w * 0.38, my)
      .lineTo(x + w * 0.48, my - 8)
      .lineTo(x + w * 0.58, my + 8)
      .lineTo(x + w * 0.68, my)
      .lineTo(x + w, my)
      .stroke(zig);
  } else {
    const mx = exit.x === entry.x + entry.w ? exit.x : exit.x + exit.w;
    const { y, h } = stair.rect;
    g.moveTo(mx, y)
      .lineTo(mx, y + h * 0.38)
      .lineTo(mx - 8, y + h * 0.48)
      .lineTo(mx + 8, y + h * 0.58)
      .lineTo(mx, y + h * 0.68)
      .lineTo(mx, y + h)
      .stroke(zig);
  }

  for (const guard of stairGuardRects(stair)) {
    g.rect(guard.x, guard.y, guard.w, guard.h).fill({ color: INK.structure });
  }
}

export function drawStair(g: Graphics, stair: StairLink): void {
  const { x, y, w, h } = stair.rect;
  const { entry, vertical } = stairHalves(stair);

  g.rect(x, y, w, h).fill({ color: INK.plate });
  if (stair.access !== "openEnd") {
    g.rect(x, y, w, h).stroke({ color: INK.opening, width: 1.8 });
  }

  drawStairTreads(g, entry, vertical, false);
  drawPassableStairGuides(g, entry, vertical);

  // Travel arrow: from the entry end toward the break line.
  const arrow = { color: INK.opening, width: 1.8 };
  const cx = entry.x + entry.w / 2;
  const cy = entry.y + entry.h / 2;
  const end = stairEntryEnd(stair);

  if (vertical) {
    const from = end === "N" ? entry.y + 10 : entry.y + entry.h - 10;
    const to = end === "N" ? entry.y + entry.h - 8 : entry.y + 8;
    const sign = to > from ? 1 : -1;
    line(g, cx, from, cx, to, arrow);
    g.moveTo(cx - 5, to - sign * 7).lineTo(cx, to).lineTo(cx + 5, to - sign * 7).stroke(arrow);
  } else {
    const from = end === "W" ? entry.x + 10 : entry.x + entry.w - 10;
    const to = end === "W" ? entry.x + entry.w - 8 : entry.x + 8;
    const sign = to > from ? 1 : -1;
    line(g, from, cy, to, cy, arrow);
    g.moveTo(to - sign * 7, cy - 5).lineTo(to, cy).lineTo(to - sign * 7, cy + 5).stroke(arrow);
  }

  drawStairExitHalf(g, stair);
}

// --- Doorways ----------------------------------------------------------------

function drawDoorway(archG: Graphics, annoG: Graphics, doorway: Doorway, mode: DoorwayStyle): void {
  const w = doorway.width;

  if (mode === "open") {
    // The wall gap is the symbol. Exterior entrances and authored archways do
    // not need a leaf, swing, dashed barrier, or other claim on walkable space.
    return;
  }

  // An open sliding door: two quiet rails cross the gap and the retracted
  // panel sits in a wall pocket beyond one jamb. Nothing projects into the
  // walkable opening. Closed collision/animation will reuse the same track.
  const panelLength = Math.min(42, w * 0.56);
  const panelDepth = 5;
  if (doorway.dir === "h") {
    line(annoG, doorway.x - w / 2 + 4, doorway.y - 2, doorway.x + w / 2 - 4, doorway.y - 2, strokes.hairline);
    line(annoG, doorway.x - w / 2 + 4, doorway.y + 2, doorway.x + w / 2 - 4, doorway.y + 2, strokes.hairline);
    const panelX = doorway.x + w / 2 + 2;
    archG.rect(panelX, doorway.y - panelDepth / 2, panelLength, panelDepth).fill({ color: INK.plate });
    archG.rect(panelX, doorway.y - panelDepth / 2, panelLength, panelDepth).stroke(strokes.fixture);
    line(archG, panelX + 6, doorway.y, panelX + panelLength - 6, doorway.y, strokes.hairline);
  } else {
    line(annoG, doorway.x - 2, doorway.y - w / 2 + 4, doorway.x - 2, doorway.y + w / 2 - 4, strokes.hairline);
    line(annoG, doorway.x + 2, doorway.y - w / 2 + 4, doorway.x + 2, doorway.y + w / 2 - 4, strokes.hairline);
    const panelY = doorway.y + w / 2 + 2;
    archG.rect(doorway.x - panelDepth / 2, panelY, panelDepth, panelLength).fill({ color: INK.plate });
    archG.rect(doorway.x - panelDepth / 2, panelY, panelDepth, panelLength).stroke(strokes.fixture);
    line(archG, doorway.x, panelY + 6, doorway.x, panelY + panelLength - 6, strokes.hairline);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function line(g: Graphics, x1: number, y1: number, x2: number, y2: number, s: { color: number; width: number; alpha?: number }): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke(s);
}

export function dashedSegment(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  s: { color: number; width: number; alpha?: number },
): void {
  const dash = 6;
  const gap = 4;
  const total = Math.hypot(x2 - x1, y2 - y1);

  if (total <= 0) {
    return;
  }

  const ux = (x2 - x1) / total;
  const uy = (y2 - y1) / total;

  for (let d = 0; d < total; d += dash + gap) {
    const end = Math.min(d + dash, total);
    g.moveTo(x1 + ux * d, y1 + uy * d)
      .lineTo(x1 + ux * end, y1 + uy * end)
      .stroke(s);
  }
}

