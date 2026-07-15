import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import type { WireItemCode } from "@dotbot/protocol";
import { isBaseObjectKind, validateBaseLayout } from "@dotbot/game/content/base";
import type { BaseLayout } from "@dotbot/game/types";
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

  app.get<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/profile", async (request, reply) => {
    const token = request.headers["x-device-token"] ?? bearerToken(request.headers.authorization);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const profile = await persistence.getProfile(token);
    if (!profile) return reply.code(404).send({ error: "Unknown device token." });
    return profile;
  });

  app.get<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/base", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const base = await persistence.getBase(token);
    if (!base) return reply.code(404).send({ error: "Unknown device token." });
    return { storageLinked: persistence.live, ...base };
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { layout?: unknown } }>("/api/base/layout", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const layout = parseBaseLayout(request.body?.layout);
    if (!layout) return reply.code(400).send({ error: "Layout contains an unknown slot, object kind, or zone mismatch." });
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    const saved = await persistence.saveBaseLayout(token, layout);
    if (!saved) return reply.code(404).send({ error: "Unknown device token." });
    return { layout: saved };
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { loadout?: unknown } }>("/api/base/loadout", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const loadout = parseLoadout(request.body?.loadout);
    if (!loadout) return reply.code(400).send({ error: "Loadout must contain at most four powerups; blueprint fragments are cargo." });
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const base = await persistence.setLoadout(token, loadout);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
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

function bearerToken(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function authToken(headers: { "x-device-token"?: string; authorization?: string }): string | undefined {
  return headers["x-device-token"] ?? bearerToken(headers.authorization);
}

function parseBaseLayout(value: unknown): BaseLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const layout: BaseLayout = {};
  for (const [slotId, kind] of Object.entries(value)) {
    if (!isBaseObjectKind(kind)) return null;
    layout[slotId] = kind;
  }
  try {
    validateBaseLayout(layout);
    return layout;
  } catch {
    return null;
  }
}

function parseLoadout(value: unknown): WireItemCode[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  return value.every((code) => code === "h" || code === "r" || code === "d" || code === "i") ? value as WireItemCode[] : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
