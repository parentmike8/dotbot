import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateGameSessionCommand,
  CreatePlayerSessionCommand,
  GameLiftClient,
  TerminateGameSessionCommand,
} from "@aws-sdk/client-gamelift";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, type DeleteCommandInput, type UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const region = process.env.AWS_REGION ?? "us-east-1";
const gameLift = new GameLiftClient({ region: process.env.GAMELIFT_REGION ?? region });
const database = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const secrets = new SecretsManagerClient({ region });
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
};
export type QuickPlayTicket = {
  playerId: string;
  playerName: string;
  partyId: string;
  buildId: string;
  region: string;
  latencyMs: number;
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
      });
    }
    if (route === "POST /quick-play" && !isPublicQuickPlayEnabled()) {
      return response(404, { error: "Route not found." });
    }
    const payload = parseBody(event.body);
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
        })).catch((cleanupError) => console.error("failed to terminate orphaned public arena", cleanupError));
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
): DeleteCommandInput {
  const hasRevision = Number.isInteger(admissionRevision);
  return {
    TableName: tableName,
    Key: { pk: key },
    ConditionExpression: `gameSessionId = :session AND arenaId = :arena AND admissionClosesAt = :closes AND ${hasRevision ? "admissionRevision = :revision" : "attribute_not_exists(admissionRevision)"}`,
    ExpressionAttributeValues: {
      ":session": gameSessionId,
      ":arena": arenaId,
      ":closes": admissionClosesAt,
      ...(hasRevision ? { ":revision": admissionRevision } : {}),
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
  return awsErrorName(error) || (error instanceof Error ? error.name : "UnknownError");
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
};
