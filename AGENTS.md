# DotBot agent instructions

Before changing the city, a building, a room, map art, collision, doors, stairs, loot placement, or AI placement, read:

1. `docs/map-building-contract.md`
2. the relevant sections of `dotbot-world-and-run-bible.md`
3. `docs/map-studio-authoring.md`
4. `CLAUDE.md` when present

The short version:

- Build the playable world in production map data and code-drawn renderer primitives. Do not use generated room, fixture, or roof images unless Mike explicitly asks for an image exploration.
- Preserve Downtown as the regression and systems map. New flagship-city work must not quietly replace it.
- Treat visual shape, collision, navigation clearance, and gameplay meaning as one authored system.
- Use Map Studio for Pixel City production edits and save directly to the authored map. Keep asset collision and occlusion guides correct; do not bypass them by dropping an untracked image into the renderer.
- Plan each floor in plain language before choosing coordinates: purpose, operational zones, adjacency logic, player route, and intended empty space. Use your own spatial judgment; do not generate a layout by filling a grid or merely satisfying validators.
- Review the rendered floor once with overlays off and explain whether its object relationships look believable before checking collision overlays. Run `auditBuildingFloorQuality` afterward as a backstop, never as a substitute for design reasoning.
- Reuse the existing mid-stride stair transition. Do not add a teleport, fade, modal, or special stair control.
- A green test suite is not map approval. Review the real map in Map Studio and move a full-size DotBot through every intended route in the production renderer.
- Keep visible language plain and literal. Do not invent lore terms when an ordinary word works.

Do not call map work complete until the contract's definition of done is met, or clearly state which checks remain.
