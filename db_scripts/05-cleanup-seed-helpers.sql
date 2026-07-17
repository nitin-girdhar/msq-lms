-- ===================================================================
-- CRM Monorepo — Seed Helper Cleanup: STEP 5
--
-- Run AFTER all seed scripts (01 through 04) have been executed.
--
-- Drops helper functions that were created solely to support dummy-data
-- generation and have no runtime purpose:
--   _seed_uuid  — deterministic UUID builder used by scripts 02/03/04
--
-- Temp tables created during seeding (ON COMMIT DROP) are already gone.
-- ===================================================================

DROP FUNCTION IF EXISTS _seed_uuid(INT, INT);
