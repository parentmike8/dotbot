# Handoff M0-T1: pnpm monorepo split

**Agent brief.** You are restructuring a working single-package game repo into a pnpm monorepo. This is a *mechanical move* — **zero behavior changes, zero refactors, zero dependency upgrades**. When done, the game must play identically and every test must pass unchanged. Build order context lives in `dotbot-implementation-roadmap.md` (milestone M0); you do not need it to execute this task.

## Repo facts you need

- Browser game: Vite 8 + React 19 + pixi.js 8; deterministic game sim in TypeScript + `@dimforge/rapier2d-compat` (WASM, inits fine in Node — vitest already runs the sim headless).
- **Node 20 is required and is NOT the shell default.** Use these binaries explicitly for every command:
  `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/node`, `.../bin/npm`, `.../bin/npx`, and (after corepack, below) `.../bin/pnpm`.
- Current layout: everything under `src/`; `index.html` + `vite.config.ts` at root; tests in `src/game/*.test.ts` (vitest, 52 tests, all passing); `public/assets/` static dir; `.claude/launch.json` launches the dev server.
- The working tree contains recent uncommitted work. **Precondition (required): commit everything as a checkpoint before touching anything**, message: `Checkpoint before monorepo split` (append the standard co-author trailer if the repo uses one). Then do all T1 work as ordinary commits on top. Never use destructive git commands.

## Target layout

```
DotBot/
├── package.json                  # root (private), workspace scripts only
├── pnpm-workspace.yaml           # packages: ["packages/*", "apps/*"]
├── tsconfig.base.json            # shared strict compiler options
├── docs *.md, .claude/, handoffs/, artifacts/   # unchanged locations
├── packages/
│   ├── game/                     # @dotbot/game
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/                  # MOVED from src/game/, except the client-only files below
│   │       ├── index.ts, simulation.ts, types.ts, config.ts, math.ts,
│   │       ├── mapModel.ts, navigation.ts, shields.ts, visibility.ts, rapier.ts
│   │       ├── content/downtown.ts
│   │       └── *.test.ts         # all existing sim tests move with it
│   └── protocol/                 # @dotbot/protocol — STUB ONLY
│       ├── package.json          # dep: @dotbot/game workspace:*
│       └── src/index.ts          # `export {};` + one-line comment "wire types land in M1"
└── apps/
    └── client/                   # @dotbot/client
        ├── package.json          # react, react-dom, pixi.js, vite, plugin-react + @dotbot/game workspace:*
        ├── vite.config.ts        # MOVED from root
        ├── index.html            # MOVED from root
        ├── tsconfig.json
        ├── public/               # MOVED from root public/
        └── src/
            ├── main.tsx, vite-env.d.ts
            ├── game/
            │   ├── renderer/     # MOVED from src/game/renderer/ (client-only: draws with pixi)
            │   ├── useDotBotGame.ts, input.ts   # client-only: DOM/React
            └── ui/               # App.tsx, MapStudio.tsx, styles.css
```

**Split rule:** `renderer/`, `useDotBotGame.ts`, `input.ts` are client code (they import pixi/React/DOM) and move to `apps/client/src/game/`. Everything else in `src/game/` is pure sim/data and moves to `packages/game/src/`. Use `git mv` so history follows.

## Package wiring (the load-bearing details)

1. **pnpm via corepack**: root `package.json` gets `"packageManager": "pnpm@9.15.0"`. Run `corepack enable` using the Node-20 bin. Delete `package-lock.json`; a single root `pnpm-lock.yaml` replaces it. Add `node_modules` handling as pnpm defaults (no `.npmrc` tweaks unless install fails; if Vite/React complain about peer resolution, add `public-hoist-pattern[]=*` and note it in your report).
2. **Internal package = source exports, no build step.**
   `packages/game/package.json`:
   ```jsonc
   {
     "name": "@dotbot/game",
     "private": true,
     "type": "module",
     "exports": { ".": "./src/index.ts", "./*": "./src/*.ts", "./content/*": "./src/content/*.ts" },
     "dependencies": { "@dimforge/rapier2d-compat": "<same version as today>" },
     "devDependencies": { "typescript": "<same>", "vitest": "<same>" },
     "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
   }
   ```
   Rapier appears in `packages/game` **only** — remove it from every other package.json.
3. **Client imports**: replace relative imports into the moved sim with package imports:
   `import { downtownMap } from "@dotbot/game/content/downtown"`, `"@dotbot/game/types"`, `"@dotbot/game/mapModel"`, `"@dotbot/game/shields"`, etc. `src/game/index.ts` (the barrel) becomes the package root export — keep whatever it currently re-exports; do not expand it. Renderer files keep importing their sibling `style.ts`/`glyphs.ts`/`mapArt.ts` relatively (those all move together into the client).
4. **tsconfig**: `tsconfig.base.json` holds the current compiler options (copy from existing root tsconfig; ensure `"moduleResolution": "bundler"` or `"NodeNext"`-compatible resolution that honors `exports` — the repo currently builds with Vite defaults; preserve them). Each package extends base. Root `tsconfig.json` may remain as a solution file or be removed — your choice, but `pnpm -r typecheck` must pass.
5. **Root scripts**:
   ```jsonc
   "scripts": {
     "dev": "pnpm --filter @dotbot/client dev",
     "build": "pnpm --filter @dotbot/client build",
     "test": "pnpm -r test",
     "typecheck": "pnpm -r typecheck"
   }
   ```
   Client package scripts: `dev`: `vite --host 0.0.0.0`, `build`: `tsc --noEmit && vite build`, `typecheck`: `tsc --noEmit`.
6. **`.claude/launch.json`**: update the existing `dotbot` entry to
   `runtimeExecutable: "/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm"`, `runtimeArgs: ["--filter", "@dotbot/client", "dev"]`, `port: 5173` (unchanged).
7. **vite.config.ts** after the move: adjust any root-relative paths (`public/` now sits beside it, so defaults work). No aliases needed — the workspace dependency + `exports` field resolves `@dotbot/game`.

## Hard constraints

- No formatting sweeps, no lint/CI additions, no Turborepo/Nx, no dependency version changes, no renames beyond this spec, no edits to sim logic or renderer drawing code beyond import paths.
- `tsconfig.tsbuildinfo`, `dist/` are build artifacts — delete rather than move; ensure `.gitignore` covers them (extend it if the move changes paths).
- Do not touch `handoffs/`, `artifacts/`, the five `dotbot-*.md` docs, or memory/plan files.

## Exit criteria (all must hold — verify each, then say so explicitly in your report)

1. `pnpm install` clean from repo root (Node 20 bin).
2. `pnpm typecheck` passes for all packages.
3. `pnpm test` → **4 test files, 52 tests, all passing** (unchanged counts; they now run inside `packages/game`).
4. `pnpm dev` serves on :5173; in a browser BOTH routes work visually: the game at `http://localhost:5173/` (bots moving, map rendering, HUD, restart button) and Map Studio at `http://localhost:5173/?studio` (building selection, floor chips, pan/zoom). Zero console errors on both.
5. `pnpm build` succeeds.
6. `git log` shows the checkpoint commit followed by your work; `git status` clean at the end.

## Report back

Write your completion report to `handoffs/M0-T1-REPORT.md`: what moved where, any deviation from this spec and why, verification output (test counts, typecheck, build), and anything that surprised you. The report is the audit input — terse but complete.
