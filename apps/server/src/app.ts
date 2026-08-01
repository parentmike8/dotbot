import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { itemFromCode, PUBLIC_EXTRACTION_ROLE_COUNT, type ClientMessage, type ServerMessage, type WireItemCode } from "@dotbot/protocol";
import { isBaseObjectKind, isBaseShellId, validateBaseLayout } from "@dotbot/game/content/base";
import { recipeById } from "@dotbot/game/content/recipes";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { BaseLayout, Item, LoadoutPreset, WireLoadoutCode } from "@dotbot/game/types";
import { isBaseTutorialComplete } from "@dotbot/game/baseTutorial";
import { createPersistence, PartyConflictError, PersistenceConflictError, type AccountSummary, type PartySummary, type Persistence, type PublicPlayer, type VerifiedExternalIdentity } from "./db";
import { canonicalTrustedPartyRoster, parseTrustedPartyRoster, type TrustedPartyRoster } from "@dotbot/protocol";
import { createFirebaseIdentityVerifier, type FirebaseIdentityVerifier } from "./identity/FirebaseIdentityVerifier";
import { formatPublicPlayerId, normalizePublicPlayerId } from "./identity/publicPlayerId";
import { MemoryIdentityRateLimiter, type IdentityRateLimitAction, type IdentityRateLimiter } from "./identity/IdentityRateLimiter";
import { BaseTutorialAuthority } from "./BaseTutorialAuthority";
import { RoomManager, type PreparedPublicPartyMember, type RoomManagerOptions } from "./RoomManager";
import { GameLiftSessionGate, isPlayerSessionClaimMismatch, requiresPlayerSessionRemoval, type InspectedPublicPlayerSession } from "./GameLiftSessionGate";
import type { ArenaDirectory } from "./ArenaDirectory";
import { isAggregateMatchSummary } from "./matchSummary";

export type CreateServerOptions = RoomManagerOptions & {
  databaseUrl?: string | null;
  persistence?: Persistence;
  gameLift?: GameLiftSessionGate;
  playerSessionReconnectMs?: number;
  /** Retry cadence after the immediate bounded GameLift removal attempts have
   * all failed. Primarily configurable for deterministic lifecycle tests. */
  playerSessionRemovalRecoveryMs?: number;
  /** Explicit additive launch-spine seam. False preserves emergency rollback. */
  publicQuickPlay?: boolean;
  /** Durable roster control-plane APIs. False preserves legacy invite state. */
  durableParties?: boolean;
  /** Signed whole-roster allocator contract. Requires durable parties. */
  atomicPartyAllocation?: boolean;
  arenaDirectory?: ArenaDirectory;
  firebaseIdentityVerifier?: FirebaseIdentityVerifier | null;
  identityRateLimiter?: IdentityRateLimiter;
};

export async function createServer(options: CreateServerOptions = {}) {
  const tls = loadTlsOptions();
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    ...(tls ? { https: tls } : {}),
  });
  app.setErrorHandler((error, request, reply) => {
    const candidateStatus = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 500;
    const statusCode = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    if (statusCode === 500) {
      request.log.error({ errorName: safeErrorName(error) }, "unhandled request failure");
      const storageRoute = /^\/api\/(?:auth|account|social)(?:\/|$)/.test(request.url);
      return reply.code(storageRoute ? 503 : 500).send({
        error: storageRoute ? "Authoritative storage is temporarily unavailable." : "The request could not be completed safely.",
      });
    }
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Invalid request." });
  });
  const persistence = options.persistence ?? await createPersistence(options.databaseUrl);
  const firebaseIdentityVerifier = options.firebaseIdentityVerifier === undefined
    ? createFirebaseIdentityVerifier()
    : options.firebaseIdentityVerifier;
  const identityRateLimiter = options.identityRateLimiter ?? new MemoryIdentityRateLimiter();
  const baseTutorialAuthority = new BaseTutorialAuthority(persistence);
  const gameLift = options.gameLift;
  const playerSessionReconnectMs = options.playerSessionReconnectMs ?? 20_000;
  const playerSessionRemovalRecoveryMs = options.playerSessionRemovalRecoveryMs ?? 5_000;
  const publicQuickPlay = options.publicQuickPlay ?? false;
  const durableParties = options.durableParties ?? false;
  const atomicPartyAllocation = publicQuickPlay && durableParties && (options.atomicPartyAllocation ?? false);
  const activePlayerSessions = new Map<string, {
    playerId: string;
    publicAdmission?: import("./GameLiftSessionGate").PublicPlayerAdmission;
    peerId: string | null;
    removalTimer: ReturnType<typeof setTimeout> | null;
    removing: boolean;
  }>();
  const pendingPlayerSessions = new Set<string>();
  const failedPlayerSessionRemovals = new Set<string>();
  const publicPeerSockets = new Map<string, WebSocket>();
  type PendingAtomicPartyMember = {
    inspected: InspectedPublicPlayerSession;
    prepared: PreparedPublicPartyMember;
    resolve: (admitted: boolean) => void;
  };
  type PendingAtomicParty = {
    claimId: string;
    members: Map<string, PendingAtomicPartyMember>;
    expectedPlayerIds: string[];
    timer: ReturnType<typeof setTimeout>;
    committing: boolean;
    settled: boolean;
  };
  const pendingAtomicParties = new Map<string, PendingAtomicParty>();
  const pendingAtomicPartyByPeer = new Map<string, string>();
  const pendingAtomicPeers = new Set<string>();
  const partyOperationReplayClaims = new Map<string, number>();
  let releasePublicMember = (_release: import("./Room").PublicMemberRelease): void => {};
  let reconcilePublicPartyRelease = async (_claimId: string, playerSessionIds: readonly string[]) => ({
    releasedPlayerSessionIds: [] as string[],
    failedPlayerSessionIds: [...playerSessionIds],
    invalidClaim: false,
  });
  let draining = false;
  const rooms = new RoomManager({
    ...options,
    persistence,
    connectionHandoffMs: playerSessionReconnectMs,
    hotArena: publicQuickPlay ? options.hotArena ?? {} : undefined,
    onPublicAdmissionChange: publicQuickPlay && options.arenaDirectory
      ? (state: { arenaId: string; open: boolean; closesAt?: number }) => options.arenaDirectory!.publish(state)
      : undefined,
    onPublicMemberReleased: publicQuickPlay
      ? (release: import("./Room").PublicMemberRelease) => {
          releasePublicMember(release);
          return options.onPublicMemberReleased?.(release);
        }
      : undefined,
    ...(gameLift ? {
      sessionRoomCode: () => publicQuickPlay ? gameLift.arenaId() : gameLift.roomCode(),
      endedRoomTtlMs: 5_000,
      onRoomExpired: () => {
        draining = true;
        return gameLift.endProcess();
      },
    } : {}),
  });
  const requireCompletedIntroduction = async (token: string, reply: FastifyReply): Promise<boolean> => {
    if (!persistence.live) {
      reply.code(503).send({ error: "Authoritative storage is unavailable." });
      return false;
    }
    let base;
    try {
      base = await persistence.getBase(token);
    } catch {
      reply.code(503).send({ error: "Authoritative storage is unavailable." });
      return false;
    }
    if (!base) {
      reply.code(404).send({ error: "Unknown device token." });
      return false;
    }
    if (!isBaseTutorialComplete(base.tutorial)) {
      reply.code(409).send({ error: "Complete the base introduction first." });
      return false;
    }
    return true;
  };

  app.get("/api/health", async (_request, reply) => {
    if (draining || failedPlayerSessionRemovals.size > 0) {
      return reply.code(503).send({
        draining,
        reservationRemovalDegraded: failedPlayerSessionRemovals.size > 0,
        rooms: rooms.rooms,
      });
    }
    return { draining: false, rooms: rooms.rooms, tickP99Ms: rooms.tickP99Ms, roomHealth: rooms.roomHealth };
  });

  app.get("/api/game-config", async () => ({
    matchmakerUrl: process.env.DOTBOT_MATCHMAKER_URL ?? null,
  }));

  app.post("/api/gamelift/drain", async (request, reply) => {
    if (!isLoopback(request.ip)) return reply.code(404).send({ error: "Not found." });
    draining = true;
    rooms.requestRetirement();
    return reply.code(204).send();
  });

  app.get("/api/gamelift/drain-status", async (request, reply) => {
    if (!isLoopback(request.ip)) return reply.code(404).send({ error: "Not found." });
    return { safe: rooms.safeToTerminate };
  });

  app.post<{ Headers: { "x-dotbot-timestamp"?: string; "x-dotbot-request-id"?: string; "x-dotbot-signature"?: string }; Body: { partyRoster?: unknown } }>("/api/internal/public-party-preflight", async (request, reply) => {
    if (!publicQuickPlay || !atomicPartyAllocation || !gameLift) return reply.code(404).send({ error: "Not found." });
    if (!allowIdentityRequest(identityRateLimiter, "arena_internal", request.ip, reply)) return;
    const body = JSON.stringify(request.body);
    const requestId = request.headers["x-dotbot-request-id"];
    const session = await gameLift.verifyPartyOperation(
      "party-preflight",
      request.headers["x-dotbot-timestamp"],
      requestId,
      request.headers["x-dotbot-signature"],
      body,
    );
    if (!session || !requestId) return reply.code(401).send({ error: "Invalid party preflight signature." });
    if (!claimPartyOperationReplay(partyOperationReplayClaims, requestId)) {
      return reply.code(409).send({ error: "Party preflight request was already processed." });
    }
    const roster = parseTrustedPartyRoster(request.body?.partyRoster);
    if (!roster || roster.expiresAt <= Date.now() || roster.buildId !== session.buildId || roster.region !== session.region) {
      return reply.code(400).send({ accepted: false, code: "party_invalid", retryable: false });
    }
    return rooms.preflightPublicParty(session.arenaId, roster.members.map((member) => ({
      playerId: member.playerId,
      name: member.name,
      partyId: roster.partyId,
    })));
  });

  app.post<{ Headers: { "x-dotbot-timestamp"?: string; "x-dotbot-request-id"?: string; "x-dotbot-signature"?: string }; Body: {
    arenaId?: unknown;
    claimId?: unknown;
    playerSessionIds?: unknown;
  } }>("/api/internal/public-party-release", async (request, reply) => {
    if (!publicQuickPlay || !atomicPartyAllocation || !gameLift) return reply.code(404).send({ error: "Not found." });
    if (!allowIdentityRequest(identityRateLimiter, "arena_internal", request.ip, reply)) return;
    const body = JSON.stringify(request.body);
    const requestId = request.headers["x-dotbot-request-id"];
    const session = await gameLift.verifyPartyOperation(
      "party-release",
      request.headers["x-dotbot-timestamp"],
      requestId,
      request.headers["x-dotbot-signature"],
      body,
    );
    if (!session || !requestId) return reply.code(401).send({ error: "Invalid party release signature." });
    if (!claimPartyOperationReplay(partyOperationReplayClaims, requestId)) {
      return reply.code(409).send({ error: "Party release request was already processed." });
    }
    const arenaId = typeof request.body?.arenaId === "string" ? request.body.arenaId.trim().toUpperCase() : "";
    const claimId = typeof request.body?.claimId === "string" ? request.body.claimId : "";
    const playerSessionIds = Array.isArray(request.body?.playerSessionIds)
      ? request.body.playerSessionIds.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048)
      : [];
    if (arenaId !== session.arenaId || !isUuid(claimId)
      || playerSessionIds.length < 1 || playerSessionIds.length > 3
      || new Set(playerSessionIds).size !== playerSessionIds.length) {
      return reply.code(400).send({ error: "Invalid party reservation release." });
    }
    const result = await reconcilePublicPartyRelease(claimId, playerSessionIds);
    if (result.invalidClaim) return reply.code(400).send({ error: "Party reservation release does not match the signed claim." });
    return reply.code(result.failedPlayerSessionIds.length > 0 ? 503 : 200).send({
      releasedPlayerSessionIds: result.releasedPlayerSessionIds,
      failedPlayerSessionIds: result.failedPlayerSessionIds,
      retryable: result.failedPlayerSessionIds.length > 0,
    });
  });

  const relaySecret = process.env.DOTBOT_RELAY_SECRET;
  if (relaySecret) {
    app.post<{ Headers: { "x-dotbot-timestamp"?: string; "x-dotbot-request-id"?: string; "x-dotbot-signature"?: string }; Body: {
      token?: unknown;
      partyAllocationVersion?: unknown;
      operation?: unknown;
      queueRequestId?: unknown;
      claimId?: unknown;
      buildId?: unknown;
      region?: unknown;
    } }>("/api/internal/matchmaker-auth", async (request, reply) => {
      const body = JSON.stringify(request.body);
      const requestId = request.headers["x-dotbot-request-id"];
      if (!validRelaySignature(relaySecret, "matchmaker-auth", request.headers["x-dotbot-timestamp"], requestId, request.headers["x-dotbot-signature"], body)) {
        return reply.code(401).send({ error: "Invalid matchmaker signature." });
      }
      const token = typeof request.body?.token === "string" ? request.body.token : "";
      if (token.length < 16 || token.length > 512) return reply.code(400).send({ error: "Invalid player token." });
      try {
        const claimed = await persistence.claimRelayRequest(requestId!, new Date(Date.now() + 5 * 60_000));
        if (!claimed) return reply.code(409).send({ error: "Matchmaker authentication request was already processed." });
        if (request.body.partyAllocationVersion === "party-v1") {
          if (!atomicPartyAllocation) return reply.code(404).send({ error: "Atomic party allocation is not enabled." });
          const operation = request.body.operation;
          const queueRequestId = typeof request.body.queueRequestId === "string" ? request.body.queueRequestId : "";
          const claimId = typeof request.body.claimId === "string" ? request.body.claimId : "";
          const buildId = typeof request.body.buildId === "string" ? request.body.buildId.trim() : "";
          const region = typeof request.body.region === "string" ? request.body.region.trim() : "";
          if (operation === "cancel-complete") {
            const completed = await persistence.completePartyQueueCancellation(token, claimId);
            if (!completed) return reply.code(409).send({ error: "Party queue cancellation could not be completed." });
            return { cancelledClaimId: claimId, completed: true };
          }
          if (operation === "cancel") {
            const claim = await persistence.cancelPartyQueue(token, claimId);
            if (!claim) return reply.code(409).send({ error: "Party queue claim is no longer active." });
            return {
              cancelledClaimId: claim.claimId,
              playerId: claim.requestingPlayerId,
              cancelSignature: createHmac("sha256", relaySecret)
                .update(`party-cancel.${requestId}.${claim.claimId}.${claim.requestingPlayerId}`)
                .digest("hex"),
            };
          }
          const claim = operation === "allocate"
            ? await persistence.claimPartyQueue(token, { requestId: queueRequestId, buildId, region })
            : null;
          if (!claim) return reply.code(409).send({ error: "Party queue claim is no longer active." });
          const issuedAt = Date.now();
          const roster: TrustedPartyRoster = { ...claim, issuedAt, expiresAt: issuedAt + 30_000 };
          const canonicalRoster = canonicalTrustedPartyRoster(roster);
          return {
            partyRoster: roster,
            rosterSignature: createHmac("sha256", relaySecret)
              .update(`party-roster.${requestId}.${canonicalRoster}`)
              .digest("hex"),
          };
        }
        const identity = await persistence.helloPlayer(token);
        if (!identity) return reply.code(401).send({ error: "Player authentication failed." });
        // This UUID is confined to the signed control-plane/AWS reservation
        // boundary so mixed GameLift revisions retain their established key.
        return { playerId: identity.playerId, name: identity.name };
      } catch (error) {
        if (error instanceof PartyConflictError) return sendPartyError(reply, error);
        request.log.warn({ errorName: safeErrorName(error) }, "matchmaker authentication failed");
        return reply.code(503).send({ error: "Authoritative persistence is temporarily unavailable." });
      }
    });

    app.post<{ Headers: { "x-dotbot-timestamp"?: string; "x-dotbot-request-id"?: string; "x-dotbot-signature"?: string }; Body: unknown }>("/api/internal/game-persistence", async (request, reply) => {
      const body = JSON.stringify(request.body);
      const requestId = request.headers["x-dotbot-request-id"];
      if (!validRelaySignature(relaySecret, "game-persistence", request.headers["x-dotbot-timestamp"], requestId, request.headers["x-dotbot-signature"], body)) {
        return reply.code(401).send({ error: "Invalid persistence relay signature." });
      }
      try {
        const claimed = await persistence.claimRelayRequest(requestId!, new Date(Date.now() + 5 * 60_000));
        if (!claimed) return reply.code(409).send({ error: "Persistence relay request was already processed." });
        return { result: await dispatchPersistenceRelay(persistence, request.body) };
      } catch (error) {
        request.log.warn({ errorName: safeErrorName(error) }, "persistence relay operation failed");
        return reply.code(error instanceof RelayPayloadError ? 400 : 503).send({
          error: error instanceof RelayPayloadError ? error.message : "Authoritative persistence is temporarily unavailable.",
        });
      }
    });
  }

  app.post<{ Body: { name?: unknown } }>("/api/auth/register", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "register", request.ip, reply)) return;
    const name = sanitizeName(request.body?.name);
    if (!name) return reply.code(400).send({ error: "A display name is required." });
    const account = await persistence.registerPlayer(name);
    const publicPlayerId = formatPublicPlayerId(account.publicPlayerId);
    return { playerId: publicPlayerId, publicPlayerId, displayName: account.name, linked: false, token: account.token };
  });

  app.post<{ Body: { token?: unknown } }>("/api/auth/hello", async (request, reply) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    if (!token) return reply.code(400).send({ error: "A device token is required." });
    const account = await persistence.getAccount(token);
    if (!account) return reply.code(404).send({ error: "Unknown device token." });
    const publicPlayerId = formatPublicPlayerId(account.publicPlayerId);
    return {
      playerId: publicPlayerId,
      publicPlayerId,
      name: account.displayName,
      displayName: account.displayName,
      linked: account.linked,
      providers: account.providers,
    };
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/auth/link", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "verify", request.ip, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const verified = await verifyFirebaseBearer(firebaseIdentityVerifier, request.headers.authorization, reply);
    if (!verified) return;
    try {
      const result = await persistence.linkAccount(token, verified);
      return {
        account: publicAccount(result.account),
        merged: result.merged,
        replayed: result.replayed,
      };
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return reply.code(409).send({ error: "Account linking could not be completed safely." });
      }
      request.log.warn({ errorName: safeErrorName(error) }, "account linking persistence failure");
      return reply.code(503).send({ error: "Authoritative storage is temporarily unavailable." });
    }
  });

  app.post<{ Headers: { authorization?: string } }>("/api/auth/session", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "verify", request.ip, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const verified = await verifyFirebaseBearer(firebaseIdentityVerifier, request.headers.authorization, reply);
    if (!verified) return;
    const session = await persistence.createLinkedSession(verified);
    if (!session) return reply.code(404).send({ error: "No linked DotBot account exists for this identity." });
    const publicPlayerId = formatPublicPlayerId(session.publicPlayerId);
    return { token: session.token, playerId: publicPlayerId, publicPlayerId, displayName: session.name, linked: true };
  });

  app.get<{ Headers: { "x-device-token"?: string } }>("/api/account", async (request, reply) => {
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const account = await persistence.getAccount(token);
    if (!account) return reply.code(404).send({ error: "Unknown device token." });
    return publicAccount(account);
  });

  app.patch<{ Headers: { "x-device-token"?: string }; Body: { displayName?: unknown } }>("/api/account/profile", async (request, reply) => {
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const token = request.headers["x-device-token"];
    const displayName = sanitizeName(request.body?.displayName);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!displayName) return reply.code(400).send({ error: "A display name is required." });
    const account = await persistence.updateDisplayName(token, displayName);
    if (!account) return reply.code(404).send({ error: "Unknown device token." });
    return publicAccount(account);
  });

  app.patch<{ Headers: { "x-device-token"?: string }; Body: { discoverableByPublicId?: unknown } }>("/api/account/privacy", async (request, reply) => {
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (typeof request.body?.discoverableByPublicId !== "boolean") {
      return reply.code(400).send({ error: "discoverableByPublicId must be boolean." });
    }
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const account = await persistence.updatePrivacy(token, request.body.discoverableByPublicId);
    if (!account) return reply.code(403).send({ error: "Link an account to manage social privacy." });
    return publicAccount(account);
  });

  app.delete<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/account", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "verify", request.ip, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const verified = await verifyFirebaseBearer(firebaseIdentityVerifier, request.headers.authorization, reply);
    if (!verified) return;
    if (!Number.isFinite(verified.authenticatedAt) || Date.now() - verified.authenticatedAt > 5 * 60_000 || verified.authenticatedAt > Date.now() + 60_000) {
      return reply.code(401).send({ error: "Reauthenticate with Firebase before deleting this account." });
    }
    try {
      const deleted = await persistence.deleteLinkedAccount(token, verified);
      if (!deleted) return reply.code(404).send({ error: "Unknown device token." });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return reply.code(409).send({ error: "Verified account deletion could not be completed safely." });
      }
      request.log.warn({ errorName: safeErrorName(error) }, "account deletion persistence failure");
      return reply.code(503).send({ error: "Authoritative storage is temporarily unavailable." });
    }
  });

  app.get<{ Headers: { "x-device-token"?: string }; Params: { publicPlayerId: string } }>("/api/social/players/:publicPlayerId", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "social_lookup", request.ip, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!normalizePublicPlayerId(request.params.publicPlayerId)) return reply.code(400).send({ error: "Invalid public player ID." });
    const player = await persistence.findPublicPlayer(token, request.params.publicPlayerId);
    if (!player) return reply.code(404).send({ error: "Player not found." });
    return publicPlayer(player);
  });

  app.get<{ Headers: { "x-device-token"?: string } }>("/api/social/friends", async (request, reply) => {
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const friends = await persistence.listFriends(token);
    if (!friends) return reply.code(403).send({ error: "Link an account to use durable friends." });
    return { friends: friends.map((friend) => ({ ...publicPlayer(friend), status: friend.status })) };
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { publicPlayerId?: unknown } }>("/api/social/friend-requests", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const publicPlayerId = typeof request.body?.publicPlayerId === "string" ? request.body.publicPlayerId : "";
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!normalizePublicPlayerId(publicPlayerId)) return reply.code(400).send({ error: "Invalid public player ID." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const friend = await persistence.requestFriend(token, publicPlayerId);
    if (!friend) return reply.code(404).send({ error: "Player not found or account linking is required." });
    return { ...publicPlayer(friend), status: friend.status };
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { publicPlayerId?: unknown } }>("/api/social/friend-requests/accept", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const publicPlayerId = typeof request.body?.publicPlayerId === "string" ? request.body.publicPlayerId : "";
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!normalizePublicPlayerId(publicPlayerId)) return reply.code(400).send({ error: "Invalid public player ID." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const friend = await persistence.acceptFriend(token, publicPlayerId);
    if (!friend) return reply.code(404).send({ error: "Pending request not found." });
    return { ...publicPlayer(friend), status: friend.status };
  });

  app.post<{ Headers: { "x-device-token"?: string } }>("/api/social/party-invites", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    try {
      if (durableParties) {
        const invite = await persistence.createDurablePartyInvite(token);
        if (!invite) return reply.code(403).send({ error: "Link an account to create durable party invitations." });
        return reply.code(201).send({ ...invite, party: publicParty(invite.party) });
      }
      const invite = await persistence.createPartyInvite(token);
      if (!invite) return reply.code(403).send({ error: "Link an account to create durable party invitations." });
      return reply.code(201).send(invite);
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { code?: unknown } }>("/api/social/party-invites/accept", async (request, reply) => {
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    // Invite codes are bearer credentials. Keep them in the request body so
    // access logs and reverse-proxy URL logs never capture the raw value.
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(code)) return reply.code(400).send({ error: "Invalid party invitation code." });
    try {
      const accepted = durableParties
        ? await persistence.acceptDurablePartyInvite(token, code)
        : await persistence.acceptPartyInvite(token, code);
      if (!accepted) return reply.code(404).send({ error: "Party invitation is invalid or expired." });
      return {
        inviter: publicPlayer(accepted.inviter),
        durable: accepted.durable,
        expiresAt: accepted.expiresAt,
        ...(accepted.party ? { party: publicParty(accepted.party) } : {}),
        ...(accepted.replayed === undefined ? {} : { replayed: accepted.replayed }),
      };
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.get<{ Headers: { "x-device-token"?: string } }>("/api/social/party", async (request, reply) => {
    if (!durableParties) return reply.code(404).send({ error: "Route not found." });
    if (!allowIdentityRequest(identityRateLimiter, "social_lookup", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    const party = await persistence.getParty(token);
    return { party: party ? publicParty(party) : null };
  });

  app.delete<{ Headers: { "x-device-token"?: string } }>("/api/social/party-invites", async (request, reply) => {
    if (!durableParties) return reply.code(404).send({ error: "Route not found." });
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    try {
      const party = await persistence.revokeDurablePartyInvites(token);
      if (!party) return reply.code(404).send({ error: "Party not found." });
      return { party: publicParty(party) };
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { version?: unknown } }>("/api/social/party/leave", async (request, reply) => {
    if (!durableParties) return reply.code(404).send({ error: "Route not found." });
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const version = parsePartyVersion(request.body?.version);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (version === null) return reply.code(400).send({ error: "Party version must be a positive integer." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    try {
      await persistence.leaveParty(token, version);
      return { party: null };
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { version?: unknown } }>("/api/social/party/disband", async (request, reply) => {
    if (!durableParties) return reply.code(404).send({ error: "Route not found." });
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const version = parsePartyVersion(request.body?.version);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (version === null) return reply.code(400).send({ error: "Party version must be a positive integer." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    try {
      const disbanded = await persistence.disbandParty(token, version);
      if (!disbanded) return reply.code(404).send({ error: "Party not found." });
      return { party: null };
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.post<{ Headers: { "x-device-token"?: string }; Body: { version?: unknown; publicPlayerId?: unknown } }>("/api/social/party/leader", async (request, reply) => {
    if (!durableParties) return reply.code(404).send({ error: "Route not found." });
    if (!allowIdentityRequest(identityRateLimiter, "social_write", request.ip, reply)) return;
    const token = request.headers["x-device-token"];
    const version = parsePartyVersion(request.body?.version);
    const publicPlayerId = typeof request.body?.publicPlayerId === "string" ? request.body.publicPlayerId : "";
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (version === null || !normalizePublicPlayerId(publicPlayerId)) return reply.code(400).send({ error: "Valid party version and public player ID are required." });
    if (!persistence.live) return reply.code(503).send({ error: "Authoritative storage is unavailable." });
    try {
      const party = await persistence.transferPartyLeader(token, publicPlayerId, version);
      if (!party) return reply.code(404).send({ error: "Party member not found." });
      return { party: publicParty(party) };
    } catch (error) {
      return sendPartyError(reply, error);
    }
  });

  app.get<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/profile", async (request, reply) => {
    const token = request.headers["x-device-token"] ?? bearerToken(request.headers.authorization);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const profile = await persistence.getProfile(token);
    if (!profile) return reply.code(404).send({ error: "Unknown device token." });
    return profile;
  });

  app.get<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/base", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const base = await persistence.getBase(token);
    if (!base) return reply.code(404).send({ error: "Unknown device token." });
    return { storageLinked: persistence.live, ...base };
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { layout?: unknown } }>("/api/base/layout", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const layout = parseBaseLayout(request.body?.layout);
    if (!layout) return reply.code(400).send({ error: "Layout contains an unknown slot, object kind, or zone mismatch." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const saved = await persistence.saveBaseLayout(token, layout);
      if (!saved) return reply.code(404).send({ error: "Unknown device token." });
      return { layout: saved };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { shell?: unknown } }>("/api/base/shell", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const shell = request.body?.shell;
    if (!isBaseShellId(shell)) return reply.code(400).send({ error: "Unknown base shell." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const base = await persistence.setBaseShell(token, shell);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { loadout?: unknown } }>("/api/base/loadout", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const loadout = parseLoadout(request.body?.loadout);
    if (!loadout) return reply.code(400).send({ error: "Loadout must contain at most four powerups; blueprint fragments are cargo." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const base = await persistence.setLoadout(token, loadout);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { recipeId?: unknown; slotId?: unknown } }>("/api/base/fabricate", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const recipeId = typeof request.body?.recipeId === "string" ? request.body.recipeId : "";
    const recipe = recipeById(recipeId);
    if (!recipe) return reply.code(400).send({ error: "Unknown fabrication recipe." });
    const slotId = request.body?.slotId;
    if (slotId !== undefined && typeof slotId !== "string") return reply.code(400).send({ error: "slotId must be a string." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const result = await persistence.fabricate(token, recipeId, slotId);
      if (!result) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...result.base, fabricated: { recipeId, output: result.output, slotId: result.slotId } };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { presets?: unknown } }>("/api/base/presets", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const presets = parsePresets(request.body?.presets);
    if (!presets) return reply.code(400).send({ error: "Presets must be at most three named four-slot powerup templates." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    const base = await persistence.savePresets(token, presets);
    if (!base) return reply.code(404).send({ error: "Unknown device token." });
    return { storageLinked: true, ...base };
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { presetIndex?: unknown } }>("/api/base/presets/apply", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const presetIndex = request.body?.presetIndex;
    if (!Number.isInteger(presetIndex) || (presetIndex as number) < 0 || (presetIndex as number) > 2) {
      return reply.code(400).send({ error: "presetIndex must identify one of the three preset slots." });
    }
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const result = await persistence.applyPreset(token, presetIndex as number);
      if (!result) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...result.base, missing: result.missing };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { insertionPointId?: unknown } }>("/api/base/insertion", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    const insertionPointId = request.body?.insertionPointId;
    if (insertionPointId !== null && (typeof insertionPointId !== "string" || !downtownMap.insertionPoints.some((point) => point.id === insertionPointId))) {
      return reply.code(400).send({ error: "Unknown insertion point." });
    }
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — NO STORAGE LINK" });
    try {
      const saved = await persistence.setInsertionPreference(token, insertionPointId as string | null);
      return { insertionPreference: saved };
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { contractId?: unknown } }>("/api/base/contracts/accept", async (request, reply) => {
    const token = authToken(request.headers);
    const contractId = request.body?.contractId;
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (typeof contractId !== "string" || !contractId) return reply.code(400).send({ error: "A contract id is required." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — CONTRACTS ARE READ-ONLY" });
    try {
      await persistence.acceptContract(token, contractId);
      const base = await persistence.getBase(token);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string } }>("/api/base/contracts/reroll", async (request, reply) => {
    const token = authToken(request.headers);
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — CONTRACTS ARE READ-ONLY" });
    try {
      await persistence.rerollContracts(token);
      const base = await persistence.getBase(token);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Headers: { "x-device-token"?: string; authorization?: string }; Body: { contractId?: unknown } }>("/api/base/contracts/abandon", async (request, reply) => {
    const token = authToken(request.headers);
    const contractId = request.body?.contractId;
    if (!token) return reply.code(400).send({ error: "A device token header is required." });
    if (typeof contractId !== "string" || !contractId) return reply.code(400).send({ error: "A contract id is required." });
    if (!await requireCompletedIntroduction(token, reply)) return;
    if (!persistence.live) return reply.code(503).send({ error: "OFFLINE — CONTRACTS ARE READ-ONLY" });
    try {
      await persistence.abandonContract(token, contractId);
      const base = await persistence.getBase(token);
      if (!base) return reply.code(404).send({ error: "Unknown device token." });
      return { storageLinked: true, ...base };
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  if (process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL("../../client/dist", import.meta.url)),
      wildcard: false,
    });
    app.get("/*", (_request, reply) => reply.sendFile("index.html"));
  }

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: { threshold: 512 },
  });

  const finishPlayerSessionRemoval = async (playerSessionId: string): Promise<void> => {
    if (!gameLift) return;
    const entry = activePlayerSessions.get(playerSessionId);
    if (!entry || entry.removing) return;
    entry.removing = true;
    if (entry.removalTimer) clearTimeout(entry.removalTimer);
    entry.removalTimer = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await gameLift.removePlayerSession(playerSessionId);
        if (activePlayerSessions.get(playerSessionId) === entry) activePlayerSessions.delete(playerSessionId);
        failedPlayerSessionRemovals.delete(playerSessionId);
        return;
      } catch (error) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
          continue;
        }
        if (activePlayerSessions.get(playerSessionId) !== entry) return;
        // Do not reopen this binding after an uncertain removal. A reconnect
        // could otherwise race a successful SDK removal or silently rejoin a
        // party that declined redeployment. Keep existing runs untouched,
        // fail only new-admission/readiness gates, and retain the binding for
        // automatic reconciliation when the loopback adapter recovers.
        failedPlayerSessionRemovals.add(playerSessionId);
        entry.removalTimer = setTimeout(() => {
          if (activePlayerSessions.get(playerSessionId) !== entry) return;
          entry.removalTimer = null;
          entry.removing = false;
          void finishPlayerSessionRemoval(playerSessionId);
        }, playerSessionRemovalRecoveryMs);
        app.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "failed to remove GameLift player session after retries; admission paused pending reconciliation");
      }
    }
  };
  const removePlayerSession = async (playerSessionId: string, peerId: string, immediate: boolean): Promise<void> => {
    const entry = activePlayerSessions.get(playerSessionId);
    if (!entry || entry.peerId !== peerId || entry.removing) return;
    entry.peerId = null;
    if (entry.removalTimer) clearTimeout(entry.removalTimer);
    if (immediate) await finishPlayerSessionRemoval(playerSessionId);
    else entry.removalTimer = setTimeout(() => {
      const current = activePlayerSessions.get(playerSessionId);
      if (current === entry && current.peerId === null) void finishPlayerSessionRemoval(playerSessionId);
    }, playerSessionReconnectMs);
  };
  releasePublicMember = ({ peerId, reservationPlayerId }: import("./Room").PublicMemberRelease) => {
    for (const [playerSessionId, entry] of activePlayerSessions) {
      const exactReservation = reservationPlayerId !== null && entry.publicAdmission?.playerId === reservationPlayerId;
      if (!exactReservation && (peerId === null || entry.peerId !== peerId)) continue;
      const connectedPeerId = entry.peerId;
      entry.peerId = null;
      void finishPlayerSessionRemoval(playerSessionId);
      if (connectedPeerId) publicPeerSockets.get(connectedPeerId)?.close(1000, "Re-enter quick play");
    }
    if (peerId) publicPeerSockets.get(peerId)?.close(1000, "Re-enter quick play");
  };

  const retainReservationForRemoval = (inspected: InspectedPublicPlayerSession): void => {
    if (activePlayerSessions.has(inspected.playerSessionId)) return;
    activePlayerSessions.set(inspected.playerSessionId, {
      playerId: inspected.admission.playerId,
      publicAdmission: inspected.admission,
      peerId: null,
      removalTimer: null,
      removing: false,
    });
  };
  const releaseUninspectedReservation = async (playerSessionId: string): Promise<void> => {
    if (!activePlayerSessions.has(playerSessionId)) {
      activePlayerSessions.set(playerSessionId, {
        playerId: "",
        peerId: null,
        removalTimer: null,
        removing: false,
      });
    }
    await finishPlayerSessionRemoval(playerSessionId);
  };
  const settlePendingAtomicParty = (batch: PendingAtomicParty, admitted: boolean): void => {
    if (!batch.settled) batch.settled = true;
    clearTimeout(batch.timer);
    if (pendingAtomicParties.get(batch.claimId) === batch) pendingAtomicParties.delete(batch.claimId);
    for (const member of batch.members.values()) {
      pendingAtomicPartyByPeer.delete(member.prepared.peer.id);
      pendingAtomicPeers.delete(member.prepared.peer.id);
      pendingPlayerSessions.delete(member.inspected.playerSessionId);
      member.resolve(admitted);
    }
  };
  const releasePendingAtomicParty = async (
    batch: PendingAtomicParty,
    code: string,
    message: string,
    notify = true,
    extraInspected: readonly InspectedPublicPlayerSession[] = [],
  ): Promise<void> => {
    if (batch.settled) {
      await Promise.all(extraInspected.map(async (entry) => {
        pendingPlayerSessions.delete(entry.playerSessionId);
        retainReservationForRemoval(entry);
        await finishPlayerSessionRemoval(entry.playerSessionId);
      }));
      return;
    }
    batch.settled = true;
    clearTimeout(batch.timer);
    if (pendingAtomicParties.get(batch.claimId) === batch) pendingAtomicParties.delete(batch.claimId);
    const known = [...batch.members.values()].map((member) => member.inspected).concat(extraInspected);
    if (notify) {
      for (const member of batch.members.values()) {
        member.prepared.peer.send({ type: "err", code, msg: message, retryable: true });
      }
    }
    for (const member of batch.members.values()) {
      pendingAtomicPartyByPeer.delete(member.prepared.peer.id);
      pendingAtomicPeers.delete(member.prepared.peer.id);
      pendingPlayerSessions.delete(member.inspected.playerSessionId);
    }
    for (const entry of extraInspected) pendingPlayerSessions.delete(entry.playerSessionId);
    await Promise.all(known.map(async (entry) => {
      retainReservationForRemoval(entry);
      await finishPlayerSessionRemoval(entry.playerSessionId);
    }));
    for (const member of batch.members.values()) member.resolve(false);
  };
  const commitPendingAtomicParty = async (batch: PendingAtomicParty): Promise<void> => {
    if (batch.settled || batch.committing || batch.members.size !== batch.expectedPlayerIds.length || !gameLift) return;
    batch.committing = true;
    const members = [...batch.members.values()].sort((left, right) => left.inspected.admission.playerId.localeCompare(right.inspected.admission.playerId));
    try {
      if (members.some((member) => !member.prepared.isPeerActive() || member.prepared.peer.isOpen?.() === false)) {
        throw new Error("A party member disconnected before atomic admission.");
      }
      await gameLift.acceptPublicPartySessions(members.map((member) => member.inspected));
      if (batch.settled) return;
      for (const member of members) {
        activePlayerSessions.set(member.inspected.playerSessionId, {
          playerId: member.inspected.admission.playerId,
          publicAdmission: member.inspected.admission,
          peerId: member.prepared.peer.id,
          removalTimer: null,
          removing: false,
        });
      }
      if (members.some((member) => !member.prepared.isPeerActive() || member.prepared.peer.isOpen?.() === false)) {
        throw new Error("A party member disconnected during atomic admission.");
      }
      const joined = await rooms.commitPublicParty(
        members.map((member) => member.prepared),
        () => !batch.settled,
      );
      if (batch.settled) return;
      if (!joined) {
        await releasePendingAtomicParty(
          batch,
          "party_invalid",
          "The intact party could not be admitted. Retry quick play together.",
          false,
        );
        return;
      }
      settlePendingAtomicParty(batch, true);
    } catch {
      // If an unexpected synchronous Room delivery failure happened after its
      // all-member map mutation, remove the whole reservation roster before
      // reconciling GameLift. The normal prevalidation path finds no members.
      rooms.releasePublicReservations(new Set(members.map((member) => member.inspected.admission.playerId)));
      await releasePendingAtomicParty(
        batch,
        "player_session_rejected",
        "GameLift could not admit the complete party. Retry quick play together.",
      );
    }
  };
  const stageAtomicPartyMember = async (
    peer: import("./Room").RoomPeer,
    message: Extract<ClientMessage, { type: "quickPlayHello" }>,
    playerSessionId: string,
    isPeerActive: () => boolean,
  ): Promise<boolean> => {
    if (!gameLift || pendingPlayerSessions.has(playerSessionId) || pendingAtomicPeers.has(peer.id)) {
      peer.send({ type: "err", code: "player_session_in_use", msg: "This player session is already connecting." });
      return false;
    }
    pendingAtomicPeers.add(peer.id);
    pendingPlayerSessions.add(playerSessionId);
    let inspected: InspectedPublicPlayerSession;
    try {
      inspected = await gameLift.inspectPublicPlayerSession(playerSessionId);
    } catch (error) {
      if (requiresPlayerSessionRemoval(error)) await releaseUninspectedReservation(playerSessionId);
      pendingPlayerSessions.delete(playerSessionId);
      pendingAtomicPeers.delete(peer.id);
      peer.send({ type: "err", code: "player_session_rejected", msg: "GameLift rejected this player session." });
      return false;
    }
    let prepared: PreparedPublicPartyMember | null;
    try {
      prepared = await rooms.preparePublicPartyMember(peer, message, inspected.admission, isPeerActive);
    } catch {
      retainReservationForRemoval(inspected);
      await finishPlayerSessionRemoval(playerSessionId);
      pendingPlayerSessions.delete(playerSessionId);
      pendingAtomicPeers.delete(peer.id);
      peer.send({ type: "err", code: "arena_unavailable", msg: "The arena could not verify this reservation. Retry quick play together.", retryable: true });
      return false;
    }
    if (!prepared || inspected.admission.partyReservationExpiresAt <= Date.now()) {
      const existing = pendingAtomicParties.get(inspected.admission.partyClaimId);
      if (existing) {
        await releasePendingAtomicParty(
          existing,
          "party_invalid",
          "The intact party could not be verified. Retry quick play together.",
          true,
          [inspected],
        );
      } else {
        retainReservationForRemoval(inspected);
        await finishPlayerSessionRemoval(playerSessionId);
        pendingPlayerSessions.delete(playerSessionId);
      }
      pendingAtomicPeers.delete(peer.id);
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const claimId = inspected.admission.partyClaimId;
      let batch = pendingAtomicParties.get(claimId);
      if (!batch) {
        const expectedPlayerIds = inspected.admission.partyMemberPlayerIds;
        const waitMs = Math.max(1, Math.min(120_000, inspected.admission.partyReservationExpiresAt - Date.now()));
        let created!: PendingAtomicParty;
        const timer = setTimeout(() => {
          void releasePendingAtomicParty(
            created,
            "party_incomplete",
            "The complete party did not connect before its reservation expired. Retry quick play together.",
          );
        }, waitMs);
        created = {
          claimId,
          members: new Map(),
          expectedPlayerIds,
          timer,
          committing: false,
          settled: false,
        };
        batch = created;
        pendingAtomicParties.set(claimId, batch);
      }
      const first = batch.members.values().next().value as PendingAtomicPartyMember | undefined;
      const sameRoster = batch.expectedPlayerIds.join(".") === inspected.admission.partyMemberPlayerIds.join(".")
        && (!first || first.inspected.admission.partyId === inspected.admission.partyId
          && first.inspected.admission.partyVersion === inspected.admission.partyVersion
          && first.inspected.admission.arenaId === inspected.admission.arenaId
          && first.inspected.admission.buildId === inspected.admission.buildId
          && first.inspected.admission.region === inspected.admission.region
          && first.inspected.admission.partyReservationExpiresAt === inspected.admission.partyReservationExpiresAt);
      if (!sameRoster || batch.members.has(inspected.admission.playerId)) {
        void releasePendingAtomicParty(
          batch,
          "party_invalid",
          "The signed party roster changed or contained a duplicate. Retry quick play together.",
          true,
          [inspected],
        ).then(() => resolve(false));
        pendingAtomicPeers.delete(peer.id);
        return;
      }
      batch.members.set(inspected.admission.playerId, { inspected, prepared, resolve });
      pendingAtomicPartyByPeer.set(peer.id, claimId);
      if (batch.members.size === batch.expectedPlayerIds.length) void commitPendingAtomicParty(batch);
    });
  };
  const cancelPendingAtomicPeer = async (peerId: string): Promise<void> => {
    const claimId = pendingAtomicPartyByPeer.get(peerId);
    const batch = claimId ? pendingAtomicParties.get(claimId) : undefined;
    if (!batch) return;
    await releasePendingAtomicParty(
      batch,
      "party_incomplete",
      "A party member disconnected before the complete party was admitted. Retry quick play together.",
    );
  };
  reconcilePublicPartyRelease = async (claimId, playerSessionIds) => {
    let ownedPlayerSessionIds: string[];
    let absentPlayerSessionIds: string[];
    try {
      const ownership = await Promise.all(playerSessionIds.map(async (playerSessionId) => ({
        playerSessionId,
        owned: await gameLift!.verifyPublicPartySessionForRelease(playerSessionId, claimId),
      })));
      ownedPlayerSessionIds = ownership.filter((entry) => entry.owned).map((entry) => entry.playerSessionId);
      absentPlayerSessionIds = ownership.filter((entry) => !entry.owned).map((entry) => entry.playerSessionId);
    } catch (error) {
      return {
        releasedPlayerSessionIds: [] as string[],
        failedPlayerSessionIds: [...playerSessionIds],
        invalidClaim: isPlayerSessionClaimMismatch(error),
      };
    }
    const requested = new Set(playerSessionIds);
    const stagedBatches = new Set<PendingAtomicParty>();
    const activeReservationPlayerIds = new Set<string>();
    for (const batch of pendingAtomicParties.values()) {
      for (const member of batch.members.values()) {
        if (!requested.has(member.inspected.playerSessionId)) continue;
        if (batch.claimId !== claimId) {
          return { releasedPlayerSessionIds: [], failedPlayerSessionIds: [...playerSessionIds], invalidClaim: true };
        }
        stagedBatches.add(batch);
      }
    }
    for (const playerSessionId of playerSessionIds) {
      const active = activePlayerSessions.get(playerSessionId);
      if (!active) continue;
      if (active.publicAdmission?.partyClaimId !== claimId) {
        return { releasedPlayerSessionIds: [], failedPlayerSessionIds: [...playerSessionIds], invalidClaim: true };
      }
      activeReservationPlayerIds.add(active.publicAdmission.playerId);
    }
    await Promise.all([...stagedBatches].map((batch) => releasePendingAtomicParty(
      batch,
      "party_cancelled",
      "Quick play was cancelled. Re-enter together when ready.",
    )));
    rooms.releasePublicReservations(activeReservationPlayerIds);
    const released = await releasePartyReservations(gameLift!, ownedPlayerSessionIds);
    return {
      releasedPlayerSessionIds: [...absentPlayerSessionIds, ...released.releasedPlayerSessionIds],
      failedPlayerSessionIds: released.failedPlayerSessionIds,
      invalidClaim: false,
    };
  };

  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    (socket as Socket).setNoDelay(true);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    if (draining) {
      ws.close(1013, "Server is draining");
      return;
    }
    let socketClosed = false;
    let acceptedPlayerSessionId: string | null = null;
    let connectionMode: "base" | "game" | null = null;
    const peer = {
      id: randomUUID(),
      isOpen: () => ws.readyState === ws.OPEN,
      send(
        message: ServerMessage,
        _delivery?: import("@dotbot/protocol").DeliveryClass,
        encoded?: string,
      ) {
        if (ws.readyState === ws.OPEN) ws.send(encoded ?? JSON.stringify(message));
      },
    };
    if (publicQuickPlay) publicPeerSockets.set(peer.id, ws);
    const processMessage = async (data: RawData) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        peer.send({ type: "err", code: "bad_message", msg: "Message must be valid JSON." });
        return;
      }
      try {
        if (message.type === "baseHello") {
          if (connectionMode !== null) {
            peer.send({ type: "err", code: "bad_message", msg: "This connection already has a session." });
            return;
          }
          try {
            const state = await baseTutorialAuthority.connect(peer.id, message.token);
            if (socketClosed) {
              baseTutorialAuthority.disconnect(peer.id);
              return;
            }
            connectionMode = "base";
            peer.send({
              type: "baseWelcome",
              tutorial: state.tutorial,
              playerPosition: state.playerPosition,
              inputAck: state.inputAck,
              snapshot: state.snapshot,
              fabricatorEnabled: state.fabricatorEnabled,
            });
          } catch (error) {
            peer.send({ type: "err", code: "storage_unavailable", msg: errorMessage(error) });
          }
          return;
        }
        if (message.type === "baseInput") {
          if (connectionMode !== "base") {
            peer.send({ type: "err", code: "tutorial_session_required", msg: "Start an authoritative base session first." });
            return;
          }
          if (
            !Array.isArray(message.move)
            || message.move.length !== 2
            || !Number.isFinite(message.move[0])
            || !Number.isFinite(message.move[1])
          ) {
            peer.send({ type: "err", code: "bad_tutorial_input", msg: "Tutorial movement input is invalid." });
            return;
          }
          try {
            const state = await baseTutorialAuthority.handleInput(peer.id, {
              seq: message.seq,
              input: { move: { x: message.move[0], y: message.move[1] }, dash: message.dash },
              interact: message.interact,
            });
            peer.send({
              type: "baseState",
              tutorial: state.tutorial,
              playerPosition: state.playerPosition,
              inputAck: state.inputAck,
              snapshot: state.snapshot,
              fabricatorEnabled: state.fabricatorEnabled,
            });
          } catch (error) {
            peer.send({ type: "err", code: "bad_tutorial_input", msg: errorMessage(error) });
          }
          return;
        }
        if (connectionMode === "base") {
          peer.send({ type: "err", code: "bad_message", msg: "A base session accepts tutorial input only." });
          return;
        }
        if (gameLift && (message.type === "hello" || message.type === "quickPlayHello")) {
          if (acceptedPlayerSessionId) {
            peer.send({ type: "err", code: "bad_message", msg: "This connection already has a player session." });
            return;
          }
          if (!message.playerSessionId) {
            peer.send({ type: "err", code: "player_session_required", msg: "A valid GameLift player session is required." });
            ws.close(1008, "Player session required");
            return;
          }
          try {
            const playerSessionId = message.playerSessionId.trim();
            if (publicQuickPlay !== (message.type === "quickPlayHello")) {
              peer.send({ type: "err", code: "wrong_session_mode", msg: publicQuickPlay ? "Use the public quick-play handshake." : "Use the rollback room handshake." });
              ws.close(1008, "Wrong session mode");
              return;
            }
            let session = activePlayerSessions.get(playerSessionId);
            if (session?.removing) {
              peer.send({ type: "err", code: "player_session_expired", msg: "This player session is being released. Re-enter quick play." });
              ws.close(1008, "Player session expired");
              return;
            }
            if (!session && failedPlayerSessionRemovals.size > 0) {
              peer.send({ type: "err", code: "server_unavailable", msg: "Server admission is recovering. Re-enter quick play." });
              ws.close(1013, "Server admission is recovering");
              return;
            }
            if (session?.peerId) {
              peer.send({ type: "err", code: "player_session_in_use", msg: "This player session is already connected." });
              ws.close(1008, "Player session already connected");
              return;
            }
            if (session?.removalTimer) {
              clearTimeout(session.removalTimer);
              session.removalTimer = null;
            }
            if (!session && atomicPartyAllocation && message.type === "quickPlayHello") {
              const admitted = await stageAtomicPartyMember(
                peer,
                message,
                playerSessionId,
                () => !socketClosed && ws.readyState === ws.OPEN,
              );
              if (!admitted) {
                ws.close(1008, "Complete party admission failed");
                return;
              }
              acceptedPlayerSessionId = playerSessionId;
              connectionMode = "game";
              return;
            }
            if (!session) {
              if (pendingPlayerSessions.has(playerSessionId)) {
                peer.send({ type: "err", code: "player_session_in_use", msg: "This player session is already connecting." });
                ws.close(1008, "Player session already connecting");
                return;
              }
              pendingPlayerSessions.add(playerSessionId);
              try {
                const publicAdmission = publicQuickPlay
                  ? await gameLift.acceptPublicPlayerSession(playerSessionId)
                  : undefined;
                session = {
                  playerId: publicAdmission?.playerId ?? await gameLift.acceptPlayerSession(playerSessionId),
                  ...(publicAdmission ? { publicAdmission } : {}),
                  peerId: null,
                  removalTimer: null,
                  removing: false,
                };
                activePlayerSessions.set(playerSessionId, session);
              } finally {
                pendingPlayerSessions.delete(playerSessionId);
              }
            }
            if (socketClosed) {
              session.peerId = peer.id;
              acceptedPlayerSessionId = playerSessionId;
              await removePlayerSession(playerSessionId, peer.id, true);
              acceptedPlayerSessionId = null;
              return;
            }
            session.peerId = peer.id;
            acceptedPlayerSessionId = playerSessionId;
            const joined = await rooms.handleMessage(
              peer,
              message,
              session.publicAdmission ?? session.playerId,
              () => !socketClosed && ws.readyState === ws.OPEN,
            );
            if (!joined) {
              await removePlayerSession(playerSessionId, peer.id, true);
              acceptedPlayerSessionId = null;
              ws.close(1008, "Player identity rejected");
            } else {
              connectionMode = "game";
            }
            return;
          } catch (error) {
            if (acceptedPlayerSessionId) {
              await removePlayerSession(acceptedPlayerSessionId, peer.id, true);
              acceptedPlayerSessionId = null;
            } else if (requiresPlayerSessionRemoval(error) && message.playerSessionId?.trim()) {
              // A successful or response-lost adapter call may have committed
              // acceptance before trusted metadata parsing failed. Preserve a
              // terminal local binding so cleanup uses the same fail-closed,
              // indefinitely retryable reconciliation path as ordinary exits.
              const playerSessionId = message.playerSessionId.trim();
              if (!activePlayerSessions.has(playerSessionId)) {
                activePlayerSessions.set(playerSessionId, {
                  playerId: "",
                  peerId: null,
                  removalTimer: null,
                  removing: false,
                });
              }
              await finishPlayerSessionRemoval(playerSessionId);
            }
            peer.send({ type: "err", code: "player_session_rejected", msg: "GameLift rejected this player session." });
            ws.close(1008, "Player session rejected");
            return;
          }
        }
        const joined = await rooms.handleMessage(peer, message, undefined, () => !socketClosed && ws.readyState === ws.OPEN);
        if ((message.type === "hello" || message.type === "quickPlayHello") && joined) connectionMode = "game";
      } catch {
        peer.send({ type: "err", code: "server_unavailable", msg: "The allocated game session is not ready." });
      }
    };
    // ws emits messages in wire order, but async identity/GameLift admission
    // can otherwise let the next callback overtake hello. Preserve that order
    // for each peer so no gameplay message can race its own handshake.
    let inbound = Promise.resolve();
    ws.on("message", (data) => {
      inbound = inbound.then(() => processMessage(data));
    });
    ws.on("close", () => {
      socketClosed = true;
      publicPeerSockets.delete(peer.id);
      if (atomicPartyAllocation) void cancelPendingAtomicPeer(peer.id);
      baseTutorialAuthority.disconnect(peer.id);
      rooms.disconnect(peer.id);
      if (gameLift && acceptedPlayerSessionId) {
        void removePlayerSession(acceptedPlayerSessionId, peer.id, false);
      }
    });
  });

  app.addHook("onReady", async () => rooms.start());
  app.addHook("onClose", async () => {
    baseTutorialAuthority.close();
    await Promise.all([...pendingAtomicParties.values()].map((batch) => releasePendingAtomicParty(
      batch,
      "server_unavailable",
      "The arena is shutting down. Retry quick play together.",
      false,
    )));
    pendingAtomicParties.clear();
    pendingAtomicPartyByPeer.clear();
    pendingAtomicPeers.clear();
    await rooms.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (gameLift) {
      const sessions = [...activePlayerSessions.keys()];
      for (const entry of activePlayerSessions.values()) if (entry.removalTimer) clearTimeout(entry.removalTimer);
      activePlayerSessions.clear();
      failedPlayerSessionRemovals.clear();
      pendingPlayerSessions.clear();
      await Promise.allSettled(sessions.map((playerSessionId) => gameLift.removePlayerSession(playerSessionId)));
    }
    await persistence.close();
    options.arenaDirectory?.close();
  });

  return { app, rooms, persistence };
}

function loadTlsOptions(): { key: Buffer; cert: Buffer } | null {
  const certificatePath = process.env.GAMELIFT_TLS_CERTIFICATE;
  const chainPath = process.env.GAMELIFT_TLS_CERTIFICATE_CHAIN;
  const keyPath = process.env.GAMELIFT_TLS_PRIVATE_KEY;
  const configured = [certificatePath, chainPath, keyPath].filter(Boolean).length;
  if (configured === 0) return null;
  if (!certificatePath || !chainPath || !keyPath) {
    throw new Error("All GameLift TLS certificate paths must be configured together.");
  }
  return {
    key: readFileSync(keyPath),
    cert: Buffer.concat([readFileSync(certificatePath), Buffer.from("\n"), readFileSync(chainPath)]),
  };
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function validRelaySignature(
  secret: string,
  scope: "matchmaker-auth" | "game-persistence",
  timestamp: string | undefined,
  requestId: string | undefined,
  signature: string | undefined,
  body: string,
): boolean {
  if (!timestamp || !isUuid(requestId) || !signature || !/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 30_000) return false;
  const expected = createHmac("sha256", secret).update(`${scope}.${timestamp}.${requestId}.${body}`).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function dispatchPersistenceRelay(persistence: Persistence, payload: unknown): Promise<unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new RelayPayloadError("Invalid relay payload.");
  const operation = (payload as { operation?: unknown }).operation;
  const args = (payload as { args?: unknown }).args;
  if (typeof operation !== "string" || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new RelayPayloadError("Invalid relay operation.");
  }
  const value = args as Record<string, unknown>;
  switch (operation) {
    case "resolveOrRegisterPlayer": {
      const name = sanitizeName(value.offeredName);
      if (typeof value.token !== "string" || value.token.length < 16 || value.token.length > 512 || !name) {
        throw new RelayPayloadError("Invalid player identity payload.");
      }
      return persistence.resolveOrRegisterPlayer(value.token, name);
    }
    case "getInsertionPreference":
      if (!isUuid(value.playerId)) throw new RelayPayloadError("Invalid player id.");
      return persistence.getInsertionPreference(value.playerId);
    case "getBaseTutorialForPlayer":
      if (!isUuid(value.playerId)) throw new RelayPayloadError("Invalid player id.");
      return persistence.getBaseTutorialForPlayer(value.playerId);
    case "getMatchIntelObjects":
      if (!isUuid(value.playerId)) throw new RelayPayloadError("Invalid player id.");
      return persistence.getMatchIntelObjects(value.playerId);
    case "startMatch": {
      const startedAt = parseRelayDate(value.startedAt);
      const playerIds = parsePlayerIds(value.playerIds);
      if (!isUuid(value.matchId) || typeof value.roomCode !== "string" || !/^[A-HJ-NP-Z2-9]{4}$/.test(value.roomCode)
        || value.mapId !== downtownMap.id || !startedAt || !playerIds) {
        throw new RelayPayloadError("Invalid match start payload.");
      }
      return persistence.startMatch({ matchId: value.matchId, roomCode: value.roomCode, mapId: value.mapId, startedAt, playerIds });
    }
    case "recordExtraction": {
      const manifest = parseRunManifest(value.manifest);
      if (!isUuid(value.matchId) || !isUuid(value.playerId) || !manifest || manifest.reason !== "extracted"
        || !Number.isInteger(value.blueprintLearningThreshold) || Number(value.blueprintLearningThreshold) < 1 || Number(value.blueprintLearningThreshold) > 100) {
        throw new RelayPayloadError("Invalid extraction payload.");
      }
      return persistence.recordExtraction({
        matchId: value.matchId,
        playerId: value.playerId,
        manifest,
        blueprintLearningThreshold: Number(value.blueprintLearningThreshold),
      });
    }
    case "recordOutcome":
      if (!isUuid(value.matchId) || !isUuid(value.playerId) || !isRunOutcome(value.outcome)) {
        throw new RelayPayloadError("Invalid match outcome payload.");
      }
      return persistence.recordOutcome({ matchId: value.matchId, playerId: value.playerId, outcome: value.outcome });
    case "finishMatch": {
      const endedAt = parseRelayDate(value.endedAt);
      if (!isUuid(value.matchId) || !endedAt || !isRelaySummary(value.summary)) throw new RelayPayloadError("Invalid match finish payload.");
      return persistence.finishMatch({ matchId: value.matchId, endedAt, summary: value.summary });
    }
    default:
      throw new RelayPayloadError("Persistence relay operation is not allowed.");
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parsePlayerIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > PUBLIC_EXTRACTION_ROLE_COUNT || !value.every(isUuid)) return null;
  const unique = [...new Set(value)];
  return unique.length === value.length ? unique : null;
}

function parseRelayDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && Math.abs(Date.now() - date.getTime()) <= 24 * 60 * 60_000 ? date : null;
}

function parseRunManifest(value: unknown): Parameters<Persistence["recordExtraction"]>[0]["manifest"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  const keptItems = parseWireItems(manifest.keptItems);
  const lostItems = parseWireItems(manifest.lostItems);
  if (!keptItems || !lostItems || (manifest.reason !== "extracted" && manifest.reason !== "died" && manifest.reason !== "timeout")) return null;
  if (!Array.isArray(manifest.learnedBlueprints) || manifest.learnedBlueprints.length > 64
    || !manifest.learnedBlueprints.every((entry) => typeof entry === "string" && isSafeIdentifier(entry))) return null;
  if (manifest.contractCompletions !== undefined && (!Array.isArray(manifest.contractCompletions) || manifest.contractCompletions.length > 0)) return null;
  let cargo: Item[] | undefined;
  if (manifest.cargo !== undefined) {
    if (!Array.isArray(manifest.cargo) || manifest.cargo.length > 128 || !manifest.cargo.every(isItem)) return null;
    cargo = manifest.cargo;
  }
  return {
    reason: manifest.reason,
    keptItems,
    lostItems,
    learnedBlueprints: manifest.learnedBlueprints,
    ...(cargo ? { cargo } : {}),
  };
}

function parseWireItems(value: unknown): WireItemCode[] | null {
  if (!Array.isArray(value) || value.length > 128 || !value.every(isWireItemCode)) return null;
  return value;
}

function isWireItemCode(value: unknown): value is WireItemCode {
  if (typeof value !== "string" || value.length > 66) return false;
  if (value.startsWith("b:") && !isSafeIdentifier(value.slice(2))) return false;
  try {
    itemFromCode(value as WireItemCode);
    return true;
  } catch {
    return false;
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function isItem(value: unknown): value is Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.sourceBuildingId !== undefined && (typeof item.sourceBuildingId !== "string" || !isSafeIdentifier(item.sourceBuildingId))) return false;
  if (item.kind === "mine") return Object.keys(item).every((key) => key === "kind" || key === "sourceBuildingId");
  if (item.kind === "blueprint") return typeof item.blueprintId === "string" && isSafeIdentifier(item.blueprintId)
    && Object.keys(item).every((key) => key === "kind" || key === "blueprintId" || key === "sourceBuildingId");
  return item.kind === "powerup" && (item.type === "health" || item.type === "radar" || item.type === "dashOvercharge" || item.type === "incognito")
    && Object.keys(item).every((key) => key === "kind" || key === "type" || key === "sourceBuildingId");
}

function isRunOutcome(value: unknown): value is "died" | "timeout" | "disconnected" {
  return value === "died" || value === "timeout" || value === "disconnected";
}

function isRelaySummary(value: unknown): boolean {
  return isAggregateMatchSummary(value);
}

class RelayPayloadError extends Error {}

function sanitizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 24) : "";
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function authToken(headers: { "x-device-token"?: string; authorization?: string }): string | undefined {
  return headers["x-device-token"] ?? bearerToken(headers.authorization);
}

async function verifyFirebaseBearer(
  verifier: FirebaseIdentityVerifier | null,
  authorization: string | undefined,
  reply: FastifyReply,
): Promise<VerifiedExternalIdentity | null> {
  if (!verifier) {
    reply.code(503).send({ error: "Firebase identity verification is not configured." });
    return null;
  }
  const token = bearerToken(authorization);
  if (!token) {
    reply.code(401).send({ error: "A Firebase identity bearer token is required." });
    return null;
  }
  try {
    return await verifier.verifyIdToken(token);
  } catch {
    reply.code(401).send({ error: "Firebase identity token is invalid or expired." });
    return null;
  }
}

function publicPlayer(player: PublicPlayer) {
  return { publicPlayerId: formatPublicPlayerId(player.publicPlayerId), displayName: player.displayName };
}

function publicAccount(account: AccountSummary) {
  return { ...publicPlayer(account), linked: account.linked, providers: account.providers };
}

function publicParty(party: PartySummary) {
  return {
    version: party.version,
    members: party.members.map((member) => ({
      publicPlayerId: formatPublicPlayerId(member.publicPlayerId),
      displayName: member.displayName,
      leader: member.leader,
    })),
    canInvite: party.canInvite,
  };
}

function parsePartyVersion(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

function sendPartyError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof PartyConflictError)) throw error;
  const status = error.code === "party_invite_invalid" ? 404
    : error.code === "party_link_required" || error.code === "party_leader_required" ? 403
      : 409;
  const messages: Record<typeof error.code, string> = {
    party_full: "That party already has three members.",
    party_queued: "Cancel public queueing before changing the party.",
    party_version_stale: "Party membership changed. Refresh before retrying.",
    party_leader_required: "Only the current party leader can do that.",
    party_link_required: "Link an account to own durable party invitations.",
    party_membership_conflict: "Party membership could not be changed safely.",
    party_invite_invalid: "Party invitation is invalid or expired.",
  };
  return reply.code(status).send({ error: messages[error.code], code: error.code });
}

function claimPartyOperationReplay(claims: Map<string, number>, requestId: string, now = Date.now()): boolean {
  for (const [id, expiresAt] of claims) {
    if (expiresAt <= now) claims.delete(id);
  }
  if (claims.has(requestId)) return false;
  while (claims.size >= 4_096) claims.delete(claims.keys().next().value!);
  claims.set(requestId, now + 5 * 60_000);
  return true;
}

export async function releasePartyReservations(
  gameLift: Pick<GameLiftSessionGate, "removePlayerSession">,
  playerSessionIds: readonly string[],
): Promise<{ releasedPlayerSessionIds: string[]; failedPlayerSessionIds: string[] }> {
  const results = await Promise.all(playerSessionIds.map(async (playerSessionId) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await gameLift.removePlayerSession(playerSessionId);
        return { playerSessionId, released: true as const };
      } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    return { playerSessionId, released: false as const };
  }));
  return {
    releasedPlayerSessionIds: results.filter((result) => result.released).map((result) => result.playerSessionId),
    failedPlayerSessionIds: results.filter((result) => !result.released).map((result) => result.playerSessionId),
  };
}

function allowIdentityRequest(
  limiter: IdentityRateLimiter,
  action: IdentityRateLimitAction,
  key: string,
  reply: FastifyReply,
): boolean {
  const decision = limiter.consume(action, key);
  if (decision.allowed) return true;
  reply.header("retry-after", decision.retryAfterSeconds).code(429).send({ error: "Too many identity requests. Try again later." });
  return false;
}

function parseBaseLayout(value: unknown): BaseLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const layout: BaseLayout = {};
  for (const [slotId, kind] of Object.entries(value)) {
    if (!isBaseObjectKind(kind)) return null;
    layout[slotId] = kind;
  }
  try {
    // Ownership is checked transactionally by persistence. Parsing accepts
    // the complete canonical roster so an unauthorized F1 layout reaches the
    // explicit 409 path instead of being mistaken for malformed input.
    validateBaseLayout(layout, { expanded: true });
    return layout;
  } catch {
    return null;
  }
}

function parseLoadout(value: unknown): WireItemCode[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  return value.every(isWireLoadoutCode) ? value as WireItemCode[] : null;
}

function parsePresets(value: unknown): LoadoutPreset[] | null {
  if (!Array.isArray(value) || value.length > 3) return null;
  const presets: LoadoutPreset[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const raw = candidate as { name?: unknown; items?: unknown };
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ").slice(0, 24) : "";
    if (!name || !Array.isArray(raw.items) || raw.items.length > 4) return null;
    if (!raw.items.every(isWireLoadoutCode)) return null;
    presets.push({ name, items: raw.items as WireLoadoutCode[] });
  }
  return presets;
}

function isWireLoadoutCode(value: unknown): value is WireLoadoutCode {
  return value === "h" || value === "r" || value === "d" || value === "i" || value === "m";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length > 200
    || /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(message)
    || /(constraint|sqlstate|player_id|device_token|external_identit|firebase-user|issuer|subject)/i.test(message)) {
    return "The request could not be completed safely.";
  }
  return message;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "UnknownError";
}
