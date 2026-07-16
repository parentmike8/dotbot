/**
 * Production snapshot-delivery probe. Creates a disposable two-player room,
 * drives continuous input, and measures the WebSocket arrival pattern.
 *
 * Run from the repo root with Node 20:
 *   pnpm --filter @dotbot/server jitterprobe
 *
 * Optional: JITTER_URL=https://... DURATION_MS=20000
 */
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";

const baseUrl = new URL(process.env.JITTER_URL ?? "https://dotbot-jpawns5vla-uc.a.run.app/");
const durationMs = Number(process.env.DURATION_MS ?? 20_000);
const wsUrl = new URL("/ws", baseUrl);
wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

type ProbeClient = {
  ws: WebSocket;
  messages: ServerMessage[];
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
};

async function register(name: string): Promise<{ token: string }> {
  const response = await fetch(new URL("/api/auth/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ token: string }>;
}

async function connect(): Promise<ProbeClient> {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: true });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const messages: ServerMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
  return {
    ws,
    messages,
    send(message) { ws.send(JSON.stringify(message)); },
    async waitFor(type, timeoutMs = 12_000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const message = messages.find((candidate) => candidate.type === type);
        if (message) return message as never;
        await delay(10);
      }
      throw new Error(`waitFor(${type}) timed out; saw ${messages.slice(-8).map(({ type: seen }) => seen).join(",")}`);
    },
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const suffix = `${Date.now().toString(36).slice(-5)}`;
const [hostAccount, buddyAccount] = await Promise.all([
  register(`Jitter Host ${suffix}`),
  register(`Jitter Buddy ${suffix}`),
]);
const host = await connect();
host.send({ type: "hello", token: hostAccount.token, name: `Jitter Host ${suffix}`, roomCode: "", preferredSquad: "alpha" });
const welcome = await host.waitFor("welcome");
const buddy = await connect();
buddy.send({ type: "hello", token: buddyAccount.token, name: `Jitter Buddy ${suffix}`, roomCode: welcome.roomCode, preferredSquad: "alpha" });
await buddy.waitFor("welcome");
host.send({ type: "startMatch" });
const start = await host.waitFor("matchStart", 20_000);
await host.waitFor("snap");

const intervals: number[] = [];
const rtts: number[] = [];
let lastSnapAt: number | null = null;
let measuring = true;
host.ws.on("message", (data) => {
  const message = JSON.parse(data.toString()) as ServerMessage;
  if (!measuring) return;
  if (message.type === "snap") {
    const now = performance.now();
    if (lastSnapAt !== null) intervals.push(now - lastSnapAt);
    lastSnapAt = now;
  } else if (message.type === "pong") {
    rtts.push(Date.now() - message.cts);
  }
});

let seq = 0;
let buddySeq = 0;
const directions: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const inputTimer = setInterval(() => {
  const phase = Math.floor((Date.now() / 2500) % directions.length);
  const move = directions[phase] ?? directions[0];
  host.send({ type: "input", seq: ++seq, move, dash: seq % 120 === 0 });
  buddy.send({ type: "input", seq: ++buddySeq, move: [-move[0], -move[1]], dash: buddySeq % 120 === 0 });
}, 33);
const pingTimer = setInterval(() => host.send({ type: "ping", cts: Date.now() }), 1000);

await delay(durationMs);
measuring = false;
clearInterval(inputTimer);
clearInterval(pingTimer);
host.send({ type: "input", seq: ++seq, move: [0, 0], dash: false });

const result = {
  url: baseUrl.origin,
  roomCode: welcome.roomCode,
  insertion: start.insertionName,
  durationMs,
  negotiatedExtensions: host.ws.extensions || "none",
  snapshots: intervals.length + 1,
  interArrivalMs: {
    p50: rounded(percentile(intervals, 0.5)),
    p90: rounded(percentile(intervals, 0.9)),
    p99: rounded(percentile(intervals, 0.99)),
    max: rounded(Math.max(0, ...intervals)),
  },
  burstsUnder15Ms: intervals.filter((value) => value < 15).length,
  stallsOver100Ms: intervals.filter((value) => value > 100).length,
  rttMs: {
    samples: rtts.length,
    p50: rounded(percentile(rtts, 0.5)),
    p90: rounded(percentile(rtts, 0.9)),
  },
};

console.log(JSON.stringify(result, null, 2));
host.ws.close();
buddy.ws.close();
