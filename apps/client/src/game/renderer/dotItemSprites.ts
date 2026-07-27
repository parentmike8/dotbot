import type { Item } from "@dotbot/game/types";

export function dotItemFrameKey(item: Item): string {
  if (item.kind === "blueprint") return "dot-blueprint";
  if (item.kind === "mine") return "dot-mine";
  if (item.type === "dashOvercharge") return "dot-dash-overcharge";
  return `dot-${item.type}`;
}
