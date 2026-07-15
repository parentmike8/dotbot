# Handoff M6: Economy loop closure — the fabricator comes online

**Agent brief.** You are closing the loop the whole game hangs on: extract materiel → learn blueprints → fabricate at the base → deploy better-equipped. The M5 fabricator stub becomes real, furniture becomes fabricable and functional, and capacity pressure (stash cap from lockers) makes fabrication matter. Design authority: roadmap M6 + owner rulings below. **Guard rail (spec's legibility principle, enforce it in data): upgrades expand options, capacity, or information — NEVER combat stats.** Nothing fabricable may touch damage, speed, plates, or any `GameConfig` combat number. Single lane, whole repo.

**Preconditions:** M5 complete + shell-plans addendum (`git log eb56bfe`; suite 110 w/ DB, 108+2 skip without — game 83, protocol 10, client 11, server 6). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (never touch `covet-postgres` on 5432). Browser checks need visible windows.

## 1) Recipe + kind data (`packages/game`, data-driven, scale-first)

- One recipe table module (`content/recipes.ts`): `{ id, output: {kind:"item", item: Item} | {kind:"furniture", objectKind}, costs: Array<{itemType: WirePowerupCode, qty}>, requiresBlueprint?: blueprintId }`. Costs are tuning knobs; no logic keyed to specific recipe ids anywhere.
- **Powerup conversion recipes** (ungated — the fabricator's innate function): each of the four powerups craftable from a mix of the others (e.g. 2 of any one type → 1 of another; pick symmetric numbers). Powerups remain the only currency — no new resource kinds.
- **Furniture recipes** (blueprint-gated): one recipe per scannable object kind in Downtown (`shelf`, `bed`, `cot`, `desk`, `workbench`, `serverRack`, `generator`, `locker`, …) — `requiresBlueprint` = that kind, exactly what M4's learning produces. Plus ONE new functional kind: **`repairBench`** (gated by the `workbench` blueprint; new glyph in the catalog, drawn to the existing standard).
- **Zone rules become data**: replace the hardcoded wall/floor kind checks in `content/base.ts` with a `BASE_KIND_ZONES` table covering every fabricable kind (lockers/consoles/fabricator/repairBench on wall; beds/desks/tables/racks etc. on floor; shelf either). The singleton rule stays for fabricator/bayConsole/planningTable/repairBench; everything else may repeat.
- **Slot parity invariant stands**: shells still expose the identical ten slots; M6 adds NO per-shell slots. Fabricated furniture with no compatible empty slot is refused with a clear message — slot scarcity is intentional (footprint expansion is a later milestone).

## 2) What placed furniture DOES (upgrades emerge from objects, no upgrades table)

- **Stash capacity = 20 × placed lockers** (starter layout: 2 lockers = 40). Shown at the locker panel as `STASH 17/40`.
  - **Banking overflow**: at extraction, items that don't fit the stash are LOST — banked in stash-space order (keep what fits, blueprint fragments FIRST so learning is never starved by full lockers); overflow rides `lostItems` and the manifest shows `STASH FULL — LOST: …`. The persistence transaction stays atomic.
  - Existing over-cap stashes (dev data) are never truncated — the cap gates NEW banking only.
- **Repair bench placed** → unlocks the health-powerup conversion recipe (health is otherwise NOT craftable; the other three conversions live on the fabricator alone). The fabricator panel lists bench-gated recipes greyed with `REQUIRES: REPAIR BENCH` until one is placed.
- **Decorative learned furniture** (bed, desk, rack, …): no mechanical effect — your base displays what you've pulled out of the city. That's the point; don't invent stats for them.
- **Bay console presets** (QoL, ungated): up to 3 named 4-slot templates stored per player. `APPLY` withdraws matching items from stash (partial fill allowed, report what's missing). Presets never bypass the loadout rules (powerups only, at-risk).

## 3) Fabrication flow (client)

- Fabricator panel (replaces the M5 stub): recipe list with glyph, costs vs current stash (uncraftable = greyed with the missing amounts), blueprint-gated rows show the blueprint name; locked rows are visible — information, not mystery.
- Fabricating furniture: pick recipe → pick a compatible empty slot (reuse the M5 slot picker) → server transaction → the object drafts in via the existing `GameRenderer.draftObject` hook (M5 report §draw-on — this is the moment the whole feature exists for; make sure it fires every time).
- Fabricating powerups: recipe → qty appears in stash; a small confirmation line in the panel, no draw-on.
- Stateless mode: fabricator panel shows recipes read-only with `OFFLINE — NO STORAGE LINK`; nothing craftable.

## 4) Server + persistence

- `POST /api/base/fabricate { recipeId, slotId? }` — one transaction: verify blueprint learned (if gated) → verify repair-bench placement (for bench-gated recipes) → lock + deduct costs from stash rows (reuse the M3/M5 row-lock pattern) → output: insert `base_layouts` row (furniture, slot validated server-side against `BASE_KIND_ZONES` + emptiness) or insert stash rows (powerups). Any failure rolls the whole thing back with a 409 + reason.
- `POST /api/base/presets` (full replace, ≤3, validated) + presets in the `GET /api/base` payload; `players.presets` jsonb migration.
- Stash cap enforcement lives in the extraction-banking transaction (server-side count vs 20×lockers from `base_layouts`).
- Recipes themselves are NOT persisted — they ship as game data (config versioning comes later with real players).

## 5) Tests

- Data: every recipe output kind has a zone rule and a glyph; costs positive; every `requiresBlueprint` matches a scannable kind that actually generates fragments in Downtown; **guard-rail test: recipe outputs are only items or furniture — no recipe or placed object mutates `GameConfig`**.
- Server (DB mode): fabricate deducts + places atomically; insufficient stock / unlearned blueprint / occupied slot / zone mismatch all 409-or-400 with no partial writes; health recipe blocked until a repair bench is placed; stash cap: extraction with a full stash banks fragments first, loses overflow into `lostItems`, manifest content asserted; presets round-trip + apply with partial stock.
- Game: zone-rule table validation for all shells (the maximal-layout reachability sweep now uses the richest fabricable furnishing).
- Existing suites green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, visible window, DB up (seed learned blueprints via SQL where needed): fabricate a shelf into a floor slot → draw-on plays; fabricate a repair bench → health recipe unlocks and converts 2 radar → 1 health in stash; fabricate a third locker → locker panel capacity rises to 60; fill the stash and extract over cap → manifest shows the stash-full loss and the DB agrees; save a preset and APPLY it at the console; all three shell plans still validate and render with fabricated furniture.
3. Stateless boot: fabricator read-only with offline hint; solo + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits (recipes+zone data / fabricate transaction / stash cap+banking / presets / panels+draw-on / tests).

## Report back

`handoffs/M6-REPORT.md`: recipe table as landed (with cost numbers), zone-rule data shape, fabricate transaction shape, stash-cap banking rules, verification output for both modes + the live narrative.
