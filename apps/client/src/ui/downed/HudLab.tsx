import { useState } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import type { CoverageSnapshot, DotBotEntity, Item } from "@dotbot/game/types";
import { bodyPrompt, downedSelf, type BodyPrompt, type DownedSelf } from "./prompt";
import { BodyPromptView, DownedSelfView } from "./DownedPrompts";

/**
 * `?hud` — the overlay against fixed states, with no game running.
 *
 * The prompts that matter most are the ones hardest to reach: you have to be
 * downed, or standing on a body somebody has already searched. Reviewing those by
 * playing until they happen is how they went unreviewed long enough to drift out
 * of the world's drawing language entirely.
 *
 * Dev-only. Nothing here is a game surface — every state is a literal.
 */

const health: Item = { kind: "powerup", type: "health" };
const radar: Item = { kind: "powerup", type: "radar" };
const mine: Item = { kind: "mine" };
const blueprint: Item = { kind: "blueprint", blueprintId: "cot" };

function actor(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id: "player",
    name: "You",
    squadId: "alpha",
    isAmbient: false,
    color: "#111",
    position: { x: 100, y: 100 },
    radius: defaultGameConfig.botRadius,
    state: "alive",
    floorId: "outdoor",
    facing: 0,
    maxShields: 3,
    shields: 3,
    shieldSegments: [1, 1, 1],
    bays: [null, null, null],
    hold: [],
    carriedCount: 0,
    searched: false,
    radarActiveMs: 0,
    radarPings: [],
    dashOverchargeCharges: 0,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}

const rival = (overrides: Partial<DotBotEntity> = {}) => actor({
  id: "rival", name: "Ochre", squadId: "rival-1", state: "downed", shields: 0, shieldSegments: [0, 0, 0], ...overrides,
});

type Pose = {
  name: string;
  note: string;
  bots: DotBotEntity[];
  coverages?: CoverageSnapshot[];
  spectating?: DotBotEntity | null;
  lastPleaAtMs?: number | null;
};

const POSES: Pose[] = [
  {
    name: "body · closed",
    note: "A rival body underfoot, never searched. Both verbs are real.",
    bots: [actor(), rival({ bays: [health, radar, mine], carriedCount: 3 })],
  },
  {
    name: "body · empty",
    note: "Nothing on it. Searching costs three seconds for nothing, and the prompt says so.",
    bots: [actor(), rival({ carriedCount: 0 })],
  },
  {
    name: "body · searching",
    note: "Mid-channel. The ring at the body counts; the overlay only names the verb.",
    bots: [actor(), rival({ bays: [health, radar, mine], carriedCount: 3 })],
    coverages: [{ kind: "loot", actorId: "player", targetId: "rival", progressMs: 1_400, durationMs: 3_000 }],
  },
  {
    name: "body · open",
    note: "Searched. Tap a mark to take one, F to take everything that fits.",
    bots: [
      actor(),
      rival({ searched: true, bays: [health, radar, mine], hold: [blueprint], carriedCount: 4 }),
    ],
  },
  {
    name: "body · open, no room",
    note: "Every bay and every hold slot full. Nothing is takeable and the prompt does not pretend.",
    bots: [
      actor({ bays: [health, health, health], hold: Array.from({ length: defaultGameConfig.holdSlots }, () => radar) }),
      rival({ searched: true, bays: [health, radar, null], carriedCount: 2 }),
    ],
  },
  {
    name: "body · stripped",
    note: "Open and empty. You can still pick them up.",
    bots: [actor(), rival({ searched: true, carriedCount: 0 })],
  },
  {
    name: "downed · squad up",
    note: "Two still standing, and you have one of their cameras.",
    bots: [
      actor({ state: "downed", shields: 0, shieldSegments: [0, 0, 0] }),
      actor({ id: "mate-1", name: "Indigo" }),
      actor({ id: "mate-2", name: "Sky" }),
    ],
    spectating: actor({ id: "mate-1", name: "Indigo" }),
  },
  {
    name: "downed · plea cooling",
    note: "The cooldown comes from the authoritative plea event, not from the button press.",
    bots: [actor({ state: "downed", shields: 0, shieldSegments: [0, 0, 0] }), actor({ id: "mate-1", name: "Indigo" })],
    spectating: actor({ id: "mate-1", name: "Indigo" }),
    lastPleaAtMs: 26_500,
  },
  {
    name: "downed · alone",
    note: "Nobody left. The camera has fallen back to your own body, where you can still plea.",
    bots: [actor({ state: "downed", shields: 0, shieldSegments: [0, 0, 0] })],
  },
  {
    name: "downed · being picked up",
    note: "Somebody is on you. No buttons: there is nothing left to decide.",
    bots: [actor({ state: "downed", shields: 0, shieldSegments: [0, 0, 0] }), actor({ id: "mate-1", name: "Indigo" })],
    coverages: [{ kind: "revive", actorId: "mate-1", targetId: "player", progressMs: 900, durationMs: 2_000 }],
  },
];

function poseState(pose: Pose): { prompt: BodyPrompt; self: DownedSelf | null } {
  const coverages = pose.coverages ?? [];
  return {
    prompt: bodyPrompt({ viewer: pose.bots[0], bots: pose.bots, coverages, config: defaultGameConfig }),
    self: downedSelf({
      viewer: pose.bots[0],
      bots: pose.bots,
      coverages,
      spectating: pose.spectating ?? null,
      lastPleaAtMs: pose.lastPleaAtMs ?? null,
      nowMs: 30_000,
      pleaCooldownMs: defaultGameConfig.pleaCooldownMs,
    }),
  };
}

export function HudLab() {
  const [selected, setSelected] = useState(0);
  const pose = POSES[selected];
  const { prompt, self } = poseState(pose);
  const noop = () => {};

  return (
    <main className="hud-lab">
      <nav aria-label="Poses">
        {POSES.map((candidate, index) => (
          <button
            key={candidate.name}
            type="button"
            aria-pressed={index === selected}
            onClick={() => setSelected(index)}
          >{candidate.name}</button>
        ))}
      </nav>
      <p className="hud-lab-note">{pose.note}</p>
      <div className="hud-lab-stage">
        {self ? <DownedSelfView self={self} onPlea={noop} onLeave={noop} /> : null}
        <BodyPromptView prompt={prompt} onVerb={noop} onTake={noop} onTakeAll={noop} />
      </div>
    </main>
  );
}
