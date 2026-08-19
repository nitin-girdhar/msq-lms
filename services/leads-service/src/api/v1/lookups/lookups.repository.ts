import { sql } from 'drizzle-orm';
import { withRoleTx, sqlUuidArr } from '@platform/db';
import type { RoleTxContext } from '@platform/db';
import {
  leadSourcesTable,
  marketingPlatformsTable,
  interactionTypesTable,
  leadStageTable,
  campaignStatusesTable,
  citiesTable,
  statesTable,
  countriesTable,
} from '@platform/db/schema';
import { and, asc, eq } from 'drizzle-orm';

// These 5 lookups are tenant-scoped (N-6 Half B). Read them under withRoleTx so
// RLS scopes rows to the caller's tenant (via current org) — a withServiceTx
// (BYPASSRLS) read would leak every tenant's catalog into the dropdown.
export async function getLookups(ctx: RoleTxContext) {
  return withRoleTx(ctx, async (tx) => {
    const [sources, platforms, interaction_types, stages, campaign_statuses] = await Promise.all([
      tx.select({ id: leadSourcesTable.id, name: leadSourcesTable.name }).from(leadSourcesTable).orderBy(asc(leadSourcesTable.name)),
      tx.select({ id: marketingPlatformsTable.id, name: marketingPlatformsTable.name, description: marketingPlatformsTable.description }).from(marketingPlatformsTable).orderBy(asc(marketingPlatformsTable.name)),
      tx.select({ id: interactionTypesTable.id, name: interactionTypesTable.name, description: interactionTypesTable.description }).from(interactionTypesTable).orderBy(asc(interactionTypesTable.name)),
      tx.select({
        id: leadStageTable.id,
        name: leadStageTable.name,
        label: leadStageTable.label,
        description: leadStageTable.description,
        sort_order: leadStageTable.sortOrder,
        followup_required: leadStageTable.followupRequired,
        is_rejected: leadStageTable.isRejected,
        is_terminated: leadStageTable.isTerminated,
      }).from(leadStageTable).orderBy(asc(leadStageTable.sortOrder)),
      tx.select({ id: campaignStatusesTable.id, name: campaignStatusesTable.name, description: campaignStatusesTable.description }).from(campaignStatusesTable).orderBy(asc(campaignStatusesTable.name)),
    ]);
    return { sources, platforms, interaction_types, stages, campaign_statuses };
  });
}

// geo.* is tenant-scoped now (db_scripts/02_tables_core.sql + 08_rls.sql), so
// these read under withRoleTx like getLookups above. This is not cosmetic: a
// withServiceTx (BYPASSRLS) read would put every tenant's cities into the
// dropdown, and every tenant has its own row called "Gurgaon".
//
// is_active filters out places a tenant has "deleted" — geo has no hard delete
// (07_grants.sql grants none), so deactivated rows stay in the table to keep
// existing leads and orgs resolvable, and must not appear in a picker.
export async function getCities(ctx: RoleTxContext, stateId?: string) {
  return withRoleTx(ctx, async (tx) => {
    const where = stateId !== undefined
      ? and(eq(citiesTable.isActive, true), eq(citiesTable.stateId, stateId))
      : eq(citiesTable.isActive, true);
    const q = tx
      .select({ id: citiesTable.id, name: citiesTable.name, state_id: citiesTable.stateId })
      .from(citiesTable)
      .where(where)
      .orderBy(asc(citiesTable.name));
    return stateId !== undefined ? q : q.limit(500);
  });
}

export async function getLocations(
  ctx: RoleTxContext,
  level: string | undefined,
  countryIds: string[],
  stateIds: string[],
) {
  return withRoleTx(ctx, async (tx) => {
    if (level === 'geo.states') {
      return (await tx.execute(sql`
        SELECT id, name, code AS "isoCode", country_id AS "countryId"
        FROM geo.states
        WHERE is_active
          ${countryIds.length ? sql`AND country_id = ANY(${sqlUuidArr(countryIds)})` : sql``}
        ORDER BY name
      `)) as Array<Record<string, unknown>>;
    }
    if (level === 'geo.cities') {
      return (await tx.execute(sql`
        SELECT id, name, state_id AS "stateId"
        FROM geo.cities
        WHERE is_active
          ${stateIds.length ? sql`AND state_id = ANY(${sqlUuidArr(stateIds)})` : sql`` }
        ORDER BY name
        ${stateIds.length ? sql`` : sql`LIMIT 500`}
      `)) as Array<Record<string, unknown>>;
    }
    return tx
      .select({ id: countriesTable.id, name: countriesTable.name, isoCode: countriesTable.isoCode })
      .from(countriesTable)
      .where(eq(countriesTable.isActive, true))
      .orderBy(asc(countriesTable.name));
  });
}
