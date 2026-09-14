import { sql } from 'drizzle-orm';
import { withServiceTx } from '@platform/db';
import { resolveFieldMappings, type FieldMappingsConfig, type ResolvedFieldMappings } from '../config/meta.config.js';
import { createIntakeLead } from '../lib/internal-leads-client.js';
import { fetchCampaign } from './meta-api.service.js';
import {
  campaignIsUnknown,
  resolveFormDefaultType,
  fetchCampaignMetadataCached,
  resolveCampaignType,
  type MetaCampaignMetadata,
  type ResolvedCampaignType,
} from './campaign-mapping.service.js';

export interface MetaLeadFieldData {
  name: string;
  values: string[];
}

export type MetaLeadPlatform = 'fb' | 'ig' | 'wa';

export interface RawMetaLead {
  id: string;
  form_id: string;
  page_id: string;
  platform: MetaLeadPlatform;
  created_time?: number | undefined;
  ad_id?: string | undefined;
  adset_id?: string | undefined;
  campaign_id?: string | undefined;
  field_data: MetaLeadFieldData[];
}

const PLATFORM_TO_LEAD_SOURCE: Record<MetaLeadPlatform, string> = {
  fb: 'facebook',
  ig: 'instagram',
  wa: 'whatsapp',
};

/**
 * Meta returns `platform` per-lead ("fb" | "ig", and for WhatsApp-originated leads
 * some value we haven't confirmed yet against a live payload). That per-lead value
 * is the source of truth for what channel a lead actually came in on — a single
 * form/campaign can run across Facebook, Instagram, and WhatsApp placements at once,
 * so the static per-(page,form) `ext.meta_page_form_org_map.platform` config value is
 * only a fallback for when Meta omits the field or returns something we don't
 * recognize yet (never crash/drop the lead over an unexpected platform string).
 */
export function resolveLeadPlatform(
  metaPlatform: string | undefined,
  fallbackPlatform: MetaLeadPlatform,
  onUnrecognized?: (rawValue: string) => void,
): MetaLeadPlatform {
  if (!metaPlatform) return fallbackPlatform;
  if (metaPlatform in PLATFORM_TO_LEAD_SOURCE) return metaPlatform as MetaLeadPlatform;
  onUnrecognized?.(metaPlatform);
  return fallbackPlatform;
}

const TEST_LEAD_VALUE_PATTERN = /test lead:/i;

/**
 * Meta's Ads Manager "Test Form" tool fires a real webhook event, but every
 * field_data value it submits is placeholder text shaped like
 * "<test lead: dummy data for full_name>". Meta exposes no dedicated test-lead
 * flag on the lead object — a missing ad_id/adset_id was considered but rejected
 * as a signal, since Meta documents it as also occurring for genuine organic
 * (non-ad) leads, which must still sync. Matching the placeholder text is the
 * only reliable signal available. Checked across all field_data entries, not
 * just full_name, since Meta stamps the same placeholder into whichever fields
 * the form has (email, phone, city, etc.).
 */
export function isMetaTestLead(fieldData: MetaLeadFieldData[]): boolean {
  return fieldData.some((f) => f.values?.some((v) => TEST_LEAD_VALUE_PATTERN.test(v)));
}

/**
 * The lms.lead_sources.name values that mean "captured by Meta itself".
 *
 * Derived from PLATFORM_TO_LEAD_SOURCE rather than written out again, because
 * this is the only place that stamps a source name on an inbound Meta lead —
 * a new platform added above must not silently fall out of the CAPI eligibility
 * check in capi-trigger.service.ts. leads-service keeps its own copy of this
 * list (it is a separate service and cannot import from here); the two are kept
 * in sync by the seed data in db_scripts/reference_data/04_lms_catalog_templates.sql.
 */
export const META_LEAD_SOURCE_NAMES: readonly string[] = Object.values(PLATFORM_TO_LEAD_SOURCE);

export interface SyncLeadResult {
  metaLeadRowId: string;
  marketingLeadId: string;
  isDuplicate: boolean;
}

function safeBigInt(value: string | undefined | null): bigint | null {
  if (value == null || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function extractFieldValue(fieldData: MetaLeadFieldData[], metaKey: string): string | undefined {
  const field = fieldData.find((f) => f.name === metaKey);
  return field?.values?.[0]?.trim() || undefined;
}

function extractByKeys(fieldData: MetaLeadFieldData[], keys: string[] | undefined): string | undefined {
  for (const key of keys ?? []) {
    const v = extractFieldValue(fieldData, key);
    if (v) return v;
  }
  return undefined;
}

function buildContactPayload(fieldData: MetaLeadFieldData[], mappings: ResolvedFieldMappings) {
  const phone = extractByKeys(fieldData, mappings.contact.phone);
  if (!phone) throw new Error('Lead payload is missing a required phone value');

  const email = extractByKeys(fieldData, mappings.contact.email) ?? null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  const fullName = extractByKeys(fieldData, mappings.contact.full_name) ?? null;

  if (fullName) {
    const parts = fullName.split(' ');
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(' ') || null;
  }

  const fnVal = extractByKeys(fieldData, mappings.contact.first_name);
  if (fnVal) firstName = fnVal;
  const lnVal = extractByKeys(fieldData, mappings.contact.last_name);
  if (lnVal) lastName = lnVal;

  const whatsappNumber = extractByKeys(fieldData, mappings.contact.whatsapp_number) ?? null;

  return { email, phone, firstName, lastName, fullName, whatsappNumber };
}

function buildAddressPayload(fieldData: MetaLeadFieldData[], mappings: ResolvedFieldMappings) {
  return {
    streetAddress: extractByKeys(fieldData, mappings.address.street_address) ?? null,
    city: extractByKeys(fieldData, mappings.address.city) ?? null,
    state: extractByKeys(fieldData, mappings.address.state) ?? null,
    province: extractByKeys(fieldData, mappings.address.province) ?? null,
    country: extractByKeys(fieldData, mappings.address.country) ?? null,
    postalCode: extractByKeys(fieldData, mappings.address.postal_code) ?? null,
    zipCode: extractByKeys(fieldData, mappings.address.zip_code) ?? null,
  };
}

function buildProfessionalPayload(fieldData: MetaLeadFieldData[], mappings: ResolvedFieldMappings) {
  return {
    jobTitle: extractByKeys(fieldData, mappings.professional.job_title) ?? null,
    companyName: extractByKeys(fieldData, mappings.professional.company_name) ?? null,
    workEmail: extractByKeys(fieldData, mappings.professional.work_email) ?? null,
    workPhoneNumber: extractByKeys(fieldData, mappings.professional.work_phone_number) ?? null,
  };
}

function buildDemographicsPayload(fieldData: MetaLeadFieldData[], mappings: ResolvedFieldMappings) {
  return {
    dateOfBirth: extractByKeys(fieldData, mappings.demographics.date_of_birth) ?? null,
    gender: extractByKeys(fieldData, mappings.demographics.gender) ?? null,
    maritalStatus: extractByKeys(fieldData, mappings.demographics.marital_status) ?? null,
    relationshipStatus: extractByKeys(fieldData, mappings.demographics.relationship_status) ?? null,
    militaryStatus: extractByKeys(fieldData, mappings.demographics.military_status) ?? null,
  };
}

function hasAnyValue(payload: Record<string, string | null>): boolean {
  return Object.values(payload).some((v) => v !== null);
}

// ── Campaign typing on the live lead path ───────────────────────────────────

/**
 * The pino child logger the webhook controller already holds. Typed structurally
 * rather than imported so this module keeps no dependency on Fastify — the same
 * reason it takes an org id instead of a request.
 */
export interface LeadSyncLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * What `syncLeadToDatabase` needs in order to TYPE a lead, as opposed to merely
 * store it.
 *
 * Every field is optional and the whole argument may be omitted: a caller that
 * cannot supply a tenant or a token still gets a lead created and routed, just
 * without a campaign type resolved here. leads-service then falls back to the
 * tenant default on its side, which is what happened for every Meta lead before
 * this phase.
 *
 * `tenantId` is a separate argument because `syncLeadToDatabase` has never taken
 * one — it is keyed on org — while every mapping lookup here is tenant-scoped.
 * The webhook controller already resolves both (from the integration for a
 * per-tenant app, from the page/form mapping for the shared one).
 */
export interface LeadSyncContext {
  tenantId?: string | undefined;
  /** Decrypted Graph token, for the one metadata call a NEW campaign costs. */
  accessToken?: string | undefined;
  graphApiVersion?: string | undefined;
  log?: LeadSyncLogger | undefined;
}

interface CampaignForIntake {
  resolved: ResolvedCampaignType | null;
  metadata: MetaCampaignMetadata | null;
}

const NO_CAMPAIGN: CampaignForIntake = { resolved: null, metadata: null };

/**
 * The campaign type for an inbound lead, and the metadata leads-service needs to
 * build the branch's `marketing.ad_campaigns` row.
 *
 * THREE THINGS THIS FUNCTION WILL NOT DO, each of them load-bearing:
 *
 *   * It will not throw. Every failure path returns nulls and the lead proceeds.
 *     The caller is mid-way through creating a real customer lead; losing it
 *     because Meta throttled a metadata lookup is strictly worse than typing it
 *     wrong for as long as it takes an admin to fix the row.
 *
 *   * It will not spend a Graph call on a campaign that already has an
 *     `ext.meta_campaigns` row. That row IS the cache, and the LRU in
 *     campaign-mapping.service.ts closes the remaining window — the burst of
 *     leads that arrives for a brand-new campaign before the first row commits.
 *     One call per NEW campaign, never per lead.
 *
 *   * It will not hold a transaction open across the Graph call. The two short
 *     transactions below straddle it deliberately.
 */
async function resolveCampaignForIntake(
  lead: RawMetaLead,
  ctx: LeadSyncContext,
): Promise<CampaignForIntake> {
  if (!ctx.tenantId) return NO_CAMPAIGN;
  const tenantId = ctx.tenantId;
  const campaignId = lead.campaign_id?.trim();

  try {
    // No campaign id at all — an organic (non-ad) lead, which Meta does deliver.
    // The form-level default is then the ONLY typing signal there is, and it
    // still has to reach leads-service, which cannot read ext.* itself.
    if (!campaignId) {
      const formDefault = await withServiceTx((tx) =>
        resolveFormDefaultType(tx, tenantId, lead.page_id, lead.form_id),
      );
      return {
        resolved: {
          campaign_type_id: null,
          mapping_status: 'unmapped',
          matched_keyword: null,
          default_campaign_type_id: formDefault,
          created: false,
        },
        metadata: null,
      };
    }

    const unknown = await withServiceTx((tx) => campaignIsUnknown(tx, campaignId));

    let metadata: MetaCampaignMetadata | null = null;
    if (unknown) {
      if (ctx.accessToken && ctx.graphApiVersion) {
        const accessToken = ctx.accessToken;
        const graphApiVersion = ctx.graphApiVersion;
        metadata = await fetchCampaignMetadataCached(campaignId, async () => {
          // ONE attempt, short timeout. This runs inside Meta's webhook delivery
          // for a real lead; graphGet's default budget (retries + backoff) could
          // hold it for a minute over a name that only labels the admin grid.
          // A miss leaves the row nameless, and the next lead for this campaign
          // or the Fetch button fills it in.
          const campaign = await fetchCampaign(campaignId, accessToken, graphApiVersion, {
            maxAttempts: 1,
            timeoutMs: 3_000,
          });
          return campaign
            ? {
                name: campaign.name,
                objective: campaign.objective,
                effective_status: campaign.effective_status,
              }
            : null;
        });
      }

      if (!metadata?.name) {
        // Not an error — the lead is fine and is about to be created. It is a
        // WARNING because the row lands `unmapped` and needs an admin, and
        // because a run of these means the token has lost ads_read or is being
        // throttled, which is worth seeing before the grid fills with them.
        ctx.log?.warn(
          {
            evt: 'webhook.campaign_name_fetch_failed',
            metaCampaignId: campaignId,
            tenantId,
            formId: lead.form_id,
          },
          'Could not resolve Meta campaign name; lead will be typed from the form/tenant default',
        );
      }
    }

    const resolved = await withServiceTx((tx) =>
      resolveCampaignType(tx, tenantId, {
        metaCampaignId: campaignId,
        metaCampaignName: metadata?.name ?? null,
        metaCampaignObjective: metadata?.objective ?? null,
        metaCampaignStatus: metadata?.effective_status ?? null,
        pageId: lead.page_id,
        formId: lead.form_id,
      }),
    );

    if (resolved.inactive_mapped_type_id) {
      // The campaign is mapped to a pool an admin has since retired. The lead is
      // routed on the form/tenant default instead — leads-service would refuse
      // the retired type and the lead would be lost — but the mapping row still
      // points at it and needs correcting on /dashboard/meta-campaigns.
      ctx.log?.warn(
        {
          evt: 'webhook.campaign_type_inactive',
          metaCampaignId: campaignId,
          tenantId,
          inactiveCampaignTypeId: resolved.inactive_mapped_type_id,
          fallbackCampaignTypeId: resolved.campaign_type_id,
        },
        'Campaign is mapped to an inactive campaign type; lead typed from the form/tenant default',
      );
    }

    if (resolved.created) {
      ctx.log?.info(
        {
          evt: 'webhook.campaign_discovered',
          metaCampaignId: campaignId,
          tenantId,
          mappingStatus: resolved.mapping_status,
          matchedKeyword: resolved.matched_keyword,
        },
        'New Meta campaign typed from an inbound lead',
      );
    }

    return { resolved, metadata };
  } catch (err) {
    // The outermost guarantee. Anything at all — a dropped connection, a
    // deleted campaign type, a malformed campaign id — lands here and the lead
    // still gets created.
    ctx.log?.warn(
      { evt: 'webhook.campaign_type_resolution_failed', err, metaCampaignId: campaignId ?? null },
      'Campaign type resolution failed; lead proceeds untyped',
    );
    return NO_CAMPAIGN;
  }
}

export async function syncLeadToDatabase(
  orgId: string,
  lead: RawMetaLead,
  orgFieldMappings?: FieldMappingsConfig | null,
  // Added, not folded into the existing three: every caller that cannot supply a
  // tenant and a token still behaves exactly as it did before this phase.
  syncContext: LeadSyncContext = {},
): Promise<SyncLeadResult> {
  const mappings = resolveFieldMappings(orgFieldMappings);
  const contact = buildContactPayload(lead.field_data, mappings);
  const address = buildAddressPayload(lead.field_data, mappings);
  const professional = buildProfessionalPayload(lead.field_data, mappings);
  const demographics = buildDemographicsPayload(lead.field_data, mappings);

  const metaLeadBigId = safeBigInt(lead.id);
  if (metaLeadBigId === null) {
    throw new Error(`Invalid Meta lead ID: "${lead.id}" is not a numeric value`);
  }

  // Dedup: check if this Meta lead was already synced (fast read-only check)
  const initialCheck = (await withServiceTx(async (tx) =>
    tx.execute(sql`SELECT id, marketing_lead_id FROM ext.meta_leads WHERE meta_lead_id = ${metaLeadBigId} LIMIT 1`),
  )) as unknown as Array<{ id: string; marketing_lead_id: string }>;

  if (initialCheck[0]) {
    return {
      metaLeadRowId: initialCheck[0].id,
      marketingLeadId: initialCheck[0].marketing_lead_id,
      isDuplicate: true,
    };
  }

  const leadCreatedAt = lead.created_time ? new Date(lead.created_time * 1000) : new Date();

  // Resolved BEFORE the intake call, because the type is an input to routing:
  // leads-service picks the assignee from the (branch x type) pool, so a type
  // arriving afterwards would be a relabel, not a route. Best-effort throughout —
  // see resolveCampaignForIntake, which cannot throw.
  const campaign = await resolveCampaignForIntake(lead, syncContext);

  // Delegate lms.marketing_leads creation to the leads-service intake endpoint.
  // This is the single canonical path for lead creation — dedup, auto-assign, and
  // lead_links for superseded leads are all handled there.
  //
  // Meta only ever sends free-text city/state/country/province (no internal
  // city_id/state_id/country_id), so only the text columns are forwarded here —
  // city_id/state_id/country_id are left for manual resolution, same as any other
  // free-text intake source. The full address (including state/country/province)
  // is still preserved verbatim in ext.meta_lead_addresses below.
  const intakeResult = await createIntakeLead({
    org_id: orgId,
    first_name: contact.firstName ?? '',
    last_name: contact.lastName ?? '',
    phone: contact.phone,
    email: contact.email,
    source: PLATFORM_TO_LEAD_SOURCE[lead.platform],
    ...(address.city ? { city: address.city } : {}),
    ...(address.streetAddress ? { address_line1: address.streetAddress } : {}),
    ...((address.postalCode ?? address.zipCode) ? { pincode: (address.postalCode ?? address.zipCode)! } : {}),
    // ── Campaign attribution ──
    //
    // THE GAP THIS CLOSES. Until now campaign_id / adset_id / ad_id were written
    // into ext.meta_leads a few lines below and passed here NOWHERE — not even
    // inside metadata — so lms.marketing_leads.campaign_id was NULL for every
    // live Meta lead and the Campaign row on the lead-edit screen always read
    // "-". The receiving WebhookLeadData has accepted all of this for a while;
    // IntakeLeadPayload was the missing half.
    //
    // meta_campaign_id is what leads-service keys the branch's
    // marketing.ad_campaigns row on; the name/status are what it names and
    // statuses that row with; campaign_type_id is the routing decision made
    // above; default_campaign_type_id is the form-level fallback, forwarded
    // because leads-service deliberately never reads ext.*.
    ...(lead.campaign_id ? { meta_campaign_id: lead.campaign_id } : {}),
    ...(campaign.metadata?.name ? { meta_campaign_name: campaign.metadata.name } : {}),
    ...(campaign.metadata?.effective_status
      ? { meta_campaign_status: campaign.metadata.effective_status }
      : {}),
    meta_platform: lead.platform,
    ...(campaign.resolved?.campaign_type_id
      ? { campaign_type_id: campaign.resolved.campaign_type_id }
      : {}),
    ...(campaign.resolved?.default_campaign_type_id
      ? { default_campaign_type_id: campaign.resolved.default_campaign_type_id }
      : {}),
    // ad_id / adset_id have no typed column on a lead — they identify the
    // creative, not the campaign — but they are the first thing anyone asks for
    // when a campaign under-performs, so they travel in metadata rather than
    // being reachable only by joining back to ext.meta_leads.
    metadata: {
      meta_lead_id: lead.id,
      form_id: lead.form_id,
      platform: PLATFORM_TO_LEAD_SOURCE[lead.platform],
      ...(lead.campaign_id ? { campaign_id: lead.campaign_id } : {}),
      ...(lead.adset_id ? { adset_id: lead.adset_id } : {}),
      ...(lead.ad_id ? { ad_id: lead.ad_id } : {}),
    },
    raw_webhook_data: { field_data: lead.field_data },
  });

  const marketingLeadId = intakeResult.id;

  // Insert ext.meta_* tables inside a transaction.
  // Re-check ext.meta_leads inside the tx to handle concurrent webhook retries.
  const metaLeadRowId = await withServiceTx(async (tx) => {
    const concurrencyCheck = (await tx.execute(
      sql`SELECT id FROM ext.meta_leads WHERE meta_lead_id = ${metaLeadBigId} LIMIT 1`,
    )) as unknown as Array<{ id: string }>;

    if (concurrencyCheck[0]) return concurrencyCheck[0].id;

    const metaLeadResult = (await tx.execute(
      sql`INSERT INTO ext.meta_leads (
            org_id, marketing_lead_id, meta_lead_id, page_id, form_id, campaign_id, adset_id, ad_id,
            platform, lead_created_at, full_name, first_name, last_name, email, phone,
            whatsapp_number, raw_field_data
          ) VALUES (
            ${orgId}, ${marketingLeadId}, ${metaLeadBigId}, ${safeBigInt(lead.page_id)},
            ${safeBigInt(lead.form_id) ?? BigInt(0)},
            ${safeBigInt(lead.campaign_id)},
            ${safeBigInt(lead.adset_id)},
            ${safeBigInt(lead.ad_id)},
            ${lead.platform}, ${leadCreatedAt.toISOString()},
            ${contact.fullName}, ${contact.firstName}, ${contact.lastName},
            ${contact.email}, ${contact.phone}, ${contact.whatsappNumber},
            ${JSON.stringify(lead.field_data)}
          )
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const rowId = metaLeadResult[0]!.id;

    if (hasAnyValue(address)) {
      await tx.execute(
        sql`INSERT INTO ext.meta_lead_addresses (
              meta_lead_id, org_id, street_address, city, state, province, country, postal_code, zip_code
            ) VALUES (
              ${rowId}, ${orgId}, ${address.streetAddress}, ${address.city}, ${address.state},
              ${address.province}, ${address.country}, ${address.postalCode}, ${address.zipCode}
            )`,
      );
    }

    if (hasAnyValue(professional)) {
      await tx.execute(
        sql`INSERT INTO ext.meta_lead_professional (
              meta_lead_id, org_id, job_title, company_name, work_email, work_phone_number
            ) VALUES (
              ${rowId}, ${orgId}, ${professional.jobTitle}, ${professional.companyName},
              ${professional.workEmail}, ${professional.workPhoneNumber}
            )`,
      );
    }

    if (hasAnyValue(demographics)) {
      await tx.execute(
        sql`INSERT INTO ext.meta_lead_demographics (
              meta_lead_id, org_id, date_of_birth, gender, marital_status, relationship_status, military_status
            ) VALUES (
              ${rowId}, ${orgId}, ${demographics.dateOfBirth}, ${demographics.gender},
              ${demographics.maritalStatus}, ${demographics.relationshipStatus}, ${demographics.militaryStatus}
            )`,
      );
    }

    const knownKeys = new Set([
      ...Object.values(mappings.contact).flat(),
      ...Object.values(mappings.address).flat(),
      ...Object.values(mappings.professional).flat(),
      ...Object.values(mappings.demographics).flat(),
    ]);

    const customFields = lead.field_data
      .filter((f) => !knownKeys.has(f.name) && f.values?.[0]?.trim())
      .map((f) => ({ key: f.name, value: f.values[0]!.trim() }));

    for (const cf of customFields) {
      await tx.execute(
        sql`INSERT INTO ext.meta_lead_custom_fields (meta_lead_id, org_id, question_key, question_value)
            VALUES (${rowId}, ${orgId}, ${cf.key}, ${cf.value})
            ON CONFLICT (meta_lead_id, question_key) DO NOTHING`,
      );
    }

    return rowId;
  });

  return { metaLeadRowId, marketingLeadId, isDuplicate: false };
}
