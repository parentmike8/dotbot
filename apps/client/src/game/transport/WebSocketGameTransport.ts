import type { ClientMessage, DeliveryClass } from "@dotbot/protocol";
import type { GameTransport, GameTransportHandlers } from "./GameTransport";

/**
 * Compatibility transport for current production and older mobile browsers.
 * WebSocket cannot drop stale packets independently, so both delivery classes
 * share one ordered stream here. The semantic split is preserved for the
 * WebTransport implementation.
 */
export class WebSocketGameTransport implements GameTransport {
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  connect(handlers: GameTransportHandlers): void {
    if (this.socket) return;
    const socket = new WebSocket(resolveWebSocketUrl(this.url));
    this.socket = socket;
    socket.addEventListener("open", handlers.open);
    socket.addEventListener("message", (event) => {
      handlers.message(JSON.parse(String(event.data)) as import("@dotbot/protocol").ServerMessage);
    });
    socket.addEventListener("error", handlers.error);
    socket.addEventListener("close", handlers.close);
  }

  send(message: ClientMessage, _delivery: DeliveryClass): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

export const createWebSocketGameTransport = (url: string): GameTransport =>
  new WebSocketGameTransport(url);

function resolveWebSocketUrl(value: string): string {
  if (/^wss?:\/\//.test(value)) return value;
  const url = new URL(value, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
