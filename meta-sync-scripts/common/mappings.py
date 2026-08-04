"""Page/form -> org routing lookups against ext.meta_page_form_org_map.

ext.meta_page_form_org_map is the single routing authority (same as the
webhook path in services/meta-conversion-api). Forms are now *discovered*
per Page at run time rather than read from this table — Meta-side pages and
ad accounts get reorganised and new leadgen forms appear constantly, so the
table's form_id list goes stale — but a form still has to be mapped here
before its leads can be routed to an org.

Deliberately no fallback guessing: page 825984413941973 alone is shared by
eight Fitclass branch orgs, so "the page's org" is not a well-defined thing.
An unmapped form is reported, never routed. Same rule sync_forms.py's
maybe_auto_map_form() already enforces.
"""

from typing import Dict, List, Optional, Tuple


def get_known_page_ids(cur, tenant_id: Optional[str] = None) -> List[str]:
    """Every distinct page_id already referenced in the mapping table, optionally
    scoped to one tenant (via the *org's* tenant, entity.organizations.tenant_id
    — not the integration's, since ext.meta_tenant_config is tenant-agnostic)."""
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


def load_form_org_map(
    cur, tenant_id: Optional[str] = None, org_id: Optional[str] = None
) -> Dict[Tuple[str, str], dict]:
    """Returns {(page_id, form_id): mapping row} for every ACTIVE mapping in
    scope. Keys are strings on both sides — Meta ids arrive from the Graph API
    as strings and are stored as BIGINT, and mixing the two silently misses."""
    cur.execute(
        """
        SELECT m.id, m.tenant_id, m.org_id, m.page_id, m.form_id, m.platform, m.last_synced_at,
               o.name AS org_name
        FROM ext.meta_page_form_org_map m
        JOIN entity.organizations o ON o.id = m.org_id
        WHERE m.is_active = true
          AND (%(tenant_id)s::uuid IS NULL OR m.tenant_id = %(tenant_id)s::uuid)
          AND (%(org_id)s::uuid IS NULL OR m.org_id = %(org_id)s::uuid)
        """,
        {"tenant_id": tenant_id, "org_id": org_id},
    )
    return {(str(row["page_id"]), str(row["form_id"])): dict(row) for row in cur.fetchall()}


def page_org_names(cur, page_id: str) -> List[str]:
    """Org names currently mapped to a page — context for the 'this form needs a
    manual mapping, here are the candidates' report."""
    cur.execute(
        """
        SELECT DISTINCT o.name FROM ext.meta_page_form_org_map m
        JOIN entity.organizations o ON o.id = m.org_id
        WHERE m.page_id = %s AND m.is_active = true
        ORDER BY o.name
        """,
        (page_id,),
    )
    return [row["name"] for row in cur.fetchall()]
