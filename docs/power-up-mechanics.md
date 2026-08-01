# Power-up mechanics and authority

Status: current implementation contract for the existing Power Dots and mines.
The final catalog, names, tuning, and visual treatment remain product/design work.

## Scope

This document owns the mechanics already represented by `health`, `radar`,
`dashOvercharge`, `incognito`, and `mine`. It does not authorize new world
placement, Blueprint content, Core or Plate-type design, persistence migration,
or a new radar/HUD visual language.

`incognito` remains the internal item id for compatibility. In the rules below,
**Invisibility** is the player-facing description of its actual effect.

## Ownership

| State or decision | Owner | Client responsibility |
| --- | --- | --- |
| Bay contents and item consumption | Authoritative simulation | Propose a bay index; never propose an item or effect |
| Effect start, refresh, and expiry | Authoritative simulation clock | Display the viewer's replicated remaining time |
| Radar eligibility and sampled contacts | Authoritative simulation | Draw only the viewer-private contacts received from the server |
| Rival body visibility | Per-viewer server interest filter | Interpolate only bodies present in authorized snapshots |
| AI perception and last-known search | Authoritative simulation | None |
| Dash timing and movement | Authoritative simulation | Predict the viewer's timed overcharge with the same shared values |
| Mine placement, arming, allegiance, trigger, damage, and cleanup | Authoritative simulation | Draw the per-viewer mine presentation received from the server |
| Mine disguise and radar reveal privacy | Per-viewer server interest filter | Never infer owner or squad from a disguised mine |
| Run reset | Room owns a fresh simulation; simulation disposal clears run-only state | Drop buffered snapshots on `matchStart` |

## Audit of the pre-repair behavior

- Radar stored anonymous orange position rings on the firing bot. It sampled
  ambient bots, ignored Invisibility, and did not provide target identity or
  relationship data. The server also sent every rival on an interested physics
  floor, including rivals behind walls, so the client already possessed the
  positions Radar was meant to authorize.
- Incognito suppressed newly emitted source-attributed noise for ten seconds,
  but did not hide a body from rival snapshots, radar, AI sight, strategic AI
  tracking, or mine sensors.
- Dash overcharge granted three cooldown-bypassing charges. The client predictor
  did not model those charges and predicted an ordinary cooldown while the server
  accepted an overcharged dash.
- Mines armed and resolved in the placement tick. Allegiance followed the live
  owner for damage checks but the placement squad for presentation and sensors.
  Owner removal left orphan mines behind, and a recruited owner could therefore
  produce contradictory friend/foe behavior.
- Snapshot interpolation retained entities missing from a newer snapshot. A
  hidden rival, expired radar contact, detonated mine, or removed noise could
  survive after the authoritative removal boundary.

## Locked mechanics

### Health

- Restores one broken Plate and never exceeds the Core's Plate capacity.
- Consumption is authoritative even when every Plate is already intact.

### Radar

- Lasts 8 seconds, refreshes to 8 seconds when used again, samples every 2
  seconds, has a 600-unit radius, and keeps each sampled contact for 2 seconds.
- Contacts include other player-role DotBots, human or AI. Ambient grey bots are
  excluded. Each contact carries a target id, position, floor, and age so the
  client can derive squad/rival treatment from authorized metadata.
- Radar ignores walls but not range, physics floor, effect time, or
  Invisibility. An invisible target produces no contact.
- Radar contacts are sent only to the firing player's connection. They do not
  broaden ordinary body visibility and do not enter the exterior world map.
- Radar reveals in-range rival mines to the firing player for the remaining
  radar duration. It does not disclose the mine owner or squad.

### Invisibility (`incognito`)

- Lasts 10 seconds and refreshes to 10 seconds when used again.
- The player, their squad, physical collision, mine triggers, and damage remain
  authoritative and unchanged. Invisibility is concealment, not invulnerability.
- Rival human connections receive no exact body state while the invisible bot is
  outside physical contact. At physical contact the body is disclosed so
  collision and combat remain readable and client prediction can reconcile.
- Rival AI cannot acquire or live-track an invisible target. AI may investigate
  a last-known position or a noise emitted before activation, and physical
  contact can still damage either bot.
- The effect suppresses new source-attributed noises and mine-sensor pings. A
  noise already emitted remains a valid stale clue. Touching a mine still
  detonates it.
- Downing clears Invisibility and every other active timed Power Dot effect.

### Dash overcharge

- Lasts 60 seconds and refreshes to 60 seconds when used again; durations do not
  stack above that value.
- While active, an alive bot may start a new dash as soon as the previous dash
  ends. Ordinary dash cooldown is held at zero.
- Input edge validation, authoritative movement, dash duration/speed, collision,
  combat, energy/physics behavior, and map bounds are unchanged.
- The current simulation has no water movement or combat restriction, so this
  repair invents none.
- Downing clears the effect. Reviving does not restore it.

### Mines

- Placement consumes one authoritative bay item, uses the bot's authoritative
  position/floor/squad, emits no placement noise, and arms on the next
  authoritative tick. A forged item, position, floor, or repeated edge cannot
  place a mine.
- Allegiance is the placement squad for the mine's lifetime. Squad members do
  not trigger it. Ambient greys and rival player roles do.
- A recruited owner loses mines placed for the former squad. Temporary
  disconnect, AI handoff, downing, and same-squad revive preserve them. Extraction,
  giving up, or other bot removal clears the owner's mines.
- Physical trigger and damage remain the existing Plate rule: the Plate facing
  the point source breaks; an already exposed Core is downed. Merely losing the
  last intact Plate does not down a bot.
- Invisibility suppresses the 300-unit sensor ping but not physical detonation.
  Sensor events remain placement-squad private.
- A squad sees its mines as mines. A rival sees a disguise only with ordinary
  line of sight, or the mine marker through walls while personally radar-revealed.
  Owner/squad/reveal lists never cross that interest boundary.
- The oldest mine from the same owner rotates out above the active cap. All
  placed mines are run-only and are cleared when the simulation is disposed.

## Client and late-state rules

- A newer snapshot's omission is authoritative at that snapshot's tick. The
  interpolation buffer may show older authorized state only while rendering a
  time before that boundary; it must not carry omitted entities beyond it.
- A reconnect receives current effect timers, current authorized contacts, and
  current mines from the server. It does not reconstruct expired intel locally.
- Prediction models the viewer's timed dash overcharge. Hidden rivals are not
  prediction obstacles until the server is authorized to disclose them; physical
  contact remains server-authoritative and may require a correction.
