import { sql } from 'drizzle-orm';
import { withRoleTx, type RoleTxContext } from '@platform/db';

// comms.message_templates is a CROSS-PRODUCT catalog (HR onboarding, task
// nudges and email templates share it), so every read here is pinned to this
// service's own corner of it. Without the module/channel guard, sending an HR
// onboarding template at a sales lead would be one bad template_id away.
const MODULE = 'lms';
const CHANNEL = 'whatsapp';

export interface WhatsAppTemplateRow {
  id: string;
  name: string;
  label: string;
  description: string | null;
  provider_template_name: string;
  language_code: string;
  preview_text: string | null;
  header_fields: string[];
  body_fields: string[];
  sort_order: number;
}

const COLUMNS = sql`
  mt.id, mt.name, mt.label, mt.description,
  mt.provider_template_name, mt.language_code, mt.preview_text,
  mt.header_fields, mt.body_fields, mt.sort_order
`;

// Audience visibility (global / own tenant / own org) is enforced by RLS on
// comms.message_templates in 06_rls.sql, so it is deliberately not repeated
// here — the same convention the lead repositories follow when they omit
// org_id filters and let the policy do the work.
export async function listTemplates(ctx: RoleTxContext): Promise<WhatsAppTemplateRow[]> {
  return withRoleTx(ctx, async (tx) => {
    // One template `name` can exist at up to three audiences at once, and the
    // rep must be offered exactly one of each. DISTINCT ON keeps the most
    // specific: an org-targeted row beats a tenant-wide one, which beats the
    // platform default. The outer query then restores presentation order,
    // because DISTINCT ON forces its own ORDER BY to lead with the dedup key.
    return (await tx.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (mt.name) ${COLUMNS}
        FROM comms.message_templates mt
        WHERE mt.module = ${MODULE}
          AND mt.channel = ${CHANNEL}
          AND mt.is_active
          AND NOT mt.is_deleted
        ORDER BY mt.name,
                 (mt.org_id    IS NOT NULL) DESC,
                 (mt.tenant_id IS NOT NULL) DESC
      ) t
      ORDER BY t.sort_order, t.label
    `)) as unknown as WhatsAppTemplateRow[];
  });
}

export async function getTemplateById(
  ctx: RoleTxContext,
  templateId: string,
): Promise<WhatsAppTemplateRow | null> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${COLUMNS}
      FROM comms.message_templates mt
      WHERE mt.id = ${templateId}::uuid
        AND mt.module = ${MODULE}
        AND mt.channel = ${CHANNEL}
        AND mt.is_active
        AND NOT mt.is_deleted
      LIMIT 1
    `)) as unknown as WhatsAppTemplateRow[];
    return rows[0] ?? null;
  });
}

/** Display name of the acting sales rep, for the {{rep_name}} placeholder. */
export async function getActorName(ctx: RoleTxContext): Promise<string | null> {
  return withRoleTx(ctx, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT full_name FROM iam.users WHERE id = ${ctx.user_id}::uuid LIMIT 1
    `)) as unknown as Array<{ full_name: string | null }>;
    return rows[0]?.full_name ?? null;
  });
}
