"""Field-mapping resolution + extraction from a raw Meta lead's field_data.

Python port of:
  services/meta-conversion-api/src/config/meta.config.ts (DEFAULT_FIELD_MAPPINGS,
    resolveFieldMappings)
  services/meta-conversion-api/src/services/lead-sync.service.ts (extractFieldValue,
    extractByKeys, buildContactPayload, buildAddressPayload,
    buildProfessionalPayload, buildDemographicsPayload)

Keep the default key lists and the extraction order (mapped-fields-first,
then leftover keys become custom fields) identical to the TS source so a
lead ingested via this script and one ingested via the webhook resolve to
the same fields.
"""

from typing import Any, Dict, List, Optional

DEFAULT_FIELD_MAPPINGS: Dict[str, Dict[str, List[str]]] = {
    "contact": {
        "phone": ["phone", "phone_number", "mobile_number"],
        "email": ["email"],
        "first_name": ["first_name"],
        "last_name": ["last_name"],
        "full_name": ["full_name"],
        "whatsapp_number": ["whatsapp_number"],
    },
    "address": {
        "street_address": ["street_address"],
        "city": ["city"],
        "state": ["state"],
        "province": ["province"],
        "country": ["country"],
        "postal_code": ["postal_code"],
        "zip_code": ["zip_code"],
    },
    "professional": {
        "job_title": ["job_title"],
        "company_name": ["company_name"],
        "work_email": ["work_email"],
        "work_phone_number": ["work_phone_number"],
    },
    "demographics": {
        "date_of_birth": ["date_of_birth"],
        "gender": ["gender"],
        "marital_status": ["marital_status"],
        "relationship_status": ["relationship_status"],
        "military_status": ["military_status"],
    },
}


def _pick(value: Optional[List[str]], fallback: List[str]) -> List[str]:
    return value if value else fallback


def resolve_field_mappings(tenant_field_mappings: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, List[str]]]:
    """Merges a tenant's ext.meta_tenant_config.field_mappings override over
    DEFAULT_FIELD_MAPPINGS. Any category/key the tenant hasn't overridden
    falls back to the default, exactly as resolveFieldMappings() does."""
    if not tenant_field_mappings:
        return DEFAULT_FIELD_MAPPINGS

    resolved: Dict[str, Dict[str, List[str]]] = {}
    for category, keys in DEFAULT_FIELD_MAPPINGS.items():
        overrides = tenant_field_mappings.get(category) or {}
        resolved[category] = {key: _pick(overrides.get(key), default) for key, default in keys.items()}
    return resolved


def extract_field_value(field_data: List[Dict[str, Any]], meta_key: str) -> Optional[str]:
    for field in field_data:
        if field.get("name") == meta_key:
            values = field.get("values") or []
            if values and str(values[0]).strip():
                return str(values[0]).strip()
            return None
    return None


def extract_by_keys(field_data: List[Dict[str, Any]], keys: Optional[List[str]]) -> Optional[str]:
    for key in keys or []:
        value = extract_field_value(field_data, key)
        if value:
            return value
    return None


def build_contact_payload(field_data: List[Dict[str, Any]], mappings: Dict[str, Dict[str, List[str]]]) -> Dict[str, Any]:
    contact = mappings["contact"]
    phone = extract_by_keys(field_data, contact["phone"])
    if not phone:
        raise ValueError("Lead payload is missing a required phone value")

    email = extract_by_keys(field_data, contact["email"])
    full_name = extract_by_keys(field_data, contact["full_name"])

    first_name: Optional[str] = None
    last_name: Optional[str] = None
    if full_name:
        parts = full_name.split(" ")
        first_name = parts[0] or None
        last_name = " ".join(parts[1:]) or None

    fn_val = extract_by_keys(field_data, contact["first_name"])
    if fn_val:
        first_name = fn_val
    ln_val = extract_by_keys(field_data, contact["last_name"])
    if ln_val:
        last_name = ln_val

    whatsapp_number = extract_by_keys(field_data, contact["whatsapp_number"])

    return {
        "email": email,
        "phone": phone,
        "first_name": first_name,
        "last_name": last_name,
        "full_name": full_name,
        "whatsapp_number": whatsapp_number,
    }


def build_address_payload(field_data: List[Dict[str, Any]], mappings: Dict[str, Dict[str, List[str]]]) -> Dict[str, Any]:
    a = mappings["address"]
    return {
        "street_address": extract_by_keys(field_data, a["street_address"]),
        "city": extract_by_keys(field_data, a["city"]),
        "state": extract_by_keys(field_data, a["state"]),
        "province": extract_by_keys(field_data, a["province"]),
        "country": extract_by_keys(field_data, a["country"]),
        "postal_code": extract_by_keys(field_data, a["postal_code"]),
        "zip_code": extract_by_keys(field_data, a["zip_code"]),
    }


def build_professional_payload(field_data: List[Dict[str, Any]], mappings: Dict[str, Dict[str, List[str]]]) -> Dict[str, Any]:
    p = mappings["professional"]
    return {
        "job_title": extract_by_keys(field_data, p["job_title"]),
        "company_name": extract_by_keys(field_data, p["company_name"]),
        "work_email": extract_by_keys(field_data, p["work_email"]),
        "work_phone_number": extract_by_keys(field_data, p["work_phone_number"]),
    }


def build_demographics_payload(field_data: List[Dict[str, Any]], mappings: Dict[str, Dict[str, List[str]]]) -> Dict[str, Any]:
    d = mappings["demographics"]
    return {
        "date_of_birth": extract_by_keys(field_data, d["date_of_birth"]),
        "gender": extract_by_keys(field_data, d["gender"]),
        "marital_status": extract_by_keys(field_data, d["marital_status"]),
        "relationship_status": extract_by_keys(field_data, d["relationship_status"]),
        "military_status": extract_by_keys(field_data, d["military_status"]),
    }


def has_any_value(payload: Dict[str, Optional[str]]) -> bool:
    return any(v is not None for v in payload.values())


def known_field_keys(mappings: Dict[str, Dict[str, List[str]]]) -> set:
    keys: set = set()
    for category in mappings.values():
        for key_list in category.values():
            keys.update(key_list)
    return keys


def extract_custom_fields(field_data: List[Dict[str, Any]], mappings: Dict[str, Dict[str, List[str]]]) -> List[Dict[str, str]]:
    known = known_field_keys(mappings)
    custom = []
    for field in field_data:
        name = field.get("name")
        if name in known:
            continue
        values = field.get("values") or []
        value = str(values[0]).strip() if values and str(values[0]).strip() else None
        if value:
            custom.append({"key": name, "value": value})
    return custom
