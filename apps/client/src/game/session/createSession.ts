import type { GameSession } from "./GameSession";
import { LocalSession, type LocalSessionOptions } from "./LocalSession";
import { NetSession, type NetSessionOptions } from "./NetSession";

export function createSession(kind: "local", options: LocalSessionOptions): GameSession;
export function createSession(kind: "net", options: NetSessionOptions): GameSession;
export function createSession(kind: "local" | "net", options: LocalSessionOptions | NetSessionOptions): GameSession {
  switch (kind) {
    case "local":
      return new LocalSession(options as LocalSessionOptions);
    case "net":
      return new NetSession(options as NetSessionOptions);
  }
}
