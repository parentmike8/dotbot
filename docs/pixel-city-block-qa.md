# Pixel City block — build QA report (2026-07-22)

Scope: full first city block — exterior completion, five-level Plume Parts,
two-level Bakery (blue building), two-level Coolies clothing store (red
building), Dots, and AI. Source of truth remains
`packages/game/src/content/authored/pixel-city.json`; Downtown is untouched.

## What was built

- **Exterior:** north service alley (container, barrels, cardboard, alley
  bin) behind all three buildings feeding Plume's back door; west-lane cone;
  two frontage planters; alley radar Dot rewarding the flank route. Streets,
  park, insertion, and extraction unchanged.
- **Plume Parts (5 floors):** GROUND public shop (approved floor, unchanged),
  F1 assembly (bins, two-row bench line, QC corner, staging, packing), F2
  storage (three shelf banks, receiving, inventory desk, secured cases), F3
  repair (three wall bays, diagnostics, reclaim racks, break corner), F4
  secured Core room (walled enclosure with one guarded mouth, monitoring
  desks, power wall, cover crate). One west stair zone: two 96×192 flights
  joined as a bank; G↔F1 and F2↔F3 on the west flight, F1↔F2 and F3↔F4 on
  the east flight, all `openEnd` mid-stride pairs.
- **Bakery:** animated `bakery-door` entrance, bake line, bread shelves,
  case+counter run, stock/office F1. **Coolies:** animated `clothes-door`
  entrance, hanging racks, display table, checkout desk, passable window
  dressing, tailoring + fitting F1.
- **Atlas:** 45 → 98 frames (facades with baked doors cleared, two new
  7-frame door families, ~30 fixture sprites, two interior floor tiles) via
  `scripts/build-pixel-city-assets.py`; raw packs still unshipped.
- **AI (one squad per building, ambient):** street rover; Plume F2 ×1, F3 ×1,
  F4 ×2 (shared `plume-guard` squad); Bakery F1 ×1; Coolies F1 ×1. Plume
  GROUND and F1 stay peaceful so the stair route can be learned safely.
- **Proxies (documented, not implemented systems):** power-up Dots as loot;
  blueprint Dots as the F1 "shield-frame" and F4 "core-frame" rewards; the F4
  "Core" is a parts case + blueprint Dot. No level locks or fabrication
  claims anywhere.

## Automated validation (all green)

- `pnpm test` — 279 tests pass (game 166, client 78, protocol 17, server 18 +
  8 skipped). `pnpm typecheck` and `pnpm build` pass (pre-existing chunk-size
  warning only).
- `pixelCityBlock.test.ts` (15 tests) now enforces block-wide:
  `auditBuildingFloorQuality` for **every** building; coordinate-identical
  reverse stair pairs; every Dot and AI spawn radius-safe **and** reachable;
  Bakery/Coolies doors authored as animated automatic doors with exact wall
  seams; small-shop Dots and stairs reachable from their front doors;
  encounter escalation (peaceful G/F1, 1/1/2 up the tower, one squad); and a
  **scripted simulation traversal** that walks a full-size DotBot
  GROUND→F1→F2→F3→F4 and back down to the street, crossing all four stair
  pairs mid-stride in both directions and exiting the front door.

## Visual review (production renderer, overlays off first)

Reviewed every floor in Map Studio at fit zoom and in the production renderer
with the player spawned on each floor. Composition critique per contract §4.1:

- **Exterior:** the three storefronts, alley service run, park, and corner
  extraction read as one block; the alley reads as a delivery/waste lane, not
  scatter. Frontage planters read as street trees (they partially overlap the
  Plume display windows — believable, noted).
- **Plume F1–F4:** each floor's anchor is legible (bench line / shelf banks /
  bay wall / core enclosure), supporting fixtures sit against what they
  serve, and the open zones read as the work aisle, patrol ground, or the F4
  fight lane. The F4 enclosure correctly blocks line of sight; its interior
  is dark until the mouth is rounded.
- **Bakery/Coolies:** both read instantly as their programs; door lanes are
  clear; counters face the doors.
- Collision + clearance overlays checked on Coolies F1 and Plume F3 (the two
  densest floors): colliders sit at visible bases, no oversized boxes, stair
  guards only on the dashed halves.
- Browser console clean on load; mobile-width layout (430px) renders sharply
  with touch controls.

## Live traversal caveat

The interactive browser could not drive the game this session: the Chrome
window was hidden (`document.visibilityState === "hidden"`), which throttles
rAF to zero and freezes the loop — the same limitation recorded for the
in-app browser pane. Movement, stair crossings, and door mechanics are instead
proven by the scripted `DotBotSimulation` traversal test above (the identical
authoritative simulation the renderer displays), plus door open/noise/close
simulation tests. AI presence was confirmed in the renderer: floor guards
visibly engaged the player on F3/F4/Coolies-F1 spawns. **Remaining manual
check:** one human feel-pass of the full climb in a focused browser.

## Known cosmetic gaps

- The Bakery/Coolies upper storefront bands reuse the shared roof/middle
  facade art; only Plume has distinct middle-floor art.
- The alley container's "Smc" branding is baked into the licensed sprite.
- Plume's baked window art shows "Plume" on the two flagship bays only.
