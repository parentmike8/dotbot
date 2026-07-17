import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CreateGameSessionCommand,
  CreatePlayerSessionCommand,
  GameLiftClient,
  TerminateGameSessionCommand,
} from "@aws-sdk/client-gamelift";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const region = process.env.AWS_REGION ?? "us-east-1";
const gameLift = new GameLiftClient({ region: process.env.GAMELIFT_REGION ?? region });
const database = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const secrets = new SecretsManagerClient({ region });
let relaySecretPromise: Promise<string> | null = null;

type InternalEvent = { source: "dotbot-game-server"; operation: string; args: unknown };
type RoomRecord = { pk: string; gameSessionId?: string; status: "creating" | "active"; expiresAt: number };
type Identity = { playerId: string; name: string };

export async function handler(event: APIGatewayProxyEventV2 | InternalEvent): Promise<APIGatewayProxyResultV2 | { result?: unknown; error?: string }> {
  if (isInternalEvent(event)) {
    try {
      return { result: await relayPersistence(event.operation, event.args) };
    } catch (error) {
      console.error("persistence relay failed", error);
      return { error: "Authoritative persistence is temporarily unavailable." };
    }
  }

  try {
    const route = event.routeKey;
    if (route === "GET /health") {
      const fleetId = process.env.FLEET_ID ?? "";
      return response(200, { ok: true, fleetConfigured: fleetId.startsWith("fleet-") });
    }
    const payload = parseBody(event.body);
    const identity = await authenticate(payload.token);
    if (route === "POST /rooms") return response(201, await createRoom(identity));
    if (route === "POST /rooms/{roomCode}/join") {
      return response(200, await joinRoom(normalizeRoomCode(event.pathParameters?.roomCode), identity));
    }
    return response(404, { error: "Route not found." });
  } catch (error) {
    const status = error instanceof MatchmakerError ? error.status : 500;
    if (status >= 500) console.error("matchmaker request failed", error);
    return response(status, {
      error: error instanceof MatchmakerError ? error.message : "Matchmaking is temporarily unavailable.",
      retryable: error instanceof MatchmakerError && error.retryable,
    });
  }
}

function isInternalEvent(event: APIGatewayProxyEventV2 | InternalEvent): event is InternalEvent {
  return "source" in event && event.source === "dotbot-game-server";
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
      })).catch((cleanupError) => console.error("failed to terminate orphaned game session", cleanupError));
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
  const responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/auth/hello`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(3000),
  });
  if (!responseValue.ok) throw new MatchmakerError(401, "Player authentication failed.");
  const identity = await responseValue.json() as Partial<Identity>;
  if (!identity.playerId || !identity.name) throw new MatchmakerError(401, "Player authentication failed.");
  return { playerId: identity.playerId, name: identity.name };
}

async function relayPersistence(operation: string, args: unknown): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(operation)) throw new Error("Invalid relay operation.");
  const body = JSON.stringify({ operation, args });
  const timestamp = Date.now().toString();
  const requestId = randomUUID();
  const signature = createHmac("sha256", await relaySecret()).update(`${timestamp}.${requestId}.${body}`).digest("hex");
  const responseValue = await fetch(`${requiredEnv("CONTROL_PLANE_URL").replace(/\/$/, "")}/api/internal/game-persistence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dotbot-timestamp": timestamp,
      "x-dotbot-request-id": requestId,
      "x-dotbot-signature": signature,
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

class MatchmakerError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

type ConnectionAllocation = {
  roomCode: string;
  playerSessionId: string;
  websocketUrl: string;
  expiresAt?: string;
};
