"""Bare-SQL port of the canonical lead-creation path.

Ports, statement-for-statement:
  services/leads-service/src/api/v1/intake/intake.repository.ts (createWebhookLead)
  services/leads-service/src/lib/assignment.ts (resolveAutoAssignedUser)
  services/leads-service/src/lib/campaign-resolution.ts (resolveCampaignForLead)
  services/meta-conversion-api/src/services/campaign-mapping.service.ts (resolveCampaignType)

No HTTP call to leads-service is made — this runs the same queries directly
against Postgres using the root_service (RLS-bypass) role, inside the caller's
transaction/cursor, so it's atomic with the ext.meta_leads insert that
follows it.
"""

import json
import logging
import random
from typing import Any, Dict, List, Optional

from . import campaign_resolution, phone as phone_util

log = logging.getLogger("lead_writer")

RANK_READ_ONLY = 0
RANK_ADMIN = 80

# AutoAssignResult.reason values. Mirrors AutoAssignReason in assignment.ts —
# this replaced a bare `None` return for the same reason it did there: a
# branch with nobody weighted is indistinguishable from one whose weighted
# members lack the LMS capability unless the reason is threaded back to the
# caller, and 10 of 30 production branches sat silently unassigned for a long
# time before anyone noticed. NOTE: assignment.ts also filters eligible rows
# by hasCapability(tenantId, roleName, CAPABILITY.LMS), which this port does
# NOT replicate (no Python equivalent of that RBAC lookup exists in this
# package) — a pre-existing Python/TypeScript divergence unrelated to
# campaign types, called out in this phase's report rather than fixed here.
AUTOASSIGN_REASON_ASSIGNED = "assigned"
AUTOASSIGN_REASON_NO_WEIGHTED_USERS = "no_weighted_users"
# 1.50.2: weighted users exist for the pool, but none whose role sits in the
# campaign type's department. Mirrors 'no_department_match' in assignment.ts.
AUTOASSIGN_REASON_NO_DEPARTMENT_MATCH = "no_department_match"


def resolve_auto_assigned_user(cur, org_id: str, campaign_type_id: Optional[str]) -> Dict[str, Optional[str]]:
    """Weighted round-robin auto-assignment WITHIN ONE (branch x campaign type)
    POOL. Direct port of
    msq-lms/services/leads-service/src/lib/assignment.ts::resolveAutoAssignedUser
    — same queries, same weight-vs-open-workload deficit formula, scoped to
    campaign_type_id throughout (lms.lead_assignment_weights' PK is
    (user_org_mapping_id, campaign_type_id) precisely so one person can hold a
    different weight per pool).

    Returns {"user_id": ..., "reason": ...}. A None campaign_type_id cannot
    match any weight row (the column is NOT NULL) and resolves to
    'no_weighted_users' — the honest answer, not a silent cross-pool fallback.
    """
    if not campaign_type_id:
        return {"user_id": None, "reason": AUTOASSIGN_REASON_NO_WEIGHTED_USERS}

    cur.execute(
        """
        SELECT uom.user_id, w.weight,
               -- DEPARTMENT RULE (1.50.2), same as assignment.ts: a weight only
               -- routes when the role's department equals the campaign type's.
               -- Rows breaking it are kept on disk by decision, so this is a flag
               -- (to report the reason) rather than a WHERE filter.
               (ur.department_id IS NOT NULL
                AND ct.department_id IS NOT DISTINCT FROM ur.department_id) AS department_ok
        FROM iam.user_org_mapping uom
        -- INNER JOIN: a membership with no weight row is not in the rotation,
        -- which is what the weight > 0 filter below already meant when the
        -- weight was a NOT NULL DEFAULT 0 column on the mapping. The explicit
        -- predicate stays because an existing row CAN hold 0 (deactivating a
        -- user zeroes it rather than deleting it).
        --
        -- Joined on the campaign type as well as the mapping: the PK is
        -- (user_org_mapping_id, campaign_type_id), so one person holds one row
        -- per pool they belong to. Without this predicate the join fans a
        -- member out across every pool and a hiring lead can land on a
        -- sales-only rep.
        JOIN lms.lead_assignment_weights w
          ON w.user_org_mapping_id = uom.id
         AND w.campaign_type_id    = %(campaign_type_id)s
        JOIN iam.users u ON u.id = uom.user_id
        JOIN iam.user_roles ur ON ur.id = uom.role_id
        JOIN marketing.campaign_types ct ON ct.id = w.campaign_type_id
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
        {
            "org_id": org_id,
            "campaign_type_id": campaign_type_id,
            "read_only": RANK_READ_ONLY,
            "admin": RANK_ADMIN,
        },
    )
    weighted = cur.fetchall()
    if not weighted:
        return {"user_id": None, "reason": AUTOASSIGN_REASON_NO_WEIGHTED_USERS}
    eligible = [u for u in weighted if u["department_ok"]]
    if not eligible:
        return {"user_id": None, "reason": AUTOASSIGN_REASON_NO_DEPARTMENT_MATCH}

    # SCOPED TO THE SAME POOL — the easiest thing here to get wrong. The
    # deficit below is "share of the pool's work minus work already held", so
    # both halves have to be measured in the same pool: counting a user's
    # whole open book instead would let a rep with 50 open SALES leads look
    # permanently over-served in the HIRING rotation and starve them of hiring
    # leads altogether — invisible on a small test dataset, systematic in
    # production.
    cur.execute(
        """
        SELECT ml.assigned_user_id, COUNT(*) AS open_count
        FROM lms.marketing_leads ml
        JOIN lms.lead_stage ls ON ls.id = ml.stage_id
        WHERE ml.org_id = %(org_id)s
          AND ml.campaign_type_id = %(campaign_type_id)s
          AND ml.is_active
          AND NOT ml.is_deleted
          AND NOT ls.is_terminated
          AND ml.assigned_user_id IS NOT NULL
        GROUP BY ml.assigned_user_id
        """,
        {"org_id": org_id, "campaign_type_id": campaign_type_id},
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

    # Random, not first-wins: a deterministic tie-break clusters every new
    # lead on whichever user happens to sort first until their count moves.
    return {"user_id": random.choice(candidates), "reason": AUTOASSIGN_REASON_ASSIGNED}


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
    meta_campaign_id: Optional[int] = None,
    meta_campaign_name: Optional[str] = None,
    meta_platform: Optional[str] = None,
    meta_campaign_status: Optional[str] = None,
    form_default_campaign_type_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    raw_webhook_data: Optional[Dict[str, Any]] = None,
    created_at: Optional[Any] = None,
) -> Dict[str, Any]:
    """Direct port of createWebhookLead. Returns
    {id, is_duplicate, existing_lead_id}, matching the TS return shape.

    campaign_id: an explicit, already-resolved marketing.ad_campaigns id.
    Still wins over the Meta-derived resolution below when given — mirrors
    `campaignId: data.campaign_id ?? resolved.campaign_id` in
    intake.repository.ts, for callers (e.g. non-Meta intake) that already
    know the exact campaign row.

    meta_campaign_id / meta_campaign_name / meta_platform / meta_campaign_status:
    the Meta-side signals campaign_resolution.resolve_campaign_for_lead needs
    to find or create the branch's marketing.ad_campaigns row and resolve its
    TYPE. meta_campaign_name is frequently unavailable at lead-ingestion time
    (Meta's /{form-id}/leads edge does not return it) — that's fine, exactly
    as it is in the TypeScript when a Graph metadata lookup fails or is
    skipped: the row is created with a placeholder name and 'unmapped'
    status, and a later sync_campaigns.py run backfills the real name and
    re-types it.

    form_default_campaign_type_id: ext.meta_page_form_org_map.default_campaign_type_id
    for the page/form this lead arrived on, if known — the routing signal used
    when the campaign name matches no keyword, or there is no campaign id at
    all (an organic lead or a walk-in).

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

    # Canonical form for the INSERT below and for the duplicate lookup - must
    # stay in step with reconcile.find_active_lead_by_phone, or the preview and
    # the import disagree about what counts as a duplicate.
    phone = phone_util.normalize(phone)

    if phone:
        # EXACT string equality, the platform rule (confirmed 2026-09-13) and
        # the same predicate leads-service's createWebhookLead uses. This used to
        # match on the last ten significant digits, so the batch path superseded
        # leads the live webhook would have kept as separate — the same lead
        # ingested two ways landed differently.
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

    # Campaign and TYPE before the pick: which rotation this lead belongs to
    # is an input to who receives it, not a label applied afterwards. Mirrors
    # intake.repository.ts calling resolveCampaignForLead before
    # resolveAutoAssignedUser. May also create the branch's
    # marketing.ad_campaigns row for a Meta campaign seen here for the first
    # time.
    cur.execute(
        "SELECT tenant_id FROM entity.organizations WHERE id = %(org_id)s",
        {"org_id": org_id},
    )
    tenant_row = cur.fetchone()
    tenant_id = tenant_row["tenant_id"] if tenant_row else None

    resolved_campaign = campaign_resolution.resolve_campaign_for_lead(
        cur,
        org_id,
        tenant_id,
        meta_campaign_id,
        meta_campaign_name=meta_campaign_name,
        meta_platform=meta_platform,
        meta_campaign_status=meta_campaign_status,
        form_default_campaign_type_id=form_default_campaign_type_id,
    )
    # An explicit campaign_id from the caller still wins; resolve_campaign_for_lead
    # only supplies one when the lead carried a Meta campaign id.
    resolved_campaign_id = campaign_id or resolved_campaign["campaign_id"]
    resolved_campaign_type_id = resolved_campaign["campaign_type_id"]

    # Parity with leads-service's resolveCampaignForLead, which re-checks every
    # type against the org's tenant and liveness before it is written. This path
    # runs as root_service with no RLS and no FK tying a type's tenant to the
    # branch's, so without it a corrupt or retired id would be stamped on the lead
    # and route into a pool nobody is weighted for.
    if resolved_campaign_type_id:
        cur.execute(
            """
            SELECT 1 FROM marketing.campaign_types
            WHERE id = %(type_id)s AND tenant_id = %(tenant_id)s
              AND is_active AND NOT is_deleted
            """,
            {"type_id": resolved_campaign_type_id, "tenant_id": tenant_id},
        )
        if not cur.fetchone():
            log.warning(
                "lead.campaign_type_unusable org_id=%s campaign_type=%s — not live or not this "
                "tenant's; falling back to the tenant default",
                org_id, resolved_campaign_type_id,
            )
            resolved_campaign_type_id = campaign_resolution.tenant_default_type(cur, tenant_id)

    assignment = resolve_auto_assigned_user(cur, org_id, resolved_campaign_type_id)
    # The fix for the silent-failure incident: auto-assign used to return a
    # bare None and the lead simply arrived unassigned, so 10 of 30 branches
    # sat with no weighted user for a long time with nothing in the logs to
    # show it. A skipped assignment now always says which pool and why.
    if assignment["reason"] != AUTOASSIGN_REASON_ASSIGNED:
        log.warning(
            "lead.autoassign_skipped org_id=%s campaign_type=%s reason=%s "
            "— lead created unassigned: no eligible user in this pool",
            org_id, resolved_campaign_type_id, assignment["reason"],
        )
    auto_assigned_user_id = assignment["user_id"]

    cur.execute(
        """
        INSERT INTO lms.marketing_leads (
            org_id, first_name, last_name, phone, email, city, address_line1,
            pincode, stage_id, source_id, campaign_id, campaign_type_id, assigned_user_id,
            metadata, raw_webhook_data, created_at, updated_at
        ) VALUES (
            %(org_id)s, %(first_name)s, %(last_name)s, %(phone)s, %(email)s,
            %(city)s, %(address_line1)s, %(pincode)s, %(stage_id)s, %(source_id)s,
            %(campaign_id)s, %(campaign_type_id)s, %(assigned_user_id)s, %(metadata)s, %(raw_webhook_data)s,
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
            "campaign_id": resolved_campaign_id,
            "campaign_type_id": resolved_campaign_type_id,
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
