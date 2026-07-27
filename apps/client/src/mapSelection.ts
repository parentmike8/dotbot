import { cornerShopMap } from "@dotbot/game/content/cornerShop";
import { downtownMap } from "@dotbot/game/content/downtown";
import { pixelCityBlockMap } from "@dotbot/game/content/pixelCityBlock";
import { quaysideMap } from "@dotbot/game/content/quaysideDepot";
import type { MapDocument } from "@dotbot/game/types";

const THEMES = new Set(["plan", "pixel-city", "lit-model"]);

export function selectMapDocument(search: string): MapDocument {
  const params = new URLSearchParams(search);
  const requested = params.get("map");
  const base = requested === "corner-shop"
    ? cornerShopMap
    : requested === "pixel-city"
      ? pixelCityBlockMap
      : requested === "quayside"
        ? quaysideMap
        : downtownMap;

  /**
   * `?theme=` overrides the map's authored visual language, for side-by-side
   * review. Downtown ships `lit-model`; `?theme=plan` brings back the drafting
   * notation it replaced.
   */
  const theme = params.get("theme");
  if (theme && THEMES.has(theme)) {
    return { ...base, visualTheme: theme as NonNullable<MapDocument["visualTheme"]> };
  }
  return base;
}
