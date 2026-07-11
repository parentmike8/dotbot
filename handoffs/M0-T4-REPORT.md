# M0-T4 completion report

## Final session seam

`apps/client/src/game/session/GameSession.ts` defines:

```ts
interface GameSession {
  readonly map: MapDocument;
  readonly playerId: string;
  start(): Promise<void>;
  sendInput(input: InputCommand): void;
  update(elapsedMs: number): GameSnapshot | null;
  drainEvents(): SimEvent[];
  setMeasuredFps?(fps: number): void;
  dispose(): void;
}
```

`LocalSession` wraps `DotBotSimulation`. `createSession("local", options)` is the only construction path used by the hook; no network-session stub was added.

## Moved out of `useDotBotGame`

- The fixed-step accumulator moved to `LocalSession.update`.
- Frame elapsed time is converted from milliseconds to seconds and capped verbatim at `Math.min(0.1, elapsedMs / 1000)`.
- Tick duration remains `1 / config.tickHz` (60 Hz with current configuration).
- Each accumulated tick applies the latest local input before `simulation.step()`.
- `update` calls `getSnapshot()` once after all ticks, preserving one snapshot per render frame rather than per tick.
- Simulation creation, input routing, event draining, FPS forwarding, and disposal now live behind the session interface.

The hook retains keyboard/touch input capture, the UI Dash queue, rAF/FPS bookkeeping, renderer and resize lifecycle, throttled HUD state, and restart-on-remount cleanup.

To preserve a Dash press on a render frame that produces no sim tick, `sendInput` immediately forwards the intent into the simulation's existing sticky Dash input and stores movement with `dash: false` for per-tick reapplication. This adds no second Dash queue and prevents one press from being requeued across multiple ticks.

## Deviations

None.

## Verification

- `pnpm typecheck`: passed for game and client.
- `pnpm test`: 4 files passed; 58 tests passed, unchanged from T3.
- `pnpm build`: passed with Vite 8.0.16; 741 modules transformed. Existing large-chunk warning remains.
- Browser game route: movement and AI/rival activity continued; Dash moved once, became ready after cooldown, and did not repeat; location changed from `DOWNTOWN` to `LOT 6 DEPOT / GROUND`; rival banking incremented; two consecutive restart clicks each reset the run to `00:00`. Zero console errors before or after restarts.
- Browser Map Studio route: rendered unchanged; Beacon House selection and ROOF/F1/GROUND chips worked. Zero console errors.
- Scope from T3 head (`3203ab2`): only `apps/client/src/game/session/*`, `apps/client/src/game/useDotBotGame.ts`, the authorized T4 handoff, and this report. `packages/**` is untouched.
- Git history uses separate atomic handoff, implementation, and report commits. `git status` is clean.
