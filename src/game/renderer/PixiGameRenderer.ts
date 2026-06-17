import { Application, Container, Graphics, Text } from "pixi.js";
import { clamp, clamp01, colorToNumber } from "../math";
import type { DotBotEntity, GameSnapshot, MapDefinition, MapZone, Vec2, Wall } from "../types";

const COLOR = {
  ground: 0xffffff,
  border: 0xe6e9ec,

  road: 0xe9ecef,
  roadCurb: 0xc6ccd3,
  laneDash: 0xccd1d8,
  crosswalk: 0xdce0e5,

  sidewalk: 0xf2f4f6,
  sidewalkLine: 0xe2e6ea,

  parkGrass: 0xeaf0ea,
  parkEdge: 0xb7c2b7,
  path: 0xf0eee8,

  roof: 0xf4f6f8,
  roofSeam: 0xe4e7eb,
  roofUnit: 0xd7dce1,

  floor: 0xfbfcfd,
  floorSeam: 0xeef1f4,

  wall: 0x111317,
  glass: 0xe7ecf1,

  object: 0x2c3137,
  objectFill: 0xf7f8fa,

  hedge: 0xe5ece5,
  hedgeEdge: 0xacbaac,
  tree: 0xedf1ec,
  treeEdge: 0xb2bdb1,
  treeDetail: 0x98a698,

  label: 0x9aa1a8,
} as const;

type BuildingView = {
  zone: MapZone;
  roof: Graphics;
  interior: Graphics;
  shell: Graphics;
};

export class PixiGameRenderer {
  private readonly app: Application;
  private readonly worldLayer = new Container();
  private readonly groundGfx = new Graphics();
  private readonly outdoorGfx = new Graphics();
  private readonly buildingsLayer = new Container();
  private readonly labelsLayer = new Container();
  private readonly dynamicGraphics = new Graphics();

  private buildingViews: BuildingView[] = [];
  private map: MapDefinition;
  private viewport = { width: 1, height: 1 };
  private currentBuildingId: string | null = null;
  private seed = 0x1a2b3c;

  private constructor(app: Application, map: MapDefinition) {
    this.app = app;
    this.map = map;
    this.app.stage.addChild(this.worldLayer);
    this.worldLayer.addChild(
      this.groundGfx,
      this.outdoorGfx,
      this.buildingsLayer,
      this.labelsLayer,
      this.dynamicGraphics,
    );
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
    const renderer = new PixiGameRenderer(app, map);
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
    const center = player?.position ?? { x: snapshot.map.width / 2, y: snapshot.map.height / 2 };
    const camera = this.getCamera(center, snapshot.map);

    this.worldLayer.scale.set(camera.scale);
    this.worldLayer.position.set(camera.x, camera.y);

    this.currentBuildingId = player ? this.buildingAt(player.position) : null;
    this.updateInteriorVisibility();

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

  // ---------------------------------------------------------------------------
  // Static map construction
  // ---------------------------------------------------------------------------

  private drawMap(map: MapDefinition): void {
    this.map = map;
    this.seed = 0x1a2b3c;
    this.groundGfx.clear();
    this.outdoorGfx.clear();
    this.buildingsLayer.removeChildren();
    this.labelsLayer.removeChildren();
    this.buildingViews = [];

    this.drawGround();
    this.drawOutdoor();
    this.buildBuildings();
  }

  private rand(): number {
    this.seed = (1664525 * this.seed + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  private zone(id: string): MapZone | undefined {
    return this.map.zones.find((item) => item.id === id);
  }

  private buildingAt(position: Vec2): string | null {
    for (const zone of this.map.zones) {
      if (zone.kind !== "building") {
        continue;
      }

      const inset = 6;
      if (
        position.x >= zone.x + inset &&
        position.x <= zone.x + zone.w - inset &&
        position.y >= zone.y + inset &&
        position.y <= zone.y + zone.h - inset
      ) {
        return zone.id;
      }
    }

    return null;
  }

  // --- Ground: base, roads, sidewalks, park ----------------------------------

  private drawGround(): void {
    const g = this.groundGfx;
    const { width, height } = this.map;

    g.rect(0, 0, width, height).fill({ color: COLOR.ground });

    this.drawSidewalkBands();
    this.drawBuildingPads();
    this.drawParkGround();
    this.drawRoads();
    this.drawBorder();
  }

  private roadZones(): MapZone[] {
    return this.map.zones.filter((zone) => zone.kind === "road");
  }

  private drawSidewalkBands(): void {
    const g = this.groundGfx;
    const band = 18;

    // Sidewalk borders that hug each road. Roads are drawn afterwards and cover
    // any overlap, so we can be generous along the edges.
    for (const road of this.roadZones()) {
      const horizontal = road.w >= road.h;
      if (horizontal) {
        g.rect(road.x, road.y - band, road.w, band).fill({ color: COLOR.sidewalk });
        g.rect(road.x, road.y + road.h, road.w, band).fill({ color: COLOR.sidewalk });
      } else {
        g.rect(road.x - band, road.y, band, road.h).fill({ color: COLOR.sidewalk });
        g.rect(road.x + road.w, road.y, band, road.h).fill({ color: COLOR.sidewalk });
      }
    }

    // Expansion-joint ticks along the horizontal road sidewalks.
    const hRoad = this.roadZones().find((road) => road.w >= road.h);
    if (hRoad) {
      for (let x = hRoad.x + 40; x < hRoad.x + hRoad.w; x += 64) {
        g.rect(x, hRoad.y - band, 2, band).fill({ color: COLOR.sidewalkLine });
        g.rect(x, hRoad.y + hRoad.h, 2, band).fill({ color: COLOR.sidewalkLine });
      }
    }

    const vRoad = this.roadZones().find((road) => road.h > road.w);
    if (vRoad) {
      for (let y = vRoad.y + 40; y < vRoad.y + vRoad.h; y += 64) {
        g.rect(vRoad.x - band, y, band, 2).fill({ color: COLOR.sidewalkLine });
        g.rect(vRoad.x + vRoad.w, y, band, 2).fill({ color: COLOR.sidewalkLine });
      }
    }
  }

  private drawBuildingPads(): void {
    const g = this.groundGfx;
    const pad = 16;

    for (const zone of this.map.zones) {
      if (zone.kind !== "building") {
        continue;
      }

      g.roundRect(zone.x - pad, zone.y - pad, zone.w + pad * 2, zone.h + pad * 2, 10).fill({
        color: COLOR.sidewalk,
      });
      g.roundRect(zone.x - pad, zone.y - pad, zone.w + pad * 2, zone.h + pad * 2, 10).stroke({
        color: COLOR.sidewalkLine,
        width: 2,
      });
    }
  }

  private drawParkGround(): void {
    const park = this.zone("west-park");
    if (!park) {
      return;
    }

    const g = this.groundGfx;
    g.roundRect(park.x, park.y, park.w, park.h, 14).fill({ color: COLOR.parkGrass });
    g.roundRect(park.x, park.y, park.w, park.h, 14).stroke({ color: COLOR.parkEdge, width: 2 });

    // A simple diagonal path across the park.
    g.moveTo(park.x + 24, park.y + park.h - 24)
      .lineTo(park.x + park.w - 28, park.y + 30)
      .stroke({ color: COLOR.path, width: 16, cap: "round" });
  }

  private drawRoads(): void {
    const g = this.groundGfx;
    const roads = this.roadZones();

    for (const road of roads) {
      g.rect(road.x, road.y, road.w, road.h).fill({ color: COLOR.road });
    }

    const hRoad = roads.find((road) => road.w >= road.h);
    const vRoad = roads.find((road) => road.h > road.w);

    // Intersection rectangle (where the two roads overlap) is left unmarked.
    const inter =
      hRoad && vRoad
        ? { x: vRoad.x, y: hRoad.y, w: vRoad.w, h: hRoad.h }
        : null;

    // Curbs along road edges, broken at the intersection.
    if (hRoad) {
      this.drawCurbRun(hRoad.x, hRoad.y, hRoad.x + hRoad.w, hRoad.y, inter, true);
      this.drawCurbRun(hRoad.x, hRoad.y + hRoad.h, hRoad.x + hRoad.w, hRoad.y + hRoad.h, inter, true);
    }
    if (vRoad) {
      this.drawCurbRun(vRoad.x, vRoad.y, vRoad.x, vRoad.y + vRoad.h, inter, false);
      this.drawCurbRun(vRoad.x + vRoad.w, vRoad.y, vRoad.x + vRoad.w, vRoad.y + vRoad.h, inter, false);
    }

    // Centre lane dashes.
    if (hRoad) {
      const cy = hRoad.y + hRoad.h / 2;
      this.drawDashRun(hRoad.x + 14, hRoad.x + hRoad.w - 14, cy, inter, true);
    }
    if (vRoad) {
      const cx = vRoad.x + vRoad.w / 2;
      this.drawDashRun(vRoad.y + 14, vRoad.y + vRoad.h - 14, cx, inter, false);
    }

    // Crosswalks at the four mouths of the intersection.
    if (inter) {
      this.drawCrosswalks(inter);
    }
  }

  private drawCurbRun(x1: number, y1: number, x2: number, y2: number, inter: { x: number; y: number; w: number; h: number } | null, horizontal: boolean): void {
    const g = this.groundGfx;
    const thickness = 3;

    if (horizontal) {
      const segments = inter ? [[x1, inter.x], [inter.x + inter.w, x2]] : [[x1, x2]];
      for (const [start, end] of segments) {
        if (end - start > 0) {
          g.rect(start, y1 - thickness / 2, end - start, thickness).fill({ color: COLOR.roadCurb });
        }
      }
    } else {
      const segments = inter ? [[y1, inter.y], [inter.y + inter.h, y2]] : [[y1, y2]];
      for (const [start, end] of segments) {
        if (end - start > 0) {
          g.rect(x1 - thickness / 2, start, thickness, end - start).fill({ color: COLOR.roadCurb });
        }
      }
    }
  }

  private drawDashRun(start: number, end: number, cross: number, inter: { x: number; y: number; w: number; h: number } | null, horizontal: boolean): void {
    const g = this.groundGfx;
    const dash = 26;
    const gap = 22;
    const thickness = 4;

    for (let pos = start; pos < end; pos += dash + gap) {
      const segEnd = Math.min(pos + dash, end);

      if (horizontal) {
        if (inter && segEnd > inter.x && pos < inter.x + inter.w) {
          continue;
        }
        g.rect(pos, cross - thickness / 2, segEnd - pos, thickness).fill({ color: COLOR.laneDash });
      } else {
        if (inter && segEnd > inter.y && pos < inter.y + inter.h) {
          continue;
        }
        g.rect(cross - thickness / 2, pos, thickness, segEnd - pos).fill({ color: COLOR.laneDash });
      }
    }
  }

  private drawCrosswalks(inter: { x: number; y: number; w: number; h: number }): void {
    const g = this.groundGfx;
    const stripe = 8;
    const gap = 10;
    const depth = 26;

    // West & east mouths: vertical stripes spanning the horizontal road height.
    for (const edgeX of [inter.x - depth, inter.x + inter.w]) {
      for (let i = 0; i < 3; i += 1) {
        const sx = edgeX + i * (stripe + gap);
        g.rect(sx, inter.y + 6, stripe, inter.h - 12).fill({ color: COLOR.crosswalk });
      }
    }

    // North & south mouths: horizontal stripes spanning the vertical road width.
    for (const edgeY of [inter.y - depth, inter.y + inter.h]) {
      for (let i = 0; i < 3; i += 1) {
        const sy = edgeY + i * (stripe + gap);
        g.rect(inter.x + 6, sy, inter.w - 12, stripe).fill({ color: COLOR.crosswalk });
      }
    }
  }

  private drawBorder(): void {
    const g = this.groundGfx;
    for (const wall of this.map.walls) {
      if (wall.id.includes("edge")) {
        g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: COLOR.border });
      }
    }
  }

  // --- Outdoor objects -------------------------------------------------------

  private drawOutdoor(): void {
    const g = this.outdoorGfx;

    for (const wall of this.map.walls) {
      if (wall.id.includes("hedge")) {
        this.drawHedge(g, wall);
      } else if (wall.id.includes("divider")) {
        this.drawMedian(g, wall);
      } else if (wall.id.includes("kiosk")) {
        this.drawKiosk(g, wall.x, wall.y, wall.w, wall.h);
      }
    }

    this.drawParkObjects();
    this.drawStreetTrees();
    this.drawParkingLot();
  }

  private drawParkObjects(): void {
    const park = this.zone("west-park");
    if (!park) {
      return;
    }

    const g = this.outdoorGfx;
    this.drawTree(g, park.x + 70, park.y + 92, 30);
    this.drawTree(g, park.x + 168, park.y + 64, 24);
    this.drawTree(g, park.x + 96, park.y + 182, 26);
    this.drawTree(g, park.x + 206, park.y + 158, 22);
    this.drawBench(g, park.x + 150, park.y + park.h - 46, 78, 20, false);
  }

  private drawStreetTrees(): void {
    const g = this.outdoorGfx;
    const hRoad = this.roadZones().find((road) => road.w >= road.h);
    const vRoad = this.roadZones().find((road) => road.h > road.w);
    if (!hRoad || !vRoad) {
      return;
    }

    const top = hRoad.y - 34;
    const bottom = hRoad.y + hRoad.h + 34;
    const left = vRoad.x - 34;
    const right = vRoad.x + vRoad.w + 34;

    // Trees tucked on the four corners of the central intersection.
    this.drawTree(g, left, top, 17);
    this.drawTree(g, right, top, 17);
    this.drawTree(g, left, bottom, 17);
    this.drawTree(g, right, bottom, 17);

    // A short avenue of trees along the south sidewalk.
    for (let x = vRoad.x + vRoad.w + 120; x < this.map.width - 120; x += 150) {
      this.drawTree(g, x, bottom, 16);
    }
  }

  private drawParkingLot(): void {
    const g = this.outdoorGfx;
    // Open block to the right of the office building.
    const lot = { x: 1150, y: 640, w: 250, h: 250 };

    g.roundRect(lot.x, lot.y, lot.w, lot.h, 8).fill({ color: COLOR.sidewalk });
    g.roundRect(lot.x, lot.y, lot.w, lot.h, 8).stroke({ color: COLOR.sidewalkLine, width: 2 });

    // Parking stall dividers.
    const stalls = 4;
    const stallW = lot.w / stalls;
    for (let i = 1; i < stalls; i += 1) {
      const x = lot.x + i * stallW;
      g.rect(x - 1.5, lot.y + 16, 3, lot.h - 32).fill({ color: COLOR.sidewalkLine });
    }

    this.drawCar(g, lot.x + stallW * 0.5 - 26, lot.y + 30, 52, 92, true);
    this.drawCar(g, lot.x + stallW * 2.5 - 26, lot.y + lot.h - 122, 52, 92, true);
  }

  // --- Buildings -------------------------------------------------------------

  private buildBuildings(): void {
    for (const zone of this.map.zones) {
      if (zone.kind !== "building") {
        continue;
      }

      const roof = new Graphics();
      const interior = new Graphics();
      const shell = new Graphics();

      const perimeter: Wall[] = [];
      const interiorWalls: Wall[] = [];

      for (const wall of this.map.walls) {
        if (this.wallZone(wall)?.id !== zone.id) {
          continue;
        }

        if (this.isPerimeterWall(wall, zone)) {
          perimeter.push(wall);
        } else {
          interiorWalls.push(wall);
        }
      }

      this.drawRoof(roof, zone);
      this.drawInterior(interior, zone, interiorWalls);
      this.drawShell(shell, perimeter);

      this.buildingsLayer.addChild(roof, interior, shell);
      this.buildingViews.push({ zone, roof, interior, shell });

      this.drawBuildingLabel(zone);
    }

    this.updateInteriorVisibility();
  }

  private wallZone(wall: Wall): MapZone | null {
    const cx = wall.x + wall.w / 2;
    const cy = wall.y + wall.h / 2;

    for (const zone of this.map.zones) {
      if (zone.kind !== "building") {
        continue;
      }

      if (cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h) {
        return zone;
      }
    }

    return null;
  }

  private isPerimeterWall(wall: Wall, zone: MapZone): boolean {
    const tol = 2;
    return (
      Math.abs(wall.x - zone.x) <= tol ||
      Math.abs(wall.x + wall.w - (zone.x + zone.w)) <= tol ||
      Math.abs(wall.y - zone.y) <= tol ||
      Math.abs(wall.y + wall.h - (zone.y + zone.h)) <= tol
    );
  }

  private drawRoof(g: Graphics, zone: MapZone): void {
    g.rect(zone.x, zone.y, zone.w, zone.h).fill({ color: COLOR.roof });

    // Parapet inset.
    g.roundRect(zone.x + 12, zone.y + 12, zone.w - 24, zone.h - 24, 4).stroke({
      color: COLOR.roofSeam,
      width: 2,
    });

    // A couple of seam lines to suggest roof panels.
    const seamX = zone.x + zone.w * 0.5;
    g.moveTo(seamX, zone.y + 14).lineTo(seamX, zone.y + zone.h - 14).stroke({ color: COLOR.roofSeam, width: 2 });

    // Rooftop service unit (HVAC).
    const ux = zone.x + zone.w - 86;
    const uy = zone.y + 30;
    g.rect(ux, uy, 54, 38).fill({ color: COLOR.roofUnit });
    g.rect(ux, uy, 54, 38).stroke({ color: COLOR.roofSeam, width: 2 });
    g.moveTo(ux + 18, uy).lineTo(ux + 18, uy + 38).stroke({ color: COLOR.roofSeam, width: 1.5 });
    g.moveTo(ux + 36, uy).lineTo(ux + 36, uy + 38).stroke({ color: COLOR.roofSeam, width: 1.5 });
  }

  private drawInterior(g: Graphics, zone: MapZone, interiorWalls: Wall[]): void {
    g.rect(zone.x, zone.y, zone.w, zone.h).fill({ color: COLOR.floor });

    // Faint floor seams.
    for (let x = zone.x + 80; x < zone.x + zone.w - 20; x += 80) {
      g.moveTo(x, zone.y + 10).lineTo(x, zone.y + zone.h - 10).stroke({ color: COLOR.floorSeam, width: 1.5 });
    }

    this.drawFurniture(g, zone);

    // Interior partitions / fixtures (collision geometry) drawn over furniture.
    for (const wall of interiorWalls) {
      const fixture = wall.id.includes("desk") || wall.id.includes("counter");
      if (fixture) {
        this.drawCounter(g, wall.x, wall.y, wall.w, wall.h);
      } else {
        g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: COLOR.wall });
      }
    }
  }

  private drawShell(g: Graphics, perimeter: Wall[]): void {
    for (const wall of perimeter) {
      g.rect(wall.x, wall.y, wall.w, wall.h).fill({ color: COLOR.wall });
    }

    for (const wall of perimeter) {
      this.drawWindowsOnWall(g, wall);
    }
  }

  private drawWindowsOnWall(g: Graphics, wall: Wall): void {
    const horizontal = wall.w >= wall.h;
    const span = horizontal ? wall.w : wall.h;
    const winLong = 30;
    const minGap = 26;
    const margin = 14;
    const usable = span - margin * 2;

    if (usable < winLong) {
      return;
    }

    const count = Math.max(1, Math.floor((usable + minGap) / (winLong + minGap)));
    const total = count * winLong + (count - 1) * minGap;
    const start = (span - total) / 2;

    for (let i = 0; i < count; i += 1) {
      const offset = start + i * (winLong + minGap);

      const wx = horizontal ? wall.x + offset : wall.x;
      const wy = horizontal ? wall.y : wall.y + offset;
      const ww = horizontal ? winLong : wall.w;
      const wh = horizontal ? wall.h : winLong;

      g.rect(wx, wy, ww, wh).fill({ color: COLOR.glass });
      g.rect(wx, wy, ww, wh).stroke({ color: COLOR.wall, width: 2 });

      if (horizontal) {
        g.moveTo(wx + ww / 2, wy).lineTo(wx + ww / 2, wy + wh).stroke({ color: COLOR.wall, width: 1.5 });
      } else {
        g.moveTo(wx, wy + wh / 2).lineTo(wx + ww, wy + wh / 2).stroke({ color: COLOR.wall, width: 1.5 });
      }
    }
  }

  private drawBuildingLabel(zone: MapZone): void {
    if (!zone.label) {
      return;
    }

    const label = new Text({
      text: zone.label.toUpperCase(),
      style: {
        fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
        fontSize: 17,
        fontWeight: "700",
        letterSpacing: 3,
        fill: COLOR.label,
      },
    });
    label.resolution = 2;
    label.anchor.set(0.5, 0);
    label.position.set(zone.x + zone.w / 2, zone.y + 22);
    this.labelsLayer.addChild(label);
  }

  private drawFurniture(g: Graphics, zone: MapZone): void {
    switch (zone.id) {
      case "clinic-zone":
        this.drawClinicFurniture(g, zone);
        break;
      case "office-zone":
        this.drawOfficeFurniture(g, zone);
        break;
      case "depot-zone":
        this.drawDepotFurniture(g, zone);
        break;
      default:
        break;
    }
  }

  private drawClinicFurniture(g: Graphics, zone: MapZone): void {
    const { x, y } = zone;
    // Left exam room.
    this.drawBed(g, x + 40, y + 110, 88, 46, "right");
    // Waiting chairs near reception.
    this.drawChair(g, x + 44, y + 196, 22);
    this.drawChair(g, x + 78, y + 196, 22);
    // Ward beds against the right wall.
    this.drawBed(g, x + 330, y + 44, 88, 46, "right");
    this.drawBed(g, x + 330, y + 180, 88, 46, "right");
    // Medical cabinet + plant.
    this.drawCabinet(g, x + 196, y + 40, 44, 26);
    this.drawPlant(g, x + 392, y + 226, 15);
  }

  private drawOfficeFurniture(g: Graphics, zone: MapZone): void {
    const { x, y } = zone;
    // Desk floor on the left.
    this.drawDesk(g, x + 30, y + 48, 96, 46, "down");
    this.drawDesk(g, x + 30, y + 140, 96, 46, "up");
    // Meeting table top-right.
    this.drawTable(g, x + 196, y + 44, 128, 74);
    // Server rack + desk bottom-right.
    this.drawServerRack(g, x + 312, y + 150, 62, 34);
    this.drawDesk(g, x + 196, y + 168, 96, 46, "down");
    this.drawPlant(g, x + 386, y + 220, 15);
  }

  private drawDepotFurniture(g: Graphics, zone: MapZone): void {
    const { x, y } = zone;
    // Crate stacks between the storage bays.
    this.drawCrateStack(g, x + 44, y + 48);
    this.drawCrateStack(g, x + 132, y + 60);
    this.drawCrateStack(g, x + 250, y + 40);
    // Pallet rack along the right wall + workbench.
    this.drawShelf(g, x + 306, y + 40, 26, 150, true);
    this.drawWorkbench(g, x + 150, y + 232, 128, 38);
    this.drawCrateStack(g, x + 40, y + 224);
  }

  private updateInteriorVisibility(): void {
    for (const view of this.buildingViews) {
      const inside = view.zone.id === this.currentBuildingId;
      view.roof.visible = !inside;
      view.interior.visible = inside;
    }
  }

  // ---------------------------------------------------------------------------
  // Object glyphs (black/gray line art, top-down)
  // ---------------------------------------------------------------------------

  private objStroke(width = 2): { color: number; width: number } {
    return { color: COLOR.object, width };
  }

  private drawTree(g: Graphics, cx: number, cy: number, r: number): void {
    g.circle(cx, cy, r).fill({ color: COLOR.tree });
    g.circle(cx, cy, r).stroke({ color: COLOR.treeEdge, width: 2 });

    for (let i = 0; i < 7; i += 1) {
      const angle = (Math.PI * 2 * i) / 7;
      const inner = r * 0.42;
      const outer = r * 0.82;
      g.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
        .lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        .stroke({ color: COLOR.treeDetail, width: 1.5 });
    }

    g.circle(cx, cy, Math.max(2, r * 0.16)).fill({ color: COLOR.treeDetail });
  }

  private drawBench(g: Graphics, x: number, y: number, w: number, h: number, vertical: boolean): void {
    g.roundRect(x, y, w, h, 4).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 4).stroke(this.objStroke());

    if (vertical) {
      g.moveTo(x + w / 2, y + 3).lineTo(x + w / 2, y + h - 3).stroke(this.objStroke(1.5));
    } else {
      g.moveTo(x + 3, y + h / 2).lineTo(x + w - 3, y + h / 2).stroke(this.objStroke(1.5));
    }
  }

  private drawCar(g: Graphics, x: number, y: number, w: number, h: number, vertical: boolean): void {
    g.roundRect(x, y, w, h, 10).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 10).stroke(this.objStroke(2));

    if (vertical) {
      // Cabin / roof panel.
      g.roundRect(x + w * 0.16, y + h * 0.32, w * 0.68, h * 0.4, 6).stroke(this.objStroke(1.5));
      // Windshield.
      g.moveTo(x + w * 0.2, y + h * 0.28).lineTo(x + w * 0.8, y + h * 0.28).stroke(this.objStroke(1.5));
      // Side mirrors.
      g.rect(x - 3, y + h * 0.3, 4, 6).fill({ color: COLOR.object });
      g.rect(x + w - 1, y + h * 0.3, 4, 6).fill({ color: COLOR.object });
    } else {
      g.roundRect(x + w * 0.32, y + h * 0.16, w * 0.4, h * 0.68, 6).stroke(this.objStroke(1.5));
      g.moveTo(x + w * 0.28, y + h * 0.2).lineTo(x + w * 0.28, y + h * 0.8).stroke(this.objStroke(1.5));
    }
  }

  private drawKiosk(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.roundRect(x, y, w, h, 4).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 4).stroke(this.objStroke());
    // Service counter line.
    g.moveTo(x + 6, y + h - 6).lineTo(x + w - 6, y + h - 6).stroke(this.objStroke(1.5));
    // Terminal mark.
    g.rect(x + w / 2 - 7, y + 5, 14, 9).stroke(this.objStroke(1.5));
  }

  private drawHedge(g: Graphics, wall: Wall): void {
    g.roundRect(wall.x, wall.y, wall.w, wall.h, 5).fill({ color: COLOR.hedge });
    g.roundRect(wall.x, wall.y, wall.w, wall.h, 5).stroke({ color: COLOR.hedgeEdge, width: 2 });

    const horizontal = wall.w >= wall.h;
    if (horizontal) {
      for (let x = wall.x + 10; x < wall.x + wall.w - 6; x += 16) {
        g.circle(x, wall.y + wall.h / 2, 3).stroke({ color: COLOR.hedgeEdge, width: 1.25 });
      }
    } else {
      for (let y = wall.y + 10; y < wall.y + wall.h - 6; y += 16) {
        g.circle(wall.x + wall.w / 2, y, 3).stroke({ color: COLOR.hedgeEdge, width: 1.25 });
      }
    }
  }

  private drawMedian(g: Graphics, wall: Wall): void {
    g.roundRect(wall.x, wall.y, wall.w, wall.h, wall.h / 2).fill({ color: COLOR.sidewalk });
    g.roundRect(wall.x, wall.y, wall.w, wall.h, wall.h / 2).stroke({ color: COLOR.roadCurb, width: 2 });
    g.moveTo(wall.x + 8, wall.y + wall.h / 2).lineTo(wall.x + wall.w - 8, wall.y + wall.h / 2).stroke({
      color: COLOR.laneDash,
      width: 2,
    });
  }

  private drawPlant(g: Graphics, cx: number, cy: number, r: number): void {
    g.circle(cx, cy, r).fill({ color: COLOR.objectFill });
    g.circle(cx, cy, r).stroke(this.objStroke());
    for (let i = 0; i < 5; i += 1) {
      const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      g.moveTo(cx, cy)
        .lineTo(cx + Math.cos(angle) * r * 0.7, cy + Math.sin(angle) * r * 0.7)
        .stroke(this.objStroke(1.25));
    }
  }

  private drawBed(g: Graphics, x: number, y: number, w: number, h: number, pillow: "left" | "right"): void {
    g.roundRect(x, y, w, h, 6).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 6).stroke(this.objStroke());

    const pillowW = w * 0.22;
    const px = pillow === "left" ? x + 5 : x + w - pillowW - 5;
    g.roundRect(px, y + 6, pillowW, h - 12, 4).stroke(this.objStroke(1.5));
    // Blanket fold line.
    const foldX = pillow === "left" ? x + w * 0.42 : x + w * 0.58;
    g.moveTo(foldX, y + 4).lineTo(foldX, y + h - 4).stroke(this.objStroke(1.5));
  }

  private drawChair(g: Graphics, cx: number, cy: number, s: number): void {
    g.roundRect(cx - s / 2, cy - s / 2, s, s, 4).fill({ color: COLOR.objectFill });
    g.roundRect(cx - s / 2, cy - s / 2, s, s, 4).stroke(this.objStroke(1.5));
    g.moveTo(cx - s / 2 + 3, cy - s / 2 + 4).lineTo(cx + s / 2 - 3, cy - s / 2 + 4).stroke(this.objStroke(1.5));
  }

  private drawCabinet(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.rect(x, y, w, h).fill({ color: COLOR.objectFill });
    g.rect(x, y, w, h).stroke(this.objStroke());
    // Cross mark.
    const cx = x + w / 2;
    const cy = y + h / 2;
    g.moveTo(cx, cy - 6).lineTo(cx, cy + 6).stroke(this.objStroke(1.5));
    g.moveTo(cx - 6, cy).lineTo(cx + 6, cy).stroke(this.objStroke(1.5));
  }

  private drawDesk(g: Graphics, x: number, y: number, w: number, h: number, chair: "up" | "down"): void {
    const deskH = h * 0.6;
    const deskY = chair === "down" ? y : y + h - deskH;
    g.roundRect(x, deskY, w, deskH, 4).fill({ color: COLOR.objectFill });
    g.roundRect(x, deskY, w, deskH, 4).stroke(this.objStroke());

    const chairSize = h * 0.32;
    const chairY = chair === "down" ? y + h - chairSize : y;
    g.roundRect(x + w / 2 - chairSize / 2, chairY, chairSize, chairSize, 5).stroke(this.objStroke(1.5));
  }

  private drawTable(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.roundRect(x, y, w, h, 8).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 8).stroke(this.objStroke());

    // Chairs around the table.
    for (const cx of [x + w * 0.28, x + w * 0.72]) {
      g.roundRect(cx - 11, y - 16, 22, 12, 4).stroke(this.objStroke(1.5));
      g.roundRect(cx - 11, y + h + 4, 22, 12, 4).stroke(this.objStroke(1.5));
    }
  }

  private drawServerRack(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.rect(x, y, w, h).fill({ color: COLOR.objectFill });
    g.rect(x, y, w, h).stroke(this.objStroke());
    for (let sy = y + 6; sy < y + h - 3; sy += 7) {
      g.moveTo(x + 4, sy).lineTo(x + w - 4, sy).stroke(this.objStroke(1.25));
    }
  }

  private drawShelf(g: Graphics, x: number, y: number, w: number, h: number, vertical: boolean): void {
    g.rect(x, y, w, h).fill({ color: COLOR.objectFill });
    g.rect(x, y, w, h).stroke(this.objStroke());

    if (vertical) {
      for (let sy = y + h / 4; sy < y + h; sy += h / 4) {
        g.moveTo(x, sy).lineTo(x + w, sy).stroke(this.objStroke(1.25));
      }
    } else {
      for (let sx = x + w / 4; sx < x + w; sx += w / 4) {
        g.moveTo(sx, y).lineTo(sx, y + h).stroke(this.objStroke(1.25));
      }
    }
  }

  private drawCrateStack(g: Graphics, x: number, y: number): void {
    g.rect(x, y, 44, 44).fill({ color: COLOR.objectFill });
    g.rect(x, y, 44, 44).stroke(this.objStroke());
    g.moveTo(x, y).lineTo(x + 44, y + 44).stroke(this.objStroke(1.25));
    g.moveTo(x + 44, y).lineTo(x, y + 44).stroke(this.objStroke(1.25));

    g.rect(x + 24, y - 22, 32, 32).fill({ color: COLOR.objectFill });
    g.rect(x + 24, y - 22, 32, 32).stroke(this.objStroke());
  }

  private drawWorkbench(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.rect(x, y, w, h).fill({ color: COLOR.objectFill });
    g.rect(x, y, w, h).stroke(this.objStroke());
    g.moveTo(x, y + h * 0.5).lineTo(x + w, y + h * 0.5).stroke(this.objStroke(1.25));
    // Tool marks.
    g.circle(x + 14, y + h * 0.28, 3).stroke(this.objStroke(1.25));
    g.rect(x + w - 24, y + 6, 16, 6).stroke(this.objStroke(1.25));
  }

  private drawCounter(g: Graphics, x: number, y: number, w: number, h: number): void {
    g.roundRect(x, y, w, h, 4).fill({ color: COLOR.objectFill });
    g.roundRect(x, y, w, h, 4).stroke(this.objStroke());
    const horizontal = w >= h;
    if (horizontal) {
      g.moveTo(x + 4, y + h / 2).lineTo(x + w - 4, y + h / 2).stroke(this.objStroke(1.25));
    } else {
      g.moveTo(x + w / 2, y + 4).lineTo(x + w / 2, y + h - 4).stroke(this.objStroke(1.25));
    }
  }

  // ---------------------------------------------------------------------------
  // Dynamic entities
  // ---------------------------------------------------------------------------

  private drawDots(snapshot: GameSnapshot): void {
    for (const dot of snapshot.dots) {
      if (!dot.active) {
        continue;
      }

      if (this.buildingAt(dot.position) !== this.currentBuildingId) {
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

      if (bot.id !== snapshot.playerId && this.buildingAt(bot.position) !== this.currentBuildingId) {
        continue;
      }

      this.drawBotBody(bot, snapshot);
    }
  }

  private drawBotBody(bot: DotBotEntity, snapshot: GameSnapshot): void {
    const color = colorToNumber(bot.color);
    const coreRadius = bot.state === "downed" ? bot.radius * 0.34 : bot.radius * 0.4;
    const alpha = bot.state === "downed" ? 0.72 : 1;

    if (bot.state === "alive") {
      this.drawShieldSegments(bot, color);
    } else {
      this.drawShieldSegments(bot, 0x111111);
    }

    this.dynamicGraphics.circle(bot.position.x, bot.position.y, coreRadius).fill({ color, alpha: bot.state === "downed" ? 0.28 : 0.95 });
    this.dynamicGraphics.circle(bot.position.x, bot.position.y, coreRadius).stroke({ color: 0x111111, width: 2, alpha });

    if (bot.dashActiveMs > 0) {
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius - 1).stroke({ color, width: 3, alpha: 0.45 });
    }

    if (bot.invulnerabilityMs > 0 && bot.state === "alive") {
      this.dynamicGraphics.circle(bot.position.x, bot.position.y, bot.radius - 3).stroke({ color: 0x111111, width: 2, alpha: 0.18 });
    }

    const coverage = snapshot.coverages.find((item) => item.targetId === bot.id && item.kind !== "capture");
    if (coverage) {
      this.drawProgressRing(
        bot.position,
        bot.radius + 15,
        coverage.progressMs / coverage.durationMs,
        coverage.kind === "revive" ? 0x2f80ed : 0xeb5757,
        4,
      );
    }
  }

  private drawShieldSegments(bot: DotBotEntity, color: number): void {
    const start = -Math.PI / 2;
    const gap = 0.24;
    const segment = (Math.PI * 2 - gap * 3) / 3;
    const shieldRadius = bot.radius * 0.78;
    const filledWidth = bot.state === "downed" ? 2 : 5;
    const emptyWidth = 2;

    for (let index = 0; index < bot.maxShields; index += 1) {
      const angleStart = start + index * (segment + gap);
      const angleEnd = angleStart + segment;
      const filled = index < bot.shields;
      this.drawArcStroke(bot.position, shieldRadius, angleStart, angleEnd, {
        color: filled ? color : 0x111111,
        width: filled ? filledWidth : emptyWidth,
        alpha: filled ? 1 : 0.3,
      });
    }
  }

  private drawProgressRing(center: Vec2, radius: number, progress: number, color: number, width: number): void {
    const clamped = clamp01(progress);
    this.drawArcStroke(center, radius, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2, {
      color,
      width,
      alpha: 0.95,
    });
  }

  private drawArcStroke(
    center: Vec2,
    radius: number,
    startAngle: number,
    endAngle: number,
    stroke: { color: number; width: number; alpha: number },
  ): void {
    this.dynamicGraphics
      .beginPath()
      .moveTo(center.x + Math.cos(startAngle) * radius, center.y + Math.sin(startAngle) * radius)
      .arc(center.x, center.y, radius, startAngle, endAngle)
      .stroke(stroke);
  }
}
