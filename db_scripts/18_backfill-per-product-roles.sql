-- ===================================================================
-- 18_backfill-per-product-roles.sql
--
-- P1.1 — Phase B (BACKFILL). Populates iam.users.platform_role and the
-- per-product <product>.member_roles grants from the current authoritative
-- source (iam.user_org_mapping + iam.users), WITHOUT touching the old
-- ladder. Idempotent and re-runnable (ON CONFLICT DO UPDATE): running it
-- again reconciles new-model data to whatever the old model currently says.
--
-- Prerequisite: 17_init-per-product-roles.sql applied.
-- Runs online; the old authz path is unaffected. During the dual-write
-- window (Phase C) this can be re-run to close any drift before the flip.
--
-- Mapping rules (locked in P1.1 design):
--   platform_role  = super_admin | tenant_admin | org_admin from the matching
--                    old role, else 'member' (hr_admin + sales ladder + read_only).
--   lms.member_roles   from old sales-ladder / read_only / org_admin grants.
--   hr.member_roles    from old hr_admin grants; admins get hr_admin in every
--                      HR-licensed org.
--   task.member_roles  every active member of a tasks-licensed org seeds as
--                      task_member; admins get task_admin.
--   Admins (org_admin/tenant_admin/super_admin) get top rank in every product
--   their org is LICENSED for (entity.tenant_modules).
-- ===================================================================

BEGIN;

-- ===================================================================
-- 1. iam.users.platform_role — from the user's DEFAULT (home) role.
-- ===================================================================
UPDATE iam.users u
SET platform_role = CASE ur.name
  WHEN 'super_admin'  THEN 'super_admin'
  WHEN 'tenant_admin' THEN 'tenant_admin'
  WHEN 'org_admin'    THEN 'org_admin'
  ELSE 'member'
END
FROM iam.user_roles ur
WHERE ur.id = u.role_id
  AND u.platform_role IS DISTINCT FROM CASE ur.name
        WHEN 'super_admin'  THEN 'super_admin'
        WHEN 'tenant_admin' THEN 'tenant_admin'
        WHEN 'org_admin'    THEN 'org_admin'
        ELSE 'member'
      END;


-- ===================================================================
-- 2. lms.member_roles — from active user_org_mapping grants whose old
-- role maps to an LMS ladder role. tenant_id is set by the table trigger.
-- ===================================================================
INSERT INTO lms.member_roles (user_id, org_id, tenant_id, role_id, granted_by, granted_at)
SELECT
  uom.user_id,
  uom.org_id,
  o.tenant_id,
  lr.id,
  uom.granted_by,
  uom.granted_at
FROM iam.user_org_mapping uom
JOIN entity.organizations o  ON o.id  = uom.org_id
JOIN iam.user_roles       ur ON ur.id = uom.role_id
JOIN lms.roles            lr ON lr.name = CASE ur.name
       WHEN 'read_only'              THEN 'read_only'
       WHEN 'sales_representative'   THEN 'sales_representative'
       WHEN 'senior_sales_executive' THEN 'senior_sales_executive'
       WHEN 'org_manager'           THEN 'org_manager'
       WHEN 'org_sr_manager'        THEN 'org_sr_manager'
       -- admins get full LMS control; hr_admin has NO CRM access -> no row.
       WHEN 'org_admin'             THEN 'lms_admin'
       WHEN 'tenant_admin'          THEN 'lms_admin'
       WHEN 'super_admin'           THEN 'lms_admin'
       ELSE NULL
     END
     -- Tenant-safe whether lms.roles is still the pre-22 global catalog (no
     -- tenant_id column -> jsonb key lookup is NULL -> predicate always true)
     -- or the post-22 tenant-scoped catalog (matches the org's own tenant,
     -- avoiding an ON CONFLICT DO UPDATE double-hit when 18 is re-run after 22).
     AND (to_jsonb(lr) ->> 'tenant_id' IS NULL OR to_jsonb(lr) ->> 'tenant_id' = o.tenant_id::text)
WHERE uom.is_active
  -- only for orgs whose tenant is licensed for LMS
  AND EXISTS (SELECT 1 FROM entity.tenant_modules tm
              WHERE tm.tenant_id = o.tenant_id AND tm.module = 'lms' AND tm.is_active)
ON CONFLICT (user_id, org_id) DO UPDATE SET
  role_id = EXCLUDED.role_id, is_active = TRUE, updated_at = CLOCK_TIMESTAMP();


-- ===================================================================
-- 3. hr.member_roles — old hr_admin grants + admins get hr_admin in every
-- HR-licensed org. (HR is licensed when 'leave' or 'attendance' is active.)
-- ===================================================================
INSERT INTO hr.member_roles (user_id, org_id, tenant_id, role_id, granted_by, granted_at)
SELECT
  uom.user_id,
  uom.org_id,
  o.tenant_id,
  hrole.id,
  uom.granted_by,
  uom.granted_at
FROM iam.user_org_mapping uom
JOIN entity.organizations o  ON o.id  = uom.org_id
JOIN iam.user_roles       ur ON ur.id = uom.role_id
JOIN hr.roles          hrole ON hrole.name = 'hr_admin'
     -- tenant-safe pre/post script-22 (see the lms.member_roles block above)
     AND (to_jsonb(hrole) ->> 'tenant_id' IS NULL OR to_jsonb(hrole) ->> 'tenant_id' = o.tenant_id::text)
WHERE uom.is_active
  AND ur.name IN ('hr_admin','org_admin','tenant_admin','super_admin')
  AND EXISTS (SELECT 1 FROM entity.tenant_modules tm
              WHERE tm.tenant_id = o.tenant_id
                AND tm.module IN ('leave','attendance') AND tm.is_active)
ON CONFLICT (user_id, org_id) DO UPDATE SET
  role_id = EXCLUDED.role_id, is_active = TRUE, updated_at = CLOCK_TIMESTAMP();


-- ===================================================================
-- 4. task.member_roles — every active member of a tasks-licensed org seeds
-- as task_member; admins get task_admin.
-- ===================================================================
INSERT INTO task.member_roles (user_id, org_id, tenant_id, role_id, granted_by, granted_at)
SELECT
  uom.user_id,
  uom.org_id,
  o.tenant_id,
  trole.id,
  uom.granted_by,
  uom.granted_at
FROM iam.user_org_mapping uom
JOIN entity.organizations o  ON o.id  = uom.org_id
JOIN iam.user_roles       ur ON ur.id = uom.role_id
JOIN task.roles        trole ON trole.name = CASE
       WHEN ur.name IN ('org_admin','tenant_admin','super_admin') THEN 'task_admin'
       ELSE 'task_member'
     END
     -- tenant-safe pre/post script-22 (see the lms.member_roles block above)
     AND (to_jsonb(trole) ->> 'tenant_id' IS NULL OR to_jsonb(trole) ->> 'tenant_id' = o.tenant_id::text)
WHERE uom.is_active
  AND EXISTS (SELECT 1 FROM entity.tenant_modules tm
              WHERE tm.tenant_id = o.tenant_id AND tm.module = 'tasks' AND tm.is_active)
ON CONFLICT (user_id, org_id) DO UPDATE SET
  role_id = EXCLUDED.role_id, is_active = TRUE, updated_at = CLOCK_TIMESTAMP();


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.12.0', 'P1.1 Phase B (backfill): iam.users.platform_role + lms/hr/task.member_roles populated from iam.user_org_mapping ladder; idempotent, old ladder untouched')
ON CONFLICT (version) DO NOTHING;

COMMIT;
