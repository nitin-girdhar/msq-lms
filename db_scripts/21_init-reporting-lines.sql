-- ===================================================================
-- 21_init-reporting-lines.sql
--
-- P2.2A — HR reporting hierarchy decoupling. Introduces effective-dated
-- `hr.reporting_lines` as the source of truth for the HR approval chain
-- (leave / attendance approvals), replacing the walk of the single global
-- `iam.users.manager_id` column.
--
-- Why a separate tree: each product owns its own hierarchy (Platform
-- Architecture Decisions §"hierarchy"). HR reporting can be re-orged on its
-- own cadence and must be effective-dated so history is auditable; the
-- LMS/sales assignment tree may legitimately differ and is decoupled in a
-- later phase. `iam.users.manager_id` degrades to an optional org default:
-- it still feeds the LMS/team `vw_user_team_members` tree and is used here
-- only to BACKFILL the initial reporting lines. It is no longer read on the
-- HR approval hot path (see services/hr-service/.../resolve-approvers.ts).
--
-- Prerequisite: 01_init-db.sql (iam.users, roles, entity.*), 10 (hr schema,
--               hr_svc), 11 (btree_gist extension for the exclusion
--               constraint; leave_policies RLS/grant recipe mirrored here).
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE
--             for triggers & policies; the backfill is guarded by NOT EXISTS.
-- Style, trigger recipe and RLS mirror hr.leave_policies in db_scripts/11.
-- ===================================================================

BEGIN;

-- ===================================================================
-- hr.reporting_lines — effective-dated managerial hierarchy (tenant/org scoped)
--   One row = "user_id reports to manager_id, in org_id, for [effective_from,
--   effective_to)". effective_to NULL = the currently-open line. A user has at
--   most one active line per org at any instant (exclusion constraint). A NULL
--   manager_id is not stored — absence of a line means "no reporting line", and
--   the approver resolver falls back to a deterministic org_admin/hr_admin.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.reporting_lines (
  id             UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id      UUID    NOT NULL REFERENCES entity.tenants(id)        ON DELETE CASCADE,
  org_id         UUID    NOT NULL REFERENCES entity.organizations(id)  ON DELETE CASCADE,
  user_id        UUID    NOT NULL REFERENCES iam.users(id)             ON DELETE CASCADE,
  manager_id     UUID    NOT NULL REFERENCES iam.users(id)             ON DELETE RESTRICT,
  effective_from DATE    NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at     TIMESTAMPTZ,
  deleted_by     UUID,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_reporting_lines_active_deleted CHECK (NOT (is_active AND is_deleted)),
  CONSTRAINT chk_reporting_lines_not_self       CHECK (user_id <> manager_id),
  CONSTRAINT chk_reporting_lines_range          CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- No two overlapping active lines for the same user in the same org. The
-- half-open daterange [from, to) lets a new line start on the exact day the
-- previous one ends without tripping the constraint. Soft-deleted rows are
-- excluded so a re-org can supersede history. (btree_gist enables mixing the
-- equality columns with the range overlap; extension is created in script 11.)
-- DROP+ADD (not IF NOT EXISTS, which ADD CONSTRAINT doesn't support) keeps the
-- script idempotent. Dropping the constraint also drops its backing gist index.
ALTER TABLE hr.reporting_lines DROP CONSTRAINT IF EXISTS excl_reporting_lines_overlap;
ALTER TABLE hr.reporting_lines ADD CONSTRAINT excl_reporting_lines_overlap
  EXCLUDE USING gist (
    org_id  WITH =,
    user_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (NOT is_deleted);

DROP TRIGGER IF EXISTS trg_reporting_lines_updated_at        ON hr.reporting_lines;
CREATE TRIGGER trg_reporting_lines_updated_at
  BEFORE UPDATE ON hr.reporting_lines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_reporting_lines_soft_delete       ON hr.reporting_lines;
CREATE TRIGGER trg_reporting_lines_soft_delete
  BEFORE DELETE ON hr.reporting_lines FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_reporting_lines_set_org_id     ON hr.reporting_lines;
CREATE TRIGGER trg_00_reporting_lines_set_org_id
  BEFORE INSERT ON hr.reporting_lines FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_reporting_lines_set_created_by ON hr.reporting_lines;
CREATE TRIGGER trg_01_reporting_lines_set_created_by
  BEFORE INSERT ON hr.reporting_lines FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_reporting_lines_audit             ON hr.reporting_lines;
CREATE TRIGGER trg_reporting_lines_audit
  AFTER UPDATE OR DELETE ON hr.reporting_lines FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_reporting_lines_org_user
  ON hr.reporting_lines (org_id, user_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_reporting_lines_org_manager
  ON hr.reporting_lines (org_id, manager_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_reporting_lines_tenant
  ON hr.reporting_lines (tenant_id) WHERE NOT is_deleted;

-- ── RLS (mirror hr.leave_policies) ─────────────────────────────────
-- app_user: SELECT-only, scoped to the caller's current org. Writes are
-- performed by the service (root_service / hr_svc) or a tenant_admin; app-layer
-- authorization gates who may edit a reporting line.
ALTER TABLE hr.reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.reporting_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.reporting_lines;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.reporting_lines;

CREATE POLICY org_isolation_policy ON hr.reporting_lines AS PERMISSIVE FOR SELECT TO app_user
  USING (
    NOT is_deleted
    AND org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_policy ON hr.reporting_lines AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid AND NOT is_deleted)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid AND NOT is_deleted);

GRANT SELECT                 ON hr.reporting_lines TO app_user;
REVOKE INSERT, UPDATE, DELETE ON hr.reporting_lines FROM app_user;
GRANT SELECT, INSERT, UPDATE ON hr.reporting_lines TO tenant_admin;
REVOKE DELETE                ON hr.reporting_lines FROM tenant_admin;
GRANT ALL PRIVILEGES         ON hr.reporting_lines TO root_service;
-- hr_svc (the HR product login) reads the tree to resolve approvers and writes
-- it when HR admins re-org. It connects under RLS, so isolation still holds.
GRANT SELECT, INSERT, UPDATE ON hr.reporting_lines TO hr_svc;

-- ===================================================================
-- Backfill: seed one open-ended reporting line per user from the current
-- iam.users.manager_id, scoped to the user's org. Idempotent — the NOT EXISTS
-- guard skips any user that already has an active (open) line, so re-running
-- the script (or running it after HR has started managing lines) is a no-op.
-- Only users with a non-null manager get a line; the rest resolve via the
-- approver resolver's org_admin/hr_admin fallback.
-- ===================================================================
INSERT INTO hr.reporting_lines (tenant_id, org_id, user_id, manager_id, effective_from, effective_to)
SELECT o.tenant_id, u.org_id, u.id, u.manager_id, CURRENT_DATE, NULL
FROM iam.users u
JOIN entity.organizations o ON o.id = u.org_id
WHERE u.manager_id IS NOT NULL
  AND NOT u.is_deleted
  AND NOT EXISTS (
    SELECT 1 FROM hr.reporting_lines rl
    WHERE rl.org_id = u.org_id AND rl.user_id = u.id
      AND rl.effective_to IS NULL AND NOT rl.is_deleted
  );

-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.15.0', 'P2.2A: effective-dated hr.reporting_lines (tenant/org scoped, RLS, no-overlap exclusion) as the HR approval-chain source of truth; backfilled from iam.users.manager_id, which degrades to an optional default')
ON CONFLICT (version) DO NOTHING;

COMMIT;
