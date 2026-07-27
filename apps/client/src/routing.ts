export type ClientSurface = "base" | "solo" | "studio" | "lab" | "hud";

export function selectClientSurface(search: string): ClientSurface {
  const params = new URLSearchParams(search);
  if (params.has("lab")) return "lab";
  if (params.has("hud")) return "hud";
  if (params.has("studio")) return "studio";
  if (params.has("solo")) return "solo";
  return "base";
}
