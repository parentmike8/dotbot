import type { GameConfig } from "@dotbot/game/types";
import { isBaseTutorialComplete } from "@dotbot/game/baseTutorial";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { NoopPersistence, type Persistence, type PlayerIdentity } from "./db";
import { Room, type PublicMemberRelease, type RoomBandwidthHealth, type RoomPeer } from "./Room";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type RoomManagerOptions = {
  countdownMs?: number;
  config?: Partial<GameConfig>;
  now?: () => number;
  persistence?: Persistence;
  /** Test hook: disable AI squad backfill (see Room). */
  aiWingmates?: boolean;
  /** Test/replay hook; production uses random UUID match seeds. */
  matchIdFactory?: () => string;
  /** Mobile network handoff grace passed through to rooms. */
  connectionHandoffMs?: number;
  /** Dedicated GameLift processes resolve exactly one externally allocated
   * room code. Cloud Run leaves this unset and keeps the legacy multi-room
   * behavior during migration. */
  sessionRoomCode?: () => Promise<string>;
  endedRoomTtlMs?: number;
  onRoomExpired?: () => void | Promise<void>;
  hotArena?: import("./Room").HotArenaOptions;
  onPublicAdmissionChange?: (state: { arenaId: string; open: boolean; closesAt?: number }) => void | Promise<void>;
  onPublicMemberReleased?: (release: PublicMemberRelease) => void | Promise<void>;
};

export type PublicPlayerAdmission = {
  playerId: string;
  arenaId: string;
  partyId: string;
  buildId: string;
  region: string;
};

export class RoomManager {
  private readonly roomMap = new Map<string, Room>();
  private readonly peerRooms = new Map<string, { room: Room; playerId: string }>();
  private readonly tickSamples: number[] = [];
  private readonly options: RoomManagerOptions;
  private readonly persistence: Persistence;
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionRoomLookup: Promise<void> | null = null;
  private lastSessionRoomLookupAt = Number.NEGATIVE_INFINITY;
  private sessionEnding = false;
  private stopped = false;

  constructor(options: RoomManagerOptions = {}) {
    this.options = options;
    this.persistence = options.persistence ?? new NoopPersistence();
  }

  get rooms(): number {
    return this.roomMap.size;
  }

  get tickP99Ms(): number {
    if (this.tickSamples.length === 0) return 0;
    const sorted = [...this.tickSamples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }

  get roomHealth(): RoomBandwidthHealth[] {
    return [...this.roomMap.values()].map((room) => room.bandwidthHealth);
  }

  get safeToTerminate(): boolean {
    return [...this.roomMap.values()].every((room) => room.safeToTerminate);
  }

  requestRetirement(): void {
    for (const room of this.roomMap.values()) room.requestRetirement();
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.interval = setInterval(() => this.tick(), 4);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await Promise.allSettled([...this.roomMap.values()].map((room) => room.waitForPersistence()));
    for (const room of this.roomMap.values()) room.dispose();
    this.roomMap.clear();
    this.peerRooms.clear();
  }

  createRoom(requestedCode?: string): Room {
    let code = requestedCode?.trim().toUpperCase() ?? "";
    if (!code) {
      do {
        code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
      } while (this.roomMap.has(code));
    }
    const existing = this.roomMap.get(code);
    if (existing) return existing;
    const room = new Room(code, this.options);
    this.roomMap.set(code, room);
    return room;
  }

  join(code: string): Room | undefined {
    return this.roomMap.get(code.trim().toUpperCase());
  }

  async handleHello(
    peer: RoomPeer,
    message: Extract<ClientMessage, { type: "hello" }>,
    expectedPlayerId?: string,
    isPeerActive: () => boolean = () => true,
  ): Promise<boolean> {
    if (!this.persistence.live) {
      peer.send({
        type: "err",
        code: "storage_unavailable",
        msg: "Authoritative base progress could not be verified. Try again.",
      });
      return false;
    }
    let identity;
    try {
      identity = await this.persistence.resolveOrRegisterPlayer(message.token, message.name);
    } catch {
      console.warn("[persistence] identity lookup failed; rejecting admission.");
      peer.send({ type: "err", code: "storage_unavailable", msg: "Player identity could not be verified. Try again." });
      return false;
    }
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    if (!matchesReservedPlayerIdentity(identity, expectedPlayerId)) {
      peer.send({ type: "err", code: "player_identity_mismatch", msg: "This player session belongs to a different account." });
      return false;
    }
    let tutorial;
    try {
      tutorial = await this.persistence.getBaseTutorialForPlayer(identity.playerId);
    } catch {
      console.warn("[persistence] tutorial lookup failed; rejecting admission.");
      peer.send({ type: "err", code: "storage_unavailable", msg: "Base progress could not be verified. Try again." });
      return false;
    }
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    if (!tutorial || !isBaseTutorialComplete(tutorial)) {
      peer.send({
        type: "err",
        code: "tutorial_required",
        msg: "Complete the base introduction before deploying.",
      });
      return false;
    }
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    const assignedCode = this.options.sessionRoomCode ? await this.options.sessionRoomCode() : undefined;
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    if (assignedCode && message.roomCode && message.roomCode.trim().toUpperCase() !== assignedCode) {
      peer.send({ type: "err", code: "room_not_found", msg: "That room is hosted by a different game session." });
      return false;
    }
    const room = assignedCode
      ? this.join(assignedCode) ?? this.createRoom(assignedCode)
      : message.roomCode ? this.join(message.roomCode) : this.createRoom();
    if (!room) {
      peer.send({ type: "err", code: "room_not_found", msg: "That room does not exist." });
      return false;
    }
    const member = room.join(
      peer,
      message.token,
      identity.name,
      formatPublicPlayerId(identity.publicPlayerId),
      message.preferredSquad,
      undefined,
      undefined,
      undefined,
      identity.playerId,
      identity.previousPublicPlayerIds?.map(formatPublicPlayerId),
    );
    if (!member) {
      peer.send({ type: "err", code: "room_unavailable", msg: "That room cannot be joined." });
      return false;
    }
    this.peerRooms.set(peer.id, { room, playerId: member.playerId });
    return true;
  }

  async handleQuickPlayHello(
    peer: RoomPeer,
    message: Extract<ClientMessage, { type: "quickPlayHello" }>,
    admission?: PublicPlayerAdmission,
    isPeerActive: () => boolean = () => true,
  ): Promise<boolean> {
    if (!this.options.hotArena) {
      peer.send({ type: "err", code: "quick_play_unavailable", msg: "Public quick play is not enabled on this server." });
      return false;
    }
    if (!this.persistence.live) {
      peer.send({ type: "err", code: "storage_unavailable", msg: "Authoritative base progress could not be verified. Try again." });
      return false;
    }
    let identity;
    try {
      identity = await this.persistence.resolveOrRegisterPlayer(message.token, message.name);
    } catch (error) {
      console.warn("[persistence] identity lookup failed; rejecting public admission.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      peer.send({ type: "err", code: "storage_unavailable", msg: "Player identity could not be verified. Try again." });
      return false;
    }
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    if (!matchesReservedPlayerIdentity(identity, admission?.playerId)) {
      peer.send({ type: "err", code: "player_identity_mismatch", msg: "This player session belongs to a different account." });
      return false;
    }
    try {
      const tutorial = await this.persistence.getBaseTutorialForPlayer(identity.playerId);
      if (!tutorial || !isBaseTutorialComplete(tutorial)) {
        peer.send({ type: "err", code: "tutorial_required", msg: "Complete the base introduction before deploying." });
        return false;
      }
    } catch (error) {
      console.warn("[persistence] tutorial lookup failed; rejecting public admission.", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      peer.send({ type: "err", code: "storage_unavailable", msg: "Base progress could not be verified. Try again." });
      return false;
    }
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    const assignedArenaId = this.options.sessionRoomCode ? await this.options.sessionRoomCode() : undefined;
    if (!isPeerActive() || peer.isOpen?.() === false) return false;
    if (admission && assignedArenaId && admission.arenaId !== assignedArenaId) {
      peer.send({ type: "err", code: "arena_mismatch", msg: "This reservation belongs to a different arena." });
      return false;
    }
    const arenaId = admission?.arenaId ?? assignedArenaId ?? "PUB1";
    const room = this.join(arenaId) ?? this.createRoom(arenaId);
    let rejection: { code: string; retryable: boolean } | undefined;
    const member = room.join(
      peer,
      message.token,
      identity.name,
      formatPublicPlayerId(identity.publicPlayerId),
      undefined,
      admission?.partyId ?? identity.playerId,
      (value) => { rejection = value; },
      admission?.playerId,
      identity.playerId,
      identity.previousPublicPlayerIds?.map(formatPublicPlayerId),
    );
    if (!member) {
      peer.send({
        type: "err",
        code: rejection?.code ?? "arena_unavailable",
        msg: rejection?.code === "party_composition_full"
          ? "This arena cannot fit the intact party. Retry quick play together."
          : rejection?.code === "arena_capacity"
            ? "This arena cannot accept another party. Retry quick play together."
          : "That arena is live, full, or retiring. Re-enter quick play.",
        ...(rejection?.retryable ? { retryable: true } : {}),
      });
      return false;
    }
    this.peerRooms.set(peer.id, { room, playerId: member.playerId });
    return true;
  }

  async handleMessage(
    peer: RoomPeer,
    message: ClientMessage,
    expected?: string | PublicPlayerAdmission,
    isPeerActive?: () => boolean,
  ): Promise<boolean> {
    if (message.type === "baseHello" || message.type === "baseInput") {
      peer.send({ type: "err", code: "bad_message", msg: "Base tutorial messages use the base session." });
      return false;
    }
    if (message.type === "hello") {
      return this.handleHello(peer, message, typeof expected === "string" ? expected : expected?.playerId, isPeerActive);
    }
    if (message.type === "quickPlayHello") {
      return this.handleQuickPlayHello(peer, message, typeof expected === "string" ? undefined : expected, isPeerActive);
    }
    const binding = this.peerRooms.get(peer.id);
    if (!binding) {
      peer.send({ type: "err", code: "hello_required", msg: "Send hello before other messages." });
      return false;
    }
    binding.room.receive(binding.playerId, message);
    return true;
  }

  disconnect(peerId: string): void {
    const binding = this.peerRooms.get(peerId);
    if (!binding) return;
    binding.room.disconnect(peerId);
    this.peerRooms.delete(peerId);
  }

  private tick(): void {
    const now = this.options.now?.() ?? Date.now();
    this.ensureAssignedRoom(now);
    for (const [code, room] of this.roomMap) {
      this.tickSamples.push(...room.tick(now));
      if (this.tickSamples.length > 2000) this.tickSamples.splice(0, this.tickSamples.length - 2000);
      const emptyLobbyExpired = (room.phase === "lobby" || room.phase === "assembling") && room.connectedCount === 0 && now - room.createdAt >= 10 * 60_000;
      const endedExpired = room.readyForDisposal && room.endedAt !== null && now - room.endedAt >= (this.options.endedRoomTtlMs ?? 30_000);
      const publicRetirementReady = Boolean(this.options.hotArena && room.readyForDisposal);
      if (emptyLobbyExpired || endedExpired || publicRetirementReady) {
        room.dispose();
        this.roomMap.delete(code);
        if (this.options.sessionRoomCode) {
          this.sessionEnding = true;
          Promise.resolve(this.options.onRoomExpired?.()).catch((error) => {
            console.error("[gamelift] failed to end expired room process.", {
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          });
        }
      }
    }
  }

  private ensureAssignedRoom(now: number): void {
    if (!this.options.sessionRoomCode || this.roomMap.size > 0 || this.sessionRoomLookup
      || this.sessionEnding || this.stopped || now - this.lastSessionRoomLookupAt < 500) return;
    this.lastSessionRoomLookupAt = now;
    this.sessionRoomLookup = this.options.sessionRoomCode()
      .then((code) => {
        if (!this.stopped && !this.sessionEnding && code) this.createRoom(code);
      })
      // Before OnStartGameSession the loopback adapter intentionally has no
      // assigned metadata. Poll quietly; once assigned, creating the empty
      // room starts the bounded idle-retirement clock even if the first player
      // abandons their reservation before opening a WebSocket.
      .catch(() => undefined)
      .finally(() => {
        this.sessionRoomLookup = null;
      });
  }
}

function formatPublicPlayerId(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

/** The GameLift reservation remains authoritative. Canonical and retired
 * internal aliases are server-only; public IDs are accepted only for rolling
 * compatibility and never become persistence or directory identity. */
export function matchesReservedPlayerIdentity(
  identity: PlayerIdentity,
  expectedPlayerId: string | undefined,
): boolean {
  if (expectedPlayerId === undefined) return true;
  const expectedRaw = expectedPlayerId.trim().toUpperCase();
  if (!expectedRaw) return false;
  const expectedPublic = expectedRaw.replace(/-/g, "");
  return identity.playerId.toUpperCase() === expectedRaw
    || identity.previousPlayerIds?.some((playerId) => playerId.toUpperCase() === expectedRaw) === true
    || identity.publicPlayerId.toUpperCase() === expectedPublic
    || identity.previousPublicPlayerIds?.some((playerId) => playerId.toUpperCase() === expectedPublic) === true;
}
