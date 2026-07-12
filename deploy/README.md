# DotBot Fly.io deploy kit

Run these commands from the repository root with Node 20 and a Fly.io account. Replace `YOUR_UNIQUE_DOTBOT_APP` with the final Fly app name.

```sh
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm build:all
fly auth login
fly launch --no-deploy --name YOUR_UNIQUE_DOTBOT_APP --region yyz --config deploy/fly.toml --dockerfile deploy/Dockerfile
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

For later releases, rebuild and deploy with:

```sh
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm build:all
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```

The image contains only the self-contained server bundle and the built client. The server listens on `PORT` (3001 by default), serves `/api/health`, upgrades `/ws`, and serves the client from the same origin when `NODE_ENV=production`.

## Postgres setup

Local persistence requires Docker Desktop to be running. From the repository root:

```sh
cp .env.example .env
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm db:up
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm db:migrate
/Users/michaelparent/.nvm/versions/node/v20.20.0/bin/pnpm dev:all
```

`pnpm dev:db` performs the Docker startup, migration, and development startup in one command. Without `DATABASE_URL`, or when Postgres cannot be reached, the server logs one warning and continues in stateless mode.

For production, provision and attach managed Fly Postgres before deploying. Replace both placeholders with the final names. These are owner-run commands; they are documented here and were not run during M3 implementation.

```sh
fly postgres create --name YOUR_DOTBOT_DB --region yyz
fly postgres attach YOUR_DOTBOT_DB --app YOUR_UNIQUE_DOTBOT_APP
fly deploy --config deploy/fly.toml --dockerfile deploy/Dockerfile
```
