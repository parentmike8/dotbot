export { DotBotSimulation } from "./simulation";
export { defaultGameConfig } from "./config";
export { downtownMap } from "./content/downtown";
export {
  BASE_OBJECT_KINDS,
  basePlacementSlots,
  createBaseMap,
  isBaseObjectKind,
  isObjectAllowedInSlot,
  starterBaseLayout,
  validateBaseLayout,
} from "./content/base";
export type {
  BaseLayout,
  BaseObjectKind,
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
