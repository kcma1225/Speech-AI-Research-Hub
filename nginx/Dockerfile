# syntax=docker/dockerfile:1
# Build context: ./nginx, with the SvelteKit app passed as the named context `frontend` (see compose.yaml).
FROM node:22.21.1-alpine3.22 AS spa
WORKDIR /src
COPY --from=frontend package.json package-lock.json ./
RUN npm ci
COPY --from=frontend . .
RUN npm run build
# The SPA fallback page bootstraps with an inline <script>; hash it for the CSP instead of allowing 'unsafe-inline'.
COPY csp-hashes.mjs /tmp/csp-hashes.mjs
RUN node /tmp/csp-hashes.mjs build/index.html > /src/script-hashes

FROM nginx:1.27.5-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY templates/ /etc/nginx/hub-templates/
COPY snippets/ /etc/nginx/snippets/
COPY entrypoint.sh /usr/local/bin/hub-nginx-entrypoint
COPY --from=spa /src/build /usr/share/nginx/html
COPY --from=spa /src/script-hashes /etc/nginx/script-hashes
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/nginx-health >/dev/null || exit 1
ENTRYPOINT ["/bin/sh", "/usr/local/bin/hub-nginx-entrypoint"]
