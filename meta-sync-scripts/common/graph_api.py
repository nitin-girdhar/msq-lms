"""Minimal Meta Graph API client.

Mirrors services/meta-conversion-api/src/services/meta-api.service.ts +
config/meta.config.ts (base URL, lead field list) — same endpoints, same
field set, just called from Python instead of axios.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests

log = logging.getLogger("graph_api")

GRAPH_BASE_URL = "https://graph.facebook.com"

LEAD_FIELDS = ["field_data", "ad_id", "adset_id", "campaign_id", "form_id", "id", "created_time", "platform"]
FORM_FIELDS = ["id", "name", "status", "leads_count", "created_time"]
CAMPAIGN_FIELDS = ["id", "name", "status", "objective", "effective_status"]

REQUEST_TIMEOUT_SECONDS = 15


def parse_created_time(value: Optional[str]) -> Optional[datetime]:
    """Meta's Lead object returns created_time as an ISO8601 string
    (e.g. "2026-07-11T18:07:55+0000"), NOT a Unix timestamp — confirmed
    against a live Graph API response. Returns None if missing/unparseable;
    callers decide whether that means "skip" or "assume now"."""
    if not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    log.warning("could not parse created_time=%r", value)
    return None


def is_before(created_time: Optional[str], cutoff: datetime) -> bool:
    parsed = parse_created_time(created_time)
    return parsed is not None and parsed < cutoff


def in_window(created_time: Optional[str], since: Optional[datetime], until: Optional[datetime]) -> bool:
    """Client-side date filter. A lead whose created_time can't be parsed is
    KEPT — dropping a real lead because of a format surprise is worse than
    letting one through for review/dedup to catch."""
    parsed = parse_created_time(created_time)
    if parsed is None:
        return True
    if since and parsed < since:
        return False
    if until and parsed >= until:
        return False
    return True


def parse_since_arg(value: str) -> datetime:
    """Parses a --since CLI value ("2026-07-28" or a full ISO8601 timestamp).
    A bare date means 00:00 UTC on that day."""
    text = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class MetaGraphError(RuntimeError):
    def __init__(self, message: str, status_code: Optional[int] = None, response_body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class MetaGraphClient:
    def __init__(self, access_token: str, graph_api_version: str):
        self.access_token = access_token
        self.graph_api_version = graph_api_version

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{GRAPH_BASE_URL}/{self.graph_api_version}/{path}"
        resp = requests.get(
            url,
            params={**params, "access_token": self.access_token},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if not resp.ok:
            body = None
            try:
                body = resp.json()
            except ValueError:
                pass
            raise MetaGraphError(
                f"Graph API GET {path} failed ({resp.status_code}): {body}",
                status_code=resp.status_code,
                response_body=body,
            )
        return resp.json()

    def get_leadgen_forms(self, page_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Returns every leadgen form on a Page (paginates internally)."""
        forms: List[Dict[str, Any]] = []
        after: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"fields": ",".join(FORM_FIELDS), "limit": limit}
            if after:
                params["after"] = after
            body = self._get(f"{page_id}/leadgen_forms", params)
            forms.extend(body.get("data", []))
            after = body.get("paging", {}).get("cursors", {}).get("after")
            if not after or not body.get("paging", {}).get("next"):
                break
        return forms

    def get_leads_page(
        self,
        form_id: str,
        after: Optional[str] = None,
        limit: int = 100,
        since: Optional[datetime] = None,
        until: Optional[datetime] = None,
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """Returns one page of leads for a form + the cursor for the next page (or None).

        `since`/`until` are sent as Meta's `filtering` param on `time_created`.
        Treat that as an *optimisation only* — this edge has been observed
        ignoring it — so every caller must still filter client-side. Use
        get_leads_all(), which does both.
        """
        params: Dict[str, Any] = {"fields": ",".join(LEAD_FIELDS), "limit": limit}
        if after:
            params["after"] = after

        filters = []
        if since:
            filters.append(
                {"field": "time_created", "operator": "GREATER_THAN", "value": int(since.timestamp())}
            )
        if until:
            filters.append(
                {"field": "time_created", "operator": "LESS_THAN", "value": int(until.timestamp())}
            )
        if filters:
            params["filtering"] = json.dumps(filters)

        body = self._get(f"{form_id}/leads", params)
        data = body.get("data", [])
        next_cursor = body.get("paging", {}).get("cursors", {}).get("after")
        has_next = bool(body.get("paging", {}).get("next"))
        return data, (next_cursor if has_next else None)

    def get_leads_all(
        self,
        form_id: str,
        since: Optional[datetime] = None,
        until: Optional[datetime] = None,
        max_pages: int = 50,
        limit: int = 100,
    ) -> Tuple[List[Dict[str, Any]], bool]:
        """Pages through /{form_id}/leads and returns every lead created at or
        after `since` (and before `until`), plus a flag for whether max_pages
        was hit before pagination naturally ended.

        Meta returns this edge newest-first, so once a *whole* page lands
        before `since` there is nothing newer further back and we stop — that
        is what keeps a page-wide backfill from walking years of history. A
        partially-old page is not enough to stop on, since the boundary page
        straddles the cutoff.
        """
        collected: List[Dict[str, Any]] = []
        after: Optional[str] = None
        pages_fetched = 0

        while pages_fetched < max_pages:
            leads, after = self.get_leads_page(form_id, after=after, limit=limit, since=since, until=until)
            pages_fetched += 1
            if not leads:
                break

            kept = [lead for lead in leads if in_window(lead.get("created_time"), since, until)]
            collected.extend(kept)

            # Whole page older than the cutoff -> nothing newer remains behind it.
            if since and not kept and all(
                is_before(lead.get("created_time"), since) for lead in leads
            ):
                log.debug("form=%s: page %d entirely before cutoff, stopping", form_id, pages_fetched)
                after = None

            if not after:
                break

        return collected, bool(after)

    def get_lead(self, lead_id: str) -> Dict[str, Any]:
        return self._get(lead_id, {"fields": ",".join(LEAD_FIELDS)})

    def get_campaign(self, campaign_id: str) -> Dict[str, Any]:
        return self._get(campaign_id, {"fields": ",".join(CAMPAIGN_FIELDS)})

    def get_managed_pages(self) -> Dict[str, str]:
        """Returns {page_id: page_access_token} for every Page this token's
        user/system-user manages. /leadgen_forms and /leads require a Page
        Access Token — the tenant-level token in ext.meta_tenant_config is a
        User/System-User token and gets rejected by those two edges
        (Meta error #190), so callers must resolve a page token via this
        method before calling get_leadgen_forms()/get_leads_page()."""
        pages: Dict[str, str] = {}
        after: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"fields": "id,access_token", "limit": 100}
            if after:
                params["after"] = after
            body = self._get("me/accounts", params)
            for page in body.get("data", []):
                if page.get("access_token"):
                    pages[str(page["id"])] = page["access_token"]
            after = body.get("paging", {}).get("cursors", {}).get("after")
            if not after or not body.get("paging", {}).get("next"):
                break
        return pages


def resolve_page_clients(integrations) -> Dict[str, Tuple[MetaGraphClient, Any]]:
    """Builds {page_id: (page-scoped client, integration)} across every active
    integration.

    /leadgen_forms and /leads only accept a Page Access Token (Meta error #190
    for the User/System-User token stored on ext.meta_tenant_config), so every
    page has to be resolved through /me/accounts first. Doing it once, up
    front, across all integrations is also what stops callers looping
    "for each integration: for each page" and re-syncing the same page once
    per credential row. First integration that manages a page wins.
    """
    clients: Dict[str, Tuple[MetaGraphClient, Any]] = {}
    for integration in integrations:
        user_client = MetaGraphClient(integration.access_token, integration.graph_api_version)
        try:
            page_tokens = user_client.get_managed_pages()
        except MetaGraphError as exc:
            log.error("integration=%s: could not list managed pages via /me/accounts: %s", integration.id, exc)
            continue
        for page_id, page_token in page_tokens.items():
            clients.setdefault(
                str(page_id), (MetaGraphClient(page_token, integration.graph_api_version), integration)
            )
    return clients
