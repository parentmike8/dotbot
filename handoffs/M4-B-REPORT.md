# M4-B completion report — online items, stash, and blueprint learning

## Result

M4-B is complete in the requested five atomic commits:

1. `Rename persistent hold to stash`
2. `Encode items and enforce inventory privacy`
3. `Persist stash items and learn blueprints`
4. `Surface stash and learned blueprints`
5. `Cover online item persistence flows`

The persistent-at-home inventory is now called **STASH** throughout server code, the profile API, and the lobby. **HOLD** means only the in-run 12-slot backpack. The physical database table remains `hold_items`, deliberately mapped to the code-level `stashItems` schema export and documented there to avoid a migration with no user-visible value.

## Wire item encoding

`packages/protocol/src/items.ts` is the single wire mapping boundary. It defines and round-trips these compact codes:

| Item | Wire code |
| --- | --- |
| Health | `h` |
| Radar | `r` |
| Dash overcharge | `d` |
| Incognito | `i` |
| Blueprint fragment | `b:<blueprintId>` |

Snapshot bot inventory fields use compact item codes. `b` carries bay detail, `h` carries hold detail, and `c` always carries the aggregate carried count. Typed dots use the same compact codes. Item-bearing events are encoded by the protocol boundary and decoded by `NetSession`; `runOver` contains compact itemized kept/lost arrays plus `learnedBlueprints`.

`useBay` is forwarded as an input edge. The client retains it until the next 30 Hz input packet includes it, then clears it; a regression test alternates render frames around the send boundary and proves the edge is sent once rather than banked or repeated. `swapBay` retains the same edge behavior.

## Privacy filter rules

Inventory privacy is enforced in the server interest filter, not left to the renderer:

- The viewer's own bot and squadmates receive full bay and hold composition.
- Every other bot omits both detail fields but retains `carriedCount`, allowing target-value reading without revealing composition.
- Radar ping detail is included only when the receiving connection's `viewerBotId` is the bot that owns the pings. Squad membership does not broaden personal radar intel.
- The compact carried count is present for every visible bot, including those whose inventory detail is redacted.

Unit coverage asserts own detail, squad detail, enemy redaction with count retained, and owner-only radar. The visible two-client check additionally inspected each client's live `window.__dotbotSnapshot`: each player saw their own Health bay, saw the opposing bot's `carriedCount: 1`, and received null/absent opposing bay and hold composition.

## Learning transaction shape

Extraction remains the only banking boundary. The database persistence transaction now performs these steps atomically:

1. Insert one physical `hold_items` row per extracted item, with `item_type` set to its compact wire code and quantity 1.
2. Count the player's stashed fragments per extracted blueprint ID.
3. At `blueprintLearningThreshold` (default 3), insert the blueprint into `learned_blueprints` with conflict-safe permanent semantics.
4. Delete all matching fragment rows once learned. A blueprint already learned is a no-op for learning, while subsequently extracted matching fragments are consumed rather than accumulating for re-learning.
5. Upsert the participant's itemized run manifest in the same transaction and return newly learned IDs to the live Room.
6. Send those returned IDs in `runOver`, allowing the just-finished manifest to render `LEARNED` immediately.

Died and timeout outcomes write itemized losses but never add stash rows. The no-database persistence adapter returns an empty learning result and preserves the complete match loop.

The DB integration test drives real bots through two live matches. With one fragment pre-seeded, the first extraction banks two Health and two shelf fragments across the scenario; the next shelf fragment reaches three, creates the permanent learned row, consumes all shelf fragment rows, and reports `shelf` in `runOver`. It also asserts item rows while the Room is still live, and proves a died account banks no items.

## Lobby and manifest surfacing

`/api/profile` now returns an itemized stash summary, learned blueprint IDs, and itemized recent manifests. The lobby renders compact glyph/count groups under `STASH`, blueprint names under `LEARNED`, and the explicit hint: “Withdrawals unlock at the Base bay console.” The run manifest renders newly learned blueprint names.

For visual display verification, the local test database was seeded with a display-only profile containing Health ×2, Radar ×1, bed fragments ×2, and learned shelf. A visible reload rendered all four values and the Base bay-console hint correctly. The extraction and threshold-learning behavior itself was verified by the real-match DB integration scenario above rather than inferred from that display seed.

## GIVE UP and network behavior

`leaveRun` while the member's bot is downed now removes that bot, returns a died itemized manifest, and keeps the member connected as a spectator while the squadmate remains in the playing state. Room coverage verifies that server lifecycle; `NetSession` coverage verifies that GIVE UP uses the network `leaveRun` message. Swap and `useBay` continue through the normal input channel.

## Verification

All commands used `/Users/michaelparent/.nvm/versions/node/v20.20.0/bin` (Node 20).

- Precondition before edits: `handoffs/M4-A-REPORT.md` existed; a fresh no-DB run was **89 passed, 1 DB-only skipped**, and a fresh DB run was **90 passed**.
- Final `pnpm typecheck`: green across game, protocol, client, and server.
- Final `DATABASE_URL` unset, full `pnpm test`: **94 passed, 1 DB-only skipped**.
- Final `DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot`, full `pnpm test`: **95 passed**.
- Final `pnpm build:all`: green. Vite emitted only its known large-chunk advisory; the server bundle completed.
- `pnpm dev:server` with the DB URL: connected to Postgres and listened on port 3001. The required live run exposed the old `tsx` argument ordering in that script; the tests commit corrects it so the documented command boots normally.
- The DB container on host port 55432 was used. Port 5432 and `covet-postgres` were not touched.

### Live narrative

- Two visible, origin-isolated browser windows registered separate players, joined the same room, and entered a live match.
- Both clients collected an item. Main-world inspection of `window.__dotbotSnapshot` proved each player received their own Health composition and only the opponent's carried count, with opponent bays/hold redacted.
- The lobby rendered the itemized STASH, learned blueprint name, recent-run structure, and withdrawal hint after profile reload.
- Radar ownership is asserted at the serialized interest-filter boundary: only a connection whose `viewerBotId` owns the radar data receives `r`; squadmates and enemies do not. This deterministic protocol test is the authoritative check because acquiring and firing Radar is spawn-dependent in a manual room.
- Downed GIVE UP is asserted through the real Room message path: the giving-up player receives the died manifest and remains connected, and their squadmate remains playing. This avoids depending on nondeterministic live combat to arrange the downed state.
- Visible solo mode rendered the full four-bay HUD and ran normally. Visible Map Studio rendered all four buildings and its layer controls unchanged.
- Browser console error collections were empty in both live-room clients, solo, and Map Studio.
- Stateless mode's full match lifecycle, itemized outcomes, and graceful no-op persistence are covered by the green no-DB suite.

## Exit criteria

1. Typecheck, both full test modes, and `build:all`: **green**.
2. Itemized extraction/learning, privacy, radar ownership, and downed GIVE UP: **green** through the visible two-client inspection plus deterministic network/DB integration coverage described above.
3. Stateless full matches, solo, Map Studio, and browser consoles: **green**.
4. Five requested atomic commits are present; final worktree cleanliness is checked after committing this report.
