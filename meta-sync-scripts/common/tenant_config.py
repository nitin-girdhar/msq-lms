"""Loads + decrypts ext.meta_tenant_config rows.

Mirrors services/meta-conversion-api/src/services/integration.service.ts
(getIntegrationById / getIntegrationByTenantId) — same SELECT, same
decrypt-on-read behavior.
"""

import json
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from . import crypto


@dataclass
class TenantIntegration:
    id: str
    tenant_id: Optional[str]  # nullable: NULL = tenant-agnostic/shared integration
    app_secret: str
    verify_token: str
    pixel_id: str
    access_token: str
    graph_api_version: str
    is_active: bool
    field_mappings: Optional[Dict[str, Any]]


def _decrypt_row(row: Dict[str, Any]) -> TenantIntegration:
    field_mappings = row["field_mappings"]
    if isinstance(field_mappings, str):
        field_mappings = json.loads(field_mappings)
    return TenantIntegration(
        id=row["id"],
        tenant_id=row["tenant_id"],
        app_secret=crypto.decrypt_secret(row["app_secret"]),
        verify_token=row["verify_token"],
        pixel_id=row["pixel_id"],
        access_token=crypto.decrypt_secret(row["access_token"]),
        graph_api_version=row["graph_api_version"],
        is_active=row["is_active"],
        field_mappings=field_mappings,
    )


_SELECT_COLUMNS = """
    id, tenant_id, app_secret, verify_token, pixel_id, access_token,
    graph_api_version, is_active, field_mappings
"""


def list_active_integrations(cur, tenant_id: Optional[str] = None) -> List[TenantIntegration]:
    """Returns active Meta integration rows (credentials).

    ext.meta_tenant_config.tenant_id is nullable — a row with tenant_id NULL
    is a tenant-agnostic/shared integration (one set of Meta credentials
    used to pull leads for orgs across any tenant; routing to the correct
    org happens downstream via ext.meta_page_form_org_map's (page_id,
    form_id) -> org_id lookup, not by matching this row's tenant_id).
    A tenant-agnostic row is always included regardless of the tenant_id
    filter, since it legitimately applies to every tenant.
    """
    if tenant_id:
        cur.execute(
            f"SELECT {_SELECT_COLUMNS} FROM ext.meta_tenant_config "
            f"WHERE is_active = true AND (tenant_id = %s OR tenant_id IS NULL)",
            (tenant_id,),
        )
    else:
        cur.execute(f"SELECT {_SELECT_COLUMNS} FROM ext.meta_tenant_config WHERE is_active = true")
    return [_decrypt_row(row) for row in cur.fetchall()]
