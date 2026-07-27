# Previous QA: DotBot Home Base furniture fidelity

- Source visual truth: `/Users/michaelparent/.codex/visualizations/2026/07/17/019f6d85-2db1-7d50-b432-3f908acd6f3c/dotbot-furniture-reference.png`
- Implementation screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/17/019f6d85-2db1-7d50-b432-3f908acd6f3c/dotbot-furniture-final.png`
- Side-by-side comparison: `/Users/michaelparent/.codex/visualizations/2026/07/17/019f6d85-2db1-7d50-b432-3f908acd6f3c/dotbot-furniture-comparison.png`
- Focused table evidence: `/Users/michaelparent/.codex/visualizations/2026/07/17/019f6d85-2db1-7d50-b432-3f908acd6f3c/reference-table-area.png` and `/Users/michaelparent/.codex/visualizations/2026/07/17/019f6d85-2db1-7d50-b432-3f908acd6f3c/dotbot-table-final.png`
- Viewport: Codex in-app Browser, CSS viewport 1159 x 767, DPR 2; captured application surface 860 x 767.
- State: Workshop Home Base, storage linked, starter furniture layout, no panel open.
- Scope: furniture fidelity and scale only. UI, room geometry, interaction dots, controls, labels, object count, and player progression state are intentionally excluded.

## Full-view comparison evidence

The updated furniture keeps DotBot's monochrome architectural-plan language while adding the reference's important legibility cues: recognizable chair silhouettes, cushions, drawer banks, vents, handles, screens, keyboards, papers, cups, tools, shelving contents, and equipment controls. The starter layout remains much sparser than the mock-up because object count and placement are game state rather than part of this pass.

## Focused-region comparison evidence

The planning table now reads as a usable top-down table-and-chair group rather than a featureless grid. Chair footprints are close to the DotBot body scale. The chairs tuck beneath a larger tabletop, matching the relationship visible in the reference dining tables while preserving the existing 108 x 72 collision footprint.

## Required fidelity surfaces

- Fonts and typography: unchanged and outside scope; no typography regression observed.
- Spacing and layout rhythm: existing room and placement-slot geometry is unchanged. Furniture detail remains inside authored collision footprints.
- Colors and visual tokens: existing white paper, dark anchor line, grey fixture line, and light annotation hierarchy are preserved. No decorative color was introduced into furniture.
- Image quality and asset fidelity: furniture remains sharp, scalable plan-view line art at the live game zoom. No blur, transparency halo, compression artifact, or off-axis perspective was observed.
- Copy and content: unchanged and outside scope.

## Comparison history

1. Initial pass — blocked
   - [P2] Chairs remained diagram-scale and did not look capable of seating a DotBot.
   - [P2] A drawing-path artifact produced a diagonal line from the furniture area toward the top-left corner.
   - Fixes: increased chair footprints across planning tables, conference tables, desks, and the Bay Console; explicitly began the cup-handle arc at its own start point.
   - Post-fix evidence: the diagonal artifact disappeared and chair footprints became comparable to the bot's body.

2. Proportion pass — blocked
   - [P2] Enlarging the chairs initially reduced the planning tabletop too aggressively, making the table look undersized.
   - Fix: tucked the chairs beneath the tabletop by roughly half their depth, increasing the visible tabletop without changing collision geometry.
   - Post-fix evidence: the final focused crop shows a substantially larger table with four readable chairs and retained surface detail.

3. Final pass — passed
   - No actionable P0, P1, or P2 furniture-fidelity issues remain in the scoped starter Home Base view.

## Interaction and runtime checks

- Production client and server bundle completed successfully inside the local production image.
- Focused furniture glyph test passed.
- Shell Plan selector opened and closed successfully after the rendering change.
- No browser console errors were recorded. Existing unrelated initialization deprecation warnings remain.

## Follow-up polish

- [P3] Review additional fabricated furniture in normal progression as those objects become available; the starter state cannot visually exercise every glyph at once.
- [P3] If a later art pass increases room furnishing density, preserve identical shell capacity and gameplay behavior.

archived result: passed

---

# DotBot Corner Shop code-capability QA

- Source visual truth:
  - `/Users/michaelparent/.codex/generated_images/019f783d-27e9-7292-bddf-7ea28eb8daa7/exec-70d4f289-6990-48bb-892f-df561ca1a89b.png` — selected open layout.
  - `/Users/michaelparent/.codex/generated_images/019f783d-27e9-7292-bddf-7ea28eb8daa7/exec-fffc1418-cb85-4923-9dd6-d670fae618c7.png` — selected detail and grey-dot direction.
- Implementation screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-studio-final.png`
- Focused implementation crop: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-studio-room-final.png`
- Combined comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-reference-comparison.png`
- Playable evidence:
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-playable-final.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-behind-counter.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-stock-room.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-interaction-dot.png`
- Collision evidence: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-collision-final.png`
- Viewport: Codex in-app Browser, 1280 x 720 CSS pixels, DPR 2.
- State: isolated Mercer Corner Market GROUND floor; Map Studio fit view and live local simulation.

## Findings

No actionable P0, P1, or P2 issues remain in the scoped room-capability test.

The implementation is intentionally less densely furnished than concept 3 because the selected direction uses concept 2's open floor. It preserves the concepts' thick plan-view walls, perimeter cooler rhythm, L counter, central produce island, floor grid, storefront glazing, and subtle grey Interaction Dot. Micro-detail is encoded as reusable vector glyphs rather than a raster background.

## Full-view comparison evidence

The combined comparison was inspected as one image. The coded room follows concept 2's spatial hierarchy: a broad open sales floor, one central produce display, a north/east refrigerated perimeter, a left-side checkout, a small stock room, and a centered glazed entrance. The wall and opening treatment remains strict plan view rather than using concept 2's bottom-wall front face. Concept 3 supplied the denser object-detail target and neutral Interaction Dot, without importing its much tighter aisle density.

## Focused-region comparison evidence

The 1:1 Map Studio view confirms that cooler doors contain stocked shelf marks, the produce island contains distinct bins and product families, and the counter contains a coffee machine, sink, register, cabinet divisions, and a consistent shallow front edge. These marks stay inside their authored footprints. A separate collision/clearance capture confirms that the visible solid objects and physics rectangles agree.

## Required fidelity surfaces

- Fonts and typography: Map Studio retains the existing system font, uppercase letter spacing, and hierarchy. The map itself depends on symbols rather than labels, matching the accessibility goal.
- Spacing and layout rhythm: the 48-unit DotBot is the scale anchor. The storefront opening is 96 units; the main aisles are materially wider than the bot; the behind-counter path and stock-room doorway were physically traversed.
- Colors and visual tokens: white paper, near-black structure, grey fixtures, hairline floor detail, and neutral grey interaction styling all come from the production renderer's existing tokens. Gameplay color remains reserved for the DotBot and HUD.
- Image quality and asset fidelity: the room is production Pixi vector linework at every zoom. No mockup, background image, placeholder texture, or raster room art is used.
- Copy and content: the development surface reads `Corner Shop Detail Test` and `MERCER CORNER MARKET`; no lore-heavy naming was introduced.

## Comparison history

1. Initial geometry pass — blocked
   - [P1] The stock-room shelf overlapped the only full-size route through the door.
   - Fix: corrected the authored 64-unit door gap and replaced the cross-room shelf with a short wall fixture.
   - Post-fix evidence: navigation reaches the stock-room review point and the live DotBot was driven into the room at approximately `(256, 184)`.

2. First furnishing pass — blocked
   - [P2] A cash machine plus grab-and-go shelf technically left a path but squeezed the staff entrance beside the counter.
   - Fix: removed the grab-and-go shelf and moved to a single wall-side cash machine with a wide route to its right.
   - Post-fix evidence: the live DotBot moved through the counter opening and reached approximately `(285, 412)` behind the counter.

3. Detail-language pass — blocked
   - [P2] The first central island and coolers read as generic storage rather than a market.
   - Fix: added reusable `produceDisplay` and `floorTiles` glyphs and expanded long `fridge` glyphs into stocked glass-door cooler bays. The checkout register and coffee station were also refined.
   - Post-fix evidence: the final 1:1 and focused room captures show recognisable produce bins, bottles, cooler doors, register controls, sink, coffee machine, floor tile rhythm, and counter panels.

4. Passability-language pass — blocked
   - [P2] Decorative trees, racks, and a plant could look physical while remaining walk-through.
   - Fix: removed ambiguous outdoor dressing from the isolated test, made the stock cart solid, and kept only clearly flat non-solid floor marks.
   - Post-fix evidence: the final collision overlay matches every visible furniture footprint; no decorative object remains in an intended route without matching collision.

5. Final pass — passed
   - No actionable P0, P1, or P2 visual, collision, traversal, or review-surface issues remain.

## Interaction and runtime checks

- Map Studio opened directly on the room at `?studio&map=corner-shop`.
- Fit, 1:1 zoom, pointer panning, collision overlay, and navigation-clearance overlay were exercised in the in-app Browser.
- The production local simulation opened at `?solo&map=corner-shop` with a real movable DotBot.
- The DotBot was driven from the storefront to the behind-counter area, into the stock room, back through the top aisle, and onto the grey Interaction Dot.
- The dedicated navigation test reaches entry, open floor, behind-counter, stock-room, and interaction-dot review points with the production 24-unit bot radius.
- Game package: 133 tests passed.
- Client package: 57 tests passed.
- Client typecheck and production build passed.
- No browser console errors were recorded. A pre-existing Pixi initialization deprecation warning remains and is unrelated to this room.

## Follow-up polish

- [P3] The grey Interaction Dot is a visual/collision placement proof only; its future door or object action is outside this room-art test.
- [P3] If a later review prefers concept 3's density, add another reusable shelf/display module while preserving the current clearance standard.

archived result: superseded by the production-art projection review below

---

# DotBot Corner Shop production-art and projection QA

- Source visual truth:
  - `/Users/michaelparent/.codex/generated_images/019f783d-27e9-7292-bddf-7ea28eb8daa7/exec-fffc1418-cb85-4923-9dd6-d670fae618c7.png` — selected detailed plan-view direction.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-a25a159a-8f01-4d51-ba03-7f986a97a89e.png` — user-reported counter overlap.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-f472eef7-6f43-4233-9f93-4506e8aca564.png` — user-reported ATM projection and route failure.
- Final full-room implementation: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-studio-overhead-v2.png`
- Reference/implementation comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-production-art-reference-comparison-v2.png`
- Failure/fix comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-projection-failure-fix-comparison.png`
- Collision and navigation overlay: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-studio-collision-overhead-v2.png`
- Live traversal evidence:
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-counter-inside-final.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-counter-edge-stop-final.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-counter-exited-final-v2.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-atm-behind-route-final.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-atm-below-final.png`
- Viewport: Codex in-app Browser, 700 x 767 CSS pixels, DPR 2; CDP captures are 1400 x 1534.
- State: isolated Mercer Corner Market GROUND floor in production Pixi renderer and Map Studio.

## Findings

No actionable P0, P1, or P2 issue remains in the scoped projection, collision, or traversal review.

The user's screenshots correctly invalidated the earlier pass. The old counter illustration projected well beyond its three colliders and its drawn staff entrance was physically narrower than a DotBot. The old ATM mixed an overhead control surface with a tall front cabinet, so its solid rectangle consumed space the image implied should be behind it. Both were art-system failures, not isolated tuning errors.

The corrected rule is now explicit in the World and Run Bible and in the map-art type contract: freestanding objects use true overhead silhouettes whose entire visible footprint is the collision footprint; wall-backed fixtures may use a shallow front edge only when it remains inside collision or extends into non-navigable wall space; irregular objects use composite colliders that trace every visible arm and preserve genuinely traversable drawn openings.

## Full-view comparison evidence

The final room was inspected beside the selected detail reference in one comparison image. It retains the reference's monochrome, high-detail architectural-plan language, stocked fixtures, subtle floor grid, and clear object identity. The implementation intentionally keeps the previously selected open-floor layout. The new counter and kiosk are more strictly overhead than the reference where necessary to preserve unambiguous traversal.

## Focused failure/fix evidence

The failure/fix comparison places both user screenshots beside the corrected live game. The new U-counter has a right-side opening substantially wider than the 48-unit DotBot. The DotBot was driven into the staff area, against the inner counter edge, and back out; at the edge it stops with visible separation rather than overlapping the drawing. The replacement ATM has no tall front cabinet face. The DotBot was driven north of it, around its right edge, and below it without crossing the visible sprite.

## Required fidelity surfaces

- Projection: freestanding kiosk, cart, and produce island now share exact art and collision rectangles. The counter's three colliders trace the illustrated top, left, and bottom arms.
- Spacing: the counter opening is 196 world units between physical arms. The ATM has a tested route on every side and authored navigation review points above and below it.
- Image quality: production raster props remain detailed at normal zoom, with transparent edges and no room-sized background image. Layout, mirroring, collision, and reuse remain map-data driven.
- Colors and visual tokens: monochrome object art, warm paper floor, grey Interaction Dot, and colored DotBot remain visually separated.
- Runtime: no browser console errors were recorded; the existing Pixi initialization deprecation warning remains unrelated.

## Comparison history

1. Raster-detail pass — blocked
   - [P1] Counter art occupied walkable space outside the authored colliders.
   - [P1] The counter's visible staff entrance was narrower than the player even though navigation entered through it.
   - [P1] The ATM's front-facing cabinet made a freestanding prop read as depth-projected and prevented the expected behind route.

2. Projection-system correction — passed
   - Replaced the counter with a true-overhead U asset built around a wide right-side opening and three matching collision arms.
   - Replaced the ATM with a compact true-overhead kiosk whose full visible rectangle is the collider.
   - Applied exact visual/collision footprints to the other freestanding props.
   - Added regression tests for freestanding footprint identity, complete counter-arm coverage, and minimum counter-opening width.
   - Added permanent projection rules to the World and Run Bible and the map object art contract.

3. Live traversal pass — passed
   - Drove the production DotBot into and out of the counter, against its inner edge, north of the ATM, around its right side, and below it.
   - Inspected the corrected room with collision and 24-unit navigation-clearance overlays.
   - Confirmed no browser console errors.

## Follow-up polish

- [P3] The current counter is intentionally generous. If future rooms use a smaller version, preserve the same opening-to-DotBot clearance ratio instead of scaling it blindly.
- [P3] New freestanding asset types should be added to the exact-footprint regression table as they are introduced.

archived result: superseded by the strict code-drawn top-down review below

---

# DotBot Corner Shop strict top-down code-art QA

- User-reported visual failures:
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-b123b7a6-dd90-46ff-aff4-db08fb86c1ef.png` — cooler overlap.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-b9289984-f2f5-4231-a88c-0fd8d482955d.png` — island clearance gap.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-e846aab7-ffb4-41a3-8ece-e2706b642303.png` — squashed cooler and rotated shelves.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-a1fd428c-a895-4b7e-b3f9-fd1681a2bed1.png` — inconsistent product scale.
  - `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-65cc2366-a2bc-47e7-8a4f-2ab8d581bc5a.png` — closest accepted overhead angle.
- Combined before/after comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-code-topdown-comparison.png`
- Full-room implementation: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-code-topdown-studio.png`
- Collision and clearance overlay: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-code-topdown-collision.png`
- Live collision evidence:
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-code-topdown-island-contact.png`
  - `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/corner-shop-code-topdown-cooler-contact.png`
- Viewport: Codex in-app Browser, 850 x 767 CSS pixels.
- State: isolated Mercer Corner Market GROUND floor in Map Studio and the production local simulation.

## Findings

The raster-fixture direction is rejected. It preserved illustrative richness but could not keep projection, transparent bounds, product scale, and collision consistently legible across reused objects.

The replacement is one strict-overhead retail drawing kit. Shelf, cooler, produce, counter, cart, and kiosk detail is assembled in world units from the authored object geometry. Every product top is 10 world units across regardless of fixture or room. The stock-room shelf and cart share the same 62 x 118 footprint as the sales shelving. Right-side shelves use the same orientation-neutral plan symbols instead of rotating a front-facing illustration.

The result is deliberately more diagrammatic than the generated art. That is an honest visual tradeoff, not a hidden success claim. It passes the scoped consistency, collision, and reuse test; final art richness still requires product approval before this becomes the city standard.

## Full-view comparison evidence

The combined image was inspected as one sheet. The before images show five distinct failure modes caused by mixing projected raster assets. The after views use a single 0-degree camera and fixed line hierarchy across the whole room. The cooler bank is assembled as nine equal bays rather than stretching one image. The east shelving and stock-room fixtures share the same package-top language and scale.

## Focused collision evidence

The DotBot was driven north into the produce island and cooler. In both captures the hairline hull at the true 24-unit physics radius touches the visible fixture outline. It does not overlap the drawing and there is no invisible padding. The Map Studio overlay traces the same fixture rectangles; the U counter uses three local collision pieces that are also used to draw its top, left, and bottom arms.

## Comparison history

1. Generated-fixture pass — blocked
   - [P1] Cooler and counter art could overlap the DotBot or imply inaccessible space.
   - [P1] Transparent and perspective padding created apparent clearance gaps.
   - [P2] Cooler, wall shelf, stock shelf, and counter contents used incompatible scales and angles.

2. Strict-plan system pass — passed
   - Removed runtime raster-fixture bindings from the corner shop.
   - Added one code-drawn retail kit with fixed frame, product, gap, control, and corner-radius units.
   - Added exact object-local collision parts for the concave U counter.
   - Added regression coverage for fixed product scale, collision identity, compound counter arms, fixture dimensions, and code-rendered room anchors.

3. Live contact pass — passed
   - Drove the production DotBot against the produce island and cooler bank.
   - Inspected collision and 24-unit navigation clearance in Map Studio.
   - Confirmed navigation paths to the open floor, behind counter, kiosk route, stock room, and Interaction Dot.

## Runtime checks

- Game package: 133 tests passed.
- Client package: 62 tests passed.
- Client typecheck and production build passed.
- Browser logs contained no errors. The existing Pixi initialization deprecation warning remains unrelated.

## Follow-up polish

- [P3] Decide whether this more architectural, diagrammatic level of richness is the desired production identity before expanding beyond the room.
- [P3] If approved, add more code-drawn product-top families and store-specific modules without changing the fixed physical scale or projection rule.

archived result: superseded by the DotBot-native parts-shop review below

---

# DotBot Parts Shop variation and doorway QA

- Source visual truth: `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-2baf4210-30ec-4cb3-a7cb-9db5aadf7dc0.png`
- Implementation screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-pass3-playable.png`
- Full-room Map Studio screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-pass3-studio.png`
- Collision and navigation overlay: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-pass3-collision.png`
- Live stock-room traversal: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-pass3-stock-room.png`
- Combined source/implementation comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-pass3-comparison.png`
- Viewport: Codex in-app Browser, 1280 x 720 CSS pixels.
- State: isolated Mercer Parts GROUND floor in the production local simulation and Map Studio.

## Findings

No actionable P0, P1, or P2 issue remains in the scoped DotBot-world, repetition, doorway, or passability-language review.

The room now reads as a shop for DotBots rather than a miniature human market. Six fixed-size overhead part families suggest cores, plates, coils, boards, bars, and linked components without adding visible lore terminology. The center island mixes wide and narrow trays, larger fields contain deliberate empty sockets, wall racks have different proportions, and deterministic part arrangements prevent repeated fixtures from becoming identical wallpaper.

The stock-room door no longer draws through the counter. Door swing selection now checks solid furniture and stairs for every floor: it keeps a normal swing when clear, flips it when the opposite side is clear, and otherwise draws a light dashed threshold. The DotBot was driven through that threshold into the stock room.

## Full-view comparison evidence

The combined comparison was inspected as one image. The source shows a long door leaf and swing arc crossing the counter, repeated package marks, and human-market worktop cues. The current room removes the overlap, keeps the open layout, replaces food/package shapes with orientation-neutral parts, and introduces visible variation without changing the 10-world-unit part scale.

## Focused-region comparison evidence

The focused source/current row shows the exact doorway and counter relationship. The current threshold stays entirely in the wall opening and uses the same light annotation weight as other passable marks. The counter remains a closed dark outline and therefore reads as solid. No part of the door symbol enters its footprint.

## Required fidelity surfaces

- Fonts and typography: existing HUD and Map Studio typography is unchanged. The only visible room-name change is the plain `MERCER PARTS`, avoiding lore-heavy naming.
- Spacing and layout rhythm: the open sales-floor structure is preserved. Variable east-rack dimensions, mixed island modules, and empty sockets break repetition while retaining full-size navigation clearance.
- Colors and visual tokens: near-black walls and closed anchor outlines identify solid geometry. Hairline grey mats, thresholds, floor tiles, and annotations remain passable. Gameplay cyan remains reserved for the DotBot.
- Image quality and asset fidelity: all part families remain sharp production Pixi linework at play and Studio zoom. There are no raster scaling, transparency, projection, or front-face artifacts.
- Copy and content: `Parts Shop`, `MERCER PARTS`, and ordinary object concepts keep the vocabulary literal and short.

## Comparison history

1. User-reported state — blocked
   - [P1] The stock-room door leaf and swing arc overlapped the solid counter.
   - [P2] Repeated tray and shelf contents made the room look stamped rather than authored.
   - [P2] Several counter and shelf cues still suggested a miniature human market.

2. First DotBot-parts pass — blocked
   - Replaced package tops with six DotBot-oriented part families, varied rack dimensions, added open sockets, and replaced the counter sink/prep board with a service dock and circuit deck.
   - [P1] A newly added coil arc inherited the previous Graphics path and produced diagonal lines across the room.
   - Fix: explicitly moved the drawing path to every coil arc start before stroking.
   - Post-fix evidence: the playable and Studio captures contain no diagonal artifacts.

3. Variation and doorway pass — passed
   - Merged selected center-island cells into mixed wide/narrow modules and varied deterministic part layouts.
   - Made doorway rendering collision-aware and replaced the blocked swing with a light dashed threshold.
   - Added focused regression tests for clear and blocked door swings, variable rack proportions, fixed part scale, and the solid/passable map grammar.
   - Drove the production DotBot through the threshold into the stock room.

## Runtime checks

- Game package: 133 tests passed.
- Client package: 65 tests passed.
- Client typecheck and production build passed.
- Browser logs contained no errors. The existing Pixi initialization deprecation warning remains unrelated.

## Follow-up polish

- [P3] If this physical-world direction is approved, add a small number of additional shop-specific part families while keeping all visible names ordinary.

archived result: superseded by the pure-code roof and sliding-door review below

---

# Pure-code roof and sliding-door QA

- Roof source feedback: `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-9bbf66e0-3956-4ad9-b4d4-8a31dd9d8d36.png`
- Door source feedback: `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-5daf453d-ee66-4f95-b896-6651e4ca3917.png`
- Coded roof review: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-coded-roof.png`
- Coded open-door review: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-open-doors.png`
- State: production Pixi renderer in the local simulation and Map Studio. No generated image is used by the implementation.

## Findings

No actionable P0, P1, or P2 issue remains in the scoped roof and doorway review.

The exterior entrance is now the wall gap itself. It has no leaf, swing arc, dashed barrier, or false collision cue. The stock-room doorway uses two light tracks and a retracted panel drawn over the wall pocket, leaving the walking lane visually and physically open.

The retail roof is now composed from code-drawn membrane bays, a raised service pad, two differently sized air handlers, an uneven vent bank, a hatch, an orthogonal conduit run, a daylight strip, and sparse drainage marks. Equipment is purposefully clustered and maintains large clear service areas. The old floating-equipment-on-a-blank-plate state is gone.

The timed, noisy sliding-door interaction is deliberately not implied as working yet. The current room displays the open state. Authoritative closed-door collision, Interaction Dot channeling, noise, and state replication remain a future gameplay implementation.

## Runtime checks

- Game package: 133 tests passed.
- Client package: 66 tests passed.
- Client typecheck and production build passed.
- Browser review passed at the playable interior and exterior Map Studio views.

## Follow-up polish

- [P3] Implement authoritative sliding-door state, timed grey-dot channeling, opening noise, collision removal, and multiplayer replication before showing a closed interactive door.

archived result: superseded by the intentional roof-plan review below

---

# Intentional retail roof-plan QA

- Source feedback: `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-42656f81-4e4c-4e85-a949-97aeb90fa902.png`
- Fit-map implementation: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-intentional-roof-fit.png`
- 1:1 implementation: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/parts-shop-intentional-roof-1x.png`
- State: pure code-drawn production Pixi roof in Map Studio, reviewed at fit-map and 1:1 zoom.

## Findings

No actionable P0, P1, or P2 issue remains in the scoped roof-composition review.

The previous roof failed because each mark was positioned as an isolated composition element. The replacement is derived from two building systems:

1. A single rear service spine aligns the roof hatch, bounded maintenance lane, two cooling units, and three-unit exhaust manifold on one deck and baseline.
2. A single six-panel skylight bank aligns over the open sales floor and connects to the service spine through one centered utility trunk.

The membrane grid establishes one background module. The standalone drains, arrows, scattered vents, diagonal skylight line, and wandering conduit were removed. The building label occupies the open lower-left field and is not treated as rooftop equipment.

## Runtime checks

- Focused client door/roof tests passed.
- Client typecheck passed.
- Browser review passed at fit-map and 1:1 exterior views.

## Follow-up polish

- [P3] Judge the service-spine-to-skylight proportion in live review before using this roof kit on another retail building.

final result: passed

---

# Pixel City user-supplied 35px orb QA

- Source visual truth: `/Users/michaelparent/development/DotBot/design-assets/pixel-city/dots/orbs-approved.png` (1536 x 1024 RGBA).
- Production implementation screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/pixel-city-orbs-35px-final.png`.
- Focused source/live comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/orbs-source-vs-35px-live.png`.
- Viewport: Codex in-app Browser, 1288 x 873 CSS pixels, DPR 1.8; Pixi canvas buffer 2318 x 1571.
- State: Pixel City solo playtest at the normal gameplay camera scale, with Health and Hide Dots visible in the park.

## Findings

No actionable P0, P1, or P2 issue remains. Both live Dots are fully visible at the requested 35-unit size. The Hide orb has a complete round left edge, Health remains recognizable, and the detached translucent ellipse reads as a shadow rather than a solid pedestal.

## Required fidelity surfaces

- Fonts and typography: unchanged and outside this asset-only scope.
- Spacing and layout rhythm: the 35-unit Dot is subordinate to the DotBot and park furniture while remaining discoverable.
- Colors and visual tokens: four Power variants remain orange, Blueprint blue, and Mine red.
- Image quality and asset fidelity: the supplied RGBA source is used directly. The production atlas stores native 35 x 35 frames, avoiding a second uneven 64-to-35 nearest-neighbour reduction in Pixi. No sprite is clipped and no background rectangle or runtime symbol overlay is present.
- Copy and content: no visible text or nomenclature changed.

## Comparison history

1. First 35-unit renderer pass — blocked
   - [P1] The Hide orb's left rim appeared vertically clipped in live play even though the 64px atlas source was complete.
   - Cause: Pixi was shrinking the 64px atlas frame to 35 world units with nearest-neighbour sampling, unevenly collapsing the dark left rim.
   - Fix: build each atlas frame at its actual 35px gameplay size with a single high-quality source reduction, then render it at 1:1 size.

2. Native 35px atlas pass — passed
   - The focused live comparison shows a complete round Hide silhouette and the intended soft detached shadow.
   - No further visual correction was required.

## Runtime checks

- Full client suite: 18 files and 75 tests passed.
- Client typecheck and production build passed.
- Browser logs contain no application errors. The existing Pixi initialization deprecation warning remains unrelated.

final result: passed

---

# Mercer Parts five-level vertical-test QA

- Source direction: expand the approved room into five levels, add planned Dot and AI encounters, and preserve Downtown's smooth stair movement.
- Implementation: production map data and Pixi renderer only. No generated image assets.
- Floors: `GROUND` Shop, `F1` Assembly, `F2` Storage, `F3` Repair, `F4` Core Bay.
- Stair rule: two west-side 104 x 184 world-unit flights, with coordinate-identical reverse pairs and the existing mid-stride floor swap. Only the dashed half's side rails and far end are solid; faint side guides keep the active half visually continuous while it remains passable at its outer end and on both sides.
- Full-floor captures: `mercer-vertical-ground.png`, `mercer-vertical-f1.png`, `mercer-vertical-f2.png`, `mercer-vertical-f3.png`, and `mercer-vertical-f4.png` in `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/`.
- Collision review: `mercer-vertical-collision.png`.
- Fresh playable handoff: `mercer-vertical-playable.png`.

## Automated findings

- Five expected floors are present in order.
- Every stair target has an opposite-direction, coordinate-identical reverse stair.
- Every stair entry, loot Dot, and AI spawn is reachable from its floor arrival point by a full-size DotBot.
- Every loot Dot and AI spawn center is at least one DotBot radius from solids.
- A production-simulation regression drives an isolated player across all eight authored up/down transitions and verifies the destination floor and lateral continuity.
- A second production-simulation regression drives a player into every flight's dashed/non-enterable half from the side and verifies that the rail blocks entry and no floor change occurs.
- Encounter progression is fixed at zero authored defenders on Ground/F1, one on F2, one on F3, and two on F4. All four share one defender squad.

## Live-review gates

- [x] Inspected all five floors in Map Studio.
- [x] Inspected collision and clearance overlays on F4's compound Core Bay and stair route.
- [x] Crossed Ground to F1 in the live production renderer with continuous movement and no button, fade, teleport, or movement reset.
- [x] Observed AI hear stair noise, descend, and pursue through the same stair system.
- [x] Confirmed every up/down transition in the production simulation.
- [x] Confirmed browser logs contain no application errors. The existing initialization deprecation warning remains unrelated.
- [x] Recorded production-renderer screenshots.
- [ ] Human play approval of the complete Ground→F4→Ground combat route remains required. Browser QA intentionally kept AI active and was downed while testing the earlier seven-defender balance; the authored encounter was reduced to four afterward.

## Runtime checks

- Game package: 142 tests passed.
- Client package: 66 tests passed.
- Client typecheck and production build passed.
- `git diff --check` passed.

current result: playable vertical test ready for human review; not yet production-approved

## July 21 stair-zone and upper-floor density revision

- Consolidated both stair runs on the west side. Intermediate floors now read as one stair zone rather than forcing an empty cross-floor commute.
- Added `StairLink.access: "openEnd"` and shared `stairGuardRects()` geometry. The dashed half's two rails and far-end cap feed the code drawing, authoritative simulation, client prediction, navigation, collision overlay, and clearance overlay. The active half has faint visual guides but no side collision.
- Kept the entry end open and the 88-world-unit clear lane between rails, which remains wider than a full 48-world-unit DotBot.
- Expanded F1 Assembly, F2 Storage, F3 Repair, and F4 Core Bay with intentional benches, storage, consoles, fabrication/repair stations, floor mats, tools, and staged parts. Object placement remains code-authored and purely overhead.
- Map Studio review completed for Ground and all four upper floors. Collision and navigation-clearance overlays must show a continuous center lane, a guarded dashed half, and an active half open on both sides.
- Automated stair pairing, reachability, full-radius clearance, side-entry rejection, and mid-stride traversal checks pass. Human play approval of the complete combat route remains required.

### F1 east-side correction

- Replaced the overlapping kiosk/furniture pile with one central assembly island, one straight east circulation lane, and an aligned wall of lockers, tools, kiosk, fabricator, and staged parts.
- No two solid F1 objects overlap. Five clearance pins down the east aisle remain at least one full DotBot radius from collision, including the narrow point between the build line and fabricator.
- The active stair halves now use faint passable side guides. Only the dashed halves retain dark solid rails and collision.

### July 21 floor-planning correction

- The earlier F4 revision passed collision and connectivity checks but failed visual planning: one oversized U counter sat directly in front of another long workbench, producing redundant fixture bands with no believable work area between them.
- The failure came from using the spacing validator as a layout method. The validator now rejects long parallel fixture banks compressed front-to-back, but this remains a backstop rather than a design engine.
- F4 was rebuilt from an explicit operational brief: north diagnostics, east storage/loadout, one compact central Core machine, a joined south repair line, and a broad loop connecting the west stair to the reward.
- The reusable contract now requires an LLM to plan purpose, zones, sequence, adjacency, and negative space before coordinates, then critique the production-rendered composition with overlays off before checking collision.
- Current F4 remains provisional pending Mike's visual and play approval.

### July 21 kiosk projection correction

- The shared kiosk still used a front-panel composition: a large screen, keypad, and slot stacked vertically inside its footprint. Exact collision did not make that visual top-down.
- Both retail and generic kiosk glyphs now use a symmetric overhead service plate with a circular dock, radial clamps, and corner sockets. No upright screen, keypad, slot, or preferred front remains.
- This is a shared renderer correction, so existing and future kiosk instances inherit the same strict plan-view grammar.

---

# Pixel City block production-slice QA

- Selected DotBot reference: `/var/folders/bh/gty5k7ks2kj6n9qv7vpj0b5c0000gn/T/codex-clipboard-c2c16e86-570e-476f-b6f2-882416f8a9c1.png`.
- Character comparison: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/character-comparison.png`.
- Final playable exterior: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/final-exterior-playtest.png`.
- Final Map Studio interior: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/final-interior-studio.png`.
- Final collision and clearance overlay: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/final-interior-overlay.png`.
- Live indoor visibility: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/final-indoor-live.png`.
- Live route and encounter evidence: `tuned-entry.png`, `tuned-east.png`, `tuned-north.png`, and `tuned-work-bay.png` in the same directory.
- Final two-shield encounter evidence: `/Users/michaelparent/.codex/visualizations/2026/07/21/dotbot-pixel-city/final-encounter.png`.
- Viewport: Codex in-app Browser, 850 x 767 CSS pixels.

## Visual findings

The production block now uses one curated LimeZu atlas with integer nearest-neighbour rendering. The two-bay playable facade, neighbouring storefronts, road intersection, parked vehicles, hydrant, lighting, and pocket park read as one authored block rather than isolated props. The shop interior has a clear entry apron, two central display choices, a west service/storage run, an east work-bay run, and a broad reconnection loop. A temporary floating entry baffle failed the operational-layout critique and was removed.

The DotBot keeps the selected compact black puck, cyan top core, shallow body depth, and large detached shield-plate silhouette. Shields are directional raster frames in the character pipeline. They show intact, damaged, and broken states from live segment health and move with the body; the pixel theme no longer draws runtime vector shield circles.

Pixel City Dots are raised, foreshortened discs and noise waves are ground-plane ellipses. The plan-view Downtown renderer retains circular markers. Indoor visibility now applies a strong dark mask outside the wall-derived visibility polygon, while the exterior and inactive buildings dim behind the active interior.

## Failure and correction history

1. Initial shield integration — blocked
   - [P1] Three small sprite marks read as particles, not protection.
   - Fix: replaced them with broad curved plate sprites, increased their silhouette scale, and added state-specific fracture and mount art.

2. Interior threshold and visibility — blocked
   - [P1] The interior tile stopped at the inner wall edge, exposing an exterior strip through door gaps and making the wall shell appear offset from the facade base.
   - [P1] The indoor fog alpha was effectively invisible.
   - Fix: extended the floor placement to the exact building footprint and made Pixel City interior fog a dark 62% wall-derived overlay. Exterior context art dims further while indoors.

3. Movement and ground effects — blocked
   - [P2] Movement alternated between `idle` and `glide` on render frames between 20 Hz simulation updates, and the second glide frame shifted both body and shield vertically by two pixels.
   - [P2] Circular Dots and dash rings used the old plan-view camera grammar.
   - Fix: latched moving state between simulation ticks, interpolated displayed bot position, fixed every character frame to one hull anchor, removed independent child pixel snapping, and moved visible animation into a short rear glow. Dots and noise now use a 0.56-height ground-plane projection.

4. Encounter balance — blocked
   - [P1] Two full-shield defenders consumed a player at the doorway before the interior could be explored.
   - Fix: defenders remain normal context-aware tactical AI but start with two of three shield plates. A live follow-up reached the work bays and engaged a defender while retaining more than two player shields; the insertion is no longer an immediate loss state.

5. Composition review — passed
   - The north fixtures form one stock run, the west fixtures one service run, the east fixtures one work-bay run, and the two central islands produce a legible loop.
   - The empty south area is a combat/entry apron connected to two exterior doors, not leftover space.
   - No isolated wall, duplicated counter bank, blocked false aisle, or decorative solid remains.

## Automated and runtime checks

- `auditBuildingFloorQuality(pixelCityBlockMap, "pixel-parts")` returns no issues.
- Full-size navigation reaches every shop Dot, both defenders, both front exits, the back exit, the park Dot, and extraction.
- Every raster fixture declares collision intent and integer scale.
- The interior floor placement must continue to match the playable building footprint exactly.
- Game package: 151 tests passed.
- Client package: 66 tests passed.
- Client typecheck and production build passed.
- Current browser reload records no application errors. The existing Pixi initialization deprecation warning remains unrelated.
- Touch joystick movement was used to cross the exterior threshold, traverse the central and east work-bay routes, fight AI, and capture a Dot.
- The sub-430px CSS layout now fits the status and inventory panels side by side with 26px of horizontal budget at a 390px viewport. A physical phone-browser pass remains required before release approval.

current result: production-ready playtest slice; final human visual and phone approval remain required before this becomes the city-wide standard

---

# Pixel City Luminous Energy Pearl Dot QA

- Source visual truth: `/Users/michaelparent/development/DotBot/design-assets/pixel-city/dots/luminous-energy-pearl-approved.png`.
- Production implementation screenshot: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/pixel-city-luminous-dots-final.png`.
- Full-view comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/luminous-dots-full-comparison.png`.
- Focused normal-scale comparison: `/Users/michaelparent/.codex/visualizations/2026/07/19/019f783d-27e9-7292-bddf-7ea28eb8daa7/luminous-dots-focused-comparison.png`.
- Viewport: Codex in-app Browser, 1422 x 800 CSS pixels, DPR 1.8. The Pixi canvas buffer is 2560 x 1440; the browser capture is density-normalized to 1422 x 800 pixels.
- Source dimensions: 1536 x 1024 pixels. Runtime Dot atlas: six 64 x 64 transparent cells. Each Pixel City Dot is rendered at 56 x 56 world units with nearest-neighbour sampling.
- State: live Pixel City solo playtest at the normal gameplay camera scale, showing Health and Hide Dots in the park. The complete six-item family was also inspected in the production atlas.

## Findings

No actionable P0, P1, or P2 mismatch remains in the scoped collectible-art review.

The live Health and Hide Dots preserve the approved hovering pearl silhouette, bright embedded channel marks, specular pixel highlights, lower glow, and contact shadow. The object remains legible against the park paving without a separate runtime icon or badge. Its shallow depth and ground contact match the purchased world's 3/4 projection more closely than the earlier flat discs.

The four Power Dot frames are orange, Blueprint is distinctly blue, and Mine is red. The symbol, material, rim, hover light, and shadow are authored into one raster frame. Pixel City loads those frames from the production atlas; Downtown retains its existing code-drawn markers.

## Required fidelity surfaces

- Fonts and typography: no in-world text was added. HUD typography is unchanged and outside this asset-only scope.
- Spacing and layout rhythm: the 56-unit rendered cell matches the approved normal-gameplay relationship to the 48-unit DotBot, benches, paving tiles, and trees. The shadow remains inside the cell and does not alter collision.
- Colors and visual tokens: Power orange, Blueprint blue, and Mine red match the approved semantic palette. Highlights remain bright enough to retain category marks at normal zoom.
- Image quality and asset fidelity: the approved raster source is used directly by a deterministic extraction pipeline. Nearest-neighbour sampling remains sharp; no runtime vector overlay, CSS drawing, blur, checker background, or transparency block is visible.
- Copy and content: item names and gameplay nomenclature are unchanged.

## Comparison history

1. Earlier coded-disc sprite — blocked
   - [P1] The flat disc silhouette remained difficult to see at the normal camera scale.
   - [P1] The symbol looked placed over the object rather than made from the same material.
   - Fix: selected the Luminous Energy Pearl direction and replaced the hand-drawn Pillow geometry with the approved raster family.

2. First palette revision — blocked
   - [P1] Health was incorrectly blue, conflicting with the intended taxonomy.
   - Fix: restored all four Power variants to orange, reserved blue for Blueprint, and kept Mine red.

3. Production renderer comparison — passed
   - The focused comparison shows the live Health and Hide sprites at normal gameplay zoom beside the approved normal-scale family.
   - No post-comparison visual fix was required.

## Runtime checks

- Focused Pixel City sprite-frame mapping test passed.
- Client typecheck and production build passed.
- Live Pixel City playtest loaded the production atlas with nearest-neighbour sampling.
- Browser logs contain no application errors. The existing Pixi initialization deprecation warning remains unrelated.

## Follow-up polish

- [P3] The current authored map exposes Health and Hide in the captured park state. Capture Blueprint and Mine in a future content-bearing room when those special item placements are authored; their final blue and red frames are already present and mapped in the production atlas.

final result: passed
