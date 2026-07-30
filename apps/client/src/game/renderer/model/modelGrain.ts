import { Texture, TilingSprite } from "pixi.js";

export const SURFACE_GRAIN_TILE = 128;
export const SURFACE_GRAIN_DOTS = 112;
export const SURFACE_GRAIN_ALPHA = 0.36;

export type GrainSample = { x: number; y: number; radius: number; light: boolean; alpha: number };

/**
 * Stable samples make the grain a material treatment, not animated television snow.
 * This also keeps tests independent of Canvas and Pixi.
 */
export function surfaceGrainSamples(count = SURFACE_GRAIN_DOTS): GrainSample[] {
  let state = 0x5f3759df;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: count }, () => ({
    x: next() * SURFACE_GRAIN_TILE,
    y: next() * SURFACE_GRAIN_TILE,
    radius: 0.35 + next() * 0.85,
    light: next() > 0.7,
    alpha: 0.018 + next() * 0.022,
  }));
}

/** Opt-in only: the measured full-world crop did not earn a default-on treatment. */
export function surfaceGrainEnabled(search: string): boolean {
  return new URLSearchParams(search).get("grain") === "1";
}

let grainTexture: Texture | null = null;

function texture(): Texture | null {
  if (grainTexture) return grainTexture;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SURFACE_GRAIN_TILE;
  canvas.height = SURFACE_GRAIN_TILE;
  const context = canvas.getContext("2d");
  if (!context) return null;

  for (const sample of surfaceGrainSamples()) {
    const channel = sample.light ? 255 : 12;
    context.beginPath();
    context.arc(sample.x, sample.y, sample.radius, 0, Math.PI * 2);
    context.fillStyle = `rgba(${channel}, ${channel}, ${channel}, ${sample.alpha})`;
    context.fill();
  }
  grainTexture = Texture.from(canvas);
  return grainTexture;
}

/**
 * One cached, non-interactive draw call over static map art.
 *
 * This is deliberately not a NoiseFilter: there is no full-screen framebuffer pass
 * and nothing updates per frame. The low-alpha 128px tile only prevents large flat
 * values from looking digitally empty at native scale.
 */
export function buildSurfaceGrain(width: number, height: number): TilingSprite | null {
  const source = texture();
  if (!source) return null;
  const grain = new TilingSprite({ texture: source, width, height });
  grain.alpha = SURFACE_GRAIN_ALPHA;
  grain.eventMode = "none";
  grain.label = "surface-grain";
  return grain;
}
