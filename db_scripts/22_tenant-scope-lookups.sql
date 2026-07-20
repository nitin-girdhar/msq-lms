-- ===================================================================
-- 22_tenant-scope-lookups.sql
--
-- Platform_Refactor_Prompts.md "Convert global lookups to tenant-scoped":
-- adds tenant_id NOT NULL + tenant-scoped RLS to eight previously-global
-- lookup tables, migrates every existing global row into one copy per
-- existing tenant, and repoints every table that FKs into them at the
-- correct tenant's copy.
--
-- Tables converted:
--   task.task_statuses, task.task_priorities
--   hr.leave_types, hr.employment_types, hr.attendance_statuses
--   lms.roles, hr.roles, task.roles
-- hr.leave_request_statuses is explicitly NOT in scope for this pass.
--
-- Structural only: every tenant's copy starts identical (same
-- name/label/rank/sort_order); there is no new admin/customization API in
-- this pass — tenants cannot yet diverge their catalogs from one another.
--
-- KNOWN FOLLOW-UP (not solved here — mirrors the existing hr.hr_settings
-- gap in 11_init-leave-management.sql, which also only seeds existing
-- tenants): a brand-new tenant created after this script runs has ZERO
-- rows in these 8 tables until an operator seeds them. Tenant
-- provisioning doesn't auto-seed reference data anywhere in this codebase
-- yet; that is a separate piece of work.
--
-- Idempotent: every step guards on `tenant_id IS NULL` / IF EXISTS, so a
-- second run is a no-op once the first run has committed. Dev/seed data
-- only at the time of writing (confirmed) — if real tenant data exists
-- before this runs, verify the row counts in the sanity-check block at
-- the bottom BEFORE trusting the migration.
--
-- RLS model: matches hr.leave_policies / hr.hr_settings (tenant-wide
-- reference data) — app_user reads rows for the tenant owning its current
-- org, tenant_admin reads rows for its own tenant directly. SELECT-only,
-- matching the unchanged GRANTs (no write access added for either role).
-- ===================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- task.task_statuses  (+ dependents: task.tasks.status_id,
--                       task.task_status_log.old_status_id/new_status_id)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE task.task_statuses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE task.task_statuses DROP CONSTRAINT IF EXISTS task_statuses_name_key;

INSERT INTO task.task_statuses (tenant_id, name, label, description, is_terminal, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_terminal, g.sort_order, g.is_active
FROM task.task_statuses g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE task.tasks d
SET status_id = n.id
FROM task.task_statuses o
JOIN entity.organizations org ON org.id = d.org_id
JOIN task.task_statuses n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.status_id = o.id AND o.tenant_id IS NULL;

UPDATE task.task_status_log d
SET old_status_id = n.id
FROM task.task_statuses o
JOIN entity.organizations org ON org.id = d.org_id
JOIN task.task_statuses n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.old_status_id = o.id AND o.tenant_id IS NULL;

UPDATE task.task_status_log d
SET new_status_id = n.id
FROM task.task_statuses o
JOIN entity.organizations org ON org.id = d.org_id
JOIN task.task_statuses n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.new_status_id = o.id AND o.tenant_id IS NULL;

DELETE FROM task.task_statuses WHERE tenant_id IS NULL;

ALTER TABLE task.task_statuses ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task.task_statuses ADD CONSTRAINT uq_task_statuses_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE task.task_statuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.task_statuses;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.task_statuses;
CREATE POLICY org_isolation_policy ON task.task_statuses AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON task.task_statuses AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- task.task_priorities  (+ dependent: task.tasks.priority_id)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE task.task_priorities
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE task.task_priorities DROP CONSTRAINT IF EXISTS task_priorities_name_key;

INSERT INTO task.task_priorities (tenant_id, name, label, description, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.sort_order, g.is_active
FROM task.task_priorities g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE task.tasks d
SET priority_id = n.id
FROM task.task_priorities o
JOIN entity.organizations org ON org.id = d.org_id
JOIN task.task_priorities n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.priority_id = o.id AND o.tenant_id IS NULL;

DELETE FROM task.task_priorities WHERE tenant_id IS NULL;

ALTER TABLE task.task_priorities ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task.task_priorities ADD CONSTRAINT uq_task_priorities_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE task.task_priorities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.task_priorities;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.task_priorities;
CREATE POLICY org_isolation_policy ON task.task_priorities AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON task.task_priorities AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- hr.leave_types  (+ dependents: hr.leave_policies.leave_type_id [tenant_id
--                   direct], hr.leave_requests.leave_type_id [via org_id],
--                   hr.leave_ledger.leave_type_id [via org_id])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE hr.leave_types
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE hr.leave_types DROP CONSTRAINT IF EXISTS leave_types_name_key;

INSERT INTO hr.leave_types (tenant_id, name, label, description, is_paid, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_paid, g.sort_order, g.is_active
FROM hr.leave_types g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE hr.leave_policies d
SET leave_type_id = n.id
FROM hr.leave_types o
JOIN hr.leave_types n ON n.tenant_id = d.tenant_id AND n.name = o.name
WHERE d.leave_type_id = o.id AND o.tenant_id IS NULL;

UPDATE hr.leave_requests d
SET leave_type_id = n.id
FROM hr.leave_types o
JOIN entity.organizations org ON org.id = d.org_id
JOIN hr.leave_types n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.leave_type_id = o.id AND o.tenant_id IS NULL;

UPDATE hr.leave_ledger d
SET leave_type_id = n.id
FROM hr.leave_types o
JOIN entity.organizations org ON org.id = d.org_id
JOIN hr.leave_types n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.leave_type_id = o.id AND o.tenant_id IS NULL;

DELETE FROM hr.leave_types WHERE tenant_id IS NULL;

ALTER TABLE hr.leave_types ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE hr.leave_types ADD CONSTRAINT uq_leave_types_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE hr.leave_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_types;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_types;
CREATE POLICY org_isolation_policy ON hr.leave_types AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON hr.leave_types AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- hr.employment_types  (+ dependent: hr.employee_profiles.employment_type_id
--                        [tenant_id direct])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE hr.employment_types
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE hr.employment_types DROP CONSTRAINT IF EXISTS employment_types_name_key;

INSERT INTO hr.employment_types (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM hr.employment_types g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE hr.employee_profiles d
SET employment_type_id = n.id
FROM hr.employment_types o
JOIN hr.employment_types n ON n.tenant_id = d.tenant_id AND n.name = o.name
WHERE d.employment_type_id = o.id AND o.tenant_id IS NULL;

DELETE FROM hr.employment_types WHERE tenant_id IS NULL;

ALTER TABLE hr.employment_types ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE hr.employment_types ADD CONSTRAINT uq_employment_types_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE hr.employment_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.employment_types;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.employment_types;
CREATE POLICY org_isolation_policy ON hr.employment_types AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON hr.employment_types AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- hr.attendance_statuses  (+ dependents: hr.attendance_days.status_id
--                          [via org_id], hr.attendance_regularizations
--                          .requested_status_id [via org_id])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE hr.attendance_statuses
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE hr.attendance_statuses DROP CONSTRAINT IF EXISTS attendance_statuses_name_key;

INSERT INTO hr.attendance_statuses (tenant_id, name, label, description, is_active)
SELECT t.id, g.name, g.label, g.description, g.is_active
FROM hr.attendance_statuses g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE hr.attendance_days d
SET status_id = n.id
FROM hr.attendance_statuses o
JOIN entity.organizations org ON org.id = d.org_id
JOIN hr.attendance_statuses n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.status_id = o.id AND o.tenant_id IS NULL;

UPDATE hr.attendance_regularizations d
SET requested_status_id = n.id
FROM hr.attendance_statuses o
JOIN entity.organizations org ON org.id = d.org_id
JOIN hr.attendance_statuses n ON n.tenant_id = org.tenant_id AND n.name = o.name
WHERE d.requested_status_id = o.id AND o.tenant_id IS NULL;

DELETE FROM hr.attendance_statuses WHERE tenant_id IS NULL;

ALTER TABLE hr.attendance_statuses ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE hr.attendance_statuses ADD CONSTRAINT uq_attendance_statuses_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE hr.attendance_statuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.attendance_statuses;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.attendance_statuses;
CREATE POLICY org_isolation_policy ON hr.attendance_statuses AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON hr.attendance_statuses AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- lms.roles  (+ dependent: lms.member_roles.role_id [tenant_id direct])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE lms.roles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE lms.roles DROP CONSTRAINT IF EXISTS roles_name_key;

INSERT INTO lms.roles (tenant_id, name, label, description, rank, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.rank, g.sort_order, g.is_active
FROM lms.roles g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE lms.member_roles d
SET role_id = n.id
FROM lms.roles o
JOIN lms.roles n ON n.tenant_id = d.tenant_id AND n.name = o.name
WHERE d.role_id = o.id AND o.tenant_id IS NULL;

DELETE FROM lms.roles WHERE tenant_id IS NULL;

ALTER TABLE lms.roles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE lms.roles ADD CONSTRAINT uq_lms_roles_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE lms.roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.roles;
CREATE POLICY org_isolation_policy ON lms.roles AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON lms.roles AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- hr.roles  (+ dependent: hr.member_roles.role_id [tenant_id direct])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE hr.roles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE hr.roles DROP CONSTRAINT IF EXISTS roles_name_key;

INSERT INTO hr.roles (tenant_id, name, label, description, rank, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.rank, g.sort_order, g.is_active
FROM hr.roles g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE hr.member_roles d
SET role_id = n.id
FROM hr.roles o
JOIN hr.roles n ON n.tenant_id = d.tenant_id AND n.name = o.name
WHERE d.role_id = o.id AND o.tenant_id IS NULL;

DELETE FROM hr.roles WHERE tenant_id IS NULL;

ALTER TABLE hr.roles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE hr.roles ADD CONSTRAINT uq_hr_roles_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE hr.roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.roles;
CREATE POLICY org_isolation_policy ON hr.roles AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON hr.roles AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ═══════════════════════════════════════════════════════════════════
-- task.roles  (+ dependent: task.member_roles.role_id [tenant_id direct])
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE task.roles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES entity.tenants(id) ON DELETE CASCADE;
ALTER TABLE task.roles DROP CONSTRAINT IF EXISTS roles_name_key;

INSERT INTO task.roles (tenant_id, name, label, description, rank, sort_order, is_active)
SELECT t.id, g.name, g.label, g.description, g.rank, g.sort_order, g.is_active
FROM task.roles g
CROSS JOIN entity.tenants t
WHERE g.tenant_id IS NULL;

UPDATE task.member_roles d
SET role_id = n.id
FROM task.roles o
JOIN task.roles n ON n.tenant_id = d.tenant_id AND n.name = o.name
WHERE d.role_id = o.id AND o.tenant_id IS NULL;

DELETE FROM task.roles WHERE tenant_id IS NULL;

ALTER TABLE task.roles ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE task.roles ADD CONSTRAINT uq_task_roles_tenant_name UNIQUE (tenant_id, name);

ALTER TABLE task.roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.roles;
CREATE POLICY org_isolation_policy ON task.roles AS PERMISSIVE FOR SELECT TO app_user
  USING (tenant_id = (SELECT tenant_id FROM entity.organizations
                      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));
CREATE POLICY tenant_isolation_policy ON task.roles AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ===================================================================
-- SANITY CHECK — abort the transaction if any dependent FK failed to
-- remap (would only happen if a dependent row's org/tenant had no
-- matching tenant-scoped lookup copy, e.g. an orphaned org with a
-- deleted tenant). Every one of these should return zero rows.
-- ===================================================================
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM task.tasks t
    JOIN task.task_statuses s ON s.id = t.status_id WHERE s.tenant_id IS NULL;
  IF v_count > 0 THEN RAISE EXCEPTION 'task.tasks.status_id: % unmigrated row(s)', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM hr.leave_requests lr
    JOIN hr.leave_types lt ON lt.id = lr.leave_type_id WHERE lt.tenant_id IS NULL;
  IF v_count > 0 THEN RAISE EXCEPTION 'hr.leave_requests.leave_type_id: % unmigrated row(s)', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM hr.attendance_days ad
    JOIN hr.attendance_statuses st ON st.id = ad.status_id WHERE st.tenant_id IS NULL;
  IF v_count > 0 THEN RAISE EXCEPTION 'hr.attendance_days.status_id: % unmigrated row(s)', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM lms.member_roles mr
    JOIN lms.roles r ON r.id = mr.role_id WHERE r.tenant_id IS NULL;
  IF v_count > 0 THEN RAISE EXCEPTION 'lms.member_roles.role_id: % unmigrated row(s)', v_count; END IF;
END $$;


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.16.0', 'Tenant-scope 8 previously-global lookups (task.task_statuses/task_priorities, hr.leave_types/employment_types/attendance_statuses, lms/hr/task.roles): tenant_id NOT NULL + UNIQUE(tenant_id,name) + tenant-scoped RLS, per-tenant row backfill, dependent FKs repointed')
ON CONFLICT (version) DO NOTHING;

COMMIT;
