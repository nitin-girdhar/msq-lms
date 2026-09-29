import { sql } from 'drizzle-orm';
import { withServiceTx, withTenantConfigTx, pgNotify, type DrizzleTx } from '@platform/db';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { getGlobalIntegration, getIntegrationById } from './integration.service.js';
import { resolveTenantAndOrg } from './page-org-map.service.js';
import { isMetaTestLead, syncLeadToDatabase, type MetaLeadFieldData, type MetaLeadPlatform } from './lead-sync.service.js';

// ── The Meta lead inbox (1.51.0) ──────────────────────────────────────────────
//
// Webhook leads that did NOT become an LMS lead. Before 1.51.0 they were a log
// line, and because the webhook answers 200 regardless (a non-2xx would make Meta
// redeliver the WHOLE batch, duplicating the leads that did land), Meta never
// sent them again: a lost lead left nothing anyone could act on.
//
// WRITES come from the webhook, which carries no session: withServiceTx, a
// documented system operation, exactly like the webhook's other writes.
//
// READS/ACTIONS come from the super_admin console:
//   * rows WITH a tenant  -> withTenantConfigTx, so admin_tenant_config_policy
//                            fences them to the administered tenant;
//   * rows WITHOUT one    -> the page was unmapped, so no tenant is known yet.
//                            They match no policy and are reached on
//                            withServiceTx, only after the controller's
//                            RANKS.SUPER_ADMIN check — the same treatment the
//                            shared (tenant-less) integration row gets.

export type InboxReason = 'unmapped' | 'missing_contact' | 'sync_failed';

export interface InboxRecord {
  meta_lead_id: string;
  tenant_id?: string | null | undefined;
  org_id?: string | null | undefined;
  integration_id?: string | null | undefined;
  page_id?: string | null | undefined;
  form_id?: string | null | undefined;
  campaign_id?: string | null | undefined;
  adset_id?: string | null | undefined;
  ad_id?: string | null | undefined;
  platform?: MetaLeadPlatform | null | undefined;
  lead_created_at?: string | null | undefined;
  raw_field_data?: MetaLeadFieldData[] | null | undefined;
  reason: InboxReason;
  error_text?: string | null | undefined;
}

function digits(v: string | null | undefined): string | null {
  return v && /^\d+$/.test(v) ? v : null;
}

/**
 * Record (or refresh) a lead that did not land. One row per Meta lead: a repeat
 * failure bumps `attempts` and refreshes the reason. A row an admin already
 * RESOLVED or IGNORED is left as it is.
 */
export async function recordInbox(r: InboxRecord): Promise<void> {
  const leadId = digits(r.meta_lead_id);
  if (!leadId) return;
  await withServiceTx((tx) => tx.execute(sql`
    INSERT INTO ext.meta_lead_inbox (
      meta_lead_id, tenant_id, org_id, integration_id, page_id, form_id, campaign_id, adset_id, ad_id,
      platform, lead_created_at, raw_field_data, reason, error_text
    ) VALUES (
      ${leadId}::bigint, ${r.tenant_id ?? null}::uuid, ${r.org_id ?? null}::uuid, ${r.integration_id ?? null}::uuid,
      ${digits(r.page_id)}::bigint, ${digits(r.form_id)}::bigint, ${digits(r.campaign_id)}::bigint,
      ${digits(r.adset_id)}::bigint, ${digits(r.ad_id)}::bigint,
      ${r.platform ?? null}, ${r.lead_created_at ?? null}::timestamptz,
      ${r.raw_field_data ? JSON.stringify(r.raw_field_data) : null}::jsonb,
      ${r.reason}, ${r.error_text ? r.error_text.slice(0, 1000) : null}
    )
    ON CONFLICT (meta_lead_id) DO UPDATE SET
      attempts       = ext.meta_lead_inbox.attempts + 1,
      reason         = EXCLUDED.reason,
      error_text     = EXCLUDED.error_text,
      tenant_id      = COALESCE(EXCLUDED.tenant_id, ext.meta_lead_inbox.tenant_id),
      org_id         = COALESCE(EXCLUDED.org_id, ext.meta_lead_inbox.org_id),
      raw_field_data = COALESCE(EXCLUDED.raw_field_data, ext.meta_lead_inbox.raw_field_data)
    WHERE ext.meta_lead_inbox.status = 'open'
  `));
}

/**
 * Closes the inbox row for a Meta lead that has now landed — by a later webhook
 * redelivery, a Retry, or a lead-pull Apply. A no-op when there is none.
 */
export async function resolveInboxByMetaLead(
  metaLeadId: string,
  marketingLeadId: string | null,
  actorUserId: string | null = null,
): Promise<void> {
  const leadId = digits(metaLeadId);
  if (!leadId) return;
  await withServiceTx((tx) => tx.execute(sql`
    UPDATE ext.meta_lead_inbox
    SET status = 'resolved', resolved_lead_id = ${marketingLeadId}::uuid,
        resolved_by = ${actorUserId}::uuid, resolved_at = NOW()
    WHERE meta_lead_id = ${leadId}::bigint AND status = 'open'
  `));
}

// ── Console side ─────────────────────────────────────────────────────────────

export interface InboxRow {
  id: string;
  meta_lead_id: string;
  tenant_id: string | null;
  org_id: string | null;
  page_id: string | null;
  form_id: string | null;
  campaign_id: string | null;
  platform: string | null;
  lead_created_at: string | null;
  reason: InboxReason;
  error_text: string | null;
  status: 'open' | 'resolved' | 'ignored';
  attempts: number;
  resolved_lead_id: string | null;
  /** Display name from the lead's field data — PII kept to name only in the grid. */
  lead_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxListFilters {
  status?: 'open' | 'resolved' | 'ignored' | undefined;
  reason?: InboxReason | undefined;
}

const INBOX_SELECT = sql`
  SELECT id, meta_lead_id::text AS meta_lead_id, tenant_id, org_id,
         page_id::text AS page_id, form_id::text AS form_id, campaign_id::text AS campaign_id,
         platform, lead_created_at, reason, error_text, status, attempts, resolved_lead_id,
         (SELECT f->'values'->>0 FROM jsonb_array_elements(COALESCE(raw_field_data, '[]'::jsonb)) f
           WHERE f->>'name' IN ('full_name','first_name') LIMIT 1) AS lead_name,
         created_at, updated_at
  FROM ext.meta_lead_inbox`;

function filterSql(filters: InboxListFilters) {
  return sql`
    ${filters.status ? sql`AND status = ${filters.status}` : sql``}
    ${filters.reason ? sql`AND reason = ${filters.reason}` : sql``}`;
}

/**
 * The inbox for ONE administered tenant (RLS-fenced), or — tenantId null — the
 * tenant-less rows (pages mapped to nobody), which only a super admin triages.
 */
export async function listInbox(
  actorUserId: string,
  tenantId: string | null,
  filters: InboxListFilters,
): Promise<InboxRow[]> {
  if (tenantId) {
    return withTenantConfigTx({ actorUserId, tenantId }, async (tx) => (await tx.execute(sql`
      ${INBOX_SELECT}
      WHERE TRUE ${filterSql(filters)}
      ORDER BY created_at DESC
      LIMIT 500
    `)) as unknown as InboxRow[]);
  }
  return withServiceTx(async (tx) => (await tx.execute(sql`
    ${INBOX_SELECT}
    WHERE tenant_id IS NULL ${filterSql(filters)}
    ORDER BY created_at DESC
    LIMIT 500
  `)) as unknown as InboxRow[]);
}

interface InboxFull {
  id: string;
  meta_lead_id: string;
  tenant_id: string | null;
  integration_id: string | null;
  page_id: string | null;
  form_id: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  platform: MetaLeadPlatform | null;
  lead_created_at: string | null;
  raw_field_data: MetaLeadFieldData[] | null;
  status: string;
}

async function loadRow(tx: DrizzleTx, id: string, tenantId: string | null): Promise<InboxFull | null> {
  const rows = (await tx.execute(sql`
    SELECT id, meta_lead_id::text AS meta_lead_id, tenant_id, integration_id,
           page_id::text AS page_id, form_id::text AS form_id, campaign_id::text AS campaign_id,
           adset_id::text AS adset_id, ad_id::text AS ad_id, platform, lead_created_at::text AS lead_created_at,
           raw_field_data, status
    FROM ext.meta_lead_inbox
    WHERE id = ${id}::uuid ${tenantId ? sql`` : sql`AND tenant_id IS NULL`}
  `)) as unknown as InboxFull[];
  return rows[0] ?? null;
}

/** The row, reached the same way listInbox reaches it — never across tenants. */
async function getRow(actorUserId: string, tenantId: string | null, id: string): Promise<InboxFull> {
  const row = tenantId
    ? await withTenantConfigTx({ actorUserId, tenantId }, (tx) => loadRow(tx, id, tenantId))
    : await withServiceTx((tx) => loadRow(tx, id, null));
  if (!row) throw new NotFoundError('Inbox entry not found');
  return row;
}

export interface RetryResult {
  status: 'resolved';
  marketing_lead_id: string;
  duplicate: boolean;
  assigned_user_id: string | null;
}

/**
 * Retry: route the stored lead again through the canonical write path — the
 * same syncLeadToDatabase the webhook calls, so typing, assignment and dedup are
 * identical. The page must now be mapped; the branch and tenant come from the
 * mapping as it stands NOW, never from the row.
 */
export async function retryInbox(actorUserId: string, tenantId: string | null, id: string): Promise<RetryResult> {
  const row = await getRow(actorUserId, tenantId, id);
  if (row.status !== 'open') throw new BadRequestError('Only open inbox entries can be retried');
  if (!row.page_id) throw new BadRequestError('This entry has no page id and cannot be routed');
  const fieldData = row.raw_field_data ?? [];
  if (fieldData.length === 0) throw new BadRequestError('This entry has no stored lead data to retry');
  if (isMetaTestLead(fieldData)) throw new BadRequestError('This is a Meta test lead; ignore it instead');

  const mapping = await resolveTenantAndOrg(row.page_id, row.form_id ?? undefined);
  if (!mapping) throw new BadRequestError('The page/form is still not mapped to a branch — map it first');
  // A tenant-scoped retry must stay in that tenant.
  if (tenantId && mapping.tenantId !== tenantId) {
    throw new BadRequestError('This page is now mapped to a different tenant');
  }

  const integration = row.integration_id ? await getIntegrationById(row.integration_id) : await getGlobalIntegration();

  const created = row.lead_created_at ? Math.floor(new Date(row.lead_created_at).getTime() / 1000) : undefined;
  const result = await syncLeadToDatabase(
    mapping.orgId,
    {
      id: row.meta_lead_id,
      form_id: row.form_id ?? 'unknown',
      page_id: row.page_id,
      platform: row.platform ?? mapping.platform,
      ...(created !== undefined && !Number.isNaN(created) ? { created_time: created } : {}),
      ...(row.campaign_id ? { campaign_id: row.campaign_id } : {}),
      ...(row.adset_id ? { adset_id: row.adset_id } : {}),
      ...(row.ad_id ? { ad_id: row.ad_id } : {}),
      field_data: fieldData,
    },
    integration?.field_mappings ?? null,
    {
      tenantId: mapping.tenantId,
      ...(integration ? { accessToken: integration.access_token, graphApiVersion: integration.graph_api_version } : {}),
    },
  );

  await withServiceTx((tx) => tx.execute(sql`
    UPDATE ext.meta_lead_inbox
    SET status = 'resolved', resolved_lead_id = ${result.marketingLeadId}::uuid,
        resolved_by = ${actorUserId}::uuid, resolved_at = NOW(),
        tenant_id = COALESCE(tenant_id, ${mapping.tenantId}::uuid),
        org_id = ${mapping.orgId}::uuid
    WHERE id = ${id}::uuid
  `));

  if (!result.isDuplicate) {
    pgNotify('crm_events', {
      type: 'lead:created',
      lead_id: result.marketingLeadId,
      org_id: mapping.orgId,
      tenant_id: mapping.tenantId,
      assigned_user_id: result.assignedUserId,
      actor_id: actorUserId,
      ts: Date.now(),
    }).catch(() => undefined);
  }

  return {
    status: 'resolved',
    marketing_lead_id: result.marketingLeadId,
    duplicate: result.isDuplicate,
    assigned_user_id: result.assignedUserId,
  };
}

export async function ignoreInbox(actorUserId: string, tenantId: string | null, id: string): Promise<void> {
  const row = await getRow(actorUserId, tenantId, id);
  if (row.status !== 'open') throw new BadRequestError('Only open inbox entries can be ignored');
  const update = (tx: DrizzleTx) => tx.execute(sql`
    UPDATE ext.meta_lead_inbox
    SET status = 'ignored', resolved_by = ${actorUserId}::uuid, resolved_at = NOW()
    WHERE id = ${id}::uuid AND status = 'open'
  `);
  if (tenantId) await withTenantConfigTx({ actorUserId, tenantId }, update);
  else await withServiceTx(update);
}
