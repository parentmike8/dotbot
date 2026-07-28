import { describe, expect, it } from "vitest";
import { downtownMap } from "./content/downtown";
import { buildingContaining } from "./mapModel";
import { SIGN_FULL_RANGE, SIGN_READ_RANGE, signReadingAt, signText, signsOnFloor } from "./signs";
import { OUTDOOR_FLOOR_ID } from "./types";
import type { MapObject } from "./types";

/**
 * A sign says what the map says, and it says it when you are near.
 *
 * The lit-model language had no way to put text in the world at all — building names
 * are baked into the art, one label per footprint, and nothing else can speak. These
 * are the two properties that make signs the general mechanic for it rather than a
 * one-off caption: the words are DERIVED, and reading is PROXIMITY.
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
    expect(readings.length).toBe(4);
    const named = readings.filter((reading) => reading.title !== "DOWNTOWN");
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
    for (const sign of signs()) {
      const { title, open } = signText(downtownMap, sign);
      if (title === "DOWNTOWN") continue;
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
    expect(signsOnFloor(downtownMap, OUTDOOR_FLOOR_ID).length).toBe(4);
  });
});
