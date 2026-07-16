import type { DownedHostileVerb, GameConfig, MapDocument, PowerupType, RadarPing } from "@dotbot/game/types";
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
  f?: number;
  fl?: string;
  s?: "downed" | "consumed";
  sh?: number[];
  /** Detailed inventory is present only for the viewer's squad. */
  b?: (WireItemCode | null)[];
  h?: WireItemCode[];
  /** Always present, including privacy-redacted rivals. */
  c?: number;
  d?: [number, number];
  iv?: number;
  r?: [number, RadarPing[]?];
  o?: number;
  ic?: number;
};

export type WireDot = {
  id: string;
  position: { x: number; y: number };
  radius: number;
  floorId: string;
  it: WireItemCode;
  active: boolean;
  captureProgressMs?: number;
};

export type WireDotDelta = {
  id: string;
  active?: boolean;
  captureProgressMs?: number;
};

export type WireDotContextSync = {
  /** Physics-floor context whose dot state is replaced wholesale. */
  context: string;
  dots?: WireDot[];
};

export type WireMine = {
  id: string;
  position: { x: number; y: number };
  radius: number;
  floorId: string;
  placedAtMs: number;
  placedByBotId?: string;
  squadId?: string;
  revealedToBotIds?: string[];
  presentation?: "squad" | "disguised" | "revealed";
  disguise?: PowerupType;
  seam?: true;
};

/** Full server-side snapshot before per-viewer dot delta encoding. */
export type FullWireSnapshot = {
  tick: number;
  bots: WireBot[];
  dots: WireDot[];
  mines: WireMine[];
  coverages: import("@dotbot/game/types").CoverageSnapshot[];
  noises: import("@dotbot/game/types").NoiseEvent[];
  /** Viewer-private match intel; omitted for players without an intel object. */
  intel?: MatchIntel;
};

/** Per-viewer snapshot payload sent after the one-time dot baseline. */
export type WireSnapshot = {
  tick: number;
  ack: number;
  bots: WireBot[];
  dotDeltas?: WireDotDelta[];
  dotSync?: WireDotContextSync[];
  mines?: WireMine[];
  coverages?: import("@dotbot/game/types").CoverageSnapshot[];
  noises?: import("@dotbot/game/types").NoiseEvent[];
  /** Viewer-private match intel; omitted for players without an intel object. */
  intel?: MatchIntel;
};

export type MatchIntel = {
  greyDensity?: Array<{ buildingId: string; buildingName: string; count: number }>;
  signal?: {
    dotId: string;
    blueprintId: string;
    position: { x: number; y: number };
    floorId: string;
    expiresAtTick: number;
  };
};

export type WireSimEvent =
  | { type: "downed"; botId: string; byBotId?: string }
  | { type: "consumed"; botId: string; byBotId: string; lostItems: WireItemCode[] }
  | { type: "revived"; botId: string; byBotId: string }
  | { type: "plea"; botId: string; squadId: string; position: { x: number; y: number }; floorId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: WireItemCode[] }
  | { type: "mineRotated"; botId: string; mineId: string }
  | { type: "mineSensor"; botId: string; squadId: string; mineId: string; position: { x: number; y: number }; floorId: string };

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
      downedVerb?: DownedHostileVerb;
      plea?: boolean;
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
      insertionName: string;
      dotBaseline: WireDot[];
      intel?: MatchIntel;
    }
  | ({ type: "snap" } & WireSnapshot)
  | { type: "meta"; add: EntityMeta[]; remove: string[] }
  | { type: "ev"; events: WireSimEvent[] }
  | { type: "runOver"; reason: "extracted" | "died" | "timeout"; keptItems: WireItemCode[]; lostItems: WireItemCode[]; learnedBlueprints: string[]; contractCompletions?: Array<{ contractId: string; title: string; payout: WireItemCode[] }> }
  | { type: "matchEnd"; reason: string }
  | { type: "pong"; cts: number; sts: number }
  | { type: "err"; code: string; msg: string };

export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
