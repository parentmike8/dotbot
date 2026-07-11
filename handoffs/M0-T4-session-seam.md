# Handoff M0-T4: `GameSession` seam (LocalSession extraction)

**Agent brief.** You are inserting the client-side abstraction that will later let a WebSocket-backed session (M1 `NetSession`) replace the in-browser simulation without touching the renderer or HUD. This task creates the interface and moves current behavior behind it. **Zero behavior change; zero changes inside `packages/`** — this is a client-only refactor.

**Precondition:** M0-T3 complete and green (`handoffs/M0-T3-REPORT.md` exists). If not, stop and report.

## Repo facts

- Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm` (shell default Node 16 breaks everything).
- Client game loop: `apps/client/src/game/useDotBotGame.ts` — owns rAF loop, fixed-timestep accumulator (60Hz), input capture (keyboard + touch joystick + dash queue), sim creation, snapshot→renderer each frame, throttled HUD state, FPS measurement (`sim.setMeasuredFps`).
- Sim API (post-T2/T3): `DotBotSimulation.create`, `applyInput(botId, input)`, `step()`, `getSnapshot()`, `drainEvents()`, `dispose()`; player bot id is `"player"`.
- Ordinary commits; never destructive git.

## The seam

New dir `apps/client/src/game/session/`:

```ts
// GameSession.ts
import type { GameSnapshot, InputCommand, MapDocument, SimEvent } from "@dotbot/game/types";

export interface GameSession {
  readonly map: MapDocument;
  readonly playerId: string;
  /** Async init (Rapier load today; WS connect for M1's NetSession). */
  start(): Promise<void>;
  /** Latest input intent for the local player; called once per render frame. */
  sendInput(input: InputCommand): void;
  /**
   * Advance session time by elapsedMs and return the freshest snapshot to
   * render (null until start() resolves). LocalSession runs the fixed-step
   * accumulator here; a future NetSession will interpolate buffered server
   * snapshots instead. The accumulator therefore MOVES OUT of the hook.
   */
  update(elapsedMs: number): GameSnapshot | null;
  /** Events since last drain (manifest/UI consumption lands in M1). */
  drainEvents(): SimEvent[];
  /** Debug instrumentation; optional so NetSession can no-op it. */
  setMeasuredFps?(fps: number): void;
  dispose(): void;
}
```

```ts
// LocalSession.ts — wraps DotBotSimulation; reproduces today's loop semantics exactly
export class LocalSession implements GameSession { ... }
```

**Semantics to preserve exactly (from the current hook):**
- Fixed 60Hz stepping via accumulator; the same clamp/cap on elapsed time the hook uses today (find it and move it verbatim — do not re-derive) so a background tab doesn't spiral.
- Input application order per tick: latest `sendInput` intent is applied via `applyInput("player", input)` before each `step()`, matching current per-frame behavior. Dash stickiness already lives in the sim (T2); do not add another queue in the session.
- `getSnapshot()` frequency: the hook currently snapshots once per rendered frame, not per sim tick — keep that (snapshot in `update` return, after stepping).

## Hook refactor (`useDotBotGame.ts`)

- Hook constructs `new LocalSession({ map: downtownMap, config: defaultGameConfig, playerId: "player" })`, awaits `start()`, and drives it: each rAF → gather input → `session.sendInput(...)` → `session.update(elapsed)` → renderer + throttled HUD exactly as now. FPS measurement forwards through `setMeasuredFps?.()`.
- The hook keeps: input listeners, joystick state, dash button, resize handling, renderer lifecycle, restart-on-remount disposal. It loses: direct `DotBotSimulation` imports and the accumulator.
- Return shape of the hook is unchanged for consumers except it may re-export `map`/`playerId` from the session (App already consumes those post-T2).
- Session construction goes through a tiny factory (`createSession(kind: "local", opts)`) so M1 adds `"net"` without touching the hook again — keep it minimal, no speculative NetSession stubs.

## Hard constraints

- `packages/**` untouched (verify with `git diff --stat` — only `apps/client` paths may appear).
- No renderer/HUD/App visual changes; Map Studio untouched (it doesn't use sessions).
- No new client test infrastructure; correctness bar is the behavior freeze below.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck` clean; `pnpm test` — game package suite passes with counts unchanged from T3's report.
2. `pnpm dev` browser check: gameplay indistinguishable (movement/dash feel, AI fights, revives, location label transitions entering a building, restart button remounts cleanly without leaks — restart twice in a row), Map Studio unaffected. Zero console errors, including after restarts.
3. `pnpm build` passes.
4. `git diff <T3-head>..HEAD --stat` shows only `apps/client` + this handoff's report; `git status` clean.

## Report back

`handoffs/M0-T4-REPORT.md`: final `GameSession` interface as landed, what moved out of the hook (accumulator/clamp specifics), any deviation + justification, verification output. Terse; this closes milestone M0.
