
-- ===================================================================
-- CRM Monorepo — Bulk Demo Seed: STEP 3
-- 500 Leads per org (5,000 total across 10 orgs)
--
-- Run AFTER: init-db.sql, init-seed.sql, seed-02-entity.tenants-orgs-iam.users.sql
-- Run BEFORE: seed-04-interactions-followups.sql
--
-- Strategy:
--   - One DO block loop per org x generate_series(1,500) per org,
--     driven by a small reference table (re-derived here since temp
--     tables from script 2 don't persist across separate sessions).
--   - Stage distribution is weighted (more new/contacting than
--     converted/unqualified) to look like a realistic pipeline.
--   - Source/platform/campaign is randomized per lead.
--   - created_at is randomized over the last ~18 months so leads land
--     in different time buckets (good for testing date-based UI sorts
--     and pagination/randomized ordering).
--   - assigned_user_id is randomly one of the 3 reps in that org, or
--     NULL for ~half of 'new' leads (unassigned inbox).
--   - metadata differs by tenant: fitness goals for FitClass orgs,
--     stay preferences for ITC Hotels orgs.
--   - outcome_id is only ever set to an outcome row matching the
--     lead's own stage_id, satisfying crm.check_lead_stage_outcome().
--   - outcome_comment is populated whenever the chosen outcome has
--     requires_comment = TRUE, satisfying the same trigger.
-- ===================================================================

SET client_encoding = 'UTF8';
BEGIN;

-- Re-create the same _seed_uuid helper (idempotent — already exists from
-- script 2, but kept here so this script is runnable standalone too).
CREATE OR REPLACE FUNCTION _seed_uuid(p_seq INT, p_slot INT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    LPAD(p_seq::TEXT, 8, '0') || '-0000-0000-' ||
    LPAD(p_slot::TEXT, 4, '0') || '-000000000000'
  )::UUID;
$$;

-- ============================================================
-- Org reference table for this script (org_seq 1-10, all orgs).
-- org_seq 1-2 use the literal UUIDs from init-seed.sql.
-- org_seq 3-10 use the _seed_uuid(seq, 0) pattern from script 2.
-- ============================================================
CREATE TEMP TABLE _lead_org_ref (
  org_seq      INT PRIMARY KEY,
  org_uuid     UUID NOT NULL,
  tenant_label TEXT NOT NULL  -- 'fitclass' or 'itc'
) ON COMMIT DROP;

INSERT INTO _lead_org_ref (org_seq, org_uuid, tenant_label) VALUES
  (1,  'b1000000-0000-0000-0000-000000000001', 'fitclass'),
  (2,  'b1000000-0000-0000-0000-000000000002', 'fitclass'),
  (3,  _seed_uuid(3,0),  'fitclass'),
  (4,  _seed_uuid(4,0),  'fitclass'),
  (5,  _seed_uuid(5,0),  'fitclass'),
  (6,  _seed_uuid(6,0),  'itc'),
  (7,  _seed_uuid(7,0),  'itc'),
  (8,  _seed_uuid(8,0),  'itc'),
  (9,  _seed_uuid(9,0),  'itc'),
  (10, _seed_uuid(10,0), 'itc');

-- ============================================================
-- Reference data pools
-- ============================================================
CREATE TEMP TABLE _name_pool (idx INT PRIMARY KEY, first_name TEXT, last_name TEXT) ON COMMIT DROP;
INSERT INTO _name_pool (idx, first_name, last_name)
SELECT (row_number() OVER ()) - 1, fn, ln FROM (VALUES
  ('Aditi','Shah'),('Aman','Verma'),('Anjali','Reddy'),('Arvind','Nair'),('Asha','Iyer'),
  ('Bhavna','Joshi'),('Chirag','Mehta'),('Deepak','Kapoor'),('Esha','Bose'),('Faizal','Khan'),
  ('Gauri','Patil'),('Harsh','Bhatt'),('Indira','Pillai'),('Jatin','Saxena'),('Kiran','Rao'),
  ('Lakshya','Chopra'),('Madhuri','Singh'),('Naveen','Gupta'),('Ojas','Trivedi'),('Pallavi','Menon'),
  ('Qadir','Sheikh'),('Ritu','Agarwal'),('Sameer','Bajaj'),('Tara','Krishnan'),('Uma','Desai'),
  ('Varun','Malhotra'),('Wahida','Ansari'),('Yash','Thakur'),('Zoya','Hussain'),('Akshay','Bhandari'),
  ('Bela','Chandra'),('Chetna','Dutta'),('Dhruv','Sharma'),('Elena','Fernandes'),('Farhan','Ahmed'),
  ('Garima','Rastogi'),('Hitesh','Vyas'),('Ishaan','Kohli'),('Jyotsna','Pandey'),('Kunal','Bedi'),
  ('Lavanya','Subramaniam'),('Manish','Tandon'),('Nandini','Ghosh'),('Omkar','Deshmukh'),('Priti','Bhalla'),
  ('Rohit','Sinha'),('Sanya','Kaur'),('Tushar','Oberoi'),('Urvashi','Chauhan'),('Vivaan','Kapadia')
) AS t(fn, ln);

CREATE TEMP TABLE _city_pool (idx INT PRIMARY KEY, city_name TEXT, state_name TEXT) ON COMMIT DROP;
INSERT INTO _city_pool (idx, city_name, state_name)
SELECT (row_number() OVER ()) - 1, c, s FROM (VALUES
  ('New Delhi','Delhi'),('Dwarka','Delhi'),('Rohini','Delhi'),('Lajpat Nagar','Delhi'),
  ('Connaught Place','Delhi'),('Saket','Delhi'),('Janakpuri','Delhi'),('Noida','Uttar Pradesh'),
  ('Gurgaon','Haryana'),('Faridabad','Haryana')
) AS t(c, s);

-- ============================================================
-- MAIN LEAD GENERATOR
-- ============================================================
DO $$
DECLARE
  v_org             RECORD;
  v_i               INT;
  v_rep_slot        INT;
  v_assigned_user   UUID;
  v_stage_roll      NUMERIC;
  v_stage_name      TEXT;
  v_stage_id        UUID;
  v_outcome_id      UUID;
  v_outcome_requires_comment BOOLEAN;
  v_outcome_comment TEXT;
  v_platform_roll   INT;
  v_platform_name   TEXT;
  v_campaign_id     UUID;
  v_source_id       UUID;
  v_name_idx        INT;
  v_first_name      TEXT;
  v_last_name       TEXT;
  v_city_idx        INT;
  v_city_name       TEXT;
  v_state_name      TEXT;
  v_created_at      TIMESTAMPTZ;
  v_phone           TEXT;
  v_email           TEXT;
  v_lead_id         UUID;
  v_metadata        JSONB;
  v_tags            TEXT[];
  v_has_email       BOOLEAN;
  v_has_address     BOOLEAN;
  v_name_pool_sz    INT;
  v_city_pool_sz    INT;
  v_lead_city_id    INTEGER;
  v_lead_state_id   SMALLINT;
  v_lead_country_id SMALLINT;
BEGIN
  SELECT COUNT(*) INTO v_name_pool_sz FROM _name_pool;
  SELECT COUNT(*) INTO v_city_pool_sz FROM _city_pool;

  FOR v_org IN SELECT * FROM _lead_org_ref ORDER BY org_seq LOOP

    PERFORM set_config('app.current_org_id',  v_org.org_uuid::TEXT, TRUE);
    PERFORM set_config('app.current_user_id', _seed_uuid(v_org.org_seq, 1)::TEXT, TRUE);

    FOR v_i IN 1..500 LOOP

      v_lead_id := public.gen_uuidv7();

      -- ── Name ──
      v_name_idx := floor(random() * v_name_pool_sz)::INT;
      SELECT first_name, last_name INTO v_first_name, v_last_name
      FROM _name_pool WHERE idx = v_name_idx;

      -- ── Address (only ~30% of leads have a structured address,
      --     mirroring the sparse pattern in the original seed) ──
      v_has_address := random() < 0.30;
      v_city_idx := floor(random() * v_city_pool_sz)::INT;
      SELECT city_name, state_name INTO v_city_name, v_state_name
      FROM _city_pool WHERE idx = v_city_idx;

      IF v_has_address THEN
        SELECT id INTO v_lead_city_id    FROM geo.cities    WHERE name = v_city_name  LIMIT 1;
        SELECT id INTO v_lead_state_id   FROM geo.states    WHERE name = v_state_name LIMIT 1;
        SELECT id INTO v_lead_country_id FROM geo.countries WHERE iso_code = 'IN';
      ELSE
        v_lead_city_id    := NULL;
        v_lead_state_id   := NULL;
        v_lead_country_id := NULL;
      END IF;

      -- ── Phone / email ──
      v_phone := '+91-9' || LPAD(floor(random() * 999999999)::TEXT, 9, '0');
      v_has_email := random() < 0.75;
      v_email := CASE WHEN v_has_email
        THEN lower(v_first_name) || '.' || lower(v_last_name) || v_i || '@' ||
             (ARRAY['gmail.com','yahoo.com','outlook.com','hotmail.com'])[1 + floor(random()*4)::INT]
        ELSE NULL END;

      -- ── Stage: weighted distribution ──
      --   new 25% | contacting 30% | qualified 15% | converted 12%
      --   unqualified 15% | transferred_out 3%
      v_stage_roll := random();
      v_stage_name := CASE
        WHEN v_stage_roll < 0.25 THEN 'new'
        WHEN v_stage_roll < 0.55 THEN 'contacting'
        WHEN v_stage_roll < 0.70 THEN 'qualified'
        WHEN v_stage_roll < 0.82 THEN 'converted'
        WHEN v_stage_roll < 0.97 THEN 'unqualified'
        ELSE 'transferred_out'
      END;
      SELECT id INTO v_stage_id FROM crm.lead_stage WHERE name = v_stage_name;

      -- ── Outcome: only for stages that have outcome rows defined,
      --     and only ~60% of the time even then (some leads sit in a
      --     stage with no outcome chosen yet) ──
      v_outcome_id := NULL;
      v_outcome_comment := NULL;
      v_outcome_requires_comment := FALSE;

      IF v_stage_name IN ('contacting','qualified','converted','unqualified','transferred_out')
         AND random() < 0.60 THEN
        SELECT lso.id, lso.requires_comment INTO v_outcome_id, v_outcome_requires_comment
        FROM crm.lead_stage_outcome lso
        WHERE lso.stage_id = v_stage_id
        ORDER BY random() LIMIT 1;

        IF v_outcome_requires_comment THEN
          v_outcome_comment := 'Auto-seeded note: see lead metadata for context.';
        END IF;
      END IF;

      -- ── Platform / campaign / source ──
      v_platform_roll := floor(random() * 5)::INT;
      v_platform_name := (ARRAY['facebook','google','whatsapp','referral','organic'])[v_platform_roll + 1];

      v_campaign_id := NULL;
      v_source_id   := NULL;
      IF v_platform_name IN ('facebook','google') THEN
        SELECT ac.id INTO v_campaign_id
        FROM marketing.ad_campaigns ac
        JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
        WHERE ac.org_id = v_org.org_uuid AND mp.name = v_platform_name
        ORDER BY random() LIMIT 1;
      ELSE
        SELECT id INTO v_source_id FROM crm.lead_sources WHERE name =
          CASE v_platform_name
            WHEN 'whatsapp' THEN 'whatsapp'
            WHEN 'referral' THEN 'referral'
            ELSE 'website_form'
          END;
      END IF;

      -- ── Assignment: 'new' leads are unassigned ~50% of the time;
      --     everything else assigned to one of the 3 reps (slots 5/6/7) ──
      v_rep_slot := 5 + floor(random() * 3)::INT;
      v_assigned_user := CASE
        WHEN v_stage_name = 'new' AND random() < 0.50 THEN NULL
        ELSE _seed_uuid(v_org.org_seq, v_rep_slot)
      END;

      -- ── created_at: random over the last 18 months, randomized
      --     time-of-day too, so list views sort/paginate realistically ──
      v_created_at := CURRENT_TIMESTAMP
                       - (floor(random() * 545)::TEXT || ' days')::INTERVAL
                       - (floor(random() * 86400)::TEXT || ' seconds')::INTERVAL;

      -- ── Metadata: domain-specific (fitness vs hospitality) ──
      v_metadata := CASE WHEN v_org.tenant_label = 'fitclass'
        THEN jsonb_build_object(
          'goal', (ARRAY['weight_loss','muscle_gain','overall_fitness','flexibility','cardio_fitness'])[1 + floor(random()*5)::INT],
          'preferred_timing', (ARRAY['morning','evening','afternoon'])[1 + floor(random()*3)::INT],
          'fitness_level', (ARRAY['beginner','intermediate','advanced'])[1 + floor(random()*3)::INT]
        )
        ELSE jsonb_build_object(
          'stay_purpose', (ARRAY['business','leisure','wedding','conference','staycation'])[1 + floor(random()*5)::INT],
          'room_type_interest', (ARRAY['deluxe','suite','executive_club','presidential'])[1 + floor(random()*4)::INT],
          'expected_guests', 1 + floor(random()*4)::INT,
          'loyalty_tier', (ARRAY['none','silver','gold','platinum'])[1 + floor(random()*4)::INT]
        )
      END;

      -- ── Tags: 0-2 random tags ──
      v_tags := CASE floor(random()*7)::INT
        WHEN 0 THEN ARRAY[]::TEXT[]
        WHEN 1 THEN ARRAY['high_value']
        WHEN 2 THEN ARRAY['trial_requested']
        WHEN 3 THEN ARRAY['re_engagement']
        WHEN 4 THEN ARRAY['premium_interest']
        WHEN 5 THEN ARRAY['referral_lead']
        ELSE        ARRAY['high_value','trial_requested']
      END;

      INSERT INTO crm.marketing_leads (
        id, org_id, first_name, last_name, phone, email,
        city_id, state_id, country_id,
        campaign_id, source_id, stage_id, outcome_id, outcome_comment,
        assigned_user_id, raw_webhook_data, metadata, tags, created_at
      ) VALUES (
        v_lead_id, v_org.org_uuid, v_first_name, v_last_name, v_phone, v_email,
        v_lead_city_id, v_lead_state_id, v_lead_country_id,
        v_campaign_id, v_source_id, v_stage_id, v_outcome_id, v_outcome_comment,
        v_assigned_user,
        jsonb_build_object('source', v_platform_name, 'seed_batch', 'bulk_500'),
        v_metadata, v_tags, v_created_at
      );

    END LOOP;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- Sanity check (run manually after this script if you want to verify)
-- ============================================================
-- SELECT o.name, COUNT(*) AS lead_count
-- FROM crm.marketing_leads ml JOIN entity.organizations o ON o.id = ml.org_id
-- WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500'
-- GROUP BY o.name ORDER BY o.name;
--
-- SELECT ls.name AS stage, COUNT(*) FROM crm.marketing_leads ml
-- JOIN crm.lead_stage ls ON ls.id = ml.stage_id
-- WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500'
-- GROUP BY ls.name ORDER BY COUNT(*) DESC;
