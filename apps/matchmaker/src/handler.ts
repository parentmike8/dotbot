import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateGameSessionCommand,
  type CreateGameSessionCommandInput,
  CreatePlayerSessionCommand,
  CreatePlayerSessionsCommand,
  type CreatePlayerSessionsCommandOutput,
  DescribeGameSessionsCommand,
  DescribePlayerSessionsCommand,
  GameLiftClient,
  TerminateGameSessionCommand,
} from "@aws-sdk/client-gamelift";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, type DeleteCommandInput, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  canonicalTrustedPartyReservation,
  canonicalTrustedPartyRoster,
  parseTrustedPartyReservation,
  parseTrustedPartyRoster,
  type TrustedPartyReservation,
  type TrustedPartyRoster,
} from "@dotbot/protocol";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCodePattern = /^[A-HJ-NP-Z2-9]{4}$/;
const region = process.env.AWS_REGION ?? "us-east-1";
const gameLift = new GameLiftClient({ region: process.env.GAMELIFT_REGION ?? region });
const database = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const secrets = new SecretsManagerClient({ region });
const atomicOwnerLeaseMs = 45_000;
let relaySecretPromise: Promise<string> | null = null;

type PersistenceInternalEvent = { source: "dotbot-game-server"; operation: string; args: unknown };
type ArenaInternalEvent = { source: "dotbot-arena-server"; operation: "setAdmission"; args: unknown };
type InternalEvent = PersistenceInternalEvent | ArenaInternalEvent;
type RoomRecord = { pk: string; gameSessionId?: string; status: "creating" | "active"; expiresAt: number };
type Identity = { playerId: string; name: string; partyId?: string };
type PublicArenaRecord = RoomRecord & {
  arenaId?: string;
  buildId?: string;
  region?: string;
  admissionClosesAt?: number;
  admissionRevision?: number;
  owner?: string;
  endpointHost?: string;
  endpointPort?: number;
  partySecret?: string;
  claimId?: string;
  creationId?: string;
  leaderPlayerId?: string;
  packingRevision?: number;
  partyReservations?: PartyPackingReservation[];
};
export type PartyPackingReservation = {
  claimId: string;
  partyId: string;
  version: number;
  memberPlayerIds: string[];
};
export type AtomicAllocationRecord = {
  pk: string;
  status: "allocating" | "active" | "cancelling" | "cancelled";
  owner?: string;
  ownerLeaseExpiresAt?: number;
  rosterDigest?: string;
  partyId?: string;
  partyVersion?: number;
  leaderPlayerId?: string;
  memberPlayerIds?: string[];
  buildId?: string;
  region?: string;
  arenaKey?: string;
  creationId?: string;
  gameSessionId?: string;
  arenaId?: string;
  endpointHost?: string;
  endpointPort?: number;
  partySecret?: string;
  allocations?: StoredPartyAllocation[];
  cleanupPlayerSessionIds?: string[];
  cleanupDiscoveryUntil?: number;
  terminateGameSession?: boolean;
  expiresAt: number;
};
type StoredPartyAllocation = {
  playerId: string;
  playerSessionId: string;
  websocketUrl: string;
  expiresAt?: string;
};
type CreatedPartyPlayerSession = {
  PlayerId?: string;
  PlayerSessionId?: string;
  GameSessionId?: string;
  PlayerData?: string;
  Status?: string;
  DnsName?: string;
  IpAddress?: string;
  Port?: number;
  CreationTime?: Date;
};

class IncompletePartyPlayerSessionsError extends Error {
  readonly clientError: MatchmakerError;

  constructor(readonly playerSessionIds: string[], readonly uncertain = false) {
    super("GameLift did not reserve the complete party.");
    this.clientError = new MatchmakerError(503, "GameLift did not reserve the complete party.", true);
  }
}

class AtomicArenaAllocationError extends Error {
  constructor(readonly allocation: AtomicArenaAllocation, readonly original: unknown) {
    super(original instanceof Error ? original.message : "Atomic arena allocation requires cleanup.");
  }
}

class AtomicArenaCreationUncertainError extends Error {
  readonly clientError = new MatchmakerError(503, "GameLift arena creation is reconciling. Retry together.", true);

  constructor(readonly original: unknown) {
    super("GameLift arena creation result is uncertain.");
  }
}
export type QuickPlayTicket = {
  playerId: string;
  playerName: string;
  partyId: string;
  buildId: string;
  region: string;
  latencyMs: number;
};

type AtomicQuickPlayRequest = {
  queueRequestId: string;
  buildId: string;
  region: string;
  latencyMs: number;
};

type AtomicCancellationAuthorization = {
  claimId: string;
  playerId: string;
};
type AtomicStatusAuthorization = AtomicCancellationAuthorization & {
  status: "active" | "cancelling" | "cancelled" | "completed" | "expired";
};

export async function handler(event: APIGatewayProxyEventV2 | InternalEvent): Promise<APIGatewayProxyResultV2 | { result?: unknown; error?: string }> {
  if (isInternalEvent(event)) {
    try {
      return { result: event.source === "dotbot-arena-server"
        ? await updateArenaAdmission(event.args)
        : await relayPersistence(event.operation, event.args) };
    } catch (error) {
      console.error("game-server internal operation failed", { errorName: safeErrorName(error) });
      return { error: event.source === "dotbot-arena-server"
        ? "Arena availability could not be updated."
        : "Authoritative persistence is temporarily unavailable." };
    }
  }

  try {
    const route = event.routeKey;
    if (route === "GET /health") {
      const fleetId = process.env.FLEET_ID ?? "";
      return response(200, {
        ok: true,
        fleetConfigured: fleetId.startsWith("fleet-"),
        publicQuickPlayEnabled: isPublicQuickPlayEnabled(),
        atomicPartyAllocationEnabled: isAtomicPartyAllocationEnabled(),
      });
    }
    if (route === "POST /quick-play" && !isPublicQuickPlayEnabled()) {
      return response(404, { error: "Route not found." });
    }
    if (isPublicQuickPlayEnabled() && (route === "POST /rooms" || route === "POST /rooms/{roomCode}/join")) {
      return response(404, { error: "Route not found." });
    }
    if ((route === "POST /quick-play/cancel" || route === "POST /quick-play/status")
      && (!isPublicQuickPlayEnabled() || !isAtomicPartyAllocationEnabled())) {
      return response(404, { error: "Route not found." });
    }
    const payload = parseBody(event.body);
    if (route === "POST /quick-play" && isAtomicPartyAllocationEnabled()) {
      return response(200, await atomicQuickPlay(payload));
    }
    if (route === "POST /quick-play/cancel") {
      return response(200, await cancelAtomicQuickPlay(payload));
    }
    if (route === "POST /quick-play/status") {
      return response(200, await atomicQuickPlayStatus(payload));
    }
    const identity = await authenticate(payload.token);
    if (route === "POST /quick-play") return response(200, await quickPlay(identity, payload));
    if (route === "POST /rooms") return response(201, await createRoom(identity));
    if (route === "POST /rooms/{roomCode}/join") {
      return response(200, await joinRoom(normalizeRoomCode(event.pathParameters?.roomCode), identity));
    }
    return response(404, { error: "Route not found." });
  } catch (error) {
    const status = error instanceof MatchmakerError ? error.status : 500;
    if (status >= 500) console.error("matchmaker request failed", { errorName: safeErrorName(error) });
    return response(status, {
      error: error instanceof MatchmakerError ? error.message : "Matchmaking is temporarily unavailable.",
      retryable: error instanceof MatchmakerError && error.retryable,
    });
  }
}

async function atomicQuickPlay(payload: Record<string, unknown>): Promise<ConnectionAllocation> {
  const request = normalizeAtomicQuickPlayRequest(payload);
  const roster = await authenticatePartyRoster(payload.token, request);
  if (roster.buildId !== request.buildId || roster.region !== request.region) {
    throw new MatchmakerError(409, "Party roster compatibility changed. Retry quick play together.", true);
  }
  return allocateAtomicParty(roster);
}

export function normalizeAtomicQuickPlayRequest(payload: Record<string, unknown>): AtomicQuickPlayRequest {
  const queueRequestId = typeof payload.queueRequestId === "string" ? payload.queueRequestId.trim().toLowerCase() : "";
  if (!isUuid(queueRequestId)) throw new MatchmakerError(400, "A valid quick-play request id is required.");
  const buildId = typeof payload.buildId === "string" ? payload.buildId.trim() : "";
  const expectedBuildId = requiredEnv("QUICK_PLAY_BUILD_ID");
  if (expectedBuildId.toLowerCase() === "disabled" || buildId !== expectedBuildId || !safeMetadata(buildId, 64)) {
    throw new MatchmakerError(400, "Quick-play build metadata is invalid.");
  }
  const allowedRegions = quickPlayRegions();
  const selected = selectQuickPlayRegion(payload.latencies, allowedRegions);
  return { queueRequestId, buildId, ...selected };
}

async function authenticatePartyRoster(tokenValue: unknown, request: AtomicQuickPlayRequest): Promise<TrustedPartyRoster> {
  const token = validPlayerToken(tokenValue);
  const body = JSON.stringify({
    token,
    partyAllocationVersion: "party-v1",
    operation: "allocate",
    queueRequestId: request.queueRequestId,
    buildId: request.buildId,
    region: request.region,
  });
  const requestId = randomUUID();
  const timestamp = Date.now().toString();
  const secret = await relaySecret();
  let responseValue: Response;
  try {
    responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/matchmaker-auth`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signControlPlaneRequest(secret, body, timestamp, requestId, "matchmaker-auth") },
      body,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw controlPlaneFailure(503, "Party authentication failed.");
  }
  if (!responseValue.ok) throw controlPlaneFailure(responseValue.status, "Party authentication failed.");
  const payload = await responseValue.json() as { partyRoster?: unknown; rosterSignature?: unknown };
  const roster = parseTrustedPartyRoster(payload.partyRoster);
  const signature = typeof payload.rosterSignature === "string" ? payload.rosterSignature : "";
  if (!roster || roster.expiresAt <= Date.now() || roster.expiresAt > Date.now() + 5 * 60_000
    || !validHexHmac(
      createHmac("sha256", secret).update(`party-roster.${requestId}.${canonicalTrustedPartyRoster(roster)}`).digest("hex"),
      signature,
    )) {
    throw new MatchmakerError(401, "Party authentication failed.");
  }
  return roster;
}

function quickPlayRegions(): string[] {
  return (process.env.QUICK_PLAY_REGIONS ?? process.env.GAME_LOCATION ?? process.env.GAMELIFT_REGION ?? region)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function selectQuickPlayRegion(latencies: unknown, allowedRegions: readonly string[]): { region: string; latencyMs: number } {
  if (!latencies || typeof latencies !== "object" || Array.isArray(latencies)) throw new MatchmakerError(400, "Regional latency measurements are required.");
  const candidates = allowedRegions.map((candidate) => ({
    region: candidate,
    latencyMs: (latencies as Record<string, unknown>)[candidate],
  })).filter((candidate): candidate is { region: string; latencyMs: number } =>
    typeof candidate.latencyMs === "number" && Number.isFinite(candidate.latencyMs)
      && candidate.latencyMs >= 0 && candidate.latencyMs <= 5_000);
  if (candidates.length === 0) throw new MatchmakerError(400, "No compatible regional latency measurement was supplied.");
  candidates.sort((left, right) => left.latencyMs - right.latencyMs || allowedRegions.indexOf(left.region) - allowedRegions.indexOf(right.region));
  return candidates[0];
}

async function allocateAtomicParty(roster: TrustedPartyRoster): Promise<ConnectionAllocation> {
  const tableName = requiredEnv("TABLE_NAME");
  const key = allocationKey(roster.claimId);
  const digest = partyRosterAllocationDigest(roster);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item as AtomicAllocationRecord | undefined;
    if (existing?.status === "active") return allocationForRequester(existing, roster, digest);
    if (existing?.status === "cancelled" || existing?.status === "cancelling") {
      throw new MatchmakerError(409, "Quick play was cancelled for this party.");
    }
    if (existing?.status === "allocating" && existing.rosterDigest !== digest) {
      throw new MatchmakerError(409, "Party roster is stale. Cancel and retry quick play together.");
    }
    const strandedAllocation = existing?.status === "allocating" && (existing.ownerLeaseExpiresAt ?? Number.MAX_SAFE_INTEGER) <= Date.now()
      ? allocationFromRecord(existing)
      : null;
    if (existing?.status === "allocating" && strandedAllocation) {
      try {
        await compensatePartyAllocation(strandedAllocation, roster.claimId);
      } catch {
        throw new MatchmakerError(503, "A previous party allocation is still reconciling. Retry together.", true);
      }
      try {
        await database.send(new DeleteCommand(strandedAtomicAllocationDeleteRequest(tableName, key, existing, digest)));
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
      continue;
    }
    const strandedCreation = existing?.status === "allocating" && (existing.ownerLeaseExpiresAt ?? Number.MAX_SAFE_INTEGER) <= Date.now()
      ? recoverableAtomicArenaCreation(existing, roster.claimId)
      : null;
    if (existing?.status === "allocating" && strandedCreation) {
      const cleanupOwner = randomUUID();
      const cleanupLease = Date.now() + atomicOwnerLeaseMs;
      try {
        await database.send(new UpdateCommand(claimStrandedAtomicArenaCreationRequest(
          tableName,
          key,
          existing,
          digest,
          cleanupOwner,
          cleanupLease,
        )));
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
      const fenced = { ...existing, owner: cleanupOwner, ownerLeaseExpiresAt: cleanupLease };
      try {
        await releaseExpiredAllocationDirectoryClaim(fenced, roster.claimId);
      } catch {
        throw new MatchmakerError(503, "A previous arena creation is still reconciling. Retry together.", true);
      }
      try {
        await database.send(new DeleteCommand(strandedAtomicArenaCreationDeleteRequest(tableName, key, fenced, digest)));
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
      continue;
    }
    if (existing?.status === "allocating" && (existing.ownerLeaseExpiresAt ?? Number.MAX_SAFE_INTEGER) > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, 40 * Math.min(4, attempt + 1)));
      continue;
    }
    const owner = randomUUID();
    try {
      if (existing?.status === "allocating") {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { pk: key },
          UpdateExpression: "SET #owner = :owner, ownerLeaseExpiresAt = :lease, expiresAt = :expires",
          ConditionExpression: "#status = :allocating AND rosterDigest = :digest AND ownerLeaseExpiresAt = :previousLease AND attribute_not_exists(cancelRequestedAt)",
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":allocating": "allocating",
            ":digest": digest,
            ":previousLease": existing.ownerLeaseExpiresAt,
            ":owner": owner,
            ":lease": Date.now() + atomicOwnerLeaseMs,
            ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
          },
        }));
      } else {
        await database.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: key,
            status: "allocating",
            owner,
            ownerLeaseExpiresAt: Date.now() + atomicOwnerLeaseMs,
            rosterDigest: digest,
            partyId: roster.partyId,
            partyVersion: roster.version,
            leaderPlayerId: roster.leaderPlayerId,
            memberPlayerIds: roster.members.map((member) => member.playerId),
            buildId: roster.buildId,
            region: roster.region,
            expiresAt: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
      }
    } catch (error) {
      if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
      throw error;
    }

    let arenaAllocation: Awaited<ReturnType<typeof allocatePartyIntoArena>> | undefined;
    try {
      arenaAllocation = await allocatePartyIntoArena(
        roster,
        async (allocation) => {
          await database.send(new UpdateCommand(retainAtomicAllocationCleanupRequest(
            tableName,
            key,
            owner,
            digest,
            allocation,
          )));
        },
        async (intent) => {
          await database.send(new UpdateCommand(retainAtomicArenaCreationIntentRequest(
            tableName,
            key,
            owner,
            digest,
            intent,
          )));
        },
      );
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: key },
        UpdateExpression: "SET memberPlayerIds = :memberIds, allocations = :allocations, cleanupPlayerSessionIds = :cleanupIds, cleanupDiscoveryUntil = :discoveryUntil, terminateGameSession = :terminate, arenaKey = :arenaKey, gameSessionId = :session, arenaId = :arena, endpointHost = :host, endpointPort = :port, partySecret = :secret, expiresAt = :expires",
        ConditionExpression: "#status = :allocating AND #owner = :owner AND rosterDigest = :digest AND attribute_not_exists(cancelRequestedAt)",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: {
          ":allocating": "allocating",
          ":owner": owner,
          ":digest": digest,
          ":memberIds": arenaAllocation.memberPlayerIds,
          ":allocations": arenaAllocation.allocations,
          ":cleanupIds": arenaAllocation.cleanupPlayerSessionIds,
          ":discoveryUntil": arenaAllocation.cleanupDiscoveryUntil,
          ":terminate": arenaAllocation.terminateGameSession,
          ":arenaKey": arenaAllocation.arenaKey,
          ":session": arenaAllocation.gameSessionId,
          ":arena": arenaAllocation.arenaId,
          ":host": arenaAllocation.endpointHost,
          ":port": arenaAllocation.endpointPort,
          ":secret": arenaAllocation.partySecret,
          ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
        },
      }));
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: key },
        UpdateExpression: "SET #status = :active REMOVE #owner, ownerLeaseExpiresAt",
        ConditionExpression: "#status = :allocating AND #owner = :owner AND rosterDigest = :digest AND attribute_not_exists(cancelRequestedAt)",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":allocating": "allocating",
          ":owner": owner,
          ":digest": digest,
        },
      }));
      return allocationForRequester({
        pk: key,
        status: "active",
        rosterDigest: digest,
        memberPlayerIds: arenaAllocation.memberPlayerIds,
        allocations: arenaAllocation.allocations,
        arenaKey: arenaAllocation.arenaKey,
        gameSessionId: arenaAllocation.gameSessionId,
        arenaId: arenaAllocation.arenaId,
        endpointHost: arenaAllocation.endpointHost,
        endpointPort: arenaAllocation.endpointPort,
        partySecret: arenaAllocation.partySecret,
        cleanupPlayerSessionIds: arenaAllocation.cleanupPlayerSessionIds,
        cleanupDiscoveryUntil: arenaAllocation.cleanupDiscoveryUntil,
        terminateGameSession: arenaAllocation.terminateGameSession,
        expiresAt: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
      }, roster, digest);
    } catch (error) {
      const allocationError = error instanceof AtomicArenaAllocationError ? error : null;
      const creationUncertain = error instanceof AtomicArenaCreationUncertainError ? error : null;
      if (allocationError) arenaAllocation = allocationError.allocation;
      const originalError = allocationError?.original ?? creationUncertain?.clientError ?? error;
      if (arenaAllocation) {
        // Retain the exact cleanup set whether ordinary publication failed or
        // cancellation won. An expired owner must reconcile this evidence
        // before a new allocator may take over the claim.
        let cleanupRetained = false;
        try {
          await database.send(new UpdateCommand(retainAtomicAllocationCleanupRequest(
            tableName,
            key,
            owner,
            digest,
            arenaAllocation,
          )));
          cleanupRetained = true;
        } catch {
          const current = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true })))
            .Item as AtomicAllocationRecord | undefined;
          if (current?.status === "active" && current.rosterDigest === digest
            && sameAtomicAllocationRecord(current, arenaAllocation)) {
            // The activation update committed and only its response was lost.
            // Returning the published idempotent record is safer than
            // compensating live reservations behind it.
            return allocationForRequester(current, roster, digest);
          }
          cleanupRetained = sameAtomicAllocationRecord(current, arenaAllocation);
        }
        try {
          await compensatePartyAllocation(arenaAllocation, roster.claimId);
        } catch (cleanupError) {
          if (!cleanupRetained) {
            console.error("party cleanup evidence could not be retained", { errorName: safeErrorName(cleanupError) });
          }
          throw cleanupError;
        }
      }
      // Cancellation can win before an arena is selected. There is then no
      // GameLift state to compensate, but the tombstone still has to become
      // terminal so the cancelling client can unfreeze Cloud SQL.
      if (!creationUncertain) {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { pk: key },
          UpdateExpression: "SET #status = :cancelled, expiresAt = :expires REMOVE #owner, ownerLeaseExpiresAt",
          ConditionExpression: "#status = :cancelling",
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":cancelling": "cancelling",
            ":cancelled": "cancelled",
            ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
          },
        })).catch(() => undefined);
        await database.send(new DeleteCommand({
          TableName: tableName,
          Key: { pk: key },
          ConditionExpression: "#status = :allocating AND #owner = :owner",
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: { ":allocating": "allocating", ":owner": owner },
        })).catch(() => undefined);
      }
      throw originalError;
    }
  }
  throw new MatchmakerError(503, "Party allocation is busy. Retry together.", true);
}

function allocationForRequester(record: AtomicAllocationRecord, roster: TrustedPartyRoster, digest: string): ConnectionAllocation {
  const complete = allocationFromRecord(record);
  const rosterIds = roster.members.map((member) => member.playerId).sort();
  const allocatedIds = complete?.allocations.map((allocation) => allocation.playerId).sort();
  if (record.rosterDigest !== digest || !complete || complete.allocations.length !== roster.members.length
    || allocatedIds?.join(".") !== rosterIds.join(".")) {
    throw new MatchmakerError(409, "Party roster is stale. Cancel and retry quick play together.");
  }
  const allocation = complete.allocations.find((candidate) => candidate.playerId === roster.requestingPlayerId);
  if (!allocation) throw new MatchmakerError(409, "This account is not part of the allocated party.");
  return {
    mode: "public-hot-arena",
    arenaId: record.arenaId,
    playerSessionId: allocation.playerSessionId,
    websocketUrl: allocation.websocketUrl,
    expiresAt: allocation.expiresAt,
    queueTicket: roster.claimId,
    partySize: roster.members.length,
  };
}

function allocationKey(claimId: string): string {
  return `ALLOCATION#${claimId}`;
}

export function partyRosterAllocationDigest(roster: TrustedPartyRoster): string {
  return createHash("sha256").update(JSON.stringify({
    claimId: roster.claimId,
    partyId: roster.partyId,
    version: roster.version,
    leaderPlayerId: roster.leaderPlayerId,
    buildId: roster.buildId,
    region: roster.region,
    memberLoadoutRevisions: roster.members
      .map((member) => ({ playerId: member.playerId, revision: member.loadoutRevision }))
      .sort((left, right) => left.playerId.localeCompare(right.playerId)),
  })).digest("hex");
}

type AtomicArenaAllocation = {
  arenaKey: string;
  gameSessionId: string;
  arenaId: string;
  endpointHost: string;
  endpointPort: number;
  partySecret: string;
  packingRevision: number;
  memberPlayerIds: string[];
  allocations: StoredPartyAllocation[];
  cleanupPlayerSessionIds: string[];
  cleanupDiscoveryUntil: number;
  terminateGameSession: boolean;
};

type AtomicArenaCreationIntent = {
  arenaKey: string;
  arenaId: string;
  partySecret: string;
  creationId: string;
};

export function selectAtomicArenaCreationIdentity(
  key: string,
  claimId: string,
  previous: Pick<PublicArenaRecord, "status" | "claimId" | "creationId" | "arenaId" | "partySecret"> | undefined,
): AtomicArenaCreationIntent | null {
  if (previous?.status === "creating" && previous.claimId === claimId
    && isUuid(previous.creationId ?? "") && roomCodePattern.test(previous.arenaId ?? "")
    && /^[a-f0-9]{64}$/.test(previous.partySecret ?? "")) {
    return {
      arenaKey: key,
      arenaId: previous.arenaId!,
      partySecret: previous.partySecret!,
      creationId: previous.creationId!,
    };
  }
  return null;
}

export function retainAtomicArenaCreationIntentRequest(
  tableName: string,
  key: string,
  owner: string,
  digest: string,
  intent: AtomicArenaCreationIntent,
): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { pk: key },
    UpdateExpression: "SET arenaKey = :arenaKey, arenaId = :arena, partySecret = :secret, creationId = :creation, expiresAt = :expires",
    ConditionExpression: "#status = :allocating AND #owner = :owner AND rosterDigest = :digest AND attribute_not_exists(cancelRequestedAt)",
    ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
    ExpressionAttributeValues: {
      ":allocating": "allocating",
      ":owner": owner,
      ":digest": digest,
      ":arenaKey": intent.arenaKey,
      ":arena": intent.arenaId,
      ":secret": intent.partySecret,
      ":creation": intent.creationId,
      ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
    },
  };
}

export function retainAtomicAllocationCleanupRequest(
  tableName: string,
  key: string,
  owner: string,
  digest: string,
  allocation: AtomicArenaAllocation,
): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { pk: key },
    UpdateExpression: "SET memberPlayerIds = :memberIds, allocations = :allocations, cleanupPlayerSessionIds = :cleanupIds, cleanupDiscoveryUntil = :discoveryUntil, terminateGameSession = :terminate, arenaKey = :arenaKey, gameSessionId = :session, arenaId = :arena, endpointHost = :host, endpointPort = :port, partySecret = :secret, expiresAt = :expires",
    ConditionExpression: "(#status = :allocating AND #owner = :owner AND rosterDigest = :digest) OR (#status = :cancelling AND rosterDigest = :digest)",
    ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
    ExpressionAttributeValues: {
      ":allocating": "allocating",
      ":cancelling": "cancelling",
      ":owner": owner,
      ":digest": digest,
      ":memberIds": allocation.memberPlayerIds,
      ":allocations": allocation.allocations,
      ":cleanupIds": allocation.cleanupPlayerSessionIds,
      ":discoveryUntil": allocation.cleanupDiscoveryUntil,
      ":terminate": allocation.terminateGameSession,
      ":arenaKey": allocation.arenaKey,
      ":session": allocation.gameSessionId,
      ":arena": allocation.arenaId,
      ":host": allocation.endpointHost,
      ":port": allocation.endpointPort,
      ":secret": allocation.partySecret,
      ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
    },
  };
}

export function strandedAtomicAllocationDeleteRequest(
  tableName: string,
  key: string,
  record: AtomicAllocationRecord,
  digest: string,
): DeleteCommandInput {
  const hasOwner = typeof record.owner === "string";
  const hasLease = Number.isFinite(record.ownerLeaseExpiresAt);
  return {
    TableName: tableName,
    Key: { pk: key },
    ConditionExpression: `#status = :allocating AND rosterDigest = :digest AND gameSessionId = :session AND arenaId = :arena AND ${hasOwner ? "#owner = :owner" : "attribute_not_exists(#owner)"} AND ${hasLease ? "ownerLeaseExpiresAt = :lease" : "attribute_not_exists(ownerLeaseExpiresAt)"}`,
    ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
    ExpressionAttributeValues: {
      ":allocating": "allocating",
      ":digest": digest,
      ":session": record.gameSessionId,
      ":arena": record.arenaId,
      ...(hasOwner ? { ":owner": record.owner } : {}),
      ...(hasLease ? { ":lease": record.ownerLeaseExpiresAt } : {}),
    },
  };
}

export function claimStrandedAtomicArenaCreationRequest(
  tableName: string,
  key: string,
  record: AtomicAllocationRecord,
  digest: string,
  owner: string,
  leaseExpiresAt: number,
): UpdateCommandInput {
  const hasCreationId = typeof record.creationId === "string";
  return {
    TableName: tableName,
    Key: { pk: key },
    UpdateExpression: "SET #owner = :nextOwner, ownerLeaseExpiresAt = :nextLease, expiresAt = :expires",
    ConditionExpression: `#status = :allocating AND #owner = :owner AND ownerLeaseExpiresAt = :lease AND rosterDigest = :digest AND ${hasCreationId ? "creationId = :creation" : "attribute_not_exists(creationId)"} AND arenaId = :arena AND partySecret = :secret AND attribute_not_exists(gameSessionId) AND attribute_not_exists(cancelRequestedAt)`,
    ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
    ExpressionAttributeValues: {
      ":allocating": "allocating",
      ":owner": record.owner,
      ":lease": record.ownerLeaseExpiresAt,
      ":digest": digest,
      ...(hasCreationId ? { ":creation": record.creationId } : {}),
      ":arena": record.arenaId,
      ":secret": record.partySecret,
      ":nextOwner": owner,
      ":nextLease": leaseExpiresAt,
      ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
    },
  };
}

export function strandedAtomicArenaCreationDeleteRequest(
  tableName: string,
  key: string,
  record: AtomicAllocationRecord,
  digest: string,
): DeleteCommandInput {
  const hasCreationId = typeof record.creationId === "string";
  return {
    TableName: tableName,
    Key: { pk: key },
    ConditionExpression: `#status = :allocating AND #owner = :owner AND ownerLeaseExpiresAt = :lease AND rosterDigest = :digest AND ${hasCreationId ? "creationId = :creation" : "attribute_not_exists(creationId)"} AND arenaId = :arena AND partySecret = :secret AND attribute_not_exists(gameSessionId) AND attribute_not_exists(cancelRequestedAt)`,
    ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
    ExpressionAttributeValues: {
      ":allocating": "allocating",
      ":owner": record.owner,
      ":lease": record.ownerLeaseExpiresAt,
      ":digest": digest,
      ...(hasCreationId ? { ":creation": record.creationId } : {}),
      ":arena": record.arenaId,
      ":secret": record.partySecret,
    },
  };
}

type ActiveAtomicArena = PublicArenaRecord & Required<Pick<PublicArenaRecord,
  "gameSessionId" | "arenaId" | "buildId" | "region" | "admissionClosesAt" | "endpointHost" | "endpointPort" | "partySecret">>;

async function allocatePartyIntoArena(
  roster: TrustedPartyRoster,
  retainCleanup: (allocation: AtomicArenaAllocation) => Promise<void>,
  retainCreationIntent: (intent: AtomicArenaCreationIntent) => Promise<void>,
): Promise<AtomicArenaAllocation> {
  const tableName = requiredEnv("TABLE_NAME");
  const key = publicArenaKey(roster);
  const reservation = packingReservation(roster);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item as PublicArenaRecord | undefined;
    if (isAtomicArenaAvailable(existing, roster)) {
      const preflight = await preflightParty(existing.endpointHost!, existing.endpointPort!, existing.partySecret!, roster);
      if (!preflight.accepted) {
        if (!preflight.retryable) throw new MatchmakerError(409, "Party roster was rejected by the arena.");
        await database.send(new DeleteCommand(stalePublicArenaDeleteRequest(
          tableName,
          key,
          existing.gameSessionId!,
          existing.arenaId!,
          existing.admissionClosesAt!,
          existing.admissionRevision,
          existing.packingRevision,
        ))).catch(() => undefined);
        continue;
      }
      const nextReservations = addPartyPackingReservation(existing.partyReservations, reservation);
      if (!nextReservations) {
        await database.send(new DeleteCommand(stalePublicArenaDeleteRequest(
          tableName,
          key,
          existing.gameSessionId!,
          existing.arenaId!,
          existing.admissionClosesAt!,
          existing.admissionRevision,
          existing.packingRevision,
        ))).catch(() => undefined);
        continue;
      }
      const packingRevision = (existing.packingRevision ?? 0) + 1;
      try {
        await database.send(new UpdateCommand(partyPackingUpdateRequest(tableName, key, existing, nextReservations, packingRevision)));
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
      try {
        const memberPlayerIds = roster.members.map((member) => member.playerId).sort();
        const cleanupIntent: AtomicArenaAllocation = {
          arenaKey: key,
          gameSessionId: existing.gameSessionId!,
          arenaId: existing.arenaId!,
          endpointHost: existing.endpointHost!,
          endpointPort: existing.endpointPort!,
          partySecret: existing.partySecret!,
          packingRevision,
          memberPlayerIds,
          allocations: [],
          cleanupPlayerSessionIds: [],
          cleanupDiscoveryUntil: 0,
          terminateGameSession: false,
        };
        try {
          await retainCleanup(cleanupIntent);
          cleanupIntent.cleanupDiscoveryUntil = Date.now() + 2 * 60_000;
          await retainCleanup(cleanupIntent);
        } catch (retainError) {
          await releaseDirectoryReservation(key, existing.gameSessionId!, existing.arenaId!, roster.claimId);
          throw retainError;
        }
        const allocations = await createPartyPlayerSessions(
          existing.gameSessionId!,
          existing.arenaId!,
          existing.endpointHost!,
          existing.endpointPort!,
          existing.partySecret!,
          roster,
        );
        return {
          arenaKey: key,
          gameSessionId: existing.gameSessionId!,
          arenaId: existing.arenaId!,
          endpointHost: existing.endpointHost!,
          endpointPort: existing.endpointPort!,
          partySecret: existing.partySecret!,
          packingRevision,
          memberPlayerIds,
          allocations,
          cleanupPlayerSessionIds: allocations.map((entry) => entry.playerSessionId),
          cleanupDiscoveryUntil: 0,
          terminateGameSession: false,
        };
      } catch (error) {
        if (error instanceof IncompletePartyPlayerSessionsError) {
          const partial: AtomicArenaAllocation = {
            arenaKey: key,
            gameSessionId: existing.gameSessionId,
            arenaId: existing.arenaId,
            endpointHost: existing.endpointHost,
            endpointPort: existing.endpointPort,
            partySecret: existing.partySecret,
            packingRevision,
            memberPlayerIds: roster.members.map((member) => member.playerId).sort(),
            allocations: [],
            cleanupPlayerSessionIds: error.playerSessionIds,
            cleanupDiscoveryUntil: error.uncertain ? Date.now() + 2 * 60_000 : 0,
            terminateGameSession: false,
          };
          try {
            await retainCleanup(partial);
          } catch (retainError) {
            throw new AtomicArenaAllocationError(partial, retainError);
          }
          throw new AtomicArenaAllocationError(partial, error.clientError);
        }
        await releaseDirectoryReservation(key, existing.gameSessionId, existing.arenaId, roster.claimId);
        if (isClosedGameSessionError(error) || isFullGameSessionError(error)) {
          await database.send(new DeleteCommand(stalePublicArenaDeleteRequest(
            tableName,
            key,
            existing.gameSessionId,
            existing.arenaId,
            existing.admissionClosesAt,
            existing.admissionRevision,
            packingRevision + 1,
          ))).catch(() => undefined);
          continue;
        }
        throw error;
      }
    }
    const created = await createAtomicArena(roster, key, retainCleanup, retainCreationIntent, existing);
    if (created) return created;
  }
  throw new MatchmakerError(503, "No arena can fit the intact party. Retry together.", true);
}

function isAtomicArenaAvailable(existing: PublicArenaRecord | undefined, roster: TrustedPartyRoster): existing is ActiveAtomicArena {
  return existing?.status === "active" && Boolean(existing.gameSessionId && existing.arenaId)
    && existing.buildId === roster.buildId && existing.region === roster.region
    && Boolean(existing.endpointHost && existing.endpointPort && existing.partySecret)
    && /^[a-f0-9]{64}$/.test(existing.partySecret ?? "")
    && (existing.admissionClosesAt ?? 0) > Date.now();
}

export function atomicGameSessionIdempotencyToken(claimId: string, creationId?: string): string {
  if (!isUuid(claimId)) throw new Error("Invalid atomic allocation claim id.");
  if (!creationId) return `party-${claimId.toLowerCase()}`;
  if (!isUuid(creationId)) throw new Error("Invalid atomic arena creation id.");
  // GameLift caps this token at 48 characters. Hashing both canonical UUIDs
  // preserves a wide generation fence without leaking either identifier into
  // the GameSession ARN.
  return `party-${createHash("sha256")
    .update(`${claimId.toLowerCase()}.${creationId.toLowerCase()}`)
    .digest("hex")
    .slice(0, 42)}`;
}

function atomicGameSessionRequest(
  claimId: string,
  leaderPlayerId: string,
  buildId: string,
  selectedRegion: string,
  arenaId: string,
  partySecret: string,
  creationId?: string,
): CreateGameSessionCommandInput {
  return {
    FleetId: requiredEnv("FLEET_ID"),
    Location: selectedRegion,
    MaximumPlayerSessionCount: 18,
    Name: `DotBot public ${arenaId}`,
    CreatorId: leaderPlayerId,
    IdempotencyToken: atomicGameSessionIdempotencyToken(claimId, creationId),
    GameProperties: [
      { Key: "mode", Value: "public-hot-arena" },
      { Key: "arenaId", Value: arenaId },
      { Key: "buildId", Value: buildId },
      { Key: "region", Value: selectedRegion },
      { Key: "partyAllocation", Value: "v1" },
      { Key: "partySecret", Value: partySecret },
    ],
  };
}

export function assertAtomicGameSessionMetadata(
  session: { GameProperties?: readonly { Key?: string; Value?: string }[] } | undefined,
  arenaId: string,
  partySecret: string,
  buildId: string,
  selectedRegion: string,
): void {
  const properties = session?.GameProperties;
  if (!Array.isArray(properties)) throw new Error("GameLift returned no atomic arena metadata.");
  const entries = properties.flatMap((entry) => typeof entry.Key === "string" && typeof entry.Value === "string"
    ? [[entry.Key, entry.Value] as const] : []);
  const values = new Map(entries);
  if (entries.length !== 6 || values.size !== 6
    || values.get("mode") !== "public-hot-arena"
    || values.get("arenaId") !== arenaId
    || values.get("buildId") !== buildId
    || values.get("region") !== selectedRegion
    || values.get("partyAllocation") !== "v1"
    || values.get("partySecret") !== partySecret) {
    throw new Error("GameLift returned mismatched atomic arena metadata.");
  }
}

function isUncertainAwsMutationError(error: unknown): boolean {
  const status = error && typeof error === "object"
    ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
    : undefined;
  return typeof status !== "number" || status >= 500;
}

async function atomicArenaPointerWasPublished(
  tableName: string,
  key: string,
  gameSessionId: string,
  arenaId: string,
  claimId: string,
): Promise<boolean> {
  const current = (await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: key },
    ConsistentRead: true,
  }))).Item as PublicArenaRecord | undefined;
  return current?.status === "active" && current.gameSessionId === gameSessionId && current.arenaId === arenaId
    && (current.partyReservations ?? []).some((reservation) => reservation.claimId === claimId);
}

async function createAtomicArena(
  roster: TrustedPartyRoster,
  key: string,
  retainCleanup: (allocation: AtomicArenaAllocation) => Promise<void>,
  retainCreationIntent: (intent: AtomicArenaCreationIntent) => Promise<void>,
  previous: PublicArenaRecord | undefined,
): Promise<AtomicArenaAllocation | null> {
  const tableName = requiredEnv("TABLE_NAME");
  const owner = randomUUID();
  const creationIdentity = selectAtomicArenaCreationIdentity(key, roster.claimId, previous);
  const reusableCreation = creationIdentity !== null;
  const arenaId = creationIdentity?.arenaId ?? generateRoomCode();
  const partySecret = creationIdentity?.partySecret ?? randomBytes(32).toString("hex");
  const creationId = creationIdentity?.creationId ?? randomUUID();
  try {
    await database.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: key,
        status: "creating",
        owner,
        buildId: roster.buildId,
        region: roster.region,
        claimId: roster.claimId,
        creationId,
        leaderPlayerId: roster.leaderPlayerId,
        arenaId,
        partySecret,
        expiresAt: Math.floor(Date.now() / 1000) + 2 * 60,
      },
      ConditionExpression: `attribute_not_exists(pk) OR expiresAt < :nowSeconds OR admissionClosesAt < :nowMillis${reusableCreation ? " OR (#status = :creating AND claimId = :claim AND creationId = :creation AND arenaId = :arena AND partySecret = :secret)" : ""}`,
      ...(reusableCreation ? { ExpressionAttributeNames: { "#status": "status" } } : {}),
      ExpressionAttributeValues: {
        ":nowSeconds": Math.floor(Date.now() / 1000),
        ":nowMillis": Date.now(),
        ...(reusableCreation ? {
          ":creating": "creating",
          ":claim": roster.claimId,
          ":creation": creationId,
          ":arena": arenaId,
          ":secret": partySecret,
        } : {}),
      },
    }));
  } catch (error) {
    if (awsErrorName(error) === "ConditionalCheckFailedException") return null;
    throw error;
  }

  let gameSessionId: string | undefined;
  let gameSessionOwnershipVerified = false;
  let endpointHost: string | undefined;
  let endpointPort: number | undefined;
  let cleanupIntent: AtomicArenaAllocation | undefined;
  try {
    // The long-lived allocation record must own the idempotency metadata
    // before GameLift can mutate. The short public pointer may expire or be
    // replaced while an uncertain CreateGameSession response is reconciled.
    await retainCreationIntent({ arenaKey: key, arenaId, partySecret, creationId });
    let created;
    try {
      created = await gameLift.send(new CreateGameSessionCommand(atomicGameSessionRequest(
        roster.claimId,
        roster.leaderPlayerId,
        roster.buildId,
        roster.region,
        arenaId,
        partySecret,
        creationId,
      )));
    } catch (error) {
      if (isFleetWakingError(error) || !isUncertainAwsMutationError(error)) throw error;
      throw new AtomicArenaCreationUncertainError(error);
    }
    gameSessionId = created.GameSession?.GameSessionId;
    if (!gameSessionId) {
      throw new AtomicArenaCreationUncertainError(new Error("GameLift returned no game session id."));
    }
    assertAtomicGameSessionMetadata(created.GameSession, arenaId, partySecret, roster.buildId, roster.region);
    gameSessionOwnershipVerified = true;
    ({ host: endpointHost, port: endpointPort } = await resolveGameSessionEndpoint(gameSessionId, created.GameSession));
    cleanupIntent = {
      arenaKey: key,
      gameSessionId,
      arenaId,
      endpointHost,
      endpointPort,
      partySecret,
      packingRevision: 0,
      memberPlayerIds: roster.members.map((member) => member.playerId).sort(),
      allocations: [],
      cleanupPlayerSessionIds: [],
      cleanupDiscoveryUntil: 0,
      terminateGameSession: true,
    };
    await retainCleanup(cleanupIntent);
    const preflight = await preflightParty(endpointHost, endpointPort, partySecret, roster, 6);
    if (!preflight.accepted) {
      throw new MatchmakerError(preflight.retryable ? 503 : 409, "The new arena rejected the intact party.", preflight.retryable);
    }
    cleanupIntent = { ...cleanupIntent, cleanupDiscoveryUntil: Date.now() + 2 * 60_000 };
    await retainCleanup(cleanupIntent);
    const allocations = await createPartyPlayerSessions(gameSessionId, arenaId, endpointHost, endpointPort, partySecret, roster);
    cleanupIntent = {
      ...cleanupIntent,
      allocations,
      cleanupPlayerSessionIds: allocations.map((entry) => entry.playerSessionId),
      cleanupDiscoveryUntil: 0,
    };
    const admissionClosesAt = Date.now() + 6_000;
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: key },
      UpdateExpression: "SET gameSessionId = :session, arenaId = :arena, endpointHost = :host, endpointPort = :port, partySecret = :secret, partyReservations = :reservations, packingRevision = :packingRevision, admissionClosesAt = :closes, expiresAt = :expires, #status = :active REMOVE #owner",
      ConditionExpression: "#owner = :owner AND #status = :creating",
      ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
      ExpressionAttributeValues: {
        ":session": gameSessionId,
        ":arena": arenaId,
        ":host": endpointHost,
        ":port": endpointPort,
        ":secret": partySecret,
        ":reservations": [packingReservation(roster)],
        ":packingRevision": 1,
        ":closes": admissionClosesAt,
        ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
        ":active": "active",
        ":creating": "creating",
        ":owner": owner,
      },
    }));
    return {
      arenaKey: key,
      gameSessionId,
      arenaId,
      endpointHost,
      endpointPort,
      partySecret,
      packingRevision: 1,
      memberPlayerIds: cleanupIntent.memberPlayerIds,
      allocations,
      cleanupPlayerSessionIds: allocations.map((entry) => entry.playerSessionId),
      cleanupDiscoveryUntil: 0,
      terminateGameSession: false,
    };
  } catch (error) {
    if (error instanceof AtomicArenaCreationUncertainError) throw error;
    if (gameSessionId && !gameSessionOwnershipVerified) {
      // A malformed success response is not authority to terminate the ID it
      // carried. Preserve the durable generation for exact replay/manual
      // reconciliation instead of risking another party's GameSession.
      throw new AtomicArenaCreationUncertainError(error);
    }
    if (cleanupIntent && gameSessionId && endpointHost && endpointPort) {
      let published = false;
      let pointerError: unknown;
      try {
        published = await atomicArenaPointerWasPublished(tableName, key, gameSessionId, arenaId, roster.claimId);
      } catch (readError) {
        pointerError = readError;
      }
      const partial: AtomicArenaAllocation = error instanceof IncompletePartyPlayerSessionsError
        ? {
          ...cleanupIntent,
          allocations: [],
          cleanupPlayerSessionIds: error.playerSessionIds,
          cleanupDiscoveryUntil: error.uncertain ? cleanupIntent.cleanupDiscoveryUntil : 0,
          terminateGameSession: !published,
        }
        : { ...cleanupIntent, terminateGameSession: !published };
      let original: unknown = pointerError ?? (error instanceof IncompletePartyPlayerSessionsError ? error.clientError : error);
      try {
        await retainCleanup(partial);
      } catch (retainError) {
        original = retainError;
      }
      if (!published) {
        await database.send(new DeleteCommand({
          TableName: tableName,
          Key: { pk: key },
          ConditionExpression: "#owner = :owner AND #status = :creating",
          ExpressionAttributeNames: { "#owner": "owner", "#status": "status" },
          ExpressionAttributeValues: { ":owner": owner, ":creating": "creating" },
        })).catch(() => undefined);
      }
      throw new AtomicArenaAllocationError(partial, original);
    }
    if (gameSessionId) {
      try {
        await gameLift.send(new TerminateGameSessionCommand({
          GameSessionId: gameSessionId,
          TerminationMode: "TRIGGER_ON_PROCESS_TERMINATE",
        }));
      } catch (cleanupError) {
        // Keep both durable ownership records so cancellation or an expired
        // allocator can replay this exact generation and finish termination.
        throw new AtomicArenaCreationUncertainError(cleanupError);
      }
    }
    await database.send(new DeleteCommand({
      TableName: tableName,
      Key: { pk: key },
      ConditionExpression: "#owner = :owner AND #status = :creating AND creationId = :creation AND arenaId = :arena AND partySecret = :secret",
      ExpressionAttributeNames: { "#owner": "owner", "#status": "status" },
      ExpressionAttributeValues: {
        ":owner": owner,
        ":creating": "creating",
        ":creation": creationId,
        ":arena": arenaId,
        ":secret": partySecret,
      },
    })).catch(() => undefined);
    if (isFleetWakingError(error)) throw new MatchmakerError(503, "Dedicated game server is waking up. This can take about a minute.", true);
    throw error;
  }
}

async function resolveGameSessionEndpoint(
  gameSessionId: string,
  initial: { DnsName?: string; IpAddress?: string; Port?: number } | undefined,
): Promise<{ host: string; port: number }> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const host = session?.DnsName || session?.IpAddress;
    if (host && session?.Port && /^[a-zA-Z0-9.-]+$/.test(host)) return { host, port: session.Port };
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    const described = await gameLift.send(new DescribeGameSessionsCommand({ GameSessionId: gameSessionId }));
    session = described.GameSessions?.[0];
  }
  throw new Error("GameLift returned no public party endpoint.");
}

async function preflightParty(
  host: string,
  port: number,
  partySecret: string,
  roster: TrustedPartyRoster,
  attempts = 2,
): Promise<{ accepted: boolean; code?: string; retryable: boolean }> {
  const body = JSON.stringify({ partyRoster: roster });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const timestamp = Date.now().toString();
    const requestId = randomUUID();
    try {
      const responseValue = await fetch(`https://${host}:${port}/api/internal/public-party-preflight`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signPartyOperation(partySecret, "party-preflight", body, timestamp, requestId),
        },
        body,
        signal: AbortSignal.timeout(1_500),
      });
      const result = await responseValue.json() as { accepted?: unknown; code?: unknown; retryable?: unknown };
      if (responseValue.ok && result.accepted === true) return { accepted: true, retryable: false };
      if (typeof result.code === "string" && typeof result.retryable === "boolean") {
        return { accepted: false, code: result.code, retryable: result.retryable };
      }
    } catch {
      // A newly activated GameSession can publish its endpoint just before the
      // Node health gate opens. Retry the same non-mutating question only.
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  return { accepted: false, code: "arena_capacity", retryable: true };
}

async function createPartyPlayerSessions(
  gameSessionId: string,
  arenaId: string,
  endpointHost: string,
  endpointPort: number,
  partySecret: string,
  roster: TrustedPartyRoster,
): Promise<StoredPartyAllocation[]> {
  const memberPlayerIds = roster.members.map((member) => member.playerId).sort();
  const memberLoadoutRevisions = roster.members
    .map((member) => ({ playerId: member.playerId, revision: member.loadoutRevision }))
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
  const reservationExpiresAt = Date.now() + 2 * 60_000;
  const playerDataMap = Object.fromEntries(memberPlayerIds.map((playerId) => {
    const reservation: TrustedPartyReservation = {
      claimId: roster.claimId,
      partyId: roster.partyId,
      version: roster.version,
      playerId,
      memberPlayerIds,
      memberLoadoutRevisions,
      arenaId,
      buildId: roster.buildId,
      region: roster.region,
      expiresAt: reservationExpiresAt,
    };
    const reservationSignature = createHmac("sha256", partySecret)
      .update(`party-reservation.${canonicalTrustedPartyReservation(reservation)}`)
      .digest("hex");
    return [playerId, JSON.stringify({ mode: "public-hot-arena", reservation, reservationSignature })];
  }));
  let created: CreatePlayerSessionsCommandOutput;
  try {
    created = await gameLift.send(new CreatePlayerSessionsCommand({
      GameSessionId: gameSessionId,
      PlayerIds: memberPlayerIds,
      PlayerDataMap: playerDataMap,
    }));
  } catch {
    // The service may have committed some or all reservations before the SDK
    // lost its response. The pre-call cleanup intent lets reconciliation find
    // only this signed claim's exact canonical players.
    throw new IncompletePartyPlayerSessionsError([], true);
  }
  const sessions = created.PlayerSessions ?? [];
  const expected = { gameSessionId, endpointHost, endpointPort, playerDataMap };
  const allocations = validateWholePartyPlayerSessions(memberPlayerIds, sessions, expected);
  if (!allocations) {
    const knownIds = [...new Set(sessions.flatMap((session) => {
      const playerId = session.PlayerId;
      return typeof playerId === "string" && memberPlayerIds.includes(playerId)
        && session.GameSessionId === gameSessionId && session.PlayerData === playerDataMap[playerId]
        && typeof session.PlayerSessionId === "string" && session.PlayerSessionId.length >= 1 && session.PlayerSessionId.length <= 2048
        ? [session.PlayerSessionId] : [];
    }))].slice(0, 3);
    throw new IncompletePartyPlayerSessionsError(knownIds);
  }
  return allocations.map((allocation) => ({
    ...allocation,
    expiresAt: new Date(reservationExpiresAt).toISOString(),
  }));
}

export function validateWholePartyPlayerSessions(
  memberPlayerIds: readonly string[],
  sessions: readonly CreatedPartyPlayerSession[],
  expected: {
    gameSessionId: string;
    endpointHost: string;
    endpointPort: number;
    playerDataMap: Readonly<Record<string, string>>;
  },
): StoredPartyAllocation[] | null {
  if (memberPlayerIds.length < 1 || memberPlayerIds.length > 3 || new Set(memberPlayerIds).size !== memberPlayerIds.length
    || !memberPlayerIds.every(isUuid) || sessions.length !== memberPlayerIds.length
    || !expected.gameSessionId || !/^[a-zA-Z0-9.-]+$/.test(expected.endpointHost)
    || !Number.isInteger(expected.endpointPort) || expected.endpointPort < 1 || expected.endpointPort > 65_535
    || !memberPlayerIds.every((playerId) => typeof expected.playerDataMap[playerId] === "string"
      && expected.playerDataMap[playerId].length > 0)) return null;
  const byPlayer = new Map(sessions.flatMap((session) => typeof session.PlayerId === "string" ? [[session.PlayerId, session] as const] : []));
  const sessionIds = sessions.flatMap((session) => session.PlayerSessionId ? [session.PlayerSessionId] : []);
  if (byPlayer.size !== memberPlayerIds.length || new Set(sessionIds).size !== sessions.length) return null;
  try {
    return [...memberPlayerIds].sort().map((playerId) => {
      const session = byPlayer.get(playerId);
      const host = session?.DnsName || session?.IpAddress;
      if (!session?.PlayerSessionId || session.GameSessionId !== expected.gameSessionId
        || session.PlayerData !== expected.playerDataMap[playerId] || session.Status !== "RESERVED"
        || host !== expected.endpointHost || session.Port !== expected.endpointPort) throw new Error("incomplete");
      return {
        playerId,
        playerSessionId: session.PlayerSessionId,
        websocketUrl: secureWebSocketUrl(expected.endpointHost, expected.endpointPort),
        ...(session.CreationTime ? { expiresAt: session.CreationTime.toISOString() } : {}),
      };
    });
  } catch {
    return null;
  }
}

export function packingReservation(roster: TrustedPartyRoster): PartyPackingReservation {
  return {
    claimId: roster.claimId,
    partyId: roster.partyId,
    version: roster.version,
    memberPlayerIds: roster.members.map((member) => member.playerId).sort(),
  };
}

export function addPartyPackingReservation(
  current: readonly PartyPackingReservation[] | undefined,
  candidate: PartyPackingReservation,
  capacity = 18,
): PartyPackingReservation[] | null {
  if (!Number.isInteger(capacity) || capacity < 1 || !validPackingReservation(candidate)) return null;
  const reservations = current ?? [];
  if (!reservations.every(validPackingReservation)) return null;
  const sameClaim = reservations.find((reservation) => reservation.claimId === candidate.claimId);
  if (sameClaim) return samePackingReservation(sameClaim, candidate) ? reservations.map(clonePackingReservation) : null;
  if (reservations.some((reservation) => reservation.partyId === candidate.partyId)) return null;
  const occupied = new Set(reservations.flatMap((reservation) => reservation.memberPlayerIds));
  if (candidate.memberPlayerIds.some((playerId) => occupied.has(playerId))) return null;
  if (occupied.size + candidate.memberPlayerIds.length > capacity) return null;
  return [...reservations.map(clonePackingReservation), clonePackingReservation(candidate)];
}

function validPackingReservation(value: PartyPackingReservation): boolean {
  return isUuid(value.claimId) && /^(?:party-[a-f0-9]{32}|solo-[a-f0-9]{24})$/.test(value.partyId)
    && Number.isInteger(value.version) && value.version >= 1
    && Array.isArray(value.memberPlayerIds) && value.memberPlayerIds.length >= 1 && value.memberPlayerIds.length <= 3
    && value.memberPlayerIds.every(isUuid) && new Set(value.memberPlayerIds).size === value.memberPlayerIds.length;
}

function samePackingReservation(left: PartyPackingReservation, right: PartyPackingReservation): boolean {
  return left.partyId === right.partyId && left.version === right.version
    && [...left.memberPlayerIds].sort().join(".") === [...right.memberPlayerIds].sort().join(".");
}

function clonePackingReservation(value: PartyPackingReservation): PartyPackingReservation {
  return { ...value, memberPlayerIds: [...value.memberPlayerIds].sort() };
}

export function partyPackingUpdateRequest(
  tableName: string,
  key: string,
  existing: ActiveAtomicArena,
  reservations: readonly PartyPackingReservation[],
  nextPackingRevision: number,
): UpdateCommandInput {
  const hasAdmissionRevision = Number.isInteger(existing.admissionRevision);
  const hasPackingRevision = Number.isInteger(existing.packingRevision);
  return {
    TableName: tableName,
    Key: { pk: key },
    UpdateExpression: "SET partyReservations = :reservations, packingRevision = :nextPackingRevision, expiresAt = :expires",
    ConditionExpression: `#status = :active AND gameSessionId = :session AND arenaId = :arena AND admissionClosesAt = :closes AND admissionClosesAt > :now AND partySecret = :secret AND ${hasAdmissionRevision ? "admissionRevision = :admissionRevision" : "attribute_not_exists(admissionRevision)"} AND ${hasPackingRevision ? "packingRevision = :packingRevision" : "attribute_not_exists(packingRevision)"}`,
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":active": "active",
      ":session": existing.gameSessionId,
      ":arena": existing.arenaId,
      ":closes": existing.admissionClosesAt,
      ":now": Date.now(),
      ":secret": existing.partySecret,
      ":reservations": reservations,
      ":nextPackingRevision": nextPackingRevision,
      ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
      ...(hasAdmissionRevision ? { ":admissionRevision": existing.admissionRevision } : {}),
      ...(hasPackingRevision ? { ":packingRevision": existing.packingRevision } : {}),
    },
  };
}

async function releaseDirectoryReservation(key: string, gameSessionId: string, arenaId: string, claimId: string): Promise<void> {
  const tableName = requiredEnv("TABLE_NAME");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const record = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item as PublicArenaRecord | undefined;
    if (!record || record.gameSessionId !== gameSessionId || record.arenaId !== arenaId) return;
    const reservations = record.partyReservations ?? [];
    if (!reservations.some((reservation) => reservation.claimId === claimId)) return;
    // Release remains allowed after admission closes; only the exact immutable
    // pointer and packing revision are authoritative during cleanup.
    const next = reservations.filter((reservation) => reservation.claimId !== claimId).map(clonePackingReservation);
    const oldPackingRevision = record.packingRevision;
    try {
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: key },
        UpdateExpression: "SET partyReservations = :reservations, packingRevision = :nextPackingRevision",
        ConditionExpression: `gameSessionId = :session AND arenaId = :arena AND ${Number.isInteger(oldPackingRevision) ? "packingRevision = :packingRevision" : "attribute_not_exists(packingRevision)"}`,
        ExpressionAttributeValues: {
          ":session": gameSessionId,
          ":arena": arenaId,
          ":reservations": next,
          ":nextPackingRevision": (oldPackingRevision ?? 0) + 1,
          ...(Number.isInteger(oldPackingRevision) ? { ":packingRevision": oldPackingRevision } : {}),
        },
      }));
      return;
    } catch (error) {
      if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
      throw error;
    }
  }
  throw new MatchmakerError(503, "Party packing cleanup is busy. Retry together.", true);
}

export function recoverableAtomicArenaCreation(
  record: AtomicAllocationRecord,
  claimId: string,
): (Omit<AtomicArenaCreationIntent, "creationId"> & { creationId?: string; leaderPlayerId: string; buildId: string; region: string }) | null {
  if (!isUuid(claimId) || record.pk !== allocationKey(claimId)
    || (record.status !== "allocating" && record.status !== "cancelling")
    || !record.buildId || !record.region || !safeMetadata(record.buildId, 64) || !safeMetadata(record.region, 64)
    || record.arenaKey !== publicArenaKey({ buildId: record.buildId, region: record.region })
    || !isUuid(record.leaderPlayerId ?? "") || (record.creationId !== undefined && !isUuid(record.creationId))
    || !roomCodePattern.test(record.arenaId ?? "")
    || !/^[a-f0-9]{64}$/.test(record.partySecret ?? "")) return null;
  return {
    arenaKey: record.arenaKey,
    arenaId: record.arenaId!,
    partySecret: record.partySecret!,
    ...(record.creationId ? { creationId: record.creationId } : {}),
    leaderPlayerId: record.leaderPlayerId!,
    buildId: record.buildId,
    region: record.region,
  };
}

async function releaseExpiredAllocationDirectoryClaim(record: AtomicAllocationRecord, claimId: string): Promise<void> {
  if (!record.buildId || !record.region || !safeMetadata(record.buildId, 64) || !safeMetadata(record.region, 64)) {
    throw new MatchmakerError(503, "Expired party allocation metadata is incomplete. Retry cancellation.", true);
  }
  const key = publicArenaKey({ buildId: record.buildId, region: record.region });
  const pointer = (await database.send(new GetCommand({
    TableName: requiredEnv("TABLE_NAME"),
    Key: { pk: key },
    ConsistentRead: true,
  }))).Item as PublicArenaRecord | undefined;
  const durableCreation = recoverableAtomicArenaCreation(record, claimId);
  const legacyCreation = pointer?.status === "creating" && pointer.claimId === claimId
    && pointer.buildId === record.buildId && pointer.region === record.region
    && isUuid(record.leaderPlayerId ?? "") && roomCodePattern.test(pointer.arenaId ?? "")
    && /^[a-f0-9]{64}$/.test(pointer.partySecret ?? "")
    ? {
      arenaKey: key,
      arenaId: pointer.arenaId!,
      partySecret: pointer.partySecret!,
      ...(pointer.creationId && isUuid(pointer.creationId) ? { creationId: pointer.creationId } : {}),
      leaderPlayerId: record.leaderPlayerId!,
      buildId: record.buildId,
      region: record.region,
    } : null;
  const creation = durableCreation ?? legacyCreation;
  if (creation) {
    // A CreateGameSession response can be lost before its ARN reaches the
    // allocation record. Replaying the exact idempotency token and durable
    // metadata returns that original GameSession (or creates it once), even
    // after the public pointer expired or another claim replaced it.
    const created = await gameLift.send(new CreateGameSessionCommand(atomicGameSessionRequest(
      claimId,
      creation.leaderPlayerId,
      creation.buildId,
      creation.region,
      creation.arenaId,
      creation.partySecret,
      creation.creationId,
    )));
    const gameSessionId = created.GameSession?.GameSessionId;
    if (!gameSessionId) throw new MatchmakerError(503, "Expired arena creation is still reconciling. Retry cancellation.", true);
    assertAtomicGameSessionMetadata(created.GameSession, creation.arenaId, creation.partySecret, creation.buildId, creation.region);
    await gameLift.send(new TerminateGameSessionCommand({
      GameSessionId: gameSessionId,
      TerminationMode: "TRIGGER_ON_PROCESS_TERMINATE",
    }));
    await database.send(new DeleteCommand({
      TableName: requiredEnv("TABLE_NAME"),
      Key: { pk: creation.arenaKey },
      ConditionExpression: `#status = :creating AND claimId = :claim AND arenaId = :arena AND partySecret = :secret${creation.creationId ? " AND creationId = :creation" : ""}`,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":creating": "creating",
        ":claim": claimId,
        ":arena": creation.arenaId,
        ":secret": creation.partySecret,
        ...(creation.creationId ? { ":creation": creation.creationId } : {}),
      },
    })).catch((error) => {
      // The pointer is only a publication slot. Its absence or replacement
      // must not turn a confirmed exact GameSession termination into failure.
      if (awsErrorName(error) !== "ConditionalCheckFailedException") throw error;
    });
    return;
  }
  if (!pointer?.gameSessionId || !pointer.arenaId
    || !(pointer.partyReservations ?? []).some((reservation) => reservation.claimId === claimId)) return;
  await releaseDirectoryReservation(key, pointer.gameSessionId, pointer.arenaId, claimId);
}

function signPartyOperation(secret: string, scope: "party-preflight" | "party-release", body: string, timestamp: string, requestId: string) {
  return {
    "x-dotbot-timestamp": timestamp,
    "x-dotbot-request-id": requestId,
    "x-dotbot-signature": createHmac("sha256", secret).update(`${scope}.${timestamp}.${requestId}.${body}`).digest("hex"),
  };
}

async function releasePartyPlayerSessions(
  host: string,
  port: number,
  partySecret: string,
  claimId: string,
  arenaId: string,
  playerSessionIds: readonly string[],
): Promise<void> {
  let pending = [...new Set(playerSessionIds)];
  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt += 1) {
    const retry: string[] = [];
    for (let offset = 0; offset < pending.length; offset += 3) {
      const batch = pending.slice(offset, offset + 3);
      const body = JSON.stringify({ arenaId, claimId, playerSessionIds: batch });
      const timestamp = Date.now().toString();
      const requestId = randomUUID();
      try {
        const responseValue = await fetch(`https://${host}:${port}/api/internal/public-party-release`, {
          method: "POST",
          headers: { "content-type": "application/json", ...signPartyOperation(partySecret, "party-release", body, timestamp, requestId) },
          body,
          signal: AbortSignal.timeout(2_000),
        });
        const result = await responseValue.json() as { failedPlayerSessionIds?: unknown };
        if (responseValue.ok) continue;
        if (Array.isArray(result.failedPlayerSessionIds)
          && result.failedPlayerSessionIds.every((value) => typeof value === "string" && batch.includes(value))) {
          retry.push(...result.failedPlayerSessionIds as string[]);
          continue;
        }
      } catch {
        // Retry the exact opaque reservation ids. The adapter reconciles
        // already-terminal removals, so uncertainty cannot reopen one.
      }
      retry.push(...batch);
    }
    pending = [...new Set(retry)];
  }
  if (pending.length > 0) throw new MatchmakerError(503, "Party reservation cleanup is incomplete. Retry cancellation.", true);
}

export type PartyCleanupPlayerSession = { playerId: string; playerSessionId: string };

export function selectPartyCleanupPlayerSessions(
  gameSessionId: string,
  arenaId: string,
  partySecret: string,
  claimId: string,
  memberPlayerIds: readonly string[],
  sessions: readonly CreatedPartyPlayerSession[],
): PartyCleanupPlayerSession[] | null {
  if (!gameSessionId || !roomCodePattern.test(arenaId) || !/^[a-f0-9]{64}$/.test(partySecret)
    || !isUuid(claimId) || memberPlayerIds.length < 1 || memberPlayerIds.length > 3
    || memberPlayerIds.some((playerId) => !isUuid(playerId))
    || new Set(memberPlayerIds).size !== memberPlayerIds.length) return null;
  const expectedMembers = [...memberPlayerIds].sort().join(".");
  const selected: PartyCleanupPlayerSession[] = [];
  for (const session of sessions) {
    const playerId = session.PlayerId;
    if (session.GameSessionId !== gameSessionId || typeof playerId !== "string" || !memberPlayerIds.includes(playerId)
      || typeof session.PlayerData !== "string") continue;
    let data: unknown;
    try {
      data = JSON.parse(session.PlayerData);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const envelope = data as Record<string, unknown>;
    const reservation = parseTrustedPartyReservation(envelope.reservation);
    const signature = typeof envelope.reservationSignature === "string" ? envelope.reservationSignature : "";
    if (envelope.mode !== "public-hot-arena" || !reservation || reservation.claimId !== claimId
      || reservation.playerId !== playerId || reservation.arenaId !== arenaId
      || reservation.memberPlayerIds.join(".") !== expectedMembers
      || !validHexHmac(
        createHmac("sha256", partySecret).update(`party-reservation.${canonicalTrustedPartyReservation(reservation)}`).digest("hex"),
        signature,
      )) continue;
    if (session.Status === "COMPLETED" || session.Status === "TIMEDOUT") continue;
    if ((session.Status !== "RESERVED" && session.Status !== "ACTIVE")
      || typeof session.PlayerSessionId !== "string" || session.PlayerSessionId.length < 1
      || session.PlayerSessionId.length > 2048) return null;
    selected.push({ playerId, playerSessionId: session.PlayerSessionId });
  }
  if (new Set(selected.map((entry) => entry.playerSessionId)).size !== selected.length) return null;
  return selected;
}

async function discoverPartyCleanupPlayerSessions(allocation: AtomicArenaAllocation, claimId: string): Promise<PartyCleanupPlayerSession[]> {
  const sessions: CreatedPartyPlayerSession[] = [];
  for (const playerId of allocation.memberPlayerIds) {
    let nextToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const described = await gameLift.send(new DescribePlayerSessionsCommand({
        GameSessionId: allocation.gameSessionId,
        PlayerId: playerId,
        Limit: 100,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      sessions.push(...(described.PlayerSessions ?? []));
      nextToken = described.NextToken;
      if (!nextToken) break;
      if (page === 9) throw new MatchmakerError(503, "Party reservation discovery is incomplete. Retry cancellation.", true);
    }
  }
  const selected = selectPartyCleanupPlayerSessions(
    allocation.gameSessionId,
    allocation.arenaId,
    allocation.partySecret,
    claimId,
    allocation.memberPlayerIds,
    sessions,
  );
  if (!selected) throw new MatchmakerError(503, "Party reservation discovery could not be trusted. Retry cancellation.", true);
  return selected;
}

async function compensatePartyAllocation(allocation: AtomicArenaAllocation, claimId: string): Promise<void> {
  let reservationCleanupError: unknown;
  let directoryCleanupError: unknown;
  let cleanupPlayerSessionIds = allocation.cleanupPlayerSessionIds;
  if (allocation.cleanupDiscoveryUntil > 0) {
    try {
      const discovered = await discoverPartyCleanupPlayerSessions(allocation, claimId);
      cleanupPlayerSessionIds = [...new Set(cleanupPlayerSessionIds.concat(
        discovered.map((entry) => entry.playerSessionId),
      ))];
      const coveredPlayers = new Set(discovered.map((entry) => entry.playerId));
      if (coveredPlayers.size < allocation.memberPlayerIds.length && Date.now() < allocation.cleanupDiscoveryUntil) {
        reservationCleanupError = new MatchmakerError(503, "Party reservation discovery is settling. Retry cancellation.", true);
      }
    } catch (error) {
      reservationCleanupError = error;
    }
  }
  try {
    await releasePartyPlayerSessions(
      allocation.endpointHost,
      allocation.endpointPort,
      allocation.partySecret,
      claimId,
      allocation.arenaId,
      cleanupPlayerSessionIds,
    );
  } catch (error) {
    reservationCleanupError ??= error;
  }
  try {
    await releaseDirectoryReservation(allocation.arenaKey, allocation.gameSessionId, allocation.arenaId, claimId);
  } catch (error) {
    directoryCleanupError = error;
  }
  if (allocation.terminateGameSession) {
    try {
      await gameLift.send(new TerminateGameSessionCommand({
        GameSessionId: allocation.gameSessionId,
        TerminationMode: "TRIGGER_ON_PROCESS_TERMINATE",
      }));
      // A confirmed whole-GameSession termination subsumes an uncertain
      // per-reservation removal for a never-published replacement arena.
      reservationCleanupError = undefined;
    } catch (error) {
      reservationCleanupError ??= error;
    }
  }
  if (directoryCleanupError) throw directoryCleanupError;
  if (reservationCleanupError) throw reservationCleanupError;
}

function allocationFromRecord(record: AtomicAllocationRecord): AtomicArenaAllocation | null {
  const allocations = Array.isArray(record.allocations) ? record.allocations : [];
  const memberPlayerIds = Array.isArray(record.memberPlayerIds) ? record.memberPlayerIds : [];
  const cleanupPlayerSessionIds = record.cleanupPlayerSessionIds
    ?? allocations.map((entry) => entry.playerSessionId);
  const cleanupDiscoveryUntil = record.cleanupDiscoveryUntil ?? 0;
  if (!record.arenaKey || !record.gameSessionId || !record.arenaId || !record.endpointHost
    || !record.endpointPort || !record.partySecret || !/^[a-f0-9]{64}$/.test(record.partySecret)
    || memberPlayerIds.length < 1 || memberPlayerIds.length > 3
    || memberPlayerIds.some((entry) => !isUuid(entry)) || new Set(memberPlayerIds).size !== memberPlayerIds.length
    || allocations.length > 3
    || allocations.some((entry) => !isUuid(entry.playerId) || !entry.playerSessionId || !entry.websocketUrl)
    || new Set(allocations.map((entry) => entry.playerId)).size !== allocations.length
    || new Set(allocations.map((entry) => entry.playerSessionId)).size !== allocations.length
    || allocations.some((entry) => !memberPlayerIds.includes(entry.playerId))
    || !Array.isArray(cleanupPlayerSessionIds) || cleanupPlayerSessionIds.length > 3
    || cleanupPlayerSessionIds.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 2048)
    || new Set(cleanupPlayerSessionIds).size !== cleanupPlayerSessionIds.length
    || allocations.some((entry) => !cleanupPlayerSessionIds.includes(entry.playerSessionId))
    || !Number.isSafeInteger(cleanupDiscoveryUntil) || cleanupDiscoveryUntil < 0) return null;
  return {
    arenaKey: record.arenaKey,
    gameSessionId: record.gameSessionId,
    arenaId: record.arenaId,
    endpointHost: record.endpointHost,
    endpointPort: record.endpointPort,
    partySecret: record.partySecret,
    packingRevision: 0,
    memberPlayerIds,
    allocations,
    cleanupPlayerSessionIds,
    cleanupDiscoveryUntil,
    terminateGameSession: record.terminateGameSession === true,
  };
}

function sameAtomicAllocationRecord(record: AtomicAllocationRecord | undefined, allocation: AtomicArenaAllocation): boolean {
  const parsed = record ? allocationFromRecord(record) : null;
  if (!parsed || parsed.arenaKey !== allocation.arenaKey || parsed.gameSessionId !== allocation.gameSessionId
    || parsed.arenaId !== allocation.arenaId || parsed.endpointHost !== allocation.endpointHost
    || parsed.endpointPort !== allocation.endpointPort || parsed.partySecret !== allocation.partySecret
    || parsed.allocations.length !== allocation.allocations.length
    || parsed.cleanupDiscoveryUntil !== allocation.cleanupDiscoveryUntil
    || parsed.terminateGameSession !== allocation.terminateGameSession
    || [...parsed.memberPlayerIds].sort().join("|") !== [...allocation.memberPlayerIds].sort().join("|")
    || [...parsed.cleanupPlayerSessionIds].sort().join("|") !== [...allocation.cleanupPlayerSessionIds].sort().join("|")) return false;
  const expected = [...allocation.allocations]
    .map((entry) => `${entry.playerId}:${entry.playerSessionId}`).sort().join("|");
  const actual = [...parsed.allocations]
    .map((entry) => `${entry.playerId}:${entry.playerSessionId}`).sort().join("|");
  return actual === expected;
}

async function cancelAtomicQuickPlay(payload: Record<string, unknown>): Promise<{ cancelled: true; queueTicket: string }> {
  const token = validPlayerToken(payload.token);
  const claimId = typeof payload.queueTicket === "string" ? payload.queueTicket.trim().toLowerCase() : "";
  if (!isUuid(claimId)) throw new MatchmakerError(400, "A valid quick-play cancellation ticket is required.");
  const authorization = await authenticatePartyCancellation(token, claimId);
  const tableName = requiredEnv("TABLE_NAME");
  const key = allocationKey(claimId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let record = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item as AtomicAllocationRecord | undefined;
    if (!record) {
      try {
        await database.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: key,
            status: "cancelled",
            memberPlayerIds: [authorization.playerId],
            expiresAt: Math.floor(Date.now() / 1000) + 6 * 60 * 60,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        await completePartyCancellation(token, claimId);
        return { cancelled: true, queueTicket: claimId };
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
    }
    if (record.status === "cancelled") {
      await completePartyCancellation(token, claimId);
      return { cancelled: true, queueTicket: claimId };
    }
    if (!record.memberPlayerIds?.includes(authorization.playerId)) {
      throw new MatchmakerError(403, "This player cannot cancel that party allocation.");
    }
    if (record.status === "active" || record.status === "allocating") {
      try {
        await database.send(new UpdateCommand({
          TableName: tableName,
          Key: { pk: key },
          UpdateExpression: "SET #status = :cancelling, cancelRequestedAt = :now",
          ConditionExpression: "#status = :expected AND contains(memberPlayerIds, :playerId)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":expected": record.status,
            ":cancelling": "cancelling",
            ":now": Date.now(),
            ":playerId": authorization.playerId,
          },
        }));
        record = { ...record, status: "cancelling" };
      } catch (error) {
        if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
        throw error;
      }
    }
    const allocation = allocationFromRecord(record);
    if (!allocation) {
      if (record.status === "cancelling" && Number.isFinite(record.ownerLeaseExpiresAt)
        && record.ownerLeaseExpiresAt! <= Date.now()) {
        await releaseExpiredAllocationDirectoryClaim(record, claimId);
        try {
          await database.send(new UpdateCommand({
            TableName: tableName,
            Key: { pk: key },
            UpdateExpression: "SET #status = :cancelled, expiresAt = :expires REMOVE #owner, ownerLeaseExpiresAt",
            ConditionExpression: "#status = :cancelling AND ownerLeaseExpiresAt = :lease AND attribute_not_exists(allocations)",
            ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
            ExpressionAttributeValues: {
              ":cancelling": "cancelling",
              ":cancelled": "cancelled",
              ":lease": record.ownerLeaseExpiresAt,
              ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
            },
          }));
          await completePartyCancellation(token, claimId);
          return { cancelled: true, queueTicket: claimId };
        } catch (error) {
          if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * Math.min(attempt + 1, 4)));
      continue;
    }
    await compensatePartyAllocation(allocation, claimId);
    try {
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: key },
        UpdateExpression: "SET #status = :cancelled, expiresAt = :expires REMOVE #owner, ownerLeaseExpiresAt",
        ConditionExpression: "#status = :cancelling",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: {
          ":cancelling": "cancelling",
          ":cancelled": "cancelled",
          ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
        },
      }));
    } catch (error) {
      if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
      throw error;
    }
    await completePartyCancellation(token, claimId);
    return { cancelled: true, queueTicket: claimId };
  }
  throw new MatchmakerError(503, "Party cancellation is reconciling. Retry together.", true);
}

async function atomicQuickPlayStatus(payload: Record<string, unknown>): Promise<{
  status: "allocating" | "active" | "cancelling" | "cancelled" | "completed" | "expired";
  queueTicket: string;
  allocation?: ConnectionAllocation;
}> {
  const token = validPlayerToken(payload.token);
  const claimId = typeof payload.queueTicket === "string" ? payload.queueTicket.trim().toLowerCase() : "";
  if (!isUuid(claimId)) throw new MatchmakerError(400, "A valid quick-play status ticket is required.");
  const authorization = await authenticatePartyStatus(token, claimId);
  if (authorization.status !== "active" && authorization.status !== "completed") {
    return { status: authorization.status, queueTicket: claimId };
  }
  const record = (await database.send(new GetCommand({
    TableName: requiredEnv("TABLE_NAME"),
    Key: { pk: allocationKey(claimId) },
    ConsistentRead: true,
  }))).Item as AtomicAllocationRecord | undefined;
  if (!record) {
    return { status: authorization.status === "completed" ? "completed" : "allocating", queueTicket: claimId };
  }
  if (!record.memberPlayerIds?.includes(authorization.playerId)) {
    throw new MatchmakerError(403, "This player cannot inspect that party allocation.");
  }
  if (authorization.status === "completed") {
    if (record.status !== "active" || record.expiresAt <= Math.floor(Date.now() / 1000)) {
      return { status: "completed", queueTicket: claimId };
    }
    const allocation = allocationForQueueStatus(record, claimId, authorization.playerId);
    if (!allocation) throw new MatchmakerError(503, "Party allocation status is reconciling.", true);
    return { status: "completed", queueTicket: claimId, allocation };
  }
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return { status: "expired", queueTicket: claimId };
  if (record.status === "allocating") return { status: "allocating", queueTicket: claimId };
  if (record.status === "cancelling") return { status: "cancelling", queueTicket: claimId };
  if (record.status === "cancelled") return { status: "cancelled", queueTicket: claimId };
  const allocation = allocationForQueueStatus(record, claimId, authorization.playerId);
  if (!allocation) throw new MatchmakerError(503, "Party allocation status is reconciling.", true);
  return { status: "active", queueTicket: claimId, allocation };
}

/** Projects exactly one authorized member's reconnect data from a completed
 * atomic claim. Canonical roster and other member sessions never cross the
 * public status boundary. */
export function allocationForQueueStatus(
  record: AtomicAllocationRecord | undefined,
  claimId: string,
  playerId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): ConnectionAllocation | null {
  if (!record || record.status !== "active" || record.expiresAt <= nowSeconds
    || !record.memberPlayerIds?.includes(playerId)) return null;
  const complete = allocationFromRecord(record);
  const member = complete?.allocations.find((entry) => entry.playerId === playerId);
  if (!complete || !member) return null;
  return {
    mode: "public-hot-arena",
    arenaId: complete.arenaId,
    playerSessionId: member.playerSessionId,
    websocketUrl: member.websocketUrl,
    expiresAt: member.expiresAt,
    queueTicket: claimId,
    partySize: complete.memberPlayerIds.length,
  };
}

async function authenticatePartyCancellation(token: string, claimId: string): Promise<AtomicCancellationAuthorization> {
  const body = JSON.stringify({ token, partyAllocationVersion: "party-v1", operation: "cancel", claimId });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const secret = await relaySecret();
  let responseValue: Response;
  try {
    responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/matchmaker-auth`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signControlPlaneRequest(secret, body, timestamp, requestId, "matchmaker-auth") },
      body,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw controlPlaneFailure(503, "Party cancellation was not authorized.");
  }
  if (!responseValue.ok) throw controlPlaneFailure(responseValue.status, "Party cancellation was not authorized.");
  const result = await responseValue.json() as { cancelledClaimId?: unknown; playerId?: unknown; cancelSignature?: unknown };
  const playerId = typeof result.playerId === "string" ? result.playerId : "";
  const signature = typeof result.cancelSignature === "string" ? result.cancelSignature : "";
  if (result.cancelledClaimId !== claimId || !isUuid(playerId)
    || !validHexHmac(createHmac("sha256", secret).update(`party-cancel.${requestId}.${claimId}.${playerId}`).digest("hex"), signature)) {
    throw new MatchmakerError(401, "Party cancellation was not authorized.");
  }
  return { claimId, playerId };
}

async function authenticatePartyStatus(token: string, claimId: string): Promise<AtomicStatusAuthorization> {
  const body = JSON.stringify({ token, partyAllocationVersion: "party-v1", operation: "status", claimId });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const secret = await relaySecret();
  let responseValue: Response;
  try {
    responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/matchmaker-auth`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signControlPlaneRequest(secret, body, timestamp, requestId, "matchmaker-auth") },
      body,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw controlPlaneFailure(503, "Party status was not authorized.");
  }
  if (!responseValue.ok) throw controlPlaneFailure(responseValue.status, "Party status was not authorized.");
  const result = await responseValue.json() as { queueClaimId?: unknown; playerId?: unknown; status?: unknown; statusSignature?: unknown };
  const playerId = typeof result.playerId === "string" ? result.playerId : "";
  const status = result.status;
  const signature = typeof result.statusSignature === "string" ? result.statusSignature : "";
  if (result.queueClaimId !== claimId || !isUuid(playerId) || !isCloudQueueStatus(status)
    || !validHexHmac(createHmac("sha256", secret).update(`party-status.${requestId}.${claimId}.${playerId}.${status}`).digest("hex"), signature)) {
    throw new MatchmakerError(401, "Party status was not authorized.");
  }
  return { claimId, playerId, status };
}

function isCloudQueueStatus(value: unknown): value is AtomicStatusAuthorization["status"] {
  return value === "active" || value === "cancelling" || value === "cancelled" || value === "completed" || value === "expired";
}

async function completePartyCancellation(token: string, claimId: string): Promise<void> {
  const body = JSON.stringify({ token, partyAllocationVersion: "party-v1", operation: "cancel-complete", claimId });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const secret = await relaySecret();
  let responseValue: Response;
  try {
    responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/matchmaker-auth`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signControlPlaneRequest(secret, body, timestamp, requestId, "matchmaker-auth") },
      body,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    throw new MatchmakerError(503, "Party cancellation is saved in AWS but Cloud SQL reconciliation must be retried.", true);
  }
  if (!responseValue.ok) throw new MatchmakerError(503, "Party cancellation is saved in AWS but Cloud SQL reconciliation must be retried.", true);
}

export function controlPlaneFailure(status: number, message: string): MatchmakerError {
  return new MatchmakerError(status >= 500 ? 503 : status === 409 ? 409 : 401, message, status >= 500);
}

async function quickPlay(identity: Identity, payload: Record<string, unknown>): Promise<ConnectionAllocation> {
  const allowedRegions = (process.env.QUICK_PLAY_REGIONS ?? process.env.GAME_LOCATION ?? process.env.GAMELIFT_REGION ?? region)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ticket = normalizeQuickPlayTicket(payload, identity, allowedRegions, requiredEnv("QUICK_PLAY_BUILD_ID"));
  const fleetId = requiredEnv("FLEET_ID");
  const tableName = requiredEnv("TABLE_NAME");
  const key = publicArenaKey(ticket);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = (await database.send(new GetCommand({ TableName: tableName, Key: { pk: key }, ConsistentRead: true }))).Item as PublicArenaRecord | undefined;
    if (existing?.status === "active" && existing.gameSessionId && existing.arenaId
      && existing.buildId === ticket.buildId && existing.region === ticket.region
      && (existing.admissionClosesAt ?? 0) > Date.now()) {
      try {
        return await allocatePublicPlayer(existing.gameSessionId, existing.arenaId, identity, ticket);
      } catch (error) {
        if (!isClosedGameSessionError(error) && !isFullGameSessionError(error)) throw error;
        await database.send(new DeleteCommand(stalePublicArenaDeleteRequest(
          tableName,
          key,
          existing.gameSessionId,
          existing.arenaId,
          existing.admissionClosesAt!,
          existing.admissionRevision,
        ))).catch(() => undefined);
      }
    }

    const owner = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 2 * 60;
    try {
      await database.send(new PutCommand({
        TableName: tableName,
        Item: { pk: key, status: "creating", owner, buildId: ticket.buildId, region: ticket.region, expiresAt },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :nowSeconds OR admissionClosesAt < :nowMillis",
        ExpressionAttributeValues: { ":nowSeconds": Math.floor(Date.now() / 1000), ":nowMillis": Date.now() },
      }));
    } catch (error) {
      if (awsErrorName(error) === "ConditionalCheckFailedException") continue;
      throw error;
    }

    let gameSessionId: string | undefined;
    try {
      const arenaId = generateRoomCode();
      const created = await gameLift.send(new CreateGameSessionCommand({
        FleetId: fleetId,
        Location: ticket.region,
        MaximumPlayerSessionCount: 18,
        Name: `DotBot public ${arenaId}`,
        CreatorId: identity.playerId,
        GameProperties: [
          { Key: "mode", Value: "public-hot-arena" },
          { Key: "arenaId", Value: arenaId },
          { Key: "buildId", Value: ticket.buildId },
          { Key: "region", Value: ticket.region },
        ],
      }));
      gameSessionId = created.GameSession?.GameSessionId;
      if (!gameSessionId) throw new Error("GameLift returned no game session id.");
      // Reserve the creator before publishing the arena. Otherwise another
      // request can successfully join the just-published session and then be
      // stranded if the creator's own reservation fails and cleanup
      // terminates what has already become shared capacity.
      const creatorAllocation = await allocatePublicPlayer(gameSessionId, arenaId, identity, ticket);
      const admissionClosesAt = Date.now() + 6_000;
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: key },
        UpdateExpression: "SET gameSessionId = :session, arenaId = :arena, admissionClosesAt = :closes, expiresAt = :expires, #status = :active REMOVE #owner",
        ConditionExpression: "owner = :owner",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: {
          ":session": gameSessionId,
          ":arena": arenaId,
          ":closes": admissionClosesAt,
          ":expires": Math.floor(Date.now() / 1000) + 6 * 60 * 60,
          ":active": "active",
          ":owner": owner,
        },
      }));
      return creatorAllocation;
    } catch (error) {
      await database.send(new DeleteCommand({
        TableName: tableName,
        Key: { pk: key },
        ConditionExpression: "owner = :owner",
        ExpressionAttributeValues: { ":owner": owner },
      })).catch(() => undefined);
      if (gameSessionId) {
        await gameLift.send(new TerminateGameSessionCommand({
          GameSessionId: gameSessionId,
          TerminationMode: "TRIGGER_ON_PROCESS_TERMINATE",
        })).catch((cleanupError) => console.error("failed to terminate orphaned public arena", { errorName: safeErrorName(cleanupError) }));
      }
      if (isFleetWakingError(error)) throw new MatchmakerError(503, "Dedicated game server is waking up. This can take about a minute.", true);
      throw error;
    }
  }
  throw new MatchmakerError(503, "Public quick play is busy. Try again.", true);
}

async function allocatePublicPlayer(gameSessionId: string, arenaId: string, identity: Identity, ticket: QuickPlayTicket): Promise<ConnectionAllocation> {
  const allocation = await gameLift.send(new CreatePlayerSessionCommand({
    GameSessionId: gameSessionId,
    PlayerId: identity.playerId,
    PlayerData: JSON.stringify({
      mode: "public-hot-arena",
      arenaId,
      partyId: ticket.partyId,
      buildId: ticket.buildId,
      region: ticket.region,
    }),
  }));
  const session = allocation.PlayerSession;
  if (!session?.PlayerSessionId || !session.Port) throw new Error("GameLift returned incomplete connection details.");
  const host = session.DnsName || session.IpAddress;
  if (!host) throw new Error("GameLift returned no connection host.");
  return {
    mode: "public-hot-arena",
    arenaId,
    playerSessionId: session.PlayerSessionId,
    websocketUrl: secureWebSocketUrl(host, session.Port),
    expiresAt: session.CreationTime?.toISOString(),
  };
}

export function normalizeQuickPlayTicket(
  payload: Record<string, unknown>,
  identity: Identity,
  allowedRegions: readonly string[],
  expectedBuildId: string,
): QuickPlayTicket {
  const buildId = typeof payload.buildId === "string" ? payload.buildId.trim() : "";
  // The authenticated player id is a private Cloud SQL UUID. Public arena
  // messages carry party ids, so the solo fallback must be stable and opaque
  // rather than embedding that UUID in the WebSocket contract.
  const partyId = identity.partyId?.trim()
    || `solo-${createHash("sha256").update(identity.playerId).digest("hex").slice(0, 24)}`;
  if (expectedBuildId.toLowerCase() === "disabled" || !safeMetadata(expectedBuildId, 64)
    || buildId !== expectedBuildId || !safeMetadata(partyId, 128)) {
    throw new MatchmakerError(400, "Quick-play build or party metadata is invalid.");
  }
  const latencies = payload.latencies;
  if (!latencies || typeof latencies !== "object" || Array.isArray(latencies)) throw new MatchmakerError(400, "Regional latency measurements are required.");
  const candidates = allowedRegions.map((candidate) => ({
    region: candidate,
    latencyMs: (latencies as Record<string, unknown>)[candidate],
  })).filter((candidate): candidate is { region: string; latencyMs: number } =>
    typeof candidate.latencyMs === "number" && Number.isFinite(candidate.latencyMs)
      && candidate.latencyMs >= 0 && candidate.latencyMs <= 5_000);
  if (candidates.length === 0) throw new MatchmakerError(400, "No compatible regional latency measurement was supplied.");
  candidates.sort((left, right) => left.latencyMs - right.latencyMs || allowedRegions.indexOf(left.region) - allowedRegions.indexOf(right.region));
  return {
    playerId: identity.playerId,
    playerName: identity.name,
    partyId,
    buildId,
    region: candidates[0].region,
    latencyMs: candidates[0].latencyMs,
  };
}

export function isPublicQuickPlayEnabled(): boolean {
  const buildId = process.env.QUICK_PLAY_BUILD_ID?.trim() ?? "";
  return process.env.DOTBOT_PUBLIC_QUICK_PLAY === "true"
    && buildId.toLowerCase() !== "disabled"
    && safeMetadata(buildId, 64);
}

export function isAtomicPartyAllocationEnabled(): boolean {
  return isPublicQuickPlayEnabled() && process.env.DOTBOT_ATOMIC_PARTY_ALLOCATION === "true";
}

export function publicArenaKey(ticket: Pick<QuickPlayTicket, "region" | "buildId">): string {
  return `PUBLIC#${ticket.region}#${ticket.buildId}`;
}

export function stalePublicArenaDeleteRequest(
  tableName: string,
  key: string,
  gameSessionId: string,
  arenaId: string,
  admissionClosesAt: number,
  admissionRevision?: number,
  packingRevision?: number,
): DeleteCommandInput {
  const hasRevision = Number.isInteger(admissionRevision);
  const hasPackingRevision = Number.isInteger(packingRevision);
  return {
    TableName: tableName,
    Key: { pk: key },
    ConditionExpression: `gameSessionId = :session AND arenaId = :arena AND admissionClosesAt = :closes AND ${hasRevision ? "admissionRevision = :revision" : "attribute_not_exists(admissionRevision)"}${hasPackingRevision ? " AND packingRevision = :packingRevision" : ""}`,
    ExpressionAttributeValues: {
      ":session": gameSessionId,
      ":arena": arenaId,
      ":closes": admissionClosesAt,
      ...(hasRevision ? { ":revision": admissionRevision } : {}),
      ...(hasPackingRevision ? { ":packingRevision": packingRevision } : {}),
    },
  };
}

function isInternalEvent(event: APIGatewayProxyEventV2 | InternalEvent): event is InternalEvent {
  return "source" in event && (event.source === "dotbot-game-server" || event.source === "dotbot-arena-server");
}

async function updateArenaAdmission(args: unknown): Promise<{ updated: boolean }> {
  const parsed = parseArenaAdmissionUpdate(args, Date.now());
  try {
    await database.send(new UpdateCommand(arenaAdmissionUpdateRequest(parsed, requiredEnv("TABLE_NAME"), Date.now())));
  } catch (error) {
    // A condition miss means this session/revision no longer owns the pool
    // pointer. It is a terminal stale update, not a transient error for the
    // old arena to retry every 500 ms for the rest of its lifetime.
    if (awsErrorName(error) === "ConditionalCheckFailedException") return { updated: false };
    throw error;
  }
  return { updated: true };
}

export function arenaAdmissionUpdateRequest(
  parsed: ReturnType<typeof parseArenaAdmissionUpdate>,
  tableName: string,
  now: number,
): UpdateCommandInput {
  const { arenaId, buildId, region: targetRegion, gameSessionId, closesAt, revision, open } = parsed;
  const key = { pk: publicArenaKey({ region: targetRegion, buildId }) };
  const common = {
    TableName: tableName,
    Key: key,
    ExpressionAttributeNames: { "#status": "status", "#region": "region" },
  };
  if (open) {
    return {
      ...common,
      UpdateExpression: "SET admissionClosesAt = :closes, admissionRevision = :revision, expiresAt = :expires",
      // The control plane publishes the GameSession/arena tuple before any
      // arena callback may revise it. Requiring that exact tuple prevents a
      // delayed callback from recreating a deleted pointer or reclaiming a
      // closed replacement session, including a four-character arena-id ABA.
      ConditionExpression: "#status = :active AND gameSessionId = :session AND arenaId = :arena AND buildId = :build AND #region = :region AND (attribute_not_exists(admissionRevision) OR admissionRevision < :revision)",
      ExpressionAttributeValues: {
        ":session": gameSessionId,
        ":closes": closesAt,
        ":active": "active",
        ":arena": arenaId,
        ":build": buildId,
        ":region": targetRegion,
        ":revision": revision,
        ":expires": Math.floor(now / 1000) + 6 * 60 * 60,
      },
    };
  }
  return {
    ...common,
    UpdateExpression: "SET admissionClosesAt = :closes, admissionRevision = :revision",
    ConditionExpression: "#status = :active AND arenaId = :arena AND gameSessionId = :session AND buildId = :build AND #region = :region AND (attribute_not_exists(admissionRevision) OR admissionRevision < :revision)",
    ExpressionAttributeValues: {
      ":session": gameSessionId,
      ":closes": closesAt,
      ":active": "active",
      ":arena": arenaId,
      ":build": buildId,
      ":region": targetRegion,
      ":revision": revision,
    },
  };
}

export function parseArenaAdmissionUpdate(args: unknown, now: number): { arenaId: string; buildId: string; region: string; gameSessionId: string; open: boolean; closesAt: number; revision: number } {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid arena admission update.");
  const value = args as Record<string, unknown>;
  const arenaId = typeof value.arenaId === "string" ? value.arenaId.trim().toUpperCase() : "";
  const buildId = typeof value.buildId === "string" ? value.buildId.trim() : "";
  const targetRegion = typeof value.region === "string" ? value.region.trim() : "";
  const gameSessionId = typeof value.gameSessionId === "string" ? value.gameSessionId.trim() : "";
  const open = value.open === true;
  const closesAt = open && typeof value.closesAt === "number" ? value.closesAt : 0;
  const revision = value.revision;
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(arenaId) || !safeMetadata(buildId, 64) || !safeMetadata(targetRegion, 64) || !safeMetadata(gameSessionId, 256)
    || !Number.isInteger(revision) || (revision as number) < 1
    || (open && (!Number.isFinite(closesAt) || closesAt < now - 1_000 || closesAt > now + 6_500))) {
    throw new Error("Invalid arena admission update.");
  }
  return { arenaId, buildId, region: targetRegion, gameSessionId, open, closesAt, revision: revision as number };
}

async function createRoom(identity: Identity): Promise<ConnectionAllocation> {
  const fleetId = requiredEnv("FLEET_ID");
  const tableName = requiredEnv("TABLE_NAME");
  const expiresAt = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  let roomCode = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    roomCode = generateRoomCode();
    try {
      await database.send(new PutCommand({
        TableName: tableName,
        Item: { pk: roomKey(roomCode), status: "creating", expiresAt },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      roomCode = "";
    }
  }
  if (!roomCode) throw new MatchmakerError(503, "Unable to allocate a room code.");

  let gameSessionId: string | undefined;
  try {
    const created = await gameLift.send(new CreateGameSessionCommand({
      FleetId: fleetId,
      Location: process.env.GAME_LOCATION || undefined,
      MaximumPlayerSessionCount: 9,
      Name: `DotBot ${roomCode}`,
      CreatorId: identity.playerId,
      GameProperties: [{ Key: "roomCode", Value: roomCode }],
    }));
    gameSessionId = created.GameSession?.GameSessionId;
    if (!gameSessionId) throw new Error("GameLift returned no game session id.");
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: roomKey(roomCode) },
      UpdateExpression: "SET gameSessionId = :session, #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":session": gameSessionId, ":active": "active" },
    }));
    return await allocatePlayer(gameSessionId, roomCode, identity);
  } catch (error) {
    await database.send(new DeleteCommand({ TableName: tableName, Key: { pk: roomKey(roomCode) } })).catch(() => undefined);
    if (gameSessionId) {
      await gameLift.send(new TerminateGameSessionCommand({
        GameSessionId: gameSessionId,
        TerminationMode: "TRIGGER_ON_PROCESS_TERMINATE",
      })).catch((cleanupError) => console.error("failed to terminate orphaned game session", { errorName: safeErrorName(cleanupError) }));
    }
    if (isFleetWakingError(error)) {
      throw new MatchmakerError(503, "Dedicated game server is waking up. This can take about a minute.", true);
    }
    throw error;
  }
}

async function joinRoom(roomCode: string, identity: Identity): Promise<ConnectionAllocation> {
  const tableName = requiredEnv("TABLE_NAME");
  const result = await database.send(new GetCommand({ TableName: tableName, Key: { pk: roomKey(roomCode) } }));
  const room = result.Item as RoomRecord | undefined;
  if (!room || room.expiresAt <= Math.floor(Date.now() / 1000)) throw new MatchmakerError(404, "That room does not exist.");
  if (room.status !== "active" || !room.gameSessionId) throw new MatchmakerError(409, "That room is still starting. Try again in a moment.");
  try {
    return await allocatePlayer(room.gameSessionId, roomCode, identity);
  } catch (error) {
    if (isClosedGameSessionError(error)) {
      await database.send(new DeleteCommand({ TableName: tableName, Key: { pk: roomKey(roomCode) } })).catch(() => undefined);
      throw new MatchmakerError(404, "That room is no longer active.");
    }
    if (isFullGameSessionError(error)) throw new MatchmakerError(409, "That room is full.");
    throw error;
  }
}

async function allocatePlayer(gameSessionId: string, roomCode: string, identity: Identity): Promise<ConnectionAllocation> {
  const allocation = await gameLift.send(new CreatePlayerSessionCommand({
    GameSessionId: gameSessionId,
    PlayerId: identity.playerId,
    PlayerData: JSON.stringify({ name: identity.name }),
  }));
  const session = allocation.PlayerSession;
  if (!session?.PlayerSessionId || !session.Port) throw new Error("GameLift returned incomplete connection details.");
  const host = session.DnsName || session.IpAddress;
  if (!host) throw new Error("GameLift returned no connection host.");
  return {
    roomCode,
    playerSessionId: session.PlayerSessionId,
    websocketUrl: secureWebSocketUrl(host, session.Port),
    expiresAt: session.CreationTime?.toISOString(),
  };
}

async function authenticate(token: unknown): Promise<Identity> {
  if (typeof token !== "string" || token.length < 16 || token.length > 512) throw new MatchmakerError(401, "A valid player token is required.");
  const body = JSON.stringify({ token });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const signedHeaders = signControlPlaneRequest(await relaySecret(), body, timestamp, requestId, "matchmaker-auth");
  let responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/matchmaker-auth`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders,
    },
    body,
    signal: AbortSignal.timeout(3000),
  });
  // Deploy this matchmaker first: it remains compatible with the prior control
  // plane, then switches to the signed internal UUID contract once available.
  if (responseValue.status === 404) {
    responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/auth/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(3000),
    });
  }
  if (!responseValue.ok) throw new MatchmakerError(401, "Player authentication failed.");
  const identity = await responseValue.json() as Partial<Identity>;
  if (!identity.playerId || !identity.name) throw new MatchmakerError(401, "Player authentication failed.");
  const partyId = typeof identity.partyId === "string" ? identity.partyId.trim() : undefined;
  if (partyId && !safeMetadata(partyId, 128)) throw new MatchmakerError(401, "Player authentication failed.");
  return { playerId: identity.playerId, name: identity.name, ...(partyId ? { partyId } : {}) };
}

async function relayPersistence(operation: string, args: unknown): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(operation)) throw new Error("Invalid relay operation.");
  const body = JSON.stringify({ operation, args });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const signedHeaders = signControlPlaneRequest(await relaySecret(), body, timestamp, requestId, "game-persistence");
  const responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/game-persistence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders,
    },
    body,
    signal: AbortSignal.timeout(5000),
  });
  const payload = await responseValue.json() as { result?: unknown; error?: string };
  if (!responseValue.ok || payload.error) throw new Error(payload.error ?? `control plane returned ${responseValue.status}`);
  return payload.result;
}

async function relaySecret(): Promise<string> {
  relaySecretPromise ??= secrets.send(new GetSecretValueCommand({ SecretId: requiredEnv("RELAY_SECRET_ARN") })).then((value) => {
    if (!value.SecretString) throw new Error("Persistence relay secret is empty.");
    return value.SecretString;
  });
  return relaySecretPromise;
}

export function secureWebSocketUrl(host: string, port: number): string {
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid GameLift endpoint.");
  }
  return `wss://${host}:${port}/ws`;
}

export function signControlPlaneRequest(
  secret: string,
  body: string,
  timestamp: string,
  requestId: string,
  scope: "matchmaker-auth" | "game-persistence" = "matchmaker-auth",
) {
  return {
    "x-dotbot-timestamp": timestamp,
    "x-dotbot-request-id": requestId,
    "x-dotbot-signature": createHmac("sha256", secret).update(`${scope}.${timestamp}.${requestId}.${body}`).digest("hex"),
  };
}

export function generateRoomCode(): string {
  const bytes = randomBytes(4);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function isFleetWakingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  return name === "FleetCapacityExceededException" || name === "NotReadyException";
}

export function isClosedGameSessionError(error: unknown): boolean {
  const name = awsErrorName(error);
  return name === "NotFoundException" || name === "InvalidGameSessionStatusException";
}

export function isFullGameSessionError(error: unknown): boolean {
  return awsErrorName(error) === "GameSessionFullException";
}

function awsErrorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "";
}

function safeErrorName(error: unknown): string {
  const name = awsErrorName(error) || (error instanceof Error ? error.name : "");
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "UnknownError";
}

function normalizeRoomCode(value: string | undefined): string {
  const code = value?.trim().toUpperCase() ?? "";
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) throw new MatchmakerError(400, "Enter a valid room code.");
  return code;
}

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) throw new MatchmakerError(400, "A request body is required.");
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new MatchmakerError(400, "Request body must be valid JSON.");
  }
}

function roomKey(roomCode: string): string { return `ROOM#${roomCode}`; }

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function safeMetadata(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function validPlayerToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) {
    throw new MatchmakerError(401, "A valid player token is required.");
  }
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validHexHmac(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

class MatchmakerError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

type ConnectionAllocation = {
  mode?: "public-hot-arena";
  roomCode?: string;
  arenaId?: string;
  playerSessionId: string;
  websocketUrl: string;
  expiresAt?: string;
  /** Opaque cancellation handle, never a party or player identifier. */
  queueTicket?: string;
  partySize?: number;
};
