import {
  BASE_TUTORIAL_FABRICATOR_ID,
} from "@dotbot/game/baseTutorial";
import type {
  GameSnapshot,
  InputCommand,
  MapDocument,
  SimEvent,
} from "@dotbot/game/types";
import {
  BaseTutorialConnection,
  type BaseTutorialConnectionState,
  type BaseTutorialConnectionStatus,
} from "../../ui/base/BaseTutorialConnection";
import type { GameSession, RunState } from "./GameSession";

export type BaseTutorialConnectionLike = {
  start(): void;
  sendInput(input: InputCommand, interact: boolean): void;
  dispose(): void;
};

export type BaseTutorialConnectionCallbacks = {
  onState: (state: BaseTutorialConnectionState) => void;
  onConnectionState: (status: BaseTutorialConnectionStatus) => void;
  onError: (message: string) => void;
};

export type BaseTutorialConnectionFactory = (
  token: string,
  callbacks: BaseTutorialConnectionCallbacks,
) => BaseTutorialConnectionLike;

export type BaseTutorialSessionOptions = {
  map: MapDocument;
  token: string;
  interactionIntent: () => boolean;
  onState: (state: BaseTutorialConnectionState) => void;
  onConnectionState: (status: BaseTutorialConnectionStatus) => void;
  onError: (message: string) => void;
  createConnection?: BaseTutorialConnectionFactory;
};

/**
 * Thin authoritative base-introduction session.
 *
 * It never predicts or advances time. The last complete server snapshot is the
 * rendered frame, so losing the socket freezes both movement and interaction
 * channels until a reconnect supplies the same live simulation again.
 */
export class BaseTutorialSession implements GameSession {
  readonly map: MapDocument;
  readonly playerId = "player";

  private readonly options: BaseTutorialSessionOptions;
  private connection: BaseTutorialConnectionLike | null = null;
  private snapshot: GameSnapshot | null = null;
  private connected = false;

  constructor(options: BaseTutorialSessionOptions) {
    this.options = options;
    this.map = options.map;
  }

  async start(): Promise<void> {
    const callbacks: BaseTutorialConnectionCallbacks = {
      onState: (state) => {
        this.snapshot = state.snapshot;
        const fabricator = this.map.buildings
          .flatMap((building) => building.floors)
          .flatMap((floor) => floor.objects)
          .find((object) => object.id === BASE_TUTORIAL_FABRICATOR_ID);
        if (fabricator) fabricator.enabled = state.fabricatorEnabled;
        this.options.onState(state);
      },
      onConnectionState: (status) => {
        this.connected = status === "connected";
        this.options.onConnectionState(status);
      },
      onError: this.options.onError,
    };
    this.connection = (this.options.createConnection ?? defaultConnection)(
      this.options.token,
      callbacks,
    );
    this.connection.start();
  }

  sendInput(input: InputCommand): void {
    if (!this.connected) return;
    this.connection?.sendInput(input, this.options.interactionIntent());
  }

  update(_elapsedMs: number): GameSnapshot | null {
    return this.snapshot;
  }

  drainEvents(): SimEvent[] {
    return [];
  }

  getRunState(): RunState {
    return { phase: "live" };
  }

  leaveRun(): void {}

  dispose(): void {
    this.connected = false;
    this.connection?.dispose();
    this.connection = null;
  }
}

function defaultConnection(
  token: string,
  callbacks: BaseTutorialConnectionCallbacks,
): BaseTutorialConnection {
  return new BaseTutorialConnection(
    token,
    callbacks.onState,
    callbacks.onConnectionState,
    callbacks.onError,
  );
}
