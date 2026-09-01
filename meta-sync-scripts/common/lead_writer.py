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

from . import phone as phone_util

RANK_READ_ONLY = 0
RANK_ADMIN = 80


def resolve_auto_assigned_user(cur, org_id: str) -> Optional[str]:
    """Weighted round-robin auto-assignment. Direct port of
    msq-lms/services/leads-service/src/lib/assignment.ts::resolveAutoAssignedUser — same queries,
    same weight-vs-open-workload deficit formula. Returns None (leave
    unassigned) when the org has no eligible weighted users."""
    cur.execute(
        """
        SELECT uom.user_id, w.weight
        FROM iam.user_org_mapping uom
        -- INNER JOIN: a membership with no weight row is not in the rotation,
        -- which is what the weight > 0 filter below already meant when the
        -- weight was a NOT NULL DEFAULT 0 column on the mapping. The explicit
        -- predicate stays because an existing row CAN hold 0 (deactivating a
        -- user zeroes it rather than deleting it).
        JOIN lms.lead_assignment_weights w ON w.user_org_mapping_id = uom.id
        JOIN iam.users u ON u.id = uom.user_id
        JOIN iam.user_roles ur ON ur.id = uom.role_id
        WHERE uom.org_id = %(org_id)s
          AND uom.is_active
          -- Must match iam.fn_actor_can_act_in_org, which
          -- lms.check_lead_fk_org_scope() re-runs on INSERT: an active
          -- MAPPING is not enough, the USER row has to be live too.
          -- Without this a user deactivated via edit-user (which leaves the
          -- mapping itself untouched) still wins the pick and then
          -- fails the insert. Because every script runs its whole scope in
          -- ONE transaction, that single RAISE rolls back the entire import.
          AND u.is_active AND NOT u.is_deleted
          AND w.weight > 0
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

    # lms.lead_stage / lms.lead_sources are tenant-scoped (N-6 Half B): every
    # tenant carries its own 'new' stage and its own 'facebook'/'instagram'
    # source rows, all sharing the same `name`. This package connects as
    # root_service (BYPASSRLS), so a bare `WHERE name = ...` LIMIT 1 has no
    # policy narrowing it and Postgres returns whichever row it reaches first —
    # in practice the wrong tenant's about half the time. That stamped 19
    # Gurugram leads (Civil Lines and Sector 104, Jul 8 - Aug 6) with a foreign
    # tenant's stage_id/source_id, which then read back blank in the UI because
    # the list query joins these tables under RLS. Resolve via the LEAD's
    # tenant, derived from org_id, exactly as createWebhookLead does in
    # services/leads-service/src/api/v1/intake/intake.repository.ts.
    cur.execute(
        """
        SELECT id FROM lms.lead_stage
        WHERE name = 'new'
          AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s)
        LIMIT 1
        """,
        {"org_id": org_id},
    )
    stage_row = cur.fetchone()
    if not stage_row:
        raise RuntimeError('Lead stage "new" not found for this tenant')
    default_stage_id = stage_row["id"]

    source_id: Optional[str] = None
    if source:
        cur.execute(
            """
            SELECT id FROM lms.lead_sources
            WHERE name = %(name)s
              AND tenant_id = (SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s)
            LIMIT 1
            """,
            {"name": source, "org_id": org_id},
        )
        src_row = cur.fetchone()
        source_id = src_row["id"] if src_row else None

    existing_lead_id: Optional[str] = None

    # Canonical form for the INSERT below, and a format-insensitive key for
    # the lookup - must stay in step with reconcile.find_active_lead_by_phone,
    # or the preview and the import disagree about what counts as a duplicate.
    phone = phone_util.normalize(phone)

    if phone:
        key = phone_util.match_key(phone)
        if key is None:
            cur.execute(
                """
                SELECT id FROM lms.marketing_leads
                WHERE org_id = %(org_id)s AND phone = %(phone)s
                  AND is_active = true AND NOT is_deleted
                LIMIT 1
                """,
                {"org_id": org_id, "phone": phone},
            )
        else:
            cur.execute(
                """
                SELECT id FROM lms.marketing_leads
                WHERE org_id = %(org_id)s
                  AND length(regexp_replace(phone, '\\D', '', 'g')) >= 10
                  AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = %(key)s
                  AND is_active = true AND NOT is_deleted
                LIMIT 1
                """,
                {"org_id": org_id, "key": key},
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
