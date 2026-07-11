import { Application, Container, Graphics } from "pixi.js";
import { clamp, clamp01, colorToNumber } from "../math";
import {
  buildingContaining,
  classifyNoise,
  contextKey,
  floorPlanById,
  isGroundFloor,
  resolvePlan,
} from "../mapModel";
import { hasLineOfSight, visibilityPolygon, visionContext } from "../visibility";
import { OUTDOOR_FLOOR_ID } from "../types";
import type { DotBotEntity, GameSnapshot, MapDocument, Vec2 } from "../types";
import { shieldArcSpan } from "../shields";
import { buildMapArt, drawStairExitHalf, type MapArt } from "./mapArt";
import { INK } from "./style";

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
  /** Far half of each stair run on the active floor, drawn over the bots so
   * they slide under the break line while changing floors. */
  private readonly stairOverlayGfx = new Graphics();

  private map: MapDocument;
  private viewport = { width: 1, height: 1 };
  private destroyed = false;

  private constructor(app: Application, map: MapDocument) {
    this.app = app;
    this.map = map;
    this.art = buildMapArt(map);
    this.app.stage.addChild(this.worldLayer);
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

  render(snapshot: GameSnapshot): void {
    const player = snapshot.bots.find((bot) => bot.id === snapshot.playerId) ?? snapshot.bots[0];
    const center = player?.position ?? { x: this.map.width / 2, y: this.map.height / 2 };
    const camera = this.getCamera(center);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);

    const playerContext = player ? this.contextKey(player.floorId, player.position) : "outdoor:street";
    this.updateVisibility(player ?? null, playerContext);
    this.updateLineOfSight(player ?? null, playerContext);

    this.maskedGfx.clear();
    this.dynamicGfx.clear();
    this.drawExtractionPulse(snapshot);
    this.drawDots(snapshot, playerContext);
    this.drawBots(snapshot, playerContext);

    if (player) {
      this.drawNoises(snapshot, player);
    }

    this.drawStairOverlay(player ?? null);
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

  private drawExtractionPulse(snapshot: GameSnapshot): void {
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

    this.dynamicGfx.circle(cx, cy, (point.rect.w / 2 + 10) * pulse).stroke({ color: INK.opening, width: 2, alpha: 0.35 });
    this.drawProgressRing(this.dynamicGfx, { x: cx, y: cy }, point.rect.w / 2 + 4, progress, INK.opening, 4);
  }

  private drawDots(snapshot: GameSnapshot, playerContext: string): void {
    for (const dot of snapshot.dots) {
      if (!dot.active || this.contextKey(dot.floorId, dot.position) !== playerContext) {
        continue;
      }

      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).fill({ color: colorToNumber(dot.color) });
      this.maskedGfx.circle(dot.position.x, dot.position.y, dot.radius).stroke({ color: 0x111111, width: 2 });
      this.drawDotMark(this.maskedGfx, dot.color, dot.position, dot.radius);

      const coverage = snapshot.coverages.find((item) => item.kind === "capture" && item.targetId === dot.id);
      if (coverage) {
        this.drawProgressRing(this.maskedGfx, dot.position, dot.radius + 8, coverage.progressMs / coverage.durationMs, 0x111111, 3);
      }
    }
  }

  /** Dots remain colored, but their compact black mark makes type readable
   * without color and survives the map's deliberately restrained palette. */
  private drawDotMark(g: Graphics, color: string, center: Vec2, radius: number): void {
    const key = color.trim().toLowerCase();
    const size = Math.max(3.5, radius * 0.42);
    const line = { color: INK.structure, width: Math.max(1.25, radius * 0.14) };
    const { x, y } = center;

    if (key === "#27ae60") {
      // Regen: plus.
      g.moveTo(x - size, y).lineTo(x + size, y).moveTo(x, y - size).lineTo(x, y + size).stroke(line);
      return;
    }

    if (key === "#2f80ed") {
      // Shield: hollow core.
      g.circle(x, y, size * 0.7).stroke(line);
      return;
    }

    if (key === "#56ccf2") {
      // Dash: forward chevron.
      g.moveTo(x - size * 0.65, y - size)
        .lineTo(x + size * 0.45, y)
        .lineTo(x - size * 0.65, y + size)
        .stroke(line);
      return;
    }

    if (key === "#f2c94c") {
      // Scanner: target.
      g.circle(x, y, size * 0.78).stroke(line);
      g.circle(x, y, Math.max(1.2, radius * 0.13)).fill({ color: INK.structure });
      return;
    }

    if (key === "#f2994a") {
      // Decoy: cross.
      g.moveTo(x - size, y - size).lineTo(x + size, y + size).moveTo(x + size, y - size).lineTo(x - size, y + size).stroke(line);
      return;
    }

    if (key === "#eb5757") {
      // Damage: diamond.
      g.poly([x, y - size, x + size, y, x, y + size, x - size, y], true).stroke(line);
      return;
    }

    if (key === "#9b51e0") {
      // Rare: four-point sparkle with shorter diagonal rays.
      const short = size * 0.62;
      g.moveTo(x - size, y)
        .lineTo(x + size, y)
        .moveTo(x, y - size)
        .lineTo(x, y + size)
        .moveTo(x - short, y - short)
        .lineTo(x + short, y + short)
        .moveTo(x + short, y - short)
        .lineTo(x - short, y + short)
        .stroke(line);
      return;
    }

    g.circle(x, y, Math.max(1.4, radius * 0.15)).fill({ color: INK.structure });
  }

  private drawBots(snapshot: GameSnapshot, playerContext: string): void {
    const sorted = [...snapshot.bots].sort((a, b) => a.position.y - b.position.y);
    const player = snapshot.bots.find((bot) => bot.id === snapshot.playerId);

    for (const bot of sorted) {
      if (bot.state === "consumed") {
        continue;
      }

      const squad = bot.team === "player" || bot.team === "ally";
      const sameArena = this.contextKey(bot.floorId, bot.position) === playerContext;

      if (squad) {
        // Squad members render through walls and across floors, but only at
        // full strength when actually seen — otherwise as a faded ghost, so
        // "I see them" and "I know where they are" read differently.
        const seen =
          bot.id === snapshot.playerId ||
          (sameArena && (!player || hasLineOfSight(this.map, playerContext, player.position, bot.position)));
        this.drawBotBody(this.dynamicGfx, bot, snapshot, seen ? 1 : 0.35);
      } else if (sameArena) {
        // Enemies render into the masked layer: hidden outside line of sight.
        this.drawBotBody(this.maskedGfx, bot, snapshot, 1);
      }
    }
  }

  private drawBotBody(g: Graphics, bot: DotBotEntity, snapshot: GameSnapshot, fade: number): void {
    const color = colorToNumber(bot.color);
    const coreRadius = bot.state === "downed" ? bot.radius * 0.34 : bot.radius * 0.4;
    const alpha = (bot.state === "downed" ? 0.72 : 1) * fade;

    this.drawShieldSegments(g, bot, bot.state === "alive" ? color : 0x111111, fade);

    g.circle(bot.position.x, bot.position.y, coreRadius).fill({ color, alpha: (bot.state === "downed" ? 0.28 : 0.95) * fade });
    g.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color: 0x111111, width: 2, alpha });

    if (bot.dashActiveMs > 0) {
      g.circle(bot.position.x, bot.position.y, bot.radius - 1).stroke({ color, width: 3, alpha: 0.45 * fade });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      g.circle(bot.position.x, bot.position.y, bot.radius - 3).stroke({ color: 0x111111, width: 2, alpha: 0.18 * fade });
    }

    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      this.drawProgressRing(
        g,
        bot.position,
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        coverage.kind === "revive" ? 0x2f80ed : 0xeb5757,
        4,
      );
    }
  }

  /**
   * Shield plates anchored to the bot's facing (plate 0 dead ahead): intact
   * plates draw solid, cracked plates split at the middle, broken plates
   * leave a faint ghost so the exposed side stays readable.
   */
  private drawShieldSegments(g: Graphics, bot: DotBotEntity, color: number, fade: number): void {
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
          color: 0x111111,
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
