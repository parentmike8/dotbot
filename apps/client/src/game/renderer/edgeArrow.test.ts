import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "@dotbot/game/config";
import type { DotBotEntity } from "@dotbot/game/types";
import { ARROW_MARGIN, arrowTarget, edgeArrow, squadArrowTargets, type Camera } from "./edgeArrow";

/**
 * The edge arrow, pinned against the three faults play found in it.
 *
 * "Both my teammates are dead. Despite that, we have this blue arrow. As I move around,
 * the arrow shifts all the way around the entire exterior of the screen. It seems to
 * just be completely buggy."
 *
 * One symptom, three causes: a bearing measured from the player but drawn from the
 * viewport centre, an off-screen indicator that fired on screen, and no floor filter.
 */

const config = defaultGameConfig;

function bot(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id: "player",
    name: "You",
    squadId: "alpha",
    isAmbient: false,
    color: "#fff",
    position: { x: 1000, y: 1000 },
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
  bot({ id: "mate", state: "downed", shields: 0, shieldSegments: [0, 0, 0], ...overrides });

const viewport = { width: 800, height: 600 };

/** A camera looking straight at `at`, so that world point lands mid-frame. */
function lookingAt(at: { x: number; y: number }, scale = 1): Camera {
  return { x: viewport.width / 2 - at.x * scale, y: viewport.height / 2 - at.y * scale, scale };
}

describe("which body the arrow is for", () => {
  it("ignores a body on another floor", () => {
    /**
     * Every other signal in the renderer filters on the viewer's floor; this one did
     * not, so it would point at a body four storeys up — a direction that means
     * nothing, because walking that way does not get you there.
     */
    const viewer = bot();
    const upstairs = body({ position: { x: 1400, y: 1000 }, floorId: "civic:F4" });
    expect(arrowTarget([viewer, upstairs], viewer)).toBeNull();
    expect(arrowTarget([viewer, { ...upstairs, floorId: "outdoor" }], viewer)?.id).toBe("mate");
  });

  it("ignores the living, rivals, and the viewer", () => {
    const viewer = bot();
    const standing = bot({ id: "up", position: { x: 1400, y: 1000 } });
    const rival = body({ id: "rival", squadId: "rival-1", position: { x: 1400, y: 1000 } });
    expect(arrowTarget([viewer, standing, rival], viewer)).toBeNull();
    // A downed viewer is not their own rescue target.
    const downedViewer = bot({ state: "downed" });
    expect(arrowTarget([downedViewer], downedViewer)).toBeNull();
  });

  it("takes the nearest, and the same one whatever order they arrive in", () => {
    /**
     * `find` took whatever the snapshot listed first, so two bodies down made the arrow
     * flip between them as the server's order changed — the same flicker-on-ties the
     * sign reader and downed coverage each had to fix.
     */
    const viewer = bot();
    const near = body({ id: "near", position: { x: 1100, y: 1000 } });
    const far = body({ id: "far", position: { x: 1600, y: 1000 } });
    expect(arrowTarget([viewer, far, near], viewer)?.id).toBe("near");
    expect(arrowTarget([viewer, near, far], viewer)?.id).toBe("near");
    // Equidistant: lowest id, either way round.
    const west = body({ id: "a-west", position: { x: 900, y: 1000 } });
    const east = body({ id: "b-east", position: { x: 1100, y: 1000 } });
    expect(arrowTarget([viewer, west, east], viewer)?.id).toBe("a-west");
    expect(arrowTarget([viewer, east, west], viewer)?.id).toBe("a-west");
  });
});

describe("where the arrow goes", () => {
  it("says nothing at all while the body is on screen", () => {
    /**
     * The fault behind "shifts all the way around the entire exterior of the screen": a
     * mate face-down thirty units away still got a border arrow, and walking past them
     * swung the bearing through a half turn, so the arrow slid right around the frame.
     * You can see the body — it has its own art and its own progress ring.
     */
    const camera = lookingAt({ x: 1000, y: 1000 });
    expect(edgeArrow({ x: 1030, y: 1000 }, camera, viewport)).toBeNull();
    expect(edgeArrow({ x: 1000, y: 1000 }, camera, viewport)).toBeNull();
    // Just inside the margin is still on screen; just outside is not.
    const insideX = 1000 + (viewport.width / 2 - ARROW_MARGIN - 2);
    expect(edgeArrow({ x: insideX, y: 1000 }, camera, viewport)).toBeNull();
    expect(edgeArrow({ x: insideX + 4, y: 1000 }, camera, viewport)).not.toBeNull();
  });

  it("points at the body, measured through the camera and not the player", () => {
    /**
     * The camera eases toward the player and clamps at the sheet edges, so the player
     * is NOT reliably mid-frame. Here the view is looking 300 units west of the player
     * — as it is whenever the player walks into a map border — and a body due east of
     * the player is east on screen too. Measuring from the player put the arrow on the
     * wrong bearing exactly when it mattered.
     */
    const camera = lookingAt({ x: 700, y: 1000 });
    const arrow = edgeArrow({ x: 2000, y: 1000 }, camera, viewport)!;
    expect(arrow).not.toBeNull();
    expect(arrow.tip.x).toBeGreaterThan(viewport.width / 2);
    expect(arrow.tip.y).toBeCloseTo(viewport.height / 2, 6);

    // And the reverse: a body west of the view centre gives a west-pointing arrow.
    const west = edgeArrow({ x: -600, y: 1000 }, camera, viewport)!;
    expect(west.tip.x).toBeLessThan(viewport.width / 2);
  });

  it("keeps the tip on the frame, at every bearing", () => {
    // A marker that leaves the frame is not a marker. Swept rather than spot-checked,
    // because the failure this replaces was a bearing-dependent one.
    const camera = lookingAt({ x: 1000, y: 1000 });
    for (let degrees = 0; degrees < 360; degrees += 7) {
      const radians = (degrees * Math.PI) / 180;
      const target = { x: 1000 + Math.cos(radians) * 4000, y: 1000 + Math.sin(radians) * 4000 };
      const arrow = edgeArrow(target, camera, viewport)!;
      expect(arrow, `no arrow at ${degrees}deg`).not.toBeNull();
      expect(arrow.tip.x, `${degrees}deg off the west edge`).toBeGreaterThanOrEqual(-0.01);
      expect(arrow.tip.x, `${degrees}deg off the east edge`).toBeLessThanOrEqual(viewport.width + 0.01);
      expect(arrow.tip.y, `${degrees}deg off the north edge`).toBeGreaterThanOrEqual(-0.01);
      expect(arrow.tip.y, `${degrees}deg off the south edge`).toBeLessThanOrEqual(viewport.height + 0.01);
      // The tip leads: it is further from centre than either base corner.
      const away = (point: { x: number; y: number }) =>
        Math.hypot(point.x - viewport.width / 2, point.y - viewport.height / 2);
      expect(away(arrow.tip)).toBeGreaterThan(away(arrow.left));
      expect(away(arrow.tip)).toBeGreaterThan(away(arrow.right));
    }
  });

  it("holds its bearing while the camera pans, instead of sweeping the border", () => {
    /**
     * The reported symptom, as a measurement. Walking east past a fixed body far to the
     * north should barely move the arrow; the old code, drawing a player-relative
     * bearing from the frame centre, swung it across the whole top edge.
     */
    const body = { x: 1000, y: -2000 };
    const bearings = [0, 40, 80, 120].map((offset) => {
      const arrow = edgeArrow(body, lookingAt({ x: 1000 + offset, y: 1000 }), viewport)!;
      return Math.atan2(arrow.tip.y - viewport.height / 2, arrow.tip.x - viewport.width / 2);
    });
    const swing = Math.max(...bearings) - Math.min(...bearings);
    expect(swing, `arrow swung ${((swing * 180) / Math.PI).toFixed(1)} degrees over 120 units walked`)
      .toBeLessThan(0.05);
  });

  it("scales with the camera, so zoom does not move the body", () => {
    // The transform includes `scale`; ignoring it would put the arrow on a different
    // bearing at a different viewport size, which is how the on-screen test drifts.
    const target = { x: 1600, y: 1000 };
    const full = edgeArrow(target, lookingAt({ x: 1000, y: 1000 }, 1), viewport);
    const zoomedOut = edgeArrow(target, lookingAt({ x: 1000, y: 1000 }, 0.55), viewport);
    // At scale 1 the body is 600px away and off screen; at 0.55 it is 330px and on it.
    expect(full).not.toBeNull();
    expect(zoomedOut).toBeNull();
  });
});

describe("squadArrowTargets", () => {
  /**
   * Every squadmate, not just the downed one.
   *
   * `arrowTarget` answers a narrower question and keeps its own tests above. This exists
   * because one arrow for the nearest downed mate told you nothing about a squad spread
   * across a building until somebody went down — and "where is everyone" is the more common
   * question. Two facts, so both are returned and the caller draws them differently.
   */
  const viewer = { id: "me", squadId: "a", floorId: "outdoor", position: { x: 0, y: 0 } };
  const mate = (id: string, x: number, over: Partial<DotBotEntity> = {}) => ({
    id, squadId: "a", floorId: "outdoor", state: "alive", position: { x, y: 0 },
    ...over,
  } as DotBotEntity);

  it("returns alive squadmates as well as downed ones", () => {
    const found = squadArrowTargets([
      mate("alive", 100),
      mate("down", 200, { state: "downed" }),
    ], viewer);
    expect(found.map((entry) => entry.bot.id)).toEqual(["alive", "down"]);
    expect(found.map((entry) => entry.downed)).toEqual([false, true]);
  });

  it("never points at yourself, a rival, or another floor", () => {
    const found = squadArrowTargets([
      mate("me", 10),
      mate("rival", 20, { squadId: "b" }),
      mate("upstairs", 30, { floorId: "civic:F2" }),
      mate("keeper", 40),
    ], viewer);
    expect(found.map((entry) => entry.bot.id)).toEqual(["keeper"]);
  });

  it("orders nearest first, and breaks ties by id so it cannot flicker", () => {
    const found = squadArrowTargets([mate("far", 300), mate("b", 50), mate("a", 50)], viewer);
    expect(found.map((entry) => entry.bot.id)).toEqual(["a", "b", "far"]);
  });
});
