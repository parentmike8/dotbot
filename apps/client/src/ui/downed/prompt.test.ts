import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import type { CoverageSnapshot, DotBotEntity, Item } from "@dotbot/game/types";
import { bodyPrompt, downedSelf, holdRoom } from "./prompt";

const health: Item = { kind: "powerup", type: "health" };
const radar: Item = { kind: "powerup", type: "radar" };
const config = defaultGameConfig;

function bot(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id: "player",
    name: "You",
    squadId: "alpha",
    isAmbient: false,
    color: "#fff",
    position: { x: 100, y: 100 },
    radius: config.botRadius,
    state: "alive",
    floorId: "outdoor",
    facing: 0,
    moving: false,
    maxShields: 3,
    shields: 3,
    shieldSegments: [1, 1, 1],
    bays: [null, null, null],
    hold: [],
    carriedCount: 0,
    searched: false,
    pleaded: false,
    radarActiveMs: 0,
    radarPings: [],
    dashOverchargeMs: 0,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}

const body = (overrides: Partial<DotBotEntity> = {}) =>
  bot({ id: "rival", name: "Ochre", squadId: "rival-1", state: "downed", shields: 0, shieldSegments: [0, 0, 0], ...overrides });

function prompt(bots: DotBotEntity[], coverages: CoverageSnapshot[] = []) {
  return bodyPrompt({ viewer: bots[0], bots, coverages, config });
}

describe("bodyPrompt", () => {
  it("says nothing with no body in reach", () => {
    expect(prompt([bot(), body({ position: { x: 900, y: 900 } })])).toEqual({ kind: "none" });
  });

  it("offers SEARCH on any rival body, and PICK UP only on one that asked", () => {
    /**
     * Searching a rival needs no consent. Carrying one does: squads load in at three
     * and reach four only by picking up a body that pleaded, so PICK UP is offered on
     * exactly the bodies `canReviveBody` will accept. Offering it otherwise starts a
     * channel the simulation refuses one frame later, which is a bug play has already
     * reported once in another guise.
     */
    expect(prompt([bot(), body({ carriedCount: 2 })])).toEqual({
      kind: "verbs", bodyId: "rival", bodyName: "Ochre", carriedCount: 2, canPickUp: false,
    });
    expect(prompt([bot(), body({ carriedCount: 2, pleaded: true })])).toEqual({
      kind: "verbs", bodyId: "rival", bodyName: "Ochre", carriedCount: 2, canPickUp: true,
    });
  });

  it("refuses PICK UP once the squad is full, however loudly the body asked", () => {
    // Four is the cap. A fifth would make a run one long convoy.
    const full = [
      bot(),
      bot({ id: "mate-1" }), bot({ id: "mate-2" }), bot({ id: "mate-3" }),
      body({ carriedCount: 0, pleaded: true }),
    ];
    expect(prompt(full)).toMatchObject({ kind: "verbs", canPickUp: false });
  });

  it("says nothing over a squadmate, because standing there is the whole action", () => {
    // There is no verb to pick: a squadmate's body is always a revive, and the
    // progress ring at the body already says it is happening.
    expect(prompt([bot(), body({ id: "mate", squadId: "alpha" })])).toEqual({ kind: "none" });
  });

  it("turns into a picker once the body has been searched", () => {
    const searched = body({ searched: true, bays: [health, null, radar], hold: [], carriedCount: 2 });
    expect(prompt([bot(), searched])).toEqual({
      kind: "picker", bodyId: "rival", bodyName: "Ochre", items: [health, radar], room: 3 + config.holdSlots,
    });
  });

  it("reports the room the player actually has, so LOOT ALL cannot promise more", () => {
    const full = bot({ bays: [health, health, health], hold: Array.from({ length: config.holdSlots }, () => radar) });
    const result = prompt([full, body({ searched: true, bays: [health, null, null], carriedCount: 1 })]);
    expect(result).toMatchObject({ kind: "picker", room: 0 });
    expect(holdRoom(bot({ bays: [health, null, null], hold: [radar] }), config.holdSlots))
      .toBe(2 + config.holdSlots - 1);
  });

  it("shows the running channel instead of the choice that started it", () => {
    const coverages: CoverageSnapshot[] = [
      { kind: "loot", actorId: "player", targetId: "rival", progressMs: 750, durationMs: 3000 },
    ];
    expect(prompt([bot(), body()], coverages)).toEqual({
      kind: "channel", verb: "loot", bodyId: "rival", bodyName: "Ochre", progress: 0.25,
    });
  });

  it("ignores channels the player is not running, and channels on dots", () => {
    const coverages: CoverageSnapshot[] = [
      { kind: "capture", actorId: "player", targetId: "dot-1", progressMs: 100, durationMs: 200 },
      { kind: "loot", actorId: "someone-else", targetId: "rival", progressMs: 100, durationMs: 200 },
    ];
    expect(prompt([bot(), body({ carriedCount: 1 })], coverages)).toMatchObject({ kind: "verbs" });
  });

  it("prompts for the nearest body when two are underfoot", () => {
    const near = body({ id: "near", name: "Near", position: { x: 104, y: 100 }, carriedCount: 1 });
    const far = body({ id: "far", name: "Far", position: { x: 118, y: 100 }, carriedCount: 5 });
    expect(prompt([bot(), far, near])).toMatchObject({ kind: "verbs", bodyId: "near" });
  });

  it("says nothing while the viewer is down or missing", () => {
    expect(bodyPrompt({ viewer: undefined, bots: [], coverages: [], config })).toEqual({ kind: "none" });
    const downedViewer = bot({ state: "downed" });
    expect(bodyPrompt({ viewer: downedViewer, bots: [downedViewer, body()], coverages: [], config }))
      .toEqual({ kind: "none" });
  });
});

describe("downedSelf", () => {
  const base = {
    bots: [] as DotBotEntity[],
    coverages: [] as CoverageSnapshot[],
    spectating: null,
    lastPleaAtMs: null,
    nowMs: 30_000,
    pleaCooldownMs: config.pleaCooldownMs,
  };

  it("is absent for a player who is still up", () => {
    expect(downedSelf({ ...base, viewer: bot() })).toBeNull();
    expect(downedSelf({ ...base, viewer: undefined })).toBeNull();
  });

  it("counts the squadmates who could still come back for you", () => {
    const viewer = bot({ state: "downed" });
    const bots = [
      viewer,
      bot({ id: "mate-1", squadId: "alpha" }),
      bot({ id: "mate-2", squadId: "alpha", state: "downed" }),
      bot({ id: "rival", squadId: "rival-1" }),
    ];
    expect(downedSelf({ ...base, viewer, bots })).toMatchObject({ rescuers: 1, beingRevived: false });
  });

  it("knows when somebody is already picking you up", () => {
    const viewer = bot({ state: "downed" });
    const coverages: CoverageSnapshot[] = [
      { kind: "revive", actorId: "mate-1", targetId: "player", progressMs: 10, durationMs: 100 },
    ];
    expect(downedSelf({ ...base, viewer, coverages })).toMatchObject({ beingRevived: true });
  });

  it("names the squadmate whose camera you have, and nothing once they are gone", () => {
    const viewer = bot({ state: "downed" });
    expect(downedSelf({ ...base, viewer, spectating: bot({ id: "mate-1", name: "Indigo" }) }))
      .toMatchObject({ watching: "Indigo" });
    expect(downedSelf({ ...base, viewer })).toMatchObject({ watching: null });
  });

  it("holds the plea until its cooldown is up, counted from the authoritative event", () => {
    const viewer = bot({ state: "downed" });
    expect(downedSelf({ ...base, viewer })).toMatchObject({ pleaReady: true, pleaReadyInMs: 0 });
    const justPled = downedSelf({ ...base, viewer, lastPleaAtMs: 30_000, nowMs: 32_000 })!;
    expect(justPled.pleaReady).toBe(false);
    expect(justPled.pleaReadyInMs).toBe(config.pleaCooldownMs - 2_000);
    expect(downedSelf({ ...base, viewer, lastPleaAtMs: 30_000, nowMs: 30_000 + config.pleaCooldownMs }))
      .toMatchObject({ pleaReady: true });
  });
});
