# Map Studio production authoring

Map Studio is the production map editor for Pixel City. It edits the same
`MapDocument` consumed by simulation, collision, navigation, and the renderer.
There is no export step.

## Open and save

1. Start the client with `pnpm dev`.
2. Open `http://localhost:5173/?studio&map=pixel-city` (use the printed port if
   Vite chooses another one).
3. Edit the map.
4. Press **Save map**. This validates and atomically writes
   `packages/game/src/content/authored/pixel-city.json`.
5. Press **Playtest** to open the production renderer and simulation.

Every successful save first creates a recovery copy in
`.map-editor-history/`. Recovery files are local and ignored by Git. Map save
and asset browsing are loopback-only Vite development endpoints; they are not
part of the shipped game server.

## Editing

- Click an item to select it. Drag its cyan outline to move it. Drag the cyan
  lower-right handle to resize it.
- Arrow keys move by 8 world units. Shift plus an arrow moves by 1.
- Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z undo and redo. Delete removes the selection.
- The inspector exposes position and size plus the complete production data
  for the selected entity. **Advanced map JSON** is the final escape hatch for
  every `MapDocument` field; it is not a separate format.
- **Inspector** and **Assets** in the top bar toggle those panels so the map
  remains usable at laptop and mobile-browser widths. Choosing an asset closes
  the tray before placement.
- Loot, AI, insertion, and extraction points remain visible as floor-aware
  authoring markers. They are guides only and do not replace the production
  renderer used by Playtest.
- The first **Insertion** added to a blank map also creates the local `player`
  spawn at that position. Moving that insertion moves the co-located player,
  so a map built from nothing can be played without hand-editing JSON.
- Use the floor list to enter a building. **+ Floor** copies the established
  shell geometry with new unique ids. Deleting a floor removes its art,
  spawns, interactions, and inbound stairs.
- **Linked stairs to** creates both coordinate-identical halves at once with
  opposite directions and `access: "openEnd"`. Moving, resizing, or deleting
  one half updates the reverse half. These use the production mid-stride floor
  transition; never replace them with a teleport.

## Purchased assets

The asset tray indexes every PNG in `Game Assets` without adding the source
packs to the web build. **Individual assets only** is the useful default; turn
it off when a sheet or complete room layer is intentionally needed. Search,
pack, and source-resolution filters operate on the complete local library.

Choosing an asset promotes only that source PNG into
`apps/client/public/assets/editor/` and records it in `manifest.json`. The map
stores the promoted asset key, so save, reload, and playtest use the exact same
sprite. Unused source-pack files never ship.

Choose placement behavior before selecting an asset:

- **Solid fixture** creates one `MapObject` whose sprite, hitbox, and foreground
  occlusion belong to the same entity.
- **Passable fixture** creates a visible `MapObject` with no collision.
- **Visual detail** creates a non-gameplay art placement.
- **Ground / floor** creates a ground art placement.

On promotion, Map Studio reads the PNG's opaque pixels and proposes a grounded
collision footprint and occlusion split. These are defaults, not approval.
With an object selected:

- cyan is the visible/selectable sprite footprint;
- red is the actual collision footprint;
- purple is the split above which sprite pixels render in front of the DotBot
  core and shield plates.

Use the inspector to correct all three. Trees normally collide only at the
trunk. Benches collide at their base while their back covers a bot behind them.
Cars and tall fixtures usually need an occlusion split. Translucent windows
that must hide a bot can increase `art.occlusionCopies` in the complete
property editor. This layers only the fixture's clipped pixels; never add a
visible backing rectangle behind the sprite.

## What the editor does not decide

Map Studio prevents format drift and makes geometry inspectable. It does not
replace spatial judgment. Before placing a floor, write the purpose, zones,
operational sequence, adjacency, and intentional negative space required by
`docs/map-building-contract.md`. Inspect the rendered composition with overlays
off before using collision and clearance overlays.

## Required handoff check

Before calling a map production-ready:

1. Save with no validation errors.
2. Review every floor at fit and play-relevant zoom.
3. Review selected fixtures' cyan, red, and purple guides.
4. Enable Collision and Nav clearance on complex areas.
5. Open Playtest and move a full-size DotBot through every intended route.
6. Traverse every stair pair both ways without stopping or snagging.
7. Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.

Warnings remain design work even when save is allowed. Tests can reject a map;
they cannot decide that its layout is believable.

## Blank-map capability check

Run this whenever Map Studio's authoring model, save path, or production map
schema changes. It proves that the editor can build a playable map instead of
only modifying an existing one.

1. Use **Advanced map JSON** to apply a valid empty `MapDocument`.
2. Build the site with the ordinary tools: road, park, insertion, extraction,
   building, solid fixture, passable detail, Dot, and AI. Before placing a Dot,
   choose its plain type: Health, Radar, Dash, or Hide.
3. Add at least three floors and create both linked stair pairs with **Linked
   stairs to**. Keep their approaches clear and exit each stair laterally in
   Playtest before judging the route.
4. Place at least one purchased asset as a solid fixture and one as a passable
   or visual element. Inspect the visible, collision, and occlusion guides.
5. Save, reload Map Studio, and confirm the map, floors, objects, markers, and
   local player start persisted.
6. Open Playtest in the production renderer. Enter from outside, traverse every
   floor in both directions, exit to the site, and deliberately push into a
   wall and solid fixture to confirm they block.
7. Confirm AI is visible and active in a separate combat run so combat cannot
   conceal a broken traversal route.
8. Restore the intended authored map through Map Studio, reload once more, and
   only then run the repository-wide test, typecheck, and build gates.
