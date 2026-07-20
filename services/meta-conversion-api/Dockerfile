# Self-contained image built from a `pnpm deploy` output.
# See docs/Platform_Architecture_Decisions.md (D5) and scripts/docker-ship.sh /
# scripts/docker-load.md for how to ship and run this image.
# Build from the repo root: `docker build -f services/meta-conversion-api/Dockerfile .`
FROM node:20-alpine AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /repo

FROM base AS builder
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crm/meta-conversion-api... build
RUN pnpm --filter @crm/meta-conversion-api deploy --prod /app

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app
EXPOSE 4003
CMD ["node", "dist/server.js"]
