"""Page/form -> org routing lookups against ext.meta_page_form_org_map.

ext.meta_page_form_org_map is the single routing authority (same as the
webhook path in services/meta-conversion-api). Forms are now *discovered*
per Page at run time rather than read from this table — Meta-side pages and
ad accounts get reorganised and new leadgen forms appear constantly, so the
table's form_id list goes stale — but a form still has to be mapped (either
directly, or via its page's page-level row) here before its leads can be
routed to an org.

A mapping row's form_id may be NULL: that's a page-level subscription,
meaning every form discovered on that page routes to the row's org. An
explicit (page_id, form_id) row always wins over a page-level row for the
same page — this is how a page shared by several orgs (e.g. page
825984413941973, shared by eight Fitclass branch orgs) stays correctly
routed: each branch gets its own explicit form_id row, and the page has no
page-level row at all. A form with neither an explicit row nor a page-level
fallback is reported, never guessed into an org. Same rule sync_forms.py's
maybe_auto_map_form() already enforces, and the same fallback order as
page-org-map.service.ts::resolveOrgId in services/meta-conversion-api.
"""

from typing import Dict, List, NamedTuple, Optional, Tuple


class FormOrgMap(NamedTuple):
    """form_map: {(page_id, form_id): row} for explicit form-level mappings.
    page_map: {page_id: row} for page-level (form_id IS NULL) mappings."""

    form_map: Dict[Tuple[str, str], dict]
    page_map: Dict[str, dict]

    def page_ids(self) -> List[str]:
        return sorted({page_id for page_id, _ in self.form_map} | set(self.page_map))

    def resolve(self, page_id: str, form_id: str) -> Optional[dict]:
        """Explicit (page_id, form_id) row wins; else fall back to the
        page's page-level row, if any; else unmapped."""
        mapping = self.form_map.get((page_id, form_id))
        if mapping is not None:
            return mapping
        return self.page_map.get(page_id)


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
) -> FormOrgMap:
    """Returns every ACTIVE mapping in scope, split into explicit form-level
    and page-level rows (see FormOrgMap). Keys are strings — Meta ids arrive
    from the Graph API as strings and are stored as BIGINT, and mixing the
    two silently misses."""
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
    form_map: Dict[Tuple[str, str], dict] = {}
    page_map: Dict[str, dict] = {}
    for row in cur.fetchall():
        row = dict(row)
        page_id = str(row["page_id"])
        if row["form_id"] is None:
            page_map[page_id] = row
        else:
            form_map[(page_id, str(row["form_id"]))] = row
    return FormOrgMap(form_map, page_map)


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
