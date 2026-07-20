-- ===================================================================
-- CRM Monorepo — Attendance (Phase 2, DB layer)
-- Adds the complete hr.* attendance model:
--   entity.organizations geo columns (geofence centre), attendance_rules,
--   shifts, shift_assignments, attendance_events (append-only), attendance_days,
--   attendance_regularizations, hr.can_approve() authority alias, and the
--   dashboard views (vw_attendance_monthly_summary / vw_org_attendance_today).
-- Prerequisite: 01_init-db.sql + 01_init-lookup-data.sql + 10_init-hr-task-schemas.sql
--               (hr schema, hr_svc role, hr.attendance_statuses lookup + seed,
--                employee_profiles) + 11_init-leave-management.sql (leave_requests,
--                hr.can_approve_leave(), btree_gist).
-- Idempotent: safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--             guarded DO blocks / DROP+CREATE for triggers & policies).
-- Style, guard patterns, trigger recipe and RLS mirror db_scripts/10 and 11.
-- Operational tables use the marketing.ad_campaigns recipe; the append-only
-- attendance_events log mirrors hr.leave_ledger's lockdown.
-- ===================================================================


-- btree_gist already installed by 11_init-leave-management.sql; keep for safety
-- (shift_assignments uses an exclusion constraint mixing = and && ).
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ===================================================================
-- 0. entity.organizations — additive geofence-centre columns
--    Guarded ADD COLUMN so re-runs are no-ops. These are the org's physical
--    location; attendance geofencing measures haversine distance from here.
-- ===================================================================
ALTER TABLE entity.organizations ADD COLUMN IF NOT EXISTS geo_lat NUMERIC(9,6);
ALTER TABLE entity.organizations ADD COLUMN IF NOT EXISTS geo_lng NUMERIC(9,6);


-- ===================================================================
-- 1. hr.attendance_rules — org-level capture rules (§4.3)
--    One row per org (UNIQUE (org_id) among non-deleted). Standard operational
--    recipe + org/tenant RLS. Readable by every app_user in the org (they need
--    the rules before punching); writes are gated to hr_admin/org_admin at the
--    app layer (same FOR ALL app_user pattern as hr.holidays).
--    Face-verification columns are created now but stay DORMANT (no enforcement
--    logic in this increment).
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.attendance_rules (
  id                       UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id                   UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  geofence_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  geofence_radius_meters   INT     NOT NULL DEFAULT 200 CHECK (geofence_radius_meters > 0),
  require_photo            BOOLEAN NOT NULL DEFAULT TRUE,
  require_geo              BOOLEAN NOT NULL DEFAULT TRUE,
  allow_wfh_checkin        BOOLEAN NOT NULL DEFAULT FALSE,
  -- ── Face-verification rules (DORMANT until the face-verification increment) ──
  require_face_match       BOOLEAN NOT NULL DEFAULT FALSE,
  face_match_threshold     NUMERIC(5,2) NOT NULL DEFAULT 85 CHECK (face_match_threshold BETWEEN 50 AND 100),
  face_match_action        TEXT    NOT NULL DEFAULT 'flag' CHECK (face_match_action IN ('flag','block')),
  -- ── standard soft-delete / audit ──
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_attendance_rules_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_attendance_rules_updated_at        ON hr.attendance_rules;
CREATE TRIGGER trg_attendance_rules_updated_at
  BEFORE UPDATE ON hr.attendance_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_rules_soft_delete       ON hr.attendance_rules;
CREATE TRIGGER trg_attendance_rules_soft_delete
  BEFORE DELETE ON hr.attendance_rules FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_attendance_rules_set_org_id     ON hr.attendance_rules;
CREATE TRIGGER trg_00_attendance_rules_set_org_id
  BEFORE INSERT ON hr.attendance_rules FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_attendance_rules_set_created_by ON hr.attendance_rules;
CREATE TRIGGER trg_01_attendance_rules_set_created_by
  BEFORE INSERT ON hr.attendance_rules FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_attendance_rules_audit             ON hr.attendance_rules;
CREATE TRIGGER trg_attendance_rules_audit
  AFTER UPDATE OR DELETE ON hr.attendance_rules FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

-- One active rules row per org.
CREATE UNIQUE INDEX IF NOT EXISTS uix_attendance_rules_org
  ON hr.attendance_rules (org_id) WHERE NOT is_deleted;

ALTER TABLE hr.attendance_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.attendance_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.attendance_rules;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.attendance_rules;
CREATE POLICY org_isolation_policy ON hr.attendance_rules AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.attendance_rules AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.attendance_rules TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.attendance_rules TO tenant_admin;
REVOKE DELETE                ON hr.attendance_rules FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.attendance_rules TO root_service;


-- ===================================================================
-- 2. hr.shifts — org-scoped shift definitions (§4.3)
--    Standard recipe + org/tenant RLS. Readable by all app_user; writes gated
--    to hr_admin/org_admin at the app layer.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.shifts (
  id                    UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id                UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name                  TEXT    NOT NULL,
  start_time            TIME    NOT NULL,
  end_time              TIME    NOT NULL,
  grace_minutes         SMALLINT NOT NULL DEFAULT 10,
  min_half_day_minutes  SMALLINT NOT NULL DEFAULT 240,
  min_full_day_minutes  SMALLINT NOT NULL DEFAULT 480,
  is_night_shift        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted            BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at            TIMESTAMPTZ,
  deleted_by            UUID,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_shifts_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_shifts_updated_at        ON hr.shifts;
CREATE TRIGGER trg_shifts_updated_at
  BEFORE UPDATE ON hr.shifts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_shifts_soft_delete       ON hr.shifts;
CREATE TRIGGER trg_shifts_soft_delete
  BEFORE DELETE ON hr.shifts FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_shifts_set_org_id     ON hr.shifts;
CREATE TRIGGER trg_00_shifts_set_org_id
  BEFORE INSERT ON hr.shifts FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_shifts_set_created_by ON hr.shifts;
CREATE TRIGGER trg_01_shifts_set_created_by
  BEFORE INSERT ON hr.shifts FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_shifts_audit             ON hr.shifts;
CREATE TRIGGER trg_shifts_audit
  AFTER UPDATE OR DELETE ON hr.shifts FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_shifts_org
  ON hr.shifts (org_id) WHERE NOT is_deleted;
CREATE UNIQUE INDEX IF NOT EXISTS uix_shifts_org_name
  ON hr.shifts (org_id, name) WHERE NOT is_deleted;

ALTER TABLE hr.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.shifts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.shifts;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.shifts;
CREATE POLICY org_isolation_policy ON hr.shifts AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.shifts AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.shifts TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.shifts TO tenant_admin;
REVOKE DELETE                ON hr.shifts FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.shifts TO root_service;


-- ===================================================================
-- 3. hr.shift_assignments — effective-dated user→shift mapping (§4.3)
--    Standard recipe + org/tenant RLS + a self-read policy (a user always sees
--    their own assignment). No overlapping assignments per user among non-deleted
--    rows (gist exclusion on user_id + daterange).
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.shift_assignments (
  id              UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id         UUID    NOT NULL REFERENCES iam.users(id)            ON DELETE RESTRICT,
  org_id          UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  shift_id        UUID    NOT NULL REFERENCES hr.shifts(id)            ON DELETE RESTRICT,
  effective_from  DATE    NOT NULL,
  effective_to    DATE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at      TIMESTAMPTZ,
  deleted_by      UUID,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_shift_assignments_active_deleted CHECK (NOT (is_active AND is_deleted)),
  CONSTRAINT chk_shift_assignments_date_order     CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- No two non-deleted assignments for the same user may cover overlapping dates.
  CONSTRAINT excl_shift_assignments_no_overlap
    EXCLUDE USING gist (
      user_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'), '[]') WITH &&
    ) WHERE (NOT is_deleted)
);

DROP TRIGGER IF EXISTS trg_shift_assignments_updated_at        ON hr.shift_assignments;
CREATE TRIGGER trg_shift_assignments_updated_at
  BEFORE UPDATE ON hr.shift_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_shift_assignments_soft_delete       ON hr.shift_assignments;
CREATE TRIGGER trg_shift_assignments_soft_delete
  BEFORE DELETE ON hr.shift_assignments FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_shift_assignments_set_org_id     ON hr.shift_assignments;
CREATE TRIGGER trg_00_shift_assignments_set_org_id
  BEFORE INSERT ON hr.shift_assignments FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_shift_assignments_set_created_by ON hr.shift_assignments;
CREATE TRIGGER trg_01_shift_assignments_set_created_by
  BEFORE INSERT ON hr.shift_assignments FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_shift_assignments_audit             ON hr.shift_assignments;
CREATE TRIGGER trg_shift_assignments_audit
  AFTER UPDATE OR DELETE ON hr.shift_assignments FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_shift_assignments_user
  ON hr.shift_assignments (user_id, effective_from DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_shift_assignments_org
  ON hr.shift_assignments (org_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_shift_assignments_shift
  ON hr.shift_assignments (shift_id) WHERE NOT is_deleted;

ALTER TABLE hr.shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.shift_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.shift_assignments;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.shift_assignments;
DROP POLICY IF EXISTS self_policy             ON hr.shift_assignments;
CREATE POLICY org_isolation_policy ON hr.shift_assignments AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.shift_assignments AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);
-- Self policy: a user may always read their own assignment (needed to compute the
-- shift before punching), regardless of the org currently in context.
CREATE POLICY self_policy ON hr.shift_assignments AS PERMISSIVE FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.shift_assignments TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.shift_assignments TO tenant_admin;
REVOKE DELETE                ON hr.shift_assignments FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.shift_assignments TO root_service;


-- ===================================================================
-- 4. hr.attendance_events — append-only raw punches (§4.3)
--    Lockdown mirrors hr.leave_ledger: app_user SELECT + INSERT own rows only,
--    tenant_admin SELECT tenant scope, NO UPDATE/DELETE for non-service. Manager
--    / subtree reads happen via the service path (never a broad app_user policy).
--    Corrections go through regularization, never row edits.
--    Face-result columns are created now but stay DORMANT.
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.attendance_events (
  id                   UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id              UUID    NOT NULL REFERENCES iam.users(id)            ON DELETE RESTRICT,
  org_id               UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  event_type           TEXT    NOT NULL CHECK (event_type IN ('check_in','check_out')),
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  source               TEXT    NOT NULL CHECK (source IN ('web','mobile','biometric','api')),
  geo_lat              NUMERIC(9,6),
  geo_lng              NUMERIC(9,6),
  distance_from_org_m  NUMERIC(10,2),
  is_within_geofence   BOOLEAN,
  is_wfh               BOOLEAN NOT NULL DEFAULT FALSE,
  photo_url            TEXT,
  -- ── Face-verification results (DORMANT until the face-verification increment) ──
  face_match_score     NUMERIC(5,2),
  face_match_passed    BOOLEAN,
  face_review_status   TEXT    CHECK (face_review_status IN ('pending','cleared','rejected')),
  ip                   TEXT,
  device_info          JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_attendance_events_user_occurred
  ON hr.attendance_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attendance_events_org
  ON hr.attendance_events (org_id);

ALTER TABLE hr.attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.attendance_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.attendance_events;
DROP POLICY IF EXISTS self_insert_policy      ON hr.attendance_events;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.attendance_events;
-- app_user: SELECT own rows only (org-manager subtree reads come via the service
-- path); INSERT own rows only. No UPDATE/DELETE (revoked below).
CREATE POLICY org_isolation_policy ON hr.attendance_events AS PERMISSIVE FOR SELECT TO app_user
  USING (
    org_id  = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid
  );
CREATE POLICY self_insert_policy ON hr.attendance_events AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (
    org_id  = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid
  );
CREATE POLICY tenant_isolation_policy ON hr.attendance_events AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT, INSERT          ON hr.attendance_events TO app_user;
GRANT SELECT                  ON hr.attendance_events TO tenant_admin;
REVOKE UPDATE, DELETE         ON hr.attendance_events FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON hr.attendance_events TO root_service;


-- ===================================================================
-- 5. hr.attendance_days — one resolved row per user per date (§4.3)
--    Upserted by the service path (live punch) and the nightly resolution job.
--    RLS: app_user SELECT own rows; tenant_admin SELECT tenant scope; writes are
--    service-only (org-wide / team reads go through the service path after an
--    authority check, exactly like the leave team queue).
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.attendance_days (
  id                 UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id            UUID    NOT NULL REFERENCES iam.users(id)               ON DELETE RESTRICT,
  org_id             UUID    NOT NULL REFERENCES entity.organizations(id)    ON DELETE RESTRICT,
  work_date          DATE    NOT NULL,
  first_in           TIMESTAMPTZ,
  last_out           TIMESTAMPTZ,
  worked_minutes     INT,
  status_id          UUID    NOT NULL REFERENCES hr.attendance_statuses(id)  ON DELETE RESTRICT,
  is_late            BOOLEAN NOT NULL DEFAULT FALSE,
  is_early_exit      BOOLEAN NOT NULL DEFAULT FALSE,
  leave_request_id   UUID    REFERENCES hr.leave_requests(id)                ON DELETE SET NULL,
  resolved_at        TIMESTAMPTZ,
  resolution_source  TEXT    CHECK (resolution_source IN ('events','leave','holiday','weekly_off','regularization','job')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_attendance_days_user_date UNIQUE (user_id, work_date)
);

DROP TRIGGER IF EXISTS trg_attendance_days_updated_at ON hr.attendance_days;
CREATE TRIGGER trg_attendance_days_updated_at
  BEFORE UPDATE ON hr.attendance_days FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_days_audit      ON hr.attendance_days;
CREATE TRIGGER trg_attendance_days_audit
  AFTER UPDATE OR DELETE ON hr.attendance_days FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_attendance_days_org_date
  ON hr.attendance_days (org_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days_user_date
  ON hr.attendance_days (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_days_leave_request
  ON hr.attendance_days (leave_request_id) WHERE leave_request_id IS NOT NULL;

ALTER TABLE hr.attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.attendance_days FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.attendance_days;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.attendance_days;
CREATE POLICY org_isolation_policy ON hr.attendance_days AS PERMISSIVE FOR SELECT TO app_user
  USING (
    org_id  = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid
  );
CREATE POLICY tenant_isolation_policy ON hr.attendance_days AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT                  ON hr.attendance_days TO app_user;
GRANT SELECT                  ON hr.attendance_days TO tenant_admin;
REVOKE INSERT, UPDATE, DELETE ON hr.attendance_days FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON hr.attendance_days TO root_service;


-- ===================================================================
-- 6. hr.attendance_regularizations — correction requests (§4.3)
--    Standard recipe + org/tenant RLS + a self policy (a user always sees and
--    inserts their own). One open regularization per (user, work_date): partial
--    unique index WHERE status='pending' AND NOT is_deleted. Approvers act via
--    the service path (hr.can_approve authority).
-- ===================================================================
CREATE TABLE IF NOT EXISTS hr.attendance_regularizations (
  id                  UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  user_id             UUID    NOT NULL REFERENCES iam.users(id)               ON DELETE RESTRICT,
  org_id              UUID    NOT NULL REFERENCES entity.organizations(id)    ON DELETE RESTRICT,
  work_date           DATE    NOT NULL,
  requested_status_id UUID    REFERENCES hr.attendance_statuses(id)           ON DELETE RESTRICT,
  requested_in        TIMESTAMPTZ,
  requested_out       TIMESTAMPTZ,
  reason              TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected')),
  approver_id         UUID    REFERENCES iam.users(id)                        ON DELETE SET NULL,
  acted_at            TIMESTAMPTZ,
  approver_comment    TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at          TIMESTAMPTZ,
  deleted_by          UUID,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_attendance_regularizations_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_attendance_regularizations_updated_at        ON hr.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations_updated_at
  BEFORE UPDATE ON hr.attendance_regularizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_regularizations_soft_delete       ON hr.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations_soft_delete
  BEFORE DELETE ON hr.attendance_regularizations FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_attendance_regularizations_set_org_id     ON hr.attendance_regularizations;
CREATE TRIGGER trg_00_attendance_regularizations_set_org_id
  BEFORE INSERT ON hr.attendance_regularizations FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_attendance_regularizations_set_created_by ON hr.attendance_regularizations;
CREATE TRIGGER trg_01_attendance_regularizations_set_created_by
  BEFORE INSERT ON hr.attendance_regularizations FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_attendance_regularizations_audit             ON hr.attendance_regularizations;
CREATE TRIGGER trg_attendance_regularizations_audit
  AFTER UPDATE OR DELETE ON hr.attendance_regularizations FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_attendance_regularizations_user
  ON hr.attendance_regularizations (user_id, work_date DESC) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_attendance_regularizations_org_status
  ON hr.attendance_regularizations (org_id, status) WHERE NOT is_deleted;
-- One open (pending) regularization per user per date.
CREATE UNIQUE INDEX IF NOT EXISTS uix_attendance_regularizations_open
  ON hr.attendance_regularizations (user_id, work_date)
  WHERE status = 'pending' AND NOT is_deleted;

ALTER TABLE hr.attendance_regularizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.attendance_regularizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON hr.attendance_regularizations;
DROP POLICY IF EXISTS tenant_isolation_policy ON hr.attendance_regularizations;
DROP POLICY IF EXISTS self_policy             ON hr.attendance_regularizations;
CREATE POLICY org_isolation_policy ON hr.attendance_regularizations AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON hr.attendance_regularizations AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);
CREATE POLICY self_policy ON hr.attendance_regularizations AS PERMISSIVE FOR ALL TO app_user
  USING      (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON hr.attendance_regularizations TO app_user;
GRANT SELECT, INSERT, UPDATE ON hr.attendance_regularizations TO tenant_admin;
REVOKE DELETE                ON hr.attendance_regularizations FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON hr.attendance_regularizations TO root_service;


-- ===================================================================
-- 7. hr.can_approve — thin authority alias over hr.can_approve_leave (§Service).
--    Rename-agnostic: the underlying function checks the management chain +
--    rank>=80 + hr_admin + tenant_admin/super_admin. Reused for attendance
--    regularization approvals so authority stays defined in exactly one place.
-- ===================================================================
CREATE OR REPLACE FUNCTION hr.can_approve(
  p_org_id       UUID,
  p_approver_id  UUID,
  p_requester_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT hr.can_approve_leave(p_org_id, p_approver_id, p_requester_id);
$$;

GRANT EXECUTE ON FUNCTION hr.can_approve(UUID,UUID,UUID) TO app_user, tenant_admin;


-- ===================================================================
-- 8. Views (security_invoker — underlying-table RLS applies to the caller)
-- ===================================================================

-- Per (user, org, month) status counts, late count, avg worked_minutes.
-- Payroll-export source. Month is the org-local YYYY-MM of work_date.
CREATE OR REPLACE VIEW hr.vw_attendance_monthly_summary WITH (security_invoker = true) AS
SELECT
  ad.org_id,
  ad.user_id,
  u.full_name                                            AS user_full_name,
  u.email                                                AS user_email,
  to_char(ad.work_date, 'YYYY-MM')                       AS month,
  COUNT(*) FILTER (WHERE st.name = 'present')            AS present_count,
  COUNT(*) FILTER (WHERE st.name = 'absent')             AS absent_count,
  COUNT(*) FILTER (WHERE st.name = 'half_day')           AS half_day_count,
  COUNT(*) FILTER (WHERE st.name = 'on_leave')           AS on_leave_count,
  COUNT(*) FILTER (WHERE st.name = 'holiday')            AS holiday_count,
  COUNT(*) FILTER (WHERE st.name = 'weekly_off')         AS weekly_off_count,
  COUNT(*) FILTER (WHERE st.name = 'wfh')                AS wfh_count,
  COUNT(*) FILTER (WHERE ad.is_late)                     AS late_count,
  COUNT(*) FILTER (WHERE ad.is_early_exit)               AS early_exit_count,
  AVG(ad.worked_minutes)::numeric(10,2)                  AS avg_worked_minutes
FROM hr.attendance_days ad
JOIN iam.users               u  ON u.id  = ad.user_id
JOIN hr.attendance_statuses  st ON st.id = ad.status_id
GROUP BY ad.org_id, ad.user_id, u.full_name, u.email, to_char(ad.work_date, 'YYYY-MM');

-- Today's org attendance: active employees LEFT JOINed to their attendance_days
-- row for CURRENT_DATE; unmatched employees surface as 'not_marked'. Used by the
-- org dashboard; the /team endpoint queries a parameterized date in the repo for
-- arbitrary days.
CREATE OR REPLACE VIEW hr.vw_org_attendance_today WITH (security_invoker = true) AS
SELECT
  ep.org_id,
  ep.user_id,
  u.full_name                          AS user_full_name,
  u.email                              AS user_email,
  ad.work_date,
  ad.first_in,
  ad.last_out,
  ad.worked_minutes,
  COALESCE(st.name,  'not_marked')     AS status_name,
  COALESCE(st.label, 'Not Marked')     AS status_label,
  COALESCE(ad.is_late, FALSE)          AS is_late,
  COALESCE(ad.is_early_exit, FALSE)    AS is_early_exit
FROM hr.employee_profiles ep
JOIN iam.users u ON u.id = ep.user_id
LEFT JOIN hr.attendance_days ad
       ON ad.user_id = ep.user_id AND ad.work_date = CURRENT_DATE
LEFT JOIN hr.attendance_statuses st ON st.id = ad.status_id
WHERE ep.is_active AND NOT ep.is_deleted;

GRANT SELECT ON hr.vw_attendance_monthly_summary, hr.vw_org_attendance_today
  TO app_user, tenant_admin, root_service;


-- ===================================================================
-- 9. SCHEMA VERSION TRACKING
-- NOTE: the prompt requested '1.5.0', but 1.0.0–1.6.1 are already consumed
-- (Meta CAPI, hr/task foundation, leave management) — using the next free
-- version, matching the precedent in 10_ and 11_.
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.7.0', 'Attendance: entity.organizations geo columns, hr.attendance_rules/shifts/shift_assignments, attendance_events (append-only), attendance_days, attendance_regularizations, hr.can_approve(), attendance views')
ON CONFLICT (version) DO NOTHING;
