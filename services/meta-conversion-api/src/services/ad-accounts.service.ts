import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import { NotFoundError } from '../lib/errors.js';
import { getGlobalIntegration } from './integration.service.js';
import { listAdAccounts } from './meta-api.service.js';

// ── Ad accounts under the SHARED Meta integration (1.51.0) ───────────────────
//
// ext.meta_ad_accounts is platform-level: no tenant_id, because one ad account
// carries campaigns for several tenants' pages (tenancy is decided per campaign,
// by page — see campaign-sync.service.ts). Its RLS is enabled with NO app-role
// policy, so every statement here runs on withServiceTx. That is a documented
// SYSTEM operation reachable only from super_admin routes: the controller checks
// RANKS.SUPER_ADMIN before calling anything in this module, and the gateway's
// superAdminGuard refuses everyone else first. The rows hold no lead data and no
// credential — an id, a name, a status and an enable flag.

export interface AdAccountRow {
  ad_account_id: string;
  name: string | null;
  business_name: string | null;
  account_status: number | null;
  is_enabled: boolean;
  last_synced_at: string | null;
  last_seen_at: string | null;
}

export async function listAdAccountRows(): Promise<AdAccountRow[]> {
  return (await withServiceTx((tx) => tx.execute(sql`
    SELECT ad_account_id, name, business_name, account_status, is_enabled,
           last_synced_at, last_seen_at
    FROM ext.meta_ad_accounts
    ORDER BY is_enabled DESC, name NULLS LAST, ad_account_id
  `))) as unknown as AdAccountRow[];
}

export interface AdAccountSyncResult {
  seen: number;
  added: number;
  accounts: AdAccountRow[];
}

/**
 * Refreshes the list from `GET /me/adaccounts` on the shared token. New accounts
 * arrive DISABLED — walking an account nobody chose would spend rate limit on
 * campaigns no tenant runs — and existing ones keep their enable flag.
 */
export async function syncAdAccountsFromMeta(): Promise<AdAccountSyncResult> {
  const integration = await getGlobalIntegration();
  if (!integration || !integration.is_active) {
    throw new NotFoundError('No active shared Meta integration is configured');
  }

  const accounts = await listAdAccounts(integration.access_token, integration.graph_api_version);

  const added = await withServiceTx(async (tx) => {
    let n = 0;
    for (const a of accounts) {
      const rows = (await tx.execute(sql`
        INSERT INTO ext.meta_ad_accounts (ad_account_id, name, business_name, account_status, is_enabled, last_seen_at)
        VALUES (${a.ad_account_id}, ${a.name}, ${a.business_name}, ${a.account_status}, FALSE, NOW())
        ON CONFLICT (ad_account_id) DO UPDATE
          SET name = EXCLUDED.name,
              business_name = EXCLUDED.business_name,
              account_status = EXCLUDED.account_status,
              last_seen_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `)) as unknown as Array<{ inserted: boolean }>;
      if (rows[0]?.inserted) n += 1;
    }
    return n;
  });

  return { seen: accounts.length, added, accounts: await listAdAccountRows() };
}

export async function setAdAccountEnabled(adAccountId: string, isEnabled: boolean): Promise<AdAccountRow> {
  const rows = (await withServiceTx((tx) => tx.execute(sql`
    UPDATE ext.meta_ad_accounts
    SET is_enabled = ${isEnabled}, updated_at = NOW()
    WHERE ad_account_id = ${adAccountId}
    RETURNING ad_account_id, name, business_name, account_status, is_enabled, last_synced_at, last_seen_at
  `))) as unknown as AdAccountRow[];
  if (!rows[0]) throw new NotFoundError('Ad account not found — sync the list from Meta first');
  return rows[0];
}
