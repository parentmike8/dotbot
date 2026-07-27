# DotBot World & Run Bible

Status: product-direction draft. Planning only; this is not an implementation request.

Last updated: 2026-07-21

This is the plain-language source of truth for DotBot's city, progression, equipment, and map direction. When a simple everyday term works, use it. Avoid lore words for normal game functions.

Older product documents still describe parts of the current build. Once this draft is approved, older documents should be marked as superseded where they conflict with it.

---

## 1. The Game Fantasy

**DECIDED**

> Enter a large and partially unknown city, travel far enough to find something genuinely rare, and survive the journey back with it.

DotBot should not feel primarily like a small combat arena. The city should make players want to:

- leave familiar routes;
- learn streets, buildings, roofs, and underground passages;
- follow contracts into new parts of the city;
- find rare equipment in memorable places;
- decide whether to keep exploring or extract;
- worry about losing something valuable on the way out;
- return with more knowledge and access next time.

Before finding something rare, the player is exploring. After finding it, the player is protecting it.

---

## 2. Plain-Language Rule

**DECIDED**

Names should be short, obvious, and practical. Do not invent lore terms when the object or action can name itself.

Use:

- `Core`
- `Core Armour`
- `Plate Carrier`
- `Plate`
- `Power Dot`
- `Armour Dot`
- `Blueprint Dot`
- `Interaction Dot`
- `Contract`
- `Level`
- `Locked Door`
- `Core Room` or the room's real name
- `Strong AI`
- `Assembly Station`
- `Shortcut`
- `Extraction`

Avoid abstract planning language in the player experience, including terms such as:

- opportunity site;
- access band;
- environmental-state site;
- Core chamber;
- progression node;
- world phenomenon.

Planning documents may describe systems precisely, but player-facing words should remain basic.

---

## 3. Default DotBot

**DECIDED**

Every player always has:

- a standard black Core with no ability;
- the existing three-Plate setup;
- no invisible bonuses.

If the player loses all rare equipment, they return to this default setup. They can always enter another run.

The default setup must remain viable through skill and teamwork. Rare equipment should be desirable without making a default player irrelevant.

---

## 4. Equipment

### 4.1 Core Armour

**CURRENT TEST DIRECTION — REQUIRES ROOM APPROVAL**

`Core Armour` is the working name.

- The standard black Core always remains underneath it.
- Core Armour gives a strong, noticeable ability or behavior.
- Every strong benefit needs a visible weakness or clear counter.
- Do not use hidden percentage bonuses.
- Core Armour is physical loot.
- It can be found, carried, extracted, stored, equipped, looted, and lost.
- A player can carry more than one because extra Core Armour is simply loot.
- Individual pieces should keep their history, including where they were found and who previously owned them.
- Losing Core Armour returns the player to the standard black Core.

Possible Core Armour behavior families remain ideas, not approved designs:

- changed Dash behavior;
- changed contact or force behavior;
- conditional Plate behavior;
- changed Dot capture or carrying behavior;
- ambush or concealment behavior;
- squad-support behavior;
- high-risk, high-reward behavior.

### 4.2 Plate Carrier

**DECIDED CATEGORY; DETAILS OPEN**

The equipment model should use `Plate Carrier` instead of Shield Frame.

The Plate Carrier determines how Plates are arranged around the DotBot. Possible examples include:

- the default three balanced Plates;
- two larger Plates;
- four smaller Plates;
- stronger front coverage with an exposed rear;
- narrow mobile coverage;
- an asymmetrical arrangement.

Rules:

- the default three-Plate Carrier is always available;
- other Plate Carriers should be physical equipment;
- their shape and weakness must be readable during combat;
- losing one returns the player to the default three-Plate Carrier;
- level does not prevent a lower-level player from using a looted Plate Carrier.

Still to decide:

- whether complete Plate Carriers can be found or must be built;
- whether their Blueprints are learned permanently;
- whether they change only Plate positions or also have simple bounded behavior;
- their fabrication cost.

### 4.3 Plates

**DECIDED DIRECTION; DETAILS OPEN**

`Plates` are the visible defensive pieces around the DotBot. The existing three shields become the default three Plates.

Plates are not separate contraband equipment. The Plate Carrier is the equipment; Plates are its active protection during a run.

### 4.4 Dots

**DECIDED DIRECTION**

There is no generic Dot and no generic currency Dot.

Dot categories may include:

- `Power Dots` for active powers;
- `Armour Dots` for restoring or affecting Plates;
- `Blueprint Dots` for permanent knowledge;
- grey `Interaction Dots` for using doors, objects, and world functions.

Each Dot needs a clear color and shape. The final Dot list can be decided later, but every Dot must have a specific purpose.

Revives are free. A revive never requires a Dot and is never a Dot type.

### 4.5 Looting and reviving

**DECIDED DIRECTION**

When a player is downed, another player has two actions:

- `LOOT`
- `REVIVE`

No other downed-player actions are needed.

Looting can take:

- equipped Core Armour;
- equipped Plate Carrier;
- carried Core Armour or Plate Carriers;
- carried Dots and Blueprint Dots.

Looted Core Armour and Plate Carriers are carried as loot. The downed player still has their standard black Core and default three-Plate Carrier available if revived.

**Nothing can be eliminated.** There is no finishing move and no third verb. A downed
bot stays down until somebody revives it, which is what makes the choices below
belong to the player who is down rather than to whoever is standing over them.
Looting leaves the body exactly where it is; wanting to loot *and* revive is two
channels, not a third verb. A channel is held by standing on the body — step off and
it cancels, and the coverer is never pinned in place while it runs.

The loot interface: a picker over what the body carries, plus a **LOOT ALL** that
takes the first items that fit and leaves the rest.

### 4.6 Being downed

**DECIDED DIRECTION**

Downed is a place you can stay for the rest of the run. Three choices, and reviving
is not among them because reviving is something *other* players do to you:

- **Wait** to be picked up by a squadmate.
- **Plea**, to be picked up by another squad.
- **Leave** the run.

While downed you watch your squad, following a living squadmate. When none are
alive the camera returns to your own body, and you can plea from either view. This
is the DMZ shape and it is deliberate: going down must never be the end of a
session, only the end of your agency in it until somebody acts.

Squads load in with three and may reach four, by reviving a downed bot from another
squad that has pleaded — that bot joins the reviver's squad. *Intended, not yet
built:* `squadId` is fixed at spawn today, with no cap and no mid-run path to change
it.

---

## 5. Contracts, Levels, and Locked Doors

### 5.1 Contract progression

**DECIDED**

Progression comes from a persistent authored series of Contracts.

Contracts should:

- give players clear purpose;
- introduce streets, buildings, and shortcuts;
- raise the player's Level;
- lead players toward locked rooms and rare equipment;
- teach the city gradually;
- create reasons to revisit places;
- bring players to shared locations where other squads may also appear.

Do not add daily Contracts for now. Do not require rumours, collectible documents, or a separate clue inventory.

Combat kills should not be the main way to Level. For now, assume Contract progress is the only Level progress.

### 5.2 Levels

**DECIDED**

Level unlocks places. It does not add combat power.

Level must not directly increase:

- damage;
- Plates;
- speed;
- carrying capacity;
- resistance;
- extraction speed;
- Core Armour strength;
- Plate Carrier strength.

### 5.3 Locked doors

**DECIDED DIRECTION**

Important locked doors have a grey Interaction Dot.

Indoor doors use a simple sliding-door format. Exterior entrances are open wall gaps. Public automatic doors can open on proximity. Secured doors still use the Interaction Dot flow below.

The requirement should be obvious, for example `LEVEL 5`.

1. An eligible player stands on the Interaction Dot.
2. A visible stationary channel completes over time.
3. The sliding door opens and the interaction creates a readable noise event.
4. Squadmates of any Level can enter.
5. Other players can also follow or enter while the door is open.

This makes higher-level friends useful without preventing mixed-level squads from playing together. It also keeps doors physical and social: opening one takes time, creates noise, and can expose the location to enemies.

The main streets and ordinary city routes should remain open to everyone. Levels should unlock valuable rooms, facilities, shortcuts, and deeper building areas rather than hide the whole city.

Do not use abstract "access bands." Give important doors direct Level requirements and clear Contract context.

---

## 6. Runs, Insertion, and Extraction

### 6.1 Run length

**DECIDED DIRECTION**

A run lasts no more than 20 minutes.

- The final three minutes are a clear extraction countdown.
- The countdown should strongly encourage players to leave.
- At 20:00 the run ends.
- The exact world event or mechanical reason for the ending can be decided later.
- The presentation should remain direct and understandable, not depend on lore.

### 6.2 Insertion and extraction

**DECIDED DIRECTION; COUNTS OPEN**

Use few insertion and extraction points relative to the size of the city.

This should:

- make travel matter;
- create a real return journey;
- form recognizable traffic routes;
- make rare locations risky even after their defenders are defeated;
- create player encounters without placing squads directly on top of each other.

Required safeguards:

- insertion areas need several ways out;
- no player can be trapped by a Level door;
- extraction points need several approaches;
- extraction camping needs counter-routes and warning opportunities;
- rare equipment should not always have a nearby extraction.

Optional extractions can exist if players complete a simple requirement, but standard extractions should remain scarce.

---

## 7. City Identity

### 7.1 Direction

**DECIDED DIRECTION**

Build a fictional New York-style city rather than a literal recreation.

The city should feel:

- ordered and understandable at street level;
- dense and layered inside buildings;
- connected through roofs, alleys, service passages, and underground routes;
- large enough that players do not learn everything quickly;
- detailed without becoming visually noisy.

Useful ingredients include:

- a clear street grid;
- mixed storefront and apartment blocks;
- alleys, courtyards, loading areas, and fire escapes;
- subway stations and maintenance passages;
- rooftops and occasional roof connections;
- parks, civic buildings, waterfront, rail yards, industrial blocks, and towers;
- major avenues that feel exposed;
- distinct landmarks that players can name and remember.

### 7.2 Building depth

**DECIDED DIRECTION**

Not every building needs a complete multi-floor interior.

Use:

- a smaller number of detailed landmark buildings;
- reusable enterable buildings with good layout variants;
- partial interiors such as stores, lobbies, roofs, and courtyards;
- locked or background buildings that make streets feel dense;
- streets, roofs, subway routes, and shortcuts as exploration spaces.

This is how the city can become very large without filling it with weak repeated interiors.

---

## 8. Special Places

**DIRECTIONAL**

Keep the first list small and name each place by what it is.

The city should support:

- rooms where rare Core Armour can be found;
- strong AI guarding valuable areas;
- places where Plate Carrier Blueprints can be found;
- hidden rooms;
- Level-locked rooms;
- unlockable extraction points;
- useful shortcuts;
- Assembly Stations.

Do not require two players to open a progression door or obtain strong Core Armour. Squadmates can help, but solo progression must remain possible.

Simple powered or unpowered versions of a room may be useful later, but a general environmental-state system is not required for the first room or proof district.

---

## 9. Finding Core Armour

### 9.1 Hybrid model

**DECIDED DIRECTION**

Core Armour can enter the game in several simple ways:

- found as a complete rare item in a specific room;
- looted from another player;
- looted from a strong AI wearing or guarding it;
- built at an Assembly Station using specific Dots.

The rarest Core Armour should usually be a complete physical item found in a memorable place or taken from a strong opponent.

Assembly Stations provide another path without adding generic crafting materials. Their recipes should use specific Dots players already understand.

### 9.2 Presentation

**DIRECTIONAL; COLOR OPEN**

The strongest Core Armour should use the rarest visual treatment.

A rare Core item could appear as a special colored Dot or Core-shaped item in the room. Gold is one possibility, but the final rare colors have not been chosen.

Do not call the location a Core chamber. Use the real room name or simply `Core Room` while planning.

### 9.3 Carrying

**DECIDED**

A found Core Armour is carried as loot. It is not automatically equipped.

A player may carry more than one if they have space. Extracted Core Armour enters the persistent collection and keeps its history.

---

## 10. Visual Detail Test: One Room First

### 10.1 Purpose

**DECIDED NEXT STEP**

Before designing the proof district, prove that one room can reach the desired level of detail and readability.

This is a real code capability test, not an image exercise. The concept images set the target, but they do not prove that the production renderer can achieve it. Approval must be based on the room drawn by the real Pixi map renderer, using real collision, with a movable DotBot.

This room should establish:

- wall and doorway detail;
- window and street-facing detail;
- solid-object appearance;
- passable-object appearance;
- object collision consistency;
- believable furniture density;
- clear walking lanes;
- Dot placement;
- readable detail at normal play zoom;
- attractive detail when zoomed in through Map Studio;
- the production standard future rooms can reuse.

### 10.2 First room subject

**RECOMMENDATION**

Use a compact New York-style parts shop as the first test.

It can test all of the difficult visual questions in one room:

- glass street frontage;
- an open exterior entrance;
- checkout counter;
- racks and stocked parts displays;
- wall cases or parts cabinets;
- small fixtures;
- a sliding back-room door;
- tight but valid aisles;
- a natural Dot location;
- a clear difference between solid furniture and floor detail.

It is ordinary enough to become reusable across the city, but rich enough to expose whether the visual system is actually good.

### 10.3 Selected direction

**DECIDED DIRECTION**

Combine the strongest parts of the three concept images:

- use the open space and spread-out furniture arrangement of image 2;
- use the strict top-down wall treatment of images 1 and 3;
- use the small, subtle grey Interaction Dot from image 3;
- widen the counter area so a DotBot can move through it comfortably;
- make every intended part of the room accessible, including behind the counter;
- do not create decorative staff areas or narrow pockets that look reachable but are not.

### 10.3A DotBot-native physical world

**CURRENT EXPLORATION — REQUIRES ROOM APPROVAL**

Use recognizable city forms, but make their contents and proportions belong to DotBots rather than miniature humans. A shop can have racks, a counter, a back room, and a street address while stocking circular cores, plates, boards, cables, and other parts instead of human food.

Keep the words ordinary. Prefer `Parts`, `Shop`, `Rack`, `Core`, `Plate`, `Board`, `Cable`, `Door`, and `Dock` over invented lore terms. The physical world may feel fantastical without requiring a lore dictionary.

### 10.4 Projection and drawing rule

**DECIDED DIRECTION**

Use one strict plan view rather than an angled, cutaway, or isometric room.

- Walls, doors, windows, floors, and collision footprints remain strict top-down plan view.
- Do not show the front face of the bottom wall as image 2 does.
- Draw fixture tops only. Do not use front faces, even on wall-backed fixtures; their angle and scale become inconsistent when the same part is rotated or reused elsewhere.
- Freestanding fixtures that a player can circle, such as kiosks, islands, and tables, must use a true overhead silhouette. Their complete visible footprint and collision footprint must agree.
- Irregular fixtures such as U counters may use multiple simple colliders, but those colliders must trace every visible arm and leave every drawn opening genuinely wide enough for a DotBot.
- No object art may project into walkable space or imply a different collision shape.
- Dark closed outlines mean solid and never passable. Light grey floor marks, mats, thresholds, and open annotations mean passable. Do not draw a solid and a passable object with the same visual weight.
- Exterior entrances are open gaps with no leaf, swing arc, dashed barrier, or implied collision.
- Interior doors use sliding panels and tracks. An open sliding door retracts into a wall pocket and never projects into the walking lane.
- Closed or locked interior sliding doors use a grey Interaction Dot. Opening one takes time and creates noise; the renderer must not show a closed door until that authoritative interaction and collision behavior exists.
- Small product, control, handle, and equipment marks use fixed world-unit sizes. They are not scaled independently to fill each fixture.
- DotBots, Plates, loot Dots, and Interaction Dots remain true top-down circles.

This keeps movement, collision, rotation, mirroring, and reuse easy to understand. Recognition must come from the overhead silhouette and plan detail, not a projected front face.

### 10.5 Code capability rule

The concept images are art direction only. They may include tiny product marks or perspective effects that have not been proven in code.

The coded room should reach its detail through reusable, code-drawn domain kits such as:

- stocked parts-rack modules;
- wall-case and parts-cabinet modules;
- checkout-counter modules;
- parts-island or display modules;
- small floor-detail and fixture marks;
- consistent wall, door, and window parts.

For the current parts-shop test, each kit draws inside the exact authored object rectangle. Irregular plan shapes may declare simple object-local collision pieces, and the drawing must use those same pieces. Part tops and controls use one fixed world-unit scale across the stock room, wall case, racks, island, counter, and station. This becomes the production direction only if the playable room is approved.

Generated images are not part of the ongoing room-authoring loop unless explicitly requested. Independently generated fixture sprites are not the production source for this style: they introduced inconsistent camera angles, product scales, transparent padding, and implied depth that the physics could not communicate reliably. Do not use a concept image as a background texture. Rooms, roofs, doors, and fixtures remain authored from map data and code-drawn primitives so they can be mirrored, varied, inspected, collided with, and reused throughout the city.

Roofs follow the same rule. They should be intentional top-down architecture rather than blank concealment plates. Start from the building below: place roof access over a back-room or service area, consolidate mechanical equipment along a believable service edge, group exhausts above the equipment they serve, and align skylights over open occupied space. Connect systems with direct maintenance paths or utility runs. Every visible roof element must belong to a named architectural system; never add isolated vents, arrows, boxes, or lines merely to balance the composition. Code-drawn parapets, membrane seams, service pads, fixed-scale equipment, hatches, conduits, and skylights remain useful only when that relationship is clear.

### 10.6 Room workflow

1. Author the room directly in map data and reusable renderer primitives.
2. Open it in Map Studio with pan, zoom, collision, and clearance layers.
3. Spawn a DotBot in the room and walk through every intended area.
4. Review the real interior, exterior entrance, and roof at normal play zoom and close review zoom.
5. Adjust code, scale, paths, collision, and visual weight until approved.
6. Record the approved room and its reusable parts as the visual and authoring standard.

Do not expand into a building until the room is approved.

### 10.7 Acceptance test

The room succeeds when:

- it immediately reads as a real place;
- it feels materially richer than current Downtown rooms;
- objects are identifiable without labels;
- players can predict what blocks movement;
- dark solid outlines and light passable marks remain visually unambiguous;
- exterior entrances remain completely open and swing-free;
- interior sliding-door panels never project into the walking lane;
- aisles feel intentional rather than barely passable;
- a DotBot can comfortably enter and leave every intended area, including behind the counter;
- visible object footprints and collision footprints agree;
- detail does not overpower bots or Dots;
- the room remains readable at play speed;
- the exact room can be reviewed with pan, zoom, collision, and clearance overlays in Map Studio;
- the same object rules can be reused elsewhere.

A polished static image does not count as passing this test.

### 10.8 Five-level Mercer Parts vertical test

**CURRENT PLAYABLE EXPLORATION — REQUIRES BUILDING APPROVAL**

The approved room language is now being tested as a five-level building in the production renderer:

- `GROUND` — public Parts Shop and counter;
- `F1` — Assembly floor;
- `F2` — Parts Storage;
- `F3` — Repair floor;
- `F4` — guarded Core Bay.

Two wide stair runs now form one west-side stair zone instead of sitting on opposite sides of each floor. Each adjacent-floor pair uses the existing Downtown mid-stride transition at identical coordinates, so a DotBot crosses the stair midline and keeps moving on the next level without a button, teleport, or fade. Only the dashed/non-enterable half has solid code-drawn side rails and a solid far-end cap. The active half uses faint passable side guides and stays physically open at its outer end and on both sides, allowing a DotBot to leave immediately after changing floors while still blocking wrong-side entry into the dashed half.

F1 through F4 must feel as authored and operational as Ground. Assembly, Storage, Repair, and Core Bay therefore use denser, purpose-specific work zones and route landmarks rather than sparse furniture islands. Density cannot reduce clear circulation, stair approaches, Dot access, or AI movement.

Mercer Parts also serves as the first building-wide authoring gate. Every floor must pass the shared `auditBuildingFloorQuality` check: no overlapping solid fixtures, no open-looking fixture gaps narrower than the 64-unit comfortable aisle (unless joined within a 16-unit seam), no redundant long fixture banks compressed front-to-back, no meaningful disconnected walkable pockets, and at least one full-size side exit from every active stair half. The seam allowance only joins modules that visibly extend one bank; it cannot excuse a counter placed directly in front of another counter. Crates and other solid anchors use dark closed outlines; pale linework remains reserved for passable floor detail. This check is required for later flagship buildings so manual review can focus on feel and intentionality instead of rediscovering basic collision errors fixture by fixture.

Two loot Dots per floor currently use existing power-up items as gameplay proxies. They test route choice and encounter placement; they do not claim that final Core Armour, Blueprint Dots, or fabrication are implemented. F1 teaches the alternating stair route without an authored ambush. One defender starts on F2, one on F3, and two guard the F4 Core Bay. They share one squad so they hold the authored encounter instead of fighting each other before the player arrives, and they may pursue stair noise between floors. No Level lock or squad-only requirement is part of this test.

The building passes only after a DotBot can traverse the full route in both directions at normal play speed, all stair entries, loot Dots, and AI spawns pass full-radius reachability checks, and every floor is reviewed in Map Studio. The reusable agent implementation standard is `docs/map-building-contract.md`.

---

## 11. Proof District After the Room

Once the room standard is approved, the proof district should test:

- the New York-style street identity;
- several room and building types using the approved detail language;
- one persistent Contract path;
- one Level-locked valuable room;
- one rare Core Armour location;
- one strong AI encounter;
- one hidden room;
- one shortcut;
- one Assembly Station location, even if assembly is not built yet;
- minimal insertion and extraction points;
- a meaningful trip back after finding rare equipment;
- the 20-minute run and final three-minute countdown.

The current four-building Downtown remains a prototype and systems test map. The flagship city starts fresh.

---

## 12. Current Decisions

| Decision | Status |
|---|---|
| Fictional New York-style city | Decided direction |
| Very large city focused on exploration | Decided |
| Current Downtown preserved only as a prototype/test map | Decided direction |
| Single-room visual test before proof district | Decided next step |
| Five-level Mercer Parts building as the next playable vertical test | Current exploration |
| Multi-floor stairs reuse Downtown's continuous mid-stride transition | Decided implementation rule |
| Current building loot uses existing power-ups as explicit proxies | Current exploration |
| Room approval requires real Pixi rendering, collision, and a movable DotBot | Decided |
| Ongoing room and roof iteration is pure code unless images are explicitly requested | Decided |
| Corner-shop layout uses image 2 openness with image 1/3 walls | Decided direction |
| Grey Interaction Dot uses image 3's subtle treatment | Decided direction |
| Exterior entrances are open gaps without swing arcs | Decided direction |
| Indoor doors slide; locked doors take time and make noise when opened from grey Interaction Dots | Decided direction |
| All intended room areas, including behind the counter, are accessible | Decided |
| Enhanced plan view instead of full isometric or angled walls | Recommended direction |
| Standard black Core with no ability | Decided |
| Default three-Plate Carrier | Decided |
| Core Armour as rare physical loot | Decided direction |
| Plate Carrier as the shield-geometry equipment | Decided category |
| No generic Dots | Decided |
| Free revives | Decided |
| Downed choices are Loot or Revive | Decided direction |
| Looted Core Armour and Plate Carriers are carried | Decided |
| Extra equipment can be carried as normal loot | Decided |
| Equipment keeps ownership and extraction history | Decided |
| Core Armour acquisition uses a hybrid model | Decided direction |
| Contracts are persistent and authored | Decided |
| No daily Contracts for now | Decided |
| Contract progress raises Level | Decided direction |
| Level unlocks places, never combat stats | Decided |
| Mixed-Level squads progress together | Decided |
| An opened Level door can be used by other players | Decided |
| No two-player requirement for progression or strong Core Armour | Decided |
| Maximum 20-minute runs | Decided direction |
| Final three-minute extraction countdown | Decided direction |
| Few insertion and extraction points | Decided direction |

---

## 13. Questions That Can Wait

These do not block the single-room visual test:

- the final rare Core Armour colors;
- exact Core Armour abilities;
- exact Plate Carrier set;
- Armour Dot behavior;
- Plate Carrier Blueprint and fabrication rules;
- Core Armour Assembly Station recipes;
- the exact end-of-run event at 20 minutes;
- final insertion and extraction counts;
- exact Level requirements for city doors;
- the detailed loot interface;
- how much item history is shown in the Home Base.

The immediate question is visual: can one room reach the quality, detail, and clarity required for the future city?
