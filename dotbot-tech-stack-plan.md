# DotBot - Tech Stack Plan

Reviewed: 2026-06-16

## Recommendation

Build DotBot web-first with a TypeScript monorepo:

- `PixiJS` for rendering.
- `Rapier 2D` for physics/collision.
- `Colyseus` for authoritative multiplayer rooms.
- `LiveKit` for voice chat.
- `Postgres` for persistent player/base/map data.
- `Capacitor` later for iOS/Android wrappers.

The key architectural rule: the game simulation must not live inside React UI components. React can own menus, Base screens, settings, account flows, and overlays. The active Map should be a canvas-based game view driven by a fixed-step simulation.

## Why This Fits DotBot

DotBot is visually simple but mechanically sensitive:

- Dot Bots must collide cleanly.
- Dot Bots must not pass through walls.
- Dots must be captured by coverage.
- Downed Dot Bots must be overlappable.
- Scans and extraction channels must be interruptible.
- Multiplayer fights need fair server authority.

This points to a lightweight custom 2D game stack, not a full 3D engine.

## Client

### App Shell

Use:

- `Vite`
- `React`
- `TypeScript`
- `pnpm` workspace

React owns:

- Home/Base UI.
- Choose your Dot Bot.
- Inventory/Home Inventory.
- Settings.
- Voice controls.
- Matchmaking/lobby screens.
- Map editor panels.

React should not own:

- Per-frame Dot Bot movement.
- Collision.
- Physics.
- Canvas rendering.

### Renderer

Use `PixiJS`.

Why:

- DotBot needs thousands of simple linework and round primitives, high-DPI rendering, mobile performance, and animation.
- PixiJS is a mature 2D renderer with WebGL/WebGPU-oriented rendering options.
- The game art style is mostly primitive geometry, so Pixi can render it with minimal asset overhead.

Rendering responsibilities:

- Black/gray map linework.
- Colored Dot Bots.
- Colored Dots.
- Scan pulses.
- Shield segments.
- Capture/consume progress rings.
- Floor fade transitions.
- Camera transforms.
- Map editor canvas.

Avoid putting every map object into DOM nodes. DOM is fine for labels/menus, but the Map itself should render in Pixi.

### UI Overlay

Use React overlays for:

- Building/floor label.
- Inventory bar.
- Dot power buttons.
- Voice/mute controls.
- Debug HUD.
- Editor side panels.

Keep these overlays sparse so the game still feels like a clean white canvas.

## Physics And Collision

Use `Rapier 2D`.

Rapier should handle:

- Round Dot Bot colliders.
- Static wall colliders.
- Object colliders.
- Door gaps.
- Collision events.
- Sensor zones for Dots, Scans, extraction, stairs, and consume/revive coverage.

Recommended body model:

- Alive Dot Bots: dynamic or kinematic round bodies.
- Downed Dot Bots: sensor/non-solid body, so other Dot Bots can overlap.
- Walls: static segment/cuboid colliders.
- Dots: sensor discs.
- Objects: static colliders plus scan sensor zone.
- Extraction points: sensor zones.
- Stairs: sensor zones with floor transition logic.

Important implementation notes:

- Server runs authoritative physics.
- Client may run local prediction for responsiveness.
- Client renders interpolated server snapshots.
- For exact competitive behavior, treat server results as truth.
- Use fixed tick simulation, not variable delta physics.

Rapier has a deterministic package option, but server authority is still the main fairness tool. Use deterministic simulation tests for replay/debugging, not as a substitute for server authority.

## Multiplayer

Use `Colyseus` first.

Why:

- It is a Node.js multiplayer framework designed for authoritative game servers.
- It gives rooms, matchmaking, and state synchronization without building all room infrastructure from scratch.
- It fits the first versions: squad rooms, Base visits, private tests, and later custom Maps.

Server responsibilities:

- Create/join match rooms.
- Validate player input.
- Run fixed-step simulation.
- Own physics truth.
- Broadcast snapshots/events.
- Apply damage/Shield loss.
- Resolve capture/scan/extraction/consume/revive channels.
- Award extracted Dots and Scans after match.

Client responsibilities:

- Send input, not positions.
- Predict local movement lightly.
- Render interpolated state.
- Display progress bars and feedback.
- Never decide authoritative loot, damage, extraction, or consume results.

Recommended tick model:

- Server simulation: start at 20 Hz or 30 Hz.
- Client render: 60 FPS when available.
- Server sends snapshots at 10-20 Hz depending on feel/bandwidth.
- Client interpolates remote Dot Bots.

Do not use Supabase Realtime/Firebase-style realtime updates for the active game loop. Those are useful for persistence and app data, not fast collision-based PvP.

## Voice Chat

Use `LiveKit`.

Do not build custom WebRTC voice.

Voice architecture:

- Game server creates a LiveKit room token.
- Match room maps to a LiveKit voice room.
- Base visit maps to a LiveKit voice room.
- Client joins voice separately from game WebSocket.
- Game server controls who can join which voice room.

Initial voice scope:

- Squad voice during runs.
- Friend voice in Base visits.
- Mute/deafen controls.

Later:

- Proximity voice.
- Enemy proximity voice.
- Spectator voice.
- Moderation/reporting tools.

Keep voice separate from the game server so game simulation performance is not coupled to audio.

## Persistence

Use Postgres.

Good managed options:

- Supabase Postgres/Auth for fastest product iteration.
- Neon Postgres plus a separate auth provider if we want a thinner DB product.

Store:

- Players.
- Home Inventory.
- Base layout.
- Extracted Scans.
- Object unlock progress.
- Map documents.
- Match results.
- Dot transactions.
- Friend/Base visit permissions.

Avoid storing active match state in Postgres. Active match state lives in the game server room memory and is summarized after extraction/death.

## Cross-Platform Path

### Phase 1: Web

Build the real game as a responsive web app:

- Desktop browser.
- Mobile browser.
- PWA installability later.

This is the fastest place to tune movement, collision, map readability, and multiplayer.

### Phase 2: iOS/Android Via Capacitor

Use Capacitor to wrap the same web app for iOS and Android.

Why:

- DotBot is canvas-heavy and visually simple.
- The app shell is web UI.
- Capacitor lets us keep one web codebase while accessing native platform APIs when needed.

This should work well if:

- Pixi performance is good in mobile WebViews.
- Rapier/WASM behaves well in mobile WebViews.
- LiveKit voice works acceptably in the wrapped app.

### Phase 3: Native Fallback Only If Needed

If Capacitor hits hard limits around WebView performance, background audio, mic permissions, or app store behavior:

- Keep shared packages for simulation, map format, networking protocol, and content.
- Build a native shell later with React Native/Expo or a native game client.
- Keep the authoritative server unchanged.

Do not start native-first unless web performance proves insufficient.

## Monorepo Shape

Recommended initial structure:

```text
apps/
  web/
    src/
      game/
      ui/
      editor/
      voice/
  server/
    src/
      rooms/
      sim/
      persistence/
packages/
  sim/
    physics/
    rules/
    replay/
  protocol/
    messages/
    snapshots/
  maps/
    schema/
    validation/
    collision-builders/
  content/
    dots/
    objects/
    buildings/
  ui/
    components/
```

Package boundaries:

- `packages/sim`: pure game rules where possible.
- `packages/maps`: Map/Base document schemas and validation.
- `packages/protocol`: client/server message types.
- `packages/content`: Dot definitions, object definitions, building type data.
- `apps/web`: rendering and UI.
- `apps/server`: authoritative rooms and persistence.

## Map Editor

Build the Map editor as part of the web app, using the same Pixi canvas layer.

Editor modes:

- Map Editor.
- Base Editor.

Shared capabilities:

- Place wall lines.
- Place objects.
- Place building footprints.
- Create floors.
- Add stairs.
- Add Dot spawn zones.
- Add extraction points.
- Validate reachability.
- Export/import Map JSON.

The editor should output deterministic JSON that can be loaded by:

- Web client.
- Server physics builder.
- Future mobile client.

This is important: the server and client must build the same collision world from the same Map document.

## Testing Strategy

### Simulation Tests

Highest priority.

Test:

- Dot Bot cannot pass through walls.
- Alive Dot Bots cannot overlap.
- Downed Dot Bots can be overlapped.
- Damage removes exactly 1 Shield.
- Invulnerability windows prevent double damage.
- Capture pauses/resets correctly.
- Consume/revive interrupts correctly.
- Extraction interrupts correctly.

### Replay Tests

Record input streams and replay them against the server simulation.

Use this for:

- Collision regressions.
- Balance changes.
- Desync debugging.
- Bug reports.

### Map Validation Tests

Validate:

- Buildings have entrances.
- Floors are reachable.
- Stairs connect valid floors.
- Extraction points are reachable.
- Spawn zones do not overlap walls.
- Doorways are wide enough.

### Browser Tests

Use Playwright for:

- App loads.
- Canvas renders nonblank.
- Mobile viewport controls fit.
- Choose your Dot Bot flow.
- Base/editor routes.

## Performance Rules

- Use a fixed simulation tick.
- Keep React out of the render loop.
- Render the Map with Pixi, not DOM.
- Object-pool Dot Bot/Dot visual nodes.
- Prebuild wall colliders from Map JSON.
- Cull off-screen objects.
- Keep labels sparse.
- Avoid per-frame allocations.
- Use simple vector primitives before image assets.
- Profile mobile browser early.

The simple visual style is a major advantage. The risk is not rendering; it is multiplayer physics correctness and latency.

## Recommended MVP Stack

For the first prototype:

- `pnpm`
- `TypeScript`
- `Vite`
- `React`
- `PixiJS`
- `@dimforge/rapier2d-compat` initially for easier bundling
- Local Colyseus server
- SQLite or local Postgres for persistence only if needed
- No LiveKit integration yet, but reserve the voice module boundary

For the first online test:

- Colyseus deployed on Fly.io/Render/Railway-style Node hosting.
- Supabase or Neon Postgres.
- LiveKit Cloud for voice.
- Web app deployed on Vercel or Cloudflare Pages.

## Alternatives Considered

### Phaser

Phaser is viable, but DotBot does not need a full 2D game framework with scenes, asset pipelines, tilemaps, and built-in arcade patterns. Pixi plus Rapier keeps the stack closer to the actual game: simple rendering, precise custom collision, and custom multiplayer simulation.

### Raw Canvas 2D

Raw Canvas 2D could work for the first prototype. The reason to start with Pixi is high-DPI handling, WebGL/WebGPU rendering, batching, resizing, and a cleaner path to mobile performance.

### Unity / Godot

These are stronger if native mobile becomes the primary target. They are weaker for the current goal: web-first iteration, simple UI, web map editor, and a lightweight canvas-like look.

### Nakama

Nakama is a serious game backend option with realtime multiplayer, storage, matchmaking, leaderboards, and social features. It may become attractive if DotBot grows into a larger live game. For the first prototypes, Colyseus plus Postgres is simpler and easier to control in TypeScript.

## Biggest Risks

### Physics Feel

Dot Bot collisions must feel intentional, not slippery or random.

Mitigation:

- Prototype movement/collision first.
- Tune acceleration, friction, mass, and hit thresholds before building meta systems.

### Multiplayer Latency

PvP consume/revive/collision will feel bad if latency is not hidden well.

Mitigation:

- Server authority.
- Client prediction.
- Snapshot interpolation.
- Generous channel times.
- Clear interruption feedback.

### Mobile WebView Performance

Capacitor is promising, but mobile WebView performance and WebRTC behavior need proof.

Mitigation:

- Test mobile browser early.
- Test Capacitor wrapper before building too much app-specific native functionality.
- Keep simulation/protocol separated so a native client remains possible.

### Scope Creep

Base building, map editor, voice, multiplayer, extraction, and physics are each meaningful systems.

Mitigation:

- First prototype only proves Dot Bot movement, Shields, Dots, walls, capture, downed state, consume/revive.
- Add extraction second.
- Add multiplayer third.
- Add Base/editor after the main mechanics feel good.

## Official References

- PixiJS: https://pixijs.com/
- Rapier JS: https://github.com/dimforge/rapier.js/
- Rapier JS docs: https://rapier.rs/docs/user_guides/javascript/getting_started_js/
- Colyseus: https://docs.colyseus.io/
- LiveKit SDKs: https://docs.livekit.io/intro/basics/connect/
- Capacitor: https://capacitorjs.com/docs
- Supabase: https://supabase.com/docs
- Nakama: https://heroiclabs.com/nakama/
