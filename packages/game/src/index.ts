export { DotBotSimulation } from "./simulation";
export { defaultGameConfig } from "./config";
export { downtownMap } from "./content/downtown";
export {
  BASE_OBJECT_KINDS,
  BASE_SHELL_IDS,
  BASE_SLOT_DEFS,
  DEFAULT_BASE_SHELL,
  baseShellDef,
  createBaseMap,
  isBaseObjectKind,
  isBaseShellId,
  isObjectAllowedInSlot,
  starterBaseLayout,
  validateBaseLayout,
} from "./content/base";
export type { BaseShellDef } from "./content/base";
export type {
  BaseLayout,
  BaseObjectKind,
  BaseShellId,
  Controller,
  DotBotEntity,
  DotEntity,
  GameConfig,
  GameSnapshot,
  InputCommand,
  MapDocument,
  PlacementSlot,
  SimEvent,
  Vec2,
} from "./types";
