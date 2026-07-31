import { Container, Graphics } from "pixi.js";
import { rectsOverlap } from "@dotbot/game/geometry";
import { FLAT_KINDS, isSolidObject } from "@dotbot/game/mapModel";
import type { MapObject, ObjectKind, Rect, Vec2 } from "@dotbot/game/types";
import { drawModelObject } from "./modelGlyphs";
import { PARALLAX_HORIZON, pullToward, type ViewPull } from "./prism";
import { SHADOW_ALPHA, withViewPull, type ShadowPad } from "./tone";

/**
 * OBJECT PARALLAX: the visual/physics rule.
 *
 * The authored ground-contact footprint, contact/cast shadow, collider and passability
 * NEVER move. They are the promise that tells a player where cover begins and where a
 * full-size DotBot may stand.
 *
 * Only geometry above that footprint may react to the camera:
 *
 *  - a solid box keeps its outer edge planted and changes only the depth/direction of
 *    the top face inside it;
 *  - a tall cylinder may lean its lid while its shaded base stays at rest;
 *  - a tree crown, lamp arm/head or other explicitly lifted part moves on a separate
 *    elevated container while the trunk/post and its shadow stay put.
 *
 * Low solid cover is deliberately conservative. Crates, benches and walls may turn
 * enough to read, but never enough to make their contact edge ambiguous. Canopies,
 * lamp heads and tall landmarks carry more travel because their height is their
 * identity and their elevated silhouette is not a ground-level collider.
 *
 * This file owns redraws so interiors and outdoors cannot acquire different camera
 * laws. Geometry is rebuilt only after the renderer's camera threshold is crossed,
 * and outdoors are clipped to the visible bounds; scanning the handle map is cheap,
 * rebuilding hundreds of world objects is not.
 */

/**
 * Production camera response.
 *
 * Full strength is intentionally kept as a lab setting: at 1, a tall object's top can
 * rotate all the way from the fixed north view to camera-relative at the edge of play,
 * which makes buildings and carved landmarks visibly change identity while walking past.
 * A quarter-strength response preserves a small depth cue without making planted geometry
 * look elastic.
 */
export const DEFAULT_OBJECT_PARALLAX_STRENGTH = 0.25;
export const MAX_OBJECT_PARALLAX_STRENGTH = 2;
/** Shared live-game/Studio camera movement threshold for object redraws. */
export const OBJECT_PARALLAX_REDRAW_STEP = 24;

/** Parse the shared game/lab URL control without collapsing every useful value to one. */
export function parseObjectParallaxStrength(search: string): number {
  const asked = new URLSearchParams(search).get("parallax");
  if (asked === null) return DEFAULT_OBJECT_PARALLAX_STRENGTH;
  const value = Number(asked);
  if (!Number.isFinite(value)) return DEFAULT_OBJECT_PARALLAX_STRENGTH;
  return Math.max(0, Math.min(MAX_OBJECT_PARALLAX_STRENGTH, value));
}

export type ParallaxObjectView = {
  object: MapObject;
  /** Planted object geometry. Its display transform is never used for parallax. */
  view: Graphics;
  /** Explicitly elevated parts, transformed as one authored object. */
  elevated: Container;
};

type ObjectParallaxProfile = {
  /** Share of the shared camera-angle response this object is allowed to use. */
  directionGain: number;
  /** Extra top-face travel, as a fraction of the primitive's authored lift. */
  faceGain: number;
  /** Maximum additional travel of an explicitly elevated group, in world units. */
  elevatedTravel: number;
};

const TALL_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "waterTank",
  "coalingTower",
  "swingRide",
  "helterSkelter",
  "bigTop",
  "stele",
  "signalMast",
  "listeningPost",
  "column",
]);

function objectParallaxProfile(object: MapObject): ObjectParallaxProfile {
  if (FLAT_KINDS.has(object.kind) || !isSolidObject(object)) {
    return { directionGain: 0, faceGain: 0, elevatedTravel: 0 };
  }
  if (object.kind === "serpentHead") {
    /**
     * A low carved wedge planted against the temple stair, not an elevated landmark.
     *
     * Rotating its prism changed which triangular face formed the snout, so the bottom
     * visibly changed shape as the player crossed the plaza. Its authored north-lit view
     * is the carving's identity and must remain stable.
     */
    return { directionGain: 0, faceGain: 0, elevatedTravel: 0 };
  }

  const short = Math.min(object.w, object.h);
  if (object.kind === "tree") {
    return {
      directionGain: 1,
      // The trunk stays conservative; the crown below carries the tree's height.
      faceGain: 0.18,
      elevatedTravel: Math.max(5, Math.min(14, short * 0.12)),
    };
  }
  if (object.kind === "lampPost") {
    return {
      directionGain: 1,
      faceGain: 0.16,
      elevatedTravel: Math.max(7, Math.min(11, short * 0.7)),
    };
  }
  if (TALL_KINDS.has(object.kind)) {
    return {
      directionGain: 1,
      faceGain: 0.82,
      elevatedTravel: Math.max(4, Math.min(12, short * 0.08)),
    };
  }
  return {
    directionGain: 1,
    faceGain: 0.3,
    // Rides and any future reparented part stay attached, but low cover never gains
    // a large floating top merely because its glyph happens to own a child.
    elevatedTravel: Math.max(2, Math.min(6, short * 0.05)),
  };
}

/** The shared interior/outdoor face pull for one authored object. */
export function objectViewPull(
  object: MapObject,
  viewCentre: Vec2,
  strength: number,
): ViewPull {
  const centre = { x: object.x + object.w / 2, y: object.y + object.h / 2 };
  const profile = objectParallaxProfile(object);
  return pullToward(centre, viewCentre, strength * profile.directionGain, profile.faceGain);
}

const SCRATCH_PAD: ShadowPad = SHADOW_ALPHA.map(() => new Graphics());

/** Rebuild one planted view without ever touching its real ground shadow pad. */
export function redrawParallaxObject(
  handle: ParallaxObjectView,
  viewCentre: Vec2,
  strength: number,
): boolean {
  const profile = objectParallaxProfile(handle.object);
  if (profile.directionGain <= 0 && profile.elevatedTravel <= 0) return false;

  const centre = {
    x: handle.object.x + handle.object.w / 2,
    y: handle.object.y + handle.object.h / 2,
  };
  const pull = objectViewPull(handle.object, viewCentre, strength);
  for (const layer of SCRATCH_PAD) layer.clear();
  handle.view.clear();
  withViewPull(pull, () => drawModelObject(handle.view, SCRATCH_PAD, handle.object));

  const dx = centre.x - viewCentre.x;
  const dy = centre.y - viewCentre.y;
  const distance = Math.hypot(dx, dy);
  const distanceShare = Math.min(1, distance / PARALLAX_HORIZON);
  const travel = profile.elevatedTravel * distanceShare * Math.max(0, strength);
  if (distance > 1e-6 && handle.elevated.children.length > 0) {
    handle.elevated.position.set((dx / distance) * travel, (dy / distance) * travel);
  } else {
    handle.elevated.position.set(0, 0);
  }
  return true;
}

export type ParallaxRedrawStats = {
  total: number;
  considered: number;
  redrawn: number;
  durationMs: number;
};

const VISIBLE_MARGIN = 96;

/**
 * Redraw only outdoor objects whose authored bounds can contribute to this frame.
 *
 * The margin covers elevated overhangs and the 24-unit camera step. A map-sized scan is
 * still only a few hundred rectangle checks; the expensive operation is Graphics
 * tessellation, and this keeps that operation proportional to what is on screen.
 */
export function redrawOutdoorObjects(
  objectViews: Map<string, ParallaxObjectView>,
  viewCentre: Vec2,
  strength: number,
  visibleBounds: Rect,
): ParallaxRedrawStats {
  const started = performance.now();
  let considered = 0;
  let redrawn = 0;
  if (strength <= 0) {
    return { total: objectViews.size, considered, redrawn, durationMs: performance.now() - started };
  }

  const visible = {
    x: visibleBounds.x - VISIBLE_MARGIN,
    y: visibleBounds.y - VISIBLE_MARGIN,
    w: visibleBounds.w + VISIBLE_MARGIN * 2,
    h: visibleBounds.h + VISIBLE_MARGIN * 2,
  };
  for (const handle of objectViews.values()) {
    if (!rectsOverlap(handle.object, visible)) continue;
    considered += 1;
    if (redrawParallaxObject(handle, viewCentre, strength)) redrawn += 1;
  }
  return {
    total: objectViews.size,
    considered,
    redrawn,
    durationMs: performance.now() - started,
  };
}
