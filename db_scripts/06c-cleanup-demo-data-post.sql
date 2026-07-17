-- ===================================================================
-- CRM Monorepo — Demo/Seed Data Cleanup: STEP 6c (run as sa / table owner)
--
-- Re-enables the trigger disabled by 06a-cleanup-demo-data-pre.sql.
-- Run this after 06b has completed successfully.
--
-- Usage:
--   psql -U sa -d <db> -v ON_ERROR_STOP=1 -f 06c-cleanup-demo-data-post.sql
-- ===================================================================

ALTER TABLE crm.marketing_leads ENABLE TRIGGER trg_marketing_leads_audit;
