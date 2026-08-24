"""Phone normalisation and dedup keys for Meta lead sync.

Meta hands back whatever the person typed into the form: "+919876543210",
"9876543210", "09876543210", "+91 98765 43210". Nothing normalised those, and
every dedup check was a raw string equality (`WHERE phone = %s`) — so the same
person arriving in two different formats produced two active leads in the same
branch. Production carries 45 such duplicate groups.

Two functions, deliberately separate:

* `normalize()` decides what gets STORED. Conservative: it only rewrites a
  value it can positively recognise as an Indian mobile, and returns anything
  it cannot classify untouched. Garbage like "11", "00000" or a Meta test-lead
  placeholder must never be "cleaned" into something that looks real.
* `match_key()` decides what gets COMPARED. The last 10 significant digits,
  which is what makes "+919876543210" and "9876543210" collide. Returns None
  for values too malformed to match on, so callers can fall back to exact
  equality rather than grouping every short/garbage number together.
"""

import re
from typing import Optional

# Indian mobile numbers are 10 digits starting 6-9. Used to avoid stamping +91
# onto a landline fragment or a junk value that merely happens to be 10 long.
_INDIAN_MOBILE = re.compile(r"^[6-9]\d{9}$")
DEFAULT_COUNTRY_CODE = "91"


def digits(raw: Optional[str]) -> str:
    """Just the digits — no +, spaces, dashes or parentheses."""
    return re.sub(r"\D", "", raw or "")


def normalize(raw: Optional[str]) -> Optional[str]:
    """Canonical E.164 form when the value is confidently recognisable.

    Anything else is returned trimmed but otherwise untouched: a value this
    cannot classify is more useful preserved verbatim (someone can still read
    it) than rewritten into a plausible-looking wrong number.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return value

    d = digits(value)

    if _INDIAN_MOBILE.match(d):                                   # 9876543210
        return f"+{DEFAULT_COUNTRY_CODE}{d}"
    if len(d) == 12 and d.startswith(DEFAULT_COUNTRY_CODE) and _INDIAN_MOBILE.match(d[2:]):
        return f"+{d}"                                            # 919876543210
    if len(d) == 11 and d.startswith("0") and _INDIAN_MOBILE.match(d[1:]):
        return f"+{DEFAULT_COUNTRY_CODE}{d[1:]}"                  # 09876543210
    if value.startswith("+") and 10 <= len(d) <= 15:              # already international
        return f"+{d}"

    return value


def match_key(raw: Optional[str]) -> Optional[str]:
    """Dedup key: last 10 significant digits, or None if unmatchable.

    None means "do not group this with anything" — callers fall back to exact
    string equality, so two leads whose phone is "00000" stay distinct rather
    than being merged on a meaningless key.
    """
    d = digits(normalize(raw))
    return d[-10:] if len(d) >= 10 else None
