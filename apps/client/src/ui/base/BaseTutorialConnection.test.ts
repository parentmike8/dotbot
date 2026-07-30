import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@dotbot/protocol";
import { BaseTutorialConnection, resumeInputSequence } from "./BaseTutorialConnection";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BaseTutorialConnection replay cursor", () => {
  it("starts at zero and resumes after the server's last accepted frame", () => {
    expect(resumeInputSequence(0, -1)).toBe(0);
    expect(resumeInputSequence(1, 0)).toBe(1);
    expect(resumeInputSequence(0, 47)).toBe(48);
  });

  it("never rewinds when an older acknowledgement arrives", () => {
    expect(resumeInputSequence(52, 47)).toBe(52);
  });

  it("fails visibly and stops accepting input when authoritative frames go silent", () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    });
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "example.test" },
      setTimeout,
      clearTimeout,
    });
    const statuses: string[] = [];
    const errors: string[] = [];
    const connection = new BaseTutorialConnection(
      "token",
      () => {},
      (status) => statuses.push(status),
      (error) => errors.push(error),
      () => Date.now(),
    );

    connection.start();
    sockets[0].emit("open", {});
    sockets[0].emit("message", { data: JSON.stringify(welcome()) });
    expect(statuses).toEqual(["connecting", "connected"]);

    vi.advanceTimersByTime(2_100);
    expect(statuses).toContain("disconnected");
    expect(errors).toContain("BASE LINK SILENT · MOVEMENT PAUSED");
    expect(sockets[0].closed).toBe(true);
    connection.dispose();
  });
});

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = FakeWebSocket.OPEN;
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
  }

  emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function welcome(): Extract<ServerMessage, { type: "baseWelcome" }> {
  const player = {
    id: "player", name: "Player", squadId: "base", isAmbient: false, color: "#fff",
    position: { x: 260, y: 640 }, radius: 24, state: "alive" as const, floorId: "outdoor",
    facing: 0, moving: false, maxShields: 3, shields: 3, shieldSegments: [1, 1, 1],
    bays: [], hold: [], carriedCount: 0, searched: false, pleaded: false, radarActiveMs: 0,
    radarPings: [], dashOverchargeCharges: 0, incognitoMs: 0, dashCooldownMs: 0,
    dashActiveMs: 0, invulnerabilityMs: 0,
  };
  return {
    type: "baseWelcome",
    tutorial: { phase: "movement", revision: 0 },
    playerPosition: { x: 260, y: 640 },
    inputAck: -1,
    fabricatorEnabled: false,
    snapshot: {
      timeMs: 0,
      bots: [player],
      dots: [],
      mines: [],
      coverages: [],
      noises: [],
      doors: [],
      debug: { tickHz: 60, tickCount: 0, fps: 60, activeBodies: 1, activeDots: 0 },
    },
  };
}
