import type { BayIndex, DownedVerb, DropCommand, GameConfig, MapDocument, PingKind, PowerupType, TakeCommand } from "@dotbot/game/types";
import type { WireItemCode } from "./items";

export type RoomPhase = "lobby" | "assembling" | "countdown" | "live" | "results" | "ended";

/**
 * Delivery semantics are part of the game protocol, not a transport detail.
 * Reliable messages must arrive in order. Latest-state messages may be
 * dropped when a newer one supersedes them (WebTransport datagrams in the
 * production transport; ordinary WebSocket frames in the compatibility
 * transport).
 */
export type DeliveryClass = "reliable" | "latest";

export const LOBBY_SQUADS = ["alpha", "bravo", "crew-3"] as const;
export type LobbySquadId = (typeof LOBBY_SQUADS)[number];

/** Six launch squads for the public extraction queue. Kept separate from the
 * three-squad legacy room protocol so emergency rollback stays additive. */
export const PUBLIC_EXTRACTION_SQUADS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;
export type PublicExtractionSquadId = (typeof PUBLIC_EXTRACTION_SQUADS)[number];
export const PUBLIC_EXTRACTION_ROLE_COUNT = PUBLIC_EXTRACTION_SQUADS.length * 3;

export type PlayerRole = {
  roleId: string;
  squadId: PublicExtractionSquadId;
  slot: 0 | 1 | 2;
  controller: "human" | "ai";
  name: string;
  playerId?: string;
  partyId?: string;
};

export type PublicArenaMember = {
  playerId: string;
  name: string;
  partyId: string;
  queued: boolean;
};

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

export type WireRadarContact = [
  botId: string,
  x: number,
  y: number,
  floorId: string,
  ageMs: number,
];

export type WireBot = {
  i: string;
  p: [number, number];
  f?: number;
  fl?: string;
  s?: "downed";
  sh?: number[];
  /** Moving under its own power. Absent means standing. See `DotBotEntity.moving`. */
  mv?: true;
  /** Detailed inventory is present only for the viewer's squad. */
  b?: (WireItemCode | null)[];
  h?: WireItemCode[];
  /** Optional provenance sidecars aligned with `b` and `h`. */
  bs?: (string | null)[];
  hs?: (string | null)[];
  /** Authoritative inventory mutation revision. */
  ir?: number;
  /** Always present, including privacy-redacted rivals. */
  c?: number;
  /** Searched: this body is open, so `b`/`h` are sent to everyone who can see it. */
  sr?: true;
  /** Pleaded: this body has asked to be picked up. See `DotBotEntity.pleaded`. */
  pl?: true;
  d?: [number, number];
  iv?: number;
  r?: [number, WireRadarContact[]?];
  /** Remaining timed dash-overcharge effect. */
  o?: number;
  ic?: number;
};

export type WireDot = {
  id: string;
  position: { x: number; y: number };
  radius: number;
  floorId: string;
  it: WireItemCode;
  /** Optional item provenance sidecar. */
  src?: string;
  /** Runtime rather than authored map definition. */
  rt?: true;
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
  doors?: import("@dotbot/game/types").DoorEntity[];
  /** Viewer-authorized count populated by the interest filter. */
  rivalsAlive?: number;
  /** Viewer-private match intel; omitted for players without an intel object. */
  intel?: MatchIntel;
};

/** Per-viewer snapshot payload sent after the one-time dot baseline. */
export type WireSnapshot = {
  tick: number;
  ack: number;
  bots: WireBot[];
  dotDeltas?: WireDotDelta[];
  /** Full definitions for runtime dots created after the baseline. */
  dotAdds?: WireDot[];
  /** Complete current runtime-dot set, repeated in every latest snapshot. */
  runtimeDots?: WireDot[];
  dotSync?: WireDotContextSync[];
  mines?: WireMine[];
  coverages?: import("@dotbot/game/types").CoverageSnapshot[];
  noises?: import("@dotbot/game/types").NoiseEvent[];
  doors?: import("@dotbot/game/types").DoorEntity[];
  rivalsAlive?: number;
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

export type KillCamActor = {
  id: string;
  position: { x: number; y: number };
  facing: number;
  floorId: string;
  shieldSegments: number[];
  dashActiveMs: number;
  state: "alive" | "downed";
};

export type KillCamFrame = {
  tick: number;
  victim: KillCamActor;
  /**
   * Present only while the historical victim could legitimately see the
   * source. An absent actor is not a stale last-known position.
   */
  source?: KillCamActor;
  /**
   * Other actors the victim was entitled to know about at this tick: squadmates
   * (including downed squadmates) plus non-squad actors actually visible to the
   * victim. Kept separate from `source` so attacker admission still controls the
   * kill label and camera framing.
   */
  visibleBots: KillCamActor[];
  /** Nearby closed doors that shaped the victim's historical fog. */
  blockingDoorIds: string[];
};

export type KillCamImpact = {
  tick: number;
  result: import("@dotbot/game/types").HitResult;
  position: { x: number; y: number };
  /** Authoritative away-from-attacker presentation direction. */
  direction: { x: number; y: number };
  /** Included only when the clip already admits this source. */
  sourceId?: string;
};

export type KillCamClip = {
  id: string;
  victimId: string;
  /** Omitted for mines, environment, and unknown sources. */
  sourceBotId?: string;
  cause: import("@dotbot/game/types").DownCause;
  startTick: number;
  deathTick: number;
  tickHz: number;
  frames: KillCamFrame[];
  /** Exact authoritative impacts. Optional only for rolling compatibility. */
  impacts?: KillCamImpact[];
};

export type WireKillCamActor = [
  id: string,
  x: number,
  y: number,
  facing: number,
  floorId: string,
  shieldSegments: number[],
  dashActiveMs: number,
  downed?: 1,
];

export type WireKillCamFrame = [
  tick: number,
  victim: WireKillCamActor,
  source: WireKillCamActor | null,
  /** Null is accepted for rolling compatibility with older sparse tuple encoders. */
  blockingDoorIds?: string[] | null,
  visibleBots?: WireKillCamActor[],
];

export type WireKillCamClip = {
  i: string;
  v: string;
  s?: string;
  c: [kind: 0 | 1 | 2 | 3, tick: number, x: number, y: number, dx: number, dy: number];
  a: number;
  z: number;
  h: number;
  f: WireKillCamFrame[];
  /** [tick, result, x, y, dx, dy, admitted source id?] */
  p?: Array<[number, 0 | 1, number, number, number, number, string?]>;
};

export type WireSimEvent =
  | {
      type: "hit";
      botId: string;
      byBotId: string;
      /** Optional on the wire for rolling compatibility with older rooms. */
      result?: import("@dotbot/game/types").HitResult;
      position?: { x: number; y: number };
      direction?: { x: number; y: number };
      tick?: number;
    }
  | {
      type: "dashContact";
      botId: string;
      byBotId: string;
      result: import("@dotbot/game/types").DashContactResult;
      position: { x: number; y: number };
      direction: { x: number; y: number };
      tick: number;
    }
  | { type: "downed"; botId: string; byBotId?: string; cause?: import("@dotbot/game/types").DownCause }
  | { type: "searched"; botId: string; byBotId: string }
  | { type: "looted"; botId: string; byBotId: string; items: WireItemCode[]; itemSources?: (string | null)[] }
  | { type: "revived"; botId: string; byBotId: string }
  | { type: "recruited"; botId: string; byBotId: string; fromSquadId: string; squadId: string }
  | { type: "plea"; botId: string; squadId: string; position: { x: number; y: number }; floorId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "extracted"; botId: string; squadId: string; items: WireItemCode[]; itemSources?: (string | null)[] }
  | { type: "mineRotated"; botId: string; mineId: string }
  | { type: "mineSensor"; botId: string; squadId: string; mineId: string; position: { x: number; y: number }; floorId: string }
  | {
      type: "pinged";
      botId: string;
      squadId: string;
      pingId: string;
      kind: PingKind;
      position: { x: number; y: number };
      floorId: string;
    };

/**
 * One prediction tick's worth of input. The client emits exactly one frame
 * per 60Hz tick and the server consumes exactly one per simulation tick, so
 * reconciliation replay is tick-exact regardless of transport jitter.
 */
export type WireInputFrame = {
  seq: number;
  move: [number, number];
  dash: boolean;
  /** Server tick of the remote world that was visible when this input frame
   * was cut. Dash lag compensation uses this exact combat timeline instead
   * of guessing from a periodically sampled RTT. */
  viewTick?: number;
  useBay?: BayIndex;
  swapBay?: { bayIndex: BayIndex; holdIndex: number };
  drop?: DropCommand;
  downedVerb?: DownedVerb;
  take?: TakeCommand;
  plea?: boolean;
  ping?: { kind: PingKind; position: [number, number]; floorId?: string };
};

/**
 * Does this frame carry a one-shot edge, rather than just movement?
 *
 * Three places need this exact answer: the client decides whether a frame ships
 * immediately and reliably, and the server's jitter buffer sheds frames in two
 * places and must shed continuous movement in preference to a press. It was
 * written out field by field in all of them, so a new action had to be remembered
 * five times over — and a list you have to remember is a list that goes stale.
 *
 * A `downedVerb` is deliberately not an edge: it is standing state, repeated every
 * frame a key is held, so shedding one costs nothing.
 */
export type ActionEdges = {
  dash?: boolean;
  useBay?: BayIndex;
  swapBay?: unknown;
  drop?: unknown;
  take?: unknown;
  plea?: boolean;
  ping?: unknown;
};

export function carriesAction(frame: ActionEdges): boolean {
  return frame.dash === true
    || frame.useBay !== undefined
    || frame.swapBay !== undefined
    || frame.drop !== undefined
    || frame.take !== undefined
    || frame.plea === true
    // A ping is the most obviously one-shot input there is: shedding it loses the mark
    // outright, and the player has no way to know it did not arrive.
    || frame.ping !== undefined;
}

export type ClientMessage =
  | { type: "baseHello"; token: string }
  | { type: "baseInput"; seq: number; move: [number, number]; dash: boolean; interact: boolean }
  | {
      type: "hello";
      token: string;
      name: string;
      roomCode: string;
      preferredSquad?: LobbySquadId;
      /** Required on the production GameLift path. The dedicated server
       * accepts it with the local Server SDK before admitting the peer. */
      playerSessionId?: string;
    }
  | {
      type: "quickPlayHello";
      token: string;
      name: string;
      /** Required on the production GameLift path. */
      playerSessionId?: string;
    }
  | { type: "joinSquad"; squadId: LobbySquadId }
  | { type: "startMatch" }
  | { type: "deployAgain" }
  | { type: "leaveRun" }
  /** Victim finished or skipped this exact replay; releases the server input gate. */
  | { type: "killCamDone"; clipId: string }
  | {
      type: "input";
      seq: number;
      move: [number, number];
      dash: boolean;
      viewTick?: number;
      useBay?: BayIndex;
      swapBay?: { bayIndex: BayIndex; holdIndex: number };
      drop?: DropCommand;
      downedVerb?: DownedVerb;
      take?: TakeCommand;
      plea?: boolean;
      ping?: { kind: PingKind; position: [number, number]; floorId?: string };
      /** Tick-stamped frame batch (newest last), including redundant copies
       * of recent frames so a dropped packet cannot lose an input. When
       * present, the top-level fields mirror the newest frame and exist for
       * older peers/scripted clients only. */
      frames?: WireInputFrame[];
    }
  | { type: "ping"; cts: number; viewDelayMs?: number };

export type ServerMessage =
  | {
      type: "baseWelcome";
      tutorial: import("@dotbot/game/baseTutorial").BaseTutorialState;
      playerPosition: { x: number; y: number };
      /** Last server-accepted input frame; reconnecting clients continue at the next value. */
      inputAck: number;
      /** Complete authoritative base-introduction frame; the browser never runs a parallel simulation. */
      snapshot: import("@dotbot/game/types").GameSnapshot;
      /** Runtime fixture state not represented by GameSnapshot. */
      fabricatorEnabled: boolean;
    }
  | {
      type: "baseState";
      tutorial: import("@dotbot/game/baseTutorial").BaseTutorialState;
      playerPosition: { x: number; y: number };
      inputAck: number;
      snapshot: import("@dotbot/game/types").GameSnapshot;
      fabricatorEnabled: boolean;
    }
  | {
      type: "welcome";
      playerId: string;
      roomCode: string;
      phase: RoomPhase;
      members: LobbyMember[];
      hostId: string;
      locked: boolean;
    }
  | {
      type: "arenaWelcome";
      playerId: string;
      arenaId: string;
      phase: Extract<RoomPhase, "assembling" | "countdown" | "live" | "results">;
      members: PublicArenaMember[];
      retiring: boolean;
      assemblyStartedAt?: number;
      assemblyDeadlineAt?: number;
    }
  | { type: "lobby"; members: LobbyMember[]; hostId: string; locked: boolean }
  | {
      type: "arenaState";
      phase: Extract<RoomPhase, "assembling" | "countdown" | "live" | "results">;
      members: PublicArenaMember[];
      retiring: boolean;
      assemblyStartedAt?: number;
      assemblyDeadlineAt?: number;
    }
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
      /** Present on the additive public hot-arena path. */
      matchId?: string;
      roles?: PlayerRole[];
    }
  | ({ type: "snap" } & WireSnapshot)
  | { type: "meta"; add: EntityMeta[]; remove: string[] }
  | { type: "roleController"; matchId: string; roleId: string; controller: "ai"; reason: "disconnect_timeout" | "player_left" }
  | { type: "ev"; events: WireSimEvent[] }
  /** Reliable and addressed only to the victim. Never broadcast. */
  | { type: "killCam"; clip: WireKillCamClip }
  | { type: "runOver"; reason: "extracted" | "died" | "timeout"; keptItems: WireItemCode[]; lostItems: WireItemCode[]; learnedBlueprints: string[]; contractCompletions?: Array<{ contractId: string; title: string; payout: WireItemCode[] }>; persistenceStatus?: "saved" | "failed" }
  | { type: "matchEnd"; reason: string }
  | { type: "pong"; cts: number; sts: number; tick?: number }
  | { type: "err"; code: string; msg: string; retryable?: boolean };

export function assertNever(value: never): never {
  throw new Error(`Unhandled message: ${JSON.stringify(value)}`);
}
