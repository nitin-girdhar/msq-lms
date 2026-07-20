-- ===================================================================
-- 20_member-role-resolver-fn.sql
--
-- P1.3 — per-product role RESOLVER. Each product service (leads/hr/tasks)
-- must resolve the acting user's PRODUCT role name + rank from its own
-- <product>.member_roles table instead of trusting a rank header from the
-- (now shrunk) JWT. fn_member_rank (script 17) returns only the rank; the
-- authz packages also need the role NAME (e.g. 'hr_admin'), so this adds a
-- sibling that returns both.
--
-- SECURITY DEFINER (like fn_member_rank / iam.fn_user_org_rank) so the
-- resolver bypasses member_roles RLS and can be called by app_user with no
-- session GUCs set. Returns (NULL, -1) when the user has no active grant in
-- that product+org — which the service treats as "not a member" (403).
--
-- Idempotent: CREATE OR REPLACE. Style mirrors iam.fn_user_org_rank in
-- db_scripts/01_init-db.sql and the fn_member_rank helpers in script 17.
-- ===================================================================

BEGIN;

CREATE OR REPLACE FUNCTION lms.fn_member_role(p_user_id UUID, p_org_id UUID)
RETURNS TABLE(role TEXT, rank INT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.name, r.rank
  FROM lms.member_roles mr
  JOIN lms.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  UNION ALL
  SELECT NULL::text, -1
  WHERE NOT EXISTS (
    SELECT 1 FROM lms.member_roles mr
    WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  )
$$;

CREATE OR REPLACE FUNCTION hr.fn_member_role(p_user_id UUID, p_org_id UUID)
RETURNS TABLE(role TEXT, rank INT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.name, r.rank
  FROM hr.member_roles mr
  JOIN hr.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  UNION ALL
  SELECT NULL::text, -1
  WHERE NOT EXISTS (
    SELECT 1 FROM hr.member_roles mr
    WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  )
$$;

CREATE OR REPLACE FUNCTION task.fn_member_role(p_user_id UUID, p_org_id UUID)
RETURNS TABLE(role TEXT, rank INT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT r.name, r.rank
  FROM task.member_roles mr
  JOIN task.roles r ON r.id = mr.role_id
  WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  UNION ALL
  SELECT NULL::text, -1
  WHERE NOT EXISTS (
    SELECT 1 FROM task.member_roles mr
    WHERE mr.user_id = p_user_id AND mr.org_id = p_org_id AND mr.is_active
  )
$$;

-- EXECUTE grants — the resolver runs on each caller's own login role (the *_svc
-- logins are NOINHERIT, so an app_user-only grant would NOT reach them via
-- membership without SET ROLE). Grant directly to every login that resolves that
-- product's rank, plus app_user/tenant_admin for SET ROLE paths. Mirrors the
-- explicit EXECUTE grants on iam.fn_user_org_rank (script 01).
--   lms.fn_member_role  → lms_svc (leads/meta), lead_svc (gateway + notifications)
--   hr.fn_member_role   → hr_svc
--   task.fn_member_role → task_svc
GRANT EXECUTE ON FUNCTION lms.fn_member_role(UUID, UUID)  TO app_user, tenant_admin, lms_svc, lead_svc;
GRANT EXECUTE ON FUNCTION hr.fn_member_role(UUID, UUID)   TO app_user, tenant_admin, hr_svc;
GRANT EXECUTE ON FUNCTION task.fn_member_role(UUID, UUID) TO app_user, tenant_admin, task_svc;

-- ===================================================================
-- SCHEMA VERSION TRACKING
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.14.0', 'P1.3: <product>.fn_member_role(user,org) -> (role,rank) resolver for per-service product-role resolution')
ON CONFLICT (version) DO NOTHING;

COMMIT;
