import type { MapDocument } from "../types";
import authoredPixelCityMap from "./authored/pixel-city.json";

/** Stable floor identifiers used by gameplay tests and authored contracts. */
export const PIXEL_CITY_FLOORS = {
  shop: "pixel-city:shop:GROUND",
  shopUpper: "pixel-city:shop:F1",
  shopStorage: "pixel-city:shop:F2",
  shopRepair: "pixel-city:shop:F3",
  shopCore: "pixel-city:shop:F4",
  blue: "pixel-city:blue:GROUND",
  blueUpper: "pixel-city:blue:F1",
  red: "pixel-city:red:GROUND",
  redUpper: "pixel-city:red:F1",
} as const;

/**
 * The production Pixel City document is saved directly by Map Studio.
 * Keep behavior in the renderer/simulation and content in the JSON document;
 * this makes editor saves immediately authoritative for gameplay and tests.
 */
export const pixelCityBlockMap = authoredPixelCityMap as MapDocument;
