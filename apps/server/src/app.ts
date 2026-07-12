import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createPersistence, type Persistence } from "./db";
import { RoomManager, type RoomManagerOptions } from "./RoomManager";

export type CreateServerOptions = RoomManagerOptions & {
  databaseUrl?: string | null;
  persistence?: Persistence;
};

export async function createServer(options: CreateServerOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const persistence = options.persistence ?? await createPersistence(options.databaseUrl);
  const rooms = new RoomManager({ ...options, persistence });

  app.get("/api/health", async () => ({ rooms: rooms.rooms, tickP99Ms: rooms.tickP99Ms, roomHealth: rooms.roomHealth }));

  app.post<{ Body: { name?: unknown } }>("/api/auth/register", async (request, reply) => {
    const name = sanitizeName(request.body?.name);
    if (!name) return reply.code(400).send({ error: "A display name is required." });
    const account = await persistence.registerPlayer(name);
    return { playerId: account.playerId, token: account.token };
  });

  app.post<{ Body: { token?: unknown } }>("/api/auth/hello", async (request, reply) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    if (!token) return reply.code(400).send({ error: "A device token is required." });
    const player = await persistence.helloPlayer(token);
    if (!player) return reply.code(404).send({ error: "Unknown device token." });
    return player;
  });

  if (process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL("../../client/dist", import.meta.url)),
      wildcard: false,
    });
    app.get("/*", (_request, reply) => reply.sendFile("index.html"));
  }

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 512 },
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    const peer = {
      id: randomUUID(),
      send(message: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        await rooms.handleMessage(peer, message);
      } catch {
        peer.send({ type: "err", code: "bad_message", msg: "Message must be valid JSON." });
      }
    });
    ws.on("close", () => rooms.disconnect(peer.id));
  });

  app.addHook("onReady", async () => rooms.start());
  app.addHook("onClose", async () => {
    rooms.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await persistence.close();
  });

  return { app, rooms, persistence };
}

function sanitizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 24) : "";
}
