import { sql } from 'drizzle-orm';
import { withServiceTx } from '@crm/db';
import { resolveFieldMappings, type FieldMappingsConfig, type ResolvedFieldMappings } from '../config/meta.config.js';
import { createIntakeLead } from '../lib/internal-leads-client.js';

export interface MetaLeadFieldData {
  name: string;
  values: string[];
}

export interface RawMetaLead {
  id: string;
  form_id: string;
  page_id: string;
  platform: 'fb' | 'ig';
  created_time?: number | undefined;
  ad_id?: string | undefined;
  adset_id?: string | undefined;
  campaign_id?: string | undefined;
  field_data: MetaLeadFieldData[];
}

const PLATFORM_TO_LEAD_SOURCE: Record<'fb' | 'ig', string> = {
  fb: 'facebook',
  ig: 'instagram',
};

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

export async function syncLeadToDatabase(
  orgId: string,
  lead: RawMetaLead,
  orgFieldMappings?: FieldMappingsConfig | null,
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
    metadata: { meta_lead_id: lead.id, form_id: lead.form_id, platform: PLATFORM_TO_LEAD_SOURCE[lead.platform] },
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
