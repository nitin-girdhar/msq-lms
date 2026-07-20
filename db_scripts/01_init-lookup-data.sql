-- ===================================================================
-- CRM Monorepo - Lookup / Reference Seed Data
-- Prerequisite: Run 01_init-db.sql first (schema must already exist).
-- Idempotent: safe to re-run (ON CONFLICT DO NOTHING / DO UPDATE SET)
-- ===================================================================

-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.0.0', 'Merged monorepo + EXISTING_WORKING_CODE: geo tables, soft-delete, business-rule triggers, audit triggers, service logins'),
  ('1.1.0', 'iam.user_org_mapping table, legal_entity_name/brand_name on entity.organizations, fixed multi-org RLS gaps')
ON CONFLICT (version) DO NOTHING;


-- ===================================================================
-- GEOGRAPHIC DATA
-- ===================================================================

-- ── Geographic seed data ────────────────────────────────────────────
INSERT INTO geo.countries (name, iso_code) VALUES
  ('India',                'IN'),
  ('United States',        'US'),
  ('United Kingdom',       'GB'),
  ('United Arab Emirates', 'AE')
ON CONFLICT (name) DO NOTHING;

INSERT INTO geo.states (country_id, name, code)
SELECT c.id, s.name, s.code
FROM geo.countries c
CROSS JOIN (VALUES
  ('Delhi',           'DL'),
  ('Maharashtra',     'MH'),
  ('Karnataka',       'KA'),
  ('Tamil Nadu',      'TN'),
  ('West Bengal',     'WB'),
  ('Telangana',       'TS'),
  ('Rajasthan',       'RJ'),
  ('Gujarat',         'GJ'),
  ('Uttar Pradesh',   'UP'),
  ('Haryana',         'HR'),
  ('Punjab',          'PB'),
  ('Madhya Pradesh',  'MP')
) AS s(name, code)
WHERE c.iso_code = 'IN'
ON CONFLICT (country_id, name) DO NOTHING;

INSERT INTO geo.cities (state_id, name)
SELECT s.id, c.name
FROM geo.states s
CROSS JOIN (VALUES
  ('Delhi',         'New Delhi'),
  ('Delhi',         'Dwarka'),
  ('Delhi',         'Rohini'),
  ('Delhi',         'Lajpat Nagar'),
  ('Delhi',         'Connaught Place'),
  ('Delhi',         'Saket'),
  ('Delhi',         'Janakpuri'),
  ('Uttar Pradesh', 'Lucknow'),
  ('Uttar Pradesh', 'Noida'),
  ('Uttar Pradesh', 'Agra'),
  ('Haryana',       'Gurgaon'),
  ('Haryana',       'Faridabad'),
  ('Punjab',        'Chandigarh'),
  ('Punjab',        'Amritsar')
) AS c(state_name, name)
WHERE s.name = c.state_name
ON CONFLICT (state_id, name) DO NOTHING;


-- ===================================================================
-- IAM -- USER ROLES
-- ===================================================================

INSERT INTO iam.user_roles (name, label, description, rank) VALUES
  ('read_only',               'Read Only',              'Read-only viewer — dashboards and reports only',                                    0),
  ('sales_representative',    'Sales Representative',   'Front-line sales — manages own assigned leads and follow-ups',                     20),
  ('senior_sales_executive',  'Senior Sales Executive', 'Senior Sales Executive — manages a team of sales reps; reports to org_manager',    40),
  ('org_manager',             'Manager',                'Manages a team of Senior Sales Executives and reps within an org',                 60),
  ('org_sr_manager',          'Senior Manager',         'Manages a team of managers and reps within an org',                               70),
  ('hr_admin',                'HR Admin',               'Manages HR — employee profiles, leave policies, attendance; no CRM/lead access',   75),
  ('org_admin',               'Admin',                  'Org-level admin — full control within one org',                                   80),
  ('tenant_admin',            'Tenant Admin',           'Tenant-level admin — manages all orgs under the tenant',                          90),
  ('super_admin',             'Super Admin',            'Platform-level superuser — SaaS admin only',                                     100)
ON CONFLICT (name) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  rank        = EXCLUDED.rank;


-- ===================================================================
-- CRM -- LEAD STAGES, OUTCOMES, INTERACTION TYPES, FOLLOW-UP STATUSES, SOURCES
-- ===================================================================

INSERT INTO lms.lead_stage (name, label, description, sort_order, followup_required, is_rejected, is_terminated) VALUES
  ('new',            'New',            'Lead just received — not yet contacted',                       1, FALSE, FALSE, FALSE),
  ('contacting',     'Contacting',     'Active outreach in progress — calls, WhatsApp, or email',      2, TRUE,  FALSE, FALSE),
  ('on_hold',        'On Hold',        'Follow-up temporarily paused — lead asked to be contacted later or is unreachable', 3, TRUE,  FALSE, FALSE),
  ('qualified',      'Qualified',      'Lead confirmed as a genuine prospect with intent and budget',  4, TRUE,  FALSE, FALSE),
  ('converted',      'Converted',      'Lead became a paying customer',                                5, FALSE, FALSE, TRUE),
  ('unqualified',    'Unqualified',    'Lead did not qualify — outcome and note must be recorded',     6, FALSE, TRUE,  TRUE),
  ('transferred_out','Transferred Out','Lead transferred to another org or partner',                   7, FALSE, FALSE, TRUE)
ON CONFLICT (name) DO UPDATE SET
  label             = EXCLUDED.label,
  description       = EXCLUDED.description,
  sort_order        = EXCLUDED.sort_order,
  followup_required = EXCLUDED.followup_required,
  is_rejected       = EXCLUDED.is_rejected,
  is_terminated     = EXCLUDED.is_terminated;

-- Seed all outcomes using name subqueries (never hardcoded IDs)
DO $$
DECLARE
  v_contacting  UUID;
  v_on_hold     UUID;
  v_qualified   UUID;
  v_converted   UUID;
  v_unqualified UUID;
  v_transferred UUID;
BEGIN
  SELECT id INTO v_contacting  FROM lms.lead_stage WHERE name = 'contacting';
  SELECT id INTO v_on_hold     FROM lms.lead_stage WHERE name = 'on_hold';
  SELECT id INTO v_qualified   FROM lms.lead_stage WHERE name = 'qualified';
  SELECT id INTO v_converted   FROM lms.lead_stage WHERE name = 'converted';
  SELECT id INTO v_unqualified FROM lms.lead_stage WHERE name = 'unqualified';
  SELECT id INTO v_transferred FROM lms.lead_stage WHERE name = 'transferred_out';

  -- contacting outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, requires_comment, sort_order) VALUES
    (v_contacting, 'not_connected',   'Not Connected',   FALSE, 1),
    (v_contacting, 'switch_off',      'Switch Off',      FALSE, 2),
    (v_contacting, 'not_answered',    'Not Answered',    FALSE, 3),
    (v_contacting, 'call_back_later', 'Call Back Later', FALSE, 4),
    (v_contacting, 'other',           'Other',           TRUE,  5)
  ON CONFLICT (stage_id, name) DO NOTHING;

  -- on_hold outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, sort_order) VALUES
    (v_on_hold, 'on_hold', 'On Hold', 1)
  ON CONFLICT (stage_id, name) DO NOTHING;

  -- qualified outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, requires_comment, sort_order) VALUES
    (v_qualified, 'visit_scheduled', 'Visit Scheduled', FALSE, 1),
    (v_qualified, 'visited',         'Visited',         FALSE, 2),
    (v_qualified, 'other',           'Other',           TRUE,  3)
  ON CONFLICT (stage_id, name) DO NOTHING;

  -- converted outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, requires_comment, sort_order) VALUES
    (v_converted, 'membership_sold', 'Membership Sold', FALSE, 1),
    (v_converted, 'other',           'Other',           TRUE,  2)
  ON CONFLICT (stage_id, name) DO NOTHING;

  -- unqualified outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, requires_comment, sort_order) VALUES
    (v_unqualified, 'no_response_after_multiple_attempts', 'No Response After Multiple Attempts', FALSE, 1),
    (v_unqualified, 'wrong_number',                        'Wrong Number',                        FALSE, 2),
    (v_unqualified, 'job_applicant',                       'Job Applicant',                       FALSE, 3),
    (v_unqualified, 'budget_issue',                        'Budget Issue',                        FALSE, 4),
    (v_unqualified, 'not_interested',                      'Not Interested',                      FALSE, 5),
    (v_unqualified, 'location_issue',                      'Location Issue',                      FALSE, 6),
    (v_unqualified, 'duplicate_lead',                      'Duplicate Lead',                      FALSE, 7),
    (v_unqualified, 'other',                               'Other',                               TRUE,  8)
  ON CONFLICT (stage_id, name) DO NOTHING;

  -- transferred_out outcomes
  INSERT INTO lms.lead_stage_outcome (stage_id, name, label, requires_comment, sort_order) VALUES
    (v_transferred, 'transferred_to_other_branch', 'Transferred to Other Branch', FALSE, 1),
    (v_transferred, 'other',                       'Other',                       TRUE,  2)
  ON CONFLICT (stage_id, name) DO NOTHING;
END;
$$;

-- ===================================================================
-- EXT -- META CAPI EVENT TYPES + LEAD STAGE -> CAPI EVENT MAPPING
-- ===================================================================

INSERT INTO ext.meta_capi_event_types (code, label, sort_order) VALUES
  ('Other',         'Other',           1),
  ('ConvertedLead', 'Converted Lead',  2),
  ('QualifiedLead', 'Qualified Lead',  3)
ON CONFLICT (code) DO UPDATE SET
  label      = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order;

-- Wire each lead_stage to its Meta CAPI event by id (never by name-string
-- comparison at request time — this join is one-time seed wiring only).
-- Stages not listed here ('new', 'unqualified') get no row, so no CAPI
-- event fires when a lead transitions into them.
INSERT INTO ext.lead_stage_capi_event_map (stage_id, capi_event_type_id)
SELECT ls.id, et.id
FROM (VALUES
  ('contacting',      'Other'),
  ('on_hold',         'Other'),
  ('qualified',       'QualifiedLead'),
  ('converted',       'ConvertedLead'),
  ('transferred_out', 'Other')
) AS m(stage_name, event_code)
JOIN lms.lead_stage ls            ON ls.name = m.stage_name
JOIN ext.meta_capi_event_types et ON et.code = m.event_code
ON CONFLICT (stage_id) DO UPDATE SET
  capi_event_type_id = EXCLUDED.capi_event_type_id;

INSERT INTO lms.interaction_types (name, label, description) VALUES
  ('call',          'Call',          'Outbound or inbound phone call'),
  ('whatsapp',      'WhatsApp',      'WhatsApp message (text, audio, or media)'),
  ('email',         'Email',         'Email sent or received'),
  ('sms',           'SMS',           'SMS or text message'),
  ('in_person',     'In Person',     'Face-to-face meeting at store, office, or event'),
  ('video_call',    'Video Call',    'Video call via Zoom, Google Meet, WhatsApp Video, etc.'),
  ('chat',          'Chat',          'Live chat on website or social media platform'),
  ('internal_note', 'Internal Note', 'Internal note or annotation added by a team member')
ON CONFLICT (name) DO NOTHING;

INSERT INTO lms.follow_up_statuses (name, label, description) VALUES
  ('pending',     'Pending',     'Follow-up scheduled and not yet actioned'),
  ('completed',   'Completed',   'Follow-up actioned within the scheduled window'),
  ('missed',      'Missed',      'Follow-up was not actioned before the scheduled time'),
  ('rescheduled', 'Rescheduled', 'Follow-up postponed to a new scheduled_at datetime')
ON CONFLICT (name) DO NOTHING;


-- ===================================================================
-- MARKETING -- PLATFORMS & CAMPAIGN STATUSES
-- ===================================================================

INSERT INTO marketing.marketing_platforms (name, label, description) VALUES
  ('facebook',     'Facebook',     'Facebook / Instagram Lead Ads and Campaigns'),
  ('google',       'Google',       'Google Ads (Search, Display, Shopping, Performance Max)'),
  ('instagram',    'Instagram',    'Instagram organic and paid posts'),
  ('youtube',      'YouTube',      'YouTube video ads'),
  ('whatsapp',     'WhatsApp',     'WhatsApp click-to-chat ads via Facebook Ads Manager'),
  ('linkedin',     'LinkedIn',     'LinkedIn Lead Gen Forms and sponsored content'),
  ('tiktok',       'TikTok',       'TikTok for Business lead generation'),
  ('organic',      'Organic',      'Walk-in, direct website, or offline enquiry with no paid source'),
  ('referral',     'Referral',     'Referred by an existing customer or partner'),
  ('whatsapp_ads', 'WhatsApp Ads', 'WhatsApp click-to-chat ads via Facebook Ads Manager (legacy alias)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO marketing.campaign_statuses (name, label, description) VALUES
  ('draft',     'Draft',     'Campaign created but not yet submitted for review or activation'),
  ('active',    'Active',    'Campaign is live and currently running'),
  ('paused',    'Paused',    'Campaign temporarily paused; can be resumed'),
  ('completed', 'Completed', 'Campaign ran its full duration and ended normally'),
  ('archived',  'Archived',  'Campaign permanently closed and moved to archive')
ON CONFLICT (name) DO NOTHING;


-- ===================================================================
-- ENTITY -- ORG TYPES, TENANT DOMAINS, TENANT PLAN TYPES
-- ===================================================================

INSERT INTO entity.org_types (name, label, description) VALUES
  ('gym_location', 'Gym Location', 'Physical gym or fitness centre location'),
  ('boutique',     'Boutique',     'Boutique or small retail outlet'),
  ('branch',       'Branch',       'Standard branch office of a business'),
  ('headquarters', 'Headquarters', 'Corporate headquarters or registered office'),
  ('franchise',    'Franchise',    'Franchise outlet operating under a licensor brand'),
  ('clinic',       'Clinic',       'Medical or wellness clinic unit'),
  ('warehouse',    'Warehouse',    'Storage or fulfilment centre'),
  ('showroom',     'Showroom',     'Product display and sales showroom'),
  ('head_office',  'Head Office',  'Corporate headquarters or registered office (alias)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO entity.tenant_domains (name, label, description) VALUES
  ('fitness',     'Fitness',     'Gyms, fitness centres, yoga studios, personal training'),
  ('retail',      'Retail',      'Fashion boutiques, apparel, accessories, lifestyle stores'),
  ('healthcare',  'Healthcare',  'Clinics, hospitals, diagnostic centres, healthcare providers'),
  ('education',   'Education',   'Schools, coaching centres, e-learning platforms'),
  ('hospitality', 'Hospitality', 'Hotels, resorts, restaurants, event venues'),
  ('medical',     'Medical',     'Medical practices and healthcare providers (alias for healthcare)'),
  ('real_estate', 'Real Estate', 'Property sales, rentals, property management'),
  ('automotive',  'Automotive',  'Car dealerships, service centres, vehicle rentals'),
  ('logistics',   'Logistics',   'Warehousing, freight, courier, supply chain')
ON CONFLICT (name) DO NOTHING;

INSERT INTO entity.tenant_plan_types (name, label, description) VALUES
  ('free_trial', 'Free Trial', 'Up to 3 iam.users, 1 org, 100 leads — 30-day trial'),
  ('starter',    'Starter',    'Up to 10 iam.users, 2 orgs, 1 000 leads/month'),
  ('growth',     'Growth',     'Up to 50 iam.users, 10 orgs, 10 000 leads/month, AI scoring'),
  ('enterprise', 'Enterprise', 'Unlimited iam.users and orgs, dedicated support, custom SLA')
ON CONFLICT (name) DO NOTHING;

INSERT INTO lms.lead_sources (name, label) VALUES
  ('facebook',     'Facebook'),
  ('google',       'Google'),
  ('instagram',    'Instagram'),
  ('whatsapp',     'WhatsApp'),
  ('website_form', 'Website Form'),
  ('referral',     'Referral'),
  ('walk_in',      'Walk In'),
  ('cold_call',    'Cold Call'),
  ('other',        'Other')
ON CONFLICT (name) DO NOTHING;


-- ===================================================================
-- SCHEMA VERSION TRACKING (Meta CAPI additions)
-- ===================================================================

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.2.0', 'Meta Conversion API: ext.meta_org_config, ext.meta_leads, ext.meta_lead_custom_fields, ext.meta_capi_outbound_logs')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.3.0', 'Meta Conversion API: ext.meta_lead_addresses, ext.meta_lead_professional, ext.meta_lead_demographics, ext.meta_org_config.field_mappings, extended ext.view_meta_leads_complete')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.4.0', 'Meta Conversion API: tenant-level app config (ext.meta_tenant_config replaces per-org ext.meta_org_config) + ext.meta_page_form_org_map for Page/Form -> org attribution, ext.meta_leads.page_id')
ON CONFLICT (version) DO NOTHING;


-- Run against a DB that already has 01_init-db.sql + 01_init-lookup-data.sql applied.
-- Paste directly into DBeaver's SQL editor (no psql \copy / meta-commands used).
--
-- NOTE: users.csv / user_org_mapping.csv had a blank org_id for the Root
-- (super_admin) user, but iam.users.org_id and iam.user_org_mapping.org_id
-- are both NOT NULL. Per instruction, the Root user is attached to the
-- Gurgaon org (e05601c1-bf3e-4b92-b157-8e038bdffab1) below.
--
-- NOTE: entity.tenant_domains / entity.tenant_plan_types / entity.org_types /
-- iam.user_roles all default their id to gen_uuidv7() at insert time, so the
-- literal UUIDs from the CSVs (generated in a different DB) don't exist here.
-- All four lookups are resolved by name below instead.
/*
BEGIN;

INSERT INTO entity.tenants
  (id, name, domain_id, plan_type_id, is_active, is_deleted, deleted_at, deleted_by, metadata, created_at, updated_at)
VALUES
  ('0b39b589-ea7d-446a-b660-350e1d84ebd9', 'Fitclass',
   (SELECT id FROM entity.tenant_domains WHERE name = 'fitness'),
   (SELECT id FROM entity.tenant_plan_types WHERE name = 'growth'),
   TRUE, FALSE, NULL, NULL, '{}'::jsonb, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00');

INSERT INTO entity.organizations
  (id, tenant_id, name, legal_entity_name, brand_name, org_type_id, address_line1, address_line2, landmark, pincode,
   city_id, state_id, country_id, timezone, is_active, is_deleted, deleted_at, deleted_by, metadata, created_at, updated_at)
VALUES
  ('e05601c1-bf3e-4b92-b157-8e038bdffab1', '0b39b589-ea7d-446a-b660-350e1d84ebd9', 'Fitclass - Gurgaon - Sec 69', NULL, 'Fitclass',
   (SELECT id FROM entity.org_types WHERE name = 'gym_location'), NULL, 'Sector 69', NULL, NULL,
   NULL, NULL, NULL, 'Asia/Kolkata', TRUE, FALSE, NULL, NULL, '{}'::jsonb, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00');

INSERT INTO iam.users
  (id, org_id, first_name, middle_name, last_name, email, mobile, password_hash, role_id, manager_id,
   is_active, is_deleted, deleted_at, deleted_by, created_by, force_password_change, password_changed_at, last_login_at, created_at, updated_at)
VALUES
  ('870d4958-4a11-4c78-99e0-f240c9f17412', 'e05601c1-bf3e-4b92-b157-8e038bdffab1', 'Root', NULL, 'User',
   'root@root.com', NULL, '$2b$12$JKkWDgN8P1xNEe.p4LvxU.Pmya5i8ywVg6GRkn7ePBqa6SJczmF7m',
   (SELECT id FROM iam.user_roles WHERE name = 'super_admin'), NULL,
   TRUE, FALSE, NULL, NULL, NULL, FALSE, '2026-07-09 08:35:14+00', NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00'),

  ('b9aaf975-05ab-4112-b2b8-1f2bc538e1e0', 'e05601c1-bf3e-4b92-b157-8e038bdffab1', 'Tenant', NULL, 'Admin',
   'admin@fitclass.in', NULL, '$2b$12$JKkWDgN8P1xNEe.p4LvxU.Pmya5i8ywVg6GRkn7ePBqa6SJczmF7m',
   (SELECT id FROM iam.user_roles WHERE name = 'tenant_admin'), NULL,
   TRUE, FALSE, NULL, NULL, NULL, FALSE, '2026-07-09 08:35:14+00', NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00'),

  ('b7d7bc32-0e25-422c-b587-8abe0911f7a5', 'e05601c1-bf3e-4b92-b157-8e038bdffab1', 'Branch', NULL, 'Admin',
   'admin-ggn-69@fitclass.in', NULL, '$2b$12$JKkWDgN8P1xNEe.p4LvxU.Pmya5i8ywVg6GRkn7ePBqa6SJczmF7m',
   (SELECT id FROM iam.user_roles WHERE name = 'org_admin'), NULL,
   TRUE, FALSE, NULL, NULL, NULL, FALSE, '2026-07-09 08:35:14+00', NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00');

-- role_id resolved by name from iam.user_roles since user_org_mapping.csv carries role names, not UUIDs.
INSERT INTO iam.user_org_mapping
  (user_id, org_id, role_id, is_active, lead_assignment_weight, granted_by, granted_at, updated_at)
VALUES
  ('870d4958-4a11-4c78-99e0-f240c9f17412', 'e05601c1-bf3e-4b92-b157-8e038bdffab1',
   (SELECT id FROM iam.user_roles WHERE name = 'super_admin'), TRUE, 0, NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00'),

  ('b9aaf975-05ab-4112-b2b8-1f2bc538e1e0', 'e05601c1-bf3e-4b92-b157-8e038bdffab1',
   (SELECT id FROM iam.user_roles WHERE name = 'tenant_admin'), TRUE, 0, NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00'),

  ('b7d7bc32-0e25-422c-b587-8abe0911f7a5', 'e05601c1-bf3e-4b92-b157-8e038bdffab1',
   (SELECT id FROM iam.user_roles WHERE name = 'org_admin'), TRUE, 0, NULL, '2026-07-09 08:35:14+00', '2026-07-09 08:35:14+00');

COMMIT;
*/