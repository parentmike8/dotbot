import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalTrustedPartyReservation, parseTrustedPartyReservation } from "@dotbot/protocol";

const roomCodePattern = /^[A-HJ-NP-Z2-9]{4}$/;

type GameLiftSession = {
  GameSessionId?: unknown;
  GameProperties?: unknown;
};

export type PublicPlayerAdmission = {
  playerId: string;
  arenaId: string;
  partyId: string;
  buildId: string;
  region: string;
  partyVersion?: number;
  partyClaimId?: string;
  partyMemberPlayerIds?: string[];
};
export type AtomicPublicPlayerAdmission = PublicPlayerAdmission & {
  partyVersion: number;
  partyClaimId: string;
  partyMemberPlayerIds: string[];
  partyReservationExpiresAt: number;
};
export type InspectedPublicPlayerSession = {
  playerSessionId: string;
  admission: AtomicPublicPlayerAdmission;
};
export type PublicGameSession = Pick<PublicPlayerAdmission, "arenaId" | "buildId" | "region"> & { gameSessionId: string };

export type GameLiftSessionGateOptions = {
  adapterUrl?: string;
  fetch?: typeof fetch;
  atomicPartyAllocation?: boolean;
};

/** The accept request may already have committed in the SDK. Callers must
 * retain the player-session id and reconcile it through RemovePlayerSession. */
export class GameLiftPlayerSessionRemovalRequiredError extends Error {
  readonly removalRequired = true;
}

export function requiresPlayerSessionRemoval(error: unknown): error is GameLiftPlayerSessionRemovalRequiredError {
  return error instanceof GameLiftPlayerSessionRemovalRequiredError;
}

/**
 * The GameLift SDK runs in a small local adapter. This gate is the only part
 * of the Node game server that can admit or remove a GameLift player session.
 * The adapter binds to loopback, so player-session IDs never become a public
 * control API.
 */
export class GameLiftSessionGate {
  private readonly adapterUrl: string;
  private readonly request: typeof fetch;
  private readonly atomicPartyAllocation: boolean;
  private ending = false;

  constructor(options: GameLiftSessionGateOptions = {}) {
    this.adapterUrl = (options.adapterUrl ?? "http://127.0.0.1:8090").replace(/\/$/, "");
    this.request = options.fetch ?? fetch;
    this.atomicPartyAllocation = options.atomicPartyAllocation ?? false;
  }

  async roomCode(): Promise<string> {
    return this.sessionProperty("roomCode", "room code");
  }

  async arenaId(): Promise<string> {
    return (await this.publicSession()).arenaId;
  }

  async publicSession(): Promise<PublicGameSession> {
    const session = await this.publicSessionMetadata();
    return { gameSessionId: session.gameSessionId, arenaId: session.arenaId, buildId: session.buildId, region: session.region };
  }

  private async publicSessionMetadata(): Promise<PublicGameSession & { partySecret?: string }> {
    const response = await this.request(`${this.adapterUrl}/v1/session`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("GameLift has not assigned this process a session.");
    const session = await response.json() as GameLiftSession;
    if (typeof session.GameSessionId !== "string" || !session.GameSessionId) throw new Error("GameLift has not assigned this process a session.");
    const properties = parseProperties(session.GameProperties);
    const arenaId = properties.arenaId?.trim().toUpperCase() ?? "";
    const buildId = properties.buildId?.trim() ?? "";
    const region = properties.region?.trim() ?? "";
    if (properties.mode !== "public-hot-arena" || !roomCodePattern.test(arenaId)
      || !safeMetadata(buildId, 64) || !safeMetadata(region, 64)) {
      throw new Error("The GameLift session is missing its public arena metadata.");
    }
    if (this.atomicPartyAllocation) {
      const partySecret = properties.partySecret?.trim() ?? "";
      if (properties.partyAllocation !== "v1" || !/^[a-f0-9]{64}$/.test(partySecret)) {
        throw new Error("The GameLift session is missing atomic party metadata.");
      }
      return { gameSessionId: session.GameSessionId, arenaId, buildId, region, partySecret };
    }
    return { gameSessionId: session.GameSessionId, arenaId, buildId, region };
  }

  private async sessionProperty(property: "roomCode" | "arenaId", label: string): Promise<string> {
    const response = await this.request(`${this.adapterUrl}/v1/session`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("GameLift has not assigned this process a session.");
    const session = await response.json() as GameLiftSession;
    if (typeof session.GameSessionId !== "string" || !session.GameSessionId) {
      throw new Error("GameLift has not assigned this process a session.");
    }
    const properties = parseProperties(session.GameProperties);
    const value = properties[property]?.trim().toUpperCase();
    if (!value || !roomCodePattern.test(value)) {
      throw new Error(`The GameLift session is missing its ${label}.`);
    }
    return value;
  }

  async acceptPlayerSession(playerSessionId: string): Promise<string> {
    const response = await this.playerSessionAction("accept", playerSessionId);
    try {
      const payload = await response.json().catch(() => null) as { playerId?: unknown } | null;
      const playerId = typeof payload?.playerId === "string" ? payload.playerId.trim() : "";
      if (!playerId || playerId.length > 1024) {
        throw new Error("GameLift returned an invalid player identity.");
      }
      return playerId;
    } catch (error) {
      throw removalRequiredError(error);
    }
  }

  async acceptPublicPlayerSession(playerSessionId: string): Promise<PublicPlayerAdmission> {
    if (this.atomicPartyAllocation) {
      throw new Error("Atomic party reservations must be accepted as one batch.");
    }
    const response = await this.playerSessionAction("accept", playerSessionId);
    try {
      const payload = await response.json().catch(() => null) as { playerId?: unknown; playerData?: unknown } | null;
      const playerId = typeof payload?.playerId === "string" ? payload.playerId.trim() : "";
      if (!playerId || playerId.length > 1024) {
        throw new Error("GameLift returned an invalid player identity.");
      }
      let playerData: unknown = payload?.playerData;
      if (typeof playerData === "string") {
        try {
          playerData = JSON.parse(playerData);
        } catch {
          throw new Error("GameLift returned invalid public player metadata.");
        }
      }
      if (!playerData || typeof playerData !== "object" || Array.isArray(playerData)) {
        throw new Error("GameLift returned invalid public player metadata.");
      }
      const value = playerData as Record<string, unknown>;
      const arenaId = typeof value.arenaId === "string" ? value.arenaId.trim().toUpperCase() : "";
      const partyId = typeof value.partyId === "string" ? value.partyId.trim() : "";
      const buildId = typeof value.buildId === "string" ? value.buildId.trim() : "";
      const region = typeof value.region === "string" ? value.region.trim() : "";
      if (value.mode !== "public-hot-arena" || !roomCodePattern.test(arenaId)
        || !safeMetadata(partyId, 128) || !safeMetadata(buildId, 64) || !safeMetadata(region, 64)) {
        throw new Error("GameLift returned invalid public player metadata.");
      }
      const session = await this.publicSession();
      if (session.arenaId !== arenaId || session.buildId !== buildId || session.region !== region) {
        throw new Error("GameLift public player metadata does not match the assigned game session.");
      }
      return { playerId, arenaId, partyId, buildId, region };
    } catch (error) {
      throw removalRequiredError(error);
    }
  }

  /** Reads and verifies one reserved session without changing GameLift state.
   * The caller must later submit the complete signed roster to
   * acceptPublicPartySessions or release every staged reservation. */
  async inspectPublicPlayerSession(playerSessionId: string): Promise<InspectedPublicPlayerSession> {
    if (!this.atomicPartyAllocation) throw new Error("Atomic party allocation is not enabled.");
    const value = playerSessionId.trim();
    if (!value || value.length > 2048) throw new Error("A valid GameLift player session is required.");
    const response = await this.request(`${this.adapterUrl}/v1/player-sessions/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerSessionId: value }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error("GameLift rejected the player session.");
    try {
      const payload = await response.json().catch(() => null);
      if (playerSessionIdFromPayload(payload) !== value) throw new Error("GameLift returned the wrong player session.");
      const session = await this.publicSessionMetadata();
      return { playerSessionId: value, admission: parseAtomicAdmission(payload, session) };
    } catch (error) {
      // The adapter confirmed that this exact id is reserved for the current
      // GameSession. Invalid downstream metadata must therefore be removed,
      // while a definite adapter rejection above must never remove an
      // untrusted id supplied by the caller.
      throw removalRequiredError(error);
    }
  }

  /** The loopback adapter describes the complete batch again, then accepts all
   * one to three reservations under ordered locks. Any partial SDK failure is
   * compensated before this method rejects. */
  async acceptPublicPartySessions(inspected: readonly InspectedPublicPlayerSession[]): Promise<void> {
    if (!this.atomicPartyAllocation || !validAtomicPartyBatch(inspected)) {
      throw new GameLiftPlayerSessionRemovalRequiredError("GameLift rejected the atomic party batch.");
    }
    const playerSessionIds = inspected.map((entry) => entry.playerSessionId);
    let response: Response;
    try {
      response = await this.request(`${this.adapterUrl}/v1/player-sessions/accept-party`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerSessionIds }),
        signal: AbortSignal.timeout(2500),
      });
    } catch {
      throw new GameLiftPlayerSessionRemovalRequiredError("GameLift party acceptance is uncertain.");
    }
    if (!response.ok) throw new GameLiftPlayerSessionRemovalRequiredError("GameLift rejected the atomic party batch.");
    try {
      const payload = await response.json().catch(() => null) as { playerSessions?: unknown } | null;
      if (!payload || !Array.isArray(payload.playerSessions) || payload.playerSessions.length !== inspected.length) {
        throw new Error("GameLift returned an incomplete atomic party batch.");
      }
      const session = await this.publicSessionMetadata();
      const accepted = payload.playerSessions.map((entry) => ({
        playerSessionId: playerSessionIdFromPayload(entry),
        admission: parseAtomicAdmission(entry, session),
      }));
      const expectedBySession = new Map(inspected.map((entry) => [entry.playerSessionId, canonicalAtomicAdmission(entry.admission)]));
      if (new Set(accepted.map((entry) => entry.playerSessionId)).size !== accepted.length
        || accepted.some((entry) => expectedBySession.get(entry.playerSessionId) !== canonicalAtomicAdmission(entry.admission))) {
        throw new Error("GameLift changed the inspected atomic party batch.");
      }
    } catch (error) {
      throw removalRequiredError(error);
    }
  }

  async removePlayerSession(playerSessionId: string): Promise<void> {
    await this.playerSessionAction("remove", playerSessionId);
  }

  async verifyPartyOperation(
    scope: "party-preflight" | "party-release",
    timestamp: string | undefined,
    requestId: string | undefined,
    signature: string | undefined,
    body: string,
    now = Date.now(),
  ): Promise<PublicGameSession | null> {
    if (!this.atomicPartyAllocation || !timestamp || !requestId || !signature
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return null;
    const time = Number(timestamp);
    if (!Number.isFinite(time) || Math.abs(now - time) > 30_000) return null;
    const session = await this.publicSessionMetadata();
    if (!session.partySecret) return null;
    const expected = createHmac("sha256", session.partySecret)
      .update(`${scope}.${timestamp}.${requestId}.${body}`)
      .digest("hex");
    return validHmac(expected, signature)
      ? { gameSessionId: session.gameSessionId, arenaId: session.arenaId, buildId: session.buildId, region: session.region }
      : null;
  }

  async endProcess(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    try {
      const response = await this.request(`${this.adapterUrl}/v1/process/end`, {
        method: "POST",
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error(`adapter returned ${response.status}`);
    } catch (error) {
      this.ending = false;
      throw error;
    }
  }

  private async playerSessionAction(action: "accept" | "remove", playerSessionId: string): Promise<Response> {
    const value = playerSessionId.trim();
    if (!value || value.length > 2048) throw new Error("A valid GameLift player session is required.");
    let response: Response;
    try {
      response = await this.request(`${this.adapterUrl}/v1/player-sessions/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerSessionId: value }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      if (action === "accept") {
        throw new GameLiftPlayerSessionRemovalRequiredError("GameLift player-session acceptance is uncertain.");
      }
      throw new Error("GameLift player-session removal failed.");
    }
    if (!response.ok) throw new Error("GameLift rejected the player session.");
    return response;
  }
}

function parseAtomicAdmission(
  payload: unknown,
  session: PublicGameSession & { partySecret?: string },
): AtomicPublicPlayerAdmission {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GameLift returned invalid atomic party metadata.");
  }
  const result = payload as Record<string, unknown>;
  const playerId = typeof result.playerId === "string" ? result.playerId.trim().toLowerCase() : "";
  let playerData: unknown = result.playerData;
  if (typeof playerData === "string") {
    try {
      playerData = JSON.parse(playerData);
    } catch {
      throw new Error("GameLift returned invalid atomic party metadata.");
    }
  }
  if (!playerData || typeof playerData !== "object" || Array.isArray(playerData)) {
    throw new Error("GameLift returned invalid atomic party metadata.");
  }
  const value = playerData as Record<string, unknown>;
  const reservation = parseTrustedPartyReservation(value.reservation);
  const reservationSignature = typeof value.reservationSignature === "string" ? value.reservationSignature : "";
  const now = Date.now();
  if (value.mode !== "public-hot-arena" || !reservation || !session.partySecret
    || reservation.playerId !== playerId
    || reservation.arenaId !== session.arenaId || reservation.buildId !== session.buildId || reservation.region !== session.region
    || reservation.expiresAt <= now || reservation.expiresAt > now + 5 * 60_000
    || !validHmac(
      createHmac("sha256", session.partySecret)
        .update(`party-reservation.${canonicalTrustedPartyReservation(reservation)}`)
        .digest("hex"),
      reservationSignature,
    )) {
    throw new Error("GameLift returned invalid atomic party metadata.");
  }
  return {
    playerId,
    arenaId: reservation.arenaId,
    partyId: reservation.partyId,
    buildId: reservation.buildId,
    region: reservation.region,
    partyVersion: reservation.version,
    partyClaimId: reservation.claimId,
    partyMemberPlayerIds: reservation.memberPlayerIds,
    partyReservationExpiresAt: reservation.expiresAt,
  };
}

function playerSessionIdFromPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const playerSessionId = (value as Record<string, unknown>).playerSessionId;
  return typeof playerSessionId === "string" ? playerSessionId.trim() : "";
}

function validAtomicPartyBatch(inspected: readonly InspectedPublicPlayerSession[]): boolean {
  if (inspected.length < 1 || inspected.length > 3
    || new Set(inspected.map((entry) => entry.playerSessionId)).size !== inspected.length
    || inspected.some((entry) => !entry.playerSessionId || entry.playerSessionId.length > 2048)) return false;
  const first = inspected[0].admission;
  const expectedMembers = first.partyMemberPlayerIds.join(".");
  if (first.partyMemberPlayerIds.length !== inspected.length) return false;
  const admittedMembers = inspected.map((entry) => entry.admission.playerId).sort();
  if (admittedMembers.join(".") !== expectedMembers) return false;
  return inspected.every(({ admission }) => admission.partyClaimId === first.partyClaimId
    && admission.partyId === first.partyId
    && admission.partyVersion === first.partyVersion
    && admission.arenaId === first.arenaId
    && admission.buildId === first.buildId
    && admission.region === first.region
    && admission.partyReservationExpiresAt === first.partyReservationExpiresAt
    && admission.partyMemberPlayerIds.join(".") === expectedMembers);
}

function canonicalAtomicAdmission(admission: AtomicPublicPlayerAdmission): string {
  return JSON.stringify({
    playerId: admission.playerId,
    arenaId: admission.arenaId,
    partyId: admission.partyId,
    buildId: admission.buildId,
    region: admission.region,
    partyVersion: admission.partyVersion,
    partyClaimId: admission.partyClaimId,
    partyMemberPlayerIds: admission.partyMemberPlayerIds,
    partyReservationExpiresAt: admission.partyReservationExpiresAt,
  });
}

function removalRequiredError(error: unknown): GameLiftPlayerSessionRemovalRequiredError {
  if (requiresPlayerSessionRemoval(error)) return error;
  return new GameLiftPlayerSessionRemovalRequiredError(error instanceof Error ? error.message : "GameLift returned an invalid player session response.");
}

function safeMetadata(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function parseProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (typeof propertyValue === "string") result[key] = propertyValue;
  }
  return result;
}

function validHmac(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
