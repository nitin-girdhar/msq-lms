import { sql } from 'drizzle-orm';
import { withRoleTx, withServiceTx } from '@crm/db';
import type { RoleTxContext } from '@crm/db';
import {
  leadSourcesTable,
  marketingPlatformsTable,
  interactionTypesTable,
  leadStageTable,
  campaignStatusesTable,
  citiesTable,
  statesTable,
  countriesTable,
} from '@crm/db/schema';
import { asc, eq } from 'drizzle-orm';

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

export async function getCities(stateId?: number) {
  return withServiceTx(async (tx) => {
    if (stateId !== undefined) {
      return tx.select({ id: citiesTable.id, name: citiesTable.name }).from(citiesTable).where(eq(citiesTable.stateId, stateId)).orderBy(asc(citiesTable.name));
    }
    return tx.select({ id: citiesTable.id, name: citiesTable.name, state_id: citiesTable.stateId }).from(citiesTable).orderBy(asc(citiesTable.name)).limit(500);
  });
}

export async function getLocations(level: string | undefined, countryIds: number[], stateIds: number[]) {
  return withServiceTx(async (tx) => {
    if (level === 'geo.states') {
      if (countryIds.length) {
        return (await tx.execute(sql`
          SELECT id, name, code AS "isoCode", country_id AS "countryId" FROM geo.states WHERE country_id = ANY(${countryIds}::int[]) ORDER BY name
        `)) as Array<Record<string, unknown>>;
      }
      return (await tx.execute(sql`
        SELECT id, name, code AS "isoCode", country_id AS "countryId" FROM geo.states ORDER BY name
      `)) as Array<Record<string, unknown>>;
    }
    if (level === 'geo.cities') {
      if (stateIds.length) {
        return (await tx.execute(sql`
          SELECT id, name, state_id AS "stateId" FROM geo.cities WHERE state_id = ANY(${stateIds}::int[]) ORDER BY name
        `)) as Array<Record<string, unknown>>;
      }
      return (await tx.execute(sql`
        SELECT id, name, state_id AS "stateId" FROM geo.cities ORDER BY name LIMIT 500
      `)) as Array<Record<string, unknown>>;
    }
    return tx.select({ id: countriesTable.id, name: countriesTable.name, isoCode: countriesTable.isoCode }).from(countriesTable).orderBy(asc(countriesTable.name));
  });
}
