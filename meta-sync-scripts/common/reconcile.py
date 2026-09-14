"""Classifies a downloaded Meta lead against what's already in the local DB.

Shared by check_leads_against_db.py (report only) and
import_downloaded_leads.py (report, then act on the same verdicts) so the
preview and the import can never disagree about what will happen.

The dedup checks mirror common/lead_writer.py::create_lead exactly — phone
match supersedes the old lead, email match is a no-op re-submission — so a
verdict here is a genuine prediction of what create_lead would do, not an
approximation.

── THE ONE DELIBERATE BEHAVIOUR CHANGE ──────────────────────────────────────

`hiring_form` WAS a SKIP verdict here, because recruitment forms share the
Pages that carry sales campaigns and there was nowhere to route a job
applicant — a hiring lead in lms.marketing_leads was simply wrong. After the
campaign-type work there IS somewhere: a type carries a department and
routes to that branch's pool.

So hiring_form stops being a verdict and becomes a SIGNAL: `is_hiring_form`
plus `suggested_campaign_type_id` (whatever marketing.fn_match_campaign_type
matches on the form NAME). The lead classifies and imports normally, and the
reviewer is told which forms look like recruitment and what type they would
match — the actual fix being to set
ext.meta_page_form_org_map.default_campaign_type_id, which is the signal
create_lead's campaign resolution already reads on the import path.

THIS CHANGES WHAT GETS IMPORTED: leads on hiring forms that used to be
discarded are now applied. That is the intent. (A TypeScript port of this
exact module — services/meta-conversion-api/src/services/
lead-reconcile.service.ts, for the admin "Meta lead pull" screen — made the
identical change first; this brings the Python CLI path in step with it.)
"""

import re
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import field_mapping, output, phone as phone_util

# Mirrors isMetaTestLead / TEST_LEAD_VALUE_PATTERN in
# services/meta-conversion-api/src/services/lead-sync.service.ts. Meta stamps
# this placeholder into whichever fields the form has when someone uses the
# Lead Ads Testing Tool. The webhook has always skipped these; this path did
# not, which is how 20 of them reached production as real leads.
TEST_LEAD_VALUE_PATTERN = re.compile(r"test lead:", re.I)

# Recruitment forms share the Pages that carry sales campaigns. Deliberately
# NARROW: it keys on explicit recruitment words only. Broader guesses were
# tried and rejected — a bare "trainer" or "PT" matches genuine
# personal-training SALES forms, and mistyping a real sales lead is worse
# than missing the hint on an oddly-named hiring form. No longer a skip (see
# the module docstring) — purely an informational signal now, surfaced
# alongside suggested_campaign_type_id() for the reviewer.
HIRING_FORM_PATTERN = re.compile(
    r"hiring|recruit|vacancy|career|job application|sales exe", re.I
)


def is_hiring_form(form_name: Optional[str]) -> bool:
    return bool(HIRING_FORM_PATTERN.search(form_name or ""))


def suggested_campaign_type_id(cur, tenant_id: Optional[str], form_name: Optional[str]) -> Optional[str]:
    """The type marketing.fn_match_campaign_type() infers from the form NAME
    alone — a display-only SIGNAL for the reviewer, same as is_hiring_form.
    Routing itself resolves the type from the CAMPAIGN name (or the form's
    default_campaign_type_id) via common/campaign_resolution.py at import
    time; this is never used for that decision, only shown alongside it —
    calls the SQL function exactly like every routing-critical resolution
    does, never reimplementing the keyword match."""
    if not tenant_id or not form_name:
        return None
    cur.execute(
        "SELECT marketing.fn_match_campaign_type(%(tenant_id)s::uuid, %(name)s) AS type_id",
        {"tenant_id": tenant_id, "name": form_name},
    )
    row = cur.fetchone()
    return row["type_id"] if row else None


def is_test_lead(field_data: List[Dict[str, Any]]) -> bool:
    return any(
        TEST_LEAD_VALUE_PATTERN.search(str(v))
        for f in field_data or []
        for v in (f.get("values") or [])
    )

# Verdicts, roughly in the order they're decided.
NEW = "new"
ALREADY_SYNCED = "already_synced"
UNMAPPED_FORM = "unmapped_form"
MISSING_CONTACT = "missing_contact"
TEST_LEAD = "test_lead"
PHONE_DUPLICATE = "phone_duplicate"
EMAIL_DUPLICATE = "email_duplicate"

# Verdicts the import stage acts on. The two duplicate verdicts are included
# deliberately, matching sync_leads.py's existing behaviour: create_lead
# supersedes on a phone match and returns the existing lead on an email match,
# and either way an ext.meta_leads row is still written against the resulting
# marketing_lead_id — that's what keeps the lead from being re-fetched forever.
# Only unmapped/unextractable leads are genuinely skipped.
IMPORTABLE = {NEW, PHONE_DUPLICATE, EMAIL_DUPLICATE}


def safe_bigint(value) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_run(run_dir: Path) -> List[dict]:
    """Reads every page_<id>_raw.json a download run produced."""
    payloads = [output.read_json(path) for path in sorted(run_dir.glob("page_*_raw.json"))]
    if not payloads:
        raise FileNotFoundError(f"No page_*_raw.json files in {run_dir} — was the download run empty?")
    return payloads


def iter_leads(page_payloads: List[dict]) -> Iterator[Tuple[dict, dict, dict]]:
    """Yields (page, form, raw_lead) for every downloaded lead."""
    for page in page_payloads:
        for form in page.get("forms") or []:
            for lead in form.get("leads") or []:
                yield page, form, lead


def is_already_synced(cur, meta_lead_id: int) -> bool:
    cur.execute("SELECT id FROM ext.meta_leads WHERE meta_lead_id = %s LIMIT 1", (meta_lead_id,))
    return cur.fetchone() is not None


def find_active_lead_by_phone(cur, org_id: str, phone: str) -> Optional[str]:
    """EXACT string equality on the phone, the platform rule (confirmed
    2026-09-13) — the same predicate lead_writer.create_lead and leads-service's
    createWebhookLead use. Normalised first exactly as create_lead normalises
    before its lookup, so this predicts what the import will actually do.

    Previously matched on the last 10 significant digits, which made the batch
    path supersede leads the live webhook keeps separate."""
    cur.execute(
        """
        SELECT id FROM lms.marketing_leads
        WHERE org_id = %(org_id)s AND phone = %(phone)s
          AND is_active = true AND NOT is_deleted
        LIMIT 1
        """,
        {"org_id": org_id, "phone": phone_util.normalize(phone)},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def find_active_lead_by_email(cur, org_id: str, email: str) -> Optional[str]:
    cur.execute(
        """
        SELECT id FROM lms.marketing_leads
        WHERE org_id = %(org_id)s AND email = %(email)s AND is_active = true AND NOT is_deleted
        LIMIT 1
        """,
        {"org_id": org_id, "email": email},
    )
    row = cur.fetchone()
    return row["id"] if row else None


def classify(cur, form: dict, raw_lead: dict, mappings: Dict[str, Any]) -> dict:
    """Returns {verdict, reason, contact, meta_lead_id, existing_lead_id,
    is_hiring_form, suggested_campaign_type_id}.

    Order matters and mirrors the import path: identity dedup first (cheapest
    and most decisive), then routability, then extractability, then the
    org-level person dedup that create_lead performs.

    is_hiring_form / suggested_campaign_type_id are computed for every row
    regardless of verdict (see the module docstring) — informational only,
    never routing-critical, so a look-alike form on a NEW lead and one on an
    ALREADY_SYNCED lead are equally worth flagging to a reviewer.
    """
    meta_lead_id = safe_bigint(raw_lead.get("id"))
    base = {
        "meta_lead_id": meta_lead_id,
        "contact": None,
        "existing_lead_id": None,
        "is_hiring_form": is_hiring_form(form.get("name")),
        "suggested_campaign_type_id": suggested_campaign_type_id(cur, form.get("tenant_id"), form.get("name")),
    }

    if meta_lead_id is None:
        return {**base, "verdict": MISSING_CONTACT, "reason": f"non-numeric lead id {raw_lead.get('id')!r}"}

    if is_already_synced(cur, meta_lead_id):
        return {**base, "verdict": ALREADY_SYNCED, "reason": "meta_lead_id already in ext.meta_leads"}

    if is_test_lead(raw_lead.get("field_data") or []):
        return {**base, "verdict": TEST_LEAD, "reason": "Meta Lead Ads Testing Tool placeholder data"}

    org_id = form.get("org_id")
    if not org_id:
        return {
            **base,
            "verdict": UNMAPPED_FORM,
            "reason": f"form {form.get('form_id')} has no active ext.meta_page_form_org_map row",
        }

    try:
        contact = field_mapping.build_contact_payload(raw_lead.get("field_data") or [], mappings)
    except ValueError as exc:
        return {**base, "verdict": MISSING_CONTACT, "reason": str(exc)}

    base["contact"] = contact

    if contact["phone"]:
        existing = find_active_lead_by_phone(cur, org_id, contact["phone"])
        if existing:
            return {
                **base,
                "verdict": PHONE_DUPLICATE,
                "existing_lead_id": existing,
                "reason": "phone already on an active lead for this org — it will be superseded",
            }

    if contact["email"]:
        existing = find_active_lead_by_email(cur, org_id, contact["email"])
        if existing:
            return {
                **base,
                "verdict": EMAIL_DUPLICATE,
                "existing_lead_id": existing,
                "reason": "email already on an active lead for this org — treated as a re-submission",
            }

    return {**base, "verdict": NEW, "reason": ""}
