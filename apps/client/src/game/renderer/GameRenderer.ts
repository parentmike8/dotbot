import { Application, Container, FillGradient, Graphics, Text } from "pixi.js";
import { clamp, clamp01, colorToNumber, normalize } from "@dotbot/game/math";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  doorEntityCollisionRect,
  floorPlanById,
  isGroundFloor,
  physicsFloorId,
  resolvePlan,
} from "@dotbot/game/mapModel";
import { rectsOverlap } from "@dotbot/game/geometry";
import { buildingMouths } from "@dotbot/game/entrances";
import {
  hasLineOfSight, outdoorVision, seesOutdoors, visibilityPolygon, visionContext,
} from "@dotbot/game/visibility";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import type { DotBotEntity, GameSnapshot, HitResult, Item, MapDocument, Rect, SimEvent, Vec2 } from "@dotbot/game/types";
import type { MatchIntel } from "@dotbot/protocol";
import { CORE_REACH } from "@dotbot/game/shields";
import type { PredictedImpact } from "../session/GameSession";
import { buildMapArt, makeWorldLabel, type MapArt } from "./mapArt";
import { CAPTION } from "./worldCaption";
import { signReadingAt, signsOnFloor } from "@dotbot/game/signs";
import { roofParallax } from "./model/modelRoof";
import {
  applyPredictedImpactOverlays,
  classifyPredictedImpact,
  impactReactionForTarget,
  predictedImpactDirection,
  type QueuedPredictedImpact,
} from "./impactPrediction";
import { drawDotDisc, drawDotGloss, drawDotMark } from "./dotArt";
import { edgeArrow, squadArrowTargets, type Camera } from "./edgeArrow";
import { drawGroundShadow, drawWaterline } from "./grounding";
import { markAge, type LiveMark } from "../pings";
import {
  drawBareEdges,
  drawBodyOutline,
  drawChargedCore,
  drawDashRing,
  drawDownedBody,
  drawInvulnerabilityRing,
  drawPlates,
} from "./bodies";
import { DOT_COLOR, INK, RIVAL_RED, SQUAD_CYAN, WEIGHT } from "./style";
import { visibilityFogStyle } from "./visibilityStyle";
import { redrawFloorObjects } from "./model/modelFloor";
import { animateAmbient, driftLeaves, fadeTrail, stampTrail, trailStep } from "./model/modelMotion";
import { driftWater } from "./model/modelWater";
import { GRD } from "./model/modelGround";
import { isInWater } from "@dotbot/game/water";
import { groundAt, isSoftGround } from "@dotbot/game/ground";

const AMBIENT_GREY = 0x868e96;

/**
 * How close to a doorway before a building starts showing you its inside.
 *
 * Shorter than `OUTDOOR_SIGHT` on purpose: sight through a door reaches further than the
 * roof lifts, so at a distance you get a bright wedge of floor through the opening and the
 * building still reads as a solid mass. Walking in is what dissolves the lid.
 */
const PEEK_RANGE = 200;

/**
 * How far the camera must travel before the active floor's objects are rebuilt.
 *
 * Object parallax changes the SHAPE of a top face, so it cannot ride a container
 * transform the way a building's mass does — it is a redraw. A camera creeping a unit at
 * a time turns no object's pull by anything an eye can see, so this is what keeps the
 * rebuild off the frames that would gain nothing from it.
 */
const PARALLAX_REDRAW_STEP = 24;

/**
 * How strongly an object's top turns toward the camera. `0` is off, `1` is fully
 * away-from-camera at the horizon.
 *
 * DEFAULT ZERO, deliberately, and not because the plumbing is unfinished — it is tested
 * and measured. It is off because one drawing question is still open and it cannot be
 * settled from a test.
 *
 * `volume` fills a rectangle's whole footprint with `mat.front` and then paints the top
 * face over it, so whichever band is left exposed comes out in the SOUTH face's tone
 * regardless of which side it is on. Turn the pull far enough and an object at the edge
 * of view shows a dark band on its north side — a shadow on the lit side, which is
 * wrong. `volumeShape` does not have the problem: it shades each face by its own normal.
 *
 * Making them agree means giving `volume` per-band shading, and the two primitives
 * currently disagree about the south face already (`mat.front` is `shade(top, 0.68)`;
 * `faceLight` south is `shade(top, 0.537)`), so reconciling them changes the tone of
 * every box in the game. That is a decision about the drawing language, not about
 * parallax, and it wants somebody looking at it.
 *
 * Until then: `?parallax=0.5` turns it on for a look without shipping it to anyone.
 */
const PARALLAX_STRENGTH = (() => {
  if (typeof window === "undefined") return 0;
  const asked = new URLSearchParams(window.location.search).get("parallax");
  const value = asked === null ? Number.NaN : Number(asked);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
})();

export type InteractionChannelVisual = {
  position: Vec2;
  radius: number;
  progress: number;
};

type DraftAnimation = {
  /** The area being built across, in world units. */
  bounds: { x: number; y: number; w: number; h: number };
  /** The production view itself, revealed through `mask`. */
  view: Container;
  mask: Graphics;
  /** The deposition front: a bright line at the leading edge of the reveal. */
  front: Graphics;
  startedAt: number;
  durationMs: number;
};

type BotView = {
  root: Container;
  body: Graphics;
  progress: Graphics;
  signature: string;
  lastPosition: Vec2 | null;
  displayPosition: Vec2 | null;
  lastDisplayAt: number;
  movingUntil: number;
  /** Longest cooldown seen on this bot — the gauge's full mark. */
  dashPeakMs: number;
};

type ImpactView = {
  root: Container;
  burst: Graphics;
  pulse: Graphics;
};


/**
 * Ease a view toward where its bot actually is.
 *
 * Idempotent within a frame on purpose: a second call with the same `now` sees
 * zero elapsed time and moves nothing. That is what lets the line-of-sight wash
 * ask for the viewer's eased position *before* the bodies are drawn, and get the
 * same answer the body will be drawn at, without the easing running twice.
 *
 * Applies to the viewer too. Drawing your own bot raw was tried, on the grounds
 * that a predicted position is already smooth — it is not, and the whole game
 * went jittery. Prediction lands on a tick boundary and is then nudged by a
 * reconciliation offset; this filter is what was absorbing both.
 */
function advanceDisplayPosition(view: BotView, target: Vec2, now: number): Vec2 {
  if (!view.displayPosition || Math.hypot(
    target.x - view.displayPosition.x,
    target.y - view.displayPosition.y,
  ) > 120) {
    view.displayPosition = { ...target };
  } else {
    const elapsed = Math.max(0, Math.min(50, now - view.lastDisplayAt));
    const smoothing = 1 - Math.exp(-elapsed / 34);
    view.displayPosition.x += (target.x - view.displayPosition.x) * smoothing;
    view.displayPosition.y += (target.y - view.displayPosition.y) * smoothing;
  }
  view.lastDisplayAt = now;
  return view.displayPosition;
}

/**
 * The live-game renderer: static map art (from mapArt.ts, shared with Map
 * Studio) plus the gameplay overlay — bots, dots, rings, noise, fog, and the
 * per-floor visibility model. The base map must stand on its own; everything
 * in this file draws *over* it and can be disabled without leaving holes.
 */
export class GameRenderer {
  private readonly app: Application;
  private readonly worldLayer = new Container();
  /** The camera as of the last drawn frame, so a click can be un-projected. */
  private lastCamera: Camera = { x: 0, y: 0, scale: 1 };
  /** Squad marks, held by the client — see game/pings.ts for why they are not sim state. */
  private squadMarks: readonly LiveMark[] = [];
  private readonly art: MapArt;
  /** Faint wash over everything outside the player's line of sight. */
  private readonly fogGfx = new Graphics();
  /** Matching wash clipped to tall foreground sprite pixels. */
  private readonly foregroundFogGfx = new Graphics();
  /** Entities subject to line-of-sight: enemies, dots, their rings. */
  private readonly maskedLayer = new Container();
  private readonly maskedGfx = new Graphics();
  private readonly maskedBotsLayer = new Container();
  private readonly visionMaskGfx = new Graphics();
  /** Always-visible layer: player, squad, noise rings, extraction pulse. */
  private readonly dynamicGfx = new Graphics();
  private readonly dynamicBotsLayer = new Container();
  private readonly impactLayer = new Container();
  /**
   * What the sign nearest the viewer says, drawn in the world.
   *
   * In `worldLayer`, not on the screen: the contract's objection to UI is that it is
   * not part of the place. Stair and interaction tags are world text at world scale,
   * and location names now exist only through these physical signs. A sign that
   * answered in a screen-space bubble would be the only floating panel in the world.
   */
  private readonly signLayer = new Container();
  private readonly signTitle: Text;
  private readonly signDetail: Text;
  /** Viewport-space markers that must remain legible beyond the camera. */
  private readonly screenGfx = new Graphics();
  /**
   * The wash over the whole view while the viewer is standing in water.
   *
   * Its own layer under `screenGfx`, so it can never come between the player and an edge
   * arrow — those point at a squadmate off screen and are the one screen-space mark that
   * must survive anything drawn over the world.
   *
   * Both children are built ONCE per viewport size and only their container's alpha moves,
   * because the vignette is a gradient and building a gradient allocates a texture. A
   * per-frame `new FillGradient` would have been a texture upload every frame for an effect
   * whose only variable is how strong it is.
   */
  private readonly wadeLayer = new Container();
  private readonly wadeTint = new Graphics();
  private readonly wadeVignette = new Graphics();
  private wadeLevel = 0;
  private wadeBuiltFor = "";
  private lastWadeAt = performance.now();

  private map: MapDocument;
  private viewport = { width: 1, height: 1 };
  private destroyed = false;
  private lastViewer: DotBotEntity | null = null;
  private lastTimeMs = 0;
  private cameraCenter: Vec2 | null = null;
  private lastCameraTarget: Vec2 | null = null;
  private cameraVelocity: Vec2 = { x: 0, y: 0 };
  private cameraImpulse: Vec2 = { x: 0, y: 0 };
  /** Where the camera was when the active floor's objects were last rebuilt. */
  private lastParallaxCentre: Vec2 = { x: Number.NaN, y: Number.NaN };
  private lastParallaxFloorId: string | undefined = undefined;
  private lastCameraAt = performance.now();
  private reducedMotion = false;
  private readonly pleaSignals = new Map<string, { event: Extract<SimEvent, { type: "plea" }>; startedAt: number }>();
  private readonly mineSignals = new Map<string, { event: Extract<SimEvent, { type: "mineSensor" }>; startedAt: number }>();
  private readonly impactFlashes: QueuedPredictedImpact[] = [];
  private readonly botViews = new Map<string, BotView>();
  /** Where each bot last put a trail mark down. See `trailStep`. */
  private readonly trailAnchors = new Map<string, Vec2>();
  private readonly impactViews = new Map<string, ImpactView>();
  private readonly draftAnimations = new Map<string, DraftAnimation>();

  private constructor(app: Application, map: MapDocument) {
    this.app = app;
    this.map = map;
    this.art = buildMapArt(map);
    /**
     * Structural ink, not label ink.
     *
     * The old footprint captions used `INK.fixture`, tuned for a name lying over
     * paper-white slab at map scale. A sign is read at play zoom, standing on a
     * mid-grey footway, and play could not read it at all: "FYI can't read the text
     * here." The detail line under it was legible in `INK.opening`, which is the clue
     * — go darker, not bigger.
     */
    this.signTitle = makeWorldLabel(CAPTION.signTitle);
    this.signDetail = makeWorldLabel(CAPTION.signDetail);
    this.signLayer.addChild(this.signTitle, this.signDetail);
    this.signLayer.visible = false;
    this.wadeLayer.addChild(this.wadeTint, this.wadeVignette);
    this.wadeLayer.alpha = 0;
    this.app.stage.addChild(this.worldLayer, this.wadeLayer, this.screenGfx);
    this.maskedBotsLayer.sortableChildren = true;
    this.dynamicBotsLayer.sortableChildren = true;
    this.maskedLayer.addChild(this.maskedGfx, this.maskedBotsLayer, this.visionMaskGfx);
    this.maskedLayer.mask = this.visionMaskGfx;
    this.foregroundFogGfx.mask = this.art.foreground;
    /**
     * Only `art.foreground` draws above the bots, and a stair is never in it.
     *
     * Every stair run lives in its floor's own view, inside `art.root` — the first
     * child here, under both bot layers — so a body crossing one is always whole.
     *
     * The far half of the flight used to be redrawn into a layer above the bots so a
     * body crossing the break line passed *under* the treads beyond it: descending
     * into the shaft rather than sliding across a picture of one. Play read it as
     * damage, not depth — "it feels like there's a smoother transition where we see
     * the dotbot entirely as it passes over the stairs without the 'half-half'
     * approach we have today... there's no 'cover' on top of the dotbot."
     *
     * The floor swap at the midline is the whole event, and the tread ramp behind the
     * bot already says which way it went. Cutting a body in half to repeat that costs
     * more than it buys, so nothing on a stair goes above this line again.
     */
    this.worldLayer.addChild(
      this.art.root,
      this.fogGfx,
      this.maskedLayer,
      this.dynamicGfx,
      this.dynamicBotsLayer,
      this.impactLayer,
      this.signLayer,
      // Above the bots: canopies, trunks, leaves. See `MapArt.overhead` — and note that
      // `art.foreground` below is the fog MASK, which pixi consumes rather than draws, so art
      // parented there is invisible.
      this.art.overhead,
      this.art.foreground,
      this.foregroundFogGfx,
    );
  }

  static async create(host: HTMLElement, map: MapDocument): Promise<GameRenderer> {
    const app = new Application();

    await app.init({
      antialias: true,
      autoStart: false,
      autoDensity: true,
      background: "#ffffff",
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });

    host.appendChild(app.canvas);
    const renderer = new GameRenderer(app, map);
    renderer.resize(host.clientWidth, host.clientHeight);
    app.render();
    return renderer;
  }

  resize(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    try {
      this.app.destroy({ removeView: true }, { children: true });
    } catch {
      // Pixi's resize plugin may already be torn down during React Fast
      // Refresh. Never let cosmetic cleanup take down the app tree.
      try {
        this.app.canvas?.remove();
      } catch {
        // The renderer may already have nulled its canvas reference.
      }
    }
  }

  /**
   * Fabrication reveal: M5 placement and M6 output call this.
   *
   * The object builds up across its own footprint behind a bright deposition
   * front, the way the fabricator that made it works. This masks the *production*
   * view rather than drawing a stand-in over it, which is the whole trick: the
   * previous version hid the real glyph and animated a hand-decomposed copy, so
   * every object kind needed a second drawing routine that agreed with the first,
   * and any glyph without one simply failed to animate.
   */
  draftObject(objectId: string, durationMs = 1200): boolean {
    const floors = this.art.buildings.flatMap((building) => building.floors);
    const floor = floors.find((candidate) => candidate.objectViews.has(objectId));
    const entry = floor?.objectViews.get(objectId);
    const stairFloor = entry ? undefined : floors.find((candidate) => candidate.stairViews.has(objectId));
    const stairEntry = stairFloor?.stairViews.get(objectId);
    const targetFloor = floor ?? stairFloor;
    if (!targetFloor || (!entry && !stairEntry)) return false;
    this.finishDraft(objectId);

    const object = entry?.object;
    const bounds = object
      ? { x: object.x, y: object.y, w: object.w, h: object.h }
      : { ...stairEntry!.stair.rect };
    const view: Container = entry?.view ?? stairEntry!.view;

    const mask = new Graphics();
    const front = new Graphics();
    view.mask = mask;
    targetFloor.furniture.addChild(mask, front);
    this.draftAnimations.set(objectId, {
      bounds, view, mask, front, startedAt: performance.now(), durationMs,
    });
    return true;
  }

  queuePlea(event: Extract<SimEvent, { type: "plea" }>): void {
    this.pleaSignals.set(event.botId, { event, startedAt: this.lastTimeMs });
  }

  /** Instant impact response at predicted dash contact. Returns the predicted
   * outcome so audio/haptics can use the same classification as the shield. */
  queueImpact(impact: PredictedImpact, snapshot: GameSnapshot): HitResult | null {
    const result = classifyPredictedImpact(snapshot, impact);
    const direction = predictedImpactDirection(snapshot, impact);
    this.impactFlashes.push({ ...impact, result, direction, startedAt: performance.now() });
    this.addCameraImpulse(
      direction,
      impact.kind === "clash" ? 5 : impact.kind === "bump" ? 2.5 : result === "downed" ? 5 : 3.5,
    );
    return impact.kind === "hit" ? result : null;
  }

  /** Locks an authoritative result onto its existing predicted presentation.
   * A late acknowledgement never restarts the effect; hits without a local
   * prediction (local mode, another player, or the viewer being struck) start
   * exactly once from the server event. */
  confirmImpact(
    event: Extract<SimEvent, { type: "hit" }>,
    snapshot: GameSnapshot,
    viewerId: string,
  ): boolean {
    const now = performance.now();
    const match = [...this.impactFlashes].reverse().find((impact) =>
      impact.kind === "hit"
        && impact.targetId === event.botId
        && impact.sourceId === event.byBotId
        && impact.confirmedAt === undefined
        && now - impact.startedAt <= 800);
    const target = snapshot.bots.find((bot) => bot.id === event.botId);
    const source = snapshot.bots.find((bot) => bot.id === event.byBotId);
    const fallbackDirection = target && source
      ? normalize({ x: target.position.x - source.position.x, y: target.position.y - source.position.y })
      : { x: 0, y: 0 };
    const direction = Math.hypot(event.direction.x, event.direction.y) > 0.001
      ? normalize(event.direction)
      : fallbackDirection;
    const eventHasWorldPoint = event.tick > 0 || event.position.x !== 0 || event.position.y !== 0;
    const position = eventHasWorldPoint
      ? event.position
      : target
        ? { x: target.position.x - direction.x * target.radius, y: target.position.y - direction.y * target.radius }
        : { x: 0, y: 0 };

    if (match) {
      match.confirmedAt = now;
      match.result = event.result;
      match.direction = direction;
      return true;
    }

    this.impactFlashes.push({
      x: position.x,
      y: position.y,
      targetId: event.botId,
      sourceId: event.byBotId,
      predictionId: `authoritative-${event.tick}-${event.byBotId}-${event.botId}-${now}`,
      predictedAtMs: now,
      kind: "hit",
      result: event.result,
      direction,
      startedAt: now,
      confirmedAt: now,
    });
    if (event.byBotId === viewerId || event.botId === viewerId) {
      this.addCameraImpulse(direction, event.result === "downed" ? 5.5 : 3.5);
    }
    return false;
  }

  queueDashContact(event: Extract<SimEvent, { type: "dashContact" }>, viewerId: string): boolean {
    const now = performance.now();
    const match = [...this.impactFlashes].reverse().find((impact) =>
      impact.kind === event.result
        && (
          (impact.targetId === event.botId && impact.sourceId === event.byBotId)
          || (impact.targetId === event.byBotId && impact.sourceId === event.botId)
        )
        && impact.confirmedAt === undefined
        && now - impact.startedAt <= 800);
    if (match) {
      match.confirmedAt = now;
      match.direction = event.direction;
      return true;
    }

    this.impactFlashes.push({
      x: event.position.x,
      y: event.position.y,
      targetId: event.botId,
      sourceId: event.byBotId,
      predictionId: `dash-contact-${event.tick}-${event.byBotId}-${event.botId}-${now}`,
      predictedAtMs: now,
      kind: event.result,
      result: "plateBreak",
      direction: event.direction,
      startedAt: now,
      confirmedAt: now,
    });
    if (event.byBotId === viewerId || event.botId === viewerId) {
      this.addCameraImpulse(event.direction, event.result === "clash" ? 5 : 2.5);
    }
    return false;
  }

  queueMineSensor(event: Extract<SimEvent, { type: "mineSensor" }>): void {
    this.mineSignals.set(event.mineId, { event, startedAt: this.lastTimeMs });
  }

  render(snapshot: GameSnapshot, playerId: string, preserveMissingViewer = false, interactionChannel: InteractionChannelVisual | null = null, intel?: MatchIntel): number {
    const nowMs = performance.now();
    snapshot = applyPredictedImpactOverlays(snapshot, this.impactFlashes, nowMs);
    this.lastTimeMs = snapshot.timeMs;
    this.updateDraftAnimations(nowMs);
    const overview = preserveMissingViewer;
    const currentPlayer = overview ? undefined : snapshot.bots.find((bot) => bot.id === playerId);
    const player = overview ? undefined : currentPlayer ?? snapshot.bots[0];
    if (currentPlayer) this.lastViewer = currentPlayer;
    const center = player?.position ?? { x: this.map.width / 2, y: this.map.height / 2 };
    const camera = this.getCamera(center, (player?.dashActiveMs ?? 0) > 0);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);
    this.lastCamera = camera;
    this.updateRoofParallax(camera.center, player?.floorId);
    this.updateObjectParallax(camera.center, player?.floorId);
    // Ambient, cosmetic, off the client clock: see `modelWater`. One transform per layer
    // per body, nothing redrawn — the same shape as the parallax passes above it.
    driftWater(this.art.water, nowMs, this.reducedMotion);
    // The rest of the world's ambient motion — turning rides, swaying canopies — on the
    // same clock and the same contract: one transform per part, nothing redrawn.
    animateAmbient(this.art.movers, nowMs, this.reducedMotion);
    // Leaves spawn only off canopies the player can actually see — the same visible-bounds
    // answer audio earshot uses, for the same reason: forty-eight leaves spread over a
    // 4,200-unit sheet is none of them on screen.
    driftLeaves(this.art.leaves, this.art.movers, nowMs, this.visibleWorldBounds(), this.reducedMotion);
    this.updateWading(player ?? null, nowMs);

    const playerContext = player ? this.contextKey(player.floorId, player.position) : "outdoor:street";
    this.updateVisibility(player ?? null, playerContext);
    this.updateLineOfSight(snapshot, player ?? null, playerContext);
    this.updateSignReading(player ?? null);

    this.maskedGfx.clear();
    this.dynamicGfx.clear();
    this.screenGfx.clear();
    this.drawExtractionPulse(snapshot, player?.squadId);
    this.drawDots(snapshot, player?.squadId, playerContext);
    this.drawMines(snapshot, playerContext);
    this.drawSignalIntel(snapshot, intel, playerContext);
    this.drawBots(snapshot, playerId, playerContext);
    // AFTER the bots, not with the other ambient passes above, and for one concrete reason:
    // `drawBots` is what advances each bot's smoothed display position, and a mark has to land
    // under the body where it is actually drawn rather than a frame behind it.
    this.updateTrails(snapshot, player ?? null, playerContext, nowMs);
    if (interactionChannel) {
      this.drawProgressRing(this.dynamicGfx, interactionChannel.position, interactionChannel.radius, interactionChannel.progress, INK.opening, 3);
    }
    if (currentPlayer) this.drawRadarPings(currentPlayer);

    if (player) {
      this.drawNoises(snapshot, player);
      this.drawPleaSignals(player);
      this.drawMineSignals(player);
      this.drawSquadMarks(player, nowMs, camera);
      this.drawSquadmateArrows(snapshot, player, camera);
    }
    this.drawImpactFlashes(snapshot, nowMs);

    // The Application ticker is intentionally disabled: scene mutation and
    // GPU submission happen in this one ordered frame, never a refresh apart.
    this.app.render();
    return performance.now();
  }

  private drawSignalIntel(snapshot: GameSnapshot, intel: MatchIntel | undefined, playerContext: string): void {
    const signal = intel?.signal;
    if (!signal || snapshot.debug.tickCount >= signal.expiresAtTick) return;
    if (this.contextKey(signal.floorId, signal.position) !== playerContext) return;
    const dot = snapshot.dots.find((candidate) => candidate.id === signal.dotId);
    if (dot && !dot.active) return;
    const { x, y } = signal.position;
    const pulse = 1 + Math.sin(snapshot.timeMs / 180) * 0.12;
    this.dynamicGfx.moveTo(x - 9 * pulse, y).lineTo(x - 2, y + 7)
      .lineTo(x + 11 * pulse, y - 10).stroke({ color: DOT_COLOR.blueprint, width: 3 });
  }

  private drawMineSignals(player: DotBotEntity): void {
    const ttlMs = 2_000;
    for (const [mineId, signal] of this.mineSignals) {
      const ageMs = this.lastTimeMs - signal.startedAt;
      if (ageMs > ttlMs) {
        this.mineSignals.delete(mineId);
        continue;
      }
      if (signal.event.floorId !== player.floorId) continue;
      const progress = clamp01(ageMs / ttlMs);
      this.dynamicGfx.circle(signal.event.position.x, signal.event.position.y, 12 + progress * 54).stroke({
        color: SQUAD_CYAN,
        width: 2,
        alpha: (1 - progress) * 0.8,
      });
    }
  }

  private drawPleaSignals(player: DotBotEntity): void {
    const ttlMs = 3_000;
    for (const [botId, signal] of this.pleaSignals) {
      const { event: plea, startedAt } = signal;
      const ageMs = this.lastTimeMs - startedAt;
      if (ageMs > ttlMs) {
        this.pleaSignals.delete(botId);
        continue;
      }
      const progress = clamp01(ageMs / ttlMs);
      const radius = 20 + progress * 70;
      const color = plea.squadId === player.squadId ? SQUAD_CYAN : RIVAL_RED;
      this.dynamicGfx.circle(plea.position.x, plea.position.y, radius).stroke({
        color,
        width: 3,
        alpha: (1 - progress) * 0.85,
      });
    }
  }

  /**
   * An edge arrow toward a downed squadmate you cannot see.
   *
   * The geometry lives in `edgeArrow`, which is where the three faults play reported
   * are documented and pinned. This is the drawing, and the one thing worth saying
   * here is that it hands over `camera` rather than assuming the player is at the
   * centre of the frame — `getCamera` returns the transform precisely so a caller
   * does not invent a second answer, and this was the caller that used to.
   */
  /**
   * An arrow at the edge for every squadmate off screen, and a different one when they are
   * down.
   *
   * It used to draw one arrow, for the nearest DOWNED mate only — so a squad spread across a
   * building told you nothing about where anybody was until somebody went down. Both facts
   * are worth showing and they are acted on differently, so they get different glyphs rather
   * than a colour change: a solid arrowhead is "they are that way", and a hollow one with a
   * cross through it is "that way, and they need picking up".
   *
   * The cross is the same mark a revive uses everywhere else in this game, which is why it
   * needs no legend.
   */
  private drawSquadmateArrows(
    snapshot: GameSnapshot,
    player: DotBotEntity,
    camera: Camera,
  ): void {
    for (const { bot, downed } of squadArrowTargets(snapshot.bots, player)) {
      const arrow = edgeArrow(bot.position, camera, this.viewport);
      if (!arrow) continue;
      const shape = [arrow.tip.x, arrow.tip.y, arrow.left.x, arrow.left.y, arrow.right.x, arrow.right.y];
      if (!downed) {
        this.screenGfx.poly(shape).fill({ color: SQUAD_CYAN, alpha: 0.9 });
        continue;
      }
      // Hollow, so it reads as "not whole", plus the revive cross at its centre.
      const cx = (arrow.tip.x + arrow.left.x + arrow.right.x) / 3;
      const cy = (arrow.tip.y + arrow.left.y + arrow.right.y) / 3;
      this.screenGfx.poly(shape)
        .fill({ color: INK.structure, alpha: 0.55 })
        .stroke({ color: SQUAD_CYAN, width: 2.4, alpha: 0.95 });
      this.screenGfx
        .moveTo(cx - 3, cy).lineTo(cx + 3, cy)
        .moveTo(cx, cy - 3).lineTo(cx, cy + 3)
        .stroke({ color: SQUAD_CYAN, width: 2, alpha: 0.95 });
    }
  }

  private updateDraftAnimations(now: number): void {
    for (const [objectId, animation] of this.draftAnimations) {
      const progress = clamp01((now - animation.startedAt) / animation.durationMs);
      const { x, y, w, h } = animation.bounds;
      // Build along the long axis, like a printer bed. `pad` covers the glyph's
      // cast shadow and any detail that sits a hair outside the authored rect.
      const pad = 6;
      const along = w >= h;
      const swept = (along ? w : h) + pad * 2;
      const cut = swept * progress;

      animation.mask.clear();
      if (along) animation.mask.rect(x - pad, y - pad, cut, h + pad * 2).fill({ color: 0xffffff });
      else animation.mask.rect(x - pad, y - pad, w + pad * 2, cut).fill({ color: 0xffffff });

      animation.front.clear();
      if (progress < 1) {
        // A hot line at the leading edge with a soft bloom behind it. Bright
        // against every material in the kit, so it reads on a dark rack and on a
        // pale mattress alike.
        const at = (along ? x : y) - pad + cut;
        const a = along ? { x: at, y: y - pad, w: 1.6, h: h + pad * 2 } : { x: x - pad, y: at, w: w + pad * 2, h: 1.6 };
        const glowDepth = 9;
        const glow = along
          ? { x: at - glowDepth, y: a.y, w: glowDepth, h: a.h }
          : { x: a.x, y: at - glowDepth, w: a.w, h: glowDepth };
        animation.front.rect(glow.x, glow.y, glow.w, glow.h).fill({ color: 0xffffff, alpha: 0.3 });
        animation.front.rect(a.x, a.y, a.w, a.h).fill({ color: 0xffffff, alpha: 0.95 });
      }

      if (progress >= 1) this.finishDraft(objectId);
    }
  }

  private finishDraft(objectId: string): void {
    const animation = this.draftAnimations.get(objectId);
    if (!animation) return;
    // Release the mask before destroying it, or Pixi keeps clipping to a dead
    // Graphics and the finished object never appears.
    animation.view.mask = null;
    animation.mask.destroy();
    animation.front.destroy();
    this.draftAnimations.delete(objectId);
  }

  /**
   * Put the nearest sign's reading next to the sign.
   *
   * No key, no aiming: walk near it and it becomes legible, which is how signs work
   * and is what makes this the general mechanic for text in the world rather than an
   * interaction. The text fades in over the last fifty-odd units instead of appearing
   * at a threshold — a caption that pops reads as UI, and the whole point is that it
   * is not.
   *
   * Anchored above the plate and centred on it, so it belongs to the object rather
   * than to the camera.
   */
  private updateSignReading(player: DotBotEntity | null): void {
    const reading = player
      ? signReadingAt(this.map, player.floorId, player.position, signsOnFloor(this.map, player.floorId))
      : null;
    if (!reading || reading.strength <= 0) {
      this.signLayer.visible = false;
      return;
    }
    this.signLayer.visible = true;
    this.signLayer.alpha = reading.strength;
    const { sign, open } = reading;
    this.signTitle.text = reading.title.toUpperCase();
    this.signDetail.text = reading.detail;
    this.signDetail.visible = reading.detail.length > 0;

    /**
     * Laid out on the sign's OPEN side, away from whatever it names.
     *
     * A fixed offset north put the words over whatever happened to be behind them, and
     * a building's own dark wall band is the one ground no ink survives. `signs.ts`
     * knows which way the building is, because that is how it found the building, so
     * the text goes the other way — onto the footway the sign faces.
     *
     * Stacked outward from the plate: title first, detail beyond it, so reading order
     * runs away from the object in both orientations.
     */
    const GAP = 10;
    const block = this.signTitle.height + (this.signDetail.visible ? this.signDetail.height + 2 : 0);
    const centreX = sign.x + sign.w / 2;
    const centreY = sign.y + sign.h / 2;
    if (open.y !== 0) {
      // Above or below: the block hangs off the near face, title nearest the plate.
      const edge = open.y < 0 ? sign.y - GAP : sign.y + sign.h + GAP;
      const top = open.y < 0 ? edge - block : edge;
      this.signTitle.position.set(centreX - this.signTitle.width / 2, top);
      this.signDetail.position.set(centreX - this.signDetail.width / 2, top + this.signTitle.height + 2);
    } else {
      // Beside it: left-aligned away from the plate so the text reads outward.
      const widest = Math.max(this.signTitle.width, this.signDetail.width);
      const left = open.x < 0 ? sign.x - GAP - widest : sign.x + sign.w + GAP;
      const top = centreY - block / 2;
      this.signTitle.position.set(left, top);
      this.signDetail.position.set(left, top + this.signTitle.height + 2);
    }
  }

  /** Rebuild the visibility polygon: vision mask + fog wash outside it. */
  private updateLineOfSight(snapshot: GameSnapshot, player: DotBotEntity | null, playerContext: string): void {
    this.visionMaskGfx.clear();
    this.fogGfx.clear();
    this.foregroundFogGfx.clear();

    if (!player) {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    /**
     * On the outdoor plane the vision context is the APERTURE one — every building near
     * enough has its footprint swapped for its real walls — so one ordinary polygon flows
     * through a doorway and is stopped by the first partition inside. Upper floors keep
     * their own context: a slab is not a wall with a hole in it.
     *
     * This replaces a disc that was added to the mask at each mouth. The disc ignored
     * walls, so a doorway lit a full circle and revealed the rooms either side of an
     * entrance hall through their own partitions. A polygon cannot do that; it is the
     * path light actually takes, which is what was asked for.
     */
    const vision = physicsFloorId(this.map, player.floorId) === OUTDOOR_FLOOR_ID
      ? outdoorVision(this.map, this.viewerDisplayPosition(player))
      : visionContext(this.map, playerContext);
    /**
     * Cast from where the bot is *drawn*, not from where it is.
     *
     * These were two different positions: the body is eased toward the simulated
     * one over about 34ms, and the wash was cast from the raw one. At a dash's
     * speed that put the light source and the body twenty units apart — light
     * spilled round a corner before you reached it, then caught up when you
     * stopped. Deleting the easing instead was tried and made the whole game
     * jitter, because the easing is also what absorbs prediction landing on tick
     * boundaries. So the wash moves to the eased position rather than the body
     * moving off it.
     */
    const polygon = visibilityPolygon(
      this.viewerDisplayPosition(player),
      vision,
      this.doorOccluders(snapshot, player.floorId),
    );

    if (polygon.length < 3) {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    // One flattened outline for the vision mask and both fog layers. Three copies
    // of the same polygon is three chances for them to stop agreeing.
    const flat = polygon.flatMap((point) => [point.x, point.y]);
    this.visionMaskGfx.poly(flat).fill({ color: 0xffffff });

    /**
     * The fog covers the SHEET, not the vision context's bounds.
     *
     * Those used to be the same rect. They are not any more: the outdoor context is bounded
     * by a box `OUTDOOR_SIGHT` around the viewer so the reveal has a maximum reach, and
     * fogging only that box would leave the rest of the map bright — the opposite of a
     * sight limit.
     */
    const fogStyle = visibilityFogStyle(playerContext !== "outdoor:street");
    for (const layer of [this.fogGfx, this.foregroundFogGfx]) {
      layer.rect(0, 0, this.map.width, this.map.height).fill(fogStyle);
      layer.poly(flat).cut();
    }

  }

  /**
   * WADING: how much the view is under water, 0..1, and the ramp that gets it there.
   *
   * Two things are wanted and they are separate. The BOT has to read as being in the water
   * — that is `drawWaterline`, drawn instead of a cast shadow. The VIEW has to change a
   * little — that is this: a wash of the water's own tone plus a vignette, so the edges of
   * the screen close in slightly and it reads as being *in* something rather than as a
   * colour filter laid over everything.
   *
   * RAMPED, NOT SWITCHED, and it is the third time that lesson has been paid for here. The
   * fog disc stepped and flickered because a threshold was a threshold; the peek lifts a
   * roof over its last 200 units for the same reason. A bot walking the rim of a cenote
   * crosses the water's edge repeatedly in a second, and a boolean would strobe the whole
   * screen. Faster in than out, because arriving should register and leaving should settle.
   *
   * `reducedMotion` does NOT turn this off. It is not motion — nothing here moves, it is a
   * tint whose strength changes — and it carries a fact about the world the player needs.
   */
  private updateWading(player: DotBotEntity | null, nowMs: number): void {
    const elapsed = Math.max(0, Math.min(120, nowMs - this.lastWadeAt));
    this.lastWadeAt = nowMs;

    const wading = player !== null
      && physicsFloorId(this.map, player.floorId) === OUTDOOR_FLOOR_ID
      && isInWater(this.map, this.viewerDisplayPosition(player));
    const target = wading ? 1 : 0;
    const alpha = 1 - Math.exp(-elapsed / (wading ? 150 : 240));
    this.wadeLevel += (target - this.wadeLevel) * alpha;
    if (this.wadeLevel < 0.004) this.wadeLevel = 0;

    this.wadeLayer.alpha = this.wadeLevel;
    this.wadeLayer.visible = this.wadeLevel > 0;
    if (this.wadeLevel > 0) this.buildWadeWash();
  }

  /** Rebuilt only when the viewport changes size. See the note on `wadeLayer`. */
  private buildWadeWash(): void {
    const { width, height } = this.viewport;
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (this.wadeBuiltFor === key) return;
    this.wadeBuiltFor = key;

    this.wadeTint.clear();
    this.wadeTint.rect(0, 0, width, height).fill({ color: GRD.deep, alpha: 0.2 });

    /**
     * The vignette: transparent in the middle, the water's tone at the edges.
     *
     * One radial gradient rather than a stack of nested frames. The alternative was four
     * rings drawn as sixteen rects, which is both more code and a visibly stepped falloff —
     * the same defect the shadow ramp needed nine layers to avoid.
     */
    this.wadeVignette.clear();
    this.wadeVignette.rect(0, 0, width, height).fill(new FillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0.1,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.72,
      textureSpace: "local",
      colorStops: [
        { offset: 0, color: "rgba(52, 60, 66, 0)" },
        { offset: 0.55, color: "rgba(52, 60, 66, 0.12)" },
        { offset: 1, color: "rgba(52, 60, 66, 0.46)" },
      ],
    }));
  }

  /** True when this bot is standing in open water on the street plane. */
  private inWater(bot: DotBotEntity): boolean {
    return physicsFloorId(this.map, bot.floorId) === OUTDOOR_FLOOR_ID
      && isInWater(this.map, bot.position);
  }

  /**
   * How far each building's roof is lifted for this viewer, 0..1.
   *
   * Only from OUTSIDE, and only on the outdoor plane: standing on a floor you already see
   * that floor, and a building whose roof you are standing on must keep it. Ramped over the
   * last `PEEK_RANGE` units to a mouth so walking up to a door lifts the lid smoothly
   * instead of snapping it off — the same lesson as the fog disc, which stepped and
   * flickered because a threshold was a threshold rather than a ramp.
   */
  private peekProgress(player: DotBotEntity | null): Map<string, number> {
    const open = new Map<string, number>();
    if (!player || physicsFloorId(this.map, player.floorId) !== OUTDOOR_FLOOR_ID) return open;
    const here = this.viewerDisplayPosition(player);
    const inside = buildingContaining(this.map, here);
    for (const building of this.map.buildings) {
      // Standing inside it, the ground floor is already the active floor.
      if (inside?.id === building.id) continue;
      let nearest = Infinity;
      for (const mouth of buildingMouths(this.map, building.id)) {
        nearest = Math.min(nearest, Math.hypot(mouth.x - here.x, mouth.y - here.y));
      }
      if (nearest >= PEEK_RANGE) continue;
      open.set(building.id, clamp01(1 - nearest / PEEK_RANGE));
    }
    return open;
  }

  /**
   * Where a point on the canvas is in the world.
   *
   * Uses the camera from the frame that is currently on screen rather than recomputing one,
   * because those are not the same thing: the camera eases and leads a dash, so a click
   * un-projected through a freshly computed camera lands slightly off the pixel the player
   * actually clicked. What they aimed at is what was drawn.
   */
  worldAt(canvasX: number, canvasY: number): Vec2 {
    const { x, y, scale } = this.lastCamera;
    return { x: (canvasX - x) / scale, y: (canvasY - y) / scale };
  }

  /**
   * The world rectangle currently on screen.
   *
   * Read off the same drawn camera as `worldAt`, for the same reason: the answer has
   * to describe what the player is looking at, not what they would be looking at if
   * a camera were computed now. Earshot is the caller — "you hear what you can see"
   * is only true if this is measured rather than assumed, because the visible width
   * of the world depends on the window and on the zoom the window chose.
   */
  visibleWorldBounds(): Rect {
    const topLeft = this.worldAt(0, 0);
    const bottomRight = this.worldAt(this.viewport.width, this.viewport.height);
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  }

  /** Hand the renderer this frame's live squad marks. */
  setSquadMarks(marks: readonly LiveMark[]): void {
    this.squadMarks = marks;
  }

  /**
   * Squad marks, drawn in the world and never hidden by fog.
   *
   * On the always-visible layer on purpose: the entire point of a mark is that it tells you
   * about somewhere you cannot see. Masking one to line of sight would leave it visible only
   * where you did not need it.
   *
   * Keyed on the PHYSICS floor rather than the arena context, which is the fix for marks
   * vanishing exactly where they were most useful. `contextKey` splits the street from each
   * building ground floor, so a mark placed on the pavement disappeared the moment you
   * stepped inside — reported with a screenshot of two marks right outside a doorway and
   * nothing drawn. The street and a ground floor are one plane joined by a door, so a mark on
   * either is a mark you can walk to without changing floor. A mark two storeys up still does
   * not draw, because that one really is somewhere else.
   */
  private drawSquadMarks(player: DotBotEntity, nowMs: number, camera: Camera): void {
    const here = physicsFloorId(this.map, player.floorId);
    for (const mark of this.squadMarks) {
      if (physicsFloorId(this.map, mark.floorId) !== here) continue;
      const fade = 1 - markAge(mark, nowMs);
      if (fade <= 0) continue;

      /**
       * Off screen, a chevron at the edge — deliberately NOT the squadmate triangle.
       *
       * Two different facts sharing one glyph is the failure: "your squadmate is that way"
       * and "somebody marked that way" are acted on differently, and an open chevron cannot
       * be mistaken for a solid arrowhead at a glance.
       */
      const arrow = edgeArrow(mark.position, camera, this.viewport);
      if (arrow) {
        const alpha = 0.4 + fade * 0.55;
        this.screenGfx
          .moveTo(arrow.left.x, arrow.left.y)
          .lineTo(arrow.tip.x, arrow.tip.y)
          .lineTo(arrow.right.x, arrow.right.y)
          .stroke({ color: SQUAD_CYAN, width: 3, alpha });
        continue;
      }
      this.drawWaymarker(mark, nowMs, fade);
    }
  }

  /**
   * A mark as a waymarker pin: an upside-down teardrop in the overlay's own glass.
   *
   * Replaces a ring-and-glyph that was reported as too big, with black outlines that did not
   * belong — "I think maybe we can use the glass UI to do a waymarker type shape... that has
   * our ping icon as the same blue as in our controls on it."
   *
   * Which is the better idea for a reason worth stating: a mark is not IN the world. It is
   * not lit by the world's light, it casts nothing, and the drawing contract's dark closed
   * outline means solid and impassable — so putting one on a mark said "this is a thing you
   * can walk into". Built out of the overlay's glass instead, it reads as a note on the glass
   * in front of the world, which is exactly what it is.
   *
   * The tip sits ON the marked point and the body rides above it, so the pin says WHERE
   * without covering it.
   */
  private drawWaymarker(mark: LiveMark, nowMs: number, fade: number): void {
    const { x, y } = mark.position;
    const r = 8.5;
    // Drops in and settles, so an arriving mark is noticed without a flash.
    const settle = Math.max(0, 1 - (nowMs - mark.placedAtMs) / 260);
    const rise = settle * settle * 14;
    const tipY = y - rise;
    const cy = tipY - r - 8;
    const alpha = (0.55 + fade * 0.45) * 0.92;

    // The pane: head and tail as one silhouette, in the Deep skin's glass tone.
    this.dynamicGfx.circle(x, cy, r).fill({ color: 0x0e1013, alpha: alpha * 0.82 });
    this.dynamicGfx
      .poly([x - r * 0.58, cy + r * 0.72, x + r * 0.58, cy + r * 0.72, x, tipY])
      .fill({ color: 0x0e1013, alpha: alpha * 0.82 });
    // A light rim rather than a dark outline: glass catches light, it does not draw an edge.
    this.dynamicGfx.circle(x, cy, r).stroke({ color: 0xffffff, width: 1, alpha: alpha * 0.3 });

    // The icon, in the controls' own cyan.
    const ink = { color: SQUAD_CYAN, width: 2, alpha };
    if (mark.kind === "enemy") {
      for (const [dx, dy] of [[-1, -1], [1, -1]]) {
        this.dynamicGfx
          .moveTo(x - dx * 3.6, cy - dy * 3.6).lineTo(x + dx * 3.6, cy + dy * 3.6).stroke(ink);
      }
    } else if (mark.kind === "loot") {
      this.dynamicGfx
        .moveTo(x, cy - 4.4).lineTo(x + 4.4, cy).lineTo(x, cy + 4.4).lineTo(x - 4.4, cy)
        .closePath()
        .stroke(ink);
    } else {
      /**
       * "Here" points down at the tip it sits above, centred on the circle.
       *
       * It read low, because it was: the chevron ran from `cy - 2` to `cy + 3.4`, so its
       * whole mass sat below centre while the ring around it was centred on `cy`. Symmetric
       * about `cy` now — a downward glyph already looks bottom-heavy, so it must be measured
       * rather than eyeballed.
       */
      this.dynamicGfx
        .moveTo(x - 4.4, cy - 2.7).lineTo(x, cy + 2.7).lineTo(x + 4.4, cy - 2.7).stroke(ink);
    }
  }

  /**
   * The viewer's eased position, brought forward so the wash and the body agree.
   *
   * `advanceDisplayPosition` does nothing on a second call within the same frame,
   * so running it here costs the later draw nothing and cannot double-ease.
   */
  private viewerDisplayPosition(player: DotBotEntity): Vec2 {
    const view = this.botViews.get(player.id);
    if (!view) return player.position;
    return advanceDisplayPosition(view, player.position, performance.now());
  }

  private getCamera(target: Vec2, dashing: boolean): { x: number; y: number; scale: number; center: Vec2 } {
    const now = performance.now();
    const elapsed = Math.max(0, Math.min(100, now - this.lastCameraAt));
    this.lastCameraAt = now;

    if (this.lastCameraTarget && elapsed > 0) {
      const targetDelta = {
        x: target.x - this.lastCameraTarget.x,
        y: target.y - this.lastCameraTarget.y,
      };
      const rawVelocity = Math.hypot(targetDelta.x, targetDelta.y) > 140
        ? { x: 0, y: 0 }
        : { x: targetDelta.x / (elapsed / 1_000), y: targetDelta.y / (elapsed / 1_000) };
      const velocityAlpha = 1 - Math.exp(-elapsed / 70);
      this.cameraVelocity = {
        x: this.cameraVelocity.x + (rawVelocity.x - this.cameraVelocity.x) * velocityAlpha,
        y: this.cameraVelocity.y + (rawVelocity.y - this.cameraVelocity.y) * velocityAlpha,
      };
    }
    this.lastCameraTarget = { ...target };

    const lookAhead = this.reducedMotion
      ? { x: 0, y: 0 }
      : clampVector({
        x: this.cameraVelocity.x * (dashing ? 0.06 : 0.022),
        y: this.cameraVelocity.y * (dashing ? 0.06 : 0.022),
      }, dashing ? 44 : 16);
    const desired = {
      x: target.x + lookAhead.x + this.cameraImpulse.x,
      y: target.y + lookAhead.y + this.cameraImpulse.y,
    };
    if (!this.cameraCenter) this.cameraCenter = { ...desired };
    const alpha = 1 - Math.exp(-elapsed / (dashing ? 62 : 105));
    this.cameraCenter = {
      x: this.cameraCenter.x + (desired.x - this.cameraCenter.x) * alpha,
      y: this.cameraCenter.y + (desired.y - this.cameraCenter.y) * alpha,
    };
    const impulseDecay = Math.exp(-elapsed / 58);
    this.cameraImpulse = {
      x: this.cameraImpulse.x * impulseDecay,
      y: this.cameraImpulse.y * impulseDecay,
    };
    const shortSide = Math.min(this.viewport.width, this.viewport.height);
    const scale = clamp(shortSide / 620, 0.55, 1.0);
    const visibleWidth = this.viewport.width / scale;
    const visibleHeight = this.viewport.height / scale;
    const centerX = visibleWidth >= this.map.width
      ? this.map.width / 2
      : clamp(this.cameraCenter.x, visibleWidth / 2, this.map.width - visibleWidth / 2);
    const centerY = visibleHeight >= this.map.height
      ? this.map.height / 2
      : clamp(this.cameraCenter.y, visibleHeight / 2, this.map.height - visibleHeight / 2);

    return {
      x: this.viewport.width / 2 - centerX * scale,
      y: this.viewport.height / 2 - centerY * scale,
      scale,
      // The world point the view is actually looking at, after clamping to the
      // sheet. Parallax is measured from here, so returning it beats having the
      // caller invert the transform and get a slightly different answer.
      center: { x: centerX, y: centerY },
    };
  }

  /**
   * Slide each building's mass a little against its own footprint, away from
   * whatever the camera is looking at.
   *
   * A transform per building per frame, and nothing is redrawn — the geometry is
   * built once and only its container moves. That is the whole reason to do
   * parallax this way rather than by rebuilding the roof at a new offset.
   */
  /**
   * Turn the objects on the floor you are standing on to face the camera.
   *
   * A building slides its whole mass with a container transform and never redraws. An
   * object cannot: its top face changes SHAPE, not position — the exposed band moves
   * around the perimeter — so this is a geometry rebuild, and the cost is the reason it
   * is fenced in on three sides.
   *
   * Only the active floor, because only one floor is drawn at a time. Only the objects,
   * because the slab, the walls, the shadows and the ambient occlusion do not care where
   * the camera is — a shadow lies on the floor and the floor does not move.
   *
   * And only when the camera has actually gone somewhere. `PARALLAX_REDRAW_STEP` is the
   * throttle: a camera drifting a unit at a time turns no object's pull by anything an
   * eye could see, and rebuilding for it would spend the whole budget on nothing.
   *
   * Worst floor in Downtown is 31 objects, so a rebuild is 31 `Graphics` — measurable
   * with `?netgraph`, which reports frame p50/p90/p99 and the long-frame count.
   */
  private updateObjectParallax(viewCenter: Vec2, activeFloorId: string | undefined): void {
    if (PARALLAX_STRENGTH <= 0 || !activeFloorId) return;
    const moved = Math.hypot(viewCenter.x - this.lastParallaxCentre.x, viewCenter.y - this.lastParallaxCentre.y);
    if (moved < PARALLAX_REDRAW_STEP && activeFloorId === this.lastParallaxFloorId) return;
    this.lastParallaxCentre = { x: viewCenter.x, y: viewCenter.y };
    this.lastParallaxFloorId = activeFloorId;

    for (const art of this.art.buildings) {
      for (const floorView of art.floors) {
        if (floorView.floor.id !== activeFloorId) continue;
        redrawFloorObjects(floorView.objectViews, viewCenter, PARALLAX_STRENGTH);
      }
    }
  }

  private updateRoofParallax(viewCenter: Vec2, playerFloorId: string | undefined): void {
    for (const art of this.art.buildings) {
      /**
       * Not while you are standing on it.
       *
       * An authored ROOF plan is both the building's exterior and a floor with
       * bots on it, and bots are drawn at their true world position. Sliding the
       * deck out from under them would put a bot several units off the parapet it
       * is pressed against — the one place in the game where the gap between drawn
       * and actual is something a player can act on.
       */
      const standingOnIt = art.roofFloorId !== null && art.roofFloorId === playerFloorId;
      const offset = standingOnIt ? { x: 0, y: 0 } : roofParallax(art.building, viewCenter);
      for (const mass of art.roofMasses) mass.position.set(offset.x, offset.y);
    }
  }

  private addCameraImpulse(direction: Vec2, intensity: number): void {
    if (this.reducedMotion) return;
    const unit = normalize(direction);
    this.cameraImpulse = clampVector({
      x: this.cameraImpulse.x + unit.x * intensity - unit.y * intensity * 0.32,
      y: this.cameraImpulse.y + unit.y * intensity + unit.x * intensity * 0.32,
    }, 9);
  }

  private contextKey(floorId: string, position: Vec2): string {
    return contextKey(this.map, floorId, position);
  }

  private doorOccluders(snapshot: GameSnapshot, floorId: string): import("@dotbot/game/types").Rect[] {
    return (snapshot.doors ?? [])
      .filter((door) => door.floorId === floorId && door.blocking)
      .map(doorEntityCollisionRect);
  }

  private updateVisibility(player: DotBotEntity | null, playerContext: string): void {
    const indoors = playerContext !== "outdoor:street";
    // Indoors the street is context, not content: dim it enough to recede without
    // losing the sense of where the building sits.
    this.art.ground.alpha = indoors ? 0.4 : 1;
    this.art.outdoorDetail.alpha = indoors ? 0.25 : 1;
    this.art.outdoorObjects.alpha = indoors ? 0.35 : 1;
    this.art.outdoorForeground.alpha = indoors ? 0.35 : 1;
    // Canopies and leaves fade with the rest of the outdoors when you are inside a building:
    // a tree is not something you see through a floor slab.
    this.art.overhead.alpha = indoors ? 0.35 : 1;

    const activeBuilding =
      player === null
        ? null
        : player.floorId !== OUTDOOR_FLOOR_ID
          ? this.art.buildings.find((view) => view.floors.some((floor) => floor.floor.id === player.floorId))?.building ?? null
          : buildingContaining(this.map, player.position);

    /**
     * How far open each building is to the viewer, 0..1.
     *
     * "when outside peering in, the roof should fade away where the fog reveals inside" —
     * so a building you are walking up to lifts its lid as you close on a doorway, and the
     * fog is what limits how much of what is underneath you can actually read. Ramped by
     * distance to the nearest mouth rather than switched, so nothing pops.
     *
     * It fades the WHOLE roof rather than only the wedge, and that is a deliberate stop
     * short of the real thing: cutting the wedge out of the roof means masking a container
     * that moves every frame under `roofParallax`, with its own AO and shadow layers inside
     * it. This is the version that can be looked at today — see task #62.
     */
    const peek = this.peekProgress(player);

    /**
     * A building standing over the floor you are on is not dimmed, it is GONE.
     *
     * Reported from play, standing in the temple's undercroft: "the observatory is blocking
     * the view of the basement floor of the temple. Not only is it just obscuring the view,
     * but if I go into that section, there seem to be elements of it that are restricting the
     * movement of the bot in that area too... I honestly think that buildings should maybe
     * disappear in that case."
     *
     * Nothing was restricting movement — `collectSolids` only ever returns the target floor's
     * own geometry, so the observatory's walls were never in the undercroft's physics. But the
     * drum was drawn on top at alpha 0.35, and what it hid was the undercroft's OWN boulders.
     * A translucent building over a floor you are standing on does not read as "elsewhere", it
     * reads as obstacles you cannot quite see — which is a worse failure than occlusion,
     * because the player learns to distrust what is drawn.
     *
     * Scoped to buildings that actually OVERLAP the floor's own extent, rather than hiding
     * every building whenever you are indoors. A ground floor shares the outdoor plane, so the
     * broad rule would empty the city out of a lobby window, which nobody asked for. The
     * undercroft is the case that matters and it is the case this catches: `bounds` is the
     * floor's own extent, so a cellar that runs out from under its own mass — which is exactly
     * how the temple's B2 reaches under the plaza — is compared against where it really goes.
     */
    const activeFloor = player && player.floorId !== OUTDOOR_FLOOR_ID
      ? floorPlanById(this.map, player.floorId)
      : null;
    const activeExtent = activeFloor?.bounds ?? null;

    for (const view of this.art.buildings) {
      const isActive = activeBuilding?.id === view.building.id;
      const opened = peek.get(view.building.id) ?? 0;
      /**
       * Hidden piece by piece rather than by one container, because there is no per-building
       * container to hide. A building's roof, entrance marks, label and floors are each added
       * to a SHARED layer so that z-order works across buildings rather than within one, and
       * that is worth keeping — so this turns off the pieces instead, and every assignment
       * below is written to respect it rather than relying on an early exit that could leave
       * one piece stale.
       */
      const standsOverMe = activeExtent !== null && !isActive
        && rectsOverlap(view.building.footprint, activeExtent);
      const activeFloorId =
        isActive && player
          ? player.floorId !== OUTDOOR_FLOOR_ID
            ? player.floorId
            : view.building.floors.find(isGroundFloor)?.id
          : opened > 0
            ? view.building.floors.find(isGroundFloor)?.id
            : undefined;

      for (const floorView of view.floors) {
        const isRoofPlan = floorView.floor.label === "ROOF";
        // A real ROOF plan doubles as the building's roof seen from outside.
        floorView.view.visible = !standsOverMe
          && (floorView.floor.id === activeFloorId || (isRoofPlan && !isActive));
        floorView.foreground.visible = floorView.view.visible;
        /**
         * A roof stair is two different things from two different places, and this is
         * the one line that knows which place the camera is in. Standing on the deck
         * you look INTO the stairwell; from the street you look at the roof OF it.
         * Drawing the housing in both is what play reported as "just a white square,
         * so it's not obvious it's stairs when on that floor".
         */
        if (floorView.stairHousing && floorView.stairWell) {
          const standingOnTheDeck = floorView.floor.id === activeFloorId;
          floorView.stairWell.visible = standingOnTheDeck;
          floorView.stairHousing.visible = !standingOnTheDeck;
        }
        // A roof being peeked under drops toward transparent; the ground floor revealed
        // beneath it comes up from nothing at the same rate, so the two cross over.
        const lid = isRoofPlan && !isActive ? 1 - opened : 1;
        floorView.view.alpha = (floorView.floor.id === activeFloorId ? (isActive ? 1 : opened) : indoors ? 0.35 : 1) * lid;
        floorView.foreground.alpha = floorView.view.alpha;
      }

      const hasRoofPlan = view.building.floors.some((floor) => floor.label === "ROOF");
      view.roof.visible = !standsOverMe && !isActive && !hasRoofPlan;
      view.roof.alpha = (indoors ? 0.35 : 1) * (1 - opened);
      view.entranceMarks.visible = !standsOverMe && !isActive;
      view.entranceMarks.alpha = indoors ? 0.35 : 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic entities
  // ---------------------------------------------------------------------------

  private drawExtractionPulse(snapshot: GameSnapshot, viewerSquadId: string | undefined): void {
    const extract = snapshot.coverages.find((coverage) => coverage.kind === "extract");

    if (!extract) {
      return;
    }

    const point = this.map.extractionPoints.find((item) => item.id === extract.targetId);

    if (!point) {
      return;
    }

    const cx = point.rect.x + point.rect.w / 2;
    const cy = point.rect.y + point.rect.h / 2;
    const progress = clamp01(extract.progressMs / extract.durationMs);
    const pulse = 1 + 0.06 * Math.sin(snapshot.timeMs / 120);
    const channeler = snapshot.bots.find((bot) => bot.id === extract.actorId);
    const channelColor = channeler ? this.relationshipColor(channeler, viewerSquadId) : INK.opening;

    this.dynamicGfx.circle(cx, cy, (point.rect.w / 2 + 10) * pulse).stroke({ color: INK.opening, width: 2, alpha: 0.35 });
    this.drawProgressRing(this.dynamicGfx, { x: cx, y: cy }, point.rect.w / 2 + 4, progress, channelColor, 4);
  }

  private drawDots(snapshot: GameSnapshot, viewerSquadId: string | undefined, playerContext: string): void {

    for (const dot of snapshot.dots) {
      if (!dot.active || this.contextKey(dot.floorId, dot.position) !== playerContext) {
        continue;
      }

      const color = dot.item.kind === "blueprint" ? DOT_COLOR.blueprint : DOT_COLOR.powerup;
      drawDotDisc(this.maskedGfx, dot.position, dot.radius, color);
      drawDotMark(this.maskedGfx, dot.item, dot.position, dot.radius);
      drawDotGloss(this.maskedGfx, dot.position, dot.radius);

      const coverage = snapshot.coverages.find((item) => item.kind === "capture" && item.targetId === dot.id);
      if (coverage) {
        const channeler = snapshot.bots.find((bot) => bot.id === coverage.actorId);
        const channelColor = channeler ? this.relationshipColor(channeler, viewerSquadId) : INK.structure;
        this.drawProgressRing(this.maskedGfx, dot.position, dot.radius + 10, coverage.progressMs / coverage.durationMs, channelColor, 3);
      }
    }
  }

  private drawMines(snapshot: GameSnapshot, playerContext: string): void {
    for (const mine of snapshot.mines) {
      if (this.contextKey(mine.floorId, mine.position) !== playerContext) continue;
      const { x, y } = mine.position;
      const size = Math.max(4, mine.radius * 0.45);
      if (mine.presentation === "squad" || mine.presentation === "revealed") {
        this.maskedGfx.circle(x, y, mine.radius).fill({ color: 0xf1f3f5 });
        this.maskedGfx.moveTo(x - size, y - size).lineTo(x + size, y + size)
          .moveTo(x + size, y - size).lineTo(x - size, y + size)
          .stroke({ color: INK.structure, width: 2 });
        continue;
      }

      this.maskedGfx.circle(x, y, mine.radius).fill({ color: colorToNumber("#e8590c") });
      const seamRadians = 1 / Math.max(1, mine.radius);
      const seamStart = seamRadians / 2;
      this.maskedGfx.beginPath()
        .moveTo(x + Math.cos(seamStart) * mine.radius, y + Math.sin(seamStart) * mine.radius)
        .arc(x, y, mine.radius, seamStart, Math.PI * 2 - seamRadians / 2)
        .stroke({ color: INK.structure, width: 2 });
      drawDotMark(this.maskedGfx, { kind: "powerup", type: mine.disguise ?? "health" }, mine.position, mine.radius);
      drawDotGloss(this.maskedGfx, mine.position, mine.radius);
    }
  }

  private drawRadarPings(player: DotBotEntity): void {
    for (const ping of player.radarPings) {
      const alpha = clamp01(1 - ping.ageMs / 2000);
      const radius = 5 + (1 - alpha) * 8;
      this.dynamicGfx.circle(ping.x, ping.y, radius).stroke({ color: DOT_COLOR.powerup, width: 2, alpha });
    }
  }

  private drawBots(snapshot: GameSnapshot, playerId: string, playerContext: string): void {
    const sorted = [...snapshot.bots].sort((a, b) => a.position.y - b.position.y);
    const player = snapshot.bots.find((bot) => bot.id === playerId);
    const viewerSquadId = player?.squadId;

    for (const view of this.botViews.values()) view.root.visible = false;

    for (const bot of sorted) {
      const squad = viewerSquadId !== undefined && bot.squadId === viewerSquadId;
      const sameArena = this.contextKey(bot.floorId, bot.position) === playerContext;

      if (squad) {
        // Squad members render through walls and across floors, but only at
        // full strength when actually seen — otherwise as a faded ghost, so
        // "I see them" and "I know where they are" read differently.
        const seen =
          bot.id === playerId ||
          (sameArena && (!player || hasLineOfSight(
            this.map,
            playerContext,
            player.position,
            bot.position,
            this.doorOccluders(snapshot, player.floorId),
          )));
        this.updateBotView(bot, snapshot, viewerSquadId, seen ? 1 : 0.35, this.dynamicBotsLayer);
      } else if (sameArena || (player && seesOutdoors(
        this.map, player.floorId, player.position, bot.floorId, bot.position,
      ))) {
        /**
         * Enemies render into the masked layer: hidden outside line of sight.
         *
         * The doorway clause is the client half of the same rule the sim uses, and both
         * halves are needed or the feature only exists for the AI. This gate says "draw
         * them"; `updateLineOfSight` opens a hole in the mask at the mouth, which is what
         * decides whether the drawing survives. Miss either one and a bot across a
         * threshold is either invisible or visible through the wall beside the door.
         */
        this.updateBotView(bot, snapshot, viewerSquadId, 1, this.maskedBotsLayer);
      }
    }

    const presentIds = new Set(snapshot.bots.map((bot) => bot.id));
    for (const [botId, view] of this.botViews) {
      if (presentIds.has(botId)) continue;
      view.root.destroy({ children: true });
      this.botViews.delete(botId);
      this.trailAnchors.delete(botId);
    }
  }

  /**
   * Scuff the ground a moving DotBot crosses, where the ground will take it.
   *
   * WHICH GROUND IS THE MAP'S ANSWER, not this function's — reported while it was being built,
   * "movement trails should only appear on surfaces where it makes sense," and the map already
   * names every piece of ground by its use. `isSoftGround` is the whole test: growth to
   * flatten, earth to scuff, ballast to turn over. A footway keeps nothing.
   *
   * IT CANNOT SHOW YOU AN ENEMY THROUGH A WALL, and that gate is the reason this is not just
   * three lines in `drawBots`. A short-lived smudge moving along behind a bot you cannot see is
   * still a position readout, so a mark is only ever stamped for a bot that is genuinely
   * visible right now — the same arena and the same line-of-sight test the enemy branch of
   * `drawBots` uses, with the player themselves exempt because you can always see yourself.
   * Marks already down stay down, which is right: you saw that crossing happen.
   */
  private updateTrails(
    snapshot: GameSnapshot,
    player: DotBotEntity | null,
    playerContext: string,
    nowMs: number,
  ): void {
    fadeTrail(this.art.trails, nowMs);
    if (!player) {
      this.trailAnchors.clear();
      return;
    }

    // Built at most once a frame, and only if some bot actually crossed a stride: it
    // allocates a rect per open door and most frames stamp nothing at all.
    let occluders: Rect[] | null = null;

    for (const bot of snapshot.bots) {
      // The smoothed position `drawBots` just settled on, so the mark lands under the body.
      const at = this.botViews.get(bot.id)?.displayPosition ?? bot.position;
      const step = trailStep(this.trailAnchors.get(bot.id), at);
      this.trailAnchors.set(bot.id, step.anchor);
      if (!step.crossed) continue;

      if (physicsFloorId(this.map, bot.floorId) !== OUTDOOR_FLOOR_ID) continue;
      if (!isSoftGround(groundAt(this.map, at))) continue;
      if (bot.id !== player.id) {
        if (this.contextKey(bot.floorId, bot.position) !== playerContext) continue;
        occluders ??= this.doorOccluders(snapshot, player.floorId);
        if (!hasLineOfSight(
          this.map, playerContext, player.position, bot.position, occluders,
        )) continue;
      }
      stampTrail(this.art.trails, step.from, at, step.heading, nowMs, bot.id);
    }
  }

  private updateBotView(
    bot: DotBotEntity,
    snapshot: GameSnapshot,
    viewerSquadId: string | undefined,
    fade: number,
    layer: Container,
  ): void {
    let view = this.botViews.get(bot.id);
    if (!view) {
      const root = new Container();
      const body = new Graphics();
      const progress = new Graphics();
      root.addChild(body, progress);
      view = {
        root,
        body,
        progress,
        signature: "",
        lastPosition: null,
        displayPosition: null,
        lastDisplayAt: performance.now(),
        movingUntil: 0,
        dashPeakMs: 0,
      };
      this.botViews.set(bot.id, view);
    }
    if (view.root.parent !== layer) layer.addChild(view.root);

    const color = this.relationshipColor(bot, viewerSquadId);
    const serrated = !bot.isAmbient && viewerSquadId !== undefined && bot.squadId !== viewerSquadId;
    const now = performance.now();
    const displayPosition = advanceDisplayPosition(view, bot.position, now);
    const positionChanged = view.lastPosition !== null && Math.hypot(
      bot.position.x - view.lastPosition.x,
      bot.position.y - view.lastPosition.y,
    ) > 0.2;
    if (positionChanged) view.movingUntil = now + 110;
    const moved = now < view.movingUntil;
    const animation = bot.state === "downed"
      ? "downed"
      : bot.dashActiveMs > 0
        ? "dash"
        : moved
          ? (Math.floor(now / 150) % 2 === 0 ? "glide-a" : "glide-b")
          : "idle";
    /**
     * How full the dash gauge is, from the longest cooldown this bot has been seen
     * to carry. Reading it off a config would mean the renderer and the server each
     * holding a copy of the same number; the bot itself already reports it.
     */
    if (bot.dashCooldownMs > view.dashPeakMs) view.dashPeakMs = bot.dashCooldownMs;
    const dashReady = bot.dashOverchargeCharges > 0 || bot.dashCooldownMs <= 0;
    const dashLevel = dashReady || view.dashPeakMs <= 0
      ? 1
      : clamp01(1 - bot.dashCooldownMs / view.dashPeakMs);
    // Quantized, or a continuous value redraws the body on every frame of every
    // cooldown. Twelve steps is finer than the eye tracks on a 24-unit core.
    const dashSteps = Math.round(dashLevel * 12);
    /**
     * Which way the sun lies, in the body's own frame, quantized.
     *
     * The body is drawn once at facing 0 and spun by its container, which is what
     * keeps a turning bot off the redraw path — but the sun does not turn with the
     * bot, so the drawing has to know how far it is about to be spun. Baking the
     * exact facing would put every turning bot back on that path at 60 Hz.
     *
     * Thirty-two buckets is 11.25 degrees, which moves the shadow's alpha-weighted
     * centroid by at most 0.50 units and its faintest ring by 1.05, against the
     * 21.49 units a half-turn used to drag the whole shadow across. Sub-pixel, on a
     * mark with no edge in it, for at most fifteen redraws a second on a bot
     * turning hard — roughly what the glide animation already costs.
     */
    const sunSteps = 32;
    // The hit flash adds its own rotation to the same container, so it spins the
    // sun exactly as facing does — for the 240 ms of the flash the light rode
    // around with the body. It goes in the same bucket rather than being added
    // afterward, so a shake still costs at most a redraw per 11.25 degrees.
    const reaction = impactReactionForTarget(this.impactFlashes, bot.id, now, this.reducedMotion);
    const spin = bot.facing + (reaction?.rotation ?? 0);
    const spinBucket = Math.round((spin / (Math.PI * 2)) * sunSteps);
    const signature = [
      bot.state,
      bot.radius,
      bot.maxShields,
      bot.shieldSegments.join(","),
      color,
      serrated ? 1 : 0,
      bot.dashActiveMs > 0 ? 1 : 0,
      bot.invulnerabilityMs > 0 ? 1 : 0,
      dashSteps,
      spinBucket,
      animation,
    ].join("|");
    if (view.signature !== signature) {
      view.body.clear();
      this.drawBotBody(
        view.body,
        { ...bot, position: { x: 0, y: 0 }, facing: 0 },
        viewerSquadId,
        dashSteps / 12,
        (spinBucket / sunSteps) * Math.PI * 2,
      );
      view.signature = signature;
    }
    view.lastPosition = { ...bot.position };

    view.root.visible = true;
    view.root.alpha = fade;
    view.root.position.set(
      displayPosition.x + (reaction?.offset.x ?? 0),
      displayPosition.y + (reaction?.offset.y ?? 0),
    );
    view.root.rotation = spin;
    view.root.scale.set(reaction?.scale ?? 1);
    view.root.zIndex = bot.position.y;

    view.progress.clear();
    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      const channeler = snapshot.bots.find((candidate) => candidate.id === coverage.actorId);
      this.drawProgressRing(
        view.progress,
        { x: 0, y: 0 },
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        channeler ? this.relationshipColor(channeler, viewerSquadId) : INK.structure,
        4,
      );
      view.progress.rotation = -view.root.rotation;
    }
  }

  /**
   * @param spin how far the view holding this drawing will be rotated. The body
   * is drawn at facing 0 and spun by its container, so every mark that encodes a
   * *world* direction — the sun, and the catch light it lights — has to be
   * counter-spun here or it rides around with the bot.
   */
  private drawBotBody(
    g: Graphics,
    bot: DotBotEntity,
    viewerSquadId: string | undefined,
    dashLevel = 1,
    spin = 0,
  ): void {
    const color = this.relationshipColor(bot, viewerSquadId);
    const serrated = !bot.isAmbient && viewerSquadId !== undefined && bot.squadId !== viewerSquadId;

    if (bot.state === "downed") {
      // A body is its own drawing, not a standing bot with the contrast turned
      // down: no cast shadow, no facing, no plate ring.
      drawDownedBody(g, {
        at: bot.position,
        radius: bot.radius,
        color,
        carriedCount: bot.carriedCount,
        searched: bot.searched,
       
        spin,
      });
      return;
    }

    const coreRadius = bot.radius * CORE_REACH;
    /**
     * A waterline INSTEAD of a cast shadow, never as well as it. A shadow promises a floor
     * under the thing casting it, and a bot in a pool is not standing on the pool.
     */
    if (this.inWater(bot)) {
      drawWaterline(g, bot.position, bot, this.lastTimeMs / 520 + bot.position.x * 0.01);
    } else {
      drawGroundShadow(g, bot.position, bot, { spin });
    }
    drawPlates(g, bot, color, serrated);
    drawBodyOutline(g, bot);
    // The catch light comes with it: one function owns what a core looks like, so
    // the lab and the game cannot disagree about the sphere.
    drawChargedCore(g, bot.position, coreRadius, dashLevel, INK.structure, spin);
    // After the core, because a bare arc's edge *is* the core's edge.
    drawBareEdges(g, bot, color);

    if (bot.dashActiveMs > 0) drawDashRing(g, bot);
    if (bot.invulnerabilityMs > 0 && bot.state === "alive") drawInvulnerabilityRing(g, bot);
  }

  private relationshipColor(bot: DotBotEntity, viewerSquadId: string | undefined): number {
    if (viewerSquadId !== undefined && bot.squadId === viewerSquadId) {
      return SQUAD_CYAN;
    }
    return bot.isAmbient ? AMBIENT_GREY : RIVAL_RED;
  }

  // --- Noise rings -----------------------------------------------------------

  private drawNoises(snapshot: GameSnapshot, player: DotBotEntity): void {
    const g = this.dynamicGfx;

    for (const noise of snapshot.noises) {
      const heard = classifyNoise(this.map, player.floorId, player.position, noise.floorId, noise.position, noise.loudness);

      if (!heard) {
        continue;
      }

      const progress = clamp01(noise.ageMs / noise.ttlMs);
      const radius = 16 + progress * (46 + noise.loudness * 84);
      const alpha = (1 - progress) * 0.55;
      const center = noise.position;

      if (heard.muffled) this.dashedCircle(g, center, radius, alpha);
      else g.circle(center.x, center.y, radius).stroke({ color: INK.opening, width: 2, alpha });

      if (heard.vertical !== 0) {
        this.drawChevron(g, noise.position, heard.vertical, alpha);
      }
    }
  }

  private dashedCircle(g: Graphics, center: Vec2, radius: number, alpha: number): void {
    const dashes = 12;

    for (let i = 0; i < dashes; i += 1) {
      const start = (Math.PI * 2 * i) / dashes;
      const end = start + (Math.PI * 2 * 0.55) / dashes;
      this.drawArcStroke(g, center, radius, start, end, { color: INK.opening, width: 2, alpha });
    }
  }

  /** Sharp, short-lived contact burst: a heavy ring snapping outward with a
   * four-tick star — distinct from the softer server noise ring that follows
   * a round trip later. */
  private drawImpactFlashes(snapshot: GameSnapshot, nowMs: number): void {
    const retentionMs = 800;
    for (let index = this.impactFlashes.length - 1; index >= 0; index -= 1) {
      const flash = this.impactFlashes[index];
      const age = nowMs - flash.startedAt;
      if (age > retentionMs) {
        this.impactViews.get(flash.predictionId)?.root.destroy({ children: true });
        this.impactViews.delete(flash.predictionId);
        this.impactFlashes.splice(index, 1);
        continue;
      }

      const lifeMs = this.reducedMotion
        ? 150
        : flash.kind === "clash"
          ? 320
          : flash.kind === "bump"
            ? 190
            : flash.result === "downed"
              ? 300
              : 240;
      let view = this.impactViews.get(flash.predictionId);
      if (!view) {
        const root = new Container();
        const burst = new Graphics();
        const pulse = new Graphics();
        if (flash.kind === "clash") {
          burst.circle(0, 0, 7).stroke({ color: 0xffffff, width: 4 });
          burst.circle(0, 0, 12).stroke({ color: INK.structure, width: 2.5 });
          for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
            burst.moveTo(dx * 6, dy * 6).lineTo(dx * 13, dy * 13)
              .stroke({ color: INK.structure, width: 2.5 });
          }
        } else if (flash.kind === "bump") {
          burst.circle(0, 0, 9).stroke({ color: INK.fixture, width: 3 });
        } else {
          burst.circle(0, 0, 8).stroke({ color: INK.structure, width: 3.5 });
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            burst.moveTo(dx * 8, dy * 8).lineTo(dx * 13, dy * 13).stroke({ color: INK.structure, width: 2 });
          }
        }
        const target = snapshot.bots.find((bot) => bot.id === flash.targetId);
        if (target && flash.kind === "hit") {
          pulse.circle(0, 0, target.radius * 0.5).stroke({ color: 0xffffff, width: 6 });
          pulse.circle(0, 0, target.radius * 0.72).stroke({ color: INK.structure, width: 2.5 });
        }
        root.addChild(burst, pulse);
        this.impactLayer.addChild(root);
        view = { root, burst, pulse };
        this.impactViews.set(flash.predictionId, view);
      }

      view.root.position.set(flash.x, flash.y);
      const target = snapshot.bots.find((bot) => bot.id === flash.targetId);
      if (target) view.pulse.position.set(target.position.x - flash.x, target.position.y - flash.y);
      if (age > lifeMs) {
        view.root.visible = false;
        continue;
      }

      const progress = clamp01(age / lifeMs);
      const alpha = (1 - progress) * 0.95;
      view.root.visible = true;
      view.burst.alpha = alpha;
      view.burst.scale.set(1 + progress * 2.5);

      // A short white-black pulse on the victim makes the contact readable on
      // a busy floor plan while the speculative shield break above conveys
      // the actual damage result without waiting for a network round trip.
      if (target && flash.kind === "hit" && age <= 110) {
        const targetProgress = age / 110;
        view.pulse.visible = true;
        view.pulse.alpha = (1 - targetProgress) * 0.95;
        view.pulse.scale.set(1 + targetProgress * 0.48);
      } else {
        view.pulse.visible = false;
      }
    }
  }

  /** Small ^ (above) or v (below) at the ring center. */
  private drawChevron(g: Graphics, center: Vec2, vertical: -1 | 1, alpha: number): void {
    const sign = vertical === 1 ? -1 : 1;
    g.moveTo(center.x - 7, center.y + sign * -4)
      .lineTo(center.x, center.y + sign * 4)
      .lineTo(center.x + 7, center.y + sign * -4)
      .stroke({ color: INK.opening, width: 2.5, alpha });
  }

  private drawProgressRing(g: Graphics, center: Vec2, radius: number, progress: number, color: number, width: number): void {
    const clamped = clamp01(progress);
    this.drawArcStroke(g, center, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2, { color, width, alpha: 0.95 });
  }

  private drawArcStroke(
    g: Graphics,
    center: Vec2,
    radius: number,
    startAngle: number,
    endAngle: number,
    strokeStyle: { color: number; width: number; alpha: number },
  ): void {
    g.beginPath()
      .moveTo(center.x + Math.cos(startAngle) * radius, center.y + Math.sin(startAngle) * radius)
      .arc(center.x, center.y, radius, startAngle, endAngle)
      .stroke(strokeStyle);
  }
}

function clampVector(vector: Vec2, maximum: number): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= maximum || length <= 0.0001) return vector;
  const scale = maximum / length;
  return { x: vector.x * scale, y: vector.y * scale };
}
