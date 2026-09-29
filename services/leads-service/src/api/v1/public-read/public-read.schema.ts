import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A catalog uuid, or a machine key (lms.lead_sources/lead_stage/
// lead_stage_outcome.name). Every uuid also matches the key shape, which is
// fine: the repository splits them with UUID_RE and matches each on its column.
const ID_OR_KEY_RE = /^[a-z0-9_:.-]{1,64}$/i;

// Comma-separated list -> trimmed, de-duplicated tokens. Malformed tokens are
// a 422, never dropped: dropping one would widen the filter to "everything".
const csvOf = (re: RegExp, message: string) =>
  z.string()
    .transform((s) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))])
    .refine((arr) => arr.length <= 100 && arr.every((t) => re.test(t)), { message });

const csvOfUuids = csvOf(UUID_RE, 'must be a comma-separated list of UUIDs (max 100)');
// source/stage/outcome take either the catalog uuid or its machine name.
const csvOfIdsOrKeys = csvOf(ID_OR_KEY_RE, 'must be a comma-separated list of ids or names (max 100)');

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// A calendar date (YYYY-MM-DD, read in each lead's branch timezone) or a full
// ISO-8601 timestamp with offset.
const dateOrDateTime = z.string().refine(
  (s) => DATE_RE.test(s) || z.string().datetime({ offset: true }).safeParse(s).success,
  { message: 'must be YYYY-MM-DD or an ISO-8601 timestamp with offset' },
);

export const listLeadsQuerySchema = z.object({
  branch_id:        csvOfUuids.optional(),
  assigned_to:      csvOfUuids.optional(),
  start_date:       dateOrDateTime.optional(),
  end_date:         dateOrDateTime.optional(),
  source:           csvOfIdsOrKeys.optional(),
  stage:            csvOfIdsOrKeys.optional(),
  outcome:          csvOfIdsOrKeys.optional(),
  include_inactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit:            z.coerce.number().int().min(1).max(500).default(100),
  offset:           z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

// Phone input may carry +, spaces, dashes, brackets; it is reduced to digits
// and matched on the last 10 (the same key the dedupe path uses).
const phoneInput = z.string().trim().max(32).refine(
  (s) => { const d = s.replace(/\D/g, ''); return d.length >= 10 && d.length <= 15; },
  { message: 'phone must contain 10-15 digits' },
);

export const findLeadsBodySchema = z.object({
  phones:           z.array(phoneInput).max(100).default([]),
  emails:           z.array(z.string().trim().email().max(254)).max(100).default([]),
  branch_id:        z.array(z.string().regex(UUID_RE, 'branch_id must be UUIDs')).max(100).optional(),
  include_inactive: z.boolean().default(false),
}).refine((b) => b.phones.length + b.emails.length > 0, { message: 'provide at least one phone or email' })
  .refine((b) => b.phones.length + b.emails.length <= 100, { message: 'at most 100 phones and emails combined' });
export type FindLeadsBody = z.infer<typeof findLeadsBodySchema>;
