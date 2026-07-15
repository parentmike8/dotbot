import { useEffect, useRef, useState, type FormEvent } from "react";
import { LOBBY_SQUADS } from "@dotbot/protocol";
import type { LobbyMember, LobbySquadId, WireItemCode } from "@dotbot/protocol";
import { NetSession } from "../../game/session/NetSession";
import { NetGameView } from "./NetGameView";
import "./lobby.css";
import { deviceTokenKey as tokenKey, ensureAccountToken, playerNameKey as nameKey } from "../identity";
import { inviteUrl, lobbyRouteFromHash } from "./lobbyRoute";

type LobbyState = {
  roomCode: string;
  members: LobbyMember[];
  hostId: string;
  playerId: string;
  locked: boolean;
};

type Profile = {
  name: string;
  stash: Array<{ itemType: WireItemCode; qty: number }>;
  learnedBlueprints: string[];
  recentManifests: Array<{
    roomCode: string;
    outcome: string;
    keptItems: WireItemCode[];
    lostItems: WireItemCode[];
    learnedBlueprints: string[];
    endedAt: string | null;
  }>;
};

type LobbyAppProps = {
  embedded?: boolean;
  onReturnToBase?: () => void;
};

export function LobbyApp({ embedded = false, onReturnToBase }: LobbyAppProps = {}) {
  const route = lobbyRouteFromHash(window.location.hash);
  const routeCode = route.roomCode;
  const [name, setName] = useState(() => localStorage.getItem(nameKey) ?? "");
  const [joinCode, setJoinCode] = useState(routeCode);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [session, setSession] = useState<NetSession | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const autoJoined = useRef(false);
  const returnToBase = () => {
    session?.dispose();
    onReturnToBase?.();
  };

  const refreshProfile = async (token = localStorage.getItem(tokenKey)) => {
    if (!token) return;
    try {
      const response = await fetch("/api/profile", { headers: { "x-device-token": token } });
      if (response.ok) setProfile(await response.json() as Profile);
    } catch {
      // Stateless/offline development keeps the lobby usable without profile data.
    }
  };

  const connect = async (code: string, preferredSquad?: LobbySquadId) => {
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Choose a display name first.");
      return;
    }
    localStorage.setItem(nameKey, cleanName);
    const token = await ensureAccountToken(cleanName);
    await refreshProfile(token);
    session?.dispose();
    setError("");
    const next = new NetSession({
      url: "/ws",
      roomCode: code,
      name: cleanName,
      token,
      preferredSquad,
      onLobby: (state) => {
        setLobby(state);
        setJoinCode(state.roomCode);
        window.history.replaceState(null, "", `/#/r/${state.roomCode}`);
      },
      onError: setError,
    });
    setSession(next);
    void next.start().then(() => setPlaying(true)).catch(() => undefined);
  };

  useEffect(() => {
    void refreshProfile();
    if (routeCode && name && !autoJoined.current) {
      autoJoined.current = true;
      void connect(routeCode, route.preferredSquad);
    }
  }, []);

  if (playing && session && lobby) {
    return (
      <NetGameView
        session={session}
        roomCode={lobby.roomCode}
        returnLabel={onReturnToBase ? "LEAVE TO BASE" : "RETURN TO LOBBY"}
        onReturnToLobby={() => {
          if (onReturnToBase) {
            returnToBase();
            return;
          }
          setPlaying(false);
          setSession(null);
          setLobby(null);
          window.history.replaceState(null, "", "/#/lobby");
          void refreshProfile();
        }}
      />
    );
  }

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!joinCode.trim()) {
      setError("Enter a four-character room code.");
      return;
    }
    connect(joinCode.trim().toUpperCase());
  };

  return (
    <main className={embedded ? "deployment-shell" : "lobby-shell"}>
      <section className="lobby-card" aria-label="DotBot multiplayer lobby">
        {embedded ? <button type="button" className="deployment-close" aria-label="Close deployment" onClick={returnToBase}>×</button> : null}
        <header>
          <span className="lobby-kicker">Deployment</span>
          <h1>{lobby ? `Room ${lobby.roomCode}` : "Deploy."}</h1>
          <p>{lobby ? "Choose a squad before the host locks deployment." : "Create a room or join one with its field code."}</p>
        </header>

        {profile ? <ProfileSummary profile={profile} /> : null}

        {!lobby ? (
          <>
            <label className="lobby-field">
              <span>Your name</span>
              <input value={name} maxLength={24} autoComplete="nickname" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="lobby-actions">
              <button type="button" className="lobby-primary" onClick={() => void connect("")}>Create room</button>
              <span className="lobby-or">or</span>
              <form onSubmit={submitJoin}>
                <input
                  aria-label="Room code"
                  value={joinCode}
                  maxLength={4}
                  placeholder="CODE"
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))}
                />
                <button type="submit">Join</button>
              </form>
            </div>
          </>
        ) : (
          <>
            <div className="lobby-squads" aria-label="Squad formation">
              {LOBBY_SQUADS.map((squadId) => {
                const members = lobby.members.filter((member) => member.squadId === squadId);
                const isCurrent = members.some((member) => member.playerId === lobby.playerId);
                return (
                  <section key={squadId} className={isCurrent ? "lobby-squad is-current" : "lobby-squad"}>
                    <header>
                      <strong>{squadName(squadId)}</strong>
                      <span>{members.length}/3</span>
                    </header>
                    <ol>
                      {members.map((member) => (
                        <li key={member.playerId}>
                          <span>{member.name}</span>
                          {member.playerId === lobby.hostId ? <em>Host</em> : null}
                        </li>
                      ))}
                      {members.length === 1 ? <li className="lobby-ai"><span>AI WINGMATE AT START</span></li> : null}
                    </ol>
                    <button type="button" disabled={lobby.locked || isCurrent || members.length >= 3} onClick={() => session?.requestSquad(squadId)}>
                      {isCurrent ? "CURRENT SQUAD" : members.length >= 3 ? "SQUAD FULL" : "JOIN SQUAD"}
                    </button>
                    <button type="button" disabled={lobby.locked} onClick={() => void copyInvite(lobby.roomCode, squadId, setError)}>COPY INVITE</button>
                  </section>
                );
              })}
            </div>
            {lobby.playerId === lobby.hostId ? (
              <button type="button" className="lobby-primary lobby-start" disabled={lobby.locked} onClick={() => session?.requestStartMatch()}>
                {lobby.locked ? "SQUADS LOCKED" : "Start"}
              </button>
            ) : <p className="lobby-waiting">Waiting for the host…</p>}
          </>
        )}
        {error ? <p className="lobby-error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function squadName(squadId: LobbySquadId): string {
  return squadId === "crew-3" ? "CREW 3" : squadId.toUpperCase();
}

async function copyInvite(roomCode: string, squadId: LobbySquadId, setError: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl(window.location.origin, roomCode, squadId));
    setError(`INVITE COPIED · ${squadName(squadId)}`);
  } catch {
    setError("COPY FAILED — SHARE THE ROOM CODE.");
  }
}

function ProfileSummary({ profile }: { profile: Profile }) {
  return (
    <section className="lobby-profile" aria-label="Player stash and recent runs">
      <strong>STASH</strong>
      {profile.stash.length > 0 ? (
        <ul className="lobby-stash-items">
          {profile.stash.map((entry) => <li key={entry.itemType}><span>{wireItemGlyph(entry.itemType)} {wireItemName(entry.itemType)}</span><b>×{entry.qty}</b></li>)}
        </ul>
      ) : <p>Empty</p>}
      <small>Withdrawals unlock at the Base bay console.</small>
      <h2>Learned</h2>
      {profile.learnedBlueprints.length > 0
        ? <p className="lobby-learned">{profile.learnedBlueprints.map((id) => `${id} blueprint`).join(" · ")}</p>
        : <p>None yet.</p>}
      <h2>Recent runs</h2>
      {profile.recentManifests.length > 0 ? (
        <ol>
          {profile.recentManifests.map((manifest, index) => (
            <li key={`${manifest.roomCode}-${manifest.endedAt ?? "live"}-${index}`}>
              <span>{manifest.outcome}</span>
              <b>Kept {manifest.keptItems.length}</b>
            </li>
          ))}
        </ol>
      ) : <p>No manifests yet.</p>}
    </section>
  );
}

function wireItemGlyph(code: WireItemCode): string {
  return code === "h" ? "+" : code === "r" ? "◎" : code === "d" ? "›" : code === "i" ? "◌" : "⌑";
}

function wireItemName(code: WireItemCode): string {
  if (code.startsWith("b:")) return `${code.slice(2)} fragment`;
  switch (code) {
    case "h": return "Health";
    case "r": return "Radar";
    case "d": return "Dash overcharge";
    case "i": return "Incognito";
    default: return code;
  }
}
