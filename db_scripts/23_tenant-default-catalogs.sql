-- ===================================================================
-- 23_tenant-default-catalogs.sql
--
-- Platform_Refactor_Prompts.md "Tenant default seeding" /
-- Platform_Implementation_Plan.md Phase 3B:
--   seedTenantDefaults(tenantId) provisioning step + versioned default
--   catalogs (per product), inserting a private copy per licensed product.
--
-- Solves the KNOWN FOLLOW-UP flagged in 22_tenant-scope-lookups.sql: a
-- brand-new tenant had ZERO rows in the 8 tenant-scoped lookup tables until
-- an operator hand-seeded them. This script adds a versioned default-catalog
-- registry and the SQL side of the provisioning seeder + an explicit opt-in
-- "reset to defaults" path.
--
-- ── Model ──────────────────────────────────────────────────────────
--   entity.catalog_versions        one row per catalog: which version a NEW
--                                  tenant is seeded from, and which licensed
--                                  modules gate it (`modules` array).
--   entity.catalog_defaults        the immutable, versioned default ROWS
--                                  (append-only: a new default = a new
--                                  version; existing versions are never
--                                  mutated). This is why editing a catalog
--                                  never retroactively touches existing
--                                  tenants — their private copy was made from
--                                  the version current AT provisioning time.
--   entity.tenant_catalog_versions per-tenant record of which catalog version
--                                  was seeded / last reset. Drives idempotency
--                                  (seed skips catalogs already recorded).
--
-- ── Functions ──────────────────────────────────────────────────────
--   entity.seed_tenant_defaults(tenant)             provisioning entry point.
--   entity.reset_tenant_catalog(tenant, key, ver?)  opt-in restore-to-default.
--   entity._apply_catalog_rows(...)                 shared per-catalog copy.
--
-- Catalogs covered (the 8 tenant-scoped lookups from script 22):
--   lms.roles                (module: lms)
--   task.task_statuses       (module: tasks)
--   task.task_priorities     (module: tasks)
--   task.roles               (module: tasks)
--   hr.leave_types           (module: leave)
--   hr.attendance_statuses   (module: attendance)
--   hr.roles                 (modules: leave OR attendance — HR-wide)
--   hr.employment_types      (modules: leave OR attendance — HR-wide)
--
-- Idempotent: tables use IF NOT EXISTS; functions CREATE OR REPLACE; the
-- default-catalog seed and existing-tenant backfill both guard on ON CONFLICT
-- / NOT EXISTS, so a second run is a no-op.
-- ===================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- 1. entity.catalog_defaults — immutable, versioned default rows
--    One table for every catalog. The core lookup shape (name/label/
--    description/sort_order/is_active) is shared; the few per-catalog
--    extras live in dedicated NULLABLE columns (is_terminal → task
--    statuses, is_paid → leave types, rank → roles). Never UPDATE an
--    existing (catalog_key, version) row set — ship a new version.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entity.catalog_defaults (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  catalog_key TEXT    NOT NULL,          -- schema-qualified target, e.g. 'task.task_statuses'
  product     TEXT    NOT NULL,          -- owning product (lms|leave|attendance|tasks)
  version     INT     NOT NULL,          -- catalog version this row belongs to
  name        TEXT    NOT NULL,          -- machine key (stable) copied verbatim into the tenant row
  label       TEXT    NOT NULL,
  description TEXT,
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_terminal BOOLEAN,                   -- task.task_statuses only
  is_paid     BOOLEAN,                   -- hr.leave_types only
  rank        INT,                       -- *.roles only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_catalog_defaults_key_version_name UNIQUE (catalog_key, version, name)
);
CREATE INDEX IF NOT EXISTS idx_catalog_defaults_key_version
  ON entity.catalog_defaults (catalog_key, version);


-- ═══════════════════════════════════════════════════════════════════
-- 2. entity.catalog_versions — the "current" version + module gating
--    per catalog. Editing a catalog for FUTURE tenants = add rows to
--    catalog_defaults at version N+1 and bump current_version here.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entity.catalog_versions (
  catalog_key     TEXT    PRIMARY KEY,       -- schema-qualified target table
  product         TEXT    NOT NULL,
  modules         TEXT[]  NOT NULL,          -- seed if the tenant has ANY of these active modules
  current_version INT     NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_catalog_versions_updated_at ON entity.catalog_versions;
CREATE TRIGGER trg_catalog_versions_updated_at BEFORE UPDATE ON entity.catalog_versions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ═══════════════════════════════════════════════════════════════════
-- 3. entity.tenant_catalog_versions — per-tenant provisioning record.
--    Tenant-scoped: RLS mirrors entity.tenant_modules (SELECT-only for
--    subject roles; only root_service writes, via the seeder functions).
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entity.tenant_catalog_versions (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id   UUID    NOT NULL REFERENCES entity.tenants(id) ON DELETE CASCADE,
  catalog_key TEXT    NOT NULL,
  version     INT     NOT NULL,
  seeded_at   TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  reset_at    TIMESTAMPTZ,
  CONSTRAINT uq_tenant_catalog_versions_tenant_key UNIQUE (tenant_id, catalog_key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_catalog_versions_tenant
  ON entity.tenant_catalog_versions (tenant_id);

ALTER TABLE entity.tenant_catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity.tenant_catalog_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON entity.tenant_catalog_versions;
DROP POLICY IF EXISTS org_isolation_policy    ON entity.tenant_catalog_versions;

-- tenant_admin: SELECT own tenant's rows.
CREATE POLICY tenant_isolation_policy ON entity.tenant_catalog_versions
  AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- app_user: SELECT rows for the tenant owning their current org (app_user
-- sessions never set app.current_tenant_id — same convention as
-- entity.tenant_modules).
CREATE POLICY org_isolation_policy ON entity.tenant_catalog_versions
  AS PERMISSIVE FOR SELECT TO app_user
  USING (
    tenant_id = (
      SELECT tenant_id FROM entity.organizations
      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );


-- ═══════════════════════════════════════════════════════════════════
-- 4. GRANTs
--    Registry tables are global reference data (no tenant_id, no RLS):
--    readable by subject roles for a future "preview defaults" UI, written
--    only by root_service. tenant_catalog_versions is SELECT-only for
--    subject roles; root_service (the seeder) writes it.
-- ═══════════════════════════════════════════════════════════════════
GRANT SELECT         ON entity.catalog_defaults, entity.catalog_versions TO app_user;
GRANT SELECT         ON entity.catalog_defaults, entity.catalog_versions TO tenant_admin;
GRANT ALL PRIVILEGES ON entity.catalog_defaults, entity.catalog_versions TO root_service;

GRANT SELECT         ON entity.tenant_catalog_versions TO app_user;
GRANT SELECT         ON entity.tenant_catalog_versions TO tenant_admin;
GRANT ALL PRIVILEGES ON entity.tenant_catalog_versions TO root_service;


-- ═══════════════════════════════════════════════════════════════════
-- 5. entity._apply_catalog_rows — shared per-catalog copy helper.
--    Copies the default rows of (p_catalog_key, p_version) into the
--    tenant's private lookup table.
--
--    p_reset = FALSE (seed): insert only rows the tenant doesn't already
--      have (ON CONFLICT DO NOTHING) — never overwrites tenant edits.
--    p_reset = TRUE (reset):  additionally restore label/description/
--      sort_order/is_active (+ the per-catalog extra) of conflicting rows
--      back to the default. The row `id` is preserved on conflict, so FKs
--      from tenant data (e.g. task.tasks.status_id) stay valid; only
--      previously hard-deleted defaults get a fresh id. Tenant-custom rows
--      (names not in the catalog) are left untouched.
--
--    Returns the number of rows inserted/updated.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION entity._apply_catalog_rows(
  p_tenant_id   UUID,
  p_catalog_key TEXT,
  p_version     INT,
  p_reset       BOOLEAN
) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE v_rows INT := 0;
BEGIN
  IF p_catalog_key = 'task.task_statuses' THEN
    INSERT INTO task.task_statuses (tenant_id, name, label, description, is_terminal, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, COALESCE(d.is_terminal, FALSE), d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          is_terminal = EXCLUDED.is_terminal, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'task.task_priorities' THEN
    INSERT INTO task.task_priorities (tenant_id, name, label, description, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'hr.leave_types' THEN
    INSERT INTO hr.leave_types (tenant_id, name, label, description, is_paid, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, COALESCE(d.is_paid, TRUE), d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          is_paid = EXCLUDED.is_paid, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'hr.employment_types' THEN
    INSERT INTO hr.employment_types (tenant_id, name, label, description, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'hr.attendance_statuses' THEN
    INSERT INTO hr.attendance_statuses (tenant_id, name, label, description, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'lms.roles' THEN
    INSERT INTO lms.roles (tenant_id, name, label, description, rank, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, COALESCE(d.rank, 0), d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'hr.roles' THEN
    INSERT INTO hr.roles (tenant_id, name, label, description, rank, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, COALESCE(d.rank, 0), d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSIF p_catalog_key = 'task.roles' THEN
    INSERT INTO task.roles (tenant_id, name, label, description, rank, sort_order, is_active)
    SELECT p_tenant_id, d.name, d.label, d.description, COALESCE(d.rank, 0), d.sort_order, d.is_active
    FROM entity.catalog_defaults d
    WHERE d.catalog_key = p_catalog_key AND d.version = p_version
    ON CONFLICT (tenant_id, name) DO UPDATE
      SET label = EXCLUDED.label, description = EXCLUDED.description,
          rank = EXCLUDED.rank, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active
      WHERE p_reset;

  ELSE
    RAISE EXCEPTION '_apply_catalog_rows: unknown catalog_key %', p_catalog_key;
  END IF;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END; $$;


-- ═══════════════════════════════════════════════════════════════════
-- 6. entity.seed_tenant_defaults — the provisioning entry point.
--    For every catalog whose gating modules overlap the tenant's ACTIVE
--    modules and that hasn't been seeded yet, copy the current version's
--    default rows into the tenant's private tables and record the version.
--    Idempotent: catalogs already in tenant_catalog_versions are skipped,
--    so re-running provisioning never overwrites tenant customisations.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION entity.seed_tenant_defaults(p_tenant_id UUID)
RETURNS TABLE(catalog_key TEXT, seeded_version INT, rows_inserted INT)
LANGUAGE plpgsql AS $$
DECLARE
  v_active TEXT[];
  cv       RECORD;
  v_rows   INT;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'seed_tenant_defaults: tenant id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM entity.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'seed_tenant_defaults: tenant % not found', p_tenant_id;
  END IF;

  SELECT COALESCE(array_agg(module), ARRAY[]::TEXT[]) INTO v_active
  FROM entity.tenant_modules
  WHERE tenant_id = p_tenant_id AND is_active;

  FOR cv IN SELECT c.catalog_key, c.current_version, c.modules FROM entity.catalog_versions c LOOP
    -- Only seed catalogs for LICENSED products.
    IF NOT (cv.modules && v_active) THEN CONTINUE; END IF;
    -- Never re-seed a catalog the tenant already provisioned (non-retroactive).
    IF EXISTS (
      SELECT 1 FROM entity.tenant_catalog_versions t
      WHERE t.tenant_id = p_tenant_id AND t.catalog_key = cv.catalog_key
    ) THEN CONTINUE; END IF;

    v_rows := entity._apply_catalog_rows(p_tenant_id, cv.catalog_key, cv.current_version, FALSE);

    INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
    VALUES (p_tenant_id, cv.catalog_key, cv.current_version);

    catalog_key    := cv.catalog_key;
    seeded_version := cv.current_version;
    rows_inserted  := v_rows;
    RETURN NEXT;
  END LOOP;
END; $$;


-- ═══════════════════════════════════════════════════════════════════
-- 7. entity.reset_tenant_catalog — explicit opt-in "reset to defaults".
--    Restores one catalog for one tenant back to a default version
--    (defaults to the current version). Re-adds deleted defaults and
--    restores default label/flags/sort_order on existing rows WITHOUT
--    changing row ids (FK-safe). Does NOT remove tenant-custom rows.
--    Records the reset on tenant_catalog_versions. Returns rows affected.
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION entity.reset_tenant_catalog(
  p_tenant_id   UUID,
  p_catalog_key TEXT,
  p_version     INT DEFAULT NULL
) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  v_current INT;
  v_version INT;
  v_rows    INT;
BEGIN
  IF p_tenant_id IS NULL OR p_catalog_key IS NULL THEN
    RAISE EXCEPTION 'reset_tenant_catalog: tenant id and catalog key are required';
  END IF;

  SELECT current_version INTO v_current FROM entity.catalog_versions WHERE catalog_key = p_catalog_key;
  IF v_current IS NULL THEN
    RAISE EXCEPTION 'reset_tenant_catalog: unknown catalog %', p_catalog_key;
  END IF;

  v_version := COALESCE(p_version, v_current);
  IF NOT EXISTS (
    SELECT 1 FROM entity.catalog_defaults WHERE catalog_key = p_catalog_key AND version = v_version
  ) THEN
    RAISE EXCEPTION 'reset_tenant_catalog: catalog % has no version %', p_catalog_key, v_version;
  END IF;

  v_rows := entity._apply_catalog_rows(p_tenant_id, p_catalog_key, v_version, TRUE);

  INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version, reset_at)
  VALUES (p_tenant_id, p_catalog_key, v_version, CLOCK_TIMESTAMP())
  ON CONFLICT (tenant_id, catalog_key) DO UPDATE
    SET version = EXCLUDED.version, reset_at = CLOCK_TIMESTAMP();

  RETURN v_rows;
END; $$;


-- ═══════════════════════════════════════════════════════════════════
-- 8. Function privileges — these functions cross tenant boundaries and
--    must only run as the BYPASSRLS service account (called from
--    @crm/db's withServiceTx at provisioning / from the tenant-scoped
--    reset path). Revoke the default PUBLIC EXECUTE so a subject role
--    (app_user / tenant_admin) can never invoke cross-tenant seeding.
-- ═══════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION entity._apply_catalog_rows(UUID, TEXT, INT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION entity.seed_tenant_defaults(UUID)                     FROM PUBLIC;
REVOKE ALL ON FUNCTION entity.reset_tenant_catalog(UUID, TEXT, INT)          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entity._apply_catalog_rows(UUID, TEXT, INT, BOOLEAN) TO root_service;
GRANT EXECUTE ON FUNCTION entity.seed_tenant_defaults(UUID)                     TO root_service;
GRANT EXECUTE ON FUNCTION entity.reset_tenant_catalog(UUID, TEXT, INT)          TO root_service;


-- ═══════════════════════════════════════════════════════════════════
-- 9. Seed the version-1 default catalogs.
--    Values mirror the original global lookup seeds (14_init-tasks.sql,
--    10_init-hr-task-schemas.sql, 17_init-per-product-roles.sql) — the set
--    every tenant received via 22_tenant-scope-lookups.sql. Append-only:
--    to change a default for future tenants, INSERT version 2 rows and bump
--    current_version below; do NOT edit these rows.
-- ═══════════════════════════════════════════════════════════════════

-- task.task_statuses (module: tasks)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, is_terminal, sort_order) VALUES
  ('task.task_statuses', 'tasks', 1, 'todo',        'To Do',       FALSE, 1),
  ('task.task_statuses', 'tasks', 1, 'in_progress', 'In Progress', FALSE, 2),
  ('task.task_statuses', 'tasks', 1, 'blocked',     'Blocked',     FALSE, 3),
  ('task.task_statuses', 'tasks', 1, 'done',        'Done',        TRUE,  4),
  ('task.task_statuses', 'tasks', 1, 'cancelled',   'Cancelled',   TRUE,  5)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- task.task_priorities (module: tasks)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, sort_order) VALUES
  ('task.task_priorities', 'tasks', 1, 'low',    'Low',    1),
  ('task.task_priorities', 'tasks', 1, 'medium', 'Medium', 2),
  ('task.task_priorities', 'tasks', 1, 'high',   'High',   3),
  ('task.task_priorities', 'tasks', 1, 'urgent', 'Urgent', 4)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- hr.leave_types (module: leave)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, is_paid, sort_order) VALUES
  ('hr.leave_types', 'leave', 1, 'casual',      'Casual Leave',      TRUE,  1),
  ('hr.leave_types', 'leave', 1, 'sick',        'Sick Leave',        TRUE,  2),
  ('hr.leave_types', 'leave', 1, 'earned',      'Earned Leave',      TRUE,  3),
  ('hr.leave_types', 'leave', 1, 'maternity',   'Maternity Leave',   TRUE,  4),
  ('hr.leave_types', 'leave', 1, 'paternity',   'Paternity Leave',   TRUE,  5),
  ('hr.leave_types', 'leave', 1, 'bereavement', 'Bereavement Leave', TRUE,  6),
  ('hr.leave_types', 'leave', 1, 'comp_off',    'Compensatory Off',  TRUE,  7),
  ('hr.leave_types', 'leave', 1, 'loss_of_pay', 'Loss of Pay',       FALSE, 8)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- hr.employment_types (modules: leave OR attendance — HR-wide)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, sort_order) VALUES
  ('hr.employment_types', 'leave', 1, 'full_time', 'Full Time', 1),
  ('hr.employment_types', 'leave', 1, 'part_time', 'Part Time', 2),
  ('hr.employment_types', 'leave', 1, 'contract',  'Contract',  3),
  ('hr.employment_types', 'leave', 1, 'intern',    'Intern',    4)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- hr.attendance_statuses (module: attendance)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, sort_order) VALUES
  ('hr.attendance_statuses', 'attendance', 1, 'present',    'Present',         1),
  ('hr.attendance_statuses', 'attendance', 1, 'absent',     'Absent',          2),
  ('hr.attendance_statuses', 'attendance', 1, 'half_day',   'Half Day',        3),
  ('hr.attendance_statuses', 'attendance', 1, 'on_leave',   'On Leave',        4),
  ('hr.attendance_statuses', 'attendance', 1, 'holiday',    'Holiday',         5),
  ('hr.attendance_statuses', 'attendance', 1, 'weekly_off', 'Weekly Off',      6),
  ('hr.attendance_statuses', 'attendance', 1, 'wfh',        'Work From Home',  7)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- lms.roles (module: lms)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, description, rank, sort_order) VALUES
  ('lms.roles', 'lms', 1, 'read_only',              'Read Only',              'Read-only viewer — dashboards and reports only',                    0,  1),
  ('lms.roles', 'lms', 1, 'sales_representative',   'Sales Representative',   'Front-line sales — manages own assigned leads and follow-ups',     20, 2),
  ('lms.roles', 'lms', 1, 'senior_sales_executive', 'Senior Sales Executive', 'Manages a team of sales reps',                                     40, 3),
  ('lms.roles', 'lms', 1, 'org_manager',            'Manager',                'Manages a team of Senior Sales Executives and reps within an org', 60, 4),
  ('lms.roles', 'lms', 1, 'org_sr_manager',         'Senior Manager',         'Manages a team of managers and reps within an org',                70, 5),
  ('lms.roles', 'lms', 1, 'lms_admin',              'LMS Admin',              'Full control of the LMS product within an org',                    80, 6)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- hr.roles (modules: leave OR attendance — HR-wide)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, description, rank, sort_order) VALUES
  ('hr.roles', 'leave', 1, 'hr_viewer',  'HR Viewer',  'Read-only access to HR data',                                  0,  1),
  ('hr.roles', 'leave', 1, 'hr_staff',   'HR Staff',   'Day-to-day HR operations — leave/attendance entry',           40, 2),
  ('hr.roles', 'leave', 1, 'hr_manager', 'HR Manager', 'Approves leave, manages team attendance',                     70, 3),
  ('hr.roles', 'leave', 1, 'hr_admin',   'HR Admin',   'Full control of the HR product — profiles, policies, config', 80, 4)
ON CONFLICT (catalog_key, version, name) DO NOTHING;

-- task.roles (module: tasks)
INSERT INTO entity.catalog_defaults (catalog_key, product, version, name, label, description, rank, sort_order) VALUES
  ('task.roles', 'tasks', 1, 'task_member', 'Task Member', 'Creates and works own tasks',                     20, 1),
  ('task.roles', 'tasks', 1, 'task_lead',   'Task Lead',   'Manages a team''s tasks and lists',               40, 2),
  ('task.roles', 'tasks', 1, 'task_admin',  'Task Admin',  'Full control of the Tasks product within an org', 80, 3)
ON CONFLICT (catalog_key, version, name) DO NOTHING;


-- Register the current version + module gating per catalog.
INSERT INTO entity.catalog_versions (catalog_key, product, modules, current_version) VALUES
  ('task.task_statuses',     'tasks',      ARRAY['tasks'],               1),
  ('task.task_priorities',   'tasks',      ARRAY['tasks'],               1),
  ('task.roles',             'tasks',      ARRAY['tasks'],               1),
  ('hr.leave_types',         'leave',      ARRAY['leave'],               1),
  ('hr.attendance_statuses', 'attendance', ARRAY['attendance'],          1),
  ('hr.employment_types',    'leave',      ARRAY['leave','attendance'],  1),
  ('hr.roles',               'leave',      ARRAY['leave','attendance'],  1),
  ('lms.roles',              'lms',        ARRAY['lms'],                 1)
ON CONFLICT (catalog_key) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════
-- 10. Backfill entity.tenant_catalog_versions for EXISTING tenants.
--     Script 22 already gave every existing tenant a copy of all 8
--     catalogs. Record that provisioning fact (version 1) for each
--     (tenant, catalog) that actually has rows, so the reset path has a
--     baseline. Idempotent via ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'task.task_statuses', 1 FROM task.task_statuses t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'task.task_priorities', 1 FROM task.task_priorities t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'task.roles', 1 FROM task.roles t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'hr.leave_types', 1 FROM hr.leave_types t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'hr.employment_types', 1 FROM hr.employment_types t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'hr.attendance_statuses', 1 FROM hr.attendance_statuses t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'hr.roles', 1 FROM hr.roles t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;
INSERT INTO entity.tenant_catalog_versions (tenant_id, catalog_key, version)
SELECT DISTINCT t.tenant_id, 'lms.roles', 1 FROM lms.roles t
ON CONFLICT (tenant_id, catalog_key) DO NOTHING;


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.17.0', 'Tenant default seeding: entity.catalog_defaults/catalog_versions (versioned per-product default catalogs) + entity.tenant_catalog_versions (per-tenant provisioning record, RLS) + entity.seed_tenant_defaults()/reset_tenant_catalog() functions; seeds v1 defaults for the 8 tenant-scoped lookups and backfills existing tenants')
ON CONFLICT (version) DO NOTHING;

COMMIT;
