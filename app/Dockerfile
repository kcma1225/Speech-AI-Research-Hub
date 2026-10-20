FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg su-exec && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs && mkdir -p /data/slides/jobs /data/slides/projects && chown -R nextjs:nodejs /data/slides
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/slide-assets ./slide-assets
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
