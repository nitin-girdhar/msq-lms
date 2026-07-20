-- ===================================================================
-- 25_lookup-admin-write-rls.sql
--
-- N-6 (Phase5_Extraction_Plan §5) — Half A. Lets the OWNING product
-- service (leads/hr/tasks) perform super_admin lookup/role management
-- writes into its OWN schema, tenant-scoped, WITHOUT root_service/BYPASSRLS.
--
-- Model: a super_admin managing a tenant's config first SELECTS a target
-- tenant; the product service then runs the write as its product-scoped
-- login (lms_svc/hr_svc/task_svc — each a MEMBER of app_user, script 19)
-- with app.current_tenant_id pinned to that tenant (see @crm/db
-- withTenantConfigTx). The permissive FOR ALL policy below keys on
-- app.current_tenant_id, so a write can only ever touch the selected
-- tenant's rows — cross-tenant contamination is physically impossible.
--
-- Why this is safe for normal runtime traffic: the product runtime
-- (app_user branch of withRoleTx) sets app.current_org_id, never
-- app.current_tenant_id, so this policy's predicate is NULL (no match) on
-- that path — it grants NOTHING extra at runtime. Only the explicit admin
-- tx sets current_tenant_id. Table-level INSERT/UPDATE is granted ONLY to
-- the specific product role (not app_user broadly), so other app_user
-- members (e.g. identity-service) still cannot write these tables even
-- though the policy is TO app_user.
--
-- These 8 tables are already tenant-scoped (tenant_id NOT NULL, script
-- 22/17). The 7 still-global LMS lookups (lead_stage etc.) are Half B.
--
-- Idempotent: DROP POLICY IF EXISTS + GRANT are safe to re-run.
-- ===================================================================

BEGIN;

-- Shared predicate: the row's tenant must equal the admin-selected tenant.
-- (Written inline per table below — Postgres has no policy macros.)

-- ── lms.roles  (lms_svc) ────────────────────────────────────────────
DROP POLICY IF EXISTS admin_tenant_config_policy ON lms.roles;
CREATE POLICY admin_tenant_config_policy ON lms.roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE lms.roles TO lms_svc;

-- ── hr.leave_types / employment_types / attendance_statuses / roles  (hr_svc) ──
DROP POLICY IF EXISTS admin_tenant_config_policy ON hr.leave_types;
CREATE POLICY admin_tenant_config_policy ON hr.leave_types
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE hr.leave_types TO hr_svc;

DROP POLICY IF EXISTS admin_tenant_config_policy ON hr.employment_types;
CREATE POLICY admin_tenant_config_policy ON hr.employment_types
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE hr.employment_types TO hr_svc;

DROP POLICY IF EXISTS admin_tenant_config_policy ON hr.attendance_statuses;
CREATE POLICY admin_tenant_config_policy ON hr.attendance_statuses
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE hr.attendance_statuses TO hr_svc;

DROP POLICY IF EXISTS admin_tenant_config_policy ON hr.roles;
CREATE POLICY admin_tenant_config_policy ON hr.roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE hr.roles TO hr_svc;

-- ── task.task_statuses / task_priorities / roles  (task_svc) ─────────
DROP POLICY IF EXISTS admin_tenant_config_policy ON task.task_statuses;
CREATE POLICY admin_tenant_config_policy ON task.task_statuses
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE task.task_statuses TO task_svc;

DROP POLICY IF EXISTS admin_tenant_config_policy ON task.task_priorities;
CREATE POLICY admin_tenant_config_policy ON task.task_priorities
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE task.task_priorities TO task_svc;

DROP POLICY IF EXISTS admin_tenant_config_policy ON task.roles;
CREATE POLICY admin_tenant_config_policy ON task.roles
  AS PERMISSIVE FOR ALL TO app_user
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT INSERT, UPDATE ON TABLE task.roles TO task_svc;

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.18.0', 'N-6 Half A: tenant-scoped admin write RLS + product-role write GRANTs on the 8 tenant-scoped lookup/role tables (lms.roles; hr.leave_types/employment_types/attendance_statuses/roles; task.task_statuses/task_priorities/roles) so product services own super_admin lookup writes without BYPASSRLS')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
