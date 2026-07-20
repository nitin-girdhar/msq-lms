-- ===================================================================
-- 24_move-api-clients-to-iam.sql
--
-- P-1/N-4 — relocates the public/partner API-key tables `api_clients` /
-- `api_client_orgs` from `ext` to `iam`. They are a platform/gateway auth
-- primitive (per-tenant hashed API keys), owned end-to-end by
-- identity-service, and were only in `ext` for historical reasons. After the
-- per-product DB grants (script 19), `ext` is lms-repo territory — a shared
-- service can't be guaranteed access to it, whereas `iam` is read by every
-- product service. RLS policies, indexes, triggers, and grants all follow the
-- table by OID on `ALTER TABLE ... SET SCHEMA` — nothing needs re-issuing.
--
-- Guarded/idempotent:
--   - No-op against a DB freshly installed from the now-updated
--     01_init-db.sql (creates iam.api_clients/iam.api_client_orgs directly).
--   - Safe to re-run against an already-migrated DB.
-- ===================================================================

BEGIN;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ext' AND c.relname = 'api_clients'
  ) THEN
    ALTER TABLE ext.api_clients SET SCHEMA iam;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ext' AND c.relname = 'api_client_orgs'
  ) THEN
    ALTER TABLE ext.api_client_orgs SET SCHEMA iam;
  END IF;
END $$;

-- lms_svc no longer needs product-specific write access to these tables (they
-- moved out of its `ext` schema territory); its blanket
-- `GRANT SELECT ON ALL TABLES IN SCHEMA iam` (script 19) already covers reads.
REVOKE ALL PRIVILEGES ON TABLE iam.api_clients, iam.api_client_orgs FROM lms_svc;

COMMIT;
