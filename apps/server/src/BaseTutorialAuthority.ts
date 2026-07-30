import {
  BASE_TUTORIAL_DOOR_ID,
  BASE_TUTORIAL_ENTRY_Y,
  BASE_TUTORIAL_FABRICATOR_DOT_ID,
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_TARGET_ID,
  type BaseTutorialAction,
  type BaseTutorialState,
} from "@dotbot/game/baseTutorial";
import { createBaseMap } from "@dotbot/game/content/base";
import { defaultGameConfig } from "@dotbot/game/config";
import { DotBotSimulation } from "@dotbot/game/simulation";
import type { GameSnapshot, InputCommand, Vec2 } from "@dotbot/game/types";
import type { Persistence } from "./db";

const maxElapsedMs = 250;
const fabricatorChannelMs = 1_000;
const movementEvidenceDistance = 28;
const reconnectGraceMs = 15_000;

export type BaseTutorialInput = {
  seq: number;
  input: InputCommand;
  interact: boolean;
};

export type BaseTutorialAuthoritativeState = {
  tutorial: BaseTutorialState;
  playerPosition: Vec2;
  inputAck: number;
  snapshot: GameSnapshot;
};

type LiveTutorialSession = {
  token: string;
  playerId: string;
  simulation: DotBotSimulation;
  tutorial: BaseTutorialState;
  origin: Vec2;
  seq: number;
  lastAt: number;
  accumulatorMs: number;
  fabricatorProgressMs: number;
  fabricatorPosition: Vec2;
  peerId: string | null;
  removalTimer: ReturnType<typeof setTimeout> | null;
};

export class BaseTutorialAuthority {
  private readonly sessions = new Map<string, LiveTutorialSession>();
  private readonly sessionsByToken = new Map<string, LiveTutorialSession>();
  private readonly now: () => number;

  constructor(
    private readonly persistence: Persistence,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  async connect(peerId: string, token: string): Promise<BaseTutorialAuthoritativeState> {
    if (!this.persistence.live) throw new Error("Authoritative storage is unavailable.");
    const identity = await this.persistence.helloPlayer(token);
    const base = await this.persistence.getBase(token);
    if (!identity || !base) throw new Error("Unknown device token.");

    const existing = this.sessionsByToken.get(token);
    if (existing) {
      if (existing.peerId) throw new Error("This base introduction is already connected.");
      if (existing.removalTimer) clearTimeout(existing.removalTimer);
      existing.removalTimer = null;
      existing.peerId = peerId;
      existing.lastAt = this.now();
      this.sessions.set(peerId, existing);
      return this.state(existing);
    }

    this.disconnect(peerId, true);
    const map = createBaseMap(base.layout, "workshop", { tutorial: base.tutorial });
    const simulation = await DotBotSimulation.create({
      map,
      config: {
        ...defaultGameConfig,
        runDurationMs: Number.MAX_SAFE_INTEGER,
        damageSpeed: 250,
        dashSpeed: 760,
      },
    });
    const snapshot = simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player");
    const fabricatorPosition = map.interactionDots?.find((dot) => dot.id === BASE_TUTORIAL_FABRICATOR_DOT_ID)?.position;
    if (!player || !fabricatorPosition) {
      simulation.dispose();
      throw new Error("Base introduction map is incomplete.");
    }
    const session: LiveTutorialSession = {
      token,
      playerId: identity.playerId,
      simulation,
      tutorial: { ...base.tutorial },
      origin: { ...player.position },
      seq: -1,
      lastAt: this.now(),
      accumulatorMs: 0,
      fabricatorProgressMs: 0,
      fabricatorPosition: { ...fabricatorPosition },
      peerId,
      removalTimer: null,
    };
    this.sessions.set(peerId, session);
    this.sessionsByToken.set(token, session);
    this.applyWorldState(session);
    return this.state(session);
  }

  async handleInput(peerId: string, frame: BaseTutorialInput): Promise<BaseTutorialAuthoritativeState> {
    const session = this.sessions.get(peerId);
    if (!session) throw new Error("No authoritative base tutorial session exists for this peer.");
    if (!Number.isInteger(frame.seq) || frame.seq < 0) throw new Error("Tutorial input sequence must be non-negative.");
    if (frame.seq <= session.seq) throw new Error("Tutorial input frame was replayed.");
    if (frame.seq !== session.seq + 1) throw new Error("Tutorial input frame arrived out of order.");
    const input = verifiedInput(frame.input);
    if (typeof frame.interact !== "boolean") throw new Error("Tutorial interaction intent must be boolean.");

    const now = this.now();
    const elapsedMs = Math.max(0, Math.min(maxElapsedMs, now - session.lastAt));
    session.lastAt = now;
    session.seq = frame.seq;
    session.accumulatorMs += elapsedMs;
    const tickMs = 1000 / session.simulation.config.tickHz;

    while (session.accumulatorMs >= tickMs) {
      session.simulation.applyInput("player", input);
      session.simulation.step();
      const events = session.simulation.drainEvents();
      await this.deriveEvidence(session, input, frame.interact, tickMs, events);
      session.accumulatorMs -= tickMs;
    }
    return this.state(session);
  }

  disconnect(peerId: string, immediate = false): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    session.peerId = null;
    if (session.removalTimer) clearTimeout(session.removalTimer);
    const remove = () => {
      if (session.peerId) return;
      session.simulation.dispose();
      this.sessionsByToken.delete(session.token);
      session.removalTimer = null;
    };
    if (immediate) {
      remove();
      return;
    }
    session.removalTimer = setTimeout(remove, reconnectGraceMs);
    session.removalTimer.unref?.();
  }

  close(): void {
    for (const session of this.sessionsByToken.values()) {
      if (session.removalTimer) clearTimeout(session.removalTimer);
      session.simulation.dispose();
    }
    this.sessions.clear();
    this.sessionsByToken.clear();
  }

  private async deriveEvidence(
    session: LiveTutorialSession,
    input: InputCommand,
    interact: boolean,
    tickMs: number,
    events: ReturnType<DotBotSimulation["drainEvents"]>,
  ): Promise<void> {
    const snapshot = session.simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player");
    if (!player) return;

    if (
      session.tutorial.phase === "movement"
      && distance(player.position, session.origin) >= movementEvidenceDistance
    ) {
      await this.advance(session, "moved");
      return;
    }

    if (
      session.tutorial.phase === "practice"
      && events.some((event) =>
        event.type === "downed"
        && event.botId === BASE_TUTORIAL_TARGET_ID
        && event.byBotId === "player")
    ) {
      await this.advance(session, "practiceHit");
      return;
    }

    if (session.tutorial.phase === "fabricator") {
      const holdingStill = Math.hypot(input.move.x, input.move.y) <= 0.05;
      const inReach = distance(player.position, session.fabricatorPosition) <= 52;
      session.fabricatorProgressMs = interact && holdingStill && inReach
        ? session.fabricatorProgressMs + tickMs
        : 0;
      if (session.fabricatorProgressMs >= fabricatorChannelMs) {
        await this.advance(session, "usedFabricator");
      }
      return;
    }

    if (session.tutorial.phase === "doorOpen" && player.position.y < BASE_TUTORIAL_ENTRY_Y) {
      await this.advance(session, "enteredBase");
    }
  }

  private async advance(session: LiveTutorialSession, action: BaseTutorialAction): Promise<void> {
    const base = await this.persistence.advanceBaseTutorial(
      session.token,
      action,
      session.tutorial.revision,
    );
    if (!base) throw new Error("Tutorial progress could not be persisted.");
    session.tutorial = { ...base.tutorial };
    this.applyWorldState(session);
  }

  private applyWorldState(session: LiveTutorialSession): void {
    const phase = session.tutorial.phase;
    const fabricatorEnabled = phase === "fabricator" || phase === "doorOpen" || phase === "complete";
    session.simulation.setMapObjectEnabled(BASE_TUTORIAL_FABRICATOR_ID, fabricatorEnabled);
    session.simulation.setDoorLocked(BASE_TUTORIAL_DOOR_ID, phase !== "doorOpen" && phase !== "complete");
    if (phase === "complete") session.simulation.removeBot(BASE_TUTORIAL_TARGET_ID);
  }

  private state(session: LiveTutorialSession): BaseTutorialAuthoritativeState {
    const snapshot = session.simulation.getSnapshot();
    const player = snapshot.bots.find((bot) => bot.id === "player");
    if (!player) throw new Error("Tutorial player is missing.");
    return {
      tutorial: { ...session.tutorial },
      playerPosition: { ...player.position },
      inputAck: session.seq,
      snapshot,
    };
  }
}

function verifiedInput(input: InputCommand): InputCommand {
  const x = input?.move?.x;
  const y = input?.move?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) > 1.001) {
    throw new Error("Tutorial movement input is invalid.");
  }
  if (typeof input.dash !== "boolean") throw new Error("Tutorial dash input is invalid.");
  return { move: { x, y }, dash: input.dash };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
