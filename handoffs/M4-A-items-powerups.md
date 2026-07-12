# Handoff M4-A: Item model, powerups, dumb greys — the loot game (sim + solo client)

**Agent brief.** You are replacing the fungible `inventoryDots` counter with a real item system: typed dots on the map, four fireable powerups, bays + hold inventory, blueprint collection, ambient AI reduced to pure obstacles, and the downed-state UX. This slice is **solo-complete**: everything works and is verifiable offline; the networked/persistence surfacing is the next task (M4-B). Design authority: `dotbot-systems-spec.md` §5–§7 + owner rulings embedded below (they override where they differ). Single lane, whole repo, but keep protocol/server changes to the minimum compile-fix — M4-B owns that ground.

**Preconditions:** M3 complete (`handoffs/M3-REPORT.md`; suite 77 w/ DB, 76+1 skip without). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Local Postgres binds host port **55432** (`covet-postgres` owns 5432 — never touch it). Browser checks need visible windows (hidden = rAF-frozen).

## 1) Item + dot model (`packages/game`)

```ts
type PowerupType = "health" | "radar" | "dashOvercharge" | "incognito";
type Item = { kind: "powerup"; type: PowerupType } | { kind: "blueprint"; blueprintId: string };
```

- `DotBotEntity`: replace `inventoryDots: number` with `bays: (Item | null)[]` (length `config.baySlots` = 4) and `hold: Item[]` (cap `config.holdSlots` = 12). Update every ripple site: AI loot logic, extraction manifest counts (now itemized), consume looting, snapshot, tests. `carriedCount(bot)` helper for the many places that only need the total.
- **Dot entities become typed**: `DotEntity` gains `item: Item`. Retire the `DOT` color palette in `content/downtown.ts` — authored dot spawns now declare items. Distribute powerup types with building identity (health at Mercy, radar at Civic, dashOvercharge outdoors/transit-y spots, incognito at Beacon; a mix on streets) — keep total counts near current.
- **Blueprint dots** spawn anchored to `scannable` objects: at map load (deterministic from map data, NOT per-match randomness yet), generate one blueprint dot per scannable-flagged object type per building, positioned at the midpoint of the object's most-open side, pushed out by `botRadius`, and REGISTERED INTO the plan's `dotSpawns` before validation-relevant consumers see them — the existing `mapValidation` capturable test must automatically cover them (extend `collectFloors` if needed so they're included; every blueprint dot must pass the capturable assertion). `blueprintId` = the object kind (e.g. `"bed"`, `"serverRack"`, `"forklift"`).
- Capture routing (owner-approved): captured dot fills the first empty bay, else hold, else capture is refused (channel completes into a "full" bounce — dot stays). Spawn loadout: non-ambient bots insert with 1 HEALTH powerup in bay 1.

## 2) Firing powerups (sim verb + effects)

- `InputCommand` gains `useBay?: 0 | 1 | 2 | 3` (edge-triggered like dash: consumed on the tick considered, dropped if the bay is empty or the bot is not alive; never banked).
- Effects (all instant; all numbers land in `GameConfig` as tuning knobs; firing emits a small noise EXCEPT incognito):
  - **health**: restore one shield plate (`platesForCount`-style +1 then re-seat; capped at max).
  - **radar**: for 8s, every 2s, record fading ping marks for all bots within 600px of the user (positions at ping time, through walls). Sim-side: store pings on the bot (`radarPings: {x, y, ageMs}[]`) included in snapshots; renderer draws them as small fading rings in the user's own view only.
  - **dashOvercharge**: the user's next 3 dashes ignore cooldown.
  - **incognito**: for 10s the bot emits NO noise events (dash/stairs/channel pings suppressed at `emitNoise`).
  - Blueprint items are not fireable (bay use on one = no-op).
- Client: keys 1–4 fire bays; touch: tapping a bay slot fires it. HUD bay strip shows the four slots with item glyphs + a hold count chip.
- **Hold⇄bay swap** (mid-run): a 2s stationary noisy channel — press/hold a swap control on a bay slot to open a minimal hold picker (movement locked), pick the hold item; the 2s channel runs (emits channel noise like other channels), then the items exchange. At this stage keep the UI minimal and title-block styled.

## 3) Dot rendering + legend (spec §6 table)

- Powerup dots: ORANGE (`#e8590c`-family, one hue), distinguished by glyph at ~10px: health = cross, radar = concentric arcs, dashOvercharge = chevron, incognito = dashed outline. Blueprint dots: BLUE (`#1971c2`) hairline plan-tick. Solid-fill identity dots are gone.
- Diegetic legend: an `L`-key / HUD-button overlay drawn like a title-block key listing the dot glyphs and colors. Minimal, static.

## 4) Ambient AI = dumb obstacles (spec §6 Bots)

- Greys (`isAmbient`) lose the loot/extract/revive/consume verbs entirely: their AI selects only wander / investigate-noise / hunt-and-attack. They still fight (down players and each other), still carry NOTHING (remove their spawn inventories), and can never be revived (already true) or consume anyone.
- Red stand-in squad AI (non-ambient) keeps the full verb set, including item pickup under the new bays/hold model and consume.

## 5) Downed-state UX (owner ruling — replaces any timer idea)

- There is NO bleed-out timer. A downed bot stays revivable until the match ends or the player opts out — squadmates crossing the whole map for a pickup is a legitimate play.
- Downed HUD (solo + net-ready): a `GIVE UP` action appears while downed with no revive in progress — solo: ends the run with the died manifest; net path should route through the existing `leaveRun` (wire the button; M4-B verifies it over the network).
- Consume by hostile non-ambient bots still works and now loots ITEMS: everything carried (bays + hold) transfers to the consumer's free capacity; **overflow spills onto the ground as dots at the consume site** (re-lootable by anyone — fights over a body leave a debris field).

## 6) Manifest + run accounting

- Manifests itemize: KEPT / LOST list item glyph + count per type (blueprints named). Kill tallies unchanged. `extracted` / `consumed` events carry the item lists instead of dot counts (additive event shape change — M4-B maps it over the wire; fix server compile minimally without redesigning messages).

## Tests

- Update all `inventoryDots` ripples with unchanged intent; new coverage: pickup routing (bay→hold→refuse), each powerup effect (plate restored + capped; pings recorded/aged; overcharge counts 3; incognito emits no noise during a dash), useBay never banks, ambient verb removal (grey next to a dot never captures; grey over a downed bot never consumes), consume spills overflow as ground dots, blueprint dots generated + capturable via the existing validation sweep, legend untested (visual).
- Determinism test: mechanical updates only.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` both with and without `DATABASE_URL` (DB tests may be red ONLY if M3's integration test references dot counts — update it mechanically to item counts, nothing more); `pnpm build`, `pnpm build:all`.
2. Solo browser (visible): typed dots render with glyphs; capturing routes bay→hold; keys 1–4 fire (watch a plate restore, radar pings appear, overcharged triple-dash, silent dash under incognito); swap channel works and is noisy (rivals investigate); greys fight but never loot/consume; downed shows GIVE UP → died manifest; extraction manifest itemizes; legend toggles.
3. Map Studio unaffected. Zero console errors.
4. `git status` clean; atomic commits (item model / typed dots+blueprints / powerup effects / ambient+downed / HUD+legend / tests).

## Report back

`handoffs/M4-A-REPORT.md`: the item model as landed, every `inventoryDots` ripple site, blueprint spawn-generation rules, effect implementations + config knobs, what compile-minimum changes touched protocol/server (M4-B's rebase input), verification output.
