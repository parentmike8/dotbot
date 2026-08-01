# DotBot game-completion backlog

Status: **living owner-alignment document, started 2026-07-31.** This is the
only active repository-level product backlog. It records the intended player
experience, the honest current state, and the work still required before the
game can be called complete.

The world and run direction remains governed by
[`../dotbot-world-and-run-bible.md`](../dotbot-world-and-run-bible.md). City,
building, room, collision, traversal, loot, and AI-placement work must also
meet [`map-building-contract.md`](map-building-contract.md). Historical
milestone reports prove that foundations were built; they do not prove that
the current public experience is finished.

## Product north star

DotBot is one public extraction game, not a room-code game and not a list of
modes.

The normal experience should be:

1. Arrive in a personal base.
2. On a first visit, learn the premise and the essential actions in a small
   practice room connected to that base, or deliberately skip it.
3. Walk to deployment and enter a short public quick-play assembly window.
4. Keep friends together, add available players, and fill every remaining
   place across six squads of three with credible red AI rivals after a visible
   countdown of no more than six seconds.
5. Enter the city, pursue Contracts, explore, collect equipment, fight or
   avoid other squads, and extract.
6. Return with saved loot and visible progress in the base.
7. Press `DEPLOY AGAIN` and begin assembling the next run immediately, without
   waiting for a new server when the existing arena can safely continue.

The experience must remain worth playing with no other human online. More
population should improve the proportion of human opponents, not determine
whether the game works.

## Status language

- **Player-visible gap**: the required experience is absent or clearly wrong
  today.
- **Foundation exists; product pass required**: meaningful code exists, but it
  needs integration, redesign, tuning, or production proof.
- **Direction to design**: the desired outcome is understood, but important
  rules still need creative product work before implementation.

## The target player journey

### First visit and practice room

The first-time player starts in a small room physically connected to the base.
The room explains the game through play and plain language, not a modal tour.

The minimum lesson sequence is:

1. Move the DotBot.
2. Bash a safe practice bot.
3. Parry an incoming bash.
4. Down and search a body.
5. Pick up an item and understand bays versus carried reserve.
6. Use an item.
7. Open the door and enter the base.

The room remains accessible after completion as an optional training arena.
Practice AI can fight normally, but defeat simply returns the player to the
base so they can walk back in.

New players are offered the tutorial before their first public deployment, but
may skip it. Skipping must be an explicit choice rather than a hidden URL path.

**Current state:** foundation exists; product pass required. The checked-in
tutorial currently covers movement, a practice dash, the fabricator, and
entering the base. It does not yet teach parrying, body search, item pickup, or
item use, and the complete first-time experience still needs production
validation.

### Base

The base is the home screen and the physical record of progression. It should
answer three questions without a conventional menu:

- What did I bring back?
- What can I equip or build now?
- What lasting progress have I made?

Required outcomes:

- Dramatically improve the layout, art, lighting/readability, object
  relationships, and sense of ownership.
- Give the player the short, clear premise for why DotBots enter the city and
  recover equipment, power, and information.
- Keep the practice-room door permanently usable.
- Make lockers, bays, fabrication, Contracts, equipment, and deployment read
  as parts of one believable space rather than disconnected panels.
- Make loadout preparation a first-class base action: select carried Dots, a
  Core, a Plate type, and eventually a saved default loadout before deployment.
- Bank extracted equipment into base storage automatically, but never
  automatically risk it in the next run; the player intentionally selects the
  next loadout.
- Let extracted objects, rare equipment, trophies, completed Contract lines,
  and meaningful Blueprint builds visibly change the space.
- Support base customization without turning the base into a generic grid
  editor.
- Revive a defeated practice player safely in the base.

**Current state:** foundation exists; product pass required. A playable base,
persisted layouts, lockers, loadouts, fabrication, upgrades, and placement
slots exist. The current base is not yet an acceptable visual or progression
experience.

### Public deployment and the hot arena

Deployment is the highest-priority player-visible gap.

The default deployment action must:

- join one public quick-play pool;
- preserve a premade party of at most three;
- assemble humans for at least one second and at most six seconds, with the
  remaining time shown clearly;
- create six squads that enter with three members each;
- fill every open place with red rival AI so each run starts with 18
  player-role combatants;
- match only on party, compatible build, and region/latency at launch, with no
  skill matchmaking;
- never make a player wait indefinitely for another human;
- never add a new human halfway through a live run; and
- start the run automatically when the assembly deadline expires.

The player first completes the base deployment Interaction Dot's short visible
channel. Stepping off cancels that channel. Completing it enters assembly
immediately without another confirmation screen, and assembly itself retains a
visible cancel action.

Private games, host-start, join codes, and create-room versus join-room choices
should be removed from the ordinary product. Friend grouping still needs a
simple party/invite path, but the party deploys into the same public pool.

After a run, the player chooses between preparing their loadout and
`DEPLOY AGAIN`. `DEPLOY AGAIN` begins assembly immediately; it is never an
involuntary queue. The arena cycles through:

`assembling -> countdown -> live -> results -> assembling`

Vacated places reopen between runs. The quick-play pool fills them after the
player opts in, then AI fills what remains. Parties persist across runs;
opponents do not need to. Each run still receives a fresh match ID and a
separate persistence transaction. Arenas drain and recycle after a bounded age
or run count so releases and cleanup remain safe.

**Current state:** player-visible gap. Production can allocate a GameLift
session, validate player sessions, and run authoritative multiplayer, but the
base deployment overlay still exposes room creation/codes and host start. A
dedicated room ends and calls `ProcessEnding` shortly after a match instead of
cycling through runs.

Capacity is part of this feature:

- Keep at least one launch-region instance warm during active hours if the
  product promises near-instant deployment.
- Maintain one spare process beyond current demand.
- Scale on available process slots, not CPU alone.
- Re-benchmark the production process and fleet shape for an 18-player room;
  the existing two-process, nine-player-per-room proof is no longer the target.
- Load-test one complete 18-client run and then the intended number of
  simultaneous 18-player rooms before setting process density or fleet limits.
- Add latency-aware regional placement only when measured player latency and
  population justify it.

### The one run mode

There is one launch mode: insert, pursue Contracts and loot, survive, and
extract.

Working launch target, still to tune:

- approximately eight minutes total;
- a clear final extraction phase of approximately 90 seconds;
- only a small number of meaningful extraction points during the run; and
- all but one extraction closing for the finale, forcing surviving squads
  toward a shared final route.

The final-extraction state machine and configurable timing belong in the
content-neutral run scaffolding now. Final locations and balance wait for the
flagship city.

The exact timing remains tunable against the flagship city's real travel
distances. The important decision is the pressure curve: few exits, clear
closure, and a final convergence rather than extraction pads scattered
everywhere.

**Current state:** foundation exists; major product pass required. The run,
timer, extraction channel, manifest, and persistence hooks exist. Extraction
placement and end-of-run closure are not yet the intended designed system.

## Workstreams

### P0 — Make the default website launch the real game

- [ ] Replace create/join/host-start deployment with public quick play.
- [ ] Add the one-to-six-second assembly countdown and automatic start.
- [ ] Expand the match model from three to six squads of three and fill all 18
      positions with humans or player-role AI.
- [ ] Preserve premade parties and fill their open squad places.
- [ ] Backfill all remaining rival places with red AI.
- [ ] Match only by party, build compatibility, and region/latency; do not add
      launch MMR.
- [ ] Add multi-run GameSession lifecycle and `DEPLOY AGAIN`.
- [ ] Let players revise their loadout after results, then begin assembly only
      when they choose `DEPLOY AGAIN`.
- [ ] Preserve parties between runs without requiring the same opponents.
- [ ] Keep an early-finishing party member with the active party unless they
      deliberately leave to queue alone.
- [ ] Hand a disconnected bot to AI after the reconnect grace period and keep
      it AI-controlled through the run.
- [ ] Drain old arenas safely between runs.
- [ ] Define warm-capacity and scale-to-zero policy consistent with the desired
      wait time.
- [ ] Prove a no-other-humans run, a mixed human/AI run, a friends-in-one-party
      run, and consecutive runs on one connection in production.
- [ ] Remove private-game and room-code language from the normal interface.

Completion means a new player can use `PLAY NOW` from the public site, choose a
guest name, optionally finish onboarding, walk to deployment, and enter a real
run without knowing a URL parameter or room code.

### P0 — Accounts, identity, and persistence

The existing device-token identity is a useful guest foundation, not the final
account experience.

- [ ] Let a guest choose a display name and play immediately.
- [ ] After the first run, offer a prominent non-blocking `SAVE YOUR PROGRESS`
      account step; make clear that unlinked progress is device-bound and
      cannot be safely recovered elsewhere.
- [ ] Use a dedicated Firebase Identity Platform tenant as the external
      identity provider for passwordless email link and phone/SMS-code access;
      enforce its tenant ID and email-link-only configuration server-side while Cloud
      SQL/Postgres remains the game-progress authority.
- [ ] Merge the provisional guest identity and all progress into the linked
      account rather than creating a second game profile.
- [ ] Support the same linked account and progress across web, iOS, Android,
      and multiple devices, while all supported devices remain cross-play
      compatible.
- [ ] Keep changeable, non-unique display names backed by an immutable internal
      player ID.
- [ ] Generate a short, friendly, case-insensitive public player ID for friend
      discovery without exposing the internal UUID.
- [ ] Add durable friends and party invites for linked accounts; guests may
      still accept invite links and play.
- [ ] Do not require or design around a progression wipe for initial release.
- [ ] Confirm Cloud SQL migrations, backups, restore procedure, retention, and
      production monitoring.
- [ ] Verify identity recovery and reconnect across browser refresh, network
      handoff, server recycle, and arena recycle.
- [ ] Verify extraction settlement, carried loss, Blueprint learning,
      Contracts, Level, base layout, equipment, settings, and customization
      all round-trip through production persistence.
- [ ] Give players clear storage-linked, offline, reconnecting, and failed-save
      states without blocking safe local play.
- [ ] Define account deletion, display-name changes, abuse controls, and the
      minimum operational/admin tooling required for launch.

**Current state:** foundation exists; product and operations pass required.
Postgres/Cloud SQL persistence, device-token registration, profiles, extraction
transactions, stash, learned Blueprints, base layouts, loadouts, upgrades, and
Contracts already have server paths. Do not rebuild these from scratch; audit
and extend them.

Persistence boundary:

- Permanent: account, Level, authored Contract progress, learned Blueprints,
  base layout, trophies, settings, customization, friends, and saved loadout
  definitions.
- Stored but at risk when equipped or carried into a run: Power Dots, rare
  Cores, applicable Plate gear, and other physical equipment.
- Run-only: recruited fourth squad members, temporary effects, placed mines,
  and generated AI objective state.

### P0 — New-player story, tutorial, and base redesign

- [ ] Write the brief premise in plain language: what DotBots recover, why they
      enter, why extraction matters, and what the base represents.
- [ ] Expand the connected practice room to teach parry, body search, pickup,
      and item use.
- [ ] Offer the tutorial before first deployment but provide a clear skip
      action, including for guests.
- [ ] Make the practice room repeatable after onboarding.
- [ ] Add safe defeat-and-return behavior for practice.
- [ ] Redesign the base as a purposeful operational space.
- [ ] Make the base show extracted equipment and long-term achievements.
- [ ] Validate the complete new and returning player paths on desktop and
      mobile, with production persistence and with stateless fallback.

### P1 — Rival player AI and squad behavior

Red AI represents missing human players. It must look like it is playing the
same extraction game, not like ambient wildlife.

- [ ] Mark AI-controlled player roles with a small, consistent `AI` badge next
      to their names for allies and rivals; do not pretend they are human.
- [ ] Keep player-role AI under the ordinary red relationship treatment when
      hostile.
- [ ] Give each red squad a believable run plan built from current Contract
      locations, desirable loot, insertion, and extraction timing.
- [ ] Feed those plans through the same generic objective format used by
      authored Contracts, without giving AI persistent player progression.
- [ ] Let red AI collect and carry loot throughout the run.
- [ ] Give defeated red players better, legible loot than ambient grey AI.
- [ ] Improve combat ability and teamwork enough that red players are a threat
      players often choose to avoid.
- [ ] Keep AI knowledge honest: no seeing through roofs, buildings, fog,
      concealed spaces, or private player inventory.
- [ ] Make AI react to the final extraction collapse and attempt to leave.
- [ ] Repair route planning, doorway/stair use, stuck recovery, regrouping, and
      long-distance following for both rival AI and friendly AI squadmates.
- [ ] Ensure friendly AI keeps trying to reach the player after separation
      instead of silently giving up.
- [ ] Validate every intended route with a full-size DotBot in the production
      renderer; navigation tests alone are not completion.

**Current state:** foundation exists; major behavior and live-traversal pass
required. AI already has looting, extraction, revive, combat, perception, stair,
and navigation systems, but current player-observed following and pathing are
not acceptable.

### P1 — Squads and social play

The launch rule is:

- squads enter with at most three;
- six squads enter every run, for 18 total player roles;
- friends remain together through public quick play;
- AI fills missing starting places; and
- a squad may reach four only by reviving a pleading player from another squad.

- [ ] Replace lobby squad columns with party formation plus automatic public
      assignment.
- [ ] Cap parties at three and explain that the fourth squad place must be
      earned by picking up a pleading player during the run; never split a
      four-person party silently.
- [ ] Make the party, squad-fill, AI-fill, and reconnect rules clear.
- [ ] Validate cross-squad plea, revive, recruitment, relationship colors,
      pings, spectating, and four-player cap in live multiplayer.
- [ ] Add the minimum friend/invite flow needed to form a party without
      reintroducing private matches.
- [ ] Offer `INVITE TO PARTY` for a recruited player after the run only when the
      existing party has fewer than three members.

**Current state:** foundation exists; integration pass required. Three-player
pregame squads, AI wingmates, global pleas, and recruitment to a four-player
cap exist in simulation/server code. They need to be carried into the public
quick-play flow and proven as one product experience.

### P1 — Contracts, Levels, and compelling progression

Progression should lead players through the city rather than merely pay them
for repeating generic collection tasks.

Direction to design:

- Use a persistent authored Contract series, not a rotating daily-job system,
  as the primary progression spine.
- Contracts introduce districts, buildings, stairs, underground routes,
  hidden passages, strong AI, locked rooms, shortcuts, and rare equipment.
- Contract completion raises Level.
- Level unlocks physical places and options, never hidden combat-stat bonuses.
- Multiple squads should sometimes receive reasons to approach the same place.
- Revisit Contracts should change the objective or route, not simply repeat a
  quantity at the same location.
- Base objects, trophies, equipment, and visibly opened city access should make
  progress tangible.

The content-neutral engine should be built before the authored progression
arc. It must support stable objectives, ordered prerequisites, completion
state, rewards, Level progress, and generalized Interaction Dot requirements.
Daily Contracts are not part of the initial direction.

- [ ] Design the first complete authored Contract line from onboarding through
      the first meaningful Level unlock.
- [ ] Define the Level curve and the city doors/areas it unlocks.
- [ ] Decide Contract failure, abandonment, replay, squad credit, and
      cross-Level squad rules.
- [ ] Replace the current deterministic daily-offer assumption with one or two
      disposable authored Contracts that prove the generic engine.
- [ ] Persist Level and generalized Interaction Dot access requirements now;
      doors are one gated interaction type, not a special progression system.
- [ ] Persist and present Contract/Level progress in the base and run.
- [ ] Build one end-to-end proof: accept in base, travel to a specific authored
      place, complete, extract, receive reward/Level, and see the world/base
      change.

**Current state:** foundation exists; creative redesign required. Map-derived
daily offers, acceptance, extraction-time completion, payouts, and planning
table UI exist, but they conflict with the current authored-progression
direction and do not yet provide the desired exploration arc.

### P1 — Power Dots, inventory, and Blueprints

Run a complete hands-on pass over every Power Dot:

- **Radar:** show a temporary, readable radar view of nearby DotBots beyond
  ordinary line of sight, including through buildings, with clear red rival
  marks. Decide how this combines with the always-available local radar and the
  full map without leaking information outside the authorized radius/time.
- **Incognito:** verify the effect is both mechanically correct and readable to
  the user.
- **Dash overcharge:** replace the current limited-charge behavior with the
  working direction of roughly one minute of no dash cooldown, then tune it.
- **Health/Armour:** reconcile the current health power with the Plate/Armour
  vocabulary and intended equipment model.
- **Mines:** retain only after live multiplayer proves placement, disguise,
  sensor, radar reveal, detonation, counterplay, and persistence are fun and
  understandable.

Blueprint work:

- [ ] Move Blueprint and base-object definitions into a stable versioned
      registry before expanding the catalog.
- [ ] Launch with a deliberately small, useful Blueprint set.
- [ ] Use only a tiny integration catalog initially, beginning with storage and
      locker-related base objects; select the real catalog later.
- [ ] Hand-author Blueprint placement beside objects that make semantic and
      spatial sense; do not scatter or generate them merely to cover every
      scannable kind.
- [ ] Make Blueprint discovery, carried risk, extraction, learning threshold,
      fabrication, and placement one readable loop.
- [ ] Verify extracted items and Blueprint-built objects actually appear and
      persist in the base.
- [ ] Give rare Blueprint or trophy objects visible meaning in the base.

**Current state:** foundation exists; curation and product QA required. Typed
items, bays/reserve, radar marks, incognito noise suppression, dash charges,
mines, Blueprint fragments, learning, fabrication, and extraction persistence
exist. Their presence in code is not evidence that each power or the complete
loop feels right.

### P1 — Cores, Plate types, loadouts, and player customization

There is no separate Plate Carrier equipment category. The equipment model is:

- **Core:** a rare, lootable, losable item that can change movement, Plate
  count, and other strongly readable game dynamics.
- **Plate type:** one equipped behavior family applied across the Core's active
  Plates. Plate types do not need to change relationship color, but their line
  or surface treatment should remain visually distinguishable.
- **Default equipment:** the standard black Core and ordinary Plates are always
  available and viable after rare equipment is lost.

Initial Plate-type directions to scaffold, with exact balance deferred:

- **Stealth Plates:** prevent radar detection and suppress noise markers.
- **Tech Plates:** shorten revive and body-loot interactions.
- **Blast Plates:** protect against mine damage.

- [ ] Implement a generic, versioned Core and Plate-type registry before
      choosing the complete equipment catalog.
- [ ] Support extraction, storage, equip, loadout, loot, loss, ownership
      history, and return to defaults for rare Cores and applicable Plate gear.
- [ ] Allow loadout preparation to select carried Dots, Core, and Plate type
      before every deployment.
- [ ] Support saved default loadout settings later without automatically
      risking equipment the player no longer owns.
- [ ] Start Core content with a small set of strongly readable tradeoffs,
      including lighter/faster/fewer-Plates and heavier/slower/more-Plates
      directions.
- [ ] Ensure every advantage has a visible weakness or counter; avoid hidden
      percentage progression.
- [ ] Pass Core and Plate visual-language decisions to Claude Design before
      final rendering implementation.
- [ ] Add player-facing DotBot appearance, base, and HUD customization with
      persistence and readability constraints.

**Current state:** direction to design. Renderer/HUD style explorations and the
equipment vocabulary exist, but rare physical Cores, Plate types, and their
complete loadout/persistence loop are not built as a launch system.

### P1 — Extraction pressure and map economy

- [ ] Reduce extraction points to a deliberate count based on city scale and
      travel routes.
- [ ] Design the normal-run extraction availability.
- [ ] Close all but one point during the final phase with unmistakable world
      and UI communication.
- [ ] Route red AI toward the surviving point.
- [ ] Make the last route tense but not a single unavoidable spawn-camp choke.
- [ ] Decide what happens to a player already channeling when closure begins.
- [ ] Tune closure timing, noise, map/radar information, and extraction channel
      duration through full multiplayer playtests.

### Parallel launch work — Marketing site and Claude Design handoff

Public routing:

- `/` is the marketing site.
- `/play` is account, base, and game.
- Development-only solo, Studio, and laboratory surfaces remain outside the
  public product flow.

The site positions DotBot as a light, accessible extraction brawler. Extraction
games may be used as internal design references, but public copy should stand
on DotBot's own identity rather than naming another title.

Required first version:

- `PLAY NOW` as the primary action;
- `CREATE ACCOUNT` and `LOG IN` without making account creation a play gate;
- a concise introduction and plain-language `HOW IT WORKS`;
- gameplay information covering squads, bashing/parrying, looting, extraction,
  the base, and persistent progress without promising unfinished content;
- responsive desktop and mobile treatment;
- optional X link when the account exists; and
- a simple contact/feedback path.

Do not add pricing copy, a waitlist, mailing list, Discord, trailer, press kit,
or public roadmap to the initial site.

Claude Design owns the visual concept and may return complete HTML. The handoff
must include:

- strong current production-renderer screenshots of the world, DotBots,
  combat, map, and glass UI;
- no unfinished-base screenshot as a visual target;
- clear labels separating current product truth from future direction;
- the no-raster-assets rule for the game world (marketing may use captured game
  media); and
- a request for production-ready responsive HTML that Codex can integrate with
  routing, Firebase Auth, the game client, accessibility, and performance
  requirements.

- [ ] Capture and curate the screenshot set from representative live game
      sessions.
- [ ] Prepare the Claude Design brief and exact page-content requirements.
- [ ] Receive the design/HTML, then integrate it without allowing marketing
      styles to fork the in-game visual system accidentally.
- [ ] Verify routing, account actions, responsive behavior, accessibility,
      loading performance, and `PLAY NOW` to guest-name to `/play` flow.

### P2 — Flagship city and world traversal

The current four-building Downtown is a prototype and regression map, not the
finished city.

The flagship city needs:

- a much larger, denser downtown with buildings close enough to form streets
  and blocks rather than isolated boxes;
- a hierarchy of tight streets, larger open spaces, interiors, roofs, and
  underground routes;
- far fewer insertion and extraction points relative to its size;
- memorable districts and destinations that support authored Contracts;
- hidden passages, grey Interaction Dots, locked doors, shortcuts, and
  discoverable alternate routes;
- moving traversal infrastructure such as a train where it adds real route
  choice;
- rivers, sewers, currents, and water routes where the movement and visibility
  rules are deliberately designed; and
- believable object density, adjacency, clearance, collision, navigation, and
  AI use under the production drawing language.

Water direction to prototype:

- entering water changes movement and visibility clearly;
- current can carry the DotBot through parts of the city;
- dash and combat are unavailable in water;
- water can be a lower-conflict traversal route without becoming perfectly
  safe; and
- selected retrieval/Contract objectives can make water worth entering.

Do not build the flagship city by enlarging a grid or cloning prototype blocks.
Plan every district and floor in plain language, author it in production map
source, review overlays-off first, and then prove collision and full-size
traversal under the map-building contract.

### P2 — World, UI, and feel polish

- [ ] Replace the generic map-button feel with a useful local radar that fits
      the world-map privacy rules.
- [ ] Make ordinary radar, Power Dot radar, noise, squad pings, and the full map
      distinct and immediately understandable.
- [ ] Finish base, run, manifest, spectate, replay, reconnect, and deployment UI
      as one consistent product.
- [ ] Complete audio, haptics, settings, accessibility, safe-area, browser
      resume, and reduced-motion passes.
- [ ] Tune combat, parry, looting, inventory, extraction, and movement from
      visible multiplayer playtests rather than automated tests alone.
- [ ] Establish launch analytics for queue wait, AI fill rate, run completion,
      extraction, disconnects, Contract progress, deaths, and return-to-deploy.

## Decisions already clear

- One public extraction mode at launch.
- Six squads of three enter every run; AI fills every empty player role.
- Public assembly lasts at least one and at most six visible seconds, with no
  launch skill matching.
- Premade parties are capped at three and persist between runs.
- The `/play` route starts at the base; the base deploys into the real game.
- No solo URL knowledge is required for normal play.
- No private matches or room codes in the ordinary flow.
- Human players join only between runs.
- Friends stay together.
- Squads insert with three and may recruit to four during the run.
- AI player roles are visibly labelled `AI`, retain relationship styling, use
  player-like objectives, and carry better loot than ambient AI.
- The game must be fun at zero population.
- Guests choose a name and play immediately; account linking is a non-blocking
  post-run durability step.
- Linked accounts work across devices and supported platforms, with durable
  friends found through short public player IDs.
- No initial-release progression wipes.
- The base is the visible record of progression.
- Loadout preparation covers carried Dots, Core, and Plate type between runs.
- Progression should encourage exploration and unlock places, not grant hidden
  combat percentages.
- Authored Contract, Level, generalized Interaction Dot, objective, and
  registry scaffolding is built before final content authoring; daily Contracts
  are deferred.
- Rare Cores affect movement and Plate count; Plate types provide readable
  utility behavior; there is no separate Plate Carrier item.
- The city needs few meaningful extraction points and a converging finale.
- The flagship city is much larger and denser than the current prototype.
- The marketing site lives at `/`, the game at `/play`, and `PLAY NOW` permits
  immediate guest entry.

## Product decisions still needed

- Launch run length and final-collapse timing after playtesting the configurable
  eight-minute/90-second scaffold.
- Exact party invitation, friend-request, blocking, and abuse-reporting UX.
- The format and collision policy for the short public player ID.
- Whether phone/SMS access ships in the first account increment or immediately
  after passwordless email-link access, given consent, anti-abuse, and
  operating-cost requirements.
- Exact post-run `SAVE YOUR PROGRESS`, loadout, and `DEPLOY AGAIN` flow; visual
  design goes to Claude Design.
- The first authored Contract arc, Level curve, and first locked locations.
- The launch story wording.
- The small initial base-object and Blueprint integration registry.
- Radar versus map responsibilities and information limits.
- Whether Plate types are individually lootable/losable equipment or a
  persistent choice fabricated from learned knowledge.
- Exact Core and Plate-type catalog and balance.
- Flagship-city district scope for the first public release.
- Water combat/safety edge cases and moving-train gameplay rules.

## Closed decisions and non-goals

- The shipped simultaneous-dash parry/clash remains the chosen combat
  counterplay. Reopen it only from a reproduced gameplay defect.
- Do not create standalone roof-peek, Temple-forest, or big-top-spacing tasks
  without a visible failing case.
- The M0–M8, NET-1, PERF-1, and UX-1 reports are historical foundation evidence,
  not active product acceptance and not instructions to rebuild those systems.
- Large source files are not backlog items by size alone. Split them only as
  part of a behavior change with focused tests.
- The solo and Map Studio URL surfaces remain development and verification
  tools; they are not additional launch game modes.

## Release verification gates

The game is not launch-ready until all of the following are demonstrated on the
public production path:

- A brand-new player completes or deliberately skips the offered tutorial and
  enters the base.
- A returning player resumes the correct account, base, inventory, Contract,
  Level, equipment, and settings state.
- Marketing `PLAY NOW` reaches `/play`, and base deployment starts a real game
  with no room code or URL flag.
- No-population quick play starts after the visible six-second deadline with 18
  AI-filled player roles across six squads.
- Friends deploy together, open places fill, and squads remain correct.
- A full run persists extraction and loss correctly through a server/process
  failure test.
- `DEPLOY AGAIN` completes consecutive runs on the hot-arena path.
- Final extraction closure works with humans and AI.
- Red and friendly AI traverse the actual city, doors, stairs, hidden routes,
  and extraction routes without unacceptable stalls.
- Every Power Dot and launch Blueprint passes visible end-to-end validation.
- Base customization and progression remain correct after refresh/reconnect.
- One 18-client GameLift room, followed by the intended simultaneous 18-player
  room density, maintains required tick, network, reconnect, and memory
  headroom.
- Current desktop browsers, iPhone Safari, Android Chrome, and the selected
  older-device floor all pass the same core loop.
- World changes pass overlays-off review, collision/navigation audits, and
  full-size production-renderer traversal.

### Existing full-world traversal proof still owed

Complete one post-fix production-renderer traversal at normal speed:

- Downtown to Main Street gate to works road to turntable extraction pad.
- Downtown to Third Avenue gate to fair drive to midway.
- Midway to east trail to Temple plaza.
- Yard to spur gate to end of the line.
- Enter and leave the roundhouse, box, pavilion, Temple, and observatory; take
  both directions of every stair transition.

Automated map audits already pass. This remains a release verification gate,
not a request for speculative map changes. Record a dated result and open new
work only for defects actually observed.

## How to maintain this document

- Add new owner observations here before treating them as scheduled work.
- Separate a desired player outcome from a proposed implementation.
- When code lands, move the item to **foundation exists; product pass required**
  until production behavior is visibly proven.
- Mark work complete only with the applicable automated, production,
  multiplayer, persistence, mobile, and map-contract evidence.
- Keep historical milestone briefs historical; do not use their old completion
  labels as substitutes for current product acceptance.
