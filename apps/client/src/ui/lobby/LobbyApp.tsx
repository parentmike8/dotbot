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
  const autoJoined = useRef(false);

  const connect = (code: string) => {
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Choose a display name first.");
      return;
    }
    localStorage.setItem(nameKey, cleanName);
    session?.dispose();
    setError("");
    const next = new NetSession({
      url: "/ws",
      roomCode: code,
      name: cleanName,
      token: getOrCreateToken(),
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
    if (routeCode && name && !autoJoined.current) {
      autoJoined.current = true;
      connect(routeCode);
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

        {!lobby ? (
          <>
            <label className="lobby-field">
              <span>Your name</span>
              <input value={name} maxLength={24} autoComplete="nickname" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="lobby-actions">
              <button type="button" className="lobby-primary" onClick={() => connect("")}>Create room</button>
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

function getOrCreateToken(): string {
  const existing = localStorage.getItem(tokenKey);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(tokenKey, token);
  return token;
}
