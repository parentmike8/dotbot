export type Vec2 = {
  x: number;
  y: number;
};

export type BotTeam = "player" | "ally" | "enemy";

export type BotState = "alive" | "downed" | "consumed";

export type GameEntity = {
  id: string;
  position: Vec2;
  radius: number;
};

export type DotBotEntity = GameEntity & {
  name: string;
  team: BotTeam;
  color: string;
  state: BotState;
  maxShields: number;
  shields: number;
  inventoryDots: number;
  dashCooldownMs: number;
  dashActiveMs: number;
  invulnerabilityMs: number;
};

export type DotEntity = GameEntity & {
  color: string;
  active: boolean;
  capturedBy?: string;
  captureProgressMs: number;
};

export type Wall = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type MapZone = {
  id: string;
  kind: "road" | "building" | "room" | "park";
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
};

export type BotSpawn = {
  id: string;
  name: string;
  team: BotTeam;
  color: string;
  position: Vec2;
  state?: BotState;
  maxShields?: number;
  shields?: number;
  inventoryDots?: number;
};

export type DotSpawn = {
  id: string;
  color: string;
  position: Vec2;
  radius?: number;
};

export type MapDefinition = {
  id: string;
  name: string;
  width: number;
  height: number;
  zones: MapZone[];
  walls: Wall[];
  botSpawns: BotSpawn[];
  dotSpawns: DotSpawn[];
};

export type InputCommand = {
  move: Vec2;
  dash: boolean;
};

export type CoverageKind = "capture" | "consume" | "revive";

export type CoverageSnapshot = {
  kind: CoverageKind;
  actorId: string;
  targetId: string;
  progressMs: number;
  durationMs: number;
};

export type GameConfig = {
  tickHz: number;
  botRadius: number;
  dotRadius: number;
  maxShields: number;
  maxInventoryDots: number;
  playerSpeed: number;
  botSpeed: number;
  dashSpeed: number;
  dashDurationMs: number;
  dashCooldownMs: number;
  damageSpeed: number;
  shieldInvulnerabilityMs: number;
  dotCaptureDurationMs: number;
  coverDurationMs: number;
  respawnDelayMs: number;
  coverCenterTolerance: number;
};

export type GameSnapshot = {
  timeMs: number;
  playerId: string;
  map: MapDefinition;
  bots: DotBotEntity[];
  dots: DotEntity[];
  coverages: CoverageSnapshot[];
  debug: {
    tickHz: number;
    tickCount: number;
    fps: number;
    activeBodies: number;
    activeDots: number;
  };
};
