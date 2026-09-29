import { sql } from 'drizzle-orm';
import { withServiceTx, sqlTextArr } from '@platform/db';
import { resolveFieldMappings } from '../config/meta.config.js';
import { getIntegrationByTenantId } from './integration.service.js';
import type { PullRunRow } from './lead-pull.service.js';

// ── Reconcile: what is genuinely missing from LMS vs. already present ───────
//
// A port of meta-sync-scripts/common/reconcile.py::classify, VERDICT FOR
// VERDICT and IN ORDER. Order matters and mirrors the import path: identity
// dedup first (cheapest and most decisive), then routability, then
// extractability, then the org-level person dedup that the canonical write path
// performs. A verdict here is a genuine PREDICTION of what applying the lead
// would do, not an approximation — which is the only reason a preview screen is
// worth showing at all.
//
// SET-BASED rather than the Python's row-at-a-time loop. A pull stages
// thousands of rows and the two dedup probes are indexed lookups into
// lms.marketing_leads; doing them one HTTP-less round trip at a time was
// tolerable for a CLI and is not for a button. The CASE below preserves the
// ladder exactly.
//
// ── THE ONE DELIBERATE BEHAVIOUR CHANGE ────────────────────────────────────
//
// `hiring_form` WAS a SKIP verdict in the Python, because recruitment forms
// share the Pages that carry sales campaigns and there was nowhere to route a
// job applicant — a hiring lead in lms.marketing_leads was simply wrong. After
// the campaign-type work (schema 1.49.0) there IS somewhere: a type carries a
// department and routes to that branch's pool.
//
// So hiring_form stops being a verdict and becomes a SIGNAL: `is_hiring_form`
// plus `suggested_campaign_type_id` (whatever marketing.fn_match_campaign_type
// matches on the form NAME). The lead classifies and imports normally, and the
// admin is told which forms look like recruitment and what type they would
// match — the actual fix being to set
// ext.meta_page_form_org_map.default_campaign_type_id, which is the signal
// syncLeadToDatabase already reads on the apply path.
//
// THIS CHANGES WHAT GETS IMPORTED: leads on hiring forms that the Python
// discarded will now be applied. That is the intent, and it is flagged here,
// in schema_version 1.50.0 and in the table comments rather than being left to
// be discovered in a diff.

/** The verdicts the apply stage acts on. */
export const IMPORTABLE_VERDICTS = ['new', 'phone_duplicate', 'email_duplicate'] as const;

// The two duplicate verdicts are importable ON PURPOSE, matching the Python's
// reasoning: the canonical write path supersedes on a phone match and returns
// the existing lead on an email match, and EITHER WAY an ext.meta_leads row is
// written against the resulting marketing_lead_id — which is exactly what stops
// the lead being re-fetched by every future pull. Dropping them would make each
// pull re-surface the same leads forever.

/** Meta's Lead Ads Testing Tool stamps this placeholder into whichever fields a form has. */
const TEST_LEAD_PATTERN = 'test lead:';

// Deliberately NARROW, copied from reconcile.py's HIRING_FORM_PATTERN: it keys
// on explicit recruitment words only. Broader guesses were tried and rejected —
// a bare "trainer" or "PT" matches genuine personal-training SALES forms, and
// mistyping a real sales lead is worse than missing the hint on an oddly-named
// hiring form.
const HIRING_FORM_PATTERN = 'hiring|recruit|vacancy|career|job application|sales exe';

export type Verdict =
  | 'already_synced'
  | 'test_lead'
  | 'unmapped_form'
  | 'missing_contact'
  | 'phone_duplicate'
  | 'email_duplicate'
  | 'new';

/**
 * Classifies every staged row of one run, in place, and returns the tallies.
 *
 * RUNS ON withServiceTx (BYPASSRLS), and that is a DOCUMENTED SYSTEM OPERATION
 * rather than an oversight. Two of the three tables it reads cannot be reached
 * any other way from here:
 *
 *   * ext.meta_leads is ORG-scoped (its app_user policy keys on
 *     app.current_org_id) and this pass spans every branch in the tenant at
 *     once, with no single current org. Under withTenantConfigTx it would read
 *     ZERO ROWS WITH NO ERROR — and a zero-row `already_synced` probe does not
 *     fail loudly, it silently reclassifies every already-imported lead as
 *     `new` and offers to import the tenant's whole back-catalogue a second
 *     time. This is the same reason syncLeadToDatabase's own dedup check sits
 *     on withServiceTx.
 *   * lms.marketing_leads is likewise org-scoped, and the phone/email dedup
 *     must be judged against the org the STAGED ROW names, not a session org.
 *
 * Tenant containment therefore rests on the WHERE clause here rather than on a
 * policy, so it is written to be checkable: every statement is scoped by
 * `run_id`, a run belongs to exactly one tenant, and each row's dedup probes
 * are correlated to that row's OWN org_id — which the staging INSERT already
 * proved belongs to the run's tenant, via scratch.meta_pull_leads'
 * WITH CHECK calling entity.fn_org_tenant(). Nothing here takes an org or
 * tenant id from the request.
 */
export async function classifyRunLeads(run: PullRunRow): Promise<Record<string, number>> {
  // The tenant's own Meta field-key overrides, so "which key holds the phone"
  // is answered the same way here as in syncLeadToDatabase's
  // buildContactPayload. Getting this wrong would make the preview disagree
  // with the import, which is the one thing a preview may not do.
  const integration = await getIntegrationByTenantId(run.tenant_id);
  const mappings = resolveFieldMappings(integration?.field_mappings ?? null);

  const phoneKeys = sqlTextArr(mappings.contact.phone);
  const emailKeys = sqlTextArr(mappings.contact.email);

  return withServiceTx(async (tx) => {
    await tx.execute(sql`
      WITH contact AS (
        SELECT
          l.id,
          l.org_id,
          l.meta_lead_id,
          -- Campaign-mode pulls stage no form name (the ad edge does not carry
          -- it); fall back to the ext.meta_forms cache the form picker fills.
          COALESCE(l.form_name, (SELECT f.name FROM ext.meta_forms f WHERE f.form_id = l.form_id)) AS form_name,
          l.page_id,
          l.form_id,
          l.campaign_id,
          l.adset_id,
          l.ad_id,
          -- extractByKeys: the first candidate key with a non-empty first
          -- value wins, in the configured order. array_position reproduces
          -- that ordering; a plain ANY() would return whichever key the JSONB
          -- happened to list first.
          (SELECT btrim(f->'values'->>0)
             FROM jsonb_array_elements(COALESCE(l.raw_field_data, '[]'::jsonb)) f
            WHERE f->>'name' = ANY(${phoneKeys})
              AND btrim(COALESCE(f->'values'->>0, '')) <> ''
            ORDER BY array_position(${phoneKeys}, f->>'name')
            LIMIT 1) AS phone,
          (SELECT btrim(f->'values'->>0)
             FROM jsonb_array_elements(COALESCE(l.raw_field_data, '[]'::jsonb)) f
            WHERE f->>'name' = ANY(${emailKeys})
              AND btrim(COALESCE(f->'values'->>0, '')) <> ''
            ORDER BY array_position(${emailKeys}, f->>'name')
            LIMIT 1) AS email,
          -- Checked across ALL field_data entries, not just full_name: Meta
          -- stamps the placeholder into whichever fields the form has.
          EXISTS (
            SELECT 1
              FROM jsonb_array_elements(COALESCE(l.raw_field_data, '[]'::jsonb)) f,
                   jsonb_array_elements_text(COALESCE(f->'values', '[]'::jsonb)) v
             WHERE v ~* ${TEST_LEAD_PATTERN}
          ) AS is_test_lead
        FROM scratch.meta_pull_leads l
        WHERE l.run_id = ${run.id}::uuid
      ),
      -- Phone duplicates are matched EXACTLY, the same predicate the write path
      -- uses. Apply goes through syncLeadToDatabase -> leads-service
      -- createWebhookLead, which supersedes only on phone = (raw extracted
      -- value), see intake.repository.ts. This used to match on the last ten
      -- significant digits, so a number on file in another format was PREVIEWED
      -- as "phone_duplicate — will be superseded" and then IMPORTED as a second
      -- active lead: the preview promised something the import did not do.
      --
      -- Exact equality is the platform rule (confirmed 2026-09-13); the Python
      -- batch path (lead_writer.py, reconcile.py) was aligned to it as well.
      keyed AS (
        SELECT c.* FROM contact c
      ),
      probed AS (
        SELECT k.*,
               EXISTS (SELECT 1 FROM ext.meta_leads ml
                        WHERE ml.meta_lead_id = k.meta_lead_id) AS already_synced,
               dup_phone.id AS phone_lead_id,
               dup_email.id AS email_lead_id,
               (k.form_name ~* ${HIRING_FORM_PATTERN}) AS is_hiring_form,
               -- 1.51.0: the PREDICTED type, by the same ladder the live path
               -- applies (campaign-mapping.service.ts::resolveCampaignType):
               -- confirmed campaign type -> ordered rules on the campaign /
               -- form / ad set / ad name -> page (form-override) default ->
               -- tenant default. So the grid says which department each lead
               -- will land in BEFORE Apply, and Apply's answer matches it
               -- unless a mapping or rule is edited in between.
               COALESCE(
                 (SELECT mc.campaign_type_id
                    FROM ext.meta_campaigns mc
                    JOIN marketing.campaign_types ct
                      ON ct.id = mc.campaign_type_id AND ct.is_active AND NOT ct.is_deleted
                   WHERE mc.meta_campaign_id = k.campaign_id
                     AND mc.tenant_id = ${run.tenant_id}::uuid
                     AND mc.mapping_status = 'confirmed'),
                 (SELECT m.campaign_type_id
                    FROM marketing.fn_match_campaign_type_rules(
                      ${run.tenant_id}::uuid,
                      (SELECT mc.name FROM ext.meta_campaigns mc
                        WHERE mc.meta_campaign_id = k.campaign_id AND mc.tenant_id = ${run.tenant_id}::uuid),
                      k.form_name,
                      (SELECT s.name FROM ext.meta_adsets s WHERE s.meta_adset_id = k.adset_id),
                      (SELECT a.name FROM ext.meta_ads a WHERE a.meta_ad_id = k.ad_id)
                    ) m),
                 (SELECT pm.default_campaign_type_id
                    FROM ext.meta_page_form_org_map pm
                    JOIN marketing.campaign_types ct
                      ON ct.id = pm.default_campaign_type_id AND ct.is_active AND NOT ct.is_deleted
                   WHERE pm.tenant_id = ${run.tenant_id}::uuid AND pm.is_active
                     AND (pm.form_id = k.form_id OR (pm.form_id IS NULL AND pm.page_id = k.page_id))
                   ORDER BY (pm.form_id IS NULL) ASC, pm.created_at DESC
                   LIMIT 1),
                 (SELECT ct.id FROM marketing.campaign_types ct
                   WHERE ct.tenant_id = ${run.tenant_id}::uuid AND ct.is_default AND ct.is_active AND NOT ct.is_deleted
                   LIMIT 1)
               ) AS suggested_type
        FROM keyed k
        LEFT JOIN LATERAL (
          SELECT ml.id FROM lms.marketing_leads ml
           WHERE ml.org_id = k.org_id
             AND ml.is_active AND NOT ml.is_deleted
             AND ml.phone = k.phone
           LIMIT 1
        ) dup_phone ON k.org_id IS NOT NULL AND k.phone IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT ml.id FROM lms.marketing_leads ml
           WHERE ml.org_id = k.org_id
             AND ml.email = k.email
             AND ml.is_active AND NOT ml.is_deleted
           LIMIT 1
        ) dup_email ON k.org_id IS NOT NULL AND k.email IS NOT NULL
      )
      UPDATE scratch.meta_pull_leads t
      SET verdict = CASE
            -- The ladder, in reconcile.py's order. hiring_form is absent by
            -- design — see the module header.
            WHEN p.already_synced        THEN 'already_synced'
            WHEN p.is_test_lead          THEN 'test_lead'
            WHEN p.org_id IS NULL        THEN 'unmapped_form'
            WHEN p.phone IS NULL         THEN 'missing_contact'
            WHEN p.phone_lead_id IS NOT NULL THEN 'phone_duplicate'
            WHEN p.email_lead_id IS NOT NULL THEN 'email_duplicate'
            ELSE 'new'
          END,
          existing_lead_id = CASE
            WHEN p.already_synced OR p.is_test_lead OR p.org_id IS NULL OR p.phone IS NULL THEN NULL
            WHEN p.phone_lead_id IS NOT NULL THEN p.phone_lead_id
            ELSE p.email_lead_id
          END,
          reason = CASE
            WHEN p.already_synced        THEN 'meta_lead_id already in ext.meta_leads'
            WHEN p.is_test_lead          THEN 'Meta Lead Ads Testing Tool placeholder data'
            WHEN p.org_id IS NULL        THEN 'form ' || t.form_id::text
                                              || ' has no active ext.meta_page_form_org_map row'
            WHEN p.phone IS NULL         THEN 'no phone value in field_data for any configured phone key'
            WHEN p.phone_lead_id IS NOT NULL THEN 'phone already on an active lead for this org — it will be superseded'
            WHEN p.email_lead_id IS NOT NULL THEN 'email already on an active lead for this org — treated as a re-submission'
            ELSE NULL
          END,
          is_hiring_form = COALESCE(p.is_hiring_form, false),
          suggested_campaign_type_id = p.suggested_type
      FROM probed p
      WHERE t.id = p.id
    `);

    const rows = (await tx.execute(sql`
      SELECT verdict, COUNT(*)::int AS count
      FROM scratch.meta_pull_leads
      WHERE run_id = ${run.id}::uuid
      GROUP BY verdict
    `)) as unknown as Array<{ verdict: Verdict | null; count: number }>;

    const tallies: Record<string, number> = {};
    for (const row of rows) tallies[row.verdict ?? 'unclassified'] = row.count;
    return tallies;
  });
}
