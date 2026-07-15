import type { DotEntity, GameConfig, MapDocument, RadarPing } from "@dotbot/game/types";
import type { WireItemCode } from "./items";

export type RoomPhase = "lobby" | "countdown" | "live" | "ended";

export const LOBBY_SQUADS = ["alpha", "bravo", "crew-3"] as const;
export type LobbySquadId = (typeof LOBBY_SQUADS)[number];

export type LobbyMember = {
  playerId: string;
  name: string;
  squadId: LobbySquadId;
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
  /** Detailed inventory is present only for the viewer's squad. */
  b?: (WireItemCode | null)[];
  h?: WireItemCode[];
  /** Always present, including privacy-redacted rivals. */
  c: number;
  d?: [number, number];
  iv?: number;
  r?: [number, RadarPing[]];
  o?: number;
  ic?: number;
};

export type WireSnapshot = {
  tick: number;
  ack: number;
  bots: WireBot[];
  dots: Array<Omit<DotEntity, "item"> & { it: WireItemCode }>;
  coverages: import("@dotbot/game/types").CoverageSnapshot[];
  noises: import("@dotbot/game/types").NoiseEvent[];
};

export type WireSimEvent =
  | { type: "downed"; botId: string; byBotId?: string }
  | { type: "consumed"; botId: string; byBotId: string; lostItems: WireItemCode[] }
  | { type: "revived"; botId: string; byBotId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: WireItemCode[] };

export type ClientMessage =
  | { type: "hello"; token: string; name: string; roomCode: string; preferredSquad?: LobbySquadId }
  | { type: "joinSquad"; squadId: LobbySquadId }
  | { type: "startMatch" }
  | { type: "leaveRun" }
  | {
      type: "input";
      seq: number;
      move: [number, number];
      dash: boolean;
      useBay?: 0 | 1 | 2 | 3;
      swapBay?: { bayIndex: 0 | 1 | 2 | 3; holdIndex: number };
    }
  | { type: "ping"; cts: number };

export type ServerMessage =
  | {
      type: "welcome";
      playerId: string;
      roomCode: string;
      phase: RoomPhase;
      members: LobbyMember[];
      hostId: string;
      locked: boolean;
    }
  | { type: "lobby"; members: LobbyMember[]; hostId: string; locked: boolean }
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
  | { type: "ev"; events: WireSimEvent[] }
  | { type: "runOver"; reason: "extracted" | "died" | "timeout"; keptItems: WireItemCode[]; lostItems: WireItemCode[]; learnedBlueprints: string[] }
  | { type: "matchEnd"; reason: string }
  | { type: "pong"; cts: number; sts: number }
  | { type: "err"; code: string; msg: string };

export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
