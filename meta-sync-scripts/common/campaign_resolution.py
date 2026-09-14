"""Bare-SQL port of the campaign -> TYPE resolution used on the live lead path.

Ports, statement-for-statement:
  services/meta-conversion-api/src/services/campaign-mapping.service.ts
    (resolveCampaignType, matchCampaignType)
  services/leads-service/src/lib/campaign-resolution.ts
    (resolveCampaignForLead, ensureBranchCampaign, tenantDefaultType)

The TypeScript splits this across two services (meta-conversion-api owns
ext.meta_campaigns and the Graph token; leads-service never reads ext.* and
receives an already-resolved type as an argument). This package has no such
service boundary -- one root_service connection can see both schemas -- so
the two are combined into one module here. Behaviour is unchanged: the same
queries run in the same order, and the routing DECISION (which type a name
implies) is made by calling marketing.fn_match_campaign_type(), never by
Python-side keyword matching. That function lives in SQL specifically so
this path and the TypeScript path cannot drift on what "a hiring campaign"
means -- see db_scripts/04_functions_triggers.sql.
"""

import logging
from typing import Any, Dict, Optional, Tuple

log = logging.getLogger("campaign_resolution")

# Mirrors PLATFORM_MAP/STATUS_MAP in sync_campaigns.py and the two TypeScript
# copies (campaign-sync.service.ts, leads-service's campaign-resolution.ts).
# All four must agree, since each creates the same marketing.ad_campaigns row.
PLATFORM_MAP = {"fb": "facebook", "ig": "instagram"}
DEFAULT_PLATFORM_NAME = "facebook"

STATUS_MAP = {
    "ACTIVE": "active",
    "PAUSED": "paused",
    "CAMPAIGN_PAUSED": "paused",
    "ADSET_PAUSED": "paused",
    "ARCHIVED": "archived",
    "DELETED": "archived",
    "IN_PROCESS": "draft",
    "WITH_ISSUES": "draft",
    "PENDING_REVIEW": "draft",
    "DISAPPROVED": "draft",
}
DEFAULT_STATUS_NAME = "draft"

# WHICH keyword fired, for the admin grid — a DISPLAY-only value. The actual
# routing decision (which TYPE wins) is made exclusively by calling
# marketing.fn_match_campaign_type(); this snippet is copied verbatim from
# that function's own predicate (04_functions_triggers.sql) rather than
# re-derived, so it cannot itself cause a routing divergence. Shared by
# match_campaign_type() below and sync_campaigns.py's ext.meta_campaigns
# upsert, both of which need it alongside a call to fn_match_campaign_type in
# the same statement (mirrors campaign-mapping.service.ts's KEYWORD_MATCH_SQL,
# reused the same way by campaign-sync.service.ts's upsertCampaign).
# Expects a `%(name)s` parameter and a `ct` alias on marketing.campaign_types
# in scope.
KEYWORD_MATCH_SQL_SNIPPET = r"""(
        SELECT kw
        FROM unnest(ct.match_keywords) AS kw
        WHERE kw <> ''
          AND %(name)s ~* ('(^|[^[:alnum:]])'
                || regexp_replace(kw, '([^[:alnum:]])', '\\\1', 'g')
                || '([^[:alnum:]]|$)')
        ORDER BY length(kw) DESC, kw ASC
        LIMIT 1
    )"""


def tenant_default_type(cur, tenant_id: str) -> Optional[str]:
    """The tenant's catch-all pool. Direct port of tenantDefaultType (both
    TypeScript copies). At most one per tenant (uix_campaign_types_one_default)."""
    cur.execute(
        """
        SELECT id FROM marketing.campaign_types
        WHERE tenant_id = %(tenant_id)s AND is_default AND is_active AND NOT is_deleted
        LIMIT 1
        """,
        {"tenant_id": tenant_id},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def match_campaign_type(cur, tenant_id: str, campaign_name: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """The type a NAME implies, plus the keyword that said so. Direct port of
    matchCampaignType. Both null when nothing matched -- a real answer, not a
    failure.

    THE TYPE ITSELF comes from calling marketing.fn_match_campaign_type() --
    never reimplemented here. matched_keyword is a DISPLAY-only value for the
    admin grid (same as campaign-mapping.service.ts's KEYWORD_MATCH_SQL): the
    regexp_replace escaping below is copied verbatim from that function's own
    predicate (04_functions_triggers.sql) rather than re-derived, so nothing
    routes on it and it cannot itself cause a routing divergence.
    """
    if not campaign_name:
        return None, None

    cur.execute(
        f"""
        SELECT ct.id AS campaign_type_id,
               {KEYWORD_MATCH_SQL_SNIPPET} AS matched_keyword
        FROM marketing.campaign_types ct
        WHERE ct.id = marketing.fn_match_campaign_type(%(tenant_id)s::uuid, %(name)s)
        LIMIT 1
        """,
        {"name": campaign_name, "tenant_id": tenant_id},
    )
    row = cur.fetchone()
    if not row:
        return None, None
    return row["campaign_type_id"], row["matched_keyword"]


def resolve_campaign_type(
    cur,
    tenant_id: str,
    meta_campaign_id: int,
    meta_campaign_name: Optional[str] = None,
    meta_campaign_objective: Optional[str] = None,
    meta_campaign_status: Optional[str] = None,
    form_default_campaign_type_id: Optional[str] = None,
) -> Dict[str, Any]:
    """The campaign's type, creating the ext.meta_campaigns mapping row when the
    campaign is new. Direct port of resolveCampaignType.

    HIT -- the row already exists: return its type, 'confirmed' or 'suggested'
    alike (a suggested mapping routes exactly like a confirmed one -- routing
    never waits for a human). No re-match.

    MISS -- insert it, typed by marketing.fn_match_campaign_type: a keyword
    match -> 'suggested'; nothing matched -> 'unmapped', falling back to the
    form default and then the tenant default so the lead still routes
    somewhere sane while the row sits in the admin's "needs mapping" grid.

    form_default_campaign_type_id is ext.meta_page_form_org_map.default_campaign_type_id
    for the page/form this lead arrived on -- resolved by the caller (it
    already has the mapping row loaded), rather than re-queried here.
    """
    # The mapped type's liveness travels with the row, exactly as in
    # campaign-mapping.service.ts: a deactivated or deleted type must not be
    # used, and an untyped back-catalogue row must not leave the lead unassigned.
    cur.execute(
        """
        SELECT mc.tenant_id,
               mc.campaign_type_id,
               (ct.id IS NOT NULL AND ct.is_active AND NOT ct.is_deleted) AS type_is_live,
               mc.mapping_status,
               mc.matched_keyword
        FROM ext.meta_campaigns mc
        LEFT JOIN marketing.campaign_types ct ON ct.id = mc.campaign_type_id
        WHERE mc.meta_campaign_id = %(meta_campaign_id)s
        LIMIT 1
        """,
        {"meta_campaign_id": meta_campaign_id},
    )
    hit = cur.fetchone()

    if hit:
        if str(hit["tenant_id"]) != str(tenant_id):
            # A shared ad account reaching two tenants. The row belongs to the
            # other one and must not be read as this tenant's mapping (nor
            # overwritten). The lead still routes, on the defaults.
            return {
                "campaign_type_id": form_default_campaign_type_id or tenant_default_type(cur, tenant_id),
                "mapping_status": "unmapped",
                "matched_keyword": None,
                "created": False,
            }
        if hit["campaign_type_id"] and hit["type_is_live"]:
            return {
                "campaign_type_id": hit["campaign_type_id"],
                "mapping_status": hit["mapping_status"],
                "matched_keyword": hit["matched_keyword"],
                "created": False,
            }
        # Untyped (every back-catalogue row seeded by backfill_campaign_types.sql)
        # or mapped to a retired pool. Returning the hit's type here left the lead
        # UNASSIGNED while the webhook routed the same lead to the default pool --
        # the two ingest paths disagreeing is exactly what this module exists to
        # prevent. Fall through to the same ladder as an unmatched new campaign.
        if hit["campaign_type_id"]:
            log.warning(
                "campaign %s is mapped to inactive campaign type %s; typing lead from the form/tenant default",
                meta_campaign_id, hit["campaign_type_id"],
            )
        return {
            "campaign_type_id": form_default_campaign_type_id or tenant_default_type(cur, tenant_id),
            "mapping_status": hit["mapping_status"],
            "matched_keyword": None,
            "created": False,
        }

    name = (meta_campaign_name or "").strip() or None
    matched_type_id, matched_keyword = match_campaign_type(cur, tenant_id, name)
    status = "suggested" if matched_type_id else "unmapped"
    fallback = None if matched_type_id else (form_default_campaign_type_id or tenant_default_type(cur, tenant_id))
    campaign_type_id = matched_type_id or fallback

    # ON CONFLICT DO NOTHING then re-select, never a bare INSERT: a webhook
    # delivery for the same brand-new campaign can commit between this
    # process's read and write, and a bare INSERT would turn that race into a
    # 23505 that fails an otherwise good lead.
    cur.execute(
        """
        INSERT INTO ext.meta_campaigns (
            tenant_id, meta_campaign_id, name, objective, effective_status,
            campaign_type_id, mapping_status, matched_keyword, first_seen_source, last_synced_at
        ) VALUES (
            %(tenant_id)s, %(meta_campaign_id)s, %(name)s, %(objective)s, %(status)s,
            %(campaign_type_id)s, %(mapping_status)s, %(matched_keyword)s, 'lead', NOW()
        )
        ON CONFLICT (meta_campaign_id) DO NOTHING
        """,
        {
            "tenant_id": tenant_id,
            "meta_campaign_id": meta_campaign_id,
            "name": name,
            "objective": meta_campaign_objective,
            "status": meta_campaign_status,
            "campaign_type_id": campaign_type_id,
            "mapping_status": status,
            "matched_keyword": matched_keyword,
        },
    )

    cur.execute(
        """
        SELECT tenant_id, campaign_type_id, mapping_status, matched_keyword
        FROM ext.meta_campaigns
        WHERE meta_campaign_id = %(meta_campaign_id)s
        LIMIT 1
        """,
        {"meta_campaign_id": meta_campaign_id},
    )
    settled = cur.fetchone()
    if not settled or str(settled["tenant_id"]) != str(tenant_id):
        return {
            "campaign_type_id": campaign_type_id,
            "mapping_status": status,
            "matched_keyword": matched_keyword,
            "created": False,
        }

    return {
        "campaign_type_id": settled["campaign_type_id"],
        "mapping_status": settled["mapping_status"],
        "matched_keyword": settled["matched_keyword"],
        "created": True,
    }


def ensure_branch_campaign(
    cur,
    org_id: str,
    tenant_id: str,
    meta_campaign_id: int,
    meta_campaign_name: Optional[str],
    meta_platform: Optional[str],
    meta_campaign_status: Optional[str],
    campaign_type_id: Optional[str],
) -> Optional[str]:
    """The branch's projection of a Meta campaign, created on first sight.
    Direct port of ensureBranchCampaign.

    Returns None when the tenant has no matching platform/status catalog row
    -- deliberately not an error: the lead still gets its TYPE and is still
    created and routed."""
    cur.execute(
        """
        SELECT id FROM marketing.ad_campaigns
        WHERE org_id = %(org_id)s AND meta_campaign_id = %(meta_campaign_id)s
        LIMIT 1
        """,
        {"org_id": org_id, "meta_campaign_id": meta_campaign_id},
    )
    existing = cur.fetchone()
    if existing:
        return existing["id"]

    platform_name = PLATFORM_MAP.get(str(meta_platform or "").lower(), DEFAULT_PLATFORM_NAME)
    status_name = STATUS_MAP.get(str(meta_campaign_status or "").upper(), DEFAULT_STATUS_NAME)

    cur.execute(
        """
        SELECT
          (SELECT id FROM marketing.marketing_platforms
             WHERE name = %(platform_name)s AND tenant_id = %(tenant_id)s LIMIT 1) AS platform_id,
          (SELECT id FROM marketing.campaign_statuses
             WHERE name = %(status_name)s AND tenant_id = %(tenant_id)s LIMIT 1) AS status_id
        """,
        {"platform_name": platform_name, "status_name": status_name, "tenant_id": tenant_id},
    )
    catalog = cur.fetchone()
    platform_id = catalog["platform_id"] if catalog else None
    status_id = catalog["status_id"] if catalog else None
    if not platform_id or not status_id:
        log.warning(
            "org=%s meta_campaign_id=%s: no tenant platform/status catalog row (platform=%s status=%s) "
            "-- lead keeps its type but gets no campaign",
            org_id, meta_campaign_id, platform_name, status_name,
        )
        return None

    name = (meta_campaign_name or "").strip() or f"Meta Campaign {meta_campaign_id}"

    cur.execute(
        """
        INSERT INTO marketing.ad_campaigns (org_id, name, platform_id, status_id, meta_campaign_id, campaign_type_id)
        VALUES (%(org_id)s, %(name)s, %(platform_id)s, %(status_id)s, %(meta_campaign_id)s, %(campaign_type_id)s)
        ON CONFLICT (org_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL DO NOTHING
        """,
        {
            "org_id": org_id,
            "name": name,
            "platform_id": platform_id,
            "status_id": status_id,
            "meta_campaign_id": meta_campaign_id,
            "campaign_type_id": campaign_type_id,
        },
    )

    # Re-select rather than RETURNING: DO NOTHING returns no row for the loser
    # of a concurrent-insert race, and that loser still needs the winner's id.
    cur.execute(
        """
        SELECT id FROM marketing.ad_campaigns
        WHERE org_id = %(org_id)s AND meta_campaign_id = %(meta_campaign_id)s
        LIMIT 1
        """,
        {"org_id": org_id, "meta_campaign_id": meta_campaign_id},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def resolve_campaign_for_lead(
    cur,
    org_id: str,
    tenant_id: str,
    meta_campaign_id: Optional[int],
    meta_campaign_name: Optional[str] = None,
    meta_platform: Optional[str] = None,
    meta_campaign_status: Optional[str] = None,
    form_default_campaign_type_id: Optional[str] = None,
) -> Dict[str, Optional[str]]:
    """What campaign and what TYPE a lead belongs to. Direct port of
    resolveCampaignForLead, combined with resolveCampaignType (see module
    docstring for why the two collapse into one call here).

    Returns {"campaign_id": marketing.ad_campaigns.id or None,
             "campaign_type_id": marketing.campaign_types.id or None}.

    No meta_campaign_id at all (an organic lead, or a walk-in) -- the
    page/form default is the only signal there is, so it wins outright, with
    the tenant default as the final fallback.
    """
    if not meta_campaign_id:
        return {
            "campaign_id": None,
            "campaign_type_id": form_default_campaign_type_id or tenant_default_type(cur, tenant_id),
        }

    resolved = resolve_campaign_type(
        cur,
        tenant_id,
        meta_campaign_id,
        meta_campaign_name=meta_campaign_name,
        meta_campaign_status=meta_campaign_status,
        form_default_campaign_type_id=form_default_campaign_type_id,
    )
    campaign_type_id = resolved["campaign_type_id"]

    campaign_id = ensure_branch_campaign(
        cur,
        org_id,
        tenant_id,
        meta_campaign_id,
        meta_campaign_name,
        meta_platform,
        meta_campaign_status,
        campaign_type_id,
    )

    return {"campaign_id": campaign_id, "campaign_type_id": campaign_type_id}
