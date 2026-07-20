-- ===================================================================
-- 17_init-per-product-roles.sql
--
-- P1.1 — Phase A (EXPAND, additive only): introduce per-product role
-- ladders and grants that will replace the single global iam.user_roles
-- ladder. NOTHING existing is modified or read here: the old ladder stays
-- fully authoritative until the flip (Phase D). This script is safe to
-- deploy on its own.
--
-- Creates, per product schema (lms | hr | task):
--   <product>.roles         — global role CATALOG lookup, own rank scale
--   <product>.member_roles  — (user, org) role GRANT, tenant-isolated + RLS
--   <product>.fn_member_rank(user, org) — SECURITY DEFINER own-rank helper
--   <product>.vw_member_roles           — security_invoker resolver view
-- Plus:
--   public.set_member_role_tenant_id()  — shared trigger: derive tenant_id
--                                          from org_id so clients can't spoof it
--   iam.users.platform_role             — nullable now; backfilled in script 18,
--                                          made NOT NULL in the Phase E contract
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE for triggers
-- & policies / ON CONFLICT DO NOTHING. Style mirrors db_scripts/01_init-db.sql
-- and 10_init-hr-task-schemas.sql.
-- ===================================================================

BEGIN;

-- ===================================================================
-- SHARED TRIGGER FUNCTION — derive member_roles.tenant_id from org_id
-- tenant_id is denormalized onto member_roles so the tenant_admin RLS
-- policy needs no join. This trigger sets it authoritatively from the
-- org's real tenant on every INSERT/UPDATE, so an app_user cannot write
-- a spoofed tenant_id to escape isolation.
-- ===================================================================
CREATE OR REPLACE FUNCTION public.set_member_role_tenant_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT tenant_id INTO NEW.tenant_id
  FROM entity.organizations
  WHERE id = NEW.org_id;
  IF NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION 'org_id % does not resolve to a tenant', NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;


-- ===================================================================
-- PER-PRODUCT ROLE CATALOGS  (global reference data, no RLS — same
-- management model as hr.employment_types / lms.lead_stage). Each product
-- owns its own rank scale; ranks are only comparable WITHIN a product.
-- ===================================================================

CREATE TABLE IF NOT EXISTS lms.roles (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,   -- machine key, stable
  label       TEXT    NOT NULL,
  description TEXT,
  rank        INT     NOT NULL DEFAULT 0
                      CONSTRAINT chk_lms_roles_rank CHECK (rank >= 0 AND rank <= 100),
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS hr.roles (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  rank        INT     NOT NULL DEFAULT 0
                      CONSTRAINT chk_hr_roles_rank CHECK (rank >= 0 AND rank <= 100),
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS task.roles (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  rank        INT     NOT NULL DEFAULT 0
                      CONSTRAINT chk_task_roles_rank CHECK (rank >= 0 AND rank <= 100),
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── Catalog grants (readable by every subject role; only root_service writes)
GRANT SELECT         ON lms.roles, hr.roles, task.roles TO app_user;
GRANT SELECT         ON lms.roles, hr.roles, task.roles TO tenant_admin;
GRANT ALL PRIVILEGES ON lms.roles, hr.roles, task.roles TO root_service;

-- ── Catalog seed data ──────────────────────────────────────────────
-- LMS ladder = the current sales ladder; org_admin maps to lms_admin (80).
INSERT INTO lms.roles (name, label, description, rank, sort_order) VALUES
  ('read_only',              'Read Only',              'Read-only viewer — dashboards and reports only',                            0, 1),
  ('sales_representative',   'Sales Representative',   'Front-line sales — manages own assigned leads and follow-ups',             20, 2),
  ('senior_sales_executive', 'Senior Sales Executive', 'Manages a team of sales reps',                                             40, 3),
  ('org_manager',            'Manager',                'Manages a team of Senior Sales Executives and reps within an org',         60, 4),
  ('org_sr_manager',         'Senior Manager',         'Manages a team of managers and reps within an org',                        70, 5),
  ('lms_admin',              'LMS Admin',              'Full control of the LMS product within an org',                            80, 6)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description,
  rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order;

-- HR ladder (own scale). hr_admin (80) is the top; maps from the old hr_admin.
INSERT INTO hr.roles (name, label, description, rank, sort_order) VALUES
  ('hr_viewer',  'HR Viewer',  'Read-only access to HR data',                                  0, 1),
  ('hr_staff',   'HR Staff',   'Day-to-day HR operations — leave/attendance entry',           40, 2),
  ('hr_manager', 'HR Manager', 'Approves leave, manages team attendance',                     70, 3),
  ('hr_admin',   'HR Admin',   'Full control of the HR product — profiles, policies, config', 80, 4)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description,
  rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order;

-- Task ladder (own scale). No prior ladder existed; task_member is the seed default.
INSERT INTO task.roles (name, label, description, rank, sort_order) VALUES
  ('task_member', 'Task Member', 'Creates and works own tasks',                     20, 1),
  ('task_lead',   'Task Lead',   'Manages a team''s tasks and lists',               40, 2),
  ('task_admin',  'Task Admin',  'Full control of the Tasks product within an org', 80, 3)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label, description = EXCLUDED.description,
  rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order;


-- ===================================================================
-- PER-PRODUCT MEMBER_ROLES  (the (user, product, role) grant).
-- Org-grained (preserves multi-org users), tenant-isolated via RLS.
-- Shape and grant model mirror iam.user_org_mapping.
-- ===================================================================

-- ── lms.member_roles ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms.member_roles (
  user_id    UUID        NOT NULL REFERENCES iam.users(id)            ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES entity.organizations(id) ON DELETE CASCADE,
  tenant_id  UUID        NOT NULL REFERENCES entity.tenants(id)       ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES lms.roles(id)            ON DELETE RESTRICT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by UUID        REFERENCES iam.users(id)                     ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_lms_member_roles_org_active
  ON lms.member_roles (org_id)    WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_lms_member_roles_tenant_active
  ON lms.member_roles (tenant_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_lms_member_roles_role
  ON lms.member_roles (role_id);

DROP TRIGGER IF EXISTS trg_00_lms_member_roles_tenant_id ON lms.member_roles;
CREATE TRIGGER trg_00_lms_member_roles_tenant_id
  BEFORE INSERT OR UPDATE ON lms.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_member_role_tenant_id();

DROP TRIGGER IF EXISTS trg_lms_member_roles_updated_at ON lms.member_roles;
CREATE TRIGGER trg_lms_member_roles_updated_at
  BEFORE UPDATE ON lms.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE lms.member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.member_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON lms.member_roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.member_roles;

CREATE POLICY org_isolation_policy ON lms.member_roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON lms.member_roles
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON lms.member_roles TO app_user;
GRANT SELECT, INSERT, UPDATE ON lms.member_roles TO tenant_admin;
GRANT ALL PRIVILEGES         ON lms.member_roles TO root_service;

-- ── hr.member_roles ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.member_roles (
  user_id    UUID        NOT NULL REFERENCES iam.users(id)            ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES entity.organizations(id) ON DELETE CASCADE,
  tenant_id  UUID        NOT NULL REFERENCES entity.tenants(id)       ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES hr.roles(id)             ON DELETE RESTRICT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by UUID        REFERENCES iam.users(id)                     ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_member_roles_org_active
  ON hr.member_roles (org_id)    WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_hr_member_roles_tenant_active
  ON hr.member_roles (tenant_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_hr_member_roles_role
  ON hr.member_roles (role_id);

DROP TRIGGER IF EXISTS trg_00_hr_member_roles_tenant_id ON hr.member_roles;
CREATE TRIGGER trg_00_hr_member_roles_tenant_id
  BEFORE INSERT OR UPDATE ON hr.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_member_role_tenant_id();

DROP TRIGGER IF EXISTS trg_hr_member_roles_updated_at ON hr.member_roles;
CREATE TRIGGER trg_hr_member_roles_updated_at
  BEFORE UPDATE ON hr.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE hr.member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.member_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON hr.member_roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.member_roles;

CREATE POLICY org_isolation_policy ON hr.member_roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON hr.member_roles
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON hr.member_roles TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.member_roles TO tenant_admin;
GRANT ALL PRIVILEGES         ON hr.member_roles TO root_service;

-- ── task.member_roles ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task.member_roles (
  user_id    UUID        NOT NULL REFERENCES iam.users(id)            ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES entity.organizations(id) ON DELETE CASCADE,
  tenant_id  UUID        NOT NULL REFERENCES entity.tenants(id)       ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES task.roles(id)           ON DELETE RESTRICT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by UUID        REFERENCES iam.users(id)                     ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_task_member_roles_org_active
  ON task.member_roles (org_id)    WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_task_member_roles_tenant_active
  ON task.member_roles (tenant_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_task_member_roles_role
  ON task.member_roles (role_id);

DROP TRIGGER IF EXISTS trg_00_task_member_roles_tenant_id ON task.member_roles;
CREATE TRIGGER trg_00_task_member_roles_tenant_id
  BEFORE INSERT OR UPDATE ON task.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_member_role_tenant_id();

DROP TRIGGER IF EXISTS trg_task_member_roles_updated_at ON task.member_roles;
CREATE TRIGGER trg_task_member_roles_updated_at
  BEFORE UPDATE ON task.member_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE task.member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE task.member_roles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON task.member_roles;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.member_roles;

CREATE POLICY org_isolation_policy ON task.member_roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON task.member_roles
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON task.member_roles TO app_user;
GRANT SELECT, INSERT, UPDATE ON task.member_roles TO tenant_admin;
GRANT ALL PRIVILEGES         ON task.member_roles TO root_service;


-- ===================================================================
-- OWN-RANK HELPERS  (SECURITY DEFINER — bypass member_roles RLS so they
-- can be called inside OTHER tables' RLS policies without recursion.
-- Mirrors iam.fn_user_org_rank. Returns -1 when the user has no active
-- grant in that product+org, which is how "no product access" is encoded.
-- ===================================================================

CREATE OR REPLACE FUNCTION lms.fn_member_rank(p_user_id UUID, p_org_id UUID)
RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_rank INT;
BEGIN
  SELECT r.rank INTO v_rank
  FROM lms.member_roles mr
  JOIN lms.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active;
  RETURN COALESCE(v_rank, -1);
END; $$;

CREATE OR REPLACE FUNCTION hr.fn_member_rank(p_user_id UUID, p_org_id UUID)
RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_rank INT;
BEGIN
  SELECT r.rank INTO v_rank
  FROM hr.member_roles mr
  JOIN hr.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active;
  RETURN COALESCE(v_rank, -1);
END; $$;

CREATE OR REPLACE FUNCTION task.fn_member_rank(p_user_id UUID, p_org_id UUID)
RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_rank INT;
BEGIN
  SELECT r.rank INTO v_rank
  FROM task.member_roles mr
  JOIN task.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active;
  RETURN COALESCE(v_rank, -1);
END; $$;


-- ===================================================================
-- RESOLVER VIEWS  (vw_ + security_invoker: RLS on member_roles applies
-- through the view for the calling role). Resolve role -> name/label/rank.
-- ===================================================================

CREATE OR REPLACE VIEW lms.vw_member_roles WITH (security_invoker = true) AS
SELECT
  mr.user_id,
  u.full_name  AS user_name,
  u.email      AS user_email,
  mr.org_id,
  o.name       AS org_name,
  mr.tenant_id,
  mr.role_id,
  r.name       AS role,
  r.label      AS role_label,
  r.rank       AS rank,
  mr.is_active,
  mr.granted_by,
  mr.granted_at,
  mr.updated_at
FROM lms.member_roles mr
JOIN      iam.users            u ON u.id = mr.user_id
JOIN      entity.organizations o ON o.id = mr.org_id
JOIN      lms.roles            r ON r.id = mr.role_id;

CREATE OR REPLACE VIEW hr.vw_member_roles WITH (security_invoker = true) AS
SELECT
  mr.user_id,
  u.full_name  AS user_name,
  u.email      AS user_email,
  mr.org_id,
  o.name       AS org_name,
  mr.tenant_id,
  mr.role_id,
  r.name       AS role,
  r.label      AS role_label,
  r.rank       AS rank,
  mr.is_active,
  mr.granted_by,
  mr.granted_at,
  mr.updated_at
FROM hr.member_roles mr
JOIN      iam.users            u ON u.id = mr.user_id
JOIN      entity.organizations o ON o.id = mr.org_id
JOIN      hr.roles             r ON r.id = mr.role_id;

CREATE OR REPLACE VIEW task.vw_member_roles WITH (security_invoker = true) AS
SELECT
  mr.user_id,
  u.full_name  AS user_name,
  u.email      AS user_email,
  mr.org_id,
  o.name       AS org_name,
  mr.tenant_id,
  mr.role_id,
  r.name       AS role,
  r.label      AS role_label,
  r.rank       AS rank,
  mr.is_active,
  mr.granted_by,
  mr.granted_at,
  mr.updated_at
FROM task.member_roles mr
JOIN      iam.users            u ON u.id = mr.user_id
JOIN      entity.organizations o ON o.id = mr.org_id
JOIN      task.roles           r ON r.id = mr.role_id;

GRANT SELECT ON lms.vw_member_roles, hr.vw_member_roles, task.vw_member_roles TO app_user;
GRANT SELECT ON lms.vw_member_roles, hr.vw_member_roles, task.vw_member_roles TO tenant_admin;


-- ===================================================================
-- iam.users.platform_role — the single, coarse cross-product role that
-- survives in the shrunk JWT. Nullable now (backfilled in script 18,
-- made NOT NULL in the Phase E contract). Drives PG-role selection and
-- platform-wide capabilities only; product authority comes from
-- <product>.member_roles.
-- ===================================================================
ALTER TABLE iam.users
  ADD COLUMN IF NOT EXISTS platform_role TEXT
    CONSTRAINT chk_users_platform_role
    CHECK (platform_role IN ('super_admin','tenant_admin','org_admin','member'));


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.11.0', 'P1.1 Phase A (expand): per-product role catalogs (lms/hr/task.roles) + grants (member_roles) with RLS + fn_member_rank + vw_member_roles + iam.users.platform_role (nullable); global iam.user_roles ladder untouched')
ON CONFLICT (version) DO NOTHING;

COMMIT;
