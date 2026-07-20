"""Bare-SQL port of the canonical lead-creation path.

Ports, statement-for-statement:
  services/leads-service/src/api/v1/intake/intake.repository.ts (createWebhookLead)
  packages/db/src/assignment.ts (resolveAutoAssignedUser)

No HTTP call to leads-service is made — this runs the same queries directly
against Postgres using the root_service (RLS-bypass) role, inside the caller's
transaction/cursor, so it's atomic with the ext.meta_leads insert that
follows it.
"""

import json
import random
from typing import Any, Dict, List, Optional

RANK_READ_ONLY = 0
RANK_ADMIN = 80


def resolve_auto_assigned_user(cur, org_id: str) -> Optional[str]:
    """Weighted round-robin auto-assignment. Direct port of
    packages/db/src/assignment.ts::resolveAutoAssignedUser — same queries,
    same weight-vs-open-workload deficit formula. Returns None (leave
    unassigned) when the org has no eligible weighted users."""
    cur.execute(
        """
        SELECT uom.user_id, uom.lead_assignment_weight AS weight
        FROM iam.user_org_mapping uom
        JOIN iam.user_roles ur ON ur.id = uom.role_id
        WHERE uom.org_id = %(org_id)s
          AND uom.is_active
          AND uom.lead_assignment_weight > 0
          AND ur.rank > %(read_only)s
          AND ur.rank < %(admin)s
        """,
        {"org_id": org_id, "read_only": RANK_READ_ONLY, "admin": RANK_ADMIN},
    )
    eligible = cur.fetchall()
    if not eligible:
        return None

    cur.execute(
        """
        SELECT ml.assigned_user_id, COUNT(*) AS open_count
        FROM lms.marketing_leads ml
        JOIN lms.lead_stage ls ON ls.id = ml.stage_id
        WHERE ml.org_id = %(org_id)s
          AND ml.is_active
          AND NOT ml.is_deleted
          AND NOT ls.is_terminated
          AND ml.assigned_user_id IS NOT NULL
        GROUP BY ml.assigned_user_id
        """,
        {"org_id": org_id},
    )
    counts = {row["assigned_user_id"]: int(row["open_count"]) for row in cur.fetchall()}

    total_open = sum(counts.get(u["user_id"], 0) for u in eligible) + 1

    best_deficit = float("-inf")
    candidates: List[str] = []
    for u in eligible:
        current = counts.get(u["user_id"], 0)
        deficit = (float(u["weight"]) / 100.0) * total_open - current
        if deficit > best_deficit:
            best_deficit = deficit
            candidates = [u["user_id"]]
        elif deficit == best_deficit:
            candidates.append(u["user_id"])

    return random.choice(candidates)


def create_lead(
    cur,
    *,
    org_id: str,
    first_name: str = "",
    last_name: str = "",
    phone: Optional[str] = None,
    email: Optional[str] = None,
    source: Optional[str] = None,
    city: Optional[str] = None,
    address_line1: Optional[str] = None,
    pincode: Optional[str] = None,
    campaign_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    raw_webhook_data: Optional[Dict[str, Any]] = None,
    created_at: Optional[Any] = None,
) -> Dict[str, Any]:
    """Direct port of createWebhookLead. Returns
    {id, is_duplicate, existing_lead_id}, matching the TS return shape.

    created_at: pass the lead's real originating timestamp for backfilled
    leads (e.g. ext.meta_leads.lead_created_at) so lms.marketing_leads.created_at
    reflects when the lead actually happened, not when this script ran. A
    live webhook-created lead correctly omits this (created_at defaults to
    NOW(), which IS accurate there since it's processed in near-real-time)."""
    if not org_id:
        raise ValueError("org_id is required")
    if not phone and not email:
        raise ValueError("At least one of phone or email is required")

    cur.execute("SELECT id FROM lms.lead_stage WHERE name = 'new' LIMIT 1")
    stage_row = cur.fetchone()
    if not stage_row:
        raise RuntimeError('Lead stage "new" not found')
    default_stage_id = stage_row["id"]

    source_id: Optional[str] = None
    if source:
        cur.execute("SELECT id FROM lms.lead_sources WHERE name = %s LIMIT 1", (source,))
        src_row = cur.fetchone()
        source_id = src_row["id"] if src_row else None

    existing_lead_id: Optional[str] = None

    if phone:
        cur.execute(
            """
            SELECT id FROM lms.marketing_leads
            WHERE org_id = %(org_id)s AND phone = %(phone)s
              AND is_active = true AND NOT is_deleted
            LIMIT 1
            """,
            {"org_id": org_id, "phone": phone},
        )
        row = cur.fetchone()
        existing_lead_id = row["id"] if row else None

    if not existing_lead_id and email:
        cur.execute(
            """
            SELECT id FROM lms.marketing_leads
            WHERE org_id = %(org_id)s AND email = %(email)s
              AND is_active = true AND NOT is_deleted
            LIMIT 1
            """,
            {"org_id": org_id, "email": email},
        )
        row = cur.fetchone()
        if row:
            # Email match: an update/re-submission, not a new lead — return early.
            return {"id": row["id"], "is_duplicate": True, "existing_lead_id": row["id"]}

    if existing_lead_id:
        cur.execute(
            "UPDATE lms.marketing_leads SET is_active = false, updated_at = NOW() WHERE id = %s",
            (existing_lead_id,),
        )

    auto_assigned_user_id = resolve_auto_assigned_user(cur, org_id)

    cur.execute(
        """
        INSERT INTO lms.marketing_leads (
            org_id, first_name, last_name, phone, email, city, address_line1,
            pincode, stage_id, source_id, campaign_id, assigned_user_id,
            metadata, raw_webhook_data, created_at, updated_at
        ) VALUES (
            %(org_id)s, %(first_name)s, %(last_name)s, %(phone)s, %(email)s,
            %(city)s, %(address_line1)s, %(pincode)s, %(stage_id)s, %(source_id)s,
            %(campaign_id)s, %(assigned_user_id)s, %(metadata)s, %(raw_webhook_data)s,
            COALESCE(%(created_at)s::timestamptz, CLOCK_TIMESTAMP()),
            COALESCE(%(created_at)s::timestamptz, CLOCK_TIMESTAMP())
        )
        RETURNING id
        """,
        {
            "org_id": org_id,
            "first_name": first_name or "",
            "last_name": last_name or "",
            "phone": phone,
            "email": email,
            "city": city,
            "address_line1": address_line1,
            "pincode": pincode,
            "stage_id": default_stage_id,
            "source_id": source_id,
            "campaign_id": campaign_id,
            "assigned_user_id": auto_assigned_user_id,
            "metadata": json.dumps(metadata or {}),
            "raw_webhook_data": json.dumps(raw_webhook_data or {}),
            "created_at": created_at,
        },
    )
    new_lead_id = cur.fetchone()["id"]

    if existing_lead_id:
        cur.execute(
            """
            INSERT INTO lms.lead_links (source_lead_id, source_org_id, dest_lead_id, dest_org_id, link_type, status)
            VALUES (%(existing)s, %(org_id)s, %(new)s, %(org_id)s, 'merge', 'completed')
            """,
            {"existing": existing_lead_id, "new": new_lead_id, "org_id": org_id},
        )
        cur.execute(
            "UPDATE lms.marketing_leads SET superseded_by = %s WHERE id = %s",
            (new_lead_id, existing_lead_id),
        )

    return {"id": new_lead_id, "is_duplicate": False, "existing_lead_id": existing_lead_id}
