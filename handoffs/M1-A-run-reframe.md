# Handoff M1-A: Run reframe + identity palette (extraction game, offline)

**Agent brief.** You are converting the run loop from "score race" to "extraction game" and switching bot rendering to the relationship-based color system. This is a big, bundled task — take it in the commit stages listed at the end. Design authority: `dotbot-systems-spec.md` §1, §6 (Bots), §8; sequencing: `dotbot-implementation-roadmap.md` M1. Unlike M0 tasks, this one **intentionally changes behavior** — the spec below defines the new behavior precisely.

**Parallel-lane rules (another agent works in this repo simultaneously on M1-B):**
- YOUR ownership zone: `packages/game/**`, `apps/client/src/game/renderer/**`, `apps/client/src/game/useDotBotGame.ts`, `apps/client/src/ui/App.tsx` + new manifest UI files, `apps/client/src/ui/styles.css`.
- DO NOT touch: `packages/protocol/**`, `apps/server/**`, `apps/client/src/game/session/createSession.ts`, any `session/Net*` or lobby files, `apps/client/src/main.tsx`.
- You may add fields/types to `packages/game/src/types.ts` freely — you are the exclusive owner of that file in this phase.
- Commit frequently and atomically; the other lane rebases on you.

**Preconditions:** M0 complete (T1–T4 reports in `handoffs/`, 58 tests green). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm` (shell default Node 16 breaks everything). **When browser-verifying: the browser window must be visible/unoccluded — Chrome suspends requestAnimationFrame in hidden windows and the game will look frozen.**

## Part 1 — Kill the score (sim)

- Remove `bankedDots` and `rivalBankedDots` from `GameSnapshot`, the sim, and the HUD; remove the `dotsBanked` event and the sim's `primarySquadId` (dies with banking).
- Extraction pads no longer bank. The extract channel (same channel verb, same load-scaled duration if present, else current duration) now **ends the bot's run**:
  - On completion for a NON-ambient bot: emit `{ type: "extracted", botId, squadId, inventoryDots }`, then `removeBot(botId)`.
  - Ambient (grey) bots STOP seeking extraction entirely: remove the extract intent from ambient AI target selection (they loot, hunt, revive/consume as today, but never leave). This replaces rival banking pressure until real enemy squads exist.

## Part 2 — Run lifecycle (client-owned for solo play)

- Add `runDurationMs` to `GameConfig` (default `480_000` — 8 minutes).
- The HUD run clock becomes a COUNTDOWN (`07:59` …). Keep the element/test-ids intact.
- The run ends for the player when ONE of:
  a. `extracted` event for the player bot → outcome `"extracted"`.
  b. `consumed` event for the player bot → outcome `"died"` (haul lost). Note: consumed players no longer respawn into the same run — gate the existing respawn path to ambient bots only.
  c. `snapshot.timeMs >= runDurationMs` → outcome `"timeout"` (haul lost). Enforced in the client hook (the future server Room will own this; do not put match rules in the sim).
- On run end: freeze input handling, keep the world rendering beneath, and show the **Manifest screen**.

## Part 3 — Manifest screen (client UI)

Full-screen overlay styled as an **architectural title block** (match the game's drafting aesthetic: white panel, hairline rules, black uppercase lettering — reuse the HUD's paper/ink CSS variables). Content rows:
- OUTCOME: EXTRACTED / CONSUMED / RUN EXPIRED.
- KEPT: dots extracted with (only on `"extracted"`; otherwise 0).
- LOST: dots carried at death/timeout.
- KILLS: two counters tallied client-side from drained `consumed` events where `byBotId` is the player or a squadmate — split AI (ambient) vs player-bots (non-ambient).
- RUN TIME.
- One action: `↻ NEW RUN` (reuse the existing remount-restart mechanism).
The hook must expose drained `SimEvent[]`s per frame to App for the tallies (extend the hook's return; `GameSession.drainEvents` already exists).

## Part 4 — Free revive + cracked plate (spec §8)

- `reviveBot`: remove the 1-dot cost (no inventory decrement; delete any AI gating requiring the reviver to carry a dot).
- Revived bots return with **one cracked plate**: `shieldSegments = [0.5, 0, ...]`, `shields = 0.5` (use `platesForCount`-style construction; `packages/game/src/shields.ts` semantics unchanged).
- Update the existing revive test assertions from `shields === 1` to `0.5` (this is the intended behavior change; note it in your report).

## Part 5 — Relationship palette (spec §6 Bots; renderer only)

In `GameRenderer` (viewer identity = the `playerId` passed to `render`):
- **Bodies**: every bot's body core renders BLACK (`INK.structure`); the per-spawn `color` field is no longer used for bodies (leave the data field in place).
- **Plates** carry the only faction color: viewer's squad → cyan `#15aabf`; non-ambient other squads → red `#e03131` **with a redundant shape cue** (serration: draw a second, thinner arc 3px outside each intact plate — must be visible at gameplay zoom); ambient bots → grey `#868e96`. Cracked/broken plate states keep their existing stroke treatments, in the faction hue.
- **Downed bots**: hollow ring (no fill) in faction hue — no new colors.
- **Channel rings** (capture/revive/consume/extract progress): rendered in the CHANNELER's faction hue relative to the viewer (a red ring over your downed ally IS the consume warning). Squad-through-wall ghosting and LOS masking behavior unchanged.
- HUD shield pips: recolor fills to the cyan; cracked gradient likewise.
- Dots/map/everything else: unchanged (dot taxonomy is M4).

## Tests (packages/game)

- Update: revive assertions (0.5); any test referencing banking fields or `dotsBanked`; determinism digest mechanically mirrors removed fields.
- Add: (a) extract channel completion emits `extracted` and removes the bot from subsequent snapshots; (b) ambient AI never acquires an extract target (e.g. run N ticks with a lone ambient bot next to a pad and assert it persists); (c) revive costs nothing and yields `[0.5, 0, 0]`.
- Full suite green.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`, `pnpm test`, `pnpm build` all pass.
2. Browser (visible window!): countdown runs; walking onto a pad and channeling ends the run with the manifest (KEPT = carried dots); dying to rivals shows CONSUMED manifest with LOST; letting the clock expire shows RUN EXPIRED; NEW RUN starts clean twice in a row; squad renders cyan-on-black, rivals grey (all current rivals are ambient), downed bots hollow; zero console errors.
3. Map Studio unaffected.
4. `git status` clean; staged commits: (1) score removal + extraction rework, (2) run lifecycle + manifest, (3) revive changes, (4) palette.

## Report back

`handoffs/M1-A-REPORT.md`: what changed per part, every intentional assertion change, event flow from sim→hook→manifest, verification output.
