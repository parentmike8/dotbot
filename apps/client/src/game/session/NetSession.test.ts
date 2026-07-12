import { afterEach, describe, expect, it, vi } from "vitest";
import { downtownMap } from "@dotbot/game/content/downtown";
import { NetSession } from "./NetSession";

describe("NetSession item edges", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends useBay once over 30Hz frames and routes GIVE UP through leaveRun", () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const sent: Array<Record<string, unknown>> = [];
    const session = new NetSession({ url: "/ws", roomCode: "TEST", name: "Ada", token: "token" });
    Object.assign(session as unknown as object, {
      socket: { readyState: 1, send: (value: string) => sent.push(JSON.parse(value) as Record<string, unknown>) },
      mapValue: downtownMap,
    });

    session.sendInput({ move: { x: 0, y: 0 }, dash: false, useBay: 2 });
    session.sendInput({ move: { x: 0, y: 0 }, dash: false });
    session.sendInput({ move: { x: 0, y: 0 }, dash: false });
    session.giveUp();

    expect(sent[0]).toMatchObject({ type: "input", seq: 1, useBay: 2 });
    expect(sent[1]).toMatchObject({ type: "input", seq: 2 });
    expect(sent[1]).not.toHaveProperty("useBay");
    expect(sent[2]).toEqual({ type: "leaveRun" });
  });
});
