# syntax=docker/dockerfile:1
FROM node:22.21.1-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.21.1-alpine3.22
ENV NODE_ENV=production
WORKDIR /app
# Runs as the image's unprivileged `node` user (uid 1000).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/ready >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
