# Pixel city block production brief

This brief records the design intent that must exist before coordinates are authored. It applies to `pixel-city-block` and is subordinate to Mike's latest direction plus `docs/map-building-contract.md`.

## Purpose

Validate a shippable city-building workflow using the purchased LimeZu packs, the selected compact DotBot, continuous movement, combat, collision, roof reveal, mobile controls, and the existing simulation. Downtown remains the systems regression map.

## Block sequence

1. Insert on the south sidewalk with the playable shop visible across a short, safe approach.
2. Read the street edge, parked vehicles, lighting, trees, benches, and two closed neighbouring façades as one intentional block.
3. Enter the open shop doorway without a door swing or modal transition.
4. Move through a broad public lane toward the service counter and parts shelves.
5. Choose either side of the central display run. Both routes reconnect at the work bays and back storage.
6. Fight two interior defenders, collect the authored Dots, and leave by the front or open back exit.

## Shop zones and adjacency

- **Entry and public lane:** clear apron immediately inside the south door; no fixture may intrude into the full-size DotBot route.
- **Parts display:** two aligned islands with a generous aisle between them. Their fronts face the public lane and their collision footprints sit at their visible bases.
- **Service counter:** along the west wall, connected to storage rather than floating in front of another counter.
- **Work bays:** along the east wall beside tool storage and computer equipment.
- **Back storage:** north-west, beside the service counter and back exit.
- **Combat loop:** the display islands create cover without closing the perimeter route. Every dead end is wider than a turning DotBot.

## Negative space

The central aisle, the perimeter loop, both door aprons, and the work-bay approach are deliberate play space. Empty areas must read as routes or combat rooms, not as leftover gaps between sprites.

## Visual and collision rules

- World art uses a curated atlas generated from the locally purchased packs. Raw packs remain ignored and are not shipped.
- The 48 px asset scale is the source of truth. Raster scaling remains integer and nearest-neighbour.
- Tall perspective fixtures have a small authored ground footprint plus an occlusion cut. Bots can pass behind the upper pixels but collide at the visible base.
- Solid props use the sprite's dark base/outline and an authored collider. Walk-through markings and surface tiles never receive colliders.
- The selected DotBot uses a 64 px directional frame around a compact black puck. Its three broad curved shield plates are part of the sprite system, not vector circles; intact, damaged, and broken plates follow the live shield state.
- Character frames share one fixed hull anchor. Movement uses a short-lived state latch and render-position smoothing so 20 Hz simulation updates do not flicker between idle and glide frames.
- Dots and noise waves use shallow ground-plane ellipses. Circular top-down effects are reserved for the plan-view Downtown regression map.
- The shop floor tile reaches the exact building footprint beneath its wall segments so open thresholds align with the exterior facade base.
- Indoor areas outside the wall-derived visibility polygon receive a strong dark overlay.

## Playtest acceptance

- Desktop and mobile browser layouts render sharply and controls remain responsive.
- The player can enter, circle every display, reach every Dot, fight every AI bot, and exit through both shop openings.
- No sprite/collider disagreement creates an invisible wall or lets the player pass through a dark solid base.
- Roof/facade visibility changes only when the existing building context changes.
- Map Studio shows the same production renderer, supports zoom/pan, and passes the map quality overlays.
