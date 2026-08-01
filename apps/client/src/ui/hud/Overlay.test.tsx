import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultGameConfig } from "@dotbot/game/config";
import type { DotBotEntity, Item } from "@dotbot/game/types";
import { BayBank, InventoryPanel } from "./Overlay";

const health: Item = { kind: "powerup", type: "health" };
const blueprint: Item = { kind: "blueprint", blueprintId: "shelf", sourceBuildingId: "lot6" };

function carrier(overrides: Partial<DotBotEntity> = {}): DotBotEntity {
  return {
    id: "player",
    name: "Player",
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
    bays: [health, null, null],
    hold: [blueprint],
    carriedCount: 2,
    searched: false,
    pleaded: false,
    radarActiveMs: 0,
    radarPings: [],
    dashOverchargeMs: 0,
    incognitoMs: 0,
    dashCooldownMs: 0,
    dashActiveMs: 0,
    invulnerabilityMs: 0,
    ...overrides,
  };
}

describe("inventory HUD", () => {
  it("keeps three bay actions and replaces per-bay swap controls with one Open control", () => {
    const markup = renderToStaticMarkup(
      <BayBank
        player={carrier()}
        slots={defaultGameConfig.baySlots}
        holdSlots={defaultGameConfig.holdSlots}
        onUse={() => {}}
        onOpen={() => {}}
        open={false}
      />,
    );
    expect(markup.match(/aria-label="Bay \d/g)).toHaveLength(3);
    expect(markup).toContain(">Open<");
    expect(markup).toContain("Hold <strong>1</strong>");
    expect(markup).not.toContain(">Swap<");
  });

  it("shows every bay and hold slot together, with downed dropping available and swapping disabled", () => {
    const markup = renderToStaticMarkup(
      <InventoryPanel
        player={carrier({ state: "downed", shields: 0, shieldSegments: [0, 0, 0] })}
        slots={defaultGameConfig.baySlots}
        holdSlots={defaultGameConfig.holdSlots}
        onUse={() => {}}
        onSwap={() => {}}
        onDrop={() => {}}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Inventory"');
    expect(markup).toContain('aria-label="Bay 3: empty"');
    expect(markup).toContain(`aria-label="Hold slot ${defaultGameConfig.holdSlots}: empty"`);
    expect(markup).toContain('aria-label="Drop Blueprint: shelf from hold slot 1"');
    expect(markup).toContain("Swap unavailable while downed");
  });
});
