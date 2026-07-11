import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import { DotBotSimulation } from "@dotbot/game/simulation";
import type { BotSpawn, InputCommand } from "@dotbot/game/types";
import { toEntityMeta, toWireSnapshot } from "@dotbot/protocol";
import type { ClientMessage, LobbyMember, RoomPhase, ServerMessage } from "@dotbot/protocol";

export interface RoomPeer {
  readonly id: string;
  send(message: ServerMessage): void;
}

type Member = LobbyMember & {
  token: string;
  peer: RoomPeer | null;
  botId: string | null;
  latestInput: InputCommand;
  latestSeq: number;
  handoffTimer: ReturnType<typeof setTimeout> | null;
};

type RoomOptions = {
  countdownMs?: number;
  now?: () => number;
};

const squads = ["alpha", "bravo", "crew-3"] as const;
const squadColors = ["#ff3b6b", "#2f80ed", "#9b51e0"] as const;
const squadAnchors = [
  { x: 300, y: 920 },
  { x: 1500, y: 800 },
  { x: 2210, y: 1320 },
] as const;

export class Room {
  readonly code: string;
  phase: RoomPhase = "lobby";
  createdAt: number;
  endedAt: number | null = null;
  droppedTickMs = 0;

  private readonly members = new Map<string, Member>();
  private readonly memberByToken = new Map<string, Member>();
  private readonly countdownMs: number;
  private readonly now: () => number;
  private simulation: DotBotSimulation | null = null;
  private hostId = "";
  private accumulatorMs = 0;
  private tickDurationMs = 1000 / defaultGameConfig.tickHz;
  private lastTickAt: number;
  private matchStartPromise: Promise<void> | null = null;

  constructor(code: string, options: RoomOptions = {}) {
    this.code = code;
    this.countdownMs = options.countdownMs ?? 3000;
    this.now = options.now ?? Date.now;
    this.createdAt = this.now();
    this.lastTickAt = this.createdAt;
  }

  get size(): number {
    return this.members.size;
  }

  get connectedCount(): number {
    return [...this.members.values()].filter((member) => member.peer !== null).length;
  }

  get lobbyMembers(): LobbyMember[] {
    return [...this.members.values()].map(({ playerId, name, squadId }) => ({ playerId, name, squadId }));
  }

  join(peer: RoomPeer, token: string, requestedName: string): Member | null {
    const existing = this.memberByToken.get(token);
    if (existing) {
      existing.peer = peer;
      existing.name = sanitizeName(requestedName);
      if (existing.handoffTimer) {
        clearTimeout(existing.handoffTimer);
        existing.handoffTimer = null;
      }
      if (this.phase === "live" && existing.botId) {
        this.simulation?.setController(existing.botId, "human");
      }
      this.sendWelcome(existing);
      if (this.phase === "live") {
        this.sendMatchStart(existing);
      }
      return existing;
    }

    if (this.phase !== "lobby" || this.members.size >= squads.length * 4) {
      return null;
    }

    const index = this.members.size;
    const member: Member = {
      playerId: `p-${token.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "") || index}`,
      token,
      name: sanitizeName(requestedName),
      squadId: squads[index % squads.length],
      peer,
      botId: null,
      latestInput: { move: { x: 0, y: 0 }, dash: false },
      latestSeq: 0,
      handoffTimer: null,
    };
    this.members.set(member.playerId, member);
    this.memberByToken.set(token, member);
    if (!this.hostId) {
      this.hostId = member.playerId;
    }
    this.sendWelcome(member);
    this.broadcastLobby();
    return member;
  }

  receive(playerId: string, message: Exclude<ClientMessage, { type: "hello" }>): void {
    const member = this.members.get(playerId);
    if (!member) return;

    switch (message.type) {
      case "startMatch":
        if (playerId !== this.hostId) {
          member.peer?.send({ type: "err", code: "not_host", msg: "Only the host can start the match." });
          return;
        }
        if (this.phase !== "lobby") {
          member.peer?.send({ type: "err", code: "bad_phase", msg: "The match has already started." });
          return;
        }
        this.beginCountdown();
        return;
      case "input":
        if (this.phase !== "live" || message.seq <= member.latestSeq) return;
        member.latestSeq = message.seq;
        member.latestInput = { move: { x: message.move[0], y: message.move[1] }, dash: message.dash };
        return;
      case "ping":
        member.peer?.send({ type: "pong", cts: message.cts, sts: this.now() });
        return;
    }
  }

  disconnect(peerId: string): void {
    const member = [...this.members.values()].find((candidate) => candidate.peer?.id === peerId);
    if (!member) return;
    member.peer = null;

    if (this.phase === "lobby") {
      this.members.delete(member.playerId);
      this.memberByToken.delete(member.token);
      if (member.playerId === this.hostId) {
        this.hostId = this.members.keys().next().value ?? "";
      }
      this.broadcastLobby();
      return;
    }

    if (this.phase === "live" && member.botId) {
      this.simulation?.setController(member.botId, "frozen");
      member.handoffTimer = setTimeout(() => {
        member.handoffTimer = null;
        if (!member.peer && member.botId && this.phase === "live") {
          this.simulation?.setController(member.botId, "ai");
        }
      }, 15_000);

      if (this.connectedCount === 0) {
        this.end("all_humans_disconnected");
      }
    }
  }

  tick(now = this.now()): number[] {
    if (this.phase !== "live" || !this.simulation) {
      this.lastTickAt = now;
      return [];
    }

    const elapsed = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    this.accumulatorMs += elapsed;
    const durations: number[] = [];
    let steps = 0;

    while (this.accumulatorMs >= this.tickDurationMs && steps < 5) {
      const started = performance.now();
      for (const member of this.members.values()) {
        if (!member.botId) continue;
        this.simulation.applyInput(member.botId, member.latestInput);
        member.latestInput = { move: member.latestInput.move, dash: false };
      }
      this.simulation.step();
      durations.push(performance.now() - started);
      this.accumulatorMs -= this.tickDurationMs;
      steps += 1;

      if (this.simulation.getSnapshot().debug.tickCount % 3 === 0) {
        this.broadcastSnapshot();
      }
    }

    if (steps === 5 && this.accumulatorMs >= this.tickDurationMs) {
      this.droppedTickMs += this.accumulatorMs;
      this.accumulatorMs = 0;
    }
    return durations;
  }

  dispose(): void {
    for (const member of this.members.values()) {
      if (member.handoffTimer) clearTimeout(member.handoffTimer);
    }
    this.simulation?.dispose();
    this.simulation = null;
  }

  private beginCountdown(): void {
    this.phase = "countdown";
    this.matchStartPromise = new Promise((resolve) => setTimeout(resolve, this.countdownMs)).then(() => this.startMatch());
  }

  private async startMatch(): Promise<void> {
    if (this.phase !== "countdown") return;
    const simulation = await DotBotSimulation.create({ map: downtownMap, config: defaultGameConfig });
    for (const spawn of downtownMap.botSpawns) simulation.removeBot(spawn.id);

    const squadCounts = new Map<string, number>();
    for (const member of this.members.values()) {
      const squadIndex = squads.indexOf(member.squadId as (typeof squads)[number]);
      const count = squadCounts.get(member.squadId) ?? 0;
      const anchor = squadAnchors[squadIndex];
      const botId = `human-${member.playerId}`;
      simulation.spawnBot(makeSpawn(botId, member.name, member.squadId, squadColors[squadIndex], anchor, count), "human");
      member.botId = botId;
      squadCounts.set(member.squadId, count + 1);
    }

    for (const [squadId, count] of squadCounts) {
      if (count >= 2) continue;
      const squadIndex = squads.indexOf(squadId as (typeof squads)[number]);
      simulation.spawnBot(
        makeSpawn(`ai-${squadId}`, `${squadId} wing`, squadId, squadColors[squadIndex], squadAnchors[squadIndex], count),
        "ai",
      );
    }
    for (const spawn of downtownMap.botSpawns.filter((candidate) => candidate.isAmbient)) {
      simulation.spawnBot(spawn, "ai");
    }

    this.simulation = simulation;
    this.tickDurationMs = 1000 / simulation.config.tickHz;
    this.accumulatorMs = 0;
    this.lastTickAt = this.now();
    this.phase = "live";
    for (const member of this.members.values()) this.sendMatchStart(member);
  }

  private sendWelcome(member: Member): void {
    member.peer?.send({
      type: "welcome",
      playerId: member.playerId,
      roomCode: this.code,
      phase: this.phase,
      members: this.lobbyMembers,
      hostId: this.hostId,
    });
  }

  private broadcastLobby(): void {
    this.broadcast({ type: "lobby", members: this.lobbyMembers, hostId: this.hostId });
  }

  private sendMatchStart(member: Member): void {
    if (!member.botId || !this.simulation) return;
    const snapshot = this.simulation.getSnapshot();
    member.peer?.send({
      type: "matchStart",
      map: downtownMap,
      config: this.simulation.config,
      yourBotId: member.botId,
      meta: snapshot.bots.map(toEntityMeta),
      tickHz: this.simulation.config.tickHz,
      endTick: Number.MAX_SAFE_INTEGER,
    });
  }

  private broadcastSnapshot(): void {
    if (!this.simulation) return;
    const snapshot = toWireSnapshot(this.simulation.getSnapshot(), Math.max(0, ...[...this.members.values()].map((member) => member.latestSeq)));
    this.broadcast({ type: "snap", ...snapshot });
    this.broadcast({ type: "ev", events: this.simulation.drainEvents() });
  }

  private end(reason: string): void {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.endedAt = this.now();
    this.broadcast({ type: "matchEnd", reason });
  }

  private broadcast(message: ServerMessage): void {
    for (const member of this.members.values()) member.peer?.send(message);
  }
}

function makeSpawn(id: string, name: string, squadId: string, color: string, anchor: { x: number; y: number }, offset: number): BotSpawn {
  return {
    id,
    name,
    squadId,
    color,
    position: { x: anchor.x + (offset % 2) * 70, y: anchor.y + Math.floor(offset / 2) * 70 },
  };
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 24) || "Player";
}
