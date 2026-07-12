import { downtownMap } from "@dotbot/game/content/downtown";
import type { CoverageSnapshot, DotEntity, NoiseEvent } from "@dotbot/game/types";
import { describe, expect, it } from "vitest";
import type { EntityMeta, WireBot, WireSnapshot } from "./messages";
import { filterEventsForViewer, filterForViewer } from "./interest";

const bot = (i: string, fl: string, x: number, y: number): WireBot => ({
  i, fl, p: [x, y], f: 0, s: "alive", sh: [1, 1, 1], b: [null, null, null, null], h: [],
});
const meta: EntityMeta[] = [
  { id: "viewer", name: "Viewer", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "mate", name: "Mate", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "street-enemy", name: "Street", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
  { id: "upper-enemy", name: "Upper", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
];
const bots: WireBot[] = [
  bot("viewer", "outdoor", 500, 500),
  bot("mate", "lot6:B1", 500, 1200),
  bot("street-enemy", "outdoor", 1000, 660),
  bot("upper-enemy", "mercy:F1", 400, 250),
];
const dots: DotEntity[] = [
  { id: "ground-dot", position: { x: 600, y: 500 }, radius: 10, color: "#fff", floorId: "outdoor", active: true, captureProgressMs: 0 },
  { id: "upper-dot", position: { x: 400, y: 250 }, radius: 10, color: "#fff", floorId: "mercy:F1", active: true, captureProgressMs: 0 },
];
const coverages: CoverageSnapshot[] = [
  { kind: "revive", actorId: "mate", targetId: "upper-enemy", progressMs: 10, durationMs: 100 },
  { kind: "capture", actorId: "upper-enemy", targetId: "upper-dot", progressMs: 10, durationMs: 100 },
];
const noises: NoiseEvent[] = [
  { id: "leak", kind: "dash", position: { x: 400, y: 250 }, floorId: "mercy:F1", loudness: 0.8, ageMs: 0, ttlMs: 1000 },
  { id: "quiet", kind: "dash", position: { x: 400, y: 250 }, floorId: "mercy:F1", loudness: 0.5, ageMs: 0, ttlMs: 1000 },
];
const wire: WireSnapshot = { tick: 1, ack: 0, bots, dots, coverages, noises };

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

  it("uses classifyNoise floor-leak and loudness semantics", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    expect(filtered.noises.map(({ id }) => id)).toEqual(["leak"]);
  });

  it("uses living squad floors when the viewer is a spectator", () => {
    const spectatorWire = {
      ...wire,
      bots: wire.bots.map((entry) => entry.i === "viewer" ? { ...entry, s: "consumed" as const } : entry),
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
      { type: "consumed", botId: "upper-enemy", byBotId: "street-enemy", lostItems: [] },
      { type: "revived", botId: "mate", byBotId: "mate" },
    ], meta, new Set(["viewer", "mate"]), "a");
    expect(events.map((event) => event.type)).toEqual(["downed", "revived"]);
  });
});
