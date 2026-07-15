export const playerNameKey = "dotbot.playerName";
export const deviceTokenKey = "dotbot.deviceToken";

export async function ensureAccountToken(name: string): Promise<string> {
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
