import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';

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
