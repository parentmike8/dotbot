import { describe, expect, it, vi } from "vitest";
import { buildTrailMarks, fadeTrail, stampTrail } from "./model/modelMotion";
import type { GameRenderer as GameRendererType } from "./GameRenderer";

describe("GameRenderer hot-run reset", () => {
  it("drops old signals, same-id views, impacts, trails, and camera carry-over", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { search: "" } });
    const { GameRenderer } = await import("./GameRenderer");
    const trail = buildTrailMarks();
    stampTrail(trail, { x: 100, y: 100 }, { x: 124, y: 100 }, 0, 5_000, "human-SAME-1234");
    fadeTrail(trail, 5_000);
    const botRoot = { destroy: vi.fn() };
    const impactRoot = { destroy: vi.fn() };
    const transientGraphics = Array.from({ length: 8 }, () => ({ clear: vi.fn() }));
    const [maskedGfx, doorGfx, collisionGfx, dynamicGfx, screenGfx, visionMaskGfx, fogGfx, foregroundFogGfx] = transientGraphics;
    const renderer = Object.assign(Object.create(GameRenderer.prototype), {
      pleaSignals: new Map([["human-SAME-1234", { startedAt: 5_000 }]]),
      mineSignals: new Map([["mine-old", { startedAt: 5_000 }]]),
      impactFlashes: [{ predictionId: "old-impact" }],
      botViews: new Map([["human-SAME-1234", { root: botRoot }]]),
      impactViews: new Map([["old-impact", { root: impactRoot }]]),
      trailAnchors: new Map([["human-SAME-1234", { x: 124, y: 100 }]]),
      art: { trails: trail },
      maskedGfx,
      doorGfx,
      collisionGfx,
      dynamicGfx,
      screenGfx,
      visionMaskGfx,
      fogGfx,
      foregroundFogGfx,
      impactLayer: { visible: true },
      signLayer: { visible: true },
      wadeLevel: 1,
      wadeLayer: { alpha: 1, visible: true },
      squadMarks: [{ id: "old-mark" }],
      lastViewer: { id: "human-SAME-1234" },
      lastTimeMs: 5_000,
      lastCamera: { x: 20, y: 30, scale: 2 },
      cameraCenter: { x: 100, y: 100 },
      lastCameraTarget: { x: 100, y: 100 },
      cameraVelocity: { x: 5, y: 6 },
      cameraImpulse: { x: 3, y: 4 },
      lastCameraAt: 0,
      replayCameraActive: true,
      lastParallaxCentre: { x: 100, y: 100 },
      lastParallaxFloorId: "outdoor",
    }) as GameRendererType;

    renderer.resetForNewRun();

    const state = renderer as unknown as {
      pleaSignals: Map<string, unknown>;
      mineSignals: Map<string, unknown>;
      impactFlashes: unknown[];
      botViews: Map<string, unknown>;
      impactViews: Map<string, unknown>;
      trailAnchors: Map<string, unknown>;
      squadMarks: unknown[];
      lastViewer: unknown;
      lastTimeMs: number;
      cameraCenter: unknown;
      cameraVelocity: { x: number; y: number };
      cameraImpulse: { x: number; y: number };
      replayCameraActive: boolean;
      impactLayer: { visible: boolean };
      signLayer: { visible: boolean };
      wadeLevel: number;
      wadeLayer: { alpha: number; visible: boolean };
    };
    expect(state.pleaSignals.size).toBe(0);
    expect(state.mineSignals.size).toBe(0);
    expect(state.impactFlashes).toEqual([]);
    expect(state.botViews.size).toBe(0);
    expect(state.impactViews.size).toBe(0);
    expect(state.trailAnchors.size).toBe(0);
    expect(state.squadMarks).toEqual([]);
    expect(state.lastViewer).toBeNull();
    expect(state.lastTimeMs).toBe(0);
    expect(state.cameraCenter).toBeNull();
    expect(state.cameraVelocity).toEqual({ x: 0, y: 0 });
    expect(state.cameraImpulse).toEqual({ x: 0, y: 0 });
    expect(state.replayCameraActive).toBe(false);
    expect(transientGraphics.every((graphics) => graphics.clear.mock.calls.length === 1)).toBe(true);
    expect(state.impactLayer.visible).toBe(false);
    expect(state.signLayer.visible).toBe(false);
    expect(state.wadeLevel).toBe(0);
    expect(state.wadeLayer).toEqual({ alpha: 0, visible: false });
    expect(trail.marks.some((mark) => mark.visible)).toBe(false);
    expect(trail.tails.size).toBe(0);
    expect(botRoot.destroy).toHaveBeenCalledWith({ children: true });
    expect(impactRoot.destroy).toHaveBeenCalledWith({ children: true });
  });
});
