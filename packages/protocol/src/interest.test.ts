import { downtownMap } from "@dotbot/game/content/downtown";
import type { CoverageSnapshot, NoiseEvent } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import type { EntityMeta, FullWireSnapshot, WireBot } from "./messages";
import { filterEventsForViewer, filterForViewer } from "./interest";

const bot = (i: string, fl: string, x: number, y: number, overrides: Partial<WireBot> = {}): WireBot => ({
  i, fl, p: [x, y], f: 0, sh: [1, 1, 1], b: [null, null, null, null], h: [], c: 0,
  ...overrides,
});
const meta: EntityMeta[] = [
  { id: "viewer", name: "Viewer", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "mate", name: "Mate", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "street-enemy", name: "Street", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "upper-enemy", name: "Upper", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
];
const bots: WireBot[] = [
  bot("viewer", "outdoor", 500, 500, { b: ["h", null, null, null], c: 1, r: [100, [{ x: 10, y: 20, ageMs: 0 }]] }),
  bot("mate", "lot6:B1", 500, 1200, { b: ["r", null, null, null], c: 1, r: [100, [{ x: 30, y: 40, ageMs: 0 }]] }),
  bot("street-enemy", "outdoor", 1000, 660, { b: ["d", null, null, null], h: ["b:bed"], c: 2, r: [100, [{ x: 50, y: 60, ageMs: 0 }]] }),
  bot("upper-enemy", "mercy:F1", 400, 250),
];
const dots: FullWireSnapshot["dots"] = [
  { id: "ground-dot", position: { x: 600, y: 500 }, radius: 10, it: "h", floorId: "outdoor", active: true, captureProgressMs: 0 },
  { id: "upper-dot", position: { x: 400, y: 250 }, radius: 10, it: "b:desk", floorId: "mercy:F1", active: true, captureProgressMs: 0 },
];
const coverages: CoverageSnapshot[] = [
  { kind: "revive", actorId: "mate", targetId: "upper-enemy", progressMs: 10, durationMs: 100 },
  { kind: "capture", actorId: "upper-enemy", targetId: "upper-dot", progressMs: 10, durationMs: 100 },
];
const noises: NoiseEvent[] = [
  { id: "leak", kind: "dash", position: { x: 400, y: 250 }, floorId: "mercy:F1", loudness: 0.8, ageMs: 0, ttlMs: 1000 },
  { id: "quiet", kind: "dash", position: { x: 400, y: 250 }, floorId: "mercy:F1", loudness: 0.5, ageMs: 0, ttlMs: 1000 },
];
const mines: FullWireSnapshot["mines"] = [
  { id: "mine-alpha-0", position: { x: 620, y: 500 }, radius: 10, placedByBotId: "viewer", squadId: "a", floorId: "outdoor", placedAtMs: 10, revealedToBotIds: ["street-enemy"] },
];
const wire: FullWireSnapshot = { tick: 1, bots, dots, mines, coverages, noises };

describe("filterForViewer", () => {
  it("includes the viewer floor, excludes other-floor enemies, and always includes squadmates", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });

    expect(filtered.bots.map(({ i }) => i)).toEqual(["viewer", "mate", "street-enemy"]);
    expect(filtered.dots.map(({ id }) => id)).toEqual(["ground-dot"]);
  });

  it("keeps coverage when either participating bot is included", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    expect(filtered.coverages).toEqual([coverages[0]]);
  });

  it("keeps squad inventory detail, redacts enemy composition, and always exposes carried count", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    const own = filtered.bots.find((entry) => entry.i === "viewer")!;
    const mate = filtered.bots.find((entry) => entry.i === "mate")!;
    const enemy = filtered.bots.find((entry) => entry.i === "street-enemy")!;
    expect(own).toMatchObject({ b: ["h", null, null, null], h: [], c: 1 });
    expect(mate).toMatchObject({ b: ["r", null, null, null], h: [], c: 1 });
    expect(enemy).toMatchObject({ c: 2 });
    expect(enemy.b).toBeUndefined();
    expect(enemy.h).toBeUndefined();
  });

  it("opens a rival's inventory once their body has been searched, and not before", () => {
    // The loot channel is what buys sight of a body's contents, so the reveal has
    // to happen here too: the picker cannot offer a slot the viewer was never sent.
    const viewerCtx = {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    };
    const down = (overrides: Partial<WireBot>) => filterForViewer(
      { ...wire, bots: bots.map((entry) => entry.i === "street-enemy" ? { ...entry, ...overrides } : entry) },
      meta,
      viewerCtx,
    ).bots.find((entry) => entry.i === "street-enemy")!;

    expect(down({ s: "downed" }).b).toBeUndefined();
    // Searched, but on its feet again — a revive closes the body back up.
    expect(down({ sr: true }).b).toBeUndefined();
    expect(down({ s: "downed", sr: true })).toMatchObject({ b: ["d", null, null, null], h: ["b:bed"], c: 2 });
  });

  it("ships radar pings only for the viewer's own bot", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    expect(filtered.bots.find((entry) => entry.i === "viewer")?.r?.[1]).toHaveLength(1);
    expect(filtered.bots.find((entry) => entry.i === "mate")?.r).toBeUndefined();
    expect(filtered.bots.find((entry) => entry.i === "street-enemy")?.r).toBeUndefined();
  });

  it("shows squad mines as X data, disguises them with seam data for rivals, and reveals only to the radar firer", () => {
    const squad = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor"]),
    });
    expect(squad.mines[0]).toMatchObject({ presentation: "squad", placedByBotId: "viewer", squadId: "a" });
    expect(squad.mines[0].seam).toBeUndefined();

    const radarFirer = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "b", viewerBotId: "street-enemy", squadPhysicsFloorIds: new Set(["outdoor"]),
    });
    expect(radarFirer.mines[0]).toMatchObject({ presentation: "revealed" });
    expect(radarFirer.mines[0].seam).toBeUndefined();
    expect(radarFirer.mines[0].placedByBotId).toBeUndefined();
    expect(radarFirer.mines[0].squadId).toBeUndefined();
    expect(radarFirer.mines[0].revealedToBotIds).toBeUndefined();

    const disguisedWire = { ...wire, mines: wire.mines.map(({ revealedToBotIds: _, ...mine }) => mine) };
    const rival = filterForViewer(disguisedWire, meta, {
      map: downtownMap, squadId: "b", viewerBotId: "street-enemy", squadPhysicsFloorIds: new Set(["outdoor"]),
    });
    expect(rival.mines[0]).toMatchObject({ presentation: "disguised", seam: true });
    expect(rival.mines[0].disguise).toMatch(/health|radar|dashOvercharge|incognito/);
  });

  it("uses classifyNoise floor-leak and loudness semantics", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    expect(filtered.noises.map(({ id }) => id)).toEqual(["leak"]);
  });

  it("uses living squad floors when the viewer is a spectator", () => {
    const spectatorWire = {
      ...wire,
      bots: wire.bots.map((entry) => entry.i === "viewer" ? { ...entry, s: "downed" as const } : entry),
    };
    const filtered = filterForViewer(spectatorWire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["lot6:B1"]), spectatedBotId: "mate",
    });
    expect(filtered.bots.map(({ i }) => i)).toEqual(["viewer", "mate"]);
    expect(filtered.dots).toEqual([]);
  });

  it("includes events tied to an included bot or the viewer squad", () => {
    const events = filterEventsForViewer([
      { type: "downed", botId: "street-enemy", byBotId: "viewer" },
      { type: "looted", botId: "upper-enemy", byBotId: "street-enemy", items: [] },
      { type: "revived", botId: "mate", byBotId: "mate" },
    ], meta, new Set(["viewer", "mate"]), "a");
    expect(events.map((event) => event.type)).toEqual(["downed", "revived"]);
  });

  it("keeps mine sensor pings squad-private", () => {
    const event = { type: "mineSensor" as const, botId: "viewer", squadId: "a", mineId: "mine-alpha-0", position: { x: 1, y: 2 }, floorId: "outdoor" };
    expect(filterEventsForViewer([event], meta, new Set(["viewer"]), "a")).toEqual([event]);
    expect(filterEventsForViewer([event], meta, new Set(["viewer"]), "b")).toEqual([]);
  });

  it("broadcasts pleas across squad and floor interest boundaries", () => {
    const events = filterEventsForViewer([
      {
        type: "plea",
        botId: "upper-enemy",
        squadId: "b",
        position: { x: 400, y: 250 },
        floorId: "mercy:F1",
      },
    ], meta, new Set(["viewer", "mate"]), "a");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "plea", botId: "upper-enemy", squadId: "b" });
  });
});
