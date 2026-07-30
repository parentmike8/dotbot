import { isBaseTutorialPhase, type BaseTutorialState } from "@dotbot/game/baseTutorial";
import type { InputCommand, Vec2 } from "@dotbot/game/types";
import type { ClientMessage, ServerMessage } from "@dotbot/protocol";

const inputIntervalMs = 1000 / 30;

export type BaseTutorialConnectionState = {
  tutorial: BaseTutorialState;
  playerPosition: Vec2;
};

export class BaseTutorialConnection {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private ready = false;
  private seq = 0;
  private lastSentAt = -Infinity;
  private dashQueued = false;

  constructor(
    private readonly token: string,
    private readonly onState: (state: BaseTutorialConnectionState) => void,
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
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.disposed) return;
    this.ready = false;
    this.seq = 0;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.socket = socket;
    socket.addEventListener("open", () => this.send({ type: "baseHello", token: this.token }));
    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        this.onError("BASE LINK RETURNED AN INVALID MESSAGE");
        return;
      }
      if (message.type === "baseWelcome" || message.type === "baseState") {
        if (!validTutorial(message.tutorial) || !Number.isInteger(message.inputAck) || message.inputAck < -1) {
          this.onError("BASE LINK RETURNED INVALID PROGRESS");
          return;
        }
        this.seq = resumeInputSequence(this.seq, message.inputAck);
        this.ready = true;
        this.onState({
          tutorial: { ...message.tutorial },
          playerPosition: { ...message.playerPosition },
        });
      } else if (message.type === "err") {
        this.onError(message.msg.toUpperCase());
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.ready = false;
      if (this.disposed) return;
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
}

export function resumeInputSequence(current: number, inputAck: number): number {
  return Math.max(current, inputAck + 1);
}

function validTutorial(value: BaseTutorialState): boolean {
  return isBaseTutorialPhase(value?.phase)
    && Number.isInteger(value?.revision)
    && value.revision >= 0;
}
