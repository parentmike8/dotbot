import { Container, Graphics, Text } from "pixi.js";
import { stairGuardRects } from "@dotbot/game/mapModel";
import type {
  Building,
  FloorPlan,
  InteractionDot,
  MapDocument,
  PlacementSlot,
  StairLink,
} from "@dotbot/game/types";
import { buildFloorModel, drawStair, drawStairHead } from "./model/modelFloor";
import { buildOutdoorModel } from "./model/modelOutdoor";
import { buildRoofModel } from "./model/modelRoof";
import {
  buildLeafFall, buildTrailMarks, type AmbientMover, type LeafFall, type TrailMarks,
} from "./model/modelMotion";
import { buildWaterSurfaces, type WaterSurface } from "./model/modelWater";
import type { ParallaxObjectView } from "./model/modelParallax";
import { SHADOW_ALPHA, V, type ShadowPad } from "./model/tone";
import { drawDotDisc } from "./dotArt";
import { DOT_COLOR, INK, OVERLAY_WHITE, WEIGHT } from "./style";
import { CAPTION, type Caption } from "./worldCaption";

/**
 * Static map drawing, shared verbatim between the live game and Map Studio.
 *
 * This file is now only assembly: it walks the MapDocument, asks `model/` for the
 * outdoor plane, each floor and each roof, and hangs the results in the layer
 * order the renderer and Map Studio both expect. Every mark is decided in
 * `model/`, from `model/tone.ts`. What lives here besides assembly is the handful
 * of things that sit *over* the world rather than in it — interaction Dots, their
 * labels, stair tags, and proximity-read sign text.
 *
 * It used to be ~1,600 lines because it also held a second drawing language: the
 * pen-plotter plan, its city furniture, its glyph library, and the branches to
 * choose between them. One language means no branches, and no second set of
 * geometry to keep honest.
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
  /** Ambient moving parts on this floor. See `modelMotion`; empty on every floor today. */
  movers: AmbientMover[];
  /**
   * Set only on an authored ROOF plan: the part of it that stands above ground.
   *
   * A roof plan does double duty — it is the building's exterior seen from the
   * street *and* a floor you can walk on — so it needs the same parallax handle
   * the generated exterior has.
   */
  roofMass?: Container;
  /**
   * A ROOF plan's two stair marks: the closed housing seen from the street, and the
   * open well seen from the deck. `GameRenderer` shows exactly one. Absent on every
   * other kind of floor, which is looked at from only one place.
   */
  stairHousing?: Container;
  stairWell?: Container;
  /** Door swings, stair tags, and other plan notation. */
  annotation: Container;
  annotationGfx: Graphics;
};

export type BuildingArt = {
  building: Building;
  /** Exterior (roof) view for buildings without an authored ROOF plan. */
  roof: Container;
  /**
   * Every above-ground roof mass this building owns, and so everything the camera
   * parallaxes: the generated exterior, plus an authored ROOF plan if it has one.
   *
   * Both are built for every building and only one is ever visible, which is
   * exactly the trap — the generated exterior is the obvious handle and it is the
   * hidden one on precisely the buildings tall enough for parallax to matter.
   */
  roofMasses: Container[];
  /** The authored ROOF plan's floor id, if any. Parallax stops when you stand on it. */
  roofFloorId: string | null;
  /** Street-view entrance marks; visible only when viewed from outside. */
  entranceMarks: Container;
  floors: FloorArt[];
};

export type MapArt = {
  root: Container;
  ground: Container;
  /** Non-solid outdoor dressing (walk-through). */
  outdoorDetail: Container;
  /** Solid outdoor objects. */
  outdoorObjects: Container;
  /** Addressable outdoor bases and their lifted parts for visible-only parallax redraws. */
  outdoorObjectViews: Map<string, ParallaxObjectView>;
  /**
   * The fog mask's target, and ONLY that.
   *
   * It is assigned to `foregroundFogGfx.mask`, and pixi consumes a mask source rather than
   * drawing it — so anything parented here disappears from the screen. Tree canopies were put
   * in it for one commit and vanished in `?solo` while every cast shadow stayed, which is a
   * confusing symptom for an obvious cause. Overhead ART goes in `overhead`.
   */
  foreground: Container;
  outdoorForeground: Container;
  /**
   * Marks that draw ABOVE THE BOTS: tree canopies, their trunks, falling leaves.
   *
   * A tree's collider is its trunk, so its canopy is something you walk under — reported from
   * play, "the player doesn't go under the tree canopy but they should" — and covering a bot
   * means drawing after it.
   *
   * KNOWN AND ACCEPTED: this layer is not fogged. `fogGfx` is drawn before the bots, so a
   * canopy above them shows through unexplored ground. `foregroundFogGfx` exists for exactly
   * this pass and is masked to `foreground`, but a mask has to be a silhouette drawn as
   * geometry rather than the art itself, and duplicating every canopy outline into a mask is a
   * bigger change than the one that fixed the layering. A tree is not secret; written down
   * rather than left to be rediscovered.
   */
  overhead: Container;
  buildingsLayer: Container;
  buildings: BuildingArt[];
  /** Every body of water's drifting surface. The renderer moves these each frame. */
  water: WaterSurface[];
  /**
   * Every ambient moving part in the world: turning rides, swaying canopies.
   *
   * One flat list rather than a tree, because the consumer is one call per frame that
   * transforms all of them — `animateAmbient` in `modelMotion`. Nothing here is redrawn.
   */
  movers: AmbientMover[];
  /** The leaf pool, drifting off whichever canopies are on screen. */
  leaves: LeafFall;
  /** Scuff marks under moving DotBots, on ground soft enough to keep one. */
  trails: TrailMarks;
};

const LABEL_FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildMapArt(map: MapDocument): MapArt {
  const root = new Container();
  const foreground = new Container();
  const outdoorForeground = new Container();
  const buildingsLayer = new Container();
  const overhead = new Container();
  foreground.addChild(outdoorForeground);

  const outdoors = buildOutdoorModel(map);
  const ground = new Container();
  const outdoorDetail = new Container();
  const outdoorObjects = new Container();
  /**
   * The water's moving highlights sit on the GROUND, immediately over the still body it
   * belongs to and under everything that stands in it — so a bot wading is drawn on top of
   * the surface rather than under a streak sliding across its face.
   */
  const water = buildWaterSurfaces(map);
  ground.addChild(outdoors.ground, water.view);
  const leaves = buildLeafFall();
  /**
   * Trails go on the DRESSING layer, above it, and under everything else.
   *
   * `outdoorDetail` is documented as the non-solid dressing a bot walks over, which is exactly
   * what a scuff is — and above `outdoors.detail` rather than below, because a bot crossing a
   * verge flattens the tufts drawn into it. Under `outdoorObjects` and under the bots for the
   * same one reason: a mark on the ground is on the ground. This also gets fog for free —
   * `fogGfx` draws over `root` — so a trail in ground you have not explored is not visible,
   * which is the opposite end of the same problem the leaves had.
   */
  const trails = buildTrailMarks();
  outdoorDetail.addChild(outdoors.detail, trails.view);
  outdoorObjects.addChild(outdoors.objects);

  const buildings = map.buildings.map((building) => buildBuildingArt(
    building, buildingsLayer, map.placementSlots, map.interactionDots, foreground,
  ));
  /**
   * Outdoor movers plus every floor's, in one list.
   *
   * Interior floors contribute nothing today — nothing indoors sways or turns — but they
   * are collected rather than assumed empty, because a glyph tags its own moving part and a
   * part nobody animates is a frozen one.
   */
  const movers = [
    ...outdoors.movers,
    ...buildings.flatMap((art) => art.floors.flatMap((floor) => floor.movers)),
  ];
  root.addChild(ground, outdoorDetail, outdoorObjects, buildingsLayer);
  /**
   * CANOPIES AND LEAVES DRAW ABOVE THE BOTS, on the one layer built for that.
   *
   * `outdoorForeground` is documented as the place for "marks that must cover a bot passing
   * behind them", and a tree is the clearest case in the world: the collider is the trunk, so
   * everything else about a tree is something you walk UNDER. Reported from play — "the player
   * doesn't go under the tree canopy but they should" — and a leaf in the air belongs there
   * for the same reason.
   *
   * A first attempt put leaves on `outdoorDetail`, the walk-through dressing layer, with a
   * comment arguing a leaf should not cross in front of a trunk. That was wrong, and looking
   * at it settled it in one frame: leaves spend the first half of their fall over the canopy
   * they came off, so under it there was nothing to see at all.
   */
  overhead.addChild(outdoors.overhead, leaves.view);

  return {
    root, ground, outdoorDetail, outdoorObjects, outdoorObjectViews: outdoors.objectViews,
    foreground, outdoorForeground, overhead,
    buildingsLayer, buildings, water: water.surfaces, movers, leaves, trails,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * World text, at world scale.
 *
 * Exported as `makeWorldLabel` because signs need it too, and the alternative was a
 * second `new Text` with its own font and resolution that could drift from every
 * caption already in the world.
 *
 * Both take a `Caption` rather than loose size and colour arguments. Every one of these
 * used to be spelled out at the call site, and two of the six were unreadable on the
 * ground they landed on — see `worldCaption.ts`, which declares each site's grounds and
 * has a test that measures them.
 */
export function makeWorldLabel(caption: Caption): Text {
  return makeLabel("", caption);
}

function makeLabel(text: string, caption: Caption): Text {
  const label = new Text({
    text,
    style: {
      fontFamily: LABEL_FONT,
      fontSize: caption.size,
      fontWeight: caption.weight as "600",
      letterSpacing: caption.tracking,
      fill: caption.ink,
    },
  });
  label.resolution = 2;
  return label;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function buildBuildingArt(
  building: Building,
  buildingsLayer: Container,
  placementSlots: PlacementSlot[] | undefined,
  interactionDots: InteractionDot[] | undefined,
  foregroundRoot: Container,
): BuildingArt {
  const floors: FloorArt[] = [];

  for (const floor of building.floors) {
    const art = floor.label === "ROOF"
      ? buildRoofArt(building, floor)
      : buildFloorArt(
          building,
          floor,
          interactionDots?.filter((dot) => dot.floorId === floor.id) ?? [],
          placementSlots?.filter((slot) => slot.floor === floor.label) ?? [],
        );
    art.view.visible = false;
    art.foreground.visible = false;
    buildingsLayer.addChild(art.view);
    foregroundRoot.addChild(art.foreground);
    floors.push(art);
  }

  // The generated exterior, for a building without an authored ROOF plan. It
  // shares the roof model with the authored case, so a tower looks the same from
  // the street as it does when you are standing on it.
  const roof = new Container();
  const roofModel = buildRoofModel(building);
  roof.addChild(roofModel.view);
  buildingsLayer.addChild(roof);

  /**
   * Kept as an empty container rather than removed.
   *
   * The plan language drew a separate street-side entrance notch here — paper-white
   * gap, ink jambs, dashed canopy. The lit model builds the opening as real
   * geometry instead: curtain, guide rails, reveal, all in the wall itself. So
   * there is nothing left to draw, but callers still toggle this layer when the
   * player steps inside, and giving them a container beats making every caller
   * check whether it exists.
   */
  const entranceMarks = new Container();
  buildingsLayer.addChild(entranceMarks);

  return {
    building,
    roof,
    roofMasses: [roofModel.mass, ...floors.flatMap((art) => (art.roofMass ? [art.roofMass] : []))],
    roofFloorId: floors.find((art) => art.roofMass)?.floor.id ?? null,
    entranceMarks,
    floors,
  };
}

/**
 * The lit-model language backing a FloorArt.
 *
 * Interaction Dots and stair tags are drawn with the shared primitives so the
 * gameplay layer stays identical across languages — only the world underneath it
 * changes.
 */
function buildFloorArt(
  building: Building,
  floor: FloorPlan,
  interactionDots: InteractionDot[],
  placementSlots: PlacementSlot[] = [],
): FloorArt {
  const model = buildFloorModel(building, floor);
  const interactionDotGfx = new Graphics();
  const interactionLabels = new Container();

  const occupied = new Set(floor.objects.map((object) => object.slotId).filter(Boolean));
  const slotGfx = new Graphics();
  for (const slot of placementSlots) {
    if (occupied.has(slot.id)) continue;
    drawModelPlacementSlot(slotGfx, slot);
  }
  // Under the objects, over the floor: it is a mark on the slab, and a bot walks
  // over it until something is installed there.
  model.furniture.addChildAt(slotGfx, 0);

  for (const stair of floor.stairs) {
    const tag = makeLabel(stair.direction === "up" ? "UP" : "DN", CAPTION.stairTag);
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
    movers: model.movers,
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
 * An empty installation bay: floor paint, not linework.
 *
 * Painted onto the slab and completely flat, because that is what it is — nothing
 * stands there yet, and a bot walks straight over it. Corner brackets rather than
 * a closed rectangle: a closed dark outline is the language's word for *solid*,
 * and an empty bay is the opposite of that.
 */
function drawModelPlacementSlot(g: Graphics, slot: PlacementSlot): void {
  const { x, y, w, h } = slot.rect;
  const arm = Math.min(14, Math.min(w, h) * 0.32);
  const width = 2.2;
  for (const [cx, cy, dx, dy] of [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ] as Array<[number, number, number, number]>) {
    g.rect(Math.min(cx, cx + dx * arm), cy - (dy > 0 ? 0 : width), Math.abs(dx * arm), width)
      .fill({ color: V.paint });
    g.rect(cx - (dx > 0 ? 0 : width), Math.min(cy, cy + dy * arm), width, Math.abs(dy * arm))
      .fill({ color: V.paint });
  }
  // Worn centre mark, so the bay reads as a place things get put rather than as
  // fresh unused paint.
  g.circle(x + w / 2, y + h / 2, 2.6).fill({ color: V.paintWorn });
}

/**
 * An authored ROOF plan in the lit-model language. It shares the roof model with
 * the generated exterior, so a building looks the same whether you are standing
 * on it or looking at it from the street.
 */
function buildRoofArt(building: Building, floor: FloorPlan): FloorArt {
  const model = buildRoofModel(building);
  const annotationGfx = new Graphics();
  const annotation = new Container();
  annotation.addChild(annotationGfx);

  const stairViews = new Map<string, { stair: StairLink; view: Container }>();
  /**
   * A roof stair is drawn twice, because a roof is looked at from two places.
   *
   * From the street you are seeing the roof OF the stairwell: a closed housing, which
   * is what `drawStairHead` is for and why it exists — calling the interior
   * `drawStair` here is what once left Downtown's towers with staircases lying open
   * on top of them.
   *
   * Standing on the deck you are seeing INTO it, and the housing then tells the
   * opposite lie. Play found that one: "we can't see the stairs going down, it's just
   * a white square, so it's not obvious it's stairs when on that floor." So the head
   * is built alongside the interior flight and `GameRenderer` shows whichever matches
   * where the camera is. Both, not one switched at build time, because the same roof
   * art serves both views within a single frame.
   *
   * The deck view is `drawStair` itself — the identical white-to-black flight every
   * interior floor draws. A purpose-built roof version was tried first, a housing with
   * its near wall removed, and play rejected it on two counts: the missing wall read as
   * a doorway ("it almost looks like the doors are ways to get off the roof") and the
   * tread ramp is already the familiar language for "down". A stair is a stair.
   */
  const housing = new Container();
  const well = new Container();
  const housingPad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  const wellPad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  for (const stair of floor.stairs) {
    const headGfx = new Graphics();
    drawStairHead(headGfx, housingPad, stair);
    housing.addChild(headGfx);

    /**
     * One container per stair INSIDE the well, rather than handing the well's own
     * graphics to `stairViews`.
     *
     * It used to add `wellGfx` to `well` and then to a bare `view`, and pixi's addChild
     * REPARENTS: the second call silently removed it from the first. So `well` held only
     * its shadow layers, and standing on a roof deck — the one place the well is the
     * visible half — showed a stair's cast shadow with no stair in it. The addressable
     * fixture is still the well, because it is the one a player can stand on and the one
     * fabrication would ever draw onto; it just gets its own node instead of being moved.
     */
    const view = new Container();
    const wellGfx = new Graphics();
    drawStair(wellGfx, wellPad, stair);
    view.addChild(wellGfx);
    well.addChild(view);
    stairViews.set(stair.id, { stair, view });
    const tag = makeLabel(stair.direction === "up" ? "UP" : "DN", CAPTION.stairTag);
    placeStairTag(tag, stair);
    annotation.addChild(tag);
  }
  for (const layer of housingPad) housing.addChildAt(layer, 0);
  for (const layer of wellPad) well.addChildAt(layer, 0);
  const stairs = new Container();
  stairs.addChild(housing, well);
  // Into the mass, not the view: a stair head sitting on the roof has to travel
  // with the roof, or it detaches from the deck the moment the camera moves.
  model.mass.addChild(stairs, annotation);

  return {
    floor,
    view: model.view,
    roofMass: model.mass,
    stairHousing: housing,
    stairWell: well,
    architecture: model.architecture,
    furniture: model.furniture,
    movers: model.movers,
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
    g.circle(x, y, dot.radius).fill({ color: OVERLAY_WHITE });
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
  const label = makeLabel(text, CAPTION.interactionTag);
  label.anchor.set(0.5, 0.5);
  const padX = 5;
  const padY = 3;
  const background = new Graphics();
  background.roundRect(-label.width / 2 - padX, -label.height / 2 - padY, label.width + padX * 2, label.height + padY * 2, 2)
    .fill({ color: OVERLAY_WHITE, alpha: 0.94 })
    .stroke({ color: INK.hairline, width: WEIGHT.hairline });
  tag.addChild(background, label);
  tag.position.set(dot.position.x, dot.position.y - dot.radius - 12);
  return tag;
}

// --- Stairs ------------------------------------------------------------------

/** The open end of the entry half: the side a bot walks in from. */
function stairEntryEnd(stair: StairLink): "N" | "S" | "E" | "W" {
  const { bottom, direction } = stair;
  if (direction === "up") return bottom;
  return bottom === "N" ? "S" : bottom === "S" ? "N" : bottom === "E" ? "W" : "E";
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

// --- Doorways ----------------------------------------------------------------

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function line(g: Graphics, x1: number, y1: number, x2: number, y2: number, s: { color: number; width: number; alpha?: number }): void {
  g.moveTo(x1, y1).lineTo(x2, y2).stroke(s);
}
