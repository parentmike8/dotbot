import { describe, expect, it } from "vitest";
import type { KillCamClip } from "@dotbot/protocol";
import { KillCamPlayback, killCamSnapshot } from "./killCam";

const clip: KillCamClip = {
  id: "victim-60",
  victimId: "victim",
  sourceBotId: "killer",
  cause: {
    kind: "dash",
    tick: 60,
    position: { x: 160, y: 100 },
    direction: { x: -1, y: 0 },
  },
  startTick: 0,
  deathTick: 60,
  tickHz: 60,
  frames: [
    {
      tick: 0,
      victim: { id: "victim", position: { x: 100, y: 100 }, facing: 0, floorId: "outdoor", shieldSegments: [1, 0, 0], dashActiveMs: 0, state: "alive" },
      blockingDoorIds: [],
    },
    {
      tick: 30,
      victim: { id: "victim", position: { x: 120, y: 100 }, facing: 0, floorId: "outdoor", shieldSegments: [1, 0, 0], dashActiveMs: 0, state: "alive" },
      source: { id: "killer", position: { x: 220, y: 100 }, facing: Math.PI, floorId: "outdoor", shieldSegments: [1, 1, 1], dashActiveMs: 100, state: "alive" },
      blockingDoorIds: [],
    },
    {
      tick: 60,
      victim: { id: "victim", position: { x: 150, y: 100 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" },
      source: { id: "killer", position: { x: 180, y: 100 }, facing: Math.PI, floorId: "outdoor", shieldSegments: [1, 1, 1], dashActiveMs: 0, state: "alive" },
      blockingDoorIds: [],
    },
  ],
};

describe("KillCamPlayback", () => {
  it("uses an isolated deterministic quarter-speed clock and never exposes the source before its visible frame", () => {
    const playback = new KillCamPlayback(clip);
    expect(playback.sample().source).toBeUndefined();
    playback.advance(1_000);
    expect(playback.replayTick).toBeCloseTo(15);
    expect(playback.sample().source).toBeUndefined();
    playback.advance(1_000);
    expect(playback.replayTick).toBeCloseTo(30);
    expect(playback.sample().source?.id).toBe("killer");
  });

  it("finishes after replay plus a short impact hold, and skip is immediate", () => {
    const playback = new KillCamPlayback(clip);
    playback.advance(4_000);
    expect(playback.finished).toBe(false);
    playback.advance(700);
    expect(playback.finished).toBe(true);

    const skipped = new KillCamPlayback(clip);
    skipped.skip();
    expect(skipped.finished).toBe(true);
  });

  it("builds an inert render-only snapshot containing only approved actors and no live dynamics", () => {
    const playback = new KillCamPlayback(clip);
    playback.advance(3_000);
    const rendered = killCamSnapshot(playback.sample(), clip, new Map([
      ["victim", { id: "victim", name: "Victim", squadId: "alpha", isAmbient: false, maxShields: 3, radius: 24 }],
      ["killer", { id: "killer", name: "Killer", squadId: "bravo", isAmbient: false, maxShields: 3, radius: 24 }],
    ]), []);
    expect(rendered.bots.map((bot) => bot.id)).toEqual(["victim", "killer"]);
    expect(rendered.dots).toEqual([]);
    expect(rendered.coverages).toEqual([]);
    expect(rendered.noises).toEqual([]);
  });

  it("shows a source-neutral mine device only at the impact", () => {
    const mineClip: KillCamClip = {
      ...clip,
      sourceBotId: undefined,
      cause: { ...clip.cause, kind: "mine" },
    };
    const atImpact = killCamSnapshot(mineClip.frames.at(-1)!, mineClip, new Map(), []);
    expect(atImpact.mines).toEqual([expect.objectContaining({
      id: `kill-cam-cause-${mineClip.id}`,
      placedByBotId: "",
      presentation: "revealed",
      position: mineClip.cause.position,
    })]);
    expect(JSON.stringify(atImpact.mines)).not.toContain("killer");
  });
});
