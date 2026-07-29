import type { DotBotEntity, Vec2 } from "@dotbot/game/types";

/**
 * The screen-edge arrow toward a downed squadmate, as geometry.
 *
 * Pulled out of `GameRenderer` so it can be measured: the renderer builds pixi
 * Containers, so a test that imports it wants a DOM, and this is exactly the code that
 * needed a test. Play reported the version that had none — "both my teammates are dead.
 * Despite that, we have this blue arrow... as I move around, the arrow shifts all the
 * way around the entire exterior of the screen. It seems to just be completely buggy."
 *
 * Three faults with one shape, and each is a rule below:
 *
 * 1. It measured the bearing from the PLAYER and drew it from the VIEWPORT CENTRE.
 *    Those are different places — the camera eases toward the player and clamps at the
 *    sheet edges — so near a map border the arrow pointed where the body was not.
 * 2. It drew whether or not the body was on screen, so a mate face-down thirty units
 *    away got a border arrow, and walking past them swung it right around the frame.
 * 3. It ignored the floor, and would point at a body four storeys up.
 */

/** The world-to-screen transform the world layer is drawn with. */
export type Camera = { x: number; y: number; scale: number };
export type Viewport = { width: number; height: number };

/** How close to the frame edge still counts as off screen, and where the tip sits. */
export const ARROW_MARGIN = 32;
const ARROW_LENGTH = 18;
const ARROW_HALF_WIDTH = 8;

/**
 * The body this arrow is for: nearest, ties broken on id.
 *
 * The original took whatever the snapshot listed first, so with two mates down the
 * arrow flipped between them as the server's order changed — the same flicker-on-ties
 * that the sign reader and downed coverage each had to fix.
 */
export function arrowTarget(
  bots: readonly DotBotEntity[],
  viewer: Pick<DotBotEntity, "id" | "squadId" | "floorId" | "position">,
): DotBotEntity | null {
  let best: DotBotEntity | null = null;
  let bestAway = Number.POSITIVE_INFINITY;
  for (const bot of bots) {
    if (bot.id === viewer.id || bot.squadId !== viewer.squadId) continue;
    if (bot.state !== "downed" || bot.floorId !== viewer.floorId) continue;
    const away = Math.hypot(bot.position.x - viewer.position.x, bot.position.y - viewer.position.y);
    if (away < bestAway || (away === bestAway && best !== null && bot.id < best.id)) {
      best = bot;
      bestAway = away;
    }
  }
  return best;
}

/**
 * Every squadmate worth an arrow, nearest first, tagged by whether they are down.
 *
 * `arrowTarget` answers a narrower question — the single nearest DOWNED mate — and stays for
 * the callers that want exactly that. This one exists because "Teammate arrows should show
 * when teammates are out of view. They should also be different for downed teammates that
 * need reviving": two facts, so two glyphs, so the drawing needs the whole set and the flag
 * rather than one bot.
 *
 * Off-view filtering is not done here on purpose. `edgeArrow` already returns null for
 * anything on screen, so asking twice would be two places that must agree about what "off
 * screen" means.
 */
export function squadArrowTargets(
  bots: readonly DotBotEntity[],
  viewer: Pick<DotBotEntity, "id" | "squadId" | "floorId" | "position">,
): Array<{ bot: DotBotEntity; downed: boolean }> {
  return bots
    .filter((bot) => bot.id !== viewer.id && bot.squadId === viewer.squadId && bot.floorId === viewer.floorId)
    .map((bot) => ({ bot, downed: bot.state === "downed" }))
    .sort((a, b) => {
      const away = (entry: { bot: DotBotEntity }) => Math.hypot(
        entry.bot.position.x - viewer.position.x,
        entry.bot.position.y - viewer.position.y,
      );
      return away(a) - away(b) || (a.bot.id < b.bot.id ? -1 : 1);
    });
}

export type Arrow = { tip: Vec2; left: Vec2; right: Vec2 };

/**
 * Where to draw the arrow, or null when there is nothing to say.
 *
 * Null means the body is on screen: you can see it, and it has its own art and its own
 * progress ring, so an edge marker would only pull the eye away from the thing it is
 * pointing at.
 */
export function edgeArrow(
  target: Vec2,
  camera: Camera,
  viewport: Viewport,
  margin = ARROW_MARGIN,
): Arrow | null {
  const at = { x: target.x * camera.scale + camera.x, y: target.y * camera.scale + camera.y };
  if (
    at.x >= margin && at.x <= viewport.width - margin &&
    at.y >= margin && at.y <= viewport.height - margin
  ) return null;

  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  const dx = at.x - center.x;
  const dy = at.y - center.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const halfWidth = Math.max(18, center.x - margin);
  const halfHeight = Math.max(18, center.y - margin);
  const edgeScale = Math.min(
    Math.abs(ux) > 0.001 ? halfWidth / Math.abs(ux) : Number.POSITIVE_INFINITY,
    Math.abs(uy) > 0.001 ? halfHeight / Math.abs(uy) : Number.POSITIVE_INFINITY,
  );
  const tip = { x: center.x + ux * edgeScale, y: center.y + uy * edgeScale };
  const base = { x: tip.x - ux * ARROW_LENGTH, y: tip.y - uy * ARROW_LENGTH };
  return {
    tip,
    left: { x: base.x - uy * ARROW_HALF_WIDTH, y: base.y + ux * ARROW_HALF_WIDTH },
    right: { x: base.x + uy * ARROW_HALF_WIDTH, y: base.y - ux * ARROW_HALF_WIDTH },
  };
}
