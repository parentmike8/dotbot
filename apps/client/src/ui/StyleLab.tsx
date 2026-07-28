import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { defaultGameConfig } from "@dotbot/game/config";
import { CORE_REACH, PLATE_REACH } from "@dotbot/game/shields";
import type { BaseLayout, BaseObjectKind, Building, DotSpawn, FloorPlan, Rect, Vec2 } from "@dotbot/game/types";
import { downtownMap } from "@dotbot/game/content/downtown";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import {
  BASE_OBJECT_KINDS,
  BASE_SLOT_DEFS,
  DEFAULT_BASE_SHELL,
  SINGLETON_BASE_KINDS,
  baseShellDef,
  createBaseMap,
  isObjectAllowedInSlot,
} from "@dotbot/game/content/base";
import { buildMapArt } from "../game/renderer/mapArt";
import { buildFloorModel } from "../game/renderer/model/modelFloor";
import { buildGeometryProof } from "../game/renderer/model/geometryProof";
import { drawDotDisc, drawDotGloss, drawDotMark } from "../game/renderer/dotArt";
import { drawGroundShadow } from "../game/renderer/grounding";
import { roofParallax } from "../game/renderer/model/modelRoof";
import {
  drawBareEdges,
  drawBodyOutline,
  drawChargedCore,
  drawDashRing,
  drawDownedBody,
  drawPlates,
  type BodyStyle,
  type CrackKind,
  type DownedBody,
  type HullKind,
} from "../game/renderer/bodies";
import { V } from "../game/renderer/model/tone";

/**
 * Style lab: one authored floor, drawn once, at a fixed camera.
 *
 * Deliberately not a game surface. There is no ticker, no input and no
 * simulation, so the same floor can be re-rendered and screenshotted hundreds
 * of times while an art language is being tuned. `?lab` selects it.
 *
 *   ?lab&view=model|city|base|quay|geometry|bodies|clump   what to draw
 *   ?lab&zoom=fit|play|close     camera
 *   ?lab&focus=racks|dock|shop|office
 *   ?lab&floor=GROUND|B1
 *   ?lab&actors=0                hide bots and Dots
 */

const BUILDING_ID = "lot6";

type LabParams = {
  view: "model" | "city" | "base" | "geometry" | "quay" | "bodies" | "clump";
  zoom: "fit" | "play" | "close";
  focus: string;
  floorLabel: string;
  actors: boolean;
};

function readParams(search: string): LabParams {
  const p = new URLSearchParams(search);
  const view = p.get("view");
  const zoom = p.get("zoom");
  return {
    view:
      view === "city" || view === "base" || view === "geometry" || view === "quay"
      || view === "bodies" || view === "clump"
        ? view
        : "model",
    zoom: zoom === "play" || zoom === "close" ? zoom : "fit",
    focus: p.get("focus") ?? "racks",
    floorLabel: (p.get("floor") ?? "GROUND").toUpperCase(),
    actors: p.get("actors") !== "0",
  };
}

// ---------------------------------------------------------------------------
// Gameplay colour: the entire chromatic budget, spent where it earns attention
// ---------------------------------------------------------------------------

const SQUAD = 0x22b8cf;
const RIVAL = 0xe03131;
const AMBIENT = 0x868e96;
const DOT_POWERUP = 0xe8590c;
const DOT_RARE = 0xf2b400;
const HULL = 0x14171a;

function powerupColor(spawn: DotSpawn): number {
  if (spawn.item.kind !== "powerup") return 0x1971c2;
  return spawn.item.type === "incognito" ? DOT_RARE : DOT_POWERUP;
}

type LabBot = {
  at: Vec2;
  facing: number;
  color: number;
  shields: number[];
  radius: number;
  /** Mid-dash, so the ring that used to be a hard circle is on show. */
  dashing?: boolean;
};

/**
 * A standing bot, drawn with the production primitives in the production order.
 *
 * Every mark here used to be a hand-rolled copy — plates stroked at 0.78 of the
 * radius long after the game moved them out to the hull — which made the review
 * surface a nicer picture than the game and a useless one for judging it. The lab
 * calls what ships, or it is not a lab.
 *
 * `spin` mirrors what `GameRenderer.drawBotBody` is passed: the game draws a bot
 * once at facing 0 and rotates its container, so the caller says how far that
 * rotation will be. Pass 0 to draw a bot outright at its own facing.
 */
function drawLabBot(g: Graphics, bot: LabBot, spin = 0): void {
  const body = {
    position: bot.at,
    radius: bot.radius,
    facing: bot.facing,
      shieldSegments: bot.shields,
  };
  drawGroundShadow(g, bot.at, body, { spin });
  drawPlates(g, body, bot.color, false);
  drawBodyOutline(g, body);
  drawChargedCore(g, bot.at, bot.radius * CORE_REACH, 1, HULL, spin);
  drawBareEdges(g, body, bot.color);
  if (bot.dashing) drawDashRing(g, body);
}

/**
 * The same bot the way the game actually assembles it: drawn at facing 0 into a
 * Graphics, then spun by its container.
 *
 * This is not pedantry about plumbing. Everything that encodes a direction in the
 * world — the sun above all — is inside that rotation, so a lab that draws bots
 * outright at their facing is the one surface that cannot show a light riding
 * around with its bot.
 */
function spunLabBot(bot: LabBot): Container {
  const held = new Container();
  const g = new Graphics();
  drawLabBot(g, { ...bot, at: { x: 0, y: 0 }, facing: 0 }, bot.facing);
  held.addChild(g);
  held.position.set(bot.at.x, bot.at.y);
  held.rotation = bot.facing;
  return held;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const FOCUS: Record<string, Rect> = {
  // Pick aisles and the racking runs: the hero of a depot floor.
  racks: { x: 330, y: 1120, w: 380, h: 300 },
  // Dock strip, roll-up doors and staged freight.
  dock: { x: 170, y: 1005, w: 480, h: 220 },
  // Workshop bench, tool chest and locker bank.
  shop: { x: 165, y: 1175, w: 260, h: 270 },
  // Dispatch office.
  office: { x: 690, y: 1290, w: 175, h: 170 },
  // Main St crossing Third Ave: kerbs, crossings, parked cars, street trees.
  street: { x: 900, y: 560, w: 700, h: 440 },
};

/**
 * `?focus=x,y,w,h` frames an arbitrary rectangle of the sheet.
 *
 * The named regions above are all interiors, which is no use during a pass over
 * the exterior: judging a frontage or a yard means looking at one, and the
 * whole-sheet fit is too small to see paving joints or how a tree meets a kerb.
 */
function focusRect(focus: string): Rect | null {
  const parts = focus.split(",").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function cameraFor(params: LabParams, fp: Rect, viewport: { w: number; h: number }): { scale: number; center: Vec2 } {
  const explicit = focusRect(params.focus);
  if (explicit) {
    const margin = 16;
    return {
      scale: Math.min((viewport.w - margin * 2) / explicit.w, (viewport.h - margin * 2) / explicit.h),
      center: { x: explicit.x + explicit.w / 2, y: explicit.y + explicit.h / 2 },
    };
  }

  if (params.view === "quay") {
    const margin = 22;
    const sheet = { x: 0, y: 0, w: quaysideMap.width, h: quaysideMap.height };
    return {
      scale: Math.min((viewport.w - margin * 2) / sheet.w, (viewport.h - margin * 2) / sheet.h),
      center: { x: sheet.w / 2, y: sheet.h / 2 },
    };
  }
  if (params.view === "geometry") {
    const margin = 24;
    return {
      scale: Math.min((viewport.w - margin * 2) / fp.w, (viewport.h - margin * 2) / fp.h),
      center: { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 },
    };
  }
  const city = params.view === "city";
  if (city && params.zoom === "fit") {
    const sheet = { x: 0, y: 0, w: downtownMap.width, h: downtownMap.height };
    const margin = 20;
    return {
      scale: Math.min((viewport.w - margin * 2) / sheet.w, (viewport.h - margin * 2) / sheet.h),
      center: { x: sheet.w / 2, y: sheet.h / 2 },
    };
  }
  if (params.zoom === "fit") {
    const margin = 34;
    const scale = Math.min((viewport.w - margin * 2) / fp.w, (viewport.h - margin * 2) / fp.h);
    return { scale, center: { x: fp.x + fp.w / 2, y: fp.y + fp.h / 2 } };
  }
  const region = FOCUS[params.focus] ?? FOCUS.racks;
  if (params.zoom === "close") {
    const scale = Math.min(viewport.w / region.w, viewport.h / region.h);
    return { scale, center: { x: region.x + region.w / 2, y: region.y + region.h / 2 } };
  }
  // Play zoom: roughly what a player sees on this device, independent of region
  // size, so legibility can be judged rather than composition.
  const visibleHeight = 660;
  const scale = viewport.h / visibleHeight;
  // Keep the frame inside the building where it fits, so a legibility test is
  // not half filled with the void outside the footprint.
  const halfW = viewport.w / 2 / scale;
  const halfH = viewport.h / 2 / scale;
  const clamp = (value: number, lo: number, hi: number): number =>
    (hi < lo ? (lo + hi) / 2 : Math.min(Math.max(value, lo), hi));
  return {
    scale,
    center: {
      x: clamp(region.x + region.w / 2, fp.x + halfW, fp.x + fp.w - halfW),
      y: clamp(region.y + region.h / 2, fp.y + halfH, fp.y + fp.h - halfH),
    },
  };
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

function findFloor(building: Building, label: string): FloorPlan {
  return building.floors.find((f) => f.label === label) ?? building.floors[0];
}

/** The new language. */
function modelWorld(building: Building, floor: FloorPlan, params: LabParams): Container {
  const world = new Container();
  const { view } = buildFloorModel(building, floor);
  world.addChild(view);

  if (!params.actors) return world;

  const actors = new Graphics();
  for (const spawn of floor.dotSpawns) {
    // The same three calls the game makes, in the same order. The lab used to draw
    // bare spheres with no mark on them, which made it a nicer picture than the
    // game and a useless one for judging what a Dot actually looks like.
    // The size the simulation actually gives a Dot, not the authored hint: every
    // Dot in a run is `config.dotRadius`, and the lab drawing them a tenth larger
    // is the lab flattering itself.
    const radius = defaultGameConfig.dotRadius;
    drawDotDisc(actors, spawn.position, radius, powerupColor(spawn));
    drawDotMark(actors, spawn.item, spawn.position, radius);
    drawDotGloss(actors, spawn.position, radius);
  }
  for (const bot of labBots(floor)) drawLabBot(actors, bot);
  for (const body of labBodies(floor)) drawDownedBody(actors, body);
  world.addChild(actors);
  return world;
}

/**
 * The whole sheet as a player standing on the street sees it: interiors hidden,
 * each building showing either its authored ROOF plan or its generated roof.
 * `buildMapArt` builds every floor and leaves visibility to the caller, so a
 * city view that skips this stacks every interior on top of the roofs.
 */
function cityWorld(): Container {
  const world = new Container();
  const art = buildMapArt(downtownMap);
  /**
   * Parallax, as a camera in the middle of the sheet would see it.
   *
   * The lab has no camera of its own, so without this the one cue that says a
   * building is tall is the one cue the review surface cannot show — and a review
   * surface that quietly omits the thing under review is worse than no shot.
   */
  const viewCenter = { x: downtownMap.width / 2, y: downtownMap.height / 2 };
  for (const building of art.buildings) {
    const offset = roofParallax(building.building, viewCenter);
    for (const mass of building.roofMasses) mass.position.set(offset.x, offset.y);
    const hasRoof = building.building.floors.some((floor) => floor.label === "ROOF");
    for (const floorArt of building.floors) {
      floorArt.view.visible = floorArt.floor.label === "ROOF";
      floorArt.foreground.visible = floorArt.view.visible;
    }
    building.roof.visible = !hasRoof;
  }
  world.addChild(art.root);
  return world;
}

/**
 * The player base, fully fitted out.
 *
 * Every base object kind at once, which is the only way to judge them: they all
 * materialize into the same two placement-slot rectangles, so what matters is
 * whether a fabricator is still distinguishable from a bay console when they are
 * side by side at the same size. A shot of one in isolation proves nothing.
 */
function baseWorld(floorLabel: string): Container {
  const world = new Container();

  /**
   * Prefer a kind not yet shown, so the fit-out covers as much of the kit as the
   * slots allow. Singletons may only appear once, which is why this cannot just
   * cycle: the base holds exactly one fabricator, and asking for two throws.
   */
  const layout: BaseLayout = {};
  const shown = new Set<BaseObjectKind>();
  for (const slot of BASE_SLOT_DEFS) {
    const allowed = BASE_OBJECT_KINDS.filter((kind) => isObjectAllowedInSlot(kind, slot));
    const free = allowed.filter((kind) => !SINGLETON_BASE_KINDS.has(kind) || !shown.has(kind));
    const pick = free.find((kind) => !shown.has(kind)) ?? free[0];
    if (!pick) continue;
    layout[slot.id] = pick;
    shown.add(pick);
  }

  const map = createBaseMap(layout, DEFAULT_BASE_SHELL, { expanded: true });
  const art = buildMapArt(map);
  for (const building of art.buildings) {
    for (const floorArt of building.floors) {
      floorArt.view.visible = floorArt.floor.label === floorLabel;
      floorArt.foreground.visible = floorArt.view.visible;
    }
    building.roof.visible = false;
  }
  world.addChild(art.root);
  return world;
}


/**
 * Every candidate downed body at once, over a standing bot for scale.
 *
 * Which crack reads as damage rather than as a fitting, and whether the hull wants
 * to be whole or open, are judgement calls — and a judgement call is made by
 * looking at the options side by side, not by describing them.
 */
const CRACKS: CrackKind[] = ["straight", "zigzag", "shatter", "none"];
const HULLS: HullKind[] = ["whole", "broken"];

function bodiesWorld(): Container {
  const world = new Container();
  const g = new Graphics();
  const cell = 130;
  const originX = 90;
  const originY = 360;

  // Reference: what a bot looks like still standing, at the same size.
  drawLabBot(g, { at: { x: originX, y: 46 }, facing: -Math.PI / 2, color: RIVAL, shields: [1, 0.5, 1], radius: 24 });
  world.addChild(label("ALIVE, FOR SCALE", originX + 34, 42));

  /**
   * The dash gauge, drained and refilling. Drawn on rivals too, so "can that thing
   * still dash at me" is something you read rather than guess.
   *
   * Twice, at two sizes. The play-size row answers the only question that matters
   * — is the level legible on a 9.6-unit core in a fight — and is far too small to
   * show *why* it does or does not work. The magnified row is where the surface is
   * actually judged. Either row on its own would flatter the drawing or hide it.
   */
  const charge = [0, 0.15, 0.35, 0.6, 0.85, 1];
  charge.forEach((level, index) => {
    const x = originX + 330 + index * 68;
    const at = { x, y: 46 };
    // The plates, then the core — but never the reference bot's own filled core
    // underneath, which would put the gauge's dim half on top of solid ink and
    // hide exactly the contrast this row exists to judge.
    const body = { position: at, radius: 24, facing: -Math.PI / 2, shieldSegments: [1, 1, 1] };
    drawGroundShadow(g, at, body);
    drawPlates(g, body, SQUAD, false);
    drawBodyOutline(g, body);
    drawChargedCore(g, at, 24 * CORE_REACH, level, HULL);
    world.addChild(label(`${Math.round(level * 100)}%`, x - 10, 78));
  });
  world.addChild(label("DASH CHARGE  \u00b7  play size", originX + 330, 98));

  charge.forEach((level, index) => {
    drawChargedCore(g, { x: originX + 340 + index * 104, y: 205 }, 43, level, HULL);
  });
  world.addChild(label("DASH CHARGE  \u00b7  magnified, for judging the surface", originX + 330, 282));

  HULLS.forEach((hull, row) => {
    CRACKS.forEach((crack, column) => {
      const style: BodyStyle = { crack, hull };
      const x = originX + column * cell;
      const y = originY + row * cell * 1.55;
      // Unsearched with a carry, then searched and stripped, so both core
      // treatments are visible for every crack.
      drawDownedBody(g, { at: { x, y }, radius: 24, color: RIVAL, carriedCount: 3, searched: false, style });
      drawDownedBody(g, { at: { x, y: y + 70 }, radius: 24, color: AMBIENT, carriedCount: 0, searched: true, style });
      world.addChild(label(`${hull} / ${crack}`, x - 44, y + 108));
    });
  });

  world.addChild(g);
  return world;
}

/**
 * Two bots at the distance the solver actually rests them at.
 *
 * This case is the bug. A DotBot separates at its plate where a plate is up and
 * at its core where one is gone, so the closest two bodies can legally sit is
 * 48.00 fully plated, 33.60 with a plate meeting a bare arc, and 19.20 bare to
 * bare — and at every one of those distances the drawing used to put ink through
 * ink. A stripped bot drew a ghost plate ring 22.5 out from a body that reaches
 * 9.6, so two of them at their legal 19.20 overlapped by 25.8 units of ring with
 * each ring enclosing the other's centre. Play reads the drawing, so play saw
 * bots welded together and reported the physics.
 *
 * The bottom row is the other half of it: the same bot at eight facings, each
 * drawn the way the game assembles one — at facing 0 into a Graphics, spun by its
 * container. If the sun is inside that rotation, the shadow swings round the row.
 */
const REST = {
  plated: 24 * PLATE_REACH * 2,
  mixed: 24 * PLATE_REACH + 24 * CORE_REACH,
  bare: 24 * CORE_REACH * 2,
};

function clumpWorld(): Container {
  const world = new Container();
  const g = new Graphics();
  const radius = 24;

  const pair = (
    y: number,
    gap: number,
    left: { shields: number[]; facing: number; color: number; dashing?: boolean },
    right: { shields: number[]; facing: number; color: number; dashing?: boolean },
    caption: string,
  ): void => {
    const x = 130;
    // The measure itself, centre to centre: the number under review, drawn.
    g.moveTo(x, y).lineTo(x + gap, y).stroke({ color: 0x6d7278, width: 0.5, alpha: 0.5 });
    for (const [at, bot] of [
      [{ x, y }, left],
      [{ x: x + gap, y }, right],
    ] as const) {
      world.addChild(spunLabBot({
        at, facing: bot.facing, color: bot.color, shields: bot.shields, radius, dashing: bot.dashing,
      }));
    }
    world.addChild(label(caption, x + gap + 46, y - 4));
  };

  world.addChild(g);

  pair(
    70,
    REST.plated,
    { shields: [1, 1, 1], facing: 0, color: SQUAD },
    { shields: [1, 1, 1], facing: Math.PI, color: RIVAL },
    `PLATE MEETS PLATE  ·  ${REST.plated.toFixed(2)}`,
  );
  pair(
    185,
    REST.mixed,
    { shields: [1, 1, 1], facing: 0, color: SQUAD },
    { shields: [0, 0, 0], facing: Math.PI, color: RIVAL },
    `PLATE MEETS BARE  ·  ${REST.mixed.toFixed(2)}`,
  );
  pair(
    285,
    REST.bare,
    { shields: [0, 0, 0], facing: 0, color: SQUAD },
    { shields: [0, 0, 0], facing: Math.PI, color: RIVAL },
    `BARE MEETS BARE  ·  ${REST.bare.toFixed(2)}`,
  );
  // The bite pointed at the other bot: plate 2 is the broken one, so facing it
  // backwards puts the open arc dead ahead.
  pair(
    385,
    REST.mixed,
    { shields: [1, 1, 0], facing: (Math.PI * 2) / 3, color: SQUAD, dashing: true },
    { shields: [1, 1, 1], facing: Math.PI, color: RIVAL },
    `BITE MEETS PLATE  ·  ${REST.mixed.toFixed(2)}  ·  left bot mid-dash`,
  );

  for (let index = 0; index < 8; index += 1) {
    const facing = (index * Math.PI * 2) / 8;
    world.addChild(spunLabBot({
      at: { x: 130 + index * 66, y: 495 },
      facing,
      color: AMBIENT,
      shields: [1, 1, 0],
      radius,
      dashing: true,
    }));
  }
  world.addChild(label("ONE LIGHT  ·  the same bot at eight facings: the sun may not turn with it", 130, 540));

  return world;
}

function label(text: string, x: number, y: number): Text {
  const node = new Text({
    text,
    style: { fill: 0x6d7278, fontFamily: "ui-monospace, monospace", fontSize: 9, letterSpacing: 1.2 },
  });
  node.position.set(x, y);
  return node;
}

/**
 * Bodies next to the bots that are still standing, because that is the only
 * comparison that matters: down has to read as down at a glance, and the three
 * states a body can be in — holding something and unsearched, open with something
 * left, open and stripped — have to be told apart without stopping to look.
 */
function labBodies(floor: FloorPlan): DownedBody[] {
  if (floor.label !== "GROUND") return [];
  return [
    { at: { x: 453, y: 1395 }, radius: 24, color: RIVAL, carriedCount: 4, searched: false },
    { at: { x: 513, y: 1395 }, radius: 24, color: AMBIENT, carriedCount: 2, searched: true },
    { at: { x: 573, y: 1395 }, radius: 24, color: SQUAD, carriedCount: 0, searched: true },
  ];
}

/**
 * Three bots placed to test the thing that matters: can you find your own bot,
 * spot a rival and read a Dot in one glance, in a room this dense?
 */
function labBots(floor: FloorPlan): LabBot[] {
  if (floor.label !== "GROUND") {
    return [{ at: { x: 470, y: 1200 }, facing: -Math.PI / 2, color: SQUAD, shields: [1, 1, 1], radius: 24 }];
  }
  return [
    { at: { x: 453, y: 1330 }, facing: -Math.PI / 2, color: SQUAD, shields: [1, 0.5, 1], radius: 24 },
    { at: { x: 573, y: 1215 }, facing: Math.PI / 2, color: RIVAL, shields: [1, 1, 0], radius: 24 },
    { at: { x: 700, y: 1075 }, facing: Math.PI, color: AMBIENT, shields: [1, 1, 1], radius: 24 },
  ];
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function caption(text: string): Text {
  return new Text({
    text,
    style: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      letterSpacing: 1.4,
      fill: 0x6b7178,
      fontWeight: "600",
    },
  });
}

/** One frame the lab knows how to draw. */
type Shot = LabParams & { name: string; w: number; h: number };

/**
 * The deliverable set. Exported at a fixed size so the frames are comparable to
 * each other and independent of whatever window the lab happens to open in.
 */
const SHOT_SET: Shot[] = [
  { name: "60-rest-distances", view: "clump", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1300 },
  { name: "50-downed-bodies", view: "bodies", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: true, w: 1700, h: 1250 },
  { name: "40-base-ground", view: "base", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1500, h: 1100 },
  { name: "41-base-upper", view: "base", zoom: "fit", focus: "racks", floorLabel: "F1", actors: false, w: 1500, h: 1100 },
  { name: "31-quayside-source", view: "quay", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1400, h: 1440 },
  { name: "30-geometry-kernel", view: "geometry", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1900, h: 800 },
  { name: "20-city-model", view: "city", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: false, w: 1800, h: 1200 },
  { name: "21-street-close", view: "city", zoom: "close", focus: "street", floorLabel: "GROUND", actors: false, w: 1600, h: 1000 },
  { name: "01-floor-model", view: "model", zoom: "fit", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1000 },
  { name: "05-racks-close", view: "model", zoom: "close", focus: "racks", floorLabel: "GROUND", actors: true, w: 1500, h: 1100 },
  { name: "06-dock-close", view: "model", zoom: "close", focus: "dock", floorLabel: "GROUND", actors: true, w: 1600, h: 760 },
  { name: "07-shop-close", view: "model", zoom: "close", focus: "shop", floorLabel: "GROUND", actors: true, w: 1100, h: 1150 },
  { name: "08-office-close", view: "model", zoom: "close", focus: "office", floorLabel: "GROUND", actors: true, w: 1100, h: 1000 },
  { name: "09-basement-model", view: "model", zoom: "fit", focus: "racks", floorLabel: "B1", actors: true, w: 1500, h: 1000 },
  { name: "10-play-zoom", view: "model", zoom: "play", focus: "racks", floorLabel: "GROUND", actors: true, w: 900, h: 560 },
  { name: "11-play-zoom-phone", view: "model", zoom: "play", focus: "racks", floorLabel: "GROUND", actors: true, w: 390, h: 720 },
];

export function StyleLab() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let app: Application | null = null;
    let disposed = false;

    const params = readParams(window.location.search);
    const shotMode = new URLSearchParams(window.location.search).has("shots");
    const building = downtownMap.buildings.find((b) => b.id === BUILDING_ID)!;
    const fp = building.footprint;

    void (async () => {
      const created = new Application();
      await created.init({
        background: V.void,
        width: host.clientWidth,
        height: host.clientHeight,
        antialias: true,
        autoStart: false,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        preference: "webgl",
        preserveDrawingBuffer: true,
      });
      if (disposed) {
        created.destroy(true);
        return;
      }
      app = created;
      // Pixi sizes the backing store; the element still needs a CSS box or it
      // lays out at its device-pixel width and the camera reads as 2x zoomed.
      created.canvas.style.width = "100%";
      created.canvas.style.height = "100%";
      created.canvas.style.display = "block";
      host.appendChild(created.canvas);

      /** Draw one spec into a viewport of the given size. */
      const compose = (spec: LabParams, viewport: { w: number; h: number }): void => {
        created.stage.removeChildren();
        const floor = findFloor(building, spec.floorLabel);

        const bg = new Graphics();
        bg.rect(0, 0, viewport.w, viewport.h).fill({ color: V.void });
        created.stage.addChild(bg);

        if (spec.view === "quay") {
          const camera = cameraFor(spec, fp, viewport);
          const bg = new Graphics();
          bg.rect(0, 0, viewport.w, viewport.h).fill({ color: V.void });
          const art = buildMapArt(quaysideMap);
          // Ground floor visible: this is a walk-in view, not a street view.
          for (const building of art.buildings) {
            for (const floorArt of building.floors) {
              floorArt.view.visible = floorArt.floor.label === "GROUND";
              floorArt.foreground.visible = floorArt.view.visible;
            }
            building.roof.visible = false;
            building.entranceMarks.visible = false;
          }
          const world = new Container();
          world.addChild(art.root);
          world.scale.set(camera.scale);
          world.position.set(
            viewport.w / 2 - camera.center.x * camera.scale,
            viewport.h / 2 - camera.center.y * camera.scale,
          );
          created.stage.addChild(bg, world);
          created.stage.addChild(Object.assign(
            caption("QUAYSIDE DEPOT  ·  authored in map source  ·  L-plan shell, chamfer, diagonal + curved partitions, curved quay wall"),
            { x: 16, y: 14 },
          ));
          return;
        }
        if (spec.view === "geometry") {
          const proof = buildGeometryProof();
          const camera = cameraFor(spec, proof.bounds, viewport);
          proof.view.scale.set(camera.scale);
          proof.view.position.set(
            viewport.w / 2 - camera.center.x * camera.scale,
            viewport.h / 2 - camera.center.y * camera.scale,
          );
          created.stage.addChild(proof.view);
          created.stage.addChild(Object.assign(
            caption("GEOMETRY KERNEL  ·  polygons, thick paths, fillets  ·  cyan track = where a 24-unit bot is actually stopped"),
            { x: 16, y: 14 },
          ));
          return;
        }

        if (spec.view === "clump") {
          const world = clumpWorld();
          world.scale.set(2.2);
          created.stage.addChild(world);
          created.stage.addChild(Object.assign(
            caption("BODIES AT THEIR TRUE REST DISTANCE  \u00b7  no mark may cross another bot's silhouette  \u00b7  centre line = the measured gap"),
            { x: 16, y: 14 },
          ));
          return;
        }

        if (spec.view === "bodies") {
          const world = bodiesWorld();
          world.scale.set(1.55);
          created.stage.addChild(world);
          created.stage.addChild(Object.assign(
            caption("DOWNED BODY CANDIDATES  \u00b7  top row unsearched with a carry, bottom row searched and stripped"),
            { x: 16, y: 14 },
          ));
          return;
        }

        if (spec.view === "base") {
          const world = baseWorld(spec.floorLabel);
          const shell = baseShellDef(DEFAULT_BASE_SHELL).footprint;
          const camera = cameraFor(spec, shell, viewport);
          world.scale.set(camera.scale);
          world.position.set(
            viewport.w / 2 - camera.center.x * camera.scale,
            viewport.h / 2 - camera.center.y * camera.scale,
          );
          created.stage.addChild(world);
          created.stage.addChild(Object.assign(
            caption(`PLAYER BASE / ${spec.floorLabel}  \u00b7  every installable kind at once  \u00b7  all in the same placement-slot rectangles`),
            { x: 16, y: 14 },
          ));
          return;
        }

        const camera = cameraFor(spec, fp, viewport);
        const world = spec.view === "city"
          ? cityWorld()
          : modelWorld(building, floor, spec);
        world.scale.set(camera.scale);
        world.position.set(
          viewport.w / 2 - camera.center.x * camera.scale,
          viewport.h / 2 - camera.center.y * camera.scale,
        );
        created.stage.addChild(world);
        created.stage.addChild(
          Object.assign(
            caption(
              `${building.name} / ${floor.label}  ·  ${spec.view.toUpperCase()}  ·  ${spec.zoom}${
                spec.zoom === "fit" ? "" : ` @ ${spec.focus}`
              }`,
            ),
            { x: 16, y: 14 },
          ),
        );
      };

      const draw = (): void => {
        // Pixi's own `resizeTo` defers the resize to the next ticker frame, and
        // this surface deliberately has no ticker, so resize explicitly.
        created.renderer.resize(host.clientWidth, host.clientHeight);
        compose(params, { w: created.screen.width, h: created.screen.height });
        created.render();
      };

      /**
       * Cost of the language, measured rather than asserted. Reported as the
       * median of repeated passes: build is the once-per-floor geometry cost,
       * render is what a frame actually pays.
       */
      const measure = (): Record<string, unknown> => {
        const floor = findFloor(building, "GROUND");
        const median = (runs: number, fn: () => void): number => {
          const times: number[] = [];
          for (let i = 0; i < runs; i += 1) {
            const t0 = performance.now();
            fn();
            times.push(performance.now() - t0);
          }
          return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
        };

        let built: Container | null = null;
        const buildMs = median(9, () => {
          built = buildFloorModel(building, floor).view;
        });

        created.renderer.resize(1280, 720);
        created.stage.removeChildren();
        const world = built!;
        world.scale.set(1.6);
        world.position.set(640 - 510 * 1.6, 360 - 1230 * 1.6);
        created.stage.addChild(world);
        const renderMs = median(30, () => created.render());

        let nodes = 0;
        const walk = (node: Container): void => {
          nodes += 1;
          for (const child of node.children) walk(child as Container);
        };
        walk(world);

        return {
          floorObjects: floor.objects.length,
          floorWalls: floor.walls.length,
          buildMs: Number(buildMs.toFixed(2)),
          renderMs: Number(renderMs.toFixed(3)),
          displayNodes: nodes,
        };
      };

      if (shotMode) {
        const results: string[] = [];
        for (const shot of SHOT_SET) {
          created.renderer.resize(shot.w, shot.h);
          compose(shot, { w: shot.w, h: shot.h });
          created.render();
          const png = created.canvas.toDataURL("image/png");
          const response = await fetch("/__lab/shot", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: shot.name, png }),
          });
          const body = await response.json() as { ok?: boolean; error?: string };
          results.push(`${shot.name}: ${body.ok ? "ok" : `FAILED ${body.error ?? ""}`}`);
        }
        (window as unknown as { labShots?: string[] }).labShots = results;
        (window as unknown as { labPerf?: unknown }).labPerf = measure();
        draw();
        return;
      }

      draw();
      const observer = new ResizeObserver(() => draw());
      observer.observe(host);
      (created as unknown as { __labObserver?: ResizeObserver }).__labObserver = observer;
    })();

    return () => {
      disposed = true;
      const held = app as unknown as { __labObserver?: ResizeObserver } | null;
      held?.__labObserver?.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} style={{ position: "fixed", inset: 0, overflow: "hidden" }} />;
}
