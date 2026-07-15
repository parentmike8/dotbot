import type { Item, WirePowerupCode } from "@dotbot/game/types";

export type { WirePowerupCode } from "@dotbot/game/types";
export type WireItemCode = WirePowerupCode | `b:${string}`;

export function itemToCode(item: Item): WireItemCode {
  if (item.kind === "blueprint") return `b:${item.blueprintId}`;
  return ({ health: "h", radar: "r", dashOvercharge: "d", incognito: "i" } as const)[item.type];
}

export function itemFromCode(code: WireItemCode): Item {
  if (code.startsWith("b:")) return { kind: "blueprint", blueprintId: code.slice(2) };
  switch (code) {
    case "h": return { kind: "powerup", type: "health" };
    case "r": return { kind: "powerup", type: "radar" };
    case "d": return { kind: "powerup", type: "dashOvercharge" };
    case "i": return { kind: "powerup", type: "incognito" };
    default: throw new Error(`Unknown wire item code: ${code}`);
  }
}
