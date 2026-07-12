# Handoff M4-B: Items over the wire — protocol, stash persistence, blueprint learning

**Agent brief.** M4-A gave the game its item system offline. You are taking it online and persistent: items in the protocol with inventory privacy, the persistent stash (renamed from M3's "hold" to avoid colliding with the in-run hold), blueprint learning on extraction, and lobby surfacing. Single lane, whole repo.

**Preconditions:** M4-A complete (`handoffs/M4-A-REPORT.md`, suite green in both DB modes). Node 20 binaries only: `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm`. Postgres on host port **55432** (`pnpm db:up` — never touch `covet-postgres` on 5432). Visible windows for browser checks.

## 1) Naming split (do this first, it de-confuses everything)

- **HOLD** = the in-run 12-slot backpack (M4-A, spec §7).
- **STASH** = the persistent at-home store (what M3 called "hold"). Rename across server persistence code, `/api/profile` response fields, and lobby UI (`STASH: …`). DB table `hold_items` stays as-is physically (rename churn isn't worth a migration) but map it to stash naming in code. Note the mapping once in the schema file.

## 2) Protocol + privacy

- `input` gains `useBay` (mirror M4-A's sim input; edge semantics preserved over the 30Hz frames the same way dash is).
- Wire items as compact codes (e.g. `"h" | "r" | "d" | "i" | "b:<blueprintId>"`); one mapping module in `packages/protocol`.
- **Inventory privacy**: full `bays`/`hold` content ships ONLY for the receiving member's own bot (and their squadmates). All other bots expose `carriedCount` alone — a fat haul reads as a juicy target without leaking composition. Enforce inside the interest filter; unit-test it (own detail present, enemy detail absent, count present).
- `radarPings` ride the snapshot for the owning viewer only (they're personal intel — filter accordingly).
- Swap channel + GIVE UP (`leaveRun` while downed) verified over the network.

## 3) Persistence (extraction-time, as always)

- On `runOver(extracted)`: within the SAME transaction as today — write each carried item to the stash (`item_type` = the compact code or `powerup:health` style — pick one, document it) and upsert the participant manifest (itemized jsonb).
- **Blueprint learning**: after banking, count the player's extracted copies per `blueprintId` (stash rows); at the threshold (default 3, in config) insert into `learned_blueprints` and CONSUME the copies (delete the fragment rows). Learning is permanent; re-learning is a no-op. Include learning results in the `runOver` payload so the manifest can show `LEARNED: BED BLUEPRINT`.
- Died/timeout paths unchanged (items lost — already handled by A's manifest itemization).
- Stateless mode: all of this no-ops gracefully exactly like M3.

## 4) Lobby surfacing (title-block minimal)

- `/api/profile` → stash summary by item type, learned blueprint list, recent runs (existing).
- Lobby shows: `STASH` line with per-type glyph counts, `LEARNED` blueprint names, recent runs as before. No withdrawing from stash into runs yet — that's the base's bay console (M5/M6); a small hint says so.

## 5) Tests

- Protocol: item code round-trip; inventory-privacy filter cases; useBay edge over input frames.
- Server integration (DB mode): extract carrying 2 health + 2 same-blueprint fragments across two matches → stash accumulates, third fragment triggers learning (fragments consumed, `learned_blueprints` row exists, `runOver` reported it); died path banks nothing; stateless mode runs the full loop unchanged.
- Crash-safety inherited: assert stash rows exist while the match is live (extend the existing assertion to itemized rows).

## Exit criteria (verify each, state each explicitly)

1. `pnpm typecheck`; `pnpm test` in BOTH DB modes; `pnpm build:all`.
2. Live, two visible windows, DB up: full run where player A extracts with mixed items → lobby STASH shows them itemized; collecting the learning threshold across runs shows `LEARNED` in manifest + lobby; player B inspects A's bot mid-run and sees only a carried count (verify via `__dotbotSnapshot`); radar pings appear only on the firing client; GIVE UP while downed over the network yields the died manifest and the squadmate keeps playing.
3. Stateless server boot still runs full matches; solo + Map Studio untouched; zero console errors.
4. `git status` clean; atomic commits (naming split / protocol+privacy / persistence+learning / lobby / tests).

## Report back

`handoffs/M4-B-REPORT.md`: wire item encoding, privacy filter rules, learning transaction shape, stash/hold naming map, verification output for both modes + the live narrative.
