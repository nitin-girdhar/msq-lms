"""Minimal Meta Graph API client.

Mirrors services/meta-conversion-api/src/services/meta-api.service.ts +
config/meta.config.ts (base URL, lead field list) — same endpoints, same
field set, just called from Python instead of axios.
"""

from typing import Any, Dict, List, Optional, Tuple

import requests

GRAPH_BASE_URL = "https://graph.facebook.com"

LEAD_FIELDS = ["field_data", "ad_id", "adset_id", "campaign_id", "form_id", "id", "created_time"]
FORM_FIELDS = ["id", "name", "status", "leads_count", "created_time"]
CAMPAIGN_FIELDS = ["id", "name", "status", "objective", "effective_status"]

REQUEST_TIMEOUT_SECONDS = 15


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
        self, form_id: str, after: Optional[str] = None, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """Returns one page of leads for a form + the cursor for the next page (or None)."""
        params: Dict[str, Any] = {"fields": ",".join(LEAD_FIELDS), "limit": limit}
        if after:
            params["after"] = after
        body = self._get(f"{form_id}/leads", params)
        data = body.get("data", [])
        next_cursor = body.get("paging", {}).get("cursors", {}).get("after")
        has_next = bool(body.get("paging", {}).get("next"))
        return data, (next_cursor if has_next else None)

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
