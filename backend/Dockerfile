# syntax=docker/dockerfile:1
FROM node:22.21.1-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Document import (src/lib/doc-import): onnxruntime-web runs Magika on its single-threaded WASM backend in Node, which
# needs only the Node bundle + the SIMD WASM; drop the other ~100 MB of builds and sources.
RUN cd node_modules/onnxruntime-web \
  && find dist -type f ! -name ort.node.min.mjs ! -name ort-wasm-simd-threaded.mjs ! -name ort-wasm-simd-threaded.wasm -delete \
  && rm -rf lib docs \
  && rm -rf ../@mixmark-io/domino/test
# pdf.js (text extraction only) loads the optional @napi-rs/canvas when present; its prebuilt binary needs AVX and
# kills the process with SIGILL on the production CPU (Xeon X5650). Without it pdf.js just warns and extracts text.
RUN rm -rf node_modules/@napi-rs

FROM node:22.21.1-alpine3.22
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg: ASR chunking in ai-worker (same image). claude CLI: the experimental `claude-cli` provider.
# poppler-utils: `pdftoppm` renders paper pages for vision models (agent view_paper_pages; baseline x86-64, no AVX).
RUN apk add --no-cache ffmpeg poppler-utils && npm install -g @anthropic-ai/claude-code@2.1.304 && npm cache clean --force
# Runs as the image's unprivileged `node` user (uid 1000).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
# Magika content-type model (doc-import), resolved from dist/ as /app/assets.
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/ready >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
