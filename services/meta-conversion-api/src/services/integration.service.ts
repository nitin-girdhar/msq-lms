import { sql } from 'drizzle-orm';
import { withServiceTx, withRoleTx, type RoleTxContext } from '@platform/db';
import type { FieldMappingsConfig } from '../config/meta.config.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';

// Decrypts the at-rest secrets (app_secret, access_token) on a raw DB row.
function decryptIntegrationRow(row: MetaIntegration | undefined): MetaIntegration | null {
  if (!row) return null;
  return {
    ...row,
    app_secret: decryptSecret(row.app_secret),
    access_token: decryptSecret(row.access_token),
  };
}

// drizzle's sql`` template spreads JS arrays into comma-joined placeholders
// (built for IN (...) clauses) — interpolating an empty array produces the
// invalid literal `()` instead of an empty postgres array. Render as a
// Postgres array-literal string instead so it binds as a single parameter.
function toUuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(',')}}`;
}

export interface MetaIntegration {
  id: string;
  tenant_id: string | null;
  app_secret: string;
  verify_token: string;
  pixel_id: string;
  access_token: string;
  graph_api_version: string;
  is_active: boolean;
  capi_trigger_stages: string[];
  field_mappings: FieldMappingsConfig | null;
}

// Used by the webhook (integrationId in the URL identifies the tenant's app).
export async function getIntegrationById(integrationId: string): Promise<MetaIntegration | null> {
  return withServiceTx(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, tenant_id, app_secret, verify_token, pixel_id, access_token,
                 graph_api_version, is_active, capi_trigger_stages, field_mappings
          FROM ext.meta_tenant_config
          WHERE id = ${integrationId} AND is_active = true
          LIMIT 1`,
    );
    return decryptIntegrationRow((rows as unknown as MetaIntegration[])[0]);
  });
}

// Used by the tenant-less webhook (POST /webhook, no :integrationId — a
// shared Meta App covering multiple tenants). At most one such row can
// exist (enforced by uix_meta_tenant_config_one_shared in db_scripts/01_init-db.sql).
export async function getGlobalIntegration(): Promise<MetaIntegration | null> {
  return withServiceTx(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, tenant_id, app_secret, verify_token, pixel_id, access_token,
                 graph_api_version, is_active, capi_trigger_stages, field_mappings
          FROM ext.meta_tenant_config
          WHERE tenant_id IS NULL AND is_active = true
          LIMIT 1`,
    );
    return decryptIntegrationRow((rows as unknown as MetaIntegration[])[0]);
  });
}

// Used by CAPI outbound (resolving a tenant's credentials to send a conversion event).
// Falls back to the shared-app row when the tenant has no dedicated app of
// its own (its leads arrived via the tenant-less webhook).
export async function getIntegrationByTenantId(tenantId: string): Promise<MetaIntegration | null> {
  const own = await withServiceTx(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, tenant_id, app_secret, verify_token, pixel_id, access_token,
                 graph_api_version, is_active, capi_trigger_stages, field_mappings
          FROM ext.meta_tenant_config
          WHERE tenant_id = ${tenantId}
          LIMIT 1`,
    );
    return decryptIntegrationRow((rows as unknown as MetaIntegration[])[0]);
  });
  return own ?? getGlobalIntegration();
}

export interface CreateIntegrationInput {
  tenant_id: string;
  app_secret: string;
  verify_token: string;
  pixel_id: string;
  access_token: string;
  graph_api_version?: string | undefined;
  capi_trigger_stages?: string[] | undefined;
  field_mappings?: FieldMappingsConfig | undefined;
}

export async function createIntegration(ctx: RoleTxContext, data: CreateIntegrationInput): Promise<{ id: string }> {
  const stagesLiteral = toUuidArrayLiteral(data.capi_trigger_stages ?? []);

  return withRoleTx(ctx, async (tx) => {
    const rows = await tx.execute(
      sql`INSERT INTO ext.meta_tenant_config (tenant_id, app_secret, verify_token, pixel_id, access_token, graph_api_version, capi_trigger_stages, field_mappings)
          VALUES (${data.tenant_id}::uuid, ${encryptSecret(data.app_secret)}, ${data.verify_token}, ${data.pixel_id}, ${encryptSecret(data.access_token)},
                  ${data.graph_api_version ?? 'v21.0'}, ${stagesLiteral}::uuid[],
                  ${data.field_mappings ? JSON.stringify(data.field_mappings) : null}::jsonb)
          RETURNING id`,
    );
    return (rows as unknown as Array<{ id: string }>)[0]!;
  });
}

export interface UpdateIntegrationInput {
  app_secret?: string | undefined;
  verify_token?: string | undefined;
  pixel_id?: string | undefined;
  access_token?: string | undefined;
  graph_api_version?: string | undefined;
  is_active?: boolean | undefined;
  capi_trigger_stages?: string[] | undefined;
  field_mappings?: FieldMappingsConfig | undefined;
}

export async function updateIntegration(ctx: RoleTxContext, data: UpdateIntegrationInput): Promise<void> {
  const stagesLiteral = toUuidArrayLiteral(data.capi_trigger_stages ?? []);

  await withRoleTx<void>(ctx, async (tx) => {
    await tx.execute(
      sql`UPDATE ext.meta_tenant_config
          SET updated_at = NOW(),
              app_secret         = COALESCE(${data.app_secret ? encryptSecret(data.app_secret) : null},     app_secret),
              verify_token       = COALESCE(${data.verify_token ?? null},       verify_token),
              pixel_id           = COALESCE(${data.pixel_id ?? null},           pixel_id),
              access_token       = COALESCE(${data.access_token ? encryptSecret(data.access_token) : null}, access_token),
              graph_api_version  = COALESCE(${data.graph_api_version ?? null},  graph_api_version),
              is_active          = COALESCE(${data.is_active ?? null},          is_active),
              capi_trigger_stages = CASE
                WHEN ${data.capi_trigger_stages !== undefined} THEN ${stagesLiteral}::uuid[]
                ELSE capi_trigger_stages
              END,
              field_mappings = CASE
                WHEN ${data.field_mappings !== undefined} THEN ${data.field_mappings ? JSON.stringify(data.field_mappings) : null}::jsonb
                ELSE field_mappings
              END
          WHERE tenant_id = ${ctx.tenant_id}::uuid`,
    );
  });
}
