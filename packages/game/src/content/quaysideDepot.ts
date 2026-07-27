import { compileBuilding, type SourceBuilding } from "../mapSource";
import { arcPoints, thickenPath } from "../geometry";
import { OUTDOOR_FLOOR_ID } from "../types";
import type { MapDocument } from "../types";

/**
 * Quayside Depot — the first building authored in the map source format.
 *
 * It exists to prove what the old pipeline could not express, in one place:
 *
 *  - an L-plan shell with one corner chamfered and rounded off;
 *  - a roll-up and a person door placed by anchor point, not arc length;
 *  - glazing along an elevation, in the same wall as the openings;
 *  - an interior partition running at a diagonal, with its own doorway;
 *  - a curved partition, authored as a corner radius;
 *  - a quay wall outside the building, following a real curve.
 *
 * Everything here compiles through `compileBuilding`, collides through the
 * geometry kernel and draws in the lit-model language with no special cases.
 */

export const QUAY_SOURCE: SourceBuilding = {
  id: "quay",
  kind: "warehouse",
  name: "QUAYSIDE DEPOT",
  shellThickness: 14,
  outline: {
    shape: "polygon",
    points: [
      { x: 240, y: 200 },
      { x: 900, y: 200 },
      // The corner facing the turning circle is cut back and rounded.
      { x: 980, y: 320, r: 70 },
      { x: 980, y: 700 },
      { x: 600, y: 700, r: 60 },
      { x: 600, y: 980 },
      { x: 240, y: 980 },
    ],
  },
  stairs: [{
    id: "quay-stair",
    rect: { x: 300, y: 800, w: 88, h: 148 },
    from: "GROUND",
    to: "B1",
    bottom: "S",
  }],
  floors: [
    {
      label: "GROUND",
      brief: {
        purpose: "Take freight off the quay and stage it for inland dispatch.",
        zones: ["quay apron", "transit shed", "tally office", "stair core"],
        sequence: "Craned onto the apron, tallied, staged in the shed, trucked out the roll-up.",
        adjacency: "Tally office overlooks the apron; the roll-up faces the turning circle.",
        negativeSpace: "The apron stays clear so a crane load can be set down anywhere on it.",
      },
      shellOpenings: [
        { kind: "rollup", width: 130, near: { x: 520, y: 200 } },
        { kind: "door", width: 56, near: { x: 800, y: 200 } },
        { kind: "window", width: 90, near: { x: 240, y: 420 } },
        { kind: "window", width: 90, near: { x: 240, y: 560 } },
        { kind: "archway", width: 96, near: { x: 980, y: 520 } },
      ],
      walls: [
        {
          id: "tally",
          thickness: 10,
          /**
           * A diagonal partition screening the tally office off the apron. It runs
           * shell to shell: a partition that stops short leaves a slot too narrow
           * to walk and too wide to read as closed, which is the exact defect the
           * wedged-fixture audit rule exists to catch.
           */
          path: [{ x: 700, y: 207 }, { x: 973, y: 420 }],
          openings: [{ kind: "door", width: 60, near: { x: 820, y: 340 } }],
        },
        {
          id: "shed-screen",
          thickness: 10,
          // A curved screen, authored purely as a corner radius.
          path: [{ x: 247, y: 700 }, { x: 470, y: 700, r: 160 }, { x: 470, y: 973 }],
          openings: [{ kind: "door", width: 64, near: { x: 350, y: 700 } }],
        },
      ],
      objects: [
        { id: "quay-rack-a", kind: "shelf", x: 320, y: 300, w: 26, h: 220, scannable: true },
        { id: "quay-rack-b", kind: "shelf", x: 440, y: 300, w: 26, h: 220 },
        { id: "quay-bench", kind: "workbench", x: 720, y: 620, w: 112, h: 34, facing: "N" },
        { id: "quay-crate-a", kind: "crateStack", x: 620, y: 300, w: 34, h: 34 },
        { id: "quay-crate-b", kind: "crateStack", x: 660, y: 300, w: 32, h: 32 },
        { id: "quay-drum", kind: "drum", x: 620, y: 380, w: 26, h: 26 },
        { id: "quay-desk", kind: "desk", x: 800, y: 300, w: 90, h: 44, facing: "N" },
      ],
      dots: [
        { id: "quay-dot-a", item: { kind: "powerup", type: "health" }, x: 390, y: 560 },
        { id: "quay-dot-b", item: { kind: "powerup", type: "incognito" }, x: 880, y: 620 },
      ],
    },
    {
      label: "B1",
      brief: {
        purpose: "Bonded store under the shed, reached only by the stair.",
        zones: ["bonded cage", "stair landing"],
        sequence: "Down the stair, along the cage front, back up.",
        adjacency: "Cage sits against the shell so only one face needs watching.",
        negativeSpace: "The landing stays clear for two bots to pass.",
      },
      objects: [
        { id: "quay-cage-a", kind: "shelf", x: 420, y: 300, w: 26, h: 200 },
        { id: "quay-cage-b", kind: "shelf", x: 520, y: 300, w: 26, h: 200 },
        { id: "quay-locker", kind: "locker", x: 300, y: 620, w: 26, h: 38 },
      ],
      dots: [{ id: "quay-dot-c", item: { kind: "powerup", type: "radar" }, x: 470, y: 560 }],
    },
  ],
};

export const quaysideDepot = compileBuilding(QUAY_SOURCE);

/** The quay itself: a curved sea wall, authored as an arc. */
function quayWall() {
  const arc = arcPoints({ x: 620, y: 1400 }, 320, Math.PI * 1.16, Math.PI * 1.84, 18);
  return { id: "quay-wall", solids: thickenPath(arc, 24) };
}

/**
 * A one-building sheet for reviewing the source format end to end. Downtown stays
 * the regression map; this is where non-rectangular authoring is proven.
 */
export const quaysideMap: MapDocument = {
  id: "quayside",
  name: "Quayside",
  width: 1280,
  height: 1320,
  visualTheme: "lit-model",
  outdoor: {
    roads: [{ id: "quay-road", x: 1040, y: 0, w: 150, h: 1320 }],
    parks: [],
    walls: [
      { id: "edge-n", x: 0, y: 0, w: 1280, h: 20 },
      { id: "edge-s", x: 0, y: 1300, w: 1280, h: 20 },
      { id: "edge-w", x: 0, y: 0, w: 20, h: 1320 },
      { id: "edge-e", x: 1260, y: 0, w: 20, h: 1320 },
    ],
    barriers: [quayWall()],
    objects: [
      { id: "quay-tree-a", kind: "tree", x: 1080, y: 300, w: 44, h: 44 },
      { id: "quay-tree-b", kind: "tree", x: 1080, y: 520, w: 44, h: 44 },
      { id: "quay-bollard-a", kind: "bollard", x: 700, y: 1080, w: 18, h: 18 },
      { id: "quay-bollard-b", kind: "bollard", x: 820, y: 1100, w: 18, h: 18 },
      { id: "quay-dumpster", kind: "dumpster", x: 1000, y: 760, w: 70, h: 44 },
    ],
    dotSpawns: [],
  },
  buildings: [quaysideDepot],
  extractionPoints: [
    { id: "quay-pad", name: "QUAY PAD", rect: { x: 780, y: 1080, w: 110, h: 110 } },
  ],
  insertionPoints: [{ id: "quay-gate", name: "QUAY GATE", position: { x: 1110, y: 120 } }],
  botSpawns: [{
    id: "player",
    name: "YOU",
    squadId: "player",
    controller: "human",
    color: "#22b8cf",
    position: { x: 1110, y: 200 },
    floorId: OUTDOOR_FLOOR_ID,
  }],
};
