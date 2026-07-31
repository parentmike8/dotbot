# DotBot

DotBot is a browser-based, server-authoritative squad extraction game. The
repository contains the deterministic game simulation, Pixi client, realtime
server, production map source, deployment tooling, and the historical design
and implementation record.

## Quick start

Use pnpm 9.15. Node 24.18 matches the production images; Node 20 remains
compatible for local development today.

```bash
pnpm install
pnpm dev          # solo client at http://localhost:5173/?solo
pnpm dev:all      # client plus realtime server
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm build:all
```

For production-parity local testing, database setup, and cloud deployment, see
[`deploy/README.md`](deploy/README.md).

## Repository map

- `packages/game` — deterministic simulation, AI, map model, and production
  world content.
- `packages/protocol` — client/server wire types and snapshot filtering.
- `apps/client` — React, Pixi renderer, input, prediction, and game UI.
- `apps/server` — authoritative rooms, persistence, matchmaking, and hosting.
- `docs` — current engineering contracts plus historical design records. Start
  with [`docs/README.md`](docs/README.md).
- `handoffs` — milestone briefs and completion reports retained as an audit
  trail; they are not the active backlog.

## Current status

The original M0–M8 implementation roadmap is complete. The remaining release
verification list lives in [`docs/backlog.md`](docs/backlog.md).
For map or world changes, [`docs/map-building-contract.md`](docs/map-building-contract.md)
is the definition of done.
