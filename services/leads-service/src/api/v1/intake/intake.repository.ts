import { and, sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import { createLogger } from '@platform/logger';
import { resolveAutoAssignedUser, storedAutoAssignReason } from '../../../lib/assignment.js';
import { resolveCampaignForLead } from '../../../lib/campaign-resolution.js';
import {
  marketingLeadsTable,
  leadLinksTable,
} from '@platform/db/schema';
import { config } from '../../../config/index.js';
import { BadRequestError } from '../../../lib/errors.js';

// Intake runs gateway-less, so there is no request-scoped logger on this path —
// same reason lib/meta-capi-trigger.ts carries its own.
const log = createLogger({ service: 'leads-service', nodeEnv: config.nodeEnv });

export interface WebhookLeadData {
  org_id: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  city?: string;
  address_line1?: string;
  address_line2?: string;
  pincode?: string;
  // geo.* PKs are UUID v7 (db_scripts/02_tables_core.sql), not identity ints.
  city_id?: string;
  state_id?: string;
  country_id?: string;
  source_id?: string;
  source?: string;
  campaign_id?: string;
  // ── Meta campaign / routing ──
  // Strings, not numbers: Meta campaign ids run past Number.MAX_SAFE_INTEGER.
  meta_campaign_id?: string;
  meta_campaign_name?: string;
  meta_platform?: string;
  meta_campaign_status?: string;
  /** Resolved by meta-conversion-api, which owns the ext.* campaign -> type mapping. */
  campaign_type_id?: string;
  /** ext.meta_page_form_org_map.default_campaign_type_id, likewise passed in. */
  default_campaign_type_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  raw_webhook_data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WebhookLeadResult {
  id: string;
  is_duplicate: boolean;
  existing_lead_id: string | null;
  /**
   * Who the lead went to (1.51.0) — null when unassigned, and for an email
   * duplicate (the existing lead is returned untouched). The webhook's realtime
   * `lead:created` event used to hard-code null here, so the rep who actually
   * received a lead got no live notification unless their role could see
   * unassigned leads.
   */
  assigned_user_id: string | null;
  /** The pool the lead was typed into; null for an email duplicate. */
  campaign_type_id: string | null;
  /** Why the pick left it unowned; null when assigned (lms.marketing_leads.auto_assign_reason). */
  auto_assign_reason: string | null;
}

// Confirms a branch (org) belongs to the given tenant — used to validate a
// body-supplied branch_id for tenant-scoped public API keys.
export async function orgBelongsToTenant(orgId: string, tenantId: string): Promise<boolean> {
  return withServiceTx(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM entity.organizations
      WHERE id = ${orgId}::uuid AND tenant_id = ${tenantId}::uuid
        AND NOT is_deleted AND is_active
      LIMIT 1
    `)) as unknown as unknown[];
    return rows.length > 0;
  });
}

// Canonical lead creation for external/intake sources (website, meta, third-party).
// Uses the service DB role (bypasses RLS) and applies the same dedup + auto-assign
// logic used by the meta webhook path.
export async function createWebhookLead(data: WebhookLeadData): Promise<WebhookLeadResult> {
  if (!data.org_id) throw new BadRequestError('org_id is required');
  if (!data.phone && !data.email) throw new BadRequestError('At least one of phone or email is required');

  return withServiceTx(async (tx) => {
    // lms.lead_stage / lms.lead_sources are tenant-scoped (N-6 Half B). This is a
    // BYPASSRLS service tx (gateway-less intake), so RLS can't auto-scope — resolve
    // the 'new' stage / named source for the LEAD's tenant explicitly (via org_id),
    // never a global `WHERE name=` that would pick an arbitrary tenant's row.
    const stageRows = (await tx.execute(sql`
      SELECT id FROM lms.lead_stage
      WHERE name = 'new'
        AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${data.org_id}::uuid)
      LIMIT 1
    `)) as Array<{ id: string }>;
    const defaultStage = stageRows[0];
    if (!defaultStage) throw new Error('Lead stage "new" not found for this tenant');

    let sourceId: string | null = data.source_id ?? null;
    if (!sourceId && data.source) {
      const srcRows = (await tx.execute(sql`
        SELECT id FROM lms.lead_sources
        WHERE name = ${String(data.source)}
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = ${data.org_id}::uuid)
        LIMIT 1
      `)) as Array<{ id: string }>;
      sourceId = srcRows[0]?.id ?? null;
    }

    // Dedup: check for existing active lead with same phone in this org.
    // If found, mark it inactive + create a lead_link supersession record,
    // then insert the new lead as the active record.
    let existingLeadId: string | null = null;

    if (data.phone) {
      const rows = (await tx.execute(sql`
        SELECT id FROM lms.marketing_leads
        WHERE org_id = ${data.org_id}::uuid
          AND phone = ${data.phone}
          AND is_active = true
          AND NOT is_deleted
        LIMIT 1
      `)) as Array<{ id: string }>;
      existingLeadId = rows[0]?.id ?? null;
    }

    // Dedup by email only if no phone match found
    if (!existingLeadId && data.email) {
      const rows = (await tx.execute(sql`
        SELECT id FROM lms.marketing_leads
        WHERE org_id = ${data.org_id}::uuid
          AND email = ${data.email}
          AND is_active = true
          AND NOT is_deleted
        LIMIT 1
      `)) as Array<{ id: string }>;

      // Email match: this is an update/re-submission, not a new lead — return early
      if (rows[0]) {
        return {
          id: rows[0].id,
          is_duplicate: true,
          existing_lead_id: rows[0].id,
          assigned_user_id: null,
          campaign_type_id: null,
          auto_assign_reason: null,
        };
      }
    }

    // Mark the existing phone-matched lead inactive before inserting the new one.
    // (The unique index on (org_id, phone) WHERE is_active = true requires this ordering.)
    if (existingLeadId) {
      await tx.execute(sql`
        UPDATE lms.marketing_leads
        SET is_active = false, updated_at = NOW()
        WHERE id = ${existingLeadId}::uuid
      `);
    }

    // Campaign and TYPE before the pick: which rotation this lead belongs to is
    // an input to who receives it, not a label applied afterwards. May also
    // create the branch's marketing.ad_campaigns row for a Meta campaign seen
    // here for the first time.
    const resolved = await resolveCampaignForLead(tx, data.org_id, {
      metaCampaignId:        data.meta_campaign_id ?? null,
      metaCampaignName:      data.meta_campaign_name ?? null,
      metaPlatform:          data.meta_platform ?? null,
      metaCampaignStatus:    data.meta_campaign_status ?? null,
      campaignTypeId:        data.campaign_type_id ?? null,
      defaultCampaignTypeId: data.default_campaign_type_id ?? null,
    });

    const assignment = await resolveAutoAssignedUser(tx, data.org_id, resolved.campaign_type_id);

    // The fix for the silent-failure incident: auto-assign used to return a bare
    // null and the lead simply arrived unassigned, so 10 of 30 branches sat with
    // no weighted user for a long time with nothing in the logs to show it.
    // A skipped assignment now always says which pool and why.
    if (assignment.reason !== 'assigned') {
      // The pool's NAME, not just its id: "no eligible user in the hiring pool"
      // is what an operator can act on from a log line. Looked up only on this
      // (rare) path, so the assigned path pays nothing for it.
      const typeRows = resolved.campaign_type_id
        ? (await tx.execute(sql`
            SELECT name FROM marketing.campaign_types WHERE id = ${resolved.campaign_type_id}::uuid LIMIT 1
          `)) as Array<{ name: string }>
        : [];
      log.warn(
        {
          event: 'lead.autoassign_skipped',
          org_id: data.org_id,
          campaign_type: typeRows[0]?.name ?? null,
          campaign_type_id: resolved.campaign_type_id,
          reason: assignment.reason,
        },
        'Lead created unassigned: no eligible user in this pool',
      );
    }

    const autoAssignedUserId = assignment.userId;

    const [inserted] = await tx
      .insert(marketingLeadsTable)
      .values({
        orgId:         data.org_id,
        firstName:     String(data.first_name ?? ''),
        lastName:      String(data.last_name ?? ''),
        phone:         data.phone ?? null,
        email:         data.email ?? null,
        city:          data.city ?? null,
        addressLine1:  data.address_line1 ?? null,
        addressLine2:  data.address_line2 ?? null,
        pincode:       data.pincode ?? null,
        cityId:        data.city_id ?? null,
        stateId:       data.state_id ?? null,
        countryId:     data.country_id ?? null,
        stageId:       defaultStage.id,
        sourceId,
        // An explicit campaign_id from the caller still wins; resolveCampaignForLead
        // only supplies one when the lead carried a Meta campaign id.
        campaignId:     data.campaign_id ?? resolved.campaign_id,
        // Written explicitly rather than left to lms.sync_lead_campaign_type():
        // that trigger only fills a NULL from the campaign, so a lead with a type
        // but no campaign row (a walk-in, or a Meta campaign whose catalog row
        // could not be created) would otherwise land untyped and unroutable.
        campaignTypeId: resolved.campaign_type_id,
        assignedUserId: autoAssignedUserId,
        autoAssignReason: storedAutoAssignReason(assignment.reason),
        tags:          Array.isArray(data.tags) ? data.tags.map(String) : [],
        metadata:      (data.metadata ?? {}) as Record<string, unknown>,
        rawWebhookData: (data.raw_webhook_data ?? {}) as Record<string, unknown>,
      })
      .returning({ id: marketingLeadsTable.id });

    const newLeadId = inserted!.id;

    // Write the merge/supersession audit link for the old lead
    if (existingLeadId) {
      await tx
        .insert(leadLinksTable)
        .values({
          sourceLeadId: existingLeadId,
          sourceOrgId:  data.org_id,
          destLeadId:   newLeadId,
          destOrgId:    data.org_id,
          linkType:     'merge',
          status:       'completed',
        });

      // Point the superseded lead forward
      await tx.execute(sql`
        UPDATE lms.marketing_leads
        SET superseded_by = ${newLeadId}::uuid
        WHERE id = ${existingLeadId}::uuid
      `);
    }

    return {
      id: newLeadId,
      is_duplicate: false,
      existing_lead_id: existingLeadId,
      assigned_user_id: autoAssignedUserId,
      campaign_type_id: resolved.campaign_type_id,
      auto_assign_reason: storedAutoAssignReason(assignment.reason),
    };
  });
}
