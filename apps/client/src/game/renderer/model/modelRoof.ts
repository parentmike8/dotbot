import { Container, Graphics } from "pixi.js";
import { isGroundFloor } from "@dotbot/game/mapModel";
import type { Building, Rect } from "@dotbot/game/types";
import { inwardBand, isAcross, perimeterEntrances } from "./entrances";
import { drawModelObject } from "./modelGlyphs";
import {
  AO_ALPHA,
  contact,
  inlay,
  jitter,
  LIFT,
  MAT,
  occlude,
  seam,
  shade,
  SHADOW_ALPHA,
  V,
  volume,
  type ShadowPad,
} from "./tone";

/**
 * A building seen from the street: its roof.
 *
 * The old language drew a blank concealment plate, which is why the exterior read
 * as a diagram of blocks. A roof is a real surface with a parapet standing above
 * it, a membrane laid in sheets, and equipment sitting where the building below
 * needs it — so it gets the same volume, light and shadow as everything else, and
 * the parapet's cast shadow on its own deck is what sells the building's height.
 */

/**
 * Mirrors the floor model's layer contract, because a roof is reached two ways:
 * as a building's generated exterior, and as an authored ROOF plan a player can
 * actually walk on. Both must be the same surface.
 */
export type RoofModel = {
  view: Container;
  architecture: Container;
  furniture: Container;
  objectViews: Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>;
};

const ROOF = {
  /** Membrane field. Darker than the sidewalk so a block reads as raised. */
  membrane: 0xbcc0c4,
  membraneLit: 0xc6cacd,
  /** Sheet laps across the field. */
  lap: 0xb1b5ba,
  /**
   * Parapet coping: a lit cap on a dark upstand.
   *
   * This was 0xdfe2e5 — brighter than the pavement it sat against — and it ran
   * flush to the footprint, so every building in the city wore a near-white line
   * all the way round. It matches the site walls' lit edge now, because a parapet
   * and a yard wall are the same material in the same light.
   */
  coping: 0x4d5359,
  /** A small surface the light reaches square on: a walkway's edge, a soffit. */
  sunlit: 0xdfe2e5,
  /** Weathering that collects in the low corners. */
  soil: 0xadb1b6,
  /** Inside a doorway reveal, below the roof plane and out of the light. */
  reveal: 0x7f858b,
} as const;

/** Where a roof's service zone is: over the deepest wall-backed strip. */
function serviceEdge(fp: Rect): Rect {
  return { x: fp.x + fp.w * 0.58, y: fp.y + 22, w: fp.w * 0.36, h: 54 };
}

export function buildRoofModel(building: Building): RoofModel {
  const fp = building.footprint;
  const view = new Container();
  const deck = new Graphics();
  const parapet = new Graphics();
  const equipment = new Container();

  const pad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  const aoPad: ShadowPad = AO_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });

  // The whole block casts onto the street. This is what gives a building height.
  contact(pad, fp, LIFT.wall * 2.4);

  const wall = 12;
  inlay(deck, fp, ROOF.membrane);

  // Membrane laid in sheets, lapped north to south.
  const sheet = 92;
  for (let y = fp.y + sheet; y < fp.y + fp.h; y += sheet) {
    inlay(deck, { x: fp.x, y: y - 1, w: fp.w, h: 2 }, ROOF.lap);
    inlay(deck, { x: fp.x, y: y - 1, w: fp.w, h: 0.8 }, ROOF.membraneLit);
  }

  // Falls: the deck drains toward outlets, so it darkens away from the ridge.
  for (let i = 0; i < 4; i += 1) {
    const t = i / 4;
    inlay(
      deck,
      { x: fp.x + wall, y: fp.y + fp.h - wall - (fp.h * 0.34) * (1 - t), w: fp.w - wall * 2, h: 2 + t * 8 },
      shade(ROOF.membrane, 0.985),
    );
  }

  // Soiling in the corners, where nothing sweeps and water sits.
  for (const [cx, cy] of [
    [fp.x + wall, fp.y + wall],
    [fp.x + fp.w - wall - 60, fp.y + wall],
    [fp.x + wall, fp.y + fp.h - wall - 60],
    [fp.x + fp.w - wall - 60, fp.y + fp.h - wall - 60],
  ]) {
    inlay(deck, { x: cx, y: cy, w: 60, h: 60 }, ROOF.soil);
  }

  /**
   * Parapet: a continuous upstand, standing back off the wall face, with its coping
   * inside. Its shadow falls onto its own deck along the north and west runs, which
   * is the cue that reads as "this surface is below that wall" rather than "this is
   * a drawn outline".
   *
   * Two things were wrong here, and both came of building the ring out of four runs
   * and lighting each one along its own north and west edge. The coping landed on
   * the *inner* face of the south and east runs, and it landed flush to the
   * building's outer edge on the north and west ones — so what a bot rested against
   * outdoors was a bright line, not a wall. Contract §3 settles that: dark, closed
   * outlines mean solid, so the wall top stays dark to the very edge and the coping
   * sits inboard of it. Which is how a parapet is built anyway — the stone is set
   * back off the face, with the wall below it in shadow.
   *
   * And because each run lit its own north edge, the side runs each put a
   * `wall` x 3.5 block of coping under the north parapet: a bright step at all four
   * corners of a line that should be continuous. One ring, drawn once, has no
   * corners to get wrong.
   */
  const inner: Rect = { x: fp.x + wall, y: fp.y + wall, w: fp.w - wall * 2, h: fp.h - wall * 2 };
  const reveal = 2.5; // the wall face below the coping: dark, and the building's edge
  const stone = 4.5;
  for (const run of [
    { x: fp.x, y: fp.y, w: fp.w, h: wall },
    { x: fp.x, y: fp.y + fp.h - wall, w: fp.w, h: wall },
    { x: fp.x, y: fp.y + wall, w: wall, h: fp.h - wall * 2 },
    { x: fp.x + fp.w - wall, y: fp.y + wall, w: wall, h: fp.h - wall * 2 },
  ]) {
    inlay(parapet, run, V.wallCap);
  }
  // The coping is a horizontal top surface, so it takes one value all the way
  // round: under a single light, only faces that turn differ.
  const cap: Rect = { x: fp.x + reveal, y: fp.y + reveal, w: fp.w - reveal * 2, h: fp.h - reveal * 2 };
  for (const band of [
    { x: cap.x, y: cap.y, w: cap.w, h: stone },
    { x: cap.x, y: cap.y + cap.h - stone, w: cap.w, h: stone },
    { x: cap.x, y: cap.y, w: stone, h: cap.h },
    { x: cap.x + cap.w - stone, y: cap.y, w: stone, h: cap.h },
  ]) {
    inlay(parapet, band, ROOF.coping);
  }
  // Inner shadow cast by the north and west parapet onto the deck.
  for (let i = 0; i < 5; i += 1) {
    const t = i / 5;
    const reach = 14 * (1 - t) + 2;
    parapet.rect(inner.x, inner.y, inner.w, reach).fill({ color: 0x000000, alpha: 0.035 });
    parapet.rect(inner.x, inner.y, reach, inner.h).fill({ color: 0x000000, alpha: 0.028 });
  }

  drawEntranceRecesses(parapet, building);

  // Roof access over the service zone, plus drainage outlets at the low corners.
  const service = serviceEdge(fp);
  const hatch: Rect = { x: service.x, y: service.y, w: 54, h: 44 };
  occlude(aoPad, hatch, 7);
  contact(pad, hatch, LIFT.cabinet);
  const lid = volume(equipmentGraphics(equipment), hatch, MAT.steelDark, LIFT.cabinet, 2);
  seam(
    equipmentGraphics(equipment),
    lid.x + lid.w * 0.5, lid.y + 2, lid.x + lid.w * 0.5, lid.y + lid.h - 2,
    MAT.steelDeep.top, 1.1,
  );

  for (const [ox, oy] of [
    [fp.x + wall + 26, fp.y + fp.h - wall - 26],
    [fp.x + fp.w - wall - 26, fp.y + fp.h - wall - 26],
  ]) {
    const g = equipmentGraphics(equipment);
    // A dished sump with a straight-barred leaf grate. Bars, not radial spokes:
    // spokes read as a swirl, and nothing that moves gets a static mark.
    g.circle(ox, oy, 10).fill({ color: shade(ROOF.membrane, 0.9) });
    g.circle(ox, oy, 6.5).fill({ color: MAT.steelDeep.front });
    for (const off of [-3.2, 0, 3.2]) {
      g.rect(ox - 5.6, oy + off - 0.6, 11.2, 1.2).fill({ color: MAT.steelDark.top });
    }
  }

  // Any authored ROOF plan's own objects still draw; otherwise derive a small
  // plant run along the service edge so the roof belongs to the building below.
  const objectViews = new Map<string, { object: import("@dotbot/game/types").MapObject; view: Graphics }>();
  const authored = building.floors.find((floor) => floor.label === "ROOF");
  if (authored) {
    for (const object of [...authored.objects].sort((a, b) => a.y + a.h - (b.y + b.h))) {
      const g = new Graphics();
      occlude(aoPad, object, 6);
      drawModelObject(g, pad, object);
      equipment.addChild(g);
      objectViews.set(object.id, { object, view: g });
    }
  } else {
    /**
     * A derived roof still has to belong to the building underneath it.
     *
     * Plant alone was not enough: Mercy Clinic's roof is 620 x 440 and had five
     * air handlers in one corner, so from the street it read as an empty grey
     * field — half the block's buildings looked unfinished next to the two with
     * authored roofs. Two systems fix it and both are real, which is what keeps
     * them inside the contract's "no decoration" rule.
     *
     * A **walkway** from the hatch along the plant run, because somebody has to
     * service those units without walking on the membrane. And **rooflights** over
     * the span, which are the most characteristic thing on a long-span roof —
     * three rows for a warehouse, two for a hospital, none where the floor below
     * is cellular and would not take them.
     */
    const walk: Rect = { x: inner.x + 20, y: service.y + service.h + 26, w: inner.w - 40, h: 22 };
    inlay(deck, walk, shade(ROOF.membrane, 1.05));
    inlay(deck, { x: walk.x, y: walk.y, w: walk.w, h: 1.6 }, ROOF.sunlit);
    // Duckboard slats, so the strip reads as a laid walkway rather than a stripe.
    for (let x = walk.x + 12; x < walk.x + walk.w - 4; x += 26) {
      inlay(deck, { x, y: walk.y + 2, w: 2, h: walk.h - 4 }, shade(ROOF.membrane, 0.94));
    }
    // Spur up to the access hatch.
    inlay(deck, {
      x: hatch.x + hatch.w / 2 - 11,
      y: hatch.y + hatch.h,
      w: 22,
      h: Math.max(0, walk.y - (hatch.y + hatch.h)),
    }, shade(ROOF.membrane, 1.05));

    const rows = building.kind === "warehouse" ? 3 : building.kind === "hospital" ? 2 : 0;
    const lightW = 120;
    const lightH = 64;
    const cols = Math.max(1, Math.floor((inner.w - 80) / (lightW + 46)));
    const startY = walk.y + walk.h + 34;
    const pitch = rows > 0 ? (inner.y + inner.h - 40 - startY) / rows : 0;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const light: Rect = {
          x: inner.x + 40 + col * (lightW + 46),
          y: startY + row * pitch,
          w: lightW,
          h: lightH,
        };
        if (light.y + light.h > inner.y + inner.h - 30) continue;
        if (light.x + light.w > inner.x + inner.w - 20) continue;
        const g = new Graphics();
        drawModelObject(g, pad, {
          id: `${building.id}-roof-light-${row}-${col}`,
          kind: "skylight",
          ...light,
        });
        equipment.addChild(g);
      }
    }

    const units = Math.max(1, Math.round(service.w / 90));
    for (let i = 0; i < units; i += 1) {
      const unit: Rect = {
        x: service.x + 64 + i * 86,
        y: service.y + 4 + jitter(building.id, i) * 6,
        w: 70,
        h: 50,
      };
      if (unit.x + unit.w > fp.x + fp.w - wall - 8) break;
      const g = new Graphics();
      occlude(aoPad, unit, 6);
      drawModelObject(g, pad, { id: `${building.id}-roof-hvac-${i}`, kind: "hvac", ...unit });
      equipment.addChild(g);
    }
  }

  const architecture = new Container();
  architecture.addChild(deck, ...aoPad, ...pad, parapet);
  view.addChild(architecture, equipment);
  return { view, architecture, furniture: equipment, objectViews };
}

/**
 * Entrances, cut through the roof.
 *
 * From the street a player only ever sees a building's roof, so a continuous
 * parapet says "no way in" all the way round — which is exactly what the depot
 * looked like: a solid slab with two roll-ups the player had no way to find. The
 * apron painted on the ground outside points at the door, but the wall above it
 * still has to open.
 *
 * So each ground-floor perimeter door becomes a real recess: the parapet stops,
 * the reveal drops into shadow, the head of the opening catches light on its
 * soffit, and a roll-up shows its curtain box. It reads as a doorway set back
 * under the building mass — which is what it is.
 */
function drawEntranceRecesses(g: Graphics, building: Building): void {
  const fp = building.footprint;
  const wall = 12;

  for (const entrance of perimeterEntrances(building)) {
    const half = entrance.door.width / 2;
    const depth = (entrance.door.thickness ?? wall) + 8;
    const reveal = inwardBand(entrance, fp, depth, half);
    const across = isAcross(entrance.side);

    // Clear the parapet out of the opening, then drop the reveal into shadow.
    inlay(g, reveal, ROOF.reveal);
    for (let i = 0; i < 4; i += 1) {
      const t = i / 4;
      const inset = 1 + t * (depth * 0.42);
      g.rect(reveal.x + (across ? 0 : inset), reveal.y + (across ? inset : 0),
        reveal.w - (across ? 0 : inset * 2), reveal.h - (across ? inset * 2 : 0))
        .fill({ color: 0x000000, alpha: 0.09 });
    }

    // Soffit: the head of the opening, lit where it faces the light.
    const lip = 3;
    const soffit: Rect = entrance.side === "S"
      ? { x: reveal.x, y: reveal.y + reveal.h - lip, w: reveal.w, h: lip }
      : entrance.side === "E"
        ? { x: reveal.x + reveal.w - lip, y: reveal.y, w: lip, h: reveal.h }
        : { x: reveal.x, y: reveal.y, w: across ? reveal.w : lip, h: across ? lip : reveal.h };
    inlay(g, soffit, ROOF.sunlit);

    // Jambs, standing full height either side of the opening.
    for (const jamb of across
      ? [{ x: reveal.x - lip, y: reveal.y, w: lip, h: reveal.h }, { x: reveal.x + reveal.w, y: reveal.y, w: lip, h: reveal.h }]
      : [{ x: reveal.x, y: reveal.y - lip, w: reveal.w, h: lip }, { x: reveal.x, y: reveal.y + reveal.h, w: reveal.w, h: lip }]
    ) inlay(g, jamb, V.wall);

    if (!entrance.vehicle) continue;

    // Roll-up curtain box, parked in the head of the opening.
    const box = 7;
    const curtain: Rect = entrance.side === "N"
      ? { x: reveal.x, y: reveal.y + lip, w: reveal.w, h: box }
      : entrance.side === "S"
        ? { x: reveal.x, y: reveal.y + reveal.h - lip - box, w: reveal.w, h: box }
        : entrance.side === "W"
          ? { x: reveal.x + lip, y: reveal.y, w: box, h: reveal.h }
          : { x: reveal.x + reveal.w - lip - box, y: reveal.y, w: box, h: reveal.h };
    inlay(g, curtain, V.wallCap);
    const span = across ? curtain.w : curtain.h;
    for (let at = 9; at < span - 4; at += 9) {
      inlay(g, across
        ? { x: curtain.x + at, y: curtain.y, w: 1.2, h: curtain.h }
        : { x: curtain.x, y: curtain.y + at, w: curtain.w, h: 1.2 }, ROOF.reveal);
    }
  }
}

/** One shared Graphics for small roof furniture, appended lazily. */
function equipmentGraphics(container: Container): Graphics {
  const last = container.children.at(-1);
  if (last instanceof Graphics) return last;
  const g = new Graphics();
  container.addChild(g);
  return g;
}
