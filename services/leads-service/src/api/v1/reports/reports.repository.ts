// ── Report data access ────────────────────────────────────────────────────────
// The only place the report engine touches the database. Everything runs inside
// withRoleTx with the REAL actor's role/org/tenant/user and `readOnly: true` —
// that is the caller contract @platform/reporting/sql/execute.ts documents, and
// layer 1 of the four scoping layers. Without it the RLS GUCs are unset and the
// security_invoker views have no actor to filter against.

import { sql } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@platform/db';
import { organizationsTable } from '@platform/db/schema';
import { eq } from 'drizzle-orm';
import { runReportQuery, type DatasetDef, type ReportQueryContext } from '@platform/reporting/sql';
import type { ReportResult, ReportSpec } from '@platform/reporting';

export interface ReportActor {
  orgId: string;
  tenantId: string;
  userId: string;
  /** platform_role, as withRoleTx understands it. */
  role: string;
  capabilities: readonly string[];
}

/**
 * The org's IANA timezone, for date bucketing.
 *
 * Read under withServiceTx, mirroring how analytics.repository.ts resolves a
 * tenant id: it is a single column of the caller's own org, needed before the
 * report transaction opens. Getting this wrong shifts every date bucket by the
 * UTC offset, which makes "leads today" in a report disagree with the leads list
 * — see the comment in @platform/reporting/sql/buckets.ts.
 */
export async function getOrgTimezone(orgId: string): Promise<string | undefined> {
  return withServiceTx(async (tx) => {
    const [row] = await tx
      .select({ timezone: organizationsTable.timezone })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    return row?.timezone ?? undefined;
  });
}

export async function runReport(
  def: DatasetDef,
  spec: ReportSpec,
  actor: ReportActor,
  options: { tenantWide?: boolean; orgTimezone?: string } = {},
): Promise<ReportResult> {
  const ctx: ReportQueryContext = {
    actor: { capabilities: actor.capabilities },
    role: actor.role,
    orgId: actor.orgId,
    tenantId: actor.tenantId,
    userId: actor.userId,
    ...(options.orgTimezone !== undefined && { orgTimezone: options.orgTimezone }),
    ...(options.tenantWide === true && { tenantWide: true }),
  };

  return withRoleTx(
    {
      role: actor.role,
      org_id: actor.orgId,
      tenant_id: actor.tenantId,
      user_id: actor.userId,
      // A report never writes. This runs the transaction under readonly_user with
      // transaction_read_only = on, so the database itself rejects a write even if
      // a dataset's `from` fragment were ever wrong.
      readOnly: true,
    },
    // The tx is passed as a SqlExecutor — @platform/reporting does not depend on
    // @platform/db, which is what keeps `postgres` out of any consumer bundle.
    (tx) => runReportQuery(tx, def, spec, ctx),
  );
}

/**
 * Cheap liveness probe for a dataset's relation.
 *
 * Exists because a missing `GRANT SELECT … TO lms_svc` on a newly-added dataset
 * relation is a runtime permission error, not a compile error — the grants in
 * db_scripts/04_roles_and_grants.sql are enumerated per login, never wildcarded.
 * Failing here names the dataset; failing inside a user's report does not.
 */
export async function probeDataset(def: DatasetDef, actor: ReportActor): Promise<void> {
  await withRoleTx(
    {
      role: actor.role,
      org_id: actor.orgId,
      tenant_id: actor.tenantId,
      user_id: actor.userId,
      readOnly: true,
    },
    async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${def.from} WHERE false`);
    },
  );
}
