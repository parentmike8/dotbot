export { DotBotSimulation } from "./simulation";
export { defaultGameConfig } from "./config";
export { auditBuildingFloorQuality, auditDotPlacement, MAX_ATTACHED_SEAM, MIN_COMFORTABLE_AISLE } from "./mapQuality";
export type { FloorQualityIssue } from "./mapQuality";
export { auditCity, MAX_SETBACK, MIN_FOOTWAY, MIN_UNASSIGNED_AREA } from "./cityQuality";
export type { CityIssue } from "./cityQuality";
export { compileCityPlan, CityPlanError, MIN_APPROACH } from "./cityPlan";
export type { ApproachSpec, CityPlan, PatchSpec, StreetSpec } from "./cityPlan";
export { cloneMapDocument, validateEditableMap } from "./mapEditor";
export type { MapEditorIssue } from "./mapEditor";
export { assignSquadInsertions, squadPreference, squadSpawnPosition, validateInsertionMap } from "./insertion";
export type { InsertionAssignment, InsertionMemberPreference, InsertionSquad } from "./insertion";
export { CONTRACT_ACTIVE_CAP, CONTRACT_OFFER_COUNT, contractDayStamp, contractObjectiveLabel, contractSatisfied, deriveContractTemplates, generateContractOffers } from "./contracts";
export { downtownMap } from "./content/downtown";
export { pixelCityBlockMap } from "./content/pixelCityBlock";
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
  DoorEntity,
  GameConfig,
  GameSnapshot,
  InputCommand,
  LoadoutPreset,
  MapDocument,
  PlacementSlot,
  Rect,
  Segment,
  SimEvent,
  Solid,
  Vec2,
  WirePowerupCode,
  WireLoadoutCode,
} from "./types";
