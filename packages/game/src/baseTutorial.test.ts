import { describe, expect, it } from "vitest";
import { createBaseMap, starterBaseLayout } from "./content/base";
import { DotBotSimulation } from "./simulation";
import {
  BASE_TUTORIAL_DOOR_ID,
  BASE_TUTORIAL_ENTRY_Y,
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_FABRICATOR_DOT_ID,
  BASE_TUTORIAL_TARGET_ID,
  advanceBaseTutorial,
  initialBaseTutorialState,
  type BaseTutorialState,
} from "./baseTutorial";

const state = (phase: BaseTutorialState["phase"], revision: number): BaseTutorialState => ({ phase, revision });

describe("base tutorial authority", () => {
  it("advances in order, resumes from a persisted revision, and treats retries as idempotent", () => {
    const moved = advanceBaseTutorial(initialBaseTutorialState, "moved");
    expect(moved).toEqual({ state: state("practice", 1), changed: true });
    expect(advanceBaseTutorial(moved.state, "moved")).toEqual({ state: moved.state, changed: false });

    const practiced = advanceBaseTutorial(moved.state, "practiceHit");
    expect(practiced).toEqual({ state: state("fabricator", 2), changed: true });
    expect(advanceBaseTutorial(practiced.state, "practiceHit")).toEqual({ state: practiced.state, changed: false });

    const fabricated = advanceBaseTutorial(practiced.state, "usedFabricator");
    expect(fabricated).toEqual({ state: state("doorOpen", 3), changed: true });
    expect(advanceBaseTutorial(fabricated.state, "enteredBase"))
      .toEqual({ state: state("complete", 4), changed: true });
  });

  it("rejects skipped and stale future actions instead of letting clients bypass the room", () => {
    expect(() => advanceBaseTutorial(initialBaseTutorialState, "practiceHit")).toThrow(/out of order/i);
    expect(() => advanceBaseTutorial(initialBaseTutorialState, "usedFabricator")).toThrow(/out of order/i);
    expect(() => advanceBaseTutorial(initialBaseTutorialState, "enteredBase")).toThrow(/out of order/i);
    expect(() => advanceBaseTutorial(state("practice", 1), "enteredBase")).toThrow(/out of order/i);
  });
});

describe("base tutorial room", () => {
  it("gates the real base and its interactions until the practice target opens the door", () => {
    const closed = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("practice", 1) });
    const closedDoor = closed.buildings[0].floors[0].doorways.find((door) => door.id === BASE_TUTORIAL_DOOR_ID);
    expect(closedDoor).toMatchObject({ mechanism: "automatic", locked: true });
    expect(closed.interactionDots?.some((dot) => dot.id === BASE_TUTORIAL_FABRICATOR_DOT_ID)).toBe(true);
    expect(closed.placementSlots).not.toEqual([]);
    expect(closed.botSpawns.find((spawn) => spawn.id === BASE_TUTORIAL_TARGET_ID))
      .toMatchObject({ controller: "frozen", faction: "ambient", maxShields: 1, shields: 0, bays: [], hold: [] });
    expect(closed.buildings[0].floors[0].objects.find((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID))
      .toMatchObject({ enabled: false, solid: true });

    const lesson = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("fabricator", 2) });
    expect(lesson.buildings[0].floors[0].doorways.find((door) => door.id === BASE_TUTORIAL_DOOR_ID))
      .toMatchObject({ locked: true });
    expect(lesson.buildings[0].floors[0].objects.find((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID))
      .toMatchObject({ enabled: true, solid: true });

    const open = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("doorOpen", 3) });
    expect(open.buildings[0].floors[0].doorways.find((door) => door.id === BASE_TUTORIAL_DOOR_ID))
      .toMatchObject({ mechanism: "automatic", locked: false });
    expect(open.botSpawns.find((spawn) => spawn.id === BASE_TUTORIAL_TARGET_ID)?.state).toBe("downed");
    expect(open.buildings[0].floors[0].objects.some((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID)).toBe(true);

    const complete = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("complete", 4) });
    expect(complete.placementSlots).not.toEqual([]);
    expect(complete.interactionDots?.some((dot) => dot.kind === "deployment")).toBe(true);
    expect(complete.interactionDots?.some((dot) => dot.kind === "object")).toBe(true);
    expect(complete.botSpawns.some((spawn) => spawn.id === BASE_TUTORIAL_TARGET_ID)).toBe(false);
    expect(complete.buildings[0].floors[0].objects.find((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID))
      .toMatchObject({ enabled: true, solid: true });
  });

  it("uses a harmless frozen fake AI that can be downed but cannot hurt, chase, loot, or drop cargo", async () => {
    const map = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("practice", 1) });
    const target = map.botSpawns.find((spawn) => spawn.id === BASE_TUTORIAL_TARGET_ID)!;
    const player = map.botSpawns.find((spawn) => spawn.id === "player")!;
    player.position = { x: target.position.x, y: target.position.y + 92 };

    const simulation = await DotBotSimulation.create({
      map,
      config: {
        damageSpeed: 250,
        playerSpeed: 260,
        botSpeed: 260,
        dashSpeed: 760,
        shieldInvulnerabilityMs: 0,
      },
    });
    const before = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!;
    for (let tick = 0; tick < 90; tick += 1) {
      simulation.applyInput("player", { move: { x: 0, y: -1 }, dash: tick === 0 });
      simulation.step();
      if (simulation.getSnapshot().bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)?.state === "downed") break;
    }
    const snapshot = simulation.getSnapshot();
    const after = snapshot.bots.find((bot) => bot.id === "player")!;
    const practice = snapshot.bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)!;
    const events = simulation.drainEvents();

    expect(practice).toMatchObject({ state: "downed", bays: [null, null, null], hold: [], carriedCount: 0 });
    expect(after).toMatchObject({ state: "alive", shields: before.shields });
    expect(events).toContainEqual(expect.objectContaining({
      type: "downed",
      botId: BASE_TUTORIAL_TARGET_ID,
      byBotId: "player",
    }));
    expect(events.some((event) => event.type === "downed" && event.botId === "player")).toBe(false);
    simulation.dispose();
  });

  it("blocks a full-size DotBot at the locked leaf and admits it through the authoritative open state", async () => {
    const walkNorth = async (tutorial: BaseTutorialState) => {
      const map = createBaseMap(starterBaseLayout, "workshop", { tutorial });
      const player = map.botSpawns.find((spawn) => spawn.id === "player")!;
      player.position = { x: 260, y: 530 };
      const simulation = await DotBotSimulation.create({
        map,
        config: { playerSpeed: 260, botSpeed: 260 },
      });
      let minimumY = player.position.y;
      for (let tick = 0; tick < 160; tick += 1) {
        simulation.applyInput("player", { move: { x: 0, y: -1 }, dash: false });
        simulation.step();
        minimumY = Math.min(
          minimumY,
          simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position.y,
        );
      }
      simulation.dispose();
      return minimumY;
    };

    expect(await walkNorth(state("practice", 1))).toBeGreaterThan(500);
    expect(await walkNorth(state("doorOpen", 3))).toBeLessThan(BASE_TUTORIAL_ENTRY_Y);
  });

  it("changes tutorial fixtures in place without recreating or resetting the simulation", async () => {
    const map = createBaseMap(starterBaseLayout, "workshop", { tutorial: state("movement", 0) });
    const simulation = await DotBotSimulation.create({ map, config: { playerSpeed: 260, botSpeed: 260 } });
    for (let tick = 0; tick < 18; tick += 1) {
      simulation.applyInput("player", { move: { x: 1, y: 0 }, dash: false });
      simulation.step();
    }
    const before = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;

    expect(simulation.setMapObjectEnabled(BASE_TUTORIAL_FABRICATOR_ID, true)).toBe(true);
    expect(simulation.setDoorLocked(BASE_TUTORIAL_DOOR_ID, false)).toBe(true);
    const after = simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position;

    expect(after).toEqual(before);
    expect(simulation.getSnapshot().doors?.find((door) => door.doorwayId === BASE_TUTORIAL_DOOR_ID)?.blocking)
      .toBe(true);
    simulation.step();
    expect(simulation.getSnapshot().bots.find((bot) => bot.id === "player")!.position.x).toBeGreaterThan(before.x);
    simulation.dispose();
  });
});
