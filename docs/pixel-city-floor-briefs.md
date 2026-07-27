# Pixel City block — site plan and floor briefs

Written before coordinates, per `docs/map-building-contract.md` §4. This document
covers the complete first city block: the exterior, five-level Plume Parts, the
two-level Bakery, and the two-level Coolies clothing store. It is the design
intent the authored JSON must communicate; if the rendered map does not read
this way, the map is wrong, not the brief.

## Site plan

The block is one street corner: south street and east street meet at the
south-east corner, where the extraction pad sits. Three retail buildings line
the north edge of the block. The insertion is on the south sidewalk, facing
Plume Parts across a short open approach.

- **Plume Parts** (west, 672×576): the flagship five-level parts building.
  Public shop at street level, work floors above, secured Core room on F4.
- **Bakery** (center-north, 336×336): ordinary two-level bakery. Public
  counter and displays below, stock room and small office above.
- **Coolies** (east-north, 336×336): ordinary two-level clothing store.
  Sales floor below, tailoring and stock above.
- **Pocket park** (south-east of the shops): benches, trees, and lamps between
  the shop walk and the extraction street; open combat ground with tree cover.
- **North service alley** (behind all three buildings): dumpsters, barrels,
  and cardboard behind the shops; Plume Parts' back door opens onto it. It is
  the flanking route: insertion → west lane → alley → back door.
- **West lane** (along Plume Parts' west wall): narrow, mostly clear connector
  between the south frontage and the alley.
- **Shop walk** (between Bakery/Coolies fronts and the park): the pedestrian
  route with both small-shop entrances; kept clear as door aprons.

Routes the exterior must read at a glance: (1) insertion → Plume front doors;
(2) insertion → west lane → alley → Plume back door; (3) shop walk past
Bakery and Coolies doors → park → extraction; (4) park as the open middle
with tree/bench cover between frontage and extraction.

Negative space: the south frontage apron, both small-shop door aprons, the
alley's driving lane, and the park's diagonal desire line to the extraction
are deliberately open. Props sit at edges, never in the middle of a route.

## Plume Parts

One west-side stair zone serves all five levels: two flights side by side
(west flight and east flight, 96×192 each, joined as one bank with a 16-unit
seam). Ground↔F1 and F2↔F3 use the west flight; F1↔F2 and F3↔F4 use the east
flight. A climb is therefore: up, walk around the bank, up again — the
alternating route the Bible's five-level test requires, with no wasted travel.

### GROUND — public shop (existing, approved)

Unchanged apart from Dots/AI review. Purpose: public parts shop. Zones: two
door aprons and public lane (south), parts display islands (center), wall
stock cases (north), service counter (south-west), work bays (east wall),
back door (north-east). Sequence: enter south → browse islands → pay at
counter or continue to work bays → back door to alley. Negative space: the
central lane between islands, the perimeter loop, and both door aprons.

### F1 — Assembly

- **Purpose:** kits staged from storage are assembled into sellable parts and
  sent down to the shop. First upper floor a player sees; teaches the
  stair-bank walk-around with no ambush.
- **Zones:** parts bins (north wall), assembly line (two bench rows, center),
  test/QC corner (north-east), kit staging (west wall, south of stairs),
  packing (south-center, near the down flight).
- **Sequence:** crates come down from F2 on the east flight → staged on the
  west wall racks → assembled along the two bench rows → tested at the QC
  desks → packed and carried down the west flight to the shop.
- **Adjacency:** staging touches the stair bank; the bench rows face each
  other across one work aisle; QC backs the north-east corner so finished
  goods pass it on the way to packing; packing sits between the line and the
  down flight.
- **Negative space:** the aisle between bench rows, the loop around the stair
  bank, and the south lane to packing are circulation; the empty south-east
  quarter is the combat pocket for later floors' defenders pursuing noise.

### F2 — Storage

- **Purpose:** bulk parts storage feeding assembly.
- **Zones:** three shelf banks (east half, aisles between), crate staging
  (south of the stair bank), inventory desk (north-east), secured case bank
  (south-east corner).
- **Sequence:** stock arrives up the east flight → staged on crates → shelved
  in the banks → picked to the west flight down to assembly; the desk logs
  everything in and out; high-value stock sits in the locked cases.
- **Adjacency:** staging touches the stair bank; shelf banks run parallel with
  full work aisles; the desk watches both the stair and the banks; the case
  bank is wall-backed and farthest from the stairs.
- **Negative space:** the two aisles between shelf banks and the perimeter
  loop; the west half stays open as the defender's patrol ground.
- **Encounter:** first defender lives here, patrolling the shelf aisles.

### F3 — Repair

- **Purpose:** broken units are diagnosed, repaired, and parts reclaimed.
- **Zones:** three repair bays (east wall: console + bench pairs), diagnostics
  bench (center), reclaim racks (north wall), break corner (south-west:
  vending, fridge, table).
- **Sequence:** units come up the west flight → diagnosed at the center bench
  → repaired in a bay → usable parts binned on the reclaim racks → returns
  carried down; workers rest in the break corner.
- **Adjacency:** bays are wall-backed with a shared service lane; diagnostics
  faces the bays; reclaim racks stay between the bays and the down flight;
  the break corner is deliberately away from the work, by the west wall.
- **Negative space:** the service lane along the bays, the loop around
  diagnostics, and the stair approaches; second defender patrols here.

### F4 — Core room (secured)

- **Purpose:** the building's protected Core and its support hardware. The
  climb's payoff; hardest fight.
- **Zones:** walled core enclosure (center-east) with one west opening,
  server/power rack wall (north), monitoring desks (west wall), guard ground
  (south lane and enclosure mouth).
- **Sequence:** arrive on the east flight → cross the guarded south lane →
  enter the enclosure mouth → the Core pedestal sits between rack rows; the
  monitoring desks watch the approach.
- **Adjacency:** the enclosure opening faces the monitoring desks, not the
  stairs — attackers must round the corner under fire; racks back the
  enclosure walls; power hardware lines the north wall.
- **Negative space:** the south lane is the authored fight space; the
  enclosure interior is tight on purpose.
- **Encounter:** two defenders (one squad with F2/F3) hold the lane and mouth.
- **Provisional:** the "Core" is a parts case + blueprint Dot proxy; no Core
  Armour, level lock, or fabrication is implemented, and nothing on the floor
  claims otherwise.

## Bakery (two levels)

### GROUND — bakery shop

- **Purpose:** ordinary public bakery: counter, displays, ovens in view.
- **Zones:** door apron (south, off the shop walk), pastry display cases
  (east wall), checkout counter (center-south, facing the door), oven corner
  (north-west behind the counter), bread shelves (west wall), stair to F1
  (north-east corner).
- **Sequence:** customer enters south → display cases on the right → pays at
  the counter; staff loop: ovens → bread shelves → cases; stair up in the
  back corner.
- **Adjacency:** counter between door and stair so the public zone is shallow;
  ovens and shelves form the staff L along west/north; cases wall-backed
  east.
- **Negative space:** the door apron and the L-shaped customer lane past the
  cases to the counter; behind-counter staff strip stays walkable.

### F1 — stock room and office

- **Purpose:** dry stock, flour, and the shop's paperwork.
- **Zones:** stock racks (west wall bank), flour/crate staging (center-south),
  office nook (east wall: desk, binder shelf), break spot (north: table).
- **Sequence:** stock up the stairs → crates staged → shelved on racks;
  paperwork at the desk; one defender guards the floor.
- **Adjacency:** staging between stair and racks; office nook wall-backed
  away from the dusty staging.
- **Negative space:** center lane from stair around staging to the office.

## Coolies (two levels)

### GROUND — clothing store

- **Purpose:** ordinary clothing retail matching the "Coolies" facade.
- **Zones:** door apron (south), window mannequins (south-west, inside the
  display glass), folded-clothes display tables (center pair), hanging racks
  (north wall), fitting corner (south-east: curtain + mirror), checkout desk
  (west, facing the tables), stair to F1 (north-west).
- **Sequence:** enter south → tables ahead → racks along the back → fit in
  the corner → pay at the desk near the exit.
- **Adjacency:** tables get the widest lanes; racks wall-backed; fitting
  corner private in the far corner; desk sees door and tables.
- **Negative space:** the door apron, the loop around both tables, and the
  fitting corner's approach.

### F1 — tailoring and stock

- **Purpose:** alterations bench and back-stock for the sales floor.
- **Zones:** garment rack rows (east half), tailoring bench (center-west:
  work table + mirror), box shelves (north wall), steam/press corner
  (south-west).
- **Sequence:** stock up the stairs → hung on rack rows → altered at the
  bench → down to the floor; one defender patrols the rack rows.
- **Adjacency:** bench near the window light (south), mirror beside it; racks
  in parallel rows with a full aisle; shelves wall-backed.
- **Negative space:** the aisle between rack rows and the bench's working
  clearance.

## As-built adjustments

The audit and navigation loop forced a few deviations from the briefs above;
these are deliberate, not drift:

- **Small-shop density:** a 96-wide stair plus a 96 door in a 304-wide
  interior leaves one fixture band per wall. The Bakery F1 break table and the
  Coolies ground fitting corner did not fit with comfortable aisles, so the
  fitting room (curtain + mirror) lives on Coolies F1 beside the tailoring
  bench, and Bakery F1 is stock/office only.
- **Window dressing is passable:** Coolies mannequins, mirror, and folded
  stacks sit in the shallow display band along the south glass as passable
  visuals — they dress the window without eating the walk lane.
- **Plume F3 diagnostics** is a single desk so the middle bay lane stays
  enterable from the west.
- **Dot readability:** the Bakery health orb sits east of the bake line so the
  tall bread-shelf sprites never hide it.

## Dots and AI (route/risk/reward)

Existing power-up items are explicit proxies; blueprint Dots stand in for the
unimplemented Core/Blueprint systems. Solo progression only; no level gates.

- **Outdoor:** health on the park path, incognito by the far park bench
  (both existing), radar in the alley behind Plume Parts (rewards the flank).
- **Plume:** GROUND keeps health/radar/dash; F1 blueprint (existing) +
  health at staging; F2 radar + dash among the banks; F3 health + incognito
  in the break corner; F4 blueprint at the Core + mine behind the rack wall.
- **Bakery:** GROUND health behind the counter; F1 dash + radar in the stock.
- **Coolies:** GROUND incognito in the fitting corner; F1 health + mine.
- **AI:** one ambient street rover (park/alley); Plume squad: F2 ×1, F3 ×1,
  F4 ×2; one defender each on Bakery F1 and Coolies F1. Ground floors and
  Plume F1 stay peaceful so the stair route can be learned under no pressure.
