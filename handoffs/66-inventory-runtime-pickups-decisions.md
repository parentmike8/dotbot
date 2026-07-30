# Task 66 decisions — inventory panel and runtime pickups

These decisions were audited against the live item, capture, channel, snapshot,
reconnect, and persistence code before implementation.

## Inventory access and channels

- The inventory panel may open while alive or downed. Opening and closing it is
  client UI state only: it does not pause the simulation, zero movement input, or
  freeze the player.
- A downed player may drop their own cargo. They may not fire a bay or start a
  bay/hold swap; those remain alive-only actions. This keeps the existing downed
  combat rule while making the requested downed inventory access meaningful.
- Dropping is an instant input edge. It does not cancel or reset capture,
  extraction, loot, or revive coverage. If the player drops the item participating
  in an in-progress bay/hold swap, that now-stale swap is cancelled rather than
  applying to a different item after hold indices close up.
- Bay/hold swapping keeps the existing two-second, stationary, noisy server
  channel. The panel replaces the old per-bay swap controls; it does not make
  swapping instant.

## Runtime pickup placement and lifetime

- The server places a dropped pickup at the authoritative bot centre on the bot's
  current authoritative physics floor. A live or downed bot centre is already a
  collision-valid world point, so a client can never spoof a pickup through a wall
  or onto another floor. The pickup is non-solid, as authored Dots are.
- Other pickups do not block a drop. Several runtime pickups may occupy the same
  point and remain separate collectible entities. `MIN_DOT_SEPARATION` is an
  authoring-quality rule for authored loot placement, not a live simulation rule;
  applying it to runtime piles would either reject a valid drop or move cargo away
  from the player into geometry.
- Runtime pickups last until one player captures them or the match ends. There is
  no owner-only window and no timed despawn.

## Authority, races, IDs, and inventory safety

- A drop request names an inventory location (`bay` or `hold`), index, the
  inventory revision the client observed, and the expected item/provenance at
  that slot. The server rejects stale or shifted requests, then derives the
  pickup position, floor, radius, and ID from authoritative state.
- Invalid indices, empty slots, non-integer indices, ambient actors, and missing
  bots are no-ops. One valid request removes exactly one item and creates exactly
  one pickup in the same simulation operation.
- Dropped pickups are public to every squad immediately. Capture uses the existing
  server-authoritative Dot channel. If multiple players cover one pickup, the
  simulation's stable bot order owns that tick; once the winner inserts the item,
  the pickup becomes inactive before another player can receive it. A full winner
  does not destroy the pickup.
- Runtime IDs use a monotonic per-match sequence under a `runtime-drop-` prefix and
  are checked against the complete Dot map before insertion. They cannot overwrite
  authored or previously dropped Dots, including authored content that happens to
  use the same prefix.

## Provenance, reconnect, and persistence

- The complete `Item`, including `sourceBuildingId`, moves from inventory to the
  runtime pickup and back unchanged. Snapshot item payloads carry provenance; the
  compact persistence item code remains the item-kind key rather than the source of
  truth for in-run cargo.
- Runtime pickups are run-scoped simulation state. A reconnect to the same live
  Room receives the current pickup in its fresh Dot baseline and the current
  inventory state. A dropped item is neither duplicated into persistent STASH nor
  lost on a normal reconnect.
- Drops are not written to Postgres mid-run. Extraction remains the only banking
  boundary, and the extraction transaction continues to receive full cargo
  provenance for contract evaluation. Process loss has the same semantics as any
  other in-progress room state; there is no new cross-process match checkpoint.
