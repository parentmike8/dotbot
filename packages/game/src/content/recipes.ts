import type { BaseObjectKind, Item, WirePowerupCode } from "../types";

export type RecipeCost = { itemType: WirePowerupCode; qty: number };

export type Recipe = {
  id: string;
  output:
    | { kind: "item"; item: Item }
    | { kind: "furniture"; objectKind: BaseObjectKind }
    | { kind: "expansion"; upgradeId: string };
  costs: RecipeCost[];
  requiresBlueprint?: string;
  /** A placed base object can unlock options without mutating combat config. */
  requiresObject?: BaseObjectKind;
};

export const SECOND_FLOOR_RECIPE_ID = "expansion-secondFloor";
export const SECOND_FLOOR_UPGRADE_ID = "secondFloor";
export const SECOND_FLOOR_COST_PER_POWERUP = 6;

const furnitureCost: RecipeCost[] = [
  { itemType: "r", qty: 1 },
  { itemType: "d", qty: 1 },
];

const furnitureKinds = [
  "bed",
  "conferenceTable",
  "cot",
  "couch",
  "counter",
  "desk",
  "filingCabinet",
  "fridge",
  "generator",
  "locker",
  "receptionDesk",
  "serverRack",
  "shelf",
  "toolCabinet",
  "workbench",
] as const satisfies readonly BaseObjectKind[];

export const RECIPES: readonly Recipe[] = [
  {
    id: SECOND_FLOOR_RECIPE_ID,
    output: { kind: "expansion", upgradeId: SECOND_FLOOR_UPGRADE_ID },
    costs: (["h", "r", "d", "i"] as const).map((itemType) => ({
      itemType,
      qty: SECOND_FLOOR_COST_PER_POWERUP,
    })),
  },
  {
    id: "fabricate-mine",
    output: { kind: "item", item: { kind: "mine" } },
    costs: [
      { itemType: "d", qty: 1 },
      { itemType: "i", qty: 1 },
    ],
    requiresBlueprint: "workbench",
  },
  {
    id: "convert-health",
    output: { kind: "item", item: { kind: "powerup", type: "health" } },
    costs: [{ itemType: "r", qty: 2 }],
    requiresObject: "repairBench",
  },
  {
    id: "convert-radar",
    output: { kind: "item", item: { kind: "powerup", type: "radar" } },
    costs: [{ itemType: "i", qty: 2 }],
  },
  {
    id: "convert-dash-overcharge",
    output: { kind: "item", item: { kind: "powerup", type: "dashOvercharge" } },
    costs: [{ itemType: "h", qty: 2 }],
  },
  {
    id: "convert-incognito",
    output: { kind: "item", item: { kind: "powerup", type: "incognito" } },
    costs: [{ itemType: "d", qty: 2 }],
  },
  ...furnitureKinds.map((objectKind): Recipe => ({
    id: `furniture-${objectKind}`,
    output: { kind: "furniture", objectKind },
    costs: furnitureCost.map((cost) => ({ ...cost })),
    requiresBlueprint: objectKind,
  })),
  {
    id: "furniture-repairBench",
    output: { kind: "furniture", objectKind: "repairBench" },
    costs: [
      { itemType: "r", qty: 2 },
      { itemType: "d", qty: 1 },
    ],
    requiresBlueprint: "workbench",
  },
] as const;

export function recipeById(recipeId: string): Recipe | undefined {
  return RECIPES.find((recipe) => recipe.id === recipeId);
}
