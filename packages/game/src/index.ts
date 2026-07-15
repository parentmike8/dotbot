export { DotBotSimulation } from "./simulation";
export { defaultGameConfig } from "./config";
export { assignSquadInsertions, squadPreference, squadSpawnPosition, validateInsertionMap } from "./insertion";
export type { InsertionAssignment, InsertionMemberPreference, InsertionSquad } from "./insertion";
export { downtownMap } from "./content/downtown";
export {
  BASE_OBJECT_KINDS,
  BASE_KIND_ZONES,
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
export { RECIPES, recipeById } from "./content/recipes";
export type { Recipe, RecipeCost } from "./content/recipes";
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
  LoadoutPreset,
  MapDocument,
  PlacementSlot,
  SimEvent,
  Vec2,
  WirePowerupCode,
} from "./types";
