/**
 * Clumping / welding repro harness. MEASUREMENT ONLY — nothing here asserts
 * anything, it only produces numbers about how the star-shaped (plate/core) body
 * behaves inside the separation solver and the AI stop-distance rule.
 *
 * Every block is `it.skip` ON PURPOSE. A file of `it()`s that cannot fail counted
 * six passes toward the suite total and made the gate look like it covered ground
 * it did not; skipped is what a manual instrument is. The invariants that came out
 * of these measurements are real assertions, in simulation.test.ts and
 * bodyContact.test.ts. This file is for re-measuring after a change to the AI or
 * the solver, which is why it is kept rather than deleted.
 *
 * Run, dropping the skips:
 *   npx vitest run src/clumping.repro.test.ts -t <letter>   # after editing it.skip -> it
 */
import { describe, it } from "vitest";
import { defaultGameConfig } from "./config";
import { DotBotSimulation } from "./simulation";
import { CORE_REACH, PLATE_REACH, contactReach, normalizeAngle } from "./shields";
import type { BotSpawn, DotBotEntity, MapDocument, Vec2, WallSegment } from "./types";

// ---------------------------------------------------------------------------
// World: a big empty sheet. Only the four map-edge walls, nowhere near the action.
// ---------------------------------------------------------------------------

const MAP_W = 1400;
const MAP_H = 1000;
const R = defaultGameConfig.botRadius; // 24
const PLATE = R * PLATE_REACH; // 24
const CORE = R * CORE_REACH; // 9.6
/**
 * HISTORICAL. This was the radius the renderer drew EVERY plate arc at — broken
 * ones included, as a 0.3-alpha ghost — so a bot showed visible ink at 21.5 in all
 * directions whatever its plates were doing. That is what made two bodies obeying
 * the solver perfectly look welded: 25.8 px of ring-through-ring at the bare-core
 * rest distance, each ring enclosing the other bot's centre.
 *
 * The ghost is gone; every mark on a bot is now bounded by `contactReach`. The
 * constant stays so the `ringOverlap` columns below remain comparable against the
 * numbers that were measured when the bug was live. It no longer describes
 * anything on screen — read it as "ink the old renderer would have crossed".
 */
const DRAWN_RING = R - 2.5; // 21.5, as the renderer WAS
const DRAWN = R;
/** Two bodies, each capped at botSeparationSpeed/tickHz, close this much per tick. */
const MAX_CLOSURE_PER_TICK = (2 * defaultGameConfig.botSeparationSpeed) / defaultGameConfig.tickHz; // 10

function bounds(width: number, height: number): WallSegment[] {
  return [
    { id: "north", x: 0, y: 0, w: width, h: 20 },
    { id: "south", x: 0, y: height - 20, w: width, h: 20 },
    { id: "west", x: 0, y: 0, w: 20, h: height },
    { id: "east", x: width - 20, y: 0, w: 20, h: height },
  ];
}

function openMap(botSpawns: BotSpawn[]): MapDocument {
  return {
    id: "clump-map",
    name: "Clump Map",
    width: MAP_W,
    height: MAP_H,
    outdoor: { roads: [], parks: [], walls: bounds(MAP_W, MAP_H), objects: [], dotSpawns: [] },
    buildings: [],
    extractionPoints: [],
    insertionPoints: [],
    botSpawns,
  };
}

/** Internal handles the harness needs: exact facing writes, dash lockout, intent. */
type InternalHandle = {
  position: Vec2;
  facing: number;
  shieldSegments: number[];
  dashCooldownMs: number;
  velocity: Vec2;
  desiredMove: Vec2;
};

function internals(sim: DotBotSimulation): Map<string, InternalHandle> {
  return (sim as unknown as { bots: Map<string, InternalHandle> }).bots;
}

/**
 * Take dashes off the table. dashCooldownMs is only ever decremented, so one
 * huge write disables `tryAiDash` for the whole run. With no dash there is no
 * body moving faster than `damageSpeed` (360) either, so no plate can break:
 * every bot keeps exactly the plate array it spawned with and the run is a pure
 * test of locomotion + separation over the star-shaped body.
 */
function disableDashes(sim: DotBotSimulation): void {
  for (const bot of internals(sim).values()) bot.dashCooldownMs = 1e9;
}

type Frame = {
  bots: DotBotEntity[];
  desired: Vec2[];
};

function snapshotFrame(sim: DotBotSimulation): Frame {
  const bots = [...sim.getSnapshot().bots].sort((a, b) => a.id.localeCompare(b.id));
  const handles = internals(sim);
  return { bots, desired: bots.map((bot) => ({ ...handles.get(bot.id)!.desiredMove })) };
}

function reachToward(a: DotBotEntity, b: DotBotEntity): number {
  const toB = Math.atan2(b.position.y - a.position.y, b.position.x - a.position.x);
  return contactReach(a.radius, a.facing, a.shieldSegments, toB);
}

function requiredGap(a: DotBotEntity, b: DotBotEntity): number {
  return reachToward(a, b) + reachToward(b, a);
}

function centreDistance(a: DotBotEntity, b: DotBotEntity): number {
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
}

const f2 = (value: number) => value.toFixed(2);
const pad = (value: string, width: number) => value.padEnd(width);

// ---------------------------------------------------------------------------
// Scenario A/B/C/D: four ambient AI bots hunting one player that keeps moving.
// ---------------------------------------------------------------------------

/**
 * The four ambient bots share a squad, so they never fight each other — they
 * only crowd. They spawn clustered on one side so all four funnel toward the
 * same arc of the player's stop ring, which is the reported screenshot.
 *
 * `shields` picks how star-shaped each body is. `platesForCount` puts the intact
 * plates first and plate 0 is dead ahead, so a bot with 1 of 3 plates reaches
 * 24 toward whatever it is walking at and 9.6 on both rear quadrants — exactly
 * the "shield touching a core" geometry from play.
 */
function clumpSpawns(shieldsPerBot: number[]): BotSpawn[] {
  const cluster: Vec2[] = [
    { x: 480, y: 440 },
    { x: 480, y: 560 },
    { x: 400, y: 500 },
    { x: 560, y: 500 },
  ];
  const bots: BotSpawn[] = [
    {
      id: "player",
      name: "Player",
      squadId: "alpha",
      controller: "human",
      color: "#ff3b6b",
      position: { x: 900, y: 500 },
    },
  ];
  cluster.forEach((position, index) => {
    bots.push({
      id: `ai-${index}`,
      name: `AI ${index}`,
      squadId: "pack",
      isAmbient: true,
      color: "#f2994a",
      position,
      maxShields: 3,
      shields: shieldsPerBot[index],
    });
  });
  return bots;
}

/**
 * The player walks a tight 115px square, forever. Standing still lets the pack
 * settle into a static overlap and never re-collide; a small loop is what play
 * actually looks like and keeps four hunters permanently re-forming the same
 * clump, which is the state being measured.
 */
const PATROL: Vec2[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];
const PATROL_TICKS = 30;

type Report = { label: string; frames: Frame[] };

async function runClump(label: string, shieldsPerBot: number[], ticks: number): Promise<Report> {
  const sim = await DotBotSimulation.create({ map: openMap(clumpSpawns(shieldsPerBot)) });
  disableDashes(sim);
  const frames: Frame[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    sim.applyInput("player", { move: PATROL[Math.floor(tick / PATROL_TICKS) % 4], dash: false });
    sim.step();
    frames.push(snapshotFrame(sim));
  }
  sim.dispose();
  return { label, frames };
}

/**
 * Build the clump, then take the steer away (every AI goes `frozen`, so
 * desiredMove is zero) and let the separation pass run on its own. Answers two
 * things at once: how many ticks the solver needs to clear the overlap it is
 * responsible for, and — the real question — what it leaves behind when it says
 * it is done.
 */
async function measureDispersal(label: string, shieldsPerBot: number[], buildTicks: number): Promise<void> {
  const worstAtFrame = (frame: DotBotEntity[]) => {
    let worst = 0;
    for (let i = 0; i < frame.length; i += 1) {
      for (let j = i + 1; j < frame.length; j += 1) {
        worst = Math.max(worst, requiredGap(frame[i], frame[j]) - centreDistance(frame[i], frame[j]));
      }
    }
    return Math.max(0, worst);
  };

  // Pass 1: the run is deterministic, so find the deepest-overlap tick first and
  // freeze there rather than at whatever the last tick happens to be.
  const probe = await runClump(label, shieldsPerBot, buildTicks);
  let freezeAt = buildTicks - 1;
  let deepest = -1;
  probe.frames.forEach((frame, tick) => {
    const worst = worstAtFrame(frame.bots);
    if (worst > deepest) {
      deepest = worst;
      freezeAt = tick;
    }
  });

  const sim = await DotBotSimulation.create({ map: openMap(clumpSpawns(shieldsPerBot)) });
  disableDashes(sim);
  for (let tick = 0; tick <= freezeAt; tick += 1) {
    sim.applyInput("player", { move: PATROL[Math.floor(tick / PATROL_TICKS) % 4], dash: false });
    sim.step();
  }
  for (const id of ["ai-0", "ai-1", "ai-2", "ai-3", "player"]) sim.setController(id, "frozen");

  const worstAt = (frame: DotBotEntity[]) => {
    let worstPen = 0;
    let worstRing = 0;
    let minDistance = Infinity;
    for (let i = 0; i < frame.length; i += 1) {
      for (let j = i + 1; j < frame.length; j += 1) {
        const distance = centreDistance(frame[i], frame[j]);
        worstPen = Math.max(worstPen, requiredGap(frame[i], frame[j]) - distance);
        worstRing = Math.max(worstRing, DRAWN_RING * 2 - distance);
        minDistance = Math.min(minDistance, distance);
      }
    }
    return { worstPen: Math.max(0, worstPen), worstRing: Math.max(0, worstRing), minDistance };
  };

  const start = worstAt([...sim.getSnapshot().bots].sort((a, b) => a.id.localeCompare(b.id)));
  let ticksToDisperse = -1;
  let settled: ReturnType<typeof worstAt> = start;
  for (let tick = 0; tick < 300; tick += 1) {
    sim.step();
    settled = worstAt([...sim.getSnapshot().bots].sort((a, b) => a.id.localeCompare(b.id)));
    if (settled.worstPen <= 0.001 && ticksToDisperse < 0) {
      ticksToDisperse = tick + 1;
      break;
    }
  }
  sim.dispose();
  console.log(`\n===== ${label}: ticks-to-disperse with the steer removed (frozen at tick ${freezeAt}) =====`);
  console.log(
    `at freeze: worst penetration ${f2(start.worstPen)}, closest pair ${f2(start.minDistance)}, ` +
      `worst plate-ring overlap ${f2(start.worstRing)}`,
  );
  console.log(
    `ticks to clear all penetration: ${ticksToDisperse < 0 ? "NEVER within 300" : ticksToDisperse}` +
      `   left at rest: closest pair ${f2(settled.minDistance)}, plate-ring overlap still ${f2(settled.worstRing)} px ` +
      `of a ${DRAWN_RING * 2} px ring (${((settled.worstRing / (DRAWN_RING * 2)) * 100).toFixed(0)}%)`,
  );
}

function reportPenetration(report: Report, tailFrom: number): void {
  const { label, frames } = report;
  const ids = frames[0].bots.map((bot) => bot.id);
  const pairs: [number, number][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) pairs.push([i, j]);
  }

  type PairAcc = {
    key: string;
    worstPen: number;
    worstPenTick: number;
    worstPenDistance: number;
    worstPenRequired: number;
    tailPenSum: number;
    tailPenTicks: number;
    penTicks: number;
    minDistance: number;
    worstHullOverlap: number;
    tailHullSum: number;
    worstRingOverlap: number;
    tailRingSum: number;
    /** Biggest one-tick step in the required distance: the square wave's height. */
    worstRequiredJump: number;
    requiredJumps: number;
    /** Penetration events deeper than one tick of the 10px/tick closure budget. */
    deepPenTicks: number;
    previousRequired: number;
    requiredSeen: Set<string>;
  };
  const acc = new Map<string, PairAcc>();
  for (const [i, j] of pairs) {
    acc.set(`${ids[i]}|${ids[j]}`, {
      key: `${ids[i]}|${ids[j]}`,
      worstPen: 0,
      worstPenTick: -1,
      worstPenDistance: 0,
      worstPenRequired: 0,
      tailPenSum: 0,
      tailPenTicks: 0,
      penTicks: 0,
      minDistance: Infinity,
      worstHullOverlap: 0,
      tailHullSum: 0,
      worstRingOverlap: 0,
      tailRingSum: 0,
      worstRequiredJump: 0,
      requiredJumps: 0,
      deepPenTicks: 0,
      previousRequired: Number.NaN,
      requiredSeen: new Set<string>(),
    });
  }

  let anyPenTicks = 0;
  let anyPenTicksTail = 0;
  let worstOverall = 0;
  let worstOverallKey = "";
  let worstOverallTick = -1;
  let tailPenAllSum = 0;
  let tailSamples = 0;

  frames.forEach((frame, tick) => {
    let framePenetrating = false;
    for (const [i, j] of pairs) {
      const a = frame.bots[i];
      const b = frame.bots[j];
      const entry = acc.get(`${a.id}|${b.id}`)!;
      const distance = centreDistance(a, b);
      const required = requiredGap(a, b);
      const penetration = Math.max(0, required - distance);
      const hullOverlap = Math.max(0, DRAWN * 2 - distance);
      const ringOverlap = Math.max(0, DRAWN_RING * 2 - distance);

      entry.requiredSeen.add(required.toFixed(1));
      entry.minDistance = Math.min(entry.minDistance, distance);
      entry.worstHullOverlap = Math.max(entry.worstHullOverlap, hullOverlap);
      entry.worstRingOverlap = Math.max(entry.worstRingOverlap, ringOverlap);
      if (!Number.isNaN(entry.previousRequired)) {
        const jump = Math.abs(required - entry.previousRequired);
        if (jump > 0.001) {
          entry.requiredJumps += 1;
          entry.worstRequiredJump = Math.max(entry.worstRequiredJump, jump);
        }
      }
      entry.previousRequired = required;
      if (penetration > MAX_CLOSURE_PER_TICK) entry.deepPenTicks += 1;
      if (penetration > entry.worstPen) {
        entry.worstPen = penetration;
        entry.worstPenTick = tick;
        entry.worstPenDistance = distance;
        entry.worstPenRequired = required;
      }
      if (penetration > 0.001) {
        entry.penTicks += 1;
        framePenetrating = true;
      }
      if (tick >= tailFrom) {
        entry.tailPenSum += penetration;
        entry.tailHullSum += hullOverlap;
        entry.tailRingSum += ringOverlap;
        entry.tailPenTicks += 1;
        tailPenAllSum += penetration;
        tailSamples += 1;
      }
      if (penetration > worstOverall) {
        worstOverall = penetration;
        worstOverallKey = entry.key;
        worstOverallTick = tick;
      }
    }
    if (framePenetrating) {
      anyPenTicks += 1;
      if (tick >= tailFrom) anyPenTicksTail += 1;
    }
  });

  console.log(`\n===== ${label}: A. penetration (${frames.length} ticks) =====`);
  console.log(`worst penetration overall: ${f2(worstOverall)} px  (pair ${worstOverallKey}, tick ${worstOverallTick})`);
  console.log(
    `mean penetration over ALL pairs, last ${frames.length - tailFrom} ticks: ${f2(tailPenAllSum / tailSamples)} px`,
  );
  console.log(
    `ticks with ANY pair penetrating: ${anyPenTicks}/${frames.length} (${((anyPenTicks / frames.length) * 100).toFixed(1)}%)` +
      `   in last ${frames.length - tailFrom}: ${anyPenTicksTail}`,
  );
  console.log(
    `${pad("pair", 18)}${pad("worstPen", 10)}${pad("@dist", 9)}${pad("req", 8)}${pad("tick", 7)}` +
      `${pad("meanPenTail", 13)}${pad("penTicks", 10)}${pad("pen>10px", 10)}${pad("minDist", 9)}` +
      `${pad("ringOvMax", 11)}${pad("ringOvTail", 12)}${pad("envOvMax", 10)}` +
      `${pad("reqJumps", 10)}${pad("maxJump", 9)}reqValuesSeen`,
  );
  for (const entry of acc.values()) {
    console.log(
      pad(entry.key, 18) +
        pad(f2(entry.worstPen), 10) +
        pad(f2(entry.worstPenDistance), 9) +
        pad(f2(entry.worstPenRequired), 8) +
        pad(String(entry.worstPenTick), 7) +
        pad(f2(entry.tailPenTicks ? entry.tailPenSum / entry.tailPenTicks : 0), 13) +
        pad(String(entry.penTicks), 10) +
        pad(String(entry.deepPenTicks), 10) +
        pad(f2(entry.minDistance), 9) +
        pad(f2(entry.worstRingOverlap), 11) +
        pad(f2(entry.tailPenTicks ? entry.tailRingSum / entry.tailPenTicks : 0), 12) +
        pad(f2(entry.worstHullOverlap), 10) +
        pad(String(entry.requiredJumps), 10) +
        pad(f2(entry.worstRequiredJump), 9) +
        [...entry.requiredSeen].sort().join(","),
    );
  }
}

function reportProgress(report: Report, tailFrom: number): void {
  const { label, frames } = report;
  const ids = frames[0].bots.map((bot) => bot.id);
  console.log(`\n===== ${label}: B. net progress over ticks ${tailFrom}..${frames.length - 1} =====`);
  console.log(
    `${pad("bot", 10)}${pad("pathLen", 11)}${pad("netDisp", 11)}${pad("net/path", 10)}` +
      `${pad("wantedPx", 11)}${pad("gotPx", 9)}${pad("delivered", 11)}${pad("backTicks", 11)}` +
      `${pad("weldedTicks", 13)}longestWeld`,
  );
  ids.forEach((id, index) => {
    let pathLength = 0;
    let wanted = 0;
    let alongIntent = 0;
    let backwardTicks = 0;
    // A welded tick: the bot asked to move and did not move at all.
    let weldedTicks = 0;
    let longestWeld = 0;
    let weldRun = 0;
    for (let t = tailFrom + 1; t < frames.length; t += 1) {
      const step = {
        x: frames[t].bots[index].position.x - frames[t - 1].bots[index].position.x,
        y: frames[t].bots[index].position.y - frames[t - 1].bots[index].position.y,
      };
      pathLength += Math.hypot(step.x, step.y);
      // What the AI asked for this tick, in pixels, at the speed it would run at.
      const intent = frames[t].desired[index];
      const intentLength = Math.hypot(intent.x, intent.y);
      const speed = id === "player" ? defaultGameConfig.playerSpeed : defaultGameConfig.botSpeed;
      wanted += (intentLength * speed) / defaultGameConfig.tickHz;
      if (intentLength > 0.0001) {
        const along = (step.x * intent.x + step.y * intent.y) / intentLength;
        alongIntent += along;
        if (along < -0.01) backwardTicks += 1;
      }
      if (intentLength > 0.05 && Math.hypot(step.x, step.y) < 0.02) {
        weldedTicks += 1;
        weldRun += 1;
        longestWeld = Math.max(longestWeld, weldRun);
      } else {
        weldRun = 0;
      }
    }
    const net = Math.hypot(
      frames[frames.length - 1].bots[index].position.x - frames[tailFrom].bots[index].position.x,
      frames[frames.length - 1].bots[index].position.y - frames[tailFrom].bots[index].position.y,
    );
    console.log(
      pad(id, 10) +
        pad(f2(pathLength), 11) +
        pad(f2(net), 11) +
        pad(pathLength > 0.001 ? (net / pathLength).toFixed(3) : "n/a", 10) +
        pad(f2(wanted), 11) +
        pad(f2(alongIntent), 9) +
        pad(wanted > 0.001 ? (alongIntent / wanted).toFixed(3) : "n/a", 11) +
        pad(String(backwardTicks), 11) +
        pad(String(weldedTicks), 13) +
        String(longestWeld),
    );
  });
}

function reportChatter(report: Report): void {
  const { label, frames } = report;
  const ids = frames[0].bots.map((bot) => bot.id);
  console.log(`\n===== ${label}: C. reach chatter, ordered pairs (flips of contactReach(a -> b)) =====`);
  console.log(`${pad("a -> b", 20)}${pad("flips", 8)}${pad("ticksAtPlate", 14)}${pad("ticksAtCore", 13)}values`);
  let totalFlips = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = 0; j < ids.length; j += 1) {
      if (i === j) continue;
      let flips = 0;
      let previous = Number.NaN;
      let plateTicks = 0;
      let coreTicks = 0;
      const values = new Set<string>();
      for (const frame of frames) {
        const reach = reachToward(frame.bots[i], frame.bots[j]);
        values.add(reach.toFixed(1));
        if (reach > (PLATE + CORE) / 2) plateTicks += 1;
        else coreTicks += 1;
        if (!Number.isNaN(previous) && Math.abs(reach - previous) > 0.001) flips += 1;
        previous = reach;
      }
      totalFlips += flips;
      console.log(
        pad(`${ids[i]} -> ${ids[j]}`, 20) +
          pad(String(flips), 8) +
          pad(String(plateTicks), 14) +
          pad(String(coreTicks), 13) +
          [...values].sort().join(","),
      );
    }
  }
  console.log(`total reach flips across all ordered pairs: ${totalFlips}`);
}

function reportFacingChurn(report: Report): void {
  const { label, frames } = report;
  const ids = frames[0].bots.map((bot) => bot.id);
  console.log(`\n===== ${label}: D. facing churn (sum |delta facing|) =====`);
  console.log(`${pad("bot", 10)}${pad("totalDeg", 12)}${pad("deg/tick", 11)}${pad("maxStepDeg", 13)}bigTurns(>10deg)`);
  ids.forEach((id, index) => {
    let total = 0;
    let maxStep = 0;
    let bigTurns = 0;
    for (let t = 1; t < frames.length; t += 1) {
      const delta = Math.abs(normalizeAngle(frames[t].bots[index].facing - frames[t - 1].bots[index].facing));
      total += delta;
      maxStep = Math.max(maxStep, delta);
      if (delta > (10 * Math.PI) / 180) bigTurns += 1;
    }
    const deg = (total * 180) / Math.PI;
    console.log(
      pad(id, 10) +
        pad(f2(deg), 12) +
        pad(f2(deg / (frames.length - 1)), 11) +
        pad(f2((maxStep * 180) / Math.PI), 13) +
        String(bigTurns),
    );
  });
}

/**
 * The same pack, but the player is jammed into the map's north-west corner and
 * holds there, so the four hunters have to crowd into a quarter-circle of ground
 * with two walls behind them.
 *
 * This is the case the open-field run cannot reach: `resolveBotSeparation`
 * computes its push from the *reach* (as little as 9.6) and then runs the result
 * through `resolveAgainstSolids` at the bot's *plain radius* (always 24). Against
 * a wall those two disagree — the solver asks for a shove the wall refuses — so
 * an overlap that would clear in two ticks on open ground has nowhere to go.
 */
function cornerSpawns(shieldsPerBot: number[]): BotSpawn[] {
  const cluster: Vec2[] = [
    { x: 300, y: 200 },
    { x: 200, y: 300 },
    { x: 320, y: 320 },
    { x: 240, y: 180 },
  ];
  const bots: BotSpawn[] = [
    { id: "player", name: "Player", squadId: "alpha", controller: "human", color: "#ff3b6b", position: { x: 90, y: 90 } },
  ];
  cluster.forEach((position, index) => {
    bots.push({
      id: `ai-${index}`,
      name: `AI ${index}`,
      squadId: "pack",
      isAmbient: true,
      color: "#f2994a",
      position,
      maxShields: 3,
      shields: shieldsPerBot[index],
    });
  });
  return bots;
}

async function runCorner(label: string, shieldsPerBot: number[], ticks: number): Promise<Report> {
  const sim = await DotBotSimulation.create({ map: openMap(cornerSpawns(shieldsPerBot)) });
  disableDashes(sim);
  const frames: Frame[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    // Hold into the corner the whole time: the player is a wall of its own.
    sim.applyInput("player", { move: { x: -1, y: -1 }, dash: false });
    sim.step();
    frames.push(snapshotFrame(sim));
  }
  sim.dispose();
  return { label, frames };
}

function reportPositions(report: Report): void {
  const last = report.frames[report.frames.length - 1];
  console.log(`\n===== ${report.label}: final state =====`);
  last.bots.forEach((bot, index) => {
    console.log(
      `${pad(bot.id, 10)}at (${f2(bot.position.x)}, ${f2(bot.position.y)})  ` +
        `facing ${f2((bot.facing * 180) / Math.PI)}deg  plates [${bot.shieldSegments.join(",")}]  ` +
        `desiredMove (${f2(last.desired[index].x)}, ${f2(last.desired[index].y)})  ` +
        `distToWestWall ${f2(bot.position.x - 20)} distToNorthWall ${f2(bot.position.y - 20)}`,
    );
  });
}

function reportAll(report: Report, tailFrom: number): void {
  reportPenetration(report, tailFrom);
  reportProgress(report, tailFrom);
  reportChatter(report);
  reportFacingChurn(report);
}

// ---------------------------------------------------------------------------

describe("clumping repro", () => {
  it.skip("A/B/C/D: four ambient AI bots hunting one moving player, star bodies", async () => {
    console.log(
      `\nconstants: R=${R} plateReach=${PLATE} coreReach=${f2(CORE)}  ` +
        `plate+plate=${PLATE * 2} plate+core=${f2(PLATE + CORE)} core+core=${f2(CORE * 2)}  ` +
        `drawn plate-ring diameter=${DRAWN_RING * 2} outer envelope=${DRAWN * 2}  ` +
        `maxClosure=${MAX_CLOSURE_PER_TICK}px/tick  ` +
        `maxPushPx=${(defaultGameConfig.botSeparationSpeed / defaultGameConfig.tickHz).toFixed(2)}/tick/body  ` +
        `huntStopCap=R*1.85=${(R * 1.85).toFixed(2)}`,
    );
    // Nobody takes a hit during the run (dashes disabled, walking speed <
    // damageSpeed), so these plate arrays are constant for 600 ticks.
    reportAll(await runClump("A1 star, every bot 1/3 plates", [1, 1, 1, 1], 600), 300);
    await measureDispersal("A1 star, every bot 1/3 plates", [1, 1, 1, 1], 600);
    reportAll(await runClump("A2 star, mixed 1,2,1,2 of 3", [1, 2, 1, 2], 600), 300);
    await measureDispersal("A2 star, mixed 1,2,1,2 of 3", [1, 2, 1, 2], 600);
  });

  it.skip("F: control — every bot fully plated, so every body is a plain circle", async () => {
    reportAll(await runClump("F circle control, 3/3 plates", [3, 3, 3, 3], 600), 300);
    await measureDispersal("F circle control, 3/3 plates", [3, 3, 3, 3], 600);
  });

  it.skip("G: the pack pressed into a corner, star vs circle", async () => {
    const star = await runCorner("G1 corner press, star 1/3 plates", [1, 1, 1, 1], 900);
    reportAll(star, 600);
    reportPositions(star);
    const circle = await runCorner("G2 corner press, circle 3/3 plates", [3, 3, 3, 3], 900);
    reportAll(circle, 600);
    reportPositions(circle);
  });

  it.skip("E: the user's case — a body turns a live plate into a core it was resting on", async () => {
    /**
     * A is stationary with its BARE rear-left arc pointed at B; B is stationary
     * with its LIVE forward plate pointed at A. Required gap 9.6 + 24 = 33.6 and
     * they start exactly there. Then A rotates 120 degrees so plate 0 — intact —
     * covers B. Required jumps to 48 with nothing having moved.
     */
    const spawns: BotSpawn[] = [
      { id: "a", name: "A", squadId: "sq-a", controller: "frozen", color: "#fff", position: { x: 700, y: 500 }, maxShields: 3, shields: 1 },
      { id: "b", name: "B", squadId: "sq-b", controller: "frozen", color: "#fff", position: { x: 700 + (PLATE + CORE), y: 500 }, maxShields: 3, shields: 1 },
    ];
    const sim = await DotBotSimulation.create({ map: openMap(spawns) });
    disableDashes(sim);
    const handles = internals(sim);
    // A: plate 1 (broken) covers the +x direction toward B.
    handles.get("a")!.facing = (-2 * Math.PI) / 3;
    // B: plate 0 (intact) covers the -x direction toward A.
    handles.get("b")!.facing = Math.PI;

    const seated = [...sim.getSnapshot().bots].sort((x, y) => x.id.localeCompare(y.id));
    console.log(`\n===== E. rotation-induced penetration, hand-built =====`);
    console.log(
      `seated: distance ${f2(centreDistance(seated[0], seated[1]))}, required ${f2(requiredGap(seated[0], seated[1]))}` +
        ` (a->b ${f2(reachToward(seated[0], seated[1]))} core, b->a ${f2(reachToward(seated[1], seated[0]))} plate)` +
        `  visible hull overlap already ${f2(DRAWN * 2 - centreDistance(seated[0], seated[1]))} px`,
    );

    // Rotate A by +120 degrees. Both bots are frozen, so nothing overwrites facing.
    handles.get("a")!.facing = 0;

    let ticksToResolve = -1;
    let worst = 0;
    const trace: string[] = [];
    for (let tick = 0; tick < 200; tick += 1) {
      const frame = [...sim.getSnapshot().bots].sort((x, y) => x.id.localeCompare(y.id));
      const distance = centreDistance(frame[0], frame[1]);
      const required = requiredGap(frame[0], frame[1]);
      const penetration = Math.max(0, required - distance);
      worst = Math.max(worst, penetration);
      if (tick < 8 || tick === 199) {
        trace.push(`t=${String(tick).padStart(3)} dist=${f2(distance)} req=${f2(required)} pen=${f2(penetration)}`);
      }
      if (penetration <= 0.001 && ticksToResolve < 0) ticksToResolve = tick;
      sim.step();
    }
    sim.dispose();
    console.log(trace.join("\n"));
    console.log(
      `worst penetration after the 120deg turn: ${f2(worst)} px; resolved after ${ticksToResolve} ticks` +
        `${ticksToResolve < 0 ? " (NEVER, within 200)" : ""}`,
    );
  });

  it.skip("E2: two AI bots walking into each other — where does the steer stop vs the solver", async () => {
    /**
     * No rotation trick at all: two mutually hunting bots on empty ground.
     * `huntStopDistance` caps at radius*1.85 = 44.4, which is INSIDE the 48 the
     * separation pass wants two plated bodies to sit at.
     */
    const spawns: BotSpawn[] = [
      { id: "a", name: "A", squadId: "sq-a", isAmbient: true, color: "#fff", position: { x: 600, y: 500 } },
      { id: "b", name: "B", squadId: "sq-b", isAmbient: true, color: "#fff", position: { x: 800, y: 500 } },
    ];
    const sim = await DotBotSimulation.create({ map: openMap(spawns) });
    disableDashes(sim);
    const frames: Frame[] = [];
    for (let tick = 0; tick < 400; tick += 1) {
      sim.step();
      frames.push(snapshotFrame(sim));
    }
    sim.dispose();

    console.log(`\n===== E2. two hunting bots, plain approach =====`);
    let worstTail = 0;
    let tailPenSum = 0;
    let tailPenTicks = 0;
    let minDistance = Infinity;
    let maxDistance = 0;
    let pathA = 0;
    for (let t = 0; t < frames.length; t += 1) {
      const [a, b] = frames[t].bots;
      const distance = centreDistance(a, b);
      const penetration = Math.max(0, requiredGap(a, b) - distance);
      if (t >= 200) {
        worstTail = Math.max(worstTail, penetration);
        tailPenSum += penetration;
        tailPenTicks += 1;
        minDistance = Math.min(minDistance, distance);
        maxDistance = Math.max(maxDistance, distance);
        if (t > 200) {
          pathA += Math.hypot(
            a.position.x - frames[t - 1].bots[0].position.x,
            a.position.y - frames[t - 1].bots[0].position.y,
          );
        }
      }
    }
    const netA = Math.hypot(
      frames[frames.length - 1].bots[0].position.x - frames[200].bots[0].position.x,
      frames[frames.length - 1].bots[0].position.y - frames[200].bots[0].position.y,
    );
    console.log(
      `steady state (ticks 200-399): distance ${f2(minDistance)}..${f2(maxDistance)}, ` +
        `worst pen ${f2(worstTail)}, mean pen ${f2(tailPenSum / tailPenTicks)}, ` +
        `bot a pathLen ${f2(pathA)} netDisp ${f2(netA)}`,
    );
  });

  it.skip("E3: rotation-induced penetration with the AI in the loop, not frozen", async () => {
    /**
     * The same turn, but nobody is pinned: three same-squad hunters crowd one
     * hunted bot so the pack's own bodies keep turning into each other while
     * the steer keeps pushing them back in. This is the version that can grind,
     * because the AI reasserts the intent that separation just undid.
     */
    const report = await runClump("E3 star pack, 1/3 plates, tight patrol", [1, 1, 1, 1], 900);
    const ids = report.frames[0].bots.map((bot) => bot.id);
    console.log(`\n===== E3. worst sustained pair, ticks 600-899 =====`);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        let penTicks = 0;
        let penSum = 0;
        let worst = 0;
        let hullSum = 0;
        let longestRun = 0;
        let run = 0;
        for (let t = 600; t < report.frames.length; t += 1) {
          const a = report.frames[t].bots[i];
          const b = report.frames[t].bots[j];
          const distance = centreDistance(a, b);
          const penetration = Math.max(0, requiredGap(a, b) - distance);
          hullSum += Math.max(0, DRAWN * 2 - distance);
          if (penetration > 0.001) {
            penTicks += 1;
            penSum += penetration;
            run += 1;
            longestRun = Math.max(longestRun, run);
          } else {
            run = 0;
          }
          worst = Math.max(worst, penetration);
        }
        console.log(
          `${pad(`${ids[i]}|${ids[j]}`, 18)}penTicks=${pad(String(penTicks), 6)}worstPen=${pad(f2(worst), 8)}` +
            `meanPenWhilePenetrating=${pad(penTicks ? f2(penSum / penTicks) : "0.00", 8)}` +
            `longestPenRun=${pad(String(longestRun), 6)}meanHullOverlap=${f2(hullSum / 300)}`,
        );
      }
    }
  });
});
