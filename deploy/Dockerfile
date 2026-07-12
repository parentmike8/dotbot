FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY apps/server/dist ./apps/server/dist
COPY apps/client/dist ./apps/client/dist

EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
