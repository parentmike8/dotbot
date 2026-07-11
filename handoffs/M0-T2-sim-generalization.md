# Handoff M0-T2: Sim API generalization (multi-controller, events, slim snapshot)

**Agent brief.** You are generalizing the game simulation from "one hardcoded human player" to "N bots, each driven by a controller," and adding an event queue — the API the future multiplayer server builds on. This is an API refactor with **ZERO gameplay behavior change**: same movement, same AI, same combat outcomes, same determinism.

**Precondition:** M0-T1 (monorepo split) is complete and its exit criteria hold (`handoffs/M0-T1-REPORT.md` exists; tests green). All paths below use the post-T1 layout. If T1 is not merged, stop and report.

## Repo facts you need

- Node 20 binaries ONLY (shell default Node 16 breaks everything): `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm` (and `node`/`npx` beside it).
- Sim: `packages/game/src/simulation.ts` — class `DotBotSimulation`, fixed-tick, deterministic (there is a determinism regression test — it is your safety net and must keep passing byte-identical).
- Client: `apps/client/src/game/useDotBotGame.ts` (game loop hook), `apps/client/src/ui/App.tsx` (HUD), `apps/client/src/game/renderer/GameRenderer.ts`.
- Tests: `packages/game/src/simulation.test.ts` (+ 3 other files), currently 52 tests total, all passing.
- Commit protocol: work in ordinary commits on top of T1; never destructive git.

## The API you are building

Add to `packages/game/src/types.ts`:

```ts
export type Controller = "human" | "ai" | "frozen";

export type SimEvent =
  | { type: "downed";   botId: string; byBotId?: string }
  | { type: "consumed"; botId: string; byBotId: string }
  | { type: "revived";  botId: string; byBotId: string }
  | { type: "dotCaptured"; botId: string; dotId: string }
  | { type: "dotsBanked";  botId: string; count: number };  // current banking behavior; M1 will replace with "extracted"
```

`DotBotSimulation` public surface after this task:

```ts
static create(options): Promise<DotBotSimulation>   // unchanged signature
spawnBot(spawn: BotSpawn, controller: Controller): string  // returns bot id; usable mid-run
removeBot(botId: string): void                       // frees physics body+collider, purges all references
setController(botId: string, controller: Controller): void
applyInput(botId: string, input: InputCommand): void // replaces applyInput(input)
step(): void
getSnapshot(): GameSnapshot
drainEvents(): SimEvent[]                            // returns queued events since last drain, then clears
dispose(): void
```

### Semantics (each row is a requirement)

| Concern | Requirement |
|---|---|
| Controller storage | `Map<botId, Controller>` internal. `create()` assigns `"human"` iff `spawn.team === "player"`, else `"ai"` — exactly reproduces today's behavior. (`team` itself is NOT touched in this task; the team→squad refactor is T3.) |
| Input routing | `Map<botId, InputCommand>` internal. `applyInput(botId, input)` stores; each `step()` applies stored intent for every `"human"` bot (generalize the current single-player intent function). Preserve today's dash semantics exactly: a queued dash must not be lost between input frames and is consumed when it fires. Inputs for unknown/non-human bots are ignored silently. |
| AI gating | The AI update runs only for bots whose controller is `"ai"` (currently it skips `team === "player"` — key it off controller instead, same net effect at create-time). `"frozen"`: alive body stays as a physical obstacle, zero desired movement, no AI, no input. |
| Speed selection | UNCHANGED in this task: keep the existing `team`-based speed choice (`playerSpeed` for team "player"). Do not re-key it to controller — that question belongs to T3. |
| `spawnBot` | Extract from the existing private `addBot`; public, returns the id, also registers the controller. `create()` uses it for `map.botSpawns`. |
| `removeBot` | Remove collider then rigid body from the Rapier world; delete from the bots map, controller map, input map; drop any coverage entries involving the bot (as actor or target); clear `capturedBy` on any dot captured by it; no dangling references. Removing an unknown id is a no-op. |
| Events | Internal queue, appended at the exact points the sim already decides these outcomes: bot downed (in damage resolution), consumed, revived, dot capture completed, dots banked at extraction. `drainEvents()` returns and clears. Events must NOT enter `getSnapshot()` and must NOT affect determinism (queue is write-only during `step`). |
| Slim snapshot | Remove `map`, `playerId`, and `locationLabel` from `GameSnapshot` (they are per-viewer or static — the client now owns them; see below). Keep `bankedDots`/`rivalBankedDots`/`debug` for now (M1 removes banking). |

## Client compensation (required so behavior is visually identical)

1. `useDotBotGame.ts`: calls `applyInput("player", {...})`; expose `map` (it already has `downtownMap`) and `playerId: "player"` from the hook's return value.
2. `GameRenderer.render(snapshot)` → `render(snapshot, playerId)`: replace internal uses of `snapshot.playerId`. The renderer already receives the map at construction — audit for any `snapshot.map` usage and switch to the constructor map.
3. `App.tsx`: take `map` and `playerId` from the hook. Compute the location label client-side with the existing pure helper `locationLabel(map, floorId, position)` from `@dotbot/game/mapModel`, using the player bot's `floorId` + `position` from the snapshot. The HUD must read exactly as before (e.g. `LOT 6 DEPOT / B1` indoors, `DOWNTOWN` on the street).
4. Map Studio is untouched (it never used snapshots).

## Test updates + additions

- Mechanical: every existing `simulation.applyInput({...})` becomes `simulation.applyInput("player", {...})`. **Do not alter any assertion or expected value.** All 52 existing tests must pass with unchanged expectations (the determinism digest may need `map`/`playerId`/`locationLabel` removals mirrored if it references them — mirror, don't weaken).
- Add new tests (same file or `simulation.api.test.ts`):
  a. Two human-controlled bots receiving different inputs move independently (spawn a second human via `spawnBot`).
  b. `removeBot` mid-run: bot disappears from snapshots, its dot `capturedBy` clears, no crash on subsequent steps; removing an unknown id is a no-op.
  c. `setController(id, "frozen")` stops movement but the body still blocks (another bot colliding with it behaves as against any solid).
  d. `drainEvents` yields `downed`/`revived`/`consumed` in a scripted fight, and returns `[]` on the second drain.

## Hard constraints

- No gameplay/tuning changes; no renames beyond this spec; no touching `packages/game/src/shields.ts`, map content, renderer drawing code (only the `render` signature + `snapshot.map`/`playerId` plumbing), or the docs/handoffs/artifacts dirs.
- The determinism test passes UNMODIFIED except for mechanical snapshot-field mirroring described above.

## Exit criteria (verify each, state each explicitly in your report)

1. `pnpm typecheck` clean; `pnpm test` → all existing 52 tests pass with unchanged assertions + your new API tests pass.
2. `pnpm dev` → in the browser: game plays identically (movement, dash, AI fights, revives, restart button, floor rail); the location label still updates when entering buildings/floors; Map Studio (`/?studio`) unaffected. Zero console errors.
3. `pnpm build` succeeds.
4. `git status` clean; commits atomic and messaged.

## Report back

Write `handoffs/M0-T2-REPORT.md`: the final public API as implemented, every deviation from this spec with justification, where each event is emitted (function names), test count before/after, and verification output. Terse but complete — this report is the audit input.
