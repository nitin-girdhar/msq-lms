-- ===================================================================
-- 19_init-per-product-db-grants.sql
--
-- P1.2 / D8 — Per-product DB role GRANTs. Today every service (leads,
-- hr, tasks) connects with a login that is a member of the single shared
-- `app_user` role and runs `SET LOCAL ROLE app_user` (see @platform/db's
-- withRoleTx), which grants access to EVERY schema app_user can touch —
-- lms, hr and task alike. `hr_svc` could physically read `lms.*` today.
-- This script closes that gap by giving each product service its own
-- direct, schema-scoped grants and making the app-layer skip the
-- `SET ROLE app_user` step for these three logins (see
-- packages/db/src/transaction.ts DB_PRODUCT_SCOPED_LOGIN).
--
-- Design (why this is safe even though hr_svc/task_svc/lms_svc remain
-- members of app_user):
--   - Row-Level-Security "TO app_user" / "TO tenant_admin" policies match
--     on ROLE MEMBERSHIP alone (pg_has_role(..., 'MEMBER')), independent
--     of the INHERIT attribute. So lms_svc/hr_svc/task_svc still satisfy
--     every existing RLS policy without ever running `SET ROLE app_user`.
--   - Table-level privileges (SELECT/INSERT/UPDATE/DELETE) are NOT
--     automatically inherited through membership because these roles are
--     created NOINHERIT (same convention as lead_svc/hr_svc/task_svc
--     already use). They only have whatever is GRANTed to them directly
--     below — which is scoped to their own schema + a read-only slice of
--     the shared iam/entity/geo tables the product actually reads.
--   - Net effect: connect as hr_svc -> RLS still enforces tenant/org
--     isolation (via membership) AND hr_svc has zero privilege on
--     lms.*/task.* tables (never granted) -> product isolation is now
--     enforced at the GRANT level, not just by convention.
--
-- Scope: only the three product-operational logins (lms_svc / hr_svc /
-- task_svc — the "app_user pool" analogue). tenant_dash_svc (tenant_admin
-- pool) and root_service (BYPASSRLS) are unchanged — they are shared,
-- cross-product-by-design roles (tenant admin dashboards, internal
-- service jobs) and out of scope for this pass. identity-service /
-- notifications-service / admin-service / api-gateway keep using
-- lead_svc (unrestricted) for now — they are shared-repo/platform
-- services that legitimately manage iam/entity directly; re-plumbing
-- them is a separate, later concern.
--
-- Idempotent: CREATE ROLE guarded, GRANT/REVOKE are naturally idempotent.
-- Prerequisite: 01_init-db.sql, 10_init-hr-task-schemas.sql,
-- 11_init-leave-management.sql, 13_init-attendance.sql, 14_init-tasks.sql,
-- 17_init-per-product-roles.sql already applied.
-- ===================================================================

BEGIN;

-- ===================================================================
-- 1. lms_svc — new product login for the LMS product (leads-service,
-- meta-conversion-api). Mirrors the lead_svc/hr_svc/task_svc creation
-- pattern. lead_svc itself is left alone (still used, unrestricted, by
-- identity-service/notifications-service/admin-service/meta legacy path
-- until those are re-plumbed) — lms_svc is the new, scoped login that
-- leads-service and meta-conversion-api switch to.
-- ===================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_svc') THEN
    CREATE ROLE lms_svc WITH LOGIN PASSWORD 'LmsSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE lms_svc WITH LOGIN PASSWORD 'LmsSvc_Dev2025' NOINHERIT; END IF;
END; $$;
-- Membership only (NOINHERIT role => no privilege leak) — satisfies every
-- RLS policy scoped "TO app_user" without needing SET ROLE. Mirrors the
-- `GRANT app_user TO hr_svc/task_svc` pattern from 10_init-hr-task-schemas.sql.
-- lms_svc does not use the tenant_admin pool (no DATABASE_URL_TENANT for
-- leads-service/meta-conversion-api), so it is not made a member of
-- tenant_admin — least privilege, nothing to gain from that membership today.
GRANT app_user TO lms_svc;

DO $$
DECLARE v_db TEXT := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lms_svc', v_db);
END; $$;


-- ===================================================================
-- 2. Schema USAGE — narrow every product login down to its own schema(s)
-- + the shared schemas it actually reads. hr_svc/task_svc previously got
-- blanket USAGE on every schema (10_init-hr-task-schemas.sql, run when
-- app_user was the only isolation mechanism); revoke that down now.
-- ===================================================================
REVOKE USAGE ON SCHEMA lms, marketing, ext, audit FROM hr_svc, task_svc;
REVOKE USAGE ON SCHEMA hr, task               FROM lms_svc;

GRANT USAGE ON SCHEMA public, iam, entity, geo, lms, marketing, ext TO lms_svc;
GRANT USAGE ON SCHEMA public, iam, entity, geo, hr                  TO hr_svc;
GRANT USAGE ON SCHEMA public, iam, entity, geo, task                TO task_svc;


-- ===================================================================
-- 3. Defense-in-depth — explicit REVOKE of all privileges on the OTHER
-- products' schemas. No-op today (nothing was ever GRANTed directly to
-- these roles on the wrong schema — they only ever had access via
-- SET ROLE app_user, which the app layer no longer does for them), but
-- this makes the isolation boundary an explicit, auditable statement
-- rather than an absence.
-- ===================================================================
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA hr, task            FROM lms_svc;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hr, task            FROM lms_svc;
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA lms, marketing, ext FROM hr_svc, task_svc;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA lms, marketing, ext FROM hr_svc, task_svc;
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA hr                  FROM task_svc;
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA task                FROM hr_svc;


-- ===================================================================
-- 4. Shared schemas — READ-ONLY (D8: "read shared iam/entity/geo").
-- Two exceptions kept at SELECT+INSERT+UPDATE (iam.users,
-- iam.user_org_mapping) because product UIs today manage team-member
-- role assignment directly through these tables under app_user's
-- existing org_admin_manage_policy/org_admin_insert_policy/
-- org_admin_update_policy RLS policies (01_init-db.sql) — restricting
-- to read-only here would break existing "manage team" functionality in
-- every product. Revisit when P1.3 moves role assignment onto the
-- per-product member_roles tables (lms/hr/task.member_roles) exclusively.
-- ===================================================================
GRANT SELECT ON ALL TABLES IN SCHEMA geo, entity TO lms_svc, hr_svc, task_svc;
GRANT SELECT ON ALL TABLES IN SCHEMA iam         TO lms_svc, hr_svc, task_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE iam.users, iam.user_org_mapping
  TO lms_svc, hr_svc, task_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA geo    GRANT SELECT ON TABLES TO lms_svc, hr_svc, task_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA entity GRANT SELECT ON TABLES TO lms_svc, hr_svc, task_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA iam    GRANT SELECT ON TABLES TO lms_svc, hr_svc, task_svc;


-- ===================================================================
-- 5. Own-schema DML — mirror exactly what app_user already has on each
-- product's own tables (same tiers as 01_init-db.sql / 10/11/13/14/17),
-- granted directly so it does not depend on SET ROLE app_user.
-- ===================================================================

-- ── lms_svc: lms / marketing / ext ─────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE
  lms.marketing_leads, lms.lead_interactions, lms.lead_follow_ups, marketing.ad_campaigns
  TO lms_svc;

GRANT SELECT ON TABLE
  lms.lead_stage, lms.lead_stage_outcome, lms.interaction_types, lms.follow_up_statuses,
  lms.lead_sources, marketing.marketing_platforms, marketing.campaign_statuses,
  lms.lead_assignment_log, lms.lead_status_log, audit.marketing_leads_history, audit.audit_log,
  lms.vw_dashboard_leads, lms.vw_lead_followup_timeline, lms.vw_lead_assignment_timeline,
  lms.vw_sales_follow_up_pipeline, lms.vw_followup_pipeline_enriched, lms.vw_org_performance_snapshot,
  lms.vw_rep_performance, marketing.vw_campaign_lookup,
  iam.vw_user_org_chart, iam.vw_user_team_members, iam.vw_user_org_access
  TO lms_svc;

GRANT SELECT, INSERT, UPDATE ON TABLE lms.lead_links TO lms_svc;
-- iam.api_clients / iam.api_client_orgs (N-4, moved from ext) are managed
-- exclusively by identity-service; lms_svc's blanket `SELECT ON ALL TABLES IN
-- SCHEMA iam` above already covers any incidental read, no product-specific
-- write grant needed.
GRANT EXECUTE ON FUNCTION iam.can_assign_to(UUID,UUID,UUID) TO lms_svc;

-- lms per-product role model (P1.1)
GRANT SELECT                 ON TABLE lms.roles         TO lms_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE lms.member_roles  TO lms_svc;
GRANT SELECT                 ON TABLE lms.vw_member_roles TO lms_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA lms       GRANT SELECT, INSERT, UPDATE ON TABLES TO lms_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA marketing GRANT SELECT, INSERT, UPDATE ON TABLES TO lms_svc;
ALTER DEFAULT PRIVILEGES IN SCHEMA ext       GRANT SELECT, INSERT, UPDATE ON TABLES TO lms_svc;

-- ── hr_svc: hr ──────────────────────────────────────────────────────
GRANT SELECT         ON TABLE hr.employment_types, hr.leave_types, hr.leave_request_statuses, hr.attendance_statuses TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE hr.departments, hr.designations, hr.employee_profiles TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE hr.holiday_calendars, hr.holidays TO hr_svc;
GRANT SELECT                 ON TABLE hr.leave_policies, hr.hr_settings TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE hr.leave_requests, hr.leave_request_approvals TO hr_svc;
GRANT SELECT                 ON TABLE hr.leave_request_status_log, hr.leave_ledger TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE hr.attendance_rules, hr.shifts, hr.shift_assignments, hr.attendance_regularizations TO hr_svc;
GRANT SELECT, INSERT         ON TABLE hr.attendance_events TO hr_svc;
GRANT SELECT                 ON TABLE hr.attendance_days TO hr_svc;
GRANT SELECT ON TABLE
  hr.vw_leave_balances, hr.vw_leave_requests_enriched, hr.vw_team_leave_calendar,
  hr.vw_attendance_monthly_summary, hr.vw_org_attendance_today
  TO hr_svc;

-- hr per-product role model (P1.1)
GRANT SELECT                 ON TABLE hr.roles         TO hr_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE hr.member_roles  TO hr_svc;
GRANT SELECT                 ON TABLE hr.vw_member_roles TO hr_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA hr GRANT SELECT, INSERT, UPDATE ON TABLES TO hr_svc;

-- ── task_svc: task ──────────────────────────────────────────────────
GRANT SELECT                 ON TABLE task.task_statuses, task.task_priorities TO task_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE task.task_lists, task.tasks TO task_svc;
GRANT SELECT                 ON TABLE task.task_status_log TO task_svc;
GRANT SELECT, INSERT         ON TABLE task.task_comments TO task_svc;
GRANT SELECT                 ON TABLE task.vw_tasks_enriched TO task_svc;

-- task per-product role model (P1.1)
GRANT SELECT                 ON TABLE task.roles         TO task_svc;
GRANT SELECT, INSERT, UPDATE ON TABLE task.member_roles  TO task_svc;
GRANT SELECT                 ON TABLE task.vw_member_roles TO task_svc;

ALTER DEFAULT PRIVILEGES IN SCHEMA task GRANT SELECT, INSERT, UPDATE ON TABLES TO task_svc;


-- ===================================================================
-- 6. entity.tenant_modules — every product reads its own tenant's
-- entitlements (already SELECT-granted to app_user broadly above via
-- ALL TABLES IN SCHEMA entity; kept explicit here for clarity since it
-- is the one entity table every product genuinely depends on).
-- ===================================================================
-- (covered by step 4's `GRANT SELECT ON ALL TABLES IN SCHEMA entity`)


-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.13.0', 'P1.2/D8: per-product DB role GRANTs — new lms_svc login; hr_svc/task_svc narrowed from blanket schema USAGE to own-schema DML + read-only iam/entity/geo; cross-product access explicitly revoked')
ON CONFLICT (version) DO NOTHING;

COMMIT;
