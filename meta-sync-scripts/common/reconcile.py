"""Classifies a downloaded Meta lead against what's already in the local DB.

Shared by check_leads_against_db.py (report only) and
import_downloaded_leads.py (report, then act on the same verdicts) so the
preview and the import can never disagree about what will happen.

The dedup checks mirror common/lead_writer.py::create_lead exactly — phone
match supersedes the old lead, email match is a no-op re-submission — so a
verdict here is a genuine prediction of what create_lead would do, not an
approximation.
"""

from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from . import field_mapping, output

# Verdicts, roughly in the order they're decided.
NEW = "new"
ALREADY_SYNCED = "already_synced"
UNMAPPED_FORM = "unmapped_form"
MISSING_CONTACT = "missing_contact"
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
    cur.execute(
        """
        SELECT id FROM lms.marketing_leads
        WHERE org_id = %(org_id)s AND phone = %(phone)s AND is_active = true AND NOT is_deleted
        LIMIT 1
        """,
        {"org_id": org_id, "phone": phone},
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
    """Returns {verdict, reason, contact, meta_lead_id, existing_lead_id}.

    Order matters and mirrors the import path: identity dedup first (cheapest
    and most decisive), then routability, then extractability, then the
    org-level person dedup that create_lead performs.
    """
    meta_lead_id = safe_bigint(raw_lead.get("id"))
    base = {"meta_lead_id": meta_lead_id, "contact": None, "existing_lead_id": None}

    if meta_lead_id is None:
        return {**base, "verdict": MISSING_CONTACT, "reason": f"non-numeric lead id {raw_lead.get('id')!r}"}

    if is_already_synced(cur, meta_lead_id):
        return {**base, "verdict": ALREADY_SYNCED, "reason": "meta_lead_id already in ext.meta_leads"}

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
