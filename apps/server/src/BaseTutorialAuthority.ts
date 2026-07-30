import {
  BASE_TUTORIAL_DOOR_ID,
  BASE_TUTORIAL_ENTRY_Y,
  BASE_TUTORIAL_FABRICATOR_DOT_ID,
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_TARGET_ID,
  advanceBaseTutorial,
  isBaseTutorialComplete,
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
  fabricatorEnabled: boolean;
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
  fabricatorPosition: Vec2 | null;
  pendingAction: BaseTutorialAction | null;
  peerId: string | null;
  removalTimer: ReturnType<typeof setTimeout> | null;
};

type PendingTutorialReservation = {
  token: string;
  peerId: string;
  cancelled: boolean;
};

export class BaseTutorialAuthority {
  private readonly sessions = new Map<string, LiveTutorialSession>();
  private readonly sessionsByToken = new Map<string, LiveTutorialSession>();
  private readonly pendingByPeer = new Map<string, PendingTutorialReservation>();
  private readonly pendingByToken = new Map<string, PendingTutorialReservation>();
  private readonly now: () => number;

  constructor(
    private readonly persistence: Persistence,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
  }

  async connect(peerId: string, token: string): Promise<BaseTutorialAuthoritativeState> {
    if (!this.persistence.live) throw new Error("Authoritative storage is unavailable.");

    if (this.sessions.has(peerId) || this.pendingByPeer.has(peerId)) {
      throw new Error("This peer already owns a base introduction connection.");
    }
    const existing = this.sessionsByToken.get(token);
    if (existing) {
      if (isBaseTutorialComplete(existing.tutorial)) {
        throw new Error("This base introduction is already complete.");
      }
      if (existing.peerId) throw new Error("This base introduction is already connected.");
      if (existing.removalTimer) clearTimeout(existing.removalTimer);
      existing.removalTimer = null;
      existing.peerId = peerId;
      existing.lastAt = this.now();
      this.sessions.set(peerId, existing);
      return this.state(existing);
    }
    if (this.pendingByToken.has(token)) {
      throw new Error("This base introduction is already connecting.");
    }

    // The token credential is the ownership key. Reserve it synchronously before
    // authentication, persistence, or Rapier initialization yields, otherwise two
    // peers can both build a simulation and both become valid seq-0 writers.
    const reservation: PendingTutorialReservation = { token, peerId, cancelled: false };
    this.pendingByPeer.set(peerId, reservation);
    this.pendingByToken.set(token, reservation);
    let simulation: DotBotSimulation | null = null;
    try {
      const identity = await this.persistence.helloPlayer(token);
      this.assertReservation(reservation);
      const base = await this.persistence.getBase(token);
      this.assertReservation(reservation);
      if (!identity || !base) throw new Error("Unknown device token.");
      if (isBaseTutorialComplete(base.tutorial)) {
        throw new Error("This base introduction is already complete.");
      }

      const map = createBaseMap(base.layout, "workshop", { tutorial: base.tutorial });
      simulation = await DotBotSimulation.create({
        map,
        config: {
          ...defaultGameConfig,
          runDurationMs: Number.MAX_SAFE_INTEGER,
          damageSpeed: 250,
          dashSpeed: 760,
        },
      });
      this.assertReservation(reservation);
      const snapshot = simulation.getSnapshot();
      const player = snapshot.bots.find((bot) => bot.id === "player");
      const fabricatorPosition = map.interactionDots
        ?.find((dot) => dot.id === BASE_TUTORIAL_FABRICATOR_DOT_ID)?.position ?? null;
      if (!player || (!fabricatorPosition && base.tutorial.phase !== "complete")) {
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
        fabricatorPosition: fabricatorPosition ? { ...fabricatorPosition } : null,
        pendingAction: null,
        peerId,
        removalTimer: null,
      };
      this.sessions.set(peerId, session);
      this.sessionsByToken.set(token, session);
      this.releaseReservation(reservation);
      simulation = null;
      this.applyWorldState(session);
      return this.state(session);
    } catch (error) {
      simulation?.dispose();
      this.releaseReservation(reservation);
      throw error;
    }
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
    await this.flushPendingEvidence(session);
    session.accumulatorMs += elapsedMs;
    const tickMs = 1000 / session.simulation.config.tickHz;

    while (session.accumulatorMs >= tickMs) {
      session.simulation.applyInput("player", input);
      session.simulation.step();
      const events = session.simulation.drainEvents();
      session.accumulatorMs -= tickMs;
      await this.deriveEvidence(session, input, frame.interact, tickMs, events);
    }
    return this.state(session);
  }

  disconnect(peerId: string, immediate = false): void {
    const pending = this.pendingByPeer.get(peerId);
    if (pending) {
      pending.cancelled = true;
      this.releaseReservation(pending);
    }
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    session.peerId = null;
    if (session.removalTimer) clearTimeout(session.removalTimer);
    const remove = () => {
      if (session.peerId) return;
      session.simulation.dispose();
      if (this.sessionsByToken.get(session.token) === session) {
        this.sessionsByToken.delete(session.token);
      }
      session.removalTimer = null;
    };
    if (immediate || isBaseTutorialComplete(session.tutorial)) {
      remove();
      return;
    }
    session.removalTimer = setTimeout(remove, reconnectGraceMs);
    session.removalTimer.unref?.();
  }

  close(): void {
    for (const reservation of this.pendingByToken.values()) reservation.cancelled = true;
    this.pendingByPeer.clear();
    this.pendingByToken.clear();
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
      await this.recordEvidence(session, "moved");
      return;
    }

    if (
      session.tutorial.phase === "practice"
      && events.some((event) =>
        event.type === "downed"
        && event.botId === BASE_TUTORIAL_TARGET_ID
        && event.byBotId === "player")
    ) {
      await this.recordEvidence(session, "practiceHit");
      return;
    }

    if (session.tutorial.phase === "fabricator") {
      const holdingStill = Math.hypot(input.move.x, input.move.y) <= 0.05;
      const inReach = session.fabricatorPosition !== null
        && distance(player.position, session.fabricatorPosition) <= 52;
      session.fabricatorProgressMs = interact && holdingStill && inReach
        ? session.fabricatorProgressMs + tickMs
        : 0;
      if (session.fabricatorProgressMs >= fabricatorChannelMs) {
        await this.recordEvidence(session, "usedFabricator");
      }
      return;
    }

    if (session.tutorial.phase === "doorOpen" && player.position.y < BASE_TUTORIAL_ENTRY_Y) {
      await this.recordEvidence(session, "enteredBase");
    }
  }

  private async recordEvidence(session: LiveTutorialSession, action: BaseTutorialAction): Promise<void> {
    if (session.pendingAction && session.pendingAction !== action) {
      throw new Error("Tutorial evidence is already awaiting durable persistence.");
    }
    session.pendingAction = action;
    await this.flushPendingEvidence(session);
  }

  private async flushPendingEvidence(session: LiveTutorialSession): Promise<void> {
    const action = session.pendingAction;
    if (!action) return;
    const expected = advanceBaseTutorial(session.tutorial, action).state;
    const base = await this.persistence.advanceBaseTutorial(
      session.token,
      action,
      session.tutorial.revision,
    );
    if (!base) throw new Error("Tutorial progress could not be persisted.");
    if (
      base.tutorial.phase !== expected.phase
      || base.tutorial.revision !== expected.revision
    ) {
      throw new Error("Tutorial persistence did not durably record the evidence.");
    }
    session.tutorial = { ...base.tutorial };
    session.pendingAction = null;
    this.applyWorldState(session);
  }

  private applyWorldState(session: LiveTutorialSession): void {
    const phase = session.tutorial.phase;
    const fabricatorEnabled = phase === "fabricator" || phase === "doorOpen";
    session.simulation.setMapObjectEnabled(BASE_TUTORIAL_FABRICATOR_ID, fabricatorEnabled);
    session.simulation.setDoorLocked(BASE_TUTORIAL_DOOR_ID, phase !== "doorOpen" && phase !== "complete");
    if (phase === "complete") session.simulation.removeBot(BASE_TUTORIAL_TARGET_ID);
  }

  private assertReservation(reservation: PendingTutorialReservation): void {
    if (
      reservation.cancelled
      || this.pendingByPeer.get(reservation.peerId) !== reservation
      || this.pendingByToken.get(reservation.token) !== reservation
    ) {
      throw new Error("Base introduction ownership reservation was cancelled.");
    }
  }

  private releaseReservation(reservation: PendingTutorialReservation): void {
    if (this.pendingByPeer.get(reservation.peerId) === reservation) {
      this.pendingByPeer.delete(reservation.peerId);
    }
    if (this.pendingByToken.get(reservation.token) === reservation) {
      this.pendingByToken.delete(reservation.token);
    }
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
      fabricatorEnabled: session.tutorial.phase === "fabricator" || session.tutorial.phase === "doorOpen",
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
