import { describe, expect, it } from "vitest";
import { initialBaseTutorialState } from "@dotbot/game/baseTutorial";
import type { InputCommand } from "@dotbot/game/types";
import { NoopPersistence } from "./db";
import { BaseTutorialAuthority } from "./BaseTutorialAuthority";

class LiveTutorialPersistence extends NoopPersistence {
  override readonly live = true;
}

const idle: InputCommand = { move: { x: 0, y: 0 }, dash: false };

describe("BaseTutorialAuthority", () => {
  it("derives ordered progress from a server simulation and preserves position across every phase", async () => {
    let now = 0;
    const persistence = new LiveTutorialPersistence();
    const account = await persistence.registerPlayer("Authority Pilot");
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });
    let welcome = await authority.connect("peer-owner", account.token);
    expect(welcome.tutorial).toEqual(initialBaseTutorialState);
    let seq = 0;
    const transitionPositions: Array<{ from: string; to: string; distance: number }> = [];

    const send = async (input: InputCommand, interact = false) => {
      const before = welcome;
      now += 1000 / 60;
      welcome = await authority.handleInput("peer-owner", { seq: seq++, input, interact });
      if (welcome.tutorial.phase !== before.tutorial.phase) {
        transitionPositions.push({
          from: before.tutorial.phase,
          to: welcome.tutorial.phase,
          distance: Math.hypot(
            welcome.playerPosition.x - before.playerPosition.x,
            welcome.playerPosition.y - before.playerPosition.y,
          ),
        });
      }
      return welcome;
    };

    for (let tick = 0; tick < 30 && welcome.tutorial.phase === "movement"; tick += 1) {
      await send({ move: { x: 0, y: -1 }, dash: false });
    }
    expect(welcome.tutorial.phase).toBe("practice");

    for (let tick = 0; tick < 180 && welcome.tutorial.phase === "practice"; tick += 1) {
      const target = welcome.snapshot.bots.find((bot) => bot.id === "base-practice-bot")!;
      const dx = target.position.x - welcome.playerPosition.x;
      const dy = target.position.y - welcome.playerPosition.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      await send({
        move: { x: dx / length, y: dy / length },
        dash: tick % 45 < 3,
      });
    }
    expect(welcome.tutorial.phase).toBe("fabricator");
    expect(welcome.snapshot.bots.find((bot) => bot.id === "base-practice-bot")?.state).toBe("downed");

    for (let tick = 0; tick < 100; tick += 1) {
      const dx = 380 - welcome.playerPosition.x;
      const dy = 586 - welcome.playerPosition.y;
      if (Math.hypot(dx, dy) < 8) break;
      const length = Math.max(1, Math.hypot(dx, dy));
      await send({ move: { x: dx / length, y: dy / length }, dash: false });
    }
    for (let tick = 0; tick < 70 && welcome.tutorial.phase === "fabricator"; tick += 1) {
      await send(idle, true);
    }
    expect(welcome.tutorial.phase).toBe("doorOpen");

    for (let tick = 0; tick < 160 && welcome.tutorial.phase !== "complete"; tick += 1) {
      const dx = 260 - welcome.playerPosition.x;
      const dy = 420 - welcome.playerPosition.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      await send({ move: { x: dx / length, y: dy / length }, dash: false });
    }
    expect(welcome.tutorial.phase).toBe("complete");
    expect(transitionPositions.map(({ from, to }) => `${from}->${to}`)).toEqual([
      "movement->practice",
      "practice->fabricator",
      "fabricator->doorOpen",
      "doorOpen->complete",
    ]);
    expect(Math.max(...transitionPositions.map(({ distance }) => distance))).toBeLessThan(30);
    expect(await persistence.getBaseTutorialForPlayer(account.playerId))
      .toEqual({ phase: "complete", revision: 4 });
    authority.disconnect("peer-owner");
  });

  it("rejects forged peers, replayed frames, and out-of-order frames", async () => {
    let now = 0;
    const persistence = new LiveTutorialPersistence();
    const owner = await persistence.registerPlayer("Owner");
    const other = await persistence.registerPlayer("Other");
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });
    await authority.connect("peer-owner", owner.token);

    await expect(authority.handleInput("peer-forged", { seq: 0, input: idle, interact: true }))
      .rejects.toThrow(/session/i);
    now += 17;
    await authority.handleInput("peer-owner", { seq: 0, input: idle, interact: false });
    await expect(authority.handleInput("peer-owner", { seq: 0, input: idle, interact: true }))
      .rejects.toThrow(/replayed/i);
    await expect(authority.handleInput("peer-owner", { seq: 2, input: idle, interact: true }))
      .rejects.toThrow(/out of order/i);

    await authority.connect("peer-other", other.token);
    expect((await persistence.getBaseTutorialForPlayer(other.playerId))).toEqual(initialBaseTutorialState);
    authority.disconnect("peer-owner");
    authority.disconnect("peer-other");
    authority.close();
  });

  it("rebinds a reconnecting device to the same live simulation position", async () => {
    let now = 0;
    const persistence = new LiveTutorialPersistence();
    const owner = await persistence.registerPlayer("Reconnect");
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });
    await authority.connect("peer-a", owner.token);
    let state = await authority.handleInput("peer-a", {
      seq: 0,
      input: { move: { x: 1, y: 0 }, dash: false },
      interact: false,
    });
    for (let seq = 1; seq < 12; seq += 1) {
      now += 17;
      state = await authority.handleInput("peer-a", {
        seq,
        input: { move: { x: 1, y: 0 }, dash: false },
        interact: false,
      });
    }
    const before = state.playerPosition;
    authority.disconnect("peer-a");
    now += 1_000;
    const resumed = await authority.connect("peer-b", owner.token);
    expect(resumed.playerPosition).toEqual(before);
    expect(resumed.tutorial).toEqual(state.tutorial);
    authority.close();
  });

  it("fails closed when authoritative persistence is unavailable", async () => {
    const persistence = new NoopPersistence();
    const account = await persistence.registerPlayer("Offline");
    const authority = new BaseTutorialAuthority(persistence);
    await expect(authority.connect("peer", account.token)).rejects.toThrow(/storage/i);
  });
});
