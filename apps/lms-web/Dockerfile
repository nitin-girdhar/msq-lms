# Self-contained image built from a `pnpm deploy` output.
# See docs/Platform_Architecture_Decisions.md (D5) and scripts/docker-ship.sh /
# scripts/docker-load.md for how to ship and run this image.
# Build from the repo root: `docker build -f apps/lms-web/Dockerfile .`
FROM node:22-alpine AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /repo

FROM base AS builder
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG API_GATEWAY_INTERNAL_URL=http://api-gateway:4000
ENV API_GATEWAY_INTERNAL_URL=$API_GATEWAY_INTERNAL_URL
ARG NEXT_PUBLIC_PASSWORD_MIN_LENGTH=12
ENV NEXT_PUBLIC_PASSWORD_MIN_LENGTH=$NEXT_PUBLIC_PASSWORD_MIN_LENGTH
# SSO origins baked into the client bundle (NEXT_PUBLIC_*) at build time — drive
# the product switcher and the auth-origin redirect.
# SSO base URLs baked into the client bundle (NEXT_PUBLIC_*) at build time.
# LEGACY FALLBACK ONLY: sso.ts prefers the UNPREFIXED runtime names (AUTH_URL,
# LMS_URL, ...) precisely so an image can be repointed without a rebuild — a
# real deployment sets those in .env and never relies on these defaults.
# They are the single-origin dev values (host + this app's path prefix), so a
# build with no --build-arg is at least self-consistent rather than pointing at
# a per-port topology that no longer exists.
ARG NEXT_PUBLIC_AUTH_URL=http://app.localhost
ENV NEXT_PUBLIC_AUTH_URL=$NEXT_PUBLIC_AUTH_URL
ARG NEXT_PUBLIC_LMS_URL=http://app.localhost/lms
ENV NEXT_PUBLIC_LMS_URL=$NEXT_PUBLIC_LMS_URL
ARG NEXT_PUBLIC_HR_URL=http://app.localhost/hrms
ENV NEXT_PUBLIC_HR_URL=$NEXT_PUBLIC_HR_URL
ARG NEXT_PUBLIC_TASK_URL=http://app.localhost/todo
ENV NEXT_PUBLIC_TASK_URL=$NEXT_PUBLIC_TASK_URL
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lms/web-app... build
RUN pnpm --filter @lms/web-app deploy --prod /app

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app
EXPOSE 3001
CMD ["node_modules/.bin/next", "start", "--port", "3001"]
