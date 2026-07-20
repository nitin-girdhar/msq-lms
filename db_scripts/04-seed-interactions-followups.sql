-- ===================================================================
-- CRM Monorepo — Bulk Demo Seed: STEP 4
-- Interactions + Follow-ups for every bulk-seeded lead
--
-- Run AFTER: init-db.sql, init-seed.sql,
--            seed-02-entity.tenants-orgs-iam.users.sql, seed-03-leads-bulk.sql
-- Run LAST.
--
-- For every lead inserted by seed-03 (tagged raw_webhook_data->>'seed_batch'
-- = 'bulk_500'):
--   - 1 to 4 lms.lead_interactions (call/whatsapp/email/in_person/sms, etc.)
--     with realistic notes and occurred_at timestamps after the lead's
--     created_at.
--   - 0 to 2 lms.lead_follow_ups. Distribution:
--       'new'/'contacting' leads lean towards 'pending' (future-dated)
--       'qualified' leads often have one 'completed' + one 'pending'
--       'converted'/'unqualified'/'transferred_out' mostly 'completed'
--         or 'missed', rarely 'pending'
--     completed_at is only ever set when status = 'completed', and left
--     NULL otherwise, satisfying lms.check_follow_up_completion().
--
-- Note: audit.marketing_leads_history and lms.lead_assignment_log are NOT
-- hand-written here — they are populated automatically by the existing
-- audit.audit_marketing_leads_changes / lms.log_lead_assignment triggers whenever
-- a lead row is updated. Since seed-03 only INSERTs leads (no UPDATEs),
-- those audit tables will stay empty for the bulk-seeded leads unless
-- you subsequently update a lead's stage/assignment through the app —
-- which is the realistic behavior (history should reflect real changes,
-- not be backfilled).
-- ===================================================================

SET client_encoding = 'UTF8';
BEGIN;

CREATE OR REPLACE FUNCTION _seed_uuid(p_seq INT, p_slot INT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    LPAD(p_seq::TEXT, 8, '0') || '-0000-0000-' ||
    LPAD(p_slot::TEXT, 4, '0') || '-000000000000'
  )::UUID;
$$;

-- ============================================================
-- Org reference (same as script 3)
-- ============================================================
CREATE TEMP TABLE _io_org_ref (
  org_seq  INT PRIMARY KEY,
  org_uuid UUID NOT NULL
) ON COMMIT DROP;

INSERT INTO _io_org_ref (org_seq, org_uuid) VALUES
  (1,  'b1000000-0000-0000-0000-000000000001'),
  (2,  'b1000000-0000-0000-0000-000000000002'),
  (3,  _seed_uuid(3,0)),
  (4,  _seed_uuid(4,0)),
  (5,  _seed_uuid(5,0)),
  (6,  _seed_uuid(6,0)),
  (7,  _seed_uuid(7,0)),
  (8,  _seed_uuid(8,0)),
  (9,  _seed_uuid(9,0)),
  (10, _seed_uuid(10,0));

-- ============================================================
-- INTERACTIONS — 1 to 4 per lead.
-- For each lead, pick a random user from that org (any role with a
-- login, i.e. slots 1-7 — read_only at slot 8 typically wouldn't log
-- interactions) to be the actor, and generate a short note per
-- interaction type.
-- ============================================================
DO $$
DECLARE
  v_lead          RECORD;
  v_org_seq       INT;
  v_num_ix        INT;
  v_k             INT;
  v_actor_slot    INT;
  v_actor_id      UUID;
  v_itype_id      UUID;
  v_itype_name    TEXT;
  v_notes         TEXT;
  v_duration      INT;
  v_occurred_at   TIMESTAMPTZ;
  v_notes_pool    TEXT[] := ARRAY[
    'Initial outreach completed. Lead responded positively.',
    'Follow-up call — lead requested more details via email.',
    'Sent brochure/pricing information. Awaiting response.',
    'Lead asked about availability and scheduling options.',
    'Discussed budget and requirements in detail.',
    'No response on first attempt — will retry.',
    'Lead confirmed interest, moving to next stage.',
    'Shared testimonials and case studies as requested.',
    'Scheduled a visit/demo for the upcoming week.',
    'Quick check-in message sent via WhatsApp.'
  ];
BEGIN
  FOR v_lead IN
    SELECT ml.id AS lead_id, ml.org_id, ml.created_at, oref.org_seq
    FROM lms.marketing_leads ml
    JOIN _io_org_ref oref ON oref.org_uuid = ml.org_id
    WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500'
  LOOP
    PERFORM set_config('app.current_org_id', v_lead.org_id::TEXT, TRUE);

    v_num_ix := 1 + floor(random() * 4)::INT;  -- 1 to 4

    FOR v_k IN 1..v_num_ix LOOP
      -- actor: random among slots 1-7 (admin, sr_mgr, mgr, sse, rep1-3)
      v_actor_slot := 1 + floor(random() * 7)::INT;
      v_actor_id   := _seed_uuid(v_lead.org_seq, v_actor_slot);

      PERFORM set_config('app.current_user_id', v_actor_id::TEXT, TRUE);

      v_itype_name := (ARRAY['call','whatsapp','email','sms','in_person','video_call','chat'])[1 + floor(random()*7)::INT];
      SELECT id INTO v_itype_id FROM lms.interaction_types WHERE name = v_itype_name;

      v_notes := v_notes_pool[1 + floor(random() * array_length(v_notes_pool,1))::INT];

      v_duration := CASE WHEN v_itype_name IN ('call','video_call')
                    THEN 60 + floor(random() * 480)::INT
                    ELSE NULL END;

      -- occurred_at: after created_at, spaced out by k, capped at "now"
      v_occurred_at := LEAST(
        v_lead.created_at + (v_k::TEXT || ' days')::INTERVAL + (floor(random()*12)::TEXT || ' hours')::INTERVAL,
        CURRENT_TIMESTAMP
      );

      INSERT INTO lms.lead_interactions
        (org_id, lead_id, user_id, interaction_type_id, notes, duration_seconds, occurred_at)
      VALUES
        (v_lead.org_id, v_lead.lead_id, v_actor_id, v_itype_id, v_notes, v_duration, v_occurred_at);
    END LOOP;
  END LOOP;
END $$;

-- ============================================================
-- FOLLOW-UPS — 0 to 2 per lead, status distribution depends on stage.
-- assigned_user_id must be a rep (slots 5-7) to match how follow-ups
-- are assigned in the original hand-written seed.
-- ============================================================
DO $$
DECLARE
  v_lead           RECORD;
  v_num_fu         INT;
  v_k              INT;
  v_rep_slot       INT;
  v_assigned_user  UUID;
  v_status_roll    NUMERIC;
  v_status_name    TEXT;
  v_status_id      UUID;
  v_scheduled_at   TIMESTAMPTZ;
  v_completed_at   TIMESTAMPTZ;
  v_notes          TEXT;
  v_notes_pool     TEXT[] := ARRAY[
    'Check in on decision timeline.',
    'Confirm visit/trial booking.',
    'Follow up on pricing discussion.',
    'Re-engage after period of silence.',
    'Close the deal — offer time-bound incentive.',
    'Qualify budget and requirement fit.',
    'Send reminder about pending documents.',
    'Verify satisfaction post-conversion.'
  ];
BEGIN
  FOR v_lead IN
    SELECT ml.id AS lead_id, ml.org_id, ml.created_at, oref.org_seq, ls.name AS stage_name
    FROM lms.marketing_leads ml
    JOIN _io_org_ref oref ON oref.org_uuid = ml.org_id
    JOIN lms.lead_stage ls ON ls.id = ml.stage_id
    WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500'
  LOOP
    PERFORM set_config('app.current_org_id', v_lead.org_id::TEXT, TRUE);

    -- number of follow-ups: leads further along the funnel tend to
    -- have more follow-up history
    v_num_fu := CASE
      WHEN v_lead.stage_name = 'new'        THEN floor(random() * 2)::INT        -- 0-1
      WHEN v_lead.stage_name IN ('contacting','qualified') THEN 1 + floor(random() * 2)::INT -- 1-2
      ELSE floor(random() * 2)::INT                                              -- 0-1
    END;

    FOR v_k IN 1..v_num_fu LOOP
      v_rep_slot := 5 + floor(random() * 3)::INT;
      v_assigned_user := _seed_uuid(v_lead.org_seq, v_rep_slot);

      PERFORM set_config('app.current_user_id', v_assigned_user::TEXT, TRUE);

      -- status distribution depends on the lead's current stage
      v_status_roll := random();
      v_status_name := CASE v_lead.stage_name
        WHEN 'new' THEN
          CASE WHEN v_status_roll < 0.85 THEN 'pending' ELSE 'missed' END
        WHEN 'contacting' THEN
          CASE WHEN v_status_roll < 0.55 THEN 'pending'
               WHEN v_status_roll < 0.85 THEN 'completed'
               ELSE 'missed' END
        WHEN 'qualified' THEN
          CASE WHEN v_status_roll < 0.40 THEN 'pending'
               WHEN v_status_roll < 0.90 THEN 'completed'
               ELSE 'missed' END
        WHEN 'converted' THEN
          CASE WHEN v_status_roll < 0.90 THEN 'completed' ELSE 'pending' END
        WHEN 'unqualified' THEN
          CASE WHEN v_status_roll < 0.70 THEN 'missed' ELSE 'completed' END
        ELSE -- transferred_out
          CASE WHEN v_status_roll < 0.60 THEN 'completed' ELSE 'missed' END
      END;
      SELECT id INTO v_status_id FROM lms.follow_up_statuses WHERE name = v_status_name;

      IF v_status_name = 'completed' THEN
        -- scheduled in the past, completed shortly after
        v_scheduled_at := v_lead.created_at + ((1 + v_k * 3)::TEXT || ' days')::INTERVAL;
        v_scheduled_at := LEAST(v_scheduled_at, CURRENT_TIMESTAMP - INTERVAL '1 day');
        v_completed_at := v_scheduled_at + (floor(random()*180)::TEXT || ' minutes')::INTERVAL;
      ELSIF v_status_name = 'missed' THEN
        -- scheduled in the past, never completed
        v_scheduled_at := v_lead.created_at + ((1 + v_k * 3)::TEXT || ' days')::INTERVAL;
        v_scheduled_at := LEAST(v_scheduled_at, CURRENT_TIMESTAMP - INTERVAL '1 day');
        v_completed_at := NULL;
      ELSE
        -- pending: scheduled in the future (relative to "today" in this
        -- seed's timeline, i.e. June 2026) so the follow-up queue UI has
        -- realistic upcoming items
        v_scheduled_at := CURRENT_TIMESTAMP + ((1 + floor(random()*21))::TEXT || ' days')::INTERVAL;
        v_completed_at := NULL;
      END IF;

      v_notes := v_notes_pool[1 + floor(random() * array_length(v_notes_pool,1))::INT];

      INSERT INTO lms.lead_follow_ups
        (org_id, lead_id, assigned_user_id, status_id, scheduled_at, completed_at, notes)
      VALUES
        (v_lead.org_id, v_lead.lead_id, v_assigned_user, v_status_id, v_scheduled_at, v_completed_at, v_notes);
    END LOOP;
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- Sanity checks (run manually after this script if you want to verify)
-- ============================================================
-- SELECT COUNT(*) FROM lms.lead_interactions li
-- JOIN lms.marketing_leads ml ON ml.id = li.lead_id
-- WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500';
--
-- SELECT fs.name AS status, COUNT(*) FROM lms.lead_follow_ups lf
-- JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
-- JOIN lms.marketing_leads ml ON ml.id = lf.lead_id
-- WHERE ml.raw_webhook_data->>'seed_batch' = 'bulk_500'
-- GROUP BY fs.name;
