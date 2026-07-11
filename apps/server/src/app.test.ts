import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";

type Inbox = {
  ws: WebSocket;
  messages: ServerMessage[];
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { type: T }>>;
};

const clients: WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe("multiplayer server", () => {
  it("drives two clients through join, start, input, snapshots, and events", async () => {
    process.env.NODE_ENV = "test";
    const { app } = await createServer({ countdownMs: 0 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const a = await connect(url);
    a.send({ type: "hello", token: "token-a", name: "Alice", roomCode: "" });
    const welcomeA = await a.waitFor("welcome");
    expect(welcomeA.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);

    const b = await connect(url);
    b.send({ type: "hello", token: "token-b", name: "Bob", roomCode: welcomeA.roomCode });
    const welcomeB = await b.waitFor("welcome");
    expect(welcomeB.members).toHaveLength(2);

    a.send({ type: "startMatch" });
    const [startA, startB] = await Promise.all([a.waitFor("matchStart", 10_000), b.waitFor("matchStart", 10_000)]);
    expect(startA.yourBotId).not.toBe(startB.yourBotId);
    expect(startA.meta.some((meta) => meta.isAmbient)).toBe(true);

    const firstA = await a.waitFor("snap");
    const initialAX = firstA.bots.find((bot) => bot.i === startA.yourBotId)?.p[0];
    const initialBX = firstA.bots.find((bot) => bot.i === startB.yourBotId)?.p[0];
    expect(initialAX).toBeTypeOf("number");
    expect(initialBX).toBeTypeOf("number");

    for (let seq = 1; seq <= 36; seq += 1) {
      a.send({ type: "input", seq, move: [1, 0], dash: seq === 1 });
      b.send({ type: "input", seq, move: [-1, 0], dash: seq === 1 });
      await delay(17);
    }
    await delay(500);

    const snapsA = a.messages.filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap");
    const snapsB = b.messages.filter((message): message is Extract<ServerMessage, { type: "snap" }> => message.type === "snap");
    expect(snapsA.length).toBeGreaterThan(10);
    expect(snapsB.length).toBeGreaterThan(10);
    const finalA = snapsA.at(-1)!;
    const finalB = snapsB.at(-1)!;
    expect(finalA.tick).toBe(finalB.tick);
    expect(finalA.bots).toEqual(finalB.bots);

    const finalAX = finalA.bots.find((bot) => bot.i === startA.yourBotId)!.p[0];
    const finalBX = finalA.bots.find((bot) => bot.i === startB.yourBotId)!.p[0];
    expect(finalAX).toBeGreaterThan(initialAX! + 30);
    expect(finalBX).toBeLessThan(initialBX! - 30);
    expect(a.messages.some((message) => message.type === "ev")).toBe(true);
    expect(b.messages.some((message) => message.type === "ev")).toBe(true);

    a.ws.close();
    b.ws.close();
    await Promise.all([onceClosed(a.ws), onceClosed(b.ws)]);
    await app.close();
  }, 20_000);
});

async function connect(url: string): Promise<Inbox> {
  const ws = new WebSocket(url);
  clients.push(ws);
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
    async waitFor(type, timeoutMs = 3000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const message = messages.find((candidate) => candidate.type === type);
        if (message) return message as never;
        await delay(5);
      }
      throw new Error(`Timed out waiting for ${type}; saw ${messages.map((message) => message.type).join(",")}`);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceClosed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", () => resolve()));
}
