import { describe, expect, it } from "vitest";
import { defaultGameConfig } from "./config";
import { downtownMap } from "./content/downtown";
import { assignSquadInsertions, squadPreference, validateInsertionMap } from "./insertion";
import type { InsertionPoint } from "./types";

const points: InsertionPoint[] = [
  { id: "a", name: "A", position: { x: 0, y: 0 } },
  { id: "b", name: "B", position: { x: 100, y: 0 } },
  { id: "c", name: "C", position: { x: 1_000, y: 0 } },
  { id: "d", name: "D", position: { x: 2_000, y: 0 } },
];

describe("insertion assignment", () => {
  it("lets the earliest joined member break a squad preference tie", () => {
    expect(squadPreference({ squadId: "alpha", members: [
      { playerId: "late", preference: "b", joinedAt: 20 },
      { playerId: "early", preference: "a", joinedAt: 10 },
    ] }, points)).toBe("a");
  });

  it("applies hard spacing before unanimous squad preferences", () => {
    const assignment = assignSquadInsertions({
      squads: [
        { squadId: "alpha", members: [{ playerId: "a1", preference: "a" }, { playerId: "a2", preference: "a" }] },
        { squadId: "bravo", members: [{ playerId: "b1", preference: "b" }, { playerId: "b2", preference: "b" }] },
      ],
      points,
      matchId: "spacing-first",
      minSpacing: 900,
    });
    expect(Math.hypot(
      assignment[0].point.position.x - assignment[1].point.position.x,
      assignment[0].point.position.y - assignment[1].point.position.y,
    )).toBeGreaterThanOrEqual(900);
    expect(assignment.map((entry) => entry.point.id)).not.toEqual(["a", "b"]);
  });

  it("honors a valid preference for roughly 80 percent of match seeds", () => {
    let hits = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const [assignment] = assignSquadInsertions({
        squads: [{ squadId: "alpha", members: [{ playerId: "p", preference: "a" }] }],
        points: points.slice(0, 3),
        matchId: `match-${index}`,
        minSpacing: 0,
      });
      if (assignment.point.id === "a") hits += 1;
    }
    expect(hits).toBeGreaterThanOrEqual(760);
    expect(hits).toBeLessThanOrEqual(840);
  });

  it("rejects fewer than squads plus two points and clears every Downtown squad footprint", () => {
    expect(() => validateInsertionMap({ ...downtownMap, insertionPoints: downtownMap.insertionPoints.slice(0, 4) }, 3, defaultGameConfig.botRadius))
      .toThrow(/squads \+ 2/);
    expect(() => validateInsertionMap(downtownMap, 3, defaultGameConfig.botRadius)).not.toThrow();
  });
});
