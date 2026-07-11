# M0-T1 completion report

## Workspace split

- Created the pnpm workspace root, shared `tsconfig.base.json`, and workspace scripts.
- Moved the pure simulation, data, and all four existing test files from `src/game/` to `packages/game/src/` as `@dotbot/game`.
- Added the `@dotbot/protocol` M1 stub with its workspace dependency on `@dotbot/game`.
- Moved Vite, React, Pixi, static assets, UI, input, hook, and renderer code to `apps/client/` as `@dotbot/client`.
- Rewired client-to-simulation imports through `@dotbot/game` source exports and updated `.claude/launch.json` to use Node 20's pnpm binary.
- Replaced `package-lock.json` with one root `pnpm-lock.yaml`. The lock preserves the checkpointed direct dependency versions; no hoisting configuration was needed.

## Deviations

No T1 implementation deviations. A concurrent untracked file, `handoffs/M0-T2-sim-generalization.md`, appeared after the required checkpoint while T1 was running. It was preserved untouched and excluded from the T1 commit, so the repository-wide `git status` is not empty even though all T1 changes are committed.

## Verification

- Node: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/node`
- pnpm: `9.15.0`
- `pnpm install`: clean; lockfile up to date, already up to date.
- `pnpm typecheck`: passed for `@dotbot/game` and `@dotbot/client`.
- `pnpm test`: 4 files passed, 52 tests passed, all under `packages/game`.
- Browser, `http://localhost:5173/`: map, moving bots, HUD, and restart rendered and worked; zero console errors.
- Browser, `http://localhost:5173/?studio`: building selection, floor chips, 1:1 zoom, and drag-pan rendered and worked; zero console errors.
- `pnpm build`: passed with Vite 8.0.16 (739 modules transformed).
- Git history: checkpoint commit followed by the T1 implementation commit; all T1 changes committed. The unrelated concurrent M0-T2 handoff remains untracked as noted above.

## Surprises

- A first unconstrained pnpm resolution selected newer compatible Vite/Vitest/plugin-react releases. The final lock was corrected to preserve the checkpoint's resolved direct versions, as required by the no-upgrade constraint.
- Rapier emits its existing deprecated-initialization console warning during browser startup. There were no console errors and no simulation code was changed.
- Vite retains the existing large-chunk warning during production build.
