import { describe, expect, it } from "vitest";
import type { KillCamClip } from "@dotbot/protocol";
import {
  KillCamPlayback,
  killCamCameraTarget,
  killCamLabel,
  killCamSnapshot,
  liveStateEndsKillCam,
} from "./killCam";

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
      visibleBots: [{ id: "mate", position: { x: 90, y: 120 }, facing: 0, floorId: "outdoor", shieldSegments: [1, 0, 0], dashActiveMs: 0, state: "alive" }],
      blockingDoorIds: [],
    },
    {
      tick: 30,
      victim: { id: "victim", position: { x: 120, y: 100 }, facing: 0, floorId: "outdoor", shieldSegments: [1, 0, 0], dashActiveMs: 0, state: "alive" },
      source: { id: "killer", position: { x: 220, y: 100 }, facing: Math.PI, floorId: "outdoor", shieldSegments: [1, 1, 1], dashActiveMs: 100, state: "alive" },
      visibleBots: [{ id: "mate", position: { x: 100, y: 120 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" }],
      blockingDoorIds: [],
    },
    {
      tick: 60,
      victim: { id: "victim", position: { x: 150, y: 100 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" },
      source: { id: "killer", position: { x: 180, y: 100 }, facing: Math.PI, floorId: "outdoor", shieldSegments: [1, 1, 1], dashActiveMs: 0, state: "alive" },
      visibleBots: [{ id: "mate", position: { x: 110, y: 120 }, facing: 0, floorId: "outdoor", shieldSegments: [0, 0, 0], dashActiveMs: 0, state: "downed" }],
      blockingDoorIds: [],
    },
  ],
};

describe("KillCamPlayback", () => {
  it("names the source and cause without restating the lethal core outcome", () => {
    expect(killCamLabel(clip, "Quetzal")).toBe("DOWNED BY QUETZAL · DASH");
    expect(killCamLabel({ ...clip, cause: { ...clip.cause, kind: "ram" } }, "Quetzal"))
      .toBe("DOWNED BY QUETZAL · RAM");
    expect(killCamLabel({ ...clip, cause: { ...clip.cause, kind: "mine" } })).toBe("MINE");
    expect(killCamLabel({ ...clip, cause: { ...clip.cause, kind: "environment" } })).toBe("IMPACT");
  });

  it("uses an isolated deterministic near-real-time clock and never exposes the source before its visible frame", () => {
    const playback = new KillCamPlayback(clip);
    expect(playback.sample().source).toBeUndefined();
    playback.advance(600);
    expect(playback.replayTick).toBeCloseTo(28.8);
    expect(playback.sample().source).toBeUndefined();
    playback.advance(25);
    expect(playback.replayTick).toBeCloseTo(30);
    expect(playback.sample().source?.id).toBe("killer");
  });

  it("finishes after replay plus a short impact hold, and skip is immediate", () => {
    const playback = new KillCamPlayback(clip);
    playback.advance(2_400);
    expect(playback.finished).toBe(false);
    playback.advance(50);
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
      ["mate", { id: "mate", name: "Mate", squadId: "alpha", isAmbient: true, maxShields: 3, radius: 20 }],
    ]), []);
    expect(rendered.bots.map((bot) => bot.id)).toEqual(["victim", "killer", "mate"]);
    expect(rendered.bots.find((bot) => bot.id === "mate")?.state).toBe("downed");
    expect(rendered.dots).toEqual([]);
    expect(rendered.coverages).toEqual([]);
    expect(rendered.noises).toEqual([]);
  });

  it("ends a dash replay at the exact visible body-contact distance", () => {
    const separatedImpact = {
      ...clip.frames.at(-1)!,
      source: {
        ...clip.frames.at(-1)!.source!,
        position: { x: 260, y: 100 },
      },
    };
    const rendered = killCamSnapshot(separatedImpact, clip, new Map([
      ["victim", { id: "victim", name: "Victim", squadId: "alpha", isAmbient: false, maxShields: 3, radius: 24 }],
      ["killer", { id: "killer", name: "Killer", squadId: "bravo", isAmbient: true, maxShields: 3, radius: 24 }],
    ]), []);
    const victim = rendered.bots.find((bot) => bot.id === "victim")!;
    const killer = rendered.bots.find((bot) => bot.id === "killer")!;
    expect(Math.hypot(
      killer.position.x - victim.position.x,
      killer.position.y - victim.position.y,
    )).toBeCloseTo(24 * 0.4 + 24, 6);
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

  it("blends into source framing on the replay clock instead of snapping when the killer appears", () => {
    const atAdmission = killCamCameraTarget(clip.frames[1], clip);
    expect(atAdmission).toEqual(clip.frames[1].victim.position);

    const playback = new KillCamPlayback(clip);
    playback.advance(900);
    const midway = playback.sample();
    const target = killCamCameraTarget(midway, clip);
    const impactMidpoint = {
      x: (midway.victim.position.x + midway.source!.position.x) / 2,
      y: (midway.victim.position.y + midway.source!.position.y) / 2,
    };
    expect(target.x).toBeGreaterThan(midway.victim.position.x);
    expect(target.x).toBeLessThan(impactMidpoint.x);
    expect(killCamCameraTarget(clip.frames[2], clip)).toEqual({
      x: (clip.frames[2].victim.position.x + clip.frames[2].source!.position.x) / 2,
      y: (clip.frames[2].victim.position.y + clip.frames[2].source!.position.y) / 2,
    });
  });

  it("ignores a stale pre-death alive snapshot but ends after an actual revive", () => {
    expect(liveStateEndsKillCam(false, "alive", false)).toBe(false);
    expect(liveStateEndsKillCam(true, "downed", false)).toBe(false);
    expect(liveStateEndsKillCam(true, "alive", false)).toBe(true);
    expect(liveStateEndsKillCam(false, "alive", true)).toBe(true);
  });
});
