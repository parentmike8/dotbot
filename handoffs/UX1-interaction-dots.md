# Handoff UX-1: Grey interaction dots — one interaction grammar everywhere

**Agent brief.** Owner directive: EVERY interaction in the game is expressed as a dot the player stands on. In-run already works this way (capture, loot, revive, mines); the base does not — its objects use invisible proximity zones and players cannot tell what is interactive. Fix: every interactive thing in the base exposes a **grey interaction dot**; standing on it runs the existing 1s channel and opens the panel. Grey is unclaimed in the dot palette (orange = powerup, blue = blueprint) — it becomes the permanent "world interaction" color. Single lane, whole repo.

**Preconditions:** Post-M8 production build (`git log`, production live via `deploy/deploy.sh` — run it at the end so the fix ships). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432**. Browser checks need visible windows.

## 1) Dot placement (pure data, derived — nothing hand-authored per layout)

- `createBaseMap` emits an `interactionDots` collection (extend `MapDocument` minimally or reuse a dedicated field — NOT `dotSpawns`, these are not lootable): one dot per
  - **placed object** (both floors): anchored at the midpoint of the object's FACING side, pushed out by `botRadius + dotRadius` — the same anchoring convention M4 uses for blueprint dots against scannables. Deterministic from slot data.
  - **empty placement slot**: dot at the slot rect center (opens the move/placement picker as today).
  - **deployment threshold**: dot at the threshold center (channel → deployment overlay, unchanged behavior).
- Every interaction dot must pass the existing flood-grid reachability sweep for all three shells, expanded and not, under the maximal furnishing — extend the validation suite to assert stand-on-ability (same capture-range math as world dots: `botRadius − dotRadius − 2`).
- If an object's facing side is too close to a wall for the push-out, fall back deterministically through the other sides (the M4 scannable anchoring already has this pattern — reuse it).

## 2) Interaction flow (`baseFlow.ts`)

- `findBaseTarget` stops measuring distance-to-rect: the target is the interaction dot whose center is within capture range of the bot center (nearest wins). Same numbers as world dot capture — the muscle memory transfers exactly.
- The 1s stationary channel and cancel-on-move semantics stay; the channel ring anchors on the DOT (small radius, like a capture ring) instead of encircling the furniture.
- Keep panels, pickers, and everything downstream unchanged.

## 3) Rendering + legend

- Grey interaction dots render on their floor at world-dot size: muted-ink grey, hairline outline, in the established CAD dot language. They must read as kin to world dots but never confusable with powerups (orange), blueprints (blue), or a mine's disguise — grey + a distinct minimal glyph (suggest a 3px hollow center — a "port"). Document the final visual in the report.
- Empty-slot corner markers stay (they mark the slot rect); the grey dot is the interaction affordance within them.
- Base instruction line becomes: `STAND ON A GREY DOT TO INTERACT · DEPLOYMENT DOT TO LEAVE`.
- The diegetic legend gains the grey row: `INTERACTION — STAND ON`.
- In-run world rendering is untouched (it already speaks dots).

## 4) Tests

- Placement: every interactive entity yields exactly one dot; facing-side anchoring + fallback; dots deterministic per (layout, shell, expanded).
- Reachability: all shells × {expanded, not} × maximal furnishing — every interaction dot stand-on-able.
- baseFlow: target resolution by dot proximity (floor-aware — an F1 dot never resolves for a GROUND bot); nearest-dot tie-breaking deterministic.
- Existing suites green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, visible window: base shows grey dots at every object, empty slot, and the threshold; standing on one channels and opens the right panel; moving cancels; furniture moves/fabrication relocate their dots; all three shells + F1 correct; solo run unchanged (world dots as before); zero console errors.
3. **Deploy to production** (`./deploy/deploy.sh`) and re-verify the base flow on the live URL.
4. `git status` clean; atomic commits (dot data / flow / render+legend / tests).

## Report back

`handoffs/UX1-REPORT.md`: dot anchoring rules + fallback, the final grey-dot visual spec, baseFlow changes, verification output for both modes + live narrative including the production check.
