# Versioned game-domain scaffolding

Status: implementation and integration contract. This document defines pure
game-domain seams only. It does not choose flagship-world content, persistence,
queue behavior, map placement, or client presentation.

## Domain model

### Authored Contracts

Contracts live in a versioned registry. A Contract has a stable id, ordered
prerequisite ids, one or more objectives, and rewards. Objective progress is
advanced by explicit domain events. Completing every objective completes the
Contract, awards its items and Level progress once, and makes dependent
Contracts available.

The graph engine owns these states:

- `locked`: at least one prerequisite is incomplete;
- `available`: every prerequisite is complete;
- `active`: the player accepted the Contract;
- `completed`: rewards and Level progress were granted.

The initial registry contains only two disposable test Contracts. They prove
ordering and objective transitions; they are not the progression arc. The old
map-derived daily-offer functions remain temporarily available as legacy
adapters for current server/client consumers. New code must use the authored
registry and graph state.

`AuthoredObjectiveDefinition` and its event reducer are shared. Player Contract
state wraps them with persistence and rewards. `AiObjective` uses the same
definition and progress shape but has no Contract id, prerequisite graph,
reward, Level, or persistence semantics.

### Level and Interaction Dots

Level is persistent access progress, never combat power. A generic interaction
target may carry requirements such as a minimum Level. Pure authorization
returns an explicit allowed or denied result and never opens a door or mutates a
map.

The same target shape covers a door, loot container, fabrication station, base
object, or other world function. Channel duration and noise are authored on the
target. A successful authorization means only that the actor may begin the
authoritative channel; runtime code still owns range, interruption, collision,
and completion.

### Versioned registries and physical equipment

Every registry has a schema version, content version, stable registry id, and
unique entry ids. Persisted references include all three ids so content can be
migrated deliberately rather than silently changing under stored items.

- Cores: the standard black Core is always present and is not at risk. Rare
  Cores are physical instances. Definitions may declaratively change movement
  and Plate count; no rare catalog or balance is selected here.
- Plate Sets: ordinary Plates are always present. Stealth, Tech, and Blast are
  scaffold entries with explicit capabilities: signal suppression, shortened
  interaction kinds, and mine-damage countering. They contain no final values or
  visual decisions.
- Blueprints and base objects: the integration registry is intentionally limited
  to storage and a locker. It is separate from the current broad prototype
  furniture list.
- Loot tables: outputs are typed item references and are rolled by a pure,
  deterministic seed.
- Fabrication recipes: inputs and outputs are typed item stacks and station
  kinds. Validation returns consumed inputs and produced outputs without
  touching storage or a map.

A physical item instance has a stable instance id, a versioned catalog
reference, and append-only acquisition/ownership history. Rare Cores and Plate
Sets therefore survive extraction, can be stored and equipped, and can be lost
without collapsing into an aggregate count.

### Extraction and loadout

Extracted physical items bank into base storage. Banking returns new storage and
does not alter the selected or locked loadout. Default black Core and ordinary
Plates are virtual defaults and need no stored instance.

A loadout selects either each default or a compatible stored physical instance.
Pure validation checks existence, catalog kind, duplicates, and carried-item
ownership. Queue integration must call `lockLoadoutAtPublicQueueEntry` once and
persist that immutable snapshot for the run. This package does not call the
matchmaker or mutate a player record.

## Persistence handoff schema

The later server integration should persist these records transactionally:

```ts
type PlayerDomainRecord = {
  contractGraph: ContractGraphState;
  learnedBlueprintRefs: CatalogRef[];
  storage: PhysicalStorage;
  selectedLoadout: LoadoutSelection;
  lockedRunLoadout?: LockedLoadout;
};

type PhysicalItemRow = {
  playerId: string;
  instance: PhysicalItemInstance;
  storageState: "stored" | "lockedForRun" | "inRun";
};
```

Required transaction boundaries:

1. Public queue entry validates the selection, writes `LockedLoadout`, and marks
   referenced instances `lockedForRun`.
2. Match start consumes that exact lock; it must not re-read the player's later
   selection.
3. Extraction settlement appends provenance, banks extracted instances, applies
   Contract events, grants rewards and Level progress once, and clears the run
   lock in one idempotent transaction keyed by match settlement id.
4. Loss clears only at-risk physical instances from the run. Missing rare Core
   or Plate Set references resolve to the always-available defaults on the next
   validation; they never synthesize replacement rare instances.

Persist `registryId`, `schemaVersion`, `contentVersion`, and `entryId` on every
catalog reference. Persist the authored Contract registry version beside graph
state. `ContractGraphState.level` is the single Level-progress value; do not add
a second player-Level column that can drift from it. A migration must explicitly
map or reject unknown versions; do not silently reinterpret them as current
content.

### Migration risks

- Existing active Contract rows contain generated daily definitions and ids.
  They cannot be inferred into the authored graph. Keep them on the legacy
  settlement path until closed, or end them with an explicit player-facing
  migration decision; never match them to authored ids heuristically.
- Existing stash rows are aggregate wire-item counts. They cannot establish
  unique rare-equipment identity, previous owners, or provenance. Preserve them
  as ordinary legacy cargo and create physical instances only from an explicit
  acquisition/fabrication/extraction event after cutover.
- The current server moves selected aggregate loadout items out of stash before
  match assembly. The physical-item integration must move the lock boundary to
  public queue entry without double-consuming those legacy rows.
- Current protocol item codes cannot carry physical instance ids or versioned
  catalog references. A protocol migration is required before rare equipment
  can enter a network run; this lane intentionally does not change that wire
  format.
- Existing map `InteractionDot` records are base affordances without target
  requirements. Runtime integration must join authored target ids to dots and
  reject missing/mismatched pairs before any Level gate, container, or station
  is placed.
- The broad prototype furniture/recipe lists remain live. They are not migrated
  merely because the new storage/locker registries exist; later adoption must
  map, retain as legacy, or retire every old id explicitly.

## Adoption order

1. Land this game-package scaffold and keep legacy daily offers, aggregate stash,
   and prototype recipes operating unchanged.
2. Add database tables/columns for graph state, Level progress, catalog refs,
   physical instances, selected loadout, and locked run loadout.
3. Dual-read existing players into defaults; do not auto-equip aggregate stash
   or newly extracted equipment.
4. Switch Contract acceptance/settlement to the authored graph and objective
   events, then remove reroll/day-stamp persistence and UI.
5. Switch loadout locking at public queue entry and extraction settlement to
   physical instances.
6. Adopt generic interaction authorization in authoritative runtime code before
   placing Level locks, containers, or stations in the production map.
7. Author the real Contract arc, equipment catalog, recipes, loot tables, and
   world placements in separate design/integration work.

## Compatibility and non-goals

- Existing `ContractDefinition`, daily-offer helpers, current `RECIPES`,
  `BaseObjectKind`, wire item codes, and map `InteractionDot` remain compatible
  until their integration owners migrate them.
- No server database/auth, matchmaker, room lifecycle, protocol, client visual,
  simulation placement, or production map content is changed here.
- No final progression curve, Contract arc, Core balance, Plate balance, object
  catalog, Blueprint catalog, recipe catalog, loot economy, or visual design is
  implied by scaffold/test entries.

## Not proven in this lane

The pure reducers, validators, deterministic loot rolls, immutable registries,
physical-item/loadout seams, and legacy compile compatibility are tested. No
database transaction, auth path, protocol round trip, queue lock, extraction
settlement, simulation capability application, grey-dot runtime channel, client
screen, production map placement, multiplayer run, or deployment is implemented
or proven here.
