# Handoff M0-T3: `BotTeam` → `squadId` + `isAmbient` refactor

**Agent brief.** You are replacing the three-value `BotTeam` ("player" | "ally" | "enemy") with squad identity. This is the most invasive refactor in milestone M0 because "team" currently encodes THREE different things at once — who is friendly to whom, who the human is, and who counts as a rival. Your job is to tease those apart with **zero observable behavior change**. Every current behavior must be reproduced exactly through the new keys.

**Precondition:** M0-T2 complete (`handoffs/M0-T2-REPORT.md` exists, its exit criteria verified). The sim now has a controller map (`human | ai | frozen`), `applyInput(botId, input)`, `spawnBot(spawn, controller)`, and a slim snapshot. If T2 is not merged and green, stop and report.

## Repo facts

- Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm` (shell default is Node 16 and breaks everything).
- Sim: `packages/game/src/simulation.ts`; types: `packages/game/src/types.ts`; map content: `packages/game/src/content/downtown.ts`; client: `apps/client/src/` (renderer + HUD).
- Determinism test exists (compares two identical replays against each other, not a stored golden — refactors are safe if the sim stays self-consistent). All tests currently green.
- Ordinary commits on top of T2; never destructive git.

## New data model (`packages/game/src/types.ts`)

```ts
// DELETE: export type BotTeam = "player" | "ally" | "enemy";

export type BotSpawn = {
  // ... existing fields, minus `team`, plus:
  squadId: string;          // every bot belongs to exactly one squad
  isAmbient?: boolean;      // grey background AI (default false). DATA-ONLY in this task:
                            // carried through spawn→entity→snapshot, no behavior keys off it yet
  controller?: Controller;  // default "ai"; replaces "team === 'player' means human"
};

// DotBotEntity: replace `team: BotTeam` with `squadId: string; isAmbient: boolean;`
```

## Semantic mapping — the heart of this task

Every current use of `team` maps to exactly one new key. Reproduce each row precisely; if you find a `team` usage not listed here, STOP and document it in your report before choosing a mapping.

| Current behavior (keyed on team) | New key | Exact rule |
|---|---|---|
| Friendly fire skip: both in {player, ally} never damage each other (`FRIENDLY_TEAMS`/`areFriendly`) | squad | `a.squadId === b.squadId` → no damage. Delete `FRIENDLY_TEAMS`; `areFriendly(a, b)` becomes same-squad |
| Coverage kind over a downed bot: friendly → "revive", hostile → "consume" | squad | same squad → revive; different squad → consume |
| AI revive / consume / hunt target selection (friendly vs non-friendly filters) | squad | same filters via same-squad test |
| Human assignment at `create()` (T2: `team === "player"` → controller "human") | controller | `spawn.controller ?? "ai"` |
| Movement speed: `team === "player"` → `playerSpeed`, else `botSpeed` | controller | controller `"human"` → `playerSpeed`, else `botSpeed` (behavior-equivalent: only the player was human) |
| Respawn inventory: player/ally respawn with 1 dot, enemies 0 | isAmbient | `isAmbient ? 0 : 1` (equivalent: current enemies become the ambient bots) |
| Ally escort AI (`team === "ally"` bots escort the player) | squad+controller | an AI bot escorts when a living **human-controlled** bot shares its squad; escort target = that human (first by bot id if several) |
| Banking counters: player/ally banks → `bankedDots`, enemy banks → `rivalBankedDots` | primary squad | sim records `primarySquadId` = squad of the first human-controlled bot at `create()` (fallback: first bot). Banks by that squad → `bankedDots`; all others → `rivalBankedDots` |
| Renderer split (`GameRenderer.drawBots`): player/ally drawn on the always-visible layer (through-wall ghosts w/ LOS fade), enemies on the LOS-masked layer | viewer squad | bots sharing the **viewer's** squad (viewer = the `playerId` passed to `render`) → dynamic layer; all others → masked layer |
| HUD rival count (`App.tsx`: alive bots with `team === "enemy"`) | viewer squad | alive bots NOT in the viewer's squad. (Ambients count as rivals for now — matches current display.) |

**Explicitly unchanged in this task:** bot colors/plate hues (per-spawn `color` stays; relationship-based hues are M1), ambient-AI dumbing-down (M4 — current rivals keep their full loot/hunt/extract AI), `bankedDots` existence (dies in M1), shields, combat tuning.

## Content update (`packages/game/src/content/downtown.ts`)

`botSpawns`: player + Indigo + Sky → `squadId: "alpha"` (player spawn additionally `controller: "human"`). Each of the 10 rivals → its own solo squad `squadId: "rival-1"` … `"rival-10"`, `isAmbient: true`. **Solo squads per rival are required** — current enemies are mutually hostile individuals (they fight, consume, and loot each other); one shared "enemy" squad would silently make them a pacifist alliance. Keep names/colors/positions/floorIds untouched.

## Test updates

- Helpers in `packages/game/src/simulation.test.ts`: `playerSpawn` → `squadId: "alpha", controller: "human"`; `allySpawn` → `squadId: "alpha"`; `enemySpawn` → `squadId: "rival-1"`. Purely mechanical elsewhere — **assertions and expected values unchanged**.
- `mapValidation.test.ts` seeds flood-fill from `spawn.team === "player"` — re-key to `spawn.controller === "human"`.
- Add minimal new coverage:
  a. Two same-squad AI bots (no human in squad) never damage each other on dash collision.
  b. Two different-squad ambient bots DO damage each other (rivalry preserved).
  c. A downed bot is revived by a same-squad bot and consumed by a different-squad bot (re-key of existing behavior — extend existing tests only if not already covered by their new keys).
- Final sweep must be clean: `grep -rn "BotTeam\|FRIENDLY_TEAMS\|\.team\b" packages apps` returns zero hits (excluding this handoffs/ dir).

## Hard constraints

- No renderer drawing changes beyond the layer-split re-key; no hue changes; no AI behavior changes beyond the mechanical re-keys above; no tuning changes; docs/handoffs/artifacts untouched.
- If any mapping above turns out ambiguous against the real code, stop on that item and record the question + your provisional choice in the report rather than improvising broadly.

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck` clean; `pnpm test`: every pre-existing test passes with unchanged assertions; new squad tests pass; determinism test passes.
2. `pnpm dev` browser check — behavior indistinguishable from before: squad renders through walls with LOS fade, rivals hidden outside line of sight, rivals fight *each other* as well as you, allies escort and revive you, revive/consume verbs work, rival banking still increments the HUD counter, restart works, Map Studio unaffected. Zero console errors.
3. The grep sweep in "Test updates" is clean.
4. `git status` clean; atomic commits.

## Report back

`handoffs/M0-T3-REPORT.md`: the mapping table above annotated with the actual function/line where each re-key landed, any team-usage you found that was NOT in the table (this is the most important section — those are the audit hotspots), test counts before/after, verification output.
