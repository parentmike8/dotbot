import { describe, expect, it } from "vitest";
import { initialHudOverlays, transitionHudOverlay } from "./hudOverlayLifecycle";

describe("HUD overlay lifecycle", () => {
  it("keeps inventory, settings, exterior map, replay, and reconnect mutually exclusive", () => {
    let state = transitionHudOverlay(initialHudOverlays, "openInventory");
    expect(state).toMatchObject({ inventory: true, settings: false, worldMap: false });

    state = transitionHudOverlay(state, "openWorldMap");
    expect(state).toMatchObject({ inventory: false, settings: false, worldMap: true });

    state = transitionHudOverlay(state, "openSettings");
    expect(state).toMatchObject({ inventory: false, settings: true, worldMap: false });

    state = transitionHudOverlay(state, "startReplay");
    expect(state).toEqual({
      inventory: false,
      settings: false,
      worldMap: false,
      replay: true,
      reconnecting: false,
    });
    expect(transitionHudOverlay(state, "openInventory")).toEqual(state);

    state = transitionHudOverlay(state, "startReconnect");
    expect(state).toEqual({
      inventory: false,
      settings: false,
      worldMap: false,
      replay: false,
      reconnecting: true,
    });
    expect(transitionHudOverlay(state, "openInventory")).toEqual(state);
  });
});
