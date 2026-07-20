-- ===================================================================
-- CRM Monorepo — Leave Management (Phase 1, DB layer)
-- Adds the complete hr.* leave-management model:
--   holiday_calendars / holidays, leave_policies, hr_settings,
--   leave_ledger (append-only), leave_requests (+ status log),
--   leave_request_approvals, hr.can_approve_leave(), and the
--   dashboard views (vw_leave_balances / vw_leave_requests_enriched /
--   vw_team_leave_calendar).
-- Prerequisite: 01_init-db.sql + 01_init-lookup-data.sql + 10_init-hr-task-schemas.sql
--               (hr schema, hr_svc role, HR lookups, employee_profiles).
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING /
--             guarded DO blocks / DROP+CREATE for triggers & policies).
-- Style, guard patterns, trigger recipe and RLS mirror db_scripts/01 and 10.
-- Operational tables use the marketing.ad_campaigns recipe; append-only logs
-- (leave_ledger, leave_request_status_log) mirror lms.lead_status_log.
-- No existing table, trigger or policy is modified except the note below:
--   hr.leave_ledger.leave_request_id FK depends on hr.leave_requests, so
--   leave_requests DDL is emitted before leave_ledger.
-- ===================================================================


-- ── Extensions ─────────────────────────────────────────────────────
-- btree_gist lets an exclusion constraint mix equality (user_id) with a
-- range overlap (daterange) — used for the no-overlapping-leave guard.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ===================================================================
-- 1. hr.holiday_calendars — org-scoped operational table
--    Standard recipe (marketing.ad_campaigns): UUIDv7 PK, org_id FK,
--    soft-delete + audit, set_updated_at / soft_delete_row / set_org_id /
--    set_created_by / audit_row_changes triggers, org + tenant RLS.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.holiday_calendars (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  year        INT     NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_holiday_calendars_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_holiday_calendars_updated_at        ON hr.holiday_calendars;
CREATE TRIGGER trg_holiday_calendars_updated_at
  BEFORE UPDATE ON hr.holiday_calendars FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_holiday_calendars_soft_delete       ON hr.holiday_calendars;
CREATE TRIGGER trg_holiday_calendars_soft_delete
  BEFORE DELETE ON hr.holiday_calendars FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_holiday_calendars_set_org_id     ON hr.holiday_calendars;
CREATE TRIGGER trg_00_holiday_calendars_set_org_id
  BEFORE INSERT ON hr.holiday_calendars FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_holiday_calendars_set_created_by ON hr.holiday_calendars;
CREATE TRIGGER trg_01_holiday_calendars_set_created_by
  BEFORE INSERT ON hr.holiday_calendars FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_holiday_calendars_audit             ON hr.holiday_calendars;
CREATE TRIGGER trg_holiday_calendars_audit
  AFTER UPDATE OR DELETE ON hr.holiday_calendars FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_holiday_calendars_org
  ON hr.holiday_calendars (org_id) WHERE NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uix_holiday_calendars_org_name_year
  ON hr.holiday_calendars (org_id, name, year) WHERE NOT is_deleted;

ALTER TABLE hr.holiday_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.holiday_calendars FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.holiday_calendars;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.holiday_calendars;
CREATE POLICY org_isolation_policy ON hr.holiday_calendars AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.holiday_calendars AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.holiday_calendars TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.holiday_calendars TO tenant_admin;
REVOKE DELETE                ON hr.holiday_calendars FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.holiday_calendars TO root_service;


-- ── hr.holidays ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr.holidays (
  id            UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  calendar_id   UUID    NOT NULL REFERENCES hr.holiday_calendars(id) ON DELETE CASCADE,
  org_id        UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  holiday_date  DATE    NOT NULL,
  name          TEXT    NOT NULL,
  is_optional   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_holidays_active_deleted CHECK (NOT (is_active AND is_deleted)),
  CONSTRAINT uq_holidays_calendar_date   UNIQUE (calendar_id, holiday_date)
);

DROP TRIGGER IF EXISTS trg_holidays_updated_at        ON hr.holidays;
CREATE TRIGGER trg_holidays_updated_at
  BEFORE UPDATE ON hr.holidays FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_holidays_soft_delete       ON hr.holidays;
CREATE TRIGGER trg_holidays_soft_delete
  BEFORE DELETE ON hr.holidays FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_holidays_set_org_id     ON hr.holidays;
CREATE TRIGGER trg_00_holidays_set_org_id
  BEFORE INSERT ON hr.holidays FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_holidays_set_created_by ON hr.holidays;
CREATE TRIGGER trg_01_holidays_set_created_by
  BEFORE INSERT ON hr.holidays FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_holidays_audit             ON hr.holidays;
CREATE TRIGGER trg_holidays_audit
  AFTER UPDATE OR DELETE ON hr.holidays FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_holidays_calendar
  ON hr.holidays (calendar_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_holidays_org_date
  ON hr.holidays (org_id, holiday_date) WHERE NOT is_deleted;

ALTER TABLE hr.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.holidays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.holidays;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.holidays;
CREATE POLICY org_isolation_policy ON hr.holidays AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.holidays AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.holidays TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.holidays TO tenant_admin;
REVOKE DELETE                ON hr.holidays FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.holidays TO root_service;


-- ===================================================================
-- 2. hr.leave_policies — per (tenant, org?, leave_type) rules (§4.2)
--    org_id NULL = tenant-wide default; an org row overrides it. Effective-
--    dated by applicable_from (new row per revision, never mutate history).
--    Writes are restricted to the tenant_admin RLS role; the app layer will
--    ALSO gate policy management to hr_admin / org_admin via serviceDb.
--    NB: no set_org_id trigger — org_id is intentionally nullable here.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.leave_policies (
  id                            UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id                     UUID    NOT NULL REFERENCES entity.tenants(id)       ON DELETE CASCADE,
  org_id                        UUID    REFERENCES entity.organizations(id)          ON DELETE CASCADE,
  leave_type_id                 UUID    NOT NULL REFERENCES hr.leave_types(id)       ON DELETE RESTRICT,
  accrual_frequency             TEXT    NOT NULL DEFAULT 'none'
                                          CHECK (accrual_frequency IN ('monthly','quarterly','yearly','none')),
  accrual_amount                NUMERIC(5,2) NOT NULL DEFAULT 0,
  max_balance                   NUMERIC(5,2),
  carry_forward                 BOOLEAN NOT NULL DEFAULT FALSE,
  max_carry_forward             NUMERIC(5,2),
  max_consecutive_days          SMALLINT,
  min_notice_days               SMALLINT NOT NULL DEFAULT 0,
  allow_half_day                BOOLEAN NOT NULL DEFAULT TRUE,
  requires_document_after_days  SMALLINT,
  -- Approval depth: any value >= 1. The approver chain walks manager_id upward
  -- N levels; a chain shorter than N terminates at the highest available
  -- manager (org_admin / hr_admin fallback). See Platform_Expansion_Plan §4.2.
  approval_levels               SMALLINT NOT NULL DEFAULT 1 CHECK (approval_levels >= 1),
  applicable_from               DATE    NOT NULL,
  is_active                     BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted                    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at                    TIMESTAMPTZ,
  deleted_by                    UUID,
  created_by                    UUID,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_leave_policies_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_leave_policies_updated_at        ON hr.leave_policies;
CREATE TRIGGER trg_leave_policies_updated_at
  BEFORE UPDATE ON hr.leave_policies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leave_policies_soft_delete       ON hr.leave_policies;
CREATE TRIGGER trg_leave_policies_soft_delete
  BEFORE DELETE ON hr.leave_policies FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_01_leave_policies_set_created_by  ON hr.leave_policies;
CREATE TRIGGER trg_01_leave_policies_set_created_by
  BEFORE INSERT ON hr.leave_policies FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_leave_policies_audit             ON hr.leave_policies;
CREATE TRIGGER trg_leave_policies_audit
  AFTER UPDATE OR DELETE ON hr.leave_policies FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_leave_policies_tenant
  ON hr.leave_policies (tenant_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_leave_policies_org
  ON hr.leave_policies (org_id) WHERE org_id IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_leave_policies_leave_type
  ON hr.leave_policies (leave_type_id) WHERE NOT is_deleted;

-- One effective-dated policy row per (tenant, org|tenant-wide, leave_type,
-- applicable_from). COALESCE folds the tenant-wide NULL org into the zero-uuid
-- so a tenant default and an org override never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uix_leave_policies_scope_type_from
  ON hr.leave_policies (
    tenant_id,
    COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    leave_type_id,
    applicable_from
  ) WHERE NOT is_deleted;

ALTER TABLE hr.leave_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_policies;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_policies;

-- app_user: SELECT-only. Any user in the tenant may read the tenant's policies
-- (tenant resolved from their current org, mirroring entity.tenant_modules).
CREATE POLICY org_isolation_policy ON hr.leave_policies AS PERMISSIVE FOR SELECT TO app_user
  USING (
    NOT is_deleted
    AND tenant_id = (
      SELECT tenant_id FROM entity.organizations
      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );

-- tenant_admin: full DML within their tenant. hr_admin / org_admin are gated at
-- the app layer via serviceDb (they connect as app_user, which is read-only here).
CREATE POLICY tenant_isolation_policy ON hr.leave_policies AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted);

GRANT SELECT                 ON hr.leave_policies TO app_user;
REVOKE INSERT, UPDATE, DELETE ON hr.leave_policies FROM app_user;
GRANT SELECT, INSERT, UPDATE ON hr.leave_policies TO tenant_admin;
REVOKE DELETE                ON hr.leave_policies FROM tenant_admin;
GRANT ALL PRIVILEGES         ON hr.leave_policies TO root_service;


-- ===================================================================
-- 2b. hr.hr_settings — leave-cycle configuration (§4.2)
--     tenant-wide default (org_id NULL), org row overrides. Read by every
--     app_user in the tenant; written via the service path.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.hr_settings (
  id                       UUID     PRIMARY KEY DEFAULT public.gen_uuidv7(),
  tenant_id                UUID     NOT NULL REFERENCES entity.tenants(id)        ON DELETE CASCADE,
  org_id                   UUID     REFERENCES entity.organizations(id)           ON DELETE CASCADE,
  -- 4 = April–March financial year (India FY default)
  leave_cycle_start_month  SMALLINT NOT NULL DEFAULT 4
                                      CHECK (leave_cycle_start_month BETWEEN 1 AND 12),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_hr_settings_updated_at ON hr.hr_settings;
CREATE TRIGGER trg_hr_settings_updated_at
  BEFORE UPDATE ON hr.hr_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS uix_hr_settings_scope
  ON hr.hr_settings (
    tenant_id,
    COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE hr.hr_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.hr_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.hr_settings;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.hr_settings;

CREATE POLICY org_isolation_policy ON hr.hr_settings AS PERMISSIVE FOR SELECT TO app_user
  USING (
    tenant_id = (
      SELECT tenant_id FROM entity.organizations
      WHERE id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
  );

CREATE POLICY tenant_isolation_policy ON hr.hr_settings AS PERMISSIVE FOR ALL TO tenant_admin
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid);

GRANT SELECT                 ON hr.hr_settings TO app_user;
REVOKE INSERT, UPDATE, DELETE ON hr.hr_settings FROM app_user;
GRANT SELECT, INSERT, UPDATE ON hr.hr_settings TO tenant_admin;
REVOKE DELETE                ON hr.hr_settings FROM tenant_admin;
GRANT ALL PRIVILEGES         ON hr.hr_settings TO root_service;

-- Seed one tenant-wide default row (month 4) per existing tenant.
INSERT INTO hr.hr_settings (tenant_id, org_id, leave_cycle_start_month)
SELECT id, NULL, 4 FROM entity.tenants
ON CONFLICT DO NOTHING;


-- ===================================================================
-- 4. hr.leave_requests — emitted BEFORE hr.leave_ledger because the ledger's
--    leave_request_id FK references this table (§3 note). Standard operational
--    recipe + a self policy (users always see & insert their own requests) +
--    an is_open exclusion guard against overlapping active requests.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.leave_requests (
  id            UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id       UUID    NOT NULL REFERENCES iam.users(id)                   ON DELETE RESTRICT,
  org_id        UUID    NOT NULL REFERENCES entity.organizations(id)        ON DELETE RESTRICT,
  leave_type_id UUID    NOT NULL REFERENCES hr.leave_types(id)              ON DELETE RESTRICT,
  start_date    DATE    NOT NULL,
  end_date      DATE    NOT NULL,
  start_half    TEXT    NOT NULL DEFAULT 'full'
                          CHECK (start_half IN ('full','first_half','second_half')),
  end_half      TEXT    NOT NULL DEFAULT 'full'
                          CHECK (end_half IN ('full','first_half','second_half')),
  days_count    NUMERIC(5,2) NOT NULL CHECK (days_count > 0),
  reason        TEXT,
  status_id     UUID    NOT NULL REFERENCES hr.leave_request_statuses(id)   ON DELETE RESTRICT,
  document_url  TEXT,
  -- Maintained by trigger from status_id: TRUE while pending/approved, else
  -- FALSE. Drives the overlap exclusion constraint below.
  is_open       BOOLEAN NOT NULL DEFAULT TRUE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_leave_requests_active_deleted CHECK (NOT (is_active AND is_deleted)),
  CONSTRAINT chk_leave_requests_date_order     CHECK (end_date >= start_date),
  -- No two OPEN (pending/approved), non-deleted requests for the same user may
  -- have overlapping inclusive date ranges.
  CONSTRAINT excl_leave_requests_no_overlap
    EXCLUDE USING gist (
      user_id WITH =,
      daterange(start_date, end_date, '[]') WITH &&
    ) WHERE (is_open AND NOT is_deleted)
);

-- Maintain is_open from the resolved status name (pending/approved => TRUE).
CREATE OR REPLACE FUNCTION hr.set_leave_request_is_open()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT name INTO v_status FROM hr.leave_request_statuses WHERE id = NEW.status_id;
  NEW.is_open := (v_status IN ('pending','approved'));
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_00_leave_requests_set_org_id      ON hr.leave_requests;
CREATE TRIGGER trg_00_leave_requests_set_org_id
  BEFORE INSERT ON hr.leave_requests FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_leave_requests_set_created_by  ON hr.leave_requests;
CREATE TRIGGER trg_01_leave_requests_set_created_by
  BEFORE INSERT ON hr.leave_requests FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_02_leave_requests_set_is_open     ON hr.leave_requests;
CREATE TRIGGER trg_02_leave_requests_set_is_open
  BEFORE INSERT OR UPDATE OF status_id ON hr.leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr.set_leave_request_is_open();

DROP TRIGGER IF EXISTS trg_leave_requests_updated_at         ON hr.leave_requests;
CREATE TRIGGER trg_leave_requests_updated_at
  BEFORE UPDATE ON hr.leave_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leave_requests_soft_delete        ON hr.leave_requests;
CREATE TRIGGER trg_leave_requests_soft_delete
  BEFORE DELETE ON hr.leave_requests FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_leave_requests_audit              ON hr.leave_requests;
CREATE TRIGGER trg_leave_requests_audit
  AFTER UPDATE OR DELETE ON hr.leave_requests FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_leave_requests_user
  ON hr.leave_requests (user_id, start_date DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_status
  ON hr.leave_requests (org_id, status_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_leave_requests_leave_type
  ON hr.leave_requests (leave_type_id) WHERE NOT is_deleted;

ALTER TABLE hr.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_requests;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_requests;
DROP POLICY IF EXISTS self_policy             ON hr.leave_requests;

CREATE POLICY org_isolation_policy ON hr.leave_requests AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.leave_requests AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

-- Self policy: a user can always see and insert their own requests, regardless
-- of the org currently in context. PERMISSIVE → OR-combined with org policy.
CREATE POLICY self_policy ON hr.leave_requests AS PERMISSIVE FOR ALL TO app_user
  USING      (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.leave_requests TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.leave_requests TO tenant_admin;
REVOKE DELETE                ON hr.leave_requests FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.leave_requests TO root_service;


-- ── hr.leave_request_status_log — append-only (mirrors lms.lead_status_log) ──
CREATE TABLE IF NOT EXISTS hr.leave_request_status_log (
  id             UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id         UUID    NOT NULL REFERENCES entity.organizations(id)     ON DELETE RESTRICT,
  request_id     UUID    NOT NULL REFERENCES hr.leave_requests(id)        ON DELETE CASCADE,
  changed_by_id  UUID    REFERENCES iam.users(id)                         ON DELETE SET NULL,
  old_status_id  UUID    REFERENCES hr.leave_request_statuses(id)         ON DELETE RESTRICT,
  new_status_id  UUID    NOT NULL REFERENCES hr.leave_request_statuses(id) ON DELETE RESTRICT,
  note           TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_leave_request_status_log_request
  ON hr.leave_request_status_log (org_id, request_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_leave_request_status_log_org_changed
  ON hr.leave_request_status_log (org_id, changed_at DESC);

-- Status-transition log writer. SECURITY DEFINER: app_user has no INSERT on the
-- log. note is read from app.leave_transition_note session GUC set by the API.
CREATE OR REPLACE FUNCTION hr.log_leave_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_changed_by UUID;
  v_note       TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN
    RETURN NEW;
  END IF;
  BEGIN
    v_changed_by := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_changed_by := NULL; END;
  BEGIN
    v_note := NULLIF(current_setting('app.leave_transition_note', true), '');
  EXCEPTION WHEN OTHERS THEN v_note := NULL; END;

  INSERT INTO hr.leave_request_status_log (
    org_id, request_id, old_status_id, new_status_id, changed_by_id, note
  ) VALUES (
    NEW.org_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status_id END,
    NEW.status_id,
    v_changed_by,
    v_note
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_leave_request_status_log ON hr.leave_requests;
CREATE TRIGGER trg_leave_request_status_log
  AFTER INSERT OR UPDATE OF status_id ON hr.leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr.log_leave_status_change();

ALTER TABLE hr.leave_request_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_request_status_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_request_status_log;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_request_status_log;
CREATE POLICY org_isolation_policy ON hr.leave_request_status_log AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY tenant_isolation_policy ON hr.leave_request_status_log AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT                  ON hr.leave_request_status_log TO app_user;
GRANT SELECT                  ON hr.leave_request_status_log TO tenant_admin;
REVOKE INSERT, UPDATE, DELETE ON hr.leave_request_status_log FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON hr.leave_request_status_log TO root_service;


-- ===================================================================
-- 3. hr.leave_ledger — append-only source of truth for balances (§4.2)
--    SELECT-only for app_user (own rows) + tenant_admin (tenant scope);
--    INSERT only via the service path (root_service / hr-service), exactly as
--    lms.lead_status_log locks down its privileges. leave_request_id FK is
--    valid now that hr.leave_requests exists above.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.leave_ledger (
  id                UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id           UUID    NOT NULL REFERENCES iam.users(id)            ON DELETE RESTRICT,
  org_id            UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  leave_type_id     UUID    NOT NULL REFERENCES hr.leave_types(id)       ON DELETE RESTRICT,
  entry_type        TEXT    NOT NULL
                              CHECK (entry_type IN ('accrual','consumption','adjustment','carry_forward','encashment','lapse')),
  amount            NUMERIC(6,2) NOT NULL CHECK (amount <> 0),
  leave_request_id  UUID    REFERENCES hr.leave_requests(id)             ON DELETE SET NULL,
  period            TEXT,
  effective_date    DATE    NOT NULL,
  note              TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_leave_ledger_user_type_date
  ON hr.leave_ledger (user_id, leave_type_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_leave_ledger_org
  ON hr.leave_ledger (org_id);
CREATE INDEX IF NOT EXISTS idx_leave_ledger_request
  ON hr.leave_ledger (leave_request_id) WHERE leave_request_id IS NOT NULL;

ALTER TABLE hr.leave_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_ledger;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_ledger;
DROP POLICY IF EXISTS self_read_policy        ON hr.leave_ledger;

-- app_user: SELECT own rows (org-manager subtree reads come via views); no DML.
CREATE POLICY org_isolation_policy ON hr.leave_ledger AS PERMISSIVE FOR SELECT TO app_user
  USING (
    org_id  = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid
  );
CREATE POLICY tenant_isolation_policy ON hr.leave_ledger AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT                  ON hr.leave_ledger TO app_user;
GRANT SELECT                  ON hr.leave_ledger TO tenant_admin;
REVOKE INSERT, UPDATE, DELETE ON hr.leave_ledger FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON hr.leave_ledger TO root_service;


-- ===================================================================
-- 5. hr.leave_request_approvals — one row per approval level (§4.2)
--    org/tenant isolation + an approver policy (approver may SELECT/UPDATE
--    rows where approver_id = current user). Created via the service path when
--    a request is submitted; the approver acts on their own row.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.leave_request_approvals (
  id                UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  leave_request_id  UUID    NOT NULL REFERENCES hr.leave_requests(id)     ON DELETE CASCADE,
  org_id            UUID    NOT NULL REFERENCES entity.organizations(id)  ON DELETE RESTRICT,
  level             SMALLINT NOT NULL,
  approver_id       UUID    NOT NULL REFERENCES iam.users(id)             ON DELETE RESTRICT,
  action            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (action IN ('pending','approved','rejected')),
  acted_at          TIMESTAMPTZ,
  comment           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_leave_request_approvals_request_level UNIQUE (leave_request_id, level)
);

DROP TRIGGER IF EXISTS trg_00_leave_request_approvals_set_org_id ON hr.leave_request_approvals;
CREATE TRIGGER trg_00_leave_request_approvals_set_org_id
  BEFORE INSERT ON hr.leave_request_approvals FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_leave_request_approvals_audit        ON hr.leave_request_approvals;
CREATE TRIGGER trg_leave_request_approvals_audit
  AFTER UPDATE OR DELETE ON hr.leave_request_approvals FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_leave_request_approvals_request
  ON hr.leave_request_approvals (leave_request_id, level);
CREATE INDEX IF NOT EXISTS idx_leave_request_approvals_approver
  ON hr.leave_request_approvals (approver_id, action);
CREATE INDEX IF NOT EXISTS idx_leave_request_approvals_org
  ON hr.leave_request_approvals (org_id);

ALTER TABLE hr.leave_request_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.leave_request_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.leave_request_approvals;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.leave_request_approvals;
DROP POLICY IF EXISTS approver_policy         ON hr.leave_request_approvals;

CREATE POLICY org_isolation_policy ON hr.leave_request_approvals AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY tenant_isolation_policy ON hr.leave_request_approvals AS PERMISSIVE FOR ALL TO tenant_admin
  USING     (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted))
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

-- Approver: may read and act on (approve/reject) rows assigned to them even
-- when the row's org is not the one currently in context.
CREATE POLICY approver_policy ON hr.leave_request_approvals AS PERMISSIVE FOR ALL TO app_user
  USING      (approver_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid)
  WITH CHECK (approver_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid);

GRANT SELECT, INSERT, UPDATE ON hr.leave_request_approvals TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.leave_request_approvals TO tenant_admin;
REVOKE DELETE                ON hr.leave_request_approvals FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.leave_request_approvals TO root_service;


-- ===================================================================
-- 6. hr.can_approve_leave — approval authority (modeled on iam.can_assign_to)
--    TRUE when the approver is in the requester's management chain, OR has
--    rank >= 80 in the org, OR is hr_admin in the org, OR is tenant_admin/
--    super_admin of the owning tenant. SECURITY DEFINER: reads iam.* + entity.*
--    regardless of the calling role. Never lets a user approve their own leave.
-- ===================================================================
CREATE OR REPLACE FUNCTION hr.can_approve_leave(
  p_org_id       UUID,
  p_approver_id  UUID,
  p_requester_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_role     TEXT;
  v_rank     INT;
  v_in_scope BOOLEAN;
  v_tenant   UUID;
BEGIN
  IF p_approver_id = p_requester_id THEN RETURN FALSE; END IF;

  -- 1) Approver is in the requester's management subtree (walks manager_id up).
  SELECT COUNT(*) > 0 INTO v_in_scope
  FROM iam.vw_user_team_members
  WHERE manager_id = p_approver_id
    AND member_id  = p_requester_id
    AND org_id     = p_org_id;
  IF COALESCE(v_in_scope, FALSE) THEN RETURN TRUE; END IF;

  -- 2) Approver's role/rank in this org (org_admin+ => rank 80; hr_admin => 75).
  SELECT ur.name, ur.rank INTO v_role, v_rank
  FROM iam.user_org_mapping uom
  JOIN iam.user_roles ur ON ur.id = uom.role_id
  WHERE uom.user_id = p_approver_id
    AND uom.org_id  = p_org_id
    AND uom.is_active;

  IF COALESCE(v_rank, -1) >= 80 THEN RETURN TRUE; END IF;
  IF v_role = 'hr_admin'        THEN RETURN TRUE; END IF;

  -- 3) tenant_admin / super_admin of the tenant that owns the request's org.
  SELECT tenant_id INTO v_tenant FROM entity.organizations WHERE id = p_org_id;
  IF EXISTS (
    SELECT 1
    FROM iam.user_org_mapping uom
    JOIN iam.user_roles ur        ON ur.id = uom.role_id
    JOIN entity.organizations o   ON o.id  = uom.org_id
    WHERE uom.user_id = p_approver_id
      AND uom.is_active
      AND o.tenant_id = v_tenant
      AND ur.name IN ('tenant_admin','super_admin')
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END; $$;

GRANT EXECUTE ON FUNCTION hr.can_approve_leave(UUID,UUID,UUID) TO app_user, tenant_admin;


-- ===================================================================
-- 7. Views (security_invoker — underlying-table RLS applies to the caller)
-- ===================================================================

-- Per (user, org, leave_type) running balance = SUM(ledger.amount).
CREATE OR REPLACE VIEW hr.vw_leave_balances WITH (security_invoker = true) AS
SELECT
  ll.user_id,
  ll.org_id,
  ll.leave_type_id,
  lt.name         AS leave_type_name,
  lt.label        AS leave_type_label,
  SUM(ll.amount)  AS balance
FROM hr.leave_ledger ll
JOIN hr.leave_types  lt ON lt.id = ll.leave_type_id
GROUP BY ll.user_id, ll.org_id, ll.leave_type_id, lt.name, lt.label;

-- Requests joined with requester name, type/status labels, and latest approval.
CREATE OR REPLACE VIEW hr.vw_leave_requests_enriched WITH (security_invoker = true) AS
SELECT
  lr.id,
  lr.user_id,
  u.full_name      AS user_full_name,
  u.email          AS user_email,
  lr.org_id,
  lr.leave_type_id,
  lt.name          AS leave_type_name,
  lt.label         AS leave_type_label,
  lr.start_date,
  lr.end_date,
  lr.start_half,
  lr.end_half,
  lr.days_count,
  lr.reason,
  lr.status_id,
  lrs.name         AS status_name,
  lrs.label        AS status_label,
  lr.document_url,
  lr.is_open,
  la.level         AS latest_approval_level,
  la.approver_id   AS latest_approver_id,
  la.action        AS latest_approval_action,
  la.acted_at      AS latest_approval_acted_at,
  lr.created_at,
  lr.updated_at
FROM hr.leave_requests lr
JOIN iam.users                    u   ON u.id   = lr.user_id
JOIN hr.leave_types               lt  ON lt.id  = lr.leave_type_id
JOIN hr.leave_request_statuses    lrs ON lrs.id = lr.status_id
LEFT JOIN LATERAL (
  SELECT level, approver_id, action, acted_at
  FROM hr.leave_request_approvals a
  WHERE a.leave_request_id = lr.id
  ORDER BY a.level DESC
  LIMIT 1
) la ON TRUE
WHERE NOT lr.is_deleted;

-- Approved leaves with user info, for team-calendar date-range queries.
CREATE OR REPLACE VIEW hr.vw_team_leave_calendar WITH (security_invoker = true) AS
SELECT
  lr.id,
  lr.user_id,
  u.full_name    AS user_full_name,
  lr.org_id,
  lr.leave_type_id,
  lt.name        AS leave_type_name,
  lt.label       AS leave_type_label,
  lr.start_date,
  lr.end_date,
  lr.start_half,
  lr.end_half,
  lr.days_count
FROM hr.leave_requests lr
JOIN iam.users               u   ON u.id   = lr.user_id
JOIN hr.leave_types          lt  ON lt.id  = lr.leave_type_id
JOIN hr.leave_request_statuses lrs ON lrs.id = lr.status_id
WHERE lrs.name = 'approved'
  AND NOT lr.is_deleted;

GRANT SELECT ON hr.vw_leave_balances, hr.vw_leave_requests_enriched, hr.vw_team_leave_calendar
  TO app_user, tenant_admin, root_service;


-- ===================================================================
-- 8. SCHEMA VERSION TRACKING
-- NOTE: prompt requested '1.4.0', but 1.0.0–1.4.0 (Meta CAPI) and 1.5.0
-- (hr/task foundation) are already consumed — using the next free version,
-- matching the precedent set in 10_init-hr-task-schemas.sql.
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.6.0', 'Leave management: hr.holiday_calendars/holidays, leave_policies, hr_settings, leave_ledger, leave_requests (+status log), leave_request_approvals, hr.can_approve_leave(), leave views')
ON CONFLICT (version) DO NOTHING;
