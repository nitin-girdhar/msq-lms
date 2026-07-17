FROM node:20-alpine AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/auth-constants/package.json packages/auth-constants/
COPY packages/permissions/package.json packages/permissions/
COPY packages/db/package.json packages/db/
COPY packages/validation/package.json packages/validation/
COPY packages/audit-log/package.json packages/audit-log/
COPY packages/service-auth/package.json packages/service-auth/
COPY services/leads-service/package.json services/leads-service/
RUN echo "shamefully-hoist=true" > .npmrc
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY services/leads-service/ services/leads-service/
RUN pnpm --filter @crm/auth-constants build
RUN pnpm --filter @crm/types build
RUN pnpm --filter @crm/permissions build
RUN pnpm --filter @crm/db build
RUN pnpm --filter @crm/validation build
RUN pnpm --filter @crm/audit-log build
RUN pnpm --filter @crm/service-auth build
RUN pnpm --filter @crm/leads-service build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/auth-constants/dist ./packages/auth-constants/dist
COPY --from=builder /app/packages/permissions/dist ./packages/permissions/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/validation/dist ./packages/validation/dist
COPY --from=builder /app/packages/audit-log/dist ./packages/audit-log/dist
COPY --from=builder /app/packages/service-auth/dist ./packages/service-auth/dist
COPY --from=builder /app/services/leads-service/dist ./services/leads-service/dist
COPY packages/types/package.json ./packages/types/
COPY packages/auth-constants/package.json ./packages/auth-constants/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/db/package.json ./packages/db/
COPY packages/validation/package.json ./packages/validation/
COPY packages/audit-log/package.json ./packages/audit-log/
COPY packages/service-auth/package.json ./packages/service-auth/
COPY services/leads-service/package.json ./services/leads-service/
EXPOSE 4002
CMD ["node", "services/leads-service/dist/server.js"]
