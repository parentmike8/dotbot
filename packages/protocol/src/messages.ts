import type { GameConfig, MapDocument, SimEvent } from "@dotbot/game/types";

export type RoomPhase = "lobby" | "countdown" | "live" | "ended";

export type LobbyMember = {
  playerId: string;
  name: string;
  squadId: string;
};

export type EntityMeta = {
  id: string;
  name: string;
  squadId: string;
  isAmbient: boolean;
  maxShields: number;
  radius: number;
  /** Static render data. Optional so older peers can still connect. */
  color?: string;
};

export type WireBot = {
  i: string;
  p: [number, number];
  f: number;
  fl: string;
  s: "alive" | "downed" | "consumed";
  sh: number[];
  n: number;
  d?: [number, number];
  iv?: number;
};

export type WireSnapshot = {
  tick: number;
  ack: number;
  bots: WireBot[];
  dots: import("@dotbot/game/types").DotEntity[];
  coverages: import("@dotbot/game/types").CoverageSnapshot[];
  noises: import("@dotbot/game/types").NoiseEvent[];
};

export type ClientMessage =
  | { type: "hello"; token: string; name: string; roomCode: string }
  | { type: "startMatch" }
  | { type: "input"; seq: number; move: [number, number]; dash: boolean }
  | { type: "ping"; cts: number };

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      roomCode: string;
      phase: RoomPhase;
      members: LobbyMember[];
      hostId: string;
    }
  | { type: "lobby"; members: LobbyMember[]; hostId: string }
  | {
      type: "matchStart";
      map: MapDocument;
      config: GameConfig;
      yourBotId: string;
      meta: EntityMeta[];
      tickHz: number;
      endTick: number;
    }
  | ({ type: "snap" } & WireSnapshot)
  | { type: "meta"; add: EntityMeta[]; remove: string[] }
  | { type: "ev"; events: SimEvent[] }
  | { type: "matchEnd"; reason: string }
  | { type: "pong"; cts: number; sts: number }
  | { type: "err"; code: string; msg: string };

export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
