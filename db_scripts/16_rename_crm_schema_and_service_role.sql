-- ===================================================================
-- 16_rename_crm_schema_and_service_role.sql
--
-- P1.0 — completes the crm-naming cleanup: renames the Postgres SCHEMA
-- `crm` -> `lms` (so it matches the LMS product it holds) and the platform
-- BYPASSRLS service role `crm_service` -> `root_service` (it is platform-wide,
-- not product-specific). Script 15 already renamed the entitlement-key
-- string 'crm'->'lms' in entity.tenant_modules.module data and explicitly
-- deferred this schema/role rename to Phase 1 — this script is that half.
--
-- Guarded/idempotent:
--   - No-op against a DB freshly installed from the now-updated db_scripts
--     01/10/11/13/14/etc (those create `lms`/`root_service` directly).
--   - Safe to re-run against an already-migrated DB.
--
-- What moves automatically with ALTER SCHEMA / ALTER ROLE RENAME (Postgres
-- tracks these by OID, not by name): every table, view, index, sequence,
-- RLS policy (`TO crm_service` policies keep applying to the renamed role),
-- and GRANT in the schema. What does NOT move: `crm.` literals hardcoded as
-- plain text inside plpgsql function bodies — those 9 functions are
-- re-CREATE OR REPLACE'd below under their new `lms.` name, bodies copied
-- verbatim (lms.-qualified) from the current 01_init-db.sql so there is
-- exactly one authored copy of each function body.
-- ===================================================================

BEGIN;

-- 1. Schema rename.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'crm') THEN
    ALTER SCHEMA crm RENAME TO lms;
  END IF;
END $$;

-- 2. Role rename. RLS policies `TO crm_service` and all grants follow the
--    role's OID automatically — no policy/grant needs re-issuing.
DO $$ BEGIN
  -- Rename only when the source exists AND the target does not. On a fresh
  -- install (01 creates root_service directly) or a shared cluster that already
  -- has root_service, this is a no-op instead of colliding on the target name.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_service')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'root_service') THEN
    ALTER ROLE crm_service RENAME TO root_service;
  END IF;
END $$;

-- 3. Defensive re-grant (schema rename preserves existing grants; restated
--    here as an audit artifact, same convention as script 15's RLS re-assert).
GRANT ALL PRIVILEGES ON SCHEMA lms TO root_service;

-- 4. Re-author the 9 function bodies that hardcode `crm.` as literal text
--    (schema-qualification inside a function body is not an OID reference).

CREATE OR REPLACE FUNCTION lms.check_lead_stage_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_outcome_stage_id  UUID;
  v_outcome_count     INT;
  v_requires_comment  BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    SELECT COUNT(*) INTO v_outcome_count
    FROM lms.lead_stage_outcome WHERE stage_id = NEW.stage_id;

    IF v_outcome_count = 0 THEN
      NEW.outcome_id      := NULL;
      NEW.outcome_comment := NULL;
    ELSIF NEW.outcome_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM lms.lead_stage_outcome
        WHERE id = NEW.outcome_id AND stage_id = NEW.stage_id
      ) THEN
        NEW.outcome_id      := NULL;
        NEW.outcome_comment := NULL;
      END IF;
    END IF;
  ELSIF NEW.outcome_id IS NOT NULL THEN
    SELECT stage_id INTO v_outcome_stage_id
    FROM lms.lead_stage_outcome WHERE id = NEW.outcome_id;

    IF v_outcome_stage_id IS DISTINCT FROM NEW.stage_id THEN
      RAISE EXCEPTION
        'outcome_id % does not belong to stage_id %. Cross-stage outcome selection is not allowed.',
        NEW.outcome_id, NEW.stage_id;
    END IF;
  END IF;

  IF NEW.outcome_id IS NOT NULL THEN
    SELECT requires_comment INTO v_requires_comment
    FROM lms.lead_stage_outcome WHERE id = NEW.outcome_id;

    IF v_requires_comment AND (NEW.outcome_comment IS NULL OR NEW.outcome_comment = '') THEN
      RAISE EXCEPTION
        'outcome_comment is required for this outcome (requires_comment = TRUE). Please provide a comment describing the reason.';
    END IF;
  ELSE
    NEW.outcome_comment := NULL;
  END IF;

  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.check_follow_up_completion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT name INTO v_status FROM lms.follow_up_statuses WHERE id = NEW.status_id;
  IF v_status = 'completed' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'completed_at must be set when follow_up status is ''completed''.';
  END IF;
  IF v_status <> 'completed' AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed_at must be NULL when follow_up status is ''%'' (not ''completed'').', v_status;
  END IF;
  RETURN NEW;
END; $$;

-- Latest version (superseded a first cut that checked iam.users.org_id
-- directly) — validates via iam.user_org_mapping so multi-org users aren't
-- incorrectly rejected. See 01_init-db.sql "UPDATED FK SCOPE CHECKS".
CREATE OR REPLACE FUNCTION lms.check_lead_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    PERFORM 1 FROM marketing.ad_campaigns
    WHERE id = NEW.campaign_id AND org_id = NEW.org_id AND NOT is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_id % does not belong to org % or has been deleted.',
        NEW.campaign_id, NEW.org_id;
    END IF;
  END IF;
  IF NEW.assigned_user_id IS NOT NULL THEN
    PERFORM 1
    FROM iam.user_org_mapping uom
    JOIN iam.users u ON u.id = uom.user_id
    WHERE uom.user_id = NEW.assigned_user_id
      AND uom.org_id  = NEW.org_id
      AND uom.is_active
      AND u.is_active AND NOT u.is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assigned_user_id % has no active mapping to org % or has been deleted.',
        NEW.assigned_user_id, NEW.org_id;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.check_interaction_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.',
      NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1
  FROM iam.user_org_mapping uom
  JOIN iam.users u ON u.id = uom.user_id
  WHERE uom.user_id = NEW.user_id
    AND uom.org_id  = NEW.org_id
    AND uom.is_active
    AND u.is_active AND NOT u.is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_id % has no active mapping to org % or has been deleted.',
      NEW.user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.check_follow_up_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.',
      NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1
  FROM iam.user_org_mapping uom
  JOIN iam.users u ON u.id = uom.user_id
  WHERE uom.user_id = NEW.assigned_user_id
    AND uom.org_id  = NEW.org_id
    AND uom.is_active
    AND u.is_active AND NOT u.is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assigned_user_id % has no active mapping to org % or has been deleted.',
      NEW.assigned_user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.set_default_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status_id IS NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'pending' LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.sync_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'completed' LIMIT 1;
  ELSIF NEW.completed_at IS NULL AND OLD.completed_at IS NOT NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'pending' LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

-- SECURITY DEFINER: app_user has only SELECT on lms.lead_assignment_log.
CREATE OR REPLACE FUNCTION lms.log_lead_assignment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor  UUID;
  v_action TEXT;
BEGIN
  IF NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id THEN RETURN NEW; END IF;
  BEGIN
    v_actor := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;
  v_action := CASE
    WHEN OLD.assigned_user_id IS NULL AND NEW.assigned_user_id IS NOT NULL THEN 'initial'
    WHEN OLD.assigned_user_id IS NOT NULL AND NEW.assigned_user_id IS NULL  THEN 'unassigned'
    WHEN v_actor = NEW.assigned_user_id                                      THEN 'self_assigned'
    ELSE 'reassigned'
  END;
  INSERT INTO lms.lead_assignment_log
    (org_id, lead_id, assigned_by_id, assigned_to_id, action, previous_assignee_id)
  VALUES
    (NEW.org_id, NEW.id, v_actor, NEW.assigned_user_id, v_action, OLD.assigned_user_id);
  RETURN NEW;
END; $$;

-- SECURITY DEFINER: app_user has no INSERT on lms.lead_status_log.
-- transition_note is read from app.lead_transition_note session GUC set by the API.
CREATE OR REPLACE FUNCTION lms.log_lead_stage_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_changed_by UUID;
  v_note       TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
       AND NEW.outcome_id IS NOT DISTINCT FROM OLD.outcome_id THEN
      RETURN NEW;
    END IF;
  END IF;
  BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_changed_by := NULL; END;
  BEGIN
    v_note := NULLIF(current_setting('app.lead_transition_note', true), '');
  EXCEPTION WHEN OTHERS THEN v_note := NULL; END;

  INSERT INTO lms.lead_status_log (
    org_id, lead_id,
    old_stage_id, new_stage_id,
    old_outcome_id, new_outcome_id,
    assigned_user_id, changed_by_id, transition_note
  ) VALUES (
    NEW.org_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.stage_id END,
    NEW.stage_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.outcome_id END,
    NEW.outcome_id,
    NEW.assigned_user_id,
    v_changed_by,
    v_note
  );
  RETURN NEW;
END; $$;

-- 5. Version tracking.
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.10.0', 'P1.0 crm-naming cleanup: SCHEMA crm renamed to lms, ROLE crm_service renamed to root_service, 9 function bodies with hardcoded crm. literals re-authored under lms. (schema-key rename to lms was 1.9.0 in script 15)')
ON CONFLICT (version) DO NOTHING;

COMMIT;
