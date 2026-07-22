import type { FastifyRequest } from 'fastify';
import { can, type CapabilityKey } from '@platform/rbac';
import { ForbiddenError } from '../lib/errors.js';

// Tier C3 — the route-level capability gate for LMS.
//
// Declared on the route rather than inside the handler so the rule is visible in
// the router, next to the path it protects: one line per route, and a reviewer
// can read the whole service's access policy without opening a controller.
//
// request.auth.capabilities is filled by `authenticate` from the DB matrix — the
// same list the browser gets on /auth/me, which is what keeps a rendered control
// and the call behind it from disagreeing.
//
// Fails CLOSED. A key with no grant row denies everyone, so adding a capability
// to code before seeding it locks the feature rather than opening it.
export function requireCapability(key: CapabilityKey, message?: string) {
  return async function capabilityGate(request: FastifyRequest): Promise<void> {
    if (!can(request.auth, key)) {
      throw new ForbiddenError(message ?? 'You do not have permission to do that');
    }
  };
}
