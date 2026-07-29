import { describe, expect, it } from "vitest";
import type { SimEvent } from "@dotbot/game/types";
import {
  CLICK_PING_KIND,
  collectPings,
  markAge,
  MAX_LIVE_PINGS,
  PING_LABEL,
  PING_TTL_MS,
  type LiveMark,
} from "./pings";

/**
 * Squad marks, and the three rules in them worth pinning.
 *
 * The interaction itself — left-click fires the last type, right-click picks one and fires
 * it — cannot be exercised in a headless suite, so the parts with rules in them live in pure
 * functions and are tested here. What is left untested is the binding, and that is stated
 * rather than implied.
 */

const ping = (id: string, over: Partial<Extract<SimEvent, { type: "pinged" }>> = {}): SimEvent => ({
  type: "pinged",
  botId: "player",
  squadId: "alpha",
  pingId: id,
  kind: "here",
  position: { x: 100, y: 200 },
  floorId: "outdoor",
  ...over,
});

describe("collectPings", () => {
  it("takes a mark from an event", () => {
    const marks = collectPings([], [ping("p1", { kind: "enemy" })], 1_000);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ id: "p1", kind: "enemy", botId: "player" });
    expect(marks[0].placedAtMs).toBe(1_000);
  });

  it("ignores everything that is not a ping", () => {
    const noise: SimEvent[] = [
      { type: "downed", botId: "a" },
      { type: "dotCaptured", botId: "a", dotId: "d1" },
    ];
    expect(collectPings([], noise, 0)).toEqual([]);
  });

  it("drops a mark once its lifetime is up", () => {
    const marks = collectPings([], [ping("p1")], 0);
    expect(collectPings(marks, [], PING_TTL_MS - 1)).toHaveLength(1);
    expect(collectPings(marks, [], PING_TTL_MS)).toHaveLength(0);
  });

  it("does not duplicate a mark whose event arrives twice", () => {
    /**
     * Not hypothetical. Input frames ship redundantly across datagrams so a dropped packet
     * cannot lose a one-shot press, and a reconnect can replay a frame — so the same
     * `pinged` event genuinely can be seen more than once. Appending would stack marks on
     * one spot and eat the cap with copies of a single click.
     */
    const once = collectPings([], [ping("p1")], 0);
    const twice = collectPings(once, [ping("p1")], 30);
    expect(twice).toHaveLength(1);
    // And the repeat refreshes it rather than being ignored outright.
    expect(twice[0].placedAtMs).toBe(30);
  });

  it("keeps the newest when the cap is reached, not the first", () => {
    /**
     * The direction matters. Refusing a new mark because four are up means a player clicks,
     * sees nothing, and has no way to know why — whereas dropping the oldest costs a mark
     * that is by definition carrying the least current information.
     */
    let marks: LiveMark[] = [];
    for (let i = 0; i < MAX_LIVE_PINGS + 3; i += 1) {
      marks = collectPings(marks, [ping(`p${i}`)], i * 10);
    }
    expect(marks).toHaveLength(MAX_LIVE_PINGS);
    expect(marks.map((mark) => mark.id)).toContain(`p${MAX_LIVE_PINGS + 2}`);
    expect(marks.map((mark) => mark.id)).not.toContain("p0");
  });

  it("orders newest first", () => {
    let marks = collectPings([], [ping("old")], 0);
    marks = collectPings(marks, [ping("new")], 500);
    expect(marks[0].id).toBe("new");
  });

  it("copies the position rather than aliasing the event's", () => {
    // The event objects come off the wire and are reused between frames in some paths;
    // holding a reference would let a mark move after it was placed.
    const event = ping("p1");
    const marks = collectPings([], [event], 0);
    (event as { position: { x: number; y: number } }).position.x = 9_999;
    expect(marks[0].position.x).toBe(100);
  });
});

describe("markAge", () => {
  it("runs 0 to 1 across the lifetime and clamps outside it", () => {
    const mark = collectPings([], [ping("p1")], 0)[0];
    expect(markAge(mark, 0)).toBe(0);
    expect(markAge(mark, PING_TTL_MS / 2)).toBeCloseTo(0.5, 6);
    expect(markAge(mark, PING_TTL_MS)).toBe(1);
    expect(markAge(mark, PING_TTL_MS * 4)).toBe(1);
    expect(markAge(mark, -500)).toBe(0);
  });
});

describe("choosing a type", () => {
  it("makes a plain click always mean HERE, with no sticky default", () => {
    /**
     * A constant rather than state, deliberately. A sticky "last picked" default means you
     * choose "enemy" once in a fight and every casual click for the next ten minutes cries
     * wolf — and the player has no indicator telling them which type is armed.
     */
    expect(CLICK_PING_KIND).toBe("here");
  });

  it("labels every kind in plain words", () => {
    // The standing rule for anything the player reads: no invented terminology.
    for (const [kind, label] of Object.entries(PING_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).toBe(label[0].toUpperCase() + label.slice(1).toLowerCase());
      expect(kind).toBe(kind.toLowerCase());
    }
  });
});
