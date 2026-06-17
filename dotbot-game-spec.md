# DotBot - Game Spec

Working title: DotBot

Status: concept spec for future web prototype

## 1. High Concept

DotBot is a minimalist 2D multiplayer extraction game on a white canvas map.

Players control Dot Bots. Dots are colored powers and resources found in the map. Shields are the Dot Bot's health. Scans are object discoveries that can be extracted and added to the Base.

The game should feel simple:

- You are a Dot Bot.
- You collect Dots.
- You have Shields.
- You scan objects.
- You extract to keep what you found.
- You use your Base to store Dots, place scanned objects, and invite friends.

No extra terms are needed for the player to understand the game.

## 2. Simple Lore

The map is a quiet city built from lines.

Dot Bots enter the map to recover Dots and scan useful objects before other Dot Bots get to them first. Dots can power movement, defense, scanning, repair, revives, and attacks.

If a Dot Bot loses all Shields, it goes down. Another Dot Bot can cover it to consume its Inventory, or a teammate can cover it to bring it back.

Everything valuable has to be extracted. What you bring home becomes part of your Base.

That is the lore. The world should feel mysterious, but the words should stay practical.

## 3. Design Pillars

### Low Mental Load

Use plain names everywhere:

- Dot Bot
- Dot
- Shield
- Scan
- Map
- Base
- Inventory
- Home Inventory

Avoid extra labels. The game should explain itself with the terms above.

### Minimal Surface, Real Depth

The art stays simple: black-and-white map, colored Dot Bots, colored Dots. The depth comes from map knowledge, movement, timing, resource pressure, and other players.

### Extraction Creates Stakes

Dots and Scans only matter permanently if they are extracted. Players should constantly decide whether to leave now or risk staying longer.

### Progression Means More Options

Progression gives:

- More Dots in Home Inventory.
- More scanned objects.
- More Base storage.
- More Base floors.
- More ways to prepare before a run.

Progression should not create unavoidable stat advantages inside a run.

### Maps Are Learnable

Maps should have buildings, floors, routes, stairs, rooftops, basements, extraction points, and known high-value areas.

Players should learn where to go, where fights happen, and what each building tends to contain.

## 4. Game Loop

1. Player starts in the Base.
2. Player chooses their Dot Bot for the next run.
3. Squad members see each other's Dot Bot colors before entering the map.
4. Squad enters the map.
5. Squad explores buildings, floors, streets, and rooftops.
6. Squad captures Dots, scans objects, fights Dot Bots, or heads for extraction.
7. Squad extracts to keep Dots and Scans.
8. Extracted Dots go to Home Inventory.
9. Extracted Scans unlock or progress base-placeable objects.
10. Base grows through storage, objects, floors, and social spaces.

## 5. Player Terms

### Dot Bot

A Dot Bot is the player character.

Visual structure:

- A colored outer outline.
- 3 Shields shown as filled segments around the outside.
- Empty Shield outlines remain visible after Shield loss.
- A selected Dot can appear in the center when ready or active.
- White space remains between the outer outline and the selected Dot.

### Dot

A Dot is a colored power/resource.

Dots can be:

- Found in the map.
- Captured by covering them with your Dot Bot.
- Carried in Inventory.
- Used during a run.
- Consumed to repair a Shield.
- Consumed to revive a teammate.
- Extracted into Home Inventory.
- Used later to choose a Dot Bot or start with extra options.

### Shield

Shields are health.

- Default: 3 Shields.
- A full Shield is a filled segment.
- A lost Shield is an empty segment outline.
- At 0 Shields, the Dot Bot is downed.
- Future possibility: 4 Shields can exist through a rare rule, Base upgrade, event, or special mode, but this should not be in the first balance pass.

### Scan

A Scan is progress on an object.

- Scans happen in the map.
- Scans must be extracted to count.
- Enough extracted Scans unlock the object for the Base.

### Inventory

Inventory is what the player carries during the current run.

### Home Inventory

Home Inventory is what the player stores in the Base.

## 6. Choose Your Dot Bot

The pre-run screen should be called:

> Choose your Dot Bot

This replaces heavier setup or class framing.

On this screen:

- Player chooses their Dot Bot color/type.
- That choice sets the Dot Bot's outer color.
- That choice gives one reusable Dot power on cooldown during the run.
- Player chooses a small number of starting Dots from Home Inventory.
- Squad members can see each other's Dot Bot colors and starting Dots.
- Players can change before entering the map.

Recommended rule:

- Choosing a Dot Bot color requires 1 matching Dot from Home Inventory.
- If the player is consumed, the enemy may gain 1 Dot matching that Dot Bot color.
- The player does not lose permanent discovery/unlock knowledge.
- If this is too punishing in playtests, make the chosen Dot Bot color non-lootable and only loot Inventory.

## 7. Inventory Limits

Inventory should be limited.

MVP starting point:

- Start with up to 2 Dots.
- Can carry up to 4 total run items, including found Dots and Scans.

Early progression:

- Increase starting Dots to 3.
- Increase total Inventory slightly through Base upgrades.

Important:

- Inventory limits create hard choices.
- Every carried Dot has value because it can be used as a power, repair fuel, revive fuel, or extraction value.
- Higher limits make fights longer and revives more common, so they must be tuned carefully.

## 8. Dot Types

Dots should be easy to understand by color and behavior.

### Dash Dot

- Reusable Dot Bot version: short dash on cooldown.
- Inventory version: stronger one-time dash.
- Can cause a damaging hit if impact is fast enough.
- Useful for escapes, chases, stairs, and open streets.

### Shield Dot

- Reusable Dot Bot version: brief shield pulse on cooldown.
- Inventory version: blocks one qualifying hit.
- May slow the Dot Bot briefly while active.

### Damage Dot

- Reusable Dot Bot version: next bump can damage even at lower speed.
- Inventory version: one stronger damaging impact.
- Useful for hunting and finishing fights.

### Scanner Dot

- Reusable Dot Bot version: small scan pulse on cooldown.
- Inventory version: larger scan pulse.
- Reveals nearby Dots, Dot Bots, downed Dot Bots, Scans, or movement on nearby floors.
- Scanner pulse also reveals the scanner's origin.

### Decoy Dot

- Reusable Dot Bot version: launches a short fake Dot Bot.
- Inventory version: longer or stronger fake.
- Useful for baiting scanners, extractions, stairs, or enemy attacks.

### Regen Dot

- Reusable Dot Bot version: restores 1 Shield after a delay if not under pressure.
- Inventory version: restores 1 Shield.
- Cannot be used while downed.
- Cannot be used while being consumed.

## 9. Capturing Dots

Dots are captured by covering them with your Dot Bot.

Rules:

- The Dot must fit fully inside the Dot Bot.
- Player must hold coverage for a short duration.
- Suggested time: 1.5 to 3 seconds.
- If the Dot leaves coverage, progress pauses or resets depending on rarity.
- If another Dot Bot bumps the player away, capture is interrupted.
- Rare Dots can move, flee, pulse, or appear in risky building floors.

This makes the same interaction easy to understand:

- Cover a Dot to capture it.
- Cover a downed enemy Dot Bot to consume it.
- Cover a downed teammate Dot Bot to revive it.

## 10. Object Scanning

Objects are simple black-and-white line glyphs.

To scan:

- Move your Dot Bot against or near the object.
- Press and hold.
- Object pulses while scanning.
- Scan can be interrupted by movement, damage, or enemy pressure.
- Scan must be extracted to count.

Scanned objects can later be added to the Base after enough extracted Scans.

## 11. Combat

Combat should be physical and readable.

The basic rule:

> Damage removes Shields. At 0 Shields, the Dot Bot is downed. Enemies can cover the downed Dot Bot to consume it. Teammates can cover the downed Dot Bot to revive it.

### Alive Dot Bots

- Have 1 or more Shields.
- Can move.
- Are solid.
- Cannot overlap other alive Dot Bots.
- Can bump, block, push, and body-check.

### Downed Dot Bots

- Have 0 Shields.
- Cannot move.
- Still show empty Shield outlines, so they are clearly a Dot Bot.
- Are not solid.
- Can be overlapped by other Dot Bots.
- Cannot be bumped or pushed.
- Can be consumed by enemies.
- Can be revived by teammates.

### Damaging Hits

A hit removes 1 Shield if it qualifies.

Qualifying damage can come from:

- High-speed collision.
- Dash impact.
- Damage Dot effect.
- Map hazard.
- Future trap/object effect.

Weak bumps:

- Push or block.
- Do not remove Shields.

Shield targeting:

- A hit does not need to touch a specific Shield segment.
- Any qualifying hit removes 1 filled Shield.
- The emptied Shield can be the one closest to the impact angle for visual feedback.

Safeguards:

- Short invulnerability after losing a Shield.
- No one-hit multi-Shield deletion unless a specific future mode allows it.
- Clear pulse when a Shield is lost.

## 12. Consuming A Downed Dot Bot

To consume:

- Enemy moves over the downed Dot Bot.
- Enemy must fully cover the downed Dot Bot.
- Enemy holds coverage for a fixed duration.
- Suggested duration: 2 to 3 seconds.
- If the enemy moves away, is bumped off, loses coverage, or takes certain damage, the consume is interrupted.

During consume:

- The enemy sees what they are about to gain.
- Teammates can attack or bump the consuming Dot Bot to stop it.

On success:

- Downed Dot Bot is eliminated from the run.
- Consuming player gains that Dot Bot's carried Inventory, subject to space.
- If the chosen Dot Bot color is lootable, consuming player also gains 1 matching Dot.
- Permanent Home Inventory is not stolen.

## 13. Reviving A Teammate

To revive:

- Teammate moves over the downed Dot Bot.
- Teammate must fully cover the downed Dot Bot.
- Teammate holds coverage for a fixed duration.
- Suggested duration: 2 to 3 seconds.
- Revive consumes 1 Dot from the reviver's Inventory.
- If the reviver has no Dots, they cannot revive.
- Revived Dot Bot returns with 1 Shield.

Dot cost:

- Default: consume the most recently acquired Dot.
- Better later UX: show which Dot will be consumed and allow quick selection if safe.
- In active combat, avoid menus.

## 14. Self Repair

Players can consume a Dot from Inventory to restore 1 Shield.

Rules:

- Consumes 1 Dot.
- Restores 1 Shield.
- Has a cooldown.
- Suggested cooldown: 8 to 12 seconds.
- Cannot be used while downed.
- Cannot be used while being consumed.

This makes every Dot useful even if the player does not care about that Dot's power.

## 15. Maps

Maps are black-and-white line-drawn spaces.

Visual language:

- White background.
- Streets: thin black/gray lines.
- Buildings: outlined shapes.
- Rooms: simple wall lines.
- Doors: gaps.
- Stairs: simple stepped/zig-zag glyph.
- Elevators: small square/arrow glyph, later.
- Objects: simple line glyphs.
- Dot Bots and Dots: colored.

Map goals:

- Players learn building names.
- Players learn where Dots spawn.
- Players learn where good Scans are.
- Players learn stairways, rooftops, basements, and extraction points.
- Players learn where fights usually happen.

## 16. Buildings And Floors

Buildings support verticality while staying 2D.

Floor labels:

- `GROUND`
- `B1`
- `F1`
- `F2`
- `F3`
- `ROOF`

Rules:

- Ground map shows streets and building footprints.
- Entering a building switches to that building's current floor.
- Ground fades into the background or disappears.
- Current floor becomes crisp and readable.
- Stairs move between floors.
- Elevators can come later.
- Nearby floors can be hinted through sound rings or Scanner Dots.

Building label examples:

- `MERCY CLINIC / F2`
- `CIVIC TOWER / ROOF`
- `LOT 6 DEPOT / B1`

## 17. Multiplayer

Initial squad size: 3.

Before entering the map:

- Show each player's Dot Bot color.
- Show each player's starting Dots.
- Let players change choices.
- Do not show roles/classes.
- Roles should emerge naturally.

During the run, players can:

- Hunt other squads.
- Avoid other squads.
- Race to rare Dots.
- Interrupt captures.
- Interrupt Scans.
- Interrupt revives.
- Interrupt consumes.
- Bait extraction.
- Use Scanner Dots and Decoy Dots for information play.

Voice chat should exist in:

- Squad runs.
- Base visits.

## 18. Extraction

Extraction turns run value into permanent value.

Rules:

- Extraction points are map locations.
- Extraction requires a countdown/channel.
- Starting extraction should be visible or audible nearby.
- Extraction can be interrupted.
- Extracted Dots enter Home Inventory.
- Extracted Scans count toward object unlocks.

Extraction decisions:

- Leave with modest value.
- Stay for rare Dots.
- Keep scanning.
- Chase another squad.
- Bait enemies into a fight.

## 19. Base

The Base is the player's home space.

Base supports:

- Home Inventory.
- Placed scanned objects.
- More storage.
- More floors.
- Pre-run preparation.
- Friend visits.
- Voice chat.

Base objects should be both aesthetic and functional.

Examples:

- Locker: increases Home Inventory capacity.
- Shelf: organizes Dots visually.
- Workbench: lets players save quick Dot Bot setups.
- Medical cot: supports revive/regen upgrades.
- Desk: supports map notes or planning.
- Generator: powers more Base floor systems.

Avoid abstract lore-only objects for now. If an object exists, it should be useful, readable, or clearly decorative.

## 20. Home Inventory

Home Inventory is total-limited, not type-limited.

Example:

- Player starts with 30 total stored Dot slots.
- Base upgrades increase capacity.
- Storage objects increase capacity.
- Players can eventually store hundreds of Dots, but only after building capacity and extracting them.

This keeps the system simple:

- One number for storage.
- Easy to understand.
- Still allows specialization.
- Still creates pressure when Home Inventory is full.

## 21. Seasons

Seasons can change Dots and Maps without power creep.

Good season levers:

- Rotate Dot types.
- Add 1 or 2 new Dots.
- Change map areas.
- Open new buildings.
- Add seasonal Scans.
- Add Base objects.

Avoid:

- Permanent stronger Dots.
- Paid power advantages.
- Making old players impossible to fight.

## 22. Fairness

Fairness rules:

- Every run has strict Inventory limits.
- Dot Bot power has a cooldown.
- Starting Dots are capped.
- Death risks run Inventory, not the whole Base.
- Paid players should not get stronger Dots or extra Shields.
- Veteran advantage should be choice, map knowledge, and Home Inventory depth.

## 23. MVP Scope

### Prototype 1: Dot Bot Feel

Goal: prove movement, Shields, covering, capture, downed state, consume, revive.

Include:

- White canvas.
- One simple map.
- Dot Bot movement.
- Joystick shaped like a Dot Bot.
- 3 Shields.
- Dot capture by covering.
- Damage from qualifying collision.
- Downed state at 0 Shields.
- Consume/revive by covering.

### Prototype 2: Extraction Loop

Add:

- Small map with buildings.
- Stairs and floors.
- Inventory.
- Dots.
- Object Scans.
- Extraction point.
- Basic Base screen.

### Prototype 3: Multiplayer

Add:

- 3-player squads.
- Other squads.
- Pre-run `Choose your Dot Bot`.
- Real-time consume/revive.
- Voice chat placeholder or integration plan.

### Prototype 4: Base And Map Editor

Add:

- Base object placement.
- Home Inventory capacity.
- Base floors.
- Internal map editor.

Map/editor details are covered in `dotbot-map-and-editor-spec.md`.

## 24. Initial Data Model Sketch

### DotBotPlayer

```ts
type DotBotPlayer = {
  id: string;
  squadId: string;
  position: Vec2;
  velocity: Vec2;
  radius: number;
  state: "alive" | "downed" | "consumed";
  maxShields: number;
  shields: number;
  dotBotType: DotType;
  dotBotPowerCooldownMs: number;
  activeDotId?: string;
  inventoryDotIds: string[];
  inventoryScanIds: string[];
};
```

### Dot

```ts
type Dot = {
  id: string;
  type: DotType;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  position?: Vec2;
  ownerPlayerId?: string;
  source: "home" | "map" | "loot";
};
```

### DotType

```ts
type DotType =
  | "dash"
  | "shield"
  | "damage"
  | "scanner"
  | "decoy"
  | "regen";
```

### ScannableObject

```ts
type ScannableObject = {
  id: string;
  objectType: string;
  position: Vec2;
  floorId: string;
  scanDurationMs: number;
  scansRequiredToUnlock: number;
  baseFunction?: "storage" | "setup" | "revive" | "organization" | "utility" | "decor";
};
```

## 25. Open Tuning Questions

- How fast should Dot Bots move?
- How big should a Dot Bot be relative to a Dot?
- How long should Dot capture take?
- Should consume and revive both take the same time?
- Should self-repair consume the newest Dot, weakest Dot, or selected Dot?
- Should choosing a Dot Bot color risk 1 matching Dot?
- Should 4 Shields ever exist?
- How many starting Dots is too many?
- How large should Inventory be?
- How visible should Scanner Dots and extraction starts be?
- Should downed Dot Bots be able to ping?

## 26. One-Sentence Pitch

DotBot is a minimalist squad extraction game where Dot Bots enter black-and-white maps, collect colored Dots, scan objects, fight over downed Dot Bots, and grow a personal Base from whatever they extract.
