--rollback
-- ===================================================================
-- CRM Monorepo — Bulk Demo Seed: STEP 2
-- Tenants + Organizations + Users (full role hierarchy)
--
-- Run AFTER: init-db.sql, init-seed.sql
-- Run BEFORE: seed-03-leads-bulk.sql
--
-- Adds:
--   - 1 new tenant: ITC Hotels (hospitality domain)
--   - 8 new orgs (org_seq 3-10): 3 more FitClass + 5 ITC Hotels
--     (combined with the 2 existing FitClass orgs from init-seed.sql,
--      this gives 5 FitClass orgs + 5 ITC Hotels orgs = 10 total)
--   - 8 iam.users per NEW org: org_admin, org_sr_manager, org_manager,
--     senior_sales_executive, sales_representative x3, read_only
--   - 2 marketing.ad_campaigns per NEW org
--
-- Idempotent: ON CONFLICT DO NOTHING / DO UPDATE throughout.
-- All demo accounts password: Admin@12345
-- ===================================================================

SET client_encoding = 'UTF8';
BEGIN;

-- ============================================================
-- Helper: build a deterministic, valid UUID from (org_seq, slot).
-- Produces e.g. org_seq=3, slot=1 -> 00000003-0000-0000-0001-000000000000
-- This avoids hand-typed/concatenated UUID literals that can silently
-- end up with the wrong number of hex digits.
-- ============================================================
CREATE OR REPLACE FUNCTION _seed_uuid(p_seq INT, p_slot INT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    LPAD(p_seq::TEXT, 8, '0') || '-0000-0000-' ||
    LPAD(p_slot::TEXT, 4, '0') || '-000000000000'
  )::UUID;
$$;

-- ============================================================
-- TENANTS
-- ============================================================
INSERT INTO entity.tenants (id, name, domain_id, plan_type_id, metadata, is_active)
VALUES
    (
        'a1000000-0000-0000-0000-000000000001',
        'FitClass',
        (SELECT id FROM entity.tenant_domains    WHERE name = 'fitness'),
        (SELECT id FROM entity.tenant_plan_types WHERE name = 'growth'),
        '{"brand_color":"#E84B1A","whatsapp_number":"+91-9810001001","features":{"ai_lead_scoring":true,"bulk_sms":true}}',
        TRUE
    ),
    (
        'a3000000-0000-0000-0000-000000000001',
        'ITC Hotels',
        (SELECT id FROM entity.tenant_domains    WHERE name = 'hospitality'),
        (SELECT id FROM entity.tenant_plan_types WHERE name = 'enterprise'),
        '{"brand_color":"#7A1F2B","loyalty_program":"ITC Green Points","features":{"ai_lead_scoring":true,"bulk_sms":true,"channel_manager_sync":true}}',
        TRUE
    )
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Config table driving org + user generation.
-- org_seq 1-2 = FitClass orgs using literal UUIDs (for script 03 compatibility).
-- org_seq 3-10 = new orgs using _seed_uuid(seq, 0) pattern.
-- ============================================================
CREATE TEMP TABLE _org_config (
  org_seq      INT PRIMARY KEY,
  org_uuid     UUID NOT NULL,
  tenant_uuid  UUID NOT NULL,
  org_name     TEXT NOT NULL,
  org_type     TEXT NOT NULL,
  city_name    TEXT NOT NULL,
  state_name   TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  address1     TEXT NOT NULL,
  landmark     TEXT NOT NULL,
  pincode      TEXT NOT NULL,
  tenant_label TEXT NOT NULL  -- 'fitclass' or 'itc' — used by later scripts for domain-specific data
) ON COMMIT DROP;

-- NOTE on slot numbering within _seed_uuid(org_seq, slot):
--   slot 0       = the organization's own id
--   slots 1-8    = iam.users (1 admin, 2 sr_manager, 3 manager, 4 sse, 5-7 reps, 8 read_only)
--   slots 101-102 = marketing.ad_campaigns
-- Keeping these disjoint avoids any collision between an org row and its iam.users.
INSERT INTO _org_config
  (org_seq, org_uuid, tenant_uuid, org_name, org_type, city_name, state_name, email_domain, address1, landmark, pincode, tenant_label)
VALUES
  -- ── Existing FitClass orgs (org_seq 1-2 use literal UUIDs so script 03 can reference them) ──
  (1, 'b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'FitClass - Connaught Place', 'gym_location', 'Connaught Place', 'Delhi',  'fitclass.cp.in',  'A-12, Barakhamba Road',            'Near Statesman House',   '110001', 'fitclass'),
  (2, 'b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'FitClass - Saket',          'gym_location', 'Saket',           'Delhi',  'fitclass.skt.in', 'Shop 14, MGF Metropolitan Mall',   'Near Select Citywalk',   '110017', 'fitclass'),
  -- ── New FitClass orgs ──
  (3, _seed_uuid(3,0), 'a1000000-0000-0000-0000-000000000001', 'FitClass - Gurgaon', 'gym_location', 'Gurgaon', 'Haryana',       'fitclass.ggn.in', 'Tower 3, Cyber Hub',          'Near DLF Cyber City',    '122002', 'fitclass'),
  (4, _seed_uuid(4,0), 'a1000000-0000-0000-0000-000000000001', 'FitClass - Noida',   'gym_location', 'Noida',   'Uttar Pradesh', 'fitclass.noi.in', 'Sector 18 Atta Market',       'Near DLF Mall of India', '201301', 'fitclass'),
  (5, _seed_uuid(5,0), 'a1000000-0000-0000-0000-000000000001', 'FitClass - Rohini',  'gym_location', 'Rohini',  'Delhi',         'fitclass.roh.in', 'Sector 7 Community Centre',   'Near Rohini West Metro', '110085', 'fitclass'),
  -- ── New ITC Hotels orgs ──
  (6, _seed_uuid(6,0), 'a3000000-0000-0000-0000-000000000001', 'ITC Hotels - Maurya Delhi',        'branch', 'New Delhi', 'Delhi', 'itcmaurya.in',     'Sardar Patel Marg, Diplomatic Enclave', 'Near Chanakyapuri',        '110021', 'itc'),
  (7, _seed_uuid(7,0), 'a3000000-0000-0000-0000-000000000001', 'ITC Hotels - Gardenia Gurgaon',    'branch', 'Gurgaon',   'Haryana', 'itcgardenia.in', 'NH8, Near IFFCO Chowk',                'Near IFFCO Chowk Metro',   '122001', 'itc'),
  (8, _seed_uuid(8,0), 'a3000000-0000-0000-0000-000000000001', 'ITC Hotels - Grand Chola Chennai', 'branch', 'New Delhi', 'Delhi', 'itcgrandchola.in', 'Mount Road Extension',                 'Near Guindy Race Course',  '600032', 'itc'),
  (9, _seed_uuid(9,0), 'a3000000-0000-0000-0000-000000000001', 'ITC Hotels - Sonar Kolkata',       'branch', 'New Delhi', 'Delhi', 'itcsonar.in',      'EM Bypass, Near Science City',         'Near Science City',        '700046', 'itc'),
  (10,_seed_uuid(10,0),'a3000000-0000-0000-0000-000000000001', 'ITC Hotels - Windsor Bengaluru',   'branch', 'New Delhi', 'Delhi', 'itcwindsor.in',    'Golf Course Road',                     'Near Golf Course',         '560052', 'itc');

-- ============================================================
-- ORGANIZATIONS (all 10 orgs; ON CONFLICT DO NOTHING is idempotent)
-- ============================================================
INSERT INTO entity.organizations
    (id, tenant_id, name, legal_entity_name, brand_name, org_type_id,
     address_line1, landmark, pincode,
     city_id, state_id, country_id,
     timezone, metadata, is_active)
SELECT
    oc.org_uuid,
    oc.tenant_uuid,
    oc.org_name,
    CASE WHEN oc.tenant_label = 'fitclass' THEN 'FitClass' ELSE 'ITC' END,
    CASE WHEN oc.tenant_label = 'fitclass' THEN 'FitClass' ELSE 'ITC' END,
    (SELECT id FROM entity.org_types WHERE name = oc.org_type),
    oc.address1, oc.landmark, oc.pincode,
    (SELECT id FROM geo.cities  WHERE name = oc.city_name),
    (SELECT id FROM geo.states  WHERE name = oc.state_name),
    (SELECT id FROM geo.countries WHERE iso_code = 'IN'),
    'Asia/Kolkata',
    CASE WHEN oc.tenant_label = 'fitclass'
         THEN jsonb_build_object('capacity', 150 + (oc.org_seq * 20), 'equipment_tier', 'standard')
         ELSE jsonb_build_object('room_count', 180 + (oc.org_seq * 15), 'star_rating', 5, 'has_banquet_hall', true)
    END,
    TRUE
FROM _org_config oc
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- USERS — 8 per org (all 10 orgs).
-- Slot numbering within _seed_uuid(org_seq, slot):
--   1 org_admin | 2 org_sr_manager | 3 org_manager | 4 senior_sales_executive
--   5/6/7 sales_representative (x3) | 8 read_only
-- ============================================================
DO $$
DECLARE
  v_org         RECORD;
  v_admin_id    UUID;
  v_srmgr_id    UUID;
  v_mgr_id      UUID;
  v_sse_id      UUID;
  v_first_names TEXT[] := ARRAY['Arun','Bina','Chetan','Deepali','Eshan','Farah','Gopal','Hema',
                                 'Imran','Jyoti','Kabir','Lata','Madhav','Nalini','Omkar','Pooja',
                                 'Qasim','Radhika','Sahil','Tanya','Uday','Varsha','Yusuf','Zara'];
  v_last_names  TEXT[] := ARRAY['Bhatt','Chawla','Dasgupta','Eapen','Ghosh','Hooda','Iyer','Jain',
                                 'Kohli','Lamba','Mathur','Nair','Oberoi','Pillai','Qureshi','Rastogi'];
  v_password_hash TEXT := '$2b$12$7Bj5154.YS5FKsl1AaDM9O8zEzQW/db5kNkP1APKT6dcIwvReJmHe';
  v_fn_idx INT;
  v_ln_idx INT;
BEGIN
  FOR v_org IN SELECT * FROM _org_config ORDER BY org_seq LOOP

    v_admin_id := _seed_uuid(v_org.org_seq, 1);
    v_srmgr_id := _seed_uuid(v_org.org_seq, 2);
    v_mgr_id   := _seed_uuid(v_org.org_seq, 3);
    v_sse_id   := _seed_uuid(v_org.org_seq, 4);

    PERFORM set_config('app.current_org_id',  v_org.org_uuid::TEXT, TRUE);
    PERFORM set_config('app.current_user_id', v_admin_id::TEXT,     TRUE);

    -- org_admin
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 0) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 0) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (
      v_admin_id, v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '001',
      'admin@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'org_admin'), NULL,
      v_password_hash, TRUE, FALSE
    )
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- org_sr_manager
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 1) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 1) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (
      v_srmgr_id, v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '004',
      'srmanager@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'org_sr_manager'), v_admin_id,
      v_password_hash, TRUE, FALSE
    )
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- org_manager
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 2) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 2) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (
      v_mgr_id, v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '005',
      'manager@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'org_manager'), v_srmgr_id,
      v_password_hash, TRUE, FALSE
    )
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- senior_sales_executive
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 3) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 3) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (
      v_sse_id, v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '006',
      'senior.exec@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'senior_sales_executive'), v_mgr_id,
      v_password_hash, TRUE, FALSE
    )
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- sales_representative x3 (slots 5, 6, 7)
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 4) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 4) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (_seed_uuid(v_org.org_seq, 5), v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '002', 'rep1@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'sales_representative'), v_sse_id, v_password_hash, TRUE, FALSE)
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    v_fn_idx := 1 + ((v_org.org_seq * 7 + 5) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 5) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (_seed_uuid(v_org.org_seq, 6), v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '003', 'rep2@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'sales_representative'), v_sse_id, v_password_hash, TRUE, FALSE)
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    v_fn_idx := 1 + ((v_org.org_seq * 7 + 6) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 6) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (_seed_uuid(v_org.org_seq, 7), v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '009', 'rep3@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'sales_representative'), v_sse_id, v_password_hash, TRUE, FALSE)
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- read_only (slot 8)
    v_fn_idx := 1 + ((v_org.org_seq * 7 + 7) % array_length(v_first_names,1));
    v_ln_idx := 1 + ((v_org.org_seq * 5 + 7) % array_length(v_last_names,1));
    INSERT INTO iam.users (id, org_id, first_name, last_name, mobile, email, role_id, manager_id, password_hash, is_active, force_password_change)
    VALUES (_seed_uuid(v_org.org_seq, 8), v_org.org_uuid, v_first_names[v_fn_idx], v_last_names[v_ln_idx],
      '+9198110' || LPAD(v_org.org_seq::TEXT,2,'0') || '007', 'viewer@' || v_org.email_domain,
      (SELECT id FROM iam.user_roles WHERE name = 'read_only'), NULL, v_password_hash, TRUE, FALSE)
    ON CONFLICT (email) DO UPDATE SET mobile = EXCLUDED.mobile, manager_id = EXCLUDED.manager_id, password_hash = EXCLUDED.password_hash;

    -- Seed iam.user_org_mapping so the crm.check_lead_fk_org_scope trigger and RLS work.
    INSERT INTO iam.user_org_mapping (user_id, org_id, role_id, granted_by, is_active)
    SELECT u.id, v_org.org_uuid, u.role_id, v_admin_id, TRUE
    FROM iam.users u
    WHERE u.id IN (
      v_admin_id, v_srmgr_id, v_mgr_id, v_sse_id,
      _seed_uuid(v_org.org_seq, 5), _seed_uuid(v_org.org_seq, 6),
      _seed_uuid(v_org.org_seq, 7), _seed_uuid(v_org.org_seq, 8)
    )
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET role_id = EXCLUDED.role_id, is_active = TRUE, updated_at = CLOCK_TIMESTAMP();

  END LOOP;
END $$;

-- ============================================================
-- AD CAMPAIGNS — 2 per new org (facebook + google), using slot
-- numbers 101/102 to keep them clearly out of the user-slot range.
-- ============================================================
DO $$
DECLARE
  v_org RECORD;
  v_statuses TEXT[] := ARRAY['active','paused','completed','draft'];
BEGIN
  FOR v_org IN SELECT * FROM _org_config ORDER BY org_seq LOOP
    PERFORM set_config('app.current_org_id', v_org.org_uuid::TEXT, TRUE);
    PERFORM set_config('app.current_user_id', _seed_uuid(v_org.org_seq, 1)::TEXT, TRUE);

    INSERT INTO marketing.ad_campaigns (id, org_id, name, platform_id, status_id, budget, started_at, ended_at)
    VALUES
      (
        _seed_uuid(v_org.org_seq, 101), v_org.org_uuid,
        v_org.org_name || ' - FB Lead Gen',
        (SELECT id FROM marketing.marketing_platforms WHERE name = 'facebook'),
        (SELECT id FROM marketing.campaign_statuses WHERE name = v_statuses[1 + (v_org.org_seq % 4)]),
        15000.00 + (v_org.org_seq * 2500),
        (CURRENT_DATE - ((400 - v_org.org_seq * 10) || ' days')::INTERVAL),
        NULL
      ),
      (
        _seed_uuid(v_org.org_seq, 102), v_org.org_uuid,
        v_org.org_name || ' - Google Search',
        (SELECT id FROM marketing.marketing_platforms WHERE name = 'google'),
        (SELECT id FROM marketing.campaign_statuses WHERE name = v_statuses[1 + ((v_org.org_seq + 1) % 4)]),
        12000.00 + (v_org.org_seq * 1800),
        (CURRENT_DATE - ((350 - v_org.org_seq * 8) || ' days')::INTERVAL),
        NULL
      )
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- Sanity check (run manually after this script if you want to verify)
-- ============================================================
-- SELECT t.name AS tenant, COUNT(DISTINCT o.id) AS orgs, COUNT(DISTINCT u.id) AS iam.users
-- FROM entity.tenants t
-- JOIN entity.organizations o ON o.tenant_id = t.id
-- LEFT JOIN iam.users u ON u.org_id = o.id
-- GROUP BY t.name;
