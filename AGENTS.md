# DotBot agent instructions

Before changing the city, a building, a room, map art, collision, doors, stairs, loot placement, or AI placement, read:

1. `docs/map-building-contract.md`
2. the relevant sections of `dotbot-world-and-run-bible.md`
3. `docs/map-studio-authoring.md`
4. `CLAUDE.md` when present

The short version:

- Build the playable world in production map data and code-drawn renderer primitives. **No raster assets ship** — a sprite is a second source of truth for an object's shape, and it always drifts from the collider. Do not use generated room, fixture, or roof images unless Mike explicitly asks for an image exploration.
- Downtown is the game and the regression map both. There is one map and one drawing language (`lit-model`).
- Treat visual shape, collision, navigation clearance, and gameplay meaning as one authored system.
- Author the world in map source (`packages/game/src/content/*.ts`). Map Studio is a tweak tool over that source, not an editor — reach for it to nudge a bench, not to build a floor.
- Plan each floor in plain language before choosing coordinates: purpose, operational zones, adjacency logic, player route, and intended empty space. Use your own spatial judgment; do not generate a layout by filling a grid or merely satisfying validators.
- Review the rendered floor once with overlays off and explain whether its object relationships look believable before checking collision overlays. Run `auditBuildingFloorQuality` afterward as a backstop, never as a substitute for design reasoning.
- Reuse the existing mid-stride stair transition. Do not add a teleport, fade, modal, or special stair control.
- A green test suite is not map approval. Review the real map in Map Studio and move a full-size DotBot through every intended route in the production renderer.
- Keep visible language plain and literal. Do not invent lore terms when an ordinary word works.

Do not call map work complete until the contract's definition of done is met, or clearly state which checks remain.
