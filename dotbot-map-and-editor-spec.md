# DotBot - Map And Editor Spec

Status: companion spec for Maps, object Scans, Base building, and future player-created Maps.

> **Superseded decisions (July 2026).** `dotbot-systems-spec.md` is now authoritative where it overlaps this document; `dotbot-implementation-roadmap.md` defines build order. Specifically superseded here:
> - **"Scans" / scan progression (§8–§9)**: replaced by blueprint dots (systems spec §5) — spatially anchored via the `scannable` flag, extracted copies complete a permanent unlock. Scan-count tiers are replaced by copy-set sizes tuned by location risk.
> - **Color rules (§1)**: refined by systems spec §6 — bot bodies are black; faction color lives only on shield plates (cyan squad / red enemy / grey AI); dot value classes are orange (powerups) and blue (blueprints) with glyph identities.
> - **Base building (§13)**: direction confirmed (same editor foundation, same data model) but the base is a small off-map hideout that doubles as the game's menu; no combat, no adjacency bonuses, layout is expression only.
> - The map direction, structure, object language, and editor foundation sections (§1–§7, §14–§16) remain fully in force.

## 1. Map Direction

Maps should be visually minimal:

- White background.
- Black and gray linework for geometry.
- Dot Bots are colored.
- Dots are colored.
- Objects, walls, doors, stairs, labels, and floors are black/gray.

Color should mean player or Dot. Everything else stays black-and-white at first.

## 2. Map Structure

Each Map has:

- Outdoor ground level.
- Building footprints.
- Building interiors.
- Floors.
- Stairs.
- Objects.
- Dot spawn points.
- Extraction points.

The Map should feel like a clean city drawing that becomes interesting because of routes, floors, scarcity, and other Dot Bots.

## 3. Ground Level

Ground level shows:

- Streets.
- Alleys.
- Building footprints.
- Building entrances.
- Outdoor objects.
- Extraction points.
- Building labels.

Players can move around the city and enter buildings through marked entrances.

## 4. Buildings And Floors

Each building has:

- Type.
- Name.
- Footprint.
- Entrances.
- One or more floors.
- Stairs between floors.
- Optional elevator later.

Floor labels:

- `GROUND`
- `B1`
- `F1`
- `F2`
- `F3`
- `ROOF`

When a Dot Bot changes floors:

- The old floor fades back.
- The current floor becomes crisp.
- The rest of the map becomes quiet/background.
- The building name and floor label stay visible.

Example labels:

- `MERCY CLINIC / F2`
- `NORTH ARCADE / GROUND`
- `CIVIC TOWER / ROOF`
- `LOT 6 DEPOT / B1`

## 5. Building Identification

Every building should have a type and a name.

Examples:

- Hospital: `Mercy Clinic`
- Mall: `North Arcade`
- Office: `Civic Tower`
- Apartment: `Row House`
- Warehouse: `Lot 6 Depot`
- Transit: `Central Station`
- School: `West Annex`

Outside:

- Building label appears near the main entrance or footprint.
- Label is subtle black/gray text.
- At close range or hover/tap, show type + name.

Inside:

- Small corner/top label shows building + floor.
- Example: `MERCY CLINIC / F2`.

Building type teaches players what to expect:

- Hospital: Regen Dots, Shield Dots, medical Scans.
- Mall: Decoy Dots, mixed Dots, benches, vending, shelves.
- Office: Scanner Dots, desks, server rooms.
- Warehouse: Damage Dots, Shield Dots, generators, workbenches.
- Transit: Dash Dots, benches, ticket machines, fast extraction routes.

## 6. Walls, Doors, Stairs

### Walls

- Simple black/gray line segments.
- Block alive Dot Bots.
- Should be easy to read at speed.

### Doors

- Simple gaps in walls.
- No door open/close mechanic for MVP.
- Doorways must be wide enough for Dot Bot movement and collisions.

### Stairs

- Simple zig-zag or stepped glyph.
- Main way to move floors.
- Should become natural fight/chokepoint areas.
- Floor change can be instant at first or require a tiny hold.

### Elevators

Later mechanic.

- Small rectangle with up/down arrows.
- Slower than stairs.
- Can skip floors.
- Can create sound/pulse when used.

## 7. Object Representation

Objects are black-and-white line glyphs.

Rules:

- No color.
- No fills except tiny black details if needed.
- No text inside object glyphs.
- Simple outlines.
- Similar stroke width across all objects.
- Must be readable at small size.
- Scannable objects pulse while scanning.
- Non-scannable objects do not pulse.

Object examples:

- Bed: rectangle plus pillow.
- Bench: long seat line plus legs.
- Desk: rectangle with chair notch.
- Office chair: small seat/back shape.
- Locker: tall rectangle with handle.
- Shelf: rectangle with divider lines.
- Filing cabinet: stacked drawers.
- Medical cot: bed with wheel ticks.
- Medical cabinet: cabinet with cross-like simple mark if readable in black/gray.
- Rolling cart: small shelves plus wheels.
- Monitor: rectangle on stand.
- Vending machine: tall rectangle plus button grid.
- Kiosk: small terminal shape.
- Counter: long rectangle with service gap.
- Plant: pot plus simple leaves.
- Couch: wide rounded rectangle with back line.
- Table: rectangle/circle with legs.
- Dresser: drawer stack.
- Fridge: tall rectangle with handle line.
- Workbench: tabletop plus tool marks.
- Generator: box plus dial.
- Tool cabinet: cabinet with drawers.
- Crate stack: 2 to 3 simple boxes.
- Pallet rack: shelf frame.
- Server rack: rectangle with stacked slots.
- Printer: box with paper line.
- Whiteboard: rectangle on wall/stand.
- Ticket machine: kiosk with slot.
- Turnstile: simple gate shape.
- Map board: rectangle on post.
- Utility box: small box with latch.
- Bike rack: repeating U-shapes.

## 8. Scannable Vs Non-Scannable

Scannable objects are objects that can become useful or placeable in the Base.

Scannable criteria:

- Can be placed in the Base.
- Has a function, aesthetic value, or both.
- Is recognizable.
- Is not too tiny or generic.
- Does not duplicate another object without a clear reason.

Non-scannable:

- Walls.
- Doors.
- Stairs.
- Elevators.
- Windows.
- Room labels.
- Building labels.
- Extraction point glyphs.
- Spawn markers.
- Road lines.
- Tiny clutter.
- Pure navigation signs.

Some things can be usable but not scannable. Example: stairs are usable, but are not Base objects.

## 9. Scan Progression

Scans must be extracted.

If a player scans an object but fails to extract, it does not count.

Recommended unlock model:

- Common object: 1 extracted Scan.
- Standard functional object: 3 extracted Scans.
- Large functional object: 5 extracted Scans.
- Rare building-specific object: 7 extracted Scans.
- Seasonal object: usually 3 to 7 extracted Scans.

This creates reasons to revisit buildings without making everything feel grindy.

### Example Scan Requirements

Bench:

- 1 extracted Scan.
- Mostly social/decorative.

Locker:

- 3 extracted Scans.
- Adds Home Inventory capacity.

Medical Cot:

- 3 extracted Scans.
- Supports revive/regen upgrades.

Workbench:

- 5 extracted Scans.
- Supports saved Dot Bot setup or Dot conversion later.

Generator:

- 5 extracted Scans.
- Powers more Base floor systems.

Hospital Scanner Bed:

- 7 extracted Scans.
- Rare hospital-specific object.
- Supports advanced storage/scanning upgrades later.

## 10. Building Object Sets

Object sets should match building type.

### Hospital

Rooms:

- Lobby.
- Exam room.
- Ward.
- Storage room.
- Staff room.
- Roof access.

Scannable:

- Medical cot.
- Bed.
- Medical cabinet.
- Rolling cart.
- Monitor.
- Locker.

Not scannable:

- Doors.
- Sinks unless made functional later.
- Curtains/partitions if too noisy.

Likely Dots:

- Regen.
- Shield.
- Scanner.

### Mall

Rooms/areas:

- Main corridor.
- Food court.
- Shop unit.
- Storage backroom.
- Security room.
- Roof access.

Scannable:

- Bench.
- Vending machine.
- Display shelf.
- Kiosk.
- Counter.
- Plant.

Not scannable:

- Storefront lines.
- Stairs/escalator geometry.
- Generic signs unless later used as Base decor.

Likely Dots:

- Dash.
- Decoy.
- Mixed common Dots.

### Office

Rooms:

- Lobby.
- Desk floor.
- Conference room.
- Server room.
- Records room.
- Roof.

Scannable:

- Desk.
- Office chair.
- Filing cabinet.
- Server rack.
- Whiteboard.
- Printer.

Not scannable:

- Cubicle dividers if too repetitive.
- Wall art unless intentionally Base-placeable.

Likely Dots:

- Scanner.
- Decoy.
- Shield.

### Warehouse

Rooms/areas:

- Loading bay.
- Storage aisles.
- Workshop.
- Generator room.
- Office nook.
- Roof ladder.

Scannable:

- Workbench.
- Generator.
- Storage shelf.
- Crate stack.
- Tool cabinet.
- Pallet rack.

Not scannable:

- Individual tiny boxes.
- Loading doors unless interactable later.

Likely Dots:

- Damage.
- Shield.
- Dash.

### Apartment / Hotel

Rooms:

- Lobby.
- Bedroom.
- Kitchen.
- Lounge.
- Laundry room.
- Roof.

Scannable:

- Bed.
- Couch.
- Table.
- Dresser.
- Fridge.
- Lamp only if it has a Base function or clear decor role.

Not scannable:

- Generic clutter.
- Tiny kitchen details.

Likely Dots:

- Regen.
- Decoy.
- Common utility Dots.

### Transit

Rooms/areas:

- Platform.
- Ticket hall.
- Control room.
- Maintenance corridor.
- Lost-and-found.

Scannable:

- Bench.
- Ticket machine.
- Map board.
- Turnstile.
- Control console.
- Locker.

Not scannable:

- Track lines.
- Platform edge markers.

Likely Dots:

- Dash.
- Scanner.
- Extraction-related objectives.

## 11. Outdoor Objects

Outdoor scannable examples:

- Bench.
- Bike rack.
- Street kiosk.
- Utility box.
- Planter.

Outdoor non-scannable examples:

- Road lines.
- Curbs.
- Crosswalks.
- Building outlines.
- Alley markers.

Outdoor Scans are easier to find but riskier because other Dot Bots can see you.

## 12. Dot Spawns

Dot spawns should be tied to places.

Examples:

- Hospital `F2`: Regen Dots.
- Hospital basement: rare Shield Dot.
- Office server room: Scanner Dots.
- Warehouse workshop: Damage Dots.
- Transit platform: Dash Dots.
- Mall food court: Decoy Dots.

Spawns should not be guaranteed every run.

Recommended model:

- Each building has weighted Dot spawn zones.
- Each floor has 1 to 4 possible Dot spawn points.
- Only a subset activates per match.
- Rare Dots create reasons to revisit and learn the Map.

## 13. Base Building

The Base should use the same editor foundation as Maps.

Base differences:

- No enemy combat by default.
- Player can place extracted/scanned objects.
- Objects can provide storage, organization, social space, or preparation functions.
- Player can unlock more rooms/floors.
- Friends can visit.
- Voice chat is enabled.

The Base should remain black-and-white:

- Object lines are black/gray.
- Stored Dots are colored.
- Visiting Dot Bots are colored.

This makes the player's Dots stand out.

## 14. Shared Map Creator / Editor

Build one editor foundation that supports:

- Internal Maps.
- Base building.
- Later player-created Maps for private servers.

Use editor modes:

`Map Editor`

- Streets.
- Building footprints.
- Building interiors.
- Floors.
- Stairs/elevators.
- Extraction points.
- Dot spawn zones.
- Object placements.
- Building type/name labels.

`Base Editor`

- Rooms.
- Floors.
- Object placement.
- Home Inventory storage objects.
- Social spaces.
- Friend visit spawn points.

Shared tools:

- Canvas rendering.
- Object library.
- Select/move/rotate/delete.
- Grid/snap options.
- Floor/layer model.
- Save/load.
- Collision preview.

Map-only tools:

- Spawn zone editing.
- Extraction point editing.
- Floor connection editing.
- Building type assignment.
- Reachability validation.

Base-only tools:

- Owned object inventory.
- Home Inventory capacity display.
- Friend permissions later.
- Voice chat zones later.

## 15. Editor Object Model

```ts
type MapDocument = {
  id: string;
  name: string;
  mode: "map" | "base";
  floors: FloorDocument[];
  buildings: BuildingDocument[];
  objects: MapObject[];
  dotSpawnZones: DotSpawnZone[];
  extractionPoints: ExtractionPoint[];
};
```

```ts
type FloorDocument = {
  id: string;
  buildingId?: string;
  label: "GROUND" | "B1" | "F1" | "F2" | "F3" | "ROOF";
  lineSegments: LineSegment[];
  objectIds: string[];
  connectionIds: string[];
};
```

```ts
type BuildingDocument = {
  id: string;
  type: BuildingType;
  name: string;
  footprint: Vec2[];
  floorIds: string[];
  entrancePoints: Vec2[];
};
```

```ts
type MapObject = {
  id: string;
  objectType: ObjectType;
  position: Vec2;
  rotation: number;
  floorId: string;
  scannable: boolean;
  scanTier?: "common" | "standard" | "large" | "rare" | "seasonal";
  baseFunction?: BaseFunction;
  collision: CollisionShape;
};
```

## 16. Editor Validation

Map validation:

- Every building has at least one entrance.
- Every non-ground floor has stairs or elevator access.
- Dot spawn zones do not overlap walls.
- Extraction points are reachable.
- Objects do not block critical paths.
- Doorways are wide enough for Dot Bots.
- Stairs line up across connected floors.
- Building labels exist.

Base validation:

- Objects fit inside unlocked rooms/floors.
- Storage objects update Home Inventory capacity.
- Dot Bot spawn/visit point is clear.
- Friends cannot spawn inside objects.

## 17. MVP Map Scope

First playable Map should be small.

Recommended MVP:

- One outdoor ground level.
- 3 buildings.
- Each building has 2 floors.
- 1 building has a roof.
- 1 building has a basement.
- 4 to 6 room types total.
- 10 to 15 object types.
- 6 Dot types.
- 3 extraction points.

Suggested first buildings:

- Hospital.
- Office.
- Warehouse.

Why:

- They teach different Dot types.
- They create distinct fight patterns.
- They use distinct object sets.
- They teach floors and Scans quickly.

## 18. Key Decisions

- Keep all geometry black/white/gray.
- Reserve color for Dot Bots and Dots.
- Start with stairs before elevators.
- Scans must be extracted.
- Extracted Scan counts unlock Base objects.
- One editor foundation supports Maps and Base building.
- Player-created Maps are later, but the data model should allow them.

## 19. Open Questions

- Should entering a building be instant or require a short hold?
- Should floor changes be instant or require a tiny hold?
- Should Scan progress pause or reset when interrupted?
- How many object types remain readable?
- Do object glyphs need labels on hover/tap?
- Should rare object Scans require the same building or any object of that type?
- Should Base object placement be freeform or snapped to a grid?
- How much of another floor should Scanner Dots reveal?

## 20. One-Sentence Map Pitch

Maps are black-and-white city drawings where Dot Bots learn buildings, floors, stairs, Scans, Dot spawns, and extraction routes while color is reserved for the players and the Dots worth fighting over.
