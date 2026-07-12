# M4-A completion report — items, powerups, and dumb greys

## Result

M4-A is complete in six atomic commits:

1. `Replace dot counts with item inventory`
2. `Add typed dots and blueprint spawns`
3. `Implement powerup effects and item swaps`
4. `Restrict ambient bots and add downed opt-out`
5. `Add item HUD glyphs and legend`
6. `Cover item and powerup behaviors`

The runtime has no `inventoryDots` or `maxInventoryDots` references. The only remaining `keptDots` / `lostDots` / `holdDots` names are the M3 database/profile compatibility model described under “M4-B rebase input.” Historical handoffs still contain their original terminology.

## Item model as landed

- `Item` is the requested discriminated union:
  - `{ kind: "powerup"; type: "health" | "radar" | "dashOvercharge" | "incognito" }`
  - `{ kind: "blueprint"; blueprintId: string }`
- `DotBotEntity` now carries fixed-length `bays: (Item | null)[]` and capped `hold: Item[]`.
- Defaults are `baySlots: 4` and `holdSlots: 12`.
- `carriedItems`, `carriedCount`, and `insertItem` centralize traversal, counting, and bay-first insertion.
- Non-ambient spawns receive HEALTH in bay 1 unless an authored/test loadout is supplied. Ambient spawns always receive empty bays and hold.
- Capture completes into the first open bay, then hold. When both are full, the completed channel resets and the dot stays active.
- `extracted` now carries `items`; `consumed` now carries `lostItems`. Solo run state and manifests carry `keptItems` / `lostItems`.
- Manifest KEPT and LOST sections group by powerup type or named blueprint and show a glyph plus count.

## `inventoryDots` ripple inventory

| Ripple site | Landing |
| --- | --- |
| Game types/config | `Item`, `bays`, `hold`, `baySlots`, `holdSlots`; count field removed |
| Spawn/respawn | normalized bay arrays; HEALTH for non-ambient; nothing for ambient |
| AI loot decisions | `carriedCount`; capacity is bays plus hold |
| Dot capture | typed item insertion; bay → hold → refusal |
| Extraction | itemized `items` event and bot removal |
| Consume | item transfer to free capacity, typed overflow spills, itemized loss event |
| Snapshot | cloned bay/hold item arrays plus powerup-effect state |
| Downtown content | authored typed powerups; count loadouts removed |
| Local session | itemized extracted/died/timeout outcomes and GIVE UP loss |
| Net session | item-array run state and edge-input forwarding |
| HUD/manifest | four actionable bays, hold count/picker, grouped item lists |
| Prediction fixtures | mechanical entity-shape updates only |
| Protocol wire | bay/hold arrays replace the numeric bot field; effect state added |
| Server Room | item-array run-over messages; timeout reads bay/hold contents |
| Persistence boundary | item-array lengths adapt to the unchanged M3 dot-count schema |
| Tests | all count-based setup/assertions converted; requested new behaviors covered |

## Typed dots and blueprint generation

- Powerup dots use one orange family (`#e8590c`); glyphs distinguish HEALTH cross, RADAR arcs, DASH chevron, and INCOGNITO dashed ring.
- Blueprint dots use blue (`#1971c2`) with a hairline plan-tick glyph.
- Authored powerups retain approximately the previous dot volume, with Mercy biased to health, Civic to radar, Beacon to incognito, and outdoor/transit locations to dash plus a street mix.
- `addBlueprintSpawns` runs while `downtownMap` is assembled, before the exported document reaches simulation, navigation prewarm, renderer, or validation.
- For each building it walks floors and objects in stable document order, emits one blueprint per scannable object kind, and uses the object kind as `blueprintId`.
- Candidate locations are the four side midpoints, pushed clear by `botRadius + 10`. The most-open capturable candidate wins with document-order tie-breaking; a deterministic outward expansion handles tight scenery.
- Reachability uses the same 8 px grid, bot clearance, and 12 px capture range as map validation. The derived blueprint is appended to the owning floor’s `dotSpawns`, so the existing validation sweep covers it automatically.
- A dedicated assertion also proves each building has exactly one registered blueprint for every scannable object type.

## Powerup verbs and tuning knobs

`InputCommand.useBay` is edge-triggered and cleared on the tick considered, including empty bays and non-alive state. It never banks. `swapBay` follows the same edge discipline.

| Effect | Implementation | Config |
| --- | --- | --- |
| HEALTH | restores one plate-equivalent across damaged segments, re-seats strongest-first, caps at max | existing shield capacity |
| RADAR | 8 s active; records same-floor bot positions within 600 through walls every 2 s; ping snapshots age and fade | `radarDurationMs=8000`, `radarPingIntervalMs=2000`, `radarRadius=600`, `radarPingTtlMs=2000` |
| DASH OVERCHARGE | next three dashes fire through cooldown and consume one charge; normal cooldown state is otherwise unchanged | `dashOverchargeUses=3` |
| INCOGNITO | suppresses all source-attributed dash, stair, capture, revive/consume, extraction, swap, and firing noises | `incognitoDurationMs=10000` |
| Firing noise | small channel noise for all powerups except incognito, whose suppression is active before emission | `powerupNoiseLoudness=0.3` |
| Hold swap | validates a hold index, locks movement, emits channel noise, then exchanges/removes items | `swapDurationMs=2000` |

RADAR pings render only from the current player’s stored marks. Blueprint bay use is a no-op.

## Ambient and downed owner rulings

- Ambient greys select only hunt, investigate, and wander intents. They retain collision, dash attacks, damage, and grey-vs-grey combat.
- Ambient actors are excluded from dot capture and downed coverage, so they cannot loot, extract, revive, consume, or carry items.
- Hostile non-ambient consumers retain consume. Items transfer bay-first/hold-second; every overflow item becomes an active typed `spill-*` dot at the body.
- There is no bleed-out field, timer, tick, event, or transition. A regression test holds a bot downed for 1,200 ticks.
- GIVE UP appears only while the local player is downed and has no revive coverage. Solo creates an immediate died manifest with all carried items lost. Net calls the existing `leaveRun` path for M4-B to validate end-to-end.

## M4-B rebase input: compile-minimum protocol/server changes

- `WireBot.n` became `b` (bays) plus `h` (hold). Optional wire fields carry radar marks/timer, overcharge charges, and incognito time.
- The existing input message gained optional `useBay` and `swapBay`; Room forwards and clears them as edges.
- `runOver` now carries `keptItems` / `lostItems`, matching solo semantics.
- Room’s persistence adapter intentionally converts item-array lengths back to M3 `RunManifest.keptDots/lostDots`. The database schema, hold-item rows, profile `holdDots`, and lobby persistence labels were not redesigned; M4-B owns that surfacing/migration.
- Interest filtering continues to transport typed dots and the new event payloads; no broader online visibility redesign was made.

## Verification

All commands used the required Node 20 binaries.

- M3 precondition: `handoffs/M3-REPORT.md` present with both green suite modes.
- `pnpm typecheck`: green across game, protocol, client, and server.
- `DATABASE_URL` unset, full `pnpm test`: **89 passed, 1 DB-only skipped**.
- `DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot`, full `pnpm test`: **90 passed**. Migrations applied successfully first. Port 5432 and `covet-postgres` were not modified.
- `pnpm build`: green. Vite emitted only its existing large-chunk advisory.
- `pnpm build:all`: green; client production build and Node 20 server bundle completed.
- Visible solo browser:
  - orange chevron powerup dots and blue blueprint plan ticks rendered;
  - real joystick navigation and capture produced `Bay 2: Health` and `Bay 3: Blueprint: shelf`, proving typed capture into the bay strip;
  - tapping bay 1 fired/consumed HEALTH;
  - the HUD showed four bays and hold capacity; the item legend opened with all five identities;
  - zero console errors.
- Powerup effect timing, bay→hold→refuse, swap locking/noise, ambient exclusions, consume overflow, no banking, and GIVE UP were exercised deterministically in the green simulation/client suite. This avoids relying on combat/drop randomness for those state assertions.
- Visible Map Studio at `/?studio`: all four buildings and layer controls rendered; zero console errors.
- `rg 'inventoryDots|maxInventoryDots'` is clean in runtime/test source; matches exist only in historical handoff/report prose.
- Six requested atomic implementation commits are present. Final `git status` was clean after this report was committed.
