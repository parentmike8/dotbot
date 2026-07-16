# UX-1 Report: Grey interaction dots

## Result

UX-1 is implemented and deployed. Every persistent-base interaction is now represented by a non-lootable, floor-aware grey dot derived from map data: one for each placed object, each empty placement slot, and the deployment threshold. Standing within the same 12px center tolerance used by world dots runs the existing stationary one-second channel and opens the unchanged downstream panel or overlay.

Production revision `dotbot-00006-jhk` is serving 100% of traffic at <https://dotbot-jpawns5vla-uc.a.run.app>.

## Dot data and placement

- `MapDocument.interactionDots` is a dedicated optional collection; interaction dots never enter `dotSpawns`, simulation capture state, inventory, contracts, or loot.
- Each dot records a stable id, target kind (`object`, `emptySlot`, or `deployment`), target id, authored floor id, center, and world-dot radius.
- `createBaseMap` derives the full collection after materializing the selected shell and layout. Equal `(layout, shell, expanded)` inputs produce equal dot data.
- Placed-object dots start at the midpoint of the object's `facing` side, pushed outward by `botRadius + dotRadius` (`24 + 10 = 34px`).
- If that point is not bot-clear and reachable within capture tolerance, derivation tries the other sides in deterministic `N, E, S, W` order after the facing side.
- Matching the existing scannable escape hatch, if every first-ring side is blocked under maximal furnishing, the same side order expands in 8px steps up to 160px. This is required by Hangar F1's fully furnished `up-wall-b`; the reachability test caught the disconnected preferred point before this fallback was added.
- Empty-slot dots are at the slot rectangle center. The deployment dot is at the threshold rectangle center.
- Derivation includes a floor flood sweep from the player spawn on Ground and the stair arrival on F1, so a locally clear object side is rejected if it is disconnected from reachable circulation.

## Interaction flow

- `findBaseTarget` no longer measures proximity to object or slot rectangles and no longer treats entering the deployment rectangle as interaction.
- It filters interaction dots to the bot's physics floor, accepts only centers within `botRadius - dotRadius - 2` (`12px`), chooses the nearest, then breaks equal-distance ties by stable dot id.
- The selected dot resolves back to its existing object, placement slot, or extraction point; all panels, move/placement behavior, fabrication behavior, and the deployment overlay remain downstream and unchanged.
- The existing one-second stationary channel and movement cancellation remain intact.
- The channel ring is centered on the dot at `dot.radius + 8`, rather than encircling furniture or the threshold rectangle.

## Rendering and permanent palette

- The semantic dot palette is centralized as orange `#e8590c` for powerups, blue `#1971c2` for blueprints, and muted-ink grey `#7d838a` for world interactions. The orange/blue in-run rendering is numerically unchanged.
- Interaction dots render at the normal 10px world-dot radius, filled muted grey with a 1.2px near-black outline.
- A hollow 3px white center with a hairline near-black rim is the interaction-specific “port” glyph. It reads as the same dot family without resembling a powerup, blueprint, or disguised mine.
- Dots are drawn in their owning floor layer. Ground and F1 never show each other's dots.
- Empty-slot corner marks remain; the grey dot overlays the center as the actionable affordance.
- Base instruction: `STAND ON A GREY DOT TO INTERACT · DEPLOYMENT DOT TO LEAVE`.
- Diegetic item key row: `INTERACTION — STAND ON`.

## Automated verification

All commands used Node 20 binaries from `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin`. No command connected to host port 5432.

1. `pnpm typecheck` — passed in all four workspaces.
2. Stateless `DATABASE_URL= pnpm test` — passed:
   - game: 116/116
   - protocol: 13/13
   - client: 19/19
   - server: 9 passed, 7 DB-only skipped
   - total: 157 passed, 7 intentionally skipped
3. PostgreSQL `DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot pnpm test` — passed:
   - game: 116/116
   - protocol: 13/13
   - client: 19/19
   - server: 16/16
   - total: 164/164
4. `pnpm build:all` — client production build and Node 20 server bundle passed. Vite retained its existing large-chunk warning; there were no build errors.
5. Focused coverage:
   - 37 map-validation tests cover exact entity-to-dot cardinality, determinism, facing anchoring, deterministic side fallback, and stand-on reachability for Workshop, Hangar, and Berth Row across both expansion states under maximal furnishing.
   - 4 base-flow tests cover one-second completion, cancel-on-move, exact 12px world-dot tolerance, floor isolation, and stable nearest-dot tie-breaking.

## Visible local narrative

The local server used PostgreSQL on host port 55432; `lsof` confirmed its established connection to `[::1]:55432`.

- Workshop visibly showed eleven grey port dots: every starter object, every empty Ground slot, and the deployment threshold.
- Standing on the deployment dot for one second opened the deployment overlay.
- Beginning that channel and moving away kept the overlay closed after the original completion time, confirming cancellation.
- Standing on the Planning Table dot opened the Planning Table panel.
- Moving the Planning Table from `floor-center` to `floor-south` visibly moved its facing-side dot with it and replaced the vacated position with a centered empty-slot dot.
- Standing on the vacated empty-slot dot opened the placement picker.
- A local test fixture on port 55432 supplied the expansion inputs. Standing on the Fabricator dot opened its panel; fabricating `SECOND FLOOR` commissioned F1 and rebuilt the map with six new F1 dots.
- Walking the stair to `player-base:F1` showed only the six F1 dots; standing on `up-floor-a` opened the placement picker. Ground/deployment targets did not resolve from F1.
- Workshop, Hangar, and Berth Row each visibly rendered their data-derived Ground dot set after switching shells.
- `?solo` remained the existing downtown run. Orange world dots and their capture behavior were unchanged, and the item key included the new grey interaction row.
- Browser console errors: 0.

## Production deploy and re-verification

- Deployed with the required `./deploy/deploy.sh`.
- Cloud Build id: `7e458b1a-cb78-4494-9ec8-32c6b265379a`.
- Cloud Run revision: `dotbot-00006-jhk`, 100% traffic.
- Live URL: <https://dotbot-jpawns5vla-uc.a.run.app>.
- A new production test bot commissioned with an active storage link.
- The production Workshop visibly showed the complete grey dot set and updated instruction.
- Standing on the production deployment dot completed the one-second channel and opened the deployment overlay.
- Returning to base and standing on the production Planning Table dot opened the correct panel.
- Production browser console errors: 0.

## Exit criteria

1. **Typecheck, both test modes, and both production builds:** passed.
2. **Visible base coverage, channel/open, movement cancel, relocation, fabrication, all shells, F1, unchanged solo, zero console errors:** passed.
3. **Production deploy with `./deploy/deploy.sh` and live base re-check:** passed on `dotbot-00006-jhk`.
4. **Atomic commits and worktree audit:** UX-1 is split into dot data, flow, render/legend, tests, and this report, with no uncommitted UX-1 paths. The repository started clean, but the unrelated `handoffs/NET1-motion-smoothing.md` appeared concurrently at 13:29 during deployment and remains untracked/preserved; global `git status` is therefore not empty.
