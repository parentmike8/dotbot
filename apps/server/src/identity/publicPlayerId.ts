import { randomBytes } from "node:crypto";

export const PUBLIC_PLAYER_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PUBLIC_PLAYER_ID_LENGTH = 8;

export type PublicPlayerIdFactory = () => string;

export function generatePublicPlayerId(bytes = randomBytes(PUBLIC_PLAYER_ID_LENGTH)): string {
  if (bytes.length < PUBLIC_PLAYER_ID_LENGTH) throw new Error("Public player ID entropy is too short.");
  return Array.from(bytes.subarray(0, PUBLIC_PLAYER_ID_LENGTH), (byte) => (
    PUBLIC_PLAYER_ID_ALPHABET[byte % PUBLIC_PLAYER_ID_ALPHABET.length]
  )).join("");
}

export function normalizePublicPlayerId(value: string): string | null {
  const normalized = value.replace(/-/g, "").trim().toUpperCase();
  return new RegExp(`^[${PUBLIC_PLAYER_ID_ALPHABET}]{${PUBLIC_PLAYER_ID_LENGTH}}$`).test(normalized)
    ? normalized
    : null;
}

export function formatPublicPlayerId(value: string): string {
  const normalized = normalizePublicPlayerId(value);
  if (!normalized) throw new Error("Invalid public player ID.");
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export async function allocateUniquePublicPlayerId<T>(
  attemptInsert: (normalizedPublicPlayerId: string) => Promise<T | null>,
  factory: PublicPlayerIdFactory = generatePublicPlayerId,
  maxAttempts = 16,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = normalizePublicPlayerId(factory());
    if (!candidate) throw new Error("Public player ID generator returned an invalid value.");
    const inserted = await attemptInsert(candidate);
    if (inserted !== null) return inserted;
  }
  throw new Error("Could not allocate a unique public player ID.");
}
