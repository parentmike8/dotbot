# World map threat model

## Product boundary

The world map is an exterior chart, not a remote game camera.

- Static outdoor geography, roads, ground uses, landmarks, and building roofs are known.
- Buildings are one exterior shape. The map never selects, draws, names, or browses an
  interior floor.
- A player inside a building still sees the exterior chart and that building's roof.
- A map ping always targets the outdoor physics context at the clicked sheet position.
- There is no exploration-fog history to merge or restore. The only map knowledge is the
  public exterior chart plus short-lived squad information.

This is the chosen explored/seen model: the exterior is known from match start, and
interiors have no map representation at all. It is bounded at zero per-player discovery
memory and zero discovery bandwidth. Adding exterior discovery later would be a product
change, not an implementation detail.

## Existing knowledge boundaries

### Static geometry

`matchStart` currently sends the complete `MapDocument`. The client needs it for
production drawing, collision prediction, stairs, doors, and visibility. Consequently,
authored interior geometry is already present in a connected client's memory even though
the world map must not present it.

The shipped UI protects the intended player experience by constructing the map from
`buildMapArt` and explicitly enabling only outdoor layers and roofs. It does not protect
interior geometry from a modified client. Making static interiors confidential would
require a different architecture: an exterior-only public map plus authoritative
geometry streaming/prediction by interest. That is outside this task.

### Dynamic entities

The server interest filter:

- always includes the viewer's squadmates;
- includes rivals only on an interested physics floor;
- sends Dots and mines only for interested physics floors;
- redacts rival inventory until a downed body has been searched;
- sends squad pings only to that squad;
- expands a downed viewer's interested floors to the floors occupied by living
  squadmates.

That snapshot is sufficient for the live renderer but too broad for a world map. The map
therefore uses an allow-list, not a filtered copy of the snapshot: viewer squad bodies
and squad marks only. It never consumes Dots, mines, doors, noises, coverage, intel,
extractions, rivals, or ambient bots.

## Threats and controls

| Threat | Control |
| --- | --- |
| Interior layout is exposed while the player is outside or on another floor | Exterior mode hides every non-roof `FloorArt`; authored roof plans render with their closed stair housing. |
| Opening the map inside swaps to the player's active floor | The map has no active-floor input and never reads the viewer floor to choose art. |
| A snapshot enemy, hidden pickup, mine, door, noise, or private intel appears on the map | Map markers are created by an allow-list of same-squad bots and squad marks. No other snapshot collections enter the map API. |
| A client forges a map ping onto an interior floor | The protocol accepts an optional requested ping floor only for the outdoor floor. Explicit interior requests are rejected by the simulation. |
| A click on a building inherits the player's interior floor | Map clicks send the outdoor floor explicitly; the clicked x/y remains the exterior sheet position. |
| A pan gesture also places a ping | Pointer travel has a click threshold; only an unmoved primary-pointer release marks. |
| Map input leaks into movement, dash, inventory, or body actions | Opening clears held movement; while open the game loop sends zero movement and the hotkey handler accepts only map close controls. |
| Downed spectating reveals the floors occupied by squadmates | The map still draws only roofs. Squad positions are already squad-authorized and are projected onto the exterior chart by x/y. |
| Reconnect restores stale tactical marks | Existing ping events remain short-lived client memory and are not replayed. Reconnect restores the same public exterior chart and current authoritative squad positions. |
| World growth leaves uncharted blank bounds | Fit and clamping derive from `MapDocument.width` and `height`; no region or building list defines the camera extent. |

## Trust statement

The server is authoritative for bot positions, squad membership, event delivery, and the
floor attached to a map ping. The client is authoritative only for camera state and for
whether it locally clears short-lived marks. A map click proposes an outdoor position;
it does not propose visibility, entity knowledge, or an interior floor.
