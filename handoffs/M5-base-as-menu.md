# Handoff M5: Base-as-menu — boot into your base, deploy from the door

**Agent brief.** You are replacing the traditional menu with the persistent base (roadmap M5, spec §2). Cold boot spawns the player's bot inside a small fixed-shell base map; every meta action is diegetic — walk to an object, channel to use it; walking out the deployment threshold opens the room join/queue flow; after a run's manifest you land back in the base with your stash updated. Single lane, whole repo. Fabrication RECIPES (crafting, costs) are M6 — the fabricator object exists here as a stub.

**Preconditions:** M4 complete (`handoffs/M4-B-REPORT.md`; suite 95 w/ DB, 94+1 skip without). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (`pnpm db:up` — never touch `covet-postgres` on 5432). Browser checks need visible windows (hidden = rAF-frozen).

## 1) Base map (`packages/game/src/content/base.ts`)

- `createBaseMap(layout: BaseLayout): MapDocument` — a single-floor fixed shell, roughly 800×600 interior, drawn to the same CAD line-tier standard as Downtown (wall tiers from `style.ts`; flood-grid clearance rules apply — ≥54px gaps, validate with the existing map validation suite).
- **Placement slots are data, not positions in code** (scale-first): the shell declares ~10 `placementSlots` (id, rect, zone: `"wall" | "floor"`); `BaseLayout` maps slotId → object kind; `createBaseMap` materializes furniture from that mapping. Objects carry their normal linework (`obj(...)` kinds already exist — fabricator/locker may need new glyphs in the object catalog; match existing glyph style).
- **Starter layout** (seeded for every player): fabricator (wall), 2 lockers (wall), bay console (wall), planning table (floor). One **deployment threshold**: a marked zone at the door (reuse the extraction-pad zone pattern, restyled as an elevator/door plate).
- No dots, no rivals, no ambient AI in the base. The player's bot spawns with empty bays.

## 2) Boot + session flow (`apps/client`)

- **The base is the boot screen.** App start (post name/token bootstrap): `LocalSession` on `createBaseMap(layout)` — the player walks around immediately. No menu screen renders. `/?studio` and the existing dev solo mode stay reachable exactly as today.
- **Interactions**: standing adjacent to an interactive object + holding the existing channel input runs a short client-side channel (~1s, reuse the channel-ring visual; movement cancels), then opens that object's panel. Panels are minimal title-block styled overlays:
  - **Locker** → stash browser: itemized stash contents (glyph + count), learned blueprints list. Read-only.
  - **Bay console** → loadout picker: withdraw up to 4 items from stash into loadout slots, or return loadout items to stash (see §4).
  - **Fabricator** → stub panel: lists learned blueprints and says fabrication comes online with the next base upgrade pass. No crafting.
  - **Planning table** → stub panel: "CONTRACTS — NOT YET COMMISSIONED".
- **Deployment threshold**: walking onto it starts a 1s channel → the room create/join UI (the existing lobby, restyled as a compact "DEPLOYMENT" overlay — code entry + squad list + start). Cancel by stepping off. Match end / manifest LEAVE → back to the base session, stash re-fetched.
- **Furniture placement/move**: from a slot's context (channel on an EMPTY slot marker, or a MOVE action on an occupied object's panel) open a slot picker; confirming re-slots the object. No free-form placement.

## 3) Fabrication-moment draw-on (renderer — the signature visual)

- When an object is placed into a slot (move or initial seed on first-ever boot), its linework **drafts itself stroke by stroke** over ~1.2s: the renderer already draws objects as ordered stroke lists — reveal them progressively (per-stroke progressive clipping or partial-path drawing; deterministic order: outline → interior detail). A hairline "pencil tick" leads the draw. Reuse this animation hook — M6's fabricator output will call the same thing.

## 4) Persistence (`apps/server` + Drizzle)

- **`base_layouts`** (schema exists in the roadmap plan; create the table now): player_id, slot_id, object_kind, unique(player_id, slot_id). Seed starter layout on player registration (and lazily for existing players on first fetch). Endpoints: `GET /api/base` (layout + stash + learned + loadout in one payload), `POST /api/base/layout` (full slot map, validated against the shell's slot ids server-side).
- **Loadout** (owner ruling — one-shot withdrawal, at-risk): `players.loadout` jsonb, up to 4 item codes.
  - Bay console withdraw/return = a transaction moving items between stash rows and `loadout` (`POST /api/base/loadout`). Blueprint fragments are NOT loadout-able (they're cargo, not gear) — powerups only.
  - At **matchStart**, the server reads the player's loadout and spawns their bays with it, then **clears the loadout** (items are now in-run). Extract → they bank back to stash like anything carried. Die/timeout → lost. If the loadout is empty, today's default spawn (1 health) applies unchanged.
- **Stateless mode** (no DATABASE_URL): base still boots and plays — layout falls back to localStorage client-side, lockers/bay console show an "OFFLINE — NO STORAGE LINK" hint, loadout unavailable, default spawn applies. Graceful exactly like M3/M4.

## 5) Tests

- Map: base shell passes the existing validation sweep (clearance, reachability of every slot and the threshold); `createBaseMap` is deterministic for a given layout; slot ids validated (bad slot/object kind rejected server-side).
- Server (DB mode): layout round-trip; loadout withdraw decrements stash + populates loadout atomically; return path restores stash; matchStart consumes loadout into spawn bays and clears it; extraction banks withdrawn items back; died path loses them (stash unchanged, loadout empty); blueprint withdrawal rejected; registration seeds the starter layout.
- Client: session flow unit-testable seams where cheap (boot lands in base session; threshold channel → deployment state). Visual polish (draw-on) is browser-verified, not unit-tested.
- Existing suites stay green in BOTH DB modes.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, visible window, DB up: cold boot lands in the base (no menu); locker shows the stash banked during M4 testing; bay console withdraws a health powerup → deploy via threshold → in-run bays show it → extract → back in base, item re-banked (and a died run loses it); fabricator/planning stubs open; moving a piece of furniture plays the draw-on; full loop base → run → manifest → base without a traditional menu.
3. Stateless boot: base playable with the offline hint; solo dev mode + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits (base map+slots / boot flow+panels / draw-on / persistence+loadout / tests).

## Report back

`handoffs/M5-REPORT.md`: shell + slot data shape, panel inventory, loadout transaction shape, draw-on implementation notes (M6 will reuse it), verification output for both modes + the live narrative.
