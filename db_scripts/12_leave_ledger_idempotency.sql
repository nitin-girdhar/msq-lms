-- ===================================================================
-- CRM Monorepo — Leave ledger accrual idempotency (Phase 1)
-- Adds the unique partial index that makes the accrual job safe to
-- re-run: at most one accrual/carry_forward row per
-- (user_id, leave_type_id, entry_type, period).
-- Consumption / adjustment / lapse / encashment rows are intentionally
-- NOT constrained (a user may consume the same period many times).
-- Idempotent: safe to re-run.
-- Prerequisite: 11_init-leave-management.sql (hr.leave_ledger).
-- ===================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uix_leave_ledger_accrual_period
  ON hr.leave_ledger (user_id, leave_type_id, entry_type, period)
  WHERE entry_type IN ('accrual', 'carry_forward');

INSERT INTO public.schema_versions (version, description) VALUES
  ('1.6.1', 'Leave ledger accrual idempotency: unique (user, leave_type, entry_type, period) for accrual/carry_forward')
ON CONFLICT (version) DO NOTHING;
