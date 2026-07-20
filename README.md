# msq-lms — Lead Management System (LMS)

Extracted from the `msq-platforms` monorepo per `docs/Phase5_Extraction_Plan.md`
(§2b). Owns: `leads-service`, `meta-conversion-api`, `notifications-service`,
`lms-web`, the `@lms/*` packages, `meta-sync-scripts/`, and the `lms`/
`marketing`/`ext` DB schemas.

**Depends on `@platform/*` from `msq-core`** — clone this repo as a `msq-lms/`
subfolder inside `msq-core` (see `msq-core`'s README), which doubles as the
parent pnpm workspace root (D5 Stage 1). Not buildable in isolation:
standalone `pnpm install`/`typecheck` in this repo alone fails to resolve
`@platform/db`, `@platform/authz`, etc.

## Status — Stage D extraction in progress, known gaps

- **Cannot bootstrap a database alone.** `db_scripts/01_init-db.sql` and the
  other files here are still schema-interleaved with `msq-core`'s `iam`/
  `entity`/`geo`/`audit` DDL (splitting correctly needs a live DB to verify
  against — same call made for `msq-core`). Run `msq-core`'s
  `db_deploy.ps1` first against the target database; this repo's
  `db_deploy.ps1` only adds the LMS-specific demo-seed/tenant-scoping scripts
  on top.
- **The Drizzle table-type split (§4 of the extraction plan) has not been
  done.** `lms`/`marketing`/`ext` table definitions still live in
  `msq-core`'s `packages/db/src/schema/`, not in this repo. Every
  `from '@platform/db/schema'` product-table import in `leads-service`/
  `meta-conversion-api`/`notifications-service` (41+8 sites per the plan)
  still points at `msq-core`. This is architecturally wrong long-term (D8:
  product-owned schemas) but functionally works today via the parent
  workspace symlink. Moving these into a local `@lms/db-schema` package is a
  substantial, separately-scoped follow-up — not attempted in this pass.
- **Cross-repo Docker networking is not wired** (same gap as `msq-core`) —
  `docker-compose.yml` here has no `postgres`/`api-gateway`/`identity-service`
  of its own; it assumes those are reachable via env vars pointing at
  `msq-core`'s containers.
- **Docker image builds need `msq-core`'s root as build context**, not this
  repo alone — e.g. `docker build -f msq-lms/services/leads-service/Dockerfile .`
  run from `msq-core/`. Verified working this way.
- **`turbo`/`depcruise`/`lint` need this repo's own `pnpm install`, which
  breaks `@platform/*` resolution.** The parent workspace (`msq-core/pnpm-workspace.yaml`)
  only globs each repo's `packages/*`/`services/*`/`apps/*`, not the repo
  root — so a parent-level `pnpm install` never installs this repo's root
  `devDependencies` (`turbo`, `dependency-cruiser`, `typescript`). Running
  `pnpm install` from *inside* this repo instead uses its own
  `pnpm-workspace.yaml` (found before the parent's, walking up), which can't
  see `msq-core`'s `@platform/*` packages. Verified in this pass via
  `pnpm --filter "./msq-lms/**" run build|typecheck` from `msq-core`'s root
  instead — that works (all 7 packages build/typecheck clean) but bypasses
  `turbo`'s task graph and this repo's own `depcruise`/`lint` scripts
  entirely. A real fix (shared devDependency hoisting strategy, or each
  repo's CI installing standalone against published `@platform/*` once
  Stage 2/3 lands) is a tracked follow-up, not solved here.

## Local dev (Stage 1 — pnpm workspace, no registry)

```
make install
make dev   # requires msq-core's `make dev-infra` + `make dev` already running
```

Note: `make install` runs plain `pnpm install`, which — per the gap above —
should be run from `msq-core`'s root, not from inside this repo alone, until
the tooling gap is resolved.
