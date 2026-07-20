-- ===================================================================
-- CRM Monorepo — Demo/Seed Data Cleanup: STEP 6a (run as sa / table owner)
--
-- lms.marketing_leads has an AFTER DELETE trigger (trg_marketing_leads_audit)
-- that snapshots the deleted row into audit.marketing_leads_history *after*
-- it's gone — but that table's lead_id FK is RESTRICT (not deferrable), so
-- the trigger's own insert fails against the row it just deleted. Disable it
-- before running 06b, then re-enable with 06c once the purge is done.
--
-- Disabling/enabling a trigger requires table ownership — root_service does
-- not own lms.marketing_leads, so this cannot run in the same session as
-- 06b. Run this once as sa, then reconnect as root_service for 06b.
--
-- Usage:
--   psql -U sa -d <db> -v ON_ERROR_STOP=1 -f 06a-cleanup-demo-data-pre.sql
-- ===================================================================

ALTER TABLE lms.marketing_leads DISABLE TRIGGER trg_marketing_leads_audit;
