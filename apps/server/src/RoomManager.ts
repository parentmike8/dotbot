import type { GameConfig } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";
import { Room, type RoomBandwidthHealth, type RoomPeer } from "./Room";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type RoomManagerOptions = {
  countdownMs?: number;
  config?: Partial<GameConfig>;
  now?: () => number;
};

export class RoomManager {
  private readonly roomMap = new Map<string, Room>();
  private readonly peerRooms = new Map<string, { room: Room; playerId: string }>();
  private readonly tickSamples: number[] = [];
  private readonly options: RoomManagerOptions;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomManagerOptions = {}) {
    this.options = options;
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

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), 4);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const room of this.roomMap.values()) room.dispose();
    this.roomMap.clear();
    this.peerRooms.clear();
  }

  createRoom(): Room {
    let code = "";
    do {
      code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    } while (this.roomMap.has(code));
    const room = new Room(code, this.options);
    this.roomMap.set(code, room);
    return room;
  }

  join(code: string): Room | undefined {
    return this.roomMap.get(code.trim().toUpperCase());
  }

  handleHello(peer: RoomPeer, message: Extract<ClientMessage, { type: "hello" }>): void {
    const room = message.roomCode ? this.join(message.roomCode) : this.createRoom();
    if (!room) {
      peer.send({ type: "err", code: "room_not_found", msg: "That room does not exist." });
      return;
    }
    const member = room.join(peer, message.token, message.name);
    if (!member) {
      peer.send({ type: "err", code: "room_unavailable", msg: "That room cannot be joined." });
      return;
    }
    this.peerRooms.set(peer.id, { room, playerId: member.playerId });
  }

  handleMessage(peer: RoomPeer, message: ClientMessage): void {
    if (message.type === "hello") {
      this.handleHello(peer, message);
      return;
    }
    const binding = this.peerRooms.get(peer.id);
    if (!binding) {
      peer.send({ type: "err", code: "hello_required", msg: "Send hello before other messages." });
      return;
    }
    binding.room.receive(binding.playerId, message);
  }

  disconnect(peerId: string): void {
    const binding = this.peerRooms.get(peerId);
    if (!binding) return;
    binding.room.disconnect(peerId);
    this.peerRooms.delete(peerId);
  }

  private tick(): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [code, room] of this.roomMap) {
      this.tickSamples.push(...room.tick(now));
      if (this.tickSamples.length > 2000) this.tickSamples.splice(0, this.tickSamples.length - 2000);
      const emptyLobbyExpired = room.phase === "lobby" && room.connectedCount === 0 && now - room.createdAt >= 10 * 60_000;
      const endedExpired = room.phase === "ended" && room.endedAt !== null && now - room.endedAt >= 30_000;
      if (emptyLobbyExpired || endedExpired) {
        room.dispose();
        this.roomMap.delete(code);
      }
    }
  }
}
