import { z } from 'zod';
import { UNASSIGNED_ASSIGNEE } from '@lms/authz';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// These params are comma-separated UUID lists that reach the repository's
// `::uuid` casts unvalidated. Without this refine any junk token surfaces as a
// Postgres "invalid input syntax for type uuid" — a 500 for what is really a bad
// request. Belt-and-braces: the service also strips unknown tokens.
const csvOfUuids = z.string().refine(
  (s) => s.split(',').filter(Boolean).every((t) => UUID_RE.test(t)),
  { message: 'must be a comma-separated list of UUIDs' },
);

// Same, but additionally allows the "unassigned" sentinel. The sentinel is the
// one intentionally non-UUID token in `assigned_to`; the service decides whether
// the caller is permitted to act on it.
const csvOfUuidsOrUnassigned = z.string().refine(
  (s) => s.split(',').filter(Boolean).every((t) => t === UNASSIGNED_ASSIGNEE || UUID_RE.test(t)),
  { message: `must be a comma-separated list of user UUIDs and/or "${UNASSIGNED_ASSIGNEE}"` },
);

export const listAssignmentsQuerySchema = z.object({
  page:        z.coerce.number().int().positive().default(1),
  page_size:   z.coerce.number().int().positive().max(5000).default(5000),
});

export const leadsHistoryQuerySchema = z.object({
  page:        z.coerce.number().int().positive().default(1),
  page_size:   z.coerce.number().int().positive().max(100).default(25),
  date_from:   z.string().optional(),
  date_to:     z.string().optional(),
  stage_ids:   csvOfUuids.optional(),
  outcome_ids: csvOfUuids.optional(),
  source_ids:  csvOfUuids.optional(),
  org_ids:     csvOfUuids.optional(),
  assigned_to: csvOfUuidsOrUnassigned.optional(),
  // Not z.coerce.boolean(): Boolean("false") is true in JS, so coercion would
  // treat the literal string "false" (what a false value serializes to) as
  // true, silently re-enabling the active-only filter.
  active_only: z.enum(['true', 'false']).optional().default('false').transform((v) => v === 'true'),
  // Whitelisted so ORDER BY is never built from a client-supplied string.
  sort_by:     z.enum(['created_at', 'assignee', 'stage', 'branch']).optional(),
  sort_dir:    z.enum(['asc', 'desc']).optional(),
});

export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;
export type LeadsHistoryQuery = z.infer<typeof leadsHistoryQuerySchema>;
