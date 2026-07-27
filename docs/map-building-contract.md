# DotBot Map-Building Contract

This is the agent-facing implementation contract for DotBot world work. It exists so a new agent can make a useful change without relying on chat history.

## 1. Authority

Apply direction in this order:

1. Mike's latest explicit instruction.
2. This contract.
3. `dotbot-world-and-run-bible.md` for product direction and unresolved decisions.
4. Proven production patterns in the codebase.

If these disagree, do not silently choose. Preserve the higher-authority direction and record the mismatch.

## 2. Production medium

- Author playable spaces in map data and reusable code-drawn renderer primitives.
- The `pixel-city` visual theme may use the curated LimeZu production atlas documented in `docs/third-party-game-assets.md`. Licensed source packs stay ignored; only selected runtime atlas frames ship. This is a production sprite pipeline, not permission to use room-sized mockups.
- Do not use a concept image as a room, fixture, or roof texture.
- Do not generate visual assets for ongoing world implementation unless Mike explicitly asks for image exploration.
- Concepts can inform art direction; they do not prove production capability.
- Preserve Downtown as the regression and systems map while the new city is developed separately.

### 2.1 Map source: the authoring format

New buildings are authored as a `SourceBuilding` in `packages/game/src/mapSource.ts` and compiled with `compileBuilding`. Author the building; the compiler produces the runtime plan. Never hand-author wall fragments, doorway rectangles, or the second half of a stair.

- **Outline** is the building's *outer* edge — the dimension you would measure on site. `{shape:"rect"}`, `{shape:"polygon"}` or `{shape:"circle"}`. The compiler insets by half the shell thickness to place the wall, derives the bounding `footprint`, and clips the floor slab to the true silhouette.
- **A wall is a path with a thickness**, not a rectangle. Any angle, any number of corners. A vertex carrying `r` becomes a real tangent curve, so an L-plan, a chamfered corner, a round tower, a curved quay wall and a ship's hull are all first-class. There is no requirement anywhere that a building be a box.
- **Openings are placed by anchor**: `near: {x, y}` and the compiler snaps the opening onto the nearest point of the wall. Do not compute arc length. `door`, `rollup` and `archway` cut the wall into a genuine absence of collision; `window` glazes it without cutting. The authored `width` is the *clear* opening — the compiler compensates for the wall's end caps so the width you state is the width a bot gets.
- **The shell belongs to the building**, so a nine-storey tower states its perimeter once. Per-floor `shellOpenings` cut that shared shell.
- **Stairs belong to the building** and compile into the coordinate-identical reverse pair, with direction taken from the floor labels. A mismatched pair is unrepresentable. `GROUND` shares the outdoor physics plane and the compiler handles that; do not restate it.
- **The floor brief of §4 is data**, not a comment: every floor carries a `brief` with all five fields.
- Ids are authored and meaningful (`lot6-rack-a`), not sequential, so inserting an object never renumbers its neighbours.

Curves live only in authoring. `packages/game/src/geometry.ts` tessellates them into polylines and thickens paths into capsules before the runtime sees anything, so collision, navigation and visibility never meet an arc.

One more rule follows from the geometry rather than the format: **a path is a centreline, and the wall is the region thickened around it**, so a free end reaches half a thickness past its last point and reads as rounded. Author a wall that must stop exactly at some line by pulling its centreline back by half the thickness; an end that butts into another wall should run to it or into it. At a doorway the compiler already handles this — the authored width is the clear width.

All four Downtown buildings are authored this way: `content/mercyClinic.ts`, `content/civicTower.ts`, `content/lot6Depot.ts` and `content/beaconHouse.ts`. `content/quaysideDepot.ts` is the reference for non-rectangular geometry. The frozen pre-migration builders and their parity tests have been retired — they pinned every object coordinate to the legacy layout, which blocked all further map work once the migration they proved was finished.

## 3. Visual and physical grammar

- Use a strict top-down plan view. Draw fixture tops, never projected front faces.
- Buildings are not boxes. A world of pure rectangles reads as a diagram; give a building the plan its function implies — an L around a yard, a chamfer at a turning circle, a curved frontage, a round tank. The constraint was in the old data format and is gone; the audit, collision, navigation and visibility all take arbitrary geometry.
- **Pixel City exception:** the purchased environment uses a consistent shallow 3/4 projection. Within that theme, use only assets that share that projection and scale. Colliders remain authored at the visible ground contact/base, tall pixels may occlude a bot in the foreground pass, and no object may mix a front-facing elevation with an overhead footprint.
- Pixel City DotBots use the first-party directional sprite atlas. Their three shield plates are sprite frames synchronized to direction and movement, with distinct intact, damaged, and broken art. Do not wrap the pixel character in runtime vector shield circles.
- Pixel City Dots and ground effects use the same foreshortened ground-plane ellipse as the environment. Do not draw circular top-down markers or noise waves into the shallow 3/4 scene.
- Pixel City collectible Dots use first-party pixel sprite frames with the item mark, shell, highlight, rim, and shadow authored into one image. Do not layer runtime vector symbols over a generic orb.
- Dark, closed outlines mean solid and impassable.
- Light grey floor marks, mats, tracks, thresholds, and annotations mean passable.
- A visible footprint and its collision footprint must agree. Compound shapes must draw and collide from the same local pieces.
- In Pixel City, use Map Studio's cyan visual footprint, red collision footprint, and purple occlusion split together. Purchased sprites receive alpha-derived defaults, but the author must correct them for the actual ground contact and overlap behavior before save approval. Use clipped sprite copies when translucent glass would otherwise reveal a DotBot that is physically behind an object; never add a visible backing rectangle.
- Product marks, controls, handles, bots, and Dots use fixed world-unit scales across rooms.
- Exterior entrances default to open wall gaps. Pixel City may instead use a matching purchased door animation when the doorway declares an authoritative mechanism; its animation frame, collision, sound, AI visibility, client prediction, and replicated state must all derive from the same live door entity.
- Interior doors are sliding doors. Do not draw a closed door until timed interaction, noise, collision, and replication are authoritative. Public automatic doors may open on proximity; secured doors still use a grey Interaction Dot and an authored delay.
- Roofs must derive from the building below. Every roof element belongs to a named system such as access, cooling, exhaust, daylight, drainage, or utilities. Never scatter marks to balance a composition.
- Use ordinary visible names such as `Parts`, `Shop`, `Rack`, `Core`, `Plate`, `Door`, and `Dock`.
- Line of sight must be visually explicit indoors and outdoors. Areas outside the visibility polygon receive a dark overlay strong enough to read immediately; hiding enemies alone is insufficient. Pixel City uses the same darkness on the street and inside buildings so visibility never changes visual language at an entrance. A building still blocks sight behind its footprint, but any exterior face directly in the player's line of sight remains fully lit. Foreground copies and base pixels of a tree, bench, car, stair, or other layered sprite receive the same fog geometry so one object never splits into unrelated bright and dark pieces.

## 3.1 The city between the buildings

Everything above governs the inside of a building. This governs the part a player sees first, and it exists because Downtown passed every interior rule while reading as four boxes dropped on a car park.

Author the ground the way a place actually grows: **street, then block, then frontage, then building.** Never the reverse. A building placed first and a road drawn near it afterwards is exactly what produces a world of objects at arbitrary distances from each other.

Write the exterior as a `CityPlan` (`packages/game/src/cityPlan.ts`) and compile it. The format enforces the order rather than trusting the author to follow it: you declare **streets** as centrelines, and their **footways are derived** — there is no way to draw a pavement in the wrong place relative to its road, because you never draw one.

- **A street is three things**, not one: a carriageway, a kerb with a real level change, and a **footway at least 96 units wide** on both sides. 96 is two DotBots — a band narrower than that is decoration, and a street whose only walkable surface is the carriageway is a road drawn on a field. `compileCityPlan` throws below 96; use `0` and call it a service lane if that is what you mean.
- **Name every piece of ground.** Whatever the streets leave over is block, and each part of it gets a `SurfaceKind`: `footway`, `forecourt`, `plaza`, `yard`, or `verge`. This is the rule the others hang off — a use is a decision, and unnamed ground is a decision nobody made. `auditCity` fails a map that leaves any contiguous region above ~160×160 unassigned.
- **Every entrance needs an approach.** Stepping out of a perimeter door must land on named ground that connects, as a network, to a carriageway. Not "is there a path" — navigation says yes on a blank paved plane. A door onto a courtyard that leads nowhere fails, and should.
- **A building addresses a street.** Its long frontage faces the carriageway, and its centre sits no more than 220 units off the nearest road. Past that it has stopped being on a street and is standing in a field.
- **Every road carries frontage.** A road with nothing built along it is a road to nowhere; either build along it or delete it.
- **Service and public faces differ.** Bins, drums, staff doors and loading belong on a rear or side elevation; entrances, glazing, seating and planting belong on the frontage. A building with the same treatment all the way round has no front. The clinic turns its ambulance apron down the west flank and its entrance forecourt to Main St; the depot does the opposite, because that is what a depot is for.
- **Repeat street furniture on a rhythm, and punch entrances out of it.** A fixed interval with named gaps — `rhythm()` in `content/downtown.ts` — not a hand-placed sequence. Downtown's first draft had trees at 350, 610, 870, 1420: a spacing with no rule behind it, which reads as scatter however carefully it was chosen.
- **Street furniture goes in a furniture strip against the kerb, never mid-footway.** Furniture is solid, so where it stands decides whether the pavement still works: a 22-radius tree at `kerb − 38` takes the middle 44 units of a 96-deep footway and leaves 36 behind it and 16 in front, and a 48-unit bot fits through neither. Against the kerb the same footway keeps a 58-unit clear walking strip. A footway carries two zones or it carries nothing.
- **What looks solid is solid.** Anything drawn as a volume with a cast shadow gets a collider — see `SOLID_KINDS`, and `FLAT_KINDS` for the only exception. The corollary is the one that costs work: an object that used to be a ghost was probably placed where a collider would not fit. Every site the promotion broke on this map was an object standing in a doorway, an entrance approach, or the only route through a room, because those are exactly the places where being a ghost hid the mistake.

The map says what ground is *for*; the renderer decides how each use *looks*. Never encode a material in the map or infer a use in the renderer.

`auditCity(map)` in `packages/game/src/cityQuality.ts` enforces the checkable half of this and `cityQuality.test.ts` asserts Downtown's ledger is empty. Add the rule *before* the fix: a defect nobody can name recurs. And check a new rule fails on the map you already believe is broken — the first footway rule written here passed Downtown before it had a single pavement on it, which made it worse than no rule.

## 4. Intentional layout

Before placing coordinates, write a short floor brief containing all five of these:

1. **Purpose:** what happens on this floor and why it exists in the building.
2. **Zones:** the two to five operational areas a player should be able to identify from the plan alone.
3. **Operational sequence:** how a DotBot, worker, or item logically moves from arrival through those zones.
4. **Adjacency:** which zones or fixtures must be together, separated, wall-backed, protected, or near an exit.
5. **Negative space:** which open areas are deliberate circulation, combat space, queueing, staging, or sightlines.

Reason from that brief before choosing object types or coordinates. Place the stair, entrances, and primary operational anchor first. Add supporting fixtures relative to that anchor, not relative to an empty patch of floor. Every major object must support at least one of:

- the room's function;
- a readable route or choice;
- cover, risk, reward, or interaction;
- a believable building system.

Do not scatter objects, arrows, vents, shelves, or loot as decoration. Repeated modules may be mirrored or varied, but scale, projection, line hierarchy, collision rules, and aisle clearances stay consistent.

The attached-seam allowance is only for modules that visibly extend one bank. Never use it to stack two long counters, benches, shelves, or other fixture faces front-to-back. Parallel banks need a real work aisle between them or one of the redundant banks must be removed. A technically valid arrangement can still fail when it has no believable operational relationship.

### 4.1 Required LLM visual critique

After the first implementation, inspect the production-rendered floor with collision and navigation overlays **off**. Judge the image as a floor plan before looking at test output or coordinates. Write down, at minimum:

- what the primary visual and gameplay anchor is;
- what each visible cluster appears to be used for;
- whether every supporting fixture is plausibly adjacent to the thing it serves;
- whether any object is isolated, redundant, front-to-back with a similar object, or present only to fill space;
- whether the empty space reads as an intentional route or work area rather than an unfinished room.

If the rendered image does not communicate the original floor brief, revise the layout. Do not rationalize it from object IDs or code comments that a player cannot see. Only after this composition pass should collision, clearance, reachability, stairs, Dots, and AI be reviewed with overlays and automated checks.

## 5. Movement and stairs

- Reuse the production mid-stride stair transition in `mapModel.ts` and `simulation.ts`.
- Adjacent-floor stair halves occupy coordinate-identical rectangles, use opposite directions, and share the same `bottom` orientation.
- A player crosses the stair midline and continues moving on the next floor without teleporting, stopping, fading, or pressing a button.
- AI uses the same transition rule.
- Keep a wide, straight approach on both ends. Do not place furniture, collision, loot, or spawn points in the stair rectangle or its immediate run-up.
- Flights should be comfortably wider than one DotBot. Current Mercer Parts flights are 104 by 184 world units; do not narrow them without live movement proof.
- Every stair must declare how access is controlled. Use `access: "openEnd"` for a freestanding flight: the dashed/non-enterable half has solid side rails and a solid far-end cap, while the active entry half uses faint passable side guides and remains physically open at its outer end and on both sides. Art, server collision, client prediction, and navigation all derive from the same guard rectangles. Omit it only when authored walls and doors already enclose the flight.
- Never leave a stair's dashed/non-enterable half accessible from the side. Never rail in the active half: after a floor change, a full-size DotBot must be able to continue along the flight or leave immediately through either side.
- Keep related flights in one legible stair zone by default. Separate or alternate them only when the travel between them contains authored gameplay—not merely empty walking distance.

## 6. Dots, rewards, and AI

- Place Dots to create a route, detour, exposure decision, or encounter. Never distribute them merely to fill empty space.
- Keep every Dot at least one full DotBot radius from solid geometry and reachable by a full-size DotBot.
- Use existing item types as explicit prototypes when the final Core Armour, Blueprint, or other reward is not implemented. Document the proxy; do not imply the missing system exists.
- AI spawns must be reachable, clear of solids and stairs, and tied to a floor's gameplay purpose.
- Upper floors need the same authorship density as the public floor: distinct work zones, perimeter use, route landmarks, and enough code-drawn fixtures to make the floor feel operational. Do not ship sparse shells around a few furniture islands.
- Escalate encounter density or position with building depth deliberately. Do not require a squad for progression or strong equipment.

## 7. Required validation

Automated checks must cover, at minimum:

- `auditCity(map)` matches its recorded ledger, and the ledger only ever shrinks;
- `auditDotPlacement(map)` returns nothing. Dots are the loot economy, so this is asserted empty rather than budgeted: a Dot inside a collider is scenery nobody can collect, and two Dots within `MIN_DOT_SEPARATION` (64, a bot diameter plus tolerance) are one pickup with a wasted slot. Note the trap — a blueprint spawn and an authored Dot are both drawn to the *same* interesting object, so they collide by construction unless the placer knows about the Dots already on the floor;
- `auditBuildingFloorQuality(map, buildingId)` returns no issues for every flagship building. It rejects solid fixture overlaps, visible fixture gaps between the 16-unit attached-seam limit and the 64-unit comfortable-aisle minimum, redundant long parallel fixture banks, meaningful disconnected floor pockets, stairs without a full-size side exit, **stairs unreachable from the rest of their floor**, and **objects hanging off the edge of the floor they stand on**;
- all floor and stair targets exist;
- every stair has a coordinate-identical reverse pair;
- stair entries, Dots, AI spawns, interactions, captures, and intended room zones are reachable by a full-size DotBot;
- Dots and spawns have radius-safe clearance from solids;
- visible compound geometry and collision pieces remain identical;
- when a building changes authoring format, a parity test proves it: no standable floor is taken away, and any floor gained is accounted for by a named effect rather than a tolerance. Compare behaviour a bot can detect — same openings, same standable area, same rooms reachable from the same arrival point — never geometric identity, because a rect wall and a capsule on a centreline are not the same set of points. **Delete the parity test once the migration it proves has landed**: it pins every coordinate, so keeping it past that point blocks all further work on the map;
- package tests, typecheck, and production build pass.

Visual and play checks are also required:

1. Inspect every floor in Map Studio at fit and play-relevant zoom.
2. Enable collision and navigation-clearance overlays on representative complex floors.
3. Walk a DotBot through every intended aisle, counter opening, door, and stair at normal movement speed.
4. Traverse the entire multi-floor route in both directions and verify no snag, stop, jump, or camera discontinuity.
5. Review relevant roofs and exterior entrances.
6. Check browser errors.

Tests can reject a map. They cannot design a map or approve its feel.

The floor-quality audit is a production authoring gate, not a Mercer-specific snapshot. Add the building-wide assertion when a building is created, then keep it green while placing each floor. Do not wait for manual screenshots to discover the same spacing class one fixture at a time. A fixture gap must make one of two promises: an attached seam of 16 units or less, or a comfortable aisle of at least 64 units. Avoid exceptions; if a special geometry is genuinely necessary, fix the shared audit or model the authored shape accurately instead of suppressing the failure.

## 8. Definition of done

Hand off map work with:

- the playable local URL or exact run command;
- a plain-language description of each authored floor or area;
- screenshots from the production renderer, not mockups;
- automated validation results;
- live movement and stair-traversal results;
- explicit provisional systems and remaining gaps.

If any item is missing, call the work a draft or vertical test rather than production-ready.
