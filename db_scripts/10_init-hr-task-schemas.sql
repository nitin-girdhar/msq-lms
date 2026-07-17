-- ===================================================================
-- CRM Monorepo — HR + Task Platform Foundation (Phase 0, DB layer only)
-- Adds: hr + task schemas, hr_svc/task_svc login roles,
--       entity.tenant_modules (module entitlements),
--       HR global lookups, org-scoped hr.departments / hr.designations,
--       hr.employee_profiles (IAM↔HR bridge, incl. dormant face-verify cols).
-- Prerequisite: 01_init-db.sql + 01_init-lookup-data.sql already applied.
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING /
--             guarded DO blocks / DROP+CREATE for triggers & policies).
-- Style, guard patterns and ordering mirror db_scripts/01_init-db.sql.
-- No existing table, trigger or policy is modified.
-- ===================================================================


-- ── Schemas ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS hr;
CREATE SCHEMA IF NOT EXISTS task;   -- no tables yet — populated in a later increment


-- ===================================================================
-- NEW SERVICE LOGIN ROLES  (per-microservice credentials, via app_user)
-- Mirrors the lead_svc / meta_svc setup in 01_init-db.sql: each service
-- connects with its own login role, then does SET LOCAL ROLE app_user +
-- session GUCs so RLS + app_user grants apply.
-- ===================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_svc') THEN
    CREATE ROLE hr_svc WITH LOGIN PASSWORD 'HrSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE hr_svc WITH LOGIN PASSWORD 'HrSvc_Dev2025' NOINHERIT; END IF;
END; $$;
GRANT app_user TO hr_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'task_svc') THEN
    CREATE ROLE task_svc WITH LOGIN PASSWORD 'TaskSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE task_svc WITH LOGIN PASSWORD 'TaskSvc_Dev2025' NOINHERIT; END IF;
END; $$;
GRANT app_user TO task_svc;


-- ── Schema USAGE grants ────────────────────────────────────────────
-- New schemas usable by the standard subject roles + service superuser,
-- matching the "GRANT USAGE ON SCHEMA ..." block in 01_init-db.sql.
GRANT USAGE ON SCHEMA hr   TO app_user, tenant_admin, crm_service;
GRANT USAGE ON SCHEMA task TO app_user, tenant_admin, crm_service;

-- New service roles need USAGE on every schema they touch (they SET ROLE
-- app_user at runtime, but still connect as themselves first).
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['public','geo','entity','iam','crm','marketing','audit','ext','hr','task'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO hr_svc, task_svc', s);
  END LOOP;
END; $$;

DO $$
DECLARE v_db TEXT := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hr_svc',   v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO task_svc', v_db);
END; $$;

-- crm_service: unrestricted on the two new schemas + default privileges for
-- future tables. app_user / tenant_admin get SELECT-by-default (explicit DML
-- grants are declared per-table below, like every operational table in 01).
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['hr','task'] LOOP
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA %I TO crm_service', s);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO crm_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL PRIVILEGES ON TABLES    TO crm_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL PRIVILEGES ON SEQUENCES TO crm_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO app_user', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO tenant_admin', s);
  END LOOP;
END; $$;


-- ===================================================================
-- entity.tenant_modules — per-tenant module entitlements (§4.4)
-- Gates which platform modules (crm | leave | attendance | tasks) a tenant
-- has licensed. Only crm_service writes; tenant_admin + app_user read (so a
-- service can check entitlement for its current org's tenant).
-- ===================================================================
CREATE TABLE IF NOT EXISTS entity.tenant_modules (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id   UUID    NOT NULL REFERENCES entity.tenants(id) ON DELETE CASCADE,
  module      TEXT    NOT NULL CHECK (module IN ('crm','leave','attendance','tasks')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_tenant_modules_tenant_module UNIQUE (tenant_id, module)
);

DROP TRIGGER IF EXISTS trg_tenant_modules_updated_at ON entity.tenant_modules;
CREATE TRIGGER trg_tenant_modules_updated_at
  BEFORE UPDATE ON entity.tenant_modules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant
  ON entity.tenant_modules (tenant_id) WHERE is_active;

ALTER TABLE entity.tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity.tenant_modules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON entity.tenant_modules;
DROP POLICY IF EXISTS org_isolation_policy    ON entity.tenant_modules;

-- tenant_admin: SELECT own tenant's rows.
CREATE POLICY tenant_isolation_policy ON entity.tenant_modules
  AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- app_user: SELECT rows for the tenant owning their current org. app_user
-- sessions never set app.current_tenant_id (see withRoleTx), so tenant is
-- derived from the current org — same convention as ext.api_clients in 01.
CREATE POLICY org_isolation_policy ON entity.tenant_modules
  AS PERMISSIVE FOR SELECT TO app_user
  USING (
    tenant_id = (
      SELECT tenant_id FROM entity.organizations
      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );

GRANT SELECT          ON entity.tenant_modules TO app_user;
GRANT SELECT          ON entity.tenant_modules TO tenant_admin;
GRANT ALL PRIVILEGES  ON entity.tenant_modules TO crm_service;

-- Seed: every existing tenant gets an active 'crm' entitlement.
INSERT INTO entity.tenant_modules (tenant_id, module)
SELECT id, 'crm' FROM entity.tenants
ON CONFLICT (tenant_id, module) DO NOTHING;


-- ===================================================================
-- HR GLOBAL LOOKUP TABLES  (UUID PKs, same shape as crm.lead_stage — no RLS)
-- Managed globally (admin-service slugs); readable by every subject role.
-- ===================================================================

CREATE TABLE IF NOT EXISTS hr.employment_types (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS hr.leave_types (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_paid     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS hr.leave_request_statuses (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS hr.attendance_statuses (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── Lookup grants ──────────────────────────────────────────────────
GRANT SELECT         ON hr.employment_types, hr.leave_types, hr.leave_request_statuses, hr.attendance_statuses TO app_user;
GRANT SELECT         ON hr.employment_types, hr.leave_types, hr.leave_request_statuses, hr.attendance_statuses TO tenant_admin;
GRANT ALL PRIVILEGES ON hr.employment_types, hr.leave_types, hr.leave_request_statuses, hr.attendance_statuses TO crm_service;

-- ── Lookup seed data ───────────────────────────────────────────────
INSERT INTO hr.employment_types (name, label) VALUES
  ('full_time', 'Full Time'),
  ('part_time', 'Part Time'),
  ('contract',  'Contract'),
  ('intern',    'Intern')
ON CONFLICT (name) DO NOTHING;

INSERT INTO hr.leave_types (name, label, is_paid, sort_order) VALUES
  ('casual',       'Casual Leave',       TRUE,  1),
  ('sick',         'Sick Leave',         TRUE,  2),
  ('earned',       'Earned Leave',       TRUE,  3),
  ('maternity',    'Maternity Leave',    TRUE,  4),
  ('paternity',    'Paternity Leave',    TRUE,  5),
  ('bereavement',  'Bereavement Leave',  TRUE,  6),
  ('comp_off',     'Compensatory Off',   TRUE,  7),
  ('loss_of_pay',  'Loss of Pay',        FALSE, 8)
ON CONFLICT (name) DO NOTHING;

INSERT INTO hr.leave_request_statuses (name, label) VALUES
  ('draft',     'Draft'),
  ('pending',   'Pending'),
  ('approved',  'Approved'),
  ('rejected',  'Rejected'),
  ('cancelled', 'Cancelled'),
  ('withdrawn', 'Withdrawn')
ON CONFLICT (name) DO NOTHING;

INSERT INTO hr.attendance_statuses (name, label) VALUES
  ('present',    'Present'),
  ('absent',     'Absent'),
  ('half_day',   'Half Day'),
  ('on_leave',   'On Leave'),
  ('holiday',    'Holiday'),
  ('weekly_off', 'Weekly Off'),
  ('wfh',        'Work From Home')
ON CONFLICT (name) DO NOTHING;


-- ===================================================================
-- ORG-SCOPED HR REFERENCE TABLES
-- Standard operational-table recipe (copied from marketing.ad_campaigns):
-- UUIDv7 PK, org_id FK, soft-delete + audit columns, set_updated_at +
-- soft_delete_row + set_org_id + set_created_by + audit_row_changes triggers,
-- org_isolation_policy + tenant_isolation_policy RLS.
-- ===================================================================

-- ── hr.departments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.departments (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_departments_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_departments_updated_at        ON hr.departments;
CREATE TRIGGER trg_departments_updated_at
  BEFORE UPDATE ON hr.departments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_departments_soft_delete       ON hr.departments;
CREATE TRIGGER trg_departments_soft_delete
  BEFORE DELETE ON hr.departments FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_departments_set_org_id     ON hr.departments;
CREATE TRIGGER trg_00_departments_set_org_id
  BEFORE INSERT ON hr.departments FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_departments_set_created_by ON hr.departments;
CREATE TRIGGER trg_01_departments_set_created_by
  BEFORE INSERT ON hr.departments FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_departments_audit             ON hr.departments;
CREATE TRIGGER trg_departments_audit
  AFTER UPDATE OR DELETE ON hr.departments FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_departments_org
  ON hr.departments (org_id) WHERE NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uix_departments_org_name
  ON hr.departments (org_id, name) WHERE NOT is_deleted;

ALTER TABLE hr.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.departments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.departments;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.departments;
CREATE POLICY org_isolation_policy ON hr.departments AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.departments AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.departments TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.departments TO tenant_admin;
REVOKE DELETE                ON hr.departments FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.departments TO crm_service;

-- ── hr.designations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.designations (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_designations_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_designations_updated_at        ON hr.designations;
CREATE TRIGGER trg_designations_updated_at
  BEFORE UPDATE ON hr.designations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_designations_soft_delete       ON hr.designations;
CREATE TRIGGER trg_designations_soft_delete
  BEFORE DELETE ON hr.designations FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_designations_set_org_id     ON hr.designations;
CREATE TRIGGER trg_00_designations_set_org_id
  BEFORE INSERT ON hr.designations FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_designations_set_created_by ON hr.designations;
CREATE TRIGGER trg_01_designations_set_created_by
  BEFORE INSERT ON hr.designations FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_designations_audit             ON hr.designations;
CREATE TRIGGER trg_designations_audit
  AFTER UPDATE OR DELETE ON hr.designations FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_designations_org
  ON hr.designations (org_id) WHERE NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uix_designations_org_name
  ON hr.designations (org_id, name) WHERE NOT is_deleted;

ALTER TABLE hr.designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.designations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.designations;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.designations;
CREATE POLICY org_isolation_policy ON hr.designations AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.designations AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.designations TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.designations TO tenant_admin;
REVOKE DELETE                ON hr.designations FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.designations TO crm_service;


-- ===================================================================
-- hr.employee_profiles — the IAM ↔ HR bridge (§4.1)
-- 1:1 with iam.users (PK = user_id). Holds employment facts; keeps
-- iam.users pure (auth + hierarchy). tenant_id is denormalized and kept
-- consistent with org_id by a BEFORE trigger so employee_code can be made
-- unique per tenant (a joined-scope index isn't possible).
-- Face-verification columns are created now but stay dormant until Prompt 11.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.employee_profiles (
  user_id             UUID    PRIMARY KEY REFERENCES iam.users(id)            ON DELETE RESTRICT,
  org_id              UUID    NOT NULL    REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  -- denormalized from entity.organizations.tenant_id via trigger (see below);
  -- exists solely to enforce employee_code uniqueness per tenant.
  tenant_id           UUID    NOT NULL    REFERENCES entity.tenants(id)       ON DELETE RESTRICT,
  employee_code       TEXT,
  date_of_joining     DATE    NOT NULL,
  date_of_exit        DATE,
  employment_type_id  UUID    REFERENCES hr.employment_types(id) ON DELETE RESTRICT,
  department_id       UUID    REFERENCES hr.departments(id)      ON DELETE RESTRICT,
  designation_id      UUID    REFERENCES hr.designations(id)     ON DELETE RESTRICT,
  probation_end_date  DATE,
  -- days of week off, 0=Sunday .. 6=Saturday; overridable by shift assignment
  weekly_off_pattern  SMALLINT[] NOT NULL DEFAULT '{0,6}',
  metadata            JSONB   NOT NULL DEFAULT '{}',
  -- ── Face-verification enrollment (dormant until Prompt 11) ──
  reference_photo_url TEXT,
  face_subject_id     TEXT,
  face_enrolled_at    TIMESTAMPTZ,
  face_consent_at     TIMESTAMPTZ,
  -- ── standard soft-delete / audit ──
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ,
  deleted_by          UUID,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_employee_profiles_exit_after_joining
    CHECK (date_of_exit IS NULL OR date_of_exit >= date_of_joining),
  CONSTRAINT chk_employee_profiles_active_deleted CHECK (NOT (is_active AND is_deleted))
);

-- Resolve tenant_id from the row's org_id, keeping the two consistent.
-- Runs after set_org_id (trg_00) has populated org_id from the GUC.
CREATE OR REPLACE FUNCTION hr.set_employee_profile_tenant_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM entity.organizations WHERE id = NEW.org_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'employee_profiles: cannot resolve tenant_id for org_id %', NEW.org_id;
  END IF;
  NEW.tenant_id := v_tenant;
  RETURN NEW;
END; $$;

-- Soft-delete keyed on user_id (public.soft_delete_row assumes an `id`
-- column, which this table does not have). Mirrors its behavior otherwise.
CREATE OR REPLACE FUNCTION hr.soft_delete_employee_profile()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user_id UUID;
BEGIN
  IF current_user = 'crm_service' THEN RETURN OLD; END IF;
  BEGIN
    v_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_user_id := NULL; END;
  UPDATE hr.employee_profiles
     SET is_active = FALSE, is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = v_user_id
   WHERE user_id = OLD.user_id;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_employee_profiles_updated_at         ON hr.employee_profiles;
CREATE TRIGGER trg_employee_profiles_updated_at
  BEFORE UPDATE ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_employee_profiles_soft_delete        ON hr.employee_profiles;
CREATE TRIGGER trg_employee_profiles_soft_delete
  BEFORE DELETE ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION hr.soft_delete_employee_profile();

DROP TRIGGER IF EXISTS trg_00_employee_profiles_set_org_id      ON hr.employee_profiles;
CREATE TRIGGER trg_00_employee_profiles_set_org_id
  BEFORE INSERT ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_employee_profiles_set_created_by  ON hr.employee_profiles;
CREATE TRIGGER trg_01_employee_profiles_set_created_by
  BEFORE INSERT ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_02_employee_profiles_set_tenant_id   ON hr.employee_profiles;
CREATE TRIGGER trg_02_employee_profiles_set_tenant_id
  BEFORE INSERT OR UPDATE ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION hr.set_employee_profile_tenant_id();

DROP TRIGGER IF EXISTS trg_employee_profiles_audit              ON hr.employee_profiles;
CREATE TRIGGER trg_employee_profiles_audit
  AFTER UPDATE OR DELETE ON hr.employee_profiles FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_employee_profiles_org
  ON hr.employee_profiles (org_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_employee_profiles_tenant
  ON hr.employee_profiles (tenant_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_employee_profiles_department
  ON hr.employee_profiles (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_profiles_designation
  ON hr.employee_profiles (designation_id) WHERE designation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_profiles_employment_type
  ON hr.employee_profiles (employment_type_id) WHERE employment_type_id IS NOT NULL;

-- employee_code unique per tenant, among non-deleted rows that have a code.
CREATE UNIQUE INDEX IF NOT EXISTS uix_employee_profiles_tenant_code
  ON hr.employee_profiles (tenant_id, employee_code)
  WHERE employee_code IS NOT NULL AND NOT is_deleted;

ALTER TABLE hr.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.employee_profiles;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.employee_profiles;
DROP POLICY IF EXISTS self_read_policy        ON hr.employee_profiles;

CREATE POLICY org_isolation_policy ON hr.employee_profiles AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.employee_profiles AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- Self-read: any authenticated app_user may read their own profile row
-- regardless of the org currently in context. PERMISSIVE → OR-combined with
-- org_isolation_policy for SELECT.
CREATE POLICY self_read_policy ON hr.employee_profiles AS PERMISSIVE FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.employee_profiles TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.employee_profiles TO tenant_admin;
REVOKE DELETE                ON hr.employee_profiles FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.employee_profiles TO crm_service;


-- ===================================================================
-- ROLE SEED — hr_admin (rank 75). Canonical seed also lives in
-- 01_init-lookup-data.sql; repeated here idempotently so this migration is
-- self-contained. See Platform_Expansion_Plan.md §2.5 / §6.3.
-- ===================================================================
INSERT INTO iam.user_roles (name, label, description, rank) VALUES
  ('hr_admin', 'HR Admin', 'Manages HR — employee profiles, leave policies, attendance; no CRM/lead access', 75)
ON CONFLICT (name) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  rank        = EXCLUDED.rank;


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- NOTE: prompt requested '1.3.0', but 1.3.0 and 1.4.0 are already consumed by
-- the Meta CAPI work in 01_init-lookup-data.sql — using the next free version.
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.5.0', 'hr/task schemas, hr_svc/task_svc roles, entity.tenant_modules, HR lookups, hr.departments/designations, hr.employee_profiles, hr_admin role')
ON CONFLICT (version) DO NOTHING;
