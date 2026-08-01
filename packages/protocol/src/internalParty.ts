/**
 * Internal control-plane/AWS contract. These values are never a public client
 * payload even though the canonicalizer lives beside the wire protocol so the
 * two trusted services sign exactly the same bytes.
 */
export type TrustedPartyRosterMember = {
  playerId: string;
  name: string;
  loadoutRevision: number;
};

export type TrustedPartyRoster = {
  claimId: string;
  partyId: string;
  version: number;
  leaderPlayerId: string;
  requestingPlayerId: string;
  buildId: string;
  region: string;
  issuedAt: number;
  expiresAt: number;
  members: TrustedPartyRosterMember[];
};

export type TrustedPartyReservation = {
  claimId: string;
  partyId: string;
  version: number;
  playerId: string;
  memberPlayerIds: string[];
  memberLoadoutRevisions: Array<{ playerId: string; revision: number }>;
  arenaId: string;
  buildId: string;
  region: string;
  expiresAt: number;
};

const rosterKeys = [
  "claimId",
  "partyId",
  "version",
  "leaderPlayerId",
  "requestingPlayerId",
  "buildId",
  "region",
  "issuedAt",
  "expiresAt",
  "members",
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const partyPattern = /^(?:party-[a-f0-9]{32}|solo-[a-f0-9]{24})$/;
const metadataPattern = /^[a-zA-Z0-9._:-]+$/;
const arenaPattern = /^[A-HJ-NP-Z2-9]{4}$/;

export function parseTrustedPartyRoster(value: unknown): TrustedPartyRoster | null {
  if (!isRecord(value) || !hasOnlyKeys(value, rosterKeys)) return null;
  const claimId = stringValue(value.claimId);
  const partyId = stringValue(value.partyId);
  const leaderPlayerId = stringValue(value.leaderPlayerId);
  const requestingPlayerId = stringValue(value.requestingPlayerId);
  const buildId = stringValue(value.buildId);
  const region = stringValue(value.region);
  const version = value.version;
  const issuedAt = value.issuedAt;
  const expiresAt = value.expiresAt;
  if (!uuidPattern.test(claimId) || !partyPattern.test(partyId)
    || !uuidPattern.test(leaderPlayerId) || !uuidPattern.test(requestingPlayerId)
    || !safeMetadata(buildId, 64) || !safeMetadata(region, 64)
    || !Number.isSafeInteger(version) || (version as number) < 1
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
    || (expiresAt as number) <= (issuedAt as number)
    || (expiresAt as number) - (issuedAt as number) > 5 * 60_000
    || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 3) return null;

  const members: TrustedPartyRosterMember[] = [];
  for (const memberValue of value.members) {
    if (!isRecord(memberValue) || !hasOnlyKeys(memberValue, ["playerId", "name", "loadoutRevision"] as const)) return null;
    const playerId = stringValue(memberValue.playerId);
    const name = stringValue(memberValue.name);
    const loadoutRevision = memberValue.loadoutRevision;
    if (!uuidPattern.test(playerId) || name.length < 1 || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)
      || !Number.isSafeInteger(loadoutRevision) || (loadoutRevision as number) < 1) return null;
    members.push({ playerId: playerId.toLowerCase(), name, loadoutRevision: loadoutRevision as number });
  }
  members.sort((left, right) => left.playerId.localeCompare(right.playerId));
  if (new Set(members.map((member) => member.playerId)).size !== members.length) return null;
  const memberIds = new Set(members.map((member) => member.playerId));
  const normalizedLeader = leaderPlayerId.toLowerCase();
  const normalizedRequester = requestingPlayerId.toLowerCase();
  if (!memberIds.has(normalizedLeader) || !memberIds.has(normalizedRequester)) return null;

  return {
    claimId: claimId.toLowerCase(),
    partyId,
    version: version as number,
    leaderPlayerId: normalizedLeader,
    requestingPlayerId: normalizedRequester,
    buildId,
    region,
    issuedAt: issuedAt as number,
    expiresAt: expiresAt as number,
    members,
  };
}

export function canonicalTrustedPartyRoster(value: TrustedPartyRoster): string {
  const parsed = parseTrustedPartyRoster(value);
  if (!parsed) throw new Error("Invalid trusted party roster.");
  return JSON.stringify(parsed);
}

export function parseTrustedPartyReservation(value: unknown): TrustedPartyReservation | null {
  const keys = ["claimId", "partyId", "version", "playerId", "memberPlayerIds", "memberLoadoutRevisions", "arenaId", "buildId", "region", "expiresAt"] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  const claimId = stringValue(value.claimId);
  const partyId = stringValue(value.partyId);
  const playerId = stringValue(value.playerId).toLowerCase();
  const arenaId = stringValue(value.arenaId).toUpperCase();
  const buildId = stringValue(value.buildId);
  const region = stringValue(value.region);
  if (!uuidPattern.test(claimId) || !partyPattern.test(partyId) || !uuidPattern.test(playerId)
    || !arenaPattern.test(arenaId) || !safeMetadata(buildId, 64) || !safeMetadata(region, 64)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || !Number.isSafeInteger(value.expiresAt)
    || !Array.isArray(value.memberPlayerIds) || value.memberPlayerIds.length < 1 || value.memberPlayerIds.length > 3
    || !Array.isArray(value.memberLoadoutRevisions) || value.memberLoadoutRevisions.length !== value.memberPlayerIds.length) return null;
  const memberPlayerIds = value.memberPlayerIds.map((member) => stringValue(member).toLowerCase()).sort();
  if (memberPlayerIds.some((member) => !uuidPattern.test(member))
    || new Set(memberPlayerIds).size !== memberPlayerIds.length
    || !memberPlayerIds.includes(playerId)) return null;
  const memberLoadoutRevisions: Array<{ playerId: string; revision: number }> = [];
  for (const entry of value.memberLoadoutRevisions) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["playerId", "revision"] as const)) return null;
    const revisionPlayerId = stringValue(entry.playerId).toLowerCase();
    if (!uuidPattern.test(revisionPlayerId) || !Number.isSafeInteger(entry.revision) || (entry.revision as number) < 1) return null;
    memberLoadoutRevisions.push({ playerId: revisionPlayerId, revision: entry.revision as number });
  }
  memberLoadoutRevisions.sort((left, right) => left.playerId.localeCompare(right.playerId));
  if (new Set(memberLoadoutRevisions.map((entry) => entry.playerId)).size !== memberLoadoutRevisions.length
    || memberLoadoutRevisions.some((entry, index) => entry.playerId !== memberPlayerIds[index])) return null;
  return {
    claimId: claimId.toLowerCase(),
    partyId,
    version: value.version as number,
    playerId,
    memberPlayerIds,
    memberLoadoutRevisions,
    arenaId,
    buildId,
    region,
    expiresAt: value.expiresAt as number,
  };
}

export function canonicalTrustedPartyReservation(value: TrustedPartyReservation): string {
  const parsed = parseTrustedPartyReservation(value);
  if (!parsed) throw new Error("Invalid trusted party reservation.");
  return JSON.stringify(parsed);
}

function safeMetadata(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && metadataPattern.test(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys<T extends readonly string[]>(value: Record<string, unknown>, keys: T): boolean {
  const allowed = new Set<string>(keys);
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => allowed.has(key));
}
