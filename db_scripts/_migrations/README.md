# One-time migrations (pre-P1.0 deployments only)

These two scripts rewrite the database's *shape* from what it looked like before the
P1.0 crm-naming cleanup (`docs/Platform_Implementation_Plan.md` Phase 1) to what
`db_scripts/01_init-db.sql` / `10_init-hr-task-schemas.sql` now create directly:

- `15_tenant-modules-lms-rename.sql` — renames the `entity.tenant_modules`
  entitlement key `'crm'` → `'lms'` (CHECK constraint + existing rows + backfill).
- `16_rename_crm_schema_and_service_role.sql` — `ALTER SCHEMA crm RENAME TO lms` +
  `ALTER ROLE crm_service RENAME TO root_service` + re-authors the 9 trigger/function
  bodies that hardcode `crm.` as literal text (schema-qualification inside a plpgsql
  body isn't an OID reference, so `ALTER SCHEMA … RENAME` doesn't touch it).

**Both are guarded no-ops on a fresh install.** `01_init-db.sql` and
`10_init-hr-task-schemas.sql` already create schema `lms` and role `root_service`
directly (confirmed: `grep -c crm_service db_scripts/01_init-db.sql` → 0), and
`10_init-hr-task-schemas.sql`'s `tenant_modules.module` CHECK already lists
`'lms'` (not `'crm'`) as the valid key. So a brand-new database never needs these
two scripts — the fresh-install sequence in `db_deploy.ps1` skips straight from
`14_init-tasks.sql` to `17_init-per-product-roles.sql`.

**Run these two only when migrating a database that was deployed *before* P1.0**
(schema still literally named `crm`, role still `crm_service`) — run them first,
in order (`15` then `16`), before continuing the normal numbered sequence at `17`.

## Why 17–20 are *not* here

`17_init-per-product-roles.sql`, `18_backfill-per-product-roles.sql`,
`19_init-per-product-db-grants.sql`, and `20_member-role-resolver-fn.sql` were
initially archived into this folder too, then moved back to `db_scripts/` root:
unlike 15/16, none of them assume a legacy pre-refactor shape. They're purely
additive (`IF NOT EXISTS` / `CREATE OR REPLACE` / idempotent `GRANT`/`REVOKE`) and
run correctly on a completely empty, freshly-created database — `18`'s backfill
does real work only when there's already seed/demo data carrying old-ladder
(`iam.user_org_mapping`) roles (e.g. after running `02`–`06` demo seeds), and is a
harmless no-op otherwise. They belong in the normal sequential fresh-install run,
not in a "pre-existing deployment only" bucket.
