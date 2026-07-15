import { describe, expect, it } from "vitest";
import { inviteUrl, lobbyRouteFromHash } from "./lobbyRoute";

describe("squad invite routes", () => {
  it("preselects a valid squad and ignores invalid preferences", () => {
    expect(lobbyRouteFromHash("#/r/ABCD?squad=bravo")).toEqual({ roomCode: "ABCD", preferredSquad: "bravo" });
    expect(lobbyRouteFromHash("#/r/ABCD?squad=unknown")).toEqual({ roomCode: "ABCD", preferredSquad: undefined });
    expect(lobbyRouteFromHash("#/lobby")).toEqual({ roomCode: "", preferredSquad: undefined });
  });

  it("builds the diegetic invite URL", () => {
    expect(inviteUrl("https://dot.bot", "QWER", "alpha")).toBe("https://dot.bot/#/r/QWER?squad=alpha");
  });
});
