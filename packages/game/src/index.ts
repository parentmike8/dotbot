export { DotBotSimulation } from "./simulation";
export { defaultGameConfig } from "./config";
export { auditBuildingFloorQuality, auditDotPlacement, MAX_ATTACHED_SEAM, MIN_COMFORTABLE_AISLE } from "./mapQuality";
export type { FloorQualityIssue } from "./mapQuality";
export { auditCity, MAX_SETBACK, MIN_FOOTWAY, MIN_UNASSIGNED_AREA } from "./cityQuality";
export type { CityIssue } from "./cityQuality";
export { compileCityPlan, CityPlanError, MIN_APPROACH } from "./cityPlan";
export type { ApproachSpec, CityPlan, PatchSpec, StreetSpec } from "./cityPlan";
export { assignSquadInsertions, squadPreference, squadSpawnPosition, validateInsertionMap } from "./insertion";
export type { InsertionAssignment, InsertionMemberPreference, InsertionSquad } from "./insertion";
export {
  DOORWAY_STEERING_MARGIN,
  STANDARD_DOORWAY_CLEAR_WIDTH,
  doorwayHalfClearance,
  doorwayNormal,
  doorwayTraversalPoints,
  minimumNavigableDoorwayWidth,
  openingCutGeometry,
} from "./doorwayClearance";
export { CONTRACT_ACTIVE_CAP, CONTRACT_OFFER_COUNT, contractDayStamp, contractObjectiveLabel, contractSatisfied, deriveContractTemplates, generateContractOffers } from "./contracts";
export {
  AUTHORED_CONTRACT_REGISTRY,
  TEST_LEVEL_CURVE,
  activateContract,
  advanceContractGraph,
  createContractGraphState,
  levelForProgress,
  validateContractGraphState,
  validateContractRegistry,
} from "./authoredContracts";
export type {
  AuthoredContractDefinition,
  ActivateContractResult,
  ContractAdvanceResult,
  ContractGraphState,
  ContractGraphStateIssue,
  ContractProgressState,
  ContractRegistryIssue,
  ContractStatus,
  LevelCurve,
  LevelProgress,
} from "./authoredContracts";
export { advanceAiObjective, advanceObjective, createAiObjective, createObjectiveProgress, validateObjectiveDefinition } from "./objectives";
export type { AiObjective, AuthoredObjectiveDefinition, ObjectiveDomainEvent, ObjectiveIssue, ObjectiveProgress } from "./objectives";
export {
  BASE_OBJECT_REGISTRY,
  BLUEPRINT_REGISTRY,
  CORE_REGISTRY,
  DEFAULT_EQUIPMENT_CATALOGS,
  PLATE_SET_REGISTRY,
  catalogRef,
  createVersionedRegistry,
  plateSetCountersDamage,
  plateSetShortensChannel,
  plateSetSuppressesSignal,
  resolveCatalogRef,
  validateEquipmentCatalogs,
} from "./catalog";
export type {
  BaseObjectDefinition,
  BlueprintDefinition,
  CatalogRef,
  CoreDefinition,
  DomainItemSpec,
  DomainItemStack,
  DomainRegistry,
  EquipmentCatalogs,
  EquipmentCatalogIssue,
  PlateSetDefinition,
  PlateSetCapability,
  VersionedRegistry,
} from "./catalog";
export { LOOT_TABLE_REGISTRY, rollLootTable, validateLootTableRegistry } from "./loot";
export type { LootTableDefinition, LootTableEntry, LootTableIssue } from "./loot";
export { FABRICATION_RECIPE_REGISTRY, fabricate, inventoryFromStacks, validateRecipe } from "./fabrication";
export type {
  DomainInventory,
  FabricationContext,
  FabricationRecipeDefinition,
  FabricationRecipeIssue,
  FabricationStationKind,
} from "./fabrication";
export {
  appendPhysicalItemHistory,
  bankExtractedItems,
  createPhysicalItem,
  lockLoadoutAtPublicQueueEntry,
  reconcileLoadoutAfterLoss,
  removePhysicalItems,
  validatePhysicalItem,
  validatePhysicalStorage,
  validateLoadout,
} from "./equipment";
export type {
  EquipmentKind,
  EquipmentSelection,
  LoadoutValidation,
  LoadoutSelection,
  LockedLoadoutSelection,
  LockLoadoutResult,
  LockedLoadout,
  PhysicalItemHistoryEvent,
  PhysicalItemInstance,
  PhysicalStorage,
} from "./equipment";
export { authorizeInteraction, validateInteractionTarget } from "./interactions";
export type {
  DomainInteractionTarget,
  InteractionAccessContext,
  InteractionAuthorization,
  InteractionChannelDefinition,
  InteractionRequirement,
  InteractionTargetIssue,
} from "./interactions";
export { downtownMap } from "./content/downtown";
export { auditPatrolRoutes } from "./patrol";
export { botSpawnFaction, isAmbientBotSpawn } from "./faction";
export {
  BASE_TUTORIAL_ACTIONS,
  BASE_TUTORIAL_DOOR_ID,
  BASE_TUTORIAL_ENTRY_Y,
  BASE_TUTORIAL_FABRICATOR_ID,
  BASE_TUTORIAL_FABRICATOR_DOT_ID,
  BASE_TUTORIAL_PHASES,
  BASE_TUTORIAL_TARGET_ID,
  advanceBaseTutorial,
  completedBaseTutorialState,
  initialBaseTutorialState,
  isBaseTutorialAction,
  isBaseTutorialComplete,
  isBaseTutorialPhase,
} from "./baseTutorial";
export type { BaseTutorialAction, BaseTutorialPhase, BaseTutorialState } from "./baseTutorial";
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
  DownCause,
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
