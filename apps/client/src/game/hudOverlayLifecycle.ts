export type HudOverlays = {
  inventory: boolean;
  settings: boolean;
  worldMap: boolean;
  replay: boolean;
  reconnecting: boolean;
};

export type HudOverlayEvent =
  | "openInventory" | "closeInventory"
  | "openSettings" | "closeSettings"
  | "openWorldMap" | "closeWorldMap"
  | "startReplay" | "endReplay"
  | "startReconnect" | "endReconnect";

export const initialHudOverlays: HudOverlays = {
  inventory: false,
  settings: false,
  worldMap: false,
  replay: false,
  reconnecting: false,
};

export function transitionHudOverlay(state: HudOverlays, event: HudOverlayEvent): HudOverlays {
  if (
    (state.replay || state.reconnecting)
    && (event === "openInventory" || event === "openSettings" || event === "openWorldMap")
  ) return state;

  switch (event) {
    case "openInventory":
      return { ...state, inventory: true, settings: false, worldMap: false };
    case "openSettings":
      return { ...state, inventory: false, settings: true, worldMap: false };
    case "openWorldMap":
      return { ...state, inventory: false, settings: false, worldMap: true };
    case "closeInventory":
      return { ...state, inventory: false };
    case "closeSettings":
      return { ...state, settings: false };
    case "closeWorldMap":
      return { ...state, worldMap: false };
    case "startReplay":
      return { ...initialHudOverlays, replay: true };
    case "endReplay":
      return { ...state, replay: false };
    case "startReconnect":
      return { ...initialHudOverlays, reconnecting: true };
    case "endReconnect":
      return { ...state, reconnecting: false };
  }
}
