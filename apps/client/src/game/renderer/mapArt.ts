import { Container, Graphics, Sprite, Text } from "pixi.js";
import { doorRuntimeId, isGroundFloor, stairGuardRects, stairHalves } from "@dotbot/game/mapModel";
import type {
  Building,
  Doorway,
  FloorPlan,
  InteractionDot,
  MapDocument,
  MapArtPlacement,
  MapObject,
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
import { doorwayStyle, perimeterDoorThresholdRect, type DoorwayStyle } from "./doorwayStyle";
import { DOT_COLOR, INK, PAPER, strokes, WEIGHT } from "./style";
import { cityFrame, cityTexture } from "./pixelAssets";

/**
 * Static map drawing, shared verbatim between the live game and Map Studio.
 *
 * Everything here derives from MapDocument data and the style.ts hierarchy.
 * No gameplay state, no procedural clutter: if a mark isn't explained by the
 * data or by plan-drawing convention, it doesn't belong in this file.
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
  /** Tall sprite pixels that render after bots for correct walk-behind depth. */
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
  doorSprites: Map<string, Sprite>;
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
  /** Perspective pixels that must cover a bot moving behind a tall prop. */
  foreground: Container;
  outdoorForeground: Container;
  buildingsLayer: Container;
  buildings: BuildingArt[];
  labels: Container;
  /** Street-view door art keyed by authoritative runtime id. */
  doorViews: Map<string, Sprite[]>;
};

const SIDEWALK = 20;
/** Roads narrower than this are service lanes: no center dash, no sidewalks. */
const LANE_MAX = 90;

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

    const buildings = map.buildings.map((building) => buildBuildingArt(
      building, buildingsLayer, labels, map.placementSlots, map.interactionDots, map, foreground,
    ));
    drawExtractionLabels(labels, map);
    root.addChild(ground, outdoorDetail, outdoorObjects, buildingsLayer, labels);
    return {
      root, ground, outdoorDetail, outdoorObjects, foreground, outdoorForeground,
      buildingsLayer, buildings, labels, doorViews: new Map(),
    };
  }

  drawGround(groundGfx, map);
  addPlacements(ground, map, "ground");
  if (map.visualTheme === "pixel-city") {
    const roadMarks = new Graphics();
    drawPixelRoads(roadMarks, map);
    ground.addChild(roadMarks);
  }
  addPlacements(outdoorDetail, map, "outdoorDetail");
  addPlacements(outdoorObjects, map, "outdoorObjects");
  drawOutdoorObjects(outdoorDetailGfx, outdoorObjectsGfx, outdoorDetail, outdoorObjects, outdoorForeground, map);

  const buildings = map.buildings.map((building) => buildBuildingArt(
    building,
    buildingsLayer,
    labels,
    map.placementSlots,
    map.interactionDots,
    map,
    foreground,
  ));

  if (map.visualTheme !== "pixel-city") drawStreetNames(labels, map);
  drawExtractionLabels(labels, map);

  root.addChild(ground, outdoorDetail, outdoorObjects, buildingsLayer, labels);

  const doorViews = new Map<string, Sprite[]>();
  for (const building of buildings) {
    const collect = (id: string, sprite: Sprite) => doorViews.set(id, [...(doorViews.get(id) ?? []), sprite]);
    for (const [id, sprite] of building.doorSprites) collect(id, sprite);
  }

  return { root, ground, outdoorDetail, outdoorObjects, foreground, outdoorForeground, buildingsLayer, buildings, labels, doorViews };
}

function drawPixelRoads(g: Graphics, map: MapDocument): void {
  const lineColor = 0xd9c86c;
  const curbColor = 0x252638;
  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;
    if (horizontal) {
      g.rect(road.x, road.y, road.w, 4).fill({ color: curbColor });
      g.rect(road.x, road.y + road.h - 4, road.w, 4).fill({ color: curbColor });
      for (let x = road.x + 20; x < road.x + road.w - 20; x += 84) {
        g.rect(x, road.y + road.h / 2 - 3, 48, 6).fill({ color: lineColor, alpha: 0.9 });
      }
    } else {
      g.rect(road.x, road.y, 4, road.h).fill({ color: curbColor });
      g.rect(road.x + road.w - 4, road.y, 4, road.h).fill({ color: curbColor });
      for (let y = road.y + 20; y < road.y + road.h - 20; y += 84) {
        g.rect(road.x + road.w / 2 - 3, y, 6, 48).fill({ color: lineColor, alpha: 0.9 });
      }
    }
  }

  for (const intersection of roadIntersections(map)) {
    const stripe = 10;
    for (let index = 0; index < 5; index += 1) {
      g.rect(intersection.x + 18 + index * 28, intersection.y + 12, stripe, 64).fill({ color: 0xe4e6ef, alpha: 0.85 });
      g.rect(intersection.x + 12, intersection.y + 18 + index * 28, 64, stripe).fill({ color: 0xe4e6ef, alpha: 0.85 });
    }
  }
}

// ---------------------------------------------------------------------------
// Ground plane: white paper, linework-only streets
// ---------------------------------------------------------------------------

function drawGround(g: Graphics, map: MapDocument): void {
  g.rect(0, 0, map.width, map.height).fill({ color: map.visualTheme === "pixel-city" ? 0x31313c : PAPER });

  if (map.visualTheme === "pixel-city") return;

  drawSheetBorder(g, map);
  drawSidewalks(g, map);
  drawParks(g, map);
  drawRoads(g, map);
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

function drawSidewalks(g: Graphics, map: MapDocument): void {
  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;

    if (Math.min(road.w, road.h) < LANE_MAX) {
      continue;
    }

    if (horizontal) {
      // Outer sidewalk edges.
      line(g, road.x, road.y - SIDEWALK, road.x + road.w, road.y - SIDEWALK, strokes.hairline);
      line(g, road.x, road.y + road.h + SIDEWALK, road.x + road.w, road.y + road.h + SIDEWALK, strokes.hairline);
      // Expansion joints.
      for (let x = road.x + 48; x < road.x + road.w; x += 72) {
        line(g, x, road.y - SIDEWALK, x, road.y, strokes.hairline);
        line(g, x, road.y + road.h, x, road.y + road.h + SIDEWALK, strokes.hairline);
      }
    } else {
      line(g, road.x - SIDEWALK, road.y, road.x - SIDEWALK, road.y + road.h, strokes.hairline);
      line(g, road.x + road.w + SIDEWALK, road.y, road.x + road.w + SIDEWALK, road.y + road.h, strokes.hairline);
      for (let y = road.y + 48; y < road.y + road.h; y += 72) {
        line(g, road.x - SIDEWALK, y, road.x, y, strokes.hairline);
        line(g, road.x + road.w, y, road.x + road.w + SIDEWALK, y, strokes.hairline);
      }
    }
  }
}

function drawParks(g: Graphics, map: MapDocument): void {
  for (const park of map.outdoor.parks) {
    g.roundRect(park.x, park.y, park.w, park.h, 10).stroke(strokes.fixture);
    g.roundRect(park.x + 5, park.y + 5, park.w - 10, park.h - 10, 8).stroke(strokes.hairline);
  }
}

function roadIntersections(map: MapDocument): Rect[] {
  const horizontal = map.outdoor.roads.filter((road) => road.w >= road.h);
  const vertical = map.outdoor.roads.filter((road) => road.h > road.w);
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

function drawRoads(g: Graphics, map: MapDocument): void {
  const intersections = roadIntersections(map);

  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;
    const lane = Math.min(road.w, road.h) < LANE_MAX;
    const curb = lane ? { color: INK.hairline, width: 1.2 } : { color: INK.fixture, width: 1.4 };
    const gaps = intersections.map((inter) =>
      horizontal ? { start: inter.x, end: inter.x + inter.w } : { start: inter.y, end: inter.y + inter.h },
    );

    // Curb lines: the strongest site mark, still well below wall weight.
    if (horizontal) {
      for (const [start, end] of spans(road.x, road.x + road.w, gaps)) {
        line(g, start, road.y, end, road.y, curb);
        line(g, start, road.y + road.h, end, road.y + road.h, curb);
      }
      if (!lane) {
        dashLine(g, road.x + 16, road.x + road.w - 16, road.y + road.h / 2, gaps, true);
      }
    } else {
      for (const [start, end] of spans(road.y, road.y + road.h, gaps)) {
        line(g, road.x, start, road.x, end, curb);
        line(g, road.x + road.w, start, road.x + road.w, end, curb);
      }
      if (!lane) {
        dashLine(g, road.y + 16, road.y + road.h - 16, road.x + road.w / 2, gaps, false);
      }
    }
  }

  for (const inter of intersections) {
    // Full crossings only; a service lane meeting an avenue gets no stripes.
    if (Math.min(inter.w, inter.h) >= LANE_MAX) {
      drawCrosswalks(g, inter);
    }
  }
}

function spans(start: number, end: number, gaps: Array<{ start: number; end: number }>): Array<[number, number]> {
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

function dashLine(
  g: Graphics,
  start: number,
  end: number,
  cross: number,
  gaps: Array<{ start: number; end: number }>,
  horizontal: boolean,
): void {
  const dash = 24;
  const gapLen = 20;

  for (let pos = start; pos < end; pos += dash + gapLen) {
    const segEnd = Math.min(pos + dash, end);

    if (gaps.some((gap) => segEnd > gap.start - 30 && pos < gap.end + 30)) {
      continue;
    }

    if (horizontal) {
      line(g, pos, cross, segEnd, cross, { color: INK.hairline, width: 2 });
    } else {
      line(g, cross, pos, cross, segEnd, { color: INK.hairline, width: 2 });
    }
  }
}

function drawCrosswalks(g: Graphics, inter: Rect): void {
  const stripe = 6;
  const gap = 9;
  const depth = 24;

  for (const edgeX of [inter.x - depth, inter.x + inter.w + depth - stripe]) {
    for (let i = 0; i < 3; i += 1) {
      const sx = edgeX + (edgeX < inter.x ? i : -i) * (stripe + gap);
      g.rect(sx, inter.y + 6, stripe, inter.h - 12).fill({ color: INK.hairline });
    }
  }

  for (const edgeY of [inter.y - depth, inter.y + inter.h + depth - stripe]) {
    for (let i = 0; i < 3; i += 1) {
      const sy = edgeY + (edgeY < inter.y ? i : -i) * (stripe + gap);
      g.rect(inter.x + 6, sy, inter.w - 12, stripe).fill({ color: INK.hairline });
    }
  }

  // Stop lines just outside the crosswalks.
  const stop = { color: INK.fixture, width: 3 };
  line(g, inter.x - depth - 12, inter.y + inter.h / 2, inter.x - depth - 12, inter.y + inter.h - 6, stop);
  line(g, inter.x + inter.w + depth + 12, inter.y + 6, inter.x + inter.w + depth + 12, inter.y + inter.h / 2, stop);
  line(g, inter.x + 6, inter.y - depth - 12, inter.x + inter.w / 2, inter.y - depth - 12, stop);
  line(g, inter.x + inter.w / 2, inter.y + inter.h + depth + 12, inter.x + inter.w - 6, inter.y + inter.h + depth + 12, stop);
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
  detailLayer: Container,
  objectsLayer: Container,
  foreground: Container,
  map: MapDocument,
): void {
  // Ground markings (parking stalls) first, trees last so canopies overlap.
  const order = (kind: string) => (kind === "parkingStall" ? 0 : kind === "tree" ? 2 : 1);
  const sorted = [...map.outdoor.objects].sort((a, b) => order(a.kind) - order(b.kind));

  for (const object of sorted) {
    const isDetail = object.solid === false && object.kind !== "car";
    if (object.art) {
      addObjectSprite(isDetail ? detailLayer : objectsLayer, foreground, object);
    } else {
      drawObject(isDetail ? detailG : objectsG, object);
    }
  }
}

function placementMatches(
  placement: MapArtPlacement,
  layer: MapArtPlacement["layer"],
  buildingId?: string,
  floorId?: string,
): boolean {
  return placement.layer === layer && placement.buildingId === buildingId && placement.floorId === floorId;
}

function addPlacements(
  container: Container,
  map: MapDocument,
  layer: MapArtPlacement["layer"],
  buildingId?: string,
  floorId?: string,
): void {
  for (const placement of map.artPlacements ?? []) {
    if (!placementMatches(placement, layer, buildingId, floorId)) continue;
    if (placement.tiled) {
      const frame = cityFrame(placement.assetKey);
      const width = placement.w ?? frame.w;
      const height = placement.h ?? frame.h;
      for (let y = 0; y < height; y += frame.h) {
        for (let x = 0; x < width; x += frame.w) {
          const tile = new Sprite(cityTexture(placement.assetKey));
          tile.position.set(placement.x + x, placement.y + y);
          tile.roundPixels = true;
          tile.zIndex = placement.zIndex ?? placement.y;
          container.addChild(tile);
        }
      }
      continue;
    }
    const display = new Sprite(cityTexture(placement.assetKey));
    display.position.set(placement.x, placement.y);
    if (placement.w !== undefined) display.width = placement.w;
    if (placement.h !== undefined) display.height = placement.h;
    display.zIndex = placement.zIndex ?? placement.y + (placement.h ?? cityFrame(placement.assetKey).h);
    container.addChild(display);
  }
}

function makeObjectSprite(object: MapObject): Sprite {
  const art = object.art!;
  const sprite = new Sprite(cityTexture(art.assetKey));
  if (art.fitToObject) {
    sprite.width = object.w;
    sprite.height = object.h;
  } else {
    const scale = art.scale ?? 1;
    sprite.scale.set(scale);
  }
  sprite.position.set(object.x + (art.offsetX ?? 0), object.y + (art.offsetY ?? 0));
  sprite.roundPixels = true;
  sprite.zIndex = object.y + object.h;
  return sprite;
}

function addObjectSprite(container: Container, foreground: Container, object: MapObject): void {
  const sprite = makeObjectSprite(object);
  container.addChild(sprite);
  if (object.art?.occlusionY === undefined) return;

  const copies = Math.max(1, Math.min(4, object.art.occlusionCopies ?? 1));
  const sample = makeObjectSprite(object);
  const top = sample.y;
  const cut = object.y + object.art.occlusionY;
  sample.destroy();
  for (let index = 0; index < copies; index += 1) {
    const overlay = makeObjectSprite(object);
    const mask = new Graphics();
    mask.rect(overlay.x, top, overlay.width, Math.max(0, cut - top)).fill({ color: 0xffffff });
    overlay.mask = mask;
    foreground.addChild(overlay, mask);
  }
}

function makeStairSprite(stair: StairLink): Sprite {
  const art = stair.art!;
  const sprite = new Sprite(cityTexture(art.assetKey));
  if (art.fitToObject) {
    sprite.width = stair.rect.w;
    sprite.height = stair.rect.h;
  } else {
    sprite.scale.set(art.scale ?? 1);
  }
  sprite.position.set(stair.rect.x + (art.offsetX ?? 0), stair.rect.y + (art.offsetY ?? 0));
  sprite.roundPixels = true;
  sprite.zIndex = stair.rect.y + stair.rect.h;
  return sprite;
}

/** Render licensed stair art below bots and repeat its non-enterable half in
 * the foreground so the mid-stride floor change reads as moving through it. */
function addStairSprite(container: Container, foreground: Container, stair: StairLink): void {
  container.addChild(makeStairSprite(stair));
  const overlay = makeStairSprite(stair);
  const { exit } = stairHalves(stair);
  const mask = new Graphics();
  mask.rect(exit.x, exit.y, exit.w, exit.h).fill({ color: 0xffffff });
  overlay.mask = mask;
  foreground.addChild(overlay, mask);
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

function drawStreetNames(layer: Container, map: MapDocument): void {
  for (const road of map.outdoor.roads) {
    const horizontal = road.w >= road.h;

    if (Math.min(road.w, road.h) < LANE_MAX) {
      continue;
    }
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
      const label = makeLabel(name, 17, 7, INK.hairline);
      label.anchor.set(0.5);
      label.position.set(pos.x, pos.y);
      if (!horizontal) {
        label.rotation = -Math.PI / 2;
      }
      layer.addChild(label);
    }
  }
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
  else if (map?.visualTheme !== "pixel-city") drawGenericRoof(roofG, building);
  roof.addChild(roofG);
  if (map) addPlacements(roof, map, "roof", building.id);
  buildingsLayer.addChild(roof);

  // Entrance marks sit above the roof and only make sense from the street;
  // callers hide them while an interior floor of this building is active.
  const entranceMarks = new Container();
  const entranceGfx = new Graphics();
  const doorSprites = new Map<string, Sprite>();
  entranceMarks.addChild(entranceGfx);
  if (map?.visualTheme === "pixel-city") {
    drawPixelEntrances(entranceGfx, building);
    const ground = building.floors.find(isGroundFloor);
    for (const doorway of ground?.doorways ?? []) {
      const sprite = makePixelDoorSprite(doorway, building.footprint);
      if (!sprite || !ground) continue;
      doorSprites.set(doorRuntimeId(ground.id, doorway.id), sprite);
      entranceMarks.addChild(sprite);
    }
  } else if (map?.visualTheme !== "lit-model") {
    // Drafting notation: a paper-white notch, ink jambs and a dashed canopy. The
    // lit model already builds the opening as geometry — curtain, rails, reveal —
    // so leaving this on paints a flat white bar across a shaded wall.
    drawEntranceMarks(entranceGfx, building);
  }
  buildingsLayer.addChild(entranceMarks);

  const label = makeLabel(building.name, 16, 3.5, INK.fixture, "800");
  label.anchor.set(0.5, 0.5);
  label.position.set(
    building.footprint.x + building.footprint.w * (building.kind === "retail" ? 0.29 : 0.5),
    building.footprint.y + building.footprint.h * (building.kind === "retail" ? 0.64 : 0.5),
  );
  labels.addChild(label);
  if (map?.visualTheme === "pixel-city") label.visible = false;

  return { building, roof, entranceMarks, doorSprites, floors, label };
}

function makePixelDoorSprite(doorway: Doorway, footprint: Rect): Sprite | null {
  if (!doorway.assetKey || doorway.dir !== "h") return null;
  if (Math.abs(doorway.y - (footprint.y + footprint.h)) > 10) return null;
  const sprite = new Sprite(cityTexture(`${doorway.assetKey}-0`));
  sprite.label = doorway.assetKey;
  sprite.anchor.set(0.5, 1);
  sprite.position.set(doorway.x, footprint.y + footprint.h);
  sprite.roundPixels = false;
  sprite.zIndex = doorway.y;
  return sprite;
}

/** Pixel façades are opaque images, so an authored open exterior doorway must
 * cut an equally obvious dark opening through the matching facade pixels. */
function drawPixelEntrances(g: Graphics, building: Building): void {
  const ground = building.floors.find(isGroundFloor);
  for (const entrance of buildingEntrances(building)) {
    if (!entrance.open) continue;
    const hasAnimatedDoor = ground?.doorways.some(
      (doorway) =>
        doorway.assetKey !== undefined &&
        Math.abs(doorway.x - entrance.cx) <= 1 &&
        Math.abs(doorway.y - entrance.cy) <= 10,
    );
    // The licensed animation includes its own frame, opening, and threshold.
    // Adding the generic entrance cutout here narrows the visible passage and
    // leaves a black rectangle protruding below the facade.
    if (hasAnimatedDoor) continue;
    const depth = 76;
    if (entrance.side === "S") {
      g.rect(entrance.cx - entrance.width / 2, entrance.cy - depth, entrance.width, depth)
        .fill({ color: 0x12131b })
        .stroke({ color: 0x25283a, width: 3 });
      g.rect(entrance.cx - entrance.width / 2 + 6, entrance.cy - 5, entrance.width - 12, 5).fill({ color: 0x6c7890 });
    } else if (entrance.side === "N") {
      // The exterior art is a south-facing facade. A north service exit is
      // visible only after the roof hides; cutting the roof here creates a
      // misleading skylight-like black box.
      continue;
    } else if (entrance.side === "E") {
      g.rect(entrance.cx - depth, entrance.cy - entrance.width / 2, depth, entrance.width)
        .fill({ color: 0x12131b })
        .stroke({ color: 0x25283a, width: 3 });
    } else {
      g.rect(entrance.cx, entrance.cy - entrance.width / 2, depth, entrance.width)
        .fill({ color: 0x12131b })
        .stroke({ color: 0x25283a, width: 3 });
    }
  }
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

  if (building.kind === "retail") {
    drawRetailRoof(g, building);
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

/** Compact commercial roof kit derived from the building below: one rear
 * service spine over the stock/utility edge and one skylight bank over the
 * open sales floor. Every item belongs to one of those two systems. */
function drawRetailRoof(g: Graphics, building: Building): void {
  const fp = building.footprint;
  const seam = { color: INK.hairline, width: WEIGHT.hairline, alpha: 0.38 };

  // A regular membrane grid belongs to the roof as a whole. It is the quiet
  // base order that every raised element aligns to.
  for (const fraction of [0.25, 0.5, 0.75]) {
    line(g, fp.x + fp.w * fraction, fp.y + 9, fp.x + fp.w * fraction, fp.y + fp.h - 9, seam);
  }
  for (const fraction of [1 / 3, 2 / 3]) {
    line(g, fp.x + 9, fp.y + fp.h * fraction, fp.x + fp.w - 9, fp.y + fp.h * fraction, seam);
  }

  // One continuous rear service spine. Access, travel, cooling, and exhaust
  // share the same deck and baseline instead of floating independently.
  const service = {
    x: fp.x + fp.w * 0.08,
    y: fp.y + fp.h * 0.09,
    w: fp.w * 0.84,
    h: Math.min(180, fp.h * 0.27),
  };
  g.rect(service.x, service.y, service.w, service.h).fill({ color: PAPER });
  g.rect(service.x, service.y, service.w, service.h).stroke(strokes.anchor);
  g.rect(service.x + 8, service.y + 8, service.w - 16, service.h - 16).stroke(strokes.hairline);

  const centerY = service.y + service.h / 2;
  const hatch = { x: service.x + 28, y: centerY - 32, w: 68, h: 64 };
  g.rect(hatch.x, hatch.y, hatch.w, hatch.h).fill({ color: PAPER });
  g.rect(hatch.x, hatch.y, hatch.w, hatch.h).stroke(strokes.opening);
  g.rect(hatch.x + 6, hatch.y + 6, hatch.w - 12, hatch.h - 12).stroke(strokes.hairline);
  line(g, hatch.x + 10, hatch.y + 10, hatch.x + hatch.w - 10, hatch.y + hatch.h - 10, strokes.hairline);
  line(g, hatch.x + hatch.w - 10, hatch.y + 10, hatch.x + 10, hatch.y + hatch.h - 10, strokes.hairline);

  // The access lane is a real, bounded path from the hatch to the equipment.
  const laneX = hatch.x + hatch.w + 12;
  const equipmentX = service.x + service.w * 0.37;
  const laneW = equipmentX - laneX - 12;
  g.rect(laneX, centerY - 25, laneW, 50).fill({ color: INK.plate });
  line(g, laneX, centerY - 25, laneX + laneW, centerY - 25, strokes.hairline);
  line(g, laneX, centerY + 25, laneX + laneW, centerY + 25, strokes.hairline);
  for (let x = laneX + 24; x < laneX + laneW; x += 38) {
    line(g, x, centerY - 25, x, centerY + 25, seam);
  }

  const equipmentY = centerY - 42;
  const unitA = { x: equipmentX, y: equipmentY, w: service.w * 0.2, h: 84 };
  const unitB = { x: unitA.x + unitA.w + 18, y: equipmentY, w: service.w * 0.17, h: 84 };
  drawObject(g, { id: `${building.id}-roof-ahu-a`, kind: "hvac", ...unitA });
  drawObject(g, { id: `${building.id}-roof-ahu-b`, kind: "hvac", ...unitB });

  // Exhausts form one aligned manifold at the end of the same service spine.
  const exhaust = {
    x: unitB.x + unitB.w + 18,
    y: equipmentY,
    w: service.x + service.w - 26 - (unitB.x + unitB.w + 18),
    h: 84,
  };
  g.rect(exhaust.x, exhaust.y, exhaust.w, exhaust.h).fill({ color: INK.plate });
  g.rect(exhaust.x, exhaust.y, exhaust.w, exhaust.h).stroke(strokes.fixture);
  const ventSize = Math.min(26, exhaust.w * 0.22);
  const ventGap = (exhaust.w - ventSize * 3) / 4;
  for (let index = 0; index < 3; index += 1) {
    drawObject(g, {
      id: `${building.id}-roof-exhaust-${index}`,
      kind: "vent",
      x: exhaust.x + ventGap + index * (ventSize + ventGap),
      y: centerY - ventSize / 2,
      w: ventSize,
      h: ventSize,
    });
  }

  // One ordered daylight bank sits directly over the open sales floor. The
  // curb and six equal lights make it one architectural element, not clutter.
  const skylight = {
    x: fp.x + fp.w * 0.5,
    y: fp.y + fp.h * 0.57,
    w: fp.w * 0.31,
    h: fp.h * 0.18,
  };
  g.rect(skylight.x, skylight.y, skylight.w, skylight.h).fill({ color: INK.glass, alpha: 0.72 });
  g.rect(skylight.x, skylight.y, skylight.w, skylight.h).stroke(strokes.anchor);
  g.rect(skylight.x + 7, skylight.y + 7, skylight.w - 14, skylight.h - 14).stroke(strokes.hairline);
  line(g, skylight.x + skylight.w / 3, skylight.y + 7, skylight.x + skylight.w / 3, skylight.y + skylight.h - 7, strokes.fixture);
  line(g, skylight.x + skylight.w * 2 / 3, skylight.y + 7, skylight.x + skylight.w * 2 / 3, skylight.y + skylight.h - 7, strokes.fixture);
  line(g, skylight.x + 7, skylight.y + skylight.h / 2, skylight.x + skylight.w - 7, skylight.y + skylight.h / 2, strokes.fixture);

  // A single straight utility trunk reinforces the relationship between the
  // rear service spine and the daylight bank without crossing the open roof.
  const trunkX = skylight.x + skylight.w / 2;
  line(g, trunkX - 3, service.y + service.h, trunkX - 3, skylight.y, strokes.hairline);
  line(g, trunkX + 3, service.y + service.h, trunkX + 3, skylight.y, strokes.hairline);
  for (const y of [service.y + service.h + 20, skylight.y - 20]) {
    g.rect(trunkX - 6, y - 3, 12, 6).fill({ color: INK.plate }).stroke(strokes.hairline);
  }
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

  if (map) addPlacements(backdrop, map, "floor", building.id, floor.id);
  if (map?.visualTheme === "pixel-city") addPixelInteriorThresholds(thresholds, floor, building.footprint);

  // Plate.
  if (isRoof) {
    drawRoofPlate(architecture, fp);
  } else if (map?.visualTheme !== "pixel-city") {
    architecture.rect(fp.x, fp.y, fp.w, fp.h).fill({ color: PAPER });
  }

  // Furniture below structure so wall poché always wins overlaps.
  for (const object of floor.objects) {
    const view = new Graphics();
    if (object.art) addObjectSprite(furniture, foreground, object);
    else drawObject(view, object);
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
    if (stair.art) {
      addStairSprite(stairView, foreground, stair);
      const { entry, vertical } = stairHalves(stair);
      drawPassableStairGuides(stairGfx, entry, vertical);
    } else {
      drawStair(stairGfx, stair);
    }
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

  // The floor plan shows the traversable opening and threshold only. The
  // automatic exterior door remains authoritative for collision, noise, and
  // visibility, but repeating its south-facing facade art inside would cover
  // the player and fixtures in the top-down interior view.
  for (const doorway of floor.doorways) {
    drawDoorway(architecture, annotationGfx, doorway, doorwayStyle(doorway, fp));
  }

  for (const dot of interactionDots) {
    drawInteractionDot(interactionDotGfx, dot, map?.visualTheme === "pixel-city");
    const label = interactionLabel(dot, floor);
    if (label) interactionLabels.addChild(makeInteractionLabel(label, dot));
  }

  view.addChild(backdrop, thresholds, architecture, stairFixtures, furniture, annotation, interactionDotGfx, interactionLabels);
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

/** Exterior doors keep their licensed animation on the facade. From inside,
 * every perimeter doorway is permanently rendered as the same light sidewalk
 * threshold so the route stays visually obvious even while collision closes. */
function addPixelInteriorThresholds(container: Container, floor: FloorPlan, footprint: Rect): void {
  const frame = cityFrame("door-threshold");
  for (const doorway of floor.doorways) {
    const rect = perimeterDoorThresholdRect(doorway, footprint);
    if (!rect) continue;

    if (doorway.dir === "h") {
      for (let offset = 0; offset < rect.w; offset += frame.w) {
        const sprite = new Sprite(cityTexture("door-threshold"));
        sprite.position.set(rect.x + offset, rect.y);
        sprite.width = Math.min(frame.w, rect.w - offset);
        sprite.height = rect.h;
        sprite.roundPixels = true;
        container.addChild(sprite);
      }
      continue;
    }

    // No current Pixel City facade uses a vertical entrance, but keep the
    // authored rule complete for mirrored blocks.
    for (let offset = 0; offset < rect.h; offset += frame.w) {
      const sprite = new Sprite(cityTexture("door-threshold"));
      sprite.position.set(rect.x, rect.y + offset);
      sprite.width = rect.w;
      sprite.height = Math.min(frame.w, rect.h - offset);
      sprite.roundPixels = true;
      container.addChild(sprite);
    }
  }
}

function drawInteractionDot(g: Graphics, dot: InteractionDot, perspective = false): void {
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
  drawDotDisc(g, dot.position, dot.radius, DOT_COLOR.interaction, perspective);
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

export type Camera = { x: number; y: number; scale: number };

/** Fit the whole map inside a viewport with a margin, centered. */
export function fitCamera(map: MapDocument, viewport: { width: number; height: number }, margin = 40): Camera {
  const scale = Math.min(
    (viewport.width - margin * 2) / map.width,
    (viewport.height - margin * 2) / map.height,
  );

  return {
    scale,
    x: (viewport.width - map.width * scale) / 2,
    y: (viewport.height - map.height * scale) / 2,
  };
}
