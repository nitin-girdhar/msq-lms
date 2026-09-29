import { sql } from 'drizzle-orm';
import { withServiceTx, sqlUuidArr, sqlTextArr } from '@platform/db';
import { isUuid } from './public-read.schema.js';

// Public read endpoints run under the service role but with a MANDATORY explicit
// tenant filter and a whitelisted column list — never SELECT *. The tenant/branch
// come from the verified API key (gateway-injected headers), never the request.
//
// Reads straight off lms.marketing_leads rather than lms.vw_dashboard_leads: the
// view is missing address_line2/landmark/pincode and carries many internal-only
// fields (assignment, stage, campaign, raw webhook data) that a partner API must
// not expose.
export async function getLeadById(tenantId: string, leadId: string) {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ml.id AS lead_id, ml.org_id, ml.first_name, ml.last_name,
             ml.phone, ml.email,
             ml.address_line1, ml.address_line2, ml.landmark, ml.pincode, ml.city,
             src.name AS lead_source, src.label AS lead_source_label
      FROM lms.marketing_leads ml
      JOIN entity.organizations o ON o.id = ml.org_id
      LEFT JOIN lms.lead_sources src ON src.id = ml.source_id
      WHERE ml.id = ${leadId}::uuid
        AND o.tenant_id = ${tenantId}::uuid
        AND NOT ml.is_deleted
    `)) as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  });
}

// ── Bulk list / find (leads:list, leads:find) ────────────────────────────────
//
// Same rules as above, plus the key's branch fence: orgIds null = every branch
// of the tenant (tenant-wide key), otherwise ml.org_id must be in the set.
// Unlike getLeadById these DO return CRM state (stage, outcome, assignee,
// next follow-up) — a product decision (2026-09-29) for partner reporting —
// but still never raw_webhook_data, metadata, tags, outcome_comment or campaign
// internals.
//
// Every catalog join is qualified on tenant too (the catalogs allow a NULL
// tenant_id for platform-wide rows): withServiceTx bypasses RLS and no
// trigger pins source/stage/outcome to the lead's tenant, so a foreign row's
// label must not be able to surface — or be matched by a name filter. The
// assignee is guarded by the assigned_user_id org-scope trigger.
const LEAD_COLUMNS = sql`
  ml.id AS lead_id, ml.org_id AS branch_id, o.name AS branch_name,
  ml.first_name, ml.last_name, ml.full_name, ml.phone, ml.email,
  ml.address_line1, ml.address_line2, ml.landmark, ml.pincode, ml.city,
  ci.name AS city_name,
  src.name AS lead_source, src.label AS lead_source_label,
  st.name  AS stage,       st.label  AS stage_label,
  oc.name  AS outcome,     oc.label  AS outcome_label,
  ml.assigned_user_id, au.full_name AS assigned_user_name,
  ml.scheduled_at AS next_followup_at,
  ml.is_active, ml.created_at, ml.updated_at`;

const LEAD_JOINS = sql`
  FROM lms.marketing_leads ml
  JOIN entity.organizations o          ON o.id  = ml.org_id
  LEFT JOIN geo.cities ci              ON ci.id = ml.city_id AND ci.tenant_id = o.tenant_id
  LEFT JOIN lms.lead_sources src       ON src.id = ml.source_id  AND (src.tenant_id = o.tenant_id OR src.tenant_id IS NULL)
  LEFT JOIN lms.lead_stage st          ON st.id  = ml.stage_id   AND (st.tenant_id  = o.tenant_id OR st.tenant_id  IS NULL)
  LEFT JOIN lms.lead_stage_outcome oc  ON oc.id  = ml.outcome_id AND (oc.tenant_id  = o.tenant_id OR oc.tenant_id  IS NULL)
  LEFT JOIN iam.users au               ON au.id  = ml.assigned_user_id`;

// The mandatory fence shared by list and find. Never omit.
function tenantFence(tenantId: string, orgIds: string[] | null, includeInactive: boolean) {
  return sql`
    o.tenant_id = ${tenantId}::uuid
    AND NOT o.is_deleted
    AND NOT ml.is_deleted
    ${orgIds ? sql`AND ml.org_id = ANY(${sqlUuidArr(orgIds)})` : sql``}
    ${includeInactive ? sql`` : sql`AND ml.is_active`}`;
}

// "<id> or <machine name>" filter on a catalog join. idCol/nameCol are fixed
// literals from this file, never caller input.
function idOrName(idCol: string, nameCol: string, values: string[]) {
  const ids = values.filter(isUuid);
  const names = values.filter((v) => !isUuid(v));
  return sql`AND (
    ${ids.length   ? sql`${sql.raw(idCol)}   = ANY(${sqlUuidArr(ids)})`    : sql`FALSE`}
    OR ${names.length ? sql`${sql.raw(nameCol)} = ANY(${sqlTextArr(names)})` : sql`FALSE`}
  )`;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListLeadsFilter {
  assignedTo?: string[];
  startDate?: string;
  endDate?: string;
  sources?: string[];
  stages?: string[];
  outcomes?: string[];
  includeInactive: boolean;
  limit: number;
  offset: number;
}

export async function listLeads(tenantId: string, orgIds: string[] | null, f: ListLeadsFilter) {
  if (orgIds && orgIds.length === 0) return { rows: [], total: 0 };
  return withServiceTx(async (tx) => {
    // A bare date is a calendar day in the lead's BRANCH timezone, so
    // end_date=2026-09-28 includes the whole of that local day.
    const start = !f.startDate ? sql``
      : DATE_ONLY_RE.test(f.startDate)
        ? sql`AND ml.created_at >= ((${f.startDate}::date)::timestamp AT TIME ZONE o.timezone)`
        : sql`AND ml.created_at >= ${f.startDate}::timestamptz`;
    const end = !f.endDate ? sql``
      : DATE_ONLY_RE.test(f.endDate)
        ? sql`AND ml.created_at < (((${f.endDate}::date) + 1)::timestamp AT TIME ZONE o.timezone)`
        : sql`AND ml.created_at <= ${f.endDate}::timestamptz`;

    const rows = (await tx.execute(sql`
      SELECT ${LEAD_COLUMNS}, COUNT(*) OVER () AS total_count
      ${LEAD_JOINS}
      WHERE ${tenantFence(tenantId, orgIds, f.includeInactive)}
        ${f.assignedTo?.length ? sql`AND ml.assigned_user_id = ANY(${sqlUuidArr(f.assignedTo)})` : sql``}
        ${start}
        ${end}
        ${f.sources?.length  ? idOrName('src.id', 'src.name', f.sources)  : sql``}
        ${f.stages?.length   ? idOrName('st.id',  'st.name',  f.stages)   : sql``}
        ${f.outcomes?.length ? idOrName('oc.id',  'oc.name',  f.outcomes) : sql``}
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}
    `)) as Array<Record<string, unknown>>;
    const total = rows[0] ? Number(rows[0]['total_count'] ?? 0) : 0;
    return { rows: rows.map(({ total_count: _t, ...r }) => r), total };
  });
}

// phoneKeys are the last-10-digit keys, emailKeys lowercased/trimmed — the
// same normalisation applied to the stored column here, so "+91 98xxx",
// "098xxx" and "98xxx" all meet. phone_key/email_key come back so the caller
// can report which input matched.
export async function findLeads(
  tenantId: string,
  orgIds: string[] | null,
  phoneKeys: string[],
  emailKeys: string[],
  includeInactive: boolean,
) {
  if (orgIds && orgIds.length === 0) return [];
  if (phoneKeys.length === 0 && emailKeys.length === 0) return [];
  return withServiceTx(async (tx) => {
    return (await tx.execute(sql`
      SELECT ${LEAD_COLUMNS},
             RIGHT(regexp_replace(COALESCE(ml.phone, ''), '\\D', '', 'g'), 10) AS phone_key,
             lower(trim(ml.email)) AS email_key
      ${LEAD_JOINS}
      WHERE ${tenantFence(tenantId, orgIds, includeInactive)}
        AND (
          ${phoneKeys.length ? sql`RIGHT(regexp_replace(ml.phone, '\\D', '', 'g'), 10) = ANY(${sqlTextArr(phoneKeys)})` : sql`FALSE`}
          OR ${emailKeys.length ? sql`lower(trim(ml.email)) = ANY(${sqlTextArr(emailKeys)})` : sql`FALSE`}
        )
      ORDER BY ml.created_at DESC, ml.id DESC
      LIMIT 1000
    `)) as Array<Record<string, unknown>>;
  });
}

// The subset of orgIds that are live branches of the tenant. Validates a
// tenant-wide key's branch_id list in one round trip.
export async function orgsBelongingToTenant(orgIds: string[], tenantId: string): Promise<string[]> {
  if (orgIds.length === 0) return [];
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id FROM entity.organizations
      WHERE id = ANY(${sqlUuidArr(orgIds)}) AND tenant_id = ${tenantId}::uuid AND NOT is_deleted
    `)) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });
}

export async function orgBelongsToTenant(orgId: string, tenantId: string): Promise<boolean> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM entity.organizations
      WHERE id = ${orgId}::uuid AND tenant_id = ${tenantId}::uuid AND NOT is_deleted
      LIMIT 1
    `)) as unknown as unknown[];
    return rows.length > 0;
  });
}
