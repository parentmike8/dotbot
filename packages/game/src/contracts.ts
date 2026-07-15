import { floorHeight } from "./mapModel";
import type { ContractDefinition, ContractObjective, Item, MapDocument, PowerupType } from "./types";

export const CONTRACT_OFFER_COUNT = 3;
export const CONTRACT_ACTIVE_CAP = 2;

const PAYOUT_KNOBS = {
  difficultyPerExtraPowerup: 4,
  maxPowerups: 3,
  blueprintBonusAt: 6,
} as const;

export function contractDayStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

type ContractTemplate = {
  id: string;
  title: string;
  objective: ContractObjective;
  difficulty: number;
};

export function deriveContractTemplates(map: MapDocument): ContractTemplate[] {
  const powerupTypes = new Set<PowerupType>();
  for (const spawn of [
    ...map.outdoor.dotSpawns,
    ...map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.dotSpawns)),
  ]) {
    if (spawn.item.kind === "powerup") powerupTypes.add(spawn.item.type);
  }

  const blueprintSources = map.buildings.flatMap((building) => {
    const seen = new Set<string>();
    return building.floors.flatMap((floor) => floor.objects
      .filter((object) => object.scannable && !seen.has(object.kind) && seen.add(object.kind))
      .map((object) => ({ building, floor, blueprintId: object.kind })));
  });

  const templates: ContractTemplate[] = [];
  for (const source of blueprintSources) {
    const depth = Math.max(0, floorHeight(source.floor.label));
    templates.push({
      id: `blueprint:${source.building.id}:${source.blueprintId}`,
      title: `RECOVER ${source.blueprintId.toUpperCase()} / ${source.building.name}`,
      objective: { kind: "extractBlueprint", blueprintId: source.blueprintId, buildingId: source.building.id },
      difficulty: 2 + depth,
    });
  }
  for (const powerupType of [...powerupTypes].sort()) {
    const count = 2 + (stableHash(powerupType) % 2);
    templates.push({
      id: `powerup:${powerupType}:${count}`,
      title: `EXTRACT ${count} ${powerupType.replace(/([A-Z])/g, " $1").toUpperCase()}`,
      objective: { kind: "extractPowerups", powerupType, count },
      difficulty: count,
    });
  }
  for (const building of map.buildings) {
    const floorDepth = Math.max(0, ...building.floors.map((floor) => floorHeight(floor.label)));
    const count = Math.min(4, 2 + Math.floor(floorDepth / 3));
    templates.push({
      id: `building:${building.id}:${count}`,
      title: `HAUL ${count} ITEMS / ${building.name}`,
      objective: { kind: "extractFromBuilding", buildingId: building.id, count },
      difficulty: count + floorDepth,
    });
  }
  return templates.sort((left, right) => left.id.localeCompare(right.id));
}

/** Deterministic for player/day; reroll is an explicit, persisted generation. */
export function generateContractOffers(map: MapDocument, playerId: string, dayStamp: string, reroll = 0): ContractDefinition[] {
  const templates = deriveContractTemplates(map);
  if (templates.length < CONTRACT_OFFER_COUNT) throw new Error("Map data does not derive enough contract templates.");
  const rng = seededRandom(`${playerId}|${dayStamp}|${reroll}`);
  const pool = [...templates];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  const powerups = derivedPowerupTypes(map);
  const blueprints = templates
    .filter((template) => template.objective.kind === "extractBlueprint")
    .map((template) => (template.objective as Extract<ContractObjective, { kind: "extractBlueprint" }>).blueprintId);
  return pool.slice(0, CONTRACT_OFFER_COUNT).map((template) => ({
    ...template,
    id: `contract-${stableHash(`${playerId}|${dayStamp}|${reroll}|${template.id}`).toString(36)}`,
    templateId: template.id,
    payout: payoutFor(template, powerups, blueprints),
  }));
}

export function contractSatisfied(contract: ContractDefinition, cargo: Item[]): boolean {
  const objective = contract.objective;
  if (objective.kind === "extractBlueprint") {
    return cargo.some((item) => item.kind === "blueprint" && item.blueprintId === objective.blueprintId && item.sourceBuildingId === objective.buildingId);
  }
  if (objective.kind === "extractPowerups") {
    return cargo.filter((item) => item.kind === "powerup" && item.type === objective.powerupType).length >= objective.count;
  }
  return cargo.filter((item) => item.sourceBuildingId === objective.buildingId).length >= objective.count;
}

export function contractObjectiveLabel(contract: ContractDefinition, map: MapDocument): string {
  const objective = contract.objective;
  const building = "buildingId" in objective ? map.buildings.find((entry) => entry.id === objective.buildingId)?.name ?? objective.buildingId : null;
  if (objective.kind === "extractBlueprint") return `EXTRACT ${objective.blueprintId.toUpperCase()} BLUEPRINT FROM ${building}`;
  if (objective.kind === "extractPowerups") return `EXTRACT ${objective.count}× ${objective.powerupType.replace(/([A-Z])/g, " $1").toUpperCase()}`;
  return `EXTRACT ${objective.count} ITEMS FROM ${building}`;
}

function payoutFor(template: ContractTemplate, powerups: PowerupType[], blueprints: string[]): ContractDefinition["payout"] {
  const powerupCount = Math.min(PAYOUT_KNOBS.maxPowerups, 1 + Math.floor(template.difficulty / PAYOUT_KNOBS.difficultyPerExtraPowerup));
  const items: Item[] = Array.from({ length: powerupCount }, (_, index) => ({
    kind: "powerup" as const,
    type: powerups[(stableHash(template.id) + index) % powerups.length],
  }));
  if (template.difficulty >= PAYOUT_KNOBS.blueprintBonusAt && blueprints.length > 0) {
    items.push({ kind: "blueprint", blueprintId: blueprints[stableHash(`${template.id}|bonus`) % blueprints.length] });
  }
  return { items };
}

function derivedPowerupTypes(map: MapDocument): PowerupType[] {
  const types = new Set<PowerupType>();
  for (const spawn of [...map.outdoor.dotSpawns, ...map.buildings.flatMap((building) => building.floors.flatMap((floor) => floor.dotSpawns))]) {
    if (spawn.item.kind === "powerup") types.add(spawn.item.type);
  }
  const result = [...types].sort();
  if (result.length === 0) throw new Error("Map data does not derive any powerup payouts.");
  return result;
}

function seededRandom(seed: string): () => number {
  let state = stableHash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
