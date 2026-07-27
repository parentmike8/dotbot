import { Application, Container, Graphics } from "pixi.js";
import { clamp, clamp01, colorToNumber, normalize } from "@dotbot/game/math";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  doorEntityCollisionRect,
  floorPlanById,
  isGroundFloor,
  resolvePlan,
} from "@dotbot/game/mapModel";
import { hasLineOfSight, visibilityPolygon, visionContext } from "@dotbot/game/visibility";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import type { DotBotEntity, GameSnapshot, HitResult, Item, MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";
import type { MatchIntel } from "@dotbot/protocol";
import { shieldArcSpan } from "@dotbot/game/shields";
import type { PredictedImpact } from "../session/GameSession";
import { buildMapArt, type MapArt } from "./mapArt";
import { drawStairDeepHalf } from "./model/modelFloor";
import {
  applyPredictedImpactOverlays,
  classifyPredictedImpact,
  impactReactionForTarget,
  predictedImpactDirection,
  type QueuedPredictedImpact,
} from "./impactPrediction";
import { drawDotDisc } from "./dotArt";
import { drawCatchLight, drawGroundShadow } from "./grounding";
import { drawDownedBody } from "./bodies";
import { DOT_COLOR, INK, WEIGHT } from "./style";
import { visibilityFogStyle } from "./visibilityStyle";

const SQUAD_CYAN = 0x15aabf;
const RIVAL_RED = 0xe03131;
const AMBIENT_GREY = 0x868e96;

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
};

type ImpactView = {
  root: Container;
  burst: Graphics;
  pulse: Graphics;
};

/**
 * The live-game renderer: static map art (from mapArt.ts, shared with Map
 * Studio) plus the gameplay overlay — bots, dots, rings, noise, fog, and the
 * per-floor visibility model. The base map must stand on its own; everything
 * in this file draws *over* it and can be disabled without leaving holes.
 */
export class GameRenderer {
  private readonly app: Application;
  private readonly worldLayer = new Container();
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
  /** Viewport-space markers that must remain legible beyond the camera. */
  private readonly screenGfx = new Graphics();
  /** Far half of each stair run on the active floor, drawn over the bots so
   * they slide under the break line while changing floors. */
  private readonly stairOverlayGfx = new Graphics();

  private map: MapDocument;
  private viewport = { width: 1, height: 1 };
  private destroyed = false;
  private lastViewer: DotBotEntity | null = null;
  private lastTimeMs = 0;
  private cameraCenter: Vec2 | null = null;
  private lastCameraTarget: Vec2 | null = null;
  private cameraVelocity: Vec2 = { x: 0, y: 0 };
  private cameraImpulse: Vec2 = { x: 0, y: 0 };
  private lastCameraAt = performance.now();
  private reducedMotion = false;
  private readonly pleaSignals = new Map<string, { event: Extract<SimEvent, { type: "plea" }>; startedAt: number }>();
  private readonly mineSignals = new Map<string, { event: Extract<SimEvent, { type: "mineSensor" }>; startedAt: number }>();
  private readonly impactFlashes: QueuedPredictedImpact[] = [];
  private readonly botViews = new Map<string, BotView>();
  private readonly impactViews = new Map<string, ImpactView>();
  private readonly draftAnimations = new Map<string, DraftAnimation>();

  private constructor(app: Application, map: MapDocument) {
    this.app = app;
    this.map = map;
    this.art = buildMapArt(map);
    this.app.stage.addChild(this.worldLayer, this.screenGfx);
    this.maskedBotsLayer.sortableChildren = true;
    this.dynamicBotsLayer.sortableChildren = true;
    this.maskedLayer.addChild(this.maskedGfx, this.maskedBotsLayer, this.visionMaskGfx);
    this.maskedLayer.mask = this.visionMaskGfx;
    this.foregroundFogGfx.mask = this.art.foreground;
    this.worldLayer.addChild(
      this.art.root,
      this.fogGfx,
      this.maskedLayer,
      this.dynamicGfx,
      this.dynamicBotsLayer,
      this.impactLayer,
      this.art.foreground,
      this.foregroundFogGfx,
      this.stairOverlayGfx,
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
  queueImpact(impact: PredictedImpact, snapshot: GameSnapshot): HitResult {
    const result = classifyPredictedImpact(snapshot, impact);
    const direction = predictedImpactDirection(snapshot, impact);
    this.impactFlashes.push({ ...impact, result, direction, startedAt: performance.now() });
    this.addCameraImpulse(direction, result === "downed" ? 5 : 3.5);
    return result;
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
      impact.targetId === event.botId
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

    const playerContext = player ? this.contextKey(player.floorId, player.position) : "outdoor:street";
    this.updateVisibility(player ?? null, playerContext);
    this.updateLineOfSight(snapshot, player ?? null, playerContext);

    this.maskedGfx.clear();
    this.dynamicGfx.clear();
    this.screenGfx.clear();
    this.drawExtractionPulse(snapshot, player?.squadId);
    this.drawDots(snapshot, player?.squadId, playerContext);
    this.drawMines(snapshot, playerContext);
    this.drawSignalIntel(snapshot, intel, playerContext);
    this.drawBots(snapshot, playerId, playerContext);
    if (interactionChannel) {
      this.drawProgressRing(this.dynamicGfx, interactionChannel.position, interactionChannel.radius, interactionChannel.progress, INK.opening, 3);
    }
    if (currentPlayer) this.drawRadarPings(currentPlayer);

    if (player) {
      this.drawNoises(snapshot, player);
      this.drawPleaSignals(player);
      this.drawMineSignals(player);
      this.drawDownedSquadmateArrow(snapshot, player);
    }
    this.drawImpactFlashes(snapshot, nowMs);

    this.drawStairOverlay(player ?? null);
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
      .lineTo(x + 11 * pulse, y - 10).stroke({ color: 0x1971c2, width: 3 });
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

  private drawDownedSquadmateArrow(snapshot: GameSnapshot, player: DotBotEntity): void {
    const squadmate = snapshot.bots.find((bot) =>
      bot.id !== player.id && bot.squadId === player.squadId && bot.state === "downed",
    );
    if (!squadmate) return;

    const dx = squadmate.position.x - player.position.x;
    const dy = squadmate.position.y - player.position.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    const halfWidth = Math.max(18, center.x - 32);
    const halfHeight = Math.max(18, center.y - 32);
    const edgeScale = Math.min(
      Math.abs(ux) > 0.001 ? halfWidth / Math.abs(ux) : Number.POSITIVE_INFINITY,
      Math.abs(uy) > 0.001 ? halfHeight / Math.abs(uy) : Number.POSITIVE_INFINITY,
    );
    const tip = { x: center.x + ux * edgeScale, y: center.y + uy * edgeScale };
    const sideX = -uy;
    const sideY = ux;
    const base = { x: tip.x - ux * 18, y: tip.y - uy * 18 };
    this.screenGfx
      .poly([
        tip.x, tip.y,
        base.x + sideX * 8, base.y + sideY * 8,
        base.x - sideX * 8, base.y - sideY * 8,
      ])
      .fill({ color: SQUAD_CYAN, alpha: 0.95 })
      .stroke({ color: INK.structure, width: 2 });
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

  /** Redraw the far half of the active floor's stairs above the bot layer. */
  private drawStairOverlay(player: DotBotEntity | null): void {
    this.stairOverlayGfx.clear();

    if (!player) {
      return;
    }

    const planRef = resolvePlan(this.map, player.floorId, player.position);
    const plan = planRef ? floorPlanById(this.map, planRef.planId) : null;

    for (const stair of plan?.stairs ?? []) {
      drawStairDeepHalf(this.stairOverlayGfx, stair);
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

    const vision = visionContext(this.map, playerContext);
    const polygon = visibilityPolygon(player.position, vision, this.doorOccluders(snapshot, player.floorId));

    if (polygon.length < 3) {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    // One flattened outline for the vision mask and both fog layers. Three copies
    // of the same polygon is three chances for them to stop agreeing.
    const flat = polygon.flatMap((point) => [point.x, point.y]);
    this.visionMaskGfx.poly(flat).fill({ color: 0xffffff });

    const fogStyle = visibilityFogStyle(playerContext !== "outdoor:street");
    for (const layer of [this.fogGfx, this.foregroundFogGfx]) {
      layer.rect(vision.boundsRect.x, vision.boundsRect.y, vision.boundsRect.w, vision.boundsRect.h).fill(fogStyle);
      layer.poly(flat).cut();
    }
  }

  private getCamera(target: Vec2, dashing: boolean): { x: number; y: number; scale: number } {
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
    };
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
    this.art.labels.alpha = indoors ? 0.45 : 1;

    const activeBuilding =
      player === null
        ? null
        : player.floorId !== OUTDOOR_FLOOR_ID
          ? this.art.buildings.find((view) => view.floors.some((floor) => floor.floor.id === player.floorId))?.building ?? null
          : buildingContaining(this.map, player.position);

    for (const view of this.art.buildings) {
      const isActive = activeBuilding?.id === view.building.id;
      const activeFloorId =
        isActive && player
          ? player.floorId !== OUTDOOR_FLOOR_ID
            ? player.floorId
            : view.building.floors.find(isGroundFloor)?.id
          : undefined;

      for (const floorView of view.floors) {
        const isRoofPlan = floorView.floor.label === "ROOF";
        // A real ROOF plan doubles as the building's roof seen from outside.
        floorView.view.visible = floorView.floor.id === activeFloorId || (isRoofPlan && !isActive);
        floorView.foreground.visible = floorView.view.visible;
        floorView.view.alpha = floorView.floor.id === activeFloorId ? 1 : indoors ? 0.35 : 1;
        floorView.foreground.alpha = floorView.view.alpha;
      }

      const hasRoofPlan = view.building.floors.some((floor) => floor.label === "ROOF");
      view.roof.visible = !isActive && !hasRoofPlan;
      view.roof.alpha = indoors ? 0.35 : 1;
      view.entranceMarks.visible = !isActive;
      view.entranceMarks.alpha = indoors ? 0.35 : 1;
      view.label.alpha = isActive ? 0 : 1;
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
      this.drawDotMark(this.maskedGfx, dot.item, dot.position, dot.radius);

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
      this.drawDotMark(this.maskedGfx, { kind: "powerup", type: mine.disguise ?? "health" }, mine.position, mine.radius);
    }
  }

  private drawDotMark(g: Graphics, item: Item, center: Vec2, radius: number): void {
    const size = Math.max(3.5, radius * 0.42);
    const line = { color: INK.structure, width: Math.max(1.25, radius * 0.14) };
    const { x, y } = center;

    if (item.kind === "blueprint") {
      g.moveTo(x - size, y - size * 0.55).lineTo(x + size, y - size * 0.55)
        .moveTo(x - size, y).lineTo(x + size * 0.45, y)
        .moveTo(x - size, y + size * 0.55).lineTo(x + size, y + size * 0.55).stroke(line);
      return;
    }
    if (item.kind === "mine") {
      g.moveTo(x - size, y - size).lineTo(x + size, y + size)
        .moveTo(x + size, y - size).lineTo(x - size, y + size).stroke(line);
      return;
    }
    if (item.type === "health") {
      g.moveTo(x - size, y).lineTo(x + size, y).moveTo(x, y - size).lineTo(x, y + size).stroke(line);
      return;
    }
    if (item.type === "radar") {
      this.drawArcStroke(g, center, size * 0.5, -Math.PI * 0.75, Math.PI * 0.75, { ...line, alpha: 1 });
      this.drawArcStroke(g, center, size, -Math.PI * 0.75, Math.PI * 0.75, { ...line, alpha: 1 });
      return;
    }
    if (item.type === "dashOvercharge") {
      g.moveTo(x - size * 0.65, y - size)
        .lineTo(x + size * 0.45, y)
        .lineTo(x - size * 0.65, y + size)
        .stroke(line);
      return;
    }
    for (let index = 0; index < 8; index += 2) {
      this.drawArcStroke(g, center, size, (index * Math.PI) / 4, ((index + 1) * Math.PI) / 4, { ...line, alpha: 1 });
    }
  }

  private drawRadarPings(player: DotBotEntity): void {
    for (const ping of player.radarPings) {
      const alpha = clamp01(1 - ping.ageMs / 2000);
      const radius = 5 + (1 - alpha) * 8;
      this.dynamicGfx.circle(ping.x, ping.y, radius).stroke({ color: 0xe8590c, width: 2, alpha });
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
      } else if (sameArena) {
        // Enemies render into the masked layer: hidden outside line of sight.
        this.updateBotView(bot, snapshot, viewerSquadId, 1, this.maskedBotsLayer);
      }
    }

    const presentIds = new Set(snapshot.bots.map((bot) => bot.id));
    for (const [botId, view] of this.botViews) {
      if (presentIds.has(botId)) continue;
      view.root.destroy({ children: true });
      this.botViews.delete(botId);
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
      };
      this.botViews.set(bot.id, view);
    }
    if (view.root.parent !== layer) layer.addChild(view.root);

    const color = this.relationshipColor(bot, viewerSquadId);
    const serrated = !bot.isAmbient && viewerSquadId !== undefined && bot.squadId !== viewerSquadId;
    const now = performance.now();
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
    const signature = [
      bot.state,
      bot.radius,
      bot.maxShields,
      bot.shieldSegments.join(","),
      color,
      serrated ? 1 : 0,
      bot.dashActiveMs > 0 ? 1 : 0,
      bot.invulnerabilityMs > 0 ? 1 : 0,
      animation,
    ].join("|");
    if (view.signature !== signature) {
      view.body.clear();
      this.drawBotBody(view.body, { ...bot, position: { x: 0, y: 0 }, facing: 0 }, viewerSquadId);
      view.signature = signature;
    }
    view.lastPosition = { ...bot.position };

    if (!view.displayPosition || Math.hypot(
      bot.position.x - view.displayPosition.x,
      bot.position.y - view.displayPosition.y,
    ) > 120) {
      view.displayPosition = { ...bot.position };
    } else {
      const elapsed = Math.max(0, Math.min(50, now - view.lastDisplayAt));
      const smoothing = 1 - Math.exp(-elapsed / 34);
      view.displayPosition.x += (bot.position.x - view.displayPosition.x) * smoothing;
      view.displayPosition.y += (bot.position.y - view.displayPosition.y) * smoothing;
    }
    view.lastDisplayAt = now;

    const reaction = impactReactionForTarget(this.impactFlashes, bot.id, now, this.reducedMotion);
    view.root.visible = true;
    view.root.alpha = fade;
    view.root.position.set(
      view.displayPosition.x + (reaction?.offset.x ?? 0),
      view.displayPosition.y + (reaction?.offset.y ?? 0),
    );
    view.root.rotation = bot.facing + (reaction?.rotation ?? 0);
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

  private drawBotBody(g: Graphics, bot: DotBotEntity, viewerSquadId: string | undefined): void {
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
      });
      return;
    }

    const coreRadius = bot.radius * 0.4;
    drawGroundShadow(g, bot.position, bot.radius);
    this.drawShieldSegments(g, bot, color, serrated, 1);
    // Hairline hull at the true collision radius: bodies stop where this
    // line is, so contact renders as contact instead of a 10px air gap
    // between shield arcs.
    g.circle(bot.position.x, bot.position.y, bot.radius - 0.5).stroke({ color: INK.structure, width: 1, alpha: 0.22 });
    g.circle(bot.position.x, bot.position.y, coreRadius).fill({ color: INK.structure, alpha: 0.95 });
    g.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color: INK.structure, width: 2 });
    // Catch light on the core, so the body reads as a sphere under the plates.
    drawCatchLight(g, bot.position, coreRadius);

    if (bot.dashActiveMs > 0) {
      g.circle(bot.position.x, bot.position.y, bot.radius - 1).stroke({ color: INK.structure, width: 3, alpha: 0.45 });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      g.circle(bot.position.x, bot.position.y, bot.radius - 3).stroke({ color: 0x111111, width: 2, alpha: 0.18 });
    }
  }

  private relationshipColor(bot: DotBotEntity, viewerSquadId: string | undefined): number {
    if (viewerSquadId !== undefined && bot.squadId === viewerSquadId) {
      return SQUAD_CYAN;
    }
    return bot.isAmbient ? AMBIENT_GREY : RIVAL_RED;
  }

  /**
   * Shield plates anchored to the bot's facing (plate 0 dead ahead): intact
   * plates draw solid, cracked plates split at the middle, broken plates
   * leave a faint ghost so the exposed side stays readable.
   */
  private drawShieldSegments(
    g: Graphics,
    bot: DotBotEntity,
    color: number,
    serrated: boolean,
    fade: number,
    radiusScale = 0.78,
  ): void {
    const span = shieldArcSpan(bot.maxShields);
    const step = (Math.PI * 2) / bot.maxShields;
    const shieldRadius = bot.radius * radiusScale;
    const intactWidth = bot.state === "downed" ? 2 : 5;

    for (let index = 0; index < bot.maxShields; index += 1) {
      const state = bot.shieldSegments[index] ?? 0;
      const start = bot.facing + index * step - span / 2;

      if (state >= 1) {
        this.drawArcStroke(g, bot.position, shieldRadius, start, start + span, {
          color,
          width: intactWidth,
          alpha: fade,
        });
        if (serrated) {
          this.drawArcStroke(g, bot.position, shieldRadius + 3, start, start + span, {
            color,
            width: 2,
            alpha: fade,
          });
        }
      } else if (state > 0) {
        // Cracked: the plate splits into two halves around a central break.
        for (const [from, to] of [
          [start, start + span * 0.42],
          [start + span * 0.58, start + span],
        ]) {
          this.drawArcStroke(g, bot.position, shieldRadius, from, to, {
            color,
            width: Math.max(2, intactWidth - 2),
            alpha: 0.9 * fade,
          });
        }
      } else {
        this.drawArcStroke(g, bot.position, shieldRadius, start, start + span, {
          color,
          width: 2,
          alpha: 0.3 * fade,
        });
      }
    }
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

      const lifeMs = this.reducedMotion ? 150 : flash.result === "downed" ? 300 : 240;
      let view = this.impactViews.get(flash.predictionId);
      if (!view) {
        const root = new Container();
        const burst = new Graphics();
        const pulse = new Graphics();
        burst.circle(0, 0, 8).stroke({ color: INK.structure, width: 3.5 });
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          burst.moveTo(dx * 8, dy * 8).lineTo(dx * 13, dy * 13).stroke({ color: INK.structure, width: 2 });
        }
        const target = snapshot.bots.find((bot) => bot.id === flash.targetId);
        if (target) {
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
      if (target && age <= 110) {
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
