import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { BASE_SHELL_IDS, createBaseMap, starterBaseLayout } from "./content/base";
import { downtownMap } from "./content/downtown";
import { quaysideMap } from "./content/quaysideDepot";
import { worldMap } from "./content/world";
import { buildingContaining, SURFACE_KINDS } from "./mapModel";
import { findNavigationPath } from "./navigation";
import { SIGN_FULL_RANGE, SIGN_READ_RANGE, signReadingAt, signText, signsOnFloor } from "./signs";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { MapDocument, MapObject } from "./types";

/**
 * A sign says what the map says, and it says it when you are near.
 *
 * The old lit-model language painted one building name across each footprint and each
 * extraction name beside its pad. These are the two properties that make signs the
 * replacement rather than another caption: the words are DERIVED, and reading is
 * PROXIMITY.
 */

const signs = () => signsOnFloor(downtownMap, OUTDOOR_FLOOR_ID);
const centre = (sign: MapObject) => ({ x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 });

describe("what a sign says", () => {
  it("names the building it stands against, and counts its floors", () => {
    /**
     * The authored map has one sign per building. Every one has to find its own
     * building — a sign that names the street instead is the failure mode, and it
     * happens whenever the sign's centre sits outside the footprint it is bolted to,
     * which is most of them.
     */
    const readings = signs().map((sign) => signText(downtownMap, sign));
    const buildingNames = new Set(downtownMap.buildings.map((building) => building.name));
    const named = readings.filter((reading) => buildingNames.has(reading.title));
    expect(named.length, `signs that found a building: ${readings.map((r) => r.title).join(", ")}`).toBe(4);
    expect(new Set(named.map((reading) => reading.title)).size, "each sign should name a different building").toBe(4);
    for (const reading of named) {
      expect(reading.detail).toMatch(/^\d+ FLOORS?$/);
    }
  });

  it("takes the floor count from the map, not from the sign", () => {
    // The whole reason the text is derived. Civic is the tower; if a floor is added
    // to it, the street has to say so without anybody editing a sign.
    const civic = downtownMap.buildings.find((building) => building.id === "civic")!;
    const storeys = civic.floors.filter((floor) => floor.label !== "ROOF").length;
    const sign = signs().find((candidate) => signText(downtownMap, candidate).title === civic.name);
    expect(sign, "no sign names the tower").toBeDefined();
    expect(signText(downtownMap, sign!).detail).toBe(`${storeys} FLOORS`);
  });

  it("points its open side away from the building it names", () => {
    /**
     * The fix for two rounds of illegible text, and the reason the probe returns a
     * direction at all.
     *
     * A fixed offset put the words over whatever happened to be behind them — first a
     * mid-grey footway, then, after darkening the ink, the clinic's own dark wall band.
     * No ink survives every ground. So the words go on the side the sign FACES, and the
     * probe that found the building is what knows which side that is.
     *
     * Asserted as geometry rather than as a pixel: stepping from the sign in the open
     * direction must leave the building, and stepping the other way must enter it.
     */
    const buildingNames = new Set(downtownMap.buildings.map((building) => building.name));
    for (const sign of signs()) {
      const { title, open } = signText(downtownMap, sign);
      if (!buildingNames.has(title)) continue;
      expect(Math.hypot(open.x, open.y)).toBeCloseTo(1, 6);
      const centre = { x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 };
      const STEP = 48;
      const outward = { x: centre.x + open.x * STEP, y: centre.y + open.y * STEP };
      const inward = { x: centre.x - open.x * STEP, y: centre.y - open.y * STEP };
      expect(
        buildingContaining(downtownMap, inward)?.name,
        `${sign.id}: stepping toward the building should reach ${title}`,
      ).toBe(title);
      expect(
        buildingContaining(downtownMap, outward),
        `${sign.id}: stepping the open way should leave ${title}`,
      ).toBeNull();
    }
  });

  it("does not count the roof as a storey", () => {
    // A ROOF plan is the building's exterior doing double duty, not a floor you arrive
    // on, so counting it would overstate every building in the city by one.
    for (const building of downtownMap.buildings) {
      const withRoof = building.floors.length;
      const storeys = building.floors.filter((floor) => floor.label !== "ROOF").length;
      if (withRoof === storeys) continue;
      const sign = signs().find((candidate) => signText(downtownMap, candidate).title === building.name);
      if (!sign) continue;
      expect(signText(downtownMap, sign).detail).toBe(`${storeys} ${storeys === 1 ? "FLOOR" : "FLOORS"}`);
    }
  });

  it("names an adjacent extraction and explains the square", () => {
    const extractionNames = new Set(downtownMap.extractionPoints.map((point) => point.name));
    const readings = signs().map((sign) => signText(downtownMap, sign));
    const extractionSigns = readings.filter((reading) => extractionNames.has(reading.title));
    expect(extractionSigns.map((reading) => reading.title).sort())
      .toEqual([...extractionNames].sort());
    expect(extractionSigns.every((reading) => reading.detail === "EXTRACTION")).toBe(true);
  });

  it("gives every world building and extraction exactly one physical sign", () => {
    const readings = signsOnFloor(worldMap, OUTDOOR_FLOOR_ID)
      .map((sign) => signText(worldMap, sign));
    const titles = readings.map((reading) => reading.title);
    const expected = [
      ...worldMap.buildings.map((building) => building.name),
      ...worldMap.extractionPoints.map((point) => point.name),
    ];
    expect(titles.sort()).toEqual(expected.sort());
  });

  it("covers the standalone non-rectangular review map too", () => {
    const readings = signsOnFloor(quaysideMap, OUTDOOR_FLOOR_ID)
      .map((sign) => signText(quaysideMap, sign));
    expect(readings.map((reading) => reading.title).sort()).toEqual([
      quaysideMap.buildings[0].name,
      quaysideMap.extractionPoints[0].name,
    ].sort());
  });

  it.each(BASE_SHELL_IDS)("replaces the %s base caption with a readable entrance sign", (shellId) => {
    const map = createBaseMap(starterBaseLayout, shellId);
    const readings = signsOnFloor(map, OUTDOOR_FLOOR_ID).map((sign) => signText(map, sign));
    expect(readings).toEqual([expect.objectContaining({ title: "YOUR BASE" })]);
  });

  it("leaves a full-size route within reading range of every sign", () => {
    const maps: MapDocument[] = [
      worldMap,
      quaysideMap,
      ...BASE_SHELL_IDS.map((shellId) => createBaseMap(starterBaseLayout, shellId)),
    ];
    for (const map of maps) {
      const spawn = map.botSpawns.find((candidate) => candidate.controller === "human") ?? map.botSpawns[0];
      for (const sign of signsOnFloor(map, OUTDOOR_FLOOR_ID)) {
        const { title } = signText(map, sign);
        const centre = { x: sign.x + sign.w / 2, y: sign.y + sign.h / 2 };
        const reach = SIGN_FULL_RANGE - defaultGameConfig.botRadius;
        const directions = [
          { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
          { x: 0.707, y: -0.707 }, { x: 0.707, y: 0.707 },
          { x: -0.707, y: 0.707 }, { x: -0.707, y: -0.707 },
        ];
        const reachable = directions.some((direction) => findNavigationPath(
          map,
          OUTDOOR_FLOOR_ID,
          spawn.position,
          {
            x: centre.x + direction.x * reach,
            y: centre.y + direction.y * reach,
          },
          defaultGameConfig.botRadius,
        ).length > 0);
        expect(
          reachable,
          `${map.id}/${sign.id} ${title} at ${sign.x},${sign.y} has no full-size route within reading range`,
        ).toBe(true);
      }
    }
  });

  it("keeps every outdoor sign visually clear of other map objects", () => {
    /**
     * Navigable is not the same as visible. A sign can leave enough room for a bot
     * while still sitting under a tree crown or behind a piece of entrance furniture.
     * The temple sign did exactly that: its plate overlapped an 88 x 88 tree beside
     * the south approach, so the path audit stayed green while the sign disappeared.
     */
    const maps: MapDocument[] = [
      worldMap,
      quaysideMap,
      ...BASE_SHELL_IDS.map((shellId) => createBaseMap(starterBaseLayout, shellId)),
    ];
    const VISUAL_GAP = 16;
    const overlaps = (sign: MapObject, object: MapObject) => (
      sign.x < object.x + object.w + VISUAL_GAP
      && sign.x + sign.w > object.x - VISUAL_GAP
      && sign.y < object.y + object.h + VISUAL_GAP
      && sign.y + sign.h > object.y - VISUAL_GAP
    );
    const obstructed: string[] = [];
    for (const map of maps) {
      const outdoorObjects = map.outdoor.objects ?? [];
      for (const sign of outdoorObjects.filter((object) => object.kind === "sign")) {
        const obstruction = outdoorObjects.find((object) => (
          object.id !== sign.id
          && !SURFACE_KINDS.has(object.kind)
          && overlaps(sign, object)
        ));
        if (obstruction) {
          obstructed.push(
            `${map.id}/${sign.id} at ${sign.x},${sign.y} is too close to `
            + `${obstruction.id} (${obstruction.kind}) at ${obstruction.x},${obstruction.y}`,
          );
        }
      }
    }
    expect(obstructed).toEqual([]);
  });
});

describe("when a sign is legible", () => {
  it("says nothing from across the street and everything up close", () => {
    // One sign, deliberately: walking away from this one eventually walks toward
    // another, and the ramp is a property of a single sign rather than of the city.
    const only = [signs()[0]];
    const at = centre(only[0]);
    expect(signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, at, only)).toMatchObject({ strength: 1 });
    const justInside = { x: at.x, y: at.y + SIGN_READ_RANGE - 4 };
    expect(signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, justInside, only)!.strength).toBeLessThan(0.2);
    const outside = { x: at.x, y: at.y + SIGN_READ_RANGE + 4 };
    expect(signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, outside, only)).toBeNull();
  });

  it("fades in rather than switching on", () => {
    /**
     * A caption that appears at a threshold reads as UI, and the contract's objection
     * to UI is that it is not part of the place. So the strength has to climb, and it
     * has to be monotone — a ramp that dips would read as flicker, which is worse than
     * a switch.
     */
    const only = [signs()[0]];
    const at = centre(only[0]);
    let previous = -1;
    for (let away = SIGN_READ_RANGE; away >= SIGN_FULL_RANGE; away -= 6) {
      const strength = signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, { x: at.x, y: at.y + away }, only)?.strength ?? 0;
      expect(strength).toBeGreaterThanOrEqual(previous);
      previous = strength;
    }
    expect(previous).toBe(1);
  });

  it("reads one sign at a time, and always the same one", () => {
    /**
     * Two captions arguing over the same patch of street is the floating-UI clutter the
     * contract forbids. Nearest wins; a tie breaks on id, so standing exactly between
     * two signs gives a stable answer rather than one that flickers frame to frame.
     */
    const [first, second] = signs();
    const midpoint = {
      x: (centre(first).x + centre(second).x) / 2,
      y: (centre(first).y + centre(second).y) / 2,
    };
    const pair = [first, second];
    const reading = signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, midpoint, pair);
    const swapped = signReadingAt(downtownMap, OUTDOOR_FLOOR_ID, midpoint, [second, first]);
    expect(reading?.sign.id).toBe(swapped?.sign.id);
  });

  it("only sees signs on the floor being walked", () => {
    // Signs are per-floor, so an indoor sign cannot be read from the street above it.
    expect(signsOnFloor(downtownMap, "civic:F4").every((sign) => sign.kind === "sign")).toBe(true);
    expect(signsOnFloor(downtownMap, OUTDOOR_FLOOR_ID).length).toBe(7);
  });
});
