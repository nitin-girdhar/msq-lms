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

## The routing model — how an inbound lead finds an owner

Three questions, answered in this order, every time a lead is created:

**1. Which BRANCH?** For a Meta lead, `ext.meta_page_form_org_map` maps the
page/form to an org (an exact `form_id` row beats the page-level fallback).
For the public API, the gateway's API key binding decides. Resolved before
leads-service is called.

**2. Which POOL?** `lib/campaign-resolution.ts::resolveCampaignForLead` resolves
a `campaign_type_id` — `sales`, `hiring`, or whatever else the tenant has in
`marketing.campaign_types` — most specific first:

  1. the type the caller supplied (**meta-conversion-api** owns the
     `ext.meta_campaigns` campaign → type mapping and passes the answer in);
  2. the page/form default, likewise passed in;
  3. the tenant's `is_default` type — walk-ins, the public API, manual creation.

A caller-supplied type that does not belong to the org's tenant is a **400**,
never quietly swapped for the default.

**leads-service does not read `ext.*`.** That schema belongs to
meta-conversion-api, which holds the Graph token. Keeping that line is why
steps 1 and 2 are parameters rather than lookups, and it is what lets the two
services stay separable.

If the lead carries a `meta_campaign_id`, this step also creates that branch's
`marketing.ad_campaigns` projection on first sight — `ON CONFLICT ... DO NOTHING`
plus a re-select, because concurrent webhook deliveries for a new campaign race.

**3. Which PERSON?** `lib/assignment.ts::resolveAutoAssignedUser(tx, orgId,
campaignTypeId)` picks from that **(branch x type)** pool only —
`lms.lead_assignment_weights` is keyed on `(user_org_mapping_id,
campaign_type_id)`, so the same person can sit in their branch's sales rotation
at 40% and its hiring rotation at 0%. Deficit-based weighted round-robin, with
the **open-workload count scoped to the same pool**: measuring a rep's whole
open book instead would let a large sales backlog starve them of hiring leads.

Weights follow the **role's department** (1.50.2): a weight only counts when the
member's role department equals the campaign type's department, the same rule
row-level visibility uses, so nobody is handed a lead they cannot see. New
out-of-department weights are refused; pre-existing ones are kept but skipped.

It returns `{ userId, reason }`, not a bare `null` — `reason` is one of
`assigned`, `no_weighted_users`, `no_department_match` or `no_capable_users`.
When it is not `'assigned'`, every creation path logs `lead.autoassign_skipped`
with the org, the type and the reason — the fix for a silent failure in which 10
of 30 branches had no weighted user and nobody noticed for a long time. Leads
left unassigned can be re-routed after the pool is fixed from lookup-admin's
**Re-run Auto-Assignment** screen (`POST /lead-assignment/rerun`, super admin,
dry run first).

**Visibility is the database's job.** Whether a user may see a typed lead at all
is decided by `lms.fn_user_sees_campaign_type()` inside `lms.marketing_leads`'
RLS `USING` clause — not by any service. The `campaign_type_ids` filter on
`GET /leads` and `GET /assignments/mine` only narrows what the caller already
sees. Do not re-implement that rule in a repository.

### Campaign lifecycle

```
Meta campaign discovered (ad-account fetch, or first lead carrying its id)
  -> ext.meta_campaigns row created in ONE statement, already typed by the
     keyword match (marketing.fn_match_campaign_type, in SQL so the TS and
     Python intake paths cannot drift):
       a keyword fired -> 'suggested', matched_keyword says which
       nothing fired  -> 'unmapped', typed from the form default, then the
                         tenant default -- the lead still routes
  -> an admin confirms in the console                        -> 'confirmed'
       (a confirmed mapping is never overwritten by a later fetch or sync)
  -> meta-conversion-api calls POST /internal/campaign-reclassify
       dry_run: true   -> impact preview for the confirm dialog
       dry_run: false  -> relabel every branch's campaign + leads, and
                          conservatively re-route the untouched ones
  -> inbound leads carry the type from then on, and route to that pool
```

**Reclassify is deliberately conservative.** It relabels everything, but only
*moves* a lead that is still auto-assigned, untouched by a person, in an open
stage, has zero interactions, **and** whose current owner holds no weight for
the new type in that branch. A lead someone has already called stays with them
and only its label is corrected. These conditions were agreed with the product
owner — do not widen them.

Managing the catalog itself: `GET/POST/PATCH/DELETE /campaign-types`, gated on
`lms.campaign_types.view` / `.manage`. **By capability, never by role name.**

Managing the campaign → type MAPPING (meta-conversion-api, super_admin,
explicit `?tenant_id=` on every route — never the caller's own tenant):
`GET /meta/campaigns` (the three grids, with a per-campaign lead count),
`POST /meta/campaigns/sync` (the Fetch button — walks
`ext.meta_tenant_config.ad_account_ids`; the Graph token needs `ads_read`), and
`PATCH /meta/campaigns/:metaCampaignId` (confirm/correct, then fan out;
`?dry_run=true` previews and writes **nothing** — not the mapping, not the
keyword, not the reclassification).

**Routing never waits for a human.** A `suggested` mapping routes exactly like a
`confirmed` one. And a Graph failure never fails a lead: the name lookup is
best-effort, and a throttled one leaves the row `unmapped` with a
`webhook.campaign_name_fetch_failed` warning while the lead is still created and
routed.

See `docs/Architecture.md` → *Weighted auto-assignment* and *Campaign-type
routing* for the full rules, and `docs/DB_model.md` for the tables.

**The Python batch path (`meta-sync-scripts/`) implements the same model, not
a separate one.** `common/campaign_resolution.py` is a statement-for-statement
port of `campaign-mapping.service.ts` + `campaign-resolution.ts` above, and
`common/lead_writer.py::resolve_auto_assigned_user` is the same port of
`lib/assignment.ts` this doc already describes — both call
`marketing.fn_match_campaign_type()` rather than reimplementing the keyword
match, precisely so a lead ingested by the webhook or by `sync_leads.py`
resolves to the identical type and pool. `sync_campaigns.py` is the batch
counterpart of the admin's "Fetch campaigns" button (repair/backfill, not
creation) and carries the same confirmed-mapping invariant. See
`meta-sync-scripts/README.md` for that side.

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
