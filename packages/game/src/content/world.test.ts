import { describe, expect, it } from "vitest";

import { auditCity } from "../cityQuality";
import { defaultGameConfig } from "../config";
import { polygonContains } from "../geometry";
import { validateInsertionMap } from "../insertion";
import { auditBuildingFloorQuality, auditDotPlacement } from "../mapQuality";
import { findNavigationPath } from "../navigation";
import { OUTDOOR_FLOOR_ID, type Rect } from "../types";
import { roundhouse, TABLE } from "./roundhouse";
import { worldMap } from "./world";

/**
 * The world, as four regions on one sheet.
 *
 * The important test here is the LAST one, and it is the only one that could not have been
 * written before this map existed: a squad standing in Downtown can walk to the temple.
 * Everything else in this file guards a rule that already had a name; that one guards the
 * claim the map is making — that the city, the depot, the fairground and the ruin are one
 * place rather than four sheets shown in sequence.
 */

const RADIUS = defaultGameConfig.botRadius;

/** One point of open ground in each region, well inside it. */
const HERE = {
  downtown: { x: 1020, y: 676 },
  yard: { x: 2500, y: 1080 },
  fairground: { x: 1250, y: 2340 },
  /**
   * The temple's own FORECOURT, in front of the archway at the foot of the grand stair.
   *
   * It was 3320,2760 — the middle of the plaza — and it is a better landmark here than
   * that, because reaching this point is reaching the temple's front door. The forecourt
   * spent a while sealed: the plaza altar and the two serpent heads flanking the arch
   * overlapped by 20 units at each end, so the only way in was round the entire base to
   * the blind north face and back through the tomb chamber. A path test whose target is
   * open plaza cannot tell that apart from a path test whose target is the way in.
   *
   * (The old point is also inside the altar now, which is how this got looked at.)
   */
  temple: { x: 3320, y: 2520 },
} as const;

describe("the world's ledgers", () => {
  /**
   * Asserted empty with `toEqual` rather than by count, so a regression names itself in
   * the failure output instead of showing up as a number that moved.
   */
  it("has no city-scale debt", () => {
    expect(auditCity(worldMap).map((issue) => `${issue.kind}: ${issue.message}`)).toEqual([]);
  });

  it("has every Dot somewhere a bot can stand, and no two in one place", () => {
    expect(auditDotPlacement(worldMap).map((issue) => issue.message)).toEqual([]);
  });

  it("fits a full squad at every arrival point", () => {
    expect(() => validateInsertionMap(worldMap, 3, RADIUS)).not.toThrow();
  });

  /**
   * The five buildings the regions added, asserted clean.
   *
   * Downtown's four are deliberately not in this list. They carry inherited debt from
   * before the floor audit existed — a handful of false aisles and one fixture overlap —
   * and folding that into this assertion would mean either fixing four buildings that are
   * not what this work is about, or writing a budget that hides the five that are.
   */
  it.each(["roundhouse", "box", "pavilion", "temple", "observatory"])(
    "%s has no floor-quality issues",
    (id) => {
      expect(auditBuildingFloorQuality(worldMap, id).map((issue) => issue.message)).toEqual([]);
    },
  );

  /**
   * Nothing standing in a building that is not part of it.
   *
   * The temple's abandoned spur ran into the pyramid, so a railway wagon was parked inside
   * the terrace wall and on top of a Dot in the tomb chamber. Checked against each
   * building's PLAN rather than its bounding box, because a turntable sits inside the
   * roundhouse's bounding box and a hundred units clear of the shed.
   */
  it("has no outdoor scenery standing inside a building", () => {
    const corners = (o: { x: number; y: number; w: number; h: number }) => [
      { x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x, y: o.y + o.h },
      { x: o.x + o.w, y: o.y + o.h }, { x: o.x + o.w / 2, y: o.y + o.h / 2 },
    ];
    const inside = worldMap.outdoor.objects.flatMap((object) => worldMap.buildings
      .filter((building) => {
        const plan = building.outline && building.outline.length >= 3 ? building.outline : null;
        if (plan) return corners(object).some((at) => polygonContains(plan, at));
        const fp = building.footprint;
        return object.x < fp.x + fp.w && fp.x < object.x + object.w
          && object.y < fp.y + fp.h && fp.y < object.y + object.h;
      })
      .map((building) => `${object.id} (${object.kind}) is inside ${building.id}`));
    expect(inside).toEqual([]);
  });

  it("gives every region an arrival point and something to extract from", () => {
    for (const [region, at] of Object.entries(HERE)) {
      const near = (points: readonly { x: number; y: number }[]) =>
        points.some((point) => Math.hypot(point.x - at.x, point.y - at.y) < 1400);
      expect(near(worldMap.insertionPoints.map((point) => point.position)), `${region} arrival`).toBe(true);
      expect(near(worldMap.extractionPoints.map((point) => ({
        x: point.rect.x + point.rect.w / 2,
        y: point.rect.y + point.rect.h / 2,
      }))), `${region} extraction`).toBe(true);
    }
  });
});

/**
 * The claim the map exists to make.
 *
 * Two of Downtown's streets run out of the city — Main St east through the yard gate, Third
 * Ave south through the fair gate — and past the yard the ground takes over with an
 * abandoned spur and a trail. A path from any region to any other proves all of that at
 * once, and it is the check that would have caught the boundary walls being authored
 * without their gaps.
 */
describe("the world is one place", () => {
  const pairs: Array<[keyof typeof HERE, keyof typeof HERE]> = [
    ["downtown", "yard"],
    ["downtown", "fairground"],
    ["fairground", "temple"],
    ["yard", "temple"],
    ["downtown", "temple"],
  ];

  it.each(pairs)("a bot can walk from the %s to the %s", (from, to) => {
    const path = findNavigationPath(worldMap, OUTDOOR_FLOOR_ID, HERE[from], HERE[to], RADIUS);
    expect(path.length).toBeGreaterThan(0);
  });
});

/**
 * The yard's spur gate is a real local route, not merely a painted railway that the
 * navigator can replace with the long way round through Downtown and the fair.
 *
 * The first authored gate overlapped the pyramid's north face: the fence ended at y 1800,
 * the pyramid began at y 1820, and a 48-wide bot therefore had only 20 units between the
 * two solids. The trail then cut diagonally through the pyramid's north-east corner.
 * Region-to-region routing stayed green because the fair's east trail still joined the
 * yard and temple through the rest of the world. These two short paths pin the route the
 * scenery itself promises.
 */
describe("the abandoned spur is a traversable gate", () => {
  const fence = worldMap.outdoor.walls
    .filter((wall) => wall.id.startsWith("yard-fence-s-"))
    .sort((a, b) => a.x - b.x);
  const gate = {
    left: fence[0].x + fence[0].w,
    right: fence[1].x,
    top: fence[0].y,
    bottom: fence[0].y + fence[0].h,
  };

  it("puts the visible trail through the same opening as the collider", () => {
    const trail = worldMap.outdoor.regions?.find((region) => region.id === "tmp-spur-trail")!;
    const stop = worldMap.outdoor.objects.find((object) =>
      object.kind === "bufferStop"
      && object.y < gate.bottom
      && object.y + object.h > gate.top
    )!;
    const crossingY = gate.bottom + RADIUS;
    const passableLeft = Math.max(gate.left, stop.x + stop.w) + RADIUS;
    const passableRight = gate.right - RADIUS;
    const visibleCrossing = Array.from(
      { length: Math.floor((passableRight - passableLeft) / 4) + 1 },
      (_, index) => ({ x: passableLeft + index * 4, y: crossingY }),
    ).some((point) => polygonContains(trail.points, point));

    expect(visibleCrossing).toBe(true);
  });

  it("keeps the abandoned rail hardware in the gate without embedding it in the fence", () => {
    const hardware = worldMap.outdoor.objects.filter((object) =>
      ["bufferStop", "track", "wagon"].includes(object.kind)
      && object.y >= 1_600
      && object.y < gate.bottom
    );
    expect(hardware.map((object) => object.kind).sort()).toEqual(["bufferStop", "track", "wagon"]);

    const track = hardware.find((object) => object.kind === "track")!;
    const stop = hardware.find((object) => object.kind === "bufferStop")!;
    const wagon = hardware.find((object) => object.kind === "wagon")!;
    expect(track.x + track.w / 2).toBe(stop.x + stop.w / 2);
    expect(stop.x).toBeGreaterThanOrEqual(gate.left);
    expect(stop.x + stop.w).toBeLessThanOrEqual(gate.right);
    expect(track.x - (wagon.x + wagon.w)).toBeGreaterThanOrEqual(0);
    expect(track.x - (wagon.x + wagon.w)).toBeLessThanOrEqual(RADIUS * 2);

    const overlaps = (a: Rect, b: Rect) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(hardware.flatMap((object) => fence
      .filter((wall) => overlaps(object, wall))
      .map((wall) => `${object.id} overlaps ${wall.id}`))).toEqual([]);

    const eastLane = gate.right - (stop.x + stop.w);
    expect(eastLane).toBeGreaterThanOrEqual(RADIUS * 3);
  });

  it("crosses the yard fence locally", () => {
    const path = findNavigationPath(
      worldMap,
      OUTDOOR_FLOOR_ID,
      { x: 3770, y: 1680 },
      { x: 3770, y: 1900 },
      RADIUS,
    );
    expect(path.length).toBeGreaterThan(0);
  });

  it("continues from the yard to END OF LINE", () => {
    const yard = worldMap.insertionPoints.find((point) => point.id === "yard-west")!.position;
    const end = worldMap.insertionPoints.find((point) => point.id === "tmp-spur")!.position;
    const path = findNavigationPath(worldMap, OUTDOOR_FLOOR_ID, yard, end, RADIUS);
    expect(path.length).toBeGreaterThan(0);
    const distance = path.slice(1).reduce(
      (total, point, index) => total + Math.hypot(point.x - path[index].x, point.y - path[index].y),
      0,
    );
    expect(distance).toBeLessThan(2_500);
  });
});

/**
 * The roundhouse's roads point at the turntable.
 *
 * This is the one claim the building is making. A roundhouse is a fan of bays around a table
 * because an engine cannot steer, so a bay whose road does not aim at the table is not a bay —
 * and for four rounds all three of them were axis-aligned rectangles, one landscape and two
 * portrait, with a source comment asserting they were "proportioned to the direction its own
 * bay runs". Nothing caught it: a pit is `track`, which is passable, so no clearance, overlap
 * or connectivity check looks at it, and `world.audit` was clean throughout.
 *
 * Asserted as an ANGLE rather than as coordinates, so the pits can be moved, lengthened or
 * renumbered and a fourth bay can be added without touching this test. What it pins is the
 * relationship, including the 90-degree term that turns a south-pointing box onto its ray —
 * the easiest thing here to get backwards, and invisible in a still if only one pit is wrong.
 */
describe("the roundhouse reads as a fan", () => {
  const floor = roundhouse.floors.find((plan) => plan.label === "GROUND")!;
  const pits = floor.objects.filter((object) => object.id.startsWith("rh-pit-"));

  it("has one pit per bay", () => {
    expect(pits).toHaveLength(3);
  });

  it.each(pits.map((pit) => [pit.id, pit] as const))("%s runs along its own ray", (_id, pit) => {
    const cx = pit.x + pit.w / 2;
    const cy = pit.y + pit.h / 2;
    // Where the pit sits, as seen from the table.
    const bearing = Math.atan2(cy - TABLE.y, cx - TABLE.x);
    // Where its long axis points. The authored box is taller than it is wide, so its axis
    // starts due south — at +90 degrees — and `angle` turns it from there.
    const axis = Math.PI / 2 + (pit.angle ?? 0);

    expect(pit.h).toBeGreaterThan(pit.w);
    // Within a degree: the road lies on the line from the table, not merely near it.
    expect(axis).toBeCloseTo(bearing, 2);
  });

  it("keeps every rotated corner inside the shed's floor band", () => {
    for (const pit of pits) {
      const cx = pit.x + pit.w / 2;
      const cy = pit.y + pit.h / 2;
      const angle = pit.angle ?? 0;
      const along = { x: Math.cos(angle + Math.PI / 2), y: Math.sin(angle + Math.PI / 2) };
      const across = { x: -along.y, y: along.x };
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) {
          const x = cx + along.x * (pit.h / 2) * end + across.x * (pit.w / 2) * side;
          const y = cy + along.y * (pit.h / 2) * end + across.y * (pit.w / 2) * side;
          const r = Math.hypot(x - TABLE.x, y - TABLE.y);
          // The walkable annulus, shell thickness already taken off both arcs.
          expect(r).toBeGreaterThan(263);
          expect(r).toBeLessThan(477);
        }
      }
    }
  });
});

/**
 * Every outdoor Dot can actually be walked to from where the player starts.
 *
 * `auditDotPlacement` asks whether a Dot has bot-radius CLEARANCE, which is a question about
 * the space immediately around it, and the ball court answered yes while being sealed: a
 * walled alley 120 x 228 with a 108-wide ring stone plugging each mouth. Centre court had 48
 * units clear in every direction and no way in. Reported from play — "there's a dot in the
 * middle of them that is not accessible because the blocks are blocking the user from getting
 * in" — and invisible to every check in the suite, because each solid was individually correct
 * and correctly placed.
 *
 * Asked of the NAVIGATOR rather than of a hand-rolled flood, for the reason settled earlier:
 * a private flood produced two false positives the navigator disagreed with, and the navigator
 * is what actually moves a bot.
 */
describe("every outdoor Dot is reachable from the player spawn", () => {
  const spawn = worldMap.botSpawns.find((s) => s.id === "player")!.position;

  it.each(worldMap.outdoor.dotSpawns.map((dot) => [dot.id, dot] as const))("%s", (_id, dot) => {
    const path = findNavigationPath(worldMap, OUTDOOR_FLOOR_ID, spawn, dot.position, RADIUS);
    expect(path.length).toBeGreaterThan(0);
  });
});
