# DotBot: Base Building, Economy & Systems Design Spec

Design decisions from ideation session, July 2026. Written as a handoff for implementation. Sections are marked DECIDED, DIRECTIONAL (agreed in spirit, details flexible), or OPEN.

> Implementation sequencing for this spec lives in `dotbot-implementation-roadmap.md`. Where this document contradicts `dotbot-game-spec.md` or `dotbot-map-and-editor-spec.md`, THIS document wins (see the superseded-decisions banners in those files).

---

## 1. Core Reframe: No Score (DECIDED)

- There is no scoreboard and no "score dots." Remove the rival-score race framing from the current build.
- Dots are materiel, not points. The objective of a run is to extract with better loot, blueprints, and loadout for future runs, or simply to survive and get out.
- That said, the end-of-game recap lists kills of AI and kills of player bots.
- No mid-run banking. You keep only what you physically extract with. Full extraction-shooter tension (DMZ/Tarkov model).
- Death (consume) is haul-ending, not run-ending: you lose what you carried and respawn in your home base. You then spawn into a new game. Learned blueprints and base infrastructure are never lost.
- End-of-run screen is a "manifest," rendered like an architectural title block: what you extracted, what you learned, what you lost.

## 2. Home Base: Off-Map Hideout (DECIDED)

The on-map base concept is cut entirely (see Section 12). The base is a persistent, off-map hideout that doubles as the game's menu.

- **The base IS the menu.** Launching the game places you in your base as your bot, top-down, rendered in the same blueprint linework as the rest of the game. No traditional menu screens.
- Every "menu function" is a physical object you walk to and channel at, using the same channel verb as in-game.
- The base is a small player-authored floor plan (starts as ~2 rooms). The home base is a set map with some empty blocks for placing important gameplay furniture. Players customize where they place furniture. Built on the existing pure-data map model; the base is effectively a small map document.
- **Layout is pure expression; contents are the mechanics.** No adjacency bonuses or layout stat effects. Squadmates can visit your base (forming up for a run happens physically in someone's base), so aesthetics have an audience.
- **Fabrication moment:** when you build a new object, you channel at the zoned floor space and its linework drafts itself in, stroke by stroke. This is a signature visual.
- Starting a run = physically walking out the door / into the deployment elevator.
- Interior = working space (fabricator, lockers, bay console, planning table). Exterior = threshold to deployment.

**Guiding principle: upgrading the base upgrades the gameplay.** Base upgrades expand options, capacity, and information. They NEVER grant invisible power (no damage boosts, no stat percentages). Combat must stay legible; new players lose to skill, not gear.

## 3. Base Upgrade Tracks (DIRECTIONAL)

Five tracks. Every upgrade is a physical furniture object unlocked by blueprint and paid for in dots.

**Capacity**
- Lockers ARE the hold: each locker adds storage slots (base hold ~12).
- Bay console upgrades: save/preset loadout configurations selectable before insertion.
- Courier rack: adds a 5th temporary bay slot for one run, at a dot cost.

**Production**
- Fabricator (starter object): converts dots into powerups and furniture. Tier gates what is craftable.
- Repair bench (blueprint sourced from Mercy Clinic): unlocks plate kits, a carryable that restores one shield plate in the field.
- Shield workshop: unlocks fabricatable plate geometries (see Section 9).

**Intel**
- Planning table: where contracts/missions live. Upgrades widen contract selection and reveal higher-risk tiers.
- Signal mast (blueprint from Civic Tower roof): marks one blueprint dot's true location at insertion.
- Listening post: shows AI density per building before you commit to a run.

**Insertion**
- Garage/elevator upgrades register insertion preferences (see Section 11).
- Higher tiers unlock preference for special entry classes (e.g. rooftop insertion at Beacon House).

**Squad**
- Guest locker: squadmates can stage items at your base.
- Squad fabricator discount: makes one base a natural gathering point.

## 4. Economy (DECIDED)

- Dots are the universal currency, spent at home: fabricating powerups, fabricating furniture, shell upgrades (bigger footprint; eventually a second floor, reusing the existing stairs/floor system).
- Blueprints unlock the ABILITY to fabricate an item; dots pay per fabrication. Once learned, a blueprint is permanent and can never be lost or stolen.
- Revives cost no dots (removes the earlier build's 1-dot revive cost). The cost of a revive is the long, loud, stationary channel.
- Closed loop: run → extract dots + blueprints → spend at base → next run is materially different.
- Shell/footprint upgrades are the big-ticket dot sinks. Everyone starts with a small footprint; footprint growth is top of the progression ladder. Bases stay modest in size; progression grows the object budget more than the floor area.

## 5. Blueprints (DECIDED)

- Blueprint dots are spatially anchored: they spawn on or near their corresponding real-world object. The existing `scannable` flag becomes the spawn table (bed blueprints at Mercy Clinic beds, forklift at Lot 6 Depot, server rack at Civic Tower, etc.). The city is a catalog; buildings have loot identity.
- Collecting a small set of the same blueprint (2 to 4 copies for good items) completes the unlock. Rarity is tuned by LOCATION RISK (where the copies live), not drop-rate grind.
- Blueprint dots obey the full dot economy: they occupy an inventory slot and must be extracted to count. Carried blueprint progress is lootable on consume, but LEARNED blueprints are permanent.
- Completing a set = permanent, unlimited fabrication rights for that item (scarcity lives in dot costs and the base object budget, not in fabrication counts).

## 6. Dots: Taxonomy, Color & Glyph System (DECIDED)

**Color principle: color encodes relationship/value, never identity.** The page stays black-and-white blueprint; color is the scarcest resource.

**Bots**
- All bot bodies are black. The black body is the customization canvas (skins, hatching, glyphs) and never carries faction color.
- Faction color lives ONLY on shield plates:
  - You + teammates: cyan/teal plates (NOT green: green vs red is the classic deuteranopia failure)
  - Enemy players: red plates, drawn with a redundant shape cue (double-stroke or serrated) so hue is never the only signal
  - AI bots: grey plates. AI bots are dumb obstacles that bring the map alive; they cannot be revived or recruited (DMZ model)
- Downed bots render as a broken/hollowed version of their mark in their faction hue. No new color.
- Channel progress rings render in the hue of whoever is channeling (a red ring over your downed ally IS the consume warning).

**Dot legend** (small geometric glyphs, all distinct at ~10px; learnable by silhouette; a diegetic legend/key lives on the pause screen drawn like a title-block key):

| Type | Color | Glyph |
|---|---|---|
| Powerup: health/repair | Orange | Cross |
| Powerup: radar | Orange | Concentric arcs |
| Powerup: dash overcharge | Orange | Chevron |
| Powerup: incognito/muffle | Orange | Dashed outline |
| Blueprint | Blue | Hairline plan-tick |
| Interaction (open, lock, etc.) | Grey | Contextual glyph (key, lock, arrow). Grey because these belong to the architecture, not loot |
| Mine (player-placed) | Disguised as a normal dot | Hairline seam visible up close; marked with an X for the placer's team |

There is no plain currency dot: powerups ARE the currency — you consume them as currency (owner ruling, July 2026).

**Mines (DIRECTIONAL)**
- Player-placeable dots that look like normal dots. On capture: detonate, shattering exactly ONE plate (a deliberate, bounded exception to collision-only damage; never more than one plate).
- The placer's team gets notified on trigger (the mine is a sensor as much as a weapon).
- Another player passing over a mine, even without detonating it, notifies the team that placed it — not just on detonation. Mines double as position beacons.
- Counterplay is mandatory: radar powerup reveals mines, hairline visual tell up close, cap of 2 to 3 active mines per player, own team sees them marked.

## 7. Inventory: Bays + Hold (DECIDED)

- **Bays**: 4 active slots carried in-run (the current 4-dot carry). (Naming not final — this is essentially the playable powerups tray.)
- **Hold**: up to ~12 storage slots in-game, like a backpack for dots. Upgradeable by upgrading the home base.
- Powerups are stored items used at a chosen moment (not instant-on-capture). Players decide when to fire them.
- Swapping hold to bays mid-run is a channel (noisy). At base, swapping is free. This gives the base its loadout function organically.
- Everything carried on your bot is lootable when consumed.
- Balance guard: since carry capacity rose from 4, deposit/extraction channel time scales with load size, and fat hauls are the juiciest consume targets. Greed buys back risk.

## 8. Combat, Revives, Squads (DECIDED)

- Squad size: up to 4 players; 3 at start of game.
- Squad formation: players can invite others to their squad and request to join other squads (DMZ-style social dynamic).
- Revive: any squadmate can revive a downed teammate. "Plea to revive" pings all squads (even enemy squads) to enable the revive.
- Revive is FREE: no dot cost, no health powerup consumed (removes the earlier build's 1-dot revive cost). The cost is the long, loud, stationary channel over bait. A squad with empty pockets can always still pick each other up and route home.
- Revived players come back with ONE CRACKED plate (half strength), rendered as a hairline/dashed arc. This preserves the visual language invariant: a standing bot ALWAYS shows at least one arc; zero arcs only ever means downed. One clean hit shatters a cracked plate and re-downs a fresh revive.
- Full fighting strength requires health powerups. Running out of health items creates a felt death spiral (a squad of cracked-plate bots) rather than a hard game-over.
- Loot-then-revive (DMZ model): an enemy player standing over a downed enemy can (a) consume: steal their carried loot and leave them there (downed player either exits game to respawn in a new one or waits for plea pick-up), or (b) revive without looting (they keep their loot), or (c) loot first, then revive them with nothing (or some things). AI bots cannot be revived by anyone.

## 9. Loadouts: Shield Geometries (DIRECTIONAL — DO NOT BUILD YET; documented for later versions)

- Loadout depth comes from plate CONFIGURATIONS, not stat mods. Examples:
  - Standard: 3 arcs (current)
  - Bulwark: one thick front plate, exposed rear
  - Skirmisher: two thin plates, faster dash
- Configurations are readable at a glance: opponents can count and see your arcs. No invisible percentages, ever.
- Geometries are unlocked via the shield workshop (blueprint + dots) and selected at the bay console before a run.

## 10. Missions / Contracts (DIRECTIONAL)

- Missions are spatial contracts taken at the planning table: pointers at curated risk, using existing verbs. Example: "Extract the ventilator blueprint from Mercy Clinic F3. Reward: 2 radar powerups."
- Objectives revolve around extracting powerups or blueprints; rewards pay out in powerups or blueprints. The economy stays closed.
- Higher planning-table tiers reveal higher-risk, higher-reward contracts.

## 11. Insertion & Matchmaking (DECIDED)

- No live insertion-pick phase (complicates lobby fill for 6-squad maps, causes pick conflicts and AFK timeouts, leaks position info).
- **Preference, not pick**: insertion upgrades register a standing preference set at the planning table before queueing (e.g. "north side," "rooftop-class").
- Matchmaker runs constrained assignment: upgraded squads are WEIGHTED toward their preference (~80% honored), ties break randomly, assignment is instant, nobody waits on a human decision.
- Hardcoded rule: minimum spacing between squad insertions ALWAYS overrides preferences. Spawn-distance integrity outranks anything built.
- At 100+ buildings, keep insertion points comfortably more numerous than squads so assignment stays trivially satisfiable.

## 12. Explicitly Cut Concepts (DECIDED: DO NOT BUILD)

- On-map persistent/per-run bases, base deploy zones, rise-from-ground deployment
- The vault and vault raiding; base sabotage verbs; squad compound blocks
- Defense contracts (base-as-match-map mode)
- Scoreboard / rival score / score dots
- Damage-dealing base traps (mines are the only sanctioned trap, and they live on the map, not in bases)
- Cross-squad revive/absorb of human players (v1)
- Recruiting/reprogramming AI bots

## 13. Open Questions (with owner rulings, July 2026)

1. **Plain currency dot visual**: RESOLVED — there is no plain currency dot. Powerups are the currency; you consume them as currency.
2. **Voice channels**: DEFERRED — decide later. The alternative is click-to-mark pings (mark enemy, move here, loot here, etc.).
3. **Extraction infrastructure**: extraction stays neutral (the three pads). A base-built squad-only extraction beacon was floated but flagged as edging toward pay-to-escape. Not critical right now; do not build.
4. **Base visiting scope** (squad-only vs friends): not critical right now.
5. **Naming**: "bays" (active 4) and "hold" (storage) are working names; "game tray" retired.
