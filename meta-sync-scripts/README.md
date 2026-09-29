# meta-sync-scripts

Standalone Python scripts for pulling Meta (Facebook/Instagram) Lead Ads
data on a schedule. This is a **complement to**, not a replacement for, the
real-time webhook integration in `services/meta-conversion-api` — that
service is the source of truth for field-mapping/dedup logic, and these
scripts port its logic 1:1 rather than reimplementing it.

Use these scripts to:
- backfill/catch up leads if a webhook delivery was missed
- backfill historical leads when Meta integration is turned on for a tenant
  that already has leads sitting in Meta
- discover new Lead Ads forms on a Page automatically
- repair/backfill Meta campaign metadata and campaign **types** for
  campaigns the live paths (webhook, or the admin "Fetch campaigns" button)
  have not — see `sync_campaigns.py`'s own docstring

## No new APIs, no new secrets

These scripts make **zero HTTP calls to any internal CRM service**. They
connect directly to Postgres as the `root_service` role (the same
RLS-bypass service role the Node services use) and talk to
`graph.facebook.com` directly. The only two secrets involved are ones that
already exist in this repo's infra:

- `DATABASE_URL_SERVICE` — same connection string
  `services/meta-conversion-api` uses
- `META_ENCRYPTION_KEY` — same AES-256-GCM key used to encrypt
  `ext.meta_tenant_config.app_secret` / `access_token` at rest; must match
  the Node service's key exactly, since these scripts decrypt those columns
  locally (Python port of `lib/crypto.ts`) to get a usable Meta access
  token per tenant.

Per-tenant Meta app credentials (access token, pixel id, etc.) live in
`ext.meta_tenant_config` — never in `.env` — same as the Node service.

## Setup

```bash
cd meta-sync-scripts
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env   # fill in DATABASE_URL_SERVICE / META_ENCRYPTION_KEY
```

`db_scripts/01_init-db.sql` already includes everything these scripts need
(`marketing.ad_campaigns.meta_campaign_id`,
`ext.meta_page_form_org_map.last_synced_at`, and the `ext.meta_forms`
table/view) — apply it to the target database as usual, no separate
migration needed.

## Page-first, not form-first

Meta ids are discovered, not remembered. Every script asks each **Page**
which leadgen forms it actually has right now
(`GET /{page-id}/leadgen_forms`) instead of trusting the `form_id` list
cached in `ext.meta_page_form_org_map`.

That table's form list goes stale the moment a new form is created — and
forms are created constantly (one Page here carries 98 of them). Pages and
ad accounts also get reorganised Meta-side: the Fitclass branches were
originally all on one shared Page and now each have their own. A
`form_id`-driven sync silently stops seeing leads at that point, which is
exactly what happened — lead sync went dead after **2026-07-28**.

`ext.meta_page_form_org_map` remains the **routing authority**: a discovered
form with no active mapping row is reported and skipped, never guessed into
an org. Use `sync_forms.py` (which auto-maps a new form when its Page has
exactly one org) or add the row by hand, then re-run.

Leads are additionally restricted by `--since` (default **2026-07-28**, the
reorganisation date), sent as Meta's `filtering` param on `time_created` and
re-applied client-side — the `/leads` edge has been seen ignoring it, so it
is treated as an optimisation only, never as a correctness guarantee.

## Scripts

### Unattended (cron)

Run in this order, or all together via `run_all.py`:

| Script | What it does |
|---|---|
| `sync_forms.py` | Discovers Lead Ads forms on every Page already referenced in `ext.meta_page_form_org_map`, caches them in `ext.meta_forms`, and auto-creates a mapping row for a newly-seen form when its Page already has an unambiguous org mapping. Forms with no page fallback are logged as needing a manual mapping. |
| `sync_campaigns.py` | **Repair/backfill, not campaign creation** — see its own docstring. For every `(org, meta campaign_id)` pair seen in `ext.meta_leads` with no `marketing.ad_campaigns` row yet (this includes campaigns that predate campaign types entirely), fetches name/objective/status via the Graph API, upserts `ext.meta_campaigns` (re-running the keyword matcher, **never** overwriting a `confirmed` mapping), upserts `marketing.ad_campaigns` carrying the resolved `campaign_type_id`, and backfills `lms.marketing_leads.campaign_id` on any already-existing Meta leads missing it. |
| `sync_leads.py` | The main puller — for every Page in scope, discovers its live forms, pages through `GET /{form_id}/leads` since `--since` for each **mapped** one, skips anything already in `ext.meta_leads` (dedup on `meta_lead_id`), and writes new leads through the same logic `intake.repository.ts::createWebhookLead` uses (dedup by phone/email, campaign + campaign-**type** resolution via `common/campaign_resolution.py`, weighted auto-assign scoped to that type's pool), then the `ext.meta_leads` + child rows. Unmapped forms are counted and logged. |
| `run_all.py` | Runs the three in order (forms → campaigns → leads) — the single entry point for a cron job. |

### Campaign + type resolution (`common/campaign_resolution.py`)

Statement-for-statement port of `campaign-mapping.service.ts::resolveCampaignType`
(meta-conversion-api) combined with `campaign-resolution.ts::resolveCampaignForLead`
(leads-service) — the two TypeScript services split this by ownership boundary
(one holds the Graph token and `ext.*`, the other never reads `ext.*`); this
package has no such boundary, so one module does both. `common/lead_writer.py`
calls it before auto-assignment: which **pool** a lead belongs to is an input
to who receives it, not a label applied afterwards.

The actual type-matching decision — does this campaign name imply `sales`,
`hiring`, or something else — is made **exclusively** by calling
`marketing.fn_match_campaign_type()` in SQL. That function exists precisely so
this Python path and the TypeScript path cannot drift on what "a hiring
campaign" means; nothing here reimplements keyword matching.

A brand-new campaign discovered via `sync_leads.py` / `import_downloaded_leads.py`
rarely has a name available (`GET /{form-id}/leads` doesn't return one), so it
is seeded into `ext.meta_campaigns` as `unmapped` with a placeholder name —
exactly the same degraded-but-safe path the TypeScript takes when its own
Graph metadata lookup fails or is skipped. A later `sync_campaigns.py` run
fetches the real name and re-types it.

### Reviewable backfill (download → check → import)

For anything you want to eyeball before it touches the database — a
recovery after a Meta-side reorg, or a first backfill for a new org. Each
stage reads the previous stage's files, so what you review is exactly what
gets written:

| Script | What it does |
|---|---|
| `download_page_leads.py` | **Stage 1.** Downloads every live form and its leads (since `--since`) for every Page in scope into a fresh `output/<run>/`. Opens the DB **read-only** — it cannot write even by accident. |
| `check_leads_against_db.py` | **Stage 2.** Reconciles that run against the local DB and reports, per lead, exactly what the import would do: `new`, `already_synced`, `unmapped_form`, `test_lead`, `hiring_form`, `phone_duplicate`, `email_duplicate`, `missing_contact`. Read-only; always exits 0. |
| `import_downloaded_leads.py` | **Stage 3.** Writes the importable leads from that same run, re-classifying each against the live DB first (the dump may be hours old). Never imports an `unmapped_form` lead. |

`output/<run>/` contains:

| File | Contents |
|---|---|
| `page_<page_id>_raw.json` | Verbatim Graph payloads — forms + leads. The import stage's only input. |
| `leads_downloaded.csv` | Flat review sheet: page, form, mapping status, org, lead id, created_time, name/phone/email. |
| `forms_discovered.csv` | Every live form per page with its mapping status and lead count since the cutoff. |
| `unmapped_forms.csv` | The action list — forms needing an `ext.meta_page_form_org_map` row, with the orgs already on that page as candidates. |
| `reconciliation.csv` / `reconciliation_summary.csv` | Stage 2 output: per-lead verdicts, and counts per form. |
| `manifest.json` | The run's `--since`, pages covered, and totals. |

### What never reaches the org

Two filters in `common/reconcile.py::classify` decide this once, so the
preview and the import can never disagree:

| Verdict | Rule |
| --- | --- |
| `test_lead` | Any field value matching `/test lead:/i` — Meta stamps this placeholder in when someone uses the Lead Ads Testing Tool. Mirrors `isMetaTestLead()` in `services/meta-conversion-api/src/services/lead-sync.service.ts`. The webhook always skipped these; this path did not, which is how 20 of them reached production as real leads. |
| `unmapped_form` | No active `ext.meta_page_form_org_map` row — never guessed into an org. |

Neither is in `IMPORTABLE`, so stage 3 skips them.

**Recruitment-form leads are no longer a third filter.** Before campaign
types, a `hiring_form` verdict (a regex on the form name — `hiring`,
`recruit`, `vacancy`, `career`, `job application`, `sales exe`) dropped these
leads outright, because there was nowhere to route them. Campaign types close
that gap: a hiring lead is now classified and imported like any other lead,
routed to the branch's HR pool by `common/campaign_resolution.py` (via the
campaign name's keyword match, or the form's own
`default_campaign_type_id`). The old regex survives as
`reconcile.is_hiring_form()` — no longer a skip, now a display-only signal —
and every row in `reconciliation.csv` also carries
`suggested_campaign_type_id` (`marketing.fn_match_campaign_type()` run
against the form name), so a reviewer can see which forms look like
recruitment and set `default_campaign_type_id` on them accordingly. A
TypeScript port of this same module
(`services/meta-conversion-api/src/services/lead-reconcile.service.ts`, for
the admin "Meta lead pull" screen) made the identical change first; this
brings the Python CLI path in step with it.

### Tenant-scoped lookups — always resolve via `org_id`

`lms.lead_stage`, `lms.lead_sources`, `marketing.marketing_platforms` and
`marketing.campaign_statuses` are tenant-scoped (N-6 Half B, `08_rls.sql`).
Every tenant carries its own `new` stage and its own `facebook` / `instagram`
source rows — same `name`, different `id`, different `tenant_id`.

This package connects as `root_service` (**BYPASSRLS**), so nothing narrows a
lookup for you. A bare `SELECT id FROM lms.lead_sources WHERE name = %s LIMIT 1`
returns whichever tenant's row Postgres reaches first. Always join through the
row's own tenant:

```sql
SELECT id FROM lms.lead_sources
WHERE name = %(name)s
  AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s)
LIMIT 1
```

`common/lead_writer.py` did not, and stamped 19 Gurugram leads (Civil Lines and
Sector 104, 8 Jul – 6 Aug 2026) with a foreign tenant's `stage_id` / `source_id`.
Those leads read back with an empty Status and Source in the UI: the leads grid
joins these tables *under* RLS, scoped to the caller's tenant, so a foreign id
matches nothing. Repair script:
`db_scripts/one_time/fix_cross_tenant_lead_stage_source.sql` (dry-run pair
alongside it).

### Phone normalisation

Meta returns whatever the person typed: `+919876543210`, `9876543210`,
`09876543210`, `+91 98765 43210`. Every dedup check used to be raw string
equality, so the same person in two formats became two active leads in the
same branch — production carries 45 such groups.

`common/phone.py` splits this in two:

- `normalize()` decides what is **stored** — E.164 when the value is
  confidently an Indian mobile (10 digits starting 6-9, optionally prefixed
  `0`/`91`/`+91`), otherwise returned untouched. Junk like `00000` or a test
  placeholder is never "cleaned" into something that looks real.
- `match_key()` decides what is **compared** — the last 10 significant
  digits, or `None` when there are fewer than 10. `None` means "match on the
  exact string instead", so short/garbage numbers stay distinct rather than
  all collapsing onto one key.

Both the dedup lookup and the INSERT go through these, so a number already
on file in a different format is found rather than inserted again.

`output/latest.txt` records the newest run, so stages 2 and 3 find it
without being told; pass `--run-dir` to target an older one.

### Common flags

- `--tenant-id <uuid>` — scope to one tenant
- `--org-id <uuid>` — scope to one org (`sync_campaigns.py` / `sync_leads.py`)
- `--page-id <id>` — add a Page beyond those in the mapping table (repeatable)
- `--since <date>` — only leads created at/after this date (`sync_leads.py`,
  `download_page_leads.py`, `run_all.py`); defaults to `2026-07-28`
- `--max-pages <n>` — hard cap on Graph pages fetched per form (100 leads
  each); a form that hits the cap is logged as truncated
- `--dry-run` — log what would happen; touches nothing (no DB write, no CSV)
- `--debug` — run all reads/dedup checks against the real database (so the
  preview reflects current state), but redirect every write to CSV files
  under `output/` instead of committing to Postgres. Each named CSV is
  overwritten at the start of a run. Use this to review exactly what a real
  run would write before letting it touch the database.

### Examples

```bash
# Reviewable backfill of everything since the Meta-side reorg
python download_page_leads.py --since 2026-07-28
python check_leads_against_db.py            # read the verdicts

# Scope a run to one tenant (Fitclass) — page discovery is filtered by the
# mapped org's tenant, so another tenant's Pages are never touched.
python download_page_leads.py --tenant-id 0b39b589-ea7d-446a-b660-350e1d84ebd9 --since 2026-08-01
python check_leads_against_db.py --tenant-id 0b39b589-ea7d-446a-b660-350e1d84ebd9
python import_downloaded_leads.py --dry-run # confirm, then drop --dry-run

# Import one page only (recommended for large backfills — see Transaction scope)
python import_downloaded_leads.py --page-id 1255862330933964

# Preview only, logs to stdout
python sync_forms.py --dry-run --tenant-id 11111111-...

# Preview with full data written to output/*.csv for review
python sync_leads.py --debug --tenant-id 11111111-...

# Cron entry (all active tenants)
python run_all.py
```

## Transaction scope

Each script runs its entire scope (all matched tenants/forms/campaigns) as
**one database transaction** — nothing is committed until the whole run
finishes without an unhandled error. This keeps things simple and, combined
with idempotency below, makes a failed run always safe to just re-run: nothing
partial was ever persisted. The trade-off is that one bad record (e.g. a
malformed lead, or a Graph API/lookup failure that isn't a caught
`MetaGraphError`) can block that entire run's writes. If you need
per-tenant or per-form commit granularity for very large backfills, scope
each run with `--tenant-id`/`--org-id`/`--page-id`/`--form-id` rather than
running unscoped across everything at once.

`download_page_leads.py` and `check_leads_against_db.py` open the connection
read-only, so they never enter this discussion at all.

## Idempotency

Every write is a check-then-skip or `ON CONFLICT` upsert keyed on an
existing (or newly added) unique constraint — `uq_meta_leads_meta_lead_id`,
`uq_meta_page_form_org_map`, `uix_ad_campaigns_org_meta_campaign_id`,
`uq_meta_campaigns_campaign_id`, `ext.meta_forms.form_id`. Running any script
(or `run_all.py`) twice in a
row, or two overlapping cron runs firing at once, produces **zero**
duplicate leads/forms/campaigns. Each script logs a `skipped (already
exists)` line per record it declines to (re)create.

`import_downloaded_leads.py` re-runs the full classification against the
live database before every write rather than trusting the downloaded
snapshot, so re-importing the same run after adding a form mapping picks up
only the newly-routable leads.
