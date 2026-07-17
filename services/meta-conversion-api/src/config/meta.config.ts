interface ContactMappings {
  phone: string[];
  email: string[];
  first_name: string[];
  last_name: string[];
  full_name: string[];
  whatsapp_number: string[];
}

interface AddressMappings {
  street_address: string[];
  city: string[];
  state: string[];
  province: string[];
  country: string[];
  postal_code: string[];
  zip_code: string[];
}

interface ProfessionalMappings {
  job_title: string[];
  company_name: string[];
  work_email: string[];
  work_phone_number: string[];
}

interface DemographicsMappings {
  date_of_birth: string[];
  gender: string[];
  marital_status: string[];
  relationship_status: string[];
  military_status: string[];
}

// Per-tenant override shape, persisted as JSONB on ext.meta_tenant_config.field_mappings.
// Any category/key a tenant omits falls back to DEFAULT_FIELD_MAPPINGS below.
export interface FieldMappingsConfig {
  contact?: {
    phone?: string[] | undefined;
    email?: string[] | undefined;
    first_name?: string[] | undefined;
    last_name?: string[] | undefined;
    full_name?: string[] | undefined;
    whatsapp_number?: string[] | undefined;
  } | undefined;
  address?: {
    street_address?: string[] | undefined;
    city?: string[] | undefined;
    state?: string[] | undefined;
    province?: string[] | undefined;
    country?: string[] | undefined;
    postal_code?: string[] | undefined;
    zip_code?: string[] | undefined;
  } | undefined;
  professional?: {
    job_title?: string[] | undefined;
    company_name?: string[] | undefined;
    work_email?: string[] | undefined;
    work_phone_number?: string[] | undefined;
  } | undefined;
  demographics?: {
    date_of_birth?: string[] | undefined;
    gender?: string[] | undefined;
    marital_status?: string[] | undefined;
    relationship_status?: string[] | undefined;
    military_status?: string[] | undefined;
  } | undefined;
}

export interface ResolvedFieldMappings {
  contact: ContactMappings;
  address: AddressMappings;
  professional: ProfessionalMappings;
  demographics: DemographicsMappings;
}

// Default field-key candidates used when a tenant has not configured custom
// field_mappings on ext.meta_tenant_config. Each db column maps to an ordered
// list of Meta form field keys to try.
export const DEFAULT_FIELD_MAPPINGS: ResolvedFieldMappings = {
  contact: {
    phone: ['phone', 'phone_number', 'mobile_number'],
    email: ['email'],
    first_name: ['first_name'],
    last_name: ['last_name'],
    full_name: ['full_name'],
    whatsapp_number: ['whatsapp_number'],
  },
  address: {
    street_address: ['street_address'],
    city: ['city'],
    state: ['state'],
    province: ['province'],
    country: ['country'],
    postal_code: ['postal_code'],
    zip_code: ['zip_code'],
  },
  professional: {
    job_title: ['job_title'],
    company_name: ['company_name'],
    work_email: ['work_email'],
    work_phone_number: ['work_phone_number'],
  },
  demographics: {
    date_of_birth: ['date_of_birth'],
    gender: ['gender'],
    marital_status: ['marital_status'],
    relationship_status: ['relationship_status'],
    military_status: ['military_status'],
  },
};

export const metaConfig = {
  graph_api: {
    base_url: 'https://graph.facebook.com',
    lead_fields: [
      'field_data', 'ad_id', 'adset_id', 'campaign_id', 'form_id', 'id', 'created_time',
    ],
  },

  capi: {
    endpoint_template: 'https://graph.facebook.com/{api_version}/{pixel_id}/events',
    default_event_name: 'Lead',
    supported_action_sources: [
      'website', 'app', 'phone_call', 'chat', 'email', 'other', 'system_generated',
    ],
  },

  dedup_window_seconds: 3600,
} as const;

function pick(value: string[] | undefined, fallback: string[]): string[] {
  return value && value.length > 0 ? value : fallback;
}

/**
 * Merge a tenant's stored field_mappings (from ext.meta_tenant_config.field_mappings)
 * over the hardcoded defaults. Any category/key the tenant has not overridden
 * falls back to DEFAULT_FIELD_MAPPINGS — this is what makes mapping changes
 * deployable without a restart (PATCH /integration updates the DB row).
 */
export function resolveFieldMappings(orgMappings: FieldMappingsConfig | null | undefined): ResolvedFieldMappings {
  if (!orgMappings) return DEFAULT_FIELD_MAPPINGS;
  const { contact: c, address: a, professional: p, demographics: d } = orgMappings;
  const D = DEFAULT_FIELD_MAPPINGS;
  return {
    contact: {
      phone: pick(c?.phone, D.contact.phone),
      email: pick(c?.email, D.contact.email),
      first_name: pick(c?.first_name, D.contact.first_name),
      last_name: pick(c?.last_name, D.contact.last_name),
      full_name: pick(c?.full_name, D.contact.full_name),
      whatsapp_number: pick(c?.whatsapp_number, D.contact.whatsapp_number),
    },
    address: {
      street_address: pick(a?.street_address, D.address.street_address),
      city: pick(a?.city, D.address.city),
      state: pick(a?.state, D.address.state),
      province: pick(a?.province, D.address.province),
      country: pick(a?.country, D.address.country),
      postal_code: pick(a?.postal_code, D.address.postal_code),
      zip_code: pick(a?.zip_code, D.address.zip_code),
    },
    professional: {
      job_title: pick(p?.job_title, D.professional.job_title),
      company_name: pick(p?.company_name, D.professional.company_name),
      work_email: pick(p?.work_email, D.professional.work_email),
      work_phone_number: pick(p?.work_phone_number, D.professional.work_phone_number),
    },
    demographics: {
      date_of_birth: pick(d?.date_of_birth, D.demographics.date_of_birth),
      gender: pick(d?.gender, D.demographics.gender),
      marital_status: pick(d?.marital_status, D.demographics.marital_status),
      relationship_status: pick(d?.relationship_status, D.demographics.relationship_status),
      military_status: pick(d?.military_status, D.demographics.military_status),
    },
  };
}
