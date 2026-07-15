import { LOBBY_SQUADS, type LobbySquadId } from "@dotbot/protocol";

export type LobbyRoute = { roomCode: string; preferredSquad?: LobbySquadId };

export function lobbyRouteFromHash(hash: string): LobbyRoute {
  const match = hash.match(/^#\/r\/([A-Z2-9]{4})(?:\?squad=([a-z0-9-]+))?$/i);
  const candidate = match?.[2]?.toLowerCase();
  return {
    roomCode: match?.[1]?.toUpperCase() ?? "",
    preferredSquad: LOBBY_SQUADS.find((squad) => squad === candidate),
  };
}

export function inviteUrl(origin: string, roomCode: string, squadId: LobbySquadId): string {
  return `${origin}/#/r/${roomCode}?squad=${squadId}`;
}
