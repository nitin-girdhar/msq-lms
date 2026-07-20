-- ===================================================================
-- 26_tenant-scope-lms-lookups.sql
--
-- N-6 (Phase5_Extraction_Plan §5) — Half B. Completes P3.1 for the 7 LMS
-- marketing lookups that were left global: adds tenant_id NOT NULL + RLS,
-- migrates each global row into one copy per existing tenant, and repoints
-- every FK that references them at the correct tenant's copy.
--
-- Tables converted:
--   lms.lead_stage, lms.lead_stage_outcome, lms.interaction_types,
--   lms.follow_up_statuses, lms.lead_sources,
--   marketing.marketing_platforms, marketing.campaign_statuses
--
-- Technique: for each table we first create per-tenant copies (CROSS JOIN
-- entity.tenants), then build an explicit TEMP old_id→(tenant,new_id) map,
-- then repoint every dependent via that map joined to the dependent's own
-- org_id→tenant. Explicit maps (vs. clever multi-joins) keep the core
-- lead-data repoints unambiguous and reviewable — a wrong repoint here
-- corrupts the lead pipeline.
--
-- Dependents repointed:
--   lms.marketing_leads          .stage_id .outcome_id .source_id
--   lms.lead_follow_ups          .stage_id .outcome_id .status_id(follow_up)
--   lms.lead_status_log          .old_stage_id .new_stage_id .old_outcome_id .new_outcome_id
--   lms.lead_interactions        .interaction_type_id
--   marketing.ad_campaigns       .platform_id .status_id(campaign)
--   ext.lead_stage_capi_event_map.stage_id      (Meta CAPI config; UNIQUE+CASCADE)
--   lms.lead_stage_outcome       .stage_id      (self-referential — handled first)
--
-- Also rewrites the two trigger fns that resolved lms.follow_up_statuses by
-- NAME globally (set_default_follow_up_status / sync_follow_up_status) to
-- scope by the follow-up's own tenant (via org_id).
--
-- RLS: runtime SELECT (app_user via current org's tenant; tenant_admin own
-- tenant) + the N-6 tenant-pinned admin write policy (db_scripts/25 model,
-- FOR ALL TO app_user keyed on app.current_tenant_id) + INSERT/UPDATE GRANTs
-- to lms_svc. These 7 had NO RLS before (pure global reference data).
--
-- Idempotent: every step guards on `tenant_id IS NULL` / IF EXISTS, so a
-- second run is a no-op once the first has committed.
--
-- KNOWN FOLLOW-UP (not solved here — same precedent as 22_tenant-scope-
-- lookups.sql, later delivered by 23_tenant-default-catalogs.sql): a tenant
-- created AFTER this runs gets ZERO rows in these 7 tables until seeded, and
-- lms.marketing_leads.stage_id is NOT NULL — so lead intake needs the catalog
-- defaults wired for these 7 (tracked as the immediate next step in N-6).
-- ===================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. lms.lead_stage  (must be first — lead_stage_outcome + many FKs point here)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE lms.lead_stage
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.lead_stage DROP CONSTRAINT IF EXISTS lead_stage_name_key;

INSERT INTO lms.lead_stage (tenant_id, name, label, description, sort_order, followup_required, is_rejected, is_terminated, is_active)
SELECT t.id, g.name, g.label, g.description, g.sort_order, g.followup_required, g.is_rejected, g.is_terminated, g.is_active
FROM lms.lead_stage g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

CREATE TEMP TABLE _stage_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM lms.lead_stage g
CROSS JOIN entity.tenants t
JOIN lms.lead_stage n ON n.tenant_id = t.id AND n.name = g.name
WHERE g.tenant_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 2. lms.lead_stage_outcome  (self-refs lead_stage; tenant via its stage)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE lms.lead_stage_outcome
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.lead_stage_outcome DROP CONSTRAINT IF EXISTS uq_lead_stage_outcome_stage_name;

-- Per-tenant outcome copies pointing at the matching per-tenant stage copy.
INSERT INTO lms.lead_stage_outcome (tenant_id, stage_id, name, label, description, requires_comment, sort_order, is_active)
SELECT sm.tenant_id, sm.new_id, o.name, o.label, o.description, o.requires_comment, o.sort_order, o.is_active
FROM lms.lead_stage_outcome o
JOIN _stage_map sm ON sm.old_id = o.stage_id
WHERE o.tenant_id IS NULL;

CREATE TEMP TABLE _outcome_map ON COMMIT DROP AS
SELECT g.id AS old_id, n.tenant_id AS tenant_id, n.id AS new_id
FROM lms.lead_stage_outcome g
JOIN _stage_map sm ON sm.old_id = g.stage_id                       -- g's global stage → (tenant,new stage)
JOIN lms.lead_stage_outcome n
  ON n.tenant_id = sm.tenant_id AND n.stage_id = sm.new_id AND n.name = g.name
WHERE g.tenant_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 3. Single-column lookups (interaction_types / follow_up_statuses /
--    lead_sources / marketing_platforms / campaign_statuses)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE lms.interaction_types    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.interaction_types    DROP CONSTRAINT IF EXISTS interaction_types_name_key;
INSERT INTO lms.interaction_types (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM lms.interaction_types g CROSS JOIN entity.tenants t WHERE g.tenant_id IS NULL;
CREATE TEMP TABLE _interaction_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM lms.interaction_types g CROSS JOIN entity.tenants t
JOIN lms.interaction_types n ON n.tenant_id = t.id AND n.name = g.name WHERE g.tenant_id IS NULL;

ALTER TABLE lms.follow_up_statuses   ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.follow_up_statuses   DROP CONSTRAINT IF EXISTS follow_up_statuses_name_key;
INSERT INTO lms.follow_up_statuses (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM lms.follow_up_statuses g CROSS JOIN entity.tenants t WHERE g.tenant_id IS NULL;
CREATE TEMP TABLE _follow_up_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM lms.follow_up_statuses g CROSS JOIN entity.tenants t
JOIN lms.follow_up_statuses n ON n.tenant_id = t.id AND n.name = g.name WHERE g.tenant_id IS NULL;

ALTER TABLE lms.lead_sources         ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.lead_sources         DROP CONSTRAINT IF EXISTS lead_sources_name_key;
INSERT INTO lms.lead_sources (tenant_id, name, label, is_active)
SELECT t.id, g.name, g.label, g.is_active
FROM lms.lead_sources g CROSS JOIN entity.tenants t WHERE g.tenant_id IS NULL;
CREATE TEMP TABLE _source_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM lms.lead_sources g CROSS JOIN entity.tenants t
JOIN lms.lead_sources n ON n.tenant_id = t.id AND n.name = g.name WHERE g.tenant_id IS NULL;

ALTER TABLE marketing.marketing_platforms ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE marketing.marketing_platforms DROP CONSTRAINT IF EXISTS marketing_platforms_name_key;
INSERT INTO marketing.marketing_platforms (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM marketing.marketing_platforms g CROSS JOIN entity.tenants t WHERE g.tenant_id IS NULL;
CREATE TEMP TABLE _platform_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM marketing.marketing_platforms g CROSS JOIN entity.tenants t
JOIN marketing.marketing_platforms n ON n.tenant_id = t.id AND n.name = g.name WHERE g.tenant_id IS NULL;

ALTER TABLE marketing.campaign_statuses ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE marketing.campaign_statuses DROP CONSTRAINT IF EXISTS campaign_statuses_name_key;
INSERT INTO marketing.campaign_statuses (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM marketing.campaign_statuses g CROSS JOIN entity.tenants t WHERE g.tenant_id IS NULL;
CREATE TEMP TABLE _campaign_status_map ON COMMIT DROP AS
SELECT g.id AS old_id, t.id AS tenant_id, n.id AS new_id
FROM marketing.campaign_statuses g CROSS JOIN entity.tenants t
JOIN marketing.campaign_statuses n ON n.tenant_id = t.id AND n.name = g.name WHERE g.tenant_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 4. Repoint every dependent FK via the maps (dependent's org_id → tenant)
-- ═══════════════════════════════════════════════════════════════════
-- marketing_leads: stage_id, outcome_id, source_id
UPDATE lms.marketing_leads d SET stage_id = m.new_id
 FROM _stage_map m, entity.organizations org
WHERE d.stage_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

UPDATE lms.marketing_leads d SET outcome_id = m.new_id
 FROM _outcome_map m, entity.organizations org
WHERE d.outcome_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

UPDATE lms.marketing_leads d SET source_id = m.new_id
 FROM _source_map m, entity.organizations org
WHERE d.source_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

-- lead_follow_ups: stage_id, outcome_id, status_id (follow_up_statuses)
UPDATE lms.lead_follow_ups d SET stage_id = m.new_id
 FROM _stage_map m, entity.organizations org
WHERE d.stage_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

UPDATE lms.lead_follow_ups d SET outcome_id = m.new_id
 FROM _outcome_map m, entity.organizations org
WHERE d.outcome_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

UPDATE lms.lead_follow_ups d SET status_id = m.new_id
 FROM _follow_up_map m, entity.organizations org
WHERE d.status_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

-- lead_status_log: old/new stage + outcome
UPDATE lms.lead_status_log d SET old_stage_id = m.new_id
 FROM _stage_map m, entity.organizations org
WHERE d.old_stage_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;
UPDATE lms.lead_status_log d SET new_stage_id = m.new_id
 FROM _stage_map m, entity.organizations org
WHERE d.new_stage_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;
UPDATE lms.lead_status_log d SET old_outcome_id = m.new_id
 FROM _outcome_map m, entity.organizations org
WHERE d.old_outcome_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;
UPDATE lms.lead_status_log d SET new_outcome_id = m.new_id
 FROM _outcome_map m, entity.organizations org
WHERE d.new_outcome_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

-- lead_interactions: interaction_type_id
UPDATE lms.lead_interactions d SET interaction_type_id = m.new_id
 FROM _interaction_map m, entity.organizations org
WHERE d.interaction_type_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

-- ad_campaigns: platform_id, status_id (campaign)
UPDATE marketing.ad_campaigns d SET platform_id = m.new_id
 FROM _platform_map m, entity.organizations org
WHERE d.platform_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;
UPDATE marketing.ad_campaigns d SET status_id = m.new_id
 FROM _campaign_status_map m, entity.organizations org
WHERE d.status_id = m.old_id AND m.tenant_id = org.tenant_id
  AND org.id = d.org_id;

-- lead_stage_outcome self-ref: repoint any remaining global outcome's stage_id
-- (the per-tenant copies already point at per-tenant stages; this covers nothing
-- new but is kept explicit — the global rows are deleted below anyway).

-- ext.lead_stage_capi_event_map: Meta CAPI config keyed by stage (UNIQUE, no
-- org_id, ON DELETE CASCADE). Replicate each global mapping to every tenant's
-- matching stage BEFORE the global stage is deleted (else CASCADE drops it).
INSERT INTO ext.lead_stage_capi_event_map (stage_id, capi_event_type_id)
SELECT sm.new_id, c.capi_event_type_id
FROM ext.lead_stage_capi_event_map c
JOIN _stage_map sm ON sm.old_id = c.stage_id
ON CONFLICT (stage_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- 5. Drop the now-orphaned global rows (outcomes before stages — RESTRICT FK)
-- ═══════════════════════════════════════════════════════════════════
DELETE FROM lms.lead_stage_outcome    WHERE tenant_id IS NULL;
DELETE FROM lms.lead_stage            WHERE tenant_id IS NULL; -- CASCADEs remaining global capi_event_map rows
DELETE FROM lms.interaction_types     WHERE tenant_id IS NULL;
DELETE FROM lms.follow_up_statuses    WHERE tenant_id IS NULL;
DELETE FROM lms.lead_sources          WHERE tenant_id IS NULL;
DELETE FROM marketing.marketing_platforms WHERE tenant_id IS NULL;
DELETE FROM marketing.campaign_statuses   WHERE tenant_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- 6. NOT NULL + per-tenant unique constraints
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE lms.lead_stage            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.lead_stage            ADD CONSTRAINT uq_lead_stage_tenant_name UNIQUE (tenant_id, name);
ALTER TABLE lms.lead_stage_outcome    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.lead_stage_outcome    ADD CONSTRAINT uq_lead_stage_outcome_stage_name UNIQUE (stage_id, name);
ALTER TABLE lms.interaction_types     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.interaction_types     ADD CONSTRAINT uq_interaction_types_tenant_name UNIQUE (tenant_id, name);
ALTER TABLE lms.follow_up_statuses    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.follow_up_statuses    ADD CONSTRAINT uq_follow_up_statuses_tenant_name UNIQUE (tenant_id, name);
ALTER TABLE lms.lead_sources          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.lead_sources          ADD CONSTRAINT uq_lead_sources_tenant_name UNIQUE (tenant_id, name);
ALTER TABLE marketing.marketing_platforms ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing.marketing_platforms ADD CONSTRAINT uq_marketing_platforms_tenant_name UNIQUE (tenant_id, name);
ALTER TABLE marketing.campaign_statuses   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE marketing.campaign_statuses   ADD CONSTRAINT uq_campaign_statuses_tenant_name UNIQUE (tenant_id, name);

-- ═══════════════════════════════════════════════════════════════════
-- 7. RLS — runtime SELECT (app_user via org→tenant; tenant_admin own tenant)
--    + N-6 tenant-pinned admin write policy + product-role write GRANTs.
-- ═══════════════════════════════════════════════════════════════════
DO $rls$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'lms.lead_stage','lms.lead_stage_outcome','lms.interaction_types',
    'lms.follow_up_statuses','lms.lead_sources',
    'marketing.marketing_platforms','marketing.campaign_statuses'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation_policy ON %s', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %s', t);
    EXECUTE format('DROP POLICY IF EXISTS admin_tenant_config_policy ON %s', t);
    EXECUTE format($p$CREATE POLICY org_isolation_policy ON %s AS PERMISSIVE FOR SELECT TO app_user
      USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                          WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid))$p$, t);
    EXECUTE format($p$CREATE POLICY tenant_isolation_policy ON %s AS PERMISSIVE FOR SELECT TO tenant_admin
      USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t);
    -- N-6 admin write (super_admin acting within a selected tenant via withTenantConfigTx)
    EXECUTE format($p$CREATE POLICY admin_tenant_config_policy ON %s AS PERMISSIVE FOR ALL TO app_user
      USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT INSERT, UPDATE ON TABLE %s TO lms_svc', t);
  END LOOP;
END $rls$;

-- ═══════════════════════════════════════════════════════════════════
-- 8. Rewrite the follow-up-status triggers that resolved by NAME globally.
--    Now scope the name lookup to the follow-up's OWN tenant (via org_id).
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION lms.set_default_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status_id IS NULL THEN
    SELECT s.id INTO NEW.status_id
    FROM lms.follow_up_statuses s
    JOIN entity.organizations o ON o.id = NEW.org_id
    WHERE s.name = 'pending' AND s.tenant_id = o.tenant_id
    LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.sync_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_tenant UUID;
BEGIN
  SELECT o.tenant_id INTO v_tenant FROM entity.organizations o WHERE o.id = NEW.org_id;
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
    SELECT s.id INTO NEW.status_id FROM lms.follow_up_statuses s
    WHERE s.name = 'completed' AND s.tenant_id = v_tenant LIMIT 1;
  ELSIF NEW.completed_at IS NULL AND OLD.completed_at IS NOT NULL THEN
    SELECT s.id INTO NEW.status_id FROM lms.follow_up_statuses s
    WHERE s.name = 'pending' AND s.tenant_id = v_tenant LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

-- ═══════════════════════════════════════════════════════════════════
-- 9. Sanity checks — no dependent may still reference a deleted global row.
-- ═══════════════════════════════════════════════════════════════════
DO $check$
DECLARE v_orphans INT;
BEGIN
  SELECT COUNT(*) INTO v_orphans FROM lms.lead_stage WHERE tenant_id IS NULL;
  IF v_orphans > 0 THEN RAISE EXCEPTION 'lead_stage still has % global rows', v_orphans; END IF;
  SELECT COUNT(*) INTO v_orphans FROM lms.marketing_leads ml
    LEFT JOIN lms.lead_stage s ON s.id = ml.stage_id WHERE ml.stage_id IS NOT NULL AND s.id IS NULL;
  IF v_orphans > 0 THEN RAISE EXCEPTION '% marketing_leads reference a missing stage', v_orphans; END IF;
END $check$;

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.19.0', 'N-6 Half B: tenant-scope the 7 LMS marketing lookups (lead_stage, lead_stage_outcome, interaction_types, follow_up_statuses, lead_sources, marketing_platforms, campaign_statuses) — tenant_id NOT NULL + RLS + admin write policy; repoint marketing_leads/lead_follow_ups/lead_status_log/lead_interactions/ad_campaigns/lead_stage_capi_event_map FKs to per-tenant copies; tenant-scope the follow-up-status default/sync triggers')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
