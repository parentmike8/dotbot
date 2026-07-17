const roomCodePattern = /^[A-HJ-NP-Z2-9]{4}$/;

type GameLiftSession = {
  GameSessionId?: unknown;
  GameProperties?: unknown;
};

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
    const response = await this.request(`${this.adapterUrl}/v1/session`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("GameLift has not assigned this process a session.");
    const session = await response.json() as GameLiftSession;
    if (typeof session.GameSessionId !== "string" || !session.GameSessionId) {
      throw new Error("GameLift has not assigned this process a session.");
    }
    const properties = parseProperties(session.GameProperties);
    const roomCode = properties.roomCode?.trim().toUpperCase();
    if (!roomCode || !roomCodePattern.test(roomCode)) {
      throw new Error("The GameLift session is missing its room code.");
    }
    return roomCode;
  }

  async acceptPlayerSession(playerSessionId: string): Promise<void> {
    await this.playerSessionAction("accept", playerSessionId);
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

  private async playerSessionAction(action: "accept" | "remove", playerSessionId: string): Promise<void> {
    const value = playerSessionId.trim();
    if (!value || value.length > 2048) throw new Error("A valid GameLift player session is required.");
    const response = await this.request(`${this.adapterUrl}/v1/player-sessions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerSessionId: value }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error("GameLift rejected the player session.");
  }
}

function parseProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (typeof propertyValue === "string") result[key] = propertyValue;
  }
  return result;
}
