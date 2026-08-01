export type PublicPartyAllocation = {
  mode: "public-hot-arena";
  arenaId: string;
  playerSessionId: string;
  websocketUrl: string;
  expiresAt?: string;
  /** Opaque cancellation handle. It is not a party or player identifier. */
  queueTicket: string;
  partySize: number;
};

export class PublicPartyQueueError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

export async function requestPublicPartyAllocation(input: {
  matchmakerUrl: string;
  token: string;
  buildId: string;
  latencies: Readonly<Record<string, number>>;
  queueRequestId?: string;
}): Promise<{ allocation: PublicPartyAllocation; queueRequestId: string }> {
  const queueRequestId = input.queueRequestId ?? crypto.randomUUID();
  const response = await fetch(matchmakerEndpoint(input.matchmakerUrl, "quick-play"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: input.token,
      queueRequestId,
      buildId: input.buildId,
      latencies: input.latencies,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<PublicPartyAllocation> & { error?: string; retryable?: boolean };
  if (!response.ok) throw new PublicPartyQueueError(payload.error ?? "Public quick play is unavailable.", response.status, payload.retryable === true);
  if (!isPublicPartyAllocation(payload)) {
    throw new PublicPartyQueueError("Public quick play returned an incomplete party allocation.", 502, true);
  }
  return { allocation: payload as PublicPartyAllocation, queueRequestId };
}

export async function cancelPublicPartyAllocation(input: {
  matchmakerUrl: string;
  token: string;
  queueTicket: string;
}): Promise<void> {
  const response = await fetch(matchmakerEndpoint(input.matchmakerUrl, "quick-play/cancel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: input.token, queueTicket: input.queueTicket }),
  });
  const payload = await response.json().catch(() => ({})) as { cancelled?: unknown; error?: string; retryable?: boolean };
  if (!response.ok || payload.cancelled !== true) {
    throw new PublicPartyQueueError(payload.error ?? "Public quick-play cancellation is incomplete.", response.status, payload.retryable === true);
  }
}

function matchmakerEndpoint(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base);
}

function isPublicPartyAllocation(value: Partial<PublicPartyAllocation>): value is PublicPartyAllocation {
  if (value.mode !== "public-hot-arena" || typeof value.arenaId !== "string" || !/^[A-HJ-NP-Z2-9]{4}$/.test(value.arenaId)
    || typeof value.playerSessionId !== "string" || value.playerSessionId.length < 1 || value.playerSessionId.length > 2048
    || typeof value.queueTicket !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.queueTicket)
    || !Number.isInteger(value.partySize) || value.partySize! < 1 || value.partySize! > 3
    || (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))))) return false;
  if (typeof value.websocketUrl !== "string") return false;
  try {
    return new URL(value.websocketUrl).protocol === "wss:";
  } catch {
    return false;
  }
}
