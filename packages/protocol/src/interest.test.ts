import { downtownMap } from "@dotbot/game/content/downtown";
import type { CoverageSnapshot, MapDocument, NoiseEvent } from "@dotbot/game/types";
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
  bot("viewer", "outdoor", 500, 500, {
    b: ["h", null, null, null], bs: ["mercy", null, null, null], ir: 3,
    c: 1, r: [100, [["street-enemy", 10, 20, "outdoor", 0]]],
  }),
  bot("mate", "lot6:B1", 500, 1200, {
    b: ["r", null, null, null], bs: ["lot6", null, null, null], ir: 4,
    c: 1, r: [100, [["street-enemy", 30, 40, "outdoor", 0]]],
  }),
  bot("street-enemy", "outdoor", 540, 500, {
    b: ["d", null, null, null], h: ["b:bed"],
    bs: ["yard", null, null, null], hs: ["mercy"], ir: 7,
    c: 2, r: [100, [["viewer", 50, 60, "outdoor", 0]]],
  }),
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

const occlusionMap: MapDocument = {
  id: "interest-occlusion",
  name: "Interest occlusion",
  width: 500,
  height: 360,
  outdoor: {
    roads: [],
    parks: [],
    walls: [
      { id: "north", x: 0, y: 0, w: 500, h: 20 },
      { id: "south", x: 0, y: 340, w: 500, h: 20 },
      { id: "west", x: 0, y: 0, w: 20, h: 360 },
      { id: "east", x: 480, y: 0, w: 20, h: 360 },
      { id: "divider", x: 240, y: 60, w: 12, h: 240 },
    ],
    objects: [],
    dotSpawns: [],
  },
  buildings: [],
  extractionPoints: [],
  insertionPoints: [],
  botSpawns: [],
};

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
    expect(own).toMatchObject({ b: ["h", null, null, null], h: [], bs: ["mercy", null, null, null], ir: 3, c: 1 });
    expect(mate).toMatchObject({ b: ["r", null, null, null], h: [], bs: ["lot6", null, null, null], ir: 4, c: 1 });
    expect(enemy).toMatchObject({ c: 2 });
    expect(enemy.b).toBeUndefined();
    expect(enemy.h).toBeUndefined();
    expect(enemy.bs).toBeUndefined();
    expect(enemy.hs).toBeUndefined();
    expect(enemy.ir).toBeUndefined();
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

    expect(down({ s: "downed" })).toMatchObject({
      b: undefined, h: undefined, bs: undefined, hs: undefined, ir: undefined,
    });
    // Searched, but on its feet again — a revive closes the body back up.
    expect(down({ sr: true })).toMatchObject({
      b: undefined, h: undefined, bs: undefined, hs: undefined, ir: undefined,
    });
    expect(down({ s: "downed", sr: true })).toMatchObject({
      b: ["d", null, null, null],
      h: ["b:bed"],
      bs: ["yard", null, null, null],
      hs: ["mercy"],
      ir: 7,
      c: 2,
    });
  });

  it("ships radar pings only for the viewer's own bot", () => {
    const filtered = filterForViewer(wire, meta, {
      map: downtownMap, squadId: "a", viewerBotId: "viewer", squadPhysicsFloorIds: new Set(["outdoor", "lot6:B1"]),
    });
    expect(filtered.bots.find((entry) => entry.i === "viewer")?.r?.[1]).toHaveLength(1);
    expect(filtered.bots.find((entry) => entry.i === "mate")?.r).toBeUndefined();
    expect(filtered.bots.find((entry) => entry.i === "street-enemy")?.r).toBeUndefined();
  });

  it("withholds exact rival bodies behind walls or invisibility while retaining viewer-private radar contacts", () => {
    const privateMeta: EntityMeta[] = [
      { id: "viewer", name: "Viewer", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
      { id: "mate", name: "Mate", squadId: "a", isAmbient: false, maxShields: 3, radius: 24 },
      { id: "visible", name: "Visible", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
      { id: "hidden", name: "Hidden", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
      { id: "invisible", name: "Invisible", squadId: "b", isAmbient: false, maxShields: 3, radius: 24 },
      { id: "ambient", name: "Ambient", squadId: "grey", isAmbient: true, maxShields: 3, radius: 24 },
    ];
    const privateWire: FullWireSnapshot = {
      tick: 4,
      bots: [
        bot("viewer", "outdoor", 100, 180, {
          r: [500, [["hidden", 400, 180, "outdoor", 20]]],
          o: 500,
          ic: 500,
        }),
        bot("mate", "outdoor", 100, 260),
        bot("visible", "outdoor", 100, 300),
        bot("hidden", "outdoor", 400, 180, { o: 900, ic: 900 }),
        bot("invisible", "outdoor", 180, 180, { ic: 900 }),
        bot("ambient", "outdoor", 100, 100),
      ],
      dots: [],
      mines: [],
      coverages: [],
      noises: [],
    };

    const filtered = filterForViewer(privateWire, privateMeta, {
      map: occlusionMap,
      squadId: "a",
      viewerBotId: "viewer",
      squadPhysicsFloorIds: new Set(["outdoor"]),
    });
    expect(filtered.bots.map(({ i }) => i)).toEqual(["viewer", "mate", "visible", "ambient"]);
    expect(filtered.bots.find(({ i }) => i === "viewer")?.r?.[1]).toEqual([
      ["hidden", 400, 180, "outdoor", 20],
    ]);
    expect(filtered.bots.find(({ i }) => i === "hidden")).toBeUndefined();
    expect(filtered.rivalsAlive).toBe(3);

    const contactWire = {
      ...privateWire,
      bots: privateWire.bots.map((entry) => entry.i === "invisible" ? { ...entry, p: [145, 180] as [number, number] } : entry),
    };
    const atContact = filterForViewer(contactWire, privateMeta, {
      map: occlusionMap,
      squadId: "a",
      viewerBotId: "viewer",
      squadPhysicsFloorIds: new Set(["outdoor"]),
    });
    const disclosed = atContact.bots.find(({ i }) => i === "invisible")!;
    expect(disclosed).toBeDefined();
    expect(disclosed.ic).toBeUndefined();
    expect(disclosed.o).toBeUndefined();

    const crossFloorMeta = [...privateMeta, {
      id: "invisible-upper", name: "Upper invisible", squadId: "b", isAmbient: false, maxShields: 3, radius: 24,
    }];
    const crossFloorWire: FullWireSnapshot = {
      ...privateWire,
      bots: [
        { ...privateWire.bots[0], s: "downed" },
        privateWire.bots[1],
        bot("invisible-upper", "tower:F1", 100, 260, { ic: 900 }),
      ],
    };
    const spectating = filterForViewer(crossFloorWire, crossFloorMeta, {
      map: occlusionMap,
      squadId: "a",
      viewerBotId: "viewer",
      spectatedBotId: "mate",
      squadPhysicsFloorIds: new Set(["outdoor", "tower:F1"]),
    });
    expect(spectating.bots.some(({ i }) => i === "invisible-upper")).toBe(false);
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

  it("withholds rival mines behind walls unless personally radar-revealed", () => {
    const mineWire: FullWireSnapshot = {
      tick: 1,
      bots: [bot("viewer", "outdoor", 100, 180)],
      dots: [],
      mines: [{
        id: "hidden-mine",
        position: { x: 400, y: 180 },
        radius: 10,
        floorId: "outdoor",
        placedAtMs: 0,
        placedByBotId: "enemy",
        squadId: "b",
      }],
      coverages: [],
      noises: [],
    };
    const viewerMeta = [meta[0]];
    const context = {
      map: occlusionMap,
      squadId: "a",
      viewerBotId: "viewer",
      squadPhysicsFloorIds: new Set(["outdoor"]),
    };
    expect(filterForViewer(mineWire, viewerMeta, context).mines).toEqual([]);

    mineWire.mines[0].revealedToBotIds = ["viewer"];
    const revealed = filterForViewer(mineWire, viewerMeta, context).mines;
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toMatchObject({ presentation: "revealed" });
    expect(revealed[0].placedByBotId).toBeUndefined();
    expect(revealed[0].squadId).toBeUndefined();
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

  it("delivers a squad mark to that squad only", () => {
    /**
     * A leaked ping hands a rival two things: the place your squad is looking at, and the
     * fact that somebody is watching it. The second is worse — it is information the mark
     * itself does not even carry.
     */
    const mark = {
      type: "pinged" as const,
      botId: "viewer",
      squadId: "a",
      pingId: "ping-viewer-1200",
      kind: "enemy" as const,
      position: { x: 640, y: 420 },
      floorId: "outdoor",
    };
    const mine = filterEventsForViewer([mark], [], new Set(["viewer"]), "a");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "pinged", kind: "enemy" });

    // A rival, even one who can see the bot that placed it.
    expect(filterEventsForViewer([mark], [], new Set(["viewer"]), "b")).toHaveLength(0);
  });

  it("keeps mine sensor pings squad-private", () => {
    const event = { type: "mineSensor" as const, botId: "viewer", squadId: "a", mineId: "mine-alpha-0", position: { x: 1, y: 2 }, floorId: "outdoor" };
    expect(filterEventsForViewer([event], meta, new Set(["viewer"]), "a")).toEqual([event]);
    expect(filterEventsForViewer([event], meta, new Set(["viewer"]), "b")).toEqual([]);
  });

  it("never discloses a mine owner's identity through the victim's down event", () => {
    const event = {
      type: "downed" as const,
      botId: "viewer",
      byBotId: "hidden-owner",
      cause: {
        kind: "mine" as const,
        tick: 10,
        position: { x: 1, y: 2 },
        direction: { x: 1, y: 0 },
      },
    };
    expect(filterEventsForViewer([event], meta, new Set(["viewer"]), "a"))
      .toEqual([{ ...event, byBotId: undefined }]);
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
