# Handoff M6-B: Footprint expansion — the second floor, the economy's big sink

**Agent brief.** M6 built the economy's faucets; this is the drain. Players buy a SECOND FLOOR for their base — the single most expensive purchase in the game — which adds placement slots (and therefore locker capacity, repair benches, display space). The upper floor reuses the existing multi-floor machinery wholesale: `FloorPlan`, `StairLink`, per-floor physics contexts, and the renderer's floor-visibility switching already power the eight-storey Civic Tower; the base simply becomes a two-floor building. Single lane, whole repo. **Sequencing: this runs AFTER M7 is complete and audited — it shares files with M7's planning-table work.**

**Preconditions:** M7 complete and audited (`handoffs/M7-REPORT.md` + audit commits). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (never touch `covet-postgres` on 5432). Browser checks need visible windows.

## 1) Upper-floor slot roster (parity above all)

- `BASE_SLOT_DEFS` entries gain `floor: "GROUND" | "F1"`. The ten GROUND slots are UNCHANGED (ids, zones — existing layouts and DB rows stay valid untouched).
- F1 adds exactly **six** canonical slots, identical across every shell: `up-wall-a`..`up-wall-d` (wall) and `up-floor-a`, `up-floor-b` (floor). The parity test extends: every shell exposes the identical sixteen-slot roster when expanded, ten when not.
- Layout validation becomes expansion-aware: a layout referencing an F1 slot is rejected (server-side and in `validateBaseLayout`) unless the player owns the expansion. `createBaseMap(layout, shellId, { expanded })` throws on F1 slots when `expanded` is false.

## 2) Upper-floor geometry per shell (the map authoring)

Each `BaseShellDef` gains `upper: { walls, doorways, windows, slots, stairs }` — an F1 `FloorPlan` fragment plus ONE `StairLink` pair connecting GROUND ↔ F1 (walk-through stairs, no teleport, exactly like Downtown). Author to the established CAD bar (line tiers, ≥54px clearances, windows composed not sprayed) and to each shell's architectural character:

- **WORKSHOP**: mezzanine over the south wing + west end of the hall; the stair rises along the west wall of the hall. The mezzanine edge gets a guardrail-weight hairline (wall data, thin — pick a non-colliding decorative convention consistent with the renderer; if everything must collide, use a low parapet wall with a 120px opening at the stair).
- **HANGAR**: a gallery floor over the utility-alcove end of the bay, stair in the north-east corner. The open bay below stays a double-height void — F1 covers roughly a third of the footprint.
- **BERTH ROW**: an upper commons over the ground commons, stair off the commons' west wall. Berths stay single-storey.
- The F1 slot rects live in comparable positions per shell but geometry is free — only ids/zones/count are parity-locked.
- Stairs must not encroach on any GROUND slot's approach: the fully-furnished flood sweep (all sixteen slots + threshold + stair mouths) must pass for every shell, expanded and not. Extend the existing validation suite to cover expanded variants; stair runs must pass the existing stair-geometry checks that Downtown's stairs satisfy.

## 3) Purchase flow (the sink itself)

- One recipe: `expansion-secondFloor` — output kind `"expansion"` (extend the recipe union), cost **6× each powerup type** (24 items total; symmetric so no single farming loop trivializes it; tuning knob like every other cost). No blueprint gate — wealth is the gate. Not repeatable: owning it removes the recipe from the craftable list (row shows `OWNED`).
- Persistence: `base_upgrades` table (player_id, upgrade_id, acquired_at, PK(player_id, upgrade_id)) + migration. This is the roadmap's upgrades table — future expansion ids land here, so nothing is named "second floor" in the schema beyond the id string.
- `POST /api/base/fabricate` handles it in the SAME transaction shape: gate check (not already owned) → cost deduction → upgrade row insert. `GET /api/base` payload gains `upgrades: string[]`.
- **The purchase moment**: on success the stair drafts in on the ground floor via the existing draw-on hook (the stairs are the visible new object); a title-block notice reads `FLOOR 1 COMMISSIONED`. The client rebuilds the session with the expanded map; the player walks upstairs immediately.
- Guard rail unchanged and re-asserted: the expansion adds slots/space only — extend the forbidden-keys recipe test to the new output kind.
- Stateless: locked row with the offline hint, like everything else.

## 4) Client floor-awareness (the part most likely to hide bugs)

- `baseFlow.findBaseTarget` currently reads `floors[0]` — make it floor-aware: targets resolve from the floor the player's bot is currently on (bot `floorId` is in the snapshot). Deployment threshold remains GROUND-only.
- Slot markers render per floor: `mapArt` currently passes `placementSlots` only to the GROUND floor — key slots by their `floor` field so F1 markers draw on F1 (and only there). Same for the move/fabricate slot pickers: offer slots on ANY floor (label them `F1 / up-wall-a`), the picker is UI, not walking.
- Shell picker previews: show the ground plan as today plus an `+ FLOOR 1` tag when expanded (do not redraw the SVG per floor — one tag is enough).
- Locker capacity, singleton rules, and every M6 mechanic count across BOTH floors (they already derive from the full layout — verify with tests, not assumptions).

## 5) Tests

- Parity: sixteen-slot roster identical across shells when expanded; ten-slot unchanged when not; F1-slot layouts rejected without the upgrade (game validation AND server 409).
- Validation sweep: expanded + maximal furnishing per shell — every slot on both floors, both stair mouths, and the threshold reachable; unexpanded sweeps unchanged.
- Purchase: transaction deducts 24 items + inserts the upgrade row atomically; double-purchase 409s without deduction; insufficient stock rolls back.
- Capacity across floors: lockers on F1 raise the cap exactly like GROUND lockers.
- Client seams: floor-aware target resolution (bot on F1 finds F1 objects, not GROUND ones under the same x/y).
- Existing suites green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, visible window, DB up: seed a rich stash → buy the expansion at the fabricator → stair drafts in → walk upstairs (floor visibility swaps on the stair midline exactly like Downtown) → fabricate a locker into `up-wall-a` → locker panel capacity rises → move a decorative piece to an F1 floor slot → all three shells render their expanded plan (switch between them; expansion persists) → reload: everything persisted.
3. Unexpanded accounts see no F1 slots anywhere (markers, pickers, map). Stateless boot degrades gracefully; solo + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits (slot roster+validation / shell F1 geometry / purchase+persistence / client floor-awareness / tests).

## Report back

`handoffs/M6B-REPORT.md`: F1 roster + per-shell geometry notes, purchase transaction shape, floor-awareness changes (baseFlow/mapArt/pickers), cost-curve observations (does 24 items feel right against M6 recipe prices — recommend, don't retune unilaterally), verification output for both modes + the live narrative.
