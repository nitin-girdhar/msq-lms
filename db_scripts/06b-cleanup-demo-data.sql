-- ===================================================================
-- CRM Monorepo — Demo/Seed Data Cleanup: STEP 6b
--
-- Deletes ALL data created by 02-seed-tenants-orgs-users.sql,
-- 03-seed-leads-bulk.sql, and 04-seed-interactions-followups.sql
-- (the FitClass + ITC Hotels demo tenants), plus any real app-generated
-- rows layered on top of them (Meta CAPI logs, audit history, sessions,
-- activity log, etc).
--
-- Run BEFORE this: 06a-cleanup-demo-data-pre.sql (as sa).
-- Run AFTER this:  06c-cleanup-demo-data-post.sql (as sa).
--
-- entity.tenants / entity.organizations / iam.users / marketing.ad_campaigns /
-- crm.marketing_leads / crm.lead_interactions / crm.lead_follow_ups all carry
-- a BEFORE DELETE trigger (public.soft_delete_row()) that normally converts
-- DELETE into an UPDATE is_deleted=TRUE. It only performs a real hard delete
-- when current_user = 'crm_service' — so this script sets that role itself
-- right after BEGIN, regardless of which login (postgres/sa/crm_service) ran
-- it. Don't skip or remove that SET ROLE line.
--
-- Run this as ONE transaction via psql (not a GUI tool that may execute
-- statements non-atomically) so a failure midway rolls back cleanly:
--   psql -U postgres -d crm -v ON_ERROR_STOP=1 -f 06b-cleanup-demo-data.sql
--
-- Safe to re-run: every DELETE is scoped by a WHERE IN (...) subquery,
-- so a second run simply finds nothing left to delete.
--
-- To scope this to fewer tenants, edit _target_tenants below.
-- ===================================================================

BEGIN;

-- Superusers (postgres/sa) can assume any role without its password; if
-- connected directly as crm_service this is a harmless no-op.
SET ROLE crm_service;

-- ============================================================
-- Target scope: the two demo tenants seeded by script 02.
-- ============================================================
CREATE TEMP TABLE _target_tenants (id UUID) ON COMMIT DROP;
INSERT INTO _target_tenants (id) VALUES
  ('a1000000-0000-0000-0000-000000000001'), -- FitClass
  ('a3000000-0000-0000-0000-000000000001'); -- ITC Hotels

CREATE TEMP TABLE _target_orgs (id UUID) ON COMMIT DROP;
INSERT INTO _target_orgs (id)
  SELECT id FROM entity.organizations WHERE tenant_id IN (SELECT id FROM _target_tenants);

CREATE TEMP TABLE _target_users (id UUID) ON COMMIT DROP;
INSERT INTO _target_users (id)
  SELECT id FROM iam.users WHERE org_id IN (SELECT id FROM _target_orgs);

CREATE TEMP TABLE _target_leads (id UUID) ON COMMIT DROP;
INSERT INTO _target_leads (id)
  SELECT id FROM crm.marketing_leads WHERE org_id IN (SELECT id FROM _target_orgs);

CREATE TEMP TABLE _target_meta_leads (id UUID) ON COMMIT DROP;
INSERT INTO _target_meta_leads (id)
  SELECT id FROM ext.meta_leads WHERE org_id IN (SELECT id FROM _target_orgs);

-- ============================================================
-- 1. Meta CAPI / Meta Lead Ads data (references orgs + leads).
--    Children of ext.meta_leads (addresses/professional/demographics/
--    custom_fields) cascade automatically on the meta_leads delete.
-- ============================================================
DELETE FROM ext.meta_capi_outbound_logs WHERE org_id IN (SELECT id FROM _target_orgs);
DELETE FROM ext.meta_leads              WHERE id     IN (SELECT id FROM _target_meta_leads);
DELETE FROM ext.meta_org_config         WHERE org_id IN (SELECT id FROM _target_orgs);

-- ============================================================
-- 2. Audit trails that RESTRICT/NO ACTION delete of leads/orgs/users.
--    audit_log.actor_id / audit.activities.performed_by have no ON DELETE
--    action (defaults to RESTRICT) and are keyed by WHO acted, not which
--    org/lead the action touched — a target user can have rows attached
--    to a non-target org's records, so these are scoped by user, not org.
-- ============================================================
DELETE FROM audit.marketing_leads_history WHERE lead_id IN (SELECT id FROM _target_leads);
DELETE FROM audit.activities
  WHERE org_id IN (SELECT id FROM _target_orgs)
     OR performed_by IN (SELECT id FROM _target_users);
-- NOTE: audit.audit_log has no FK on changed_by/org_id in this environment's
-- deployed schema (no RESTRICT risk), but we still purge the demo rows so
-- they don't linger. changed_by has no FK constraint here, so this is a
-- courtesy cleanup, not a dependency requirement.
DELETE FROM audit.audit_log
  WHERE org_id IN (SELECT id FROM _target_orgs)
     OR changed_by IN (SELECT id FROM _target_users);

-- ============================================================
-- 3. Rows keyed by a target USER (not by lead/org) that carry a RESTRICT
--    FK to iam.users — must go before any lead/user delete regardless of
--    which org the referenced lead belongs to. A target-org user may have
--    logged an interaction or been assigned a follow-up on a lead outside
--    the two demo orgs, and the leads.org_id-scoped deletes below wouldn't
--    catch that.
-- ============================================================
DELETE FROM crm.lead_interactions WHERE user_id          IN (SELECT id FROM _target_users);
DELETE FROM crm.lead_follow_ups   WHERE assigned_user_id IN (SELECT id FROM _target_users);

-- ============================================================
-- 4. Leads and everything that cascades from them:
--    crm.lead_interactions, crm.lead_follow_ups, crm.lead_assignment_log,
--    crm.lead_status_log (all ON DELETE CASCADE via lead_id).
-- ============================================================
DELETE FROM crm.lead_links WHERE source_org_id IN (SELECT id FROM _target_orgs)
                               OR dest_org_id   IN (SELECT id FROM _target_orgs);
DELETE FROM crm.marketing_leads WHERE id IN (SELECT id FROM _target_leads);

-- ============================================================
-- 5. Org-scoped data with no lead dependency.
-- ============================================================
DELETE FROM marketing.ad_campaigns WHERE org_id IN (SELECT id FROM _target_orgs);
DELETE FROM ext.api_client_orgs    WHERE org_id IN (SELECT id FROM _target_orgs);

-- ============================================================
-- 6. Users (cascades iam.user_org_mapping, iam.token_blocklist via
--    user_id ON DELETE CASCADE).
-- ============================================================
DELETE FROM iam.users WHERE id IN (SELECT id FROM _target_users);

-- ============================================================
-- 7. Orgs, then tenants.
-- ============================================================
DELETE FROM entity.organizations WHERE id IN (SELECT id FROM _target_orgs);
DELETE FROM entity.tenants       WHERE id IN (SELECT id FROM _target_tenants);

RESET ROLE;

COMMIT;

-- ============================================================
-- Sanity check (run manually after this script if you want to verify)
-- ============================================================
-- SELECT count(*) FROM entity.tenants      WHERE id IN ('a1000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001');
-- SELECT count(*) FROM entity.organizations WHERE tenant_id IN ('a1000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001');
-- SELECT count(*) FROM crm.marketing_leads; -- should be 0 if this was the only demo data
