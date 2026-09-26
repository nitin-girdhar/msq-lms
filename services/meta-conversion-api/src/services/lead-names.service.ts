import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import { fetchAdMeta, fetchAdsetMeta, fetchFormMeta } from './meta-api.service.js';
import type { RuleMatchField } from './campaign-mapping.service.js';

// ── The per-lead names the ordered campaign-type rules match on (1.51.0) ─────
//
// A lead carries form_id / adset_id / ad_id, never their names. A rule on
// `form_name`, `adset_name` or `ad_name` needs the name, so this resolves it:
// ext.meta_forms / ext.meta_adsets / ext.meta_ads first (the cache), and a
// single short Graph call for an id seen for the FIRST time — and only when the
// tenant actually has a live rule on that field. A tenant with no ad-name rules
// never pays a Graph call to learn an ad name.
//
// Best-effort end to end, like campaign typing: every failure yields a null
// name, never an error. The lead is not lost over a name.
//
// Runs on withServiceTx: it is part of the intake of a lead that arrived with no
// session. The tenant is written explicitly on every cache row, and an existing
// row owned by another tenant is never overwritten (WHERE on the upsert).

export interface LeadIdsForNames {
  page_id?: string | null | undefined;
  form_id?: string | null | undefined;
  adset_id?: string | null | undefined;
  ad_id?: string | null | undefined;
  /** Already known (the lead pull stages it) — skips the lookup entirely. */
  form_name?: string | null | undefined;
}

export interface LeadNames {
  formName: string | null;
  adsetName: string | null;
  adName: string | null;
}

export interface GraphCredentials {
  accessToken?: string | undefined;
  graphApiVersion?: string | undefined;
}

const NAME_LOOKUP = { maxAttempts: 1, timeoutMs: 3_000 } as const;

function digits(value: string | null | undefined): string | null {
  return value && /^\d+$/.test(value) ? value : null;
}

export async function resolveLeadNames(
  tenantId: string,
  lead: LeadIdsForNames,
  fields: Set<RuleMatchField>,
  creds: GraphCredentials,
): Promise<LeadNames> {
  const formId = fields.has('form_name') && !lead.form_name ? digits(lead.form_id) : null;
  const adsetId = fields.has('adset_name') ? digits(lead.adset_id) : null;
  const adId = fields.has('ad_name') ? digits(lead.ad_id) : null;

  const names: LeadNames = { formName: lead.form_name ?? null, adsetName: null, adName: null };
  if (!formId && !adsetId && !adId) return names;

  const cached = (await withServiceTx((tx) => tx.execute(sql`
    SELECT
      (SELECT name FROM ext.meta_forms  WHERE ${formId}::text  IS NOT NULL AND form_id       = ${formId}::bigint)  AS form_name,
      (SELECT name FROM ext.meta_adsets WHERE ${adsetId}::text IS NOT NULL AND meta_adset_id = ${adsetId}::bigint) AS adset_name,
      (SELECT name FROM ext.meta_ads    WHERE ${adId}::text    IS NOT NULL AND meta_ad_id    = ${adId}::bigint)    AS ad_name
  `))) as unknown as Array<{ form_name: string | null; adset_name: string | null; ad_name: string | null }>;

  names.formName = names.formName ?? cached[0]?.form_name ?? null;
  names.adsetName = cached[0]?.adset_name ?? null;
  names.adName = cached[0]?.ad_name ?? null;

  if (!creds.accessToken || !creds.graphApiVersion) return names;
  const token = creds.accessToken;
  const version = creds.graphApiVersion;

  // Graph calls OUTSIDE any transaction, in parallel — they are independent.
  const [form, adset, ad] = await Promise.all([
    formId && !names.formName ? fetchFormMeta(formId, token, version, NAME_LOOKUP) : Promise.resolve(null),
    adsetId && !names.adsetName ? fetchAdsetMeta(adsetId, token, version, NAME_LOOKUP) : Promise.resolve(null),
    adId && !names.adName ? fetchAdMeta(adId, token, version, NAME_LOOKUP) : Promise.resolve(null),
  ]);
  if (!form && !adset && !ad) return names;

  if (form?.name) names.formName = form.name;
  if (adset?.name) names.adsetName = adset.name;
  if (ad?.name) names.adName = ad.name;

  // Cache what came back. ON CONFLICT ... WHERE the row is this tenant's: the
  // natural ids are globally unique, and a row another tenant owns is left alone.
  await withServiceTx(async (tx) => {
    const pageForForm = digits(form?.page_id) ?? digits(lead.page_id);
    if (form && pageForForm) {
      await tx.execute(sql`
        INSERT INTO ext.meta_forms (tenant_id, page_id, form_id, name, status, last_synced_at)
        VALUES (${tenantId}::uuid, ${pageForForm}::bigint, ${form.form_id}::bigint, ${form.name}, ${form.status}, NOW())
        ON CONFLICT (form_id) DO UPDATE
          SET name = COALESCE(EXCLUDED.name, ext.meta_forms.name),
              status = COALESCE(EXCLUDED.status, ext.meta_forms.status),
              last_synced_at = NOW(), updated_at = NOW()
          WHERE ext.meta_forms.tenant_id = EXCLUDED.tenant_id
      `);
    }
    if (adset) {
      await tx.execute(sql`
        INSERT INTO ext.meta_adsets (tenant_id, meta_adset_id, meta_campaign_id, name, promoted_page_id, effective_status, last_synced_at)
        VALUES (${tenantId}::uuid, ${adset.adset_id}::bigint, ${digits(adset.campaign_id)}::bigint, ${adset.name},
                ${digits(adset.promoted_page_id)}::bigint, ${adset.effective_status}, NOW())
        ON CONFLICT (meta_adset_id) DO UPDATE
          SET name = COALESCE(EXCLUDED.name, ext.meta_adsets.name),
              promoted_page_id = COALESCE(EXCLUDED.promoted_page_id, ext.meta_adsets.promoted_page_id),
              effective_status = COALESCE(EXCLUDED.effective_status, ext.meta_adsets.effective_status),
              last_synced_at = NOW(), updated_at = NOW()
          WHERE ext.meta_adsets.tenant_id = EXCLUDED.tenant_id
      `);
    }
    if (ad) {
      await tx.execute(sql`
        INSERT INTO ext.meta_ads (tenant_id, meta_ad_id, meta_adset_id, meta_campaign_id, name, effective_status, last_synced_at)
        VALUES (${tenantId}::uuid, ${ad.ad_id}::bigint, ${digits(ad.adset_id)}::bigint, ${digits(ad.campaign_id)}::bigint,
                ${ad.name}, ${ad.effective_status}, NOW())
        ON CONFLICT (meta_ad_id) DO UPDATE
          SET name = COALESCE(EXCLUDED.name, ext.meta_ads.name),
              effective_status = COALESCE(EXCLUDED.effective_status, ext.meta_ads.effective_status),
              last_synced_at = NOW(), updated_at = NOW()
          WHERE ext.meta_ads.tenant_id = EXCLUDED.tenant_id
      `);
    }
  }).catch(() => undefined); // a failed cache write costs one extra lookup next time, nothing more

  return names;
}
