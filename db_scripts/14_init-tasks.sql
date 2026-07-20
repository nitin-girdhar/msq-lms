-- ===================================================================
-- CRM Monorepo — Tasks / To-Do (Phase 3, DB layer)
-- Adds the complete task.* model:
--   Global lookups task.task_statuses / task.task_priorities (lms.lead_stage
--   shape, no RLS), org-scoped task.task_lists, task.tasks (+ append-only
--   task.task_status_log via trigger + completed_at consistency trigger),
--   append-only task.task_comments, and the dashboard views
--   (task.vw_my_tasks / task.vw_team_tasks).
-- Prerequisite: 01_init-db.sql + 01_init-lookup-data.sql + 10_init-hr-task-schemas.sql
--               (task schema, task_svc login role, schema USAGE + default
--                privileges for app_user/tenant_admin/root_service on the task schema).
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING /
--             guarded DO blocks / DROP+CREATE for triggers & policies).
-- Style, guard patterns, trigger recipe and RLS mirror db_scripts/10, 11 and 13.
-- Operational tables use the marketing.ad_campaigns recipe; the append-only
-- task_status_log / task_comments logs mirror hr.leave_request_status_log's lockdown.
--
-- VISIBILITY NOTE (documented once, enforced in the app layer — see
-- Architecture.md "Tasks"): task_lists carry a `visibility` of private/team/org.
--   * RLS keeps org isolation for every task.* table PLUS a private-list rule on
--     task_lists (a private list is visible ONLY to its owner, even inside the org).
--   * `team` visibility (a team list is visible to the owner's management subtree)
--     is NOT expressible in a single-row RLS predicate, so it is enforced in the
--     tasks-service repository via iam.vw_user_team_members.
--   * task.tasks RLS is plain org/tenant isolation. A task's effective visibility
--     derives from its list's visibility; rather than a correlated join policy on
--     every task read, the tasks-service applies the private/team/own filter in the
--     query (own tasks — created_by/assignee — are always visible). This keeps the
--     hot read path simple; the alternative (a join RLS policy on task.tasks) was
--     rejected for cost/complexity. See Architecture.md for the rationale.
-- ===================================================================


-- ===================================================================
-- 1. GLOBAL LOOKUP TABLES  (UUID PKs, same shape as lms.lead_stage — no RLS)
--    Managed globally (admin-service /lookups slugs); readable by every subject
--    role. task schema USAGE + default SELECT privileges already granted in 10.
-- ===================================================================

-- ── task.task_statuses ─────────────────────────────────────────────
-- is_terminal marks statuses that close a task (done, cancelled). The
-- completed_at consistency trigger keys specifically off the 'done' status.
CREATE TABLE IF NOT EXISTS task.task_statuses (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS task.task_priorities (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  name        TEXT    NOT NULL UNIQUE,
  label       TEXT    NOT NULL,
  description TEXT,
  sort_order  INT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── Lookup grants ──────────────────────────────────────────────────
GRANT SELECT         ON task.task_statuses, task.task_priorities TO app_user;
GRANT SELECT         ON task.task_statuses, task.task_priorities TO tenant_admin;
GRANT ALL PRIVILEGES ON task.task_statuses, task.task_priorities TO root_service;

-- ── Lookup seed data ───────────────────────────────────────────────
INSERT INTO task.task_statuses (name, label, is_terminal, sort_order) VALUES
  ('todo',        'To Do',       FALSE, 1),
  ('in_progress', 'In Progress', FALSE, 2),
  ('blocked',     'Blocked',     FALSE, 3),
  ('done',        'Done',        TRUE,  4),
  ('cancelled',   'Cancelled',   TRUE,  5)
ON CONFLICT (name) DO NOTHING;

INSERT INTO task.task_priorities (name, label, sort_order) VALUES
  ('low',    'Low',    1),
  ('medium', 'Medium', 2),
  ('high',   'High',   3),
  ('urgent', 'Urgent', 4)
ON CONFLICT (name) DO NOTHING;


-- ===================================================================
-- 2. task.task_lists — org-scoped named lists (§4.5)
--    Standard operational recipe + org/tenant RLS + an owner-private rule.
--    `visibility`: private (owner only) | team (owner's subtree, app layer) |
--    org (whole org). Writes gated in the service layer.
-- ===================================================================
CREATE TABLE IF NOT EXISTS task.task_lists (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  name        TEXT    NOT NULL,
  description TEXT,
  owner_id    UUID    NOT NULL REFERENCES iam.users(id) ON DELETE RESTRICT,
  visibility  TEXT    NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private','team','org')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_task_lists_active_deleted CHECK (NOT (is_active AND is_deleted))
);

DROP TRIGGER IF EXISTS trg_task_lists_updated_at        ON task.task_lists;
CREATE TRIGGER trg_task_lists_updated_at
  BEFORE UPDATE ON task.task_lists FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_task_lists_soft_delete       ON task.task_lists;
CREATE TRIGGER trg_task_lists_soft_delete
  BEFORE DELETE ON task.task_lists FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_task_lists_set_org_id     ON task.task_lists;
CREATE TRIGGER trg_00_task_lists_set_org_id
  BEFORE INSERT ON task.task_lists FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_task_lists_set_created_by ON task.task_lists;
CREATE TRIGGER trg_01_task_lists_set_created_by
  BEFORE INSERT ON task.task_lists FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_task_lists_audit             ON task.task_lists;
CREATE TRIGGER trg_task_lists_audit
  AFTER UPDATE OR DELETE ON task.task_lists FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_task_lists_org
  ON task.task_lists (org_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_task_lists_owner
  ON task.task_lists (owner_id) WHERE NOT is_deleted;

ALTER TABLE task.task_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE task.task_lists FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.task_lists;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.task_lists;
-- app_user: own org, not deleted, AND (non-private OR owner). The private rule
-- guarantees a peer never even reads another user's private list at the row level;
-- `team` narrowing (owner subtree) is layered on top in the service.
CREATE POLICY org_isolation_policy ON task.task_lists AS PERMISSIVE FOR ALL TO app_user
  USING (
    org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND NOT is_deleted
    AND (visibility <> 'private' OR owner_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid)
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND NOT is_deleted
  );
CREATE POLICY tenant_isolation_policy ON task.task_lists AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON task.task_lists TO app_user;
GRANT SELECT, INSERT, UPDATE ON task.task_lists TO tenant_admin;
REVOKE DELETE                ON task.task_lists FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON task.task_lists TO root_service;


-- ===================================================================
-- 3. task.tasks — the core task entity (§4.5)
--    Standard operational recipe + org/tenant RLS. list_id ON DELETE SET NULL
--    (deleting a list detaches, never cascades, its tasks). parent_task_id is a
--    self-FK for subtasks. related_entity_* is a polymorphic soft link (a task
--    "about" a lead / leave request) with no cross-schema hard FK.
-- ===================================================================
CREATE TABLE IF NOT EXISTS task.tasks (
  id                   UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id               UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  list_id              UUID    REFERENCES task.task_lists(id) ON DELETE SET NULL,
  title                TEXT    NOT NULL,
  description          TEXT,
  assignee_id          UUID    REFERENCES iam.users(id) ON DELETE SET NULL,
  due_at               TIMESTAMPTZ,
  priority_id          UUID    REFERENCES task.task_priorities(id) ON DELETE RESTRICT,
  status_id            UUID    NOT NULL REFERENCES task.task_statuses(id) ON DELETE RESTRICT,
  parent_task_id       UUID    REFERENCES task.tasks(id) ON DELETE SET NULL,
  related_entity_type  TEXT,
  related_entity_id    UUID,
  tags                 TEXT[]  NOT NULL DEFAULT '{}',
  completed_at         TIMESTAMPTZ,
  -- RFC 5545 RRULE column only; recurrence expansion is a later increment.
  recurrence_rule      TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at           TIMESTAMPTZ,
  deleted_by           UUID,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT chk_tasks_active_deleted   CHECK (NOT (is_active AND is_deleted)),
  CONSTRAINT chk_tasks_not_self_parent  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  -- related_entity_type and _id are set together or not at all.
  CONSTRAINT chk_tasks_related_entity
    CHECK ((related_entity_type IS NULL) = (related_entity_id IS NULL))
);

-- completed_at ↔ status consistency (auto-managed, mirrors the intent of
-- lms.check_follow_up_completion). Sets completed_at when the task enters the
-- terminal 'done' status and clears it on any transition away from 'done'. Runs
-- BEFORE so the value lands on the same row write.
CREATE OR REPLACE FUNCTION task.set_task_completion()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT name INTO v_status FROM task.task_statuses WHERE id = NEW.status_id;
  IF v_status = 'done' THEN
    IF NEW.completed_at IS NULL THEN NEW.completed_at := CLOCK_TIMESTAMP(); END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END; $$;

-- Append-only status-transition log writer. SECURITY DEFINER: app_user has no
-- INSERT on task.task_status_log. Note is read from the app.task_transition_note
-- session GUC set by the API before the update (mirrors hr.log_leave_status_change).
CREATE OR REPLACE FUNCTION task.log_task_status_change()
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
    v_note := NULLIF(current_setting('app.task_transition_note', true), '');
  EXCEPTION WHEN OTHERS THEN v_note := NULL; END;

  INSERT INTO task.task_status_log (
    org_id, task_id, old_status_id, new_status_id, changed_by_id, note
  ) VALUES (
    NEW.org_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status_id END,
    NEW.status_id,
    v_changed_by,
    v_note
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_tasks_updated_at        ON task.tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON task.tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_completion         ON task.tasks;
CREATE TRIGGER trg_tasks_completion
  BEFORE INSERT OR UPDATE OF status_id ON task.tasks FOR EACH ROW EXECUTE FUNCTION task.set_task_completion();

DROP TRIGGER IF EXISTS trg_tasks_soft_delete       ON task.tasks;
CREATE TRIGGER trg_tasks_soft_delete
  BEFORE DELETE ON task.tasks FOR EACH ROW EXECUTE FUNCTION public.soft_delete_row();

DROP TRIGGER IF EXISTS trg_00_tasks_set_org_id     ON task.tasks;
CREATE TRIGGER trg_00_tasks_set_org_id
  BEFORE INSERT ON task.tasks FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

DROP TRIGGER IF EXISTS trg_01_tasks_set_created_by ON task.tasks;
CREATE TRIGGER trg_01_tasks_set_created_by
  BEFORE INSERT ON task.tasks FOR EACH ROW EXECUTE FUNCTION public.set_created_by();

DROP TRIGGER IF EXISTS trg_tasks_audit             ON task.tasks;
CREATE TRIGGER trg_tasks_audit
  AFTER UPDATE OR DELETE ON task.tasks FOR EACH ROW EXECUTE FUNCTION audit.audit_row_changes();

CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee_status
  ON task.tasks (org_id, assignee_id, status_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_org_due
  ON task.tasks (org_id, due_at) WHERE completed_at IS NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_related_entity
  ON task.tasks (related_entity_type, related_entity_id) WHERE related_entity_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_list
  ON task.tasks (list_id) WHERE list_id IS NOT NULL AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_created_by
  ON task.tasks (org_id, created_by) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON task.tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;

ALTER TABLE task.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task.tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.tasks;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.tasks;
-- Plain org/tenant isolation (see VISIBILITY NOTE at the top). Private/team
-- narrowing is applied in the tasks-service query, never bypassed.
CREATE POLICY org_isolation_policy ON task.tasks AS PERMISSIVE FOR ALL TO app_user
  USING     (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid AND NOT is_deleted);
CREATE POLICY tenant_isolation_policy ON task.tasks AS PERMISSIVE FOR ALL TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted)
  WITH CHECK (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted) AND NOT is_deleted);

GRANT SELECT, INSERT, UPDATE ON task.tasks TO app_user;
GRANT SELECT, INSERT, UPDATE ON task.tasks TO tenant_admin;
REVOKE DELETE                ON task.tasks FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES         ON task.tasks TO root_service;


-- ===================================================================
-- 4. task.task_status_log — append-only (mirrors hr.leave_request_status_log)
--    SELECT-only for app_user (org scope) + tenant_admin (tenant scope);
--    INSERT only via the SECURITY DEFINER trigger above.
-- ===================================================================
CREATE TABLE IF NOT EXISTS task.task_status_log (
  id            UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id        UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  task_id       UUID    NOT NULL REFERENCES task.tasks(id)           ON DELETE CASCADE,
  changed_by_id UUID    REFERENCES iam.users(id)                     ON DELETE SET NULL,
  old_status_id UUID    REFERENCES task.task_statuses(id)            ON DELETE RESTRICT,
  new_status_id UUID    NOT NULL REFERENCES task.task_statuses(id)   ON DELETE RESTRICT,
  note          TEXT,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX IF NOT EXISTS idx_task_status_log_task
  ON task.task_status_log (org_id, task_id, changed_at DESC);

-- The status-log trigger inserts into this table; declared after the table exists.
DROP TRIGGER IF EXISTS trg_tasks_status_log ON task.tasks;
CREATE TRIGGER trg_tasks_status_log
  AFTER INSERT OR UPDATE OF status_id ON task.tasks
  FOR EACH ROW EXECUTE FUNCTION task.log_task_status_change();

ALTER TABLE task.task_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE task.task_status_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.task_status_log;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.task_status_log;
CREATE POLICY org_isolation_policy ON task.task_status_log AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
CREATE POLICY tenant_isolation_policy ON task.task_status_log AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT                  ON task.task_status_log TO app_user;
GRANT SELECT                  ON task.task_status_log TO tenant_admin;
REVOKE INSERT, UPDATE, DELETE ON task.task_status_log FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON task.task_status_log TO root_service;


-- ===================================================================
-- 5. task.task_comments — append-only comment thread (§4.5)
--    app_user SELECT + INSERT (own author rows); NO UPDATE/DELETE for non-service
--    (author-delete can come in a later increment). RLS org/tenant isolation.
-- ===================================================================
CREATE TABLE IF NOT EXISTS task.task_comments (
  id          UUID    PRIMARY KEY DEFAULT public.gen_uuidv7(),
  org_id      UUID    NOT NULL REFERENCES entity.organizations(id) ON DELETE RESTRICT,
  task_id     UUID    NOT NULL REFERENCES task.tasks(id)           ON DELETE CASCADE,
  user_id     UUID    NOT NULL REFERENCES iam.users(id)            ON DELETE RESTRICT,
  body        TEXT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

DROP TRIGGER IF EXISTS trg_00_task_comments_set_org_id ON task.task_comments;
CREATE TRIGGER trg_00_task_comments_set_org_id
  BEFORE INSERT ON task.task_comments FOR EACH ROW EXECUTE FUNCTION public.set_org_id();

CREATE INDEX IF NOT EXISTS idx_task_comments_task
  ON task.task_comments (org_id, task_id, created_at);

ALTER TABLE task.task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task.task_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_policy    ON task.task_comments;
DROP POLICY IF EXISTS self_insert_policy      ON task.task_comments;
DROP POLICY IF EXISTS tenant_isolation_policy ON task.task_comments;
CREATE POLICY org_isolation_policy ON task.task_comments AS PERMISSIVE FOR SELECT TO app_user
  USING (org_id = NULLIF(current_setting('app.current_org_id',true),'')::uuid);
-- INSERT own author rows only (org + author must match the session).
CREATE POLICY self_insert_policy ON task.task_comments AS PERMISSIVE FOR INSERT TO app_user
  WITH CHECK (
    org_id  = NULLIF(current_setting('app.current_org_id',true),'')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id',true),'')::uuid
  );
CREATE POLICY tenant_isolation_policy ON task.task_comments AS PERMISSIVE FOR SELECT TO tenant_admin
  USING (org_id IN (SELECT id FROM entity.organizations WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid AND NOT is_deleted));

GRANT SELECT, INSERT          ON task.task_comments TO app_user;
GRANT SELECT                  ON task.task_comments TO tenant_admin;
REVOKE UPDATE, DELETE         ON task.task_comments FROM app_user, tenant_admin;
GRANT ALL PRIVILEGES          ON task.task_comments TO root_service;


-- ===================================================================
-- 6. Views (security_invoker — underlying-table RLS applies to the caller)
--    These resolve lookup labels + user names for the list/detail read paths.
--    Visibility narrowing (own/team/private) still happens in the repository;
--    the views are org-scoped projections, not access-control boundaries.
-- ===================================================================

-- Enriched task projection: lookup labels, list name/visibility, assignee &
-- creator names. Reused by the list/detail endpoints.
CREATE OR REPLACE VIEW task.vw_tasks_enriched WITH (security_invoker = true) AS
SELECT
  t.id,
  t.org_id,
  t.list_id,
  tl.name        AS list_name,
  tl.visibility  AS list_visibility,
  tl.owner_id    AS list_owner_id,
  t.title,
  t.description,
  t.assignee_id,
  ua.full_name   AS assignee_name,
  ua.email       AS assignee_email,
  t.created_by,
  uc.full_name   AS created_by_name,
  t.due_at,
  t.priority_id,
  tp.name        AS priority_name,
  tp.label       AS priority_label,
  tp.sort_order  AS priority_sort_order,
  t.status_id,
  ts.name        AS status_name,
  ts.label       AS status_label,
  ts.is_terminal AS status_is_terminal,
  t.parent_task_id,
  t.related_entity_type,
  t.related_entity_id,
  t.tags,
  t.completed_at,
  t.recurrence_rule,
  t.created_at,
  t.updated_at
FROM task.tasks t
LEFT JOIN task.task_lists      tl ON tl.id = t.list_id
LEFT JOIN task.task_priorities tp ON tp.id = t.priority_id
JOIN      task.task_statuses   ts ON ts.id = t.status_id
LEFT JOIN iam.users            ua ON ua.id = t.assignee_id
LEFT JOIN iam.users            uc ON uc.id = t.created_by
WHERE NOT t.is_deleted;

GRANT SELECT ON task.vw_tasks_enriched TO app_user, tenant_admin, root_service;


-- ===================================================================
-- 7. SCHEMA VERSION TRACKING
-- NOTE: the prompt requested '1.6.0', but 1.0.0–1.7.0 are already consumed
-- (Meta CAPI, hr/task foundation, leave management, attendance) — using the next
-- free version, matching the precedent set in 10_, 11_ and 13_.
-- ===================================================================
INSERT INTO public.schema_versions (version, description) VALUES
  ('1.8.0', 'Tasks: task.task_statuses/task_priorities lookups, task.task_lists (owner-private RLS), task.tasks (+ status log + completion trigger), task.task_comments, task.vw_tasks_enriched')
ON CONFLICT (version) DO NOTHING;
