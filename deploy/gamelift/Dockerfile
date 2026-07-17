FROM golang:1.24-bookworm AS adapter-build
WORKDIR /adapter
COPY apps/gamelift-adapter/go.mod apps/gamelift-adapter/go.sum ./
RUN go mod download
COPY apps/gamelift-adapter/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/gamelift-adapter .

FROM node:20-slim AS game-build
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
ENV NODE_ENV=production \
    PORT=8080 \
    GAME_PORT=8080 \
    GAME_HEALTH_URL=http://127.0.0.1:8080/api/health \
    GAMELIFT_ADAPTER_PORT=8090
WORKDIR /repo
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 dotbot
COPY --from=game-build /repo/apps/server/dist apps/server/dist
COPY --from=game-build /repo/apps/client/dist apps/client/dist
COPY --from=adapter-build /out/gamelift-adapter /usr/local/bin/gamelift-adapter
COPY deploy/gamelift/entrypoint.sh /usr/local/bin/dotbot-gamelift-entrypoint
RUN chmod 0555 /usr/local/bin/gamelift-adapter /usr/local/bin/dotbot-gamelift-entrypoint \
    && chown -R dotbot:dotbot /repo
USER dotbot
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dotbot-gamelift-entrypoint"]
