import { isBaseTutorialPhase, type BaseTutorialState } from "@dotbot/game/baseTutorial";
import type { GameSnapshot, InputCommand, Vec2 } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";

const inputIntervalMs = 1000 / 30;
const authoritySilenceMs = 2000;

export type BaseTutorialConnectionState = {
  tutorial: BaseTutorialState;
  playerPosition: Vec2;
  inputAck: number;
  snapshot: GameSnapshot;
  fabricatorEnabled: boolean;
};

export type BaseTutorialConnectionStatus = "connecting" | "connected" | "disconnected";

export class BaseTutorialConnection {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private authorityTimer: number | null = null;
  private disposed = false;
  private ready = false;
  private seq = 0;
  private lastSentAt = -Infinity;
  private dashQueued = false;

  constructor(
    private readonly token: string,
    private readonly onState: (state: BaseTutorialConnectionState) => void,
    private readonly onConnectionState: (status: BaseTutorialConnectionStatus) => void,
    private readonly onError: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    this.connect();
  }

  sendInput(input: InputCommand, interact: boolean): void {
    this.dashQueued ||= input.dash;
    const now = this.now();
    if (!this.ready || !this.socket || now - this.lastSentAt < inputIntervalMs) return;
    this.lastSentAt = now;
    this.send({
      type: "baseInput",
      seq: this.seq++,
      move: [input.move.x, input.move.y],
      dash: this.dashQueued,
      interact,
    });
    this.dashQueued = false;
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.authorityTimer !== null) window.clearTimeout(this.authorityTimer);
    this.reconnectTimer = null;
    this.authorityTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.disposed) return;
    this.ready = false;
    this.seq = 0;
    this.dashQueued = false;
    this.onConnectionState("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket = socket;
    socket.addEventListener("open", () => this.send({ type: "baseHello", token: this.token }));
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        this.onError("BASE LINK RETURNED AN INVALID MESSAGE");
        return;
      }
      if (message.type === "baseWelcome" || message.type === "baseState") {
        if (
          !validTutorial(message.tutorial)
          || !Number.isInteger(message.inputAck)
          || message.inputAck < -1
          || typeof message.fabricatorEnabled !== "boolean"
          || !validSnapshot(message.snapshot, message.playerPosition)
        ) {
          this.ready = false;
          this.onError("BASE LINK RETURNED INVALID PROGRESS");
          socket.close();
          return;
        }
        this.seq = resumeInputSequence(this.seq, message.inputAck);
        this.ready = true;
        this.armAuthorityTimer(socket);
        this.onConnectionState("connected");
        this.onState({
          tutorial: { ...message.tutorial },
          playerPosition: { ...message.playerPosition },
          inputAck: message.inputAck,
          snapshot: message.snapshot,
          fabricatorEnabled: message.fabricatorEnabled,
        });
      } else if (message.type === "err") {
        this.onError(message.msg.toUpperCase());
        if (!this.ready) socket.close();
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.authorityTimer !== null) window.clearTimeout(this.authorityTimer);
      this.authorityTimer = null;
      this.ready = false;
      if (this.disposed) return;
      this.onConnectionState("disconnected");
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 500);
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private armAuthorityTimer(socket: WebSocket): void {
    if (this.authorityTimer !== null) window.clearTimeout(this.authorityTimer);
    this.authorityTimer = window.setTimeout(() => {
      this.authorityTimer = null;
      if (this.disposed || this.socket !== socket) return;
      this.ready = false;
      this.onError("BASE LINK SILENT · MOVEMENT PAUSED");
      this.onConnectionState("disconnected");
      socket.close();
    }, authoritySilenceMs);
  }
}

export function resumeInputSequence(current: number, inputAck: number): number {
  return Math.max(current, inputAck + 1);
}

function validTutorial(value: BaseTutorialState): boolean {
  return isBaseTutorialPhase(value?.phase)
    && Number.isInteger(value?.revision)
    && value.revision >= 0;
}

function validSnapshot(snapshot: GameSnapshot, position: Vec2): boolean {
  if (
    !snapshot
    || !Array.isArray(snapshot.bots)
    || !Array.isArray(snapshot.dots)
    || !Array.isArray(snapshot.mines)
    || !Number.isFinite(snapshot.timeMs)
    || !Number.isFinite(position?.x)
    || !Number.isFinite(position?.y)
  ) return false;
  const player = snapshot.bots.find((bot) => bot.id === "player");
  return Boolean(
    player
    && Number.isFinite(player.position?.x)
    && Number.isFinite(player.position?.y)
    && Math.abs(player.position.x - position.x) < 0.001
    && Math.abs(player.position.y - position.y) < 0.001,
  );
}
