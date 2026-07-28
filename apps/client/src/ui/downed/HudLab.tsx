import { useState } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import { downtownMap } from "@dotbot/game/content/downtown";
import type { CoverageSnapshot, DotBotEntity, Item } from "@dotbot/game/types";
import { bodyPrompt, downedSelf, type BodyPrompt, type DownedSelf } from "./prompt";
import { BodyPromptView, DownedSelfView } from "./DownedPrompts";
import { BayBank, FloorRail, HoldPicker, RunReadout, SettingsPanel } from "../hud/Overlay";
import { floorColumn } from "../hud/hud";
import { hudSkinClass } from "../hud/overlaySkins";
import { FeedbackControls } from "../FeedbackControls";

/**
 * `?hud` — the overlay against fixed states, with no game running.
 *
 * The prompts that matter most are the ones hardest to reach: you have to be
 * downed, or standing on a body somebody has already searched. Reviewing those by
 * playing until they happen is how they went unreviewed long enough to drift out
 * of the world's drawing language entirely.
 *
 * The corner readouts are here for the same reason, one step removed: they are easy
 * to reach in play and impossible to *judge* there, because judging a panel means
 * looking at its edge and its tone against the ground behind it while nothing moves.
 * The restyle onto the world's plate tones was reviewed here.
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
    moving: false,
    maxShields: 3,
    shields: 3,
    shieldSegments: [1, 1, 1],
    bays: [null, null, null],
    hold: [],
    carriedCount: 0,
    searched: false,
    pleaded: false,
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

/** The floor rail against a real building, so the column is the authored stack. */
const tower = downtownMap.buildings.find((building) => building.floors.length > 2)!;
const towerFloor = tower.floors.find((floor) => floor.label === "F2") ?? tower.floors[0];
const column = floorColumn(downtownMap, towerFloor.id, towerFloor.dotSpawns[0].position);

const carrying: Item[] = [blueprint, health];

export function HudLab() {
  const [selected, setSelected] = useState(0);
  const [corners, setCorners] = useState(true);
  const [panel, setPanel] = useState<"none" | "hold" | "settings">("none");
  const pose = POSES[selected];
  const { prompt, self } = poseState(pose);
  const noop = () => {};
  const feedback = { sound: true, haptics: false, reducedMotion: false };

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
      <nav aria-label="Surfaces">
        <button type="button" aria-pressed={corners} onClick={() => setCorners((on) => !on)}>corners</button>
        <button type="button" aria-pressed={panel === "hold"} onClick={() => setPanel(panel === "hold" ? "none" : "hold")}>hold picker</button>
        <button type="button" aria-pressed={panel === "settings"} onClick={() => setPanel(panel === "settings" ? "none" : "settings")}>settings</button>
      </nav>
      <p className="hud-lab-note">{pose.note}</p>
      {/* The stage carries the shipping skin, or this lab reviews an overlay nobody sees. */}
      <div className={`hud-lab-stage ${hudSkinClass()}`}>
        {corners ? (
          <>
            <RunReadout remainingRunMs={252_000} rivals={7} onSettings={() => setPanel("settings")}>
              <button type="button" className="restart-button">↻ Restart run</button>
            </RunReadout>
            <BayBank
              player={actor({ bays: [health, blueprint, null], hold: carrying })}
              slots={defaultGameConfig.baySlots}
              holdSlots={defaultGameConfig.holdSlots}
              onUse={noop}
              onSwapRequest={() => setPanel("hold")}
            />
            {column ? <FloorRail column={column} /> : null}
          </>
        ) : null}
        {panel === "hold" ? (
          <HoldPicker bay={0} hold={carrying} onChoose={noop} onClose={() => setPanel("none")} />
        ) : null}
        {panel === "settings" ? (
          <SettingsPanel onClose={() => setPanel("none")}>
            <FeedbackControls
              preferences={feedback}
              audioStatus="ready"
              onToggleSound={noop}
              onToggleHaptics={noop}
              onToggleReducedMotion={noop}
              onTestSound={noop}
            />
          </SettingsPanel>
        ) : null}
        {self ? <DownedSelfView self={self} onPlea={noop} onLeave={noop} /> : null}
        <BodyPromptView prompt={prompt} onVerb={noop} onTake={noop} onTakeAll={noop} />
      </div>
    </main>
  );
}
