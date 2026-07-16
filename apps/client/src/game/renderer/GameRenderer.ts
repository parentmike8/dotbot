import { Application, Container, Graphics } from "pixi.js";
import { clamp, clamp01, colorToNumber } from "@dotbot/game/math";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  floorPlanById,
  isGroundFloor,
  resolvePlan,
} from "@dotbot/game/mapModel";
import { hasLineOfSight, visibilityPolygon, visionContext } from "@dotbot/game/visibility";
import { OUTDOOR_FLOOR_ID } from "@dotbot/game/types";
import type { DotBotEntity, GameSnapshot, Item, MapDocument, SimEvent, Vec2 } from "@dotbot/game/types";
import type { MatchIntel } from "@dotbot/protocol";
import { shieldArcSpan } from "@dotbot/game/shields";
import { buildMapArt, drawStair, drawStairExitHalf, type MapArt } from "./mapArt";
import { drawObjectDraftLayers } from "./glyphs";
import { INK, WEIGHT } from "./style";

const SQUAD_CYAN = 0x15aabf;
const RIVAL_RED = 0xe03131;
const AMBIENT_GREY = 0x868e96;

export type InteractionChannelVisual = {
  position: Vec2;
  radius: number;
  progress: number;
};

type DraftAnimation = {
  object: import("@dotbot/game/types").MapObject;
  staticView: Graphics;
  outline: Graphics;
  detail: Graphics;
  outlineMask: Graphics;
  detailMask: Graphics;
  pencil: Graphics;
  startedAt: number;
  durationMs: number;
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
  /** Entities subject to line-of-sight: enemies, dots, their rings. */
  private readonly maskedLayer = new Container();
  private readonly maskedGfx = new Graphics();
  private readonly visionMaskGfx = new Graphics();
  /** Always-visible layer: player, squad, noise rings, extraction pulse. */
  private readonly dynamicGfx = new Graphics();
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
  private readonly pleaSignals = new Map<string, { event: Extract<SimEvent, { type: "plea" }>; startedAt: number }>();
  private readonly mineSignals = new Map<string, { event: Extract<SimEvent, { type: "mineSensor" }>; startedAt: number }>();
  private readonly draftAnimations = new Map<string, DraftAnimation>();

  private constructor(app: Application, map: MapDocument) {
    this.app = app;
    this.map = map;
    this.art = buildMapArt(map);
    this.app.stage.addChild(this.worldLayer, this.screenGfx);
    this.maskedLayer.addChild(this.maskedGfx, this.visionMaskGfx);
    this.maskedLayer.mask = this.visionMaskGfx;
    this.worldLayer.addChild(this.art.root, this.fogGfx, this.maskedLayer, this.dynamicGfx, this.stairOverlayGfx);
  }

  static async create(host: HTMLElement, map: MapDocument): Promise<GameRenderer> {
    const app = new Application();

    await app.init({
      antialias: true,
      autoDensity: true,
      background: "#ffffff",
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });

    host.appendChild(app.canvas);
    const renderer = new GameRenderer(app, map);
    renderer.resize(host.clientWidth, host.clientHeight);
    return renderer;
  }

  resize(width: number, height: number): void {
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
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

  /** Reusable fabrication hook: M5 placement and M6 output call this API. */
  draftObject(objectId: string, durationMs = 1200): boolean {
    const floors = this.art.buildings.flatMap((building) => building.floors);
    const floor = floors
      .find((candidate) => candidate.objectViews.has(objectId));
    const entry = floor?.objectViews.get(objectId);
    const stairFloor = entry ? undefined : floors.find((candidate) => candidate.stairViews.has(objectId));
    const stairEntry = stairFloor?.stairViews.get(objectId);
    const targetFloor = floor ?? stairFloor;
    if (!targetFloor || (!entry && !stairEntry)) return false;
    this.finishDraft(objectId);

    const outline = new Graphics();
    const detail = new Graphics();
    const outlineMask = new Graphics();
    const detailMask = new Graphics();
    const pencil = new Graphics();
    const object = entry?.object ?? {
      id: objectId,
      kind: "rug" as const,
      ...stairEntry!.stair.rect,
      solid: false,
    };
    if (entry) {
      drawObjectDraftLayers(outline, detail, object);
    } else {
      const { x, y, w, h } = stairEntry!.stair.rect;
      outline.rect(x, y, w, h).stroke({ color: INK.opening, width: WEIGHT.opening });
      drawStair(detail, stairEntry!.stair);
    }
    outline.mask = outlineMask;
    detail.mask = detailMask;
    const staticView = entry?.view ?? stairEntry!.view;
    staticView.visible = false;
    targetFloor.furniture.addChild(outline, detail, pencil, outlineMask, detailMask);
    this.draftAnimations.set(objectId, {
      object,
      staticView,
      outline,
      detail,
      outlineMask,
      detailMask,
      pencil,
      startedAt: performance.now(),
      durationMs,
    });
    return true;
  }

  queuePlea(event: Extract<SimEvent, { type: "plea" }>): void {
    this.pleaSignals.set(event.botId, { event, startedAt: this.lastTimeMs });
  }

  queueMineSensor(event: Extract<SimEvent, { type: "mineSensor" }>): void {
    this.mineSignals.set(event.mineId, { event, startedAt: this.lastTimeMs });
  }

  render(snapshot: GameSnapshot, playerId: string, preserveMissingViewer = false, interactionChannel: InteractionChannelVisual | null = null, intel?: MatchIntel): void {
    this.lastTimeMs = snapshot.timeMs;
    this.updateDraftAnimations(performance.now());
    const currentPlayer = snapshot.bots.find((bot) => bot.id === playerId);
    const player = currentPlayer ?? (preserveMissingViewer ? this.lastViewer ?? undefined : snapshot.bots[0]);
    if (currentPlayer) this.lastViewer = currentPlayer;
    const center = player?.position ?? { x: this.map.width / 2, y: this.map.height / 2 };
    const camera = this.getCamera(center);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);

    const playerContext = player ? this.contextKey(player.floorId, player.position) : "outdoor:street";
    this.updateVisibility(player ?? null, playerContext);
    this.updateLineOfSight(player ?? null, playerContext);

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

    this.drawStairOverlay(player ?? null);
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
      const outlineProgress = clamp01(progress / 0.55);
      const detailProgress = clamp01((progress - 0.55) / 0.45);
      this.drawDraftMask(animation.outlineMask, animation.object, outlineProgress);
      this.drawDraftMask(animation.detailMask, animation.object, detailProgress);
      this.drawPencilTick(animation.pencil, animation.object, progress < 0.55 ? outlineProgress : detailProgress);
      if (progress >= 1) this.finishDraft(objectId);
    }
  }

  private drawDraftMask(mask: Graphics, object: import("@dotbot/game/types").MapObject, progress: number): void {
    mask.clear();
    const pad = 4;
    if (object.w >= object.h) {
      mask.rect(object.x - pad, object.y - pad, (object.w + pad * 2) * progress, object.h + pad * 2).fill({ color: 0xffffff });
    } else {
      mask.rect(object.x - pad, object.y - pad, object.w + pad * 2, (object.h + pad * 2) * progress).fill({ color: 0xffffff });
    }
  }

  private drawPencilTick(pencil: Graphics, object: import("@dotbot/game/types").MapObject, progress: number): void {
    pencil.clear();
    if (progress >= 1) return;
    if (object.w >= object.h) {
      const x = object.x + object.w * progress;
      pencil.moveTo(x, object.y - 5).lineTo(x + 4, object.y + 3).stroke({ color: INK.hairline, width: WEIGHT.hairline });
    } else {
      const y = object.y + object.h * progress;
      pencil.moveTo(object.x - 5, y).lineTo(object.x + 3, y + 4).stroke({ color: INK.hairline, width: WEIGHT.hairline });
    }
  }

  private finishDraft(objectId: string): void {
    const animation = this.draftAnimations.get(objectId);
    if (!animation) return;
    animation.staticView.visible = true;
    animation.outline.destroy();
    animation.detail.destroy();
    animation.outlineMask.destroy();
    animation.detailMask.destroy();
    animation.pencil.destroy();
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
      drawStairExitHalf(this.stairOverlayGfx, stair);
    }
  }

  /** Rebuild the visibility polygon: vision mask + fog wash outside it. */
  private updateLineOfSight(player: DotBotEntity | null, playerContext: string): void {
    this.visionMaskGfx.clear();
    this.fogGfx.clear();

    if (!player || player.state === "consumed") {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    const vision = visionContext(this.map, playerContext);
    const polygon = visibilityPolygon(player.position, vision);

    if (polygon.length < 3) {
      this.visionMaskGfx.rect(0, 0, this.map.width, this.map.height).fill({ color: 0xffffff });
      return;
    }

    const flat = polygon.flatMap((point) => [point.x, point.y]);
    this.visionMaskGfx.poly(flat).fill({ color: 0xffffff });

    const bounds = vision.boundsRect;
    this.fogGfx.rect(bounds.x, bounds.y, bounds.w, bounds.h).fill({ color: 0x2f353b, alpha: 0.035 });
    this.fogGfx.poly(flat).cut();
    this.fogGfx.poly(flat).stroke({ color: 0xb9c0c8, width: 1.1, alpha: 0.35 });
  }

  private getCamera(target: Vec2): { x: number; y: number; scale: number } {
    const shortSide = Math.min(this.viewport.width, this.viewport.height);
    const scale = clamp(shortSide / 620, 0.55, 1.0);
    const visibleWidth = this.viewport.width / scale;
    const visibleHeight = this.viewport.height / scale;
    const centerX = clamp(target.x, visibleWidth / 2, this.map.width - visibleWidth / 2);
    const centerY = clamp(target.y, visibleHeight / 2, this.map.height - visibleHeight / 2);

    return {
      x: this.viewport.width / 2 - centerX * scale,
      y: this.viewport.height / 2 - centerY * scale,
      scale,
    };
  }

  private contextKey(floorId: string, position: Vec2): string {
    return contextKey(this.map, floorId, position);
  }

  private updateVisibility(player: DotBotEntity | null, playerContext: string): void {
    const indoors = playerContext !== "outdoor:street";
    this.art.ground.alpha = indoors ? 0.4 : 1;
    this.art.outdoorDetail.alpha = indoors ? 0.25 : 1;
    this.art.outdoorObjects.alpha = indoors ? 0.35 : 1;
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
        floorView.view.alpha = floorView.floor.id === activeFloorId ? 1 : indoors ? 0.35 : 1;
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

      const color = dot.item.kind === "blueprint" ? "#1971c2" : "#e8590c";
      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).fill({ color: colorToNumber(color) });
      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).stroke({ color: 0x111111, width: 2 });
      this.drawDotMark(this.maskedGfx, dot.item, dot.position, dot.radius);

      const coverage = snapshot.coverages.find((item) => item.kind === "capture" && item.targetId === dot.id);
      if (coverage) {
        const channeler = snapshot.bots.find((bot) => bot.id === coverage.actorId);
        const channelColor = channeler ? this.relationshipColor(channeler, viewerSquadId) : INK.structure;
        this.drawProgressRing(this.maskedGfx, dot.position, dot.radius + 8, coverage.progressMs / coverage.durationMs, channelColor, 3);
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
      this.maskedGfx.arc(x, y, mine.radius, seamRadians / 2, Math.PI * 2 - seamRadians / 2)
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
      g.arc(x, y, size * 0.5, -Math.PI * 0.75, Math.PI * 0.75).stroke(line);
      g.arc(x, y, size, -Math.PI * 0.75, Math.PI * 0.75).stroke(line);
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
      g.arc(x, y, size, (index * Math.PI) / 4, ((index + 1) * Math.PI) / 4).stroke(line);
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

    for (const bot of sorted) {
      if (bot.state === "consumed") {
        continue;
      }

      const squad = viewerSquadId !== undefined && bot.squadId === viewerSquadId;
      const sameArena = this.contextKey(bot.floorId, bot.position) === playerContext;

      if (squad) {
        // Squad members render through walls and across floors, but only at
        // full strength when actually seen — otherwise as a faded ghost, so
        // "I see them" and "I know where they are" read differently.
        const seen =
          bot.id === playerId ||
          (sameArena && (!player || hasLineOfSight(this.map, playerContext, player.position, bot.position)));
        this.drawBotBody(this.dynamicGfx, bot, snapshot, viewerSquadId, seen ? 1 : 0.35);
      } else if (sameArena) {
        // Enemies render into the masked layer: hidden outside line of sight.
        this.drawBotBody(this.maskedGfx, bot, snapshot, viewerSquadId, 1);
      }
    }
  }

  private drawBotBody(g: Graphics, bot: DotBotEntity, snapshot: GameSnapshot, viewerSquadId: string | undefined, fade: number): void {
    const color = this.relationshipColor(bot, viewerSquadId);
    const coreRadius = bot.state === "downed" ? bot.radius * 0.34 : bot.radius * 0.4;
    const alpha = (bot.state === "downed" ? 0.72 : 1) * fade;
    const serrated = !bot.isAmbient && viewerSquadId !== undefined && bot.squadId !== viewerSquadId;

    this.drawShieldSegments(g, bot, color, serrated, fade);

    if (bot.state === "downed") {
      g.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color, width: 2.5, alpha });
    } else {
      g.circle(bot.position.x, bot.position.y, coreRadius).fill({ color: INK.structure, alpha: 0.95 * fade });
      g.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color: INK.structure, width: 2, alpha });
    }

    if (bot.dashActiveMs > 0) {
      g.circle(bot.position.x, bot.position.y, bot.radius - 1).stroke({ color: INK.structure, width: 3, alpha: 0.45 * fade });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      g.circle(bot.position.x, bot.position.y, bot.radius - 3).stroke({ color: 0x111111, width: 2, alpha: 0.18 * fade });
    }

    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      const channeler = snapshot.bots.find((candidate) => candidate.id === coverage.actorId);
      this.drawProgressRing(
        g,
        bot.position,
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        channeler ? this.relationshipColor(channeler, viewerSquadId) : INK.structure,
        4,
      );
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
  private drawShieldSegments(g: Graphics, bot: DotBotEntity, color: number, serrated: boolean, fade: number): void {
    const span = shieldArcSpan(bot.maxShields);
    const step = (Math.PI * 2) / bot.maxShields;
    const shieldRadius = bot.radius * 0.78;
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

      if (heard.muffled) {
        this.dashedCircle(g, noise.position, radius, alpha);
      } else {
        g.circle(noise.position.x, noise.position.y, radius).stroke({ color: INK.opening, width: 2, alpha });
      }

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
