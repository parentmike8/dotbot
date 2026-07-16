/**
 * Prediction-exactness probe. Boots the real server in-process (stateless,
 * PRODUCTION feel config), drives one websocket client through the exact
 * pipeline the browser uses — one input frame per 60Hz tick, 30Hz batched
 * sends with redundancy, reconciliation replay of un-acked frames — and
 * measures how far the replayed authoritative state diverges from local
 * prediction. With the tick-exact input stream the answer should be the wire
 * rounding floor (~0.01px positions, 1ms dash timers), not tens of pixels.
 *
 * Run from apps/server:
 *   npx tsx src/playtest/predictionprobe.ts                  # in-process server
 *   PROBE_URL=https://... npx tsx src/playtest/predictionprobe.ts   # production
 */
import WebSocket from "ws";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { collectSolidRects } from "@dotbot/game/collision";
import { integrateWithWalls } from "@dotbot/game/kinematics";
import { clamp, normalizeInputVector } from "@dotbot/game/math";
import type { Vec2 } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage, WireInputFrame } from "@dotbot/protocol";
import { createServer } from "../app";

type MirrorState = {
  position: Vec2;
  facing: number;
  dashCooldownMs: number;
  dashActiveMs: number;
};

const config = defaultGameConfig;
const tickMs = 1000 / config.tickHz;
const solids = collectSolidRects(downtownMap, "outdoor");
let lastAim: Vec2 = { x: 1, y: 0 };

/** Same math as LitePredictor.advance (walls only; the probe route stays in
 * open space so bot-separation and knockback never enter the measurement). */
function stepMirror(state: MirrorState, frame: WireInputFrame): MirrorState {
  const move = normalizeInputVector({ x: frame.move[0], y: frame.move[1] });
  state.dashCooldownMs = Math.max(0, state.dashCooldownMs - tickMs);
  state.dashActiveMs = Math.max(0, state.dashActiveMs - tickMs);
  if (frame.dash && state.dashCooldownMs <= 0 && state.dashActiveMs <= 0) {
    state.dashActiveMs = config.dashDurationMs;
    state.dashCooldownMs = config.dashCooldownMs;
  }
  if (Math.hypot(move.x, move.y) > 0.05) lastAim = move;
  const direction = state.dashActiveMs > 0 ? lastAim : move;
  const speed = state.dashActiveMs > 0 ? config.dashSpeed : config.playerSpeed;
  const position = integrateWithWalls(
    state.position,
    { x: direction.x * speed, y: direction.y * speed },
    tickMs,
    config.botRadius,
    solids,
  );
  state.position = {
    x: clamp(position.x, config.botRadius, downtownMap.width - config.botRadius),
    y: clamp(position.y, config.botRadius, downtownMap.height - config.botRadius),
  };
  if (Math.hypot(direction.x, direction.y) > 0.05) state.facing = Math.atan2(direction.y, direction.x);
  return state;
}

function cloneState(state: MirrorState): MirrorState {
  return { ...state, position: { ...state.position } };
}

async function main(): Promise<void> {
  let wsUrl: string;
  let app: Awaited<ReturnType<typeof createServer>>["app"] | null = null;
  if (process.env.PROBE_URL) {
    const base = new URL(process.env.PROBE_URL);
    const url = new URL("/ws", base);
    url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    wsUrl = url.toString();
  } else {
    process.env.NODE_ENV = "test";
    ({ app } = await createServer({ countdownMs: 0 }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no tcp address");
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  }
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));

  let yourBotId = "";
  let state: MirrorState | null = null;
  let seq = 0;
  const pending: WireInputFrame[] = [];
  /** clear = no other bot within 120px: measures the pipeline itself.
   * contact = near another bot: separation/knockback divergence the client
   * genuinely cannot know — corrections there are correct behavior. */
  const errors: Array<{ error: number; clear: boolean }> = [];
  let dashStartSeen: { at: number; from: Vec2 } | null = null;
  const dashTravels: number[] = [];

  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as ServerMessage;
    if (message.type === "matchStart") {
      yourBotId = message.yourBotId;
      return;
    }
    if (message.type !== "snap" || !yourBotId) return;
    const own = message.bots.find((bot) => bot.i === yourBotId);
    if (!own) return;
    const authoritative: MirrorState = {
      position: { x: own.p[0], y: own.p[1] },
      facing: own.f ?? 0,
      dashCooldownMs: own.d?.[0] ?? 0,
      dashActiveMs: own.d?.[1] ?? 0,
    };
    if (!state) {
      state = authoritative;
      return;
    }
    // Reconciliation replay, exactly as the client does it.
    const predictedBefore = cloneState(state);
    while (pending.length > 0 && pending[0].seq <= message.ack) pending.shift();
    let corrected = cloneState(authoritative);
    for (const frame of pending) corrected = stepMirror(corrected, frame);
    const error = Math.hypot(
      corrected.position.x - predictedBefore.position.x,
      corrected.position.y - predictedBefore.position.y,
    );
    const nearestOther = Math.min(
      Number.POSITIVE_INFINITY,
      ...message.bots
        .filter((bot) => bot.i !== yourBotId && (bot.fl ?? "outdoor") === (own.fl ?? "outdoor") && bot.s !== "consumed")
        .map((bot) => Math.hypot(bot.p[0] - own.p[0], bot.p[1] - own.p[1])),
    );
    errors.push({ error, clear: nearestOther > 120 });
    state = corrected;

    // Server-side dash travel: from dash activation to its end.
    if (authoritative.dashActiveMs > 0 && !dashStartSeen) {
      dashStartSeen = { at: Date.now(), from: { ...authoritative.position } };
    } else if (authoritative.dashActiveMs <= 0 && dashStartSeen) {
      dashTravels.push(Math.hypot(
        authoritative.position.x - dashStartSeen.from.x,
        authoritative.position.y - dashStartSeen.from.y,
      ));
      dashStartSeen = null;
    }
  });

  send({ type: "hello", token: `probe-${Date.now()}`, name: "Probe", roomCode: "" });
  await waitFor(() => yourBotId === "" && false, 200).catch(() => undefined);
  send({ type: "startMatch" });
  await waitFor(() => yourBotId !== "", 10_000);
  await waitFor(() => state !== null, 5_000);

  // 12 seconds oscillating around the spawn plaza (net-zero drift keeps the
  // probe off street furniture and mostly away from wandering greys), with
  // direction changes, a stop phase, and periodic dashes.
  const directions: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [0, 0], [-1, -1], [1, 0], [-1, 0], [0, 0]];
  const startedAt = Date.now();
  let frameClock = Date.now();
  while (Date.now() - startedAt < 12_000) {
    const now = Date.now();
    while (frameClock <= now) {
      frameClock += tickMs;
      seq += 1;
      const phase = Math.floor((seq * tickMs) / 600) % directions.length;
      const move = directions[phase];
      const frame: WireInputFrame = {
        seq,
        move,
        dash: seq % 90 === 30 && Math.hypot(move[0], move[1]) > 0,
      };
      if (state) stepMirror(state, frame);
      pending.push(frame);
      if (frame.dash || seq % 2 === 0) {
        const frames = pending.slice(-4);
        const top = frames[frames.length - 1];
        send({ type: "input", seq: top.seq, move: top.move, dash: top.dash, frames });
      }
    }
    await delay(4);
  }

  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
    return {
      snapshots: values.length,
      meanPx: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3)),
      p50Px: Number(pick(0.5).toFixed(3)),
      p99Px: Number(pick(0.99).toFixed(3)),
      maxPx: Number(Math.max(0, ...values).toFixed(3)),
      correctionsOver05px: values.filter((value) => value >= 0.5).length,
    };
  };
  console.log(JSON.stringify({
    clearField: summarize(errors.filter(({ clear }) => clear).map(({ error }) => error)),
    nearOtherBots: summarize(errors.filter(({ clear }) => !clear).map(({ error }) => error)),
    dashesObserved: dashTravels.length,
    dashTravelPx: dashTravels.map((value) => Number(value.toFixed(1))),
  }, null, 2));

  ws.close();
  await app?.close();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("waitFor timed out");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
