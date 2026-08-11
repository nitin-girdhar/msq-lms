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

// Same gate, satisfied by ANY ONE of several keys.
//
// For a read that legitimately hangs off two different pages. The Lead History
// dialog is the case this exists for: it is opened from a history row, but the
// three reads behind it (lead, timeline, form submission) sit under the LEADS
// page in the capability tree. A role that holds Leads History but not Leads —
// org_admin and tenant_admin, since the 2026-08-07 'lms.leads' deny — then hits
// a 403 on a screen it is entitled to. Accepting lms.history.detail.view as an
// alternative lets the history page carry its own permission.
//
// Still fails closed: with no key granted, nobody gets through. And it widens
// only the GATE — which rows come back is RLS's answer, unchanged by this.
export function requireAnyCapability(keys: readonly CapabilityKey[], message?: string) {
  return async function anyCapabilityGate(request: FastifyRequest): Promise<void> {
    if (!keys.some((key) => can(request.auth, key))) {
      throw new ForbiddenError(message ?? 'You do not have permission to do that');
    }
  };
}
