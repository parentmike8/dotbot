import type { GameSession } from "./GameSession";
import { LocalSession, type LocalSessionOptions } from "./LocalSession";

export function createSession(kind: "local", options: LocalSessionOptions): GameSession {
  switch (kind) {
    case "local":
      return new LocalSession(options);
  }
}
