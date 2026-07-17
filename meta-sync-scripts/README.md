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
connect directly to Postgres as the `crm_service` role (the same
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

## Scripts

Run in this order (or all together via `run_all.py`):

| Script | What it does |
|---|---|
| `sync_forms.py` | Discovers Lead Ads forms on every Page already referenced in `ext.meta_page_form_org_map`, caches them in `ext.meta_forms`, and auto-creates a mapping row for a newly-seen form when its Page already has an unambiguous org mapping. Forms with no page fallback are logged as needing a manual mapping. |
| `sync_campaigns.py` | Finds every `(org, meta campaign_id)` pair seen in `ext.meta_leads` that isn't yet in `marketing.ad_campaigns`, resolves name/status via the Graph API, upserts it, and backfills `crm.marketing_leads.campaign_id` on any already-existing Meta leads missing it. |
| `sync_leads.py` | The main puller — pages through `GET /{form_id}/leads` for every active mapping, skips anything already in `ext.meta_leads` (dedup on `meta_lead_id`), and writes new leads through the same logic `intake.repository.ts::createWebhookLead` uses (dedup by phone/email, weighted auto-assign, `campaign_id` when resolvable), then the `ext.meta_leads` + child rows. |
| `run_all.py` | Runs the three in order (forms → campaigns → leads) — the single entry point for a cron job. |

### Common flags (all scripts)

- `--tenant-id <uuid>` — scope to one tenant
- `--org-id <uuid>` — scope to one org (`sync_campaigns.py` / `sync_leads.py` only)
- `--dry-run` — log what would happen; touches nothing (no DB write, no CSV)
- `--debug` — run all reads/dedup checks against the real database (so the
  preview reflects current state), but redirect every write to CSV files
  under `output/` instead of committing to Postgres. Each named CSV is
  overwritten at the start of a run. Use this to review exactly what a real
  run would write before letting it touch the database.

`sync_leads.py` also has `--form-id`, `--max-pages` (default 20, hard cap
per form per run), and `--stop-after-dupes` (default 5 — stop paging a form
once this many consecutive already-synced leads are seen, since Meta's
`/leads` edge doesn't reliably support server-side `since` filtering).

### Examples

```bash
# Preview only, logs to stdout
python sync_forms.py --dry-run --tenant-id 11111111-...

# Preview with full data written to output/*.csv for review
python sync_leads.py --debug --tenant-id 11111111-...

# Real run, single tenant
python run_all.py --tenant-id 11111111-...

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
each run with `--tenant-id`/`--org-id`/`--form-id` rather than running
unscoped across everything at once.

## Idempotency

Every write is a check-then-skip or `ON CONFLICT` upsert keyed on an
existing (or newly added) unique constraint — `uq_meta_leads_meta_lead_id`,
`uq_meta_page_form_org_map`, `uix_ad_campaigns_org_meta_campaign_id`,
`ext.meta_forms.form_id`. Running any script (or `run_all.py`) twice in a
row, or two overlapping cron runs firing at once, produces **zero**
duplicate leads/forms/campaigns. Each script logs a `skipped (already
exists)` line per record it declines to (re)create.
