import { Assets, Rectangle, Texture } from "pixi.js";
import type { Item, MapDocument } from "@dotbot/game/types";
import { dotItemFrameKey } from "./dotItemSprites";

type Frame = { x: number; y: number; w: number; h: number };
type Manifest = { frames: Record<string, Frame> };
type EditorAsset = { key: string; url: string; width: number; height: number };
type EditorManifest = { version: 1; assets: Record<string, EditorAsset> };

const CITY_PNG = "/assets/pixel-city/pixel-city.png";
const CITY_JSON = "/assets/pixel-city/pixel-city.json";
const DOTBOT_PNG = "/assets/pixel-city/dotbot.png";
const DOTBOT_JSON = "/assets/pixel-city/dotbot.json";
const DOTBOT_SHIELDS_PNG = "/assets/pixel-city/dotbot-shields.png";
const DOTBOT_SHIELDS_JSON = "/assets/pixel-city/dotbot-shields.json";
const DOT_ITEMS_PNG = "/assets/pixel-city/dot-items.png";
const DOT_ITEMS_JSON = "/assets/pixel-city/dot-items.json";
const EDITOR_ASSETS_JSON = "/assets/editor/manifest.json";

let cityManifest: Manifest | null = null;
let dotbotManifest: Manifest | null = null;
let dotbotShieldManifest: Manifest | null = null;
let dotItemManifest: Manifest | null = null;
const cityTextures = new Map<string, Texture>();
const dotbotTextures = new Map<string, Texture>();
const dotbotShieldTextures = new Map<string, Texture>();
const dotItemTextures = new Map<string, Texture>();
const editorTextures = new Map<string, Texture>();
const editorFrames = new Map<string, Frame>();

async function loadManifest(url: string): Promise<Manifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load pixel asset manifest: ${url}`);
  return response.json() as Promise<Manifest>;
}

function usedCityAssetKeys(map: MapDocument): Set<string> {
  return new Set([
    ...(map.artPlacements ?? []).map((placement) => placement.assetKey),
    ...map.outdoor.objects.map((object) => object.art?.assetKey).filter((key): key is string => Boolean(key)),
    ...map.buildings.flatMap((building) => building.floors.flatMap((floor) =>
      [
        ...floor.objects.map((object) => object.art?.assetKey),
        ...floor.stairs.map((stair) => stair.art?.assetKey),
      ].filter((key): key is string => Boolean(key)),
    )),
  ]);
}

async function loadEditorAssets(map: MapDocument): Promise<void> {
  const wanted = [...usedCityAssetKeys(map)].filter((key) => key.startsWith("editor-") && !editorTextures.has(key));
  if (!wanted.length) return;
  const response = await fetch(`${EDITOR_ASSETS_JSON}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load promoted editor asset manifest.");
  const manifest = await response.json() as EditorManifest;
  await Promise.all(wanted.map(async (key) => {
    const asset = manifest.assets[key];
    if (!asset) throw new Error(`Unknown promoted editor asset: ${key}`);
    await Assets.load(asset.url);
    const texture = Texture.from(asset.url);
    texture.source.style.scaleMode = "nearest";
    editorTextures.set(key, texture);
    editorFrames.set(key, { x: 0, y: 0, w: asset.width, h: asset.height });
  }));
}

export async function loadProductionPixelAssets(map: MapDocument): Promise<void> {
  if (map.visualTheme !== "pixel-city") return;
  const [city, dotbot, dotbotShields, dotItems] = await Promise.all([
    cityManifest ?? loadManifest(CITY_JSON),
    dotbotManifest ?? loadManifest(DOTBOT_JSON),
    dotbotShieldManifest ?? loadManifest(DOTBOT_SHIELDS_JSON),
    dotItemManifest ?? loadManifest(DOT_ITEMS_JSON),
    Assets.load(CITY_PNG),
    Assets.load(DOTBOT_PNG),
    Assets.load(DOTBOT_SHIELDS_PNG),
    Assets.load(DOT_ITEMS_PNG),
  ]);
  cityManifest = city as Manifest;
  dotbotManifest = dotbot as Manifest;
  dotbotShieldManifest = dotbotShields as Manifest;
  dotItemManifest = dotItems as Manifest;
  Texture.from(CITY_PNG).source.style.scaleMode = "nearest";
  Texture.from(DOTBOT_PNG).source.style.scaleMode = "nearest";
  Texture.from(DOTBOT_SHIELDS_PNG).source.style.scaleMode = "nearest";
  Texture.from(DOT_ITEMS_PNG).source.style.scaleMode = "nearest";
  await loadEditorAssets(map);
}

function frameTexture(
  key: string,
  manifest: Manifest | null,
  url: string,
  cache: Map<string, Texture>,
): Texture {
  const cached = cache.get(key);
  if (cached) return cached;
  const frame = manifest?.frames[key];
  if (!frame) throw new Error(`Unknown pixel asset frame: ${key}`);
  const source = Texture.from(url).source;
  const texture = new Texture({
    source,
    frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
    label: key,
  });
  cache.set(key, texture);
  return texture;
}

export function cityTexture(key: string): Texture {
  const editor = editorTextures.get(key);
  if (editor) return editor;
  return frameTexture(key, cityManifest, CITY_PNG, cityTextures);
}

export function dotbotTexture(key: string): Texture {
  return frameTexture(key, dotbotManifest, DOTBOT_PNG, dotbotTextures);
}

export function dotbotShieldTexture(key: string): Texture {
  return frameTexture(key, dotbotShieldManifest, DOTBOT_SHIELDS_PNG, dotbotShieldTextures);
}

export function dotItemTexture(item: Item): Texture {
  return frameTexture(dotItemFrameKey(item), dotItemManifest, DOT_ITEMS_PNG, dotItemTextures);
}

export function cityFrame(key: string): Frame {
  const editor = editorFrames.get(key);
  if (editor) return editor;
  const frame = cityManifest?.frames[key];
  if (!frame) throw new Error(`Unknown pixel asset frame: ${key}`);
  return frame;
}
