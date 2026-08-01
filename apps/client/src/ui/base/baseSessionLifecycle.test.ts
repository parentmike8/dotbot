import { describe, expect, it } from "vitest";
import { BASE_TUTORIAL_TARGET_ID } from "@dotbot/game/baseTutorial";
import { starterBaseLayout } from "@dotbot/game/content/base";
import { collectSolids } from "@dotbot/game/collision";
import type { BaseLayout, GameSnapshot } from "@dotbot/game/types";
import {
  BaseSessionLifecycle,
  tutorialAuthorityToken,
  type BaseSessionWorld,
} from "./baseSessionLifecycle";

const complete = { phase: "complete" as const, revision: 4 };
const initial: BaseSessionWorld = {
  layout: starterBaseLayout,
  shell: "workshop",
  expanded: false,
  tutorial: { phase: "movement", revision: 0 },
};

describe("BaseSessionLifecycle", () => {
  it("uses the device token issued while a local first-run base is being promoted", () => {
    expect(tutorialAuthorityToken("", "fresh-device-token")).toBe("fresh-device-token");
    expect(tutorialAuthorityToken("existing-device-token", null)).toBe("existing-device-token");
  });

  it("promotes a locally mounted first-run base when durable identity finishes linking", () => {
    const lifecycle = new BaseSessionLifecycle(initial, false);
    const linkedWorld: BaseSessionWorld = {
      layout: { ...starterBaseLayout, "floor-south": "workbench" },
      shell: "workshop",
      expanded: false,
      tutorial: { phase: "movement", revision: 0 },
    };

    expect(lifecycle.world(linkedWorld).authoritative).toBe(false);
    expect(lifecycle.activateAuthoritative(linkedWorld)).toBe(true);
    expect(lifecycle.world(linkedWorld)).toMatchObject({
      authoritative: true,
      layout: linkedWorld.layout,
      tutorial: linkedWorld.tutorial,
    });
    expect(lifecycle.activateAuthoritative(linkedWorld)).toBe(false);
  });

  it("keeps one frozen authoritative world through incomplete phase changes", () => {
    const lifecycle = new BaseSessionLifecycle(initial, true);
    const changed: BaseSessionWorld = {
      layout: { ...starterBaseLayout, "floor-south": "workbench" },
      shell: "hangar",
      expanded: true,
      tutorial: { phase: "doorOpen", revision: 3 },
    };

    expect(lifecycle.acceptAuthoritative(authoritySnapshot("practice", 1, { x: 260, y: 570 })))
      .toBe(false);
    const before = lifecycle.world(initial);
    const after = lifecycle.world(changed);

    expect(after.authoritative).toBe(true);
    expect(after.layout).toBe(before.layout);
    expect(after.shell).toBe("workshop");
    expect(after.expanded).toBe(false);
    expect(after.spawn).toBeNull();
  });

  it("hands off terminal authority at the exact final position into the current layout", () => {
    const lifecycle = new BaseSessionLifecycle(initial, true);
    const finalPosition = { x: 301.25, y: 486.75 };
    const current: BaseSessionWorld = {
      layout: { ...starterBaseLayout, "floor-south": "workbench" },
      shell: "hangar",
      expanded: true,
      tutorial: complete,
    };

    expect(lifecycle.acceptAuthoritative(authoritySnapshot("complete", 4, finalPosition))).toBe(true);
    const world = lifecycle.world(current);
    const map = lifecycle.createMap(current);
    const player = map.botSpawns.find((spawn) => spawn.id === "player")!;

    expect(world.authoritative).toBe(false);
    expect(world.layout).toBe(current.layout);
    expect(world.shell).toBe("hangar");
    expect(world.expanded).toBe(true);
    expect(player.position).toEqual(finalPosition);
    expect(player.floorId).toBe("outdoor");
    expect(map.botSpawns.some((spawn) => spawn.id === BASE_TUTORIAL_TARGET_ID)).toBe(false);
    expect(map.buildings[0].floors).toHaveLength(2);
  });

  it("retires authority after an authenticated skip and uses the regular base spawn", () => {
    const lifecycle = new BaseSessionLifecycle(initial, true);

    expect(lifecycle.acceptSkipped(complete)).toBe(true);
    expect(lifecycle.authoritative).toBe(false);
    expect(lifecycle.world({ ...initial, tutorial: complete })).toMatchObject({
      authoritative: false,
      tutorial: complete,
      spawn: null,
    });
    expect(lifecycle.acceptSkipped(complete)).toBe(false);
  });

  it("rebuilds post-completion art and collision from the same current layout", () => {
    const lifecycle = new BaseSessionLifecycle({ ...initial, tutorial: complete }, false);
    lifecycle.rememberLocalSnapshot(localSnapshot({ x: 512, y: 344 }));
    const nextLayout: BaseLayout = {
      ...starterBaseLayout,
      "floor-south": "workbench",
    };
    const next: BaseSessionWorld = {
      layout: nextLayout,
      shell: "workshop",
      expanded: false,
      tutorial: complete,
    };
    const map = lifecycle.createMap(next);
    const floor = map.buildings[0].floors[0];
    const object = floor.objects.find((candidate) => candidate.slotId === "floor-south")!;
    const solids = collectSolids(map, floor.id);

    expect(object.kind).toBe("workbench");
    expect(solids.some((solid) =>
      solid.kind === "rect"
      && solid.x === object.x
      && solid.y === object.y
      && solid.w === object.w
      && solid.h === object.h)).toBe(true);
    expect(map.botSpawns.find((spawn) => spawn.id === "player")?.position)
      .toEqual({ x: 512, y: 344 });
  });

  it("uses current shell and expansion state for already-complete accounts", () => {
    const lifecycle = new BaseSessionLifecycle({ ...initial, tutorial: complete }, false);
    const workshop = lifecycle.createMap({ ...initial, tutorial: complete });
    const expandedHangar = lifecycle.createMap({
      ...initial,
      shell: "hangar",
      expanded: true,
      tutorial: complete,
    });

    expect(workshop.outdoor.objects.some((object) => object.id === "base-workshop-sign")).toBe(true);
    expect(expandedHangar.outdoor.objects.some((object) => object.id === "base-hangar-sign")).toBe(true);
    expect(expandedHangar.buildings[0].floors).toHaveLength(2);
    expect(expandedHangar.buildings[0].floors[0].stairs).toHaveLength(1);
  });
});

function authoritySnapshot(
  phase: "practice" | "complete",
  revision: number,
  position: { x: number; y: number },
) {
  return {
    tutorial: { phase, revision },
    playerPosition: position,
    inputAck: 12,
    fabricatorEnabled: false,
    snapshot: localSnapshot(position),
  };
}

function localSnapshot(position: { x: number; y: number }): GameSnapshot {
  return {
    timeMs: 4000,
    bots: [{
      id: "player",
      name: "Player",
      squadId: "base",
      isAmbient: false,
      color: "#fff",
      position,
      radius: 24,
      state: "alive",
      floorId: "outdoor",
      facing: 0,
      moving: false,
      maxShields: 3,
      shields: 3,
      shieldSegments: [1, 1, 1],
      bays: [],
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
    }],
    dots: [],
    mines: [],
    coverages: [],
    noises: [],
    doors: [],
    debug: { tickHz: 60, tickCount: 240, fps: 60, activeBodies: 1, activeDots: 0 },
  };
}
