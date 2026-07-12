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
