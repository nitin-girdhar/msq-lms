#!/usr/bin/env python3
"""Discover Meta Lead Ads forms on Pages we already know about, and cache
them in ext.meta_forms.

ext.meta_tenant_config credentials are tenant-agnostic (tenant_id may be
NULL — one shared Meta app/token can serve orgs across any tenant). Routing
a form to an org is therefore never based on which "tenant" an integration
row belongs to — it's resolved purely from ext.meta_page_form_org_map's
(page_id, form_id) -> org_id data, same as the webhook path.
--tenant-id filters which orgs' *mappings* are in scope for this run (via
entity.organizations.tenant_id), not which integration/credentials are used.

For every active integration, iterates every distinct page_id already
referenced in ext.meta_page_form_org_map within scope (add a brand-new page
via --page-id) and calls Meta's GET /{page-id}/leadgen_forms.

For each form found:
  - upsert ext.meta_forms (id keyed on form_id — idempotent, safe to re-run)
  - if the form has no ext.meta_page_form_org_map row yet, but its Page
    already has exactly one distinct org mapped to it, auto-create a mapping
    row for the new form using that org (its tenant_id is derived from
    entity.organizations, not from the integration). A page shared by
    multiple orgs (e.g. one tenant's several branches all on one Facebook
    Page) is never auto-mapped — every new form on it is left unmapped and
    logged, since guessing which branch it belongs to risks routing one
    org's leads into another's CRM.

Nothing here calls any internal CRM HTTP API — DB (crm_service role) and
graph.facebook.com only.
"""

import argparse
import sys
from typing import Optional

from common import config, db, tenant_config
from common.graph_api import MetaGraphClient, MetaGraphError
from common.output import CsvWriter

log = config.setup_logging("sync_forms")


def get_known_page_ids(cur, tenant_id: Optional[str] = None) -> list:
    if tenant_id:
        cur.execute(
            """
            SELECT DISTINCT m.page_id FROM ext.meta_page_form_org_map m
            JOIN entity.organizations o ON o.id = m.org_id
            WHERE o.tenant_id = %s
            """,
            (tenant_id,),
        )
    else:
        cur.execute("SELECT DISTINCT page_id FROM ext.meta_page_form_org_map")
    return [str(row["page_id"]) for row in cur.fetchall()]


def upsert_form(cur, page_id: str, form: dict, dry_run: bool, debug_writer: CsvWriter = None) -> str:
    form_id = form["id"]
    name = form.get("name")
    status = form.get("status")
    leads_count = form.get("leads_count")
    created_time = form.get("created_time")

    if dry_run:
        log.info("  [dry-run] would upsert ext.meta_forms form_id=%s name=%r status=%s", form_id, name, status)
        return "dry_run"

    if debug_writer is not None:
        debug_writer.write(
            {
                "page_id": page_id,
                "form_id": form_id,
                "name": name,
                "status": status,
                "leads_count": leads_count,
                "meta_created_time": created_time,
            }
        )
        log.info("  [debug] wrote ext.meta_forms row to CSV form_id=%s name=%r status=%s", form_id, name, status)
        return "debug"

    # tenant_id on ext.meta_forms: best-effort context only (the table has no
    # routing role — ext.meta_page_form_org_map is the routing authority).
    # Derive it from any org already mapped to this page, if one exists.
    cur.execute(
        """
        SELECT o.tenant_id FROM ext.meta_page_form_org_map m
        JOIN entity.organizations o ON o.id = m.org_id
        WHERE m.page_id = %s LIMIT 1
        """,
        (page_id,),
    )
    tenant_row = cur.fetchone()
    tenant_id = tenant_row["tenant_id"] if tenant_row else None

    cur.execute(
        """
        INSERT INTO ext.meta_forms (tenant_id, page_id, form_id, name, status, leads_count, meta_created_time, last_synced_at)
        VALUES (%(tenant_id)s, %(page_id)s, %(form_id)s, %(name)s, %(status)s, %(leads_count)s, %(created_time)s, NOW())
        ON CONFLICT (form_id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          leads_count = EXCLUDED.leads_count,
          last_synced_at = NOW()
        RETURNING (xmax = 0) AS inserted
        """,
        {
            "tenant_id": tenant_id,
            "page_id": page_id,
            "form_id": form_id,
            "name": name,
            "status": status,
            "leads_count": leads_count,
            "created_time": created_time,
        },
    )
    return "created" if cur.fetchone()["inserted"] else "updated"


def maybe_auto_map_form(cur, page_id: str, form_id: str, dry_run: bool, debug_writer: CsvWriter = None) -> str:
    """Auto-creates a meta_page_form_org_map row for a newly-discovered form,
    using the page's existing org mapping as a fallback — mirrors
    page-org-map.service.ts::resolveOrgId's page_id fallback. Never touches
    an existing mapping row.

    Scoped by page_id only (not any tenant_id) — the mapping table itself,
    via org_id, is the single source of truth for routing; a page's org(s)
    are found by looking at who's already mapped to it, globally.

    Only auto-maps when the Page maps to exactly ONE distinct org. Several
    real orgs (e.g. Fitclass's 8 branches) intentionally share a single
    Facebook Page — for those, "most recently mapped org" is not a safe
    guess (confirmed live: it would have auto-mapped forms named
    "DEHRADUN_Valentine...", "Ashok Vihar Phase II..." etc. all to whichever
    branch happened to be mapped most recently). When a page has multiple
    distinct orgs mapped to it, every new form on that page is left
    unmapped and reported — routing must be a human decision there, not a
    guess, per the "never let a user act on another org's data" rule.
    """
    cur.execute(
        "SELECT id FROM ext.meta_page_form_org_map WHERE page_id = %s AND form_id = %s LIMIT 1",
        (page_id, form_id),
    )
    if cur.fetchone():
        return "already_mapped"

    cur.execute(
        "SELECT DISTINCT org_id FROM ext.meta_page_form_org_map WHERE page_id = %s AND is_active = true",
        (page_id,),
    )
    distinct_orgs = cur.fetchall()
    if len(distinct_orgs) != 1:
        return "no_page_fallback"

    cur.execute(
        """
        SELECT m.org_id, m.platform, o.tenant_id
        FROM ext.meta_page_form_org_map m
        JOIN entity.organizations o ON o.id = m.org_id
        WHERE m.page_id = %s AND m.is_active = true
        ORDER BY m.created_at DESC
        LIMIT 1
        """,
        (page_id,),
    )
    fallback = cur.fetchone()
    if not fallback:
        return "no_page_fallback"

    if dry_run:
        log.info(
            "  [dry-run] would auto-map form_id=%s -> org_id=%s (page fallback)", form_id, fallback["org_id"]
        )
        return "dry_run"

    if debug_writer is not None:
        debug_writer.write(
            {
                "tenant_id": fallback["tenant_id"],
                "org_id": fallback["org_id"],
                "page_id": page_id,
                "form_id": form_id,
                "platform": fallback["platform"],
            }
        )
        log.info("  [debug] wrote auto-map row to CSV form_id=%s -> org_id=%s", form_id, fallback["org_id"])
        return "debug"

    cur.execute(
        """
        INSERT INTO ext.meta_page_form_org_map (tenant_id, org_id, page_id, form_id, platform)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (page_id, form_id) DO NOTHING
        """,
        (fallback["tenant_id"], fallback["org_id"], page_id, form_id, fallback["platform"]),
    )
    return "auto_mapped"


def sync_forms(
    cur, integration: tenant_config.TenantIntegration, scope_tenant_id: Optional[str],
    extra_page_ids: list, dry_run: bool, debug: bool,
) -> dict:
    # ext.meta_tenant_config.access_token is a User/System-User token.
    # /leadgen_forms requires a Page Access Token (Meta error #190 otherwise)
    # — resolve each managed page's own token via /me/accounts first.
    user_client = MetaGraphClient(integration.access_token, integration.graph_api_version)
    try:
        page_tokens = user_client.get_managed_pages()
    except MetaGraphError as exc:
        log.error("integration=%s: could not list managed pages via /me/accounts: %s", integration.id, exc)
        return {"created": 0, "updated": 0, "auto_mapped": 0, "unmapped": 0, "errors": 1}

    page_ids = set(get_known_page_ids(cur, scope_tenant_id)) | set(extra_page_ids)

    forms_writer = CsvWriter("meta_forms") if debug else None
    mapping_writer = CsvWriter("meta_page_form_org_map_new") if debug else None

    counts = {"created": 0, "updated": 0, "auto_mapped": 0, "unmapped": 0, "errors": 0}

    for page_id in sorted(page_ids):
        page_token = page_tokens.get(str(page_id))
        if not page_token:
            log.error(
                "page=%s: not found among this token's managed Pages (/me/accounts) — "
                "check the page_id is correct and the Meta user still has access to it",
                page_id,
            )
            counts["errors"] += 1
            continue

        client = MetaGraphClient(page_token, integration.graph_api_version)
        try:
            forms = client.get_leadgen_forms(page_id)
        except MetaGraphError as exc:
            log.error("page=%s: Graph API error: %s", page_id, exc)
            counts["errors"] += 1
            continue

        log.info("page=%s: found %d form(s)", page_id, len(forms))
        for form in forms:
            result = upsert_form(cur, page_id, form, dry_run, forms_writer)
            if result in ("created", "updated"):
                counts[result] += 1

            map_result = maybe_auto_map_form(cur, page_id, form["id"], dry_run, mapping_writer)
            if map_result == "auto_mapped":
                counts["auto_mapped"] += 1
            elif map_result == "no_page_fallback":
                counts["unmapped"] += 1
                log.warning(
                    "  form_id=%s on page=%s has no unambiguous org fallback (either no org mapped to "
                    "this page yet, or multiple orgs share it) — needs manual ext.meta_page_form_org_map entry",
                    form["id"],
                    page_id,
                )

    if forms_writer:
        forms_writer.close()
    if mapping_writer:
        mapping_writer.close()

    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", help="Only sync pages already mapped to orgs in this tenant (UUID)")
    parser.add_argument("--page-id", action="append", default=[], help="Extra page_id(s) to discover forms on (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Run all reads/dedup checks against the real DB, but redirect every write to "
        "CSV files under output/ instead of committing to Postgres",
    )
    args = parser.parse_args()

    with db.transaction() as cur:
        integrations = tenant_config.list_active_integrations(cur, args.tenant_id)
        if not integrations:
            log.warning("No active ext.meta_tenant_config rows found for the given scope")
            return 0

        # In --debug mode this transaction only ever issues SELECTs (every
        # write is redirected to CSV in upsert_form/maybe_auto_map_form), so
        # committing it is a no-op against the database either way.
        total = {"created": 0, "updated": 0, "auto_mapped": 0, "unmapped": 0, "errors": 0}
        for integration in integrations:
            counts = sync_forms(cur, integration, args.tenant_id, args.page_id, args.dry_run, args.debug)
            for key in total:
                total[key] += counts[key]

    log.info(
        "Done. forms created=%d updated=%d auto_mapped=%d unmapped=%d errors=%d",
        total["created"], total["updated"], total["auto_mapped"], total["unmapped"], total["errors"],
    )
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
