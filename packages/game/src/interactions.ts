import { distance } from "./math";
import type { DotBotEntity, Vec2 } from "./types";
import type { FabricationStationKind } from "./fabrication";
import type { CatalogRef } from "./registry";

export type InteractionRequirement =
  | { kind: "minimumLevel"; level: number }
  | { kind: "completedContract"; contractId: string }
  | { kind: "capability"; capabilityId: string };

export type InteractionChannelDefinition = {
  kind: "stationary";
  durationMs: number;
  noise: { kind: "interaction"; emitted: true };
};

type DomainInteractionBase = {
  id: string;
  dot: "grey";
  requirements: readonly InteractionRequirement[];
  channel: InteractionChannelDefinition;
};

export type DomainInteractionTarget = DomainInteractionBase & (
  | { kind: "door"; doorwayId: string }
  | { kind: "lootContainer"; lootTable: CatalogRef }
  | { kind: "fabricationStation"; stationKind: FabricationStationKind }
  | { kind: "baseObject"; objectId: string }
  | { kind: "worldFunction"; functionId: string }
);

export type InteractionAccessContext = {
  level: number;
  completedContractIds?: ReadonlySet<string>;
  capabilityIds?: ReadonlySet<string>;
};

export type InteractionAuthorization =
  | { authorized: true; targetId: string }
  | { authorized: false; reason: "invalid-context" }
  | { authorized: false; reason: "level-required"; requiredLevel: number; actualLevel: number }
  | { authorized: false; reason: "contract-required"; contractId: string }
  | { authorized: false; reason: "capability-required"; capabilityId: string };

export type InteractionTargetIssue = {
  code: "missing-id" | "missing-target" | "invalid-channel-duration" | "invalid-level" | "duplicate-requirement";
  detail: string;
};

export function validateInteractionTarget(target: DomainInteractionTarget): InteractionTargetIssue[] {
  const issues: InteractionTargetIssue[] = [];
  if (!target.id.trim()) issues.push({ code: "missing-id", detail: "interaction" });
  const targetId = target.kind === "door"
    ? target.doorwayId
    : target.kind === "baseObject"
      ? target.objectId
      : target.kind === "worldFunction"
        ? target.functionId
        : target.kind === "lootContainer" ? target.lootTable.entryId : target.stationKind;
  if (!targetId.trim()) issues.push({ code: "missing-target", detail: target.kind });
  if (!Number.isFinite(target.channel.durationMs) || target.channel.durationMs <= 0) {
    issues.push({ code: "invalid-channel-duration", detail: String(target.channel.durationMs) });
  }
  const requirements = new Set<string>();
  for (const requirement of target.requirements) {
    const key = requirement.kind === "minimumLevel"
      ? requirement.kind
      : `${requirement.kind}:${requirement.kind === "completedContract" ? requirement.contractId : requirement.capabilityId}`;
    if (requirements.has(key)) issues.push({ code: "duplicate-requirement", detail: key });
    requirements.add(key);
    if (requirement.kind === "minimumLevel" && (!Number.isSafeInteger(requirement.level) || requirement.level < 1)) {
      issues.push({ code: "invalid-level", detail: String(requirement.level) });
    }
    if (requirement.kind === "completedContract" && !requirement.contractId.trim()) {
      issues.push({ code: "missing-target", detail: requirement.kind });
    }
    if (requirement.kind === "capability" && !requirement.capabilityId.trim()) {
      issues.push({ code: "missing-target", detail: requirement.kind });
    }
  }
  return issues;
}

/** Pure access decision. Runtime range, channel interruption, and effects stay authoritative elsewhere. */
export function authorizeInteraction(
  actor: InteractionAccessContext,
  target: DomainInteractionTarget,
): InteractionAuthorization {
  const issues = validateInteractionTarget(target);
  if (issues.length > 0) throw new Error(`Invalid interaction target ${target.id}: ${issues.map((issue) => issue.code).join(", ")}`);
  if (!Number.isSafeInteger(actor.level) || actor.level < 1) return { authorized: false, reason: "invalid-context" };
  for (const requirement of target.requirements) {
    if (requirement.kind === "minimumLevel" && actor.level < requirement.level) {
      return { authorized: false, reason: "level-required", requiredLevel: requirement.level, actualLevel: actor.level };
    }
    if (requirement.kind === "completedContract" && !actor.completedContractIds?.has(requirement.contractId)) {
      return { authorized: false, reason: "contract-required", contractId: requirement.contractId };
    }
    if (requirement.kind === "capability" && !actor.capabilityIds?.has(requirement.capabilityId)) {
      return { authorized: false, reason: "capability-required", capabilityId: requirement.capabilityId };
    }
  }
  return { authorized: true, targetId: target.id };
}

/**
 * Center-to-center reach at which the visible bot and interaction-dot circles
 * first overlap. The bot radius is its outer gameplay footprint (and already
 * contains the rendered shield plates), so touching any part of that footprint
 * starts the channel instead of requiring the dot to sit inside the core.
 */
export function interactionDotReach(botRadius: number, dotRadius: number): number {
  return Math.max(0, botRadius) + Math.max(0, dotRadius);
}

export function withinInteractionDotRange(
  botPosition: Vec2,
  botRadius: number,
  dotPosition: Vec2,
  dotRadius: number,
): boolean {
  return distance(botPosition, dotPosition) <= interactionDotReach(botRadius, dotRadius);
}

/**
 * Single source of truth for "can this bot channel on that downed body".
 * The server gates coverage on it and the client drives the verb UI from it,
 * so what the player is told matches what the simulation will accept.
 */
export function withinDownedCoverRange(
  actorPosition: Vec2,
  actorRadius: number,
  targetPosition: Vec2,
  targetRadius: number,
  minimumTolerance: number,
): boolean {
  const downedFootprintRadius = targetRadius * 0.55;
  return distance(actorPosition, targetPosition) <= Math.max(minimumTolerance, actorRadius + downedFootprintRadius);
}

type BodyReach = Pick<DotBotEntity, "id" | "squadId" | "state" | "position" | "radius" | "floorId">;

/**
 * Is this body open to that bot's hands right now?
 *
 * A searched body stays open, so a taker who steps away and comes back does not
 * channel again — but it is only open to a rival. You do not take from your own
 * squad; you pick them up.
 *
 * The same predicate gates the simulation, the picker UI, and which inventories
 * cross the wire, so the client can never show a slot the server will refuse.
 */
/**
 * Whether `actor` can pick this body up — the one rule, read by the simulation and by
 * the overlay that offers the verb.
 *
 * A squadmate is always a rescue. A rival is a recruitment, and it needs two things:
 * the body has to have ASKED (`pleaded`), because a squad you did not choose is not a
 * rescue; and the actor's squad has to have room, because three load in and four is
 * the cap.
 *
 * Written once because the alternative is the overlay offering a verb the simulation
 * refuses, which play has already reported once as a channel that appears and
 * vanishes.
 */
export function canReviveBody(
  actor: BodyReach,
  body: BodyReach & Pick<DotBotEntity, "pleaded">,
  squadSize: number,
  maxSquadSize: number,
): boolean {
  if (actor.id === body.id || actor.state !== "alive" || body.state !== "downed") return false;
  if (actor.floorId !== body.floorId) return false;
  if (actor.squadId === body.squadId) return true;
  return body.pleaded && squadSize < maxSquadSize;
}

export function canTakeFromBody(
  actor: BodyReach,
  body: BodyReach & Pick<DotBotEntity, "searched">,
  minimumTolerance: number,
): boolean {
  return actor.id !== body.id
    && actor.state === "alive"
    && bodyContentsPublic(body)
    && actor.squadId !== body.squadId
    && actor.floorId === body.floorId
    && withinDownedCoverRange(actor.position, actor.radius, body.position, body.radius, minimumTolerance);
}

/** A searched body's contents are known to everyone: it is lying open on the floor. */
export function bodyContentsPublic(body: Pick<DotBotEntity, "state" | "searched">): boolean {
  return body.state === "downed" && body.searched;
}
