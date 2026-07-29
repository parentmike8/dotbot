import type { Rect, Vec2 } from "@dotbot/game/types";

/**
 * How loudly a thing that happened at a world point reaches the player, 0 to 1.
 *
 * Every hit anywhere in the world used to play at full volume. In a 4200 x 3400
 * world with four regions and thirty-odd bots in them, that is a constant clatter
 * of fights you are nowhere near, and it is worse than noise: the one cue that
 * should mean "something is happening HERE" means nothing at all.
 *
 * Earshot is the union of two things, and it takes both because either alone is
 * wrong:
 *
 *  - WHAT YOU CAN SEE. If a fight is drawn on your screen you must hear it. A
 *    radius alone fails this on a wide monitor, where the screen is wider than any
 *    fixed number you would pick — which is why the view rect has to come from the
 *    live camera and not from a constant.
 *  - WHAT IS CLOSE. A fight ten units past the edge of the screen is still
 *    happening next to you, and going silent at the bezel would teach the player
 *    that the screen edge is a wall for sound. The radius covers that, and a view
 *    rect alone fails it.
 *
 * Inside earshot the result is a GAIN rather than a yes, because a boundary you
 * can hear is a boundary the player will find. Volume falls off with distance from
 * the listener, so what the cutoff removes is the tail of something already faint
 * rather than a sound at full strength.
 */

/** Within this, a hit is at full volume: it is happening on top of you. */
export const EARSHOT_FULL = 260;

/**
 * Audible regardless of what is on screen. Roughly two screens' worth of the
 * shortest phone viewport, so the off-screen allowance is generous on a phone and
 * irrelevant on a monitor — where the view rect is doing the work anyway.
 */
export const EARSHOT_RADIUS = 620;

/** The quietest an audible hit can be, at the very edge of earshot. */
export const EARSHOT_EDGE_GAIN = 0.3;

/**
 * How far sound carries for this listener: the fixed radius, widened to take in
 * the whole view whenever the point is on screen.
 *
 * Widening to the FARTHEST corner rather than to the nearest edge is what makes
 * "anything you can see, you can hear" a guarantee instead of an approximation.
 * The camera clamps to the sheet, so the player can sit well off centre — near the
 * map edge the far corner is most of the screen away, and a reach measured from
 * the centre would have gone silent on the half of the screen the player is not on.
 */
function reachFor(listener: Vec2, view: Rect | null): number {
  if (!view) return EARSHOT_RADIUS;
  let farthest = 0;
  for (const x of [view.x, view.x + view.w]) {
    for (const y of [view.y, view.y + view.h]) {
      farthest = Math.max(farthest, Math.hypot(x - listener.x, y - listener.y));
    }
  }
  return Math.max(EARSHOT_RADIUS, farthest);
}

function contains(view: Rect, at: Vec2): boolean {
  return at.x >= view.x && at.x <= view.x + view.w && at.y >= view.y && at.y <= view.y + view.h;
}

/**
 * The gain for a world sound, or 0 when it is out of earshot entirely.
 *
 * `view` is the world rectangle currently on screen, or null when nothing has been
 * drawn yet — in which case the radius alone decides, which is the conservative
 * answer for the frame before the first render.
 */
export function earshotGain(at: Vec2, listener: Vec2, view: Rect | null): number {
  const distance = Math.hypot(at.x - listener.x, at.y - listener.y);
  if (distance <= EARSHOT_FULL) return 1;

  const onScreen = view !== null && contains(view, at);
  const reach = onScreen ? reachFor(listener, view) : EARSHOT_RADIUS;
  if (distance >= reach) return onScreen ? EARSHOT_EDGE_GAIN : 0;

  const t = (distance - EARSHOT_FULL) / (reach - EARSHOT_FULL);
  return 1 + (EARSHOT_EDGE_GAIN - 1) * t;
}
