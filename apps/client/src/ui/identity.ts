export const playerNameKey = "dotbot.playerName";
export const deviceTokenKey = "dotbot.deviceToken";

export type AccountState = {
  publicPlayerId: string | null;
  displayName: string;
  linked: boolean;
  providers: Array<"email_link" | "phone">;
  storageAvailable: boolean;
};

let accountTokenInFlight: Promise<string> | null = null;

export async function ensureAccountToken(name: string): Promise<string> {
  accountTokenInFlight ??= ensureAccountTokenOnce(name).finally(() => {
    accountTokenInFlight = null;
  });
  return accountTokenInFlight;
}

async function ensureAccountTokenOnce(name: string): Promise<string> {
  const existing = localStorage.getItem(deviceTokenKey);
  if (existing) {
    try {
      const response = await fetch("/api/auth/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: existing }),
      });
      if (response.ok) return existing;
      if (response.status !== 404) return existing;
    } catch {
      return existing;
    }
  }

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      const account = await response.json() as { token: string };
      localStorage.setItem(deviceTokenKey, account.token);
      return account.token;
    }
  } catch {
    // Fall through to a client token so the stateless base remains playable.
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(deviceTokenKey, token);
  return token;
}

export async function fetchAccountState(): Promise<AccountState> {
  const token = localStorage.getItem(deviceTokenKey);
  const displayName = localStorage.getItem(playerNameKey) ?? "Player";
  if (!token) return { publicPlayerId: null, displayName, linked: false, providers: [], storageAvailable: false };
  try {
    const response = await fetch("/api/account", { headers: { "x-device-token": token } });
    if (!response.ok) return { publicPlayerId: null, displayName, linked: false, providers: [], storageAvailable: response.status !== 503 };
    const account = await response.json() as Omit<AccountState, "storageAvailable">;
    return { ...account, storageAvailable: true };
  } catch {
    return { publicPlayerId: null, displayName, linked: false, providers: [], storageAvailable: false };
  }
}

/**
 * Firebase tokens are accepted as short-lived arguments and are never stored.
 * The server owns the atomic guest-progress merge.
 */
export async function linkGuestAccount(firebaseIdToken: string): Promise<AccountState> {
  const token = localStorage.getItem(deviceTokenKey);
  if (!token) throw new Error("A guest device session is required before linking.");
  const response = await fetch("/api/auth/link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-token": token,
      authorization: `Bearer ${firebaseIdToken}`,
    },
    body: "{}",
  });
  const payload = await response.json() as { account?: Omit<AccountState, "storageAvailable">; error?: string };
  if (!response.ok || !payload.account) throw new Error(payload.error ?? "Account linking failed.");
  localStorage.setItem(playerNameKey, payload.account.displayName);
  return { ...payload.account, storageAvailable: true };
}

export async function updateDisplayName(displayName: string): Promise<AccountState> {
  const token = localStorage.getItem(deviceTokenKey);
  if (!token) throw new Error("A device session is required before changing the display name.");
  const clean = displayName.trim().replace(/\s+/g, " ").slice(0, 24);
  if (!clean) throw new Error("A display name is required.");
  const response = await fetch("/api/account/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-device-token": token },
    body: JSON.stringify({ displayName: clean }),
  });
  const payload = await response.json() as Omit<AccountState, "storageAvailable"> & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Display name could not be changed.");
  localStorage.setItem(playerNameKey, payload.displayName);
  return { ...payload, storageAvailable: true };
}

export async function createLinkedDeviceSession(firebaseIdToken: string): Promise<AccountState> {
  const existing = localStorage.getItem(deviceTokenKey);
  if (existing) {
    let response: Response;
    try {
      response = await fetch("/api/auth/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: existing }),
      });
    } catch {
      throw new Error("Guest progress could not be verified before login. Try again.");
    }
    if (response.ok) return linkGuestAccount(firebaseIdToken);
    if (response.status !== 404) throw new Error("Guest progress could not be verified before login. Try again.");
  }
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { authorization: `Bearer ${firebaseIdToken}` },
  });
  const payload = await response.json() as Omit<AccountState, "storageAvailable" | "providers"> & { token?: string; error?: string };
  if (!response.ok || !payload.token) throw new Error(payload.error ?? "Account login failed.");
  localStorage.setItem(deviceTokenKey, payload.token);
  localStorage.setItem(playerNameKey, payload.displayName);
  return {
    publicPlayerId: payload.publicPlayerId,
    displayName: payload.displayName,
    linked: true,
    providers: [],
    storageAvailable: true,
  };
}

export async function acceptPartyInvite(code: string): Promise<{ inviter: { publicPlayerId: string; displayName: string }; durable: boolean }> {
  const token = localStorage.getItem(deviceTokenKey);
  if (!token) throw new Error("Choose a display name before accepting an invitation.");
  const response = await fetch("/api/social/party-invites/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": token },
    body: JSON.stringify({ code }),
  });
  const payload = await response.json() as { inviter?: { publicPlayerId: string; displayName: string }; durable?: boolean; error?: string };
  if (!response.ok || !payload.inviter) throw new Error(payload.error ?? "Party invitation could not be accepted.");
  return { inviter: payload.inviter, durable: payload.durable === true };
}

export function partyInviteCodeFromHash(hash: string): string | null {
  const match = /^#\/party\/([A-Za-z0-9_-]{16,128})$/.exec(hash);
  return match?.[1] ?? null;
}

export function resetIdentityTestState(): void {
  accountTokenInFlight = null;
}
