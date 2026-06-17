import { Application, Container, Graphics } from "pixi.js";
import { clamp, clamp01, colorToNumber } from "../math";
import type { DotBotEntity, GameSnapshot, MapDefinition, Vec2 } from "../types";

export class PixiGameRenderer {
  private readonly app: Application;
  private readonly worldLayer = new Container();
  private readonly mapGraphics = new Graphics();
  private readonly dynamicGraphics = new Graphics();
  private viewport = { width: 1, height: 1 };

  private constructor(app: Application) {
    this.app = app;
    this.app.stage.addChild(this.worldLayer);
    this.worldLayer.addChild(this.mapGraphics);
    this.worldLayer.addChild(this.dynamicGraphics);
  }

  static async create(host: HTMLElement, map: MapDefinition): Promise<PixiGameRenderer> {
    const app = new Application();

    await app.init({
      antialias: true,
      autoDensity: true,
      background: "#ffffff",
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });

    host.appendChild(app.canvas);
    const renderer = new PixiGameRenderer(app);
    renderer.resize(host.clientWidth, host.clientHeight);
    renderer.drawMap(map);

    return renderer;
  }

  resize(width: number, height: number): void {
    this.viewport = {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  }

  render(snapshot: GameSnapshot): void {
    const player = snapshot.bots.find((bot) => bot.id === snapshot.playerId) ?? snapshot.bots[0];
    const camera = this.getCamera(player?.position ?? { x: snapshot.map.width / 2, y: snapshot.map.height / 2 }, snapshot.map);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);
    this.dynamicGraphics.clear();
    this.drawDots(snapshot);
    this.drawBots(snapshot);
  }

  destroy(): void {
    this.app.destroy(true);
  }

  private getCamera(target: Vec2, map: MapDefinition): { x: number; y: number; scale: number } {
    const shortSide = Math.min(this.viewport.width, this.viewport.height);
    const scale = clamp(shortSide / 560, 0.58, 1.05);
    const visibleWidth = this.viewport.width / scale;
    const visibleHeight = this.viewport.height / scale;
    const centerX = clamp(target.x, visibleWidth / 2, map.width - visibleWidth / 2);
    const centerY = clamp(target.y, visibleHeight / 2, map.height - visibleHeight / 2);

    return {
      x: this.viewport.width / 2 - centerX * scale,
      y: this.viewport.height / 2 - centerY * scale,
      scale,
    };
  }

  private drawMap(map: MapDefinition): void {
    this.mapGraphics.clear();
    this.mapGraphics.rect(0, 0, map.width, map.height).fill({ color: 0xffffff });

    for (const zone of map.zones) {
      if (zone.kind === "road") {
        this.mapGraphics.rect(zone.x, zone.y, zone.w, zone.h).fill({ color: 0xf4f5f6 });
      }

      if (zone.kind === "park") {
        this.mapGraphics.roundRect(zone.x, zone.y, zone.w, zone.h, 16).fill({ color: 0xf8faf8 });
        this.mapGraphics.roundRect(zone.x, zone.y, zone.w, zone.h, 16).stroke({ color: 0xb8bfc5, width: 2 });
      }

      if (zone.kind === "building") {
        this.mapGraphics.roundRect(zone.x, zone.y, zone.w, zone.h, 8).fill({ color: 0xffffff });
        this.mapGraphics.roundRect(zone.x, zone.y, zone.w, zone.h, 8).stroke({ color: 0x1f2328, width: 2 });
      }
    }

    for (const wall of map.walls) {
      this.mapGraphics.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: 0x111111 });
    }

    for (let x = 160; x < map.width; x += 160) {
      this.mapGraphics.rect(x, 444, 48, 4).fill({ color: 0xd4d8dd, alpha: 0.8 });
      this.mapGraphics.rect(x, 560, 48, 4).fill({ color: 0xd4d8dd, alpha: 0.8 });
    }

    for (let y = 140; y < map.height; y += 150) {
      this.mapGraphics.rect(728, y, 4, 44).fill({ color: 0xd4d8dd, alpha: 0.8 });
      this.mapGraphics.rect(848, y, 4, 44).fill({ color: 0xd4d8dd, alpha: 0.8 });
    }
  }

  private drawDots(snapshot: GameSnapshot): void {
    for (const dot of snapshot.dots) {
      if (!dot.active) {
        continue;
      }

      this.dynamicGraphics.circle(dot.position.x, dot.position.y, dot.radius).fill({ color: colorToNumber(dot.color) });
      this.dynamicGraphics.circle(dot.position.x, dot.position.y, dot.radius).stroke({ color: 0x111111, width: 2 });

      const coverage = snapshot.coverages.find((item) => item.kind === "capture" && item.targetId === dot.id);
      if (coverage) {
        this.drawProgressRing(dot.position, dot.radius + 8, coverage.progressMs / coverage.durationMs, 0x111111, 3);
      }
    }
  }

  private drawBots(snapshot: GameSnapshot): void {
    const sorted = [...snapshot.bots].sort((a, b) => {
      if (a.state === b.state) {
        return a.position.y - b.position.y;
      }

      return a.state === "consumed" ? -1 : 1;
    });

    for (const bot of sorted) {
      if (bot.state === "consumed") {
        continue;
      }

      this.drawBotBody(bot, snapshot);
    }
  }

  private drawBotBody(bot: DotBotEntity, snapshot: GameSnapshot): void {
    const color = colorToNumber(bot.color);
    const radius = bot.state === "downed" ? bot.radius * 0.72 : bot.radius;
    const alpha = bot.state === "downed" ? 0.72 : 1;

    this.dynamicGraphics.circle(bot.position.x, bot.position.y, radius).fill({ color: 0xffffff, alpha });
    this.dynamicGraphics.circle(bot.position.x, bot.position.y, radius).stroke({ color, width: bot.state === "downed" ? 4 : 5, alpha });

    if (bot.state === "alive") {
      this.drawShieldSegments(bot, color);
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius * 0.32).fill({ color, alpha: 0.92 });
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius * 0.32).stroke({ color: 0x111111, width: 1.5 });
    } else {
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, radius * 0.5).stroke({ color: 0x111111, width: 2, alpha: 0.65 });
    }

    if (bot.dashActiveMs > 0) {
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius + 9).stroke({ color, width: 3, alpha: 0.45 });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius + 13).stroke({ color: 0x111111, width: 2, alpha: 0.18 });
    }

    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      this.drawProgressRing(
        bot.position,
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        coverage.kind === "revive" ? 0x2f80ed : 0xeb5757,
        5,
      );
    }
  }

  private drawShieldSegments(bot: DotBotEntity, color: number): void {
    const start = -Math.PI / 2;
    const gap = 0.2;
    const segment = (Math.PI * 2 - gap * 3) / 3;

    for (let index = 0; index < bot.maxShields; index += 1) {
      const angleStart = start + index * (segment + gap);
      const angleEnd = angleStart + segment;
      const filled = index < bot.shields;
      this.dynamicGraphics
        .arc(bot.position.x, bot.position.y, bot.radius + 6, angleStart, angleEnd)
        .stroke({ color: filled ? color : 0x111111, width: filled ? 6 : 2, alpha: filled ? 1 : 0.35 });
    }
  }

  private drawProgressRing(center: Vec2, radius: number, progress: number, color: number, width: number): void {
    const clamped = clamp01(progress);
    this.dynamicGraphics
      .arc(center.x, center.y, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2)
      .stroke({ color, width, alpha: 0.95 });
  }
}
