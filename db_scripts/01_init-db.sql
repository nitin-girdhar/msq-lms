--rollback
--drop database crm (force)
--create database crm_v2
-- ===================================================================
-- CRM Monorepo — Merged Production Schema
-- Combines: monorepo UUID-based design + EXISTING_WORKING_CODE features
-- UUID PKs for all operational/lookup tables
-- SMALLINT/INTEGER PKs for geographic tables (geo.countries/states/cities)
-- Idempotent: safe to re-run (IF NOT EXISTS, ON CONFLICT DO NOTHING)
-- ===================================================================


-- ── Schema version tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.schema_versions (
  version     TEXT        PRIMARY KEY,
  description TEXT,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- ── Extensions ─────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes() used by public.gen_uuidv7()
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS "vector"';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pgvector not available (%). AI embedding features disabled.', SQLERRM;
END;
$$;

-- ── Schemas ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS geo;
CREATE SCHEMA IF NOT EXISTS entity;
CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS lms;
CREATE SCHEMA IF NOT EXISTS marketing;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS ext;

-- ── UUIDv7 generator (RFC 9562 §5.7) ──────────────────────────────
-- Time-ordered UUIDs: 48-bit ms timestamp prefix eliminates the
-- random-insert B-tree fragmentation caused by public.gen_uuidv7() (v4).
-- Works on PostgreSQL 14+ with no extensions required.
CREATE OR REPLACE FUNCTION public.gen_uuidv7() RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_millis BIGINT;
  v_bytes  BYTEA;
  v_hex    TEXT;
BEGIN
  v_millis := (EXTRACT(EPOCH FROM CLOCK_TIMESTAMP()) * 1000)::BIGINT;
  v_bytes  := gen_random_bytes(10);
  v_hex :=
    -- 48-bit unix_ts_ms: high 32 bits (8 hex) + low 16 bits (4 hex)
    lpad(to_hex(v_millis >> 16), 8, '0') ||
    lpad(to_hex(v_millis & 65535), 4, '0') ||
    -- version nibble (7) + 12-bit rand_a
    '7' ||
    lpad(to_hex(((get_byte(v_bytes, 0) & 15) << 8) | get_byte(v_bytes, 1)), 3, '0') ||
    -- variant bits (10xxxxxx) + rand_b
    lpad(to_hex((get_byte(v_bytes, 2) & 63) | 128), 2, '0') ||
    lpad(to_hex(get_byte(v_bytes, 3)), 2, '0') ||
    encode(substring(v_bytes from 5 for 6), 'hex');
  RETURN (
    substring(v_hex, 1, 8)  || '-' ||
    substring(v_hex, 9, 4)  || '-' ||
    substring(v_hex, 13, 4) || '-' ||
    substring(v_hex, 17, 4) || '-' ||
    substring(v_hex, 21, 12)
  )::UUID;
END; $$;

-- ── Roles (idempotent) ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOINHERIT;
  ELSE
    ALTER ROLE app_user NOLOGIN NOINHERIT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_admin') THEN
    CREATE ROLE tenant_admin NOLOGIN NOINHERIT;
  ELSE
    ALTER ROLE tenant_admin NOLOGIN NOINHERIT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'root_service') THEN
    CREATE ROLE root_service WITH LOGIN PASSWORD 'CrmSvc_Dev2025' BYPASSRLS;
  ELSE
    ALTER ROLE root_service WITH LOGIN PASSWORD 'CrmSvc_Dev2025' BYPASSRLS;
  END IF;
END $$;

-- ===================================================================
-- GEOGRAPHIC LOOKUP TABLES
-- SMALLINT/INTEGER PKs (GENERATED ALWAYS AS IDENTITY) — high-cardinality
-- safe with SMALLINT for geo.countries/states; INTEGER for geo.cities.
-- ===================================================================

CREATE TABLE IF NOT EXISTS geo.countries (
  id       SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name     TEXT     NOT NULL UNIQUE,
  iso_code CHAR(2)  NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS geo.states (
  id         SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  country_id SMALLINT NOT NULL REFERENCES geo.countries(id) ON DELETE RESTRICT,
  name       TEXT     NOT NULL,
  code       TEXT,
  description TEXT,
  CONSTRAINT uq_states_country_name UNIQUE (country_id, name)
);

CREATE TABLE IF NOT EXISTS geo.cities (
  id          INTEGER  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  state_id    SMALLINT NOT NULL REFERENCES geo.states(id) ON DELETE RESTRICT,
  name        TEXT     NOT NULL,
  description TEXT,
  CONSTRAINT uq_cities_state_name UNIQUE (state_id, name)
);


-- ===================================================================
-- OPERATIONAL LOOKUP TABLES  (UUID PKs)
-- ===================================================================

CREATE TABLE IF NOT EXISTS iam.user_roles (
  id          UUID     PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT     NOT NULL UNIQUE,
  label       TEXT     NOT NULL,
  description TEXT,
  rank        INT      NOT NULL DEFAULT 0
                       CONSTRAINT chk_user_roles_rank CHECK (rank >= 0 AND rank <= 100),
  is_active   BOOLEAN  NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS lms.lead_stage (
  id                UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name              TEXT    NOT NULL UNIQUE,
  label             TEXT    NOT NULL,
  description       TEXT,
  sort_order        INT     NOT NULL DEFAULT 0,
  followup_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_rejected       BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminated     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS lms.lead_stage_outcome (
  id               UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  stage_id         UUID    NOT NULL REFERENCES lms.lead_stage(id) ON DELETE RESTRICT,
  name             TEXT    NOT NULL,
  label            TEXT    NOT NULL,
  description      TEXT,
  requires_comment BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INT     NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_lead_stage_outcome_stage_name UNIQUE (stage_id, name)
);


CREATE TABLE IF NOT EXISTS lms.interaction_types (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS lms.follow_up_statuses (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS marketing.marketing_platforms (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS marketing.campaign_statuses (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS entity.org_types (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS entity.tenant_domains (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS entity.tenant_plan_types (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- Monorepo addition: source channel for organic / non-campaign leads
CREATE TABLE IF NOT EXISTS lms.lead_sources (
  id        UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name      TEXT    NOT NULL UNIQUE,
  label     TEXT    NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- ===================================================================
-- CORE TABLES
-- ===================================================================

-- ── Utility functions (needed before table triggers) ──────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := CLOCK_TIMESTAMP(); RETURN NEW; END; $$;

-- Converts a physical DELETE into a soft delete (UPDATE is_deleted=TRUE).
-- root_service bypasses this and performs a real delete (GDPR/purge).
-- Also clears is_active (where the table has that column) so tables with a
-- chk_*_active_deleted CHECK (NOT (is_active AND is_deleted)) constraint
-- (entity.tenants, entity.organizations, iam.users) don't fail the soft
-- delete on a row that was still active.
CREATE OR REPLACE FUNCTION public.soft_delete_row()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_user_id UUID;
  v_has_is_active BOOLEAN;
BEGIN
  IF current_user = 'root_service' THEN RETURN OLD; END IF;
  BEGIN
    v_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_user_id := NULL; END;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = TG_TABLE_SCHEMA
      AND table_name   = TG_TABLE_NAME
      AND column_name  = 'is_active'
  ) INTO v_has_is_active;

  IF v_has_is_active THEN
    EXECUTE format(
      'UPDATE %I.%I SET is_active = FALSE, is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = $1 WHERE id = $2',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING v_user_id, OLD.id;
  ELSE
    EXECUTE format(
      'UPDATE %I.%I SET is_deleted = TRUE, deleted_at = CLOCK_TIMESTAMP(), deleted_by = $1 WHERE id = $2',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    ) USING v_user_id, OLD.id;
  END IF;
  RETURN NULL;
END; $$;

-- Auto-populates created_by from app.current_user_id on INSERT.
CREATE OR REPLACE FUNCTION public.set_created_by()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_user_id UUID;
BEGIN
  IF NEW.created_by IS NULL THEN
    BEGIN
      v_user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN v_user_id := NULL; END;
    NEW.created_by := v_user_id;
  END IF;
  RETURN NEW;
END; $$;

-- Auto-populate org_id from session GUC when not provided explicitly.
CREATE OR REPLACE FUNCTION public.set_org_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_org TEXT;
BEGIN
  IF NEW.org_id IS NULL THEN
    v_org := current_setting('app.current_org_id', true);
    IF v_org IS NULL OR v_org = '' THEN
      RAISE EXCEPTION 'org_id is NULL and app.current_org_id GUC is not set';
    END IF;
    NEW.org_id := v_org::uuid;
  END IF;
  RETURN NEW;
END; $$;

-- ── TENANTS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity.tenants (
  id           UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name         TEXT    NOT NULL UNIQUE,
  domain_id    UUID    REFERENCES entity.tenant_domains(id),
  plan_type_id UUID    REFERENCES entity.tenant_plan_types(id),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at   TIMESTAMPTZ,
  deleted_by   UUID,
  metadata     JSONB   NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_tenants_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_tenants_updated_at   ON entity.tenants;
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON entity.tenants FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_tenants_soft_delete  ON entity.tenants;
CREATE TRIGGER trg_tenants_soft_delete
  BEFORE DELETE ON entity.tenants FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

ALTER TABLE entity.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity.tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self_policy ON entity.tenants;
CREATE POLICY tenant_self_policy ON entity.tenants
  AS PERMISSIVE FOR SELECT TO app_user
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_admin_self_policy ON entity.tenants;
CREATE POLICY tenant_admin_self_policy ON entity.tenants
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── ORGANIZATIONS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity.organizations (
  id            UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id     UUID    NOT NULL REFERENCES entity.tenants(id) ON DELETE RESTRICT,
  name               TEXT    NOT NULL,
  legal_entity_name  TEXT,
  brand_name         TEXT,
  org_type_id        UUID    REFERENCES entity.org_types(id),
  address_line1 TEXT,
  address_line2 TEXT,
  landmark      TEXT,
  pincode       TEXT,
  -- free-text city (monorepo); structured FK city below for enriched queries
  city          TEXT,
  city_id       INTEGER  REFERENCES geo.cities(id)    ON DELETE RESTRICT,
  state_id      SMALLINT REFERENCES geo.states(id)    ON DELETE RESTRICT,
  country_id    SMALLINT REFERENCES geo.countries(id) ON DELETE RESTRICT,
  timezone      TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID,
  metadata      JSONB   NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_organizations_tenant_name  UNIQUE (tenant_id, name),
  CONSTRAINT chk_organizations_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_organizations_updated_at  ON entity.organizations;
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON entity.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_organizations_soft_delete ON entity.organizations;
CREATE TRIGGER trg_organizations_soft_delete
  BEFORE DELETE ON entity.organizations FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

-- ── USERS ─────────────────────────────────────────────────────────
-- full_name is GENERATED ALWAYS AS STORED — never insert it directly.
CREATE TABLE IF NOT EXISTS iam.users (
  id                    UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id                UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  first_name            TEXT    NOT NULL,
  middle_name           TEXT,
  last_name             TEXT    NOT NULL DEFAULT '',
  full_name             TEXT    GENERATED ALWAYS AS (
                          TRIM(first_name
                            || COALESCE(' ' || NULLIF(middle_name, ''), '')
                            || COALESCE(' ' || NULLIF(last_name,   ''), ''))
                        ) STORED,
  email                 TEXT    NOT NULL UNIQUE,
  mobile                TEXT,
  password_hash         TEXT    NOT NULL,
  role_id               UUID    NOT NULL REFERENCES iam.user_roles(id) ON DELETE RESTRICT,
  -- self-referential adjacency list; NULL = top of hierarchy
  manager_id            UUID    REFERENCES iam.users(id) ON DELETE SET NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at            TIMESTAMPTZ,
  deleted_by            UUID,
  created_by            UUID,
  force_password_change BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_user_not_own_manager    CHECK (id <> manager_id),
  CONSTRAINT chk_users_active_deleted    CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_users_updated_at       ON iam.users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON iam.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_users_soft_delete      ON iam.users;
CREATE TRIGGER trg_users_soft_delete
  BEFORE DELETE ON iam.users FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_users_set_org_id    ON iam.users;
CREATE TRIGGER trg_00_users_set_org_id
  BEFORE INSERT ON iam.users FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_users_set_created_by ON iam.users;
CREATE TRIGGER trg_01_users_set_created_by
  BEFORE INSERT ON iam.users FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ── iam.user_org_mapping ─────────────────────────────────────────
-- Source of truth for which orgs a user can access and at what role.
-- Replaces the single org_id + role_id on iam.users for access control.
--
-- iam.users.org_id  remains as the user's PRIMARY / home org (FK integrity
--               and fallback when no org is selected).
-- iam.users.role_id remains as the user's DEFAULT role (mirrors the home
--               org row here; kept for backward-compat during transition).
CREATE TABLE IF NOT EXISTS iam.user_org_mapping (
  user_id    UUID        NOT NULL REFERENCES iam.users(id)         ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES entity.organizations(id)  ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES iam.user_roles(id)     ON DELETE RESTRICT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  -- % share of new leads this user should auto-receive within this org.
  -- Sums to 100 (or all-zero = auto-assignment disabled) across an org's
  -- mapped rows; enforced at the application layer, not by a DB constraint.
  lead_assignment_weight SMALLINT NOT NULL DEFAULT 0 CHECK (lead_assignment_weight BETWEEN 0 AND 100),
  granted_by UUID        REFERENCES iam.users(id)                   ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (user_id, org_id)
);

DROP TRIGGER IF EXISTS trg_user_org_mapping_updated_at ON iam.user_org_mapping;
CREATE TRIGGER trg_user_org_mapping_updated_at
  BEFORE UPDATE ON iam.user_org_mapping
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_user_org_mapping_user_active
  ON iam.user_org_mapping (user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_user_org_mapping_org_active
  ON iam.user_org_mapping (org_id)  WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_user_org_mapping_role
  ON iam.user_org_mapping (role_id);

-- ── RLS HELPER FUNCTIONS (SECURITY DEFINER) ───────────────────────
-- These bypass RLS on iam.user_org_mapping so they can be used safely
-- inside RLS policies on OTHER tables without recursive infinite loops.

DROP FUNCTION IF EXISTS iam.fn_user_active_orgs(UUID) CASCADE;
CREATE FUNCTION iam.fn_user_active_orgs(p_user_id UUID)
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT ARRAY(SELECT org_id FROM iam.user_org_mapping WHERE user_id = p_user_id AND is_active)
$$;

DROP FUNCTION IF EXISTS iam.fn_org_active_users(UUID) CASCADE;
CREATE FUNCTION iam.fn_org_active_users(p_org_id UUID)
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT ARRAY(SELECT user_id FROM iam.user_org_mapping WHERE org_id = p_org_id AND is_active)
$$;

CREATE OR REPLACE FUNCTION iam.fn_user_org_rank(p_user_id UUID, p_org_id UUID)
RETURNS INT LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE v_rank INT;
BEGIN
  SELECT ur.rank INTO v_rank
  FROM iam.user_org_mapping uom
  JOIN iam.user_roles ur ON ur.id = uom.role_id
  WHERE uom.user_id = p_user_id AND uom.org_id = p_org_id AND uom.is_active;
  RETURN COALESCE(v_rank, -1);
END; $$;

-- ── AD_CAMPAIGNS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing.ad_campaigns (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  platform_id UUID    NOT NULL REFERENCES marketing.marketing_platforms(id) ON DELETE RESTRICT,
  status_id   UUID    NOT NULL REFERENCES marketing.campaign_statuses(id)   ON DELETE RESTRICT,
  budget      NUMERIC(12,2),
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  -- Links a Meta lead's campaign_id (bigint, raw on ext.meta_leads) to a real
  -- lms.marketing_leads.campaign_id FK, so the "Campaign" field on the lead
  -- edit screen (sourced from marketing_leads_vw -> marketing.ad_campaigns)
  -- is populated for Meta-sourced leads instead of always showing "-".
  meta_campaign_id BIGINT,
  CONSTRAINT chk_campaign_dates
    CHECK (ended_at IS NULL OR started_at IS NULL OR started_at < ended_at)
);

DROP TRIGGER IF EXISTS trg_ad_campaigns_updated_at    ON marketing.ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_updated_at
  BEFORE UPDATE ON marketing.ad_campaigns FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_ad_campaigns_soft_delete   ON marketing.ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_soft_delete
  BEFORE DELETE ON marketing.ad_campaigns FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_ad_campaigns_set_org_id ON marketing.ad_campaigns;
CREATE TRIGGER trg_00_ad_campaigns_set_org_id
  BEFORE INSERT ON marketing.ad_campaigns FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_ad_campaigns_set_created_by ON marketing.ad_campaigns;
CREATE TRIGGER trg_01_ad_campaigns_set_created_by
  BEFORE INSERT ON marketing.ad_campaigns FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ── MARKETING_LEADS ───────────────────────────────────────────────
-- full_name is GENERATED ALWAYS AS STORED.
-- city TEXT = free-text (monorepo); city_id/state_id/country_id = structured FK (EXISTING).
-- is_active: false when the record has been superseded or transferred out.
-- superseded_by: old row → newer active row (same-org re-submission or walk-in dedup).
--   All cross-org transfers and merge audit trail live in lms.lead_links.
-- embedding column stub: uncomment after pgvector confirmed.
CREATE TABLE IF NOT EXISTS lms.marketing_leads (
  id               UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id           UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  first_name       TEXT    NOT NULL,
  middle_name      TEXT,
  last_name        TEXT    NOT NULL DEFAULT '',
  full_name        TEXT    GENERATED ALWAYS AS (
                     TRIM(first_name
                       || COALESCE(' ' || NULLIF(middle_name, ''), '')
                       || COALESCE(' ' || NULLIF(last_name,   ''), ''))
                   ) STORED,
  phone            TEXT,
  email            TEXT,
  -- address fields
  address_line1    TEXT,
  address_line2    TEXT,
  landmark         TEXT,
  pincode          TEXT,
  -- free-text city (backwards-compatible); structured FKs below
  city             TEXT,
  city_id          INTEGER  REFERENCES geo.cities(id)    ON DELETE RESTRICT,
  state_id         SMALLINT REFERENCES geo.states(id)    ON DELETE RESTRICT,
  country_id       SMALLINT REFERENCES geo.countries(id) ON DELETE RESTRICT,
  -- CRM state
  stage_id         UUID    REFERENCES lms.lead_stage(id)         ON DELETE RESTRICT,
  outcome_id       UUID    REFERENCES lms.lead_stage_outcome(id)  ON DELETE RESTRICT,
  outcome_comment  TEXT,
  -- current/next follow-up due time; source of truth for "is this lead overdue".
  -- Kept in sync by the app on every follow-up create/reschedule/complete; NULL = no open follow-up.
  scheduled_at     TIMESTAMPTZ,
  -- source tracking
  campaign_id      UUID    REFERENCES marketing.ad_campaigns(id) ON DELETE SET NULL,
  source_id        UUID    REFERENCES lms.lead_sources(id),
  -- assignment
  assigned_user_id UUID    REFERENCES iam.users(id) ON DELETE SET NULL,
  -- lead linking: dedup chain + transfer supersession
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by    UUID    REFERENCES lms.marketing_leads(id) ON DELETE SET NULL,
  -- raw/enrichment data
  raw_webhook_data JSONB   NOT NULL DEFAULT '{}',
  metadata         JSONB   NOT NULL DEFAULT '{}',
  tags             TEXT[]  NOT NULL DEFAULT '{}',
  -- embedding vector(1536), -- uncomment after pgvector confirmed
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

COMMENT ON COLUMN lms.marketing_leads.is_active IS
  'FALSE when this record has been superseded by a newer submission or transferred out. Filter WHERE is_active = TRUE for the live lead pipeline.';
COMMENT ON COLUMN lms.marketing_leads.superseded_by IS
  'Points forward to the newer active lead that replaced this one (same org). Set on both re-submission duplicates and walk-in dedup. Cross-org transfers are tracked in lms.lead_links.';

DROP TRIGGER IF EXISTS trg_marketing_leads_updated_at     ON lms.marketing_leads;
CREATE TRIGGER trg_marketing_leads_updated_at
  BEFORE UPDATE ON lms.marketing_leads FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_marketing_leads_soft_delete    ON lms.marketing_leads;
CREATE TRIGGER trg_marketing_leads_soft_delete
  BEFORE DELETE ON lms.marketing_leads FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_marketing_leads_set_org_id  ON lms.marketing_leads;
CREATE TRIGGER trg_00_marketing_leads_set_org_id
  BEFORE INSERT ON lms.marketing_leads FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_marketing_leads_set_created_by ON lms.marketing_leads;
CREATE TRIGGER trg_01_marketing_leads_set_created_by
  BEFORE INSERT ON lms.marketing_leads FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- migration: replace duplicate_lead_id with is_active + superseded_by
ALTER TABLE lms.marketing_leads DROP COLUMN IF EXISTS duplicate_lead_id;
ALTER TABLE lms.marketing_leads ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE lms.marketing_leads ADD COLUMN IF NOT EXISTS superseded_by UUID    REFERENCES lms.marketing_leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_leads_is_active    ON lms.marketing_leads (org_id, is_active) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_superseded_by ON lms.marketing_leads (superseded_by)    WHERE superseded_by IS NOT NULL;

-- ── LEAD_LINKS ────────────────────────────────────────────────────
-- Audit trail for all lead-to-lead relationships:
--   link_type = 'merge'    → same-org dedup (re-submission or walk-in), source_org_id = dest_org_id
--   link_type = 'transfer' → executive cross-org transfer,             source_org_id ≠ dest_org_id
-- dest_lead_id is nullable: set after the destination lead row is created.
CREATE TABLE IF NOT EXISTS lms.lead_links (
  id              UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  -- source (the record being retired / transferred out)
  source_lead_id  UUID        NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE RESTRICT,
  source_org_id   UUID        NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  -- destination (the active record going forward)
  dest_lead_id    UUID        REFERENCES lms.marketing_leads(id) ON DELETE SET NULL,
  dest_org_id     UUID        NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  -- discriminator
  link_type       TEXT        NOT NULL CHECK (link_type IN ('merge', 'transfer')),
  -- who & why
  created_by      UUID        REFERENCES iam.users(id) ON DELETE SET NULL,
  reason          TEXT,
  notes           TEXT,
  -- lifecycle of the link action itself
  status          TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_lead_links_updated_at ON lms.lead_links;
CREATE TRIGGER trg_lead_links_updated_at
  BEFORE UPDATE ON lms.lead_links FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_lead_links_source_lead  ON lms.lead_links (source_lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_links_dest_lead    ON lms.lead_links (dest_lead_id) WHERE dest_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_links_source_org   ON lms.lead_links (source_org_id);
CREATE INDEX IF NOT EXISTS idx_lead_links_dest_org     ON lms.lead_links (dest_org_id);

-- RLS
ALTER TABLE lms.lead_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON lms.lead_links;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.lead_links;

-- both orgs involved in a link can see/write the record
CREATE POLICY org_isolation_policy ON lms.lead_links
  AS PERMISSIVE FOR ALL TO app_user
  USING (
    source_org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid
    OR dest_org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid
  );

CREATE POLICY tenant_isolation_policy ON lms.lead_links
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (
    source_org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid
        AND NOT is_deleted
    )
    OR dest_org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid
        AND NOT is_deleted
    )
  );

GRANT SELECT, INSERT, UPDATE ON lms.lead_links TO app_user;
GRANT SELECT, INSERT, UPDATE ON lms.lead_links TO tenant_admin;
GRANT ALL PRIVILEGES          ON lms.lead_links TO root_service;

-- ── ORG_API_KEYS (removed) ─────────────────────────────────────────
-- Legacy per-org API key table for the website lead-intake form. Confirmed no
-- external traffic; superseded by iam.api_clients / POST /public/v1/leads.
-- Dropped outright — no consumers to preserve compatibility for.
DROP TABLE IF EXISTS lms.org_api_keys CASCADE;

-- ── IAM.API_CLIENTS ────────────────────────────────────────────────
-- Scoped credentials for the public/partner API (/public/v1/*). Each key is
-- tenant-bound and optionally bound to one or more branches (see
-- iam.api_client_orgs below); carries explicit scopes. Only the HMAC hash of
-- the raw key is stored — never the plaintext. Lives in iam (not ext) because
-- it's a platform/gateway auth primitive, not LMS/Meta-integration data (N-4) —
-- identity-service owns its CRUD and, post-D8 grants, only iam is guaranteed
-- reachable from a shared service.
CREATE TABLE IF NOT EXISTS iam.api_clients (
  id                 UUID         NOT NULL DEFAULT gen_uuidv7() PRIMARY KEY,
  tenant_id          UUID         NOT NULL REFERENCES entity.tenants(id) ON DELETE CASCADE,
  name               VARCHAR(120) NOT NULL,
  key_prefix         TEXT         NOT NULL,          -- display-only, e.g. "crmk_live_Ab12Cd"
  key_hash           TEXT         NOT NULL UNIQUE,   -- HMAC-SHA256(pepper, raw key); never plaintext
  scopes             TEXT[]       NOT NULL DEFAULT '{}',
  rate_limit_per_min INTEGER      NOT NULL DEFAULT 60,
  scope_all_orgs     BOOLEAN      NOT NULL DEFAULT FALSE, -- TRUE = tenant-wide (all branches, incl. future ones)
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  expires_at         TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_by         UUID         REFERENCES iam.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_api_clients_updated_at ON iam.api_clients;
CREATE TRIGGER trg_api_clients_updated_at
  BEFORE UPDATE ON iam.api_clients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_api_clients_tenant   ON iam.api_clients (tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_clients_key_hash ON iam.api_clients (key_hash) WHERE is_active;

-- ── IAM.API_CLIENT_ORGS ────────────────────────────────────────────
-- Junction table: which branches an iam.api_clients row is scoped to. Zero
-- rows for a client means tenant-wide (only valid when scope_all_orgs = TRUE).
-- Created here (ahead of iam.api_clients' own RLS policies below) because
-- the org_isolation_policy on iam.api_clients references this table.
CREATE TABLE IF NOT EXISTS iam.api_client_orgs (
  api_client_id UUID NOT NULL REFERENCES iam.api_clients(id)      ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES entity.organizations(id) ON DELETE CASCADE,
  CONSTRAINT pk_api_client_orgs PRIMARY KEY (api_client_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_api_client_orgs_org ON iam.api_client_orgs (org_id);

ALTER TABLE iam.api_clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON iam.api_clients;
DROP POLICY IF EXISTS org_isolation_policy    ON iam.api_clients;

-- tenant_admin (and super_admin via root_service) manage every API client in
-- their tenant, regardless of branch binding.
CREATE POLICY tenant_isolation_policy ON iam.api_clients AS PERMISSIVE FOR ALL TO tenant_admin
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- org_admin (app_user) may only see/manage clients explicitly bound to their
-- own branch via iam.api_client_orgs — never a tenant-wide (scope_all_orgs)
-- client, and never another branch's. app.current_tenant_id is never set for
-- the app_user transaction path (see withRoleTx), so tenant is derived from
-- the org itself rather than that GUC — matches the org_isolation_policy
-- convention used for every other app_user-scoped table in this file.
CREATE POLICY org_isolation_policy ON iam.api_clients AS PERMISSIVE FOR ALL TO app_user
  USING (
    EXISTS (
      SELECT 1 FROM iam.api_client_orgs o
      WHERE o.api_client_id = iam.api_clients.id
      AND o.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  )
  WITH CHECK (
    scope_all_orgs = FALSE
    AND tenant_id = (
      SELECT tenant_id FROM entity.organizations
      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE ON iam.api_clients TO tenant_admin;
GRANT SELECT, INSERT, UPDATE ON iam.api_clients TO app_user;
GRANT ALL PRIVILEGES          ON iam.api_clients TO root_service;

-- ── IAM.API_CLIENT_ORGS RLS ────────────────────────────────────────
-- Table itself is created earlier, alongside iam.api_clients (see above).
ALTER TABLE iam.api_client_orgs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON iam.api_client_orgs;
DROP POLICY IF EXISTS org_isolation_policy    ON iam.api_client_orgs;

CREATE POLICY tenant_isolation_policy ON iam.api_client_orgs AS PERMISSIVE FOR ALL TO tenant_admin
  USING (
    api_client_id IN (
      SELECT id FROM iam.api_clients
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid AND NOT is_deleted
    )
  );

CREATE POLICY org_isolation_policy ON iam.api_client_orgs AS PERMISSIVE FOR ALL TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON iam.api_client_orgs TO tenant_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.api_client_orgs TO app_user;
GRANT ALL PRIVILEGES                 ON iam.api_client_orgs TO root_service;

-- ── LEAD_INTERACTIONS ─────────────────────────────────────────────
-- Append-only log — no updated_at, no update trigger.
CREATE TABLE IF NOT EXISTS lms.lead_interactions (
  id                  UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id              UUID    NOT NULL REFERENCES entity.organizations(id)   ON DELETE RESTRICT,
  lead_id             UUID    NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE CASCADE,
  user_id             UUID    NOT NULL REFERENCES iam.users(id)           ON DELETE RESTRICT,
  interaction_type_id UUID    REFERENCES lms.interaction_types(id)        ON DELETE RESTRICT,
  notes               TEXT,
  duration_seconds    INT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ,
  deleted_by          UUID,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_lead_interactions_soft_delete        ON lms.lead_interactions;
CREATE TRIGGER trg_lead_interactions_soft_delete
  BEFORE DELETE ON lms.lead_interactions FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_lead_interactions_set_org_id      ON lms.lead_interactions;
CREATE TRIGGER trg_00_lead_interactions_set_org_id
  BEFORE INSERT ON lms.lead_interactions FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_lead_interactions_set_created_by  ON lms.lead_interactions;
CREATE TRIGGER trg_01_lead_interactions_set_created_by
  BEFORE INSERT ON lms.lead_interactions FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ── LEAD_FOLLOW_UPS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lms.lead_follow_ups (
  id               UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id           UUID    NOT NULL REFERENCES entity.organizations(id)   ON DELETE RESTRICT,
  lead_id          UUID    NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE CASCADE,
  assigned_user_id UUID    NOT NULL REFERENCES iam.users(id)           ON DELETE RESTRICT,
  status_id        UUID    NOT NULL REFERENCES lms.follow_up_statuses(id) ON DELETE RESTRICT,
  -- Snapshot of the lead's stage/outcome at the moment this entry was appended (history context).
  stage_id         UUID    REFERENCES lms.lead_stage(id)         ON DELETE RESTRICT,
  outcome_id       UUID    REFERENCES lms.lead_stage_outcome(id) ON DELETE RESTRICT,
  scheduled_at     TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  notes            TEXT,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_lead_follow_ups_updated_at        ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_updated_at
  BEFORE UPDATE ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_lead_follow_ups_soft_delete       ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_soft_delete
  BEFORE DELETE ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_lead_follow_ups_set_org_id     ON lms.lead_follow_ups;
CREATE TRIGGER trg_00_lead_follow_ups_set_org_id
  BEFORE INSERT ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_lead_follow_ups_set_created_by ON lms.lead_follow_ups;
CREATE TRIGGER trg_01_lead_follow_ups_set_created_by
  BEFORE INSERT ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

-- ── LEAD_ASSIGNMENT_LOG ───────────────────────────────────────────
-- Populated automatically by trigger on lms.marketing_leads.
CREATE TABLE IF NOT EXISTS lms.lead_assignment_log (
  id                   UUID PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id               UUID NOT NULL REFERENCES entity.organizations(id)   ON DELETE RESTRICT,
  lead_id              UUID NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE CASCADE,
  assigned_by_id       UUID REFERENCES iam.users(id) ON DELETE SET NULL,
  assigned_to_id       UUID REFERENCES iam.users(id) ON DELETE SET NULL,
  previous_assignee_id UUID REFERENCES iam.users(id) ON DELETE SET NULL,
  action               TEXT NOT NULL DEFAULT 'reassigned'
                       CONSTRAINT chk_assignment_action CHECK (
                         action IN ('initial','reassigned','unassigned','self_assigned','bulk_assigned')
                       ),
  note                 TEXT,
  assigned_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- ── ACTIVITIES ────────────────────────────────────────────────────
-- Fire-and-forget log written by audit.activities-service.
CREATE TABLE IF NOT EXISTS audit.activities (
  id           UUID PRIMARY KEY DEFAULT public.gen_uuidv7(),
  action_type  TEXT NOT NULL,
  performed_by UUID REFERENCES iam.users(id),
  target_id    UUID,
  target_type  TEXT,
  org_id       UUID REFERENCES entity.organizations(id),
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- ── LEAD_STATUS_LOG ───────────────────────────────────────────────
-- Immutable stage-transition log. Written by trigger only.
CREATE TABLE IF NOT EXISTS lms.lead_status_log (
  id               UUID PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id           UUID NOT NULL REFERENCES entity.organizations(id)   ON DELETE RESTRICT,
  lead_id          UUID NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE CASCADE,
  changed_by_id    UUID REFERENCES iam.users(id)            ON DELETE SET NULL,
  old_stage_id     UUID REFERENCES lms.lead_stage(id)       ON DELETE RESTRICT,
  new_stage_id     UUID NOT NULL REFERENCES lms.lead_stage(id) ON DELETE RESTRICT,
  old_outcome_id   UUID REFERENCES lms.lead_stage_outcome(id) ON DELETE RESTRICT,
  new_outcome_id   UUID REFERENCES lms.lead_stage_outcome(id) ON DELETE RESTRICT,
  assigned_user_id UUID REFERENCES iam.users(id)            ON DELETE SET NULL,
  transition_note  TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_lead_status_log_lead_changed
  ON lms.lead_status_log (org_id, lead_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_status_log_org_changed
  ON lms.lead_status_log (org_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_status_log_changed_by
  ON lms.lead_status_log (org_id, changed_by_id, changed_at DESC);

-- ── MARKETING_LEADS_HISTORY ───────────────────────────────────────
-- Dedicated audit table for lms.marketing_leads field changes.
-- UPDATE: diff-style {"field": {"old": v, "new": v}}
-- DELETE: full to_jsonb(OLD) snapshot
CREATE TABLE IF NOT EXISTS audit.marketing_leads_history (
  id                 UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  lead_id            UUID    NOT NULL REFERENCES lms.marketing_leads(id) ON DELETE RESTRICT,
  changed_by_user_id UUID    REFERENCES iam.users(id) ON DELETE SET NULL,
  operation          CHAR(1) NOT NULL CHECK (operation IN ('I','U','D')),
  changed_fields     JSONB,
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_marketing_leads_history_lead_changed
  ON audit.marketing_leads_history (lead_id, changed_at DESC);

-- ── AUDIT_LOG ─────────────────────────────────────────────────────
-- Generic audit for all operational tables except lms.marketing_leads
-- (which has its own history table above).
-- Columns cover both the monorepo convention and EXISTING_WORKING_CODE convention.
CREATE TABLE IF NOT EXISTS audit.audit_log (
  id             UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  table_name     TEXT        NOT NULL,
  operation      CHAR(1)     NOT NULL CHECK (operation IN ('U', 'D')),
  -- EXISTING_WORKING_CODE naming
  record_id      UUID,
  changed_by     UUID,
  changed_fields JSONB,
  -- monorepo naming (aliases of above; populated together for compatibility)
  row_id         UUID,
  actor_id       UUID        REFERENCES iam.users(id),
  old_data       JSONB,
  new_data       JSONB,
  -- common
  org_id         UUID,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_record
  ON audit.audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_table
  ON audit.audit_log (org_id, table_name, changed_at DESC)
  WHERE org_id IS NOT NULL;

-- ===================================================================
-- BUSINESS RULE TRIGGER FUNCTIONS
-- ===================================================================

-- Enforces outcome_id ↔ stage_id consistency on lms.marketing_leads.
-- On stage change: auto-nulls outcome when new stage has no outcomes or
--   supplied outcome doesn't match the new stage.
-- Validates requires_comment when outcome.requires_comment = TRUE.
CREATE OR REPLACE FUNCTION lms.check_lead_stage_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_outcome_stage_id  UUID;
  v_outcome_count     INT;
  v_requires_comment  BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    SELECT COUNT(*) INTO v_outcome_count
    FROM lms.lead_stage_outcome WHERE stage_id = NEW.stage_id;

    IF v_outcome_count = 0 THEN
      NEW.outcome_id      := NULL;
      NEW.outcome_comment := NULL;
    ELSIF NEW.outcome_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM lms.lead_stage_outcome
        WHERE id = NEW.outcome_id AND stage_id = NEW.stage_id
      ) THEN
        NEW.outcome_id      := NULL;
        NEW.outcome_comment := NULL;
      END IF;
    END IF;
  ELSIF NEW.outcome_id IS NOT NULL THEN
    SELECT stage_id INTO v_outcome_stage_id
    FROM lms.lead_stage_outcome WHERE id = NEW.outcome_id;

    IF v_outcome_stage_id IS DISTINCT FROM NEW.stage_id THEN
      RAISE EXCEPTION
        'outcome_id % does not belong to stage_id %. Cross-stage outcome selection is not allowed.',
        NEW.outcome_id, NEW.stage_id;
    END IF;
  END IF;

  IF NEW.outcome_id IS NOT NULL THEN
    SELECT requires_comment INTO v_requires_comment
    FROM lms.lead_stage_outcome WHERE id = NEW.outcome_id;

    IF v_requires_comment AND (NEW.outcome_comment IS NULL OR NEW.outcome_comment = '') THEN
      RAISE EXCEPTION
        'outcome_comment is required for this outcome (requires_comment = TRUE). Please provide a comment describing the reason.';
    END IF;
  ELSE
    NEW.outcome_comment := NULL;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_stage_outcome_check ON lms.marketing_leads;
CREATE TRIGGER trg_lead_stage_outcome_check
  BEFORE INSERT OR UPDATE OF stage_id, outcome_id, outcome_comment ON lms.marketing_leads
  FOR EACH ROW EXECUTE FUNCTION lms.check_lead_stage_outcome();

-- Enforces completed_at ↔ status='completed' invariant on follow-ups.
CREATE OR REPLACE FUNCTION lms.check_follow_up_completion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT name INTO v_status FROM lms.follow_up_statuses WHERE id = NEW.status_id;
  IF v_status = 'completed' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'completed_at must be set when follow_up status is ''completed''.';
  END IF;
  IF v_status <> 'completed' AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed_at must be NULL when follow_up status is ''%'' (not ''completed'').', v_status;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_follow_up_completion_check ON lms.lead_follow_ups;
CREATE TRIGGER trg_follow_up_completion_check
  BEFORE INSERT OR UPDATE OF status_id, completed_at ON lms.lead_follow_ups
  FOR EACH ROW EXECUTE FUNCTION lms.check_follow_up_completion();

-- Validates campaign_id and assigned_user_id belong to the same org as the lead.
CREATE OR REPLACE FUNCTION lms.check_lead_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    PERFORM 1 FROM marketing.ad_campaigns
    WHERE id = NEW.campaign_id AND org_id = NEW.org_id AND NOT is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_id % does not belong to org % or has been deleted.', NEW.campaign_id, NEW.org_id;
    END IF;
  END IF;
  IF NEW.assigned_user_id IS NOT NULL THEN
    PERFORM 1 FROM iam.users
    WHERE id = NEW.assigned_user_id AND org_id = NEW.org_id AND NOT is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assigned_user_id % does not belong to org % or has been deleted.', NEW.assigned_user_id, NEW.org_id;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_marketing_leads_fk_scope ON lms.marketing_leads;
CREATE TRIGGER trg_marketing_leads_fk_scope
  BEFORE INSERT OR UPDATE OF org_id, campaign_id, assigned_user_id ON lms.marketing_leads
  FOR EACH ROW EXECUTE FUNCTION lms.check_lead_fk_org_scope();

-- Validates lead and user in an interaction share the same org.
CREATE OR REPLACE FUNCTION lms.check_interaction_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.', NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1 FROM iam.users
  WHERE id = NEW.user_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_id % does not belong to org % or has been deleted.', NEW.user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_interactions_fk_scope ON lms.lead_interactions;
CREATE TRIGGER trg_lead_interactions_fk_scope
  BEFORE INSERT OR UPDATE OF org_id, lead_id, user_id ON lms.lead_interactions
  FOR EACH ROW EXECUTE FUNCTION lms.check_interaction_fk_org_scope();

-- Validates lead and assigned user in a follow-up share the same org.
CREATE OR REPLACE FUNCTION lms.check_follow_up_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.', NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1 FROM iam.users
  WHERE id = NEW.assigned_user_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assigned_user_id % does not belong to org % or has been deleted.', NEW.assigned_user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_follow_ups_fk_scope ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_fk_scope
  BEFORE INSERT OR UPDATE OF org_id, lead_id, assigned_user_id ON lms.lead_follow_ups
  FOR EACH ROW EXECUTE FUNCTION lms.check_follow_up_fk_org_scope();

-- Set lms.lead_follow_ups.status_id to 'pending' on INSERT when not supplied.
CREATE OR REPLACE FUNCTION lms.set_default_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status_id IS NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'pending' LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_follow_ups_default_status ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_default_status
  BEFORE INSERT ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION lms.set_default_follow_up_status();

-- Auto-transition status when completed_at is set or cleared.
CREATE OR REPLACE FUNCTION lms.sync_follow_up_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'completed' LIMIT 1;
  ELSIF NEW.completed_at IS NULL AND OLD.completed_at IS NOT NULL THEN
    SELECT id INTO NEW.status_id FROM lms.follow_up_statuses WHERE name = 'pending' LIMIT 1;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_follow_ups_sync_status ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_sync_status
  BEFORE UPDATE OF completed_at ON lms.lead_follow_ups
  FOR EACH ROW EXECUTE FUNCTION lms.sync_follow_up_status();

-- ===================================================================
-- USER HIERARCHY FUNCTIONS & TRIGGERS
-- ===================================================================

-- Prevents circular manager_id chains (cycle detection).
CREATE OR REPLACE FUNCTION iam.check_user_hierarchy_no_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_cursor  UUID;
  v_visited UUID[] := ARRAY[NEW.id];
BEGIN
  IF NEW.manager_id IS NULL THEN RETURN NEW; END IF;
  v_cursor := NEW.manager_id;
  LOOP
    IF v_cursor = ANY(v_visited) THEN
      RAISE EXCEPTION
        'Circular reporting chain detected: setting manager_id = % on user % would create a cycle. Chain visited: %',
        NEW.manager_id, NEW.id, v_visited;
    END IF;
    v_visited := v_visited || v_cursor;
    SELECT manager_id INTO v_cursor FROM iam.users WHERE id = v_cursor;
    EXIT WHEN v_cursor IS NULL;
  END LOOP;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_user_hierarchy_no_cycle ON iam.users;
CREATE TRIGGER trg_user_hierarchy_no_cycle
  BEFORE INSERT OR UPDATE OF manager_id ON iam.users
  FOR EACH ROW EXECUTE FUNCTION iam.check_user_hierarchy_no_cycle();

-- Write to lms.lead_assignment_log whenever assigned_user_id changes.
-- SECURITY DEFINER: app_user has only SELECT on lms.lead_assignment_log.
CREATE OR REPLACE FUNCTION lms.log_lead_assignment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor  UUID;
  v_action TEXT;
BEGIN
  IF NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id THEN RETURN NEW; END IF;
  BEGIN
    v_actor := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;
  v_action := CASE
    WHEN OLD.assigned_user_id IS NULL AND NEW.assigned_user_id IS NOT NULL THEN 'initial'
    WHEN OLD.assigned_user_id IS NOT NULL AND NEW.assigned_user_id IS NULL  THEN 'unassigned'
    WHEN v_actor = NEW.assigned_user_id                                      THEN 'self_assigned'
    ELSE 'reassigned'
  END;
  INSERT INTO lms.lead_assignment_log
    (org_id, lead_id, assigned_by_id, assigned_to_id, action, previous_assignee_id)
  VALUES
    (NEW.org_id, NEW.id, v_actor, NEW.assigned_user_id, v_action, OLD.assigned_user_id);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_assignment_log ON lms.marketing_leads;
CREATE TRIGGER trg_lead_assignment_log
  AFTER UPDATE OF assigned_user_id ON lms.marketing_leads
  FOR EACH ROW EXECUTE FUNCTION lms.log_lead_assignment();

-- ===================================================================
-- ASSIGNMENT AUTHORITY FUNCTION
-- ===================================================================

-- Returns TRUE if acting user has authority to assign a lead to target user.
-- 3-param version: org_id, acting_user_id, target_user_id.
-- SECURITY DEFINER: reads iam.users + iam.vw_user_team_members regardless of calling role.
CREATE OR REPLACE FUNCTION iam.can_assign_to(
  p_org_id         UUID,
  p_acting_user_id UUID,
  p_target_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_role     TEXT;
  v_in_scope BOOLEAN;
BEGIN
  IF p_acting_user_id = p_target_user_id THEN RETURN TRUE; END IF;

  SELECT ur.name INTO v_role
  FROM iam.users u JOIN iam.user_roles ur ON ur.id = u.role_id
  WHERE u.id = p_acting_user_id AND u.org_id = p_org_id
    AND NOT u.is_deleted AND u.is_active;

  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role IN ('super_admin','tenant_admin','org_admin') THEN RETURN TRUE; END IF;

  IF v_role IN ('org_manager','org_sr_manager','senior_sales_executive') THEN
    SELECT COUNT(*) > 0 INTO v_in_scope
    FROM iam.vw_user_team_members
    WHERE manager_id = p_acting_user_id
      AND member_id  = p_target_user_id
      AND org_id     = p_org_id;
    RETURN COALESCE(v_in_scope, FALSE);
  END IF;

  RETURN FALSE;
END; $$;

-- ===================================================================
-- VIEWS
-- ===================================================================

-- Recursive org chart (depth + breadcrumb path).
CREATE OR REPLACE VIEW iam.vw_user_org_chart AS
WITH RECURSIVE tree AS (
  SELECT u.id, u.org_id, u.first_name, u.middle_name, u.last_name, u.full_name, u.email,
         ur.name AS role_name, u.manager_id,
         NULL::UUID AS manager_id_resolved, NULL::TEXT AS manager_full_name,
         0 AS hierarchy_level,
         ARRAY[u.id] AS ancestor_ids,
         ARRAY[u.full_name]::TEXT[] AS path_names
  FROM iam.users u JOIN iam.user_roles ur ON ur.id = u.role_id
  WHERE u.manager_id IS NULL AND NOT u.is_deleted
  UNION ALL
  SELECT u.id, u.org_id, u.first_name, u.middle_name, u.last_name, u.full_name, u.email,
         ur.name AS role_name, u.manager_id,
         t.id AS manager_id_resolved, t.full_name AS manager_full_name,
         t.hierarchy_level + 1,
         t.ancestor_ids || u.id,
         t.path_names   || u.full_name
  FROM iam.users u JOIN iam.user_roles ur ON ur.id = u.role_id
  JOIN tree t ON t.id = u.manager_id
  WHERE NOT u.is_deleted AND NOT (u.id = ANY(t.ancestor_ids))
)
SELECT id AS user_id, org_id, first_name, middle_name, last_name, full_name, email,
       role_name, manager_id, manager_full_name, hierarchy_level,
       array_to_string(path_names, ' > ') AS reporting_path, ancestor_ids
FROM tree;

-- Recursive subtree membership — used by iam.can_assign_to for hierarchy authority.
CREATE OR REPLACE VIEW iam.vw_user_team_members AS
WITH RECURSIVE subtree AS (
  SELECT u.id AS manager_id, u.org_id, u.id AS member_id,
         u.full_name AS member_full_name, u.email AS member_email,
         ur.name AS member_role, u.manager_id AS direct_manager_id,
         0 AS depth, u.is_active, ARRAY[u.id] AS visited
  FROM iam.users u JOIN iam.user_roles ur ON ur.id = u.role_id WHERE NOT u.is_deleted
  UNION ALL
  SELECT s.manager_id, u.org_id, u.id AS member_id,
         u.full_name, u.email, ur.name AS member_role,
         u.manager_id AS direct_manager_id, s.depth + 1, u.is_active,
         s.visited || u.id
  FROM iam.users u JOIN iam.user_roles ur ON ur.id = u.role_id
  JOIN subtree s ON s.member_id = u.manager_id
  WHERE NOT u.is_deleted AND NOT (u.id = ANY(s.visited))
)
SELECT manager_id, org_id, member_id, member_full_name, member_email,
       member_role, direct_manager_id, depth, is_active
FROM subtree WHERE depth > 0;

-- Primary lead listing.
-- city = ml.city (free-text, always populated); city_name = from geographic FK (when available).
CREATE OR REPLACE VIEW lms.vw_dashboard_leads WITH (security_invoker = true) AS
SELECT
  ml.id                AS lead_id,
  ml.org_id,
  o.name               AS org_name,
  ml.first_name,
  ml.middle_name,
  ml.last_name,
  ml.full_name,
  ml.phone,
  ml.email,
  ml.city,
  ci.name              AS city_name,
  st.name              AS state_name,
  co.name              AS country_name,
  ml.address_line1,
  ml.tags,
  ml.metadata,
  ls.name              AS stage,
  ls.label             AS stage_label,
  ls.followup_required,
  ls.is_rejected,
  ls.is_terminated,
  lso.name             AS outcome,
  lso.label            AS outcome_label,
  ml.outcome_comment,
  ml.stage_id,
  ml.outcome_id,
  ac.name              AS campaign_name,
  mp.name              AS platform,
  src.name             AS source,
  u.full_name          AS assigned_rep_name,
  u.email              AS assigned_rep_email,
  ml.assigned_user_id,
  ml.campaign_id,
  ml.is_active,
  ml.superseded_by,
  ml.is_deleted,
  ml.created_at,
  ml.updated_at,
  ml.scheduled_at,
  (ml.scheduled_at IS NOT NULL AND ml.scheduled_at < NOW()) AS is_followup_overdue
FROM  lms.marketing_leads     ml
JOIN  entity.organizations        o    ON o.id    = ml.org_id
LEFT JOIN lms.lead_stage       ls   ON ls.id   = ml.stage_id
LEFT JOIN lms.lead_stage_outcome lso ON lso.id = ml.outcome_id
LEFT JOIN marketing.ad_campaigns     ac   ON ac.id   = ml.campaign_id
LEFT JOIN marketing.marketing_platforms mp ON mp.id  = ac.platform_id
LEFT JOIN iam.users            u    ON u.id    = ml.assigned_user_id
LEFT JOIN lms.lead_sources     src  ON src.id  = ml.source_id
LEFT JOIN geo.cities           ci   ON ci.id   = ml.city_id
LEFT JOIN geo.states           st   ON st.id   = ml.state_id
LEFT JOIN geo.countries        co   ON co.id   = ml.country_id;

-- Unified lead timeline: status changes + follow-ups + interactions + assignment changes.
CREATE OR REPLACE VIEW lms.vw_lead_followup_timeline WITH (security_invoker = true) AS
SELECT
  lsl.id AS event_id, lsl.org_id, lsl.lead_id,
  'status_change'     AS event_type,
  lsl.changed_at      AS event_at,
  cb.full_name AS actor_name, cb.email AS actor_email,
  os.name AS old_stage,  os.label AS old_stage_label,
  ns.name AS new_stage,  ns.label AS new_stage_label,
  ofr.name AS old_outcome, ofr.label AS old_outcome_label,
  nfr.name AS new_outcome, nfr.label AS new_outcome_label,
  au.full_name AS assigned_to_name,
  lsl.transition_note AS note,
  NULL::uuid          AS followup_id,
  NULL::text          AS followup_status,
  NULL::timestamptz   AS scheduled_at,
  NULL::timestamptz   AS completed_at,
  NULL::text          AS interaction_type
FROM lms.lead_status_log lsl
LEFT JOIN iam.users              cb  ON cb.id  = lsl.changed_by_id
LEFT JOIN lms.lead_stage         os  ON os.id  = lsl.old_stage_id
JOIN  lms.lead_stage             ns  ON ns.id  = lsl.new_stage_id
LEFT JOIN lms.lead_stage_outcome ofr ON ofr.id = lsl.old_outcome_id
LEFT JOIN lms.lead_stage_outcome nfr ON nfr.id = lsl.new_outcome_id
LEFT JOIN iam.users              au  ON au.id  = lsl.assigned_user_id

UNION ALL

SELECT
  lf.id, lf.org_id, lf.lead_id,
  'follow_up',
  COALESCE(lf.completed_at, lf.scheduled_at),
  u.full_name, u.email,
  NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  u.full_name, lf.notes,
  lf.id, fs.name, lf.scheduled_at, lf.completed_at, NULL
FROM lms.lead_follow_ups lf
JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
JOIN iam.users u ON u.id = lf.assigned_user_id
WHERE NOT lf.is_deleted

UNION ALL

SELECT
  li.id, li.org_id, li.lead_id,
  'interaction',
  li.occurred_at,
  u.full_name, u.email,
  NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL, li.notes,
  NULL, NULL, NULL, NULL, it.name
FROM lms.lead_interactions li
LEFT JOIN lms.interaction_types it ON it.id = li.interaction_type_id
JOIN iam.users u ON u.id = li.user_id
WHERE NOT li.is_deleted

UNION ALL

SELECT
  l.id, l.org_id, l.lead_id,
  'assignment_change',
  l.assigned_at,
  cu.full_name, cu.email,
  NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  COALESCE(new_u.full_name, 'Unassigned'),
  CASE
    WHEN old_u.full_name IS NULL THEN 'Assigned to '    || COALESCE(new_u.full_name, 'unknown')
    WHEN new_u.full_name IS NULL THEN 'Unassigned from '|| old_u.full_name
    ELSE 'Reassigned from ' || old_u.full_name || ' to ' || COALESCE(new_u.full_name, 'unknown')
  END,
  NULL, NULL, NULL, NULL, NULL
FROM lms.lead_assignment_log l
LEFT JOIN iam.users cu    ON cu.id = l.assigned_by_id
LEFT JOIN iam.users old_u ON old_u.id = l.previous_assignee_id
LEFT JOIN iam.users new_u ON new_u.id = l.assigned_to_id;

-- Assignment history for a lead (who held it, for how long).
CREATE OR REPLACE VIEW lms.vw_lead_assignment_timeline AS
SELECT
  l.id AS log_id, l.org_id, l.lead_id, ml.full_name AS lead_full_name,
  actor.full_name  AS assigned_by_name,  actor.email  AS assigned_by_email,
  target.full_name AS assigned_to_name,  target.email AS assigned_to_email,
  prev.full_name   AS previous_assignee_name,
  l.action, l.note, l.assigned_at,
  LEAD(l.assigned_at) OVER (PARTITION BY l.lead_id ORDER BY l.assigned_at)
    - l.assigned_at AS held_for
FROM lms.lead_assignment_log l
JOIN  lms.marketing_leads ml  ON ml.id    = l.lead_id
LEFT JOIN iam.users actor     ON actor.id  = l.assigned_by_id
LEFT JOIN iam.users target    ON target.id = l.assigned_to_id
LEFT JOIN iam.users prev      ON prev.id   = l.previous_assignee_id;

-- Follow-up queue: pending + missed only.
CREATE OR REPLACE VIEW lms.vw_sales_follow_up_pipeline WITH (security_invoker = true) AS
SELECT
  lf.id AS follow_up_id, lf.org_id, o.name AS org_name,
  ml.full_name AS lead_full_name, ml.phone AS lead_phone, ml.email AS lead_email,
  u.full_name AS assigned_rep_name, u.email AS assigned_rep_email,
  fs.name AS status, lf.scheduled_at, lf.completed_at, lf.notes
FROM lms.lead_follow_ups lf
JOIN lms.marketing_leads     ml ON ml.id  = lf.lead_id
JOIN iam.users               u  ON u.id   = lf.assigned_user_id
JOIN lms.follow_up_statuses  fs ON fs.id  = lf.status_id
JOIN entity.organizations       o  ON o.id   = lf.org_id
WHERE fs.name IN ('pending','missed');

-- Enriched follow-up pipeline with overdue flag + last interaction.
CREATE OR REPLACE VIEW lms.vw_followup_pipeline_enriched WITH (security_invoker = true) AS
SELECT
  lf.id AS follow_up_id, lf.org_id, o.name AS org_name, lf.lead_id,
  ml.full_name AS lead_full_name, ml.phone AS lead_phone, ml.email AS lead_email,
  ls.name AS lead_stage, ls.label AS lead_stage_label, ml.tags AS lead_tags,
  u.id AS assigned_rep_id, u.full_name AS assigned_rep_name, u.email AS assigned_rep_email,
  fs.name AS follow_up_status, lf.scheduled_at, lf.completed_at, lf.notes, lf.created_at,
  (fs.name = 'pending' AND lf.scheduled_at < CLOCK_TIMESTAMP()) AS is_overdue,
  CASE WHEN fs.name = 'pending' AND lf.scheduled_at < CLOCK_TIMESTAMP()
       THEN EXTRACT(EPOCH FROM (CLOCK_TIMESTAMP() - lf.scheduled_at))::INT / 60
       ELSE NULL END AS minutes_overdue,
  last_ix.occurred_at AS last_interaction_at,
  last_ix.type_name   AS last_interaction_type
FROM lms.lead_follow_ups lf
JOIN lms.marketing_leads     ml ON ml.id  = lf.lead_id
JOIN lms.lead_stage          ls ON ls.id  = ml.stage_id
JOIN lms.follow_up_statuses  fs ON fs.id  = lf.status_id
JOIN iam.users               u  ON u.id   = lf.assigned_user_id
JOIN entity.organizations       o  ON o.id   = lf.org_id
LEFT JOIN LATERAL (
  SELECT li.occurred_at, it.name AS type_name
  FROM lms.lead_interactions li
  LEFT JOIN lms.interaction_types it ON it.id = li.interaction_type_id
  WHERE li.lead_id = lf.lead_id AND NOT li.is_deleted
  ORDER BY li.occurred_at DESC LIMIT 1
) last_ix ON TRUE
WHERE NOT lf.is_deleted AND NOT ml.is_deleted AND fs.name IN ('pending','missed');

-- Per-org KPIs for analytics service.
CREATE OR REPLACE VIEW lms.vw_org_performance_snapshot WITH (security_invoker = true) AS
WITH lead_counts AS (
  SELECT ml.org_id,
    COUNT(*)                                        AS total_leads,
    COUNT(*) FILTER (WHERE ls.name = 'converted')   AS converted_leads,
    COUNT(*) FILTER (WHERE ls.name = 'unqualified') AS unqualified_leads
  FROM lms.marketing_leads ml JOIN lms.lead_stage ls ON ls.id = ml.stage_id
  WHERE NOT ml.is_deleted GROUP BY ml.org_id
),
interaction_stats AS (
  SELECT org_id, COUNT(*) AS total_interactions, COUNT(DISTINCT lead_id) AS leads_with_interactions
  FROM lms.lead_interactions WHERE NOT is_deleted GROUP BY org_id
),
follow_up_counts AS (
  SELECT lf.org_id,
    COUNT(*) FILTER (WHERE fs.name = 'pending') AS pending_follow_ups,
    COUNT(*) FILTER (WHERE fs.name = 'missed')  AS missed_follow_ups
  FROM lms.lead_follow_ups lf JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
  WHERE NOT lf.is_deleted GROUP BY lf.org_id
),
platform_usage AS (
  SELECT org_id, most_used_platform FROM (
    SELECT ac.org_id, mp.name AS most_used_platform, COUNT(ml.id) AS lead_count,
           ROW_NUMBER() OVER (PARTITION BY ac.org_id ORDER BY COUNT(ml.id) DESC) AS rn
    FROM marketing.ad_campaigns ac JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
    LEFT JOIN lms.marketing_leads ml ON ml.campaign_id = ac.id AND NOT ml.is_deleted
    WHERE NOT ac.is_deleted GROUP BY ac.org_id, mp.name
  ) r WHERE rn = 1
)
SELECT
  o.id AS org_id, o.name AS org_name, o.tenant_id,
  COALESCE(lc.total_leads,       0)::INT AS total_leads,
  COALESCE(lc.converted_leads,   0)::INT AS converted_leads,
  COALESCE(lc.unqualified_leads, 0)::INT AS unqualified_leads,
  CASE WHEN COALESCE(ist.leads_with_interactions,0) = 0 THEN 0::NUMERIC(5,2)
       ELSE ROUND(ist.total_interactions::NUMERIC / ist.leads_with_interactions, 2)
  END AS avg_interactions_per_lead,
  COALESCE(fc.pending_follow_ups, 0)::INT AS pending_follow_ups,
  COALESCE(fc.missed_follow_ups,  0)::INT AS missed_follow_ups,
  pu.most_used_platform,
  CLOCK_TIMESTAMP() AS snapshot_at
FROM entity.organizations o
LEFT JOIN lead_counts lc ON lc.org_id = o.id
LEFT JOIN interaction_stats ist ON ist.org_id = o.id
LEFT JOIN follow_up_counts fc ON fc.org_id = o.id
LEFT JOIN platform_usage pu ON pu.org_id = o.id
WHERE NOT o.is_deleted;

-- Cross-org tenant KPIs (query as tenant_admin role).
CREATE OR REPLACE VIEW lms.vw_tenant_full_dashboard WITH (security_invoker = true) AS
WITH org_leads AS (
  SELECT ml.org_id,
    COUNT(*)                                               AS total_leads,
    COUNT(*) FILTER (WHERE ls.name = 'new')               AS new_leads,
    COUNT(*) FILTER (WHERE ls.name = 'contacting')        AS contacting_leads,
    COUNT(*) FILTER (WHERE ls.name = 'qualified')         AS qualified_leads,
    COUNT(*) FILTER (WHERE ls.name = 'converted')         AS converted_leads,
    COUNT(*) FILTER (WHERE ls.name = 'unqualified')       AS unqualified_leads,
    COUNT(*) FILTER (WHERE ls.name = 'transferred_out')   AS transferred_out_leads
  FROM lms.marketing_leads ml JOIN lms.lead_stage ls ON ls.id = ml.stage_id
  WHERE NOT ml.is_deleted GROUP BY ml.org_id
),
org_follow_ups AS (
  SELECT lf.org_id,
    COUNT(*) FILTER (WHERE fs.name = 'pending')   AS pending_follow_ups,
    COUNT(*) FILTER (WHERE fs.name = 'missed')    AS missed_follow_ups,
    COUNT(*) FILTER (WHERE fs.name = 'completed') AS completed_follow_ups
  FROM lms.lead_follow_ups lf JOIN lms.follow_up_statuses fs ON fs.id = lf.status_id
  WHERE NOT lf.is_deleted GROUP BY lf.org_id
),
org_platform AS (
  SELECT org_id, most_used_platform FROM (
    SELECT ac.org_id, mp.name AS most_used_platform, COUNT(ml.id) AS cnt,
           ROW_NUMBER() OVER (PARTITION BY ac.org_id ORDER BY COUNT(ml.id) DESC) AS rn
    FROM marketing.ad_campaigns ac JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
    LEFT JOIN lms.marketing_leads ml ON ml.campaign_id = ac.id AND NOT ml.is_deleted
    WHERE NOT ac.is_deleted GROUP BY ac.org_id, mp.name
  ) r WHERE rn = 1
)
SELECT
  o.tenant_id, t.name AS tenant_name, o.id AS org_id, o.name AS org_name,
  ot.name AS org_type,
  o.city,
  ci.name AS city_name, st.name AS state_name,
  COALESCE(ol.total_leads,           0)::INT AS total_leads,
  COALESCE(ol.new_leads,             0)::INT AS new_leads,
  COALESCE(ol.contacting_leads,      0)::INT AS contacting_leads,
  COALESCE(ol.qualified_leads,       0)::INT AS qualified_leads,
  COALESCE(ol.converted_leads,       0)::INT AS converted_leads,
  COALESCE(ol.unqualified_leads,     0)::INT AS unqualified_leads,
  COALESCE(ol.transferred_out_leads, 0)::INT AS transferred_out_leads,
  CASE WHEN COALESCE(ol.total_leads, 0) = 0 THEN 0::NUMERIC(5,2)
       ELSE ROUND(ol.converted_leads::NUMERIC / ol.total_leads * 100, 2)
  END AS conversion_rate_pct,
  COALESCE(ofu.pending_follow_ups,   0)::INT AS pending_follow_ups,
  COALESCE(ofu.missed_follow_ups,    0)::INT AS missed_follow_ups,
  COALESCE(ofu.completed_follow_ups, 0)::INT AS completed_follow_ups,
  op.most_used_platform,
  CLOCK_TIMESTAMP() AS snapshot_at
FROM entity.organizations o
JOIN entity.tenants t ON t.id = o.tenant_id
LEFT JOIN entity.org_types ot ON ot.id = o.org_type_id
LEFT JOIN geo.cities    ci ON ci.id = o.city_id
LEFT JOIN geo.states    st ON st.id = o.state_id
LEFT JOIN org_leads ol ON ol.org_id = o.id
LEFT JOIN org_follow_ups ofu ON ofu.org_id = o.id
LEFT JOIN org_platform   op  ON op.org_id  = o.id
WHERE NOT o.is_deleted AND NOT t.is_deleted;

-- ── ADDITIONAL VIEWS (v1.2) ───────────────────────────────────────

-- All active org-user mappings with role and org context.
-- Used by APIs that need to know which orgs a user can access.
CREATE OR REPLACE VIEW iam.vw_user_org_access WITH (security_invoker = true) AS
SELECT
  uom.user_id,
  u.full_name     AS user_full_name,
  u.email         AS user_email,
  u.is_active     AS user_is_active,
  uom.org_id,
  o.name          AS org_name,
  o.tenant_id,
  t.name          AS tenant_name,
  ur.name         AS role_name,
  ur.label        AS role_label,
  ur.rank         AS role_rank,
  uom.granted_at,
  uom.updated_at  AS mapping_updated_at
FROM iam.user_org_mapping uom
JOIN iam.users          u  ON u.id  = uom.user_id  AND NOT u.is_deleted
JOIN entity.organizations  o  ON o.id  = uom.org_id   AND NOT o.is_deleted
JOIN entity.tenants        t  ON t.id  = o.tenant_id   AND NOT t.is_deleted
JOIN iam.user_roles     ur ON ur.id = uom.role_id
WHERE uom.is_active;

-- Ad campaigns with resolved platform and status names (for dropdowns).
CREATE OR REPLACE VIEW marketing.vw_campaign_lookup WITH (security_invoker = true) AS
SELECT
  ac.id         AS campaign_id,
  ac.name       AS campaign_name,
  ac.org_id,
  o.name        AS org_name,
  mp.name       AS platform_name,
  mp.id         AS platform_id,
  cs.name       AS status_name,
  cs.id         AS status_id,
  ac.budget,
  ac.started_at,
  ac.ended_at,
  ac.created_at
FROM marketing.ad_campaigns      ac
JOIN entity.organizations     o  ON o.id  = ac.org_id      AND NOT o.is_deleted
JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
JOIN marketing.campaign_statuses cs ON cs.id  = ac.status_id
WHERE NOT ac.is_deleted;

-- Per-rep lead counts by stage (org-scoped, for analytics / leaderboard).
CREATE OR REPLACE VIEW lms.vw_rep_performance WITH (security_invoker = true) AS
SELECT
  ml.org_id,
  o.name                AS org_name,
  u.id                  AS rep_id,
  u.full_name           AS rep_name,
  u.email               AS rep_email,
  ur.name               AS role_name,
  COUNT(*)              AS total_assigned,
  COUNT(*) FILTER (WHERE ls.name = 'new')            AS new_count,
  COUNT(*) FILTER (WHERE ls.name = 'contacting')     AS contacting_count,
  COUNT(*) FILTER (WHERE ls.name = 'qualified')      AS qualified_count,
  COUNT(*) FILTER (WHERE ls.name = 'converted')      AS converted_count,
  COUNT(*) FILTER (WHERE ls.name = 'unqualified')    AS unqualified_count,
  COUNT(*) FILTER (WHERE ls.name = 'transferred_out') AS transferred_out_count,
  CASE WHEN COUNT(*) = 0 THEN 0::NUMERIC(5,2)
       ELSE ROUND(
         COUNT(*) FILTER (WHERE ls.name = 'converted')::NUMERIC / COUNT(*) * 100, 2
       )
  END                   AS conversion_rate_pct
FROM lms.marketing_leads ml
JOIN iam.users          u  ON u.id  = ml.assigned_user_id AND NOT u.is_deleted
JOIN iam.user_roles     ur ON ur.id = u.role_id
JOIN entity.organizations  o  ON o.id  = ml.org_id
JOIN lms.lead_stage     ls ON ls.id = ml.stage_id
WHERE NOT ml.is_deleted
GROUP BY ml.org_id, o.name, u.id, u.full_name, u.email, ur.name;

-- Campaign performance (tenant_admin scope).
CREATE OR REPLACE VIEW marketing.vw_tenant_campaign_summary WITH (security_invoker = true) AS
WITH cls AS (
  SELECT sub.campaign_id,
    SUM(sub.stage_cnt)::INT AS total_leads,
    COALESCE(SUM(sub.stage_cnt) FILTER (WHERE ls.name = 'converted'), 0)::INT AS converted_leads,
    jsonb_object_agg(ls.name, sub.stage_cnt) AS leads_by_stage
  FROM (
    SELECT campaign_id, stage_id, COUNT(*) AS stage_cnt
    FROM lms.marketing_leads WHERE campaign_id IS NOT NULL AND NOT is_deleted
    GROUP BY campaign_id, stage_id
  ) sub JOIN lms.lead_stage ls ON ls.id = sub.stage_id GROUP BY sub.campaign_id
)
SELECT
  o.tenant_id, ac.org_id, o.name AS org_name,
  ac.id AS campaign_id, ac.name AS campaign_name,
  mp.name AS platform, cs.name AS campaign_status, ac.budget,
  COALESCE(cls.total_leads, 0)::INT AS total_leads,
  COALESCE(cls.leads_by_stage, '{}'::jsonb) AS leads_by_stage,
  CASE WHEN COALESCE(cls.total_leads, 0) = 0 THEN 0::NUMERIC(5,2)
       ELSE ROUND(COALESCE(cls.converted_leads,0)::NUMERIC / cls.total_leads * 100, 2)
  END AS conversion_rate
FROM marketing.ad_campaigns ac
JOIN entity.organizations o ON o.id = ac.org_id
JOIN marketing.marketing_platforms mp ON mp.id = ac.platform_id
JOIN marketing.campaign_statuses cs ON cs.id = ac.status_id
LEFT JOIN cls ON cls.campaign_id = ac.id
WHERE NOT ac.is_deleted;

-- ===================================================================
-- AUDIT TRIGGER FUNCTIONS
-- ===================================================================

-- RLS on audit.marketing_leads_history.
-- INSERT from the SECURITY DEFINER function bypasses RLS; SELECT is gated.
ALTER TABLE audit.marketing_leads_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.marketing_leads_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS history_org_isolation    ON audit.marketing_leads_history;
DROP POLICY IF EXISTS history_tenant_isolation ON audit.marketing_leads_history;

CREATE POLICY history_org_isolation ON audit.marketing_leads_history
  AS PERMISSIVE FOR SELECT TO app_user
  USING (EXISTS (
    SELECT 1 FROM lms.marketing_leads ml
    WHERE ml.id = audit.marketing_leads_history.lead_id
      AND ml.org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  ));

CREATE POLICY history_tenant_isolation ON audit.marketing_leads_history
  AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (EXISTS (
    SELECT 1 FROM lms.marketing_leads ml
    JOIN entity.organizations o ON o.id = ml.org_id
    WHERE ml.id = audit.marketing_leads_history.lead_id
      AND o.tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- Audit trigger for lms.marketing_leads (field-level diff on UPDATE, snapshot on DELETE).
-- SECURITY DEFINER: app_user has no INSERT on audit.marketing_leads_history.
CREATE OR REPLACE FUNCTION audit.audit_marketing_leads_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  k_skip CONSTANT TEXT[] := ARRAY['updated_at','created_at','id','deleted_at','deleted_by'];
  v_diff       JSONB := '{}';
  v_old_json   JSONB;
  v_new_json   JSONB;
  v_key        TEXT;
  v_old_val    JSONB;
  v_new_val    JSONB;
  v_changed_by UUID;
BEGIN
  BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_changed_by := NULL; END;

  IF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);
    v_new_json := to_jsonb(NEW);
    FOR v_key, v_new_val IN SELECT key, value FROM jsonb_each(v_new_json) LOOP
      CONTINUE WHEN v_key = ANY(k_skip);
      v_old_val := v_old_json -> v_key;
      IF v_new_val IS DISTINCT FROM v_old_val THEN
        v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('old', v_old_val, 'new', v_new_val));
      END IF;
    END LOOP;
    IF v_diff = '{}'::jsonb THEN RETURN NEW; END IF;
    INSERT INTO audit.marketing_leads_history (lead_id, changed_by_user_id, operation, changed_fields)
    VALUES (NEW.id, v_changed_by, 'U', v_diff);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit.marketing_leads_history (lead_id, changed_by_user_id, operation, changed_fields)
    VALUES (OLD.id, v_changed_by, 'D', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_marketing_leads_audit ON lms.marketing_leads;
CREATE TRIGGER trg_marketing_leads_audit
  AFTER UPDATE OR DELETE ON lms.marketing_leads
  FOR EACH ROW EXECUTE FUNCTION audit.audit_marketing_leads_changes();

-- RLS on audit.audit_log.
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON audit.audit_log;
DROP POLICY IF EXISTS tenant_isolation_policy ON audit.audit_log;

CREATE POLICY org_isolation_policy ON audit.audit_log
  AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON audit.audit_log
  AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
      AND NOT is_deleted
  ));

-- Generic audit trigger for all operational tables except lms.marketing_leads.
-- SECURITY DEFINER: app_user has no INSERT on audit.audit_log.
CREATE OR REPLACE FUNCTION audit.audit_row_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  k_skip   CONSTANT TEXT[] := ARRAY['updated_at','created_at','id','deleted_at','deleted_by','created_by'];
  v_diff       JSONB := '{}';
  v_old_json   JSONB;
  v_new_json   JSONB;
  v_key        TEXT;
  v_old_val    JSONB;
  v_new_val    JSONB;
  v_changed_by UUID;
  v_record_id  UUID;
  v_org_id     UUID;
BEGIN
  BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_changed_by := NULL; END;

  IF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);
    v_new_json := to_jsonb(NEW);
    FOR v_key, v_new_val IN SELECT key, value FROM jsonb_each(v_new_json) LOOP
      CONTINUE WHEN v_key = ANY(k_skip);
      v_old_val := v_old_json -> v_key;
      IF v_new_val IS DISTINCT FROM v_old_val THEN
        v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('old', v_old_val, 'new', v_new_val));
      END IF;
    END LOOP;
    IF v_diff = '{}'::jsonb THEN RETURN NEW; END IF;
    v_record_id := (to_jsonb(NEW) ->> 'id')::uuid;
    v_org_id    := NULLIF(to_jsonb(NEW) ->> 'org_id', '')::uuid;
    INSERT INTO audit.audit_log (table_name, operation, record_id, row_id, org_id, changed_by, actor_id, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, 'U', v_record_id, v_record_id, v_org_id, v_changed_by, v_changed_by, v_diff, v_old_json, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_json  := to_jsonb(OLD);
    v_record_id := (v_old_json ->> 'id')::uuid;
    v_org_id    := NULLIF(v_old_json ->> 'org_id', '')::uuid;
    INSERT INTO audit.audit_log (table_name, operation, record_id, row_id, org_id, changed_by, actor_id, changed_fields, old_data)
    VALUES (TG_TABLE_NAME, 'D', v_record_id, v_record_id, v_org_id, v_changed_by, v_changed_by, v_old_json, v_old_json);
    RETURN OLD;
  END IF;
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS trg_users_audit           ON iam.users;
CREATE TRIGGER trg_users_audit
  AFTER UPDATE OR DELETE ON iam.users FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

DROP TRIGGER IF EXISTS trg_ad_campaigns_audit    ON marketing.ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_audit
  AFTER UPDATE OR DELETE ON marketing.ad_campaigns FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

DROP TRIGGER IF EXISTS trg_lead_interactions_audit ON lms.lead_interactions;
CREATE TRIGGER trg_lead_interactions_audit
  AFTER UPDATE OR DELETE ON lms.lead_interactions FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

DROP TRIGGER IF EXISTS trg_lead_follow_ups_audit ON lms.lead_follow_ups;
CREATE TRIGGER trg_lead_follow_ups_audit
  AFTER UPDATE OR DELETE ON lms.lead_follow_ups FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

-- Lead stage transition log.
-- SECURITY DEFINER: app_user has no INSERT on lms.lead_status_log.
-- transition_note is read from app.lead_transition_note session GUC set by the API.
CREATE OR REPLACE FUNCTION lms.log_lead_stage_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_changed_by UUID;
  v_note       TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
       AND NEW.outcome_id IS NOT DISTINCT FROM OLD.outcome_id THEN
      RETURN NEW;
    END IF;
  END IF;
  BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_changed_by := NULL; END;
  BEGIN
    v_note := NULLIF(current_setting('app.lead_transition_note', true), '');
  EXCEPTION WHEN OTHERS THEN v_note := NULL; END;

  INSERT INTO lms.lead_status_log (
    org_id, lead_id,
    old_stage_id, new_stage_id,
    old_outcome_id, new_outcome_id,
    assigned_user_id, changed_by_id, transition_note
  ) VALUES (
    NEW.org_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.stage_id END,
    NEW.stage_id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.outcome_id END,
    NEW.outcome_id,
    NEW.assigned_user_id,
    v_changed_by,
    v_note
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_lead_status_log  ON lms.marketing_leads;
DROP TRIGGER IF EXISTS trg_lead_stage_log   ON lms.marketing_leads;
CREATE TRIGGER trg_lead_stage_log
  AFTER INSERT OR UPDATE OF stage_id, outcome_id ON lms.marketing_leads
  FOR EACH ROW EXECUTE FUNCTION lms.log_lead_stage_change();

-- ===================================================================
-- ROW LEVEL SECURITY
-- ===================================================================

-- lms.marketing_leads
ALTER TABLE lms.marketing_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.marketing_leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.marketing_leads;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.marketing_leads;
CREATE POLICY org_isolation_policy ON lms.marketing_leads AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON lms.marketing_leads AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- iam.users
ALTER TABLE iam.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON iam.users;
DROP POLICY IF EXISTS tenant_isolation_policy ON iam.users;
CREATE POLICY org_isolation_policy ON iam.users AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON iam.users AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- marketing.ad_campaigns
ALTER TABLE marketing.ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.ad_campaigns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON marketing.ad_campaigns;
DROP POLICY IF EXISTS tenant_isolation_policy ON marketing.ad_campaigns;
CREATE POLICY org_isolation_policy ON marketing.ad_campaigns AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON marketing.ad_campaigns AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- lms.lead_interactions
ALTER TABLE lms.lead_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.lead_interactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.lead_interactions;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.lead_interactions;
CREATE POLICY org_isolation_policy ON lms.lead_interactions AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON lms.lead_interactions AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- lms.lead_follow_ups
ALTER TABLE lms.lead_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.lead_follow_ups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.lead_follow_ups;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.lead_follow_ups;
CREATE POLICY org_isolation_policy ON lms.lead_follow_ups AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON lms.lead_follow_ups AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- lms.lead_assignment_log
ALTER TABLE lms.lead_assignment_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.lead_assignment_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.lead_assignment_log;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.lead_assignment_log;
CREATE POLICY org_isolation_policy ON lms.lead_assignment_log AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY tenant_isolation_policy ON lms.lead_assignment_log AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

-- lms.lead_status_log (SELECT only for non-service roles)
ALTER TABLE lms.lead_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms.lead_status_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON lms.lead_status_log;
DROP POLICY IF EXISTS tenant_isolation_policy ON lms.lead_status_log;
CREATE POLICY org_isolation_policy ON lms.lead_status_log AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY tenant_isolation_policy ON lms.lead_status_log AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

-- ===================================================================
-- INDEXES
-- ===================================================================

-- lms.marketing_leads
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_stage_created
  ON lms.marketing_leads (org_id, stage_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_created
  ON lms.marketing_leads (org_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_assigned_user
  ON lms.marketing_leads (org_id, assigned_user_id, created_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_campaign
  ON lms.marketing_leads (org_id, campaign_id) WHERE campaign_id IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_outcome
  ON lms.marketing_leads (org_id, outcome_id) WHERE outcome_id IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_phone
  ON lms.marketing_leads (org_id, phone) WHERE phone IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_org_email
  ON lms.marketing_leads (org_id, email) WHERE email IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_fullname_trgm
  ON lms.marketing_leads USING GIN (full_name gin_trgm_ops) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_webhook_gin
  ON lms.marketing_leads USING GIN (raw_webhook_data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_metadata_gin
  ON lms.marketing_leads USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_marketing_leads_tags_gin
  ON lms.marketing_leads USING GIN (tags);

-- lms.lead_interactions
CREATE INDEX IF NOT EXISTS idx_lead_interactions_org_lead_occurred
  ON lms.lead_interactions (org_id, lead_id, occurred_at DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead_id
  ON lms.lead_interactions (lead_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_lead_interactions_lead_id_full
  ON lms.lead_interactions (lead_id);

-- lms.lead_follow_ups
CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_org_user_scheduled
  ON lms.lead_follow_ups (org_id, assigned_user_id, scheduled_at ASC, status_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_lead_id
  ON lms.lead_follow_ups (lead_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_lead_id_full
  ON lms.lead_follow_ups (lead_id);

-- lms.lead_assignment_log
CREATE INDEX IF NOT EXISTS idx_lead_assignment_log_lead
  ON lms.lead_assignment_log (org_id, lead_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_log_assigned_by
  ON lms.lead_assignment_log (org_id, assigned_by_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_log_assigned_to
  ON lms.lead_assignment_log (org_id, assigned_to_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_log_lead_id_full
  ON lms.lead_assignment_log (lead_id);

-- marketing.ad_campaigns
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_org_platform
  ON marketing.ad_campaigns (org_id, platform_id) WHERE NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uix_ad_campaigns_org_meta_campaign_id
  ON marketing.ad_campaigns (org_id, meta_campaign_id)
  WHERE meta_campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_meta_campaign_id
  ON marketing.ad_campaigns (meta_campaign_id)
  WHERE meta_campaign_id IS NOT NULL;

-- entity.organizations
CREATE INDEX IF NOT EXISTS idx_organizations_tenant_id
  ON entity.organizations (tenant_id) WHERE NOT is_deleted;

-- iam.users
CREATE INDEX IF NOT EXISTS idx_users_org_role
  ON iam.users (org_id, role_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_users_org_email
  ON iam.users (org_id, email) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON iam.users USING GIN (email gin_trgm_ops) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_users_manager_id
  ON iam.users (org_id, manager_id) WHERE manager_id IS NOT NULL AND NOT is_deleted;

-- Vector similarity stub — uncomment after pgvector confirmed and embedding column added
-- CREATE INDEX IF NOT EXISTS idx_marketing_leads_embedding_ivfflat
--   ON lms.marketing_leads USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ===================================================================
-- GRANTS
-- ===================================================================

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL    ON SCHEMA public FROM PUBLIC;
GRANT  USAGE  ON SCHEMA public TO PUBLIC;
GRANT  USAGE  ON SCHEMA public    TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA geo       TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA entity    TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA iam       TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA lms       TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA marketing TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA audit     TO app_user, tenant_admin, root_service;
GRANT  USAGE  ON SCHEMA ext       TO app_user, tenant_admin, root_service;

DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO root_service', current_database()); END; $$;

-- app_user: DML on operational tables; SELECT-only on audit + lookups
GRANT SELECT, INSERT, UPDATE ON TABLE
  iam.users, marketing.ad_campaigns, lms.marketing_leads, lms.lead_interactions, lms.lead_follow_ups TO app_user;
REVOKE DELETE ON TABLE
  iam.users, marketing.ad_campaigns, lms.marketing_leads, lms.lead_interactions, lms.lead_follow_ups FROM app_user;

GRANT SELECT ON TABLE
  iam.user_roles, lms.lead_stage, lms.lead_stage_outcome, lms.interaction_types, lms.follow_up_statuses,
  marketing.marketing_platforms, marketing.campaign_statuses, entity.org_types, entity.tenant_domains, entity.tenant_plan_types,
  lms.lead_sources, entity.organizations,
  geo.countries, geo.states, geo.cities
TO app_user;

GRANT SELECT ON TABLE lms.lead_assignment_log, lms.lead_status_log, audit.marketing_leads_history, audit.audit_log TO app_user;
REVOKE INSERT, UPDATE, DELETE ON TABLE lms.lead_assignment_log, lms.lead_status_log, audit.marketing_leads_history, audit.audit_log FROM app_user;

GRANT SELECT ON TABLE
  lms.vw_dashboard_leads, iam.vw_user_org_chart, iam.vw_user_team_members,
  lms.vw_lead_followup_timeline, lms.vw_lead_assignment_timeline,
  lms.vw_sales_follow_up_pipeline, lms.vw_followup_pipeline_enriched,
  lms.vw_org_performance_snapshot,
  iam.vw_user_org_access, marketing.vw_campaign_lookup, lms.vw_rep_performance
TO app_user;

GRANT EXECUTE ON FUNCTION iam.can_assign_to(UUID,UUID,UUID) TO app_user;

-- tenant_admin: cross-org DML
GRANT SELECT, INSERT, UPDATE ON TABLE
  iam.users, marketing.ad_campaigns, lms.marketing_leads, lms.lead_interactions, lms.lead_follow_ups TO tenant_admin;
REVOKE DELETE ON TABLE
  iam.users, marketing.ad_campaigns, lms.marketing_leads, lms.lead_interactions, lms.lead_follow_ups FROM tenant_admin;

GRANT SELECT ON TABLE
  entity.organizations, lms.lead_assignment_log, lms.lead_status_log, audit.marketing_leads_history TO tenant_admin;
GRANT SELECT ON TABLE audit.audit_log TO tenant_admin;
REVOKE INSERT, UPDATE, DELETE ON TABLE audit.audit_log FROM tenant_admin;
GRANT SELECT ON TABLE
  iam.user_roles, lms.lead_stage, lms.lead_stage_outcome, lms.interaction_types, lms.follow_up_statuses,
  marketing.marketing_platforms, marketing.campaign_statuses, entity.org_types, entity.tenant_domains, entity.tenant_plan_types,
  lms.lead_sources,
  geo.countries, geo.states, geo.cities
TO tenant_admin;

GRANT SELECT ON TABLE
  lms.vw_dashboard_leads, iam.vw_user_org_chart, iam.vw_user_team_members,
  lms.vw_lead_followup_timeline, lms.vw_lead_assignment_timeline,
  lms.vw_sales_follow_up_pipeline, lms.vw_followup_pipeline_enriched,
  marketing.vw_tenant_campaign_summary, lms.vw_tenant_full_dashboard,
  lms.vw_org_performance_snapshot,
  iam.vw_user_org_access, marketing.vw_campaign_lookup, lms.vw_rep_performance
TO tenant_admin;

GRANT EXECUTE ON FUNCTION iam.can_assign_to(UUID,UUID,UUID) TO tenant_admin;

-- root_service: unrestricted across all schemas
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['public','geo','entity','iam','lms','marketing','audit','ext'] LOOP
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA %I TO root_service', s);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO root_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL PRIVILEGES ON TABLES    TO root_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL PRIVILEGES ON SEQUENCES TO root_service', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO app_user', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO tenant_admin', s);
  END LOOP;
END; $$;

-- ===================================================================
-- SERVICE LOGIN ROLES  (per-microservice credentials)
-- Each service connects with its own login role, then does:
--   SET LOCAL ROLE app_user;          -- activates RLS + grants
--   SET LOCAL app.current_org_id = '...';
--   SET LOCAL app.current_user_id = '...';
-- ===================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lead_svc') THEN
    CREATE ROLE lead_svc WITH LOGIN PASSWORD 'LeadSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE lead_svc WITH LOGIN PASSWORD 'LeadSvc_Dev2025' NOINHERIT; END IF;
END; $$;
GRANT app_user TO lead_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campaign_svc') THEN
    CREATE ROLE campaign_svc WITH LOGIN PASSWORD 'replace_in_env' NOINHERIT;
  ELSE ALTER ROLE campaign_svc WITH LOGIN NOINHERIT; END IF;
END; $$;
GRANT app_user TO campaign_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'user_mgmt_svc') THEN
    CREATE ROLE user_mgmt_svc WITH LOGIN PASSWORD 'replace_in_env' NOINHERIT;
  ELSE ALTER ROLE user_mgmt_svc WITH LOGIN NOINHERIT; END IF;
END; $$;
GRANT app_user TO user_mgmt_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notif_svc') THEN
    CREATE ROLE notif_svc WITH LOGIN PASSWORD 'replace_in_env' NOINHERIT;
  ELSE ALTER ROLE notif_svc WITH LOGIN NOINHERIT; END IF;
END; $$;
GRANT app_user TO notif_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intake_svc') THEN
    CREATE ROLE intake_svc WITH LOGIN PASSWORD 'replace_in_env' NOINHERIT;
  ELSE ALTER ROLE intake_svc WITH LOGIN NOINHERIT; END IF;
END; $$;
GRANT app_user TO intake_svc;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_dash_svc') THEN
    CREATE ROLE tenant_dash_svc WITH LOGIN PASSWORD 'TenantSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE tenant_dash_svc WITH LOGIN PASSWORD 'TenantSvc_Dev2025' NOINHERIT; END IF;
END; $$;
GRANT tenant_admin TO tenant_dash_svc;

-- analytics_svc: BYPASSRLS + SELECT only (read replica)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_svc') THEN
    CREATE ROLE analytics_svc WITH LOGIN PASSWORD 'replace_in_env' BYPASSRLS NOINHERIT;
  ELSE ALTER ROLE analytics_svc WITH LOGIN BYPASSRLS NOINHERIT; END IF;
END; $$;
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['public','geo','entity','iam','lms','marketing','audit','ext'] LOOP
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO analytics_svc', s);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I FROM analytics_svc', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO analytics_svc', s);
  END LOOP;
END; $$;

-- Schema USAGE for all service roles
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['public','geo','entity','iam','lms','marketing','audit','ext'] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO lead_svc, campaign_svc, user_mgmt_svc, notif_svc, intake_svc, tenant_dash_svc, analytics_svc', s);
  END LOOP;
END; $$;

DO $$
DECLARE v_db TEXT := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lead_svc',        v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO campaign_svc',    v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO user_mgmt_svc',   v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO notif_svc',       v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO intake_svc',      v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tenant_dash_svc', v_db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO analytics_svc',   v_db);
END; $$;

-- Production password rotation — run via psql with -v vars set:
--   psql ... -v LEAD_SVC_PWD=xxx -v TENANT_DASH_PWD=xxx -v ROOT_SVC_PWD=xxx ...
-- Maps to .env: DATABASE_URL / DATABASE_URL_TENANT / DATABASE_URL_SERVICE
-- ALTER ROLE lead_svc        WITH PASSWORD :'LEAD_SVC_PWD';       -- → DATABASE_URL
-- ALTER ROLE tenant_dash_svc WITH PASSWORD :'TENANT_DASH_PWD';    -- → DATABASE_URL_TENANT
-- ALTER ROLE root_service     WITH PASSWORD :'ROOT_SVC_PWD';        -- → DATABASE_URL_SERVICE
-- ALTER ROLE campaign_svc    WITH PASSWORD :'CAMPAIGN_SVC_PWD';
-- ALTER ROLE user_mgmt_svc   WITH PASSWORD :'USER_MGMT_PWD';
-- ALTER ROLE notif_svc       WITH PASSWORD :'NOTIF_SVC_PWD';
-- ALTER ROLE intake_svc      WITH PASSWORD :'INTAKE_SVC_PWD';
-- ALTER ROLE analytics_svc   WITH PASSWORD :'ANALYTICS_SVC_PWD';

-- ===================================================================
-- v1.1: MULTI-ORG RLS FIX (auto-grant triggers + updated FK checks)
-- ===================================================================

-- ── AUTO-GRANT TRIGGER 1 ──────────────────────────────────────────
-- New org added to a tenant → all existing tenant_admins in that
-- tenant automatically receive a row for the new org.
CREATE OR REPLACE FUNCTION iam.auto_grant_tenant_admins_on_new_org()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO iam.user_org_mapping (user_id, org_id, role_id, is_active, granted_by)
  SELECT uom.user_id, NEW.id, uom.role_id, TRUE, NULL
  FROM iam.user_org_mapping uom
  JOIN entity.organizations    o  ON o.id  = uom.org_id
  JOIN iam.user_roles       ur ON ur.id = uom.role_id
  WHERE o.tenant_id = NEW.tenant_id
    AND ur.name     = 'tenant_admin'
    AND uom.is_active
  ON CONFLICT (user_id, org_id) DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_auto_grant_tenant_admins_on_new_org ON entity.organizations;
CREATE TRIGGER trg_auto_grant_tenant_admins_on_new_org
  AFTER INSERT ON entity.organizations
  FOR EACH ROW EXECUTE FUNCTION iam.auto_grant_tenant_admins_on_new_org();

-- ── AUTO-GRANT TRIGGER 2 ──────────────────────────────────────────
-- User first granted tenant_admin in any org → they automatically
-- receive rows for all other existing orgs in the same tenant.
-- pg_trigger_depth() guard prevents recursive re-firing when this
-- function's own INSERTs trigger the same event.
CREATE OR REPLACE FUNCTION iam.auto_grant_all_orgs_on_tenant_admin()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tenant_id UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM iam.user_roles WHERE id = NEW.role_id AND name = 'tenant_admin'
  ) THEN RETURN NEW; END IF;

  SELECT tenant_id INTO v_tenant_id FROM entity.organizations WHERE id = NEW.org_id;

  INSERT INTO iam.user_org_mapping (user_id, org_id, role_id, is_active, granted_by)
  SELECT NEW.user_id, o.id, NEW.role_id, TRUE, NEW.granted_by
  FROM entity.organizations o
  WHERE o.tenant_id = v_tenant_id
    AND o.id       <> NEW.org_id
    AND NOT o.is_deleted
  ON CONFLICT (user_id, org_id) DO NOTHING;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_auto_grant_all_orgs_on_tenant_admin ON iam.user_org_mapping;
CREATE TRIGGER trg_auto_grant_all_orgs_on_tenant_admin
  AFTER INSERT ON iam.user_org_mapping
  FOR EACH ROW EXECUTE FUNCTION iam.auto_grant_all_orgs_on_tenant_admin();

-- ── UPDATED FK SCOPE CHECKS ───────────────────────────────────────
-- Now validate via iam.user_org_mapping so multi-org iam.users (whose home
-- org_id differs from the working org) are not incorrectly rejected.

CREATE OR REPLACE FUNCTION lms.check_lead_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    PERFORM 1 FROM marketing.ad_campaigns
    WHERE id = NEW.campaign_id AND org_id = NEW.org_id AND NOT is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_id % does not belong to org % or has been deleted.',
        NEW.campaign_id, NEW.org_id;
    END IF;
  END IF;
  IF NEW.assigned_user_id IS NOT NULL THEN
    PERFORM 1
    FROM iam.user_org_mapping uom
    JOIN iam.users u ON u.id = uom.user_id
    WHERE uom.user_id = NEW.assigned_user_id
      AND uom.org_id  = NEW.org_id
      AND uom.is_active
      AND u.is_active AND NOT u.is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assigned_user_id % has no active mapping to org % or has been deleted.',
        NEW.assigned_user_id, NEW.org_id;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.check_interaction_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.',
      NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1
  FROM iam.user_org_mapping uom
  JOIN iam.users u ON u.id = uom.user_id
  WHERE uom.user_id = NEW.user_id
    AND uom.org_id  = NEW.org_id
    AND uom.is_active
    AND u.is_active AND NOT u.is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_id % has no active mapping to org % or has been deleted.',
      NEW.user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION lms.check_follow_up_fk_org_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM lms.marketing_leads
  WHERE id = NEW.lead_id AND org_id = NEW.org_id AND NOT is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_id % does not belong to org % or has been deleted.',
      NEW.lead_id, NEW.org_id;
  END IF;
  PERFORM 1
  FROM iam.user_org_mapping uom
  JOIN iam.users u ON u.id = uom.user_id
  WHERE uom.user_id = NEW.assigned_user_id
    AND uom.org_id  = NEW.org_id
    AND uom.is_active
    AND u.is_active AND NOT u.is_deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assigned_user_id % has no active mapping to org % or has been deleted.',
      NEW.assigned_user_id, NEW.org_id;
  END IF;
  RETURN NEW;
END; $$;

-- ── UPDATED iam.can_assign_to ─────────────────────────────────────────
-- Looks up role via iam.user_org_mapping instead of iam.users.org_id so that
-- multi-org iam.users are evaluated for the org they are currently working in.
CREATE OR REPLACE FUNCTION iam.can_assign_to(
  p_org_id         UUID,
  p_acting_user_id UUID,
  p_target_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_role     TEXT;
  v_in_scope BOOLEAN;
BEGIN
  IF p_acting_user_id = p_target_user_id THEN RETURN TRUE; END IF;

  SELECT ur.name INTO v_role
  FROM iam.user_org_mapping uom
  JOIN iam.user_roles ur ON ur.id = uom.role_id
  JOIN iam.users      u  ON u.id  = uom.user_id
  WHERE uom.user_id = p_acting_user_id
    AND uom.org_id  = p_org_id
    AND uom.is_active
    AND u.is_active AND NOT u.is_deleted;

  IF v_role IS NULL THEN RETURN FALSE; END IF;
  IF v_role IN ('super_admin','tenant_admin','org_admin') THEN RETURN TRUE; END IF;

  IF v_role IN ('org_manager','org_sr_manager','senior_sales_executive') THEN
    SELECT COUNT(*) > 0 INTO v_in_scope
    FROM iam.vw_user_team_members
    WHERE manager_id = p_acting_user_id
      AND member_id  = p_target_user_id
      AND org_id     = p_org_id;
    RETURN COALESCE(v_in_scope, FALSE);
  END IF;

  RETURN FALSE;
END; $$;

-- ── RLS: entity.organizations ────────────────────────────────────────────
-- Previously had no RLS — anyone with app_user could read all orgs.
-- Now: app_user sees only orgs they are mapped to; tenant_admin sees
-- all orgs within their tenant.
ALTER TABLE entity.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity.organizations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON entity.organizations;
DROP POLICY IF EXISTS tenant_isolation_policy ON entity.organizations;

CREATE POLICY org_isolation_policy ON entity.organizations AS PERMISSIVE FOR SELECT TO app_user
  USING (
    NOT is_deleted AND
    id = ANY(iam.fn_user_active_orgs(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid
    ))
  );

CREATE POLICY tenant_isolation_policy ON entity.organizations AS PERMISSIVE FOR ALL TO tenant_admin
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND NOT is_deleted
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND NOT is_deleted
  );

-- ── RLS: iam.users — update SELECT to use iam.user_org_mapping ────────────
-- Old policy: org_id = current_org_id (breaks for multi-org iam.users
-- whose home org differs from the org they're currently working in).
-- New SELECT policy: see all iam.users who have an active mapping to the
-- current org (regardless of their home org_id).
-- Write policies remain anchored to org_id for home-org assignment.
ALTER TABLE iam.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON iam.users;
DROP POLICY IF EXISTS tenant_isolation_policy ON iam.users;
DROP POLICY IF EXISTS users_org_select        ON iam.users;
DROP POLICY IF EXISTS users_org_write         ON iam.users;
DROP POLICY IF EXISTS users_org_update        ON iam.users;
DROP POLICY IF EXISTS users_tenant_isolation  ON iam.users;

CREATE POLICY users_org_select ON iam.users AS PERMISSIVE FOR SELECT TO app_user
  USING (
    NOT is_deleted AND
    id = ANY(iam.fn_org_active_users(
      NULLIF(current_setting('app.current_org_id', true), '')::uuid
    ))
  );

CREATE POLICY users_org_write ON iam.users AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND NOT is_deleted
  );

CREATE POLICY users_org_update ON iam.users AS PERMISSIVE FOR UPDATE TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND NOT is_deleted
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND NOT is_deleted
  );

CREATE POLICY users_tenant_isolation ON iam.users AS PERMISSIVE FOR ALL TO tenant_admin
  USING (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND NOT is_deleted
    ) AND NOT is_deleted
  )
  WITH CHECK (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND NOT is_deleted
    ) AND NOT is_deleted
  );

-- ── RLS: iam.user_org_mapping ─────────────────────────────────────────
-- Policies use SECURITY DEFINER helpers to avoid recursive RLS
-- (a policy querying iam.user_org_mapping would trigger its own RLS).
ALTER TABLE iam.user_org_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.user_org_mapping FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS self_read_policy        ON iam.user_org_mapping;
DROP POLICY IF EXISTS org_admin_manage_policy ON iam.user_org_mapping;
DROP POLICY IF EXISTS tenant_isolation_policy ON iam.user_org_mapping;

-- Any user can read their own mapping rows.
CREATE POLICY self_read_policy ON iam.user_org_mapping AS PERMISSIVE FOR SELECT TO app_user
  USING (
    user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

-- Org admins (rank >= 80) can manage mappings within their current org.
-- iam.fn_user_org_rank is SECURITY DEFINER so it bypasses RLS on this table.
CREATE POLICY org_admin_manage_policy ON iam.user_org_mapping AS PERMISSIVE FOR ALL TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  );

-- tenant_admin can manage all mappings across their tenant's orgs.
CREATE POLICY tenant_isolation_policy ON iam.user_org_mapping AS PERMISSIVE FOR ALL TO tenant_admin
  USING (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND NOT is_deleted
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND NOT is_deleted
    )
  );

-- ── GRANTS: iam.user_org_mapping ──────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE iam.user_org_mapping TO app_user;
REVOKE DELETE ON TABLE iam.user_org_mapping FROM app_user;

GRANT SELECT, INSERT, UPDATE ON TABLE iam.user_org_mapping TO tenant_admin;
REVOKE DELETE ON TABLE iam.user_org_mapping FROM tenant_admin;

GRANT ALL PRIVILEGES ON TABLE iam.user_org_mapping TO root_service;

-- tenant_admin can also manage entity.organizations
GRANT INSERT, UPDATE ON TABLE entity.organizations TO tenant_admin;

GRANT EXECUTE ON FUNCTION iam.fn_user_active_orgs(UUID)  TO app_user, tenant_admin;
GRANT EXECUTE ON FUNCTION iam.fn_org_active_users(UUID)  TO app_user, tenant_admin;
GRANT EXECUTE ON FUNCTION iam.fn_user_org_rank(UUID,UUID) TO app_user, tenant_admin;

-- ===================================================================
-- SECURITY HARDENING BLOCK
-- (Issues: #4 JWT blocklist, #15 audit.activities RLS, #19 view
--  security_invoker, #28 iam.user_org_mapping policy split, #32 audit.audit_log)
-- ===================================================================

-- ── TOKEN BLOCKLIST (issue #4: DB-backed JWT revocation) ──────────
-- Supports revocation at JTI (logout), user, org, and tenant level.
CREATE TABLE IF NOT EXISTS iam.token_blocklist (
  id          UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  jti         TEXT,
  user_id     UUID        REFERENCES iam.users(id)         ON DELETE CASCADE,
  org_id      UUID        REFERENCES entity.organizations(id) ON DELETE CASCADE,
  tenant_id   UUID,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by  UUID        REFERENCES iam.users(id)         ON DELETE SET NULL,
  reason      TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_blocklist_has_scope CHECK (
    jti IS NOT NULL OR user_id IS NOT NULL OR org_id IS NOT NULL OR tenant_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_blocklist_jti
  ON iam.token_blocklist (jti) WHERE jti IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_blocklist_user
  ON iam.token_blocklist (user_id, revoked_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_blocklist_org
  ON iam.token_blocklist (org_id, revoked_at) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_blocklist_tenant
  ON iam.token_blocklist (tenant_id, revoked_at) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_token_blocklist_expires
  ON iam.token_blocklist (expires_at);

-- Cleanup job: delete entries whose tokens have already expired
CREATE OR REPLACE FUNCTION iam.purge_expired_token_blocklist() RETURNS void
LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM iam.token_blocklist WHERE expires_at < NOW();
$$;

GRANT ALL ON TABLE iam.token_blocklist TO root_service;
REVOKE ALL  ON TABLE iam.token_blocklist FROM app_user, tenant_admin;

-- ── ACTIVITIES RLS (issue #15) ────────────────────────────────────
ALTER TABLE audit.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.activities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON audit.activities;
DROP POLICY IF EXISTS tenant_isolation_policy ON audit.activities;

CREATE POLICY org_isolation_policy ON audit.activities AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON audit.activities AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (
    org_id IN (
      SELECT id FROM entity.organizations
      WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND NOT is_deleted
    )
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE audit.activities FROM app_user, tenant_admin;
GRANT SELECT ON TABLE audit.activities TO app_user;
GRANT SELECT ON TABLE audit.activities TO tenant_admin;
GRANT ALL    ON TABLE audit.activities TO root_service;

-- ── VIEW SECURITY_INVOKER (issue #19) ─────────────────────────────
-- These views were missing WITH (security_invoker = true), which
-- means queries ran as the view owner, bypassing the caller's RLS.
ALTER VIEW iam.vw_user_org_chart          SET (security_invoker = true);
ALTER VIEW iam.vw_user_team_members       SET (security_invoker = true);
ALTER VIEW lms.vw_lead_assignment_timeline SET (security_invoker = true);

-- ── USER_ORG_MAPPING: split PERMISSIVE FOR ALL policy (issue #28) ─
-- The previous org_admin_manage_policy was FOR ALL (SELECT + DML),
-- which stacks additively (OR) with self_read_policy for SELECT.
-- Split into explicit per-operation policies to prevent ambiguity.
DROP POLICY IF EXISTS org_admin_manage_policy ON iam.user_org_mapping;
DROP POLICY IF EXISTS org_admin_read_policy   ON iam.user_org_mapping;
DROP POLICY IF EXISTS org_admin_insert_policy ON iam.user_org_mapping;
DROP POLICY IF EXISTS org_admin_update_policy ON iam.user_org_mapping;

CREATE POLICY org_admin_read_policy ON iam.user_org_mapping AS PERMISSIVE FOR SELECT TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  );

CREATE POLICY org_admin_insert_policy ON iam.user_org_mapping AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  );

CREATE POLICY org_admin_update_policy ON iam.user_org_mapping AS PERMISSIVE FOR UPDATE TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 80
  );

-- ── USER_ORG_MAPPING: assignable-users read policy (issue #33) ────
-- org_admin_read_policy (rank >= 80) is the only SELECT grant beyond a
-- user's own row, but GET /users/assignable (services/users-service)
-- is meant for anyone at or above RANKS.SSE (40) — see
-- packages/permissions/src/business-rules.ts minRankToAssignLeads.
-- Actors ranked 40-79 (SSE, org_manager, org_sr_manager) were silently
-- getting zero rows back from the join to this table, making the
-- "Assigned To" picker on the Edit Lead modal appear empty for them.
DROP POLICY IF EXISTS assignable_read_policy ON iam.user_org_mapping;

CREATE POLICY assignable_read_policy ON iam.user_org_mapping AS PERMISSIVE FOR SELECT TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND iam.fn_user_org_rank(
      NULLIF(current_setting('app.current_user_id', true), '')::uuid,
      NULLIF(current_setting('app.current_org_id',  true), '')::uuid
    ) >= 40
  );

-- ── AUDIT_LOG: remove duplicate alias columns (issue #32) ─────────
-- row_id and actor_id are exact aliases of record_id and changed_by.
-- Drop them and update the trigger to only use the canonical names.
ALTER TABLE audit.audit_log
  DROP COLUMN IF EXISTS row_id,
  DROP COLUMN IF EXISTS actor_id;

-- Update the audit trigger function to stop writing the dropped columns.
CREATE OR REPLACE FUNCTION audit.audit_row_changes() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_old_json  JSONB;
  v_diff      JSONB := '{}';
  v_key       TEXT;
  v_old_val   JSONB;
  v_new_val   JSONB;
  v_record_id UUID;
  v_org_id    UUID;
  v_changed_by UUID;
BEGIN
  v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;

  IF TG_OP = 'UPDATE' THEN
    v_old_json := to_jsonb(OLD);
    FOR v_key IN SELECT key FROM jsonb_each(to_jsonb(NEW)) LOOP
      v_old_val := v_old_json -> v_key;
      v_new_val := to_jsonb(NEW) -> v_key;
      IF v_new_val IS DISTINCT FROM v_old_val THEN
        v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('old', v_old_val, 'new', v_new_val));
      END IF;
    END LOOP;
    IF v_diff = '{}'::jsonb THEN RETURN NEW; END IF;
    v_record_id := (to_jsonb(NEW) ->> 'id')::uuid;
    v_org_id    := NULLIF(to_jsonb(NEW) ->> 'org_id', '')::uuid;
    INSERT INTO audit.audit_log (table_name, operation, record_id, org_id, changed_by, changed_fields, old_data, new_data)
    VALUES (TG_TABLE_NAME, 'U', v_record_id, v_org_id, v_changed_by, v_diff, v_old_json, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_json  := to_jsonb(OLD);
    v_record_id := (v_old_json ->> 'id')::uuid;
    v_org_id    := NULLIF(v_old_json ->> 'org_id', '')::uuid;
    INSERT INTO audit.audit_log (table_name, operation, record_id, org_id, changed_by, changed_fields, old_data)
    VALUES (TG_TABLE_NAME, 'D', v_record_id, v_org_id, v_changed_by, v_old_json, v_old_json);
    RETURN OLD;
  END IF;
  RETURN NULL;
END; $$;

-- Prevent duplicate active leads per org on phone and email.
-- Partial indexes: enforced only for active, non-deleted rows.
-- is_active = true ensures superseded rows can share the same phone/email.
CREATE UNIQUE INDEX IF NOT EXISTS uix_marketing_leads_org_phone
  ON lms.marketing_leads (org_id, phone)
  WHERE phone IS NOT NULL AND NOT is_deleted AND is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uix_marketing_leads_org_email
  ON lms.marketing_leads (org_id, email)
  WHERE email IS NOT NULL AND NOT is_deleted AND is_active = true;

-- ===================================================================
-- META CONVERSION API — Tables for bidirectional Meta Lead Ads integration
-- Inbound:  Meta webhook → lms.marketing_leads + ext.meta_leads
-- Outbound: CRM stage changes → Meta CAPI conversion events
-- ===================================================================


-- ── META_ORG_CONFIG (removed) ──────────────────────────────────────
-- Superseded by ext.meta_tenant_config + ext.meta_page_form_org_map below:
-- one Meta App/Business Manager is registered per TENANT (not per org), and
-- individual orgs/branches are attributed via their Page+Form combination,
-- since a single tenant-level app can have many orgs' Pages/Forms behind it.
DROP TABLE IF EXISTS ext.meta_org_config CASCADE;

-- ── META_TENANT_CONFIG: per-tenant Meta app credentials + CAPI config ─
-- tenant_id is nullable to support ONE additional row shared across
-- MULTIPLE tenants (a single Meta App/Business Manager receiving leads
-- for more than one tenant). That row's webhook callback URL omits the
-- integration id (POST /meta/webhook instead of /meta/webhook/:integrationId);
-- tenant AND org are then both resolved from ext.meta_page_form_org_map via
-- page_id/form_id, which is already globally unique
-- (uq_meta_page_form_org_map UNIQUE (page_id, form_id)).
-- Per-tenant rows (tenant_id NOT NULL) are unaffected and work as before.
CREATE TABLE IF NOT EXISTS ext.meta_tenant_config (
  id                 UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id          UUID        REFERENCES entity.tenants(id),
  app_secret         TEXT        NOT NULL,
  verify_token       TEXT        NOT NULL,
  pixel_id           TEXT        NOT NULL,
  access_token       TEXT        NOT NULL,
  graph_api_version  TEXT        NOT NULL DEFAULT 'v21.0',
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  capi_trigger_stages UUID[]     NOT NULL DEFAULT '{}',
  field_mappings     JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_tenant_config_tenant UNIQUE (tenant_id)
);

-- At most one shared-app row (tenant_id IS NULL) may exist at a time.
-- uq_meta_tenant_config_tenant above already allows multiple NULLs
-- (Postgres treats NULLs as distinct in a plain UNIQUE constraint), so it
-- does not enforce this on its own.
CREATE UNIQUE INDEX IF NOT EXISTS uix_meta_tenant_config_one_shared
  ON ext.meta_tenant_config ((true))
  WHERE tenant_id IS NULL;

ALTER TABLE ext.meta_tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_tenant_config FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_tenant_config;

-- Tenant-level credentials are managed by tenant_admin only — no app_user
-- policy, since an individual org/branch never owns the shared app config.
-- NOTE: this policy only matches rows where tenant_id equals the caller's
-- session tenant_id, so the shared row (tenant_id IS NULL) never matches
-- any tenant_admin session and is invisible to every tenant's admin UI —
-- intentional, since a cross-tenant app config must not be editable from a
-- single tenant's admin UI. It can only be managed by root_service
-- (bypasses RLS), i.e. DB-only / direct SQL for now.
CREATE POLICY tenant_isolation_policy ON ext.meta_tenant_config
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ── META_PAGE_FORM_ORG_MAP: Page+Form -> org attribution ──────────
-- A Meta lead form always belongs to exactly one Page, but a single Page can
-- run many forms across different campaigns/purposes, and those forms are not
-- guaranteed to belong to the same org (e.g. a shared/corporate Page running
-- location-specific forms). form_id is therefore the authoritative routing
-- key (globally unique in Meta's system); page_id is retained for reference,
-- validation, and to auto-attribute newly created forms on a known Page.
CREATE TABLE IF NOT EXISTS ext.meta_page_form_org_map (
  id          UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id   UUID        NOT NULL REFERENCES entity.tenants(id),
  org_id      UUID        NOT NULL REFERENCES entity.organizations(id),
  page_id     BIGINT      NOT NULL,
  form_id     BIGINT      NOT NULL,
  platform    TEXT        NOT NULL CHECK (platform IN ('fb', 'ig')),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  -- Recorded by sync_leads.py after each pull run against a form, for
  -- observability/reporting (Meta's /{form-id}/leads edge does not
  -- reliably support server-side "since" filtering, so this is not used
  -- as a query filter — dedup on ext.meta_leads.meta_lead_id is the real
  -- cursor).
  last_synced_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_page_form_org_map UNIQUE (page_id, form_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_page_form_org_map_org    ON ext.meta_page_form_org_map (org_id);
CREATE INDEX IF NOT EXISTS idx_meta_page_form_org_map_tenant ON ext.meta_page_form_org_map (tenant_id);
CREATE INDEX IF NOT EXISTS idx_meta_page_form_org_map_page   ON ext.meta_page_form_org_map (page_id);

ALTER TABLE ext.meta_page_form_org_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_page_form_org_map FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_page_form_org_map;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_page_form_org_map;

CREATE POLICY org_isolation_policy ON ext.meta_page_form_org_map
  FOR ALL TO app_user
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_page_form_org_map
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_FORMS: cache of discovered Lead Ads forms per tenant/page ─────
-- Populated by sync_forms.py. Lets an admin see which forms exist on Meta
-- vs. which ones already have an org mapping in ext.meta_page_form_org_map.
CREATE TABLE IF NOT EXISTS ext.meta_forms (
  id                 UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id          UUID        NOT NULL REFERENCES entity.tenants(id),
  page_id            BIGINT      NOT NULL,
  form_id            BIGINT      NOT NULL,
  name               TEXT,
  status             TEXT,
  leads_count        INT,
  meta_created_time  TIMESTAMPTZ,
  last_synced_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_forms_form_id UNIQUE (form_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_forms_tenant ON ext.meta_forms (tenant_id);
CREATE INDEX IF NOT EXISTS idx_meta_forms_page   ON ext.meta_forms (page_id);

DROP TRIGGER IF EXISTS trg_meta_forms_updated_at ON ext.meta_forms;
CREATE TRIGGER trg_meta_forms_updated_at
  BEFORE UPDATE ON ext.meta_forms FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE ext.meta_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_forms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_forms;

-- Forms exist independently of (and prior to) org attribution, same
-- reasoning as ext.meta_tenant_config: managed by tenant_admin only, no
-- app_user policy.
CREATE POLICY tenant_isolation_policy ON ext.meta_forms
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE OR REPLACE VIEW ext.vw_meta_forms
  WITH (security_invoker = true)
AS
  SELECT
    f.id, f.tenant_id, f.page_id, f.form_id, f.name, f.status, f.leads_count,
    f.meta_created_time, f.last_synced_at, f.created_at, f.updated_at,
    m.org_id,
    (m.id IS NOT NULL) AS is_mapped
  FROM ext.meta_forms f
  LEFT JOIN ext.meta_page_form_org_map m
    ON m.form_id = f.form_id AND m.tenant_id = f.tenant_id AND m.is_active;

-- ── META_LEADS: raw Meta lead data linked to lms.marketing_leads ──────
CREATE TABLE IF NOT EXISTS ext.meta_leads (
  id                 UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id             UUID        NOT NULL REFERENCES entity.organizations(id),
  marketing_lead_id  UUID        REFERENCES lms.marketing_leads(id) ON DELETE SET NULL,
  meta_lead_id       BIGINT      NOT NULL,
  page_id            BIGINT,
  form_id            BIGINT      NOT NULL,
  campaign_id        BIGINT,
  adset_id           BIGINT,
  ad_id              BIGINT,
  platform           TEXT        CHECK (platform IN ('fb', 'ig')),
  lead_created_at    TIMESTAMPTZ NOT NULL,
  full_name          TEXT,
  first_name         TEXT,
  last_name          TEXT,
  email              TEXT,
  phone              TEXT,
  whatsapp_number    TEXT,
  raw_field_data     JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_leads_meta_lead_id UNIQUE (meta_lead_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_leads_org          ON ext.meta_leads (org_id);
CREATE INDEX IF NOT EXISTS idx_meta_leads_form         ON ext.meta_leads (form_id);
CREATE INDEX IF NOT EXISTS idx_meta_leads_campaign     ON ext.meta_leads (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_leads_mktg_lead    ON ext.meta_leads (marketing_lead_id) WHERE marketing_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_leads_created      ON ext.meta_leads (created_at DESC);

ALTER TABLE ext.meta_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_leads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_leads;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_leads;

CREATE POLICY org_isolation_policy ON ext.meta_leads
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_leads
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_LEAD_CUSTOM_FIELDS: unmapped form fields (1:many) ────────
CREATE TABLE IF NOT EXISTS ext.meta_lead_custom_fields (
  id                 UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  meta_lead_id       UUID        NOT NULL REFERENCES ext.meta_leads(id) ON DELETE CASCADE,
  org_id             UUID        NOT NULL REFERENCES entity.organizations(id),
  question_key       TEXT        NOT NULL,
  question_value     TEXT,
  CONSTRAINT uq_meta_custom_field UNIQUE (meta_lead_id, question_key)
);

ALTER TABLE ext.meta_lead_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_lead_custom_fields FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_lead_custom_fields;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_lead_custom_fields;

CREATE POLICY org_isolation_policy ON ext.meta_lead_custom_fields
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_lead_custom_fields
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_CAPI_OUTBOUND_LOGS: CAPI event audit trail ──────────────
CREATE TABLE IF NOT EXISTS ext.meta_capi_outbound_logs (
  id                   UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id               UUID        NOT NULL REFERENCES entity.organizations(id),
  marketing_lead_id    UUID        NOT NULL REFERENCES lms.marketing_leads(id),
  meta_lead_id         UUID        REFERENCES ext.meta_leads(id) ON DELETE SET NULL,
  event_name           TEXT        NOT NULL,
  event_id             TEXT        NOT NULL,
  delivery_status      TEXT        NOT NULL CHECK (delivery_status IN ('SUCCESS', 'FAILED', 'PENDING')),
  fb_trace_id          TEXT,
  request_payload      JSONB       NOT NULL,
  response_payload     JSONB,
  triggered_by         TEXT        NOT NULL CHECK (triggered_by IN ('auto_stage_change', 'manual')),
  triggered_by_user_id UUID,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capi_logs_org           ON ext.meta_capi_outbound_logs (org_id);
CREATE INDEX IF NOT EXISTS idx_capi_logs_lead          ON ext.meta_capi_outbound_logs (marketing_lead_id);
CREATE INDEX IF NOT EXISTS idx_capi_logs_sent          ON ext.meta_capi_outbound_logs (sent_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uix_capi_logs_lead_event_success
  ON ext.meta_capi_outbound_logs (marketing_lead_id, event_name)
  WHERE delivery_status = 'SUCCESS';

ALTER TABLE ext.meta_capi_outbound_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_capi_outbound_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_capi_outbound_logs;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_capi_outbound_logs;

CREATE POLICY org_isolation_policy ON ext.meta_capi_outbound_logs
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_capi_outbound_logs
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_CAPI_EVENT_TYPES: lookup of supported Meta CAPI event names ──
CREATE TABLE IF NOT EXISTS ext.meta_capi_event_types (
  id          SMALLINT     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL,
  label       VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_meta_capi_event_types_code UNIQUE (code)
);

DROP TRIGGER IF EXISTS trg_meta_capi_event_types_updated_at ON ext.meta_capi_event_types;
CREATE TRIGGER trg_meta_capi_event_types_updated_at
  BEFORE UPDATE ON ext.meta_capi_event_types FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── LEAD_STAGE_CAPI_EVENT_MAP: lms.lead_stage -> Meta CAPI event fired on transition ──
-- Global mapping (no org_id), mirroring lms.lead_stage itself being a shared
-- lookup table. Joined by stage_id (UUID), never by stage name text — a stage
-- with no row here simply does not fire a CAPI event on transition.
CREATE TABLE IF NOT EXISTS ext.lead_stage_capi_event_map (
  id                 UUID        PRIMARY KEY DEFAULT public.gen_uuidv7(),
  stage_id           UUID        NOT NULL UNIQUE REFERENCES lms.lead_stage(id) ON DELETE CASCADE,
  capi_event_type_id SMALLINT    NOT NULL REFERENCES ext.meta_capi_event_types(id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_stage_capi_event_map_event_type
  ON ext.lead_stage_capi_event_map (capi_event_type_id);

DROP TRIGGER IF EXISTS trg_lead_stage_capi_event_map_updated_at ON ext.lead_stage_capi_event_map;
CREATE TRIGGER trg_lead_stage_capi_event_map_updated_at
  BEFORE UPDATE ON ext.lead_stage_capi_event_map FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE VIEW ext.vw_meta_capi_event_types AS
SELECT id, code, label, description, is_active, sort_order
FROM ext.meta_capi_event_types
WHERE is_active = TRUE
ORDER BY sort_order, label;

CREATE OR REPLACE VIEW ext.vw_lead_stage_capi_event_map AS
SELECT
  m.id,
  m.stage_id,
  ls.name  AS stage_code,
  ls.label AS stage_label,
  m.capi_event_type_id,
  et.code  AS capi_event_code,
  et.label AS capi_event_label,
  m.created_at,
  m.updated_at
FROM ext.lead_stage_capi_event_map m
JOIN lms.lead_stage ls            ON ls.id = m.stage_id
JOIN ext.meta_capi_event_types et ON et.id = m.capi_event_type_id;

-- ── META_LEAD_ADDRESSES: address fields from Meta lead forms (1:1) ────
CREATE TABLE IF NOT EXISTS ext.meta_lead_addresses (
  meta_lead_id    UUID        PRIMARY KEY REFERENCES ext.meta_leads(id) ON DELETE CASCADE,
  org_id          UUID        NOT NULL REFERENCES entity.organizations(id),
  street_address  TEXT,
  city            TEXT,
  state           TEXT,
  province        TEXT,
  country         TEXT,
  postal_code     TEXT,
  zip_code        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_addresses_org ON ext.meta_lead_addresses (org_id);

ALTER TABLE ext.meta_lead_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_lead_addresses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_lead_addresses;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_lead_addresses;

CREATE POLICY org_isolation_policy ON ext.meta_lead_addresses
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_lead_addresses
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_LEAD_PROFESSIONAL: job/company fields from Meta lead forms (1:1) ─
CREATE TABLE IF NOT EXISTS ext.meta_lead_professional (
  meta_lead_id      UUID        PRIMARY KEY REFERENCES ext.meta_leads(id) ON DELETE CASCADE,
  org_id            UUID        NOT NULL REFERENCES entity.organizations(id),
  job_title         TEXT,
  company_name      TEXT,
  work_email        TEXT,
  work_phone_number TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_professional_org ON ext.meta_lead_professional (org_id);

ALTER TABLE ext.meta_lead_professional ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_lead_professional FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_lead_professional;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_lead_professional;

CREATE POLICY org_isolation_policy ON ext.meta_lead_professional
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_lead_professional
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── META_LEAD_DEMOGRAPHICS: demographic fields from Meta lead forms (1:1) ─
CREATE TABLE IF NOT EXISTS ext.meta_lead_demographics (
  meta_lead_id         UUID        PRIMARY KEY REFERENCES ext.meta_leads(id) ON DELETE CASCADE,
  org_id               UUID        NOT NULL REFERENCES entity.organizations(id),
  date_of_birth        DATE,
  gender               TEXT,
  marital_status       TEXT,
  relationship_status  TEXT,
  military_status      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_demographics_org ON ext.meta_lead_demographics (org_id);

ALTER TABLE ext.meta_lead_demographics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.meta_lead_demographics FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_policy    ON ext.meta_lead_demographics;
DROP POLICY IF EXISTS tenant_isolation_policy ON ext.meta_lead_demographics;

CREATE POLICY org_isolation_policy ON ext.meta_lead_demographics
  FOR ALL TO app_user
  USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_policy ON ext.meta_lead_demographics
  AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ))
  WITH CHECK (org_id IN (
    SELECT id FROM entity.organizations
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  ));

-- ── VIEW: complete meta leads joined to lms.marketing_leads + address/professional/demographics ─
CREATE OR REPLACE VIEW ext.view_meta_leads_complete
  WITH (security_invoker = true)
AS
  SELECT ml.id, ml.org_id, ml.marketing_lead_id, ml.meta_lead_id,
         ml.page_id, ml.form_id, ml.campaign_id AS meta_campaign_id,
         ml.adset_id, ml.ad_id, ml.platform,
         ml.lead_created_at AS meta_created_at,
         ml.full_name AS meta_full_name, ml.email AS meta_email,
         ml.phone AS meta_phone, ml.whatsapp_number,
         ml.raw_field_data,
         mk.first_name, mk.last_name, mk.phone AS crm_phone, mk.email AS crm_email,
         mk.stage_id, mk.outcome_id, mk.assigned_user_id, mk.campaign_id AS crm_campaign_id,
         mk.created_at AS crm_created_at,
         addr.street_address, addr.city, addr.state, addr.province,
         addr.country, addr.postal_code, addr.zip_code,
         prof.job_title, prof.company_name, prof.work_email, prof.work_phone_number,
         demo.date_of_birth, demo.gender, demo.marital_status,
         demo.relationship_status, demo.military_status
  FROM ext.meta_leads ml
  LEFT JOIN lms.marketing_leads mk         ON ml.marketing_lead_id = mk.id
  LEFT JOIN ext.meta_lead_addresses addr   ON addr.meta_lead_id = ml.id
  LEFT JOIN ext.meta_lead_professional prof ON prof.meta_lead_id = ml.id
  LEFT JOIN ext.meta_lead_demographics demo ON demo.meta_lead_id = ml.id;

-- ── Grants for Meta tables ────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON ext.meta_tenant_config      TO tenant_admin;
GRANT SELECT, INSERT, UPDATE ON ext.meta_page_form_org_map  TO tenant_admin;
GRANT SELECT, INSERT         ON ext.meta_page_form_org_map  TO app_user;
GRANT SELECT, INSERT, UPDATE ON ext.meta_forms              TO tenant_admin;
GRANT SELECT                 ON ext.vw_meta_forms           TO tenant_admin;
GRANT SELECT, INSERT, UPDATE ON ext.meta_leads               TO app_user;
GRANT SELECT, INSERT         ON ext.meta_lead_custom_fields   TO app_user;
GRANT SELECT, INSERT         ON ext.meta_capi_outbound_logs   TO app_user;
GRANT SELECT, INSERT         ON ext.meta_lead_addresses       TO app_user;
GRANT SELECT, INSERT         ON ext.meta_lead_professional    TO app_user;
GRANT SELECT, INSERT         ON ext.meta_lead_demographics    TO app_user;
GRANT SELECT                 ON ext.view_meta_leads_complete   TO app_user;
GRANT SELECT                       ON ext.meta_capi_event_types        TO app_user;
GRANT SELECT, INSERT, UPDATE       ON ext.lead_stage_capi_event_map    TO app_user;
GRANT SELECT                       ON ext.vw_meta_capi_event_types     TO app_user;
GRANT SELECT                       ON ext.vw_lead_stage_capi_event_map TO app_user;

GRANT ALL PRIVILEGES ON ext.meta_tenant_config       TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_page_form_org_map   TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_forms               TO root_service;
GRANT SELECT         ON ext.vw_meta_forms            TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_leads               TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_lead_custom_fields  TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_capi_outbound_logs  TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_lead_addresses      TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_lead_professional   TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_lead_demographics   TO root_service;
GRANT SELECT         ON ext.view_meta_leads_complete  TO root_service;
GRANT ALL PRIVILEGES ON ext.meta_capi_event_types     TO root_service;
GRANT ALL PRIVILEGES ON ext.lead_stage_capi_event_map TO root_service;
GRANT SELECT ON ext.vw_meta_capi_event_types     TO root_service;
GRANT SELECT ON ext.vw_lead_stage_capi_event_map TO root_service;

-- ── meta_svc login role ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meta_svc') THEN
    CREATE ROLE meta_svc WITH LOGIN PASSWORD 'MetaSvc_Dev2025' NOINHERIT;
  ELSE ALTER ROLE meta_svc WITH LOGIN PASSWORD 'MetaSvc_Dev2025' NOINHERIT; END IF;
END; $$;
GRANT app_user TO meta_svc;

GRANT USAGE ON SCHEMA public TO meta_svc;
GRANT USAGE ON SCHEMA ext    TO meta_svc;
GRANT USAGE ON SCHEMA lms    TO meta_svc;
GRANT USAGE ON SCHEMA iam    TO meta_svc;
GRANT USAGE ON SCHEMA entity TO meta_svc;
DO $$
DECLARE v_db TEXT := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO meta_svc', v_db);
END; $$;
