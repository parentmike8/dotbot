import type { ClientMessage, DeliveryClass, ServerMessage } from "@dotbot/protocol";

export type GameTransportHandlers = {
  open(): void;
  message(message: ServerMessage): void;
  error(): void;
  close(): void;
};

/** Transport boundary shared by browser and native-container builds. */
export interface GameTransport {
  connect(handlers: GameTransportHandlers): void;
  send(message: ClientMessage, delivery: DeliveryClass): void;
  close(): void;
}

export type GameTransportFactory = (url: string) => GameTransport;
