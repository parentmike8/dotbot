import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { RoomManager, type RoomManagerOptions } from "./RoomManager";

export async function createServer(options: RoomManagerOptions = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const rooms = new RoomManager(options);

  app.get("/api/health", async () => ({ rooms: rooms.rooms, tickP99Ms: rooms.tickP99Ms }));

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
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        rooms.handleMessage(peer, message);
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
  });

  return { app, rooms };
}
