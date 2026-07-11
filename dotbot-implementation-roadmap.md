# DotBot: Implementation Roadmap — Base, Economy, Multiplayer & Systems

## Context

The July 2026 ideation spec reframes DotBot from a score-race sandbox into a **squad extraction game**: dots are materiel, runs end by extracting or dying, progression lives in a persistent off-map base that doubles as the menu, and blueprints learned from the city unlock fabrication. The current build is a single-player browser sandbox (deterministic 60Hz TypeScript sim + Rapier, Pixi renderer, AI bots, the rebuilt Downtown map) with none of the meta systems and no networking.

Owner decisions from planning Q&A: **plan the whole spec now** (this document), **server-authoritative Node netcode** reusing the existing sim, **Node + Postgres self-hosted** backend in a shared-types monorepo, **2–3 squads** per match on the current map, **run timer** plus extract-or-die lifecycle, and sequencing driven by **"friends can playtest in the browser ASAP."**

Deliverable of this plan: commit this roadmap to the repo as `dotbot-implementation-roadmap.md` and reconcile the two existing spec docs with the decided design (no code yet). Implementation then proceeds milestone by milestone, each its own plan/approval.

---

## Locked architecture decisions

| Area | Decision |
|---|---|
| Topology | Server-authoritative: the existing `DotBotSimulation` runs headless in Node (vitest already proves headless viability); clients send inputs, server broadcasts snapshots |
| Monorepo | pnpm workspaces: `packages/game` (sim+map, moved from `src/game` minus renderer/input), `packages/protocol` (wire types + interest filtering), `apps/client` (Vite/React/Pixi), `apps/server` (Fastify REST + bare `ws`, one deployable that also serves the built client — one URL, no CORS) |
| Shared code | Internal-package pattern: packages export TS source; Vite compiles directly, server uses `tsx` dev / esbuild bundle prod. Rapier is a dependency of `packages/game` ONLY (kills client/server version skew) |
| Protocol v1 | JSON over WebSocket + permessage-deflate; entity statics sent once (`matchStart`/`meta`), floats rounded; sim 60Hz, broadcast 20Hz, inputs 30Hz with seq numbers. ~25–40 KB/s per client worst case — binary protocol explicitly deferred |
| Prediction | Phase A: thin client (interpolate everything, ~120ms feel) to ship fast. Phase B: own-bot prediction via a physics-lite model (circle-vs-rect sweep against `MapDocument` walls, reference `resolveWallPenetration`) + input replay and error-blending. **Never rollback** |
| Rooms | One Node process, N rooms in-process (Rapier step for ~40 bodies ≪1ms), 4-char join codes, lobby→countdown→live→results. Worker-per-room deferred |
| Persistence | Postgres + Drizzle. Device-token anonymous auth (128-bit token in localStorage, hashed server-side, display name only). **Extraction manifests written at extraction time**, not match end — a crash must never eat a successful extract |
| Offline mode | Preserved by construction via a `GameSession` interface: `LocalSession` (in-browser sim — solo play, Map Studio) vs `NetSession` (WebSocket). Renderer stays network-agnostic |
| Interest mgmt | v1: full room state (fine at this scale). v2: filter by physics-floor context (`contextKey`/`physicsFloorId` in `mapModel.ts`) + squadmates always visible. True LOS culling + entity-id randomization deferred |

---

## Milestones

### M0 — Repo split + sim generalization (no networking, no behavior change)

The enabling refactor. Exit criteria: game plays identically offline; all tests green.

- pnpm workspaces; move `src/game` → `packages/game` (renderer, `useDotBotGame.ts`, `input.ts` stay client-side); `packages/protocol` stub; root scripts (`pnpm dev`, `pnpm test`).
- **Sim API generalization** (`simulation.ts`): controller map (`human | ai | frozen`) replacing the hardcoded `"player"` special case; `applyInput(botId, input)`; `spawnBot`/`removeBot` public; `drainEvents(): SimEvent[]` (`extracted/downed/consumed/revived` — the server's persistence primitive); slim `GameSnapshot` (drop `map` and `playerId` from the per-tick payload).
- **Team → squad refactor**: `BotTeam ("player"|"ally"|"enemy")` becomes `squadId: string` + `isAmbient: boolean` (grey AI). Friendly-fire, revive/consume eligibility, and AI targeting key off squad. Most invasive change in the whole roadmap — done here, alone, behind the existing determinism + 52-test suite.
- `GameSession` seam in the client (`LocalSession` wrapping the sim = current behavior).

### M1 — Run reframe + netcode MVP: "friends fight and extract in one room"

The milestone that matters. No DB, no auth beyond a name, no prediction, no interest filtering. Deployed on one Fly/Railway machine.

- **Kill the score** (spec §1): remove `bankedDots`/`rivalBankedDots`, banking-on-pad behavior, and rival-race HUD. Extraction channel now **ends your run with your haul**; scaled by load size.
- **Run lifecycle**: room-owned run timer in ticks (`endTick`); consume with no revive → out (haul lost); `runOver` (extracted/died/timeout) → **manifest screen** rendered as an architectural title block (kept/learned/lost + AI and player kill counts); `matchEnd` at timer.
- **Revive changes** (spec §8): free (no dot cost); revived bot returns with **one cracked plate** (`platesForCount`-style `[0.5,0,0]` — invariant: a standing bot always shows ≥1 arc); plea-to-revive ping (v1: own squad; all-squads plea later with the loot-then-revive verbs).
- **Faction color by relationship** (spec §6, partial): plate hue derived client-side from viewer's squad — cyan self/squad, red enemy squads (+ double-stroke/serration redundant cue), grey ambient AI. Bot bodies black. Channel rings in channeler's hue. (Body customization canvas deferred.)
- **Server** (`apps/server`): Fastify + `ws`, RoomManager with join-by-code lobby, host-start, per-room accumulator tick loop, 20Hz snapshots, event drain; **reconnect grace** (15s frozen → AI handoff — ally AI already loots/revives/extracts); AI backfill of empty squad slots (red stand-in squads) + ambient greys from `map.botSpawns`.
- **Client**: `NetSession`, lobby/join UI (`/#/r/ABCD`), thin-client rendering, run timer via ping/pong clock sync.

### M2 — Feel + fairness

- Own-bot prediction (LitePredictor + replay/blend; dash predicted locally; channels render optimistically but progress is server-driven).
- Interest filtering by floor context + squadmates-always; spectate-after-death (squad perspective) or leave.
- Tick-time and bandwidth counters on `/api/health`; tune snapshot rate if needed.

### M3 — Persistence + identity

- Postgres via docker-compose (dev) / managed (prod); Drizzle schema: `players`, `hold_items`, `learned_blueprints`, `base_layouts`, `upgrades`, `match_results`, `match_participants`.
- Device-token registration; hold survives between runs; manifest history ("what you extracted/learned/lost") backed by DB.

### M4 — Dot taxonomy + inventory v2 (spec §5–§7)

- **Powerups are the currency** (owner ruling on open Q1 — no plain currency dot): orange glyph family — cross (health/plate restore), concentric arcs (radar), chevron (dash overcharge), dashed outline (incognito/muffle). Stored-and-fired items, not instant-on-capture. Legacy identity-colored dots and the `DOT` palette in `content/downtown.ts` retired.
- **Blueprints** (blue plan-tick glyph): spawn tables driven by the existing `scannable` flags — blueprint dots anchor to their real object (beds at Mercy, racks at Civic, forklift at Lot 6). 2–4 extracted copies = permanently learned. Carried copies lootable; learned unlosable.
- **Bays(4) + Hold(~12)**: hold as backpack storage; mid-run bay⇄hold swap is a noisy channel; free at base. Everything carried lootable on consume; extraction/deposit channel time scales with load. (Naming "bays" flagged — revisit.)
- Diegetic dot legend on the pause screen, drawn as a title-block key.
- Ambient AI made genuinely "dumb obstacle" (no loot/extract/revive verbs for greys); red stand-in squads keep full behavior.

### M5 — Base-as-menu (spec §2)

- Base = small fixed-shell `MapDocument` per player with zoned placement blocks; stored in `base_layouts`. **The base is the boot screen**: spawn as your bot, walk to objects, channel to use; walk out the door / deployment elevator to queue.
- Starter objects: fabricator, 2 lockers (hold), bay console (loadout), planning table (stub), door/elevator threshold.
- **Fabrication moment**: channel at a zoned block → object linework drafts itself stroke by stroke (signature visual; renderer already draws everything as strokes — animate reveal along a per-glyph draw order).
- Placement/move of furniture via channel + slot picker (no free-form editor v1). Squadmate visiting deferred until squad-social exists.
- Reuses: map model, renderer, Map Studio's camera/selection patterns.

### M6 — Economy loop closure (spec §3–§4)

- Fabricator recipes: powerups + furniture, costs paid from hold stock; blueprint-gated. Upgrade tracks v1: lockers (capacity), repair bench (plate kits — field plate restore carryable), bay console presets. Shell/footprint upgrade as the big sink (second floor reuses stairs/floor system).
- Guard rail enforced in data: **upgrades expand options/capacity/information, never stats** (spec's legibility principle).

### M7 — Contracts, insertion preferences, matchmaking v2 (spec §10–§11)

- Planning table contracts: spatial objectives ("extract X blueprint from Mercy F1") paying out powerups/blueprints; tiered by table level.
- Insertion: preference-not-pick registered at the planning table; matchmaker does constrained assignment, ~80% preference weighting, **minimum squad-spacing rule hardcoded above all preferences**; insertion points > squads always.
- Squad social: invites, join requests, all-squads revive pleas + loot-then-revive verb set (consume / revive-clean / loot-then-revive).

### M8 — Mines + intel objects (spec §3, §6)

- Mines: disguised as normal dots; detonate = exactly one plate shattered (bounded exception to collision-only damage); **proximity ping to placer's squad even without detonation** (owner addition — mines are sensors); hairline seam tell; X-marked for own team; radar reveals; 2–3 active cap.
- Intel furniture: listening post (AI density per building pre-run), signal mast (marks one blueprint location at insertion).

### Documented, not built (owner's cut list §12 + deferrals)

Shield geometries (§9 — explicitly "do not build yet"), on-map bases, vault/raiding, defense contracts, damage traps beyond mines, cross-squad recruiting, AI revival, base-built extraction beacons, voice (revisit vs click-to-ping later), base visiting scope.

---

## Key files (existing code that carries the load)

- `src/game/simulation.ts` → `packages/game` — controller map, squad refactor, events, extraction rework
- `src/game/types.ts` — squadId, slimmed snapshot, item/dot taxonomy types
- `src/game/useDotBotGame.ts` — splits into `GameSession` / `LocalSession` / `NetSession`
- `src/game/mapModel.ts` — `contextKey`/`physicsFloorId` power interest filtering
- `src/game/shields.ts` — cracked-plate revive state already exists (`0.5` plates)
- `src/game/content/downtown.ts` — `scannable` flags become blueprint spawn tables; `DOT` palette retired
- `src/game/renderer/` — relationship-hue plates, dot glyph family, manifest/title-block screens, fabrication draw-on
- `src/ui/MapStudio.tsx` — camera/selection patterns reused by the base editor

## Risks (top 4)

1. **Squad refactor destabilizes sim** → done alone in M0 behind the 52-test suite + determinism test.
2. **Prediction jitter from float divergence** → architecture never depends on cross-platform determinism; lite-model + blend only.
3. **Server GC/tick jitter** → one wire snapshot per room per broadcast, per-client filtering from that object; health counters from day one.
4. **Scope gravity** → M1 ships with *placeholder* economy; every meta system (M4+) layers onto live playtests, and the §12 cut list is authoritative.

## Verification strategy

- Per milestone: existing vitest suites stay green; new suites for protocol round-trips, interest filtering (pure functions), and a two-headless-clients-vs-server integration test driving a full join→fight→extract→manifest loop in Node.
- Manual gates: M1 = two browsers on LAN complete a full run; M3 = extraction survives a mid-match server kill (manifest persisted); M5 = cold boot lands in base, full loop base→run→manifest→base without a traditional menu.

## Immediate next steps on approval

1. Save this roadmap as `dotbot-implementation-roadmap.md` in the repo root beside the other specs.
2. Update `dotbot-game-spec.md` / `dotbot-map-and-editor-spec.md` where they contradict decided design (banking/score references, revive dot cost, base-on-map remnants), marking superseded sections.
3. Record decisions in project memory.
4. Then: plan M0 in detail as its own implementation pass.
