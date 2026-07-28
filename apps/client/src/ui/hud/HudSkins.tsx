import { useState } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import type { DotBotEntity, Item } from "@dotbot/game/types";
import { BayBank, RunReadout, TouchControls } from "./Overlay";

/**
 * Four takes on glass, over the world's ground.
 *
 * Round one offered four materials — plate, bare, glass, instrument — and glass won
 * outright; the other three were written off. Worth recording why the shipped one lost,
 * because the reason was mine: I had rebased the panels onto the world's own INK tones,
 * and the world IS a pale plate lit from the north, so "made of the world's material"
 * and "looks printed on paper" turned out to be the same constraint. Nobody asked for
 * it, and it capped how good the overlay could get.
 *
 * So this round stays inside glass and varies what is still genuinely open within it:
 * how much world comes through, whether a pane has an outline or a lit rim, how much it
 * floats, and where colour is allowed to carry meaning. A is byte-for-byte the winner,
 * kept as the baseline to judge the other three against.
 *
 * Nothing here restyles a component. Every variant is a wrapper class, so whichever one
 * is picked is a stylesheet change and not a rewrite.
 */

export type SkinId = "base" | "deep" | "rim" | "accent";

export const SKINS: Array<{ id: SkinId; name: string; note: string }> = [
  {
    id: "base",
    name: "A · Glass",
    note: "The one you picked, unchanged. Hairline edge, blur 10, 55% pane. Here as the baseline.",
  },
  {
    id: "deep",
    name: "B · Deep",
    note: "Heavier pane, no outline at all, softer corners, and a drop shadow so it floats in FRONT of the world instead of sitting on it. Less world through the glass, more separation.",
  },
  {
    id: "rim",
    name: "C · Rimlit",
    note: "The only one that obeys the world's own lighting rule: no outline, but each pane catches the north-west light on its top edge and shades at the bottom. Reads as a real sheet with thickness, lit by the same sun as the building under it.",
  },
  {
    id: "accent",
    name: "D · Accent",
    note: "A's restraint, with the squad cyan let in on exactly what is live — slot numbers, the hold count, the labels. The question is whether the colour reads as information or as decoration.",
  },
];

/** A stand-in carrier: three bays, two of them filled, two items in the hold. */
const health: Item = { kind: "powerup", type: "health" };
const overcharge: Item = { kind: "powerup", type: "dashOvercharge" };
const plan: Item = { kind: "blueprint", blueprintId: "lot6-forklift" };

/**
 * Only the fields the bay bank reads. Cast rather than spelled out in full because a
 * complete `DotBotEntity` here would be twenty-odd irrelevant literals to maintain,
 * and this surface is dev-only.
 */
const carrier = {
  id: "player",
  bays: [health, overcharge, null],
  hold: [plan, health],
} as unknown as DotBotEntity;

/** Held off-centre, so the knob is somewhere other than the middle in every option. */
const joystick = { active: true, knob: { x: 13, y: -9 } } as never;

function Stage({ skin }: { skin: SkinId }) {
  const noop = () => {};
  return (
    <div className={`skin-stage skin-glass skin-v-${skin}`}>
      <div className="skin-ground" aria-hidden="true" />
      <RunReadout remainingRunMs={252_000} rivals={7} onSettings={noop}>
        <button type="button" className="restart-button">↻ Restart run</button>
      </RunReadout>
      <BayBank
        player={carrier}
        slots={defaultGameConfig.baySlots}
        holdSlots={defaultGameConfig.holdSlots}
        onUse={noop}
        onSwapRequest={noop}
      />
      <TouchControls
        joystick={joystick}
        joystickHandlers={{}}
        onDash={noop}
        dashProgress={0.62}
        dashDisabled={false}
      />
    </div>
  );
}

export function HudSkins() {
  const [solo, setSolo] = useState<SkinId | null>(null);
  const shown = solo ? SKINS.filter((skin) => skin.id === solo) : SKINS;

  return (
    <main className="hud-skins">
      <header>
        <h1>Glass · four ways</h1>
        <p>
          Same three pieces in each — the run readout and its buttons, the three clickable
          powerups, and the controls. <strong>A is the one you picked, unchanged.</strong> Each
          sits over a light interior slab above and dark asphalt below, because a dark overlay
          fails on the pale half and reads fine on the other.
        </p>
        <nav aria-label="Show one option">
          <button type="button" aria-pressed={solo === null} onClick={() => setSolo(null)}>all four</button>
          {SKINS.map((skin) => (
            <button
              key={skin.id}
              type="button"
              aria-pressed={solo === skin.id}
              onClick={() => setSolo(skin.id)}
            >{skin.name}</button>
          ))}
        </nav>
      </header>
      <div className={`skin-grid ${solo ? "solo" : ""}`}>
        {shown.map((skin) => (
          <section key={skin.id} aria-label={skin.name}>
            <h2>{skin.name}</h2>
            <Stage skin={skin.id} />
            <p>{skin.note}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
