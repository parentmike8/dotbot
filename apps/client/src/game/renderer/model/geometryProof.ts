import { Container, Graphics } from "pixi.js";
import {
  circlePoints,
  filletCorners,
  pathOutline,
  polygonBounds,
  separateCircleFromSolid,
  thickenPath,
  type Solid,
} from "@dotbot/game/geometry";
import type { Vec2 } from "@dotbot/game/types";
import {
  AO_ALPHA,
  contactShape,
  MAT,
  SHADOW_ALPHA,
  V,
  volumeShape,
  type ShadowPad,
} from "./tone";

/**
 * Proof that the world is no longer made of rectangles.
 *
 * Every structure here is authored the way the map source format will express
 * it — polygons and thick paths, with curves declared as fillets or arcs and
 * tessellated by the kernel — and drawn by exactly the same lit-model language as
 * Lot 6. Collision comes from the same kernel: the walking test below pushes a
 * bot-sized circle along a line and records where it is actually stopped, so the
 * drawn shape and the collider can be compared by eye.
 *
 * Nothing here is content. It is a rig for checking that geometry, shading and
 * collision agree before any of it is authored into the real city.
 */

export type GeometryProof = { view: Container; bounds: { x: number; y: number; w: number; h: number } };

type Structure = {
  label: string;
  /** Closed outlines drawn as extruded volumes. */
  masses?: Vec2[][];
  /** Open or closed wall paths, drawn thick and collided as capsules. */
  walls?: Array<{ points: Vec2[]; thickness: number; closed?: boolean }>;
  /** Where the walking test starts and which way it pushes. */
  probe?: { from: Vec2; to: Vec2 };
};

const WALL_MAT = { top: V.wallCap, front: V.wall, edge: 0x0b0e11, lit: 0x565c63 };

function ell(x: number, y: number): Vec2[] {
  // An L-plan building: the shape most real corner sites actually are.
  return [
    { x, y },
    { x: x + 300, y },
    { x: x + 300, y: y + 130 },
    { x: x + 130, y: y + 130 },
    { x: x + 130, y: y + 280 },
    { x, y: y + 280 },
  ];
}

function chamfered(x: number, y: number): Vec2[] {
  // A corner block with its street corner cut off, then softened.
  return filletCorners([
    { x: x + 70, y },
    { x: x + 260, y },
    { x: x + 260, y: y + 240 },
    { x, y: y + 240 },
    { x, y: y + 70 },
  ], 26, true, 4);
}

function hull(x: number, y: number): Vec2[] {
  // A ship: pointed bow, parallel midbody, transom stern.
  return filletCorners([
    { x: x + 190, y: y + 8 },
    { x: x + 240, y: y + 60 },
    { x: x + 250, y: y + 150 },
    { x: x + 230, y: y + 250 },
    { x: x + 150, y: y + 300 },
    { x: x + 60, y: y + 300 },
    { x: x + 12, y: y + 250 },
    { x: x + 6, y: y + 120 },
    { x: x + 60, y: y + 26 },
  ], 20, true, 4);
}

const STRUCTURES: Structure[] = [
  {
    label: "L-PLAN BLOCK",
    masses: [ell(60, 60)],
    probe: { from: { x: 250, y: 200 }, to: { x: 250, y: 420 } },
  },
  {
    label: "CHAMFERED CORNER",
    masses: [chamfered(440, 60)],
    probe: { from: { x: 420, y: 90 }, to: { x: 560, y: 190 } },
  },
  {
    label: "ROUND TOWER",
    masses: [circlePoints({ x: 880, y: 190 }, 120, 28)],
    probe: { from: { x: 700, y: 190 }, to: { x: 900, y: 190 } },
  },
  {
    label: "ANGLED + CURVED WALLS",
    walls: [
      { points: [{ x: 1080, y: 70 }, { x: 1330, y: 200 }, { x: 1330, y: 320 }], thickness: 14 },
      {
        points: filletCorners(
          [{ x: 1080, y: 320 }, { x: 1080, y: 180 }, { x: 1210, y: 180 }],
          90,
          false,
          10,
        ),
        thickness: 12,
      },
    ],
    probe: { from: { x: 1150, y: 60 }, to: { x: 1260, y: 260 } },
  },
  {
    label: "SHIP HULL",
    masses: [hull(1440, 40)],
    probe: { from: { x: 1560, y: 20 }, to: { x: 1560, y: 200 } },
  },
];

/**
 * Walk a bot-sized circle toward a target, separating against every solid each
 * step. Where it stops is where the collider actually is — the honest check that
 * what is drawn is what blocks you.
 */
function walkProbe(g: Graphics, solids: Solid[], from: Vec2, to: Vec2, radius = 24): void {
  const steps = 90;
  let position = { ...from };
  const trail: Vec2[] = [{ ...position }];

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    position = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    for (let pass = 0; pass < 3; pass += 1) {
      for (const solid of solids) position = separateCircleFromSolid(position, radius, solid);
    }
    trail.push({ ...position });
  }

  g.moveTo(trail[0].x, trail[0].y);
  for (const point of trail.slice(1)) g.lineTo(point.x, point.y);
  g.stroke({ color: 0x22b8cf, width: 2.5, alpha: 0.9 });

  const end = trail.at(-1)!;
  g.circle(end.x, end.y, radius).stroke({ color: 0x22b8cf, width: 2 });
  g.circle(end.x, end.y, radius * 0.34).fill({ color: 0x14171a });
}

export function buildGeometryProof(): GeometryProof {
  const view = new Container();
  const ground = new Graphics();
  const structures = new Graphics();
  const probes = new Graphics();

  const pad: ShadowPad = SHADOW_ALPHA.map((alpha) => {
    const g = new Graphics();
    g.alpha = alpha;
    return g;
  });
  void AO_ALPHA;

  const all: Vec2[] = [];
  for (const structure of STRUCTURES) {
    for (const mass of structure.masses ?? []) all.push(...mass);
    for (const wall of structure.walls ?? []) all.push(...wall.points);
    if (structure.probe) all.push(structure.probe.from, structure.probe.to);
  }
  const bounds = polygonBounds(all);
  const sheet = { x: bounds.x - 60, y: bounds.y - 60, w: bounds.w + 120, h: bounds.h + 120 };
  ground.rect(sheet.x, sheet.y, sheet.w, sheet.h).fill({ color: V.slab });

  for (const structure of STRUCTURES) {
    const solids: Solid[] = [];

    for (const mass of structure.masses ?? []) {
      contactShape(pad, mass, 18);
      volumeShape(structures, mass, WALL_MAT, 12);
      // A mass collides as its own outline. Convex hulls collide exactly; an
      // L-plan is concave, so it is walled rather than filled — see below.
      solids.push(...thickenPath(mass, 6, true));
    }

    for (const wall of structure.walls ?? []) {
      const outline = pathOutline(wall.points, wall.thickness, wall.closed);
      contactShape(pad, outline, 12);
      volumeShape(structures, outline, WALL_MAT, 10);
      solids.push(...thickenPath(wall.points, wall.thickness, wall.closed));
    }

    if (structure.probe) walkProbe(probes, solids, structure.probe.from, structure.probe.to);
  }

  view.addChild(ground, ...pad, structures, probes);
  return { view, bounds: sheet };
}
