# syntax=docker/dockerfile:1
# Worker: Quarto (slide render) + headless Chrome (PDF) + ffmpeg (media) + Node job runner.
# Quarto upstream image is amd64-only; compose sets platform: linux/amd64.

FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.3-bookworm-slim AS node

FROM ghcr.io/quarto-dev/quarto:1.10.19
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 ffmpeg fontconfig libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 libx11-xcb1 \
      libgbm1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*
# Pinned, checksum-verified browser + offline math/fonts (downloaded at build time only).
COPY scripts/build-assets.py /usr/local/bin/build-assets.py
RUN python3 /usr/local/bin/build-assets.py && chmod -R a+rX /opt/chrome /opt/slide-assets \
    && chmod 0555 /opt/chrome/chrome-headless-shell && rm /usr/local/bin/build-assets.py
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/prepare-pdf.py ./scripts/prepare-pdf.py
COPY assets ./assets
RUN chmod -R a+rX /app && node --version && ffmpeg -version > /dev/null && quarto --version
# Root filesystem is read-only at runtime; Quarto/Deno/Chrome caches and job scratch go to tmpfs /tmp.
ENV NODE_ENV=production HOME=/tmp XDG_CACHE_HOME=/tmp/.cache XDG_DATA_HOME=/tmp/.local/share \
    XDG_CONFIG_HOME=/tmp/.config DENO_DIR=/tmp/.deno WORK_DIR=/tmp/jobs
USER 1001:1001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/dist/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "/app/dist/main.js"]
