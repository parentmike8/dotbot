# Ambient and Escort AI

## State and hostility model

Ambient bots are one world faction. Their legacy `squadId` values remain only as
stable presentation/network data; they never make ambient bots hostile to each
other.

An ambient bot moves through:

1. `patrol` — follow its authored production loop.
2. `engage` — pursue and attack a non-ambient bot acquired by valid sight or a
   source-attributed audible event.
3. `investigate` — travel toward the last position actually sensed for 3 seconds.
4. `search` — inspect three deterministic points within 96 units of that position
   over 4.5 seconds.
5. `patrol` — forget the alert after 7.5 seconds without renewed contact and
   rejoin the authored loop.

The 3-second last-known commitment is at most 504 units at the current 168 px/s
AI speed. It lets a guard round one nearby corner without following a live,
unseen position across a district. The 96-unit search radius is two DotBot
diameters: visibly more than standing on the last-known point, but still tied to
the place that caused the alert.

Escorts have no patrol state. They follow their squad's human and current ping
movement. They do not capture Dots, strip bodies, or extract autonomously.
Ambient bots become valid escort targets only while that specific ambient bot is
aggressive toward the escort's squad.

A rival human becomes a valid escort target only after a server-resolved attack
against the protected squad. That ledger is scoped from the aggressor faction to
the victim squad and expires after 15 seconds without another authoritative
hostile action. Sight, proximity, and pings never refresh it.

## Authored route briefs

Each loop uses production `BotSpawn.patrol` data. Routes keep the named
responsibility near its operational anchor, join several distinct sides of that
anchor, and leave the central combat/circulation space open.

| Bot | Responsibility and zones | Loop and intended empty space |
| --- | --- | --- |
| Ochre | Watch the east car park and Civic Tower service edge. | Long rectangle between the park corners and tower edge; car-park centre stays open. |
| Mint | Watch the southwest depot approach and extraction yard. | Yard perimeter loop; pad and main vehicle lane stay open. |
| Violet | Guard the Civic Tower south entrance and Main St frontage. | Entrance-to-frontage loop; doorway mouth and carriageway crossing stay open. |
| Amber | Watch the northwest plaza/service-yard seam. | Loop around the yard edges; plaza centre remains public circulation. |
| Slate | Walk Mercy Clinic F1 ward circulation. | Ward-station and bed-bay loop; bed approaches and stair run stay open. |
| Coal | Guard Lot 6 bonded cage storage. | Cage-front and locker-wall loop; cage aisles stay open. |
| Coral | Guard Civic F4 operations. | Incident-table and dispatch perimeter; four-sided table approach stays open. |
| Plum | Inspect Civic F7 plant. | Plant-bank and south workbench loop; central maintenance aisle stays open. |
| Sage | Walk Beacon F1 residential corridor. | West core, studio doors, lounge arch, east core; room interiors stay private/open. |
| Rose | Guard Beacon roof garden and plant. | Garden, terrace, service-corner loop; open middle deck stays clear. |
| Rust | Inspect both rail-yard wagon rakes. | Long aisle loop along the rake ends; track crossing and loading aisle stay open. |
| Cinder | Guard the water-tank and works-road approach. | Tank/service loop with a wide turn; road and tank access stay open. |
| Ash | Walk the roundhouse service apron. | Bay-mouth and turntable-side loop; central turntable approach stays open. |
| Signal | Guard the signal-box yard door and works-road crossing. | Door approach and crossing loop; the deliberately tight one-person operating floor stays empty. |
| Tinsel | Guard the fair's main avenue. | Long midway loop between ride fronts; avenue centre remains a player route. |
| Cotton | Watch the helter-skelter and west fair entrance. | Attraction perimeter loop; entrance throat stays open. |
| Bulb | Walk the pavilion bar and hall entrance. | Counter/door/hall loop; bar approach and dance floor stay open. |
| Reel | Watch the pavilion gallery. | Gallery perimeter loop; central overlook and stair landing stay open. |
| Jade | Guard the temple plaza approach. | Plaza-edge loop between approach and stair axis; ceremonial centre stays open. |
| Obsidian | Watch the observatory/temple trail junction. | Junction triangle with long legs; trail crossing remains open. |
| Copal | Guard the summit platform. | Shrine-door and platform-edge loop; door and altar approach stay open. |
| Quetzal | Walk the observatory ground floor. | Instrument, entry, and stair-side loop; central viewing floor stays open. |
