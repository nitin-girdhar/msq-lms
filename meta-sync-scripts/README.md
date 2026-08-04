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
- resolve Meta campaign metadata so the "Campaign" field on the lead edit
  screen is populated for Meta-sourced leads

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
| `sync_campaigns.py` | Finds every `(org, meta campaign_id)` pair seen in `ext.meta_leads` that isn't yet in `marketing.ad_campaigns`, resolves name/status via the Graph API, upserts it, and backfills `lms.marketing_leads.campaign_id` on any already-existing Meta leads missing it. |
| `sync_leads.py` | The main puller — for every Page in scope, discovers its live forms, pages through `GET /{form_id}/leads` since `--since` for each **mapped** one, skips anything already in `ext.meta_leads` (dedup on `meta_lead_id`), and writes new leads through the same logic `intake.repository.ts::createWebhookLead` uses (dedup by phone/email, weighted auto-assign, `campaign_id` when resolvable), then the `ext.meta_leads` + child rows. Unmapped forms are counted and logged. |
| `run_all.py` | Runs the three in order (forms → campaigns → leads) — the single entry point for a cron job. |

### Reviewable backfill (download → check → import)

For anything you want to eyeball before it touches the database — a
recovery after a Meta-side reorg, or a first backfill for a new org. Each
stage reads the previous stage's files, so what you review is exactly what
gets written:

| Script | What it does |
|---|---|
| `download_page_leads.py` | **Stage 1.** Downloads every live form and its leads (since `--since`) for every Page in scope into a fresh `output/<run>/`. Opens the DB **read-only** — it cannot write even by accident. |
| `check_leads_against_db.py` | **Stage 2.** Reconciles that run against the local DB and reports, per lead, exactly what the import would do: `new`, `already_synced`, `unmapped_form`, `phone_duplicate`, `email_duplicate`, `missing_contact`. Read-only; always exits 0. |
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
`ext.meta_forms.form_id`. Running any script (or `run_all.py`) twice in a
row, or two overlapping cron runs firing at once, produces **zero**
duplicate leads/forms/campaigns. Each script logs a `skipped (already
exists)` line per record it declines to (re)create.

`import_downloaded_leads.py` re-runs the full classification against the
live database before every write rather than trusting the downloaded
snapshot, so re-importing the same run after adding a form mapping picks up
only the newly-routable leads.
