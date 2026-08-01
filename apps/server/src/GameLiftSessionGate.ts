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
};
export type PublicGameSession = Pick<PublicPlayerAdmission, "arenaId" | "buildId" | "region"> & { gameSessionId: string };

export type GameLiftSessionGateOptions = {
  adapterUrl?: string;
  fetch?: typeof fetch;
};

/**
 * The GameLift SDK runs in a small local adapter. This gate is the only part
 * of the Node game server that can admit or remove a GameLift player session.
 * The adapter binds to loopback, so player-session IDs never become a public
 * control API.
 */
export class GameLiftSessionGate {
  private readonly adapterUrl: string;
  private readonly request: typeof fetch;
  private ending = false;

  constructor(options: GameLiftSessionGateOptions = {}) {
    this.adapterUrl = (options.adapterUrl ?? "http://127.0.0.1:8090").replace(/\/$/, "");
    this.request = options.fetch ?? fetch;
  }

  async roomCode(): Promise<string> {
    return this.sessionProperty("roomCode", "room code");
  }

  async arenaId(): Promise<string> {
    return (await this.publicSession()).arenaId;
  }

  async publicSession(): Promise<PublicGameSession> {
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
    const payload = await response.json().catch(() => null) as { playerId?: unknown } | null;
    if (!payload || typeof payload.playerId !== "string" || !payload.playerId || payload.playerId.length > 1024) {
      throw new Error("GameLift returned an invalid player identity.");
    }
    return payload.playerId;
  }

  async acceptPublicPlayerSession(playerSessionId: string): Promise<PublicPlayerAdmission> {
    const response = await this.playerSessionAction("accept", playerSessionId);
    const payload = await response.json().catch(() => null) as { playerId?: unknown; playerData?: unknown } | null;
    if (!payload || typeof payload.playerId !== "string" || !payload.playerId || payload.playerId.length > 1024) {
      throw new Error("GameLift returned an invalid player identity.");
    }
    let playerData: unknown = payload.playerData;
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
    return { playerId: payload.playerId, arenaId, partyId, buildId, region };
  }

  async removePlayerSession(playerSessionId: string): Promise<void> {
    await this.playerSessionAction("remove", playerSessionId);
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
    const response = await this.request(`${this.adapterUrl}/v1/player-sessions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerSessionId: value }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error("GameLift rejected the player session.");
    return response;
  }
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
