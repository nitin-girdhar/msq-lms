-- ===================================================================
-- 15_tenant-modules-lms-rename.sql
--
-- Phase 0 PR-C — entitlement-key rename crm -> lms + backfill + RLS confirm.
--
-- Renames the lead product's entitlement key in entity.tenant_modules from the
-- legacy 'crm' to 'lms' (the module CHECK constraint + existing rows), backfills
-- an active 'lms' row for every tenant so nothing 403s once the gateway/service
-- product gates go live, and re-asserts the tenant-isolation RLS as an audit
-- artifact. The *schema* rename (tenant_modules -> tenant_products, and the crm
-- schema itself) is deferred to Phase 1 — this is only the entitlement-key half.
--
-- Idempotent: safe to re-run. entity.tenant_modules was created in
-- 10_init-hr-task-schemas.sql (already applied) — that script is NOT edited.
-- ===================================================================

BEGIN;

-- 1. Drop the old inline CHECK from script 10. An inline single-column CHECK is
--    auto-named <table>_<column>_check by Postgres → tenant_modules_module_check.
ALTER TABLE entity.tenant_modules
  DROP CONSTRAINT IF EXISTS tenant_modules_module_check;

-- 2. Rename existing rows crm -> lms. Guarded by WHERE so a re-run is a no-op.
UPDATE entity.tenant_modules
  SET module = 'lms', updated_at = clock_timestamp()
  WHERE module = 'crm';

-- 3. Re-add the module CHECK under a stable, explicit name with the new key set.
ALTER TABLE entity.tenant_modules
  DROP CONSTRAINT IF EXISTS chk_tenant_modules_module;
ALTER TABLE entity.tenant_modules
  ADD CONSTRAINT chk_tenant_modules_module
  CHECK (module IN ('lms','leave','attendance','tasks'));

-- 4. Backfill: every existing tenant gets an active 'lms' entitlement so the
--    new gateway + leads-service product gates never 403 a current tenant.
--    Every tenant already had a 'crm' row (seeded in script 10, renamed above),
--    so ON CONFLICT DO NOTHING makes this effectively a safety net.
--    hr/task entitlements (leave/attendance/tasks) are intentionally left as-is
--    ("where used") — forcing them on would over-grant products no one licensed.
INSERT INTO entity.tenant_modules (tenant_id, module)
SELECT id, 'lms' FROM entity.tenants
ON CONFLICT (tenant_id, module) DO NOTHING;

-- 5. Confirm/re-assert tenant RLS (acceptance: a tenant sees only its own rows).
--    Unchanged from script 10 — restated here so this file documents the final
--    intended state. Reads are tenant/org-scoped; WRITES stay platform-only
--    (crm_service / super_admin service role). tenant_admin and app_user are
--    deliberately SELECT-only: entitlements are a billing lever, so a tenant must
--    never be able to self-grant a product by writing its own tenant_modules row.
ALTER TABLE entity.tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity.tenant_modules FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON entity.tenant_modules;
DROP POLICY IF EXISTS org_isolation_policy    ON entity.tenant_modules;

-- tenant_admin: SELECT own tenant's rows.
CREATE POLICY tenant_isolation_policy ON entity.tenant_modules
  AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- app_user: SELECT rows for the tenant owning their current org. app_user
-- sessions never set app.current_tenant_id (see withRoleTx), so tenant is
-- derived from the current org — same convention as iam.api_clients in 01.
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

-- 6. Version tracking (1.6.0–1.8.0 already consumed by scripts 11–14).
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.9.0', 'tenant_modules entitlement-key crm->lms rename (CHECK + rows), lms backfill for all tenants, RLS re-asserted; supports central gateway + leads-service product gating (Phase 0 PR-C)')
ON CONFLICT (version) DO NOTHING;

COMMIT;
