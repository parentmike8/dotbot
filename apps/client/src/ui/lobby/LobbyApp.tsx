import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LobbyMember } from "@dotbot/protocol";
import { NetSession } from "../../game/session/NetSession";
import { NetGameView } from "./NetGameView";
import "./lobby.css";

type LobbyState = {
  roomCode: string;
  members: LobbyMember[];
  hostId: string;
  playerId: string;
};

type Profile = {
  name: string;
  holdDots: number;
  recentManifests: Array<{
    roomCode: string;
    outcome: string;
    keptDots: number;
    lostDots: number;
    endedAt: string | null;
  }>;
};

const nameKey = "dotbot.playerName";
const tokenKey = "dotbot.deviceToken";

export function LobbyApp() {
  const routeCode = roomCodeFromHash();
  const [name, setName] = useState(() => localStorage.getItem(nameKey) ?? "");
  const [joinCode, setJoinCode] = useState(routeCode);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [session, setSession] = useState<NetSession | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const autoJoined = useRef(false);

  const refreshProfile = async (token = localStorage.getItem(tokenKey)) => {
    if (!token) return;
    try {
      const response = await fetch("/api/profile", { headers: { "x-device-token": token } });
      if (response.ok) setProfile(await response.json() as Profile);
    } catch {
      // Stateless/offline development keeps the lobby usable without profile data.
    }
  };

  const connect = async (code: string) => {
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
      void connect(routeCode);
    }
  }, []);

  if (playing && session && lobby) {
    return (
      <NetGameView
        session={session}
        roomCode={lobby.roomCode}
        onReturnToLobby={() => {
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
    <main className="lobby-shell">
      <section className="lobby-card" aria-label="DotBot multiplayer lobby">
        <header>
          <span className="lobby-kicker">DotBot field office</span>
          <h1>{lobby ? `Room ${lobby.roomCode}` : "Fight together."}</h1>
          <p>{lobby ? "Squads are assigned. The host starts the run." : "Create a room or join one with its field code."}</p>
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
            <ol className="lobby-members">
              {lobby.members.map((member) => (
                <li key={member.playerId}>
                  <span>{member.name}</span>
                  <small>{member.squadId}</small>
                  {member.playerId === lobby.hostId ? <em>Host</em> : null}
                </li>
              ))}
            </ol>
            {lobby.playerId === lobby.hostId ? (
              <button type="button" className="lobby-primary lobby-start" onClick={() => session?.requestStartMatch()}>
                Start
              </button>
            ) : <p className="lobby-waiting">Waiting for the host…</p>}
          </>
        )}
        {error ? <p className="lobby-error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function roomCodeFromHash(): string {
  return window.location.hash.match(/^#\/r\/([A-Z2-9]{4})$/i)?.[1]?.toUpperCase() ?? "";
}

async function ensureAccountToken(name: string): Promise<string> {
  const existing = localStorage.getItem(tokenKey);
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
      localStorage.setItem(tokenKey, account.token);
      return account.token;
    }
  } catch {
    // Fall through to the legacy client token for stateless/offline mode.
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(tokenKey, token);
  return token;
}

function ProfileSummary({ profile }: { profile: Profile }) {
  return (
    <section className="lobby-profile" aria-label="Player hold and recent runs">
      <strong>Hold: {profile.holdDots} dots</strong>
      <small>Extracted dots bank here for later. Withdrawals arrive in M4.</small>
      <h2>Recent runs</h2>
      {profile.recentManifests.length > 0 ? (
        <ol>
          {profile.recentManifests.map((manifest, index) => (
            <li key={`${manifest.roomCode}-${manifest.endedAt ?? "live"}-${index}`}>
              <span>{manifest.outcome}</span>
              <b>Kept {manifest.keptDots}</b>
            </li>
          ))}
        </ol>
      ) : <p>No manifests yet.</p>}
    </section>
  );
}
