# Scripted playtest report — post-M8 build

**Method.** `apps/server/src/playtest/harness.ts` boots the production server in-process (DB mode, port 55432) and drives real websocket clients through three scenarios at PRODUCTION config: a pacing run (insert → loot → extract), a combat scenario (duel, plea, loot-then-revive, mines) in a sterile human-only arena, and a six-player load test. Rerun any time:

```
cd apps/server
DATABASE_URL=postgres://postgres:postgres@localhost:55432/dotbot npx tsx src/playtest/harness.ts
# SCENARIO=pacing|combat|load to run one
```

Numbers below are from the final clean runs (2026-07-15/16). A scripted bot is not a player: it can't dodge, kite, or read the map, so combat numbers are floors/ceilings, not averages.

---

## 1. Bandwidth and server health — the binary-protocol question

| Metric | Measured | Design budget |
| --- | ---: | ---: |
| Per-client, 6-player room, everyone moving | **115–118 KB/s** | 25–40 KB/s |
| Per-client, 2-player room | ~98 KB/s | — |
| Average snapshot (20 Hz) | 5.7–5.9 KB | — |
| One-time matchStart payload | ~79 KB | fine |
| Server tick p99 (6 players + greys, 1 room) | 4.2–9.1 ms | 16.6 ms |

**Verdict: the budget is blown ~3×, but binary encoding is NOT the first move.** Two observations point at cheaper, bigger wins:

- Every client received byte-identical volumes. Outdoors + ground floors share one physics context, so interest filtering removes almost nothing during street play — the filter only earns its keep inside multi-storey buildings.
- The snapshot re-sends the full dot table (~40 dots), coverages, and full bot list every 50ms. Dots barely change; most snapshot mass is static repetition.

**Recommended order:** (1) send dots once at matchStart + delta events on capture/spawn (likely −50–70%), (2) omit unchanged optional fields per bot, (3) re-measure; only reach for binary encoding if still >40 KB/s. Tick health is comfortable for several rooms per process; not a concern at friends-playtest scale.

## 2. Pacing (production config, WEST GATE insertion)

| Mark | Time |
| --- | ---: |
| Reach Lot 6 depot interior | 4.1 s |
| First two items looted (health + fragment) | 5.9 s |
| Extracted at DEPOT PAD (incl. 4 s channel) | **17.3 s** |
| Share of the 8-minute run timer used | **3.6%** |

A beeline loot-and-extract is trivially fast. Consequences:

- **Speedrun farming is the optimal economy strategy**: ~2 items per 17 s of run time puts the 24-item second floor at roughly a dozen minimal runs — under 15 minutes of play including lobby overhead. Contracts and deeper blueprint targets are the counterweight; watch whether humans actually beeline.
- The 8-minute timer is effectively infinite for extraction purposes — it exists to bound matches, not runs. That's fine, but "timeout" outcomes should be rare in practice; if human playtests show many, something else is wrong.

## 3. Combat, verbs, pleas, mines (sterile human-vs-human arena)

- **Time-to-down: 2.8–3.9 s** of sustained dash pressure against a stationary 3-plate target. Against a moving target, scripted attackers cannot land qualifying hits at all (relative speed rarely exceeds `damageSpeed` 360 when the target flees) — TTK for real players will sit well above this floor. Feels directionally right for an extraction game.
- **Dash knockback is enormous.** In an open-field duel the stationary victim was shoved ~1,000px down the street before dropping. Fights travel. This needs eyes-on human evaluation — it may be great chaos or may feel like air hockey. Tuning knob if needed: contact restitution/impulse on dash hits.
- **Loot-then-revive works end-to-end over the network**: 4.5 s channel + approach ≈ 5.4 s observed; victim stood with the cracked-plate invariant `[0.5,0,0]`; attacker's inventory gained the victim's carried health. Plea reached the enemy squad's client. Consume/reviveClean share the same verified path.
- **Mines: fully functional.** Silent placement, disguise + seam delivered to the enemy wire (squad sees X), **6 sensor pings** during a ~12 s loiter inside the 300px radius (2 s cadence ✓), and stepping on one downed a plateless target per the ruling. One residual disguised mine remained visible afterwards.

## 4. Grey (ambient AI) pressure — the biggest emergent finding

With greys active, the scripted attacker could not complete ANY downed-verb channel in 20 s, and in one run was itself downed mid-attempt. Greys relentlessly hunt the nearest human, shove combatants around (bodies slid along the street at contact distance in every grey-adjacent run), and turn every post-fight interaction into a second fight.

- For real players this is partly intended (greys are pressure), but **field revives under grey harassment may be brutally frustrating** — the revive channel demands standing still at exactly the wrong moment.
- **Watch item for the human playtest:** downed bodies visually "drifting" while greys/attackers mill around them. Scripted data shows position drift at contact spacing; collider flags are provably correct (downed = sensor+disabled), so the mover is grey contact pressure on the *living* bots plus something unconfirmed. Needs eyes-on with the renderer.
- Candidate tunings if humans confirm the pain: grey de-aggro radius around downed-interaction channels, or a short grey-attention cooldown after a squad wipes a grey.

## 5. Input handling finding

`normalizeInputVector` renormalizes every nonzero move vector to full magnitude: **analog movement does not exist over the wire** — any joystick tilt is full speed. Keyboard play is unaffected (this is exactly what keyboard wants); touch players lose fine control. Decide whether that's a design position or a bug; the fix (clamp length to ≤1 instead of normalizing to =1) is one line in `math.ts` but changes touch feel everywhere.

## 6. Economy cross-check (static data + observed rates)

- Loot rate floor: ~7 items/min of pure speedrunning (before lobby overhead).
- Recipe ladder at that rate: furniture (2 items) ≈ trivial; repair bench (3) ≈ trivial; second floor (24) ≈ ~12 minimal runs. The real gates are blueprint learning (3 fragments of a kind) and contract RNG, not raw item volume.
- Stash pressure: cap 40 (2 lockers) absorbs ~20 minimal runs before overflow-loss matters — capacity pressure will be invisible in short playtests unless players hoard. Consider whether 20/locker is too generous for the loop you want.

## 7. Verified-working checklist (over real websockets, production config)

Insertion assignment + spacing, squad formation, match lifecycle, dot capture, extraction + banking + manifests, blueprint fragments, pleas (cross-squad), all three downed verbs' shared path (lootThenRevive end-to-end), mine placement/disguise/sensor/detonation/cap, spectate data flow (squad context retained), 20 Hz snapshots at stable cadence, tick p99 under 10 ms at full room load.

## 8. Recommended actions (priority order)

1. Snapshot slimming (dots-as-deltas first) — before any friends playtest with >4 players on real networks.
2. Decide the analog-input question (one-line change, affects touch).
3. Eyes-on review of dash knockback distance and the downed-body drift during your browser session.
4. Watch speedrun-vs-explore behavior in the first human playtest before touching the economy numbers.
5. Entity-id randomization + merging mines into the dots array (wire-level disguise) before any non-friend players.
