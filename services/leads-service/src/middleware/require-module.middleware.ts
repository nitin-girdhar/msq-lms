import type { FastifyRequest } from 'fastify';
import { getActiveTenantModules } from '@platform/db';
import { ForbiddenError } from '../lib/errors.js';

export type PlatformModule = 'lms' | 'leave' | 'attendance' | 'tasks';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { modules: Set<string>; expiresAt: number }>();

async function resolveActiveModules(request: FastifyRequest): Promise<Set<string>> {
  const { tenant_id, org_id, role, user_id } = request.auth;
  const cacheKey = tenant_id || org_id;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.modules;

  const modules = new Set(await getActiveTenantModules({ role, org_id, tenant_id, user_id }));
  cache.set(cacheKey, { modules, expiresAt: now + CACHE_TTL_MS });
  return modules;
}

// Rejects requests to a module the tenant hasn't licensed (entity.tenant_modules).
// Defense-in-depth: the gateway also gates the LMS routes centrally, but leads-
// service enforces its own 'lms' entitlement so a call that bypasses the gateway
// is still rejected. Mirrors hr-service / tasks-service requireModule; the shared
// getActiveTenantModules helper lives in @platform/db and reads via RLS for the caller.
export function requireModule(module: PlatformModule) {
  return async (request: FastifyRequest): Promise<void> => {
    const modules = await resolveActiveModules(request);
    if (!modules.has(module)) {
      throw new ForbiddenError('MODULE_NOT_ENABLED');
    }
  };
}
