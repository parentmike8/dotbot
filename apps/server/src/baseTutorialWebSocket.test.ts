import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { createServer } from "./app";
import { NoopPersistence } from "./db";

class LiveTutorialPersistence extends NoopPersistence {
  override readonly live = true;
}

describe("base tutorial WebSocket evidence path", () => {
  it("binds evidence to one authenticated peer and rejects forged, skipped, and replayed frames", async () => {
    process.env.NODE_ENV = "test";
    const persistence = new LiveTutorialPersistence();
    const { app } = await createServer({ persistence });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected server address.");
    const account = await persistence.registerPlayer("Evidence Pilot");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const inbox: ServerMessage[] = [];
    socket.on("message", (data) => inbox.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
    const waitFor = async (type: ServerMessage["type"], after = 0) => {
      const started = Date.now();
      while (Date.now() - started < 2_000) {
        const found = inbox.slice(after).find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${type}.`);
    };

    send({ type: "baseInput", seq: 0, move: [0, 0], dash: false, interact: true });
    expect(await waitFor("err")).toMatchObject({ code: "tutorial_session_required" });

    const beforeHello = inbox.length;
    send({ type: "baseHello", token: account.token });
    expect(await waitFor("baseWelcome", beforeHello)).toMatchObject({
      tutorial: { phase: "movement", revision: 0 },
      inputAck: -1,
    });

    const beforeSkip = inbox.length;
    send({ type: "baseInput", seq: 1, move: [0, -1], dash: false, interact: false });
    expect(await waitFor("err", beforeSkip)).toMatchObject({ code: "bad_tutorial_input" });

    const beforeAccepted = inbox.length;
    send({ type: "baseInput", seq: 0, move: [0, 0], dash: false, interact: false });
    await waitFor("baseState", beforeAccepted);
    const beforeReplay = inbox.length;
    send({ type: "baseInput", seq: 0, move: [0, 0], dash: false, interact: true });
    expect(await waitFor("err", beforeReplay)).toMatchObject({ code: "bad_tutorial_input" });

    const beforeSecondHello = inbox.length;
    send({ type: "baseHello", token: account.token });
    expect(await waitFor("err", beforeSecondHello)).toMatchObject({ code: "bad_message" });
    expect((await persistence.getBase(account.token))?.tutorial).toEqual({ phase: "movement", revision: 0 });

    socket.close();
    await app.close();
  });

  it("resumes a disconnected browser from the server replay cursor", async () => {
    process.env.NODE_ENV = "test";
    const persistence = new LiveTutorialPersistence();
    const { app } = await createServer({ persistence });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected server address.");
    const account = await persistence.registerPlayer("Resume Pilot");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const connect = async () => {
      const socket = new WebSocket(url);
      const inbox: ServerMessage[] = [];
      socket.on("message", (data) => inbox.push(JSON.parse(data.toString()) as ServerMessage));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      const waitFor = async (type: ServerMessage["type"]) => {
        const started = Date.now();
        while (Date.now() - started < 2_000) {
          const found = inbox.find((message) => message.type === type);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`Timed out waiting for ${type}.`);
      };
      return { socket, inbox, waitFor };
    };

    const first = await connect();
    first.socket.send(JSON.stringify({ type: "baseHello", token: account.token } satisfies ClientMessage));
    await first.waitFor("baseWelcome");
    first.socket.send(JSON.stringify({
      type: "baseInput",
      seq: 0,
      move: [0, -1],
      dash: false,
      interact: false,
    } satisfies ClientMessage));
    const beforeClose = await first.waitFor("baseState");
    expect(beforeClose).toMatchObject({ inputAck: 0 });
    first.socket.close();
    await new Promise<void>((resolve) => first.socket.once("close", () => resolve()));

    const resumed = await connect();
    resumed.socket.send(JSON.stringify({ type: "baseHello", token: account.token } satisfies ClientMessage));
    const welcome = await resumed.waitFor("baseWelcome");
    expect(welcome).toMatchObject({ inputAck: 0 });
    resumed.socket.send(JSON.stringify({
      type: "baseInput",
      seq: 1,
      move: [0, -1],
      dash: false,
      interact: false,
    } satisfies ClientMessage));
    expect(await resumed.waitFor("baseState")).toMatchObject({ inputAck: 1 });
    expect(resumed.inbox.some((message) => message.type === "err")).toBe(false);

    resumed.socket.close();
    await app.close();
  });
});
