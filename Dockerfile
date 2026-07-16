# Build the whole monorepo, ship only the two build outputs. The server
# bundle is self-contained (esbuild, rapier2d-compat embeds its WASM), and in
# production it also serves the client from ../../client/dist — so the image
# preserves the apps/server/dist + apps/client/dist relative layout.
FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/game/package.json packages/game/
COPY packages/protocol/package.json packages/protocol/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:all

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/client/dist apps/client/dist
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
