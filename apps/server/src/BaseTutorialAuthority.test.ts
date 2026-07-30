import { describe, expect, it } from "vitest";
import {
  BASE_TUTORIAL_TARGET_ID,
  initialBaseTutorialState,
} from "@dotbot/game/baseTutorial";
import type { InputCommand } from "@dotbot/game/types";
import { NoopPersistence } from "./db";
import { BaseTutorialAuthority } from "./BaseTutorialAuthority";

class LiveTutorialPersistence extends NoopPersistence {
  override readonly live = true;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FirstHelloDeferredPersistence extends LiveTutorialPersistence {
  readonly firstHello = deferred();
  helloCalls = 0;

  override async helloPlayer(token: string) {
    const call = ++this.helloCalls;
    if (call === 1) await this.firstHello.promise;
    return super.helloPlayer(token);
  }
}

class TwoHelloDeferredPersistence extends LiveTutorialPersistence {
  readonly firstHello = deferred();
  readonly secondHello = deferred();
  helloCalls = 0;

  override async helloPlayer(token: string) {
    const call = ++this.helloCalls;
    if (call === 1) await this.firstHello.promise;
    if (call === 2) await this.secondHello.promise;
    return super.helloPlayer(token);
  }
}

class FlakyPracticePersistence extends LiveTutorialPersistence {
  practiceFailures = 1;
  failAfterCommit = false;

  override async advanceBaseTutorial(
    token: string,
    action: Parameters<LiveTutorialPersistence["advanceBaseTutorial"]>[1],
    revision: number,
  ) {
    if (action === "practiceHit" && this.practiceFailures > 0 && !this.failAfterCommit) {
      this.practiceFailures -= 1;
      throw new Error("Transient tutorial write failure.");
    }
    const result = await super.advanceBaseTutorial(token, action, revision);
    if (action === "practiceHit" && this.practiceFailures > 0 && this.failAfterCommit) {
      this.practiceFailures -= 1;
      throw new Error("Transient post-commit base read failure.");
    }
    return result;
  }
}

const idle: InputCommand = { move: { x: 0, y: 0 }, dash: false };

describe("BaseTutorialAuthority", () => {
  it("atomically reserves one token owner before asynchronous session creation", async () => {
    let now = 0;
    const persistence = new FirstHelloDeferredPersistence();
    const owner = await persistence.registerPlayer("Concurrent owner");
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });

    const peerA = authority.connect("peer-a", owner.token);
    const peerB = authority.connect("peer-b", owner.token);
    let duplicateSettledBeforeInitialization = false;
    void peerB.finally(() => {
      duplicateSettledBeforeInitialization = true;
    }).catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reservedBeforeAwait = duplicateSettledBeforeInitialization;
    persistence.firstHello.resolve();
    const results = await Promise.allSettled([peerA, peerB]);

    expect(reservedBeforeAwait).toBe(true);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "peer-a" : "peer-b";
    const loser = winner === "peer-a" ? "peer-b" : "peer-a";
    now += 17;
    await expect(authority.handleInput(loser, { seq: 0, input: idle, interact: false }))
      .rejects.toThrow(/session/i);
    await expect(authority.handleInput(winner, { seq: 0, input: idle, interact: false }))
      .resolves.toMatchObject({ inputAck: 0 });
    authority.close();
  });

  it("does not let stale initialization cleanup release a newer token owner", async () => {
    let now = 0;
    const persistence = new TwoHelloDeferredPersistence();
    const owner = await persistence.registerPlayer("Replacement owner");
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });

    const stale = authority.connect("peer-stale", owner.token);
    authority.disconnect("peer-stale", true);
    const replacement = authority.connect("peer-current", owner.token);
    persistence.firstHello.resolve();

    await expect(stale).rejects.toThrow(/cancelled|ownership/i);
    await expect(authority.connect("peer-intruder", owner.token)).rejects.toThrow(/connecting/i);
    persistence.secondHello.resolve();
    const connected = await replacement;
    expect(connected.inputAck).toBe(-1);
    now += 17;
    await expect(authority.handleInput("peer-current", { seq: 0, input: idle, interact: false }))
      .resolves.toMatchObject({ inputAck: 0 });
    authority.close();
  });

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
    await expect(authority.connect("peer-after-completion", account.token))
      .rejects.toThrow(/complete|finished/i);
    await expect(authority.handleInput("peer-owner", { seq: seq++, input: idle, interact: false }))
      .rejects.toThrow(/session/i);
    authority.close();
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
    expect(resumed.inputAck).toBe(11);
    now += 17;
    await expect(authority.handleInput("peer-b", {
      seq: 12,
      input: idle,
      interact: false,
    })).resolves.toMatchObject({ inputAck: 12 });
    await expect(authority.handleInput("peer-a", {
      seq: 12,
      input: idle,
      interact: false,
    })).rejects.toThrow(/session/i);
    authority.close();
  });

  it("fails closed when authoritative persistence is unavailable", async () => {
    const persistence = new NoopPersistence();
    const account = await persistence.registerPlayer("Offline");
    const authority = new BaseTutorialAuthority(persistence);
    await expect(authority.connect("peer", account.token)).rejects.toThrow(/storage/i);
  });

  it.each([
    ["before commit", false],
    ["after commit", true],
  ] as const)("retries latched practice evidence after a transient %s failure", async (_label, failAfterCommit) => {
    let now = 0;
    const persistence = new FlakyPracticePersistence();
    persistence.failAfterCommit = failAfterCommit;
    const owner = await persistence.registerPlayer("Retry practice");
    await persistence.advanceBaseTutorial(owner.token, "moved", 0);
    const authority = new BaseTutorialAuthority(persistence, { now: () => now });
    let current = await authority.connect("peer", owner.token);
    let seq = 0;
    let failed = false;

    for (let tick = 0; tick < 180 && !failed; tick += 1) {
      const target = current.snapshot.bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)!;
      const dx = target.position.x - current.playerPosition.x;
      const dy = target.position.y - current.playerPosition.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      now += 17;
      try {
        current = await authority.handleInput("peer", {
          seq: seq++,
          input: { move: { x: dx / length, y: dy / length }, dash: tick % 45 < 3 },
          interact: false,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        failed = true;
      }
    }

    expect(failed).toBe(true);
    expect(current.tutorial.phase).toBe("practice");
    expect((await persistence.getBase(owner.token))?.tutorial).toEqual(
      failAfterCommit ? { phase: "fabricator", revision: 2 } : { phase: "practice", revision: 1 },
    );

    authority.disconnect("peer");
    const stalled = await authority.connect("peer-resumed", owner.token);
    expect(stalled.tutorial).toEqual({ phase: "practice", revision: 1 });
    expect(stalled.snapshot.bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)?.state).toBe("downed");

    now += 17;
    const recovered = await authority.handleInput("peer-resumed", {
      seq: seq++,
      input: idle,
      interact: false,
    });
    expect(recovered.tutorial).toEqual({ phase: "fabricator", revision: 2 });
    expect(recovered.snapshot.bots.find((bot) => bot.id === BASE_TUTORIAL_TARGET_ID)?.state).toBe("downed");
    expect((await persistence.getBase(owner.token))?.tutorial).toEqual({ phase: "fabricator", revision: 2 });
    authority.close();
  });
});
