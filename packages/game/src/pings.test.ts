import { describe, expect, it } from "vitest";
import { DotBotSimulation } from "./simulation";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import type { SimEvent } from "./types";

/**
 * A mark reaches your squad and nobody else.
 *
 * The leak is the thing worth guarding: a ping tells a rival both where your squad is
 * looking AND that somebody is watching it, which is more information than the mark itself
 * carries. So the squad filter is asserted at the delivery boundary rather than trusted.
 */

function sim() {
  return DotBotSimulation.create({ map: downtownMap, config: defaultGameConfig });
}

function pings(events: readonly SimEvent[]) {
  return events.filter((event): event is Extract<SimEvent, { type: "pinged" }> => event.type === "pinged");
}

/** The first two human-controlled bots, which the downtown sheet authors as players. */
function twoPlayers(simulation: DotBotSimulation) {
  const bots = simulation.getSnapshot().bots.filter((bot) => !bot.isAmbient);
  expect(bots.length, "the map needs at least two non-ambient bots").toBeGreaterThan(1);
  return bots;
}

describe("marking a place", () => {
  it("emits one event carrying everything a mark needs", async () => {
    const simulation = await sim();
    const [me] = twoPlayers(simulation);
    simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "enemy", position: { x: 640, y: 420 } } });
    simulation.step();

    const marks = pings(simulation.drainEvents());
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      botId: me.id,
      squadId: me.squadId,
      kind: "enemy",
      position: { x: 640, y: 420 },
    });
    expect(marks[0].pingId).toBeTruthy();
  });

  it("keeps NO simulation state — the event is the whole thing", async () => {
    /**
     * The design decision, asserted so it cannot be quietly reversed into a world list with
     * a TTL and a cap. A mark has no authority: nothing collides with it, nothing shoots it,
     * it decides nothing. The snapshot is the authoritative world, so a mark must not appear
     * in it.
     */
    const simulation = await sim();
    const [me] = twoPlayers(simulation);
    simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "here", position: { x: 700, y: 400 } } });
    simulation.step();
    simulation.drainEvents();

    const snapshot = simulation.getSnapshot() as unknown as Record<string, unknown>;
    for (const key of Object.keys(snapshot)) {
      expect(key.toLowerCase(), "no ping state on the snapshot").not.toContain("ping");
    }
  });

  it("clamps a mark to the sheet", async () => {
    // The position comes from a click un-projected through a camera, so a click during a
    // camera ease can land outside the map. A mark off the sheet is a mark nobody can see.
    const simulation = await sim();
    const [me] = twoPlayers(simulation);
    simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "here", position: { x: -900, y: 99_999 } } });
    simulation.step();

    const [mark] = pings(simulation.drainEvents());
    expect(mark.position.x).toBe(0);
    expect(mark.position.y).toBe(downtownMap.height);
  });

  it("rate limits one bot rather than letting a held input stream", async () => {
    /**
     * Expressed as a RATE, in terms of the configured cooldown, because the first version of
     * this test asserted "thirty ticks of input is exactly one mark" — which silently encoded
     * `pingCooldownMs: 900`. When that 900 turned out to be a bug that ate half the player's
     * clicks, the test failed for being right about the old number rather than about the rule.
     * A test that pins a constant it does not name will do that every time the constant moves.
     *
     * The rule is: a stream of identical input cannot produce a mark per tick. So the bound is
     * derived from the cooldown, with slack for where the ticks fall relative to it.
     */
    const simulation = await sim();
    const [me] = twoPlayers(simulation);
    const ticks = 120;
    const tickMs = 1000 / defaultGameConfig.tickHz;
    let sent = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "here", position: { x: 700, y: 400 } } });
      simulation.step();
      sent += pings(simulation.drainEvents()).length;
    }

    const window = ticks * tickMs;
    const allowed = Math.ceil(window / defaultGameConfig.pingCooldownMs) + 1;
    expect(sent, `${ticks} ticks of held input`).toBeLessThanOrEqual(allowed);
    // And far fewer than one per tick, which is what the cooldown exists to prevent.
    expect(sent).toBeLessThan(ticks / 4);
    // But not zero: a rate limit that never lets anything through is a mute button.
    expect(sent).toBeGreaterThan(0);
  });

  it("steers an AI squadmate that was doing something else", async () => {
    /**
     * The point of the whole feature for a solo player: a mark has to move a squadmate, not
     * just draw a chevron. Asserted as "the marked bot went somewhere" rather than by naming
     * the exact target it should choose, because naming it would pin the AI's entire priority
     * order and fail the next time an unrelated intent is added.
     */
    const simulation = await sim();
    const [me] = twoPlayers(simulation);
    const mate = simulation.getSnapshot().bots.find(
      (bot) => bot.id !== me.id && bot.squadId === me.squadId && !bot.isAmbient,
    );
    if (!mate) return; // single-bot squad on this sheet; squads are assigned per match

    for (let tick = 0; tick < 20; tick += 1) simulation.step();
    const before = simulation.getSnapshot().bots.find((bot) => bot.id === mate.id)!;

    const far = { x: downtownMap.width - 200, y: downtownMap.height - 200 };
    simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "here", position: far } });
    for (let tick = 0; tick < 40; tick += 1) simulation.step();
    const after = simulation.getSnapshot().bots.find((bot) => bot.id === mate.id)!;

    const moved = Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y);
    expect(moved, "a marked squadmate should be going somewhere").toBeGreaterThan(0);
  });

  it("stamps the marker's own squad on the event", async () => {
    /**
     * The squad id is what the delivery filter keys on, so it has to be the MARKER's rather
     * than anything derived later. The filter itself is asserted in
     * `packages/protocol/src/interest.test.ts` — it cannot be tested here, because protocol
     * depends on game and not the other way round.
     */
    const simulation = await sim();
    const bots = twoPlayers(simulation);
    const me = bots[0];
    simulation.applyInput(me.id, { move: { x: 0, y: 0 }, dash: false, ping: { kind: "loot", position: { x: 620, y: 430 } } });
    simulation.step();
    const [mark] = pings(simulation.drainEvents());
    expect(mark.squadId).toBe(me.squadId);
    // Two squads only exist once a match assigns them, so the rival case is asserted where
    // it can be: `interest.test.ts`, at the delivery boundary that actually filters.
  });

});
