import { useState } from "react";
import { defaultGameConfig } from "@dotbot/game/config";
import type { DotBotEntity, Item } from "@dotbot/game/types";
import { BayBank, RunReadout, TouchControls } from "./Overlay";
import { DEFAULT_HUD_SKIN, HUD_SKINS, hudSkinClass, type HudSkinId } from "./overlaySkins";

/**
 * Every overlay skin, side by side over the world's ground.
 *
 * Round one offered four materials — plate, bare, glass, instrument — and glass won
 * outright; the other three were written off. Worth recording why the SHIPPED one lost,
 * because the reason was mine: I had rebased the panels onto the world's own INK tones,
 * and the world IS a pale plate lit from the north, so "made of the world's material"
 * and "looks printed on paper" turned out to be the same constraint. Nobody asked for
 * it, and it capped how good the overlay could get.
 *
 * Round two stayed inside glass and varied what was still open within it: how much world
 * comes through, outline versus lit rim, how much the pane floats, and where colour is
 * allowed to mean something. Deep ships. The other three are kept rather than deleted
 * because a player is meant to be able to choose between them later, which turns this
 * page from a dev lab into the preview for that setting.
 *
 * Nothing here restyles a component. Every skin is a wrapper class, so the choice is a
 * class name and never a rewrite.
 */

/**
 * The list is `HUD_SKINS`, not a copy of it.
 *
 * This page existed to choose between four candidates; one was chosen and the rest were
 * kept for a future player-facing picker, so the four are now a real theme list that
 * ships. Restating them here would be a second place for a skin to exist, and the whole
 * point of the wrapper-class design is that there is exactly one.
 */
export type SkinId = HudSkinId;

export const SKINS = HUD_SKINS;

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
    <div className={`skin-stage ${hudSkinClass(skin)}`}>
      <div className="skin-ground" aria-hidden="true" />
      <RunReadout remainingRunMs={252_000} rivals={7} onSettings={noop}>
        <button type="button" className="restart-button">↻ Restart run</button>
      </RunReadout>
      <BayBank
        player={carrier}
        slots={defaultGameConfig.baySlots}
        holdSlots={defaultGameConfig.holdSlots}
        onUse={noop}
        onOpen={noop}
        open={false}
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
        <h1>Overlay skins</h1>
        <p>
          Same three pieces in each — the run readout and its buttons, the three clickable
          powerups, and the controls. <strong>Deep is what ships;</strong> the rest are here
          for the style setting. Each sits over a light interior slab above and dark asphalt
          below, because a dark overlay fails on the pale half and reads fine on the other.
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
            <h2>{skin.name}{skin.id === DEFAULT_HUD_SKIN ? " · ships" : ""}</h2>
            <Stage skin={skin.id} />
            <p>{skin.note}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
