import { sql } from 'drizzle-orm';
import { withServiceTx, toTextArrayLiteral } from '@crm/db';
import { BadRequestError } from '../../../lib/errors.js';

export interface ReassignOrgLeadsParams {
  orgId: string;
  fromUserId: string;
  toUserId: string;
  actorId: string;
}

// Hands a departing user's still-open leads, within a single org, to another
// active user in that same org. Moved here from identity-service (N-5) — leads
// are LMS-owned data, so LMS-service is the only one allowed to write them.
export async function reassignOrgLeads(params: ReassignOrgLeadsParams): Promise<number> {
  return withServiceTx(async (tx) => {
    const [candidate] = (await tx.execute(sql`
      SELECT u.id
      FROM iam.users u
      JOIN iam.user_org_mapping uom ON uom.user_id = u.id AND uom.org_id = ${params.orgId}::uuid AND uom.is_active
      WHERE u.id = ${params.toUserId}::uuid AND NOT u.is_deleted AND u.is_active
    `)) as Array<{ id: string }>;
    if (!candidate) throw new BadRequestError('Lead reassignment target must be an active user in that branch');

    // trg_lead_assignment_log reads the acting user from this GUC to fill
    // lead_assignment_log.assigned_by_id — a service tx doesn't set it by
    // default (unlike withRoleTx). Same pattern leads.repository.ts's
    // transferLead uses for its own trigger.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${params.actorId}, true)`);

    const rows = (await tx.execute(sql`
      UPDATE lms.marketing_leads
      SET assigned_user_id = ${params.toUserId}::uuid, updated_at = NOW()
      WHERE assigned_user_id = ${params.fromUserId}::uuid AND org_id = ${params.orgId}::uuid
        AND NOT is_deleted AND is_active
      RETURNING id
    `)) as Array<{ id: string }>;
    return rows.length;
  });
}

export interface KnownLeadContacts {
  emails: string[];
  phoneKeys: string[];
}

// Used by the platform public-comms recipient guard (P-1): api-gateway is
// shared and, post-D8-grants, cannot read lms.marketing_leads itself — it
// checks its own iam.users side of the allowlist and asks leads-service for
// the LMS-lead side. `emails`/`phoneKeys` are already normalized
// (lowercased / last-10-digit) by the caller.
export async function findKnownLeadContacts(
  tenantId: string,
  emails: string[],
  phoneKeys: string[],
): Promise<KnownLeadContacts> {
  return withServiceTx(async (tx) => {
    const knownEmails: string[] = [];
    if (emails.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT LOWER(l.email) AS e
        FROM lms.marketing_leads l JOIN entity.organizations o ON o.id = l.org_id
        WHERE o.tenant_id = ${tenantId}::uuid AND NOT l.is_deleted AND l.email IS NOT NULL
          AND LOWER(l.email) = ANY(${toTextArrayLiteral(emails)}::text[])
      `)) as Array<{ e: string }>;
      knownEmails.push(...rows.map((r) => r.e));
    }

    const knownPhoneKeys: string[] = [];
    if (phoneKeys.length > 0) {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT RIGHT(regexp_replace(l.phone, '\\D', '', 'g'), 10) AS p
        FROM lms.marketing_leads l JOIN entity.organizations o ON o.id = l.org_id
        WHERE o.tenant_id = ${tenantId}::uuid AND NOT l.is_deleted AND l.phone IS NOT NULL
          AND RIGHT(regexp_replace(l.phone, '\\D', '', 'g'), 10) = ANY(${toTextArrayLiteral(phoneKeys)}::text[])
      `)) as Array<{ p: string }>;
      knownPhoneKeys.push(...rows.map((r) => r.p));
    }

    return { emails: knownEmails, phoneKeys: knownPhoneKeys };
  });
}
