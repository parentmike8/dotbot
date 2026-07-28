import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { Item, SimEvent } from "@dotbot/game/types";
import { bayStrip, floorColumn, formatRunClock, rivalsAlive, squadDownCounts } from "./hud";

/**
 * The arithmetic the overlay used to do twice.
 *
 * Every function here existed as two copies — one in the solo sandbox, one in the net
 * match — and two of the pairs had already drifted apart. These are the assertions that
 * stop them drifting again, so they are written against the drift rather than against
 * the happy path.
 */

const health: Item = { kind: "powerup", type: "health" };
const blueprint: Item = { kind: "blueprint", blueprintId: "cot" };

describe("the run clock", () => {
  it("counts in minutes and seconds, zero-padded", () => {
    expect(formatRunClock(0)).toBe("00:00");
    expect(formatRunClock(9_000)).toBe("00:09");
    expect(formatRunClock(69_000)).toBe("01:09");
    expect(formatRunClock(600_000)).toBe("10:00");
  });

  it("floors rather than rounds, so the clock never shows a second early", () => {
    // 59.9s is still 59, not 1:00. Rounding here makes a clock that hits 00:00 with
    // time left on it, which is the one moment a player is watching it.
    expect(formatRunClock(59_900)).toBe("00:59");
  });

  it("reads 00:00 once it has run out", () => {
    // The callers subtract elapsed from the run length, so overshoot is normal.
    expect(formatRunClock(-1)).toBe("00:00");
    expect(formatRunClock(-500_000)).toBe("00:00");
  });
});

describe("the bay strip", () => {
  it("pads to the slot count so an empty bay still reads as a slot", () => {
    expect(bayStrip([health], 3)).toEqual([health, null, null]);
    expect(bayStrip(undefined, 3)).toEqual([null, null, null]);
  });

  /**
   * The reason this takes `slots` at all. The net surface drew four bays from a
   * hardcoded `[null, null, null, null]` while `baySlots` is three, so a match showed a
   * fourth slot that could never hold anything — and the two surfaces disagreed about
   * how many bays the game has.
   */
  it("uses the count it is given, not a literal", () => {
    expect(bayStrip([health, blueprint], defaultGameConfig.baySlots)).toHaveLength(defaultGameConfig.baySlots);
    expect(bayStrip([], 4)).toHaveLength(4);
  });

  it("truncates a longer bank rather than overflowing the bank", () => {
    expect(bayStrip([health, health, health, health], 2)).toEqual([health, health]);
    expect(bayStrip([health], 0)).toEqual([]);
  });
});

describe("rivals still standing", () => {
  const bots = [
    { squadId: "alpha", state: "alive" },
    { squadId: "alpha", state: "downed" },
    { squadId: "rival-1", state: "alive" },
    { squadId: "rival-1", state: "downed" },
    { squadId: "rival-2", state: "alive" },
  ];

  it("counts other squads' living bots and no one else's", () => {
    expect(rivalsAlive(bots, "alpha")).toBe(2);
    expect(rivalsAlive(bots, "rival-1")).toBe(2);
  });

  it("has nothing to report before the viewer has a squad", () => {
    // Both surfaces render a frame or two before the first snapshot names the player.
    expect(rivalsAlive(bots, undefined)).toBe(0);
    expect(rivalsAlive(undefined, "alpha")).toBe(0);
  });
});

describe("downs credited to the squad", () => {
  const meta: Record<string, { squadId: string; isAmbient: boolean }> = {
    me: { squadId: "alpha", isAmbient: false },
    mate: { squadId: "alpha", isAmbient: false },
    rival: { squadId: "rival-1", isAmbient: false },
    grey: { squadId: "grey", isAmbient: true },
  };
  const metaOf = (id: string) => meta[id];

  it("splits by whether the victim was a person", () => {
    const events: SimEvent[] = [
      { type: "downed", botId: "rival", byBotId: "me" },
      { type: "downed", botId: "grey", byBotId: "mate" },
      { type: "downed", botId: "grey", byBotId: "me" },
    ];
    expect(squadDownCounts(events, metaOf, "me")).toEqual({ ai: 2, players: 1 });
  });

  it("credits the squad, not the individual", () => {
    // A squadmate's down is the squad's down: this is a shared tally on a shared run.
    const events: SimEvent[] = [{ type: "downed", botId: "rival", byBotId: "mate" }];
    expect(squadDownCounts(events, metaOf, "me")).toEqual({ ai: 0, players: 1 });
  });

  it("ignores downs by anyone else, and downs by nobody", () => {
    const events: SimEvent[] = [
      { type: "downed", botId: "me", byBotId: "rival" },
      // No `byBotId`: a fall, or a mine whose owner has left. Nobody's credit.
      { type: "downed", botId: "grey" },
      { type: "dotCaptured", botId: "me", dotId: "dot-1" },
    ];
    expect(squadDownCounts(events, metaOf, "me")).toEqual({ ai: 0, players: 0 });
  });

  it("survives a bot the surface can no longer resolve", () => {
    // A player who disconnected mid-run is gone from the entity table while their
    // events are still in the log, so the lookup returns undefined rather than throwing.
    const events: SimEvent[] = [{ type: "downed", botId: "ghost", byBotId: "gone" }];
    expect(squadDownCounts(events, metaOf, "me")).toEqual({ ai: 0, players: 0 });
  });
});

describe("the floor column", () => {
  /**
   * Against the real downtown map rather than a fixture, because the ordering rule is
   * about authored data: the rail is a section through the building, so it has to read
   * top-down whatever order the source lists floors in.
   */
  /**
   * A Dot spawn rather than the footprint's centre. `footprint` is deliberately larger
   * than the building it bounds — that is documented on the type — so its middle is not
   * reliably a place you can stand, whereas a Dot spawn is authored to be one.
   */
  const tower = downtownMap.buildings.find((building) => building.floors.length > 2)!;
  const towerGround = tower.floors.find((floor) => floor.label === "GROUND")!;
  const standing = towerGround.dotSpawns[0].position;

  it("names the building you are standing in", () => {
    expect(floorColumn(downtownMap, towerGround.id, standing)?.building.id).toBe(tower.id);
  });

  it("reads top floor first, however the source is ordered", () => {
    const labels = floorColumn(downtownMap, towerGround.id, standing)!.floors.map((floor) => floor.label);
    expect(labels[0]).toBe("ROOF");
    expect(labels[labels.length - 1]).toBe("GROUND");
  });

  it("has no column outdoors", () => {
    // The rail is a building's own picture of itself. On the street there is no building
    // to draw, and the rail is absent rather than showing a stale one.
    expect(floorColumn(downtownMap, "outdoor", { x: 0, y: 0 })).toBeNull();
  });
});
